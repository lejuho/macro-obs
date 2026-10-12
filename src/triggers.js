// 결정 트리거 평가기 (스펙 §3.4, §4.2)
// "평온할 때의 내가 흥분한 나에게 보내는 지시서" — 전 조건(AND) 충족 시 발동, 발동 후 disarm.

const { stmts } = require('./db');

const OPS = { '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b };

/** "3>1550 & 7<2.7" → [{indicator_id:3, op:'>', value:1550}, ...]  실패 시 {error} */
function parseConditions(text) {
  const parts = text.split('&').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: '조건이 비어있다' };
  const conds = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return { error: `조건 형식 오류: "${p}" — <지표id><연산자><값> (예: 3>1550). 지표id는 /ind` };
    conds.push({ indicator_id: Number(m[1]), op: m[2], value: Number(m[3]) });
  }
  return { conds };
}

/** 순수 판정: conds × 최신값 맵 → 전부 충족? (값 없는 지표가 있으면 false) */
function evaluate(conds, latestOf) {
  for (const c of conds) {
    const v = latestOf(c.indicator_id);
    if (v == null || !OPS[c.op](v, c.value)) return false;
  }
  return true;
}

/** armed 트리거 스캔 → 발동 목록. 발동 시 disarm + trigger_fired alert 생성 */
function scan() {
  const fired = [];
  for (const t of stmts.armedTriggers.all()) {
    let conds;
    try { conds = JSON.parse(t.conditions_json); } catch { continue; }
    const ok = evaluate(conds, (id) => stmts.latestValue.get(id)?.value ?? null);
    if (!ok) continue;
    stmts.fireTrigger.run(t.id);
    const { id: alertId } = stmts.insertTriggerAlert.get({ trigger_id: t.id });
    fired.push({ alert_id: alertId, trigger: t, conds });
  }
  return fired;
}

function describeConds(conds) {
  const nameOf = (id) => {
    const { db } = require('./db');
    return db.prepare('SELECT name FROM indicators WHERE id = ?').get(id)?.name || `#${id}`;
  };
  return conds.map((c) => {
    const cur = stmts.latestValue.get(c.indicator_id)?.value;
    return `${nameOf(c.indicator_id)} ${c.op} ${c.value} (현재 ${cur ?? '-'})`;
  }).join('  AND  ');
}

/** 발동 알림 포맷 — 지시서 원문 + 작성일이 본체 */
function formatFired({ trigger, conds }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `⚡ <b>트리거 발동: ${esc(trigger.name)}</b>`,
    `조건: ${esc(describeConds(conds))}`,
    ``,
    `📜 <b>${trigger.created_at.slice(0, 10)}의 네가 지금의 너에게:</b>`,
    `"${esc(trigger.action_text)}"`,
    ``,
    ...(trigger.scenario_id ? [`연결 시나리오: /scn ${trigger.scenario_id}`, ``] : []),
    `이 메시지에 답장: 지시를 따랐는가, 안 따랐다면 왜 — 한 줄.`,
    `(답장해야 닫힌다. 회피도 기록이다. 재장전: /trig arm ${trigger.id})`,
  ].join('\n');
}

module.exports = { parseConditions, evaluate, scan, formatFired };
