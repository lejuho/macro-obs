// MCP 서버 코어 (1층: 읽기 전용) — 의존성 제로 JSON-RPC 2.0 직접 구현
// 트랜스포트와 분리: handleRpc(msg) → 응답 객체 | null(notification)
// 철학 정합: 도구는 전부 "사실과 사전계산"의 조회. 판단(커밋/수정)은 3층에서 origin 태깅과 함께.

const { db, stmts } = require('./db');
const flags = require('./flags');

const PROTOCOL = '2025-03-26';
const INFO = { name: 'macro-obs', version: '1.0.0' };

// ── 리졸버 ──
function findIndicator(ref) {
  if (/^\d+$/.test(String(ref))) {
    return db.prepare(`SELECT * FROM indicators WHERE id = ?`).get(Number(ref));
  }
  return db.prepare(`SELECT * FROM indicators WHERE name LIKE ? ORDER BY id LIMIT 1`).get(`%${ref}%`);
}
function findScenario(ref) {
  if (/^\d+$/.test(String(ref))) return stmts.scenarioById.get(Number(ref));
  return db.prepare(`SELECT * FROM scenarios WHERE name LIKE ? LIMIT 1`).get(`%${ref}%`);
}
const edgeById = db.prepare(`
  SELECT e.*, s.name AS src_name, d.name AS dst_name FROM edges e
  JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst WHERE e.id = ?`);

