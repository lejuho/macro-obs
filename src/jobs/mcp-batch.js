// 배치 에이전트 도구 서버 (stdio) — claude -p가 --mcp-config로 띄운다
const readline = require('readline');
const { createHandler } = require('../mcp');
const { BATCH_TOOLS } = require('../mcp-batch-tools');

const handle = createHandler(BATCH_TOOLS, { name: 'macro-obs-batch', version: '1.0.0' });
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); }
  const res = await handle(msg);
  if (res) process.stdout.write(JSON.stringify(res) + '\n');
});
console.error('[macro-obs-batch mcp] stdio ready');
