// ECOS 통계표/항목코드 탐색기 — 코드가 틀렸을 때 올바른 코드를 API로 직접 찾는다.
//
// 사용법:
//   node scripts/find-ecos-code.js 국제수지          # 키워드로 통계표 검색
//   node scripts/find-ecos-code.js --items 301Y017   # 해당 표의 항목코드 목록 (+주기)
//   node scripts/find-ecos-code.js --items 301Y017 경상   # 항목명 필터
//
// 찾은 {통계표코드, 항목코드, 주기}를 src/collectors/ecos.js 의 SERIES에 반영.

const { ECOS_API_KEY } = require('../src/config');

async function ecos(service, ...parts) {
  const url = ['https://ecos.bok.or.kr/api', service, ECOS_API_KEY(), 'json', 'kr', '1', '500', ...parts].join('/');
  const json = await (await fetch(url)).json();
  if (json.RESULT) throw new Error(`${json.RESULT.CODE}: ${json.RESULT.MESSAGE}`);
  return json[service]?.row || [];
}

(async () => {
  const [, , a, b, c] = process.argv;
  if (!a) { console.log('키워드 또는 --items <통계표코드> 를 넘겨라'); process.exit(1); }

  if (a === '--items') {
    const rows = await ecos('StatisticItemList', b);
    const filter = c ? (r) => (r.ITEM_NAME || '').includes(c) : () => true;
    for (const r of rows.filter(filter)) {
      console.log(`${b}  item=${r.ITEM_CODE}  cycle=${r.CYCLE}  [${r.ITEM_NAME}]  (${r.START_TIME}~${r.END_TIME})`);
    }
    if (!rows.length) console.log('항목 없음 — 통계표코드 확인');
  } else {
    const rows = await ecos('StatisticTableList');
    const hits = rows.filter((r) => (r.STAT_NAME || '').includes(a) && r.SRCH_YN === 'Y');
    for (const r of hits) console.log(`${r.STAT_CODE}  ${r.STAT_NAME}  (cycle: ${r.CYCLE || '-'})`);
    if (!hits.length) console.log('검색 결과 없음 — 다른 키워드로 시도 (예: 국제수지, 경상수지)');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