// ── 도구 정의 + 핸들러 ──
const TOOLS = [
  {
    name: 'get_status',
    description: '가설별 현재값 vs 밴드, open 알림, 채점 대기 예측, 다가오는 선거. 대화를 관측소의 현재 사실에 접지하는 기본 도구.',
    returns: '{hypotheses[{id,statement,band_low,band_high,window_rule,rationale,indicator_id,indicator_name,unit,latest,latest_date,flags}], open_alerts[{id,observed_value,observed_date,direction,triggered_at,statement,indicator_name}], pending_predictions(채점 대기 수), watch[관찰 전용 지표 {id,name,unit,note,category,latest,latest_date,flags}], elections[{...,date,dday}], cycle(산업 사이클 스냅샷)}',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler() {
      const { api } = require('./jobs/server');
      return api.status();
    },
  },
  {
    name: 'list_indicators',
    description: '전체 지표 목록 (id, 이름, 최신값, 노브 문장). get_series의 지표 탐색용.',
    returns: '[{id,source,name,unit,category,note,latest,latest_date}]',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler() {
      return db.prepare(`
        SELECT i.id, i.source, i.name, i.unit, i.category, i.note,
          (SELECT value FROM observations o WHERE o.indicator_id = i.id ORDER BY date DESC LIMIT 1) AS latest,
          (SELECT date  FROM observations o WHERE o.indicator_id = i.id ORDER BY date DESC LIMIT 1) AS latest_date
        FROM indicators i ORDER BY i.id`).all();
    },
  },
  {
    name: 'get_series',
    description: '지표 시계열 조회. indicator는 id 또는 이름 일부(예: "환율", "MOVE").',
    returns: '{indicator(지표 행), observations[{date,value}] 날짜 오름차순}',
    inputSchema: {
      type: 'object',
      properties: {
        indicator: { type: 'string', description: '지표 id 또는 이름 일부' },
        days: { type: 'number', description: '조회 기간 (기본 180)' },
      },
      required: ['indicator'], additionalProperties: false,
    },
    handler({ indicator, days = 180 }) {
      const ind = findIndicator(indicator);
      if (!ind) throw new Error(`지표 없음: ${indicator} — list_indicators로 확인`);
      const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      return { indicator: ind, observations: stmts.obsSince.all(ind.id, since) };
    },
  },
  {
    name: 'list_scenarios',
    description: '사전계산된 테일 시나리오 12종 목록 (연관국, 트리거 힌트 포함).',
    returns: '[{id,name,trigger_hint,countries,computed_at}]',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler() {
      return stmts.allScenarios.all().map((s) => ({
        id: s.id, name: s.name, trigger_hint: s.trigger_hint,
        countries: flags.forScenario(s.name), computed_at: s.computed_at,
      }));
    },
  },
  {
    name: 'run_scenario',
    description: '시나리오의 사전계산 전파 결과. 노드별 impact와 도달 경로의 간선 노트(왜/조건/지경학)까지. 경합(수혜·피해 공존) 노드는 경로가 나뉘어 나온다 — 지배 경로 판단은 사용자 몫이라는 전제로 제시할 것.',
    returns: '{scenario{id,name,trigger_hint,shocks}, note, nodes[{name,type,max_abs,contested,paths[{impact,hops,edges[{route,kind,weight,hhi,why,condition,leverage}]}]}] max_abs 내림차순}',
    inputSchema: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: '시나리오 id 또는 이름 일부 (예: "대만", "BOJ")' },
        limit: { type: 'number', description: '상위 노드 수 (기본 12)' },
      },
      required: ['scenario'], additionalProperties: false,
    },
    handler({ scenario, limit = 12 }) {
      const sc = findScenario(scenario);
      if (!sc) throw new Error(`시나리오 없음: ${scenario} — list_scenarios로 확인`);
      const rows = stmts.scenarioResults.all(sc.id);
      const byNode = new Map();
      for (const r of rows) {
        if (!byNode.has(r.node_id)) byNode.set(r.node_id, { name: r.name, type: r.type, paths: [] });
        byNode.get(r.node_id).paths.push({
          impact: r.impact, hops: r.hops,
          edges: JSON.parse(r.path_json).map((id) => {
            const e = edgeById.get(id);
            return e && {
              route: `${e.src_name}→${e.dst_name}`, kind: e.kind, weight: e.weight, hhi: e.hhi,
              why: e.path_note, condition: e.condition_note, leverage: e.leverage_note,
            };
          }).filter(Boolean),
        });
      }
      const nodes = [...byNode.values()]
        .map((n) => ({ ...n, max_abs: Math.max(...n.paths.map((p) => Math.abs(p.impact))),
          contested: new Set(n.paths.map((p) => Math.sign(p.impact))).size > 1 }))
        .sort((a, b) => b.max_abs - a.max_abs).slice(0, limit);
      return {
        scenario: { id: sc.id, name: sc.name, trigger_hint: sc.trigger_hint, shocks: JSON.parse(sc.shocks_json) },
        note: 'impact는 순위용 휴리스틱. contested=true 노드는 경로를 합산하지 말 것.',
        nodes,
      };
    },
  },
  {
    name: 'get_graph_node',
    description: '해도 노드의 유입/유출 간선 전부와 노트(경로/조건/지경학), HHI, 계절성. 특정 산업·흐름·초크포인트의 구조를 파악할 때.',
    returns: '{node{...,meta}, outgoing[], incoming[] (간선: route,kind,sign,weight,hhi,why,condition,leverage), scenarios_hitting{시나리오명: 최대 impact}}',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '노드 이름 일부' } },
      required: ['name'], additionalProperties: false,
    },
    handler({ name }) {
      const node = db.prepare(`SELECT * FROM nodes WHERE name LIKE ? LIMIT 1`).get(`%${name}%`);
      if (!node) throw new Error(`노드 없음: ${name}`);
      const shape = (e) => ({
        route: `${e.src_name}→${e.dst_name}`, kind: e.kind, sign: e.sign, weight: e.weight,
        hhi: e.hhi, why: e.path_note, condition: e.condition_note, leverage: e.leverage_note,
      });
      const q = (col) => db.prepare(`
        SELECT e.*, s.name AS src_name, d.name AS dst_name FROM edges e
        JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst WHERE e.${col} = ?`).all(node.id).map(shape);
      return {
        node: { ...node, meta: node.meta_json ? JSON.parse(node.meta_json) : null, meta_json: undefined },
        outgoing: q('src'), incoming: q('dst'),
        scenarios_hitting: stmts.scenariosHittingNode.all(`%${node.name}%`)
          .reduce((acc, r) => {
            if (!acc[r.name] || Math.abs(r.impact) > Math.abs(acc[r.name])) acc[r.name] = r.impact;
            return acc;
          }, {}),
      };
    },
  },
  {
    name: 'get_exposures',
    description: '공시(DART) 기반 기업 구조적 노출 순위. metric: fx(환율 국면 — 수출·외화부채) | rates(금리 국면 — 변동금리부채).',
    returns: '{metric, note, firms[{name,stock_code,industry,export_ratio,fx_debt_ratio,float_rate_ratio,score}] score 내림차순}',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['fx', 'rates'] },
        limit: { type: 'number', description: '기본 10' },
      },
      required: ['metric'], additionalProperties: false,
    },
    handler({ metric, limit = 10 }) {
      const w = metric === 'fx'
        ? { w_export: 1.0, w_fxdebt: 0.8, w_float: 0 }
        : { w_export: 0, w_fxdebt: 0.2, w_float: 1.0 };
      const rows = stmts.topExposed.all({ ...w, limit });
      return { metric, note: '노출 크기 순위일 뿐 방향(수혜/피해) 판단은 사용자 몫.', firms: rows };
    },
  },
  {
    name: 'get_track',
    description: '캘리브레이션 트랙레코드(지표별 hit rate)와 최근 예측 타임라인. 사용자의 판단 이력을 참조할 때 — miss도 그대로 보여줄 것.',
    returns: '{rows[{indicator_name,origin,score,n}] 채점 완료 집계, predictions[{id,statement,expected_low,expected_high,target_date,actual_value,score,committed_at,indicator_name}] 최신 200건, origin_summary[{origin,score,n}]}',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler() {
      const { api } = require('./jobs/server');
      return api.track();
    },
  },
  {
    name: 'search_news',
    description: '뉴스 이벤트 클러스터(축별 프레이밍 스냅샷 포함)와 언론사 트랙레코드. query 생략 시 최근 클러스터.',
    returns: '{clusters[{id,event_key,title,query,first_seen,last_seen,status,countries_json,initial,revisit}] 최근 10개, press_track[{source,verdict,n}]} — initial/revisit은 null 또는 {spectrum_frames{A,B,wire,econ,official,unknown: 축별 프레임 문장|null}, core_frame, notable_claims, expected_development, country_codes, political_contexts}',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '클러스터 제목 검색어 (선택)' } },
      additionalProperties: false,
    },
    handler({ query } = {}) {
      const clusters = (query
        ? db.prepare(`SELECT * FROM news_clusters WHERE title LIKE ? ORDER BY last_seen DESC LIMIT 10`).all(`%${query}%`)
        : db.prepare(`SELECT * FROM news_clusters ORDER BY last_seen DESC LIMIT 10`).all()
      ).map((c) => ({
        ...c,
        initial: JSON.parse(stmts.snapshotFor.get(c.id, 'initial')?.content_json || 'null'),
        revisit: JSON.parse(stmts.snapshotFor.get(c.id, 'revisit')?.content_json || 'null'),
      }));
      return { clusters, press_track: stmts.pressTrackAgg.all() };
    },
  },
  {
    name: 'get_events',
    description: '이벤트 로그: 텔레그램 알림(breach/trigger/grade/news_revisit/worldview_review/track_weekly/message)과 배치 갱신(news_cluster). since_id로 커서 폴링 — 응답의 next_since_id를 다음 호출에 넘길 것.',
    returns: '{events[{id,ts,source,kind,text,data,delivered}], next_since_id} — since_id를 주면 오래된 순, 아니면 최신 순',
    inputSchema: {
      type: 'object',
      properties: {
        since_id: { type: 'integer', description: '이 id 초과 이벤트만 (오래된 순)' },
        since: { type: 'string', description: 'ISO 시각 이상 (예: 2026-10-01)' },
        kind: { type: 'string', description: '콤마 구분 kind 필터' },
        source: { type: 'string', description: '콤마 구분 source 필터 (daily,news,monthly,quarterly,bot)' },
        limit: { type: 'integer', description: '기본 100, 최대 500' },
      },
      additionalProperties: false,
    },
    handler(args = {}) {
      return require('./events').list(args);
    },
  },
];

