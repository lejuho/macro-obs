// 도메인 → 매체·스펙트럼 매핑 (네이버 API는 매체명을 안 주므로 originallink 도메인으로 식별)
//
// spectrum 라벨은 'A'/'B'/'wire' 축 표기 — 통상적 학술 미디어 배치 기준의 시작점이며
// 이 파일은 데이터일 뿐이다. 목적은 "누가 옳냐"가 아니라
// 같은 사건을 축의 양끝이 어떻게 다르게 서사화하고 90일 뒤 누구의 예측이 살아남았는지의 측정.
// 필요하면 자유롭게 재배치하라 — 시스템 로직은 라벨 내용에 무관심하다.

module.exports = {
  AXIS: { A: '보수 계열', B: '진보 계열', wire: '통신·공영', unknown: '미분류' },
  DOMAINS: {
    'chosun.com': { name: '조선일보', spectrum: 'A' },
    'joongang.co.kr': { name: '중앙일보', spectrum: 'A' },
    'donga.com': { name: '동아일보', spectrum: 'A' },
    'hankyung.com': { name: '한국경제', spectrum: 'A' },
    'mk.co.kr': { name: '매일경제', spectrum: 'A' },
    'hani.co.kr': { name: '한겨레', spectrum: 'B' },
    'khan.co.kr': { name: '경향신문', spectrum: 'B' },
    'ohmynews.com': { name: '오마이뉴스', spectrum: 'B' },
    'pressian.com': { name: '프레시안', spectrum: 'B' },
    'yna.co.kr': { name: '연합뉴스', spectrum: 'wire' },
    'news1.kr': { name: '뉴스1', spectrum: 'wire' },
    'newsis.com': { name: '뉴시스', spectrum: 'wire' },
    'kbs.co.kr': { name: 'KBS', spectrum: 'wire' },
    'ytn.co.kr': { name: 'YTN', spectrum: 'wire' },
    'edaily.co.kr': { name: '이데일리', spectrum: 'wire' },
    'yonhapnewstv.co.kr': { name: '연합뉴스TV', spectrum: 'wire' },
  },
};
