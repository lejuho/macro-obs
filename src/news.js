// 뉴스 프레이밍 파이프라인 (Phase 5) — LLM은 인자 주입(DI)으로 테스트 가능
const fs = require('fs');
const path = require('path');
const { db, stmts, tx } = require('./db');
const llm = require('./llm');
const QUERIES = require('../data/news-queries');
const {
  AXES, COUNTRIES, resolveProfiles, compactForPrompt,
} = require('./political-context');

const P = (f) => fs.readFileSync(path.join(__dirname, '..', 'prompts', f), 'utf8');

// ── 외부 에이전트 보고서 연결 ─────────────────────────────
// reports(save_report)는 외부 에이전트의 의견이지 관측소 판단이 아니다. 클러스터와의 연결은
// 보고서가 명시한 event_ids만으로 만든다 (제목 매칭 금지):
//   news_revisit 이벤트 data.cluster_id / news_cluster 이벤트 data.cluster_ids
const REPORT_MAX = 3;               // 재방문에 넣을 보고서 수
const REPORT_EXCERPT = 1500;        // 재방문용 보고서당 발췌 상한(자)
const CLUSTER_NOTE_EXCERPT = 300;   // 클러스터링용 메모 발췌 상한(자)
const CLUSTER_ATTEMPTS = 2;        // 클러스터링 실패(호출·파싱·검증) 시 거부 사유를 붙여 재시도 — 실패 쿼리 기사는 2일 창이 지나면 영영 미배정
const CLUSTER_NOTE_MAX = 5;         // 클러스터링 프롬프트에 넣을 메모 수

const linkedReportRows = db.prepare(`
  SELECT r.id, r.ts, r.author, r.title, r.body, e.id AS event_id
  FROM reports r, json_each(r.event_ids_json) j
  JOIN events e ON e.id = j.value
  WHERE (e.kind = 'news_revisit' AND json_extract(e.data_json, '$.cluster_id') = ?)
     OR (e.kind = 'news_cluster' AND EXISTS (
          SELECT 1 FROM json_each(e.data_json, '$.cluster_ids') k WHERE k.value = ?))
  ORDER BY r.id DESC`);

/** 순수: 보고서 본문에서 해당 이벤트 id(#N)를 언급하는 마크다운 섹션만 발췌. 없으면 앞부분. */
function excerptReport(body, eventIds, max) {
  const text = String(body || '');
  const sections = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line) && cur.length) { sections.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) sections.push(cur.join('\n'));
  const res = eventIds.map((id) => new RegExp(`#${id}(?!\\d)`));
  const mentions = (t) => res.some((re) => re.test(t));
  // 제목(헤딩)이 이벤트를 가리키는 섹션 우선, 없으면 본문에서 언급한 섹션
  const headed = sections.filter((sec) => mentions(sec.split('\n')[0]));
  const hit = headed.length ? headed : sections.filter(mentions);
  const out = (hit.length ? hit.join('\n') : text).trim();
  return out.length > max ? `${out.slice(0, max)}…(생략)` : out;
}

/** 클러스터에 명시적으로 연결된 보고서 (최신순, 보고서당 1행) */
function linkedReports(clusterId, { limit = REPORT_MAX, excerpt = REPORT_EXCERPT } = {}) {
  const byId = new Map();
  for (const r of linkedReportRows.all(clusterId, clusterId)) {
    if (!byId.has(r.id)) byId.set(r.id, { id: r.id, ts: r.ts, author: r.author, title: r.title, body: r.body, event_ids: [] });
    byId.get(r.id).event_ids.push(r.event_id);
  }
  return [...byId.values()].slice(0, limit).map(({ body, ...r }) => ({ ...r, excerpt: excerptReport(body, r.event_ids, excerpt) }));
}

const REPORT_LABEL = '외부 에이전트 보고서 (참고, 관측소 판단 아님)';

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

