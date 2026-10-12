// OAuth 2.1 인가 서버 (MCP 원격 커넥터용) — 의존성 제로.
// 규격: MCP Authorization (RFC 9728 보호 리소스 메타데이터, RFC 8414 AS 메타데이터,
//        RFC 7591 동적 클라이언트 등록, PKCE S256 필수, refresh token 회전).
// 승인 화면(/oauth/authorize)은 Cloudflare Access 이메일 로그인 뒤에 두고, 서버가 Access JWT를 직접 검증한다.
// 토큰·코드·시크릿은 sha256 해시로만 저장. env: PUBLIC_BASE_URL (예: https://macro.lee-blog.me)
const crypto = require('crypto');
const { db } = require('./db');
const cfAccess = require('./cf-access');

const ACCESS_TTL = 3600;            // 1시간
const REFRESH_TTL = 90 * 86400;     // 90일 (사용할 때마다 회전)
const CODE_TTL = 300;               // 5분
const PENDING_TTL = 600_000;        // 승인 화면 대기 10분
const SCOPES = ['macro.read', 'macro.report'];
const MAX_CLIENTS = 200;

const base = () => (process.env.PUBLIC_BASE_URL || 'https://macro.lee-blog.me').replace(/\/$/, '');
const resourceUrl = () => `${base()}/mcp`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

const pending = new Map(); // 승인 대기 중인 authorize 요청 (단일 프로세스)

const q = {
  insClient: db.prepare(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris_json) VALUES (?, ?, ?, ?)`),
  client: db.prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`),
  countClients: db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`),
  insCode: db.prepare(`INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, owner, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  takeCode: db.prepare(`DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *`),
  insToken: db.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, scope, owner, expires_at) VALUES (?, ?, ?, ?, ?, ?)`),
  token: db.prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ? AND revoked = 0 AND expires_at > ?`),
  revoke: db.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?`),
  gc: db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`),
  gcCodes: db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`),
};

// ── 메타데이터 ──
function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [base()],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'macro-obs',
  };
}
function authServerMetadata() {
  return {
    issuer: base(),
    authorization_endpoint: `${base()}/oauth/authorize`,
    token_endpoint: `${base()}/oauth/token`,
    registration_endpoint: `${base()}/oauth/register`,
    revocation_endpoint: `${base()}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: SCOPES,
  };
}
function wwwAuthenticate() {
  return `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`;
}

// ── 토큰 검증 (/mcp, /api 에서 호출) ──
/** 유효한 access token이면 { client_id, scope, owner }, 아니면 null */
function verifyAccessToken(token) {
  if (!token) return null;
  const row = q.token.get(sha(token), 'access', nowSec());
  return row ? { client_id: row.client_id, scope: row.scope || '', owner: row.owner } : null;
}

function issueTokens(client_id, scope, owner) {
  const access = rand();
  const refresh = rand();
  q.insToken.run(sha(access), 'access', client_id, scope, owner, nowSec() + ACCESS_TTL);
  q.insToken.run(sha(refresh), 'refresh', client_id, scope, owner, nowSec() + REFRESH_TTL);
  q.gc.run(nowSec());
  q.gcCodes.run(nowSec());
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope };
}

function normalizeScope(s) {
  const asked = String(s || '').split(/\s+/).filter(Boolean);
  const granted = asked.length ? asked.filter((x) => SCOPES.includes(x)) : SCOPES;
  return (granted.length ? granted : SCOPES).join(' ');
}

function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch { return false; }
}

