// 밴드 설정 참고용 통계 (스펙 §0 원칙: 추천이 아니라 사실 제공)
// obs: [{date, value}] 오름차순 무관 — 내부 정렬

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function stats(obs) {
  if (!obs.length) return null;
  const vals = obs.map((o) => o.value).sort((a, b) => a - b);
  const latest = obs.reduce((a, b) => (a.date > b.date ? a : b));
  return {
    n: vals.length,
    min: vals[0], max: vals[vals.length - 1],
    p10: pct(vals, 0.10), p50: pct(vals, 0.50), p90: pct(vals, 0.90),
    latest: latest.value, latest_date: latest.date,
  };
}

const r2 = (v) => (v == null ? '-' : Math.round(v * 100) / 100);

/** 가설 + 1년/3년 관측 → 참고치 텍스트 */
function formatContext(hyp, obs1y, obs3y) {
  const s1 = stats(obs1y), s3 = stats(obs3y);
  const lines = [
    `📐 <b>밴드 참고치: ${hyp.indicator_name}</b>`,
    `현재 가설 밴드: [${hyp.band_low} ~ ${hyp.band_high}]`,
    '',
  ];
  if (s1) lines.push(`<b>최근 1년</b> (n=${s1.n}): ${r2(s1.min)}~${r2(s1.max)} · p10/p50/p90 = ${r2(s1.p10)}/${r2(s1.p50)}/${r2(s1.p90)}`);
  if (s3) lines.push(`<b>최근 3년</b> (n=${s3.n}): ${r2(s3.min)}~${r2(s3.max)} · p10/p50/p90 = ${r2(s3.p10)}/${r2(s3.p50)}/${r2(s3.p90)}`);
  if (s1) lines.push('', `최신: ${r2(s1.latest)} (${s1.latest_date})`);
  lines.push('', '⚠️ 이건 최근 분포의 기술이지 추천이 아니다. 밴드는 구조적 주장이어야 한다 — 분포를 그대로 베끼면 가설이 아니라 변동성 알림이 된다.');
  return lines.join('\n');
}

module.exports = { stats, formatContext };
