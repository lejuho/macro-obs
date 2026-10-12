// 네이버 뉴스 검색 수집기 (Phase 5)
// API: https://openapi.naver.com/v1/search/news.json (키: developers.naver.com 무료)
// 저장 정책: 제목·API 요약(description)·링크·매체·날짜만. 본문 전문 저장 금지.

const { stmts, tx } = require('../db');
const PRESS = require('../../data/press-map');
const QUERIES = require('../../data/news-queries');

const ID = () => process.env.NAVER_CLIENT_ID;
const SECRET = () => process.env.NAVER_CLIENT_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 순수: originallink → {source, spectrum} */
function identifyPress(originallink) {
  try {
    const host = new URL(originallink).hostname.replace(/^www\./, '');
    for (const [domain, info] of Object.entries(PRESS.DOMAINS)) {
      if (host === domain || host.endsWith('.' + domain)) return info;
    }
  } catch { /* fallthrough */ }
  return { name: '기타', spectrum: 'unknown' };
}

/** 순수: API 응답 → 저장 레코드 (HTML 태그 제거) */
function parseItems(json, query) {
  const strip = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return (json.items || []).map((it) => {
    const press = identifyPress(it.originallink || it.link);
    return {
      link: it.originallink || it.link,
      title: strip(it.title),
      description: strip(it.description),
      source: press.name, spectrum: press.spectrum,
      pub_date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      query,
    };
  });
}

async function search(query, display = 50) {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${display}&sort=date`;
  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': ID(), 'X-Naver-Client-Secret': SECRET() },
  });
  if (!res.ok) throw new Error(`Naver HTTP ${res.status} (${query})`);
  return res.json();
}

async function collect() {
  if (!ID() || !SECRET()) return [{ ok: false, error: 'NAVER_CLIENT_ID/SECRET 없음 (.env)' }];
  const results = [];
  for (const q of QUERIES) {
    try {
      const items = parseItems(await search(q.query), q.query);
      let added = 0;
      tx(() => {
        for (const it of items) {
          const r = stmts.insertNewsItem.run(it);
          if (r.changes) added++;
        }
      });
      results.push({ query: q.query, fetched: items.length, added, ok: true });
    } catch (e) {
      results.push({ query: q.query, ok: false, error: e.message });
    }
    await sleep(300);
  }
  return results;
}

module.exports = { collect, search, parseItems, identifyPress };
