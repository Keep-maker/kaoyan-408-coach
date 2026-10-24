// ============================================================
//  408 题库练习服务
//  组卷 / 判分 / 错题 / 收藏 / 练习报告 / 掌握度回写
// ============================================================
const crypto = require('node:crypto');
const { q } = require('./db');
const E = require('./engine');
const S = require('../data/syllabus');

const SUBJECTS = {
  ds: { name: '数据结构', short: '数据结构' },
  co: { name: '计算机组成原理', short: '组成原理' },
  os: { name: '操作系统', short: '操作系统' },
  cn: { name: '计算机网络', short: '计算机网络' }
};
const SUBJECT_ROOTS = { ds: 1, co: 2, os: 3, cn: 4 };
const TYPES = ['SINGLE', 'MULTIPLE', 'JUDGE', 'FILL', 'SHORT', 'COMPOSITE'];
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];
const TYPE_LABEL = {
  SINGLE: '单选', MULTIPLE: '多选', JUDGE: '判断', FILL: '填空',
  SHORT: '简答', COMPOSITE: '综合'
};
const DIFF_LABEL = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };
const MODES = ['random', 'sequence', 'wrong', 'favorite'];

// 研岛章节分类 id -> 本项目知识体系章节 id
const SOURCE_CHAPTER = {
  19: 'ds0', 20: 'ds1', 21: 'ds2', 22: 'ds0', 23: 'ds3', 24: 'ds4', 25: 'ds5', 26: 'ds6',
  30: 'co1', 31: 'co2', 32: 'co3', 33: 'co4', 34: 'co5', 35: 'co6', 36: 'co7',
  11: 'os1', 12: 'os2', 27: 'os3', 28: 'os4', 29: 'os5',
  13: 'cn1', 14: 'cn2', 15: 'cn3', 16: 'cn4', 17: 'cn5', 18: 'cn6'
};
const CHAPTER_ALIASES = {
  '绪论': 'ds0',
  '串': 'ds0',
  '进程管理': 'os2',
  '输入/输出系统': 'os5',
  'I/O系统': 'os5',
  '输入输出系统': 'os5'
};
// 源数据少量题目只有“小节”而缺“章节”，按语义补齐
const SECTION_CHAPTER = {
  '指令系统': 'co4',
  '计算机系统概述': 'co1',
  '数据的表示和运算': 'co2',
  '存储系统': 'co3',
  '中央处理器': 'co5',
  '总线': 'co6',
  '输入/输出系统': 'co7',
  'I/O系统': 'co7',
  '内存管理': 'os3',
  '文件管理': 'os4',
  'I/O管理': 'os5',
  '进程管理': 'os2'
};

function tableReady() {
  return Boolean(q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='qb_questions'"));
}

function bankSize() {
  if (!tableReady()) return 0;
  return q.get('SELECT COUNT(*) n FROM qb_questions').n || 0;
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\s、，,。；;：:·/\\-]/g, '')
    .replace(/输入输出|输入\/输出|i\/o/g, 'io')
    .replace(/处理机|处理器/g, '')
    .replace(/进程与进程管理/g, '进程管理')
    .replace(/与/g, '和')
    .replace(/及/g, '和');
}

function normalizeChapterName(row) {
  const explicit = String(row.chapter_name || '').trim();
  if (explicit) return explicit;
  const section = String(row.section_name || '').trim();
  const subject = S.SUBJECT_BY_ID[row.subject_key];
  if (subject) {
    const exact = subject.chapters.find((ch) => ch.name === section);
    if (exact) return exact.name;
  }
  return row.subject_key === 'co' ? '其他组成原理题' : row.subject_key === 'ds' ? '其他数据结构题' : '未分类';
}

