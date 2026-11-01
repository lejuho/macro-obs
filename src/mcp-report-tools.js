// 외부 에이전트 보고서 도구 — OAuth(macro.report 스코프) 또는 MCP_WRITE_TOKEN으로만 노출.
// reports 테이블만 건드린다 (가설·예측·그래프 불변). 관측소 판단과 섞이지 않도록 author로 출처 표시.
const { db } = require('./db');

const insReport = db.prepare(`
  INSERT INTO reports (author, title, body, event_ids_json, since_id, until_id, meta_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

/** 커서 루프 보고서(until_id 있음)가 지금까지 덮은 마지막 이벤트 id — 작성자 무관 공유 커서 */
function latestUntilId() {
  return db.prepare(`SELECT MAX(until_id) AS m FROM reports`).get().m ?? null;
}

/** 루프 보고서의 범위 (since, until]·event_ids가 기존 보고서와 겹치면 그 보고서 */
function findOverlap(ids, since, until) {
  const byIds = ids.length
    ? db.prepare(`SELECT DISTINCT r.id, r.author, r.since_id, r.until_id FROM reports r, json_each(r.event_ids_json) j
        WHERE j.value IN (${ids.map(() => '?').join(',')}) ORDER BY r.id LIMIT 1`).get(...ids)
    : null;
  if (byIds) return byIds;
  return db.prepare(`SELECT id, author, since_id, until_id FROM reports
    WHERE until_id IS NOT NULL AND since_id IS NOT NULL AND since_id < ? AND ? < until_id ORDER BY id LIMIT 1`).get(until, since) || null;
}

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
        'event_ids에는 이 보고서가 다룬 이벤트 id를 전부 넣어라 — 중복 보고 방지와 뉴스 클러스터 연결에 쓰인다.',
        'news_cluster(data.cluster_ids)·news_revisit(data.cluster_id) 이벤트를 넣으면 그 클러스터의 다음 클러스터링·90일 재방문에',
        '"외부 에이전트 보고서(참고, 관측소 판단 아님)"로 발췌가 전달되어 사실 확인 힌트로 검증된다.',
        '그러니 클러스터별 내용은 "### #<이벤트id> ..." 헤딩 아래에 적어라 — 해당 섹션만 발췌된다.',
        '저장 성공 응답을 받은 뒤에만 다음 폴링의 since_id를 until_id로 올려라.',
        'until_id를 준 보고서는 다른 보고서(작성자 무관)가 이미 다룬 구간·이벤트와 겹치면 거부된다 — get_reports의 latest_until_id부터 이어서 분석하라.',
      ].join(' '),
      returns: '{ok, report_id, until_id, warning?(until_id 없는 보고서에 이미 보고된 이벤트가 섞였을 때)} — until_id 있는 보고서가 기존 구간과 겹치면 저장하지 않고 isError(latest_until_id 안내)',
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
        if (until_id != null) {
          const since = since_id ?? (ids.length ? Math.min(...ids) - 1 : until_id);
          const o = findOverlap(ids, since, until_id);
          if (o) {
            const range = o.until_id != null ? `, #${(o.since_id ?? 0) + 1}–${o.until_id}` : '';
            const latest = latestUntilId();
            throw new Error(`저장 안 함: 이 구간이 이미 보고서 #${o.id}(${o.author}${range})에서 다뤄졌다. `
              + `공유 커서 latest_until_id=${latest} — get_events(since_id=${latest})로 그 뒤 이벤트만 분석해 다시 저장하라. 새 이벤트가 없으면 저장하지 않는다.`);
          }
        }
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
      returns: '{reports[{id,ts,author,title,body,event_ids,since_id,until_id,meta}], latest_until_id} — since_id를 주면 그 이후를 오래된 순으로. latest_until_id는 작성자 무관 보고 커서(다음 get_events since_id)',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '기본 20, 최대 100' }, since_id: { type: 'integer' } },
        additionalProperties: false,
      },
      handler(args = {}) { return { reports: listReports(args), latest_until_id: latestUntilId() }; },
    },
  ];
}

module.exports = { reportTools, listReports, latestUntilId };
