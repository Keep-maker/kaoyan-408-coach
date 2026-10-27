'use strict';
// ============================================================
//  题库数据治理：修科目错标 / 标记重复题 / 补缺失章节
//  幂等：可反复执行
// ============================================================
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.KY_DB || path.join(__dirname, '..', 'data', 'kaoyan.db');

// 研岛一级分类 -> 科目（与 lib/quiz-service.js 的 SOURCE_CHAPTER 同源口径）
const CHAPTER_SUBJECT = {
  19: 'ds', 20: 'ds', 21: 'ds', 22: 'ds', 23: 'ds', 24: 'ds', 25: 'ds', 26: 'ds',
  30: 'co', 31: 'co', 32: 'co', 33: 'co', 34: 'co', 35: 'co', 36: 'co',
  11: 'os', 12: 'os', 27: 'os', 28: 'os', 29: 'os',
  13: 'cn', 14: 'cn', 15: 'cn', 16: 'cn', 17: 'cn', 18: 'cn',
};
const ROOT_ID = { ds: 1, co: 2, os: 3, cn: 4 };

// 上游只给了科目根分类、没有章节的题目，按内容归入最近章节
const MANUAL_CHAPTER = {
  14991: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14992: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14993: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14994: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14995: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14996: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14997: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14998: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  14999: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
  15000: { chapterId: 19, chapterName: '绪论', sectionName: '算法和算法评价' },
};

function ensureColumn(db, table, column, type) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function main() {
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout = 10000;');
  ensureColumn(db, 'qb_questions', 'dup_of', 'INTEGER');
  ensureColumn(db, 'qb_questions', 'needs_review', 'INTEGER DEFAULT 0');

  const stats = { fixedSubject: 0, markedDup: 0, fixedChapter: 0, flagged: 0 };

  // 1) 科目错标：章节分类属于 A 科，却记成了 B 科
  const rows = db.prepare('SELECT source_id, subject_key, chapter_id, chapter_name FROM qb_questions').all();
  const fixSubject = db.prepare('UPDATE qb_questions SET subject_key=?, source_category_id=? WHERE source_id=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const should = CHAPTER_SUBJECT[Number(row.chapter_id)];
      if (!should || should === row.subject_key) continue;
      fixSubject.run(should, ROOT_ID[should], row.source_id);
      stats.fixedSubject += 1;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }

  // 2) 重复题：同题干（去空白后完全一致）只保留一道，其余标记 dup_of
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE qb_questions SET dup_of=NULL').run();
    const dup = db.prepare(`
      SELECT replace(replace(trim(content), ' ', ''), char(10), '') key, COUNT(*) c
      FROM qb_questions GROUP BY key HAVING c > 1
    `).all();
    const pick = db.prepare(`
      SELECT source_id FROM qb_questions
      WHERE replace(replace(trim(content), ' ', ''), char(10), '') = ?
      ORDER BY answer_count DESC, correct_count DESC, source_id ASC
      LIMIT 1
    `);
    const mark = db.prepare('UPDATE qb_questions SET dup_of=? WHERE source_id=?');
    for (const group of dup) {
      const keep = pick.get(group.key);
      if (!keep) continue;
      const others = db.prepare(`
        SELECT source_id FROM qb_questions
        WHERE replace(replace(trim(content), ' ', ''), char(10), '') = ? AND source_id <> ?
      `).all(group.key, keep.source_id);
      for (const other of others) {
        mark.run(keep.source_id, other.source_id);
        stats.markedDup += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }

  // 3) 补缺失章节
  const fill = db.prepare(`UPDATE qb_questions SET chapter_id=?, chapter_name=?, section_name=?
    WHERE source_id=? AND (chapter_name IS NULL OR TRIM(chapter_name)='')`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [id, info] of Object.entries(MANUAL_CHAPTER)) {
      const r = fill.run(info.chapterId, info.chapterName, info.sectionName, Number(id));
      stats.fixedChapter += Number(r.changes || 0);
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }

  // 4) 标记无解析题，刷题时按需过滤
  const flagged = db.prepare(`UPDATE qb_questions SET needs_review=1
    WHERE TRIM(COALESCE(explanation,''))='' AND TRIM(COALESCE(answer_text,''))=''`).run();
  stats.flagged = Number(flagged.changes || 0);

  const summary = db.prepare(`
    SELECT subject_key, COUNT(*) n, SUM(CASE WHEN dup_of IS NOT NULL THEN 1 ELSE 0 END) dup
    FROM qb_questions GROUP BY subject_key
  `).all();
  console.log('治理完成:', stats);
  console.log('分科题量:', summary.map((r) => `${r.subject_key}=${r.n}${r.dup ? `(重复${r.dup})` : ''}`).join(' '));
  console.log('总题量:', db.prepare('SELECT COUNT(*) n FROM qb_questions').get().n,
    '| 可刷题量:', db.prepare('SELECT COUNT(*) n FROM qb_questions WHERE dup_of IS NULL').get().n);
  db.close();
}

main();
