// 텔레그램 봇 데몬 (Phase 1) — 알림 답장 수신 → 예측 커밋
// 실행: node src/jobs/bot.js  (systemd 서비스로 상시 구동, README 참조)
//
// 처리:
//   [알림 메시지에 답장]  → parseCommit → predictions 기록, alert → committed
//   [알림 답장 "mute"]    → alert → muted (트랙레코드에 회피로 남음)
//   /status               → 가설 현황 + open 알림
//   /track                → 캘리브레이션 트랙레코드
//   [manual 예측 채점 답장 "hit"/"miss"] → self-grade

const { db, stmts } = require('../db');
const { send } = require('../notify/telegram');
const { parseCommit, targetDate, formatTrack } = require('../predictions');
const { formatContext } = require('../bandstats');
const { TG_BOT_TOKEN, TG_CHAT_ID } = require('../config');

const POLL_TIMEOUT = 50; // long-poll seconds

function getOffset() {
  const row = stmts.kvGet.get('tg_offset');
  return row ? Number(row.value) : 0;
}
function setOffset(v) { stmts.kvSet.run('tg_offset', String(v)); }

async function poll() {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN()}/getUpdates?timeout=${POLL_TIMEOUT}&offset=${getOffset()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000) });
  const json = await res.json();
  if (!json.ok) throw new Error(`getUpdates: ${json.description}`);
  return json.result;
}

async function handleMessage(msg) {
  if (!msg.text) return;
  if (String(msg.chat.id) !== String(TG_CHAT_ID())) return; // 본인 채팅만
  const text = msg.text.trim();

  // --- 명령 ---
  if (text === '/status') return send(statusText());
  if (text === '/track') return send(formatTrack(stmts.trackRecord.all()));
  if (text === '/help' || text === '/start') {
    return send([
      '알림에 답장으로 커밋: <code>1450~1520</code> · 단일값 · 자유서술 · <code>mute</code>',
      '명령:',
      '/status — 가설 현황',
      '/track — 트랙레코드',
      '/hyp — 가설 목록(id 확인)',
      '/hyp ctx &lt;id&gt; — 밴드 설정 참고치(1y/3y 분포)',
      '/hyp revise &lt;id&gt; &lt;lo&gt;~&lt;hi&gt; &lt;근거...&gt; — 가설 수정(근거 필수)',
    ].join('\n'));
  }

  // --- 가설 관리 ---
  if (text === '/hyp') {
    const rows = stmts.activeHypotheses.all();
    return send(rows.map((h) =>
      `#${h.id} ${esc(h.indicator_name)} [${h.band_low}~${h.band_high}] (${h.window_rule})`).join('\n') || '가설 없음');
  }
  let m = text.match(/^\/hyp\s+ctx\s+(\d+)$/);
  if (m) {
    const hyp = stmts.hypById.get(Number(m[1]));
    if (!hyp) return send(`가설 #${m[1]} 없음. /hyp 로 id 확인.`);
    const iso = (days) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    return send(formatContext(hyp,
      stmts.obsSince.all(hyp.indicator_id, iso(365)),
      stmts.obsSince.all(hyp.indicator_id, iso(365 * 3))));
  }
  m = text.match(/^\/hyp\s+revise\s+(\d+)\s+([0-9.]+)\s*[~\-]\s*([0-9.]+)\s+([\s\S]+)$/);
  if (m) return handleRevise(Number(m[1]), Number(m[2]), Number(m[3]), m[4].trim());
  if (/^\/hyp\s+revise/.test(text)) {
    return send('형식: /hyp revise &lt;id&gt; &lt;lo&gt;~&lt;hi&gt; &lt;근거&gt;\n근거 없이는 수정 불가 — rationale이 다음 알림에 그대로 뜬다.');
  }

  // --- 알림 답장 → 커밋 ---
  const replyId = msg.reply_to_message?.message_id;
  if (!replyId) return; // 답장 아닌 일반 메시지는 무시

  const alert = stmts.alertByTgId.get(replyId);
  if (alert) return handleCommit(alert, text);

  // manual 채점 답장 (grade 리포트 메시지에 대한 hit/miss)
  const selfGrade = /^(hit|miss)$/i.exec(text);
  if (selfGrade) {
    const predId = stmts.kvGet.get(`selfgrade_msg_${replyId}`)?.value;
    if (predId) {
      db.prepare(`UPDATE predictions SET score = ?, graded_at = datetime('now') WHERE id = ?`)
        .run(selfGrade[1].toLowerCase(), Number(predId));
      return send(`기록됨: 예측 #${predId} → ${selfGrade[1].toLowerCase()}`);
    }
  }
}

