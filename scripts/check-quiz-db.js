const path = require('node:path');
const { q, DB_FILE } = require('../lib/db');

const table = q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='qb_questions'");
console.log('DB=' + DB_FILE);
if (!table) {
  console.log('qb_questions 尚未创建');
  process.exit(0);
}
console.log('总题量=' + q.get('SELECT COUNT(*) n FROM qb_questions').n);
console.table(q.all(`SELECT subject_key AS subject, COUNT(*) AS total
  FROM qb_questions GROUP BY subject_key ORDER BY subject_key`));
console.table(q.all(`SELECT type, COUNT(*) AS total
  FROM qb_questions GROUP BY type ORDER BY type`));
console.log('空题干=' + q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE TRIM(COALESCE(title,''))=''`).n);
console.log('空解析=' + q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE TRIM(COALESCE(explanation,''))=''`).n);
console.log('缺章节=' + q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE chapter_id IS NULL`).n);
console.log('选择题缺答案=' + q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE type IN ('SINGLE','MULTIPLE','JUDGE')
  AND (answer_text IS NULL OR TRIM(answer_text)='')`).n);
console.log('文件=' + path.basename(DB_FILE));
console.log('选项缺失=' + q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE type IN ('SINGLE','MULTIPLE') AND (options_json IS NULL OR options_json='[]')`).n);
console.log('选项无正确项=' + q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE type IN ('SINGLE','MULTIPLE') AND options_json NOT LIKE '%"isCorrect":true%'`).n);
console.log('同步记录=' + (q.get("SELECT COUNT(*) n FROM qb_sync_meta").n || 0));
