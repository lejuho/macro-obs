// 파생 지표 (Phase 4) — 원시 시계열에서 계산되는 2차 지표
// 전부 순수 함수 + 얇은 파이프라인. 원본(base)이 아직 수집 안 됐으면 조용히 스킵.
//
// op 종류:
//   yoy      : 전년동월비 % (월별 시리즈)
//   mom_diff : 전월차 (누적(YTD) 시리즈 → 월간 플로우 복원. 매년 1월은 값 그대로)
//   spread   : base - other (같은 날짜 매칭, 일별 금리차 등)
//   rvol     : N일 실현변동성 (mode 'diff'=일변화 stdev, 금리→bp / 'pct'=일수익률 stdev, 환율→%)
//              연율화 ×√252. Tier 3 프록시: MOVE↔미국채 rvol, 한국CDS↔원화 rvol

const { stmts, tx } = require('./db');

const DERIVED = [
  {
    code: 'KR_EXPORT_YOY', name: '수출 YoY', freq: 'M', unit: '%',
    note: '한국 경기 핵심 노브: 수출 증가율이 코스피·원화의 선행 축.',
    op: 'yoy', base: { source: 'ecos', code: '901Y118/T002' },
  },
  {
    code: 'KR_SEMI_EXPORT_YOY', name: '반도체 수출금액지수 YoY', freq: 'M', unit: '%',
    note: '코스피 핵심 노브: AI CAPEX 사이클의 한국측 실측치(수출금액지수 기준). 피크아웃 시나리오의 조기신호.',
    op: 'yoy', base: { source: 'ecos', code: '403Y001/30911AA' },
  },
  {
    code: 'KR_US_10Y_SPREAD', name: '한미 10년 금리차', freq: 'D', unit: '%p',
    note: '외국인 채권자금 노브: 역전 폭 확대는 원화·자금이탈 압력.',
    op: 'spread', base: { source: 'ecos', code: '817Y002/010210000' }, other: { source: 'fred', code: 'DGS10' },
  },
  {
    code: 'MOVE_PROXY', name: '미국채 변동성(MOVE 프록시)', freq: 'D', unit: 'bp',
    note: '채권시장 스트레스 노브: MOVE는 ICE 사유지수라 미국 10년물 20일 실현변동성(연율화 bp)으로 대용. 급등은 국채시장 발작 시나리오의 조기신호.',
    op: 'rvol', base: { source: 'fred', code: 'DGS10' }, mode: 'diff', window: 20,
  },
  {
    code: 'KRW_STRESS', name: '원화 변동성(CDS 프록시)', freq: 'D', unit: '%',
    note: '원화 스트레스 노브: 한국 CDS는 무료 소스가 없어 원/달러 20일 실현변동성(연율화 %)으로 대용. 레벨(환율)과 별개로 속도를 본다.',
    op: 'rvol', base: { source: 'ecos', code: '731Y001/0000001' }, mode: 'pct', window: 20,
  },
  {
    code: 'KR_RETAIL_YOY', name: '소매판매 YoY', freq: 'M', unit: '%',
    note: '내수 소비 노브: 지수 레벨보다 증가율이 판단 대상. 수출 YoY와 함께 내수/외수 균형을 본다.',
    op: 'yoy', base: { source: 'ecos', code: '901Y100/G0' },
  },
  {
    code: 'KR_INDPROD_YOY', name: '전산업생산 YoY', freq: 'M', unit: '%',
    note: '실물경기 동행 노브: 수출(선행 축)이 꺾인 뒤 생산으로 전이되는지 확인하는 용도. 재고율과 함께 재고순환 국면 판단.',
    op: 'yoy', base: { source: 'ecos', code: '901Y033/A00' },
  },
  {
    code: 'KR_CA_MONTHLY', name: '경상수지(월간 플로우)', freq: 'M', unit: '백만달러',
    note: '누적(YTD) 공시 시 전월차로 월간 흑자 복원. 원시 시리즈가 이미 월별이면 이 파생은 등록하지 말 것.',
    op: 'mom_diff', base: { source: 'ecos', code: '301Y013/000000' },
    disabled: true, // ← 원시 시리즈가 누적인 것으로 확인되면 false로
  },
];

