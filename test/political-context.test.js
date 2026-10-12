// 국가별 정치 구조 버전/선거주기 판정 순수함수 테스트
const {
  AXES, validateProfiles, resolveProfile, classifyElectionCycle,
} = require('../src/political-context');
const { resolveClaudeBin } = require('../src/claude-cli');

let pass = 0, fail = 0;
const assert = (condition, name) => condition
  ? (pass++, console.log(`  ✅ ${name}`))
  : (fail++, console.log(`  ❌ ${name}`));

assert(validateProfiles(), '기본 국가 프로필 검증');
assert(AXES.includes('party_organization') && AXES.includes('external_constraints'), '확장 정치구조 축');

const kr = resolveProfile('KR', '2026-07-20');
assert(kr?.axes.power_structure.regime === 'presidential', '날짜 기준 한국 프로필 조회');
assert(resolveProfile('ZZ', '2026-07-20') === null, '미등록 국가는 null');

const versioned = [{
  code: 'TT', name: '테스트', versions: [
    { valid_from: '2025-01-01', valid_to: '2025-12-31', axes: { government_status: { relation: 'unified' } } },
    { valid_from: '2026-01-01', valid_to: null, axes: { government_status: { relation: 'divided' } } },
  ],
}];
assert(resolveProfile('TT', '2025-06-01', versioned).axes.government_status.relation === 'unified', '과거 버전 보존');
assert(resolveProfile('TT', '2026-06-01', versioned).axes.government_status.relation === 'divided', '새 유효 버전 적용');

assert(classifyElectionCycle(kr, { date: '2026-01-15', body: 'parliament' },
  { start: '2026-01-01', end: '2030-12-31' }) === 'concurrent', '동시선거 판정');
assert(classifyElectionCycle(kr, { date: '2026-06-01', body: 'parliament' },
  { start: '2026-01-01', end: '2030-12-31' }) === 'honeymoon', '밀월선거 판정');
assert(classifyElectionCycle(kr, { date: '2028-11-01', body: 'midterm' },
  { start: '2026-01-01', end: '2030-12-31' }) === 'midterm', '중간선거 명시값 우선');

assert(resolveClaudeBin({ env: { CLAUDE_BIN: '/custom/claude' }, exists: () => false }) === '/custom/claude',
  'CLAUDE_BIN 명시값 우선');
assert(resolveClaudeBin({ env: {}, exists: (p) => p === '/home/pi/.local/bin/claude' }) === '/home/pi/.local/bin/claude',
  'cron PATH 밖 기본 설치경로 탐색');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
