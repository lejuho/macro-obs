// Phase 1 테스트: parseCommit / grade 순수함수 + DB 커밋-채점 플로우
// 실행: DB_PATH=/tmp/macro-p1.db node --no-warnings test/phase1.test.js

process.env.DB_PATH = process.env.DB_PATH || '/tmp/macro-p1.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { parseCommit, grade, targetDate, formatTrack } = require('../src/predictions');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. parseCommit');
let p = parseCommit('1450~1520');
assert(p.expected_low === 1450 && p.expected_high === 1520 && p.structured, 'band tilde');
p = parseCommit('1520 - 1450');
assert(p.expected_low === 1450 && p.expected_high === 1520, 'band reversed+dash normalized');
p = parseCommit('1500');
assert(Math.abs(p.expected_low - 1470) < 1e-9 && Math.abs(p.expected_high - 1530) < 1e-9, 'point → ±2% band');
p = parseCommit('연말까지 1550 뚫고 위기 국면 간다');
assert(!p.structured && p.expected_low === null, 'free text → unstructured');
assert(parseCommit('MUTE').mute === true, 'mute keyword');
assert(/^\d{4}-\d{2}-\d{2}$/.test(targetDate()), 'targetDate ISO format');

console.log('2. grade');
const band = { expected_low: 1450, expected_high: 1520 };
assert(grade(band, { date: '2026-10-03', value: 1480 }, '2026-10-03').score === 'hit', 'in-band hit');
// 밴드폭 70의 10% = 7 → 1520+7=1527까지 partial
assert(grade(band, { date: '2026-10-03', value: 1525 }, '2026-10-03').score === 'partial', 'edge partial');
assert(grade(band, { date: '2026-10-03', value: 1560 }, '2026-10-03').score === 'miss', 'far miss');
assert(grade(band, null, '2026-10-03').score === 'void', 'no obs → void');
assert(grade(band, { date: '2026-09-01', value: 1480 }, '2026-10-03').score === 'void', 'stale obs (>14d) → void');
assert(grade({ expected_low: null, expected_high: null }, { date: '2026-10-03', value: 1 }, '2026-10-03').score === 'manual', 'free text → manual');

console.log('3. DB 플로우: alert → commit → grade');
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/x', name: 'T환율', freq: 'D', unit: 'W', category: 'macro',
});
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, rationale)
  VALUES ('h', ?, 1350, 1480, 'r')`).run(indId);
const { id: alertId } = stmts.insertAlert.get({
  hypothesis_id: 1, observed_value: 1490, observed_date: '2026-07-04', direction: 'above',
});
stmts.setAlertTgId.run(777, alertId);
const found = stmts.alertByTgId.get(777);
assert(found && found.id === alertId, 'alert lookup by tg_message_id');

// 커밋 (과거 target_date로 넣어 즉시 채점 대상화)
const { id: predId } = stmts.insertPrediction.get({
  alert_id: alertId, statement: '1500~1550',
  expected_low: 1500, expected_high: 1550, target_date: '2026-07-01',
});
stmts.setAlertStatus.run('committed', alertId);
assert(db.prepare(`SELECT status FROM alerts WHERE id=?`).get(alertId).status === 'committed', 'alert → committed');

stmts.upsertObs.run(indId, '2026-06-30', 1512);
const due = stmts.dueForGrading.all();
assert(due.length === 1 && due[0].id === predId, 'due for grading query');
const obs = stmts.obsOnOrBefore.get(indId, '2026-07-01');
const g = grade(due[0], obs, due[0].target_date);
assert(g.score === 'hit' && g.actual === 1512, 'graded hit with actual');
stmts.gradePrediction.run(g.actual, g.score, predId);
stmts.setAlertStatus.run('graded', alertId);

console.log('4. 재촉(nag) 쿼리');
const { id: a2 } = stmts.insertAlert.get({
  hypothesis_id: 1, observed_value: 1495, observed_date: '2026-07-05', direction: 'above',
});
db.prepare(`UPDATE alerts SET triggered_at = datetime('now','-2 day') WHERE id=?`).run(a2);
let nags = stmts.openAlertsToNag.all();
assert(nags.length === 1 && nags[0].id === a2, 'open+aged alert is nagged');
stmts.bumpNag.run(a2);
assert(stmts.openAlertsToNag.all().length === 0, 'nag cooldown (24h) suppresses');
db.prepare(`UPDATE alerts SET nag_count = 3, last_nag_at = datetime('now','-2 day') WHERE id=?`).run(a2);
assert(stmts.openAlertsToNag.all().length === 0, 'nag cap 3 respected');

console.log('5. 트랙레코드 포맷');
const track = formatTrack(stmts.trackRecord.all());
assert(track.includes('T환율') && track.includes('hit 1'), 'track record includes graded pred');
assert(formatTrack([]).includes('아직'), 'empty track message');

console.log('6. 마이그레이션 멱등성 (재실행 시 오류 없음)');
// db.js를 다시 require해도 user_version 가드로 ALTER 중복 실행 안 됨 — 프로세스 재시작 시뮬레이션은
// user_version 확인으로 대체
assert(db.prepare('PRAGMA user_version').get().user_version === 1, 'user_version advanced once');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
