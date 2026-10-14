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

// A/B 보강: 최신순 50건은 소형 매체가 대부분이라 축 양끝 기사가 거의 안 잡힌다.
// 같은 쿼리로 더 깊은 최신순 페이지 + 관련도순을 훑어 A/B 매체 기사만 추가로 담는다.
const BOOST = {
  pages: [{ sort: 'date', start: 51 }, { sort: 'date', start: 151 }, { sort: 'sim', start: 1 }],
  spectra: ['A', 'B'],
  maxAgeHours: 72, // 오래된 기사는 지난 사건을 새 클러스터로 만들 수 있어 제외
  cap: 30,         // 쿼리당 상한 — 클러스터링 LLM 입력량 보호
};

/** 순수: 보강 후보 → A/B·최근·중복 제거·최신순 상한 */
function pickBoost(items, { now = Date.now(), seen = new Set() } = {}) {
  const since = now - BOOST.maxAgeHours * 3600_000;
  const out = [];
  for (const it of items) {
    if (!BOOST.spectra.includes(it.spectrum) || seen.has(it.link)) continue;
    if (!it.pub_date || Date.parse(it.pub_date) < since) continue;
    seen.add(it.link);
    out.push(it);
  }
  return out.sort((a, b) => b.pub_date.localeCompare(a.pub_date)).slice(0, BOOST.cap);
}

async function search(query, display = 50, { sort = 'date', start = 1 } = {}) {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}&start=${start}`;
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
      let extra = [], boostError = null;
      try {
        const pool = [];
        for (const pg of BOOST.pages) {
          await sleep(300);
          pool.push(...parseItems(await search(q.query, 100, pg), q.query));
        }
        extra = pickBoost(pool, { seen: new Set(items.map((it) => it.link)) });
      } catch (e) { boostError = e.message; } // 보강 실패는 본 수집을 막지 않는다
      let added = 0, boosted = 0;
      tx(() => {
        for (const it of items) {
          const r = stmts.insertNewsItem.run(it);
          if (r.changes) added++;
        }
        for (const it of extra) {
          const r = stmts.insertNewsItem.run(it);
          if (r.changes) boosted++;
        }
      });
      results.push({ query: q.query, fetched: items.length, added, boosted, boostError, ok: true });
    } catch (e) {
      results.push({ query: q.query, ok: false, error: e.message });
    }
    await sleep(300);
  }
  return results;
}

module.exports = { collect, search, parseItems, identifyPress, pickBoost, BOOST };
