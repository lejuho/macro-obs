// LLM 추출 래퍼 — 파이의 Claude Code 헤드리스(claude -p) 호출.
// 추상화 이유: 물량이 커지면 Batch API로 갈아탈 수 있게 인터페이스 고정.
//
// EXTRACT_MODE=claude (기본) : claude -p 실행
// EXTRACT_MODE=manual        : 프롬프트를 out/pending/에 파일로 떨굼 (수동 실행 하이브리드)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PROMPT = fs.readFileSync(path.join(ROOT, 'prompts', 'extract-exposure.md'), 'utf8');
const MODE = process.env.EXTRACT_MODE || 'claude';

const FIELDS = ['export_ratio', 'usd_revenue_ratio', 'fx_debt_ratio', 'float_rate_ratio'];

/** LLM 출력 검증: JSON 파싱 + 비율 범위 + evidence가 발췌 원문에 실존하는지 */
function validate(outputText, excerpt) {
  let obj;
  const cleaned = outputText.replace(/```json|```/g, '').trim();
  try { obj = JSON.parse(cleaned); } catch { return { ok: false, reason: 'JSON 파싱 실패' }; }

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
  const ev = obj.evidence || {};
  for (const [field, quote] of Object.entries(ev)) {
    if (typeof quote === 'string' && quote.length >= 6 && !excerpt.includes(quote)) {
      return { ok: false, reason: `evidence 원문 불일치 (${field}): "${quote.slice(0, 30)}"` };
    }
  }
  // 값이 있는데 evidence가 없는 필드 → 경고만 (반려는 과함)
  const warnings = FIELDS.filter((f) => obj[f] != null && !ev[f]);
  return { ok: true, data: obj, warnings };
}

function extract(corpName, excerpt) {
  const input = `${PROMPT}\n[회사: ${corpName}]\n\n${excerpt}\n--- 보고서 발췌 끝 ---`;

  if (MODE === 'manual') {
    const dir = path.join(ROOT, 'out', 'pending');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${corpName.replace(/[^\w가-힣]/g, '_')}.txt`);
    fs.writeFileSync(f, input);
    return { ok: false, reason: `manual 모드 — ${f} 를 직접 처리 후 import 하라`, pending: f };
  }

  // claude -p 헤드리스. 재시도 1회 (검증 실패 시 사유를 붙여 재요청)
  for (let attempt = 1; attempt <= 2; attempt++) {
    let out;
    try {
      out = execFileSync('claude', ['-p', '--output-format', 'text'], {
        input, maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
        env: { ...process.env },
      }).toString('utf8');
    } catch (e) {
      if (attempt === 2) return { ok: false, reason: `claude 실행 실패: ${e.message.slice(0, 200)}` };
      continue;
    }
    const v = validate(out, excerpt);
    if (v.ok) return v;
    if (attempt === 2) return v;
    // 재시도: 실패 사유를 프리픽스로
    console.warn(`  재시도 (${corpName}): ${v.reason}`);
  }
}

module.exports = { extract, validate, FIELDS };
