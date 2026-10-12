// 현재 관점 복합 오버레이: 여러 시나리오+정치구조를 한 번에 동결하고 T+90에 지도 자체를 검토한다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, stmts, tx } = require('./db');
const llm = require('./llm');
const flags = require('./flags');
const { resolveProfiles } = require('./political-context');
const OBSERVABLE_RULES = require('../data/worldview-observables');

const REVIEW_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'worldview-review.md'), 'utf8');
const DAY = 86_400_000;
const SCENARIO_VERDICTS = new Set(['consistent', 'partial', 'inconsistent', 'unclear']);
const PATH_VERDICTS = new Set(['transmitted', 'blocked', 'reversed', 'lagged', 'unclear']);
const PROPOSAL_TYPES = new Set(['adjust_weight', 'adjust_condition', 'add_edge', 'add_moderator', 'split_scenario']);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const opposite = (direction) => direction === 'up' ? 'down' : 'up';

function graphState() {
  const nodes = db.prepare(`SELECT id,type,name,meta_json FROM nodes ORDER BY id`).all();
  const edges = db.prepare(`
    SELECT id,src,dst,kind,sign,weight,hhi,source,path_note,condition_note,leverage_note,updated_at
    FROM edges ORDER BY id`).all();
  const serialized = JSON.stringify({ nodes, edges });
  return {
    fingerprint: crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16),
    nodes, edges,
  };
}

