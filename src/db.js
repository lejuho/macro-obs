// node:sqlite (Node 22+) — 네이티브 의존성 제로.
// 마이그레이션: PRAGMA user_version 기반. 기존 DB에 안전하게 컬럼/테이블 추가.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('./config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

// --- migrations ---
const MIGRATIONS = [
  // v1 → v2: Phase 1 (커밋 루프)
  `
  CREATE TABLE IF NOT EXISTS predictions (
    id            INTEGER PRIMARY KEY,
    alert_id      INTEGER NOT NULL REFERENCES alerts(id),
    statement     TEXT NOT NULL,
    expected_low  REAL,
    expected_high REAL,
    target_date   TEXT NOT NULL,
    actual_value  REAL,
    score         TEXT CHECK (score IN ('hit','miss','partial','void','manual')),
    committed_at  TEXT DEFAULT (datetime('now')),
    graded_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY, value TEXT
  );
  ALTER TABLE alerts ADD COLUMN nag_count INTEGER DEFAULT 0;
  ALTER TABLE alerts ADD COLUMN last_nag_at TEXT;
  `,
];
let v = db.prepare('PRAGMA user_version').get().user_version;
while (v < MIGRATIONS.length) {
  db.exec('BEGIN');
  try {
    db.exec(MIGRATIONS[v]);
    v++;
    db.exec(`PRAGMA user_version = ${v}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const stmts = {
  upsertIndicator: db.prepare(`
    INSERT INTO indicators (source, source_code, name, freq, unit, category)
    VALUES (@source, @source_code, @name, @freq, @unit, @category)
    ON CONFLICT(source, source_code) DO UPDATE SET name=excluded.name
    RETURNING id`),
  upsertObs: db.prepare(`
    INSERT INTO observations (indicator_id, date, value)
    VALUES (?, ?, ?)
    ON CONFLICT(indicator_id, date) DO UPDATE SET value=excluded.value`),
  lastNObs: db.prepare(`
    SELECT date, value FROM observations
    WHERE indicator_id = ? ORDER BY date DESC LIMIT ?`),
  activeHypotheses: db.prepare(`
    SELECT h.*, i.name AS indicator_name, i.unit
    FROM hypotheses h JOIN indicators i ON i.id = h.indicator_id
    WHERE h.status = 'active'`),
  lastAlertFor: db.prepare(`
    SELECT triggered_at FROM alerts
    WHERE hypothesis_id = ? AND kind = 'band_breach'
    ORDER BY triggered_at DESC LIMIT 1`),
  insertAlert: db.prepare(`
    INSERT INTO alerts (kind, hypothesis_id, observed_value, observed_date, direction)
    VALUES ('band_breach', @hypothesis_id, @observed_value, @observed_date, @direction)
    RETURNING id`),
  setAlertTgId: db.prepare(`UPDATE alerts SET tg_message_id = ? WHERE id = ?`),
  // Phase 1
  alertByTgId: db.prepare(`
    SELECT a.*, h.statement AS hyp_statement, h.indicator_id, i.name AS indicator_name, i.unit
    FROM alerts a
    JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE a.tg_message_id = ?`),
  insertPrediction: db.prepare(`
    INSERT INTO predictions (alert_id, statement, expected_low, expected_high, target_date)
    VALUES (@alert_id, @statement, @expected_low, @expected_high, @target_date)
    RETURNING id`),
  setAlertStatus: db.prepare(`UPDATE alerts SET status = ? WHERE id = ?`),
  dueForGrading: db.prepare(`
    SELECT p.*, a.hypothesis_id, h.indicator_id, h.statement AS hyp_statement,
           i.name AS indicator_name, i.unit
    FROM predictions p
    JOIN alerts a ON a.id = p.alert_id
    JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE p.graded_at IS NULL AND p.target_date <= date('now')`),
  obsOnOrBefore: db.prepare(`
    SELECT date, value FROM observations
    WHERE indicator_id = ? AND date <= ?
    ORDER BY date DESC LIMIT 1`),
  gradePrediction: db.prepare(`
    UPDATE predictions SET actual_value = ?, score = ?, graded_at = datetime('now')
    WHERE id = ?`),
  openAlertsToNag: db.prepare(`
    SELECT a.*, h.statement AS hyp_statement, i.name AS indicator_name, i.unit
    FROM alerts a
    JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE a.status = 'open' AND a.nag_count < 3
      AND (a.last_nag_at IS NULL OR a.last_nag_at <= datetime('now','-1 day'))
      AND a.triggered_at <= datetime('now','-1 day')`),
  bumpNag: db.prepare(`
    UPDATE alerts SET nag_count = nag_count + 1, last_nag_at = datetime('now') WHERE id = ?`),
  kvGet: db.prepare(`SELECT value FROM kv WHERE key = ?`),
  kvSet: db.prepare(`
    INSERT INTO kv (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  obsSince: db.prepare(`
    SELECT date, value FROM observations
    WHERE indicator_id = ? AND date >= ? ORDER BY date`),
  hypById: db.prepare(`
    SELECT h.*, i.name AS indicator_name, i.unit
    FROM hypotheses h JOIN indicators i ON i.id = h.indicator_id
    WHERE h.id = ?`),
  reviseHyp: db.prepare(`
    INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, window_rule, rationale, revised_from)
    SELECT @statement, indicator_id, @band_low, @band_high, window_rule, @rationale, id
    FROM hypotheses WHERE id = @old_id
    RETURNING id`),
  retireHyp: db.prepare(`UPDATE hypotheses SET status = 'revised' WHERE id = ?`),
  trackRecord: db.prepare(`
    SELECT i.name AS indicator_name, p.score, COUNT(*) AS n
    FROM predictions p
    JOIN alerts a ON a.id = p.alert_id
    JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE p.graded_at IS NOT NULL
    GROUP BY i.name, p.score`),
};

module.exports = { db, stmts, tx };
