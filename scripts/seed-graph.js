// 그래프 시드 등록 + 시나리오 사전계산
// 실행: node scripts/seed-graph.js          (노드/간선 있으면 중단 — 수동 편집 보호)
//       node scripts/seed-graph.js --wipe   (전체 재시드)

const { db, stmts, tx } = require('../src/db');
const { NODES, EDGES, SCENARIOS } = require('../data/graph-seed');
const { computeAll } = require('../src/graph');

const wipe = process.argv.includes('--wipe');
const existing = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
if (existing && !wipe) {
  console.log(`노드 ${existing}개 존재 — 수동 편집 보호를 위해 중단. 재시드하려면 --wipe`);
  process.exit(1);
}

tx(() => {
  if (wipe) {
    db.exec('DELETE FROM scenario_results');
    stmts.clearGraph.run();
    stmts.clearNodes.run();
  }
  const idOf = {};
  for (const [type, name, meta] of NODES) {
    idOf[name] = stmts.upsertNode.get({ type, name, meta_json: meta ? JSON.stringify(meta) : null }).id;
  }
  for (const [src, dst, kind, sign, weight, source, path_note, condition_note, leverage_note] of EDGES) {
    if (!idOf[src] || !idOf[dst]) throw new Error(`간선 노드 누락: ${src}→${dst}`);
    stmts.insertEdge.run({
      src: idOf[src], dst: idOf[dst], kind, sign, weight, hhi: null, source: source || 'manual',
      path_note, condition_note: condition_note || null, leverage_note: leverage_note || null,
    });
  }
  for (const sc of SCENARIOS) {
    stmts.upsertScenario.get({
      name: sc.name, shocks_json: JSON.stringify(sc.shocks), trigger_hint: sc.trigger_hint,
    });
  }
});
console.log(`노드 ${NODES.length} · 간선 ${EDGES.length} · 시나리오 ${SCENARIOS.length} 등록`);
for (const r of computeAll()) console.log(`  사전계산: ${r.name} — ${r.paths} 경로`);
console.log('완료. 텔레그램에서 /scn 으로 조회.');
