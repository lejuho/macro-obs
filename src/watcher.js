// 밴드 감시기 (스펙 §4.1)
// 판정 규칙 window_rule = 'close_N': 최신 N개 관측이 전부 같은 방향으로 밴드 이탈 시 확정.
// 확정 시 alert 생성. 동일 가설 재알림은 ALERT_COOLDOWN_DAYS 쿨다운.

const { stmts } = require('./db');
const { ALERT_COOLDOWN_DAYS } = require('./config');

function parseWindowRule(rule) {
  const m = /^close_(\d+)$/.exec(rule || 'close_3');
  return m ? Number(m[1]) : 3;
}

/** 순수 판정 함수 (테스트 대상). obs: 최신순 [{date, value}] */
function judge(hyp, obs) {
  const n = parseWindowRule(hyp.window_rule);
  if (obs.length < n) return null; // 데이터 부족 시 판정 보류
  const window = obs.slice(0, n);

  const allAbove = hyp.band_high != null && window.every((o) => o.value > hyp.band_high);
  const allBelow = hyp.band_low != null && window.every((o) => o.value < hyp.band_low);
  if (!allAbove && !allBelow) return null;

  return {
    direction: allAbove ? 'above' : 'below',
    observed_value: window[0].value,
    observed_date: window[0].date,
  };
}

function inCooldown(hypId, now = new Date()) {
  const last = stmts.lastAlertFor.get(hypId);
  if (!last) return false;
  const elapsed = now - new Date(last.triggered_at + 'Z');
  return elapsed < ALERT_COOLDOWN_DAYS * 86400_000;
}

/** 전체 active 가설 스캔 → 신규 alert 목록 반환 */
function scan() {
  const created = [];
  for (const hyp of stmts.activeHypotheses.all()) {
    const obs = stmts.lastNObs.all(hyp.indicator_id, parseWindowRule(hyp.window_rule));
    const breach = judge(hyp, obs);
    if (!breach) continue;
    if (stmts.pendingPredictionForDirection.get(hyp.id, breach.direction)) continue;
    if (inCooldown(hyp.id)) continue;
    const { id } = stmts.insertAlert.get({ hypothesis_id: hyp.id, ...breach });
    created.push({ alert_id: id, hyp, breach });
  }
  return created;
}

module.exports = { scan, judge, parseWindowRule };
