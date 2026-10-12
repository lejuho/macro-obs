// 뉴노멀 가설 4건 초기 등록.
// ⚠️ band 값은 자리표시자 — 등록 전에 본인 판단으로 확정할 것. rationale이 알림에 그대로 뜬다.
// 실행: node scripts/seed-hypotheses.js   (이미 같은 statement가 있으면 건너뜀)

const { db, stmts } = require('../src/db');

// indicator는 수집기가 만들었어야 함 → 먼저 daily.js 또는 collect 1회 실행 필요.
function indicatorId(sourceCode, source = 'ecos') {
  const row = db.prepare(`SELECT id FROM indicators WHERE source=? AND source_code=?`).get(source, sourceCode);
  if (!row) throw new Error(`indicator not found: ${source}/${sourceCode} — 수집기를 먼저 1회 실행하세요`);
  return row.id;
}

// 글로벌 지표 가설 (--global 플래그로 등록. FRED 수집 1회 선행 필요)
// ⚠️ 밴드는 자리표시자 — 관찰 전용으로 둘 지표(달러지수, USD/JPY 등)는 여기 넣지 않았다.
//    가설 = 뉴노멀 주장이 있는 것만. 알림은 커밋을 요구하므로 밴드 남발 = 커밋 피로.
const SEEDS_GLOBAL = [
  {
    statement: '미국 10년물 고금리 뉴노멀: 3.8~5.0% 밴드',
    source: 'fred', source_code: 'DGS10',
    band_low: 3.8, band_high: 5.0, window_rule: 'close_3',
    rationale: '재정적자 구조화 + 기간프리미엄 복원으로 저금리 회귀 없음이 가설. 3.8 하회는 침체 프라이싱, 5.0 상회는 국채시장 발작 국면(/scn node 미국장기금리로 세계 확인).',
  },
  {
    statement: 'VIX 평시 레짐: 12~28 밴드',
    source: 'fred', source_code: 'VIXCLS',
    band_low: 12, band_high: 28, window_rule: 'close_2',
    rationale: '12 하회는 과열 안일(숏볼 축적), 28 상회는 위험회피 급증. 단독 해석 금지 — HY 스프레드와 교차 확인.',
  },
  {
    statement: 'HY 스프레드 신용 사이클: 2.8~5.0%p 밴드',
    source: 'fred', source_code: 'BAMLH0A0HYM2',
    band_low: 2.8, band_high: 5.0, window_rule: 'close_3',
    rationale: '2.8 하회는 신용 과열, 5.0 상회는 침체 프라이싱 개시. VIX보다 거시적 — 이탈 시 우선 신뢰.',
  },
];

const SEEDS = [
  {
    statement: '환율 뉴노멀: 원/달러 1350~1480 밴드 (구질서 ~1165 종료)',
    source_code: '731Y001/0000001',
    band_low: 1350, band_high: 1480, window_rule: 'close_3',
    rationale: '경상수지 구조 약화 + 한미 금리차 + 해외투자 확대(자본유출 상시화)로 균형환율 레벨시프트. 1350 하향이탈은 뉴노멀 가설 약화 신호, 1480 상향이탈은 위기 국면 전환 신호.',
  },
  {
    statement: '금리 뉴노멀: 기준금리 2.0~3.5% 구간 (제로금리 시대 종료)',
    source_code: '722Y001/0101000',
    band_low: 2.0, band_high: 3.5, window_rule: 'close_1', // 기준금리는 결정 즉시 유의미 → 1회
    rationale: '구조적 인플레(공급망 재편, 인구) 하에서 실질 중립금리 상승. 2.0 하회는 침체 대응 국면, 3.5 상회는 인플레 재점화 국면.',
  },
  {
    statement: '경상수지 뉴노멀: 월 60~110억$ 흑자 페이스 (연 1000억$ 시대의 지속 여부)',
    source_code: '301Y013/000000',
    band_low: 6000, band_high: 11000, window_rule: 'close_2', // 월별, 단위: 백만달러
    rationale: '반도체 사이클 + 서비스수지 적자 + 소득수지 흑자 확대의 합성. 하단 이탈은 무역구조 악화, 상단 이탈은 반도체 슈퍼사이클 신호.',
  },
  {
    statement: '시장금리 프록시: 국고채 3년 2.3~3.8% 밴드',
    source_code: '817Y002/010200000',
    band_low: 2.3, band_high: 3.8, window_rule: 'close_3',
    rationale: '잠재성장률 0.8% 가설의 시장 반영 프록시. 지속적 하단 이탈은 저성장 고착 프라이싱, 상단 이탈은 재정 리스크 프리미엄.',
  },
];

const seeds = process.argv.includes('--global') ? SEEDS_GLOBAL : SEEDS;
let added = 0;
for (const s of seeds) {
  const exists = db.prepare(`SELECT 1 FROM hypotheses WHERE statement = ?`).get(s.statement);
  if (exists) { console.log(`skip (exists): ${s.statement}`); continue; }
  db.prepare(`
    INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, window_rule, rationale)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(s.statement, indicatorId(s.source_code, s.source || 'ecos'), s.band_low, s.band_high, s.window_rule, s.rationale);
  console.log(`added: ${s.statement}`);
  added++;
}
console.log(`\n${added} hypothesis(es) registered. 확인: node scripts/status.js`);
