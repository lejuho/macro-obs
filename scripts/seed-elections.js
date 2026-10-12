// 선거/레버 시드 등록 (멱등 — 재실행 시 레버는 갱신)
const { stmts, tx } = require('../src/db');
const { ELECTIONS } = require('../data/elections-seed');

tx(() => {
  for (const e of ELECTIONS) {
    const { id } = stmts.upsertElection.get({ country: e.country, body: e.body, date: e.date, note: e.note });
    stmts.clearLevers.run(id);
    for (const l of (e.levers || [])) {
      stmts.insertLever.run({
        election_id: id, outcome_branch: l.branch, lever: l.lever,
        scenario_name: l.scenario || null, note: l.note || null,
      });
    }
    console.log(`${e.date} ${e.country} ${e.body} — 레버 ${e.levers?.length || 0}`);
  }
});
console.log('완료. 텔레그램 /elec 로 조회.');
