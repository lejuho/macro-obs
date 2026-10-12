// DART 수집기 (Phase 2)
// API 문서: https://opendart.fss.or.kr/guide/main.do
//  - corpCode.xml: 전체 고유번호 (zip)
//  - list.json: 공시 목록 → 최신 정기보고서 rcept_no
//  - document.xml: 원문 (zip 안에 XML)
//
// 원문은 수십만 자라 LLM에 통째로 못 넣는다 → 키워드 주변 발췌(excerpt)로 압축.
// zip 해제는 시스템 unzip 사용 (라즈비안 기본 탑재. 없으면: sudo apt install unzip)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { stmts, tx } = require('../db');

const DART_KEY = () => {
  const v = process.env.DART_API_KEY;
  if (!v) throw new Error('missing env: DART_API_KEY');
  return v;
};
const TMP = path.join(__dirname, '..', '..', 'tmp');

// 발췌 대상 키워드 — 노출 필드와 대응
const KEYWORDS = [
  '수출', '해외매출', '지역별 매출', '외화', '환율변동위험', '환위험',
  '차입금', '변동금리', '이자율위험', '원재료', '주요 원재료', '매입',
];
// 입력 토큰 절약 기본값. 품질 회귀 시 .env에서 즉시 되돌릴 수 있다.
const EXCERPT_RADIUS = Number(process.env.DART_EXCERPT_RADIUS || 900); // 키워드 앞뒤 문자 수
const EXCERPT_MAX = Number(process.env.DART_EXCERPT_MAX || 30_000);    // LLM 입력 상한 (자)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code || cause?.errno || error?.code;
  const message = cause?.message || error?.message || String(error);
  return [code, message].filter(Boolean).join(': ');
}

