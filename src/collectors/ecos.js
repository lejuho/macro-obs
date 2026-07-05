// ECOS 수집기.
// API 문서: https://ecos.bok.or.kr/api/ (StatisticSearch 서비스)
// URL 형식: /api/StatisticSearch/{KEY}/json/kr/{start}/{end}/{통계표코드}/{주기}/{시작일}/{종료일}/{항목코드1}
//
// ⚠️ 통계표/항목 코드는 훈련 지식 기반 기본값이며 개편으로 바뀔 수 있음.
//    반드시 `node scripts/verify-ecos-codes.js`로 실기기(네트워크 되는 환경)에서 검증 후 확정할 것.
//    코드가 다르면 이 파일의 SERIES만 고치면 된다.

const { stmts, tx } = require('../db');
const { ECOS_API_KEY } = require('../config');

// Phase 0 수집 대상. 스펙 §3.2의 뉴노멀 가설 4건을 커버.
const SERIES = [
  {
    key: 'usdkrw',
    name: '원/달러 환율(매매기준율)',
    stat: '731Y001', item: '0000001', freq: 'D', unit: 'KRW/USD',
  },
  {
    key: 'base_rate',
    name: '한국은행 기준금리',
    stat: '722Y001', item: '0101000', freq: 'D', unit: '%',
  },
  {
    key: 'ktb3y',
    name: '국고채 3년 수익률',
    stat: '817Y002', item: '010200000', freq: 'D', unit: '%',
  },
  {
    key: 'cpi',
    name: '소비자물가지수(2020=100)',
    stat: '901Y009', item: '0', freq: 'M', unit: 'index',
  },
  {
    key: 'current_account',
    name: '경상수지',
    stat: '301Y013', item: '000000', freq: 'M', unit: '백만달러',
  },
];

function fmtDate(d, freq) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (freq === 'D') return `${y}${m}${day}`;
  if (freq === 'M') return `${y}${m}`;
  if (freq === 'Q') return `${y}Q${Math.ceil((d.getMonth() + 1) / 3)}`;
  return String(y);
}

// ECOS TIME 필드(YYYYMMDD/YYYYMM/...) → ISO
function ecosTimeToISO(t) {
  t = String(t);
  if (t.length === 8) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  if (t.length === 6) return `${t.slice(0, 4)}-${t.slice(4, 6)}-01`;
  if (/^\d{4}Q\d$/.test(t)) {
    const q = Number(t[5]);
    return `${t.slice(0, 4)}-${String(q * 3 - 2).padStart(2, '0')}-01`;
  }
  return `${t}-01-01`;
}

async function fetchSeries(s, lookbackDays) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86400_000);
  const url = [
    'https://ecos.bok.or.kr/api/StatisticSearch',
    ECOS_API_KEY(), 'json', 'kr', '1', '3000',
    s.stat, s.freq, fmtDate(start, s.freq), fmtDate(end, s.freq), s.item,
  ].join('/');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ECOS HTTP ${res.status} (${s.key})`);
  const json = await res.json();

  if (json.RESULT) {
    // 에러 응답 형식: { RESULT: { CODE, MESSAGE } }
    throw new Error(`ECOS ${json.RESULT.CODE}: ${json.RESULT.MESSAGE} (${s.key}, stat=${s.stat})`);
  }
  const rows = json.StatisticSearch?.row || [];
  return rows
    .filter((r) => r.DATA_VALUE !== '' && r.DATA_VALUE != null)
    .map((r) => ({ date: ecosTimeToISO(r.TIME), value: Number(r.DATA_VALUE) }));
}

async function collect({ lookbackDays = 30 } = {}) {
  const results = [];
  for (const s of SERIES) {
    const { id } = stmts.upsertIndicator.get({
      source: 'ecos', source_code: `${s.stat}/${s.item}`,
      name: s.name, freq: s.freq, unit: s.unit, category: 'macro',
    });
    try {
      const obs = await fetchSeries(s, s.freq === 'D' ? lookbackDays : 400);
      tx(() => {
        for (const o of obs) stmts.upsertObs.run(id, o.date, o.value);
      });
      results.push({ key: s.key, indicator_id: id, count: obs.length, ok: true });
    } catch (e) {
      // 한 시리즈 실패가 전체 배치를 죽이지 않는다
      results.push({ key: s.key, indicator_id: id, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { collect, SERIES };
