// ECOS 통계코드 검증 스크립트 — 파이/로컬(네트워크 되는 곳)에서 최초 1회 실행.
// 각 SERIES에 대해 최근 데이터 3건을 실제로 받아와 출력한다.
// 코드가 틀렸으면 ECOS 에러 메시지가 그대로 보이므로,
// https://ecos.bok.or.kr 통계코드검색에서 올바른 코드를 찾아 src/collectors/ecos.js의 SERIES를 수정.
//
// 실행: ECOS_API_KEY=xxx node scripts/verify-ecos-codes.js

const { SERIES } = require('../src/collectors/ecos');
const { ECOS_API_KEY } = require('../src/config');

function fmt(d, freq) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'),
    day = String(d.getDate()).padStart(2, '0');
  return freq === 'D' ? `${y}${m}${day}` : freq === 'M' ? `${y}${m}` : `${y}`;
}

(async () => {
  const end = new Date();
  const start = new Date(end.getTime() - 400 * 86400_000);
  let allOk = true;

  for (const s of SERIES) {
    const url = ['https://ecos.bok.or.kr/api/StatisticSearch', ECOS_API_KEY(), 'json', 'kr',
      '1', '1000', s.stat, s.freq, fmt(start, s.freq), fmt(end, s.freq), s.item].join('/');
    try {
      const json = await (await fetch(url)).json();
      if (json.RESULT) throw new Error(`${json.RESULT.CODE}: ${json.RESULT.MESSAGE}`);
      const rows = json.StatisticSearch?.row || [];
      const sample = rows.slice(-3) // 최신 3건.map((r) => `${r.TIME}=${r.DATA_VALUE}`).join(', ');
      console.log(`✅ ${s.key.padEnd(16)} ${s.stat}/${s.item}  [${rows[0]?.ITEM_NAME1 || '?'}]  ${sample}`);
    } catch (e) {
      allOk = false;
      console.log(`❌ ${s.key.padEnd(16)} ${s.stat}/${s.item}  → ${e.message}`);
    }
  }
  console.log(allOk
    ? '\n전체 통과. seed-hypotheses.js로 진행하세요.'
    : '\n실패 항목이 있음. ECOS 통계코드검색에서 코드 확인 후 src/collectors/ecos.js 수정.');
})();
