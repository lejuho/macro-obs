// 외부 에이전트 보고서 → 뉴스 파이프라인 피드백 테스트 (명시적 event_ids 연결만)
// 실행: node --no-warnings test/news-reports.test.js

process.env.DB_PATH = '/tmp/macro-news-reports.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const news = require('../src/news');
const { reportTools } = require('../src/mcp-report-tools');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

// 픽스처: 90일 지난 클러스터 2개 + 이벤트 + 보고서
const mkCluster = (key, title) => {
  const { id } = stmts.insertCluster.get({ event_key: key, title, query: '국채 금리', countries_json: '[]' });
  db.prepare(`UPDATE news_clusters SET first_seen = datetime('now','-91 day'), last_seen = datetime('now','-1 day') WHERE id = ?`).run(id);
  stmts.insertSnapshot.run(id, 'initial', JSON.stringify({
    spectrum_frames: { A: '재정 우려', B: null, wire: null }, notable_claims: [{ source: '한경', claim: '3년물 4% 돌파' }],
    core_frame: '재정 프리미엄', expected_development: '금리 상승', structural_hypotheses: [],
  }));
  return id;
};
const c1 = mkCluster('kr-3y-fiscal', '국고채 재정 우려');
const c2 = mkCluster('kr-other', '무관한 사건');
const ev = (kind, data) => Number(db.prepare(`INSERT INTO events (source, kind, data_json) VALUES ('news', ?, ?)`).run(kind, JSON.stringify(data)).lastInsertRowid);
const eRevisit = ev('news_revisit', { cluster_id: c1, title: 'x' });
const eCluster = ev('news_cluster', { query: '국채 금리', ok: true, cluster_ids: [c1] });
const eOther = ev('news_cluster', { query: '국채 금리', ok: true, cluster_ids: [] });
const save = reportTools('oauth:Tester').find((t) => t.name === 'save_report').handler;
save({ title: '보고서 A', body: `## 요약\n전반 요약\n### #${eRevisit} / 클러스터: 국고채\n공식 발표로는 3.86%였다.\n## 기타\n#${eOther} 언급`, event_ids: [eRevisit, eOther] });
save({ title: '보고서 B (제목에 국고채 재정 우려)', body: '제목만 겹치는 보고서', event_ids: [eOther] });
save({ title: '보고서 C', body: 'x'.repeat(5000), event_ids: [eCluster] });

console.log('1. 연결 — 명시적 event_ids만');
const linked = news.linkedReports(c1);
assert(linked.map((r) => r.id).join() === '3,1', 'news_revisit·news_cluster 경유 보고서 연결 (최신순)');
assert(!linked.some((r) => r.id === 2), '제목만 겹치는 보고서는 연결 안 됨');
assert(news.linkedReports(c2).length === 0, '무관 클러스터는 연결 없음');

console.log('2. 발췌');
const a = linked.find((r) => r.id === 1);
assert(a.excerpt.startsWith(`### #${eRevisit}`) && !a.excerpt.includes('전반 요약'), '이벤트 헤딩 섹션만 발췌');
assert(linked.find((r) => r.id === 3).excerpt.length <= 1510, '발췌 상한');
assert(news.excerptReport('#12 언급\n#123', [12], 100) === '#12 언급\n#123', '헤딩 없으면 전체(상한 내)');
assert(news.excerptReport('## a\n#123 only', [12], 100) === '## a\n#123 only', '#12가 #123에 오매칭되지 않음 → 폴백');

console.log('3. 재방문 — 라벨·감사 기록');
let prompt = '';
const out = {
  outcome_summary: '3년물은 3.8% 위에서 등락했다.', frame_verdicts: {}, claim_verdicts: [], structural_verdicts: [], lesson: 'x',
  report_checks: [
    { report_id: 1, point: '3.86%', status: 'confirmed', evidence: '지표 시계열' },
    { report_id: 99, point: '참조 안 된 보고서', status: 'confirmed' },
    { report_id: 3, point: 'p', status: 'maybe' },
  ],
};
(async () => {
  const r = await news.revisitCluster(stmts.clusterByKey.get('kr-3y-fiscal'), {
    fetchRecent: async () => [], runLLM: (input) => { prompt = input; return { ok: true, text: JSON.stringify(out) }; },
  });
  assert(r.ok, '재방문 성공');
  assert(prompt.includes('외부 에이전트 보고서 (참고, 관측소 판단 아님)') && prompt.includes('보고서 #1 (oauth:Tester'), '프롬프트에 라벨·출처');
  assert(prompt.includes('직접 확인하지 못한') || prompt.includes('직접 확인한 경우에만'), '검증 규율 문구');
  const snap = JSON.parse(stmts.snapshotFor.get(c1, 'revisit').content_json);
  assert(snap.consulted_report_ids.join() === '3,1', 'consulted_report_ids 코드 기록');
  assert(snap.report_checks.length === 1 && snap.report_checks[0].report_id === 1, '미참조·잘못된 enum check 제거');
  assert(news.formatRevisit(stmts.clusterByKey.get('kr-3y-fiscal'), snap).includes('참고한 외부 보고서 #3, #1 (확인 1'), '알림에 참고 보고서 표시');

  console.log('4. 보고서 없는 재방문은 그대로');
  let p2 = '';
  const r2 = await news.revisitCluster(stmts.clusterByKey.get('kr-other'), {
    fetchRecent: async () => [], runLLM: (input) => { p2 = input; return { ok: true, text: JSON.stringify({ ...out, report_checks: [] }) }; },
  });
  const snap2 = JSON.parse(stmts.snapshotFor.get(c2, 'revisit').content_json);
  assert(r2.ok && !p2.includes('[외부 에이전트 보고서 (참고') && snap2.consulted_report_ids.length === 0, '보고서 섹션 없음 + 빈 감사 기록');

  console.log('5. 클러스터링 — 기존 사건 메모 + cluster_ids 이벤트 데이터');
  db.prepare(`UPDATE news_clusters SET last_seen = datetime('now') WHERE id = ?`).run(c1);
  db.prepare(`INSERT INTO news_items (link, title, description, source, spectrum, pub_date, query) VALUES ('https://a/1','국고채 3년 급등','d','한경','A','2026-10-13T00:00:00Z','국채 금리')`).run();
  const itemId = db.prepare(`SELECT id FROM news_items`).get().id;
  let cprompt = '';
  const cr = news.clusterQuery('국채 금리', (input) => {
    cprompt = input;
    return { ok: true, text: JSON.stringify({ clusters: [{ event_key: 'kr-3y-fiscal', title: 't', core_frame: 'f', member_ids: [itemId], countries: [], spectrum_frames: {}, notable_claims: [], structural_hypotheses: [] }], noise_ids: [] }) };
  });
  assert(cr.ok && cr.cluster_ids.join() === String(c1), '결과에 cluster_ids (news_cluster 이벤트 → 보고서 연결 근거)');
  assert(cprompt.includes('kr-3y-fiscal ← 보고서 #3') && cprompt.includes('옮기지 마라'), '기존 사건 메모 + 프레이밍 차단 문구');
  const note = cprompt.split('\n').find((l) => l.startsWith('- kr-3y-fiscal ←'));
  assert(note.length < 400, '메모 길이 상한');
  assert(cr.report_notes.join() === '3', 'report_notes 기록');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