async function dartFetch(pathAndQuery, { attempts = 3, fetchImpl = fetch, sleepFn = sleep } = {}) {
  const url = `https://opendart.fss.or.kr/api/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}crtfc_key=${DART_KEY()}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return res;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === attempts) throw new Error(`DART HTTP ${res.status}`);
      console.warn(`  ⚠ DART HTTP ${res.status} → ${attempt}/${attempts - 1} 재시도`);
    } catch (error) {
      if (attempt === attempts || /^DART HTTP /.test(error.message)) {
        if (/^DART HTTP /.test(error.message)) throw error;
        throw new Error(`DART fetch 실패 (${describeFetchError(error)})`, { cause: error });
      }
      console.warn(`  ⚠ DART fetch 실패 (${describeFetchError(error)}) → ${attempt}/${attempts - 1} 재시도`);
    }
    await sleepFn(1000 * (2 ** (attempt - 1)));
  }
  throw new Error('DART fetch 실패'); // unreachable
}

/** 고유번호 전체 동기화 → corps 테이블 (상장사만) */
async function syncCorpCodes() {
  fs.mkdirSync(TMP, { recursive: true });
  const zipPath = path.join(TMP, 'corpCode.zip');
  const res = await dartFetch('corpCode.xml');
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const xml = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 128 * 1024 * 1024 }).toString('utf8');

  // 의존성 없는 정규식 파싱 (구조 단순: <list><corp_code>..</corp_code>...)
  const entries = xml.match(/<list>[\s\S]*?<\/list>/g) || [];
  let listed = 0;
  tx(() => {
    for (const e of entries) {
      const g = (tag) => (e.match(new RegExp(`<${tag}>(.*?)</${tag}>`)) || [])[1]?.trim() || '';
      const stock = g('stock_code');
      if (!stock || stock.length !== 6) continue; // 비상장 제외
      stmts.upsertCorp.run({ corp_code: g('corp_code'), stock_code: stock, name: g('corp_name') });
      listed++;
    }
  });
  return { total: entries.length, listed };
}

/** data/targets.csv (종목코드 한 줄씩, # 주석 허용) → is_target 마킹 */
function markTargets() {
  const p = path.join(__dirname, '..', '..', 'data', 'targets.csv');
  if (!fs.existsSync(p)) throw new Error(`${p} 없음 — 종목코드를 한 줄에 하나씩 넣어라 (예: 005930)`);
  const codes = fs.readFileSync(p, 'utf8').split('\n')
    .map((l) => l.split('#')[0].trim()).filter((l) => /^\d{6}$/.test(l));
  let marked = 0;
  for (const c of codes) {
    const r = stmts.markTarget.run(c);
    if (r.changes) marked++;
    else console.warn(`  대상 아님(미상장/코드오류?): ${c}`);
  }
  return { requested: codes.length, marked };
}

function reportMeta(r) {
  const nm = r.report_nm;
  const priority = nm.includes('사업보고서') ? 4 : nm.includes('반기보고서') ? 3
    : nm.includes('분기보고서') ? 2 : 0;
  const reprt_code = nm.includes('사업보고서') ? '11011' : nm.includes('반기') ? '11012'
    : /1분기|03\)/.test(nm) ? '11013' : '11014';
  const fyMatch = nm.match(/\((\d{4})\.\d{2}\)/);
  return {
    ...r, priority, reprt_code,
    fy: fyMatch ? Number(fyMatch[1]) : new Date().getFullYear() - 1,
  };
}

/** 정기보고서 후보. 가장 최근 접수분부터 정렬해 원문 없을 때 이전 공시로 폴백한다. */
function sortReports(reports) {
  return reports.map(reportMeta)
    .filter((r) => r.priority > 0)
    .sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt) || (b.priority - a.priority));
}

async function latestReports(corpCode) {
  const end = new Date(), start = new Date(end.getTime() - 400 * 86400_000);
  const f = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const res = await dartFetch(
    `list.json?corp_code=${corpCode}&bgn_de=${f(start)}&end_de=${f(end)}&pblntf_ty=A&page_count=100`);
  const json = await res.json();
  if (json.status !== '000') {
    if (json.status === '013') return []; // 조회 결과 없음
    throw new Error(`DART list ${json.status}: ${json.message}`);
  }
  return sortReports(json.list || []);
}

/** 기존 호출부 호환용: 우선순위가 가장 높은 보고서 하나만 반환. */
async function latestReport(corpCode) {
  return (await latestReports(corpCode))[0] || null;
}

/** XML → evidence 검증 가능한 평문. 표 셀 경계는 줄바꿈으로 보존하고 반복 머리말만 제거한다. */
function textFromXml(raw) {
  const decoded = raw
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  const text = decoded
    // 표/문단 경계를 먼저 줄바꿈으로 바꿔 셀 사이 거대한 공백을 없앤다.
    .replace(/<\/?(?:P|TR|TABLE|SECTION|TITLE|TH|TD|BR|DIV|LI|UL|OL|PAGE)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '');
  const lines = [];
  let previous = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!line) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    // DART 화면 머리말·쪽번호는 의미가 없고 보고서마다 수백 번 반복될 수 있다.
    if (/^(전자공시시스템|DART|목\s*차)$/i.test(line) ||
        /^https?:\/\/(dart\.)?fss\.or\.kr/i.test(line) ||
        /^[-–—]?\s*\d+\s*[-–—]?$/.test(line)) continue;
    // 연속 반복 헤더만 제거한다. 전역 중복 제거는 표의 분자/분모를 훼손하므로 하지 않는다.
    if (line.length >= 8 && line === previous) continue;
    lines.push(line);
    previous = line;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 평문 → 키워드 주변 발췌. 순서와 원문 문자열을 유지해 evidence 검증이 가능하다. */
function buildExcerpt(text, { radius = EXCERPT_RADIUS, max = EXCERPT_MAX } = {}) {
  const spans = [];
  outer: for (const kw of KEYWORDS) {
    let i = -1;
    while ((i = text.indexOf(kw, i + 1)) !== -1) {
      spans.push([Math.max(0, i - radius), Math.min(text.length, i + kw.length + radius)]);
      if (spans.length >= 400) break outer;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  let excerpt = merged.map(([a, b]) => text.slice(a, b).trim()).filter(Boolean).join('\n\n[...]\n\n');
  if (excerpt.length > max) excerpt = excerpt.slice(0, max).trimEnd();
  return excerpt;
}

/** 원문 다운로드 → 텍스트화 → 키워드 발췌. cache=true면 평문 전체를 배치 도구 캐시에 저장 */
async function fetchExcerpt(rceptNo, { cache = false } = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  const zipPath = path.join(TMP, `${rceptNo}.zip`);
  const res = await dartFetch(`document.xml?rcept_no=${rceptNo}`);
  const body = Buffer.from(await res.arrayBuffer());
  assertDocumentZip(body, res.headers.get('content-type'));
  fs.writeFileSync(zipPath, body);
  let raw;
  try {
    raw = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
  } finally { fs.unlinkSync(zipPath); }

  const text = textFromXml(raw);

  if (cache) require('../mcp-batch-tools').cacheReport(rceptNo, text);

  return buildExcerpt(text);
}

/** DART는 원문이 없을 때도 HTTP 200 + XML 오류를 반환한다. */
function assertDocumentZip(body, contentType = '') {
  if (body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b) return;

  const text = body.toString('utf8', 0, Math.min(body.length, 2000));
  const status = (text.match(/<status>([^<]+)<\/status>/i) || [])[1];
  const message = (text.match(/<message>([^<]+)<\/message>/i) || [])[1];
  const error = new Error(status
    ? `DART document ${status}: ${message || '알 수 없는 오류'}`
    : `DART document 응답이 ZIP이 아님 (${contentType || 'content-type 없음'})`);
  error.code = status === '014' ? 'DART_DOCUMENT_UNAVAILABLE' : 'DART_DOCUMENT_ERROR';
  error.dartStatus = status || null;
  throw error;
}

module.exports = {
  syncCorpCodes, markTargets, latestReport, latestReports, fetchExcerpt, textFromXml, buildExcerpt,
  sortReports, assertDocumentZip, dartFetch, describeFetchError,
  EXCERPT_RADIUS, EXCERPT_MAX,
};
