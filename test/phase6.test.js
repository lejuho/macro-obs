// Phase 6 테스트: rvol 프록시 + 초안 생성기
// 실행: node --no-warnings test/phase6.test.js

process.env.DB_PATH = '/tmp/macro-p6.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { rvol, DERIVED } = require('../src/derived');
const drafts = require('../src/drafts');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. rvol — Tier 3 프록시 수학');
const flat = Array.from({ length: 25 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, value: 100 }));
assert(rvol(flat, { mode: 'pct', window: 20 }).every((o) => o.value === 0), '무변동 → 0');
const jumpy = flat.map((o, i) => ({ ...o, value: i < 20 ? 100 : 100 + (i % 2 ? 3 : -3) }));
const rv = rvol(jumpy, { mode: 'pct', window: 20 });
assert(rv[rv.length - 1].value > rv[0].value, '변동 유입 시 상승');
assert(rvol(flat.slice(0, 10), { window: 20 }).length === 0, '표본 부족 → 빈 배열');
assert(DERIVED.some((d) => d.code === 'MOVE_PROXY' && d.mode === 'diff'), 'MOVE 프록시 등록(diff/bp)');
assert(DERIVED.some((d) => d.code === 'KRW_STRESS' && d.mode === 'pct'), 'CDS 프록시 등록(pct/%)');

console.log('2. 재료 수집 — 픽스처');
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/d', name: '원/달러 환율', freq: 'D', unit: '원', category: 'macro', note: null,
});
stmts.upsertObs.run(indId, '2026-06-06', 1500);
stmts.upsertObs.run(indId, '2026-07-05', 1554);
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, rationale)
  VALUES ('환율 뉴노멀 1350~1480', ?, 1350, 1480, '레벨시프트 가설')`).run(indId);
const { id: alertId } = stmts.insertAlert.get({
  hypothesis_id: 1, observed_value: 1554, observed_date: '2026-07-03', direction: 'above',
});
const { id: predId } = stmts.insertPrediction.get({
  alert_id: alertId, statement: '1500~1560', expected_low: 1500, expected_high: 1560,
  target_date: '2026-07-01',
});
stmts.gradePrediction.run(1554, 'hit', predId);
// 가설 수정 1건
const { id: newHyp } = stmts.reviseHyp.get({
  statement: '환율 뉴노멀 1450~1600', band_low: 1450, band_high: 1600,
  rationale: '1554 지속으로 레벨 상향', old_id: 1,
});
stmts.retireHyp.run(1);

let m = drafts.gatherMaterial(30);
assert(m.graded.length === 1 && m.graded[0].score === 'hit', '채점 예측 수집');
assert(m.revisions.length === 1 && m.revisions[0].old_statement.includes('1350'), '수정 이력 + 구가설');
assert(m.breaches.length === 1, '이탈 수집');
assert(m.moves.some((x) => x.now_v === 1554 && x.then_v === 1500), '기간 지표 변화');
assert(drafts.hasMaterial(m), '재료 있음 판정');

console.log('3. 초안 생성 — 가짜 LLM');
const goodDraft = `# 2026-07 관측 노트\n## 이번 달 판정\n환율 커밋 1500~1560은 1554로 hit.\n## 가설의 상태\n1350~1480 가설을 1450~1600으로 상향 — 레벨시프트 확인.\n## 이탈과 대응\n상단 돌파 후 커밋 논리 유지.\n## 다음 관전 포인트\n다음 채점일 대기.\n` + 'x'.repeat(300);
let r = drafts.generateDraft({ runLLM: () => ({ ok: true, text: goodDraft }) });
assert(r.ok && fs.existsSync(r.file), '파일 생성');
assert(fs.readFileSync(r.file, 'utf8').includes('관측 노트'), '내용 저장');
assert(r.material_counts.graded === 1, '재료 카운트 리포트');
fs.unlinkSync(r.file);

console.log('4. 검증 — 불량 초안 거부');
r = drafts.generateDraft({ runLLM: () => ({ ok: true, text: '짧음' }) });
assert(!r.ok && r.reason.includes('분량'), '분량 미달 거부');
r = drafts.generateDraft({ runLLM: () => ({ ok: true, text: '구조 없는 장문 '.repeat(100) }) });
assert(!r.ok && r.reason.includes('구조'), '마크다운 구조 없음 거부');

console.log('5. 재료 없음 → skip');
const empty = '/tmp/macro-p6-empty.db';
if (fs.existsSync(empty)) fs.unlinkSync(empty);
const { execSync } = require('child_process');
const out = execSync(
  `DB_PATH=${empty} node --no-warnings -e "console.log(JSON.stringify(require('./src/drafts').generateDraft({runLLM:()=>({ok:true,text:'x'})})))"`,
  { cwd: __dirname + '/..' }).toString();
assert(JSON.parse(out).skip != null, '빈 DB → skip (LLM 호출 안 함)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
