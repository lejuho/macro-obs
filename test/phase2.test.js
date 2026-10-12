// Phase 2 테스트: LLM 출력 검증 / 노출 랭킹 / 알림 조인
// 실행: node --no-warnings test/phase2.test.js

process.env.DB_PATH = '/tmp/macro-p2.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { db, stmts } = require('../src/db');
const { validate, parseJsonObject, buildInput } = require('../src/extract/claude');
const { exposureSection } = require('../src/exposure');
const { formatBreach } = require('../src/notify/telegram');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. validate — LLM 출력 검증');
const excerpt = '당사의 수출 비중은 매출의 78%이며 외화차입금은 총차입금의 45%입니다. 변동금리부 차입 비중은 30% 수준.';
let v = validate(JSON.stringify({
  export_ratio: 0.78, usd_revenue_ratio: null, fx_debt_ratio: 0.45, float_rate_ratio: 0.30,
  import_deps: ['웨이퍼'], evidence: { export_ratio: '수출 비중은 매출의 78%' },
}), excerpt);
assert(v.ok, 'valid output passes');
assert(v.warnings.includes('fx_debt_ratio'), 'missing evidence → warning not rejection');

v = validate('```json\n{"export_ratio": 0.5, "evidence": {}}\n```', excerpt);
assert(v.ok, 'markdown fence stripped');

v = validate('분석 결과입니다.\n```json\n{"export_ratio": 0.5, "evidence": {}}\n```\n이상입니다.', excerpt);
assert(v.ok, '설명문 사이의 JSON 객체만 추출');
assert(parseJsonObject('설명 {not json} 후 {"export_ratio":null}').export_ratio === null,
  '잘못된 중괄호를 건너뛰고 유효한 JSON 탐색');
const agentInput = buildInput('테스트', '수출 비중 10%', { agent: true, rceptNo: '20260000000001' });
assert(agentInput.indexOf('에이전트 도구 지침') < agentInput.indexOf('--- 보고서 발췌 시작 ---'),
  '도구 지침을 보고서 발췌 밖으로 분리');

v = validate(JSON.stringify({ export_ratio: 78 }), excerpt); // % 변환 안 한 위반
assert(!v.ok && v.reason.includes('범위'), 'ratio > 1 rejected');

v = validate(JSON.stringify({
  export_ratio: 0.5, evidence: { export_ratio: '보고서에 없는 지어낸 인용구절임' },
}), excerpt);
assert(!v.ok && v.reason.includes('불일치'), 'fabricated evidence quote rejected');

v = validate(JSON.stringify({
  export_ratio: 0.78, evidence: { export_ratio: '78%-30%' },
}), excerpt);
assert(v.ok, '숫자 산식 evidence: 각 피연산자 원문 실존 시 허용');
v = validate(JSON.stringify({
  export_ratio: 0.78, evidence: { export_ratio: '78%+99%' },
}), excerpt);
assert(!v.ok, '숫자 산식 evidence: 피연산자 하나라도 없으면 반려');

v = validate('죄송합니다, JSON을 만들 수 없습니다', excerpt);
assert(!v.ok, 'non-JSON rejected');

console.log('2. 노출 랭킹 (최신 보고서 선택 포함)');
const corps = [
  ['C1', '005930', '삼성전자'], ['C2', '000660', 'SK하이닉스'],
  ['C3', '015760', '한국전력'], ['C4', '105560', 'KB금융'],
];
for (const [cc, sc, nm] of corps) stmts.upsertCorp.run({ corp_code: cc, stock_code: sc, name: nm });
const exp = (cc, fy, rc, e, fx, fl) => stmts.upsertExposure.run({
  corp_code: cc, fy, reprt_code: rc, rcept_no: 'r',
  export_ratio: e, usd_revenue_ratio: null, fx_debt_ratio: fx, float_rate_ratio: fl,
  import_deps: '[]', evidence: '{}', raw_json: '{}',
});
exp('C1', 2024, '11011', 0.60, 0.30, 0.10); // 삼성 구보고서
exp('C1', 2025, '11011', 0.75, 0.35, 0.10); // 삼성 최신 — 이게 잡혀야 함
exp('C2', 2025, '11012', 0.85, 0.50, 0.20);
exp('C3', 2025, '11011', 0.02, 0.40, 0.70); // 한전: 수출 없음, 변동금리 큼
exp('C4', 2025, '11011', null, null, null); // 금융사: 전부 미공시

// 환율 가중치: 수출 1.0 + 외화부채 0.8
let rows = stmts.topExposed.all({ w_export: 1.0, w_fxdebt: 0.8, w_float: 0, limit: 5 });
assert(rows[0].name === 'SK하이닉스', 'fx ranking top = highest export+fxdebt');
const samsung = rows.find((r) => r.name === '삼성전자');
assert(samsung && samsung.export_ratio === 0.75, 'latest report chosen over old (0.75 not 0.60)');
assert(!rows.find((r) => r.name === 'KB금융'), 'all-null firm excluded (score 0)');

// 금리 가중치: 변동금리 1.0
rows = stmts.topExposed.all({ w_export: 0, w_fxdebt: 0.2, w_float: 1.0, limit: 5 });
assert(rows[0].name === '한국전력', 'rate ranking top = highest float-rate debt');

console.log('3. 알림 조인');
const sec = exposureSection('731Y001/0000001', 3);
assert(sec && sec.includes('SK하이닉스') && sec.includes('수출 85%'), 'usdkrw alert gets export exposure');
assert(sec.includes('방향(수혜/피해) 판단은 네 몫'), 'judgment disclaimer present');
assert(exposureSection('901Y009/0') === null, 'unmapped indicator (cpi) → null, alert unchanged');

const msg = formatBreach({
  hyp: { indicator_name: 'T', statement: 's', rationale: 'r', band_low: 1, band_high: 2, unit: '', window_rule: 'close_3' },
  breach: { direction: 'above', observed_value: 3, observed_date: 'd' },
  extra: sec,
});
assert(msg.includes('구조적 노출 상위') && msg.indexOf('노출') < msg.indexOf('90일 뒤'), 'extra section before commit prompt');
const msgNoExtra = formatBreach({
  hyp: { indicator_name: 'T', statement: 's', rationale: 'r', band_low: 1, band_high: 2, unit: '', window_rule: 'close_3' },
  breach: { direction: 'above', observed_value: 3, observed_date: 'd' },
});
assert(!msgNoExtra.includes('구조적'), 'no extra → alert format unchanged (Phase 0/1 compat)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