// ── HTTP 유틸 ──
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
function parseForm(req, raw) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
};
function json(res, code, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra });
  res.end(JSON.stringify(body));
}
const oerr = (res, code, error, description) => {
  console.log(`[oauth] ${code} ${error}${description ? ' — ' + description : ''}`);
  return json(res, code, { error, ...(description ? { error_description: description } : {}) });
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function html(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>macro-obs 연결 승인</title><style>
body{font:15px/1.6 system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
.card{background:#fff;border:1px solid #ddd;border-radius:12px;padding:20px}
h1{font-size:18px;margin:0 0 12px}dt{color:#666;font-size:13px}dd{margin:0 0 10px;word-break:break-all}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer;margin-right:8px}
button.ok{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{background:#1b1b1b;border-color:#333}button{background:#222;color:#eee}button.ok{background:#eee;color:#111}}
</style></head><body><div class="card">${body}</div></body></html>`);
}

async function ownerFromAccess(req) {
  return cfAccess.verify(req.headers['cf-access-jwt-assertion']);
}

// ── 핸들러 ──
function authorizeParams(p) {
  const client = q.client.get(String(p.client_id || ''));
  if (!client) return { fatal: '알 수 없는 client_id' };
  const uris = JSON.parse(client.redirect_uris_json);
  const redirect_uri = p.redirect_uri || (uris.length === 1 ? uris[0] : '');
  if (!uris.includes(redirect_uri)) return { fatal: '등록되지 않은 redirect_uri' };
  // 여기부터는 redirect로 에러를 돌려줄 수 있음
  const back = (error, desc) => {
    const u = new URL(redirect_uri);
    u.searchParams.set('error', error);
    if (desc) u.searchParams.set('error_description', desc);
    if (p.state) u.searchParams.set('state', p.state);
    return u.toString();
  };
  if (p.response_type !== 'code') return { redirect: back('unsupported_response_type') };
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return { redirect: back('invalid_request', 'PKCE S256 필수') };
  if (p.resource && p.resource.replace(/\/$/, '') !== resourceUrl() && p.resource.replace(/\/$/, '') !== base()) {
    return { redirect: back('invalid_target', `resource는 ${resourceUrl()}`) };
  }
  return {
    client, redirect_uri, state: p.state || null, code_challenge: p.code_challenge,
    scope: normalizeScope(p.scope), resource: p.resource || resourceUrl(),
  };
}

async function handleAuthorize(req, res, url) {
  let owner;
  try { owner = (await ownerFromAccess(req)).email; }
  catch (e) { return html(res, 403, `<h1>승인 불가</h1><p>${esc(e.message)}</p>`); }

  if (req.method === 'GET') {
    const r = authorizeParams(Object.fromEntries(url.searchParams));
    if (r.fatal) return html(res, 400, `<h1>잘못된 요청</h1><p>${esc(r.fatal)}</p>`);
    if (r.redirect) { res.writeHead(302, { Location: r.redirect }); return res.end(); }
    for (const [k, v] of pending) if (v.at < Date.now() - PENDING_TTL) pending.delete(k);
    const rid = rand(24);
    pending.set(rid, { ...r, client_id: r.client.client_id, owner, at: Date.now() });
    return html(res, 200, `<h1>macro-obs 연결 승인</h1>
<dl><dt>앱</dt><dd>${esc(r.client.client_name || '(이름 없음)')}</dd>
<dt>돌아갈 주소</dt><dd>${esc(new URL(r.redirect_uri).origin)}</dd>
<dt>권한</dt><dd>${r.scope.split(' ').map((s) => s === 'macro.read' ? '이벤트·트랙레코드·뉴스 읽기' : '분석 보고서 저장(save_report)').join('<br>')}</dd>
<dt>승인자</dt><dd>${esc(owner)}</dd></dl>
<form method="post" action="/oauth/authorize"><input type="hidden" name="rid" value="${rid}">
<button class="ok" name="decision" value="approve">승인</button><button name="decision" value="deny">거부</button></form>`);
  }

  if (req.method === 'POST') {
    const p = parseForm(req, await readBody(req));
    const pend = pending.get(String(p.rid || ''));
    pending.delete(String(p.rid || ''));
    if (!pend || pend.at < Date.now() - PENDING_TTL || pend.owner !== owner) {
      return html(res, 400, '<h1>만료된 요청</h1><p>앱에서 연결을 다시 시작하라.</p>');
    }
    const u = new URL(pend.redirect_uri);
    if (pend.state) u.searchParams.set('state', pend.state);
    if (p.decision !== 'approve') {
      u.searchParams.set('error', 'access_denied');
    } else {
      const code = rand();
      q.insCode.run(sha(code), pend.client_id, pend.redirect_uri, pend.code_challenge, pend.scope, pend.resource, owner, nowSec() + CODE_TTL);
      u.searchParams.set('code', code);
      require('./events').record({ source: 'oauth', kind: 'oauth_grant', data: { client_id: pend.client_id, client_name: pend.client.client_name, scope: pend.scope } });
    }
    u.searchParams.set('iss', base());
    res.writeHead(302, { Location: u.toString() });
    return res.end();
  }
  res.writeHead(405).end();
}

function clientAuth(req, p) {
  let id = p.client_id; let secret = p.client_secret;
  const basic = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (basic) {
    const [u, s] = Buffer.from(basic[1], 'base64').toString().split(':');
    id = decodeURIComponent(u || ''); secret = decodeURIComponent(s || '');
  }
  const client = q.client.get(String(id || ''));
  if (!client) return null;
  if (client.client_secret_hash) {
    if (!secret) return null;
    const a = Buffer.from(sha(secret)); const b = Buffer.from(client.client_secret_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  }
  return client;
}

async function handleToken(req, res) {
  if (req.method !== 'POST') return oerr(res, 405, 'invalid_request');
  const p = parseForm(req, await readBody(req));
  const client = clientAuth(req, p);
  if (!client) return oerr(res, 401, 'invalid_client');

  if (p.grant_type === 'authorization_code') {
    const row = q.takeCode.get(sha(String(p.code || ''))); // 1회용 — 조회와 동시에 삭제
    if (!row || row.expires_at < nowSec() || row.client_id !== client.client_id) return oerr(res, 400, 'invalid_grant');
    if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return oerr(res, 400, 'invalid_grant', 'redirect_uri 불일치');
    const challenge = crypto.createHash('sha256').update(String(p.code_verifier || '')).digest('base64url');
    if (!p.code_verifier || challenge !== row.code_challenge) return oerr(res, 400, 'invalid_grant', 'PKCE 검증 실패');
    return json(res, 200, issueTokens(client.client_id, row.scope, row.owner));
  }
  if (p.grant_type === 'refresh_token') {
    const h = sha(String(p.refresh_token || ''));
    const row = q.token.get(h, 'refresh', nowSec());
    if (!row || row.client_id !== client.client_id) return oerr(res, 400, 'invalid_grant');
    q.revoke.run(h); // 회전: 쓴 refresh token은 폐기
    const scope = p.scope ? normalizeScope(p.scope).split(' ').filter((s) => row.scope.split(' ').includes(s)).join(' ') || row.scope : row.scope;
    return json(res, 200, issueTokens(client.client_id, scope, row.owner));
  }
  return oerr(res, 400, 'unsupported_grant_type');
}

async function handleRegister(req, res) {
  if (req.method !== 'POST') return oerr(res, 405, 'invalid_request');
  let p;
  try { p = JSON.parse(await readBody(req, 16 * 1024)); } catch { return oerr(res, 400, 'invalid_client_metadata', 'JSON 필요'); }
  const uris = Array.isArray(p.redirect_uris) ? p.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
    return oerr(res, 400, 'invalid_redirect_uri', 'https 또는 http://localhost 만 허용');
  }
  if (q.countClients.get().n >= MAX_CLIENTS) return oerr(res, 400, 'invalid_client_metadata', '클라이언트 수 상한');
  const method = p.token_endpoint_auth_method || 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
    return oerr(res, 400, 'invalid_client_metadata', `token_endpoint_auth_method ${method}`);
  }
  const client_id = `mo_${rand(16)}`;
  const secret = method === 'none' ? null : rand();
  const name = String(p.client_name || '').slice(0, 100);
  q.insClient.run(client_id, secret ? sha(secret) : null, name, JSON.stringify(uris));
  return json(res, 201, {
    client_id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: nowSec(), client_name: name, redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: method,
  });
}

async function handleRevoke(req, res) {
  if (req.method !== 'POST') return oerr(res, 405, 'invalid_request');
  const p = parseForm(req, await readBody(req));
  if (p.token) q.revoke.run(sha(String(p.token)));
  return json(res, 200, {});
}

/** /.well-known/* 또는 /oauth/* 이면 처리하고 true */
function handle(req, res, url) {
  const path = url.pathname;
  const isOauth = path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-') || path === '/.well-known/openid-configuration';
  if (!isOauth) return false;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
  const fail = (e) => { console.error(`oauth ${path}:`, e.message); if (!res.headersSent) oerr(res, 400, 'invalid_request', e.message); };

  if (path.startsWith('/.well-known/oauth-protected-resource')) json(res, 200, protectedResourceMetadata());
  else if (path.startsWith('/.well-known/oauth-authorization-server') || path === '/.well-known/openid-configuration') json(res, 200, authServerMetadata());
  else if (path === '/oauth/authorize') handleAuthorize(req, res, url).catch(fail);
  else if (path === '/oauth/token') handleToken(req, res).catch(fail);
  else if (path === '/oauth/register') handleRegister(req, res).catch(fail);
  else if (path === '/oauth/revoke') handleRevoke(req, res).catch(fail);
  else json(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, verifyAccessToken, wwwAuthenticate, SCOPES, _internal: { sha, pending, issueTokens } };
