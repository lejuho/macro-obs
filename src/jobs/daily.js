// 일일 배치: 수집 → 밴드 감시 → 알림 → 채점 → 재촉(nag) → (월요일) 주간 리포트
// cron (하루 2회 — ECOS 반영 시차 흡수, 중복 실행 무해):
//   0 9  * * *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/daily.js >> log/daily.log 2>&1
//   0 19 * * *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/daily.js >> log/daily.log 2>&1

const { collect } = require('../collectors/ecos');
const { collect: collectFred } = require('../collectors/fred');
const { computeAll: computeDerived } = require('../derived');
const { scan: scanTriggers, formatFired } = require('../triggers');
const { scan } = require('../watcher');
const { send, alertKeyboard, formatBreach } = require('../notify/telegram');
const { db, stmts } = require('../db');
const { grade, pickGradingObs, formatTrack } = require('../predictions');
const { exposureSection, scenarioHints } = require('../exposure');
const worldview = require('../worldview');

async function main() {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] daily job start`);

  // 1. 수집
  const results = await collect({ lookbackDays: 30 });
  const fredResults = await collectFred({ lookbackDays: 45 });
  for (const r of [...results, ...fredResults]) {
    console.log(r.ok ? `  collect ${r.key}: ${r.count} rows` : `  collect ${r.key}: FAILED — ${r.error}`);
  }
  if (results.length && results.every((r) => !r.ok)) {
    await send(`⚠️ macro-obs: 전체 수집 실패\n${results.map((f) => f.error).join('\n')}`).catch(() => {});
  }

  // 1.5 파생 지표 계산
  for (const r of computeDerived()) {
    if (r.skip) continue;
    console.log(r.ok ? `  derived ${r.key}: ${r.count} rows` : `  derived ${r.key}: FAILED — ${r.error}`);
  }

  // 2. 밴드 감시 → 알림
  for (const b of scan()) {
    const srcCode = db.prepare('SELECT source_code FROM indicators WHERE id = ?').get(b.hyp.indicator_id)?.source_code;
    const extra = srcCode
      ? [exposureSection(srcCode), scenarioHints(srcCode)].filter(Boolean).join('\n') || null
      : null;
    const msg = await send(formatBreach({ ...b, extra }), {
      reply_markup: alertKeyboard(b.alert_id),
      event: { kind: 'breach', data: {
        alert_id: b.alert_id, hypothesis_id: b.hyp.id, indicator: b.hyp.indicator_name,
        band: [b.hyp.band_low, b.hyp.band_high], ...b.breach,
      } },
    });
    if (msg.message_id) stmts.setAlertTgId.run(msg.message_id, b.alert_id);
    console.log(`  alert #${b.alert_id} sent`);
  }

  // 2.5 결정 트리거 평가 (스펙 §4.2)
  for (const f of scanTriggers()) {
    const msg = await send(formatFired(f), {
      event: { kind: 'trigger', data: { alert_id: f.alert_id, trigger_id: f.trigger.id, name: f.trigger.name } },
    });
    if (msg.message_id) stmts.setAlertTgId.run(msg.message_id, f.alert_id);
    console.log(`  trigger fired: #${f.trigger.id} ${f.trigger.name}`);
  }

  // 3. 채점 (target_date 도래 예측)
  for (const p of stmts.dueForGrading.all()) {
    const pick = pickGradingObs(stmts, p);
    if (pick.wait) { console.log(`  pred #${p.id}: ${pick.period} 관측 공표 대기`); continue; }
    const obs = pick.obs;
    const g = grade(p, obs, p.target_date, p.freq);

    if (g.score === 'manual') {
      // 자유 서술 → self-grade 요청. 답장 매칭을 위해 message_id 저장.
      const msg = await send([
        `⏰ <b>채점일 도래 — self-grade 필요</b>`,
        `${esc(p.indicator_name)} · 예측 #${p.id}`,
        `당시 커밋: "${esc(p.statement)}"`,
        `현재 관측: ${obs ? `${obs.value} (${obs.date})` : '결측'}`,
        ``,
        `이 메시지에 답장: <code>hit</code> 또는 <code>miss</code>`,
      ].join('\n'), { event: { kind: 'grade_request', data: { prediction_id: p.id, indicator: p.indicator_name, observed: obs || null } } });
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
      `실제(${pick.period ? `${pick.period.slice(0, 7)}분` : p.target_date}): ${g.actual ?? '결측'}`,
    ].join('\n'), { event: { kind: 'grade', data: {
      prediction_id: p.id, indicator: p.indicator_name, statement: p.statement,
      expected: [p.expected_low, p.expected_high], target_date: p.target_date, actual: g.actual, score: g.score,
    } } });
    console.log(`  pred #${p.id}: ${g.score}`);
  }

  // 4. 미커밋 알림 재촉 (24h 경과, 최대 3회)
  for (const a of stmts.openAlertsToNag.all()) {
    stmts.bumpNag.run(a.id);
    await send(`⏳ 미커밋 알림 (${a.nag_count + 1}/3): <b>${esc(a.indicator_name)}</b> — ${a.observed_value} @ ${a.observed_date}\n원 알림에 답장으로 커밋하라. 커밋 전까지 닫히지 않는다.`);
    console.log(`  nag alert #${a.id}`);
  }

  // 4.5 선거 D-30/D-7 리마인더 (kv 가드 — 각 1회)
  for (const e of stmts.upcomingElections.all(5)) {
    const dday = Math.ceil((new Date(e.date) - Date.now()) / 86400_000);
    for (const mark of [30, 7]) {
      if (dday === mark && !stmts.kvGet.get(`elec_${e.id}_d${mark}`)) {
        const levers = stmts.leversFor.all(e.id);
        await send([
          `🗳 <b>D-${mark}: ${e.country} ${e.body}</b> (${e.date})`,
          e.note ? `<i>${e.note}</i>` : '',
          ...levers.map((l) => `· [${l.outcome_branch}] ${l.lever}`),
          levers.length ? '' : '⚠️ 레버 미작성 — data/elections-seed.js 갱신 시점',
          '분기별 결과가 나오면 해당 시나리오를 열어 세계를 확인하라.',
        ].filter(Boolean).join('\n'));
        stmts.kvSet.run(`elec_${e.id}_d${mark}`, '1');
        console.log(`  election reminder: ${e.country} D-${mark}`);
      }
    }
  }

  // 5. 월요일 주간 트랙레코드 리포트 (하루 다회 실행 대비 kv 가드)
  const today = new Date().toISOString().slice(0, 10);
  if (new Date().getDay() === 1 && stmts.kvGet.get('weekly_report_last')?.value !== today) {
    const rows = stmts.trackRecord.all();
    if (rows.length) {
      await send(formatTrack(rows), { event: { kind: 'track_weekly', data: { rows } } });
      stmts.kvSet.run('weekly_report_last', today);
    }
  }

  // 6. 현재 관점 T+N 검토 — 하루 최대 1건, 예비 판정 후 사용자 확인 전까지 그래프 불변
  const dueView = stmts.dueWorldviewReviews.get();
  if (dueView) {
    const r = worldview.generateReview(dueView.id);
    if (!r.ok) console.error(`  worldview #${dueView.id} review FAILED — ${r.reason}`);
    else {
      const msg = await send(worldview.formatReview(r.bundle.commit, r.data), {
        event: { kind: 'worldview_review', data: { worldview_id: dueView.id, review: r.data } },
      });
      stmts.setWorldviewReviewPending.run({ id: dueView.id, message_id: msg.message_id || null });
      if (msg.message_id) stmts.kvSet.run(`worldview_review_msg_${msg.message_id}`, String(dueView.id));
      console.log(`  worldview #${dueView.id}: review pending confirmation`);
    }
  }

  console.log(`[${new Date().toISOString()}] done in ${Date.now() - t0}ms`);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

main().catch((e) => { console.error('daily job fatal:', e); process.exit(1); });
