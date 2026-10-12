// FRED 수집기 (글로벌 계기판 지표 — Tier 1)
// API: https://api.stlouisfed.org/fred/series/observations
// 키 발급: https://fred.stlouisfed.org/docs/api/api_key.html (무료)
//
// 선정 기준: 시나리오 연결성 × 무료 API 존재 × 가설화 가능성.
// MOVE·한국CDS·JKM·SCFI·BDI는 무료 API가 없어 보류 (스펙 §8-5 조기신호 프록시 리서치 대상).
//
// note = 계기판 카드에 뜨는 "노브 문장" (해석 힌트 — 추천 아님)
// graph_node = 해도 흐름 노드 매핑 (밴드 이탈 시 역방향 시나리오 조회에 사용)

const { stmts, tx } = require('../db');

const FRED_KEY = () => process.env.FRED_API_KEY; // 없으면 수집 스킵 (선택 기능)

const SERIES = [
  {
    code: 'DGS10', name: '미국 국채 10년', freq: 'D', unit: '%',
    note: '글로벌 할인율 노브: 상승은 성장주·반도체·이차전지 밸류에이션 압박. 유가·재정·기대인플레와 함께 볼 것.',
    graph_node: '미국장기금리',
  },
  {
    code: 'DGS2', name: '미국 국채 2년', freq: 'D', unit: '%',
    note: 'Fed 정책 기대 노브: 10년물과의 역전 폭이 정책 긴축 강도.',
  },
  {
    code: 'T10Y3M', name: '미국 10년-3개월 금리차', freq: 'D', unit: '%p',
    note: '침체 선행 노브: 뉴욕연은 12개월 침체확률 모델의 입력. 역전 후 재가팔라지는 구간이 역사적 위험 구간.',
  },
  {
    code: 'VIXCLS', name: 'VIX', freq: 'D', unit: 'pt',
    note: '주식 위험회피 노브: 20 이상 경계, 30 이상 위험회피 급증. VIX가 낮아도 신용스프레드가 뛰면 스트레스가 숨어있을 수 있음.',
  },
  {
    code: 'BAMLH0A0HYM2', name: '미국 HY 스프레드', freq: 'D', unit: '%p',
    note: '신용위험 노브: 급등은 침체 신호로 해석 가능. 주식(VIX)보다 거시적일 때가 많음.',
  },
  {
    code: 'DTWEXBGS', name: '달러지수(광의)', freq: 'D', unit: 'index',
    note: '달러 강세 노브: DXY는 ICE 사유지수라 FRED 무역가중 광의지수로 대용. 강세 = 원화·신흥국 압력.',
    graph_node: '달러유동성',
  },
  {
    code: 'DEXJPUS', name: 'USD/JPY', freq: 'D', unit: 'JPY',
    note: '엔캐리·BOJ 노브: 급락(엔 급등)은 캐리 청산 신호 — BOJ 긴축 쇼크 시나리오의 조기신호 (2024.8 실증).',
    graph_node: '엔화유동성',
  },
  {
    code: 'DEXCHUS', name: 'USD/CNY', freq: 'D', unit: 'CNY',
    note: '위안화 노브: 위안 약세는 원화 약세로 전염 (프록시 통화). 역외 CNH는 무료 소스가 없어 온쇼어 대용.',
    graph_node: '위안화가치',
  },
  {
    code: 'DCOILBRENTEU', name: 'Brent 유가', freq: 'D', unit: '$/bbl',
    note: '에너지 수입비용 노브: 호르무즈·중동 리스크의 가격 표현. 원화·정유·항공·전력 원가 직결.',
    graph_node: '원유수입',
  },
];

async function fetchSeries(code, lookbackDays) {
  const start = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10);
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${code}` +
    `&api_key=${FRED_KEY()}&file_type=json&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED HTTP ${res.status} (${code})`);
  const json = await res.json();
  if (json.error_message) throw new Error(`FRED ${code}: ${json.error_message}`);
  return parseObs(json.observations || []);
}

/** 순수 파서 (테스트 대상): FRED는 결측을 value:'.'로 표기 */
function parseObs(observations) {
  return observations
    .filter((o) => o.value !== '.' && o.value !== '' && o.value != null)
    .map((o) => ({ date: o.date, value: Number(o.value) }));
}

async function collect({ lookbackDays = 30 } = {}) {
  if (!FRED_KEY()) return []; // 키 없으면 조용히 스킵 — 선택 기능
  const results = [];
  for (const s of SERIES) {
    const { id } = stmts.upsertIndicator.get({
      source: 'fred', source_code: s.code, name: s.name,
      freq: s.freq, unit: s.unit, category: 'global', note: s.note,
    });
    try {
      const obs = await fetchSeries(s.code, lookbackDays);
      tx(() => { for (const o of obs) stmts.upsertObs.run(id, o.date, o.value); });
      results.push({ key: s.code, indicator_id: id, count: obs.length, ok: true });
    } catch (e) {
      results.push({ key: s.code, indicator_id: id, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { collect, parseObs, SERIES };
