// OAuth 2.1 + 공인망 게이트 + save_report 테스트 — 가짜 Cloudflare Access 키로 전 흐름 검증
// 실행: node --no-warnings test/oauth.test.js

process.env.DB_PATH = '/tmp/macro-oauth.db';
process.env.DRY_RUN = '1';
process.env.PUBLIC_BASE_URL = 'https://macro.example.com';
process.env.PUBLIC_API_TOKEN = 'static-token-abc';
process.env.CF_ACCESS_TEAM_DOMAIN = 'team.cloudflareaccess.com';
process.env.CF_ACCESS_AUD = 'aud-123';
process.env.OAUTH_OWNER_EMAIL = 'owner@example.com';
const fs = require('fs');
const crypto = require('crypto');
for (const f of ['', '-wal', '-shm']) if (fs.existsSync(process.env.DB_PATH + f)) fs.unlinkSync(process.env.DB_PATH + f);

const { db } = require('../src/db');
const cfAccess = require('../src/cf-access');
const { createServer } = require('../src/jobs/server');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

// 가짜 Access 서명키
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
cfAccess._setKeysFn(async () => [jwk]);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function accessJwt(claims = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1' });
  const p = b64({ iss: 'https://team.cloudflareaccess.com', aud: ['aud-123'], email: 'owner@example.com',
    exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

(async () => {
  const server = createServer(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const PUB = { 'Cf-Connecting-Ip': '1.2.3.4' };
  const rpc = (headers, method, params = {}) => fetch(base + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...PUB, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const toolNames = async (headers) => (await (await rpc(headers, 'tools/list')).json()).result.tools.map((t) => t.name);

  console.log('1. 메타데이터 · 401 안내');
  const prm = await (await fetch(base + '/.well-known/oauth-protected-resource', { headers: PUB })).json();
  assert(prm.resource === 'https://macro.example.com/mcp' && prm.authorization_servers[0] === 'https://macro.example.com', '보호 리소스 메타데이터');
  const asm = await (await fetch(base + '/.well-known/oauth-authorization-server', { headers: PUB })).json();
  assert(asm.code_challenge_methods_supported.includes('S256') && asm.registration_endpoint.endsWith('/oauth/register'), 'AS 메타데이터');
  const r401 = await rpc({}, 'tools/list');
  assert(r401.status === 401 && /resource_metadata=/.test(r401.headers.get('www-authenticate')), '/mcp 무토큰 → 401 + WWW-Authenticate');

  console.log('2. 동적 클라이언트 등록');
  const bad = await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...PUB },
    body: JSON.stringify({ redirect_uris: ['http://evil.com/cb'] }) });
  assert(bad.status === 400, 'http(비 localhost) redirect 거부');
  const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...PUB },
    body: JSON.stringify({ client_name: 'TestAgent', redirect_uris: ['https://agent.example.com/cb'], token_endpoint_auth_method: 'none' }) })).json();
  assert(/^mo_/.test(reg.client_id) && !reg.client_secret, '공개 클라이언트 등록');

  console.log('3. 승인 화면 — Access JWT 검증');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authUrl = `/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('https://agent.example.com/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=macro.read%20macro.report&resource=${encodeURIComponent('https://macro.example.com/mcp')}`;
  assert((await fetch(base + authUrl, { headers: PUB })).status === 403, 'JWT 없음 → 403');
  assert((await fetch(base + authUrl, { headers: { ...PUB, 'Cf-Access-Jwt-Assertion': accessJwt({ email: 'other@example.com' }) } })).status === 403, '다른 이메일 → 403');
  assert((await fetch(base + authUrl, { headers: { ...PUB, 'Cf-Access-Jwt-Assertion': accessJwt({ aud: ['wrong'] }) } })).status === 403, 'aud 불일치 → 403');
  assert((await fetch(base + authUrl, { headers: { ...PUB, 'Cf-Access-Jwt-Assertion': (() => { const t = accessJwt(); const i = t.length - 20; return t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1); })() } })).status === 403, '서명 변조 → 403');
  const noPkce = await fetch(base + authUrl.replace(/&code_challenge=[^&]+/, ''), { redirect: 'manual', headers: { ...PUB, 'Cf-Access-Jwt-Assertion': accessJwt() } });
  assert(noPkce.status === 302 && noPkce.headers.get('location').includes('error=invalid_request'), 'PKCE 없음 → redirect 에러');
  const page = await fetch(base + authUrl, { headers: { ...PUB, 'Cf-Access-Jwt-Assertion': accessJwt() } });
  const html = await page.text();
  assert(page.status === 200 && html.includes('TestAgent') && html.includes('owner@example.com'), '승인 화면 표시');
  const rid = html.match(/name="rid" value="([^"]+)"/)[1];

  const approve = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual',
    headers: { ...PUB, 'Content-Type': 'application/x-www-form-urlencoded', 'Cf-Access-Jwt-Assertion': accessJwt() },
    body: `rid=${rid}&decision=approve` });
  const loc = new URL(approve.headers.get('location'));
  assert(approve.status === 302 && loc.origin === 'https://agent.example.com' && loc.searchParams.get('state') === 'xyz' && loc.searchParams.get('code'), '승인 → code + state');
  const replay = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual',
    headers: { ...PUB, 'Content-Type': 'application/x-www-form-urlencoded', 'Cf-Access-Jwt-Assertion': accessJwt() },
    body: `rid=${rid}&decision=approve` });
  assert(replay.status === 400, '같은 rid 재사용 거부');

  console.log('4. 토큰 교환 · 회전');
  const tok = (body) => fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...PUB }, body: new URLSearchParams(body) });
  const code = loc.searchParams.get('code');
  assert((await tok({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: 'wrong', redirect_uri: 'https://agent.example.com/cb' })).status === 400, 'PKCE 불일치 → 400 (코드 소모)');
  // 코드는 1회용이라 새로 발급
  const page2 = await (await fetch(base + authUrl, { headers: { ...PUB, 'Cf-Access-Jwt-Assertion': accessJwt() } })).text();
  const rid2 = page2.match(/name="rid" value="([^"]+)"/)[1];
  const ap2 = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual',
    headers: { ...PUB, 'Content-Type': 'application/x-www-form-urlencoded', 'Cf-Access-Jwt-Assertion': accessJwt() }, body: `rid=${rid2}&decision=approve` });
  const code2 = new URL(ap2.headers.get('location')).searchParams.get('code');
  const t1 = await (await tok({ grant_type: 'authorization_code', code: code2, client_id: reg.client_id, code_verifier: verifier, redirect_uri: 'https://agent.example.com/cb' })).json();
  assert(t1.access_token && t1.refresh_token && t1.token_type === 'Bearer', 'code → access/refresh');
  assert((await tok({ grant_type: 'authorization_code', code: code2, client_id: reg.client_id, code_verifier: verifier })).status === 400, 'code 재사용 거부');
  const t2 = await (await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id })).json();
  assert(t2.access_token && t2.refresh_token !== t1.refresh_token, 'refresh → 새 토큰');
  assert((await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id })).status === 400, '쓴 refresh 재사용 거부');

  console.log('5. MCP 도구 노출');
  const oauthTools = await toolNames({ Authorization: `Bearer ${t2.access_token}` });
  assert(['get_events', 'get_reports', 'save_report'].every((n) => oauthTools.includes(n)) && !oauthTools.includes('commit_prediction') && !oauthTools.includes('get_status'), 'OAuth: 읽기 3종 + 보고서 도구만');
  const staticTools = await toolNames({ Authorization: 'Bearer static-token-abc' });
  assert(!staticTools.includes('save_report') && staticTools.includes('get_events'), '고정 토큰: 읽기만');
  assert((await rpc({ Authorization: `Bearer ${t1.access_token}` }, 'tools/list')).status === 200, '회전 전 access는 만료 전까지 유효');

  console.log('6. save_report');
  db.prepare(`INSERT INTO events (source, kind, text) VALUES ('daily','breach','x'), ('news','news_revisit','y')`).run();
  const call = async (name, args) => JSON.parse((await (await rpc({ Authorization: `Bearer ${t2.access_token}` }, 'tools/call', { name, arguments: args })).json()).result.content[0].text);
  const saved = await call('save_report', { title: '주간 분석', body: '## 변화\n...', event_ids: [1, 2], since_id: 0, until_id: 2 });
  assert(saved.ok && saved.report_id === 1 && saved.until_id === 2, '보고서 저장');
  const again = await call('save_report', { title: '중복', body: 'x', event_ids: [2] });
  assert(again.ok && /이미 보고서 #1/.test(again.warning), '중복 이벤트 경고');
  const row = db.prepare('SELECT author FROM reports WHERE id = 1').get();
  assert(row.author === 'oauth:TestAgent', 'author = OAuth 클라이언트명 (인자로 위조 불가)');
  const errRes = await (await rpc({ Authorization: `Bearer ${t2.access_token}` }, 'tools/call', { name: 'save_report', arguments: { title: '' , body: 'x' } })).json();
  assert(errRes.result.isError, '빈 title → isError');
  const rep = await (await fetch(base + '/api/reports', { headers: { ...PUB, Authorization: `Bearer ${t2.access_token}` } })).json();
  assert(rep.reports.length === 2, '/api/reports (OAuth)');

  console.log('6b. macro.write — 승인 화면 체크로만 부여');
  const writeUrl = authUrl.replace('scope=macro.read%20macro.report', 'scope=macro.read%20macro.report%20macro.write');
  const grant = async (body) => {
    const pg = await (await fetch(base + writeUrl, { headers: { ...PUB, 'Cf-Access-Jwt-Assertion': accessJwt() } })).text();
    const r = pg.match(/name="rid" value="([^"]+)"/)[1];
    const ap = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual',
      headers: { ...PUB, 'Content-Type': 'application/x-www-form-urlencoded', 'Cf-Access-Jwt-Assertion': accessJwt() }, body: `rid=${r}&decision=approve${body}` });
    const c = new URL(ap.headers.get('location')).searchParams.get('code');
    return { page: pg, tok: await (await tok({ grant_type: 'authorization_code', code: c, client_id: reg.client_id, code_verifier: verifier, redirect_uri: 'https://agent.example.com/cb' })).json() };
  };
  const noTick = await grant('');
  assert(!noTick.tok.scope.includes('macro.write') && noTick.page.includes('name="write"'), '요청만으로는 write 미부여 (체크박스 표시)');
  assert(!(await toolNames({ Authorization: `Bearer ${noTick.tok.access_token}` })).includes('commit_prediction'), '미체크: 쓰기 도구 없음');
  const ticked = await grant('&write=1');
  assert(ticked.tok.scope.split(' ').includes('macro.write'), '체크 → macro.write 부여');
  const wTools = await toolNames({ Authorization: `Bearer ${ticked.tok.access_token}` });
  assert(['get_status', 'commit_prediction', 'revise_hypothesis', 'add_trigger', 'save_report', 'get_reports'].every((n) => wTools.includes(n)), 'write: 전체+쓰기 도구');
  const wr = await (await tok({ grant_type: 'refresh_token', refresh_token: ticked.tok.refresh_token, client_id: reg.client_id, scope: 'macro.read macro.report macro.write' })).json();
  assert(wr.scope.split(' ').includes('macro.write'), 'refresh(스코프 명시)에도 write 유지');
  const wr2 = await (await tok({ grant_type: 'refresh_token', refresh_token: wr.refresh_token, client_id: reg.client_id })).json();
  assert(wr2.scope.includes('macro.write'), 'refresh(스코프 생략)에도 write 유지');
  const up = await (await tok({ grant_type: 'refresh_token', refresh_token: noTick.tok.refresh_token, client_id: reg.client_id, scope: 'macro.read macro.write' })).json();
  assert(!up.scope.includes('macro.write'), 'refresh로 write 승격 불가');

  console.log('7. 게이트 회귀');
  assert((await fetch(base + '/api/status', { headers: { ...PUB, Authorization: `Bearer ${t2.access_token}` } })).status === 403, 'OAuth로도 /api/status 403');
  assert((await fetch(base + '/api/status')).status === 200, '로컬 무인증 유지');
  await fetch(base + '/oauth/revoke', { method: 'POST', headers: { ...PUB, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${t2.access_token}` });
  assert((await rpc({ Authorization: `Bearer ${t2.access_token}` }, 'tools/list')).status === 401, 'revoke 후 401');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
