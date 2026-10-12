// PWA 웹서버 (Phase 3b) — node:http, 의존성 제로.
// LAN/테일넷 전용 설계 (인증 없음 — 공인망에 노출 금지).
// 실행: node src/jobs/server.js   (systemd: deploy/macro-obs-web.service)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, stmts } = require('../db');
const flags = require('../flags');
const cycle = require('../cycle');

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
    // 관찰 전용 지표: 활성 가설이 없는 지표 (계기판 표시만, 알림 없음)
    const watch = db.prepare(`
      SELECT i.id, i.name, i.unit, i.note, i.category,
        (SELECT value FROM observations o WHERE o.indicator_id = i.id ORDER BY date DESC LIMIT 1) AS latest,
        (SELECT date  FROM observations o WHERE o.indicator_id = i.id ORDER BY date DESC LIMIT 1) AS latest_date
      FROM indicators i
      WHERE i.id NOT IN (SELECT indicator_id FROM hypotheses WHERE status = 'active')
        AND EXISTS (SELECT 1 FROM observations o WHERE o.indicator_id = i.id)
      ORDER BY i.category, i.id`).all();
    for (const h of hyps) h.flags = flags.forIndicator(h.indicator_name);
    for (const w of watch) w.flags = flags.forIndicator(w.name);
    const elections = stmts.upcomingElections.all(3).map((e) => ({
      ...e, dday: Math.ceil((new Date(e.date) - Date.now()) / 86400_000),
    }));
    return { hypotheses: hyps, open_alerts, pending_predictions: pending, watch, elections, cycle: cycle.snapshot(db) };
  },
  series(id, days = 365) {
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    return stmts.obsSince.all(Number(id), since);
  },
  track() {
    const rows = stmts.trackRecord.all();
    const origin_summary = stmts.originSummary.all();
    const predictions = db.prepare(`
      SELECT p.id, p.statement, p.expected_low, p.expected_high, p.target_date,
             p.actual_value, p.score, p.committed_at, i.name AS indicator_name
      FROM predictions p JOIN alerts a ON a.id = p.alert_id
      JOIN hypotheses h ON h.id = a.hypothesis_id
      JOIN indicators i ON i.id = h.indicator_id
      ORDER BY p.committed_at DESC LIMIT 200`).all();
    return { rows, predictions, origin_summary };
  },
  graph() {
    const nodes = db.prepare(`SELECT id, type, name, meta_json FROM nodes ORDER BY type, name`).all();
    for (const n of nodes) n.flags = flags.forNode(n.name);
    const edges = db.prepare(`
      SELECT id, src, dst, kind, sign, weight, path_note, condition_note, leverage_note
      FROM edges`).all();
    return { nodes, edges };
  },
  scenarios() {
    return stmts.allScenarios.all().map((sc) => ({ ...sc, flags: flags.forScenario(sc.name) }));
  },
  scenario(id) {
    const sc = stmts.scenarioById.get(Number(id));
    if (!sc) return null;
    const results = stmts.scenarioResults.all(sc.id)
      .map((r) => ({ ...r, path: JSON.parse(r.path_json), path_json: undefined }));
    return { scenario: sc, results };
  },
  worldviewCurrent() {
    const current = stmts.latestWorldview.get();
    if (!current) return null;
    const bundle = require('../worldview').getBundle(current.id);
    return {
      commit: bundle.commit,
      scenarios: bundle.scenarios.map((s) => {
        const snap = JSON.parse(s.scenario_snapshot_json);
        return { scenario_id: s.scenario_id, name: s.name, role: s.role, shocks: snap.shocks || [] };
      }),
      paths: bundle.paths.map((p) => ({
        id: p.id, scenario_id: p.scenario_id, scenario_name: p.scenario_name,
        node_id: p.node_id, name: p.name, impact: p.impact, hops: p.hops, path: p.path,
      })),
      political_contexts: bundle.political_contexts.map((p) => ({
        country_code: p.country_code, country_name: p.country_name, valid_from: p.valid_from,
      })),
      observables: bundle.observables.map((o) => ({
        id: o.id, path_id: o.path_id, node: o.node_name, indicator: o.indicator_name,
        expected_direction: o.expected_direction, threshold: o.threshold, metric: o.metric,
        baseline_value: o.baseline_value, baseline_date: o.baseline_date,
        actual_value: o.actual_value, actual_date: o.actual_date, change_value: o.change_value,
        direction_score: o.direction_score, status: o.status,
      })),
      review: bundle.review ? JSON.parse(bundle.review.raw_json) : null,
    };
  },
};

function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  // MCP Streamable HTTP (테일넷 전용 — 웹서버와 같은 보안 경계)
  // 읽기는 무인증, 쓰기 도구는 MCP_WRITE_TOKEN 헤더 일치 시에만 노출 (토큰 미설정 = HTTP 항상 읽기 전용)
  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const { createHandler, TOOLS } = require('../mcp');
      const { WRITE_TOOLS } = require('../mcp-write-tools');
      const crypto = require('crypto');
      const token = process.env.MCP_WRITE_TOKEN;
      const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const authed = !!token && given.length === token.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      const handleRpc = createHandler(authed ? [...TOOLS, ...WRITE_TOOLS] : TOOLS);
      let msg;
      try { msg = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      }
      const out = await handleRpc(msg);
      if (!out) { res.writeHead(202).end(); return; } // notification
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
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
    if (url.pathname === '/api/worldview/current') {
      const r = api.worldviewCurrent();
      return r ? send(200, r) : send(404, { error: 'not found' });
    }
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
