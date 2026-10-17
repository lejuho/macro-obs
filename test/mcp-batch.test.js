// MCP 2층 테스트: 배치 도구 서버 + 에이전트 배선 (claude 바이너리 불필요)
// 실행: node --no-warnings test/mcp-batch.test.js

process.env.DB_PATH = '/tmp/macro-mcpb.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { createHandler } = require('../src/mcp');
const { BATCH_TOOLS, cacheReport, clearReportCache, REPORTS_DIR } = require('../src/mcp-batch-tools');
const { buildAgentArgs } = require('../src/llm');
const news = require('../src/news');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

const handle = createHandler(BATCH_TOOLS, { name: 'macro-obs-batch', version: '1.0.0' });
const call = async (name, args) => {
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { data: r.result.isError ? null : JSON.parse(r.result.content[0].text), isError: !!r.result.isError, text: r.result.content[0].text };
};

(async () => {
  console.log('1. 배치 서버 — 팩토리 분리');
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert(init.result.serverInfo.name === 'macro-obs-batch', '별도 serverInfo');
  assert(!('instructions' in init.result), '배치 서버는 사용 안내 생략');
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert(list.result.tools.length === 3, '배치 도구 3종');
  assert(!list.result.tools.some((t) => t.name === 'get_status'), '1층 도구 미노출 (격리)');

  console.log('2. 보고서 캐시 + search/fetch');
  clearReportCache();
  const rcept = '20260515000123';
  const doc = '가. 사업 개요 ... ' + 'x'.repeat(5000) +
    ' 나. 외화차입금 현황: 총차입금 중 외화차입금은 45%입니다. ' + 'y'.repeat(5000) +
    ' 다. 변동금리부 차입 비중은 30% 수준입니다.';
  cacheReport(rcept, doc);
  assert(fs.existsSync(`${REPORTS_DIR}/${rcept}.txt`), '캐시 파일 생성');

  let c = await call('search_report', { rcept_no: rcept, keyword: '외화차입금' });
  assert(c.data.total_found === 2 && c.data.hits[0].context.includes('외화차입금'), '키워드 위치 + 문맥');
  const pos = c.data.hits[0].pos;
  c = await call('fetch_report_section', { rcept_no: rcept, pos, radius: 100 });
  assert(c.data.section.includes('45%'), '구간 조회로 수치 확보 (발췌 상한 우회)');
  c = await call('fetch_report_section', { rcept_no: rcept, pos, radius: 99999 });
  assert(c.data.section.length <= 8001, 'radius 상한 강제');

  c = await call('search_report', { rcept_no: '99999999999', keyword: 'x' });
  assert(c.isError && c.text.includes('이번 배치 대상이 아니다'), '캐시 밖 접근 거부');
  c = await call('search_report', { rcept_no: '../etc/passwd', keyword: 'x' });
  assert(c.isError && c.text.includes('형식 오류'), '경로 주입 차단');

  clearReportCache();
  assert(!fs.existsSync(REPORTS_DIR), '배치 종료 시 캐시 정리');

  console.log('3. 에이전트 설정 빌드');
  const b = buildAgentArgs(['batch', 'obs']);
  assert(b.config.mcpServers.batch.args.some((a) => a.includes('mcp-batch.js')), 'batch 서버 경로');
  assert(b.config.mcpServers.obs.env.DB_PATH === process.env.DB_PATH, 'DB_PATH 명시 전달');
  assert(b.args.includes('--mcp-config') && b.args.includes('--allowedTools'), 'claude 인자');
  assert(b.args[b.args.indexOf('--allowedTools') + 1] === 'mcp__obs,mcp__batch', '서버 단위 허용');
  const only = buildAgentArgs(['batch']);
  assert(!only.config.mcpServers.obs && only.args[only.args.indexOf('--allowedTools') + 1] === 'mcp__batch', '서버 선택');
  const haiku = buildAgentArgs(['batch'], { model: 'haiku' });
  assert(haiku.args[haiku.args.indexOf('--model') + 1] === 'haiku', '호출별 모델 override');

  console.log('4. 프롬프트 부록 — 에이전트/플레인 분기');
  const items = [{ id: 1, source: 'S', spectrum: 'wire', title: 't', description: 'd' }];
  assert(news.buildClusterPrompt(items, [], { agent: true }).includes('search_news_live'), '클러스터 부록 (agent)');
  assert(!news.buildClusterPrompt(items, []).includes('search_news_live'), '플레인엔 부록 없음');
  const cl = { first_seen: '2026-04-01 00:00:00', title: 'T', query: 'q' };
  const rp = news.buildRevisitPrompt(cl, { notable_claims: [] }, [], { agent: true });
  assert(rp.includes('get_series') && rp.includes('실제 데이터로 채점'), '재방문 부록: 지표 접지 지시');

  console.log('5. DART agent 검증 완화 — 발췌 밖 evidence');
  const { validate } = require('../src/extract/claude');
  const excerpt = '수출 비중은 78%입니다';
  const out = JSON.stringify({
    export_ratio: 0.78, fx_debt_ratio: 0.45,
    evidence: { export_ratio: '수출 비중은 78%', fx_debt_ratio: '외화차입금은 45%입니다' }, // 발췌 밖
  });
  assert(!validate(out, excerpt).ok, '플레인: 발췌 밖 인용 반려 (기존 동작 유지)');
  const va = validate(out, excerpt, { agent: true });
  assert(va.ok && va.data._evidence_outside_excerpt.includes('fx_debt_ratio'), 'agent: 반려 대신 표본검증 표시');

  console.log('6. run() 폴백 계약 — agent 실패 시 플레인 경로');
  // PATH를 비워 claude 바이너리 부재를 재현 — 실기기(파이)에도 claude가 있으므로
  // 실제 호출 대신 spawn 실패를 강제해야 테스트가 밀폐적이고 무료다.
  const llm = require('../src/llm');
  const savedPath = process.env.PATH;
  const savedClaudeBin = process.env.CLAUDE_BIN;
  process.env.PATH = '/nonexistent';
  process.env.CLAUDE_BIN = '/nonexistent/claude';
  let r;
  try { r = llm.run('test', { label: 't', agent: true, servers: ['batch'] }); }
  finally {
    process.env.PATH = savedPath;
    if (savedClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = savedClaudeBin;
  }
  assert(r.ok === false && !String(r.reason).includes('agent'), '최종 오류가 플레인 경로에서 옴 (폴백 작동)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
