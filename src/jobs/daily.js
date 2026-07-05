// 일일 배치: 수집 → 밴드 감시 → 알림 → 채점 → 재촉(nag) → (월요일) 주간 리포트
// cron (하루 2회 — ECOS 반영 시차 흡수, 중복 실행 무해):
//   0 9  * * *  cd /home/pi/macro_obs && /usr/bin/node --no-warnings src/jobs/daily.js >> log/daily.log 2>&1
//   0 19 * * *  cd /home/pi/macro_obs && /usr/bin/node --no-warnings src/jobs/daily.js >> log/daily.log 2>&1

const { collect } = require('../collectors/ecos');
const { scan } = require('../watcher');
const { send, formatBreach } = require('../notify/telegram');
const { stmts } = require('../db');
const { grade, formatTrack } = require('../predictions');

async function main() {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] daily job start`);

  // 1. 수집
  const results = await collect({ lookbackDays: 30 });
  for (const r of results) {
    console.log(r.ok ? `  collect ${r.key}: ${r.count} rows` : `  collect ${r.key}: FAILED — ${r.error}`);
  }
  if (results.length && results.every((r) => !r.ok)) {
    await send(`⚠️ macro-obs: 전체 수집 실패\n${results.map((f) => f.error).join('\n')}`).catch(() => {});
  }

  // 2. 밴드 감시 → 알림
  for (const b of scan()) {
    const msg = await send(formatBreach(b));
    if (msg.message_id) stmts.setAlertTgId.run(msg.message_id, b.alert_id);
    console.log(`  alert #${b.alert_id} sent`);
  }

  // 3. 채점 (target_date 도래 예측)
  for (const p of stmts.dueForGrading.all()) {
    const obs = stmts.obsOnOrBefore.get(p.indicator_id, p.target_date);
    const g = grade(p, obs, p.target_date);

    if (g.score === 'manual') {
      // 자유 서술 → self-grade 요청. 답장 매칭을 위해 message_id 저장.
      const msg = await send([
        `⏰ <b>채점일 도래 — self-grade 필요</b>`,
        `${esc(p.indicator_name)} · 예측 #${p.id}`,
        `당시 커밋: "${esc(p.statement)}"`,
        `현재 관측: ${obs ? `${obs.value} (${obs.date})` : '결측'}`,
        ``,
        `이 메시지에 답장: <code>hit</code> 또는 <code>miss</code>`,
      ].join('\n'));
      if (msg.message_id) stmts.kvSet.run(`selfgrade_msg_${msg.message_id}`, String(p.id));
      // graded_at은 self-grade 답장 시점에 기록 (bot.js)
      console.log(`  pred #${p.id}: manual self-grade requested`);
      continue;
    }

    stmts.gradePrediction.run(g.actual, g.score, p.id);
    stmts.setAlertStatus.run('graded', p.alert_id);
    const icon = { hit: '🎯', partial: '🟡', miss: '❌', void: '⬜' }[g.score];
    await send([
      `${icon} <b>채점: ${g.score.toUpperCase()}</b> — ${esc(p.indicator_name)}`,
      `예측(${p.committed_at.slice(0, 10)}): "${esc(p.statement)}" [${p.expected_low}~${p.expected_high}]`,
      `실제(${p.target_date}): ${g.actual ?? '결측'}`,
    ].join('\n'));
    console.log(`  pred #${p.id}: ${g.score}`);
  }

  // 4. 미커밋 알림 재촉 (24h 경과, 최대 3회)
  for (const a of stmts.openAlertsToNag.all()) {
    stmts.bumpNag.run(a.id);
    await send(`⏳ 미커밋 알림 (${a.nag_count + 1}/3): <b>${esc(a.indicator_name)}</b> — ${a.observed_value} @ ${a.observed_date}\n원 알림에 답장으로 커밋하라. 커밋 전까지 닫히지 않는다.`);
    console.log(`  nag alert #${a.id}`);
  }

  // 5. 월요일 주간 트랙레코드 리포트 (하루 다회 실행 대비 kv 가드)
  const today = new Date().toISOString().slice(0, 10);
  if (new Date().getDay() === 1 && stmts.kvGet.get('weekly_report_last')?.value !== today) {
    const rows = stmts.trackRecord.all();
    if (rows.length) {
      await send(formatTrack(rows));
      stmts.kvSet.run('weekly_report_last', today);
    }
  }

  console.log(`[${new Date().toISOString()}] done in ${Date.now() - t0}ms`);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

main().catch((e) => { console.error('daily job fatal:', e); process.exit(1); });
