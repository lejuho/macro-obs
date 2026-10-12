// DART 발췌 다이어트: XML 정리 / 구간 병합 / 상한 / evidence 문자열 보존
process.env.DB_PATH = '/tmp/macro-dart-excerpt.db';
process.env.DART_API_KEY = 'test-key';
const {
  textFromXml, buildExcerpt, sortReports, assertDocumentZip, dartFetch,
  EXCERPT_RADIUS, EXCERPT_MAX,
} = require('../src/collectors/dart');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. 기본 다이어트 설정');
assert(EXCERPT_RADIUS === 900 && EXCERPT_MAX === 30000, '기본 반경 900자 / 상한 30k');

console.log('2. XML 평문화');
const xml = `<DOCUMENT><P>전자공시시스템</P><TABLE><TR><TD>수출 422,618</TD><TD>합계 757,515</TD></TR></TABLE>
<P>동일한 긴 반복 머리말입니다</P><P>동일한 긴 반복 머리말입니다</P><P>- 12 -</P>
<P>외화차입금은 45%입니다 &amp; 변동금리부는 30%입니다</P></DOCUMENT>`;
const text = textFromXml(xml);
assert(!text.includes('전자공시시스템') && !text.includes('- 12 -'), '화면 머리말·쪽번호 제거');
assert(text.match(/동일한 긴 반복 머리말입니다/g).length === 1, '연속 반복 헤더 제거');
assert(text.includes('수출 422,618') && text.includes('합계 757,515'), '표 셀 evidence 문자열 보존');
assert(text.includes('45%입니다 & 변동금리부'), '엔티티 복원');

console.log('3. 키워드 발췌');
const excerpt = buildExcerpt(text, { radius: 40, max: 150 });
assert(excerpt.includes('수출 422,618') && excerpt.includes('외화차입금'), '노출 키워드 구간 포함');
assert(excerpt.length <= 150, '문자 상한 강제');
const overlapping = buildExcerpt('앞'.repeat(20) + '수출과 외화 및 차입금 비중 45%' + '뒤'.repeat(20), { radius: 30, max: 500 });
assert(!overlapping.includes('[...]'), '겹치는 키워드 구간 병합');

console.log('4. DART 보고서 후보 / 원문 응답 검증');
const reports = sortReports([
  { rcept_dt: '20260515', rcept_no: 'quarter', report_nm: '분기보고서 (2026.03)' },
  { rcept_dt: '20260324', rcept_no: 'old-correction', report_nm: '[기재정정]사업보고서 (2024.12)' },
  { rcept_dt: '20260313', rcept_no: 'original', report_nm: '사업보고서 (2025.12)' },
  { rcept_dt: '20260619', rcept_no: 'correction', report_nm: '[기재정정]사업보고서 (2025.12)' },
]);
assert(reports.map((r) => r.rcept_no).join(',') === 'correction,quarter,old-correction,original',
  '가장 최근 접수일 우선으로 이전 공시 폴백 순서 생성');
assert(reports[0].reprt_code === '11011' && reports[1].reprt_code === '11013', '보고서 코드 계산');

let dartError;
try {
  assertDocumentZip(Buffer.from('<?xml version="1.0"?><result><status>014</status><message>파일이 존재하지 않습니다.</message></result>'), 'application/xml');
} catch (e) { dartError = e; }
assert(dartError?.code === 'DART_DOCUMENT_UNAVAILABLE' && dartError?.dartStatus === '014',
  'HTTP 200 XML의 DART 014를 원문 없음으로 분류');
let zipAccepted = true;
try { assertDocumentZip(Buffer.from([0x50, 0x4b, 0x03, 0x04])); } catch { zipAccepted = false; }
assert(zipAccepted, 'ZIP 매직바이트 응답 통과');

async function testFetchRetry() {
  let calls = 0;
  const response = { ok: true, status: 200 };
  const got = await dartFetch('list.json', {
    fetchImpl: async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'socket reset' } });
      return response;
    },
    sleepFn: async () => {},
  });
  assert(got === response && calls === 3, '네트워크 실패 2회 후 3회차 자동 복구');
}

testFetchRetry().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
