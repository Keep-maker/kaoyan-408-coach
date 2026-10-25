'use strict';
// 为缺失章节的题目回填章节：先按 displayChapterId 逐行推断，能推断的直接写入。
const { db, q } = require('../lib/db');
const S = require('../data/syllabus');
const Q = require('../lib/quiz-service');

const rows = q.all('SELECT * FROM qb_questions WHERE chapter_id IS NULL OR chapter_name IS NULL');
const before = rows.length;
const updates = [];

// 先构建「小节名 -> 章节」索引，用已归类题目反推，覆盖源站小节命名与知识树不一致的情况
const sectionIndex = new Map();
for (const row of q.all(`SELECT section_name, chapter_id, chapter_name, COUNT(*) n
    FROM qb_questions
    WHERE section_name IS NOT NULL AND TRIM(section_name) <> ''
      AND chapter_id IS NOT NULL AND chapter_name IS NOT NULL
    GROUP BY section_name, chapter_id, chapter_name`)) {
  const key = String(row.section_name).trim();
  const prev = sectionIndex.get(key);
  if (!prev || row.n > prev.n) {
    sectionIndex.set(key, { chapterId: row.chapter_id, chapterName: row.chapter_name, n: row.n });
  }
}

for (const row of rows) {
  let chapterId = Q.displayChapterId(row);
  let chapterName = chapterId ? (S.CHAPTER_BY_ID[chapterId] || {}).name : null;
  if (!chapterId && row.section_name) {
    const hit = sectionIndex.get(String(row.section_name).trim());
    if (hit) {
      chapterId = hit.chapterId;
      chapterName = hit.chapterName;
    }
  }
  if (!chapterId) continue;
  updates.push([chapterId, chapterName || row.chapter_name, row.source_id]);
}

const statement = db.prepare(
  'UPDATE qb_questions SET chapter_id=?, chapter_name=? WHERE source_id=?'
);
db.exec('BEGIN');
try {
  for (const args of updates) statement.run(...args);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log('缺失章节题数:', before);
console.log('本次回填:', updates.length);
console.log('仍缺失:', q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE chapter_id IS NULL OR chapter_name IS NULL`).n);
