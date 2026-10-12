// 분기 배치 (Phase 2): 대상 기업의 최신 정기보고서 → 발췌 → LLM 추출 → exposures
// 재개 가능(resumable): 이미 추출된 (corp, fy, reprt)는 건너뜀 → 중단돼도 재실행하면 이어짐.
//
// cron (분기당 10회: 30개사씩 5시간 간격, 199개사 + 재시도 여유):
//   0 3,8,13,18,23 13-14 1,4,7,10 *  cd /home/pi/macro-obs && PATH=/home/pi/.local/bin:/usr/bin:/bin /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js --limit 30 >> log/quarterly.log 2>&1
//
// 최초 셋업:
//   node src/jobs/quarterly.js --sync     # 고유번호 동기화 + targets.csv 마킹 (최초/반기 1회)
//   node src/jobs/quarterly.js            # 추출 실행
//   node src/jobs/quarterly.js --limit 3  # 파일럿: 3개사만

const { syncCorpCodes, markTargets, latestReports, fetchExcerpt } = require('../collectors/dart');
const { cacheReport, clearReportCache } = require('../mcp-batch-tools');

const AGENT = process.env.EXTRACT_AGENT === '1'; // 2층 opt-in — 실패 시 자동 플레인 폴백
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

  for (const corp of targets) {
    if (stats.done >= limit) break;
    try {
      const reports = await latestReports(corp.corp_code);
      if (!reports.length) { stats.noReport++; console.log(`  ${corp.name}: 정기보고서 없음`); continue; }

      let rpt = null;
      let excerpt = null;
      let skipped = false;
      const unavailable = [];
      for (const candidate of reports) {
        if (stmts.hasExposure.get(corp.corp_code, candidate.fy, candidate.reprt_code)) {
          stats.skipped++;
          skipped = true;
          break;
        }

        console.log(`  ${corp.name}: ${candidate.report_nm} (${candidate.rcept_no}) 발췌 중...${AGENT ? ' [agent]' : ''}`);
        try {
          excerpt = await fetchExcerpt(candidate.rcept_no, AGENT ? { cache: true } : {});
          rpt = candidate;
          break;
        } catch (e) {
          if (e.code !== 'DART_DOCUMENT_UNAVAILABLE') throw e;
          unavailable.push(candidate.rcept_no);
          console.warn(`  ⚠ ${corp.name}: ${e.message} → 이전 정기보고서 시도`);
        }
      }
      if (skipped) continue;
      if (!rpt) {
        stats.failed++;
        failures.push(`${corp.name}: DART 원문 없음 (${unavailable.join(', ')})`);
        continue;
      }

      if (excerpt.length < 500) {
        stats.failed++; failures.push(`${corp.name}: 발췌 빈약(${excerpt.length}자)`);
        continue;
      }

      const r = extract(corp.name, excerpt, { agent: AGENT, rceptNo: rpt.rcept_no });
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

  if (AGENT) clearReportCache(); // 원문 임시 캐시 정리
  const summary = `📦 노출 매트릭스 배치: 추출 ${stats.done} · 스킵 ${stats.skipped} · 실패 ${stats.failed} · 보고서없음 ${stats.noReport}`;
  console.log(summary);
  if (failures.length) console.log('실패 목록:\n  ' + failures.join('\n  '));
  if (stats.done || stats.failed) {
    await send(summary + (failures.length ? `\n실패: ${failures.slice(0, 5).join(' / ')}${failures.length > 5 ? ' 외' : ''}` : '')).catch(() => {});
  }
}

main().catch((e) => { console.error('quarterly fatal:', e); process.exit(1); });
