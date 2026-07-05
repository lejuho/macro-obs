-- macro-obs Phase 0 schema
-- 스펙 §3의 부분집합. Phase 1+ 테이블(predictions/triggers/graph)은 추후 마이그레이션으로 추가.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS indicators (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  source_code TEXT,
  name        TEXT NOT NULL,
  freq        TEXT NOT NULL CHECK (freq IN ('D','W','M','Q','A')),
  unit        TEXT,
  category    TEXT DEFAULT 'macro',
  UNIQUE(source, source_code)
);

CREATE TABLE IF NOT EXISTS observations (
  indicator_id INTEGER NOT NULL REFERENCES indicators(id),
  date         TEXT NOT NULL,
  value        REAL NOT NULL,
  ingested_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (indicator_id, date)
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id           INTEGER PRIMARY KEY,
  statement    TEXT NOT NULL,
  indicator_id INTEGER NOT NULL REFERENCES indicators(id),
  band_low     REAL,
  band_high    REAL,
  window_rule  TEXT DEFAULT 'close_3',   -- 'close_N': 연속 N회 관측 이탈 시 확정
  rationale    TEXT NOT NULL,
  status       TEXT DEFAULT 'active' CHECK (status IN ('active','revised','retired')),
  revised_from INTEGER REFERENCES hypotheses(id),
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,          -- 'band_breach' (Phase 0)
  hypothesis_id  INTEGER REFERENCES hypotheses(id),
  observed_value REAL,
  observed_date  TEXT,
  direction      TEXT,                   -- 'above' | 'below'
  triggered_at   TEXT DEFAULT (datetime('now')),
  status         TEXT DEFAULT 'open' CHECK (status IN ('open','committed','graded','muted')),
  tg_message_id  INTEGER
);

-- 재알림 쿨다운 판정용
CREATE INDEX IF NOT EXISTS idx_alerts_hyp_time ON alerts(hypothesis_id, triggered_at);
CREATE INDEX IF NOT EXISTS idx_obs_date ON observations(indicator_id, date DESC);
