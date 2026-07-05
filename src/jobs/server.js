// PWA 웹서버 (Phase 3b) — node:http, 의존성 제로.
// LAN/테일넷 전용 설계 (인증 없음 — 공인망에 노출 금지).
// 실행: node src/jobs/server.js   (systemd: deploy/macro-obs-web.service)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, stmts } = require('../db');

const PORT = Number(process.env.WEB_PORT || 8787);
const PUB = path.join(__dirname, '..', '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// --- API handlers (테스트에서 직접 호출 가능하도록 분리) ---
const api = {
  status() {
    const hyps = db.prepare(`
      SELECT h.id, h.statement, h.band_low, h.band_high, h.window_rule, h.rationale,
             h.indicator_id, i.name AS indicator_name, i.unit,
        (SELECT value FROM observations o WHERE o.indicator_id = h.indicator_id ORDER BY date DESC LIMIT 1) AS latest,
        (SELECT date  FROM observations o WHERE o.indicator_id = h.indicator_id ORDER BY date DESC LIMIT 1) AS latest_date
      FROM hypotheses h JOIN indicators i ON i.id = h.indicator_id
      WHERE h.status = 'active' ORDER BY h.id`).all();
    const open_alerts = db.prepare(`
      SELECT a.id, a.observed_value, a.observed_date, a.direction, a.triggered_at,
             h.statement, i.name AS indicator_name
      FROM alerts a JOIN hypotheses h ON h.id = a.hypothesis_id
      JOIN indicators i ON i.id = h.indicator_id
      WHERE a.status = 'open' ORDER BY a.triggered_at DESC`).all();
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM predictions WHERE graded_at IS NULL`).get().n;
    return { hypotheses: hyps, open_alerts, pending_predictions: pending };
  },
  series(id, days = 365) {
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    return stmts.obsSince.all(Number(id), since);
  },
  track() {
    const rows = stmts.trackRecord.all();
    const predictions = db.prepare(`
      SELECT p.id, p.statement, p.expected_low, p.expected_high, p.target_date,
             p.actual_value, p.score, p.committed_at, i.name AS indicator_name
      FROM predictions p JOIN alerts a ON a.id = p.alert_id
      JOIN hypotheses h ON h.id = a.hypothesis_id
      JOIN indicators i ON i.id = h.indicator_id
      ORDER BY p.committed_at DESC LIMIT 200`).all();
    return { rows, predictions };
  },
  graph() {
    const nodes = db.prepare(`SELECT id, type, name, meta_json FROM nodes ORDER BY type, name`).all();
    const edges = db.prepare(`
      SELECT id, src, dst, kind, sign, weight, path_note, condition_note, leverage_note
      FROM edges`).all();
    return { nodes, edges };
  },
  scenarios() { return stmts.allScenarios.all(); },
  scenario(id) {
    const sc = stmts.scenarioById.get(Number(id));
    if (!sc) return null;
    const results = stmts.scenarioResults.all(sc.id)
      .map((r) => ({ ...r, path: JSON.parse(r.path_json), path_json: undefined }));
    return { scenario: sc, results };
  },
};

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': url.pathname.startsWith('/api') ? 'no-store' : 'max-age=60' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  try {
    let m;
    if (url.pathname === '/api/status') return send(200, api.status());
    if ((m = url.pathname.match(/^\/api\/series\/(\d+)$/)))
      return send(200, api.series(m[1], Number(url.searchParams.get('days') || 365)));
    if (url.pathname === '/api/track') return send(200, api.track());
    if (url.pathname === '/api/graph') return send(200, api.graph());
    if (url.pathname === '/api/scenarios') return send(200, api.scenarios());
    if ((m = url.pathname.match(/^\/api\/scenario\/(\d+)$/))) {
      const r = api.scenario(m[1]);
      return r ? send(200, r) : send(404, { error: 'not found' });
    }
    if (url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });

    // 정적 파일
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const fp = path.join(PUB, path.normalize(file));
    if (!fp.startsWith(PUB) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      return send(404, 'not found', 'text/plain');
    }
    return send(200, fs.readFileSync(fp), MIME[path.extname(fp)] || 'application/octet-stream');
  } catch (e) {
    console.error(`${req.method} ${req.url}:`, e.message);
    return send(500, { error: e.message });
  }
}

function createServer(port = PORT) {
  const server = http.createServer(handle);
  server.listen(port, '0.0.0.0');
  return server;
}

if (require.main === module) {
  createServer();
  console.log(`[${new Date().toISOString()}] web server on :${PORT} (LAN/테일넷 전용 — 공인망 노출 금지)`);
}
module.exports = { createServer, api };
