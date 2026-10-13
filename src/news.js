// 뉴스 프레이밍 파이프라인 (Phase 5) — LLM은 인자 주입(DI)으로 테스트 가능
const fs = require('fs');
const path = require('path');
const { stmts, tx } = require('./db');
const llm = require('./llm');
const QUERIES = require('../data/news-queries');
const {
  AXES, COUNTRIES, resolveProfiles, compactForPrompt,
} = require('./political-context');

const P = (f) => fs.readFileSync(path.join(__dirname, '..', 'prompts', f), 'utf8');

// ── 클러스터링 ──────────────────────────────────────────

const AGENT_CLUSTER_APPENDIX = `
[에이전트 모드] batch 서버의 search_news_live(query)로 추가 검색이 가능하다.
사건 판단이 애매한 기사(맥락 부족)는 관련 키워드로 1~2회 검색해 확인하고 배정하라.`;

const AGENT_REVISIT_APPENDIX = `
[에이전트 모드] 도구:
- batch.search_news_live(query): 다른 키워드로 최근 보도 추가 검색
- obs.get_series(indicator, days): 관측소의 실제 지표 시계열 (예: "환율", 120)
수치가 걸린 주장(예: "연말 1650")은 뉴스 서사가 아니라 get_series의 실제 데이터로 채점하라.
현재 기사가 부족하면 search_news_live로 보강하되, 근거 없는 held/failed 판정은 여전히 금지.`;

function buildClusterPrompt(items, existingKeys, { agent = false, politicalContexts = [] } = {}) {
  const lines = items.map((it) =>
    `[${it.id}] ${it.source}(${it.spectrum}) | ${it.title} | ${it.description || ''}`);
  return [
    P('news-cluster.md'),
    agent ? AGENT_CLUSTER_APPENDIX : '',
    existingKeys.length ? `기존 사건 키: ${existingKeys.join(', ')}` : '기존 사건 키: 없음',
    // enum을 명시 — 이전엔 정치구조 JSON의 하위 키(regime, legislature…)를 축으로 오인해 쿼리 전체가 거부됐다
    `[허용 국가 코드] ${COUNTRIES.map((c) => c.code).join(', ')} (이 밖의 나라는 countries에 넣지 마라)`,
    `[허용 구조 축] ${AXES.join(', ')} (axis 값은 이 중 정확히 하나. 하위 필드명·국가명·자유 서술 금지)`,
    politicalContexts.length
      ? `[관련 가능 국가의 시점별 정치구조 파라미터] (참고 자료 — 이 JSON의 키는 구조 축 이름이 아니다)\n${JSON.stringify(compactForPrompt(politicalContexts))}`
      : '[관련 가능 국가의 정치구조 파라미터] 없음',
    '--- 기사 시작 ---', ...lines, '--- 기사 끝 ---',
  ].filter(Boolean).join('\n');
}

// LLM이 자주 내는 하위 필드명/별칭 → 축. 매핑 안 되는 축의 가설은 버린다(추측 매핑 금지).
const AXIS_ALIASES = {
  regime: 'power_structure', legislature: 'power_structure', executive: 'power_structure',
  relation: 'government_status', divided_government: 'government_status', cohabitation: 'government_status',
  election: 'election_cycle', elections: 'election_cycle', midterm: 'election_cycle', midterms: 'election_cycle',
  parties: 'party_system', party: 'party_system',
  media: 'information_environment', federalism: 'territorial_structure',
};

