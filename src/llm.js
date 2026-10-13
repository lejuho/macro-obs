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

/** 텍스트 안의 균형 잡힌 JSON 객체 후보 전부 (문자열 내 괄호 무시) */
function jsonObjectCandidates(text) {
  const out = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          if (v && typeof v === 'object' && !Array.isArray(v)) out.push({ v, len: i + 1 - start });
        } catch { /* 다음 시작점 */ }
        break;
      }
    }
  }
  return out;
}

/**
 * JSON 강제 파싱. 에이전트 모드는 도구 사용 서술·코드펜스를 앞뒤에 붙이곤 해서
 * 전체 파싱 → 펜스 제거 → 본문 속 객체 추출(requireKey 보유 우선, 없으면 최대) 순으로 시도.
 */
function parseJson(text, { requireKey } = {}) {
  const raw = String(text || '');
  const tries = [raw.trim(), raw.replace(/```(?:json)?/g, '').trim()];
  for (const t of tries) {
    try {
      const data = JSON.parse(t);
      if (!requireKey || (data && data[requireKey] !== undefined)) return { ok: true, data };
    } catch { /* 다음 */ }
  }
  const cands = jsonObjectCandidates(raw);
  const pick = cands.filter((c) => !requireKey || c.v[requireKey] !== undefined)
    .sort((a, b) => b.len - a.len)[0];
  if (pick) return { ok: true, data: pick.v, extracted: true };
  return { ok: false, reason: 'JSON 파싱 실패' };
}

/** 파싱 실패 원문 보존 (원인 추적용 — 이전엔 로그에 사유만 남아 원문을 볼 수 없었다) */
function dumpFailure(label, text) {
  try {
    const dir = path.join(ROOT, 'log', 'llm-fail');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^\w-]/g, '_')}.txt`);
    fs.writeFileSync(f, String(text || ''));
    return f;
  } catch { return null; }
}

/**
 * 실행 + JSON 파싱. 파싱 실패 시 원문을 덤프하고, 같은 모델(도구 없이)에 1회 "JSON으로만 재출력" 수리 요청.
 * runLLM 주입 가능 (테스트).
 */
function runJson(input, { runLLM = run, requireKey, label = 'task', ...opts } = {}) {
  const r = runLLM(input, { label, ...opts });
  if (!r.ok) return r;
  const p = parseJson(r.text, { requireKey });
  if (p.ok) return { ok: true, data: p.data, text: r.text };
  const dumped = dumpFailure(label, r.text);
  const repairPrompt = [
    '아래는 지정된 JSON 스키마로 답해야 했던 출력인데 유효한 JSON 하나로 파싱되지 않는다.',
    '내용을 바꾸거나 새로 지어내지 말고, 같은 내용을 유효한 JSON 객체 하나로만 다시 출력하라 (백틱·설명 금지).',
    requireKey ? `최상위 키 "${requireKey}"가 반드시 있어야 한다.` : '',
    '출력이 중간에 잘렸다면 완결된 항목까지만 남기고 배열·객체를 닫아라.',
    '--- 원 출력 ---', String(r.text || '').slice(0, 120_000),
  ].filter(Boolean).join('\n');
  const r2 = runLLM(repairPrompt, { label: `${label}-repair`, ...opts, agent: false });
  if (!r2.ok) return { ok: false, reason: `JSON 파싱 실패 (수리 호출 실패: ${r2.reason})`, dumped };
  const p2 = parseJson(r2.text, { requireKey });
  if (p2.ok) return { ok: true, data: p2.data, text: r2.text, repaired: true, dumped };
  dumpFailure(`${label}-repair`, r2.text);
  return { ok: false, reason: 'JSON 파싱 실패 (수리 후에도)', dumped };
}

module.exports = { run, runAgent, buildAgentArgs, parseJson, runJson, dumpFailure };
