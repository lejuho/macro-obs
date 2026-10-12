// 뉴스 배치 (Phase 5): 수집 → 클러스터+프레이밍 → 90일 재방문
// cron (daily.js와 별도 — LLM 비용 분리):
//   30 21 * * *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/news.js >> log/news.log 2>&1

const { collect } = require('../collectors/naver');
const { clusterQuery, revisitCluster, formatRevisit } = require('../news');
const { send } = require('../notify/telegram');
const { record } = require('../events');
const { stmts } = require('../db');
const QUERIES = require('../../data/news-queries');
const AGENT = process.env.EXTRACT_AGENT === '1';

async function main() {
  console.log(`[${new Date().toISOString()}] news job start`);

  // 1. 수집
  for (const r of await collect()) {
    console.log(r.ok ? `  collect "${r.query}": +${r.added}/${r.fetched}` : `  collect "${r.query}": ${r.error}`);
  }

  // 2. 클러스터+프레이밍 (쿼리당 claude 1콜)
  for (const q of QUERIES) {
    const r = clusterQuery(q.query, undefined, { agent: AGENT });
    if (r.skip) continue;
    record({ kind: 'news_cluster', data: r });
    console.log(r.ok
      ? `  cluster "${r.query}": 신규 ${r.created} · 갱신 ${r.updated} · noise ${r.noise}`
      : `  cluster "${r.query}": FAILED — ${r.reason}`);
  }

  // 3. 90일 재방문 (하루 최대 3건 — 구독 한도 보호)
  for (const c of stmts.dueRevisit.all()) {
    const r = await revisitCluster(c, { agent: AGENT });
    if (r.skip) continue;
    if (!r.ok) { console.log(`  revisit ${r.cluster}: FAILED — ${r.reason}`); continue; }
    console.log(`  revisit ${r.cluster}: ${r.verdicts} claims graded`);
    await send(formatRevisit(c, r.data), {
      event: { kind: 'news_revisit', data: { cluster_id: c.id, title: c.title, review: r.data } },
    }).catch((e) => console.error('send:', e.message));
  }

  console.log(`[${new Date().toISOString()}] news job done`);
}

main().catch((e) => { console.error('news job fatal:', e); process.exit(1); });
