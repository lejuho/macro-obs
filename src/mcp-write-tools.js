// MCP 쓰기 도구 (3층) — 대화에서 합의된 판단을 관측소에 주입한다.
// 원칙:
//   1. origin='assisted' 태깅 — 트랙레코드가 human/assisted로 분리 집계된다 (캘리브레이션 실험).
//   2. 텔레그램 흐름과 동일한 가드 (open 알림만 커밋, 근거 필수, revised_from 체인).
//   3. 노출 경계: stdio(로컬)는 기본 포함, HTTP는 MCP_WRITE_TOKEN 있을 때만.
//
// 도구 description에 사용 규율을 박는다 — 조회하는 Claude가 이 규율을 물려받는다.

const { db, stmts } = require('./db');
const { parseCommit, targetDate } = require('./predictions');
const { parseConditions } = require('./triggers');

const WRITE_TOOLS = [
  {
    name: 'commit_prediction',
    description: [
      'open 알림에 90일 예측을 커밋한다 (origin=assisted로 기록 — 사용자 단독 판단과 분리 집계됨).',
      '반드시 사용자가 명시적으로 커밋을 요청했을 때만 호출하라. 토론 중 임의로 커밋하지 마라.',
      'statement는 사용자와 합의된 최종 문장이어야 한다: "1450~1520"(밴드) / "1500"(점→±2%) / 자유 서술.',
      '호출 전에 get_status로 알림 id와 현재값을 확인하고, 사용자에게 최종 문장을 되물어 확정받아라.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        alert_id: { type: 'number', description: 'open 상태의 알림 id (get_status로 확인)' },
        statement: { type: 'string', description: '합의된 커밋 문장' },
      },
      required: ['alert_id', 'statement'], additionalProperties: false,
    },
    handler({ alert_id, statement }) {
      const alert = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(alert_id);
      if (!alert) throw new Error(`알림 #${alert_id} 없음 — get_status로 확인`);
      if (alert.status !== 'open') throw new Error(`알림 #${alert_id}는 이미 ${alert.status} — 커밋 불가`);
      if (alert.kind !== 'band_breach') throw new Error(`알림 #${alert_id}는 ${alert.kind} — 밴드 이탈 알림만 커밋 대상`);

      const parsed = parseCommit(statement);
      if (parsed.mute) throw new Error('mute는 이 도구로 못 한다 — 회피는 사용자가 직접 (텔레그램/버튼)');

      const tdate = targetDate();
      const { id } = stmts.insertPrediction.get({
        alert_id, statement: parsed.statement,
        expected_low: parsed.expected_low, expected_high: parsed.expected_high,
        target_date: tdate,
      });
      stmts.setPredictionOrigin.run('assisted', id);
      stmts.setAlertStatus.run('committed', alert_id);
      return {
        prediction_id: id, origin: 'assisted', target_date: tdate,
        band: parsed.structured ? [parsed.expected_low, parsed.expected_high] : null,
        note: parsed.structured
          ? `${tdate}에 자동 채점. assisted 트랙으로 분리 집계된다.`
          : `자유 서술 — ${tdate}에 self-grade 요청이 온다. assisted 트랙 분리 집계.`,
      };
    },
  },
  {
    name: 'revise_hypothesis',
    description: [
      '가설 밴드를 수정한다 (구가설 retire + revised_from 체인 보존, origin=assisted).',
      '가설 수정은 커밋보다 무겁다 — 세계관의 변경이다. 사용자가 명시적으로 수정을 결정했을 때만,',
      'rationale은 대화에서 나온 사용자의 논리를 재서술해 넣어라 (다음 이탈 알림에 그대로 뜬다).',
      '수정 전 get_status와 필요시 /hyp ctx에 해당하는 get_series로 분포를 확인·제시했는가?',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        hypothesis_id: { type: 'number' },
        band_low: { type: 'number' },
        band_high: { type: 'number' },
        rationale: { type: 'string', description: '수정 근거 (10자 이상 필수)' },
      },
      required: ['hypothesis_id', 'band_low', 'band_high', 'rationale'], additionalProperties: false,
    },
    handler({ hypothesis_id, band_low, band_high, rationale }) {
      const old = stmts.hypById.get(hypothesis_id);
      if (!old) throw new Error(`가설 #${hypothesis_id} 없음`);
      if (old.status !== 'active') throw new Error(`가설 #${hypothesis_id}는 ${old.status} — 수정 불가`);
      if (String(rationale).trim().length < 10) {
        throw new Error('근거가 너무 짧다. 이 문장이 다음 이탈 알림에 "등록 논리"로 그대로 뜬다.');
      }
      let lo = band_low, hi = band_high;
      if (lo > hi) [lo, hi] = [hi, lo];

      const statement = old.statement.replace(/\d+(?:\.\d+)?\s*~\s*\d+(?:\.\d+)?/, `${lo}~${hi}`);
      const { id } = stmts.reviseHyp.get({
        statement, band_low: lo, band_high: hi, rationale: rationale.trim(), old_id: hypothesis_id,
      });
      stmts.setHypOrigin.run('assisted', id);
      stmts.retireHyp.run(hypothesis_id);
      return {
        new_hypothesis_id: id, origin: 'assisted',
        old_band: [old.band_low, old.band_high], new_band: [lo, hi],
        note: '수정 이력은 revised_from 체인으로 보존. 이 rationale이 다음 알림에 뜬다.',
      };
    },
  },
  {
    name: 'add_trigger',
    description: [
      '결정 트리거를 장전한다 — "평온할 때의 지시서". 조건(AND) 충족 시 action_text가 작성일과 함께 발송된다.',
      '사용자가 명시적으로 예약을 요청했을 때만. action_text는 흥분한 미래의 사용자가 그대로 실행할 수 있게',
      '대화에서 합의된 구체적 지시로 재서술하라. 조건의 지표 id는 list_indicators로 확인.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '트리거 이름' },
        conditions: { type: 'string', description: '"<지표id><연산자><값>" & 결합 (예: "1>1600 & 7>5")' },
        action_text: { type: 'string', description: '발동 시 돌아올 지시문 (10자 이상)' },
      },
      required: ['name', 'conditions', 'action_text'], additionalProperties: false,
    },
    handler({ name, conditions, action_text }) {
      const parsed = parseConditions(conditions);
      if (parsed.error) throw new Error(parsed.error);
      if (String(action_text).trim().length < 10) {
        throw new Error('지시문이 너무 짧다 — 미래의 사용자가 그대로 실행할 수 있게 구체적으로.');
      }
      for (const c of parsed.conds) {
        const ind = db.prepare('SELECT name FROM indicators WHERE id = ?').get(c.indicator_id);
        if (!ind) throw new Error(`지표 #${c.indicator_id} 없음 — list_indicators로 확인`);
      }
      const { id } = stmts.insertTrigger.get({
        name: name.trim(), conditions_json: JSON.stringify(parsed.conds),
        action_text: action_text.trim(), scenario_id: null,
      });
      return {
        trigger_id: id, conditions: parsed.conds,
        note: '장전됨. 전 조건 충족 시 발동 후 disarm — 재장전은 /trig arm.',
      };
    },
  },
];

module.exports = { WRITE_TOOLS };
