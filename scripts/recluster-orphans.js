// 클러스터링 실패가 이틀 이어져 2일 창 밖으로 밀린 기사(미배정·비noise)를 소급 클러스터링한다.
// 쿼리·수집일 묶음을 시간순으로 처리 — 사건 날짜는 기사 pub_date 기준, 이벤트 로그(news_cluster)는 남기지 않음.
// 실행: node --no-warnings --no-network-family-autoselection scripts/recluster-orphans.js [--dry] [--since 2026-10-01]
const { db } = require('../src/db');
const { clusterQuery } = require('../src/news');

const dry = process.argv.includes('--dry');
const si = process.argv.indexOf('--since');
const since = si > 0 ? process.argv[si + 1] : '2026-10-01';

const orphans = db.prepare(`
  SELECT * FROM news_items WHERE cluster_id IS NULL AND is_noise = 0
  AND ingested_at >= ? AND ingested_at < datetime('now', '-2 day')
  ORDER BY ingested_at, id`).all(since);
const batches = new Map();
for (const it of orphans) {
  const k = `${it.ingested_at.slice(0, 10)}|${it.query}`;
  if (!batches.has(k)) batches.set(k, []);
  batches.get(k).push(it);
}
console.log(`[${new Date().toISOString()}] orphans ${orphans.length} · batches ${batches.size}${dry ? ' (dry)' : ''}`);
const tally = { ok: 0, failed: 0, created: 0, updated: 0, noise: 0, deferred: 0 };
for (const [k, items] of batches) {
  const [day, query] = k.split('|');
  const asOf = items.map((i) => i.pub_date).filter(Boolean).sort().at(-1) || `${day}T12:00:00Z`;
  if (dry) { console.log(`  ${day} "${query}": ${items.length}건 (asOf ${asOf.slice(0, 16)})`); continue; }
  const r = clusterQuery(query, undefined, { items, asOf });
  if (r.ok) {
    tally.ok++; tally.created += r.created; tally.updated += r.updated; tally.noise += r.noise; tally.deferred += r.deferred;
    console.log(`  ${day} "${query}": 신규 ${r.created} · 갱신 ${r.updated} · noise ${r.noise}${r.deferred ? ` · 미배정 ${r.deferred}` : ''}${r.retried ? ' · 재시도' : ''}${r.repaired ? ' · JSON수리' : ''}`);
  } else {
    tally.failed++;
    console.log(`  ${day} "${query}": FAILED — ${r.reason}`);
  }
}
console.log(`[${new Date().toISOString()}] done`, JSON.stringify(tally));
