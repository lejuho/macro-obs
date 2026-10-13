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

// --- 공인망(클라우드플레어 터널) 게이트 ---
// 터널 경유 판별: CF가 항상 붙이는 Cf-Connecting-Ip 헤더, 또는 docker 브리지(172.16/12)발 접속(cloudflared 컨테이너).
// 터널 요청 인증: PUBLIC_API_TOKEN(고정 Bearer) 또는 OAuth access token(src/oauth.js). 둘 다 아니면 401 + WWW-Authenticate.
// 경로 화이트리스트 + MCP는 읽기 도구(+OAuth macro.report 스코프면 보고서 도구, macro.write면 전체+쓰기 도구)만. OAuth 엔드포인트는 무인증 공개.
// 테일넷/LAN/localhost 요청은 기존대로 무인증.
const PUBLIC_PATHS = new Set(['/api/events', '/api/track', '/api/reports', '/mcp']);
const DOCKER_NET = /^(::ffff:)?172\.(1[6-9]|2\d|3[01])\./;

function isPublic(req) {
  return !!req.headers['cf-connecting-ip'] || DOCKER_NET.test(req.socket.remoteAddress || '');
}
function tokenMatches(given, token) {
  const crypto = require('crypto');
  return !!token && given.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/** 공인망 요청 주체: { kind:'static' } | { kind:'oauth', client_id, scope, owner } | null */
function publicAuth(req) {
  const given = bearer(req);
  if (tokenMatches(given, process.env.PUBLIC_API_TOKEN)) return { kind: 'static' };
  const o = require('../oauth').verifyAccessToken(given);
  return o ? { kind: 'oauth', ...o } : null;
}
/** 통과면 null, 아니면 [status, message] */
function publicGate(req, pathname) {
  if (!publicAuth(req)) return [401, 'unauthorized'];
  if (!PUBLIC_PATHS.has(pathname)) return [403, 'forbidden'];
  return null;
}

/** 요청 주체별 MCP 도구 세트 */
function mcpToolset(req, pub) {
  const { TOOLS } = require('../mcp');
  const { WRITE_TOOLS } = require('../mcp-write-tools');
  const { reportTools } = require('../mcp-report-tools');
  const pubNames = (process.env.PUBLIC_MCP_TOOLS || 'get_events,get_track,search_news').split(',').map((t) => t.trim());
  const pubRead = TOOLS.filter((t) => pubNames.includes(t.name));
  if (pub) {
    const who = publicAuth(req);
    if (who.kind === 'static') return pubRead;
    const scopes = who.scope.split(' ');
    const client = db.prepare('SELECT client_name FROM oauth_clients WHERE client_id = ?').get(who.client_id);
    const author = `oauth:${client?.client_name || who.client_id}`;
    const reports = reportTools(author);
    // macro.write: 로컬 stdio와 같은 전체 도구 (쓰기 도구는 origin=assisted로 기록)
    if (scopes.includes('macro.write')) return [...TOOLS, ...WRITE_TOOLS, ...reports];
    return [
      ...(scopes.includes('macro.read') ? [...pubRead, reports.find((t) => t.name === 'get_reports')] : []),
      ...(scopes.includes('macro.report') ? reports.filter((t) => t.name === 'save_report') : []),
    ];
  }
  // 로컬: 쓰기 도구는 MCP_WRITE_TOKEN 일치 시에만 (토큰 미설정 = HTTP 항상 읽기 전용)
  const authed = tokenMatches(bearer(req), process.env.MCP_WRITE_TOKEN);
  const reports = reportTools('local');
  return authed ? [...TOOLS, ...WRITE_TOOLS, ...reports] : [...TOOLS, reports.find((t) => t.name === 'get_reports')];
}

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  // 공인망 접근 로그 (토큰·쿼리 값은 남기지 않음 — 키 이름만)
  if (isPublic(req)) {
    const t0 = Date.now();
    res.on('finish', () => console.log(`[pub] ${req.method} ${url.pathname}${url.search ? ' ?' + [...url.searchParams.keys()].join(',') : ''} → ${res.statusCode} ${Date.now() - t0}ms auth=${req.headers.authorization ? req.headers.authorization.split(' ')[0] : '-'} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`));
  }

  // OAuth 인가 서버 + 메타데이터 (공개 — 승인 화면은 내부에서 Cloudflare Access JWT 검증)
  if (require('../oauth').handle(req, res, url)) return;

  const pub = isPublic(req);
  if (pub) {
    if (req.method === 'OPTIONS' && url.pathname === '/mcp') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
      });
      return res.end();
    }
    const denied = publicGate(req, url.pathname);
    if (denied) {
      res.writeHead(denied[0], {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        ...(denied[0] === 401 ? { 'WWW-Authenticate': require('../oauth').wwwAuthenticate() } : {}),
      });
      return res.end(JSON.stringify({ error: denied[1] }));
    }
  }

  // MCP Streamable HTTP (JSON 응답 모드, 세션 없음)
  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { res.writeHead(413).end(); req.destroy(); return; }
      body += c;
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      const { createHandler } = require('../mcp');
      const handleRpc = createHandler(mcpToolset(req, pub));
      let msg;
      try { msg = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      }
      const out = await handleRpc(msg);
      if (!out) { res.writeHead(202).end(); return; } // notification
      res.writeHead(200, { 'Content-Type': 'application/json', ...(pub ? { 'Access-Control-Allow-Origin': '*' } : {}) });
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
    if (url.pathname === '/api/reports') {
      return send(200, { reports: require('../mcp-report-tools').listReports(Object.fromEntries(url.searchParams)) });
    }
    if (url.pathname === '/api/events') {
      const q = Object.fromEntries(url.searchParams);
      return send(200, require('../events').list(q));
    }
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
module.exports = { createServer, api, isPublic, publicGate };
