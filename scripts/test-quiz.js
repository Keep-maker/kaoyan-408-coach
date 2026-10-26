const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbFile = path.join(os.tmpdir(), `kaoyan-quiz-${Date.now()}.db`);
process.env.KY_DB = dbFile;

const { db, q } = require('../lib/db');
const quiz = require('../lib/quiz-service');
const E = require('../lib/engine');

let passed = 0;
function check(ok, message) {
  assert.ok(ok, message);
  passed += 1;
  console.log('  ok - ' + message);
}

function setup() {
  q.run(`CREATE TABLE qb_questions (
    source_id INTEGER PRIMARY KEY, slug TEXT, subject_key TEXT, source_category_id INTEGER,
    chapter_id INTEGER, chapter_name TEXT, section_name TEXT, title TEXT, content TEXT,
    type TEXT, difficulty TEXT, options_json TEXT, answer_text TEXT, explanation TEXT,
    tags_json TEXT, correct_count INTEGER, answer_count INTEGER, source_url TEXT,
    source_updated_at TEXT, synced_at TEXT
  )`);
  const options1 = [
    { content: '错误选项', isCorrect: false, displayOrder: 0 },
    { content: '正确选项', isCorrect: true, displayOrder: 1 },
    { content: '另一个错误选项', isCorrect: false, displayOrder: 2 }
  ];
  const options2 = [
    { content: '要点一', isCorrect: true, displayOrder: 0 },
    { content: '干扰项', isCorrect: false, displayOrder: 1 },
    { content: '要点二', isCorrect: true, displayOrder: 2 }
  ];
  q.run(`INSERT INTO qb_questions
    (source_id,slug,subject_key,source_category_id,chapter_id,chapter_name,section_name,title,content,type,difficulty,options_json,answer_text,explanation,tags_json,correct_count,answer_count,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  101, 'single-test', 'ds', 20, 20, '线性表', '顺序表',
  '顺序表插入元素平均移动多少次？', '顺序表插入元素平均移动多少次？', 'SINGLE', 'EASY',
  JSON.stringify(options1), 'B', '## 正确答案\nB\n\n## 详细解析\n答案为 B。',
  JSON.stringify(['线性表', '顺序表']), 10, 12, 'https://www.408dao.com/questions/101/test');
  q.run(`INSERT INTO qb_questions
    (source_id,slug,subject_key,source_category_id,chapter_id,chapter_name,section_name,title,content,type,difficulty,options_json,answer_text,explanation,tags_json,correct_count,answer_count,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  102, 'multiple-test', 'ds', 23, 23, '树与二叉树', '二叉树的性质',
  '下列哪些结论正确？', '下列哪些结论正确？', 'MULTIPLE', 'MEDIUM',
  JSON.stringify(options2), 'A、C', '## 正确答案\nA、C\n\n## 详细解析\nA、C 正确。',
  JSON.stringify(['二叉树', '结点']), 8, 10, 'https://www.408dao.com/questions/102/test');
  q.run(`INSERT INTO qb_questions
    (source_id,slug,subject_key,source_category_id,chapter_id,chapter_name,section_name,title,content,type,difficulty,options_json,answer_text,explanation,tags_json,correct_count,answer_count,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  103, 'short-test', 'os', 12, 12, '进程管理', '信号量',
  '简述 P、V 操作的语义。', '简述 P、V 操作的语义。', 'SHORT', 'HARD',
  '[]', 'P 申请资源，V 释放资源。', '## 正确答案\nP 申请资源，V 释放资源并唤醒等待进程。',
  JSON.stringify(['信号量', 'PV 操作']), 2, 4, 'https://www.408dao.com/questions/103/test');
  q.run(`INSERT INTO users (name,exam_date,daily_minutes,target_score,start_date)
    VALUES ('测试',?,240,110,?)`, E.addDays(E.todayStr(), 60), E.todayStr());
  return q.get('SELECT id FROM users ORDER BY id DESC LIMIT 1').id;
}

function pickAndAnswer(userId, session, sourceId, answer) {
  const response = quiz.submitAnswer(userId, {
    sessionId: session.id,
    sourceId,
    answer,
    elapsedMs: 1000
  });
  check(response.answer !== null, '提交答案后返回判分结果');
  return response;
}

(async () => {
  console.log('题库练习服务测试');
  const userId = setup();
  const overview = quiz.overview(userId);
  check(overview.total === 3, '题库概览统计总题量');
  check(overview.ready === true, '题库表就绪');
  check(overview.subjects.find((x) => x.id === 'ds').total === 2, '按科目统计题量');

  const started = quiz.createSession(userId, { subject: 'ds', count: 2, mode: 'sequence' });
  check(started.session.total === 2, '按科目创建练习会话');
  check(started.question.options.every((o) => !('isCorrect' in o)), '未作答前不向前端泄露答案');
  const statuses = started.statuses.slice();
  const ids = statuses.map((x) => x.sourceId);
  check(ids.includes(101) && ids.includes(102), '组卷筛选出目标题目');

  const wrong = pickAndAnswer(userId, started.session, 101, 'A');
  check(wrong.answer.correct === false, '单选题错误答案判为错误');
  check(wrong.answer.correctKeys[0] === 'B', '返回正确选项字母');

  const right = pickAndAnswer(userId, started.session, 102, ['A', 'C']);
  check(right.answer.correct === true, '多选题全选正确才判对');

  quiz.toggleBookmark(userId, 101, true);
  const favorites = quiz.collection(userId, 'favorite');
  check(favorites.total === 1 && favorites.items[0].sourceId === 101, '收藏夹持久化');
  const wrongs = quiz.collection(userId, 'wrong');
  check(wrongs.total === 1 && wrongs.items[0].sourceId === 101, '错题本按最新作答归档');

  const report = quiz.finishSession(userId, started.session.id);
  check(report.scored === 2 && report.correct === 1 && report.wrong === 1, '练习报告汇总正确/错误');
  check(q.get('SELECT COUNT(*) n FROM logs WHERE user_id=? AND kind=?', userId, 'quiz').n >= 1, '练习结果写入学习记录');
  check(q.get("SELECT COUNT(*) n FROM checkins WHERE user_id=?", userId).n === 1, '练习时长自动计入打卡');

  const subjective = quiz.createSession(userId, { subject: 'os', count: 1, mode: 'sequence' });
  const submitted = pickAndAnswer(userId, subjective.session, 103, 'P 是申请资源');
  check(submitted.answer.needsSelfGrade === true && submitted.answer.correct === null, '主观题进入自评状态');
  const graded = quiz.selfGrade(userId, {
    sessionId: subjective.session.id,
    sourceId: 103,
    correct: true
  });
  check(graded.answer.correct === true, '主观题自评后写入结果');

  // 选做题即使服务端生成了字母答案，也不应把字母当成“参考答案”重复展示
  const choiceStable = quiz.createSession(userId, { subject: 'ds', count: 1, mode: 'sequence' });
  const choiceAnswer = quiz.submitAnswer(userId, {
    sessionId: choiceStable.session.id, sourceId: choiceStable.question.sourceId,
    answer: 'B', elapsedMs: 1000
  });
  check(choiceAnswer.answer.correctKeys.length > 0,
    '选择题返回正确选项字母，供选项着色');

  check(quiz.inferPointId({
    subject_key: 'ds', source_category_id: 20, chapter_name: '线性表',
    section_name: '顺序表', title: '顺序表的插入删除', tags_json: '["顺序表"]'
  })?.startsWith('ds1-'), '题目可关联到现有知识点');
  check(quiz.learningPointId({
    subject_key: 'cn', source_category_id: 14, chapter_id: 14, chapter_name: '物理层',
    section_name: '编码与调制', title: '曼彻斯特编码的码元速率如何计算？', tags_json: '["曼彻斯特"]'
  })?.startsWith('cn2-'), '题目无法精确命中时可按章节兜底映射');
  check(quiz.displayChapterId({
    subject_key: 'co', source_category_id: 2, chapter_id: null,
    chapter_name: null, section_name: '指令系统'
  }) === 'co4', '缺失章节的题目可从已有分类恢复');
  const strayFileQuestion = {
    subject_key: 'co', source_category_id: 28, chapter_id: 28,
    chapter_name: '文件管理', section_name: '文件系统', title: '文件系统题'
  };
  check(!String(quiz.learningPointId(strayFileQuestion)).startsWith('os4-'),
    '源站跨科错分的题目不会污染另一科掌握度');

  // 新增强：按指定题号组卷（报告页“只练本次错题”），仅返回题库中存在的题
  const sessionByIds = quiz.createSession(userId, {
    sourceIds: [101, 102, 999999],
    count: 10,
    mode: 'random'
  });
  check(sessionByIds.session.total === 2,
    '按 sourceIds 组卷只包含存在的题');
  const byIds = sessionByIds.statuses.map((x) => x.sourceId).sort();
  check(byIds.join(',') === '101,102', 'sourceIds 组卷返回指定题目');

  // 新增强：概览返回最近练习与薄弱点候选
  const over2 = quiz.overview(userId);
  check(Array.isArray(over2.sessions) && over2.sessions.length >= 1, '概览返回最近练习列表');
  check(Array.isArray(over2.weak) && over2.weak.length > 0, '概览返回薄弱点候选');
  check('pointId' in (over2.weak[0] || {}), '薄弱点候选含知识点 id');

  // 新增强：报告错题条目带题干与解析，供报告页复盘
  const report2 = quiz.buildReport(userId, quiz.getSession(userId, started.session.id));
  const wrongItem = report2.wrongItems.find((x) => x.sourceId === 101);
  check(wrongItem && String(wrongItem.content || '').length > 0, '报告错题带题干');
  check(wrongItem && (wrongItem.explanation || wrongItem.answerText), '报告错题带解析/答案');

  console.log(`通过 ${passed} 项检查`);
  db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(dbFile + suffix, { force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error('\n失败:', error);
  try { db.close(); } catch (_) {}
  process.exitCode = 1;
});
