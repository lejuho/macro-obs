// 텔레그램 발송 (Phase 0: 발신만. 답장 수신/커밋 파싱은 Phase 1)
const { TG_BOT_TOKEN, TG_CHAT_ID, DRY_RUN } = require('../config');

async function telegram(method, body) {
  if (DRY_RUN) {
    console.log(`--- [DRY_RUN] telegram ${method} ---\n${JSON.stringify(body, null, 2)}\n---`);
    return method === 'sendMessage' ? { message_id: null } : true;
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

async function send(text, options = {}) {
  return telegram('sendMessage', {
    chat_id: TG_CHAT_ID(),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  }); // { message_id, ... }
}

async function answerCallbackQuery(callbackQueryId, text, options = {}) {
  return telegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    ...options,
  });
}

async function setMyCommands(commands) {
  return telegram('setMyCommands', { commands });
}

function alertKeyboard(alertId) {
  const rows = [
    [
      { text: 'mute', callback_data: `alert:mute:${alertId}` },
      { text: 'status', callback_data: 'cmd:status' },
      { text: 'track', callback_data: 'cmd:track' },
    ],
  ];
  if (process.env.WEB_URL) rows.push([{ text: 'web', url: process.env.WEB_URL }]);
  return { inline_keyboard: rows };
}

/** 밴드 이탈 알림 포맷 (스펙 §4.1의 1·2·4번 요소. 3번 그래프 조인은 Phase 2에서 추가) */
function formatBreach({ hyp, breach, extra }) {
  const dir = breach.direction === 'above' ? '상단 돌파 ↑' : '하단 이탈 ↓';
  const band = `[${hyp.band_low ?? '-∞'} ~ ${hyp.band_high ?? '+∞'}]`;
  const commitExample = formatCommitExample(hyp);
  return [
    `🔔 <b>가설 밴드 이탈: ${esc(hyp.indicator_name)}</b>`,
    ``,
    `<b>가설:</b> ${esc(hyp.statement)}`,
    `<b>등록 논리:</b> ${esc(hyp.rationale)}`,
    ``,
    `<b>관측:</b> ${breach.observed_value} ${esc(hyp.unit || '')} (${breach.observed_date}) — 밴드 ${band} ${dir}`,
    `판정: ${hyp.window_rule} 충족`,
    ``,
    ...(extra ? [extra, ``] : []),
    `❓ <b>90일 뒤 이 지표는 어디에 있는가?</b>`,
    `이 메시지에 답장으로 커밋: <code>${commitExample}</code> 형식 또는 자유 서술`,
    `(커밋 전까지 이 알림은 닫히지 않는다)`,
  ].join('\n');
}

function formatCommitExample(hyp) {
  const lo = hyp.band_low;
  const hi = hyp.band_high;
  if (Number.isFinite(lo) && Number.isFinite(hi)) return `${roundExample(lo)}~${roundExample(hi)}`;
  if (Number.isFinite(lo)) return `${roundExample(lo)}~${roundExample(lo * 1.1)}`;
  if (Number.isFinite(hi)) return `${roundExample(hi * 0.9)}~${roundExample(hi)}`;
  return '값~값';
}

function roundExample(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  send,
  answerCallbackQuery,
  setMyCommands,
  alertKeyboard,
  formatBreach,
  formatCommitExample,
};
