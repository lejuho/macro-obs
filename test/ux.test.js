// UX + 글로벌 지표 테스트: 커밋 예시 / 인라인 키보드 / 콜백 mute / FRED 파서 / 관찰 지표 API
// 실행: node --no-warnings test/ux.test.js

process.env.DB_PATH = '/tmp/macro-ux.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { formatBreach, formatCommitExample, alertKeyboard } = require('../src/notify/telegram');
const { parseObs } = require('../src/collectors/fred');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. 커밋 예시 — 가설 밴드 스케일 (환율 하드코딩 제거)');
assert(formatCommitExample({ band_low: 6000, band_high: 11000 }) === '6000~11000', '경상수지 스케일');
assert(formatCommitExample({ band_low: 2, band_high: 3.5 }) === '2~3.5', '금리 스케일');
assert(formatCommitExample({}) === '하한~상한', '밴드 없으면 일반형');
const msg = formatBreach({
  hyp: { indicator_name: '경상수지', statement: 's', rationale: 'r', band_low: 6000, band_high: 11000, unit: '백만달러', window_rule: 'close_2' },
  breach: { direction: 'below', observed_value: 4200, observed_date: '2026-07-01' },
});
assert(msg.includes('<code>6000~11000</code>'), 'formatBreach가 자기 밴드 예시 사용');

console.log('2. 인라인 키보드');
const kb = alertKeyboard(42);
assert(kb.inline_keyboard[0].some((b) => b.callback_data === 'alert:mute:42'), 'mute 버튼 + alert id');
assert(kb.inline_keyboard[0].length === 3, 'mute/status/track 3버튼');

console.log('3. 콜백 mute 플로우');
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/u', name: 'T', freq: 'D', unit: '', category: 'macro', note: null,
});
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, rationale)
  VALUES ('h', ?, 1, 2, 'r')`).run(indId);
const { id: alertId } = stmts.insertAlert.get({
  hypothesis_id: 1, observed_value: 3, observed_date: 'd', direction: 'above',
});
const { handleCallbackQuery } = require('../src/jobs/bot');
(async () => {
  await handleCallbackQuery({ id: 'cb1', data: `alert:mute:${alertId}` });
  assert(db.prepare('SELECT status FROM alerts WHERE id=?').get(alertId).status === 'muted', '버튼 클릭 → muted');
  await handleCallbackQuery({ id: 'cb2', data: `alert:mute:${alertId}` }); // 중복 클릭
  assert(db.prepare('SELECT status FROM alerts WHERE id=?').get(alertId).status === 'muted', '중복 클릭 무해');
  await handleCallbackQuery({ id: 'cb3', data: 'alert:mute:999' }); // 없는 알림
  pass++; console.log('  ✅ 없는 알림 콜백 무해');

  console.log('4. FRED 파서 — 결측(.) 필터');
  const obs = parseObs([
    { date: '2026-07-01', value: '4.32' },
    { date: '2026-07-02', value: '.' },
    { date: '2026-07-03', value: '4.41' },
  ]);
  assert(obs.length === 2 && obs[1].value === 4.41, "'.' 결측 제거 + 숫자 변환");

  console.log('5. 관찰 지표 API (가설 없는 지표만)');
  const { id: watchId } = stmts.upsertIndicator.get({
    source: 'fred', source_code: 'VIXCLS', name: 'VIX', freq: 'D', unit: 'pt',
    category: 'global', note: '주식 위험회피 노브',
  });
  stmts.upsertObs.run(watchId, '2026-07-01', 18.5);
  stmts.upsertObs.run(indId, '2026-07-01', 1.5); // 가설 있는 지표
  const { api } = require('../src/jobs/server');
  const st = api.status();
  assert(st.watch.some((w) => w.name === 'VIX' && w.note.includes('노브')), '관찰 지표 + 노브 문장');
  assert(!st.watch.some((w) => w.id === indId), '가설 있는 지표는 관찰 목록에서 제외');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
