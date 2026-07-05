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
  // v2 → v3: Phase 2 (DART 노출 매트릭스)
  `
  CREATE TABLE IF NOT EXISTS corps (
    corp_code  TEXT PRIMARY KEY,   -- DART 8자리 고유번호
    stock_code TEXT UNIQUE,        -- 종목코드 6자리
    name       TEXT NOT NULL,
    industry   TEXT,               -- 수동/추출 보완
    is_target  INTEGER DEFAULT 0   -- 추출 대상 여부
  );
  CREATE TABLE IF NOT EXISTS exposures (
    id            INTEGER PRIMARY KEY,
    corp_code     TEXT NOT NULL REFERENCES corps(corp_code),
    fy            INTEGER NOT NULL,   -- 사업연도
    reprt_code    TEXT NOT NULL,      -- 11011 사업 / 11012 반기 / 11013 1Q / 11014 3Q
    rcept_no      TEXT,               -- 원문 접수번호 (검증 추적용)
    export_ratio        REAL,   -- 매출 중 수출 비중 (0~1)
    usd_revenue_ratio   REAL,   -- 달러표시 매출 비중 (0~1, 미공시 시 null)
    fx_debt_ratio       REAL,   -- 차입금 중 외화 비중 (0~1)
    float_rate_ratio    REAL,   -- 차입금 중 변동금리 비중 (0~1)
    import_deps         TEXT,   -- 주요 수입 원자재/부품 JSON 배열
    evidence            TEXT,   -- 근거 인용 JSON {field: "보고서 원문 구절"}
    raw_json            TEXT,   -- LLM 출력 원본
    extracted_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(corp_code, fy, reprt_code)
  );
  CREATE INDEX IF NOT EXISTS idx_exp_lookup ON exposures(fy, reprt_code);
  `,
  // v3 → v4: Phase 3 (의존성 그래프 + 시나리오)
  `
  CREATE TABLE IF NOT EXISTS nodes (
    id        INTEGER PRIMARY KEY,
    type      TEXT NOT NULL CHECK (type IN
      ('country','relation','chokepoint','flow','industry','firm','macro')),
    name      TEXT NOT NULL,
    meta_json TEXT,
    UNIQUE(type, name)
  );
  CREATE TABLE IF NOT EXISTS edges (
    id             INTEGER PRIMARY KEY,
    src            INTEGER NOT NULL REFERENCES nodes(id),
    dst            INTEGER NOT NULL REFERENCES nodes(id),
    kind           TEXT NOT NULL CHECK (kind IN
      ('supply','demand','transit','policy','coercion_transfer')),
    sign           INTEGER NOT NULL CHECK (sign IN (1,-1)),
    weight         REAL NOT NULL,
    hhi            REAL,
    path_note      TEXT NOT NULL,
    condition_note TEXT,
    leverage_note  TEXT,
    source         TEXT DEFAULT 'manual',
    updated_at     TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
  CREATE TABLE IF NOT EXISTS scenarios (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    shocks_json     TEXT NOT NULL,
    trigger_hint    TEXT,
    linked_case_ids TEXT,
    computed_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS scenario_results (
    scenario_id INTEGER NOT NULL REFERENCES scenarios(id),
    node_id     INTEGER NOT NULL REFERENCES nodes(id),
    impact      REAL NOT NULL,
    hops        INTEGER NOT NULL,
    path_json   TEXT NOT NULL,
    PRIMARY KEY (scenario_id, node_id, path_json)
  );
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
  // Phase 2
  upsertCorp: db.prepare(`
    INSERT INTO corps (corp_code, stock_code, name)
    VALUES (@corp_code, @stock_code, @name)
    ON CONFLICT(corp_code) DO UPDATE SET stock_code=excluded.stock_code, name=excluded.name`),
  markTarget: db.prepare(`UPDATE corps SET is_target = 1 WHERE stock_code = ?`),
  targets: db.prepare(`SELECT * FROM corps WHERE is_target = 1 ORDER BY stock_code`),
  hasExposure: db.prepare(`
    SELECT 1 FROM exposures WHERE corp_code = ? AND fy = ? AND reprt_code = ?`),
  upsertExposure: db.prepare(`
    INSERT INTO exposures (corp_code, fy, reprt_code, rcept_no,
      export_ratio, usd_revenue_ratio, fx_debt_ratio, float_rate_ratio,
      import_deps, evidence, raw_json)
    VALUES (@corp_code, @fy, @reprt_code, @rcept_no,
      @export_ratio, @usd_revenue_ratio, @fx_debt_ratio, @float_rate_ratio,
      @import_deps, @evidence, @raw_json)
    ON CONFLICT(corp_code, fy, reprt_code) DO UPDATE SET
      export_ratio=excluded.export_ratio, usd_revenue_ratio=excluded.usd_revenue_ratio,
      fx_debt_ratio=excluded.fx_debt_ratio, float_rate_ratio=excluded.float_rate_ratio,
      import_deps=excluded.import_deps, evidence=excluded.evidence,
      raw_json=excluded.raw_json, rcept_no=excluded.rcept_no,
      extracted_at=datetime('now')`),
  topExposed: db.prepare(`
    WITH ranked AS (
      SELECT corp_code, MAX(fy * 10 + CASE reprt_code
        WHEN '11013' THEN 1 WHEN '11012' THEN 2
        WHEN '11014' THEN 3 ELSE 4 END) AS rk
      FROM exposures GROUP BY corp_code
    )
    SELECT c.name, c.stock_code, c.industry,
           e.export_ratio, e.fx_debt_ratio, e.float_rate_ratio,
           COALESCE(e.export_ratio, 0) * @w_export
         + COALESCE(e.fx_debt_ratio, 0) * @w_fxdebt
         + COALESCE(e.float_rate_ratio, 0) * @w_float AS score
    FROM exposures e
    JOIN corps c ON c.corp_code = e.corp_code
    JOIN ranked r ON r.corp_code = e.corp_code
      AND (e.fy * 10 + CASE e.reprt_code
        WHEN '11013' THEN 1 WHEN '11012' THEN 2
        WHEN '11014' THEN 3 ELSE 4 END) = r.rk
    WHERE score > 0
    ORDER BY score DESC LIMIT @limit`),
  // Phase 3
  upsertNode: db.prepare(`
    INSERT INTO nodes (type, name, meta_json) VALUES (@type, @name, @meta_json)
    ON CONFLICT(type, name) DO UPDATE SET meta_json=excluded.meta_json
    RETURNING id`),
  nodeByName: db.prepare(`SELECT * FROM nodes WHERE name = ?`),
  scenariosHittingNode: db.prepare(`
    SELECT s.id, s.name, r.impact, r.hops FROM scenario_results r
    JOIN scenarios s ON s.id = r.scenario_id
    JOIN nodes n ON n.id = r.node_id
    WHERE n.name LIKE ?
    ORDER BY ABS(r.impact) DESC`),
  insertEdge: db.prepare(`
    INSERT INTO edges (src, dst, kind, sign, weight, hhi, source, path_note, condition_note, leverage_note)
    VALUES (@src, @dst, @kind, @sign, @weight, @hhi, @source, @path_note, @condition_note, @leverage_note)`),
  edgesFrom: db.prepare(`
    SELECT e.*, n.name AS dst_name, n.type AS dst_type
    FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ?`),
  clearGraph: db.prepare(`DELETE FROM edges`),
  clearNodes: db.prepare(`DELETE FROM nodes`),
  upsertScenario: db.prepare(`
    INSERT INTO scenarios (name, shocks_json, trigger_hint)
    VALUES (@name, @shocks_json, @trigger_hint)
    ON CONFLICT(name) DO UPDATE SET shocks_json=excluded.shocks_json,
      trigger_hint=excluded.trigger_hint
    RETURNING id`),
  allScenarios: db.prepare(`SELECT * FROM scenarios ORDER BY id`),
  scenarioById: db.prepare(`SELECT * FROM scenarios WHERE id = ?`),
  clearScenarioResults: db.prepare(`DELETE FROM scenario_results WHERE scenario_id = ?`),
  insertScenarioResult: db.prepare(`
    INSERT OR REPLACE INTO scenario_results (scenario_id, node_id, impact, hops, path_json)
    VALUES (?, ?, ?, ?, ?)`),
  markScenarioComputed: db.prepare(`
    UPDATE scenarios SET computed_at = datetime('now') WHERE id = ?`),
  scenarioResults: db.prepare(`
    SELECT r.*, n.name, n.type FROM scenario_results r
    JOIN nodes n ON n.id = r.node_id
    WHERE r.scenario_id = ? ORDER BY ABS(r.impact) DESC`),
  trackRecord: db.prepare(`
    SELECT i.name AS indicator_name, p.score, COUNT(*) AS n
    FROM predictions p
    JOIN alerts a ON a.id = p.alert_id
    JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE p.graded_at IS NOT NULL
    GROUP BY i.name, p.score`),
};

module.exports = { db, stmts, tx, MIGRATION_COUNT: MIGRATIONS.length };
