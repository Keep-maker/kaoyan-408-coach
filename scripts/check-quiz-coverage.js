const { q } = require('../lib/db');
const S = require('../data/syllabus');
const Q = require('../lib/quiz-service');

const rows = q.all(`SELECT source_id, subject_key, source_category_id, chapter_id,
  chapter_name, section_name, title, tags_json FROM qb_questions`);
const counts = {};
let mapped = 0;
for (const row of rows) {
  const pointId = Q.learningPointId(row);
  if (!pointId) continue;
  mapped += 1;
  counts[pointId] = (counts[pointId] || 0) + 1;
}
console.log(`知识点关联：${mapped}/${rows.length}（${(mapped / rows.length * 100).toFixed(1)}%）`);
console.log(`覆盖知识点：${Object.keys(counts).length}/${S.POINTS.length}`);
const subjects = ['ds', 'co', 'os', 'cn'];
for (const subject of subjects) {
  const subjectPoints = S.POINTS.filter((p) => p.subjectId === subject);
  const covered = subjectPoints.filter((p) => counts[p.id]);
  const total = rows.filter((r) => r.subject_key === subject).length;
  const mappedSubject = subjectPoints.reduce((n, p) => n + (counts[p.id] || 0), 0);
  console.log(`${subject}: ${mappedSubject}/${total} 题有知识点映射，覆盖 ${covered.length}/${subjectPoints.length} 个点`);
}
console.table(q.all(`SELECT subject_key, COALESCE(chapter_name, '(空)') chapter, COUNT(*) n
  FROM qb_questions
  WHERE subject_key='co' AND (chapter_id IS NULL OR chapter_id=28)
  GROUP BY subject_key, chapter_name`));
