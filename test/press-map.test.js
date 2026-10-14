// press-map 확장 회귀: 라벨 부여 매체 / 이름만 식별 매체 / 미등록 매체
// 실행: node --no-warnings test/press-map.test.js
process.env.DB_PATH = '/tmp/macro-pressmap.db';
const { identifyPress } = require('../src/collectors/naver');
const PRESS = require('../data/press-map');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

assert(identifyPress('https://news.einfomax.co.kr/news/a').spectrum === 'wire', '연합인포맥스 → wire (서브도메인)');
assert(identifyPress('https://www.tvchosun.com/x').spectrum === 'A', 'TV조선 → A');
assert(identifyPress('https://www.nocutnews.co.kr/news/1').spectrum === 'B', '노컷뉴스 → B');
const sed = identifyPress('https://www.sedaily.com/NewsView/1');
assert(sed.name === '서울경제' && sed.spectrum === 'econ', '서울경제 → econ');
assert(identifyPress('https://www.hankyung.com/a').spectrum === 'econ' && identifyPress('https://www.edaily.co.kr/a').spectrum === 'econ', '한경·이데일리 → econ (A/wire에서 이관)');
assert(identifyPress('https://www.kotra.or.kr/a').spectrum === 'official', 'KOTRA → official');
assert(identifyPress('https://www.seoul.co.kr/a').spectrum === 'unknown', '성향 평가가 엇갈리는 종합지는 unknown 유지');
assert(identifyPress('https://www.sbs.co.kr/a').spectrum === 'wire', '민영 지상파는 통신·공영 축');
assert(identifyPress('https://nosuchpress.example/1').name === '기타', '미등록 → 기타');
assert(Object.values(PRESS.DOMAINS).every((v) => v.spectrum in PRESS.AXIS), '모든 spectrum이 AXIS 라벨 안');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
