// 밴드 참고치 + 가설 수정 체인 테스트
// 실행: node --no-warnings test/hyp.test.js

process.env.DB_PATH = '/tmp/macro-hyp.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { stats, formatContext } = require('../src/bandstats');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. stats 순수함수');
const obs = [
  { date: '2026-01-01', value: 1400 },
  { date: '2026-02-01', value: 1420 },
  { date: '2026-03-01', value: 1380 },
  { date: '2026-04-01', value: 1460 },
  { date: '2026-05-01', value: 1440 },
];
const s = stats(obs);
assert(s.n === 5 && s.min === 1380 && s.max === 1460, 'n/min/max');
assert(s.p50 === 1420, 'median');
assert(s.latest === 1440 && s.latest_date === '2026-05-01', 'latest by date not by order');
assert(stats([]) === null, 'empty → null');

console.log('2. formatContext에 비추천 경고 포함');
const ctx = formatContext(
  { indicator_name: 'T', band_low: 1350, band_high: 1480 }, obs, obs);
assert(ctx.includes('추천이 아니다'), 'anti-recommendation warning present');
assert(ctx.includes('p10/p50/p90'), 'percentiles present');

console.log('3. 가설 수정 체인 (revised_from)');
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/h', name: 'T환율', freq: 'D', unit: 'W', category: 'macro', note: null,
});
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, window_rule, rationale)
  VALUES ('환율 뉴노멀: 1350~1480 밴드', ?, 1350, 1480, 'close_3', '구근거')`).run(indId);

const { id: newId } = stmts.reviseHyp.get({
  statement: '환율 뉴노멀: 1380~1520 밴드',
  band_low: 1380, band_high: 1520, rationale: '경상수지 하향에 따른 상향 조정', old_id: 1,
});
stmts.retireHyp.run(1);

const oldH = stmts.hypById.get(1);
const newH = stmts.hypById.get(newId);
assert(oldH.status === 'revised', 'old hypothesis retired as revised');
assert(newH.status === 'active' && newH.revised_from === 1, 'new hypothesis chains to old');
assert(newH.window_rule === 'close_3' && newH.indicator_id === indId, 'indicator/window_rule inherited');
assert(stmts.activeHypotheses.all().length === 1, 'only new one active');

console.log('4. 수정 체인이 감시기에 반영');
const { scan } = require('../src/watcher');
// 구밴드(1480) 위지만 신밴드(1520) 아래 → 알림 없어야 함
['2026-07-01', '2026-07-02', '2026-07-03'].forEach((d, i) =>
  stmts.upsertObs.run(indId, d, 1500 + i));
assert(scan().length === 0, 'old band no longer fires');
// 신밴드도 돌파 → 알림
['2026-07-04', '2026-07-05', '2026-07-06'].forEach((d, i) =>
  stmts.upsertObs.run(indId, d, 1530 + i));
const br = scan();
assert(br.length === 1 && br[0].hyp.id === newId, 'new band fires against new hypothesis');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