function normalizeAxis(axis) {
  const raw = String(axis || '').trim();
  if (AXES.includes(raw)) return raw;
  // "electoral_system.legislature", "external_constraints: North_Korea" → 앞부분
  const head = raw.split(/[.:\s(]/)[0].toLowerCase().replace(/-/g, '_');
  if (AXES.includes(head)) return head;
  if (AXIS_ALIASES[head]) return AXIS_ALIASES[head];
  return null;
}

/**
 * 관대한 정리: 사소한 enum 이탈 하나로 쿼리 전체(수십 건)를 버리지 않도록
 * 알 수 없는 국가 코드는 제거, 구조 축은 정규화(불가 시 그 가설만 제거),
 * event_key는 소문자화, 이중 배정은 첫 배정 유지, 미배정 id는 다음 배치로 넘긴다.
 * 반환 { data, warnings, missing } — data는 사본.
 */
function sanitizeClusterOut(data, itemIds) {
  const warnings = [];
  if (!data || !Array.isArray(data.clusters)) return { data, warnings, missing: [] };
  const countryCodes = new Set(COUNTRIES.map((c) => c.code));
  const valid = new Set(itemIds);
  const seen = new Set();
  const take = (id, where) => {
    if (!valid.has(id)) { warnings.push(`입력에 없는 id 무시(${where}): ${id}`); return false; }
    if (seen.has(id)) { warnings.push(`id 이중 배정 → 첫 배정 유지: ${id}`); return false; }
    seen.add(id); return true;
  };
  const clusters = data.clusters.map((c0) => {
    const c = { ...c0 };
    if (typeof c.event_key === 'string') {
      const k = c.event_key.trim().toLowerCase().replace(/[\s_]+/g, '-');
      if (k !== c.event_key) warnings.push(`event_key 정규화: ${c.event_key} → ${k}`);
      c.event_key = k;
    }
    if (Array.isArray(c.member_ids)) c.member_ids = c.member_ids.filter((id) => take(id, c.event_key));
    if (Array.isArray(c.countries)) {
      const bad = c.countries.filter((x) => !countryCodes.has(x));
      if (bad.length) warnings.push(`알 수 없는 국가 코드 제거(${c.event_key}): ${bad.join(',')}`);
      c.countries = c.countries.filter((x) => countryCodes.has(x));
    }
    if (Array.isArray(c.structural_hypotheses)) {
      c.structural_hypotheses = c.structural_hypotheses.flatMap((h) => {
        const axis = normalizeAxis(h && h.axis);
        if (!axis) { warnings.push(`구조 축 불명 → 가설 제거(${c.event_key}): ${h && h.axis}`); return []; }
        if (axis !== h.axis) warnings.push(`구조 축 정규화: ${h.axis} → ${axis}`);
        if (!h.mechanism || !h.expected_outcome || !['explicit', 'inferred'].includes(h.basis)) {
          warnings.push(`구조 가설 형식 불량 → 제거(${c.event_key}): ${axis}`); return [];
        }
        return [{ ...h, axis }];
      });
    }
    if (Array.isArray(c.notable_claims)) {
      c.notable_claims = c.notable_claims.filter((cl) => cl && cl.source && cl.claim);
    }
    return c;
  }).filter((c) => !Array.isArray(c.member_ids) || c.member_ids.length);
  const noise_ids = (data.noise_ids || []).filter((id) => take(id, 'noise'));
  const missing = itemIds.filter((id) => !seen.has(id));
  if (missing.length) warnings.push(`미배정 ${missing.length}건 → 다음 배치로: ${missing.slice(0, 5).join(',')}`);
  return { data: { ...data, clusters, noise_ids }, warnings, missing };
}

/** 프레이밍이 비었는지 (축별·핵심 프레임 전무 + 주장 0) — 재방문 판정이 불가능해지는 스냅샷 */
function framingGap(c) {
  const f = c.spectrum_frames || {};
  const anyFrame = ['A', 'B', 'wire', 'unknown'].some((k) => f[k]) || !!c.core_frame;
  return !anyFrame && !(c.notable_claims || []).length && !c.expected_development;
}

/** 순수 검증: 출력 구조 + 모든 id가 정확히 한 곳에 배정됐는지 */
function validateClusterOut(data, itemIds) {
  if (!data || !Array.isArray(data.clusters)) return { ok: false, reason: 'clusters 배열 없음' };
  const seen = new Set();
  const countryCodes = new Set(COUNTRIES.map((c) => c.code));
  for (const c of data.clusters) {
    if (!/^[a-z0-9][a-z0-9-]{3,60}$/.test(c.event_key || '')) return { ok: false, reason: `event_key 형식: ${c.event_key}` };
    if (!c.title || !Array.isArray(c.member_ids)) return { ok: false, reason: `클러스터 구조: ${c.event_key}` };
    for (const id of c.member_ids) {
      if (seen.has(id)) return { ok: false, reason: `id 중복 배정: ${id}` };
      seen.add(id);
    }
    for (const cl of c.notable_claims || []) {
      if (!cl.source || !cl.claim) return { ok: false, reason: 'claim 구조' };
    }
    if (c.countries != null && !Array.isArray(c.countries)) return { ok: false, reason: 'countries 배열 아님' };
    for (const code of c.countries || []) {
      if (!countryCodes.has(code)) return { ok: false, reason: `알 수 없는 국가 코드: ${code}` };
    }
    for (const h of c.structural_hypotheses || []) {
      if (!AXES.includes(h.axis)) return { ok: false, reason: `구조 축 enum: ${h.axis}` };
      if (!h.mechanism || !h.expected_outcome || !['explicit', 'inferred'].includes(h.basis)) {
        return { ok: false, reason: `구조 가설 형식: ${h.axis}` };
      }
    }
  }
  for (const id of data.noise_ids || []) {
    if (seen.has(id)) return { ok: false, reason: `id 중복(noise): ${id}` };
    seen.add(id);
  }
  const missing = itemIds.filter((id) => !seen.has(id));
  if (missing.length) return { ok: false, reason: `미배정 id: ${missing.slice(0, 5).join(',')}` };
  return { ok: true };
}

/** 쿼리 1개분 클러스터링 실행. runLLM 주입 가능 (기본 llm.run) */
function clusterQuery(query, runLLM = llm.run, { agent = false } = {}) {
  const items = stmts.unclusteredItems.all(query);
  if (!items.length) return { query, skip: 'no items' };

  const existing = stmts.recentClusters.all(query).map((c) => c.event_key);
  const queryConfig = QUERIES.find((q) => q.query === query) || {};
  const politicalContexts = resolveProfiles(queryConfig.countries || [], new Date());
  const parsed = llm.runJson(buildClusterPrompt(items, existing, { agent, politicalContexts }),
    { runLLM, requireKey: 'clusters', label: `cluster-${query}`, agent, servers: ['batch'] });
  if (!parsed.ok) return { query, ok: false, reason: parsed.reason };

  const itemIds = items.map((i) => i.id);
  const clean = sanitizeClusterOut(parsed.data, itemIds);
  parsed.data = clean.data;
  const assigned = itemIds.filter((id) => !clean.missing.includes(id));
  const v = validateClusterOut(parsed.data, assigned);
  if (!v.ok) return { query, ok: false, reason: v.reason, warnings: clean.warnings };

  let created = 0, updated = 0, gaps = 0;
  const itemById = new Map(items.map((item) => [item.id, item]));
  tx(() => {
    for (const c of parsed.data.clusters) {
      let row = stmts.clusterByKey.get(c.event_key);
      let clusterId;
      const countryCodes = [...new Set(c.countries || [])];
      const countriesJson = JSON.stringify(countryCodes);
      if (row) {
        clusterId = row.id;
        stmts.touchCluster.run(clusterId);
        if (countryCodes.length) stmts.setClusterCountries.run(countriesJson, clusterId);
        updated++;
      }
      else {
        clusterId = stmts.insertCluster.get({
          event_key: c.event_key, title: c.title, query, countries_json: countriesJson,
        }).id;
        created++;
      }
      for (const id of c.member_ids) stmts.assignCluster.run(clusterId, id);
      // initial 스냅샷은 클러스터당 1회 (신규일 때만)
      if (!row) {
        const eventDates = c.member_ids
          .map((id) => itemById.get(id)?.pub_date)
          .filter(Boolean)
          .sort();
        const eventDate = eventDates[0] || new Date().toISOString();
        stmts.insertSnapshot.run(clusterId, 'initial', JSON.stringify({
          spectrum_frames: c.spectrum_frames || {}, notable_claims: c.notable_claims || [],
          core_frame: c.core_frame || null, expected_development: c.expected_development || null,
          ...(framingGap(c) ? (gaps++, { framing_gap: true }) : {}),
          country_codes: countryCodes,
          political_contexts: resolveProfiles(countryCodes, eventDate),
          structural_hypotheses: c.structural_hypotheses || [],
        }));
      }
    }
    for (const id of parsed.data.noise_ids || []) stmts.markNoise.run(id);
  });
  return {
    query, ok: true, created, updated, noise: (parsed.data.noise_ids || []).length,
    deferred: clean.missing.length, framing_gaps: gaps,
    ...(parsed.repaired ? { repaired: true } : {}),
    ...(clean.warnings.length ? { warnings: clean.warnings } : {}),
  };
}

// ── 90일 재방문 ─────────────────────────────────────────

function buildRevisitPrompt(cluster, initial, recentItems, { agent = false, currentContexts = [] } = {}) {
  const claims = (initial.notable_claims || [])
    .map((c) => `- ${c.source}: ${c.claim}`).join('\n') || '- (없음)';
  const frames = Object.entries(initial.spectrum_frames || {})
    .map(([k, v]) => `- ${k}: ${v || '(없음)'}`).join('\n');
  const recent = recentItems.map((it) => `- ${it.source} | ${it.title} | ${it.description || ''}`).join('\n')
    || '- (최근 보도 없음)';
  const hypotheses = (initial.structural_hypotheses || [])
    .map((h) => `- ${h.axis}: ${h.mechanism} → ${h.expected_outcome} (${h.basis})`).join('\n') || '- (없음)';
  return [
    P('news-revisit.md'),
    agent ? AGENT_REVISIT_APPENDIX : '',
    `[당시 스냅샷] (${cluster.first_seen.slice(0, 10)})`,
    `사건: ${cluster.title}`,
    `핵심 프레임: ${initial.core_frame || '(기록 없음)'}`,
    `당시 기대된 전개: ${initial.expected_development || '(기록 없음)'}`,
    `축별 프레이밍:\n${frames}`, `매체별 주장:\n${claims}`,
    ...(initial.framing_gap || (!initial.core_frame && !frames.replace(/- \w+: \(없음\)\n?/g, '').trim())
      ? ['[주의] 당시 프레이밍 기록이 비어 있다. 프레임·주장 판정은 null/unclear로 두고, 사건 제목 기준 실제 전개(outcome_summary)만 기술하라. 당시 프레임을 추정해 만들지 마라.']
      : []),
    `[당시 정치구조]\n${JSON.stringify(initial.political_contexts || [])}`,
    `[현재 정치구조]\n${JSON.stringify(currentContexts)}`,
    `[당시 구조적 가설]\n${hypotheses}`,
    `[현재 기사들]`, recent,
  ].join('\n\n');
}

function validateRevisitOut(data, initialClaims, initialHypotheses = []) {
  if (!data || !data.outcome_summary) return { ok: false, reason: 'outcome_summary 없음' };
  const known = new Set((initialClaims || []).map((c) => c.source));
  for (const v of data.claim_verdicts || []) {
    if (!['held', 'failed', 'unclear'].includes(v.verdict)) return { ok: false, reason: `verdict enum: ${v.verdict}` };
    if (!known.has(v.source)) return { ok: false, reason: `당시 목록에 없는 매체: ${v.source}` };
  }
  const knownAxes = new Set(initialHypotheses.map((h) => h.axis));
  for (const v of data.structural_verdicts || []) {
    if (!['consistent', 'inconsistent', 'unclear'].includes(v.verdict)) {
      return { ok: false, reason: `구조 verdict enum: ${v.verdict}` };
    }
    if (!knownAxes.has(v.axis)) return { ok: false, reason: `당시 목록에 없는 구조 축: ${v.axis}` };
  }
  return { ok: true };
}

/**
 * 재방문 1건. fetchRecent(cluster) → 최근 기사 메타 (기본: 네이버 재검색), runLLM 주입 가능
 */
async function revisitCluster(cluster, { runLLM = llm.run, fetchRecent, agent = false } = {}) {
  const snap = stmts.snapshotFor.get(cluster.id, 'initial');
  if (!snap) { stmts.markRevisited.run(cluster.id); return { cluster: cluster.event_key, skip: 'no initial snapshot' }; }
  const initial = JSON.parse(snap.content_json);
  let countryCodes = initial.country_codes || [];
  if (!countryCodes.length) {
    try { countryCodes = JSON.parse(cluster.countries_json || '[]'); } catch { countryCodes = []; }
  }
  const currentContexts = resolveProfiles(countryCodes, new Date());

  let recent = [];
  if (fetchRecent) recent = await fetchRecent(cluster);
  else {
    try {
      const { search, parseItems } = require('./collectors/naver');
      recent = parseItems(await search(cluster.title.slice(0, 30), 20), cluster.query).slice(0, 20);
    } catch { recent = []; }
  }

  const parsed = llm.runJson(buildRevisitPrompt(cluster, initial, recent, { agent, currentContexts }),
    { runLLM, requireKey: 'outcome_summary', label: `revisit-${cluster.event_key}`, agent, servers: ['batch', 'obs'] });
  if (!parsed.ok) return { cluster: cluster.event_key, ok: false, reason: parsed.reason };
  const v = validateRevisitOut(parsed.data, initial.notable_claims, initial.structural_hypotheses);
  if (!v.ok) return { cluster: cluster.event_key, ok: false, reason: v.reason };

  tx(() => {
    stmts.insertSnapshot.run(cluster.id, 'revisit', JSON.stringify(parsed.data));
    for (const cv of parsed.data.claim_verdicts || []) {
      stmts.insertPressTrack.run({
        cluster_id: cluster.id, source: cv.source, claim: cv.claim,
        verdict: cv.verdict, note: cv.note || null,
      });
    }
    stmts.markRevisited.run(cluster.id);
  });
  return { cluster: cluster.event_key, ok: true, verdicts: (parsed.data.claim_verdicts || []).length, data: parsed.data };
}

// ── 포맷터 ──────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatRevisit(cluster, data) {
  const fv = data.frame_verdicts || {};
  const mark = (h) => (h === true ? '✅ 유지' : h === false ? '❌ 뒤집힘' : '⬜ 불명');
  return [
    `📰 <b>90일 재방문: ${esc(cluster.title)}</b> (${cluster.first_seen.slice(0, 10)} 사건)`,
    ``,
    `<b>실제 전개:</b> ${esc(data.outcome_summary)}`,
    ``,
    ...(fv.core ? [`핵심 프레임: ${mark(fv.core.held)} — ${esc(fv.core.note)}`] : []),
    ...(fv.A ? [`A축: ${mark(fv.A.held)} — ${esc(fv.A.note)}`] : []),
    ...(fv.B ? [`B축: ${mark(fv.B.held)} — ${esc(fv.B.note)}`] : []),
    ``,
    ...((data.claim_verdicts || []).map((c) =>
      `${{ held: '🎯', failed: '❌', unclear: '⬜' }[c.verdict]} ${esc(c.source)}: "${esc(c.claim)}" — ${esc(c.note || '')}`)),
    ...((data.structural_verdicts || []).map((v) =>
      `${{ consistent: '🧭', inconsistent: '↩️', unclear: '⬜' }[v.verdict]} 구조(${esc(v.axis)}): ${esc(v.note || '')}`)),
    ``,
    `💡 ${esc(data.lesson || '')}`,
  ].join('\n');
}

