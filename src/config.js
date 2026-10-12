// 의존성 없는 .env 로더. 파이에서 dotenv 설치 없이 동작.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name} (.env 확인)`);
  return v;
}

module.exports = {
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'db', 'macro.db'),
  ECOS_API_KEY: () => req('ECOS_API_KEY'),
  TG_BOT_TOKEN: () => (process.env.DRY_RUN === '1' && !process.env.TG_BOT_TOKEN ? 'dry-run' : req('TG_BOT_TOKEN')),
  TG_CHAT_ID: () => (process.env.DRY_RUN === '1' && !process.env.TG_CHAT_ID ? 'dry-run' : req('TG_CHAT_ID')),
  // 밴드 이탈 재알림 쿨다운 (스펙 §4.1)
  ALERT_COOLDOWN_DAYS: Number(process.env.ALERT_COOLDOWN_DAYS || 7),
  // true면 텔레그램 발송 대신 콘솔 출력 (개발/테스트)
  DRY_RUN: process.env.DRY_RUN === '1',
};
