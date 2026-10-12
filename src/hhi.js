// HHI 계산 + weight 검증 리포트 (Phase 4b) — 순수 함수부
// 원칙: 시스템은 집중도라는 사실을 계산·비교까지만. weight 수정은 사람 (graph-seed 편집).

/** shares: [{partner, v}] → HHI (0~1). 점유율 제곱합 */
function hhi(shares) {
  const total = shares.reduce((a, s) => a + s.v, 0);
  if (!total) return null;
  return shares.reduce((a, s) => a + (s.v / total) ** 2, 0);
}

function topShare(shares) {
  const total = shares.reduce((a, s) => a + s.v, 0);
  if (!total || !shares.length) return null;
  const top = shares.reduce((a, s) => (s.v > a.v ? s : a));
  return { partner: top.partner, share: top.v / total };
}

/**
 * weight 검증 판정.
 * 해석 규칙: transit/supply 간선의 weight는 "이 경로가 막혔을 때 흐름이 받는 타격"의 근사
 * → 상위 공급자 점유율(또는 병목 경유 비중)이 1차 앵커.
 * verdict: ok(|Δ|<0.15) / review(0.15~0.3) / mismatch(>0.3)
 */
function judge(currentWeight, shares) {
  const h = hhi(shares), t = topShare(shares);
  if (h == null) return { verdict: 'no_data' };
  const anchor = t.share;
  const delta = Math.abs(currentWeight - anchor);
  const verdict = delta < 0.15 ? 'ok' : delta < 0.3 ? 'review' : 'mismatch';
  return {
    verdict, hhi: Math.round(h * 1000) / 1000,
    top_partner: t.partner, top_share: Math.round(t.share * 1000) / 1000,
    current_weight: currentWeight, delta: Math.round(delta * 100) / 100,
  };
}

module.exports = { hhi, topShare, judge };
