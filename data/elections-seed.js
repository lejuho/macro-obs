// 선거 캘린더 + 정책 레버 시드 (Phase 4c)
// 원칙 (설계 대화에서 확정): 좌/우 이념 라벨이 아니라 **정책 레버 단위**로 적는다.
//   레버 = 결과에 따라 실제로 바뀌는 정책 손잡이. scenario_name으로 해도 시나리오와 연결.
// 갱신: 선거 3~6개월 전 각 분기의 레버를 리서치로 채운다 (LLM 초안 → 사람 확정).
// ⚠️ 날짜는 등록 시점 최선 추정 — note에 확정 여부 명시. 재시드: node scripts/seed-elections.js

const ELECTIONS = [
  {
    country: '미국', body: 'midterm', date: '2026-11-03',
    note: '중간선거 — 상하원 구도가 관세·산업정책 입법 지형 결정',
    levers: [
      { branch: '여당 상하원 유지', lever: '관세·수출통제 현행 기조 지속', scenario: '미국 관세·산업정책 압박',
        note: '한국 패키지 협상 압력 지속. coercion_transfer 간선 활성 상태 유지' },
      { branch: '하원 역전', lever: '신규 관세 입법 동력 약화 (행정명령 중심으로 이동)', scenario: '미국 관세·산업정책 압박',
        note: '압박 강도보다 예측가능성이 변수 — 행정부 단독 수단은 오히려 변동성↑' },
      { branch: '공통', lever: 'IRA 보조금 존폐 재론', scenario: null,
        note: '이차전지 coercion_transfer 간선(보조금-투자요구)의 유효성 재평가 필요' },
    ],
  },
  {
    country: '중국', body: 'party_congress', date: '2027-10-15',
    note: '21차 당대회 — 날짜 근사(가을), 확정 시 수정',
    levers: [
      { branch: '기술자립 노선 강화', lever: '반도체 국산화 보조금·희토류 통제 카드 상시화', scenario: '미중 디커플링 심화',
        note: '한국 중간재의 對中 수출 구조 재평가 시점' },
      { branch: '경기부양 우선', lever: '부동산·지방정부 구제 패키지', scenario: '중국 부동산 재침체',
        note: '철강 덤핑 경로의 완화 여부 — 중국부동산 노드 가중치 재검토' },
    ],
  },
  {
    country: '대만', body: 'president', date: '2028-01-13',
    note: '총통 선거 — 양안 긴장도의 최대 분기점',
    levers: [
      { branch: '현상유지파 승리', lever: '대만해협 긴장 현 수준', scenario: '대만 유사', note: null },
      { branch: '급진 독립 성향 강화', lever: '중국 군사훈련 상시화 → 해협 보험료·물류 리스크 상향', scenario: '대만 유사',
        note: '조기신호: 훈련 빈도, 해협 통과 보험료 프록시' },
    ],
  },
  {
    country: '한국', body: 'parliament', date: '2028-04-12',
    note: '총선 — 날짜 근사',
    levers: [
      { branch: '공통', lever: '對美 투자 패키지·방위비 협상 재론, 상법·자본시장 규제 방향', scenario: '미국 관세·산업정책 압박',
        note: '전자증권법(2027.2)·STO 입법 후속이 원화 자산 구조에 영향' },
    ],
  },
  {
    country: '미국', body: 'president', date: '2028-11-07',
    note: '대선 — 레버는 2028년 상반기에 후보 확정 후 채움',
    levers: [],
  },
];

module.exports = { ELECTIONS };
