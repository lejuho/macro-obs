// Phase 3b 테스트: 웹서버 API — 시드된 DB에 대해 전 엔드포인트 검증
// 실행: node --no-warnings test/phase3b.test.js

process.env.DB_PATH = '/tmp/macro-p3b.db';
process.env.DRY_RUN = '1';
const fs = require('fs');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { execSync } = require('child_process');
execSync(`DB_PATH=${process.env.DB_PATH} node --no-warnings scripts/seed-graph.js`, { cwd: __dirname + '/..' });

const { db, stmts } = require('../src/db');
const { createServer } = require('../src/jobs/server');

let pass = 0, fail = 0;
const assert = (c, n) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

// 픽스처: 가설 + 관측 + 알림 + 예측
const { id: indId } = stmts.upsertIndicator.get({
  source: 'ecos', source_code: 'T/w', name: '원/달러 환율', freq: 'D', unit: 'KRW', category: 'macro', note: null,
});
db.prepare(`INSERT INTO hypotheses (statement, indicator_id, band_low, band_high, rationale)
  VALUES ('환율 뉴노멀 1350~1480', ?, 1350, 1480, '근거')`).run(indId);
for (let i = 0; i < 30; i++) {
  stmts.upsertObs.run(indId, new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), 1400 + i);
}
const { id: alertId } = stmts.insertAlert.get({
  hypothesis_id: 1, observed_value: 1490, observed_date: '2026-07-04', direction: 'above',
});
stmts.insertPrediction.get({
  alert_id: alertId, statement: '1450~1520', expected_low: 1450, expected_high: 1520,
  target_date: '2026-10-03',
});

(async () => {
  const server = createServer(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = (p) => fetch(base + p).then((r) => r.json());

  const st = await j('/api/status');
  assert(st.hypotheses.length === 1 && st.hypotheses[0].latest === 1400, 'status: 가설+최신값');
  assert(st.open_alerts.length === 1 && st.pending_predictions === 1, 'status: 알림/예측 카운트');

  const series = await j(`/api/series/${indId}?days=10`);
  assert(series.length >= 9 && series[0].date < series[series.length - 1].date, 'series: 기간 필터 + 오름차순');

  const g = await j('/api/graph');
  const seed = require('../data/graph-seed');
assert(g.nodes.length === seed.NODES.length && g.edges.length === seed.EDGES.length, 'graph: 시드 노드/간선 수 일치');
  assert(g.edges.some((e) => e.kind === 'coercion_transfer' && e.leverage_note), 'graph: coercion 간선에 leverage_note');

  const scs = await j('/api/scenarios');
  assert(scs.length === seed.SCENARIOS.length, 'scenarios: 시드 수 일치');
  const coercion = scs.find((s) => s.name === '미국 관세·산업정책 압박');
  const d = await j('/api/scenario/' + coercion.id);
  assert(d.results.length > 0 && Array.isArray(d.results[0].path), 'scenario: 결과 + path 배열');
  const semi = d.results.filter((r) => r.name === '반도체');
  assert(semi.length >= 2 && new Set(semi.map((r) => Math.sign(r.impact))).size > 1, 'scenario: 경합 경로 별도 행');

  assert((await fetch(base + '/api/scenario/999')).status === 404, '404: 없는 시나리오');
  assert((await fetch(base + '/api/nope')).status === 404, '404: 없는 API');

  const html = await fetch(base + '/').then((r) => r.text());
  assert(html.includes('관측소') && html.includes('manifest.webmanifest'), 'static: index.html 서빙');
  assert(html.includes('운영 동선') && html.includes('평시에 할 일'), 'guide: 안내 탭 포함');
  assert((await fetch(base + '/sw.js')).headers.get('content-type').includes('javascript'), 'static: MIME');
  assert((await fetch(base + '/../etc/passwd')).status === 404, 'static: 경로 탈출 차단');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
