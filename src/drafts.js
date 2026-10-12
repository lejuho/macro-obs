// 초안 생성기 (Phase 6, 스펙 §4.5) — graded 판단을 발행 가능한 자산으로.
// 시스템은 초안까지만. 발행 여부·수정은 사람.

const fs = require('fs');
const path = require('path');
const { db, stmts } = require('./db');
const llm = require('./llm');

const P = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'draft-post.md'), 'utf8');
const OUT_DIR = path.join(__dirname, '..', 'out', 'drafts');

/** 지난 N일 재료 수집. 전부 사실 레코드 — LLM은 이 밖을 말할 수 없다 */
function gatherMaterial(days = 30) {
  const graded = db.prepare(`
    SELECT p.statement, p.expected_low, p.expected_high, p.actual_value, p.score,
           p.committed_at, p.graded_at, h.statement AS hyp, i.name AS indicator, i.unit
    FROM predictions p JOIN alerts a ON a.id = p.alert_id
    LEFT JOIN hypotheses h ON h.id = a.hypothesis_id
    LEFT JOIN indicators i ON i.id = h.indicator_id
    WHERE p.graded_at >= datetime('now', ?) AND p.score IS NOT NULL
    ORDER BY p.graded_at`).all(`-${days} day`);

  const revisions = db.prepare(`
    SELECT n.statement AS new_statement, n.rationale AS new_rationale, n.created_at,
           o.statement AS old_statement, i.name AS indicator
    FROM hypotheses n JOIN hypotheses o ON o.id = n.revised_from
    JOIN indicators i ON i.id = n.indicator_id
    WHERE n.created_at >= datetime('now', ?)`).all(`-${days} day`);

  const breaches = db.prepare(`
    SELECT a.observed_value, a.observed_date, a.direction, a.status,
           h.statement AS hyp, i.name AS indicator, i.unit
    FROM alerts a JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE a.kind = 'band_breach' AND a.triggered_at >= datetime('now', ?)`).all(`-${days} day`);

  // 활성 가설 지표의 기간 변화
  const moves = db.prepare(`
    SELECT i.name, i.unit, h.band_low, h.band_high,
      (SELECT value FROM observations o WHERE o.indicator_id = i.id ORDER BY date DESC LIMIT 1) AS now_v,
      (SELECT value FROM observations o WHERE o.indicator_id = i.id
        AND date <= date('now', ?) ORDER BY date DESC LIMIT 1) AS then_v
    FROM hypotheses h JOIN indicators i ON i.id = h.indicator_id
    WHERE h.status = 'active'`).all(`-${days} day`);

  const lessons = db.prepare(`
    SELECT c.title, s.content_json FROM framing_snapshots s
    JOIN news_clusters c ON c.id = s.cluster_id
    WHERE s.phase = 'revisit' AND s.created_at >= datetime('now', ?)`).all(`-${days} day`)
    .map((r) => ({ event: r.title, lesson: JSON.parse(r.content_json).lesson })).filter((l) => l.lesson);

  // 다음 관전 포인트 재료
  const pending = db.prepare(`
    SELECT p.statement, p.target_date, i.name AS indicator
    FROM predictions p JOIN alerts a ON a.id = p.alert_id
    LEFT JOIN hypotheses h ON h.id = a.hypothesis_id
    LEFT JOIN indicators i ON i.id = h.indicator_id
    WHERE p.graded_at IS NULL ORDER BY p.target_date LIMIT 5`).all();

  return { period_days: days, graded, revisions, breaches, moves, lessons, pending };
}

const hasMaterial = (m) => m.graded.length + m.revisions.length + m.breaches.length > 0;

function buildDraftPrompt(material, ym) {
  return `${P}\n[연월: ${ym}]\n--- 재료 JSON ---\n${JSON.stringify(material, null, 1)}\n--- 끝 ---`;
}

/** 초안 검증: 최소 분량 + 마크다운 구조 (산문이라 기계 검증은 경량) */
function validateDraft(text) {
  if (!text || text.trim().length < 400) return { ok: false, reason: '분량 미달' };
  if (!/^#\s/m.test(text) || !/^##\s/m.test(text)) return { ok: false, reason: '마크다운 구조 없음' };
  return { ok: true };
}

/** 월간 초안 생성. runLLM 주입 가능 */
function generateDraft({ runLLM = llm.run, days = 30 } = {}) {
  const material = gatherMaterial(days);
  if (!hasMaterial(material)) return { skip: '재료 없음 — 채점·수정·이탈이 있어야 초안이 나온다' };

  const ym = new Date().toISOString().slice(0, 7);
  const r = runLLM(buildDraftPrompt(material, ym), { label: `draft-${ym}` });
  if (!r.ok) return { ok: false, reason: r.reason };
  const v = validateDraft(r.text);
  if (!v.ok) return { ok: false, reason: v.reason };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${ym}.md`);
  fs.writeFileSync(file, r.text.trim() + '\n');
  return { ok: true, file, ym, chars: r.text.length, material_counts: {
    graded: material.graded.length, revisions: material.revisions.length,
    breaches: material.breaches.length, lessons: material.lessons.length,
  } };
}

module.exports = { gatherMaterial, buildDraftPrompt, validateDraft, generateDraft, hasMaterial };
