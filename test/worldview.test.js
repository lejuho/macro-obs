// 복합 시나리오 현재 관점: 동결 → 커밋 → T+90 검토 → 승인 보정
process.env.DB_PATH = '/tmp/macro-worldview.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
try { fs.unlinkSync(process.env.DB_PATH); } catch {}

const { db, stmts } = require('../src/db');
const { computeAll } = require('../src/graph');
const worldview = require('../src/worldview');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

const a = stmts.upsertNode.get({ type: 'chokepoint', name: '대만해협', meta_json: null }).id;
const b = stmts.upsertNode.get({ type: 'chokepoint', name: '호르무즈해협', meta_json: null }).id;
const c = stmts.upsertNode.get({ type: 'flow', name: '반도체수출', meta_json: null }).id;
const d = stmts.upsertNode.get({ type: 'flow', name: '원유수입', meta_json: null }).id;
stmts.insertEdge.run({ src: a, dst: c, kind: 'policy', sign: 1, weight: .7, hhi: null, source: 'manual:geo', path_note: '대만 경로', condition_note: null, leverage_note: null });
stmts.insertEdge.run({ src: b, dst: d, kind: 'transit', sign: 1, weight: .8, hhi: null, source: 'manual:geo', path_note: '호르무즈 경로', condition_note: null, leverage_note: null });
const s1 = stmts.upsertScenario.get({ name: '대만 유사', shocks_json: JSON.stringify([{ node: '대만해협', impact: -1 }]), trigger_hint: '훈련' }).id;
const s2 = stmts.upsertScenario.get({ name: '호르무즈 봉쇄', shocks_json: JSON.stringify([{ node: '호르무즈해협', impact: -1 }]), trigger_hint: '충돌' }).id;
computeAll();
const semi = stmts.upsertIndicator.get({ source: 'derived', source_code: 'KR_SEMI_EXPORT_YOY', name: '반도체 수출 YoY', freq: 'M', unit: '%', category: 'macro', note: null }).id;
const brent = stmts.upsertIndicator.get({ source: 'fred', source_code: 'DCOILBRENTEU', name: 'Brent 유가', freq: 'D', unit: '$/bbl', category: 'global', note: null }).id;
stmts.upsertObs.run(semi, '2026-07-01', 10);
stmts.upsertObs.run(brent, '2026-07-20', 80);

console.log('1. 복합 오버레이 동결');
const draft = worldview.createDraft([s1, s2], '대만과 호르무즈 복합 충격이 현재 흐름의 주 설명이다', {
  now: new Date('2026-07-20T00:00:00Z'), horizonDays: 90,
});
assert(draft.commit.status === 'draft' && draft.scenarios.length === 2, '주·보조 시나리오 초안');
assert(draft.paths.length === 2 && draft.graph_snapshot.edges.length === 2, '사용 경로·간선 동결');
assert(draft.commit.target_date === '2026-10-18', 'T+90 판정일');
assert(draft.political_contexts.some((p) => p.country_code === 'TW'), '관련 정치구조 동결');
assert(draft.observables.length === 2, '경로별 관측 기준 동결');
const apiView = require('../src/jobs/server').api.worldviewCurrent();
assert(apiView === null, '커밋 전 초안은 현재 관점 API에 미노출');

console.log('2. 텔레그램 커밋 상태');
const committed = worldview.commitDraft(draft.commit.id);
assert(committed.commit.status === 'committed' && committed.commit.committed_at, 'draft → committed');
assert(require('../src/jobs/server').api.worldviewCurrent().paths.length === 2, 'PWA 복합 오버레이 API');

console.log('3. 예비검토와 수정 제안');
stmts.upsertObs.run(semi, '2026-10-01', 2);
stmts.upsertObs.run(brent, '2026-10-18', 90);
const edgeId = draft.graph_snapshot.edges[0].id;
const fakeReview = {
  outcome_summary: '대만 경로는 차단됐고 호르무즈 경로는 일부 전달됐다.',
  quantitative_insight: '실측 가능한 두 경로의 방향은 맞았지만 시나리오 선택과 중간 전달은 약했다.',
  scenario_verdicts: [
    { scenario_id: s1, verdict: 'inconsistent', note: '물류 충격 부재' },
    { scenario_id: s2, verdict: 'partial', note: '유가만 상승' },
  ],
  path_verdicts: [
    { path_id: draft.paths[0].id, verdict: 'blocked', note: '중간 전달 차단' },
    { path_id: draft.paths[1].id, verdict: 'transmitted', note: '관측 지표 방향 일치' },
  ],
  missing_drivers: [{ kind: 'political_structure', driver: '의회 통제', mechanism: '정책 집행 제약', evidence: '후속 보도' }],
  revision_proposals: [{
    proposal_type: 'adjust_weight', target_ref: `edge:${edgeId}`, reason: '반복 검증 전 보수 조정 제안',
    proposed: { edge_id: edgeId, weight: .55 },
  }],
};
const reviewed = worldview.generateReview(draft.commit.id, () => ({ ok: true, text: JSON.stringify(fakeReview) }));
assert(reviewed.ok && stmts.worldviewReview.get(draft.commit.id), '검토 결과 저장');
assert(reviewed.data.quantitative.observable_direction_score === 100, '실측 방향 점수 기계 계산');
assert(reviewed.data.quantitative.scenario_selection_fit_pct === 17.5, '주·보조 역할 가중 선택 적합도');
const proposals = worldview.confirmReview(draft.commit.id, '정치구조 누락을 다음 커밋에서 우선 추적');
assert(proposals.length === 1 && stmts.worldviewById.get(draft.commit.id).status === 'reviewed', '사용자 확인 후 수정 제안 개방');

console.log('4. 명시 승인 후 파라미터 적용');
worldview.applyProposal(proposals[0].id);
assert(db.prepare('SELECT weight FROM edges WHERE id=?').get(edgeId).weight === .55, '승인된 weight만 변경');
assert(stmts.graphProposalById.get(proposals[0].id).status === 'applied', '수정 감사 상태');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
