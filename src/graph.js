// 그래프 전파 엔진 (스펙 §4.3)
// 규칙:
//   - BFS 최대 3홉, impact = shock × ∏(weight × sign) × damp^(물리홉수-1)
//   - coercion_transfer/policy 간선은 물리 전파가 아니므로 홉·감쇠 미계상 (sign/weight만)
//   - |impact| < PRUNE 가지치기
//   - 같은 노드에 도달하는 경합 경로는 합산하지 않고 각각 보존 (판단은 사람)
//   - 숫자는 순위·강조용 휴리스틱이지 정밀 추정치가 아니다

const { stmts, tx } = require('./db');

const MAX_HOPS = 3;
const DAMP = 0.7;
const PRUNE = 0.05;
const NO_DAMP_KINDS = new Set(['coercion_transfer', 'policy']);

/**
 * 순수 전파 함수 (테스트 대상).
 * edgesFrom: (nodeId) => [{dst, sign, weight, kind, id, dst_name}]
 * shocks: [{node_id, impact}]  (충격: 보통 -1 = 차단/악화)
 * returns: [{node_id, impact, hops, path: [edgeId...]}]
 */
function propagate(edgesFrom, shocks) {
  const results = [];
  // 경로 단위 BFS — 같은 노드 재방문 허용(다른 경로), 단 한 경로 내 순환 금지
  let frontier = shocks.map((s) => ({
    node_id: s.node_id, impact: s.impact, hops: 0, path: [], visited: new Set([s.node_id]),
  }));

  while (frontier.length) {
    const next = [];
    for (const cur of frontier) {
      for (const e of edgesFrom(cur.node_id)) {
        if (cur.visited.has(e.dst)) continue; // 경로 내 순환 방지
        const physical = !NO_DAMP_KINDS.has(e.kind);
        const hops = cur.hops + (physical ? 1 : 0);
        if (hops > MAX_HOPS) continue;

        const damp = physical && hops > 1 ? DAMP : 1; // 첫 물리홉은 감쇠 없음
        const impact = cur.impact * e.weight * e.sign * damp;
        if (Math.abs(impact) < PRUNE) continue;

        const entry = {
          node_id: e.dst, impact, hops,
          path: [...cur.path, e.id],
          visited: new Set([...cur.visited, e.dst]),
        };
        results.push(entry);
        next.push(entry);
      }
    }
    frontier = next;
  }
  return results;
}

/** 시나리오 1건 계산 → scenario_results 캐시 */
function computeScenario(scenario) {
  const shocks = JSON.parse(scenario.shocks_json).map((s) => {
    const n = stmts.nodeByName.get(s.node);
    if (!n) throw new Error(`시나리오 "${scenario.name}": 노드 없음 — ${s.node}`);
    return { node_id: n.id, impact: s.impact ?? -1 };
  });

  const cache = new Map();
  const edgesFrom = (id) => {
    if (!cache.has(id)) cache.set(id, stmts.edgesFrom.all(id));
    return cache.get(id);
  };

  const results = propagate(edgesFrom, shocks);
  tx(() => {
    stmts.clearScenarioResults.run(scenario.id);
    for (const r of results) {
      stmts.insertScenarioResult.run(
        scenario.id, r.node_id, r.impact, r.hops, JSON.stringify(r.path));
    }
    stmts.markScenarioComputed.run(scenario.id);
  });
  return results.length;
}

function computeAll() {
  const out = [];
  for (const sc of stmts.allScenarios.all()) {
    out.push({ name: sc.name, paths: computeScenario(sc) });
  }
  return out;
}

/** 시나리오 결과 → 텔레그램 텍스트. 노드별 경합 경로 병렬 표시 */
function formatScenario(scenario, limit = 10) {
  const rows = stmts.scenarioResults.all(scenario.id);
  if (!rows.length) return `"${scenario.name}": 결과 없음 — 그래프/시드 확인`;

  // 노드별 그룹, 대표 임팩트 = |최대| 경로. 경합(부호 상이) 여부 표시
  const byNode = new Map();
  for (const r of rows) {
    if (!byNode.has(r.node_id)) byNode.set(r.node_id, []);
    byNode.get(r.node_id).push(r);
  }
  const nodes = [...byNode.values()]
    .map((paths) => ({
      name: paths[0].name, type: paths[0].type, paths,
      maxAbs: Math.max(...paths.map((p) => Math.abs(p.impact))),
      signs: new Set(paths.map((p) => Math.sign(p.impact))),
    }))
    .sort((a, b) => b.maxAbs - a.maxAbs)
    .slice(0, limit);

  const bar = (v) => (v < 0 ? '🔴' : '🟢') + Math.abs(v).toFixed(2);
  const lines = [`🗺 <b>${scenario.name}</b>`];
  if (scenario.trigger_hint) lines.push(`<i>트리거 힌트: ${scenario.trigger_hint}</i>`);
  lines.push('');
  for (const n of nodes) {
    if (n.signs.size > 1) {
      // 경합 경로 — 수혜/피해 병렬
      const pos = n.paths.filter((p) => p.impact > 0).sort((a, b) => b.impact - a.impact)[0];
      const neg = n.paths.filter((p) => p.impact < 0).sort((a, b) => a.impact - b.impact)[0];
      lines.push(`⚔️ <b>${n.name}</b> 경합: ${bar(neg.impact)} vs ${bar(pos.impact)} — 지배 경로 판단은 네 몫`);
    } else {
      const top = n.paths.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))[0];
      lines.push(`${bar(top.impact)} <b>${n.name}</b> (${top.hops}홉)`);
    }
  }
  lines.push('', '<i>수치는 순위용 휴리스틱. 경로 상세: /scn path &lt;시나리오id&gt; &lt;노드명&gt;</i>');
  return lines.join('\n');
}

/** 특정 노드 도달 경로 상세 (path_note 역추적) */
function formatPaths(scenarioId, nodeName) {
  const { db } = require('./db');
  const rows = db.prepare(`
    SELECT r.impact, r.hops, r.path_json FROM scenario_results r
    JOIN nodes n ON n.id = r.node_id
    WHERE r.scenario_id = ? AND n.name LIKE ?
    ORDER BY ABS(r.impact) DESC LIMIT 5`).all(scenarioId, `%${nodeName}%`);
  if (!rows.length) return `경로 없음: ${nodeName}`;

  const edgeById = (id) => db.prepare(`
    SELECT e.*, s.name AS src_name, d.name AS dst_name FROM edges e
    JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst WHERE e.id = ?`).get(id);

  const lines = [];
  for (const r of rows) {
    const hops = JSON.parse(r.path_json).map(edgeById);
    const chain = hops.map((e) => `${e.src_name}→${e.dst_name}`).join(' → ');
    lines.push(`<b>${r.impact.toFixed(2)}</b> ${chain}`);
    for (const e of hops) {
      lines.push(`  · ${e.src_name}→${e.dst_name}: ${e.path_note}${e.condition_note ? ` <i>(조건: ${e.condition_note})</i>` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { propagate, computeScenario, computeAll, formatScenario, formatPaths, MAX_HOPS, DAMP, PRUNE };
