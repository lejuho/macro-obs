// 범용 claude -p 래퍼 (Phase 5+) — DART 전용 extract/claude.js와 별개의 얇은 공통층.
// MODE: claude(기본) | manual(프롬프트 파일 덤프)
// 테스트는 run 함수를 주입(DI)해서 LLM 없이 파이프라인 검증.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveClaudeBin } = require('./claude-cli');

const MODE = () => process.env.EXTRACT_MODE || 'claude';
// 세션 기본값(fable) 상속 금지 — 배치는 항상 명시 모델로 (memory: batch-jobs-use-cheap-models)
const MODEL = () => process.env.EXTRACT_MODEL || 'sonnet';
const ROOT = path.join(__dirname, '..');

/** 에이전트 모드 인자 빌드 (순수 — 테스트 대상). servers: ['batch','obs'] */
function buildAgentArgs(servers = ['batch', 'obs'], { model = MODEL() } = {}) {
  const node = process.execPath;
  const mcpServers = {};
  if (servers.includes('obs')) {
    mcpServers.obs = {
      command: node, args: ['--no-warnings', path.join(ROOT, 'src', 'jobs', 'mcp-stdio.js')],
      env: { DB_PATH: process.env.DB_PATH || '' },
    };
  }
  if (servers.includes('batch')) {
    mcpServers.batch = {
      command: node, args: ['--no-warnings', path.join(ROOT, 'src', 'jobs', 'mcp-batch.js')],
      env: {
        DB_PATH: process.env.DB_PATH || '',
        NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID || '',
        NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET || '',
      },
    };
  }
  const allowed = Object.keys(mcpServers).map((n) => `mcp__${n}`).join(',');
  return {
    config: { mcpServers },
    args: ['-p', '--output-format', 'text', '--model', model, '--mcp-config', '__CONFIG_PATH__', '--allowedTools', allowed],
  };
}

function run(input, { label = 'task', timeout = 300_000, agent = false, servers, model = MODEL() } = {}) {
  if (agent && MODE() === 'claude') {
    const r = runAgent(input, { label, timeout, servers, model });
    if (r.ok) return r;
    console.warn(`  [llm] agent 모드 실패(${r.reason}) → 플레인 폴백`);
    // 폴백: 도구 없이 기존 방식
  }
  return runPlain(input, { label, timeout, model });
}

function runAgent(input, { label, timeout = 600_000, servers, model = MODEL() } = {}) {
  const { config, args } = buildAgentArgs(servers, { model });
  const dir = path.join(ROOT, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, `mcp-${label.replace(/[^\w-]/g, '_')}-${process.pid}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  try {
    const out = execFileSync(resolveClaudeBin(),
      args.map((a) => (a === '__CONFIG_PATH__' ? cfgPath : a)),
      { input, maxBuffer: 16 * 1024 * 1024, timeout, env: { ...process.env } }).toString('utf8');
    return { ok: true, text: out, agent: true };
  } catch (e) {
    return { ok: false, reason: `agent 실행 실패: ${e.message.slice(0, 200)}` };
  } finally {
    try { fs.unlinkSync(cfgPath); } catch { /* noop */ }
  }
}

function runPlain(input, { label = 'task', timeout = 300_000, model = MODEL() } = {}) {
  if (MODE() === 'manual') {
    const dir = path.join(__dirname, '..', 'out', 'pending');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${label}-${Date.now()}.txt`);
    fs.writeFileSync(f, input);
    return { ok: false, reason: `manual 모드 — ${f}`, pending: f };
  }
  try {
    const out = execFileSync(resolveClaudeBin(), ['-p', '--output-format', 'text', '--model', model], {
      input, maxBuffer: 16 * 1024 * 1024, timeout, env: { ...process.env },
    }).toString('utf8');
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, reason: `claude 실행 실패: ${e.message.slice(0, 200)}` };
  }
}

/** JSON 강제 파싱 (백틱 제거) */
function parseJson(text) {
  try { return { ok: true, data: JSON.parse(text.replace(/```json|```/g, '').trim()) }; }
  catch { return { ok: false, reason: 'JSON 파싱 실패' }; }
}

module.exports = { run, runAgent, buildAgentArgs, parseJson };
