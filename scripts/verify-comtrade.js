// Comtrade 검증 — 원유(2709) 1건으로 스키마/키 확인
// 실행: COMTRADE_API_KEY=xxx node --no-warnings --no-network-family-autoselection scripts/verify-comtrade.js
const { fetchShares } = require('../src/collectors/trade');
(async () => {
  if (!process.env.COMTRADE_API_KEY) { console.log('COMTRADE_API_KEY 필요'); process.exit(1); }
  const year = String(new Date().getFullYear() - 1);
  try {
    const shares = await fetchShares('2709', 'M', year);
    if (!shares.length) throw new Error(`${year}년 데이터 없음 — 전년도로 재시도: period 인자`);
    const total = shares.reduce((a, s) => a + s.value, 0);
    console.log(`✅ 원유 수입 ${year} — 상대국 ${shares.length}곳, 총 $${(total / 1e9).toFixed(1)}B`);
    for (const s of shares.slice(0, 5)) {
      console.log(`   ${s.partner}: ${((s.value / total) * 100).toFixed(1)}%`);
    }
    console.log('\n스키마 정상. 전체 수집: node scripts/hhi-report.js --collect');
  } catch (e) {
    console.log(`❌ ${e.message}\n→ API 개편 시 src/collectors/trade.js의 URL/파서 수정`);
  }
})();