// ── 사용 안내 (initialize.instructions) ──
// 클라이언트가 연결 시 모델에게 넘겨주는 도구 흐름 안내. 노출된 도구 조합에 맞는 줄만 싣는다
// (공개 터널은 읽기 3종만, 배치 서버는 해당 없음 → 안내 생략).
const GUIDE_INTRO = 'macro-obs는 거시 관측소다: 가설 밴드·지표·시나리오 전파·뉴스 프레이밍을 사실과 사전계산으로 제공한다. 방향·수혜/피해 판단은 사용자 몫 — 결과의 note를 따를 것. 각 도구 설명 끝의 "반환:"이 응답 JSON 형태다.';
const GUIDE = [
  { needs: ['get_status'], text: '대화를 시작할 때 get_status로 현재 사실(가설 밴드 대비 현재값, open 알림, 다가오는 선거)부터 확인한다.' },
  { needs: ['list_indicators', 'get_series'], text: '지표 id를 모르면 list_indicators → get_series(id 또는 이름 일부).' },
  { needs: ['list_scenarios', 'run_scenario'], text: '시나리오는 list_scenarios → run_scenario. contested=true 노드는 경로를 합산하지 말고 갈래별로 제시한다.' },
  { needs: ['get_graph_node'], text: '특정 산업·흐름·초크포인트의 구조는 get_graph_node(이름 일부).' },
  { needs: ['search_news'], text: `search_news의 spectrum_frames 축: ${Object.entries(require('../data/press-map').AXIS).map(([k, v]) => `${k}(${v})`).join('·')}. null은 그 축 기사가 없었다는 뜻이지 중립이 아니다.` },
  { needs: ['get_events'], text: 'get_events는 커서 폴링: 직전 응답의 next_since_id를 since_id로 넘긴다.' },
  { needs: ['get_reports', 'get_events', 'save_report'], text: '보고서 루프: get_reports로 직전 보고서 확인 → get_events(since_id) → 분석 → save_report(event_ids 전부, since_id, until_id=next_since_id). 저장 성공 응답 뒤에만 커서를 올린다.' },
  { needs: ['commit_prediction'], text: '쓰기 도구(commit_prediction·revise_hypothesis·add_trigger)는 사용자가 명시적으로 요청하고 최종 문장을 확인한 뒤에만 호출한다. 기록은 origin=assisted로 분리 집계된다.' },
  { needs: [], text: '도구 오류는 isError 텍스트로 온다 — 메시지의 안내(예: "list_indicators로 확인")를 따른다.' },
];
function buildInstructions(toolset) {
  const names = new Set(toolset.map((t) => t.name));
  const lines = GUIDE.filter((g) => g.needs.length && g.needs.every((n) => names.has(n))).map((g) => g.text);
  if (!lines.length) return null;
  const tail = GUIDE.filter((g) => !g.needs.length).map((g) => g.text);
  return [GUIDE_INTRO, ...lines, ...tail].map((l, i) => (i ? `- ${l}` : l)).join('\n');
}

