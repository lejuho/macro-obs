// 알림 ↔ 노출 매트릭스 조인 (스펙 §4.1의 3번 요소)
// 지표별 가중치: 이 지표가 흔들릴 때 어떤 노출 필드가 유효한가
const { stmts } = require('./db');

const WEIGHTS = {
  // 환율 → 수출 비중(수혜/피해 방향은 사람이 판단, 여기선 노출 크기만) + 외화부채
  '731Y001/0000001': { w_export: 1.0, w_fxdebt: 0.8, w_float: 0 },
  // 기준금리/국고채 → 변동금리 부채 + 외화부채 약간
  '722Y001/0101000': { w_export: 0, w_fxdebt: 0.2, w_float: 1.0 },
  '817Y002/010200000': { w_export: 0, w_fxdebt: 0.2, w_float: 1.0 },
  // 경상수지 → 수출 구조
  '301Y013/000000': { w_export: 1.0, w_fxdebt: 0, w_float: 0 },
};

const pc = (v) => (v == null ? '-' : Math.round(v * 100) + '%');

// 지표 → 그래프 흐름 노드 (밴드 이탈 시 역방향 시나리오 조회용)
// ECOS는 수동 매핑, FRED는 SERIES 정의의 graph_node에서 자동 생성
const NODE_MAP = { '731Y001/0000001': '원화가치' };
try {
  for (const s of require('./collectors/fred').SERIES) {
    if (s.graph_node) NODE_MAP[s.code] = s.graph_node;
  }
} catch { /* fred 미사용 환경 무해 */ }

/** 이 지표(흐름 노드)를 미는 사전계산 시나리오 상위 N */
function scenarioHints(indicatorSourceCode, limit = 3) {
  const nodeName = NODE_MAP[indicatorSourceCode];
  if (!nodeName) return null;
  let rows;
  try { rows = stmts.scenariosHittingNode.all(`%${nodeName}%`); } catch { return null; }
  if (!rows?.length) return null;
  const best = {};
  for (const r of rows) if (!best[r.name] || Math.abs(r.impact) > Math.abs(best[r.name].impact)) best[r.name] = r;
  const top = Object.values(best).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, limit);
  return ['', `<b>${nodeName}를 미는 시나리오</b> — 지금 어느 세계인가:`,
    ...top.map((r) => `· ${r.impact < 0 ? '🔴' : '🟢'}${Math.abs(r.impact).toFixed(2)} ${r.name} (/scn ${r.id})`)].join('\n');
}

/** 이탈 알림에 붙일 노출 상위 N 텍스트. 데이터 없으면 null (Phase 2 미가동 시 알림은 기존 그대로) */
function exposureSection(indicatorSourceCode, limit = 5) {
  const w = WEIGHTS[indicatorSourceCode];
  if (!w) return null;
  let rows;
  try { rows = stmts.topExposed.all({ ...w, limit }); } catch { return null; }
  if (!rows?.length) return null;

  const lines = ['', '<b>구조적 노출 상위</b> (공시 기반, 최신 보고서):'];
  for (const r of rows) {
    const parts = [];
    if (w.w_export && r.export_ratio != null) parts.push(`수출 ${pc(r.export_ratio)}`);
    if (w.w_fxdebt && r.fx_debt_ratio != null) parts.push(`외화부채 ${pc(r.fx_debt_ratio)}`);
    if (w.w_float && r.float_rate_ratio != null) parts.push(`변동금리 ${pc(r.float_rate_ratio)}`);
    lines.push(`· ${r.name}: ${parts.join(' · ')}`);
  }
  lines.push('<i>노출 크기 순위일 뿐 방향(수혜/피해) 판단은 네 몫이다</i>');
  return lines.join('\n');
}

module.exports = { exposureSection, scenarioHints, WEIGHTS };
