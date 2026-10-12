// MCP stdio 트랜스포트 — 파이 로컬 Claude Code용 (개행 구분 JSON-RPC)
// 등록: claude mcp add macro-obs -- node --no-warnings /home/pi/macro-obs/src/jobs/mcp-stdio.js
const readline = require('readline');
const { createHandler, TOOLS } = require('../mcp');
const { WRITE_TOOLS } = require('../mcp-write-tools');
// 로컬 stdio = 신뢰 경계 안 → 읽기+쓰기 전체 노출
const handleRpc = createHandler([...TOOLS, ...WRITE_TOOLS]);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); }
  const res = await handleRpc(msg);
  if (res) process.stdout.write(JSON.stringify(res) + '\n');
});
// stdout은 프로토콜 전용 — 로그는 stderr로
console.error('[macro-obs mcp] stdio ready');
