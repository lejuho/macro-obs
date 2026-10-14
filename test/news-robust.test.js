// 뉴스 파이프라인 견고화 테스트: JSON 추출·수리, enum 정리, 프레이밍 공백 플래그
// 실행: node --no-warnings test/news-robust.test.js

process.env.DB_PATH = '/tmp/macro-news-robust.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const llm = require('../src/llm');
const news = require('../src/news');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. parseJson — 에이전트 서술·펜스·예시 객체 사이에서 본문 추출');
let p = llm.parseJson('검색해보니 {"x":1} 같은 형태다.\n```json\n{"clusters":[{"t":"괄호 } 포함"}]}\n```\n이상.', { requireKey: 'clusters' });
assert(p.ok && p.data.clusters[0].t === '괄호 } 포함', 'requireKey 보유 객체 선택 + 문자열 내 괄호 무시');
assert(llm.parseJson('{"a":1}').ok, '순수 JSON');
assert(!llm.parseJson('{"clusters": [1, 2', { requireKey: 'clusters' }).ok, '잘린 JSON → 실패');

console.log('2. runJson — 파싱 실패 시 1회 수리 호출');
const calls = [];
let r = llm.runJson('prompt', {
  label: 'test-repair', requireKey: 'clusters', agent: true,
  runLLM: (input, opts) => {
    calls.push(opts);
    return calls.length === 1 ? { ok: true, text: '{"clusters": [{"a":1}' } : { ok: true, text: '{"clusters":[{"a":1}]}' };
  },
});
assert(r.ok && r.repaired && calls.length === 2, '수리 후 성공');
assert(calls[1].agent === false && calls[1].label.endsWith('-repair'), '수리 호출은 도구 없이');
assert(r.dumped && fs.existsSync(r.dumped), '실패 원문 덤프');
if (r.dumped) fs.unlinkSync(r.dumped);

console.log('3. normalizeAxis — 실제 로그에 나온 이탈값');
assert(news.normalizeAxis('electoral_system.legislature') === 'electoral_system', '점 표기 → 앞 축');
assert(news.normalizeAxis('external_constraints: North_Korea') === 'external_constraints', '콜론 서술 → 앞 축');
assert(news.normalizeAxis('regime') === 'power_structure' && news.normalizeAxis('legislature') === 'power_structure', '하위 키 별칭');
assert(news.normalizeAxis('government_status.relation') === 'government_status', 'government_status.relation');
assert(news.normalizeAxis('Congress_foreign_policy') === null && news.normalizeAxis('CN') === null, '매핑 불가 → null(추측 금지)');

console.log('4. clusterQuery — UA·이탈 축·미배정이 있어도 쿼리 전체를 버리지 않음');
const q = '미국 정치 의회 행정부 선거';
for (let i = 1; i <= 3; i++) {
  stmts.insertNewsItem.run({ link: `https://x.com/${i}`, title: `기사${i}`, description: 'd', source: '기타', spectrum: 'unknown', pub_date: '2026-10-13T00:00:00Z', query: q });
}
const ids = db.prepare(`SELECT id FROM news_items ORDER BY id`).all().map((x) => x.id);
const out = {
  clusters: [{
    event_key: 'US-Aid-Ukraine-Vote-2026-10', title: '우크라 지원안 표결', member_ids: [ids[0], ids[0]],
    core_frame: '의회 분열이 대외 지원을 지연시킨다는 해석', expected_development: '연내 표결 통과 여부',
    countries: ['US', 'UA'], spectrum_frames: { A: null, B: null, wire: null, unknown: '의회 교착 강조' },
    notable_claims: [],
    structural_hypotheses: [
      { axis: 'Congress_foreign_policy', mechanism: 'm', expected_outcome: 'o', basis: 'inferred' },
      { axis: 'government_status.relation', mechanism: '분점정부', expected_outcome: '지연', basis: 'explicit' },
    ],
  }, {
    event_key: 'empty-frame-case-2026-10', title: '빈 프레임 사건', member_ids: [ids[1]],
    spectrum_frames: { A: null, B: null, wire: null }, notable_claims: [],
  }],
  noise_ids: [],
};
r = news.clusterQuery(q, () => ({ ok: true, text: `설명 먼저.\n${JSON.stringify(out)}` }));
assert(r.ok && r.created === 2, `쿼리 성공 (reason: ${r.reason || '-'})`);
assert(r.deferred === 1, '미배정 1건 이월');
assert(r.warnings.some((w) => w.includes('UA')) && r.warnings.some((w) => w.includes('Congress_foreign_policy')), '경고에 제거 내역');
const c1 = stmts.clusterByKey.get('us-aid-ukraine-vote-2026-10');
assert(c1 && JSON.parse(c1.countries_json).join() === 'US', 'event_key 소문자화 + UA 제거');
const s1 = JSON.parse(stmts.snapshotFor.get(c1.id, 'initial').content_json);
assert(s1.structural_hypotheses.length === 1 && s1.structural_hypotheses[0].axis === 'government_status', '축 정규화, 매핑 불가 가설만 제거');
assert(s1.core_frame && s1.expected_development && !s1.framing_gap, 'core_frame/expected_development 저장');
const c2 = stmts.clusterByKey.get('empty-frame-case-2026-10');
assert(JSON.parse(stmts.snapshotFor.get(c2.id, 'initial').content_json).framing_gap === true && r.framing_gaps === 1, '빈 프레임 → framing_gap 플래그');
assert(db.prepare(`SELECT cluster_id FROM news_items WHERE id = ?`).get(ids[2]).cluster_id == null, '이월 기사는 미배정 상태 유지');