function resolveChapterId(row, allowCrossSubject = false) {
  const bySource = row.chapter_id && SOURCE_CHAPTER[row.chapter_id]
    ? SOURCE_CHAPTER[row.chapter_id] : null;
  if (bySource) {
    const target = S.CHAPTER_BY_ID[bySource];
    if (allowCrossSubject || !target || !row.subject_key || target.subjectId === row.subject_key) return bySource;
  }
  const subjectRoot = SUBJECT_ROOTS[row.subject_key];
  const section = normalizeName(row.section_name);
  for (const [name, id] of Object.entries(SECTION_CHAPTER)) {
    if (section !== normalizeName(name)) continue;
    const target = S.CHAPTER_BY_ID[id];
    if (allowCrossSubject || !target || !row.subject_key || target.subjectId === row.subject_key) return id;
  }
  // 源站个别题目只带科目根分类，真实归属在 tag / 小节文本里
  const subject = S.SUBJECT_BY_ID[row.subject_key];
  const chapterName = normalizeName(row.chapter_name);
  const sourceChapterId = Number(row.chapter_id || row.source_category_id);
  const chapterBelongsToSubject = subject && subject.chapters.some((ch) =>
    (ch.id === 'os2' ? [12] : []).includes(sourceChapterId) ||
    ({ os1: [11], os3: [27], os4: [28], os5: [29],
      co1: [30], co2: [31], co3: [32], co4: [33], co5: [34], co6: [35], co7: [36],
      cn1: [13], cn2: [14], cn3: [15], cn4: [16], cn5: [17], cn6: [18],
      ds1: [20], ds2: [21], ds3: [23], ds4: [24], ds5: [25], ds6: [26] }[ch.id] || [])
      .includes(sourceChapterId));
  if (subject && (!chapterName || !chapterBelongsToSubject)) {
    const context = normalizeName([row.section_name, row.chapter_name].filter(Boolean).join(' '));
    const found = subject.chapters.find((ch) => {
      const target = normalizeName(ch.name);
      return target.length >= 2 && context.includes(target);
    });
    if (found) return found.id;
  }
  if (row.source_category_id && row.source_category_id !== subjectRoot && SOURCE_CHAPTER[row.source_category_id]) {
    const mapped = SOURCE_CHAPTER[row.source_category_id];
    const target = S.CHAPTER_BY_ID[mapped];
    if (allowCrossSubject || !row.subject_key || !target || target.subjectId === row.subject_key) return mapped;
  }
  if (CHAPTER_ALIASES[row.chapter_name]) return CHAPTER_ALIASES[row.chapter_name];
  const sub = S.SUBJECT_BY_ID[row.subject_key];
  if (!sub) return null;
  const source = normalizeName(row.chapter_name);
  const found = sub.chapters.find((ch) => {
    const target = normalizeName(ch.name);
    if (!source || !target) return false;
    if (source.includes(target) || target.includes(source)) return true;
    const a = source.replace(/管理/g, '').replace(/和/g, '');
    const b = target.replace(/管理/g, '').replace(/和/g, '');
    return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
  });
  return found ? found.id : null;
}

