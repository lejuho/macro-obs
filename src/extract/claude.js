// LLM 추출 래퍼 — 파이의 Claude Code 헤드리스(claude -p) 호출.
// 추상화 이유: 물량이 커지면 Batch API로 갈아탈 수 있게 인터페이스 고정.
//
// EXTRACT_MODE=claude (기본) : claude -p 실행
// EXTRACT_MODE=manual        : 프롬프트를 out/pending/에 파일로 떨굼 (수동 실행 하이브리드)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveClaudeBin } = require('../claude-cli');

const ROOT = path.join(__dirname, '..', '..');
const PROMPT = fs.readFileSync(path.join(ROOT, 'prompts', 'extract-exposure.md'), 'utf8');
const MODE = process.env.EXTRACT_MODE || 'claude';
// 모델 사다리 — 구독 윈도우 절약: 1차 haiku, 검증 실패 시에만 sonnet 승급.
// EXTRACT_MODEL을 지정하면 사다리 없이 그 모델로 고정 (세션 기본값 fable 상속 금지).
const LADDER = process.env.EXTRACT_MODEL
  ? [process.env.EXTRACT_MODEL, process.env.EXTRACT_MODEL]
  : ['haiku', 'sonnet'];

const FIELDS = ['export_ratio', 'usd_revenue_ratio', 'fx_debt_ratio', 'float_rate_ratio'];

/** 설명문·마크다운이 섞여도 첫 번째 유효한 JSON 객체만 안전하게 추출한다. */
function parseJsonObject(outputText) {
  const text = String(outputText || '');
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
          const value = JSON.parse(text.slice(start, i + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch { break; }
      }
    }
  }
  return null;
}

/** LLM 출력 검증. agent 모드에선 evidence가 발췌 밖 원문일 수 있어 실존 검증을 경고로 완화 */
function validate(outputText, excerpt, { agent = false } = {}) {
  const obj = parseJsonObject(outputText);
  if (!obj) return { ok: false, reason: 'JSON 파싱 실패' };

  for (const f of FIELDS) {
    const v = obj[f];
    if (v !== null && v !== undefined && (typeof v !== 'number' || v < 0 || v > 1)) {
      return { ok: false, reason: `${f} 범위 위반: ${v}` };
    }
  }
  if (obj.import_deps != null && !Array.isArray(obj.import_deps)) {
    return { ok: false, reason: 'import_deps 배열 아님' };
  }
  // evidence 실존 검증 — 지어낸 인용 탐지 (스펙 §8-3의 자동화 부분)
  // 계산된 비율은 "분자 / 분모" 형태로 올 수 있어 '/'로 쪼개 각 조각을 검증.
  // 표 셀 사이 줄바꿈/공백 차이는 내용 실존성과 무관하므로 공백 제거 후 비교.
  const norm = (s) => s.replace(/\s+/g, '');
  const normExcerpt = norm(excerpt);
  const evidenceParts = (quote) => quote.split('/').flatMap((raw) => {
    const part = raw.trim();
    // 모델이 분자들을 33.8%+31.6% 또는 346,314-188,110처럼 쓸 때도
    // 각 피연산자가 숫자뿐인 산식이고 원문에 개별 실존하면 허용한다.
    return /^[\d,.%]+(?:[+-][\d,.%]+)+$/.test(norm(part)) ? norm(part).split(/[+-]/) : [part];
  });
  const ev = obj.evidence || {};
  for (const [field, quote] of Object.entries(ev)) {
    if (typeof quote !== 'string') continue;
    for (const part of evidenceParts(quote).map((s) => norm(s))) {
      const minLength = /^[\d,.%]+$/.test(part) ? 2 : 6;
      if (part.length >= minLength && !normExcerpt.includes(part)) {
        if (!agent) return { ok: false, reason: `evidence 원문 불일치 (${field}): "${part.slice(0, 30)}"` };
        // agent 모드: 발췌 밖 원문 인용 가능 — 반려 대신 표본검증 대상 표시
        (obj._evidence_outside_excerpt ??= []).push(field);
        break;
      }
    }
  }
  // 값이 있는데 evidence가 없는 필드 → 경고만 (반려는 과함)
  const warnings = FIELDS.filter((f) => obj[f] != null && !ev[f]);
  return { ok: true, data: obj, warnings };
}

