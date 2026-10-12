// 합성 데이터 E2E 테스트 (네트워크 불필요)
// 검증: close_N 판정 / 밴드 내 미발화 / 쿨다운 / 알림 포맷
// 실행: DB_PATH=/tmp/macro-test.db node test/e2e.test.js

process.env.DB_PATH = process.env.DB_PATH || '/tmp/macro-test.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { scan, judge } = require('../src/watcher');
const { formatBreach } = require('../src/notify/telegram');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

// --- 셋업: 가짜 환율 indicator + 가설 ---
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'TEST/usdkrw', name: '테스트 환율',
  freq: 'D', unit: 'KRW/USD', category: 'macro', note: null,
});
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, window_rule, rationale)
  VALUES ('테스트 뉴노멀 1350~1480', ?, 1350, 1480, 'close_3', '테스트 근거')`).run(indId);

function setObs(values) {
  db.prepare(`DELETE FROM observations WHERE indicator_id = ?`).run(indId);
  values.forEach((v, i) => {
    const d = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
    stmts.upsertObs.run(indId, d, v);
  });
}

console.log('1. 밴드 내 → 알림 없음');
setObs([1400, 1410, 1420]);
assert(scan().length === 0, 'in-band no alert');

console.log('2. 2회만 이탈 (close_3 미충족) → 알림 없음');
setObs([1400, 1490, 1495]);
assert(scan().length === 0, 'close_3 not met with 2 breaches');

console.log('3. 3회 연속 상단 이탈 → 알림 1건');
setObs([1400, 1485, 1490, 1495]);
const breaches = scan();
assert(breaches.length === 1, 'breach detected');
assert(breaches[0].breach.direction === 'above', 'direction=above');
assert(breaches[0].breach.observed_value === 1495, 'latest value reported');

console.log('4. 쿨다운 내 재스캔 → 중복 알림 없음');
assert(scan().length === 0, 'cooldown suppresses duplicate');

const alertId = breaches[0].alert_id;
stmts.insertPrediction.get({
  alert_id: alertId, statement: '1440~1570', expected_low: 1440, expected_high: 1570,
  target_date: '2026-10-01',
});
stmts.setAlertStatus.run('committed', alertId);
db.prepare(`UPDATE alerts SET triggered_at = datetime('now', '-8 day') WHERE id = ?`).run(alertId);
assert(scan().length === 0, 'pending same-direction prediction suppresses reminder');

setObs([1345, 1340, 1335]);
const opposite = scan();
assert(opposite.length === 1 && opposite[0].breach.direction === 'below',
  'opposite-direction breach still fires');

console.log('5. judge 순수함수: 하단 이탈');
const j = judge(
  { band_low: 1350, band_high: 1480, window_rule: 'close_2' },
  [{ date: '2026-07-05', value: 1340 }, { date: '2026-07-04', value: 1345 }],
);
assert(j && j.direction === 'below', 'below breach via judge()');

console.log('6. 데이터 부족 시 판정 보류');
assert(judge({ band_low: 1, band_high: 2, window_rule: 'close_3' },
  [{ date: 'd', value: 5 }]) === null, 'insufficient data → null');

console.log('7. 알림 메시지 포맷 (HTML 이스케이프 포함)');
const msg = formatBreach({
  hyp: { indicator_name: '원/달러 <환율>', statement: 'S', rationale: 'R & B',
    band_low: 1350, band_high: 1480, unit: 'KRW/USD', window_rule: 'close_3' },
  breach: { direction: 'above', observed_value: 1495, observed_date: '2026-07-04' },
});
assert(msg.includes('&lt;환율&gt;') && msg.includes('R &amp; B'), 'HTML escaped');
assert(msg.includes('90일 뒤'), 'commit prompt present');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