function pointTokens(name) {
  const cleaned = String(name || '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/的定义|的基本|基本|主要|常见|及其|以及|的/g, '')
    .replace(/[、，,。；;：:·/\\\s-]/g, ' ');
  return [...new Set(cleaned.split(/\s+/).flatMap((part) => {
    if (part.length <= 2) return [part];
    const out = [part];
    for (let i = 0; i < part.length - 1; i++) out.push(part.slice(i, i + 2));
    return out;
  }).filter((x) => x.length >= 2))];
}

function inferPointId(row) {
  const chapterId = resolveChapterId(row);
  if (!chapterId || chapterId === 'ds0') return null;
  const candidate = S.POINTS.filter((p) => p.chapterId === chapterId);
  // 章节归属跨科目时宁可不映射，也不能污染另一科的掌握度
  const points = candidate.filter((p) => !row.subject_key || p.subjectId === row.subject_key);
  if (!points.length) return null;
  const context = normalizeName([
    row.section_name, row.chapter_name, row.title,
    ...(safeJson(row.tags_json, []))
  ].filter(Boolean).join(' '));
  let best = null;
  for (const point of points) {
    const pointCore = normalizeName(point.name.replace(/（.*?）/g, ''));
    const section = normalizeName(row.section_name);
    const coreSquashed = pointCore.replace(/管理/g, '');
    const sectionSquashed = section.replace(/管理/g, '');
    let score = coreSquashed && sectionSquashed &&
      (sectionSquashed.includes(coreSquashed) || coreSquashed.includes(sectionSquashed))
      ? 12 : 0;
    for (const token of pointTokens(point.name)) {
      if (context.includes(normalizeName(token))) score += Math.max(1, token.length - 1);
    }
    if (!best || score > best.score) best = { point, score };
  }
  return best && best.score >= 3 ? best.point.id : null;
}

function displayChapterId(row) {
  const chapterId = resolveChapterId(row, true);
  if (!chapterId || chapterId === 'ds0') return null;
  const chapter = S.CHAPTER_BY_ID[chapterId];
  if (!chapter) return null;
  if (row.subject_key && chapter.subjectId !== row.subject_key) return null;
  return chapterId;
}

function chapterFilterSourceIds(chapterId) {
  const wanted = String(chapterId);
  const ids = new Set();
  const rows = q.all('SELECT source_id, source_category_id, chapter_id, chapter_name, section_name, subject_key FROM qb_questions');
  for (const row of rows) {
    if (displayChapterId(row) === wanted) ids.add(row.source_id);
  }
  return [...ids];
}

// 题目无法精确落到某个知识点时，归到所属章节最强相关的点：
// 先按小节点名匹配，再退到该章节权重最高的知识点，保证练习仍能驱动掌握度。
function learningPointId(row) {
  const exact = inferPointId(row);
  if (exact) return exact;
  const chapterId = resolveChapterId(row);
  if (!chapterId || chapterId === 'ds0') return null;
  const chapterPoints = S.POINTS.filter((p) => p.chapterId === chapterId &&
    (!row.subject_key || p.subjectId === row.subject_key));
  if (!chapterPoints.length) return null;
  const context = normalizeName([row.section_name, row.content, row.title].filter(Boolean).join(' '));
  let best = null;
  for (const point of chapterPoints) {
    const score = pointTokens(point.name)
      .reduce((n, token) => n + (context.includes(normalizeName(token)) ? 1 : 0), 0);
    if (!best || score > best.score || (score === best.score && point.weight > best.point.weight)) {
      best = { point, score };
    }
  }
  return best ? best.point.id : null;
}

function optionKey(index) {
  return String.fromCharCode(65 + index);
}

function normalizeOptions(row) {
  return safeJson(row.options_json, [])
    .filter((o) => o && String(o.content || '').trim())
    .sort((a, b) => Number(a.displayOrder || 0) - Number(b.displayOrder || 0))
    .map((o, i) => ({
      key: optionKey(i),
      content: String(o.content || ''),
      isCorrect: Boolean(o.isCorrect),
      displayOrder: i
    }));
}

function extractReferenceAnswer(row) {
  const type = String(row.type || '').toUpperCase();
  const direct = ['SINGLE', 'MULTIPLE'].includes(type) ? '' : String(row.answer_text || '').trim();
  if (direct) return direct;
  const text = String(row.explanation || '');
  const match = text.match(/##\s*正确答案\s*([\s\S]*?)(?=\n##\s|\n###\s|$)/);
  return match ? match[1].trim().slice(0, 2000) : '请对照详细解析判断作答是否完整。';
}

function publicQuestion(row, bookmark = false) {
  const options = normalizeOptions(row);
  const chapter = S.CHAPTER_BY_ID[displayChapterId(row)];
  return {
    sourceId: row.source_id,
    subjectKey: row.subject_key,
    subjectName: SUBJECTS[row.subject_key]?.name || row.subject_key,
    chapterId: chapter ? chapter.id : row.chapter_id,
    chapterName: chapter ? chapter.name : normalizeChapterName(row),
    sectionName: row.section_name || '',
    title: row.title || row.content,
    content: row.content || row.title,
    type: row.type,
    typeLabel: TYPE_LABEL[row.type] || row.type,
    difficulty: row.difficulty,
    difficultyLabel: DIFF_LABEL[row.difficulty] || row.difficulty,
    options: options.map(({ key, content }) => ({ key, content })),
    tags: safeJson(row.tags_json, []).map((x) => typeof x === 'string' ? x : x?.name).filter(Boolean),
    sourceUrl: row.source_url,
    answerCount: row.answer_count || 0,
    correctCount: row.correct_count || 0,
    bookmarked: Boolean(bookmark)
  };
}

function normalizeChoice(answer) {
  const list = Array.isArray(answer) ? answer : [answer];
  const keys = [];
  for (const item of list) {
    const matches = String(item || '').toUpperCase().match(/[A-H]/g) || [];
    matches.forEach((key) => { if (!keys.includes(key)) keys.push(key); });
  }
  return keys.sort();
}

function gradeQuestion(row, answer) {
  const options = normalizeOptions(row);
  const autoTypes = new Set(['SINGLE', 'MULTIPLE']);
  const canAutoGrade = autoTypes.has(row.type) && options.length > 0;
  if (!canAutoGrade) {
    return {
      autoGraded: false,
      correct: null,
      correctKeys: [],
      correctOptions: [],
      referenceAnswer: extractReferenceAnswer(row)
    };
  }
  const correctKeys = options.filter((o) => o.isCorrect).map((o) => o.key).sort();
  const givenKeys = normalizeChoice(answer);
  const correct = givenKeys.length === correctKeys.length &&
    givenKeys.every((key, i) => key === correctKeys[i]);
  return {
    autoGraded: true,
    correct,
    correctKeys,
    correctOptions: options.filter((o) => o.isCorrect).map((o) => ({ key: o.key, content: o.content })),
    referenceAnswer: extractReferenceAnswer(row)
  };
}

function getQuestionRow(sourceId) {
  return q.get('SELECT * FROM qb_questions WHERE source_id=?', Number(sourceId));
}

function latestAttempt(userId, sessionId, sourceId) {
  return q.get(
    'SELECT * FROM quiz_attempts WHERE user_id=? AND session_id=? AND source_id=? ORDER BY id DESC LIMIT 1',
    userId, sessionId, Number(sourceId)
  );
}

function answerView(row, attempt) {
  if (!attempt) return null;
  const grade = gradeQuestion(row, safeJson(attempt.answer_json, ''));
  return {
    answer: safeJson(attempt.answer_json, ''),
    correct: attempt.correct === null ? null : attempt.correct === 1,
    needsSelfGrade: attempt.correct === null,
    autoGraded: grade.autoGraded,
    correctKeys: grade.correctKeys,
    correctOptions: grade.correctOptions,
    referenceAnswer: grade.referenceAnswer,
    explanation: row.explanation || '',
    elapsedMs: attempt.elapsed_ms || 0,
    at: attempt.created_at
  };
}

function sessionState(session) {
  return {
    id: session.id,
    mode: session.mode,
    total: session.total,
    currentIndex: session.current_index || 0,
    answered: session.answered || 0,
    correct: session.correct || 0,
    status: session.status,
    durationMs: session.duration_ms || 0,
    startedAt: session.started_at,
    finishedAt: session.finished_at
  };
}

function getSession(userId, sessionId) {
  const session = q.get('SELECT * FROM quiz_sessions WHERE id=? AND user_id=?', String(sessionId || ''), userId);
  if (!session) throw new Error('练习记录不存在或已失效');
  return session;
}

function overview(userId) {
  if (!tableReady()) {
    return {
      ready: false, total: 0, subjects: Object.entries(SUBJECTS).map(([id, x]) => ({ id, ...x, total: 0 })),
      chapters: [], types: [], difficulties: [], practiced: 0, accuracy: null, wrongCount: 0,
      favoriteCount: 0, sessions: [], mappedRate: 0
    };
  }
  const bySubject = q.all('SELECT subject_key id, COUNT(*) total FROM qb_questions GROUP BY subject_key');
  const subjects = Object.entries(SUBJECTS).map(([id, meta]) => ({
    id, ...meta, total: bySubject.find((x) => x.id === id)?.total || 0
  }));
  const chapterRows = q.all(`SELECT * FROM qb_questions
    ORDER BY subject_key, source_category_id`);
  const chapterMap = new Map();
  for (const row of chapterRows) {
    const displayId = displayChapterId(row);
    if (!displayId) continue;
    if (!chapterMap.has(displayId)) {
      chapterMap.set(displayId, {
        id: displayId, name: row.chapter_name,
        subjectKey: row.subject_key, total: 0
      });
    }
    chapterMap.get(displayId).total += 1;
  }
  const knownChapters = [...chapterMap.values()].sort((a, b) =>
    Object.keys(SUBJECTS).indexOf(a.subjectKey) - Object.keys(SUBJECTS).indexOf(b.subjectKey) ||
    String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true })
  );
  const attached = new Map();
  for (const ch of knownChapters) {
    const subject = S.SUBJECT_BY_ID[ch.subjectKey];
    const target = subject?.chapters.find((x) => x.id === ch.id);
    const name = target?.name || ch.name;
    if (!attached.has(ch.id)) {
      attached.set(ch.id, { id: ch.id, name, subjectKey: ch.subjectKey, total: 0 });
    }
    attached.get(ch.id).total += ch.total;
  }
  const chapters = [...attached.values()];
  const types = q.all('SELECT type, COUNT(*) total FROM qb_questions GROUP BY type');
  const difficulties = q.all('SELECT difficulty, COUNT(*) total FROM qb_questions GROUP BY difficulty');
  const attemptStats = q.get(`SELECT COUNT(*) attempts,
      SUM(CASE WHEN correct IS NOT NULL THEN 1 ELSE 0 END) graded,
      SUM(CASE WHEN correct=1 THEN 1 ELSE 0 END) correct
    FROM quiz_attempts WHERE user_id=?`, userId);
  const latest = q.all(`SELECT a.source_id, a.correct FROM quiz_attempts a
    WHERE a.user_id=? AND a.id=(
      SELECT MAX(b.id) FROM quiz_attempts b
      WHERE b.user_id=a.user_id AND b.source_id=a.source_id
    )`, userId);
  const mapped = q.get(`SELECT COUNT(DISTINCT source_id) n FROM quiz_attempts
    WHERE user_id=? AND point_id IS NOT NULL`, userId).n || 0;
  const recent = q.all(`SELECT * FROM quiz_sessions WHERE user_id=?
    ORDER BY started_at DESC LIMIT 6`, userId).map(sessionState);
  return {
    ready: true,
    total: bankSize(),
    subjects,
    chapters: chapters.map((c) => ({
      id: c.id, name: c.name, subjectKey: c.subjectKey, total: c.total
    })),
    types: TYPES.map((id) => ({ id, name: TYPE_LABEL[id], total: types.find((x) => x.type === id)?.total || 0 })),
    difficulties: DIFFICULTIES.map((id) => ({
      id, name: DIFF_LABEL[id], total: difficulties.find((x) => x.difficulty === id)?.total || 0
    })),
    practiced: attemptStats.attempts || 0,
    accuracy: attemptStats.graded ? Math.round((attemptStats.correct || 0) / attemptStats.graded * 100) : null,
    wrongCount: latest.filter((x) => x.correct === 0).length,
    favoriteCount: q.get('SELECT COUNT(*) n FROM quiz_bookmarks WHERE user_id=?', userId).n || 0,
    sessions: recent,
    mappedRate: attemptStats.attempts ? Math.round(mapped / attemptStats.attempts * 100) : 0
  };
}

