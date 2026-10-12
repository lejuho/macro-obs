// Phase 4 테스트: 파생 지표 계산 + 트리거 전 과정
// 실행: node --no-warnings test/phase4.test.js

process.env.DB_PATH = '/tmp/macro-p4.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { yoy, momDiff, spread } = require('../src/derived');
const { parseConditions, evaluate, scan, formatFired } = require('../src/triggers');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));
const near = (a, b) => Math.abs(a - b) < 1e-6;

console.log('1. yoy — 전년동월비');
let r = yoy([
  { date: '2025-06-01', value: 500 },
  { date: '2025-07-01', value: 520 },
  { date: '2026-06-01', value: 600 },
  { date: '2026-07-01', value: 494 },
]);
assert(r.length === 2, '전년 대응월 있는 것만');
assert(near(r[0].value, 20), '600/500 = +20%');
assert(near(r[1].value, -5), '494/520 = -5%');

console.log('2. momDiff — 누적→월간 플로우 복원');
r = momDiff([
  { date: '2025-12-01', value: 90000 },
  { date: '2026-01-01', value: 8000 },   // 1월: 리셋, 값 그대로
  { date: '2026-02-01', value: 17000 },
  { date: '2026-03-01', value: 24500 },
]);
assert(r.find((x) => x.date === '2026-01-01').value === 8000, '1월 = 원값 (연초 리셋)');
assert(r.find((x) => x.date === '2026-02-01').value === 9000, '2월 = 17000-8000');
assert(r.find((x) => x.date === '2026-03-01').value === 7500, '3월 = 24500-17000');

console.log('3. spread — 날짜 매칭 차');
r = spread(
  [{ date: '2026-07-01', value: 3.1 }, { date: '2026-07-02', value: 3.2 }, { date: '2026-07-03', value: 3.3 }],
  [{ date: '2026-07-01', value: 4.48 }, { date: '2026-07-03', value: 4.5 }],
);
assert(r.length === 2 && near(r[0].value, -1.38), '매칭 날짜만, 3.1-4.48');

console.log('4. parseConditions');
let p = parseConditions('1>1600 & 7 >= 5.0');
assert(p.conds?.length === 2 && p.conds[0].op === '>' && p.conds[1].op === '>=', '두 조건 AND 파싱');
assert(parseConditions('환율>1600').error != null, '지표id 아닌 형식 거부');
assert(parseConditions('').error != null, '빈 조건 거부');

console.log('5. evaluate — AND + 결측 안전');
const latest = (m) => (id) => m[id] ?? null;
assert(evaluate(p.conds, latest({ 1: 1650, 7: 5.2 })) === true, '전 조건 충족 → true');
assert(evaluate(p.conds, latest({ 1: 1650, 7: 4.0 })) === false, '하나라도 미충족 → false');
assert(evaluate(p.conds, latest({ 1: 1650 })) === false, '값 없는 지표 → false (안전측)');

console.log('6. 트리거 발동 전 과정 (DB)');
const { id: indA } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/a', name: '환율T', freq: 'D', unit: '원', category: 'macro', note: null,
});
stmts.upsertObs.run(indA, '2026-07-04', 1610);
const { id: trigId } = stmts.insertTrigger.get({
  name: '환율위기 지시서',
  conditions_json: JSON.stringify([{ indicator_id: indA, op: '>', value: 1600 }]),
  action_text: '신규 리스크자산 매수 중단, 달러예금 비중 재검토. 흥분해서 물타기 금지.',
  scenario_id: null,
});
let fired = scan();
assert(fired.length === 1 && fired[0].trigger.id === trigId, '조건 충족 → 발동');
assert(db.prepare('SELECT armed FROM triggers WHERE id=?').get(trigId).armed === 0, '발동 후 disarm');
assert(scan().length === 0, '재스캔 시 재발동 없음 (armed=0)');
const alertRow = db.prepare(`SELECT * FROM alerts WHERE trigger_id = ?`).get(trigId);
assert(alertRow && alertRow.kind === 'trigger_fired' && alertRow.status === 'open', 'trigger_fired 알림 생성');

const msg = formatFired(fired[0]);
assert(msg.includes('물타기 금지') && msg.includes('의 네가 지금의 너에게'), '지시서 원문 + 작성일 프레임');
assert(msg.includes(`/trig arm ${trigId}`), '재장전 안내');

console.log('7. 트리거 알림 답장 → 이행 노트 (매칭 경로)');
stmts.setAlertTgId.run(555, alertRow.id);
const found = stmts.alertByTgId.get(555);
assert(found && found.kind === 'trigger_fired', 'LEFT JOIN으로 트리거 알림도 매칭');
const { handleCommit } = require('../src/jobs/bot');
(async () => {
  await handleCommit(found, '지시대로 매수 중단함. 달러예금은 이미 30%라 유지.');
  const pred = db.prepare(`SELECT * FROM predictions WHERE alert_id = ?`).get(alertRow.id);
  assert(pred && pred.statement.startsWith('[트리거 이행노트]'), '이행 노트 기록');
  assert(pred.score === 'manual' && pred.graded_at, '즉시 마감 (90일 채점 불필요)');
  assert(db.prepare('SELECT status FROM alerts WHERE id=?').get(alertRow.id).status === 'graded', '알림 마감');

  console.log('8. 재장전');
  stmts.armTrigger.run(trigId);
  assert(scan().length === 1, '재장전 후 조건 여전 충족 → 재발동');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
