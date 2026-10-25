const { q } = require('../lib/db');
const Q = require('../lib/quiz-service');
const S = require('../data/syllabus');

for (const pid of ['os3-6', 'os3-3', 'os3-2', 'os2-9', 'cn3-4', 'ds5-2', 'os4-6', 'cn1-4', 'os3-7', 'co2-4']) {
  const pt = S.POINT_BY_ID[pid];
  const kws = Q.POINT_KEYWORDS[pid] || [];
  const like = kws.map((t) =>
    `(title LIKE '%${t}%' OR section_name LIKE '%${t}%' OR tags_json LIKE '%${t}%' OR content LIKE '%${t}%')`
  ).join(' OR ');
  const n = q.get(`SELECT COUNT(*) n FROM qb_questions WHERE subject_key=? AND ${like}`, pt.subjectId).n;
  console.log(pid.padEnd(8), pt.chapterId.padEnd(6), String(n).padStart(4), kws.join('/'));
}