function cleanFilters(input = {}) {
  const subject = SUBJECTS[input.subject] ? input.subject : '';
  const type = TYPES.includes(input.type) ? input.type : '';
  const difficulty = DIFFICULTIES.includes(input.difficulty) ? input.difficulty : '';
  const chapter = input.chapter ? String(input.chapter) : '';
  const mode = MODES.includes(input.mode) ? input.mode : 'random';
  const count = Math.max(1, Math.min(50, Number(input.count) || 20));
  const pointId = S.POINT_BY_ID[input.pointId] ? input.pointId : '';
  const readyOnly = input.readyOnly !== false;
  return { subject, chapter, type, difficulty, mode, count, pointId, readyOnly };
}

function pointChapterSource(pointId) {
  const pt = S.POINT_BY_ID[pointId];
  if (!pt) return null;
  const entry = Object.entries(SOURCE_CHAPTER).find(([, chapterId]) => chapterId === pt.chapterId);
  return entry ? String(entry[0]) : null;
}

function selectQuestionIds(userId, filters) {
  const where = ['1=1'];
  const params = [];
  let joins = '';
  let pointLike = '';
  if (filters.subject) {
    where.push('q.subject_key=?');
    params.push(filters.subject);
  }
  if (filters.chapter) {
    const sourceIds = chapterFilterSourceIds(filters.chapter);
    if (!sourceIds.length) return [];
    where.push(`q.source_id IN (${sourceIds.map(() => '?').join(',')})`);
    params.push(...sourceIds);
  }
  if (filters.type) {
    where.push('q.type=?');
    params.push(filters.type);
  }
  if (filters.difficulty) {
    where.push('q.difficulty=?');
    params.push(filters.difficulty);
  }
  if (filters.readyOnly) {
    where.push(`(TRIM(COALESCE(q.explanation,''))<>'' OR q.type IN ('SINGLE','MULTIPLE'))`);
  }
  if (filters.pointId) {
    const pt = S.POINT_BY_ID[filters.pointId];
    const sourceChapter = pointChapterSource(filters.pointId);
    if (sourceChapter) {
      where.push('q.source_category_id=?');
      params.push(Number(sourceChapter));
    } else if (pt) {
      where.push('q.subject_key=?');
      params.push(pt.subjectId);
    }
    if (pt) {
      pointLike = pt.name.replace(/[（）()]/g, '').slice(0, 12);
      where.push('(q.title LIKE ? OR q.section_name LIKE ? OR q.tags_json LIKE ?)');
      params.push(`%${pointLike}%`, `%${pointLike}%`, `%${pointLike}%`);
    }
  }
  if (filters.mode === 'wrong') {
    joins += ` JOIN (
      SELECT a.source_id, a.correct FROM quiz_attempts a
      WHERE a.user_id=? AND a.id=(
        SELECT MAX(b.id) FROM quiz_attempts b
        WHERE b.user_id=a.user_id AND b.source_id=a.source_id
      )
    ) latest ON latest.source_id=q.source_id`;
    params.unshift(userId);
    where.push('latest.correct=0');
  } else if (filters.mode === 'favorite') {
    joins += ' JOIN quiz_bookmarks bk ON bk.source_id=q.source_id AND bk.user_id=?';
    params.unshift(userId);
  }
  const order = filters.mode === 'sequence' ? 'q.source_id ASC' : 'RANDOM()';
  const sql = `SELECT q.source_id FROM qb_questions q${joins}
    WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`;
  params.push(filters.count);
  let ids = q.all(sql, ...params).map((x) => x.source_id);
  // 「点练」没有精确命中时回退到该章节，不让入口变成死路
  if (!ids.length && filters.pointId && (filters.chapter || pointLike)) {
    const safe = { ...filters, pointId: '', count: filters.count };
    const sourceChapter = pointChapterSource(filters.pointId);
    if (sourceChapter) safe.chapter = sourceChapter;
    ids = selectQuestionIds(userId, safe);
  }
  return ids;
}

