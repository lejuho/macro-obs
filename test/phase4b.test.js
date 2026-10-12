// Phase 4b 테스트: HHI 수학 + 판정 + 파이프라인 (합성 무역 데이터)
// 실행: node --no-warnings test/phase4b.test.js

process.env.DB_PATH = '/tmp/macro-p4b.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { execSync } = require('child_process');
execSync(`DB_PATH=${process.env.DB_PATH} node --no-warnings scripts/seed-graph.js`, { cwd: __dirname + '/..' });

const { stmts } = require('../src/db');
const { hhi, topShare, judge } = require('../src/hhi');
const { parseShares } = require('../src/collectors/trade');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('1. hhi / topShare');
const even4 = [{ partner: 'A', v: 25 }, { partner: 'B', v: 25 }, { partner: 'C', v: 25 }, { partner: 'D', v: 25 }];
assert(near(hhi(even4), 0.25), '균등 4개국 = 0.25');
const mono = [{ partner: 'CN', v: 90 }, { partner: 'X', v: 10 }];
assert(near(hhi(mono), 0.81 + 0.01), '90/10 집중 = 0.82');
assert(topShare(mono).partner === 'CN' && near(topShare(mono).share, 0.9), '1위 식별');
assert(hhi([]) === null, '빈 데이터 → null');

console.log('2. judge — verdict 경계');
const shares70 = [{ partner: 'ME', v: 70 }, { partner: 'US', v: 30 }];
assert(judge(0.7, shares70).verdict === 'ok', 'weight 0.7 vs 1위 0.7 → ok');
assert(judge(0.5, shares70).verdict === 'review', 'Δ0.2 → review');
assert(judge(0.3, shares70).verdict === 'mismatch', 'Δ0.4 → mismatch');
assert(judge(0.5, []).verdict === 'no_data', '데이터 없음');

console.log('3. Comtrade 파서 — World 합계 제외');
const parsed = parseShares({ data: [
  { partnerCode: 0, partnerDesc: 'World', primaryValue: 100 },
  { partnerCode: 682, partnerDesc: 'Saudi Arabia', primaryValue: 40 },
  { partnerCode: 784, partnerDesc: 'UAE', primaryValue: 25 },
  { partnerCode: 840, partnerDesc: 'USA', primaryValue: 0 },
] });
assert(parsed.length === 2 && parsed[0].partner === 'Saudi Arabia', 'World(0)·0값 제외');

console.log('4. 파이프라인: 점유율 캐시 → 리포트 조인 → edges.hhi 갱신');
// 원유수입: 사우디 60 / UAE 25 / 미국 15 → HHI 0.445, 1위 0.6
for (const [partner, v] of [['Saudi Arabia', 60], ['UAE', 25], ['USA', 15]]) {
  stmts.upsertTradeShare.run({ node_name: '원유수입', hs: '2709', partner, value_usd: v, period: '2025' });
}
const shares = stmts.tradeSharesFor.all('원유수입', '2025').map((r) => ({ partner: r.partner, v: r.v }));
assert(near(hhi(shares), 0.36 + 0.0625 + 0.0225), 'DB 조회 → HHI 계산');

const edges = stmts.tradeEdgesInto.all('원유수입');
assert(edges.length >= 2, 'manual:trade 유입 간선 조회 (호르무즈·말라카)');
const hormuz = edges.find((e) => e.src_name === '호르무즈해협');
const j = judge(hormuz.weight, shares);
assert(j.verdict === 'ok' && near(hormuz.weight, 0.7), '호르무즈 0.7 vs 1위 0.6 → ok (Δ0.1)');
stmts.setEdgeHhi.run(j.hhi, hormuz.id);
const { db } = require('../src/db');
assert(near(db.prepare('SELECT hhi FROM edges WHERE id=?').get(hormuz.id).hhi, j.hhi), 'edges.hhi 저장');

console.log('5. multi-HS 노드 합산 (배터리광물: 리튬 2종 + 흑연)');
for (const [hs, partner, v] of [['283691', 'China', 50], ['282520', 'China', 30], ['2504', 'China', 15], ['283691', 'Chile', 20]]) {
  stmts.upsertTradeShare.run({ node_name: '배터리광물수입', hs, partner, value_usd: v, period: '2025' });
}
const bat = stmts.tradeSharesFor.all('배터리광물수입', '2025').map((r) => ({ partner: r.partner, v: r.v }));
assert(bat[0].partner === 'China' && near(bat[0].v, 95), 'HS 합산 GROUP BY partner');
assert(near(topShare(bat).share, 95 / 115), '중국 점유 83%');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
