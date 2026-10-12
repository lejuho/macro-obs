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
const { parseConditions } = require('../triggers');
const worldview = require('../worldview');
const flags = require('../flags');
const { TG_BOT_TOKEN, TG_CHAT_ID } = require('../config');

const POLL_TIMEOUT = 50; // long-poll seconds

// 텔레그램 / 자동완성 등록 목록
const BOT_COMMANDS = [
  { command: 'status', description: '가설 현황 + open 알림' },
  { command: 'track', description: '캘리브레이션 트랙레코드' },
  { command: 'hyp', description: '가설: /hyp ctx <id> · /hyp revise <id> <lo>~<hi> <근거>' },
  { command: 'scn', description: '시나리오: /scn <id> · /scn node <노드> · /scn path <id> <노드>' },
  { command: 'view', description: '현재 관점: /view new 1,2 | 설명 · /view apply <제안id>' },
  { command: 'ind', description: '지표 목록 (id + 최신값) — 트리거 조건 작성용' },
  { command: 'trig', description: '트리거: /trig add 이름 | 조건 | 지시문 · /trig arm <id>' },
  { command: 'elec', description: '다가오는 선거 + 정책 레버 분기' },
  { command: 'news', description: '최근 뉴스 클러스터 (축별 보도량)' },
  { command: 'draft', description: '관측 노트 초안 즉시 생성 (월간 배치와 별개)' },
  { command: 'press', description: '언론사 트랙레코드 (90일 검증)' },
  { command: 'guide', description: '운영 동선과 설계 이유' },
  { command: 'help', description: '명령 전체' },
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
      '/view — 현재 관점 목록 · /view new 1,2 | 설명 — 복합 오버레이 초안',
      '/view show &lt;id&gt; · /view review &lt;id&gt; · /view apply|reject &lt;수정제안id&gt;',
      '/guide — 운영 동선과 설계 이유',
    ].join('\n'));
  }

  if (text === '/draft') {
    const { generateDraft } = require('../drafts');
    await send('초안 생성 중... (claude 호출, 1~2분)');
    const r = generateDraft();
    if (r.skip) return send(`생성 안 함: ${esc(r.skip)}`);
    if (!r.ok) return send(`❌ ${esc(r.reason)}`);
    return send(`📝 초안 생성: <code>out/drafts/${r.ym}.md</code> (${r.chars}자)\n재료: 채점 ${r.material_counts.graded} · 수정 ${r.material_counts.revisions} · 이탈 ${r.material_counts.breaches}`);
  }

  // --- 뉴스 프레이밍 ---
  if (text === '/news') {
    const rows = stmts.newsClustersRecent.all(8).filter((c) => c.event_key);
    if (!rows.length) return send('클러스터 없음 — src/jobs/news.js 배치 실행 후.');
    return send(rows.map((c) =>
      `${c.status === 'revisited' ? '📗' : '📘'} <b>${esc(c.title)}</b>\n  ${c.query} · 기사 ${c.items} (A ${c.a_cnt}·B ${c.b_cnt}) · ${c.first_seen.slice(0, 10)}~`).join('\n\n')
      + '\n\n📗=재방문 완료. 상세는 관측소.');
  }
  if (text === '/press') {
    const { formatPressTrack } = require('../news');
    return send(formatPressTrack());
  }

  // --- 현재 관점 복합 오버레이 ---
  if (text === '/view') {
    const rows = stmts.recentWorldviews.all(8);
    if (!rows.length) return send('현재 관점 커밋 없음.\n/view new 1,2 | 지금 세계를 설명하는 문장');
    const proposals = stmts.pendingGraphProposals.all();
    return send([
      '<b>현재 관점 커밋</b>',
      ...rows.map((v) => `#${v.id} ${v.status === 'committed' ? '🟢' : v.status === 'reviewed' ? '📗' : v.status === 'draft' ? '✎' : '◌'} ${esc(v.thesis)} → ${v.target_date}`),
      '', `적용 대기 수정 제안 ${proposals.length}건`,
      ...proposals.slice(0, 8).map((p) => `· #${p.id} ${p.proposal_type} ${esc(p.target_ref || '')}`),
    ].join('\n'));
  }
  let vm = text.match(/^\/view\s+new\s+([0-9,\s]+)\s*\|\s*([\s\S]+)$/);
  if (vm) {
    try {
      const bundle = worldview.createDraft(vm[1].split(',').map((x) => Number(x.trim())), vm[2].trim());
      const msg = await send(worldview.formatDraft(bundle));
      if (msg.message_id) stmts.kvSet.run(`worldview_draft_msg_${msg.message_id}`, String(bundle.commit.id));
      return;
    } catch (e) { return send(`❌ ${esc(e.message)}`); }
  }
  if (/^\/view\s+new/.test(text)) return send('형식: /view new &lt;주 시나리오id,보조id...&gt; | &lt;현재 관점 설명&gt;\n예: /view new 1,2 | 대만·호르무즈 복합 충격이 현재 흐름의 주된 설명이다');
  vm = text.match(/^\/view\s+show\s+(\d+)$/);
  if (vm) {
    const bundle = worldview.getBundle(Number(vm[1]));
    return send(bundle ? worldview.formatDraft(bundle).replace('초안', `(${bundle.commit.status})`) : `현재 관점 #${vm[1]} 없음`);
  }
  vm = text.match(/^\/view\s+review\s+(\d+)$/);
  if (vm) {
    await send(`🧭 현재 관점 #${vm[1]} 검토 중...`);
    const r = worldview.generateReview(Number(vm[1]));
    if (!r.ok) return send(`❌ ${esc(r.reason)}`);
    const msg = await send(worldview.formatReview(r.bundle.commit, r.data));
    stmts.setWorldviewReviewPending.run({ id: Number(vm[1]), message_id: msg.message_id || null });
    if (msg.message_id) stmts.kvSet.run(`worldview_review_msg_${msg.message_id}`, String(vm[1]));
    return;
  }
  vm = text.match(/^\/view\s+(apply|reject)\s+(\d+)$/);
  if (vm) {
    try {
      if (vm[1] === 'apply') {
        const p = worldview.applyProposal(Number(vm[2]));
        return send(`✅ 수정 제안 #${vm[2]} 적용·기록됨\n${esc(p.reason)}`);
      }
      worldview.rejectProposal(Number(vm[2]));
      return send(`수정 제안 #${vm[2]} 기각 기록됨.`);
    } catch (e) { return send(`❌ ${esc(e.message)}`); }
  }

  // --- 선거/정책 레버 ---
  if (text === '/elec') {
    const rows = stmts.upcomingElections.all(5);
    if (!rows.length) return send('등록된 선거 없음 — scripts/seed-elections.js');
    const out = [];
    for (const e of rows) {
      const dday = Math.ceil((new Date(e.date) - Date.now()) / 86400_000);
      out.push(`🗳 <b>${esc(e.country)} ${esc(e.body)}</b> ${e.date} (D-${dday})${e.note ? `\n<i>${esc(e.note)}</i>` : ''}`);
      for (const l of stmts.leversFor.all(e.id)) {
        out.push(`  · [${esc(l.outcome_branch)}] ${esc(l.lever)}${l.scenario_name ? ` → /scn "${esc(l.scenario_name)}"` : ''}`);
      }
      out.push('');
    }
    out.push('<i>레버 = 결과에 따라 실제로 바뀌는 정책 손잡이. 이념 라벨이 아니다.</i>');
    return send(out.join('\n'));
  }

  // --- 지표 목록 ---
  if (text === '/ind') {
    const rows = stmts.indicatorsList.all();
    return send('<b>지표 (id · 최신값)</b>\n' + rows.map((i) =>
      `#${i.id} ${esc(i.name)}: ${i.latest ?? '-'} ${esc(i.unit || '')}`).join('\n'));
  }

  // --- 결정 트리거 ---
  if (text === '/trig') {
    const rows = stmts.allTriggers.all();
    if (!rows.length) return send('트리거 없음. 등록: /trig add 이름 | 조건 | 지시문\n예: /trig add 환율위기 | 1>1600 & 7>5 | 달러예금 비중 재검토, 신규 리스크자산 매수 중단');
    return send(rows.map((t) =>
      `#${t.id} ${t.armed ? '🟢armed' : `⚪fired(${(t.fired_at || '').slice(0, 10)})`} <b>${esc(t.name)}</b>\n  ${esc(t.conditions_json)}\n  "${esc(t.action_text.slice(0, 80))}${t.action_text.length > 80 ? '…' : ''}"`).join('\n\n'));
  }
  let tm = text.match(/^\/trig\s+add\s+([^|]+)\|([^|]+)\|([\s\S]+)$/);
  if (tm) {
    const name = tm[1].trim(), condText = tm[2].trim(), action = tm[3].trim();
    const parsed = parseConditions(condText);
    if (parsed.error) return send(`❌ ${esc(parsed.error)}`);
    if (action.length < 10) return send('지시문이 너무 짧다. 흥분한 미래의 네가 그대로 실행할 수 있게 구체적으로.');
    // 조건의 지표 존재 검증
    for (const c of parsed.conds) {
      if (!db.prepare('SELECT 1 FROM indicators WHERE id = ?').get(c.indicator_id)) {
        return send(`❌ 지표 #${c.indicator_id} 없음 — /ind 로 확인`);
      }
    }
    const { id } = stmts.insertTrigger.get({
      name, conditions_json: JSON.stringify(parsed.conds), action_text: action, scenario_id: null,
    });
    return send(`⚡ 트리거 #${id} 장전: <b>${esc(name)}</b>\n조건 충족 시 이 지시문이 작성일과 함께 돌아온다.`);
  }
  if (/^\/trig\s+add/.test(text)) {
    return send('형식: /trig add 이름 | 조건 | 지시문\n조건: <지표id><연산자><값>, & 결합 (예: 1>1600 & 7>5). 지표id는 /ind');
  }
  tm = text.match(/^\/trig\s+arm\s+(\d+)$/);
  if (tm) {
    stmts.armTrigger.run(Number(tm[1]));
    return send(`트리거 #${tm[1]} 재장전.`);
  }
  tm = text.match(/^\/trig\s+del\s+(\d+)$/);
  if (tm) {
    stmts.delTrigger.run(Number(tm[1]));
    return send(`트리거 #${tm[1]} 삭제.`);
  }

  // --- 시나리오 ---
  if (text === '/scn') {
    const rows = stmts.allScenarios.all();
    return send(rows.map((sc) => {
      const f = flags.label(flags.forScenario(sc.name), false);
      return `#${sc.id} ${esc(sc.name)}${f ? ' ' + f : ''}${sc.computed_at ? '' : ' (미계산)'}`;
    }).join('\n') || '시나리오 없음 — scripts/seed-graph.js 실행');
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

  const draftId = stmts.kvGet.get(`worldview_draft_msg_${replyId}`)?.value;
  if (draftId) {
    try {
      if (/^commit$/i.test(text)) return send(worldview.formatCommitted(worldview.commitDraft(Number(draftId))));
      if (/^cancel$/i.test(text)) { stmts.cancelWorldview.run(Number(draftId)); return send(`현재 관점 초안 #${draftId} 취소.`); }
      return send('초안 답장은 <code>commit</code> 또는 <code>cancel</code>.');
    } catch (e) { return send(`❌ ${esc(e.message)}`); }
  }

  const reviewCommitId = stmts.kvGet.get(`worldview_review_msg_${replyId}`)?.value;
  if (reviewCommitId) {
    try {
      const note = /^confirm$/i.test(text) ? null : text.trim();
      const proposals = worldview.confirmReview(Number(reviewCommitId), note);
      const automatic = proposals.filter((p) => p.status === 'pending');
      const manual = proposals.filter((p) => p.status === 'manual_review');
      return send([
        `📗 현재 관점 #${reviewCommitId} 검토 확정${note ? ' · 사용자 보정 메모 포함' : ''}.`,
        `자동 적용 가능한 수정 제안 ${automatic.length}건:`,
        ...automatic.map((p) => `#${p.id} ${p.proposal_type} ${esc(p.target_ref || '')}`),
        `구조 추가·분할 수동검토 ${manual.length}건:`,
        ...manual.map((p) => `#${p.id} ${p.proposal_type} ${esc(p.target_ref || '')}`),
        automatic.length ? '적용: /view apply &lt;제안id&gt; · 기각: /view reject &lt;제안id&gt;' : '',
      ].filter(Boolean).join('\n'));
    } catch (e) { return send(`❌ ${esc(e.message)}`); }
  }

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
  // 트리거 발동 알림: 예측이 아니라 이행 노트 — 즉시 기록·마감
  if (alert.kind === 'trigger_fired') {
    stmts.insertPrediction.get({
      alert_id: alert.id, statement: `[트리거 이행노트] ${text.trim()}`,
      expected_low: null, expected_high: null, target_date: new Date().toISOString().slice(0, 10),
    });
    db.prepare(`UPDATE predictions SET score = 'manual', graded_at = datetime('now') WHERE alert_id = ?`).run(alert.id);
    stmts.setAlertStatus.run('graded', alert.id);
    return send(`📜 이행 노트 기록됨 (알림 #${alert.id} 마감).`);
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

/** 인라인 버튼 클릭 처리 */
async function handleCallbackQuery(q) {
  if (String(q.message?.chat?.id ?? q.from?.id) !== String(TG_CHAT_ID())) return;
  const data = q.data || '';
  try {
    if (data === 'status') { await send(statusText()); return answerCallbackQuery(q.id); }
    if (data === 'track') { await send(formatTrack(stmts.trackRecord.all())); return answerCallbackQuery(q.id); }
    const m = data.match(/^alert:mute:(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const alert = db.prepare('SELECT status FROM alerts WHERE id = ?').get(id);
      if (!alert) return answerCallbackQuery(q.id, `알림 #${id} 없음`);
      if (alert.status !== 'open') return answerCallbackQuery(q.id, `이미 ${alert.status}`);
      stmts.setAlertStatus.run('muted', id);
      await send(`알림 #${id} muted. ⚠️ 회피도 트랙레코드에 남는다.`);
      return answerCallbackQuery(q.id, 'muted');
    }
    return answerCallbackQuery(q.id);
  } catch (e) {
    console.error('callback:', e.message);
    return answerCallbackQuery(q.id).catch(() => {});
  }
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

/** 인라인 버튼 클릭 처리 */
async function handleCallbackQuery(q) {
  const data = q.data || '';
  try {
    if (data === 'status') { await send(statusText()); return answerCallbackQuery(q.id); }
    if (data === 'track') { await send(formatTrack(stmts.trackRecord.all())); return answerCallbackQuery(q.id); }
    const m = data.match(/^alert:mute:(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const alert = db.prepare('SELECT status FROM alerts WHERE id = ?').get(id);
      if (!alert) return answerCallbackQuery(q.id, `알림 #${id} 없음`);
      if (alert.status !== 'open') return answerCallbackQuery(q.id, `이미 ${alert.status}`);
      stmts.setAlertStatus.run('muted', id);
      await send(`알림 #${id} muted. ⚠️ 회피도 트랙레코드에 남는다.`);
      return answerCallbackQuery(q.id, 'muted');
    }
    return answerCallbackQuery(q.id);
  } catch (e) {
    console.error('callback:', e.message);
    return answerCallbackQuery(q.id).catch(() => {});
  }
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
  await setMyCommands(BOT_COMMANDS).catch((e) => console.warn('setMyCommands:', e.message));
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