async function handleCommit(alert, text) {
  if (alert.status !== 'open') {
    return send(`이 알림(#${alert.id})은 이미 ${alert.status} 상태.`);
  }
  const parsed = parseCommit(text);

  if (parsed.mute) {
    stmts.setAlertStatus.run('muted', alert.id);
    return send(`알림 #${alert.id} muted. ⚠️ 회피도 트랙레코드에 남는다.`);
  }

  const tdate = targetDate();
  const { id: predId } = stmts.insertPrediction.get({
    alert_id: alert.id,
    statement: parsed.statement,
    expected_low: parsed.expected_low,
    expected_high: parsed.expected_high,
    target_date: tdate,
  });
  stmts.setAlertStatus.run('committed', alert.id);

  const bandTxt = parsed.structured
    ? `밴드 [${round2(parsed.expected_low)} ~ ${round2(parsed.expected_high)}] — ${tdate}에 자동 채점`
    : `자유 서술 — ${tdate}에 self-grade 요청이 온다`;
  return send(`✅ 커밋 #${predId} (알림 #${alert.id})\n<b>${esc(alert.indicator_name)}</b>: "${esc(parsed.statement)}"\n${bandTxt}`);
}

async function handleRevise(oldId, lo, hi, rationale) {
  const old = stmts.hypById.get(oldId);
  if (!old) return send(`가설 #${oldId} 없음.`);
  if (old.status !== 'active') return send(`가설 #${oldId}는 ${old.status} 상태 — 수정 불가.`);
  if (lo > hi) [lo, hi] = [hi, lo];
  if (rationale.length < 10) return send('근거가 너무 짧다. 이 문장이 다음 이탈 알림에 "등록 논리"로 그대로 뜬다 — 미래의 나를 설득할 만큼 써라.');

  const statement = old.statement.replace(/\d+(?:\.\d+)?\s*~\s*\d+(?:\.\d+)?/, `${lo}~${hi}`);
  const { id: newId } = stmts.reviseHyp.get({
    statement, band_low: lo, band_high: hi, rationale, old_id: oldId,
  });
  stmts.retireHyp.run(oldId);
  return send(`✏️ 가설 #${oldId} → <b>#${newId}</b>로 수정\n밴드: [${old.band_low}~${old.band_high}] → [${lo}~${hi}]\n근거: "${esc(rationale)}"\n(수정 이력은 revised_from 체인으로 보존)`);
}

function statusText() {
  const hyps = db.prepare(`
    SELECT h.id, h.band_low, h.band_high, i.name AS ind, i.unit,
      (SELECT value FROM observations o WHERE o.indicator_id = h.indicator_id ORDER BY date DESC LIMIT 1) AS latest,
      (SELECT date  FROM observations o WHERE o.indicator_id = h.indicator_id ORDER BY date DESC LIMIT 1) AS d
    FROM hypotheses h JOIN indicators i ON i.id = h.indicator_id
    WHERE h.status='active'`).all();
  const open = db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE status='open'`).get().n;
  const pend = db.prepare(`SELECT COUNT(*) AS n FROM predictions WHERE graded_at IS NULL`).get().n;

  const lines = ['<b>가설 현황</b>'];
  for (const h of hyps) {
    const mark = h.latest == null ? '·' : h.latest > h.band_high ? '⚠️↑' : h.latest < h.band_low ? '⚠️↓' : '✓';
    lines.push(`${mark} ${esc(h.ind)}: ${h.latest ?? '-'} ${esc(h.unit || '')} [${h.band_low}~${h.band_high}] (${h.d ?? '-'})`);
  }
  lines.push('', `open 알림 ${open} · 채점 대기 예측 ${pend}`);
  return lines.join('\n');
}

const round2 = (v) => Math.round(v * 100) / 100;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  console.log(`[${new Date().toISOString()}] bot daemon start`);
  for (;;) {
    try {
      const updates = await poll();
      for (const u of updates) {
        setOffset(u.update_id + 1);
        if (u.message) await handleMessage(u.message).catch((e) => console.error('handle:', e.message));
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000)); // 백오프 후 재시도
    }
  }
}

if (require.main === module) main();
module.exports = { handleMessage, handleCommit };
