// 커밋 파싱 + 채점 로직 (스펙 §3.3, §4.4)
// 전부 순수 함수 — 테스트 대상. DB 접근은 호출부(bot.js, daily.js)에서.

const HORIZON_DAYS = 90;

/**
 * 답장 텍스트 → 예측 구조화.
 * 지원 형식:
 *   "1450~1520" / "1450-1520" / "1450 ~ 1520"  → 밴드
 *   "1500"                                      → 점 예측 (±2% 밴드로 변환)
 *   그 외 자유 서술                               → 구조화 불가, 채점 시 self-grade (manual)
 * "mute" → { mute: true }
 */
function parseCommit(text) {
  const t = text.trim();
  if (/^mute$/i.test(t)) return { mute: true };

  const band = t.match(/^([0-9]+(?:\.[0-9]+)?)\s*[~\-–]\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (band) {
    let lo = Number(band[1]), hi = Number(band[2]);
    if (lo > hi) [lo, hi] = [hi, lo];
    return { statement: t, expected_low: lo, expected_high: hi, structured: true };
  }
  const point = t.match(/^([0-9]+(?:\.[0-9]+)?)$/);
  if (point) {
    const v = Number(point[1]);
    return {
      statement: t,
      expected_low: v * 0.98, expected_high: v * 1.02, // 점 예측 → ±2% 밴드
      structured: true,
    };
  }
  return { statement: t, expected_low: null, expected_high: null, structured: false };
}

function targetDate(from = new Date(), days = HORIZON_DAYS) {
  const d = new Date(from.getTime() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 채점 (스펙 §4.4):
 *   hit     — actual이 [low, high] 안
 *   partial — 밴드 폭의 10%만큼 확장한 밴드 안
 *   miss    — 그 외
 *   void    — actual 없음(관측이 target_date 기준 14일보다 오래됨/결측)
 *   manual  — 자유 서술 예측 (self-grade 필요)
 * obs: { date, value } | null — target_date 이전 최신 관측
 */
function grade(pred, obs, targetDateStr) {
  if (pred.expected_low == null || pred.expected_high == null) {
    return { score: 'manual', actual: obs ? obs.value : null };
  }
  if (!obs) return { score: 'void', actual: null };

  const staleness = (new Date(targetDateStr) - new Date(obs.date)) / 86400_000;
  if (staleness > 14) return { score: 'void', actual: null };

  const { value } = obs;
  const lo = pred.expected_low, hi = pred.expected_high;
  if (value >= lo && value <= hi) return { score: 'hit', actual: value };

  const margin = Math.max((hi - lo) * 0.10, Math.abs(value) * 0.001);
  if (value >= lo - margin && value <= hi + margin) return { score: 'partial', actual: value };
  return { score: 'miss', actual: value };
}

/** 트랙레코드 rows [{indicator_name, score, n}] → 텍스트 요약 */
function formatTrack(rows) {
  if (!rows.length) return '아직 채점된 예측이 없다. (첫 커밋 후 90일)';
  const by = {};
  for (const r of rows) {
    by[r.indicator_name] ??= { hit: 0, partial: 0, miss: 0, void: 0, manual: 0 };
    by[r.indicator_name][r.score] = r.n;
  }
  const lines = ['📊 <b>캘리브레이션 트랙레코드</b>', ''];
  for (const [name, s] of Object.entries(by)) {
    const graded = s.hit + s.partial + s.miss;
    const rate = graded ? Math.round(((s.hit + s.partial * 0.5) / graded) * 100) : 0;
    lines.push(`<b>${name}</b>: ${rate}%  (hit ${s.hit} · partial ${s.partial} · miss ${s.miss}${s.void ? ` · void ${s.void}` : ''}${s.manual ? ` · manual ${s.manual}` : ''})`);
  }
  lines.push('', 'miss는 숨기지 않는다 — 그게 이 표의 존재 이유.');
  return lines.join('\n');
}

module.exports = { parseCommit, targetDate, grade, formatTrack, HORIZON_DAYS };
