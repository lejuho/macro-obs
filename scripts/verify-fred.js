// FRED 시리즈 검증 — 최신 3건 출력. 실행: FRED_API_KEY=xxx node scripts/verify-fred.js
const { SERIES } = require('../src/collectors/fred');
(async () => {
  if (!process.env.FRED_API_KEY) { console.log('FRED_API_KEY 필요 (.env 또는 환경변수)'); process.exit(1); }
  const start = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  for (const s of SERIES) {
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.code}&api_key=${process.env.FRED_API_KEY}&file_type=json&observation_start=${start}`;
      const json = await (await fetch(url)).json();
      if (json.error_message) throw new Error(json.error_message);
      const rows = (json.observations || []).filter((o) => o.value !== '.');
      const sample = rows.slice(-3).map((r) => `${r.date}=${r.value}`).join(', ');
      console.log(`✅ ${s.code.padEnd(14)} [${s.name}]  ${sample || '데이터 없음'}`);
    } catch (e) { console.log(`❌ ${s.code.padEnd(14)} → ${e.message}`); }
  }
})();
