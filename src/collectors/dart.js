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
const EXCERPT_RADIUS = 1500;   // 키워드 앞뒤 문자 수
const EXCERPT_MAX = 45_000;    // LLM 입력 상한 (자)

async function dartFetch(pathAndQuery) {
  const url = `https://opendart.fss.or.kr/api/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}crtfc_key=${DART_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DART HTTP ${res.status}`);
  return res;
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

/** 최신 정기보고서 조회. 우선순위: 최근 1년 내 사업(11011) > 반기(11012) > 분기(11013/14) */
async function latestReport(corpCode) {
  const end = new Date(), start = new Date(end.getTime() - 400 * 86400_000);
  const f = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const res = await dartFetch(
    `list.json?corp_code=${corpCode}&bgn_de=${f(start)}&end_de=${f(end)}&pblntf_ty=A&page_count=100`);
  const json = await res.json();
  if (json.status !== '000') {
    if (json.status === '013') return null; // 조회 결과 없음
    throw new Error(`DART list ${json.status}: ${json.message}`);
  }
  const prio = (nm) => nm.includes('사업보고서') ? 4 : nm.includes('반기') ? 3 : nm.includes('분기') ? 2 : 0;
  const reports = (json.list || [])
    .filter((r) => prio(r.report_nm) > 0)
    .sort((a, b) => (b.rcept_dt + prio(b.report_nm)) < (a.rcept_dt + prio(a.report_nm)) ? -1 : 1);
  if (!reports.length) return null;
  const r = reports[0];
  const nm = r.report_nm;
  const reprt_code = nm.includes('사업보고서') ? '11011' : nm.includes('반기') ? '11012'
    : /1분기|03\)/.test(nm) ? '11013' : '11014';
  const fyMatch = nm.match(/\((\d{4})\.\d{2}\)/);
  return {
    rcept_no: r.rcept_no, report_nm: nm, reprt_code,
    fy: fyMatch ? Number(fyMatch[1]) : new Date().getFullYear() - 1,
  };
}

/** 원문 다운로드 → 텍스트화 → 키워드 발췌 */
async function fetchExcerpt(rceptNo) {
  fs.mkdirSync(TMP, { recursive: true });
  const zipPath = path.join(TMP, `${rceptNo}.zip`);
  const res = await dartFetch(`document.xml?rcept_no=${rceptNo}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  let raw;
  try {
    raw = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
  } finally { fs.unlinkSync(zipPath); }

  // XML 태그 제거 → 평문
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');

  // 키워드 주변 발췌 + 중복 구간 병합
  const spans = [];
  for (const kw of KEYWORDS) {
    let i = -1;
    while ((i = text.indexOf(kw, i + 1)) !== -1) {
      spans.push([Math.max(0, i - EXCERPT_RADIUS), Math.min(text.length, i + EXCERPT_RADIUS)]);
      if (spans.length > 400) break;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  let excerpt = merged.map(([a, b]) => text.slice(a, b)).join('\n\n[...]\n\n');
  if (excerpt.length > EXCERPT_MAX) excerpt = excerpt.slice(0, EXCERPT_MAX);
  return excerpt;
}

module.exports = { syncCorpCodes, markTargets, latestReport, fetchExcerpt };
