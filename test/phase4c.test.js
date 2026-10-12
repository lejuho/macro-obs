// Phase 4c 테스트: 국기 매핑 규칙 + 선거/정책 레버
// 실행: node --no-warnings test/phase4c.test.js

process.env.DB_PATH = '/tmp/macro-p4c.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { execSync } = require('child_process');
execSync(`DB_PATH=${process.env.DB_PATH} node --no-warnings scripts/seed-elections.js`, { cwd: __dirname + '/..' });

const { stmts } = require('../src/db');
const flags = require('../src/flags');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('1. 국기 — 지표 규칙 (연관국 전부)');
assert(flags.forIndicator('원/달러 환율(매매기준율)').join() === 'KR,US', '환율 = 한·미');
assert(flags.forIndicator('한미 10년 금리차').join() === 'KR,US', '패턴 우선순위 (한미 > 미국)');
assert(flags.forIndicator('USD/JPY').join() === 'US,JP', 'USD/JPY');
assert(flags.forIndicator('반도체 수출 YoY').join() === 'KR', '파생지표도 매칭');
assert(flags.forIndicator('Brent 유가').length === 0, 'Brent = 모호 → 무표시');
assert(flags.forIndicator('알 수 없는 지표').length === 0, '미등록 → 빈 배열');

console.log('2. 국기 — 노드 엄격 규칙 (이름 명시만)');
assert(flags.forNode('대미자동차수출').join() === 'KR,US', '대미자동차수출 = 한·미 (사용자 예시)');
assert(flags.forNode('호르무즈해협').length === 0, '호르무즈 = 이름에 국가 없음 → 무표시');
assert(flags.forNode('핵심광물공급지').length === 0, '핵심광물 = 무표시');
assert(flags.forNode('BOJ·JGB').join() === 'JP', 'BOJ = 일본 (기관명도 명시로 간주)');
assert(flags.forNode('반도체').length === 0, '산업 열 = 거의 없음 (사용자 예시)');

console.log('3. 국기 — 렌더');
assert(flags.flag('KR') === '🇰🇷' && flags.flag('EU') === '🇪🇺', '이모지 변환 (EU 특례)');
assert(flags.label(['TW', 'CN']) === '🇹🇼 대만 · 🇨🇳 중국', '국기+국가명');
assert(flags.label(['TW', 'CN'], false) === '🇹🇼🇨🇳', '국기만');
assert(flags.label([]) === '', '빈 배열 → 빈 문자열');

console.log('4. 시나리오 국기 — 전 시나리오 커버 확인');
const seedScn = require('../data/graph-seed').SCENARIOS;
const unmapped = seedScn.filter((s) => !(s.name in flags.SCENARIO_FLAGS));
assert(unmapped.length === 0, `시드 12종 전부 매핑 존재 (누락: ${unmapped.map((s) => s.name).join(',') || '없음'})`);

console.log('5. 선거 시드 + upcoming 조회');
const up = stmts.upcomingElections.all(5);
assert(up.length >= 4, '미래 선거 4건 이상');
assert(up[0].date <= up[up.length - 1].date, '날짜순 정렬');
const midterm = up.find((e) => e.body === 'midterm');
assert(midterm && midterm.country === '미국', '2026-11 미국 중간선거');
const levers = stmts.leversFor.all(midterm.id);
assert(levers.length === 3, '중간선거 레버 3분기');
assert(levers.some((l) => l.scenario_name === '미국 관세·산업정책 압박'), '시나리오 이름 연결');
assert(!levers.some((l) => /좌파|우파|진보|보수/.test(l.lever)), '이념 라벨 없음 — 정책 레버만 (설계 원칙)');

console.log('6. 멱등 재시드');
execSync(`DB_PATH=${process.env.DB_PATH} node --no-warnings scripts/seed-elections.js`, { cwd: __dirname + '/..' });
assert(stmts.upcomingElections.all(10).length === up.length, '재실행해도 중복 없음');
assert(stmts.leversFor.all(midterm.id).length === 3, '레버는 갱신(clear 후 재삽입)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
