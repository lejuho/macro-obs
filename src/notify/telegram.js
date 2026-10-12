// 텔레그램 공통 래퍼 — sendMessage 외 setMyCommands, answerCallbackQuery 등 임의 메서드 호출
const { TG_BOT_TOKEN, TG_CHAT_ID, DRY_RUN } = require('../config');

async function telegram(method, body) {
  if (DRY_RUN) {
    console.log(`--- [DRY_RUN] telegram ${method} ---\n${JSON.stringify(body, null, 2)}\n---`);
    return { ok: true, result: { message_id: null } };
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json;
}

/**
 * options.event = { kind, data } — 이벤트 로그 메타 (텔레그램엔 안 보냄).
 * 발송 성공/실패와 무관하게 events 테이블에 남는다 (DRY_RUN 제외). kind 생략 시 'message'.
 */
async function send(text, { event, ...options } = {}) {
  const log = (delivered) => {
    if (DRY_RUN) return;
    const { record } = require('../events');
    record({ kind: event?.kind || 'message', text, data: event?.data ?? null, delivered });
  };
  let json;
  try {
    json = await telegram('sendMessage', {
      chat_id: TG_CHAT_ID(), text, parse_mode: 'HTML',
      disable_web_page_preview: true, ...options,
    });
  } catch (e) { log(false); throw e; }
  log(true);
  return json.result;
}

async function answerCallbackQuery(callbackQueryId, text) {
  return telegram('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

async function setMyCommands(commands) {
  return telegram('setMyCommands', { commands });
}

/** 밴드 이탈 알림 하단 인라인 버튼 */
function alertKeyboard(alertId) {
  return {
    inline_keyboard: [[
      { text: '🔇 mute', callback_data: `alert:mute:${alertId}` },
      { text: '📊 status', callback_data: 'status' },
      { text: '🎯 track', callback_data: 'track' },
    ]],
  };
}

/** 커밋 예시를 해당 가설의 밴드 스케일로 (환율 하드코딩 제거) */
function formatCommitExample(hyp) {
  if (hyp.band_low != null && hyp.band_high != null) return `${hyp.band_low}~${hyp.band_high}`;
  return '하한~상한';
}

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
    ...(extra ? [extra, ``] : []),
    `❓ <b>90일 뒤 이 지표는 어디에 있는가?</b>`,
    `이 메시지에 답장으로 커밋: <code>${commitExample}</code> 형식 또는 자유 서술`,
    `(커밋 전까지 이 알림은 닫히지 않는다)`,
  ].join('\n');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { telegram, send, answerCallbackQuery, setMyCommands, alertKeyboard, formatCommitExample, formatBreach };
