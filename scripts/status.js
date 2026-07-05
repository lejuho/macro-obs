// 현재 상태 요약: 가설별 최신값 vs 밴드, open 알림
const { db } = require('../src/db');

const hyps = db.prepare(`
  SELECT h.id, h.statement, h.band_low, h.band_high, h.window_rule, h.status,
         i.name AS ind, i.unit,
         (SELECT value FROM observations o WHERE o.indicator_id = h.indicator_id
          ORDER BY date DESC LIMIT 1) AS latest,
         (SELECT date FROM observations o WHERE o.indicator_id = h.indicator_id
          ORDER BY date DESC LIMIT 1) AS latest_date
  FROM hypotheses h JOIN indicators i ON i.id = h.indicator_id
  WHERE h.status = 'active'`).all();

console.log('=== active hypotheses ===');
for (const h of hyps) {
  const pos = h.latest == null ? 'no data'
    : h.latest > h.band_high ? '⚠️ ABOVE'
    : h.latest < h.band_low ? '⚠️ BELOW' : 'in band';
  console.log(`#${h.id} ${h.ind}: ${h.latest ?? '-'} ${h.unit || ''} (${h.latest_date ?? '-'})  밴드[${h.band_low}~${h.band_high}] ${pos}  (${h.window_rule})`);
}

const alerts = db.prepare(`
  SELECT a.id, a.status, a.observed_value, a.observed_date, a.direction, h.statement
  FROM alerts a JOIN hypotheses h ON h.id = a.hypothesis_id
  WHERE a.status = 'open' ORDER BY a.triggered_at DESC`).all();

console.log(`\n=== open alerts (${alerts.length}) ===`);
for (const a of alerts) {
  console.log(`#${a.id} [${a.direction}] ${a.observed_value} @ ${a.observed_date} — ${a.statement}`);
}
