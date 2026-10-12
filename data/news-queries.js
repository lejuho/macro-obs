// 뉴스 수집 쿼리 — 해도 노드/시나리오와 연결 (조회 맥락 제공)
// 유지 규칙: 쿼리 수 ≤ 10 (일 배치 LLM 비용·클러스터 관리 상한)
module.exports = [
  { query: '원달러 환율', node: '원화가치', countries: ['KR', 'US'] },
  { query: '반도체 수출', node: '반도체수출', scenario: 'AI CAPEX 피크아웃', countries: ['KR', 'US', 'CN', 'TW'] },
  { query: '대미 관세', node: '대미자동차수출', scenario: '미국 관세·산업정책 압박', countries: ['KR', 'US'] },
  { query: '미중 수출통제', scenario: '미중 디커플링 심화', countries: ['US', 'CN'] },
  { query: '한중 무역', scenario: '중국 보복 패키지', countries: ['KR', 'CN'] },
  { query: '국채 금리', node: '미국장기금리', countries: ['US', 'KR'] },
  { query: '경상수지', node: '원화가치', countries: ['KR'] },
  { query: '호르무즈', scenario: '호르무즈 봉쇄', countries: ['US'] },
  { query: '한국 정치 국회 정당 정부', topic: 'politics', countries: ['KR'] },
  { query: '미국 정치 의회 행정부 선거', topic: 'politics', countries: ['US'] },
];
