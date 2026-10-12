// 해도 노드 → 실제 관측 지표 판정 규칙.
// negative_direction: 해당 노드 impact가 음수(악화)일 때 지표 숫자가 움직일 방향.
// threshold: 방향 판정에 필요한 최소 변화폭. pct_change는 %, delta는 지표 단위.
module.exports = [
  { node: '원화가치', source: 'ecos', source_code: '731Y001/0000001', metric: 'pct_change', negative_direction: 'up', threshold: 1.0, lag_days: 0 },
  { node: '미국장기금리', source: 'fred', source_code: 'DGS10', metric: 'delta', negative_direction: 'up', threshold: 0.15, lag_days: 0 },
  { node: '달러유동성', source: 'fred', source_code: 'DTWEXBGS', metric: 'pct_change', negative_direction: 'up', threshold: 1.0, lag_days: 0 },
  { node: '엔화유동성', source: 'fred', source_code: 'DEXJPUS', metric: 'pct_change', negative_direction: 'down', threshold: 1.0, lag_days: 0 },
  { node: '위안화가치', source: 'fred', source_code: 'DEXCHUS', metric: 'pct_change', negative_direction: 'up', threshold: 0.5, lag_days: 0 },
  { node: '원유수입', source: 'fred', source_code: 'DCOILBRENTEU', metric: 'pct_change', negative_direction: 'up', threshold: 5.0, lag_days: 0 },
  { node: '반도체수출', source: 'derived', source_code: 'KR_SEMI_EXPORT_YOY', metric: 'delta', negative_direction: 'down', threshold: 3.0, lag_days: 30 },
  { node: '반도체', source: 'derived', source_code: 'KR_SEMI_EXPORT_YOY', metric: 'delta', negative_direction: 'down', threshold: 3.0, lag_days: 30 },
];
