// UN Comtrade 수집기 (Phase 4b) — 한국(410)의 HS별 상대국 수출입액
// API: https://comtradeapi.un.org/data/v1/get/{typeCode}/{freqCode}/{clCode}
//   무료 키: https://comtradeplus.un.org → API 구독(free tier, 일 호출 제한 있음)
// ⚠️ 엔드포인트/파라미터는 개편 가능 — scripts/verify-comtrade.js 로 실기기 검증 후 사용.
//   연간(A) 데이터는 1년 안팎 시차가 있으므로 period는 확정 연도 기준(기본: 재작년~작년).

const { stmts, tx } = require('../db');
const HHI_MAP = require('../../data/hhi-map');

const KEY = () => process.env.COMTRADE_API_KEY;
const KOREA = 410;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchShares(hs, direction, period) {
  const url = `https://comtradeapi.un.org/data/v1/get/C/A/HS` +
    `?reporterCode=${KOREA}&period=${period}&partnerCode=&partner2Code=` +
    `&cmdCode=${hs}&flowCode=${direction}&customsCode=C00&motCode=0` +
    `&subscription-key=${KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Comtrade HTTP ${res.status} (hs=${hs})`);
  const json = await res.json();
  return parseShares(json);
}

/** 순수 파서 (테스트 대상): World(0) 합계 행 제외, 상대국별 금액 */
function parseShares(json) {
  const rows = json?.data || [];
  return rows
    .filter((r) => r.partnerCode !== 0 && r.partnerDesc && r.primaryValue > 0)
    .map((r) => ({ partner: r.partnerDesc, value: r.primaryValue }));
}

/** HHI_MAP 전체 수집 → trade_shares 캐시. 연 1~2회면 충분 (연간 데이터) */
async function collect({ period } = {}) {
  if (!KEY()) return [{ ok: false, error: 'COMTRADE_API_KEY 없음 (.env)' }];
  const year = period || String(new Date().getFullYear() - 1);
  const results = [];
  for (const [node, cfg] of Object.entries(HHI_MAP)) {
    for (const hs of cfg.hs) {
      try {
        const shares = await fetchShares(hs, cfg.direction, year);
        tx(() => {
          for (const s of shares) {
            stmts.upsertTradeShare.run({
              node_name: node, hs, partner: s.partner, value_usd: s.value, period: year,
            });
          }
        });
        results.push({ node, hs, count: shares.length, ok: true });
      } catch (e) {
        results.push({ node, hs, ok: false, error: e.message });
      }
      await sleep(1500); // 무료 티어 레이트리밋 예의
    }
  }
  return results;
}

module.exports = { collect, parseShares, fetchShares };