function createSession(userId, input) {
  if (!tableReady() || bankSize() === 0) throw new Error('题库尚未同步，请先同步题库');
  const filters = cleanFilters(input);
  const ids = selectQuestionIds(userId, filters);
  if (!ids.length) throw new Error(filters.mode === 'wrong' ? '错题本里还没有题目，先完成一次练习' :
    filters.mode === 'favorite' ? '收藏夹里还没有题目' : '当前筛选条件下没有题目');
  const id = crypto.randomUUID();
  q.run(`INSERT INTO quiz_sessions
    (id,user_id,mode,filters_json,question_ids,total,current_index,answered,correct,duration_ms)
    VALUES (?,?,?,?,?,?,0,0,0,0)`,
  id, userId, filters.mode, JSON.stringify(filters), JSON.stringify(ids), ids.length);
  const session = getSession(userId, id);
  const first = getSessionQuestion(userId, id, 0);
  return { session: sessionState(session), question: first.question, answer: first.answer, statuses: first.statuses };
}

function getStatuses(userId, session) {
  const ids = safeJson(session.question_ids, []);
  const rows = q.all(`SELECT source_id, correct FROM quiz_attempts
    WHERE user_id=? AND session_id=? ORDER BY id`, userId, session.id);
  const map = Object.fromEntries(rows.map((r) => [String(r.source_id), r]));
  return ids.map((sourceId, index) => ({
    index,
    sourceId,
    answered: Boolean(map[String(sourceId)]),
    correct: map[String(sourceId)]?.correct ?? null
  }));
}

