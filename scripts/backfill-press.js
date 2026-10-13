// data/press-map.js 변경 후 기존 news_items의 source/spectrum을 재식별한다 (스냅샷은 건드리지 않음).
// 실행: node --no-warnings scripts/backfill-press.js [--dry]
const { db } = require('../src/db');
const { identifyPress } = require('../src/collectors/naver');

const dry = process.argv.includes('--dry');
const share = () => db.prepare(`SELECT spectrum, COUNT(*) AS n FROM news_items GROUP BY spectrum`).all();
console.log('before', share());
const upd = db.prepare(`UPDATE news_items SET source = ?, spectrum = ? WHERE id = ?`);
let changed = 0;
db.exec('BEGIN');
for (const r of db.prepare(`SELECT id, link, source, spectrum FROM news_items`).all()) {
  const p = identifyPress(r.link);
  if (p.name === r.source && p.spectrum === r.spectrum) continue;
  changed++;
  if (!dry) upd.run(p.name, p.spectrum, r.id);
}
db.exec(dry ? 'ROLLBACK' : 'COMMIT');
console.log(`${dry ? '(dry) ' : ''}changed ${changed}`);
console.log('after', share());