function buildClusterPrompt(items, existingKeys, { agent = false, politicalContexts = [], reportNotes = [] } = {}) {
  const lines = items.map((it) =>
    `[${it.id}] ${it.source}(${it.spectrum}) | ${it.title} | ${it.description || ''}`);
  return [
    P('news-cluster.md'),
    agent ? AGENT_CLUSTER_APPENDIX : '',
    existingKeys.length ? `기존 사건 키: ${existingKeys.join(', ')}` : '기존 사건 키: 없음',
    reportNotes.length
      ? [`[기존 사건에 대한 ${REPORT_LABEL}] 기사 배정 판단의 보조 맥락일 뿐이다. 이 메모의 내용을 core_frame·spectrum_frames·notable_claims에 옮기지 마라 — 프레이밍은 기사만으로 요약한다.`,
        ...reportNotes.map((n) => `- ${n.event_key} ← 보고서 #${n.report_id} (${n.author}, ${String(n.ts).slice(0, 10)}): ${n.excerpt.replace(/\s+/g, ' ')}`)].join('\n')
      : '',
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
  const anyFrame = ['A', 'B', 'wire', 'econ', 'official', 'unknown'].some((k) => f[k]) || !!c.core_frame;
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
function clusterQuery(query, runLLM = llm.run, { agent = false, items: givenItems, asOf } = {}) {
  // asOf(ISO) = 소급 모드: 주어진 기사로, 그 시점 주변 클러스터를 맥락으로, 사건 날짜로 기록
  const items = givenItems || stmts.unclusteredItems.all(query);
  if (!items.length) return { query, skip: 'no items' };

  const recentRows = asOf ? stmts.clustersAround.all(query, asOf, asOf) : stmts.recentClusters.all(query);
  const existing = recentRows.map((c) => c.event_key);
  const reportNotes = [];
  for (const c of recentRows) {
    if (reportNotes.length >= CLUSTER_NOTE_MAX) break;
    const [r] = linkedReports(c.id, { limit: 1, excerpt: CLUSTER_NOTE_EXCERPT });
    if (r) reportNotes.push({ event_key: c.event_key, report_id: r.id, author: r.author, ts: r.ts, excerpt: r.excerpt });
  }
  const queryConfig = QUERIES.find((q) => q.query === query) || {};
  const politicalContexts = resolveProfiles(queryConfig.countries || [], new Date());
  const basePrompt = buildClusterPrompt(items, existing, { agent, politicalContexts, reportNotes });
  const itemIds = items.map((i) => i.id);
  let parsed, clean, fail = null;
  const retried = [];
  for (let attempt = 1; attempt <= CLUSTER_ATTEMPTS; attempt++) {
    const prompt = fail
      ? `${basePrompt}\n\n[재시도] 직전 출력이 거부됐다: ${fail.reason}\n위 형식·허용 목록을 지켜 JSON 객체 하나만 다시 출력하라.`
      : basePrompt;
    parsed = llm.runJson(prompt,
      { runLLM, requireKey: 'clusters', label: `cluster-${query}${attempt > 1 ? `-retry${attempt - 1}` : ''}`, agent, servers: ['batch'] });
    if (!parsed.ok) { fail = { reason: parsed.reason }; retried.push(parsed.reason); continue; }
    clean = sanitizeClusterOut(parsed.data, itemIds);
    parsed.data = clean.data;
    const v = validateClusterOut(parsed.data, itemIds.filter((id) => !clean.missing.includes(id)));
    if (v.ok) { fail = null; break; }
    fail = { reason: v.reason, warnings: clean.warnings };
    retried.push(v.reason);
  }
  if (fail) return { query, ok: false, reason: `${fail.reason} (${CLUSTER_ATTEMPTS}회 시도)`, ...(fail.warnings ? { warnings: fail.warnings } : {}) };

  let created = 0, updated = 0, gaps = 0;
  const clusterIds = new Set(); // news_cluster 이벤트에 실어 보고서(event_ids)↔클러스터 연결의 근거로 쓴다
  const itemById = new Map(items.map((item) => [item.id, item]));
  tx(() => {
    for (const c of parsed.data.clusters) {
      let row = stmts.clusterByKey.get(c.event_key);
      let clusterId;
      const countryCodes = [...new Set(c.countries || [])];
      const countriesJson = JSON.stringify(countryCodes);
      const memberDates = c.member_ids.map((id) => itemById.get(id)?.pub_date).filter(Boolean).sort();
      const sqlTs = (iso) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
      if (row) {
        clusterId = row.id;
        if (asOf) stmts.touchClusterAt.run(sqlTs(memberDates.at(-1) || asOf), clusterId);
        else stmts.touchCluster.run(clusterId);
        if (countryCodes.length) stmts.setClusterCountries.run(countriesJson, clusterId);
        updated++;
      }
      else {
        const base = { event_key: c.event_key, title: c.title, query, countries_json: countriesJson };
        clusterId = asOf
          ? stmts.insertClusterAt.get({ ...base, first_seen: sqlTs(memberDates[0] || asOf), last_seen: sqlTs(memberDates.at(-1) || asOf) }).id
          : stmts.insertCluster.get(base).id;
        created++;
      }
      clusterIds.add(clusterId);
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
    cluster_ids: [...clusterIds],
    ...(reportNotes.length ? { report_notes: reportNotes.map((n) => n.report_id) } : {}),
    ...(parsed.repaired ? { repaired: true } : {}),
    ...(retried.length ? { retried } : {}),
    ...(clean.warnings.length ? { warnings: clean.warnings } : {}),
  };
}

// ── 90일 재방문 ─────────────────────────────────────────

function buildRevisitPrompt(cluster, initial, recentItems, { agent = false, currentContexts = [], reports = [] } = {}) {
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
    ...(reports.length ? [
      `[${REPORT_LABEL}]\n외부 에이전트가 이 사건 관련 이벤트를 분석해 남긴 메모다. 정답이 아니라 확인할 거리(fact-check 힌트)다.\n` +
      '- 메모의 주장은 현재 기사·지표·검색으로 네가 직접 확인한 경우에만 판정 근거로 쓴다. 확인 못 한 결론을 outcome_summary·verdict·lesson에 옮기지 마라.\n' +
      '- report_checks에 메모의 핵심 주장마다 confirmed|contradicted|unverified와 너의 근거를 적어라.',
      ...reports.map((r) => `--- 보고서 #${r.id} (${r.author}, ${String(r.ts).slice(0, 10)}) ${r.title}\n${r.excerpt}`),
    ] : []),
  ].join('\n\n');
}

/** 순수: report_checks에서 참조하지 않은 보고서·잘못된 enum 항목 제거 (재방문 전체를 버리지 않음) */
function cleanReportChecks(data, consultedIds) {
  const ok = new Set(consultedIds);
  const checks = Array.isArray(data.report_checks) ? data.report_checks : [];
  data.report_checks = checks.filter((c) => c && ok.has(Number(c.report_id))
    && ['confirmed', 'contradicted', 'unverified'].includes(c.status) && c.point)
    .map((c) => ({ report_id: Number(c.report_id), point: String(c.point), status: c.status, evidence: c.evidence || null }));
  data.consulted_report_ids = [...consultedIds]; // 코드가 기록 — 자기확증 감사용
  return data;
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

  const reports = linkedReports(cluster.id);
  const parsed = llm.runJson(buildRevisitPrompt(cluster, initial, recent, { agent, currentContexts, reports }),
    { runLLM, requireKey: 'outcome_summary', label: `revisit-${cluster.event_key}`, agent, servers: ['batch', 'obs'] });
  if (!parsed.ok) return { cluster: cluster.event_key, ok: false, reason: parsed.reason };
  const v = validateRevisitOut(parsed.data, initial.notable_claims, initial.structural_hypotheses);
  if (!v.ok) return { cluster: cluster.event_key, ok: false, reason: v.reason };
  cleanReportChecks(parsed.data, reports.map((r) => r.id));

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

// ── 재검토 (재방문 이후 도착한 외부 보고서) ──────────────
// 보고서는 재방문 이벤트를 본 뒤에 쓰이므로 그 재방문에는 반영될 수 없다. 재방문 뒤 새로 연결된(아직 참조 안 한)
// 보고서가 있으면 이전 재방문 결과를 놓고 한 번 더 검토한다.
// 자기확증 방지: 판정 변경은 모델이 직접 확인한 근거(evidence)가 있어야 하고, 이전 결과와의 차이는 코드가 계산한다.
// 루프 방지: 클러스터당 재검토 최대 REREVIEW_MAX회 (재검토 결과에 다시 보고서가 붙어도 무한히 돌지 않음).
const REREVIEW_MAX = 2;

const revisitSnapshots = db.prepare(`
  SELECT id, content_json, created_at FROM framing_snapshots
  WHERE cluster_id = ? AND phase = 'revisit' ORDER BY id`);
const clustersWithReports = db.prepare(`
  SELECT DISTINCT c.* FROM news_clusters c
  WHERE c.status = 'revisited' AND EXISTS (
    SELECT 1 FROM reports r, json_each(r.event_ids_json) j JOIN events e ON e.id = j.value
    WHERE (e.kind = 'news_revisit' AND json_extract(e.data_json, '$.cluster_id') = c.id)
       OR (e.kind = 'news_cluster' AND EXISTS (
            SELECT 1 FROM json_each(e.data_json, '$.cluster_ids') k WHERE k.value = c.id)))
  ORDER BY c.id`);

/** 재검토 대상: revisited 클러스터 중 아직 어떤 재방문·재검토에서도 참조하지 않은 연결 보고서가 있는 것 */
function dueRereview(limit = 2) {
  const out = [];
  for (const c of clustersWithReports.all()) {
    const snaps = revisitSnapshots.all(c.id).map((r) => ({ id: r.id, data: JSON.parse(r.content_json) }));
    if (!snaps.length) continue;
    if (snaps.filter((x) => x.data.rereview_of).length >= REREVIEW_MAX) continue;
    const consulted = new Set(snaps.flatMap((x) => x.data.consulted_report_ids || []));
    const fresh = linkedReports(c.id).filter((r) => !consulted.has(r.id));
    if (!fresh.length) continue;
    out.push({ cluster: c, previous: snaps[snaps.length - 1], reports: fresh });
    if (out.length >= limit) break;
  }
  return out;
}

/** 순수: 이전 재방문 대비 판정 차이 (코드가 계산 — 모델의 자기 보고와 대조용) */
function diffRevisit(prev, next) {
  const diff = [];
  for (const k of new Set([...Object.keys(prev.frame_verdicts || {}), ...Object.keys(next.frame_verdicts || {})])) {
    const a = prev.frame_verdicts?.[k]?.held ?? null, b = next.frame_verdicts?.[k]?.held ?? null;
    if (a !== b) diff.push({ field: `frame.${k}`, before: a, after: b });
  }
  const key = (v) => `${v.source}|${v.claim}`;
  const before = new Map((prev.claim_verdicts || []).map((v) => [key(v), v.verdict]));
  for (const v of next.claim_verdicts || []) {
    if (before.has(key(v)) && before.get(key(v)) !== v.verdict) diff.push({ field: `claim.${v.source}`, before: before.get(key(v)), after: v.verdict });
  }
  const sb = new Map((prev.structural_verdicts || []).map((v) => [v.axis, v.verdict]));
  for (const v of next.structural_verdicts || []) {
    if (sb.has(v.axis) && sb.get(v.axis) !== v.verdict) diff.push({ field: `structural.${v.axis}`, before: sb.get(v.axis), after: v.verdict });
  }
  return diff;
}

const REREVIEW_APPENDIX = (previous) => `
[재검토 모드] 이 사건은 이미 90일 재방문을 마쳤다. 아래 [이전 재방문 결과]는 그때의 판정이고,
[외부 에이전트 보고서]는 그 뒤에 도착한 메모다. 보고서가 지적한 점을 현재 기사·지표·검색으로 직접 확인해 이전 판정을 유지하거나 고쳐라.
- 출력은 위 스키마 전체(이전 판정을 유지하는 항목도 그대로 다시 적는다) + "changes_from_previous" 배열.
- changes_from_previous: [{ "field": "frame.core|claim.<매체>|structural.<축>|outcome_summary", "before": ..., "after": ..., "evidence": "네가 직접 확인한 근거 한 문장" }]
- 보고서 주장만으로 판정을 바꾸지 마라. 직접 확인하지 못했으면 이전 판정을 유지하고 report_checks에 unverified로 남겨라.
- 바꿀 것이 없으면 changes_from_previous는 빈 배열.
[이전 재방문 결과]
${JSON.stringify(previous, null, 1).slice(0, 6000)}`;

/** 재검토 1건. due = dueRereview() 원소 */
async function rereviewCluster(due, { runLLM = llm.run, fetchRecent, agent = false } = {}) {
  const { cluster, previous, reports } = due;
  const snap = stmts.snapshotFor.get(cluster.id, 'initial');
  if (!snap) return { cluster: cluster.event_key, skip: 'no initial snapshot' };
  const initial = JSON.parse(snap.content_json);
  let countryCodes = initial.country_codes || [];
  if (!countryCodes.length) { try { countryCodes = JSON.parse(cluster.countries_json || '[]'); } catch { countryCodes = []; } }
  const currentContexts = resolveProfiles(countryCodes, new Date());
  let recent = [];
  if (fetchRecent) recent = await fetchRecent(cluster);
  else {
    try {
      const { search, parseItems } = require('./collectors/naver');
      recent = parseItems(await search(cluster.title.slice(0, 30), 20), cluster.query).slice(0, 20);
    } catch { recent = []; }
  }
  const prev = previous.data;
  const prompt = buildRevisitPrompt(cluster, initial, recent, { agent, currentContexts, reports })
    + '\n\n' + REREVIEW_APPENDIX(prev);
  const parsed = llm.runJson(prompt,
    { runLLM, requireKey: 'outcome_summary', label: `rereview-${cluster.event_key}`, agent, servers: ['batch', 'obs'] });
  if (!parsed.ok) return { cluster: cluster.event_key, ok: false, reason: parsed.reason };
  const data = parsed.data;
  const v = validateRevisitOut(data, initial.notable_claims, initial.structural_hypotheses);
  if (!v.ok) return { cluster: cluster.event_key, ok: false, reason: v.reason };
  cleanReportChecks(data, reports.map((r) => r.id));

  const diff = diffRevisit(prev, data);
  const changes = (Array.isArray(data.changes_from_previous) ? data.changes_from_previous : [])
    .filter((c) => c && c.field && String(c.evidence || '').trim());
  // 판정이 바뀌었는데 근거 있는 변경 기록이 없으면 이전 판정 유지 (보고서 결론의 무근거 복사 차단)
  const accepted = !diff.length || changes.length > 0;
  const stored = accepted ? data : { ...prev, report_checks: data.report_checks };
  Object.assign(stored, {
    consulted_report_ids: reports.map((r) => r.id),
    rereview_of: previous.id,
    changes_from_previous: accepted ? changes : [],
    diff: accepted ? diff : [],
    ...(accepted ? {} : { rejected_diff: diff, rejected_reason: '근거(evidence) 있는 변경 기록 없이 판정이 바뀜 — 이전 판정 유지' }),
  });

  tx(() => {
    stmts.insertSnapshot.run(cluster.id, 'revisit', JSON.stringify(stored));
    // 언론사 트랙레코드는 최신 판정 기준 (이전 판정은 이전 revisit 스냅샷에 보존)
    if (accepted && diff.some((d) => d.field.startsWith('claim.'))) {
      db.prepare('DELETE FROM press_track WHERE cluster_id = ?').run(cluster.id);
      for (const cv of stored.claim_verdicts || []) {
        stmts.insertPressTrack.run({ cluster_id: cluster.id, source: cv.source, claim: cv.claim, verdict: cv.verdict, note: cv.note || null });
      }
    }
  });
  return { cluster: cluster.event_key, ok: true, accepted, changed: accepted ? diff.length : 0, data: stored };
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
    ...(fv.econ ? [`경제지: ${mark(fv.econ.held)} — ${esc(fv.econ.note)}`] : []),
    ``,
    ...((data.claim_verdicts || []).map((c) =>
      `${{ held: '🎯', failed: '❌', unclear: '⬜' }[c.verdict]} ${esc(c.source)}: "${esc(c.claim)}" — ${esc(c.note || '')}`)),
    ...((data.structural_verdicts || []).map((v) =>
      `${{ consistent: '🧭', inconsistent: '↩️', unclear: '⬜' }[v.verdict]} 구조(${esc(v.axis)}): ${esc(v.note || '')}`)),
    ...((data.consulted_report_ids || []).length ? [``, `🗂 참고한 외부 보고서 ${data.consulted_report_ids.map((id) => `#${id}`).join(', ')}` +
      ` (확인 ${(data.report_checks || []).filter((c) => c.status === 'confirmed').length}` +
      ` · 반박 ${(data.report_checks || []).filter((c) => c.status === 'contradicted').length}` +
      ` · 미확인 ${(data.report_checks || []).filter((c) => c.status === 'unverified').length})`] : []),
    ``,
    `💡 ${esc(data.lesson || '')}`,
  ].join('\n');
}

function formatRereview(cluster, data) {
  const head = `🔁 <b>재검토: ${esc(cluster.title)}</b> — 외부 보고서 ${(data.consulted_report_ids || []).map((id) => `#${id}`).join(', ')} 도착 후`;
  const changes = data.changes_from_previous || [];
  const body = data.rejected_reason
    ? [`⚠️ ${esc(data.rejected_reason)}`, ...(data.rejected_diff || []).map((d) => `· (기각) ${esc(d.field)}: ${esc(d.before)} → ${esc(d.after)}`)]
    : changes.length
      ? changes.map((c) => `· ${esc(c.field)}: ${esc(c.before)} → ${esc(c.after)} — ${esc(c.evidence)}`)
      : ['판정 변경 없음 (이전 재방문 유지)'];
  const checks = data.report_checks || [];
  return [head, '', ...body, '',
    ...checks.map((c) => `${{ confirmed: '✅', contradicted: '❌', unverified: '⬜' }[c.status]} 보고서 #${c.report_id}: ${esc(c.point)}${c.evidence ? ` — ${esc(c.evidence)}` : ''}`),
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
  clusterQuery, revisitCluster, dueRereview, rereviewCluster, diffRevisit, formatRereview,
  buildClusterPrompt, validateClusterOut, sanitizeClusterOut, normalizeAxis, framingGap, buildRevisitPrompt, validateRevisitOut,
  formatRevisit, formatPressTrack,
  linkedReports, excerptReport, cleanReportChecks,
};
