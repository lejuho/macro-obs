// MCP 1층 테스트: 프로토콜 + 도구 + 트랜스포트
// 실행: node --no-warnings test/mcp.test.js

process.env.DB_PATH = '/tmp/macro-mcp.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { execSync } = require('child_process');
execSync(`DB_PATH=${process.env.DB_PATH} node --no-warnings scripts/seed-graph.js`, { cwd: __dirname + '/..' });

const { db, stmts } = require('../src/db');
const { handleRpc, TOOLS } = require('../src/mcp');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));
const rpc = (method, params, id = 1) => handleRpc({ jsonrpc: '2.0', id, method, params });
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { raw: r, data: r.result.isError ? null : JSON.parse(r.result.content[0].text), isError: !!r.result.isError, text: r.result.content[0].text };
};

// 픽스처
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/m', name: '원/달러 환율', freq: 'D', unit: '원', category: 'macro', note: '테스트 노브',
});
for (let i = 0; i < 5; i++) stmts.upsertObs.run(indId, `2026-07-0${i + 1}`, 1550 + i);
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, rationale)
  VALUES ('환율 뉴노멀', ?, 1450, 1600, 'r')`).run(indId);

(async () => {
console.log('1. 핸드셰이크');
let r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
assert(r.result.serverInfo.name === 'macro-obs' && r.result.capabilities.tools, 'initialize');
assert((await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })) === null, 'notification → 무응답');
assert((await rpc('ping')).result != null, 'ping');

console.log('2. tools/list');
r = await rpc('tools/list');
assert(r.result.tools.length === TOOLS.length, `도구 ${TOOLS.length}종 노출`);
assert(r.result.tools.every((t) => t.name && t.description && t.inputSchema?.type === 'object'), '스키마 완비');
assert(!r.result.tools.some((t) => t.handler), 'handler 미노출');

console.log('3. 도구 호출');
let c = await call('get_status');
assert(c.data.hypotheses.length === 1 && c.data.hypotheses[0].latest === 1554, 'get_status: 가설+최신값');
c = await call('get_series', { indicator: '환율', days: 30 });
assert(c.data.indicator.id === indId && c.data.observations.length === 5, 'get_series: 이름 부분일치 리졸브');
c = await call('get_series', { indicator: String(indId) });
assert(c.data.indicator.id === indId, 'get_series: id 리졸브');
c = await call('list_scenarios');
assert(c.data.length === 12 && c.data.find((s) => s.name === '대만 유사').countries.includes('TW'), 'list_scenarios + 연관국');

c = await call('run_scenario', { scenario: '관세' });
assert(c.data.scenario.name === '미국 관세·산업정책 압박', 'run_scenario: 이름 일부 리졸브');
const semi = c.data.nodes.find((n) => n.name === '반도체');
assert(semi && semi.contested === true, '경합 노드 표시');
assert(semi.paths.some((p) => p.edges.some((e) => e.leverage && e.leverage.includes('CMS'))), '경로에 지경학 노트 포함');
assert(c.data.note.includes('휴리스틱'), '휴리스틱 주의 문구');

c = await call('get_graph_node', { name: '원화가치' });
assert(c.data.incoming.length >= 4 && c.data.outgoing.length >= 4, '유입/유출 간선');
assert(Object.keys(c.data.scenarios_hitting).length >= 5, '역방향 시나리오 조인');
c = await call('get_graph_node', { name: '전력유틸리티' });
assert(c.data.node.meta?.seasons, '계절성 meta 노출');

console.log('4. 오류 의미론');
c = await call('get_series', { indicator: '없는지표' });
assert(c.isError && c.text.includes('list_indicators'), '도구 오류 → isError 결과 (프로토콜 오류 아님)');
r = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
assert(r.error && r.error.code === -32602, '없는 도구 → -32602');
assert((await rpc('no/method')).error.code === -32601, '없는 메서드 → -32601');
assert((await handleRpc({ foo: 1 })).error.code === -32600, '비정상 요청 → -32600');

console.log('5. HTTP 트랜스포트 (/mcp)');
const { createServer } = require('../src/jobs/server');
{
  const server = createServer(0);
  await new Promise((res) => server.on('listening', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let res = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  const json = await res.json();
  assert(res.status === 200 && json.result.tools.length === TOOLS.length + 1, 'POST /mcp tools/list (읽기 + get_reports)');
  res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert(res.status === 202, 'notification → 202');
  res = await fetch(base + '/mcp');
  assert(res.status === 405, 'GET → 405');
  server.close();

  console.log('6. stdio 트랜스포트 (스모크)');
  const { spawnSync } = require('child_process');
  const out = spawnSync('node', ['--no-warnings', 'src/jobs/mcp-stdio.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } }) + '\n',
    timeout: 15000,
  }).stdout.toString().trim().split('\n');
  assert(JSON.parse(out[0]).result.serverInfo.name === 'macro-obs', 'stdio: initialize');
  assert(JSON.parse(out[1]).result.content[0].text.includes('환율 뉴노멀'), 'stdio: tools/call');

}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
