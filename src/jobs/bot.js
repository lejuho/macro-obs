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
const { answerCallbackQuery, send, setMyCommands } = require('../notify/telegram');
const { parseCommit, targetDate, formatTrack } = require('../predictions');
const { formatContext } = require('../bandstats');
const { formatScenario, formatPaths, computeAll } = require('../graph');
const { TG_BOT_TOKEN, TG_CHAT_ID } = require('../config');

const POLL_TIMEOUT = 50; // long-poll seconds
const BOT_COMMANDS = [
  { command: 'start', description: '도움말과 입력 형식' },
  { command: 'help', description: '도움말과 입력 형식' },
  { command: 'guide', description: '운영 동선과 설계 이유' },
  { command: 'status', description: '가설별 최신값, 밴드, open 알림' },
  { command: 'track', description: '예측 캘리브레이션 기록' },
  { command: 'hyp', description: '가설: /hyp ctx <가설id>, /hyp revise <id> <하한~상한> <근거>' },
  { command: 'scn', description: '시나리오: /scn <id>, /scn node <노드명>, /scn path <id> <노드명>' },
];

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
  if (text === '/guide') {
    return send([
      '<b>운영 동선 — 알림 → 조회 → 커밋</b>',
      '',
      '① <b>알림(여기)</b>: 푸시가 필요한 사건은 가설이 흔들리는 순간뿐. 조용함도 신호다.',
      '② <b>조회(관측소)</b>: 이벤트 때 하는 일은 분석이 아니라 사전계산된 지도 열기. 해도에 시나리오를 얹어라.',
      '③ <b>커밋(여기)</b>: 알림은 90일 예측을 답장해야 닫힌다. 적지 않은 판단은 측정되지 않고, 측정되지 않으면 나아지지 않는다. mute도 기록된다.',
      '',
      '분업: 시스템 = 사실·사전계산 / 사람 = 판단(밴드, 커밋, 경합 경로 선택, 수정 근거).',
      '수치는 순위용 휴리스틱, ⚔️ 경합은 합산하지 않는다 — 지배 경로 판단이 네 몫.',
      '',
      '평시가 본 작업 시간: 간선 노트 손질, weight 검증, 트리거 예약. 위기 때의 나는 평시의 내가 시켜둔 일을 수행할 뿐이다.',
      '',
      '명령 전체는 /help',
    ].join('\n'));
  }
  if (text === '/help' || text === '/start') {
    return send([
      '알림에 답장으로 커밋: <code>하한~상한</code> · 단일값 · 자유서술 · <code>mute</code>',
      '명령:',
      '/status — 가설 현황',
      '/track — 트랙레코드',
      '/hyp — 가설 목록(id 확인)',
      '/hyp ctx &lt;id&gt; — 밴드 설정 참고치(1y/3y 분포)',
      '/hyp revise &lt;id&gt; &lt;lo&gt;~&lt;hi&gt; &lt;근거...&gt; — 가설 수정(근거 필수)',
      '/scn — 목록 · /scn &lt;id&gt; — 결과 · /scn node &lt;노드&gt; — 이 노드를 미는 시나리오 · /scn path &lt;id&gt; &lt;노드&gt; · /scn recompute',
      '/guide — 운영 동선과 설계 이유',
    ].join('\n'));
  }

  // --- 시나리오 ---
  if (text === '/scn') {
    const rows = stmts.allScenarios.all();
    return send(rows.map((sc) =>
      `#${sc.id} ${esc(sc.name)}${sc.computed_at ? '' : ' (미계산)'}`).join('\n') || '시나리오 없음 — scripts/seed-graph.js 실행');
  }
  if (text === '/scn recompute') {
    const out = computeAll();
    return send('재계산 완료:\n' + out.map((r) => `${esc(r.name)}: ${r.paths} 경로`).join('\n'));
  }
  let sm = text.match(/^\/scn\s+node\s+(.+)$/);
  if (sm) {
    const rows = stmts.scenariosHittingNode.all(`%${sm[1].trim()}%`);
    if (!rows.length) return send(`"${esc(sm[1])}"에 도달하는 시나리오 없음`);
    const best = {};
    for (const r of rows) if (!best[r.name] || Math.abs(r.impact) > Math.abs(best[r.name].impact)) best[r.name] = r;
    return send(`<b>"${esc(sm[1].trim())}"를 미는 시나리오</b> (사전계산):\n` +
      Object.values(best).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
        .map((r) => `${r.impact < 0 ? '🔴' : '🟢'}${Math.abs(r.impact).toFixed(2)} #${r.id} ${esc(r.name)}`).join('\n') +
      '\n<i>지금 어느 세계인지 판단은 네 몫 — /scn &lt;id&gt;로 전체 지도</i>');
  }
  sm = text.match(/^\/scn\s+path\s+(\d+)\s+(.+)$/);
  if (sm) return send(formatPaths(Number(sm[1]), sm[2].trim()));
  sm = text.match(/^\/scn\s+(\d+)$/);
  if (sm) {
    const sc = stmts.scenarioById.get(Number(sm[1]));
    if (!sc) return send(`시나리오 #${sm[1]} 없음. /scn 으로 확인.`);
    return send(formatScenario(sc));
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

async function handleCallbackQuery(q) {
  const chatId = q.message?.chat?.id;
  if (String(chatId) !== String(TG_CHAT_ID())) {
    return answerCallbackQuery(q.id, '허용되지 않은 채팅입니다.', { show_alert: true });
  }

  const data = q.data || '';
  if (data === 'cmd:status') {
    await answerCallbackQuery(q.id, '가설 현황을 보냅니다.');
    return send(statusText());
  }
  if (data === 'cmd:track') {
    await answerCallbackQuery(q.id, '트랙레코드를 보냅니다.');
    return send(formatTrack(stmts.trackRecord.all()));
  }

  const mute = data.match(/^alert:mute:(\d+)$/);
  if (mute) {
    const alertId = Number(mute[1]);
    const alert = db.prepare(`
      SELECT a.id, a.status, i.name AS indicator_name
      FROM alerts a
      JOIN hypotheses h ON h.id = a.hypothesis_id
      JOIN indicators i ON i.id = h.indicator_id
      WHERE a.id = ?`).get(alertId);

    if (!alert) return answerCallbackQuery(q.id, `알림 #${alertId} 없음`, { show_alert: true });
    if (alert.status !== 'open') {
      return answerCallbackQuery(q.id, `이미 ${alert.status} 상태입니다.`, { show_alert: true });
    }

    stmts.setAlertStatus.run('muted', alertId);
    await answerCallbackQuery(q.id, `알림 #${alertId} muted`);
    return send(`알림 #${alertId} muted: <b>${esc(alert.indicator_name)}</b>\n⚠️ 회피도 트랙레코드에 남는다.`);
  }

  return answerCallbackQuery(q.id, '알 수 없는 버튼입니다.', { show_alert: true });
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
  await setMyCommands(BOT_COMMANDS).catch((e) => console.error('setMyCommands:', e.message));
  for (;;) {
    try {
      const updates = await poll();
      for (const u of updates) {
        setOffset(u.update_id + 1);
        if (u.message) await handleMessage(u.message).catch((e) => console.error('handle:', e.message));
        if (u.callback_query) await handleCallbackQuery(u.callback_query).catch((e) => console.error('callback:', e.message));
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000)); // 백오프 후 재시도
    }
  }
}

if (require.main === module) main();
module.exports = { handleMessage, handleCallbackQuery, handleCommit, BOT_COMMANDS };
