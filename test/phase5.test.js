// Phase 5 테스트: 뉴스 파이프라인 (가짜 LLM 주입 — claude 불필요)
// 실행: node --no-warnings test/phase5.test.js

process.env.DB_PATH = '/tmp/macro-p5.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const news = require('../src/news');
const { parseItems, identifyPress } = require('../src/collectors/naver');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

// ── 픽스처: 기사 6건 (환율 급등 사건 — A/B/wire 프레이밍 갈림) ──
const fixtures = [
  ['https://chosun.com/1', '환율 1550 돌파', '정부 정책 불확실성이 원화 약세 불렀다', '조선일보', 'A'],
  ['https://hani.co.kr/1', '환율 1550 돌파', '글로벌 달러 강세 국면, 수출 대기업엔 호재', '한겨레', 'B'],
  ['https://yna.co.kr/1', '원달러 1554 마감', '서울외환시장서 1554.1원 마감', '연합뉴스', 'wire'],
  ['https://chosun.com/2', '환율 연말 1650 간다', 'A증권 전망 인용 보도', '조선일보', 'A'],
  ['https://hani.co.kr/2', '환율 곧 안정될 것', '당국 개입 여력 충분 분석', '한겨레', 'B'],
  ['https://blog.example.com/1', '환율 관련 잡담', '광고성 단신', '기타', 'unknown'],
];
for (const [link, title, description, source, spectrum] of fixtures) {
  stmts.insertNewsItem.run({ link, title, description, source, spectrum, pub_date: '2026-04-05T00:00:00Z', query: '원달러 환율' });
}
const ids = db.prepare(`SELECT id FROM news_items ORDER BY id`).all().map((r) => r.id);

console.log('1. 수집 파서/도메인 식별 (회귀 — phase4c와 별개 재확인)');
assert(identifyPress('https://m.khan.co.kr/article/1').name === '경향신문', '서브도메인 매칭');
assert(parseItems({ items: [] }, 'q').length === 0, '빈 응답 안전');

console.log('2. 클러스터링 — 가짜 LLM 주입');
const clusterOut = {
  clusters: [{
    event_key: 'fx-1550-breach-2026-04',
    title: '환율 1550 돌파',
    member_ids: ids.slice(0, 5),
    countries: ['KR', 'US'],
    spectrum_frames: { A: '정책 실기론', B: '외부요인·수출호재론', wire: '1554.1 마감 사실' },
    notable_claims: [
      { source: '조선일보', claim: '연말까지 1650 도달 전망' },
      { source: '한겨레', claim: '당국 개입으로 단기 안정 전망' },
    ],
    structural_hypotheses: [{
      axis: 'external_constraints', mechanism: '미국 금리와 달러 강세가 원화 약세를 제약',
      expected_outcome: '90일 뒤에도 한미 금융여건이 환율 설명에 남음', basis: 'inferred',
    }],
  }],
  noise_ids: [ids[5]],
};
const fakeLLM = (input) => ({ ok: true, text: JSON.stringify(clusterOut) });
let r = news.clusterQuery('원달러 환율', fakeLLM);
assert(r.ok && r.created === 1, '클러스터 1건 생성');
const cluster = stmts.clusterByKey.get('fx-1550-breach-2026-04');
assert(cluster && cluster.status === 'open', 'event_key로 조회');
assert(db.prepare(`SELECT COUNT(*) n FROM news_items WHERE cluster_id = ?`).get(cluster.id).n === 5, '5건 배정');
assert(db.prepare(`SELECT is_noise FROM news_items WHERE id = ?`).get(ids[5]).is_noise === 1, 'noise 마킹(is_noise)');
const snap = stmts.snapshotFor.get(cluster.id, 'initial');
assert(snap && JSON.parse(snap.content_json).notable_claims.length === 2, 'initial 스냅샷 + 주장 2건');
assert(JSON.parse(snap.content_json).political_contexts.length === 2, '관련국 정치구조를 initial에 시점 고정');

console.log('3. 재실행 멱등 — 미배정 기사 없으면 스킵');
assert(news.clusterQuery('원달러 환율', fakeLLM).skip === 'no items', '전부 배정됨 → skip');

