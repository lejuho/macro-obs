// HHI 검증 리포트 — 캐시된 무역 점유율 × 해도 간선 weight 비교
// 실행:
//   node scripts/hhi-report.js --collect   # Comtrade 수집 (연 1~2회)
//   node scripts/hhi-report.js             # 리포트 출력 + edges.hhi 갱신
// weight 수정은 사람 몫: 리포트 보고 data/graph-seed.js 편집 → seed-graph --wipe → /scn recompute

const { stmts } = require('../src/db');
const { hhi, topShare, judge } = require('../src/hhi');


(async () => {
  if (process.argv.includes('--collect')) {
    const { collect } = require('../src/collectors/trade');
    console.log('Comtrade 수집 중 (품목당 1.5초 간격)...');
    for (const r of await collect({})) {
      console.log(r.ok ? `  ✅ ${r.node} hs${r.hs}: ${r.count}개국` : `  ❌ ${r.node} hs${r.hs}: ${r.error}`);
    }
    return;
  }

  const period = String(new Date().getFullYear() - 1);
  const map = require('../data/hhi-map');
  console.log(`=== HHI 검증 리포트 (${period}) ===`);
  console.log('verdict: ok(|Δ|<0.15) · review(0.15~0.3) · mismatch(>0.3)\n');
  let flagged = 0;
  for (const node of Object.keys(map)) {
    const shares = stmts.tradeSharesFor.all(node, period).map((r) => ({ partner: r.partner, v: r.v }));
    if (!shares.length) { console.log(`⬜ ${node}: 데이터 없음 (--collect 먼저)`); continue; }
    const edges = stmts.tradeEdgesInto.all(node);
    const h = hhi(shares), t = topShare(shares);
    console.log(`\n【${node}】 HHI ${h.toFixed(3)} · 1위 ${t.partner} ${(t.share * 100).toFixed(1)}%`);
    for (const e of edges) {
      const j = judge(e.weight, shares);
      stmts.setEdgeHhi.run(j.hhi, e.id);
      const mark = { ok: '✅', review: '🟡', mismatch: '🔴' }[j.verdict] || '⬜';
      console.log(`  ${mark} ${e.src_name}→${e.dst_name}: weight ${e.weight} vs 1위점유 ${j.top_share} (Δ${j.delta})`);
      if (j.verdict !== 'ok') flagged++;
    }
    if (!edges.length) console.log('  (manual:trade 유입 간선 없음)');
  }
  console.log(`\n${flagged}건 검토 필요. weight 수정은 graph-seed.js 편집 → seed-graph --wipe → /scn recompute`);
})();
