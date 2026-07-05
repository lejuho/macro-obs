// 분기 배치 (Phase 2): 대상 기업의 최신 정기보고서 → 발췌 → LLM 추출 → exposures
// 재개 가능(resumable): 이미 추출된 (corp, fy, reprt)는 건너뜀 → 중단돼도 재실행하면 이어짐.
//
// cron (분기 첫 주말 등 수동 판단으로 돌려도 됨):
//   0 3 15 1,4,7,10 *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js >> log/quarterly.log 2>&1
//
// 최초 셋업:
//   node src/jobs/quarterly.js --sync     # 고유번호 동기화 + targets.csv 마킹 (최초/반기 1회)
//   node src/jobs/quarterly.js            # 추출 실행
//   node src/jobs/quarterly.js --limit 3  # 파일럿: 3개사만

const { syncCorpCodes, markTargets, latestReport, fetchExcerpt } = require('../collectors/dart');
const { extract } = require('../extract/claude');
const { stmts } = require('../db');
const { send } = require('../notify/telegram');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  if (args.includes('--sync')) {
    console.log('corpCode 동기화 중...');
    const c = await syncCorpCodes();
    console.log(`  상장사 ${c.listed}건 등록`);
    const t = markTargets();
    console.log(`  대상 마킹: ${t.marked}/${t.requested}`);
    return;
  }

  const targets = stmts.targets.all();
  if (!targets.length) {
    console.log('대상 없음 — 먼저: node src/jobs/quarterly.js --sync');
    return;
  }

  const stats = { done: 0, skipped: 0, failed: 0, noReport: 0 };
  const failures = [];

  for (const corp of targets.slice(0, limit === Infinity ? undefined : limit + 50)) {
    if (stats.done >= limit) break;
    try {
      const rpt = await latestReport(corp.corp_code);
      if (!rpt) { stats.noReport++; console.log(`  ${corp.name}: 정기보고서 없음`); continue; }

      if (stmts.hasExposure.get(corp.corp_code, rpt.fy, rpt.reprt_code)) {
        stats.skipped++;
        continue;
      }

      console.log(`  ${corp.name}: ${rpt.report_nm} (${rpt.rcept_no}) 발췌 중...`);
      const excerpt = await fetchExcerpt(rpt.rcept_no);
      if (excerpt.length < 500) {
        stats.failed++; failures.push(`${corp.name}: 발췌 빈약(${excerpt.length}자)`);
        continue;
      }

      const r = extract(corp.name, excerpt);
      if (!r.ok) {
        stats.failed++; failures.push(`${corp.name}: ${r.reason}`);
        continue;
      }
      if (r.warnings?.length) console.warn(`  ⚠ ${corp.name}: evidence 없는 필드 ${r.warnings.join(',')}`);

      stmts.upsertExposure.run({
        corp_code: corp.corp_code, fy: rpt.fy, reprt_code: rpt.reprt_code, rcept_no: rpt.rcept_no,
        export_ratio: r.data.export_ratio ?? null,
        usd_revenue_ratio: r.data.usd_revenue_ratio ?? null,
        fx_debt_ratio: r.data.fx_debt_ratio ?? null,
        float_rate_ratio: r.data.float_rate_ratio ?? null,
        import_deps: JSON.stringify(r.data.import_deps ?? []),
        evidence: JSON.stringify(r.data.evidence ?? {}),
        raw_json: JSON.stringify(r.data),
      });
      stats.done++;
      console.log(`  ✅ ${corp.name} (${stats.done}${limit !== Infinity ? '/' + limit : ''})`);

      await sleep(3000); // DART 예의 + claude 구독 한도 분산
    } catch (e) {
      stats.failed++; failures.push(`${corp.name}: ${e.message.slice(0, 120)}`);
      console.error(`  ❌ ${corp.name}: ${e.message}`);
      await sleep(3000);
    }
  }

  const summary = `📦 노출 매트릭스 배치: 추출 ${stats.done} · 스킵 ${stats.skipped} · 실패 ${stats.failed} · 보고서없음 ${stats.noReport}`;
  console.log(summary);
  if (failures.length) console.log('실패 목록:\n  ' + failures.join('\n  '));
  if (stats.done || stats.failed) {
    await send(summary + (failures.length ? `\n실패: ${failures.slice(0, 5).join(' / ')}${failures.length > 5 ? ' 외' : ''}` : '')).catch(() => {});
  }
}

main().catch((e) => { console.error('quarterly fatal:', e); process.exit(1); });