console.log('4. 검증 — 불량 LLM 출력 거부');
let v = news.validateClusterOut({ clusters: [{ event_key: 'X 대문자', title: 't', member_ids: [1] }] }, [1]);
assert(!v.ok, 'event_key 형식 위반 거부');
v = news.validateClusterOut({ clusters: [{ event_key: 'ok-key-1', title: 't', member_ids: [1, 2] }], noise_ids: [2] }, [1, 2]);
assert(!v.ok && v.reason.includes('중복'), 'id 이중 배정 거부');
v = news.validateClusterOut({ clusters: [], noise_ids: [1] }, [1, 2]);
assert(!v.ok && v.reason.includes('미배정'), '미배정 id 거부');

console.log('5. 90일 재방문 — 스냅샷 diff + 언론사 트랙레코드');
db.prepare(`UPDATE news_clusters SET first_seen = datetime('now', '-91 day') WHERE id = ?`).run(cluster.id);
assert(stmts.dueRevisit.all().some((c) => c.id === cluster.id), 'due 쿼리에 포착');

const revisitOut = {
  outcome_summary: '환율은 90일간 1500대에 머물렀고 1650에는 도달하지 않았다. 당국 개입 후에도 레벨은 유지됐다.',
  frame_verdicts: {
    A: { held: false, note: '정책 실기 단일 원인론은 글로벌 달러 강세 지속으로 약화' },
    B: { held: true, note: '외부요인론이 전개와 부합' },
  },
  claim_verdicts: [
    { source: '조선일보', claim: '연말까지 1650 도달 전망', verdict: 'failed', note: '90일 내 미도달' },
    { source: '한겨레', claim: '당국 개입으로 단기 안정 전망', verdict: 'unclear', note: '안정의 기준 불명확' },
  ],
  structural_verdicts: [{ axis: 'external_constraints', verdict: 'consistent', note: '달러 금융여건 영향이 유지됨' }],
  lesson: '급등 국면의 극단 목표가는 축 불문 과장되는 경향.',
};
(async () => {
  const rr = await revisit();
  async function revisit() {
    return news.revisitCluster(cluster, {
      runLLM: () => ({ ok: true, text: JSON.stringify(revisitOut) }),
      fetchRecent: async () => [{ source: '연합뉴스', title: '환율 1520선 등락', description: '최근 흐름' }],
    });
  }
  assert(rr.ok && rr.verdicts === 2, '재방문 완료 + 판정 2건');
  assert(stmts.clusterByKey.get('fx-1550-breach-2026-04').status === 'revisited', 'status 전환');
  assert(stmts.snapshotFor.get(cluster.id, 'revisit') != null, 'revisit 스냅샷 저장');
  const track = stmts.pressTrackAgg.all();
  assert(track.find((t) => t.source === '조선일보' && t.verdict === 'failed'), '트랙레코드: failed 기록');

  console.log('6. 재방문 검증 — 없는 매체 판정 거부');
  const bad = news.validateRevisitOut(
    { outcome_summary: 'o', claim_verdicts: [{ source: '없던매체', claim: 'c', verdict: 'held' }] },
    [{ source: '조선일보', claim: 'x' }]);
  assert(!bad.ok, '당시 목록에 없는 매체 → 거부 (지어내기 방지)');

  console.log('7. 포맷터');
  const msg = news.formatRevisit(cluster, revisitOut);
  assert(msg.includes('90일 재방문') && msg.includes('❌') && msg.includes('과장되는 경향'), '재방문 리포트 포맷');
  const pt = news.formatPressTrack();
  assert(pt.includes('조선일보') && pt.includes('표본이 적을 땐'), '트랙레코드 포맷 + 표본 경고');

  console.log('8. manual 모드 — 프롬프트 파일 덤프');
  process.env.EXTRACT_MODE = 'manual';
  stmts.insertNewsItem.run({ link: 'https://yna.co.kr/2', title: '추가기사', description: 'd', source: '연합뉴스', spectrum: 'wire', pub_date: null, query: '원달러 환율' });
  const mr = news.clusterQuery('원달러 환율'); // 기본 llm.run 사용
  assert(!mr.ok && mr.reason.includes('manual'), 'manual 모드에서 파일 덤프 경로 반환');
  process.env.EXTRACT_MODE = 'claude';

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
