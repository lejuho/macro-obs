// 월간 배치 (Phase 6): 관측 노트 초안 생성 → 텔레그램 통지
// cron: 0 22 1 * *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/monthly.js >> log/monthly.log 2>&1

const { generateDraft } = require('../drafts');
const { send } = require('../notify/telegram');
const { stmts } = require('../db');

async function main() {
  const ym = new Date().toISOString().slice(0, 7);
  if (stmts.kvGet.get('draft_last')?.value === ym) { console.log('이번 달 초안 이미 생성'); return; }

  const r = generateDraft();
  if (r.skip) { console.log(`skip: ${r.skip}`); return; }
  if (!r.ok) {
    console.error(`draft failed: ${r.reason}`);
    await send(`📝 월간 초안 생성 실패: ${r.reason}`).catch(() => {});
    process.exit(1);
  }
  stmts.kvSet.run('draft_last', ym);
  console.log(`draft: ${r.file} (${r.chars}자)`);
  await send([
    `📝 <b>${r.ym} 관측 노트 초안 생성</b>`,
    `재료: 채점 ${r.material_counts.graded} · 가설수정 ${r.material_counts.revisions} · 이탈 ${r.material_counts.breaches} · 뉴스교훈 ${r.material_counts.lessons}`,
    `파일: <code>out/drafts/${r.ym}.md</code>`,
    ``,
    `시스템은 초안까지 — 발행 여부와 손질은 네 몫이다.`,
  ].join('\n')).catch(() => {});
}

main().catch((e) => { console.error('monthly fatal:', e); process.exit(1); });
