// Claude CLI 위치를 cron/systemd처럼 PATH가 축소된 환경에서도 안정적으로 찾는다.
const fs = require('fs');

const DEFAULT_CANDIDATES = [
  '/home/pi/.local/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
];

function resolveClaudeBin({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  return DEFAULT_CANDIDATES.find((candidate) => exists(candidate)) || 'claude';
}

module.exports = { resolveClaudeBin, DEFAULT_CANDIDATES };
