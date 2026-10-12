// 등록된 산업동향 지표를 한 줄 경기 흐름으로 합성한다.
// 예측 모델이 아니라 방향판: 성장률 3종의 수준 + 제조업 재고율의 최근 3개월 변화를 사용한다.

const SPECS = [
  { key: 'external', label: '외수', source: 'derived', code: 'KR_EXPORT_YOY', kind: 'growth' },
  { key: 'production', label: '생산', source: 'derived', code: 'KR_INDPROD_YOY', kind: 'growth' },
  { key: 'domestic', label: '내수', source: 'derived', code: 'KR_RETAIL_YOY', kind: 'growth' },
  { key: 'inventory', label: '재고부담', source: 'ecos', code: '901Y026/I33A', kind: 'inventory' },
];

const round = (v) => Math.round(v * 100) / 100;

function load(db, spec) {
  const indicator = db.prepare(`
    SELECT id, name, unit FROM indicators WHERE source = ? AND source_code = ?`).get(spec.source, spec.code);
  if (!indicator) return null;
  const obs = db.prepare(`
    SELECT date, value FROM observations WHERE indicator_id = ? ORDER BY date DESC LIMIT 3`).all(indicator.id);
  return obs.length ? { ...spec, ...indicator, obs } : null;
}

function growthSignal(s) {
  const latest = s.obs[0], base = s.obs[2] || s.obs[1];
  const score = latest.value >= 1 ? 1 : latest.value <= -1 ? -1 : 0;
  const delta = base ? round(latest.value - base.value) : null;
  const momentum = delta == null ? 'na' : delta > 0.5 ? 'improving' : delta < -0.5 ? 'slowing' : 'steady';
  const arrow = score > 0 ? '↗' : score < 0 ? '↘' : '→';
  const suffix = momentum === 'improving' ? ' 개선' : momentum === 'slowing' ? ' 둔화' : '';
  return {
    key: s.key, label: s.label, date: latest.date, value: latest.value, unit: s.unit,
    score, momentum, delta, display: arrow + suffix,
    detail: `YoY ${latest.value >= 0 ? '+' : ''}${round(latest.value)}%` +
      (delta == null ? '' : ` · 최근 ${s.obs.length >= 3 ? '3개월' : '2개월'} ${delta >= 0 ? '+' : ''}${delta}%p`),
  };
}

function inventorySignal(s) {
  const latest = s.obs[0], base = s.obs[2] || s.obs[1];
  const delta = base ? round(latest.value - base.value) : null;
  // 재고율 상승은 출하 대비 재고 부담 확대. ±3%p 이하는 월별 잡음으로 본다.
  const score = delta == null ? 0 : delta >= 3 ? -1 : delta <= -3 ? 1 : 0;
  const momentum = score < 0 ? 'burden_up' : score > 0 ? 'burden_down' : 'steady';
  return {
    key: s.key, label: s.label, date: latest.date, value: latest.value, unit: s.unit,
    score, momentum, delta,
    display: score < 0 ? '↗ 확대' : score > 0 ? '↘ 완화' : '→',
    detail: `${round(latest.value)}%` +
      (delta == null ? '' : ` · 최근 ${s.obs.length >= 3 ? '3개월' : '2개월'} ${delta >= 0 ? '+' : ''}${delta}%p`),
  };
}

function snapshot(db) {
  const signals = SPECS.map((s) => load(db, s)).filter(Boolean)
    .map((s) => s.kind === 'inventory' ? inventorySignal(s) : growthSignal(s));
  if (signals.length < 3) return { available: false, reason: '산업동향 지표가 3개 이상 필요', signals };

  const score = signals.reduce((sum, s) => sum + s.score, 0) / signals.length;
  const label = score >= 0.75 ? '확장' : score >= 0.25 ? '완만한 확장' :
    score > -0.25 ? '혼조' : score > -0.75 ? '완만한 둔화' : '둔화';
  const inventory = signals.find((s) => s.key === 'inventory');
  const growth = signals.filter((s) => s.key !== 'inventory');
  const improving = growth.filter((s) => s.momentum === 'improving').length;
  const slowing = growth.filter((s) => s.momentum === 'slowing').length;
  const qualifier = inventory?.momentum === 'burden_up' ? '재고 부담 확대' :
    inventory?.momentum === 'burden_down' ? '재고 부담 완화' :
    slowing > improving ? '모멘텀 둔화' : improving > slowing ? '모멘텀 개선' : '모멘텀 보합';
  const asOf = signals.map((s) => s.date).sort()[0]; // 전 지표가 갖춰진 가장 보수적인 기준월
  return { available: true, label, qualifier, as_of: asOf, score: round(score), signals };
}

module.exports = { snapshot, growthSignal, inventorySignal, SPECS };