console.log('5. 재방문 프롬프트 — 공백 스냅샷이면 추정 금지 지시');
const prompt = news.buildRevisitPrompt({ title: 't', first_seen: '2026-07-05 00:00:00' },
  { spectrum_frames: { A: null, B: null, wire: null }, notable_claims: [] }, []);
assert(prompt.includes('[주의] 당시 프레이밍 기록이 비어 있다'), '공백 경고 포함');
const prompt2 = news.buildRevisitPrompt({ title: 't', first_seen: '2026-07-05 00:00:00' }, s1, []);
assert(!prompt2.includes('[주의]') && prompt2.includes('의회 분열'), '정상 스냅샷은 핵심 프레임 전달');

console.log('6. 클러스터 프롬프트에 enum 명시');
const cp = news.buildClusterPrompt([], [], {});
assert(cp.includes('[허용 국가 코드] KR') && cp.includes('[허용 구조 축] power_structure'), '허용 목록 명시');

console.log('7. clusterQuery — 실패 시 거부 사유를 붙여 1회 재시도');
{
  const q2 = '한중 무역';
  stmts.insertNewsItem.run({ link: 'https://x.com/r1', title: '재시도 기사', description: 'd', source: '기타', spectrum: 'unknown', pub_date: '2026-10-13T00:00:00Z', query: q2 });
  const rid = db.prepare(`SELECT id FROM news_items WHERE link = 'https://x.com/r1'`).get().id;
  const good = { clusters: [{ event_key: 'retry-case-2026-10', title: '재시도', member_ids: [rid], core_frame: 'f', countries: ['KR'], spectrum_frames: {}, notable_claims: [], structural_hypotheses: [] }], noise_ids: [] };
  const bad = { clusters: [{ event_key: '!!', title: 'x', member_ids: [rid] }], noise_ids: [] };
  const prompts = [];
  let r2 = news.clusterQuery(q2, (input) => { prompts.push(input); return { ok: true, text: JSON.stringify(prompts.length === 1 ? bad : good) }; });
  assert(r2.ok && r2.created === 1 && r2.retried?.length === 1, `검증 실패 → 재시도 성공 (reason: ${r2.reason || '-'})`);
  assert(prompts[1].includes('[재시도]') && prompts[1].includes('event_key 형식'), '재시도 프롬프트에 거부 사유');

  stmts.insertNewsItem.run({ link: 'https://x.com/r2', title: '계속 실패', description: 'd', source: '기타', spectrum: 'unknown', pub_date: '2026-10-13T00:00:00Z', query: q2 });
  let calls = 0;
  r2 = news.clusterQuery(q2, () => { calls++; return { ok: false, reason: 'timeout' }; });
  assert(!r2.ok && calls === 2 && r2.reason.includes('2회 시도'), '호출 실패 2회 → 실패 보고(무한 재시도 없음)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
