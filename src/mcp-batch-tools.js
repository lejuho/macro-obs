// 배치 에이전트 도구 (2층) — DART/뉴스 배치의 claude가 필요한 만큼 호출
// 서버 진입점: src/jobs/mcp-batch.js (stdio)
//
// 보고서 원문은 quarterly.js(에이전트 모드)가 tmp/reports/{rcept_no}.txt 에 캐시해둔 것을 읽는다.
// 공시 원문의 임시 작업 사본 — 배치 종료 시 정리.

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'tmp', 'reports');

function reportText(rceptNo) {
  if (!/^\d{10,20}$/.test(String(rceptNo))) throw new Error(`rcept_no 형식 오류: ${rceptNo}`);
  const f = path.join(REPORTS_DIR, `${rceptNo}.txt`);
  if (!fs.existsSync(f)) throw new Error(`원문 캐시 없음: ${rceptNo} — 이번 배치 대상이 아니다`);
  return fs.readFileSync(f, 'utf8');
}

const BATCH_TOOLS = [
  {
    name: 'search_report',
    description: '보고서 원문에서 키워드 등장 위치 탐색 (각 위치의 짧은 문맥 80자). 발췌에 없는 항목을 찾을 때 먼저 이걸로 위치를 확인하고 fetch_report_section으로 해당 구간을 가져와라.',
    returns: '{keyword, total_found, hits[{pos,context}], report_length}',
    inputSchema: {
      type: 'object',
      properties: {
        rcept_no: { type: 'string', description: '처리 중인 보고서 접수번호 (프롬프트에 명시됨)' },
        keyword: { type: 'string' },
        max_hits: { type: 'number', description: '기본 10' },
      },
      required: ['rcept_no', 'keyword'], additionalProperties: false,
    },
    handler({ rcept_no, keyword, max_hits = 10 }) {
      const text = reportText(rcept_no);
      const hits = [];
      let i = -1;
      while ((i = text.indexOf(keyword, i + 1)) !== -1 && hits.length < max_hits) {
        hits.push({ pos: i, context: text.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ') });
      }
      return { keyword, total_found: hits.length, hits, report_length: text.length };
    },
  },
  {
    name: 'fetch_report_section',
    description: '보고서 원문의 특정 위치(pos) 주변 구간을 가져온다. search_report로 찾은 pos를 넣어라. radius 기본 2000자, 최대 4000자.',
    returns: '{pos, section}',
    inputSchema: {
      type: 'object',
      properties: {
        rcept_no: { type: 'string' },
        pos: { type: 'number', description: 'search_report가 반환한 위치' },
        radius: { type: 'number', description: '앞뒤 문자 수 (기본 2000, 최대 4000)' },
      },
      required: ['rcept_no', 'pos'], additionalProperties: false,
    },
    handler({ rcept_no, pos, radius = 2000 }) {
      const text = reportText(rcept_no);
      const r = Math.min(Math.max(radius, 200), 4000);
      return { pos, section: text.slice(Math.max(0, pos - r), Math.min(text.length, pos + r)) };
    },
  },
  {
    name: 'search_news_live',
    description: '네이버 뉴스 실시간 검색 (메타·요약만, 본문 없음). 재방문 채점 시 "실제 전개" 근거가 부족하면 다른 키워드로 추가 검색하라.',
    returns: '{query, items[{title,description,source,spectrum,pub_date}]}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        display: { type: 'number', description: '기본 15, 최대 30' },
      },
      required: ['query'], additionalProperties: false,
    },
    async handler({ query, display = 15 }) {
      const { search, parseItems } = require('./collectors/naver');
      const items = parseItems(await search(query, Math.min(display, 30)), query);
      return { query, items: items.map(({ title, description, source, spectrum, pub_date }) =>
        ({ title, description, source, spectrum, pub_date })) };
    },
  },
];

// 원문 캐시 관리 (quarterly.js 에이전트 모드가 사용)
function cacheReport(rceptNo, text) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `${rceptNo}.txt`), text);
}
function clearReportCache() {
  if (fs.existsSync(REPORTS_DIR)) fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
}

module.exports = { BATCH_TOOLS, cacheReport, clearReportCache, REPORTS_DIR };