function formatPressTrack() {
  const rows = stmts.pressTrackAgg.all();
  if (!rows.length) return '언론사 트랙레코드 없음 — 첫 클러스터의 90일 재방문 이후 쌓인다.';
  const by = {};
  for (const r of rows) { (by[r.source] ??= { held: 0, failed: 0, unclear: 0 })[r.verdict] = r.n; }
  const lines = ['📰 <b>언론사 트랙레코드</b> (검증가능 주장의 90일 후 판정)', ''];
  for (const [src, s] of Object.entries(by).sort((a, b) =>
    (b[1].held + b[1].failed) - (a[1].held + a[1].failed))) {
    const graded = s.held + s.failed;
    const rate = graded ? Math.round((s.held / graded) * 100) : null;
    lines.push(`<b>${esc(src)}</b>: ${rate != null ? rate + '%' : '—'} (held ${s.held} · failed ${s.failed} · unclear ${s.unclear})`);
  }
  lines.push('', '표본이 적을 땐 %가 아니라 개별 사례를 봐라.');
  return lines.join('\n');
}

module.exports = {
  clusterQuery, revisitCluster,
  buildClusterPrompt, validateClusterOut, sanitizeClusterOut, normalizeAxis, framingGap, buildRevisitPrompt, validateRevisitOut,
  formatRevisit, formatPressTrack,
};
