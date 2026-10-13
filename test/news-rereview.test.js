// 재검토 테스트: 재방문 뒤 도착한 외부 보고서 → 근거 있는 변경만 반영, 루프 상한
// 실행: node --no-warnings test/news-rereview.test.js

process.env.DB_PATH = '/tmp/macro-news-rereview.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const news = require('../src/news');
const { reportTools } = require('../src/mcp-report-tools');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

// 픽스처: 재방문까지 끝난 클러스터 (한화 탈락 판정)
const { id: cid } = stmts.insertCluster.get({ event_key: 'ca-sub', title: '캐나다 잠수함 사업', query: '방산', countries_json: '[]' });
db.prepare(`UPDATE news_clusters SET status = 'revisited', first_seen = datetime('now','-95 day') WHERE id = ?`).run(cid);
stmts.insertSnapshot.run(cid, 'initial', JSON.stringify({
  spectrum_frames: { A: 'K방산 진출 기대' }, notable_claims: [{ source: '한경', claim: '한화 수주 유력' }],
  core_frame: 'K방산 수주 기대', structural_hypotheses: [],
}));
const prevRevisit = {
  outcome_summary: 'TKMS로 결정, 한국 컨소시엄 수주 실패.', frame_verdicts: { core: { held: false, note: '빗나감' } },
  claim_verdicts: [{ source: '한경', claim: '한화 수주 유력', verdict: 'failed', note: '탈락' }],
  structural_verdicts: [], lesson: '정치 변수', report_checks: [], consulted_report_ids: [],
};
stmts.insertSnapshot.run(cid, 'revisit', JSON.stringify(prevRevisit));
stmts.insertPressTrack.run({ cluster_id: cid, source: '한경', claim: '한화 수주 유력', verdict: 'failed', note: '탈락' });

const ev = (kind, data) => Number(db.prepare(`INSERT INTO events (source, kind, data_json) VALUES ('news', ?, ?)`).run(kind, JSON.stringify(data)).lastInsertRowid);
const save = reportTools('oauth:Tester').find((t) => t.name === 'save_report').handler;
const eRev = ev('news_revisit', { cluster_id: cid, title: '캐나다 잠수함 사업' });
save({ title: '재방문 정정', body: `### #${eRev}\nTKMS는 우선공급자 선정 후 계약 협상 중, 한화는 예비공급자 — 최종 탈락 아님.`, event_ids: [eRev] });

const stubLLM = (out) => () => ({ ok: true, text: JSON.stringify(out) });
const noFetch = async () => [];

(async () => {
  console.log('1. 대상 선정');
  let due = news.dueRereview();
  assert(due.length === 1 && due[0].cluster.id === cid && due[0].reports[0].id === 1, '재방문 뒤 도착한 미참조 보고서 → 재검토 대상');

  console.log('2. 근거 없는 판정 변경은 기각');
  let r = await news.rereviewCluster(due[0], { fetchRecent: noFetch, runLLM: stubLLM({
    ...prevRevisit, claim_verdicts: [{ source: '한경', claim: '한화 수주 유력', verdict: 'unclear', note: '보고서에 따름' }],
    changes_from_previous: [], report_checks: [{ report_id: 1, point: '예비공급자', status: 'unverified', evidence: '확인 기사 없음' }],
  }) });
  assert(r.ok && !r.accepted && r.data.claim_verdicts[0].verdict === 'failed', '이전 판정 유지');
  assert(r.data.rejected_diff.length === 1 && r.data.rereview_of, '기각된 차이·재검토 출처 기록');
  assert(db.prepare('SELECT verdict FROM press_track WHERE cluster_id = ?').get(cid).verdict === 'failed', 'press_track 불변');
  assert(news.dueRereview().length === 0, '참조한 보고서로는 재검토 반복 안 함');
  assert(/기각/.test(news.formatRereview({ title: 't' }, r.data)), '알림에 기각 표시');

  console.log('3. 근거 있는 변경은 반영');
  const eRev2 = ev('news_revisit', { cluster_id: cid, title: 'x', rereview: true });
  save({ title: '추가 정정', body: `### #${eRev2}\n계약 미체결 확인.`, event_ids: [eRev2] });
  due = news.dueRereview();
  assert(due.length === 1 && due[0].reports.map((x) => x.id).join() === '2', '새 보고서만 대상');
  r = await news.rereviewCluster(due[0], { fetchRecent: noFetch, runLLM: stubLLM({
    ...prevRevisit, claim_verdicts: [{ source: '한경', claim: '한화 수주 유력', verdict: 'unclear', note: '계약 협상 중' }],
    changes_from_previous: [{ field: 'claim.한경', before: 'failed', after: 'unclear', evidence: '10월 보도: TKMS 계약 협상 단계, 미체결' }],
    report_checks: [{ report_id: 2, point: '계약 미체결', status: 'confirmed', evidence: '10월 보도' }],
  }) });
  assert(r.ok && r.accepted && r.changed === 1, '변경 반영');
  assert(db.prepare('SELECT verdict FROM press_track WHERE cluster_id = ?').all(cid).map((x) => x.verdict).join() === 'unclear', 'press_track 최신 판정으로 교체');
  const snaps = db.prepare(`SELECT content_json FROM framing_snapshots WHERE cluster_id = ? AND phase = 'revisit' ORDER BY id`).all(cid);
  assert(snaps.length === 3 && JSON.parse(snaps[0].content_json).claim_verdicts[0].verdict === 'failed', '최초 재방문 스냅샷 보존');
  assert(news.diffRevisit(prevRevisit, JSON.parse(snaps[2].content_json)).length === 1, 'diff는 코드 계산');

  console.log('4. 루프 상한 (클러스터당 2회)');
  const eRev3 = ev('news_revisit', { cluster_id: cid, title: 'x', rereview: true });
  save({ title: '또 정정', body: `### #${eRev3}\n...`, event_ids: [eRev3] });
  assert(news.dueRereview().length === 0, '재검토 2회 후 더 이상 대상 아님');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
