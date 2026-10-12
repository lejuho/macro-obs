// 산업동향 경기 흐름 합성 테스트
process.env.DB_PATH = '/tmp/macro-cycle.db';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { snapshot } = require('../src/cycle');
let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

function seed(source, code, name, values, unit = '%') {
  const { id } = stmts.upsertIndicator.get({ source, source_code: code, name, freq: 'M', unit, category: 'derived', note: null });
  values.forEach((v, i) => stmts.upsertObs.run(id, `2026-0${3 + i}-01`, v));
}

console.log('1. 데이터 부족');
assert(!snapshot(db).available, '지표 미등록이면 판정 보류');

console.log('2. 완만한 확장 + 재고 부담 확대');
seed('derived', 'KR_EXPORT_YOY', '수출 YoY', [45, 48, 53]);
seed('derived', 'KR_INDPROD_YOY', '전산업생산 YoY', [3.7, 2.45, 2.29]);
seed('derived', 'KR_RETAIL_YOY', '소매판매 YoY', [5, 1.59, 1.73]);
seed('ecos', '901Y026/I33A', '제조업 재고율', [93.3, 97.8, 101.8]);
const c = snapshot(db);
assert(c.available && c.label === '완만한 확장', '성장률 플러스 3종 → 완만한 확장');
assert(c.qualifier === '재고 부담 확대', '재고율 3개월 상승 반영');
assert(c.as_of === '2026-05-01' && c.signals.length === 4, '공통 기준월 + 4축');
assert(c.signals.find((s) => s.key === 'production').display.includes('둔화'), '생산 모멘텀 둔화 표시');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
