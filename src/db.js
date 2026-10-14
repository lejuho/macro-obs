// node:sqlite (Node 22+) — 네이티브 의존성 제로.
// 마이그레이션: PRAGMA user_version 기반. 기존 DB에 안전하게 컬럼/테이블 추가.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('./config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
// 여러 프로세스(cron 잡·bot·web)가 동시에 쓰므로 lock 시 즉시 실패하지 말고 대기
db.exec('PRAGMA busy_timeout = 5000');
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
  // v4 → v5: 지표 노브 문장 (계기판 해석 힌트)
  `
  ALTER TABLE indicators ADD COLUMN note TEXT;
  `,
  // v5 → v6: 결정 트리거 (스펙 §3.4 — 평온할 때 쓰는 지시서)
  `
  CREATE TABLE IF NOT EXISTS triggers (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    conditions_json TEXT NOT NULL,   -- [{indicator_id, op, value}] AND 결합
    action_text     TEXT NOT NULL,   -- 평온할 때 쓴 지시서 원문
    scenario_id     INTEGER REFERENCES scenarios(id),
    armed           INTEGER DEFAULT 1,
    fired_at        TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );
  ALTER TABLE alerts ADD COLUMN trigger_id INTEGER REFERENCES triggers(id);
  `,
  // v6 → v7: HHI 검증용 무역 점유율 캐시 (Phase 4b)
  `
  CREATE TABLE IF NOT EXISTS trade_shares (
    node_name  TEXT NOT NULL,     -- 해도 flow 노드명
    hs         TEXT NOT NULL,     -- HS 코드
    partner    TEXT NOT NULL,     -- 상대국
    value_usd  REAL NOT NULL,
    period     TEXT NOT NULL,     -- 'YYYY' 연간
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (node_name, hs, partner, period)
  );
  `,
  // v7 → v8: 선거 캘린더 + 정책 레버 (Phase 4c)
  `
  CREATE TABLE IF NOT EXISTS elections (
    id      INTEGER PRIMARY KEY,
    country TEXT NOT NULL,
    body    TEXT NOT NULL,          -- 'president'|'parliament'|'party_congress'|'midterm'
    date    TEXT NOT NULL,          -- 근사치 허용, note에 명시
    note    TEXT,
    UNIQUE(country, body, date)
  );
  CREATE TABLE IF NOT EXISTS policy_levers (
    id             INTEGER PRIMARY KEY,
    election_id    INTEGER NOT NULL REFERENCES elections(id),
    outcome_branch TEXT NOT NULL,   -- 'A 승리' 같은 분기
    lever          TEXT NOT NULL,   -- 바뀌는 정책 레버
    scenario_name  TEXT,            -- 연결 시나리오 (id는 재시드로 변하므로 이름 참조)
    note           TEXT,
    updated_at     TEXT DEFAULT (datetime('now'))
  );
  `,
  // v8 → v9: 뉴스 프레이밍 diff (Phase 5)
  `
  CREATE TABLE IF NOT EXISTS news_items (
    id          INTEGER PRIMARY KEY,
    link        TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,               -- API 제공 요약만. 본문 전문 저장 금지 (저작권)
    source      TEXT,               -- 매체명 (도메인 매핑)
    spectrum    TEXT,               -- 'A'|'B'|'wire'|'econ'|'official'|'unknown' (축 라벨 — data/press-map.js)
    pub_date    TEXT,
    query       TEXT NOT NULL,
    cluster_id  INTEGER REFERENCES news_clusters(id),
    is_noise    INTEGER DEFAULT 0,
    ingested_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_news_query ON news_items(query, ingested_at);
  CREATE TABLE IF NOT EXISTS news_clusters (
    id         INTEGER PRIMARY KEY,
    event_key  TEXT UNIQUE NOT NULL,  -- LLM이 부여하는 사건 슬러그 (연속성 유지)
    title      TEXT NOT NULL,
    query      TEXT NOT NULL,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen  TEXT DEFAULT (datetime('now')),
    status     TEXT DEFAULT 'open' CHECK (status IN ('open','revisited','ignored'))
  );
  CREATE TABLE IF NOT EXISTS framing_snapshots (
    id           INTEGER PRIMARY KEY,
    cluster_id   INTEGER NOT NULL REFERENCES news_clusters(id),
    phase        TEXT NOT NULL CHECK (phase IN ('initial','revisit')),
    content_json TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS press_track (
    id         INTEGER PRIMARY KEY,
    cluster_id INTEGER NOT NULL REFERENCES news_clusters(id),
    source     TEXT NOT NULL,
    claim      TEXT NOT NULL,       -- 당시의 예측/단정 요지 (요약 재서술)
    verdict    TEXT NOT NULL CHECK (verdict IN ('held','failed','unclear')),
    note       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  `,
  // v9 → v10: origin 태깅 (MCP 3층 — human vs assisted 캘리브레이션 분리 실험)
  `
  ALTER TABLE predictions ADD COLUMN origin TEXT DEFAULT 'human'
    CHECK (origin IN ('human','assisted'));
  ALTER TABLE hypotheses ADD COLUMN origin TEXT DEFAULT 'human'
    CHECK (origin IN ('human','assisted'));
  `,
  // v10 → v11: 뉴스 사건의 관련국 태깅 (정치 구조 맥락은 snapshot JSON에 시점 고정)
  `
  ALTER TABLE news_clusters ADD COLUMN countries_json TEXT DEFAULT '[]';
  `,
  // 현재 관점(worldview) 복합 오버레이 커밋 + T+90 지도 보정
  `
  CREATE TABLE IF NOT EXISTS worldview_commits (
    id                     INTEGER PRIMARY KEY,
    thesis                 TEXT NOT NULL,
    horizon_days           INTEGER NOT NULL DEFAULT 90,
    target_date            TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','committed','review_pending','reviewed','cancelled')),
    graph_fingerprint      TEXT NOT NULL,
    graph_snapshot_json    TEXT NOT NULL,
    political_context_json TEXT NOT NULL,
    created_at             TEXT DEFAULT (datetime('now')),
    committed_at           TEXT,
    review_message_id      INTEGER
  );
  CREATE TABLE IF NOT EXISTS worldview_scenarios (
    commit_id             INTEGER NOT NULL REFERENCES worldview_commits(id),
    scenario_id           INTEGER NOT NULL REFERENCES scenarios(id),
    role                  TEXT NOT NULL CHECK (role IN ('primary','secondary','watch')),
    scenario_snapshot_json TEXT NOT NULL,
    PRIMARY KEY (commit_id, scenario_id)
  );
  CREATE TABLE IF NOT EXISTS worldview_paths (
    id          INTEGER PRIMARY KEY,
    commit_id   INTEGER NOT NULL REFERENCES worldview_commits(id),
    scenario_id INTEGER NOT NULL REFERENCES scenarios(id),
    node_id     INTEGER NOT NULL REFERENCES nodes(id),
    impact      REAL NOT NULL,
    hops        INTEGER NOT NULL,
    path_json   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_worldview_due ON worldview_commits(status, target_date);
  CREATE TABLE IF NOT EXISTS worldview_reviews (
    id                      INTEGER PRIMARY KEY,
    commit_id               INTEGER NOT NULL UNIQUE REFERENCES worldview_commits(id),
    outcome_summary         TEXT NOT NULL,
    scenario_verdicts_json  TEXT NOT NULL,
    path_verdicts_json      TEXT NOT NULL,
    missing_drivers_json    TEXT NOT NULL,
    revision_proposals_json TEXT NOT NULL,
    raw_json                TEXT NOT NULL,
    confirmed               INTEGER DEFAULT 0,
    user_note               TEXT,
    created_at              TEXT DEFAULT (datetime('now')),
    confirmed_at            TEXT
  );
  CREATE TABLE IF NOT EXISTS graph_revision_proposals (
    id            INTEGER PRIMARY KEY,
    review_id     INTEGER NOT NULL REFERENCES worldview_reviews(id),
    proposal_type TEXT NOT NULL,
    target_ref    TEXT,
    proposal_json TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','applied','rejected','manual_review')),
    created_at    TEXT DEFAULT (datetime('now')),
    resolved_at   TEXT
  );
  `,
  // 현재 관점 정량 판정: 경로별 observable 동결 + review 점수
  `
  CREATE TABLE IF NOT EXISTS worldview_observables (
    id                 INTEGER PRIMARY KEY,
    commit_id          INTEGER NOT NULL REFERENCES worldview_commits(id),
    path_id            INTEGER NOT NULL REFERENCES worldview_paths(id),
    indicator_id       INTEGER NOT NULL REFERENCES indicators(id),
    metric             TEXT NOT NULL CHECK (metric IN ('pct_change','delta')),
    expected_direction TEXT NOT NULL CHECK (expected_direction IN ('up','down')),
    threshold          REAL NOT NULL,
    lag_days           INTEGER NOT NULL DEFAULT 0,
    baseline_value     REAL,
    baseline_date      TEXT,
    actual_value       REAL,
    actual_date        TEXT,
    change_value       REAL,
    direction_score    REAL,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scored','void')),
    scored_at          TEXT,
    UNIQUE(path_id, indicator_id)
  );
  CREATE INDEX IF NOT EXISTS idx_worldview_observables_commit ON worldview_observables(commit_id);
  ALTER TABLE worldview_reviews ADD COLUMN quant_json TEXT DEFAULT '{}';
  `,
  // v?: 이벤트 로그 — 알림·판단·갱신을 외부 에이전트가 /api/events, MCP get_events로 폴링
  `
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY,
    ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    source     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    text       TEXT,
    data_json  TEXT,
    delivered  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  `,
  // OAuth 2.1 (MCP 원격 커넥터) + 외부 에이전트 보고서
  `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id          TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_name        TEXT,
    redirect_uris_json TEXT NOT NULL,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope          TEXT,
    resource       TEXT,
    owner          TEXT,
    expires_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash  TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id   TEXT NOT NULL,
    scope       TEXT,
    owner       TEXT,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_exp ON oauth_tokens(expires_at);
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY,
    ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    author     TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    event_ids_json TEXT,
    since_id   INTEGER,
    until_id   INTEGER,
    meta_json  TEXT
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
    INSERT INTO indicators (source, source_code, name, freq, unit, category, note)
    VALUES (@source, @source_code, @name, @freq, @unit, @category, @note)
    ON CONFLICT(source, source_code) DO UPDATE SET name=excluded.name, note=excluded.note
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
  openAlertForDirection: db.prepare(`
    SELECT id FROM alerts
    WHERE hypothesis_id = ? AND direction = ? AND kind = 'band_breach' AND status = 'open'
    LIMIT 1`),
  refreshAlert: db.prepare(`
    UPDATE alerts SET observed_value = @observed_value, observed_date = @observed_date,
      triggered_at = datetime('now'), nag_count = 0, last_nag_at = NULL
    WHERE id = @id`),
  pendingPredictionForDirection: db.prepare(`
    SELECT p.id, p.statement, p.target_date
    FROM predictions p
    JOIN alerts a ON a.id = p.alert_id
    WHERE a.hypothesis_id = ? AND a.direction = ?
      AND p.graded_at IS NULL
    ORDER BY p.committed_at DESC LIMIT 1`),
  insertAlert: db.prepare(`
    INSERT INTO alerts (kind, hypothesis_id, observed_value, observed_date, direction)
    VALUES ('band_breach', @hypothesis_id, @observed_value, @observed_date, @direction)
    RETURNING id`),
  setAlertTgId: db.prepare(`UPDATE alerts SET tg_message_id = ? WHERE id = ?`),
  // Phase 1
  alertByTgId: db.prepare(`
    SELECT a.*, h.statement AS hyp_statement, h.indicator_id, i.name AS indicator_name, i.unit
    FROM alerts a
    LEFT JOIN hypotheses h ON h.id = a.hypothesis_id
    LEFT JOIN indicators i ON i.id = h.indicator_id
    WHERE a.tg_message_id = ?`),
  insertPrediction: db.prepare(`
    INSERT INTO predictions (alert_id, statement, expected_low, expected_high, target_date)
    VALUES (@alert_id, @statement, @expected_low, @expected_high, @target_date)
    RETURNING id`),
  setAlertStatus: db.prepare(`UPDATE alerts SET status = ? WHERE id = ?`),
  dueForGrading: db.prepare(`
    SELECT p.*, a.hypothesis_id, h.indicator_id, h.statement AS hyp_statement,
           i.name AS indicator_name, i.unit, i.freq
    FROM predictions p
    JOIN alerts a ON a.id = p.alert_id
    JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE p.graded_at IS NULL AND p.target_date <= date('now')`),
  obsOnOrBefore: db.prepare(`
    SELECT date, value FROM observations
    WHERE indicator_id = ? AND date <= ?
    ORDER BY date DESC LIMIT 1`),
  // 월/분기 지표: target_date가 속한 기간의 관측 (공표 지연 때문에 target_date 이후에야 생긴다)
  obsInPeriod: db.prepare(`
    SELECT date, value FROM observations
    WHERE indicator_id = ? AND date >= ? AND date < ?
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
  // Phase 4: 트리거 + 지표 조회
  indicatorsList: db.prepare(`
    SELECT i.id, i.source, i.source_code, i.name, i.unit,
      (SELECT value FROM observations o WHERE o.indicator_id = i.id ORDER BY date DESC LIMIT 1) AS latest
    FROM indicators i ORDER BY i.id`),
  latestValue: db.prepare(`
    SELECT value, date FROM observations WHERE indicator_id = ? ORDER BY date DESC LIMIT 1`),
  insertTrigger: db.prepare(`
    INSERT INTO triggers (name, conditions_json, action_text, scenario_id)
    VALUES (@name, @conditions_json, @action_text, @scenario_id) RETURNING id`),
  armedTriggers: db.prepare(`SELECT * FROM triggers WHERE armed = 1`),
  allTriggers: db.prepare(`SELECT * FROM triggers ORDER BY id`),
  fireTrigger: db.prepare(`
    UPDATE triggers SET armed = 0, fired_at = datetime('now') WHERE id = ?`),
  armTrigger: db.prepare(`UPDATE triggers SET armed = 1, fired_at = NULL WHERE id = ?`),
  delTrigger: db.prepare(`DELETE FROM triggers WHERE id = ?`),
  insertTriggerAlert: db.prepare(`
    INSERT INTO alerts (kind, trigger_id) VALUES ('trigger_fired', @trigger_id) RETURNING id`),
  upsertTradeShare: db.prepare(`
    INSERT OR REPLACE INTO trade_shares (node_name, hs, partner, value_usd, period)
    VALUES (@node_name, @hs, @partner, @value_usd, @period)`),
  tradeSharesFor: db.prepare(`
    SELECT partner, SUM(value_usd) AS v FROM trade_shares
    WHERE node_name = ? AND period = ? GROUP BY partner ORDER BY v DESC`),
  tradeEdgesInto: db.prepare(`
    SELECT e.id, e.weight, e.hhi, e.kind, s.name AS src_name, d.name AS dst_name
    FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
    WHERE d.name = ? AND e.source LIKE 'manual:trade%' AND e.kind IN ('supply','transit')`),
  setEdgeHhi: db.prepare(`UPDATE edges SET hhi = ?, updated_at = datetime('now') WHERE id = ?`),
  upsertElection: db.prepare(`
    INSERT INTO elections (country, body, date, note) VALUES (@country, @body, @date, @note)
    ON CONFLICT(country, body, date) DO UPDATE SET note=excluded.note RETURNING id`),
  upcomingElections: db.prepare(`
    SELECT * FROM elections WHERE date >= date('now') ORDER BY date LIMIT ?`),
  insertLever: db.prepare(`
    INSERT INTO policy_levers (election_id, outcome_branch, lever, scenario_name, note)
    VALUES (@election_id, @outcome_branch, @lever, @scenario_name, @note)`),
  leversFor: db.prepare(`SELECT * FROM policy_levers WHERE election_id = ? ORDER BY outcome_branch, id`),
  clearLevers: db.prepare(`DELETE FROM policy_levers WHERE election_id = ?`),
  // Phase 5
  insertNewsItem: db.prepare(`
    INSERT OR IGNORE INTO news_items (link, title, description, source, spectrum, pub_date, query)
    VALUES (@link, @title, @description, @source, @spectrum, @pub_date, @query)`),
  unclusteredItems: db.prepare(`
    SELECT * FROM news_items WHERE query = ? AND cluster_id IS NULL AND is_noise = 0
    AND ingested_at >= datetime('now', '-2 day') ORDER BY id`),
  markNoise: db.prepare(`UPDATE news_items SET is_noise = 1 WHERE id = ?`),
  recentClusters: db.prepare(`
    SELECT * FROM news_clusters WHERE query = ? AND last_seen >= datetime('now', '-14 day')
    ORDER BY last_seen DESC LIMIT 10`),
  clusterByKey: db.prepare(`SELECT * FROM news_clusters WHERE event_key = ?`),
  insertCluster: db.prepare(`
    INSERT INTO news_clusters (event_key, title, query, countries_json)
    VALUES (@event_key, @title, @query, @countries_json)
    RETURNING id`),
  touchCluster: db.prepare(`UPDATE news_clusters SET last_seen = datetime('now') WHERE id = ?`),
  // 소급 클러스터링: 사건 날짜(기사 pub_date) 기준으로 first_seen/last_seen — 90일 재방문 시점이 실제 사건에 맞도록
  insertClusterAt: db.prepare(`
    INSERT INTO news_clusters (event_key, title, query, countries_json, first_seen, last_seen)
    VALUES (@event_key, @title, @query, @countries_json, @first_seen, @last_seen)
    RETURNING id`),
  touchClusterAt: db.prepare(`UPDATE news_clusters SET last_seen = max(last_seen, ?) WHERE id = ?`),
  clustersAround: db.prepare(`
    SELECT * FROM news_clusters WHERE query = ?
    AND last_seen >= datetime(?, '-14 day') AND first_seen <= datetime(?, '+3 day')
    ORDER BY last_seen DESC LIMIT 15`),
  setClusterCountries: db.prepare(`UPDATE news_clusters SET countries_json = ? WHERE id = ?`),
  assignCluster: db.prepare(`UPDATE news_items SET cluster_id = ? WHERE id = ?`),
  insertSnapshot: db.prepare(`
    INSERT INTO framing_snapshots (cluster_id, phase, content_json) VALUES (?, ?, ?)`),
  snapshotFor: db.prepare(`
    SELECT * FROM framing_snapshots WHERE cluster_id = ? AND phase = ? ORDER BY id DESC LIMIT 1`),
  dueRevisit: db.prepare(`
    SELECT * FROM news_clusters WHERE status = 'open'
    AND first_seen <= datetime('now', '-90 day') ORDER BY first_seen LIMIT 3`),
  markRevisited: db.prepare(`UPDATE news_clusters SET status = 'revisited' WHERE id = ?`),
  clusterItems: db.prepare(`
    SELECT title, description, source, spectrum, pub_date FROM news_items
    WHERE cluster_id = ? ORDER BY pub_date LIMIT 40`),
  insertPressTrack: db.prepare(`
    INSERT INTO press_track (cluster_id, source, claim, verdict, note)
    VALUES (@cluster_id, @source, @claim, @verdict, @note)`),
  pressTrackAgg: db.prepare(`
    SELECT source, verdict, COUNT(*) AS n FROM press_track GROUP BY source, verdict`),
  newsClustersRecent: db.prepare(`
    SELECT c.*, COUNT(i.id) AS items,
      SUM(CASE WHEN i.spectrum='A' THEN 1 ELSE 0 END) AS a_cnt,
      SUM(CASE WHEN i.spectrum='B' THEN 1 ELSE 0 END) AS b_cnt,
      SUM(CASE WHEN i.spectrum='econ' THEN 1 ELSE 0 END) AS e_cnt
    FROM news_clusters c LEFT JOIN news_items i ON i.cluster_id = c.id
    GROUP BY c.id ORDER BY c.last_seen DESC LIMIT ?`),
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
    SELECT i.name AS indicator_name, p.origin, p.score, COUNT(*) AS n
    FROM predictions p
    JOIN alerts a ON a.id = p.alert_id
    JOIN hypotheses h ON h.id = a.hypothesis_id
    JOIN indicators i ON i.id = h.indicator_id
    WHERE p.graded_at IS NOT NULL
    GROUP BY i.name, p.origin, p.score`),
  originSummary: db.prepare(`
    SELECT origin, score, COUNT(*) AS n FROM predictions
    WHERE graded_at IS NOT NULL GROUP BY origin, score`),
  setPredictionOrigin: db.prepare(`UPDATE predictions SET origin = ? WHERE id = ?`),
  setHypOrigin: db.prepare(`UPDATE hypotheses SET origin = ? WHERE id = ?`),
  // 현재 관점 복합 오버레이
  insertWorldview: db.prepare(`
    INSERT INTO worldview_commits
      (thesis, horizon_days, target_date, graph_fingerprint, graph_snapshot_json, political_context_json)
    VALUES (@thesis, @horizon_days, @target_date, @graph_fingerprint, @graph_snapshot_json, @political_context_json)
    RETURNING id`),
  insertWorldviewScenario: db.prepare(`
    INSERT INTO worldview_scenarios (commit_id, scenario_id, role, scenario_snapshot_json)
    VALUES (@commit_id, @scenario_id, @role, @scenario_snapshot_json)`),
  insertWorldviewPath: db.prepare(`
    INSERT INTO worldview_paths (commit_id, scenario_id, node_id, impact, hops, path_json)
    VALUES (@commit_id, @scenario_id, @node_id, @impact, @hops, @path_json) RETURNING id`),
  insertWorldviewObservable: db.prepare(`
    INSERT INTO worldview_observables
      (commit_id,path_id,indicator_id,metric,expected_direction,threshold,lag_days,baseline_value,baseline_date)
    VALUES (@commit_id,@path_id,@indicator_id,@metric,@expected_direction,@threshold,@lag_days,@baseline_value,@baseline_date)`),
  worldviewObservables: db.prepare(`
    SELECT wo.*,i.name AS indicator_name,i.unit,wp.impact,wp.scenario_id,n.name AS node_name
    FROM worldview_observables wo JOIN indicators i ON i.id=wo.indicator_id
    JOIN worldview_paths wp ON wp.id=wo.path_id JOIN nodes n ON n.id=wp.node_id
    WHERE wo.commit_id=? ORDER BY ABS(wp.impact) DESC,wo.id`),
  scoreWorldviewObservable: db.prepare(`
    UPDATE worldview_observables SET actual_value=@actual_value,actual_date=@actual_date,
      change_value=@change_value,direction_score=@direction_score,status=@status,scored_at=datetime('now')
    WHERE id=@id`),
  worldviewById: db.prepare(`SELECT * FROM worldview_commits WHERE id = ?`),
  latestWorldview: db.prepare(`
    SELECT * FROM worldview_commits WHERE status IN ('committed','review_pending','reviewed')
    ORDER BY committed_at DESC, id DESC LIMIT 1`),
  recentWorldviews: db.prepare(`SELECT * FROM worldview_commits ORDER BY id DESC LIMIT ?`),
  worldviewScenarios: db.prepare(`
    SELECT ws.*, s.name FROM worldview_scenarios ws JOIN scenarios s ON s.id=ws.scenario_id
    WHERE ws.commit_id = ? ORDER BY CASE ws.role WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END, ws.scenario_id`),
  worldviewPaths: db.prepare(`
    SELECT wp.*, n.name, n.type, s.name AS scenario_name
    FROM worldview_paths wp JOIN nodes n ON n.id=wp.node_id JOIN scenarios s ON s.id=wp.scenario_id
    WHERE wp.commit_id = ? ORDER BY ABS(wp.impact) DESC`),
  commitWorldview: db.prepare(`
    UPDATE worldview_commits SET status='committed', committed_at=datetime('now')
    WHERE id=? AND status='draft'`),
  cancelWorldview: db.prepare(`UPDATE worldview_commits SET status='cancelled' WHERE id=? AND status='draft'`),
  dueWorldviewReviews: db.prepare(`
    SELECT * FROM worldview_commits WHERE status='committed' AND target_date <= date('now')
    ORDER BY target_date LIMIT 1`),
  setWorldviewReviewPending: db.prepare(`
    UPDATE worldview_commits SET status='review_pending', review_message_id=@message_id WHERE id=@id`),
  insertWorldviewReview: db.prepare(`
    INSERT INTO worldview_reviews
      (commit_id,outcome_summary,scenario_verdicts_json,path_verdicts_json,missing_drivers_json,revision_proposals_json,raw_json,quant_json)
    VALUES (@commit_id,@outcome_summary,@scenario_verdicts_json,@path_verdicts_json,@missing_drivers_json,@revision_proposals_json,@raw_json,@quant_json)
    RETURNING id`),
  worldviewReview: db.prepare(`SELECT * FROM worldview_reviews WHERE commit_id=?`),
  confirmWorldviewReview: db.prepare(`
    UPDATE worldview_reviews SET confirmed=1,user_note=@user_note,confirmed_at=datetime('now') WHERE commit_id=@commit_id`),
  finishWorldviewReview: db.prepare(`UPDATE worldview_commits SET status='reviewed' WHERE id=?`),
  insertGraphProposal: db.prepare(`
    INSERT INTO graph_revision_proposals (review_id,proposal_type,target_ref,proposal_json,status)
    VALUES (@review_id,@proposal_type,@target_ref,@proposal_json,@status) RETURNING id`),
  pendingGraphProposals: db.prepare(`
    SELECT gp.*, wr.commit_id FROM graph_revision_proposals gp
    JOIN worldview_reviews wr ON wr.id=gp.review_id WHERE gp.status='pending' ORDER BY gp.id`),
  graphProposalsForCommit: db.prepare(`
    SELECT gp.*, wr.commit_id FROM graph_revision_proposals gp
    JOIN worldview_reviews wr ON wr.id=gp.review_id WHERE wr.commit_id=? ORDER BY gp.id`),
  graphProposalById: db.prepare(`SELECT * FROM graph_revision_proposals WHERE id=?`),
  resolveGraphProposal: db.prepare(`
    UPDATE graph_revision_proposals SET status=?,resolved_at=datetime('now') WHERE id=?`),
};

module.exports = { db, stmts, tx, MIGRATION_COUNT: MIGRATIONS.length };