const AGENT_APPENDIX = `
--- 에이전트 도구 지침 (아래 보고서 원문의 일부가 아님) ---
너는 batch 서버의 도구를 쓸 수 있다:
- search_report(rcept_no, keyword): 원문에서 키워드 위치 탐색
- fetch_report_section(rcept_no, pos, radius): 해당 구간 원문 조회
아래 발췌에 없는 필드(예: 외화차입금, 변동금리 비중)는 null로 포기하기 전에
반드시 search_report → fetch_report_section으로 원문을 확인하라.
근거를 원문에서 찾으면 evidence 인용은 그 구간의 실제 문자열로.
--- 에이전트 도구 지침 끝 ---
`;

const EXCERPT_MARKER = '--- 보고서 발췌 시작 ---';

function buildInput(corpName, excerpt, { agent = false, rceptNo = null } = {}) {
  const instructions = PROMPT.replace(new RegExp(`\\n?${EXCERPT_MARKER}\\s*$`), '');
  const agentInstructions = agent && rceptNo ? `[rcept_no: ${rceptNo}]${AGENT_APPENDIX}` : '';
  return `${instructions}\n${agentInstructions}\n${EXCERPT_MARKER}\n[회사: ${corpName}]\n\n${excerpt}\n--- 보고서 발췌 끝 ---`;
}

function extract(corpName, excerpt, { agent = false, rceptNo = null } = {}) {
  const input = buildInput(corpName, excerpt, { agent, rceptNo });

  if (agent && MODE === 'claude') {
    const llm = require('../llm');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const model = LADDER[attempt - 1];
      const r = llm.run(input, {
        label: `dart-${corpName}`, agent: true, servers: ['batch'], model, timeout: 600_000,
      });
      if (!r.ok) {
        if (attempt === 2) return { ok: false, reason: r.reason };
        console.warn(`  승급 재시도 (${corpName}): ${model} 실행 실패 → ${LADDER[1]}`);
        continue;
      }
      const v = validate(r.text, excerpt, { agent: true });
      if (v.ok) return { ...v, model };
      if (attempt === 2) return v;
      console.warn(`  승급 재시도 (${corpName}): ${model} 검증 실패(${v.reason}) → ${LADDER[1]}`);
    }
  }

  if (MODE === 'manual') {
    const dir = path.join(ROOT, 'out', 'pending');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${corpName.replace(/[^\w가-힣]/g, '_')}.txt`);
    fs.writeFileSync(f, input);
    return { ok: false, reason: `manual 모드 — ${f} 를 직접 처리 후 import 하라`, pending: f };
  }

  // claude -p 헤드리스. 모델 사다리: 1차(haiku) 실패 시 2차(sonnet)로 승급 재시도
  for (let attempt = 1; attempt <= 2; attempt++) {
    const model = LADDER[attempt - 1];
    let out;
    try {
      out = execFileSync(resolveClaudeBin(), ['-p', '--output-format', 'text', '--model', model], {
        input, maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
        env: { ...process.env },
      }).toString('utf8');
    } catch (e) {
      if (attempt === 2) return { ok: false, reason: `claude 실행 실패: ${e.message.slice(0, 200)}` };
      console.warn(`  승급 재시도 (${corpName}): ${model} 실행 실패 → ${LADDER[1]}`);
      continue;
    }
    const v = validate(out, excerpt);
    if (v.ok) return { ...v, model };
    if (attempt === 2) return v;
    console.warn(`  승급 재시도 (${corpName}): ${model} 검증 실패(${v.reason}) → ${LADDER[1]}`);
  }
}

module.exports = { extract, validate, parseJsonObject, buildInput, FIELDS };
