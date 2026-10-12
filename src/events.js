// 이벤트 로그 — 텔레그램 알림·배치 판단·갱신을 한 테이블에 적재.
// 외부 에이전트는 /api/events?since_id=N (또는 MCP get_events)로 커서 기반 폴링.
const path = require('path');
const { db } = require('./db');

const insert = db.prepare(`
  INSERT INTO events (source, kind, text, data_json, delivered) VALUES (?, ?, ?, ?, ?)`);

/** cron 진입점 파일명 = source (daily/news/monthly/quarterly/bot/server/mcp-stdio) */
function defaultSource() {
  return require.main?.filename ? path.basename(require.main.filename, '.js') : 'unknown';
}

function htmlToText(s) {
  return String(s ?? '').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 기록 실패가 본 작업을 막지 않도록 예외를 삼킨다. 반환: event id | null */
function record({ kind, text = null, data = null, source = defaultSource(), delivered = null }) {
  try {
    const r = insert.run(source, kind, text == null ? null : htmlToText(text),
      data == null ? null : JSON.stringify(data), delivered == null ? null : Number(delivered));
    return Number(r.lastInsertRowid);
  } catch (e) {
    console.error('events.record:', e.message);
    return null;
  }
}

/** 필터: since_id(커서, 초과분만) · since(ISO ts 이상) · kind/source(콤마 구분 다중) · limit(≤500) */
function list({ since_id, since, kind, source, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (since_id != null && since_id !== '') { where.push('id > ?'); args.push(Number(since_id)); }
  if (since) { where.push('ts >= ?'); args.push(String(since)); }
  for (const [col, val] of [['kind', kind], ['source', source]]) {
    if (!val) continue;
    const vals = String(val).split(',').map((v) => v.trim()).filter(Boolean);
    where.push(`${col} IN (${vals.map(() => '?').join(',')})`);
    args.push(...vals);
  }
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  // 커서 폴링이면 오래된 것부터, 아니면 최신부터
  const order = since_id != null && since_id !== '' ? 'ASC' : 'DESC';
  const rows = db.prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id ${order} LIMIT ${n}`).all(...args);
  const events = rows.map(({ data_json, ...r }) => ({ ...r, data: data_json ? JSON.parse(data_json) : null }));
  const next_since_id = events.reduce((m, e) => Math.max(m, e.id), Number(since_id) || 0);
  return { events, next_since_id };
}

module.exports = { record, list, htmlToText };