// ── 순수 계산 함수들 (테스트 대상). obs: [{date, value}] 오름차순 가정 ──

function yoy(obs) {
  const byMonth = new Map(obs.map((o) => [o.date.slice(0, 7), o.value]));
  const out = [];
  for (const o of obs) {
    const [y, m] = o.date.slice(0, 7).split('-');
    const prev = byMonth.get(`${Number(y) - 1}-${m}`);
    if (prev != null && prev !== 0) {
      out.push({ date: o.date, value: Math.round(((o.value / prev) - 1) * 10000) / 100 });
    }
  }
  return out;
}

function momDiff(obs) {
  const out = [];
  for (let i = 0; i < obs.length; i++) {
    const cur = obs[i], prev = obs[i - 1];
    const isJan = cur.date.slice(5, 7) === '01';
    if (isJan || !prev) { out.push({ date: cur.date, value: cur.value }); continue; }
    // 같은 해 연속 월일 때만 차분 (연도 바뀌면 1월 케이스로 이미 처리)
    if (prev.date.slice(0, 4) === cur.date.slice(0, 4)) {
      out.push({ date: cur.date, value: Math.round((cur.value - prev.value) * 100) / 100 });
    }
  }
  return out;
}

function spread(baseObs, otherObs) {
  const other = new Map(otherObs.map((o) => [o.date, o.value]));
  return baseObs
    .filter((o) => other.has(o.date))
    .map((o) => ({ date: o.date, value: Math.round((o.value - other.get(o.date)) * 1000) / 1000 }));
}

function rvol(obs, { mode = 'pct', window = 20 } = {}) {
  const out = [];
  const chg = [];
  for (let i = 1; i < obs.length; i++) {
    chg.push({
      date: obs[i].date,
      v: mode === 'pct' ? (obs[i].value / obs[i - 1].value - 1) : (obs[i].value - obs[i - 1].value),
    });
  }
  for (let i = window - 1; i < chg.length; i++) {
    const w = chg.slice(i - window + 1, i + 1).map((c) => c.v);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1));
    // 연율화 ×√252, pct→%, diff(금리 %포인트)→bp: 둘 다 ×100
    out.push({ date: chg[i].date, value: Math.round(sd * Math.sqrt(252) * 100 * 100) / 100 });
  }
  return out;
}

// ── 파이프라인 ──

function findIndicator(ref) {
  const { db } = require('./db');
  return db.prepare(`SELECT id FROM indicators WHERE source = ? AND source_code = ?`)
    .get(ref.source, ref.code);
}

function loadObs(indicatorId) {
  const { db } = require('./db');
  return db.prepare(`SELECT date, value FROM observations WHERE indicator_id = ? ORDER BY date`)
    .all(indicatorId);
}

/** daily 배치에서 수집 직후 호출. 결과: [{key, count|skip, ok}] */
function computeAll() {
  const results = [];
  for (const d of DERIVED) {
    if (d.disabled) { results.push({ key: d.code, ok: true, skip: 'disabled' }); continue; }
    const base = findIndicator(d.base);
    if (!base) { results.push({ key: d.code, ok: true, skip: `base 미수집 (${d.base.code})` }); continue; }

    let series;
    if (d.op === 'yoy') series = yoy(loadObs(base.id));
    else if (d.op === 'rvol') series = rvol(loadObs(base.id), { mode: d.mode, window: d.window });
    else if (d.op === 'mom_diff') series = momDiff(loadObs(base.id));
    else if (d.op === 'spread') {
      const other = findIndicator(d.other);
      if (!other) { results.push({ key: d.code, ok: true, skip: `other 미수집 (${d.other.code})` }); continue; }
      series = spread(loadObs(base.id), loadObs(other.id));
    } else { results.push({ key: d.code, ok: false, error: `unknown op ${d.op}` }); continue; }

    const { id } = stmts.upsertIndicator.get({
      source: 'derived', source_code: d.code, name: d.name,
      freq: d.freq, unit: d.unit, category: 'derived', note: d.note,
    });
    tx(() => { for (const o of series) stmts.upsertObs.run(id, o.date, o.value); });
    results.push({ key: d.code, indicator_id: id, count: series.length, ok: true });
  }
  return results;
}

module.exports = { computeAll, yoy, momDiff, spread, rvol, DERIVED };