function createDraft(scenarioIds, thesis, { horizonDays = 90, now = new Date() } = {}) {
  const ids = [...new Set((scenarioIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length || ids.length > 4) throw new Error('시나리오는 1~4개 선택');
  if (!thesis || thesis.trim().length < 10) throw new Error('현재 관점 설명은 10자 이상');
  if (!Number.isInteger(horizonDays) || horizonDays < 30 || horizonDays > 365) throw new Error('기간은 30~365일');

  const scenarios = ids.map((id) => stmts.scenarioById.get(id));
  if (scenarios.some((s) => !s)) throw new Error('존재하지 않는 시나리오 id 포함');
  const graph = graphState();
  const selectedPaths = [];
  for (const scenario of scenarios) {
    const rows = stmts.scenarioResults.all(scenario.id);
    if (!rows.length) throw new Error(`${scenario.name}: 사전계산 결과 없음 — /scn recompute`);
    for (const row of rows) selectedPaths.push({ scenario, row });
  }

  const relevantEdgeIds = new Set(selectedPaths.flatMap(({ row }) => JSON.parse(row.path_json)));
  const relevantNodeIds = new Set(selectedPaths.map(({ row }) => row.node_id));
  for (const edge of graph.edges.filter((e) => relevantEdgeIds.has(e.id))) {
    relevantNodeIds.add(edge.src); relevantNodeIds.add(edge.dst);
  }
  const snapshot = {
    fingerprint: graph.fingerprint,
    nodes: graph.nodes.filter((n) => relevantNodeIds.has(n.id)),
    edges: graph.edges.filter((e) => relevantEdgeIds.has(e.id)),
  };
  const countryCodes = [...new Set(scenarios.flatMap((s) => flags.forScenario(s.name)))];
  const politicalContexts = resolveProfiles(countryCodes, now);
  const targetDate = new Date(now.getTime() + horizonDays * DAY).toISOString().slice(0, 10);

  let id;
  tx(() => {
    id = stmts.insertWorldview.get({
      thesis: thesis.trim(), horizon_days: horizonDays, target_date: targetDate,
      graph_fingerprint: graph.fingerprint,
      graph_snapshot_json: JSON.stringify(snapshot),
      political_context_json: JSON.stringify(politicalContexts),
    }).id;
    scenarios.forEach((scenario, index) => stmts.insertWorldviewScenario.run({
      commit_id: id, scenario_id: scenario.id, role: index === 0 ? 'primary' : 'secondary',
      scenario_snapshot_json: JSON.stringify({
        id: scenario.id, name: scenario.name, shocks: JSON.parse(scenario.shocks_json),
        trigger_hint: scenario.trigger_hint, computed_at: scenario.computed_at,
      }),
    }));
    for (const { scenario, row } of selectedPaths) {
      const pathId = stmts.insertWorldviewPath.get({
        commit_id: id, scenario_id: scenario.id, node_id: row.node_id,
        impact: row.impact, hops: row.hops, path_json: row.path_json,
      }).id;
      const rule = OBSERVABLE_RULES.find((r) => r.node === row.name);
      if (!rule) continue;
      const indicator = db.prepare(`
        SELECT id FROM indicators WHERE source=? AND source_code=? ORDER BY id LIMIT 1`).get(rule.source, rule.source_code);
      if (!indicator) continue;
      const baseline = stmts.obsOnOrBefore.get(indicator.id, now.toISOString().slice(0, 10));
      stmts.insertWorldviewObservable.run({
        commit_id: id, path_id: pathId, indicator_id: indicator.id,
        metric: rule.metric,
        expected_direction: row.impact < 0 ? rule.negative_direction : opposite(rule.negative_direction),
        threshold: rule.threshold, lag_days: rule.lag_days || 0,
        baseline_value: baseline?.value ?? null, baseline_date: baseline?.date ?? null,
      });
    }
  });
  return getBundle(id);
}

function getBundle(id) {
  const commit = stmts.worldviewById.get(Number(id));
  if (!commit) return null;
  return {
    commit,
    scenarios: stmts.worldviewScenarios.all(commit.id),
    paths: stmts.worldviewPaths.all(commit.id).map((p) => ({ ...p, path: JSON.parse(p.path_json) })),
    graph_snapshot: JSON.parse(commit.graph_snapshot_json),
    political_contexts: JSON.parse(commit.political_context_json),
    observables: stmts.worldviewObservables.all(commit.id),
    review: stmts.worldviewReview.get(commit.id) || null,
  };
}

function commitDraft(id) {
  const before = stmts.worldviewById.get(Number(id));
  if (!before) throw new Error(`현재 관점 #${id} 없음`);
  if (before.status !== 'draft') throw new Error(`현재 관점 #${id}: ${before.status}`);
  stmts.commitWorldview.run(Number(id));
  return getBundle(id);
}

function formatDraft(bundle) {
  const byNode = new Map();
  for (const p of bundle.paths) {
    const v = byNode.get(p.node_id) || { name: p.name, values: [], scenarios: new Set() };
    v.values.push(p.impact); v.scenarios.add(p.scenario_name); byNode.set(p.node_id, v);
  }
  const top = [...byNode.values()].map((v) => ({
    ...v, max: v.values.slice().sort((a, b) => Math.abs(b) - Math.abs(a))[0],
    conflict: new Set(v.values.map(Math.sign)).size > 1,
  })).sort((a, b) => Math.abs(b.max) - Math.abs(a.max)).slice(0, 8);
  return [
    `🧭 <b>현재 관점 오버레이 초안 #${bundle.commit.id}</b>`,
    `관점: ${esc(bundle.commit.thesis)}`,
    `판정일: ${bundle.commit.target_date} · 그래프 ${bundle.commit.graph_fingerprint}`,
    '',
    ...bundle.scenarios.map((s) => `${s.role === 'primary' ? '● 주' : '○ 보조'} #${s.scenario_id} ${esc(s.name)}`),
    '', '<b>동시 활성 상위 요소</b>',
    ...top.map((n) => `${n.conflict ? '⚔️' : n.max < 0 ? '🔴' : '🟢'} ${esc(n.name)} ${n.max > 0 ? '+' : ''}${n.max.toFixed(2)} · ${n.scenarios.size}개 시나리오`),
    '', `<b>기계 채점 가능 경로</b> ${bundle.observables.length}/${bundle.paths.length}`,
    ...bundle.observables.slice(0, 5).map((o) => `· ${esc(o.node_name)} → ${esc(o.indicator_name)} ${o.expected_direction === 'up' ? '↑' : '↓'} · ${o.metric} ${o.threshold}`),
    '', `관련 정치구조: ${bundle.political_contexts.map((p) => p.country_name).join(' · ') || '없음'}`,
    bundle.commit.status === 'draft'
      ? '이 메시지에 답장 <code>commit</code> 또는 <code>cancel</code>'
      : `상태: ${bundle.commit.status}`,
  ].join('\n');
}

function formatCommitted(bundle) {
  return `✅ 현재 관점 #${bundle.commit.id} 커밋\n<b>${esc(bundle.commit.thesis)}</b>\n${bundle.scenarios.map((s) => `${s.role}: ${esc(s.name)}`).join('\n')}\nT+${bundle.commit.horizon_days}: ${bundle.commit.target_date}\n그래프·정치구조·관측기준 ${bundle.observables.length}건 동결 완료.`;
}

function reviewInput(bundle, machine) {
  const recent = db.prepare(`
    SELECT title,query,first_seen,last_seen,status FROM news_clusters
    WHERE last_seen >= datetime('now','-120 day') ORDER BY last_seen DESC LIMIT 30`).all();
  const currentCodes = bundle.political_contexts.map((p) => p.country_code);
  const currentGraphFingerprint = graphState().fingerprint;
  return [
    REVIEW_PROMPT,
    `[커밋]\n${JSON.stringify({
      id: bundle.commit.id, thesis: bundle.commit.thesis, committed_at: bundle.commit.committed_at,
      target_date: bundle.commit.target_date, graph_fingerprint: bundle.commit.graph_fingerprint,
      current_graph_fingerprint: currentGraphFingerprint,
      scenarios: bundle.scenarios.map((s) => ({ id: s.scenario_id, name: s.name, role: s.role })),
    })}`,
    `[당시 정치구조]\n${JSON.stringify(bundle.political_contexts)}`,
    `[현재 정치구조]\n${JSON.stringify(resolveProfiles(currentCodes, new Date()))}`,
    `[판정 대상 경로: 영향 절대값 상위 24]\n${JSON.stringify(bundle.paths.slice(0, 24).map((p) => ({
      path_id: p.id, scenario_id: p.scenario_id, scenario: p.scenario_name,
      outcome_node: p.name, impact: p.impact, hops: p.hops, edge_ids: p.path,
    })))}`,
    `[당시 동결된 사용 간선]\n${JSON.stringify(bundle.graph_snapshot.edges)}`,
    `[기계 채점 — LLM은 이 숫자를 수정하지 말고 원인만 해석]\n${JSON.stringify(machine)}`,
    `[최근 뉴스 사건]\n${JSON.stringify(recent)}`,
  ].join('\n\n');
}

function scoreObservables(bundle) {
  const targetMs = new Date(`${bundle.commit.target_date}T00:00:00Z`).getTime();
  const details = [];
  for (const row of bundle.observables) {
    const actual = stmts.obsOnOrBefore.get(row.indicator_id, bundle.commit.target_date);
    const maxAgeDays = Math.max(14, Number(row.lag_days || 0) + 15);
    const ageDays = actual ? Math.floor((targetMs - new Date(`${actual.date}T00:00:00Z`).getTime()) / DAY) : Infinity;
    if (row.baseline_value == null || !actual || ageDays > maxAgeDays) {
      stmts.scoreWorldviewObservable.run({
        id: row.id, actual_value: actual?.value ?? null, actual_date: actual?.date ?? null,
        change_value: null, direction_score: null, status: 'void',
      });
      details.push({ ...row, actual_value: actual?.value ?? null, actual_date: actual?.date ?? null, status: 'void' });
      continue;
    }
    const change = row.metric === 'pct_change'
      ? ((actual.value - row.baseline_value) / Math.abs(row.baseline_value || 1)) * 100
      : actual.value - row.baseline_value;
    const observedDirection = change >= row.threshold ? 'up' : change <= -row.threshold ? 'down' : 'flat';
    const directionScore = observedDirection === 'flat' ? 0 : observedDirection === row.expected_direction ? 1 : -1;
    stmts.scoreWorldviewObservable.run({
      id: row.id, actual_value: actual.value, actual_date: actual.date,
      change_value: change, direction_score: directionScore, status: 'scored',
    });
    details.push({ ...row, actual_value: actual.value, actual_date: actual.date, change_value: change, direction_score: directionScore, status: 'scored' });
  }
  const topPaths = bundle.paths.slice(0, 24);
  const totalWeight = topPaths.reduce((sum, p) => sum + Math.abs(p.impact), 0);
  const observablePathIds = new Set(details.map((d) => d.path_id));
  const observableWeight = topPaths.filter((p) => observablePathIds.has(p.id)).reduce((sum, p) => sum + Math.abs(p.impact), 0);
  const scored = details.filter((d) => d.status === 'scored');
  const scoredWeight = scored.reduce((sum, d) => sum + Math.abs(d.impact), 0);
  const directionScore = scoredWeight
    ? scored.reduce((sum, d) => sum + Math.abs(d.impact) * d.direction_score, 0) / scoredWeight * 100
    : null;
  return {
    observable_coverage_pct: totalWeight ? Math.round(observableWeight / totalWeight * 1000) / 10 : 0,
    observable_direction_score: directionScore == null ? null : Math.round(directionScore * 10) / 10,
    scored_observables: scored.length,
    void_observables: details.filter((d) => d.status === 'void').length,
    details: details.map((d) => ({
      observable_id: d.id, path_id: d.path_id, node: d.node_name, indicator: d.indicator_name,
      metric: d.metric, expected_direction: d.expected_direction, threshold: d.threshold,
      baseline_value: d.baseline_value, baseline_date: d.baseline_date,
      actual_value: d.actual_value, actual_date: d.actual_date,
      change_value: d.change_value, direction_score: d.direction_score, status: d.status,
    })),
  };
}

function quantitativeSummary(data, bundle, machine) {
  const scenarioValue = { consistent: 1, partial: .5, inconsistent: 0 };
  const secondaries = bundle.scenarios.filter((s) => s.role !== 'primary').length;
  const roleWeight = (s) => s.role === 'primary' ? (secondaries ? .65 : 1) : .35 / secondaries;
  let scenarioNumerator = 0, scenarioDenominator = 0;
  for (const verdict of data.scenario_verdicts || []) {
    if (verdict.verdict === 'unclear') continue;
    const scenario = bundle.scenarios.find((s) => s.scenario_id === Number(verdict.scenario_id));
    if (!scenario) continue;
    const w = roleWeight(scenario);
    scenarioNumerator += w * scenarioValue[verdict.verdict]; scenarioDenominator += w;
  }
  const pathValue = { transmitted: 1, lagged: .5, blocked: 0, reversed: -1 };
  const pathById = new Map(bundle.paths.map((p) => [p.id, p]));
  let pathNumerator = 0, pathDenominator = 0, judgedWeight = 0;
  const topWeight = bundle.paths.slice(0, 24).reduce((sum, p) => sum + Math.abs(p.impact), 0);
  for (const verdict of data.path_verdicts || []) {
    if (verdict.verdict === 'unclear') continue;
    const p = pathById.get(Number(verdict.path_id)); if (!p) continue;
    const w = Math.abs(p.impact);
    pathNumerator += w * pathValue[verdict.verdict]; pathDenominator += w; judgedWeight += w;
  }
  return {
    scenario_selection_fit_pct: scenarioDenominator ? Math.round(scenarioNumerator / scenarioDenominator * 1000) / 10 : null,
    transmission_score: pathDenominator ? Math.round(pathNumerator / pathDenominator * 1000) / 10 : null,
    transmission_coverage_pct: topWeight ? Math.round(judgedWeight / topWeight * 1000) / 10 : 0,
    observable_direction_score: machine.observable_direction_score,
    observable_coverage_pct: machine.observable_coverage_pct,
    scored_observables: machine.scored_observables,
    void_observables: machine.void_observables,
    missing_driver_count: (data.missing_drivers || []).length,
    observable_details: machine.details,
  };
}

function validateReview(data, bundle) {
  if (!data?.outcome_summary || !data.quantitative_insight) return { ok: false, reason: 'outcome_summary/quantitative_insight 없음' };
  const scenarioIds = new Set(bundle.scenarios.map((s) => s.scenario_id));
  const pathIds = new Set(bundle.paths.slice(0, 24).map((p) => p.id));
  const seenScenarios = new Set(), seenPaths = new Set();
  for (const v of data.scenario_verdicts || []) {
    if (!scenarioIds.has(Number(v.scenario_id)) || !SCENARIO_VERDICTS.has(v.verdict)) return { ok: false, reason: 'scenario verdict 형식' };
    if (seenScenarios.has(Number(v.scenario_id))) return { ok: false, reason: 'scenario verdict 중복' };
    seenScenarios.add(Number(v.scenario_id));
  }
  for (const v of data.path_verdicts || []) {
    if (!pathIds.has(Number(v.path_id)) || !PATH_VERDICTS.has(v.verdict)) return { ok: false, reason: 'path verdict 형식' };
    if (seenPaths.has(Number(v.path_id))) return { ok: false, reason: 'path verdict 중복' };
    seenPaths.add(Number(v.path_id));
  }
  if (seenScenarios.size !== scenarioIds.size) return { ok: false, reason: 'scenario verdict 누락' };
  if (seenPaths.size !== pathIds.size) return { ok: false, reason: 'path verdict 누락' };
  for (const p of data.revision_proposals || []) {
    if (!PROPOSAL_TYPES.has(p.proposal_type) || !p.reason || typeof p.proposed !== 'object') return { ok: false, reason: 'revision proposal 형식' };
  }
  return { ok: true };
}

function generateReview(commitId, runLLM = llm.run) {
  const bundle = getBundle(commitId);
  if (!bundle) return { ok: false, reason: '커밋 없음' };
  if (bundle.commit.status !== 'committed') return { ok: false, reason: `상태 ${bundle.commit.status}` };
  if (bundle.review) return { ok: true, data: JSON.parse(bundle.review.raw_json), bundle, reused: true };
  const machine = scoreObservables(bundle);
  const r = runLLM(reviewInput(bundle, machine), {
    label: `worldview-review-${commitId}`, agent: true, servers: ['batch', 'obs'], model: 'sonnet', timeout: 600_000,
  });
  if (!r.ok) return r;
  const parsed = llm.parseJson(r.text);
  if (!parsed.ok) return parsed;
  const valid = validateReview(parsed.data, bundle);
  if (!valid.ok) return valid;
  const quant = quantitativeSummary(parsed.data, bundle, machine);
  parsed.data.quantitative = quant;
  let reviewId;
  tx(() => {
    reviewId = stmts.insertWorldviewReview.get({
      commit_id: commitId, outcome_summary: parsed.data.outcome_summary,
      scenario_verdicts_json: JSON.stringify(parsed.data.scenario_verdicts || []),
      path_verdicts_json: JSON.stringify(parsed.data.path_verdicts || []),
      missing_drivers_json: JSON.stringify(parsed.data.missing_drivers || []),
      revision_proposals_json: JSON.stringify(parsed.data.revision_proposals || []),
      raw_json: JSON.stringify(parsed.data), quant_json: JSON.stringify(quant),
    }).id;
    for (const proposal of parsed.data.revision_proposals || []) {
      const auto = ['adjust_weight', 'adjust_condition'].includes(proposal.proposal_type);
      stmts.insertGraphProposal.get({
        review_id: reviewId, proposal_type: proposal.proposal_type,
        target_ref: proposal.target_ref || null, proposal_json: JSON.stringify(proposal),
        status: auto ? 'pending' : 'manual_review',
      });
    }
  });
  return { ok: true, data: parsed.data, bundle: getBundle(commitId) };
}

function formatReview(commit, data) {
  const icon = { consistent: '✅', partial: '🟡', inconsistent: '❌', unclear: '⬜' };
  return [
    `🧭 <b>현재 관점 T+${commit.horizon_days} 예비검토 #${commit.id}</b>`,
    `<b>실제 전개:</b> ${esc(data.outcome_summary)}`, '',
    ...(data.quantitative ? [
      '<b>정량 차이</b>',
      `· 시나리오 선택 적합도: ${data.quantitative.scenario_selection_fit_pct ?? '—'}%`,
      `· 전달경로 점수: ${data.quantitative.transmission_score ?? '—'} (-100 역전 · 0 차단 · +100 전달)`,
      `· 실측 방향 점수: ${data.quantitative.observable_direction_score ?? '—'} · 관측 커버리지 ${data.quantitative.observable_coverage_pct}%`,
      `· 기계 채점 ${data.quantitative.scored_observables} · 결측 ${data.quantitative.void_observables}`,
      '',
    ] : []),
    `<b>정량 인사이트:</b> ${esc(data.quantitative_insight)}`, '',
    ...(data.scenario_verdicts || []).map((v) => `${icon[v.verdict]} 시나리오 #${v.scenario_id}: ${esc(v.note)}`),
    '', '<b>누락된 설명 후보</b>',
    ...((data.missing_drivers || []).map((d) => `· ${esc(d.driver)} — ${esc(d.mechanism)}`)),
    '', `수정 제안 ${(data.revision_proposals || []).length}건. 아직 그래프에는 적용하지 않음.`,
    `이 메시지에 답장 <code>confirm</code> 또는 판단 보정 메모를 남겨라.`,
  ].join('\n');
}

function confirmReview(commitId, userNote = null) {
  const review = stmts.worldviewReview.get(Number(commitId));
  if (!review) throw new Error(`검토 없음: #${commitId}`);
  stmts.confirmWorldviewReview.run({ commit_id: Number(commitId), user_note: userNote });
  stmts.finishWorldviewReview.run(Number(commitId));
  return stmts.graphProposalsForCommit.all(Number(commitId));
}

function applyProposal(id) {
  const row = stmts.graphProposalById.get(Number(id));
  if (!row) throw new Error(`수정 제안 #${id} 없음`);
  if (row.status !== 'pending') throw new Error(`수정 제안 #${id}: ${row.status}`);
  const proposal = JSON.parse(row.proposal_json);
  const p = proposal.proposed || {};
  if (row.proposal_type === 'adjust_weight') {
    if (!Number.isInteger(Number(p.edge_id)) || typeof p.weight !== 'number' || p.weight < 0 || p.weight > 1) throw new Error('edge_id/weight 형식');
    const edge = db.prepare(`SELECT id,weight FROM edges WHERE id=?`).get(Number(p.edge_id));
    if (!edge) throw new Error(`edge #${p.edge_id} 없음`);
    db.prepare(`UPDATE edges SET weight=?,updated_at=datetime('now') WHERE id=?`).run(p.weight, Number(p.edge_id));
    proposal.applied_change = { field: 'weight', from: edge.weight, to: p.weight, applied_at: new Date().toISOString() };
    require('./graph').computeAll();
  } else if (row.proposal_type === 'adjust_condition') {
    if (!Number.isInteger(Number(p.edge_id)) || !p.condition_note) throw new Error('edge_id/condition_note 형식');
    const edge = db.prepare(`SELECT condition_note FROM edges WHERE id=?`).get(Number(p.edge_id));
    if (!edge) throw new Error(`edge #${p.edge_id} 없음`);
    db.prepare(`UPDATE edges SET condition_note=?,updated_at=datetime('now') WHERE id=?`).run(String(p.condition_note), Number(p.edge_id));
    proposal.applied_change = { field: 'condition_note', from: edge.condition_note, to: String(p.condition_note), applied_at: new Date().toISOString() };
  } else throw new Error(`${row.proposal_type}: 자동 적용 불가`);
  db.prepare(`UPDATE graph_revision_proposals SET proposal_json=? WHERE id=?`).run(JSON.stringify(proposal), row.id);
  stmts.resolveGraphProposal.run('applied', row.id);
  return proposal;
}

function rejectProposal(id) {
  const row = stmts.graphProposalById.get(Number(id));
  if (!row || row.status !== 'pending') throw new Error('대기 중 수정 제안 아님');
  stmts.resolveGraphProposal.run('rejected', row.id);
}

module.exports = {
  graphState, createDraft, getBundle, commitDraft, formatDraft, formatCommitted,
  scoreObservables, quantitativeSummary, validateReview, generateReview, formatReview,
  confirmReview, applyProposal, rejectProposal,
};
