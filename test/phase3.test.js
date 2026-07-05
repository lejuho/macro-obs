// Phase 3 테스트: 전파 엔진 + 시드 무결성
// 실행: node --no-warnings test/phase3.test.js

process.env.DB_PATH = '/tmp/macro-p3.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { propagate, DAMP, PRUNE } = require('../src/graph');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 그래프 헬퍼: adjacency map → edgesFrom 함수
function G(edges) {
  const map = new Map();
  edges.forEach((e, i) => {
    if (!map.has(e.src)) map.set(e.src, []);
    map.get(e.src).push({ id: i, ...e });
  });
  return (id) => map.get(id) || [];
}

console.log('1. 기본 전파 + 감쇠');
// A -(w0.8)-> B -(w0.9)-> C : 첫 물리홉 감쇠 없음, 둘째 홉부터 DAMP
let r = propagate(G([
  { src: 1, dst: 2, sign: 1, weight: 0.8, kind: 'supply' },
  { src: 2, dst: 3, sign: 1, weight: 0.9, kind: 'supply' },
]), [{ node_id: 1, impact: -1 }]);
const b = r.find((x) => x.node_id === 2), c = r.find((x) => x.node_id === 3);
assert(near(b.impact, -0.8) && b.hops === 1, '1홉: -1 × 0.8 (감쇠 없음)');
assert(near(c.impact, -0.8 * 0.9 * DAMP) && c.hops === 2, '2홉: × 0.9 × damp');

console.log('2. sign 반전 (수혜 경로)');
r = propagate(G([{ src: 1, dst: 2, sign: -1, weight: 0.8, kind: 'transit' }]),
  [{ node_id: 1, impact: -1 }]);
assert(near(r[0].impact, 0.8), '충격(-1) × sign(-1) = 수혜(+)');

console.log('3. 가지치기');
r = propagate(G([{ src: 1, dst: 2, sign: 1, weight: 0.04, kind: 'supply' }]),
  [{ node_id: 1, impact: -1 }]);
assert(r.length === 0, `|impact| < ${PRUNE} 제거`);

console.log('4. 3홉 상한');
r = propagate(G([
  { src: 1, dst: 2, sign: 1, weight: 1, kind: 'supply' },
  { src: 2, dst: 3, sign: 1, weight: 1, kind: 'supply' },
  { src: 3, dst: 4, sign: 1, weight: 1, kind: 'supply' },
  { src: 4, dst: 5, sign: 1, weight: 1, kind: 'supply' },
]), [{ node_id: 1, impact: -1 }]);
assert(!r.find((x) => x.node_id === 5), '4홉째 도달 없음');
assert(r.find((x) => x.node_id === 4), '3홉까지는 도달');

console.log('5. coercion_transfer — 홉·감쇠 미계상');
r = propagate(G([
  { src: 1, dst: 2, sign: 1, weight: 0.6, kind: 'coercion_transfer' },
  { src: 2, dst: 3, sign: 1, weight: 0.9, kind: 'supply' },
]), [{ node_id: 1, impact: -1 }]);
const c2 = r.find((x) => x.node_id === 2), c3 = r.find((x) => x.node_id === 3);
assert(near(c2.impact, -0.6) && c2.hops === 0, 'coercion 간선: 홉 0, 감쇠 없음');
assert(near(c3.impact, -0.6 * 0.9) && c3.hops === 1, '이후 첫 물리홉도 감쇠 없음');

console.log('6. 순환 방지 + 경합 경로 보존');
r = propagate(G([
  { src: 1, dst: 2, sign: 1, weight: 0.9, kind: 'supply' },   // 피해 경로
  { src: 1, dst: 3, sign: 1, weight: 0.8, kind: 'supply' },
  { src: 3, dst: 2, sign: -1, weight: 0.5, kind: 'supply' },  // 수혜 경로 (2홉)
  { src: 2, dst: 1, sign: 1, weight: 0.9, kind: 'supply' },   // 순환
]), [{ node_id: 1, impact: -1 }]);
const toB = r.filter((x) => x.node_id === 2);
assert(toB.length === 2, '같은 노드로의 두 경로 모두 보존 (비합산)');
assert(toB.some((x) => x.impact < 0) && toB.some((x) => x.impact > 0), '피해/수혜 부호 공존');
assert(!r.find((x) => x.node_id === 1), '순환으로 시작점 재도달 없음');

console.log('7. 시드 무결성 (실DB 시드 + 전 시나리오 계산)');
const { execSync } = require('child_process');
execSync(`DB_PATH=${process.env.DB_PATH} node --no-warnings scripts/seed-graph.js`, { cwd: __dirname + '/..' });
const { stmts } = require('../src/db');
const { formatScenario } = require('../src/graph');
const scs = stmts.allScenarios.all();
const { SCENARIOS } = require('../data/graph-seed');
assert(scs.length === SCENARIOS.length && scs.every((s) => s.computed_at), '시나리오 전부 사전계산됨');
const coercion = scs.find((s) => s.name === '미국 관세·산업정책 압박');
const out = formatScenario(coercion);
assert(out.includes('반도체') && out.includes('경합'), 'CMS 시나리오: 반도체 경합 표시');
// v2: 원화급락은 시나리오가 아니라 흐름 — 역방향 조회로 대체 검증
const hits = stmts.scenariosHittingNode.all('%원화가치%');
assert(new Set(hits.map((h) => h.name)).size >= 5, '역방향: 원화가치를 미는 시나리오 다수');
const boj = scs.find((s) => s.name === 'BOJ 긴축 쇼크');
assert(formatScenario(boj).includes('인터넷성장주'), '금융 체인이 멀티충격으로 산업 도달');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