// ── JSON-RPC 처리 (팩토리 — 1층/2층 서버가 공유) ──
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function createHandler(tools, serverInfo = INFO) {
  return (msg) => rpcCore(msg, tools, serverInfo);
}

/** 1층 기본 핸들러 — async (도구가 비동기일 수 있음) */
function handleRpc(msg) { return rpcCore(msg, TOOLS, INFO); }

async function rpcCore(msg, TOOLSET, SERVER_INFO) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return err(msg?.id ?? null, -32600, 'invalid request');
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;

  try {
    if (method === 'initialize') {
      const instructions = buildInstructions(TOOLSET);
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: params.protocolVersion || PROTOCOL,
        capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        ...(instructions ? { instructions } : {}),
      } };
    }
    if (method.startsWith('notifications/')) return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: {
        tools: TOOLSET.map(({ name, description, returns, inputSchema }) => ({
          name, description: returns ? `${description} 반환: ${returns}` : description, inputSchema,
        })),
      } };
    }
    if (method === 'tools/call') {
      const tool = TOOLSET.find((t) => t.name === params.name);
      if (!tool) return err(id, -32602, `unknown tool: ${params.name}`);
      try {
        const result = await tool.handler(params.arguments || {});
        return { jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 1) }],
        } };
      } catch (e) {
        // 도구 실행 오류는 프로토콜 오류가 아니라 isError 결과 (MCP 규약)
        return { jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: e.message }], isError: true,
        } };
      }
    }
    if (isNotification) return null;
    return err(id, -32601, `method not found: ${method}`);
  } catch (e) {
    return err(id, -32603, e.message);
  }
}

module.exports = { handleRpc, createHandler, buildInstructions, TOOLS, PROTOCOL };
