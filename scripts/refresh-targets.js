// 시총 상위 N개 종목으로 data/targets.csv 재생성 (공공데이터포털 금융위 주식시세정보 API)
// 실행: node --no-warnings --no-network-family-autoselection scripts/refresh-targets.js [N]
//
// 설계 의도: 리스트 "생성"만 자동화하고, 갱신 시점은 사람이 판단한다 (반기 1회 권장).
// 유니버스 변경은 의도적·기록된 행위여야 하므로 cron에 넣지 않는다.
// 기존 파일은 targets.csv.bak-<ts>로 백업. 갱신 후 quarterly.js --sync로 재마킹할 것.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'src', 'config')); // .env 로드
const KEY = process.env.DATA_GO_KR_KEY;
if (!KEY) { console.error('missing env: DATA_GO_KR_KEY (.env 확인)'); process.exit(1); }

const N = Number(process.argv[2] || 200);
const BASE = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

async function fetchDay(basDt, pageNo = 1) {
  const url = `${BASE}?serviceKey=${KEY}&resultType=json&numOfRows=5000&pageNo=${pageNo}&basDt=${basDt}`;
  // 게이트웨이가 기본 UA(curl/node)를 403으로 막아서 브라우저 UA 필요
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`data.go.kr HTTP ${res.status}`);
  const json = await res.json();
  const body = json?.response?.body;
  if (!body) throw new Error(`응답 형식 이상: ${JSON.stringify(json).slice(0, 200)}`);
  return { total: Number(body.totalCount), items: body.items?.item || [] };
}

// 우선주(…우, …우B/C), 스팩 제외 — 기업 단위 노출 매트릭스이므로 보통주만
function isCommonStock(nm) {
  return !/(우|우B|우C)$/.test(nm) && !nm.includes('스팩');
}

(async () => {
  // 최근 영업일 탐색: 오늘부터 최대 10일 역행
  let basDt = null, rows = [];
  for (let d = 0; d < 10; d++) {
    const day = new Date(Date.now() - d * 86400_000);
    const ymd = day.toISOString().slice(0, 10).replace(/-/g, '');
    const { total, items } = await fetchDay(ymd);
    if (total > 0) {
      basDt = ymd; rows = items;
      for (let p = 2; rows.length < total; p++) rows.push(...(await fetchDay(ymd, p)).items);
      break;
    }
  }
  if (!basDt) throw new Error('최근 10일 내 시세 데이터 없음');

  const top = rows
    .filter((r) => (r.mrktCtg === 'KOSPI' || r.mrktCtg === 'KOSDAQ') && isCommonStock(r.itmsNm))
    .sort((a, b) => Number(b.mrktTotAmt) - Number(a.mrktTotAmt))
    .slice(0, N);

  const csvPath = path.join(ROOT, 'data', 'targets.csv');
  if (fs.existsSync(csvPath)) {
    const bak = `${csvPath}.bak-${new Date().toISOString().slice(0, 10)}`;
    fs.copyFileSync(csvPath, bak);
    console.log(`백업: ${bak}`);
  }

  const lines = [
    `# 추출 대상 종목코드 (한 줄에 하나, # 뒤는 주석)`,
    `# 시총 상위 ${N} — 기준일 ${basDt}, 생성 ${new Date().toISOString().slice(0, 16)}Z`,
    `# 소스: 공공데이터포털 금융위 주식시세정보 (우선주·스팩 제외)`,
    `# 갱신: node scripts/refresh-targets.js && node src/jobs/quarterly.js --sync`,
    ...top.map((r) => {
      const jo = (Number(r.mrktTotAmt) / 1e12).toFixed(1);
      return `${r.srtnCd}  # ${r.itmsNm} (${r.mrktCtg}, ${jo}조)`;
    }),
  ];
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
  console.log(`${csvPath} — ${top.length}종목 (기준일 ${basDt})`);
  console.log(`상위 5: ${top.slice(0, 5).map((r) => r.itmsNm).join(', ')}`);
  console.log(`다음 단계: node src/jobs/quarterly.js --sync`);
})();
