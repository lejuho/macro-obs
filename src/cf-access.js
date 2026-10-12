// Cloudflare Access JWT 검증 — 의존성 제로 (node:crypto RS256).
// Access가 앞단에서 인증을 통과시키면 오리진 요청에 Cf-Access-Jwt-Assertion 헤더를 붙인다.
// 헤더만 믿지 않고 팀 공개키로 서명·aud·iss·만료·이메일을 직접 검증 → Access 설정이 빠져도 fail closed.
// env: CF_ACCESS_TEAM_DOMAIN (예: myteam.cloudflareaccess.com), CF_ACCESS_AUD, OAUTH_OWNER_EMAIL
const crypto = require('crypto');

let certCache = { at: 0, keys: [] };

async function getKeys(team, force = false) {
  if (!force && Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys = [] } = await res.json();
  certCache = { at: Date.now(), keys };
  return keys;
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function configured() {
  return !!(process.env.CF_ACCESS_TEAM_DOMAIN && process.env.CF_ACCESS_AUD && process.env.OAUTH_OWNER_EMAIL);
}

/** 성공 시 { email }, 실패 시 throw */
let defaultKeysFn = getKeys;
/** 테스트용: 공개키 조회 함수 교체 */
function _setKeysFn(fn) { defaultKeysFn = fn || getKeys; }

async function verify(token, { getKeysFn = defaultKeysFn, now = Date.now() } = {}) {
  const team = process.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CF_ACCESS_AUD;
  const owner = (process.env.OAUTH_OWNER_EMAIL || '').toLowerCase();
  if (!configured()) throw new Error('Cloudflare Access 미설정 (CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD/OAUTH_OWNER_EMAIL)');
  if (!token) throw new Error('Cf-Access-Jwt-Assertion 없음 — Access 애플리케이션이 이 경로를 보호하는지 확인');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT 형식');
  const header = JSON.parse(b64url(parts[0]).toString());
  const payload = JSON.parse(b64url(parts[1]).toString());
  if (header.alg !== 'RS256') throw new Error(`alg ${header.alg}`);

  let keys = await getKeysFn(team);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getKeysFn(team, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('kid 불일치');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64url(parts[2]));
  if (!ok) throw new Error('서명 불일치');

  const sec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < sec) throw new Error('만료');
  if (payload.nbf && payload.nbf > sec + 60) throw new Error('nbf');
  if (payload.iss !== `https://${team}`) throw new Error(`iss ${payload.iss}`);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('aud 불일치');
  const email = String(payload.email || '').toLowerCase();
  if (!email || email !== owner) throw new Error(`허용되지 않은 사용자: ${email || '(서비스 토큰)'}`);
  return { email };
}

module.exports = { verify, configured, _setKeysFn };
