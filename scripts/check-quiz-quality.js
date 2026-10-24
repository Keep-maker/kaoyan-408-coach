const { q } = require('../lib/db');

console.log('空题干:', q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE TRIM(COALESCE(title,''))='' AND TRIM(COALESCE(content,''))=''`).n);
console.log('源题无解析:', q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE TRIM(COALESCE(explanation,''))=''`).n);
console.log('无答案主观题:', q.get(`SELECT COUNT(*) n FROM qb_questions
  WHERE type IN ('SHORT','FILL','COMPOSITE')
  AND TRIM(COALESCE(answer_text,''))=''
  AND TRIM(COALESCE(explanation,''))=''`).n);