function getSessionQuestion(userId, sessionId, index = 0) {
  const session = getSession(userId, sessionId);
  const ids = safeJson(session.question_ids, []);
  const safeIndex = Math.max(0, Math.min(ids.length - 1, Number(index) || 0));
  const sourceId = ids[safeIndex];
  const row = getQuestionRow(sourceId);
  if (!row) throw new Error('题目已从题库移除');
  const attempt = latestAttempt(userId, sessionId, sourceId);
  const bookmark = Boolean(q.get('SELECT 1 x FROM quiz_bookmarks WHERE user_id=? AND source_id=?', userId, sourceId));
  return {
    session: sessionState(session),
    index: safeIndex,
    question: publicQuestion(row, bookmark),
    answer: answerView(row, attempt),
    statuses: getStatuses(userId, session)
  };
}

function submitAnswer(userId, input) {
  const session = getSession(userId, input.sessionId);
  if (session.status !== 'active') throw new Error('本次练习已经结束');
  const ids = safeJson(session.question_ids, []);
  const sourceId = Number(input.sourceId);
  if (!ids.includes(sourceId)) throw new Error('题目不属于本次练习');
  let attempt = latestAttempt(userId, session.id, sourceId);
  if (attempt) {
    const row = getQuestionRow(sourceId);
    return { answer: answerView(row, attempt), session: sessionState(session) };
  }
  const row = getQuestionRow(sourceId);
  const grade = gradeQuestion(row, input.answer);
  const correctValue = grade.correct === null ? null : (grade.correct ? 1 : 0);
  const elapsed = Math.max(0, Math.min(30 * 60 * 1000, Number(input.elapsedMs) || 0));
  const pointId = learningPointId(row);
  q.tx(() => {
    q.run(`INSERT INTO quiz_attempts
      (user_id,session_id,source_id,point_id,subject_key,chapter_name,answer_json,correct,elapsed_ms)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    userId, session.id, sourceId, pointId, row.subject_key, row.chapter_name,
    JSON.stringify(input.answer ?? ''), correctValue, elapsed);
    const index = ids.indexOf(sourceId);
    q.run(`UPDATE quiz_sessions SET answered=answered+1,
      correct=correct+?, current_index=MAX(current_index, ?), duration_ms=duration_ms+?
      WHERE id=? AND user_id=?`,
    grade.correct === 1 ? 1 : 0, index + 1, elapsed, session.id, userId);
  });
  attempt = latestAttempt(userId, session.id, sourceId);
  return {
    answer: answerView(row, attempt),
    session: sessionState(getSession(userId, session.id))
  };
}

function selfGrade(userId, input) {
  const session = getSession(userId, input.sessionId);
  const sourceId = Number(input.sourceId);
  const attempt = latestAttempt(userId, session.id, sourceId);
  if (!attempt) throw new Error('请先提交作答');
  if (attempt.correct !== null) throw new Error('该题已经完成判分');
  const correct = Boolean(input.correct) ? 1 : 0;
  q.tx(() => {
    q.run('UPDATE quiz_attempts SET correct=? WHERE id=? AND user_id=?', correct, attempt.id, userId);
    q.run('UPDATE quiz_sessions SET correct=correct+? WHERE id=? AND user_id=?', correct, session.id, userId);
  });
  const row = getQuestionRow(sourceId);
  return {
    answer: answerView(row, latestAttempt(userId, session.id, sourceId)),
    session: sessionState(getSession(userId, session.id))
  };
}

function toggleBookmark(userId, sourceId, bookmarked) {
  const id = Number(sourceId);
  if (!getQuestionRow(id)) throw new Error('题目不存在');
  if (bookmarked === false) {
    q.run('DELETE FROM quiz_bookmarks WHERE user_id=? AND source_id=?', userId, id);
    return { bookmarked: false };
  }
  q.run('INSERT INTO quiz_bookmarks (user_id,source_id) VALUES (?,?) ON CONFLICT DO NOTHING', userId, id);
  return { bookmarked: true };
}

function collection(userId, kind, limit = 80) {
  if (!tableReady()) return { items: [], total: 0 };
  const max = Math.max(1, Math.min(200, Number(limit) || 80));
  if (kind === 'wrong') {
    const items = q.all(`WITH latest AS (
        SELECT a.* FROM quiz_attempts a
        WHERE a.user_id=? AND a.id=(
          SELECT MAX(b.id) FROM quiz_attempts b
          WHERE b.user_id=a.user_id AND b.source_id=a.source_id
        )
      )
      SELECT q.*, latest.correct, latest.answer_json, latest.created_at attempted_at
      FROM latest JOIN qb_questions q ON q.source_id=latest.source_id
      WHERE latest.correct=0 ORDER BY latest.id DESC LIMIT ?`, userId, max);
    return {
      items: items.map((row) => {
        const grade = gradeQuestion(row, safeJson(row.answer_json, ''));
        return {
          ...publicQuestion(row, Boolean(q.get('SELECT 1 x FROM quiz_bookmarks WHERE user_id=? AND source_id=?', userId, row.source_id))),
          answer: safeJson(row.answer_json, ''), attemptedAt: row.attempted_at,
          explanation: row.explanation || '', correctKeys: grade.correctKeys,
          correctOptions: grade.correctOptions, referenceAnswer: grade.referenceAnswer
        };
      }),
      total: overview(userId).wrongCount
    };
  }
  const items = q.all(`SELECT q.*, bk.created_at bookmarked_at FROM quiz_bookmarks bk
    JOIN qb_questions q ON q.source_id=bk.source_id
    WHERE bk.user_id=? ORDER BY bk.created_at DESC LIMIT ?`, userId, max);
  return {
    items: items.map((row) => {
      const grade = gradeQuestion(row, '');
      return {
        ...publicQuestion(row, true), bookmarkedAt: row.bookmarked_at,
        explanation: row.explanation || '', correctKeys: grade.correctKeys,
        correctOptions: grade.correctOptions, referenceAnswer: grade.referenceAnswer
      };
    }),
    total: q.get('SELECT COUNT(*) n FROM quiz_bookmarks WHERE user_id=?', userId).n || 0
  };
}

function buildReport(userId, session) {
  const rows = q.all(`SELECT a.*, q.title, q.type, q.difficulty, q.chapter_name, q.subject_key
    FROM quiz_attempts a JOIN qb_questions q ON q.source_id=a.source_id
    WHERE a.user_id=? AND a.session_id=? ORDER BY a.id`, userId, session.id);
  const graded = rows.filter((r) => r.correct !== null);
  const correct = graded.filter((r) => r.correct === 1).length;
  const subjects = Object.entries(SUBJECTS).map(([id, meta]) => {
    const list = graded.filter((r) => r.subject_key === id);
    return {
      id, name: meta.name, total: list.length,
      correct: list.filter((r) => r.correct === 1).length,
      accuracy: list.length ? Math.round(list.filter((r) => r.correct === 1).length / list.length * 100) : null
    };
  }).filter((x) => x.total);
  return {
    session: sessionState(session),
    scored: graded.length,
    correct,
    wrong: graded.length - correct,
    pendingSelfGrade: rows.length - graded.length,
    accuracy: graded.length ? Math.round(correct / graded.length * 100) : null,
    mappedCount: rows.filter((r) => r.point_id).length,
    subjects,
    wrongItems: graded.filter((r) => r.correct === 0).slice(0, 12).map((r) => ({
      sourceId: r.source_id, title: r.title, subjectKey: r.subject_key,
      chapterName: r.chapter_name, pointId: r.point_id
    }))
  };
}

function finishSession(userId, sessionId) {
  let session = getSession(userId, sessionId);
  if (session.status === 'active') {
    const attempts = q.all(`SELECT a.*, q.source_id FROM quiz_attempts a
      JOIN qb_questions q ON q.source_id=a.source_id
      WHERE a.user_id=? AND a.session_id=?`, userId, session.id);
    const graded = attempts.filter((a) => a.correct !== null);
    const durationMinutes = Math.max(graded.length ? 1 : 0,
      Math.round(Number(session.duration_ms || q.get(
        'SELECT SUM(elapsed_ms) n FROM quiz_attempts WHERE user_id=? AND session_id=?', userId, session.id
      ).n || 0) / 60000));
    const groups = {};
    for (const a of graded) {
      if (!a.point_id || !S.POINT_BY_ID[a.point_id]) continue;
      const g = groups[a.point_id] || (groups[a.point_id] = { total: 0, correct: 0 });
      g.total += 1;
      g.correct += a.correct === 1 ? 1 : 0;
    }
    q.tx(() => {
      let wroteMinutes = 0;
      Object.entries(groups).forEach(([pointId, g]) => {
        const minutes = Math.max(1, Math.round(durationMinutes * g.total / Math.max(1, graded.length)));
        wroteMinutes += minutes;
        q.run(`INSERT INTO logs
          (user_id,point_id,date,minutes,kind,correct,total,self_rating,note)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        userId, pointId, E.todayStr(), minutes, 'quiz', g.correct, g.total, 0, '408 题库练习');
        E.applyLog(userId, {
          point_id: pointId, date: E.todayStr(), kind: 'quiz',
          minutes, correct: g.correct, total: g.total, self_rating: 0
        });
        q.run(`UPDATE plan SET status='done'
          WHERE user_id=? AND date=? AND point_id=? AND status='todo'`,
        userId, E.todayStr(), pointId);
      });
      if (durationMinutes > 0) {
        const ck = q.get('SELECT * FROM checkins WHERE user_id=? AND date=?', userId, E.todayStr());
        if (ck) q.run('UPDATE checkins SET minutes=minutes+? WHERE id=?', durationMinutes, ck.id);
        else q.run('INSERT INTO checkins (user_id,date,minutes,mood,note) VALUES (?,?,?,?,?)',
          userId, E.todayStr(), durationMinutes, 3, '（由题库练习自动生成）');
      }
      q.run(`UPDATE quiz_sessions SET status='completed', finished_at=datetime('now','localtime'),
        duration_ms=?, correct=(SELECT COALESCE(SUM(correct),0) FROM quiz_attempts
          WHERE user_id=? AND session_id=?) WHERE id=? AND user_id=?`,
      Math.max(Number(session.duration_ms || 0), durationMinutes * 60000), userId, session.id, session.id, userId);
    });
    session = getSession(userId, session.id);
  }
  return buildReport(userId, session);
}

module.exports = {
  SUBJECTS, TYPES, DIFFICULTIES, TYPE_LABEL, DIFF_LABEL,
  tableReady, bankSize, overview, createSession, getSessionQuestion,
  submitAnswer, selfGrade, toggleBookmark, collection, finishSession,
  buildReport, inferPointId, learningPointId, displayChapterId, gradeQuestion
};
