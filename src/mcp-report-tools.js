// 외부 에이전트 보고서 도구 — OAuth(macro.report 스코프) 또는 MCP_WRITE_TOKEN으로만 노출.
// reports 테이블만 건드린다 (가설·예측·그래프 불변). 관측소 판단과 섞이지 않도록 author로 출처 표시.
const { db } = require('./db');

const insReport = db.prepare(`
  INSERT INTO reports (author, title, body, event_ids_json, since_id, until_id, meta_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

function listReports({ limit = 20, since_id } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = since_id != null
    ? db.prepare(`SELECT * FROM reports WHERE id > ? ORDER BY id ASC LIMIT ${n}`).all(Number(since_id))
    : db.prepare(`SELECT * FROM reports ORDER BY id DESC LIMIT ${n}`).all();
  return rows.map(({ event_ids_json, meta_json, ...r }) => ({
    ...r, event_ids: JSON.parse(event_ids_json || '[]'), meta: JSON.parse(meta_json || 'null'),
  }));
}

/** author: 호출 주체 (OAuth client 이름/ID 등) — 서버가 주입, 도구 인자로 받지 않음 */
function reportTools(author = 'unknown') {
  return [
    {
      name: 'save_report',
      description: [
        'get_events로 읽은 새 이벤트에 대한 분석 보고서를 macro-obs에 저장한다.',
        'body는 마크다운: 변화(무엇이 바뀌었나) · 근거(이벤트 id·수치) · 불확실성(무엇이 판정을 뒤집을 수 있나)을 구분해 적어라.',
        'event_ids에는 이 보고서가 다룬 이벤트 id를 전부 넣어라 — 중복 보고 방지에 쓰인다.',
        '저장 성공 응답을 받은 뒤에만 다음 폴링의 since_id를 until_id로 올려라.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '한 줄 제목 (≤200자)' },
          body: { type: 'string', description: '마크다운 본문 (≤100KB)' },
          event_ids: { type: 'array', items: { type: 'integer' }, description: '다룬 이벤트 id 목록' },
          since_id: { type: 'integer', description: '이번 분석의 시작 커서 (get_events since_id)' },
          until_id: { type: 'integer', description: '이번 분석이 커버한 마지막 이벤트 id (next_since_id)' },
          meta: { type: 'object', description: '선택: 모델명, 비교 기간 등' },
        },
        required: ['title', 'body'],
        additionalProperties: false,
      },
      handler({ title, body, event_ids = [], since_id = null, until_id = null, meta = null } = {}) {
        if (!String(title || '').trim()) throw new Error('title 필수');
        if (!String(body || '').trim()) throw new Error('body 필수');
        if (String(title).length > 200) throw new Error('title 200자 초과');
        if (Buffer.byteLength(String(body)) > 100 * 1024) throw new Error('body 100KB 초과');
        if (!Array.isArray(event_ids) || !event_ids.every(Number.isInteger)) throw new Error('event_ids는 정수 배열');
        const ids = [...new Set(event_ids)];
        const dup = ids.length
          ? db.prepare(`SELECT r.id FROM reports r, json_each(r.event_ids_json) j
              WHERE j.value IN (${ids.map(() => '?').join(',')}) AND r.author = ? LIMIT 1`).get(...ids, author)
          : null;
        const r = insReport.run(author, String(title), String(body), JSON.stringify(ids),
          since_id, until_id, meta == null ? null : JSON.stringify(meta));
        return {
          ok: true, report_id: Number(r.lastInsertRowid), until_id,
          ...(dup ? { warning: `일부 이벤트가 이미 보고서 #${dup.id}에 포함됨` } : {}),
        };
      },
    },
    {
      name: 'get_reports',
      description: '저장된 분석 보고서 목록 (최신순). 새 보고서를 쓰기 전에 직전 보고서와 중복·모순이 없는지 확인할 때.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '기본 20, 최대 100' }, since_id: { type: 'integer' } },
        additionalProperties: false,
      },
      handler(args = {}) { return { reports: listReports(args) }; },
    },
  ];
}

module.exports = { reportTools, listReports };
