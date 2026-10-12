// MCP 3층 테스트: 쓰기 도구 + origin 태깅 + 토큰 게이트
// 실행: node --no-warnings test/mcp-write.test.js

process.env.DB_PATH = '/tmp/macro-mcpw.db';
process.env.DRY_RUN = '1';
process.env.MCP_WRITE_TOKEN = 'test-token-1234';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { createHandler, TOOLS } = require('../src/mcp');
const { WRITE_TOOLS } = require('../src/mcp-write-tools');
const { formatTrack } = require('../src/predictions');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

const full = createHandler([...TOOLS, ...WRITE_TOOLS]);
const call = async (name, args) => {
  const r = await full({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { data: r.result?.isError ? null : JSON.parse(r.result.content[0].text), isError: !!r.result?.isError, text: r.result?.content?.[0]?.text, raw: r };
};

// 픽스처: 지표 + 가설 + open 알림
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/w3', name: '원/달러 환율', freq: 'D', unit: '원', category: 'macro', note: null,
});
stmts.upsertObs.run(indId, '2026-07-05', 1554);
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, rationale)
  VALUES ('환율 뉴노멀: 1350~1480 밴드', ?, 1350, 1480, '레벨시프트')`).run(indId);
const { id: alertId } = stmts.insertAlert.get({
  hypothesis_id: 1, observed_value: 1554, observed_date: '2026-07-05', direction: 'above',
});

(async () => {
  console.log('1. commit_prediction — origin=assisted');
  let c = await call('commit_prediction', { alert_id: alertId, statement: '1500~1580' });
  assert(c.data.origin === 'assisted' && c.data.band[0] === 1500, '커밋 + assisted 태깅');
  const pred = db.prepare(`SELECT * FROM predictions WHERE id = ?`).get(c.data.prediction_id);
  assert(pred.origin === 'assisted' && pred.expected_high === 1580, 'DB origin 확인');
  assert(db.prepare(`SELECT status FROM alerts WHERE id=?`).get(alertId).status === 'committed', '알림 → committed');

  console.log('2. 가드');
  c = await call('commit_prediction', { alert_id: alertId, statement: '1500~1580' });
  assert(c.isError && c.text.includes('이미 committed'), '중복 커밋 거부');
  c = await call('commit_prediction', { alert_id: 999, statement: '1' });
  assert(c.isError, '없는 알림 거부');
  const { id: alert2 } = stmts.insertAlert.get({
    hypothesis_id: 1, observed_value: 1560, observed_date: '2026-07-06', direction: 'above',
  });
  c = await call('commit_prediction', { alert_id: alert2, statement: 'mute' });
  assert(c.isError && c.text.includes('직접'), 'mute는 도구로 불가 (회피는 사용자 직접)');

  console.log('3. 텔레그램 커밋은 여전히 human (기본값)');
  const { id: humanPred } = stmts.insertPrediction.get({
    alert_id: alert2, statement: '1520~1590', expected_low: 1520, expected_high: 1590,
    target_date: '2026-10-04',
  });
  assert(db.prepare(`SELECT origin FROM predictions WHERE id=?`).get(humanPred).origin === 'human', '기본 origin=human');

  console.log('4. revise_hypothesis — 체인 + origin + 근거 가드');
  c = await call('revise_hypothesis', { hypothesis_id: 1, band_low: 1450, band_high: 1600, rationale: '짧음' });
  assert(c.isError && c.text.includes('짧다'), '근거 10자 미만 거부');
  c = await call('revise_hypothesis', {
    hypothesis_id: 1, band_low: 1600, band_high: 1450,
    rationale: '1554 지속과 경상 구조 변화로 레벨 상향 합의',
  });
  assert(c.data.new_band[0] === 1450 && c.data.new_band[1] === 1600, '역순 밴드 정규화');
  const newHyp = stmts.hypById.get(c.data.new_hypothesis_id);
  assert(newHyp.origin === 'assisted' && newHyp.revised_from === 1, 'assisted + revised_from 체인');
  assert(stmts.hypById.get(1).status === 'revised', '구가설 retire');
  c = await call('revise_hypothesis', { hypothesis_id: 1, band_low: 1, band_high: 2, rationale: '충분히 긴 근거 문장' });
  assert(c.isError && c.text.includes('revised'), 'retire된 가설 재수정 거부');

  console.log('5. add_trigger — 파싱 + 지표 존재 가드');
  c = await call('add_trigger', {
    name: '환율 위기국면', conditions: `${indId}>1600`,
    action_text: '신규 리스크자산 매수 중단, 달러예금 비중 재검토. 물타기 금지.',
  });
  assert(c.data.trigger_id > 0 && c.data.conditions[0].value === 1600, '트리거 장전');
  c = await call('add_trigger', { name: 't', conditions: '999>1', action_text: '충분히 긴 지시문입니다' });
  assert(c.isError && c.text.includes('list_indicators'), '없는 지표 거부');
  c = await call('add_trigger', { name: 't', conditions: '환율>1600', action_text: '충분히 긴 지시문입니다' });
  assert(c.isError, '조건 형식 오류 거부');

  console.log('6. 노출 경계 — stdio 전체 / HTTP 토큰 게이트');
  const list = await full({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert(list.result.tools.length === TOOLS.length + 3, 'stdio 핸들러: 읽기+쓰기 전체');

  const { createServer } = require('../src/jobs/server');
  const server = createServer(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth) => fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  let r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert(r.result.tools.length === TOOLS.length + 1, 'HTTP 무인증: 읽기 전용 (+get_reports)');
  r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'commit_prediction', arguments: { alert_id: 1, statement: '1' } } });
  assert(r.error?.code === -32602, 'HTTP 무인증 쓰기 호출 → unknown tool');
  r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'wrong-token-9999');
  assert(r.result.tools.length === TOOLS.length + 1, '틀린 토큰 → 읽기 전용');
  r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'test-token-1234');
  assert(r.result.tools.length === TOOLS.length + 3 + 2, '올바른 토큰 → 쓰기 + 보고서 도구');
  server.close();

  console.log('7. origin 분리 트랙레코드');
  // assisted 1건 + human 1건 채점
  stmts.gradePrediction.run(1554, 'hit', pred.id);
  stmts.gradePrediction.run(1700, 'miss', humanPred);
  const rows = stmts.trackRecord.all();
  assert(rows.some((x) => x.origin === 'assisted') && rows.some((x) => x.origin === 'human'), 'trackRecord에 origin');
  const txt = formatTrack(rows);
  assert(txt.includes('origin 실험') && txt.includes('🤝 assisted: 100%') && txt.includes('🧠 human: 0%'), '분리 집계 표시');
  assert(txt.includes('원/달러 환율') && txt.includes('hit 1 · partial 0 · miss 1'), '지표 합산은 origin 통합');
  // human만 있으면 실험 섹션 미표시 (기존 사용자 경험 유지)
  const humanOnly = rows.filter((x) => x.origin === 'human');
  assert(!formatTrack(humanOnly).includes('origin 실험'), '단일 origin이면 실험 섹션 숨김');

  const { api } = require('../src/jobs/server');
  assert(api.track().origin_summary.length >= 2, 'api.track origin_summary');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
