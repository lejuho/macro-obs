// 국기·연관국 매핑 (단일 소스 — PWA는 /api/flags로, 봇은 직접 require)
// 규칙:
//   지표    = 연관국 전부 (계기판 카드 우상단)
//   노드    = 이름에 국가가 명시적으로 들어간 것만 (엄격 — 호르무즈/핵심광물 등 모호 노드 제외)
//   시나리오 = 연관국 나열 (이름 명시 여부와 무관)
// 지표는 source_code가 환경마다 다를 수 있어(사용자가 VERIFY 코드 확정) 이름 기준 매칭.

const NAMES = {
  KR: '한국', US: '미국', CN: '중국', JP: '일본', TW: '대만',
  EU: '유럽', IR: '이란', SA: '사우디', AE: 'UAE', EG: '이집트', YE: '예멘',
};

/** 'KR' → 🇰🇷 (지역 표시 문자) */
function flag(cc) {
  if (cc === 'EU') return '🇪🇺';
  return [...cc.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');
}

// 지표명 → 연관국 (부분일치 우선순위: 긴 패턴 먼저)
const INDICATOR_RULES = [
  ['한미 10년 금리차', ['KR', 'US']],
  ['원/달러', ['KR', 'US']],
  ['USD/JPY', ['US', 'JP']],
  ['USD/CNY', ['US', 'CN']],
  ['미국', ['US']],
  ['달러지수', ['US']],
  ['VIX', ['US']],
  ['HY 스프레드', ['US']],
  ['Brent', []],            // 글로벌 벤치마크 — 특정국 모호, 국기 없음
  ['국고채', ['KR']],
  ['기준금리', ['KR']],
  ['경상수지', ['KR']],
  ['무역수지', ['KR']],
  ['수출', ['KR']],
  ['소비자물가', ['KR']],
];

// 노드명 → 연관국 (이름에 국가 명시된 것만. 나머지는 의도적으로 없음)
const NODE_FLAGS = {
  '대만해협': ['TW'], '미중수출통제': ['US', 'CN'], '미국관세산업정책': ['US'],
  '한중관계': ['KR', 'CN'], 'BOJ·JGB': ['JP'], '미국국채시장': ['US'],
  '중국부동산': ['CN'], '유럽에너지재정': ['EU'],
  '대미자동차수출': ['KR', 'US'], '대중중간재수출': ['KR', 'CN'],
  'TSMC파운드리공급': ['TW'], '위안화가치': ['CN'], '엔화유동성': ['JP'],
  '원화가치': ['KR'], '미국장기금리': ['US'],
};

// 시나리오명 → 연관국
const SCENARIO_FLAGS = {
  '대만 유사': ['TW', 'CN', 'US'],
  '호르무즈 봉쇄': ['IR', 'SA', 'AE'],
  '홍해수에즈 장기 차질': ['YE', 'EG'],
  '미중 디커플링 심화': ['US', 'CN'],
  '중국 보복 패키지': ['CN', 'KR'],
  '미국 관세·산업정책 압박': ['US', 'KR'],
  'BOJ 긴축 쇼크': ['JP'],
  '미국 국채시장 발작': ['US'],
  '중국 부동산 재침체': ['CN'],
  'AI CAPEX 피크아웃': ['US'],
  '원자재 슈퍼스파이크': [],
  '엘니뇨·작황 쇼크': [],
};

function forIndicator(name) {
  for (const [pat, ccs] of INDICATOR_RULES) {
    if (name.includes(pat)) return ccs;
  }
  return [];
}
const forNode = (name) => NODE_FLAGS[name] || [];
const forScenario = (name) => SCENARIO_FLAGS[name] || [];

/** ['KR','US'] → "🇰🇷 한국 · 🇺🇸 미국" (withNames=false면 국기만) */
function label(ccs, withNames = true) {
  if (!ccs?.length) return '';
  return ccs.map((c) => (withNames ? `${flag(c)} ${NAMES[c] || c}` : flag(c)))
    .join(withNames ? ' · ' : '');
}

module.exports = {
  flag, label, forIndicator, forNode, forScenario,
  NODE_FLAGS, SCENARIO_FLAGS, NAMES,
};
