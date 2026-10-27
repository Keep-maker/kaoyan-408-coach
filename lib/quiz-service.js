// ============================================================
//  408 题库练习服务
//  组卷 / 判分 / 错题 / 收藏 / 练习报告 / 掌握度回写
// ============================================================
const crypto = require('node:crypto');
const { q, ensureColumns } = require('./db');
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
  const ready = Boolean(q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='qb_questions'"));
  // 题库表来自同步脚本，可能是旧版本建的，缺列时先补齐再查询
  if (ready) ensureColumns();
  return ready;
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
    bookmarked: Boolean(bookmark),
    sectionName2: row.section_name || '',
    needsReview: Boolean(row.needs_review),
    orderNo: row.order_no != null ? Number(row.order_no) : null,
    paperScore: row.paper_score != null ? Number(row.paper_score) : null,
    examSection: row.exam_section || null
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
  const paperScore = row.paper_score != null ? Number(row.paper_score) : null;
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
    paperScore,
    score: attempt.score === null || attempt.score === undefined ? null : Number(attempt.score),
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
  const blank = {
    ready: false, total: 0, bankTotal: 0,
    subjects: Object.entries(SUBJECTS).map(([id, x]) => ({ id, ...x, total: 0 })),
    chapters: [], sections: [], types: [], difficulties: [],
    practiced: 0, accuracy: null, wrongCount: 0, favoriteCount: 0, noteCount: 0,
    unseenCount: 0, sessions: [], weak: [], mappedRate: 0, insights: null
  };
  if (!tableReady()) return blank;

  // 只统计可刷的题（排除同题干重复项）
  const bySubject = q.all(`SELECT subject_key id, COUNT(*) total FROM qb_questions
    WHERE COALESCE(dup_of,0)=0 GROUP BY subject_key`);
  const subjects = Object.entries(SUBJECTS).map(([id, meta]) => ({
    id, ...meta, total: bySubject.find((x) => x.id === id)?.total || 0
  }));

  // 章节 / 小节清单（按本科目知识树顺序）
  const chapterRows = q.all(`SELECT subject_key, chapter_id, chapter_name, section_name,
      COUNT(*) n FROM qb_questions WHERE COALESCE(dup_of,0)=0
    GROUP BY subject_key, chapter_id, chapter_name, section_name`);

  const chapterAgg = new Map();
  const sectionAgg = new Map();
  for (const row of chapterRows) {
    const displayId = displayChapterId(row);
    if (displayId) {
      const item = chapterAgg.get(displayId) || {
        id: displayId, name: row.chapter_name, subjectKey: row.subject_key, total: 0
      };
      item.total += row.n;
      chapterAgg.set(displayId, item);
    }
    const sectionName = String(row.section_name || '').trim();
    if (!sectionName || !displayId) continue;
    const key = displayId + '|' + sectionName;
    const sec = sectionAgg.get(key) || {
      chapterId: displayId, name: sectionName, subjectKey: row.subject_key, total: 0
    };
    sec.total += row.n;
    sectionAgg.set(key, sec);
  }

  const subjectOrder = Object.keys(SUBJECTS);
  const chapterSort = (a, b) => {
    const si = subjectOrder.indexOf(a.subjectKey) - subjectOrder.indexOf(b.subjectKey);
    if (si) return si;
    const sa = S.SUBJECT_BY_ID[a.subjectKey];
    const ia = sa ? sa.chapters.findIndex((c) => c.id === a.id) : 99;
    const sb = S.SUBJECT_BY_ID[b.subjectKey];
    const ib = sb ? sb.chapters.findIndex((c) => c.id === b.id) : 99;
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.name).localeCompare(String(b.name), 'zh-CN');
  };
  const chapters = [...chapterAgg.values()]
    .map((c) => ({ ...c, name: (S.CHAPTER_BY_ID[c.id] && S.CHAPTER_BY_ID[c.id].name) || c.name }))
    .sort(chapterSort);
  const chapterIndex = new Map(chapters.map((c, i) => [c.id, i]));
  const sections = [...sectionAgg.values()].sort((a, b) =>
    (chapterIndex.get(a.chapterId) ?? 99) - (chapterIndex.get(b.chapterId) ?? 99)
    || String(a.name).localeCompare(String(b.name), 'zh-CN'));

  const types = q.all(`SELECT type, COUNT(*) total FROM qb_questions
    WHERE COALESCE(dup_of,0)=0 GROUP BY type`);
  const difficulties = q.all(`SELECT difficulty, COUNT(*) total FROM qb_questions
    WHERE COALESCE(dup_of,0)=0 GROUP BY difficulty`);

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
    ORDER BY started_at DESC LIMIT 8`, userId).map(sessionState);
  const weak = E.weakPoints(userId, 8)
    .filter((w) => w.point)
    .map((w) => {
      const chapter = S.CHAPTER_BY_ID[w.point.chapterId];
      return {
        pointId: w.point.id,
        name: w.point.name,
        subjectId: w.point.subjectId,
        subjectName: SUBJECTS[w.point.subjectId]?.name || w.point.subjectId,
        chapterName: chapter ? chapter.name : '',
        weight: w.point.weight,
        p: Math.round(Math.max(0, Math.min(1, w.p)) * 100),
        studied: Boolean(w.studied),
        loss: w.loss
      };
    });

  const seen = new Set(latest.map((x) => x.source_id));
  const unseenCount = Math.max(0, (q.get(
    'SELECT COUNT(*) n FROM qb_questions WHERE COALESCE(dup_of,0)=0'
  ).n || 0) - seen.size);

  const noteCount = q.get('SELECT COUNT(*) n FROM quiz_notes WHERE user_id=?', userId).n || 0;

  return {
    ready: true,
    total: subjects.reduce((n, x) => n + x.total, 0),
    bankTotal: bankSize(),
    subjects,
    chapters: chapters.map((c) => ({
      id: c.id, name: c.name, subjectKey: c.subjectKey, total: c.total
    })),
    sections,
    types: TYPES.map((id) => ({ id, name: TYPE_LABEL[id], total: types.find((x) => x.type === id)?.total || 0 })),
    difficulties: DIFFICULTIES.map((id) => ({
      id, name: DIFF_LABEL[id], total: difficulties.find((x) => x.difficulty === id)?.total || 0
    })),
    practiced: attemptStats.attempts || 0,
    accuracy: attemptStats.graded ? Math.round((attemptStats.correct || 0) / attemptStats.graded * 100) : null,
    wrongCount: latest.filter((x) => x.correct === 0).length,
    favoriteCount: q.get('SELECT COUNT(*) n FROM quiz_bookmarks WHERE user_id=?', userId).n || 0,
    noteCount,
    unseenCount,
    sectionsCount: sections.length,
    sessions: recent,
    weak,
    mappedRate: attemptStats.attempts ? Math.round(mapped / attemptStats.attempts * 100) : 0,
    insights: insights(userId)
  };
}

// 刷题数据洞察：章节正确率热力、题型正确率、答题速度、错题分层
function insights(userId) {
  const rows = q.all(`SELECT a.*, qb.chapter_name, qb.subject_key, qb.type, qb.section_name,
      qb.title, qb.content
    FROM quiz_attempts a JOIN qb_questions qb ON qb.source_id=a.source_id
    WHERE a.user_id=?`, userId);

  const byChapter = new Map();
  const byType = new Map();
  const bySubject = new Map();
  let totalMs = 0;
  let timed = 0;

  for (const r of rows) {
    const graded = r.correct === null ? null : r.correct === 1;
    const chapterKey = r.chapter_name || '未分类';
    const ch = byChapter.get(chapterKey) || {
      name: chapterKey, subjectKey: r.subject_key, total: 0, correct: 0
    };
    ch.total += 1;
    if (graded) ch.correct += 1;
    byChapter.set(chapterKey, ch);

    const ty = byType.get(r.type) || { type: r.type, name: TYPE_LABEL[r.type] || r.type, total: 0, correct: 0 };
    ty.total += 1;
    if (graded) ty.correct += 1;
    byType.set(r.type, ty);

    const sb = bySubject.get(r.subject_key) || { subjectKey: r.subject_key, total: 0, correct: 0 };
    sb.total += 1;
    if (graded) sb.correct += 1;
    bySubject.set(r.subject_key, sb);

    const ms = Number(r.elapsed_ms || 0);
    if (ms > 1000) { totalMs += ms; timed += 1; }
  }

  const rate = (correct, total) => (total ? Math.round((correct / total) * 100) : null);
  const chapterHeat = [...byChapter.values()]
    .map((c) => ({ ...c, accuracy: rate(c.correct, c.total) }))
    .sort((a, b) => (a.accuracy ?? 101) - (b.accuracy ?? 101))
    .slice(0, 12);

  const wrongBuckets = q.all(`WITH latest AS (
      SELECT a.source_id, a.correct FROM quiz_attempts a
      WHERE a.user_id=? AND a.id=(
        SELECT MAX(b.id) FROM quiz_attempts b
        WHERE b.user_id=a.user_id AND b.source_id=a.source_id
      )
    )
    SELECT CASE WHEN cnt >= 3 THEN '3' WHEN cnt = 2 THEN '2' ELSE '1' END lvl, COUNT(*) n
    FROM (
      SELECT source_id, SUM(CASE WHEN correct=0 THEN 1 ELSE 0 END) cnt
      FROM quiz_attempts WHERE user_id=? GROUP BY source_id
      HAVING cnt > 0
    ) x GROUP BY lvl`, userId, userId);

  return {
    chapterHeat,
    types: [...byType.values()].map((t) => ({ ...t, accuracy: rate(t.correct, t.total) })),
    subjects: [...bySubject.values()].map((t) => ({ ...t, accuracy: rate(t.correct, t.total) })),
    avgSeconds: timed ? Math.round(totalMs / timed / 1000) : null,
    wrongBuckets: wrongBuckets.reduce((acc, x) => {
      acc[String(x.lvl)] = x.n;
      return acc;
    }, {})
  };
}

function cleanFilters(input = {}) {
  const subject = SUBJECTS[input.subject] ? input.subject : '';
  const type = TYPES.includes(input.type) ? input.type : '';
  const difficulty = DIFFICULTIES.includes(input.difficulty) ? input.difficulty : '';
  const chapter = input.chapter ? String(input.chapter) : '';
  const section = input.section ? String(input.section).slice(0, 80) : '';
  const keyword = input.keyword ? String(input.keyword).trim().slice(0, 40) : '';
  const mode = MODES.includes(input.mode) ? input.mode : 'random';
  const count = Math.max(1, Math.min(100, Number(input.count) || 20));
  const pointId = S.POINT_BY_ID[input.pointId] ? input.pointId : '';
  const readyOnly = input.readyOnly !== false;
  const unseenOnly = Boolean(input.unseenOnly);
  const sourceIds = Array.isArray(input.sourceIds)
    ? [...new Set(input.sourceIds.map((x) => Number(x)).filter((x) => Number.isInteger(x)))].slice(0, 200)
    : null;
  return { subject, chapter, section, keyword, type, difficulty, mode, count, pointId, readyOnly, unseenOnly, sourceIds };
}

function pointChapterSource(pointId) {
  const pt = S.POINT_BY_ID[pointId];
  if (!pt) return null;
  const entry = Object.entries(SOURCE_CHAPTER)
    .filter(([, chapterId]) => {
      const target = S.CHAPTER_BY_ID[chapterId];
      return chapterId === pt.chapterId && (!target || target.subjectId === pt.subjectId);
    })
    .sort((a, b) => Number(a[0]) - Number(b[0]))[0];
  return entry ? String(entry[0]) : null;
}

// 知识点点练的召回词表：知识点名太长且与源站小节命名差异大，
// 用核心关键词提高命中；无命中时按章节兜底，保证每个点都能出题。
const POINT_KEYWORDS = {
  'ds5-2': ['分块'], 
  'os2-9': ['生产者', '消费者', '哲学家', '读者写者', '读者', '写者', '银行取号', '理发店', '吸烟者'],
  'os2-10': ['管程'],
  'os3-2': ['动态分区', '可变分区', '首次适应', '最佳适应', '最坏适应', '紧凑'],
  'os3-3': ['分页', '页表', '地址变换', '快表', '页框', '多级页表'],
  'os3-4': ['段式', '段页式', '段表', '分段'],
  'os3-6': ['页面置换', '缺页', 'OPT', 'FIFO', 'LRU', 'CLOCK', 'Belady'],
  'os3-7': ['工作集', '抖动', '内存映射'],
  'os4-3': ['文件共享', '硬链接', '软链接', '存取控制'],
  'os4-6': ['磁盘调度', 'SCAN', 'SSTF', 'C-SCAN', 'LOOK', '电梯'],
  'cn1-4': ['分层', '协议', '接口', '服务'],
  'cn3-4': ['后退', '选择重传', 'GBN', 'SR', '滑动窗口'],
  'cn3-7': ['交换机', '网桥', 'VLAN'],
  'cn4-4': ['ARP', 'DHCP', 'ICMP'],
  'co2-4': ['乘法', 'Booth', '除法'],
  'co2-6': ['浮点加法', '浮点加减', '舍入'],
  'co3-8': ['TLB', 'Cache', '页表'],
  'co5-7': ['超标量', '动态流水', '多发射'],
  'os2-12': ['银行家'],
  'os4-5': ['索引分配', 'inode', '混合索引'],
  'cn1-2': ['时延', '带宽积', 'RTT', '速率'],
  'cn2-3': ['曼彻斯特', '编码', '调制'],
  'cn2-5': ['FDM', 'TDM', 'WDM', 'CDMA', '复用']
};

function selectQuestionIds(userId, filters) {
  // 重复题（同题干多 ID）不参与组卷，避免一次练习里出现两道一样的题
  const where = ['COALESCE(q.dup_of, 0) = 0'];
  const params = [];
  let joins = '';
  if (filters.sourceIds && filters.sourceIds.length) {
    const bankIds = q.all(
      `SELECT source_id FROM qb_questions
       WHERE source_id IN (${filters.sourceIds.map(() => '?').join(',')})`,
      ...filters.sourceIds
    );
    return bankIds.map((x) => x.source_id).slice(0, filters.count);
  }
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
  if (filters.section) {
    where.push('q.section_name=?');
    params.push(filters.section);
  }
  if (filters.keyword) {
    const kw = '%' + filters.keyword + '%';
    where.push('(q.title LIKE ? OR q.content LIKE ? OR q.tags_json LIKE ? OR q.section_name LIKE ?)');
    params.push(kw, kw, kw, kw);
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
      // 知识点的精确过滤很容易漏题（源站小节命名与知识树不一致），
      // 这里只在返回结果太少时按关键词补充，不把关键词当作硬性条件。
    }
  }
  if (filters.unseenOnly) {
    where.push(`q.source_id NOT IN (SELECT DISTINCT source_id FROM quiz_attempts WHERE user_id=?)`);
    params.push(userId);
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
  let ids;
  if (filters.pointId) {
    // 章节内优先找「知识点强相关」的题；不够再从整章补充，保证点练入口一定可出题。
    const pt = S.POINT_BY_ID[filters.pointId];
    const keywords = POINT_KEYWORDS[filters.pointId] || [
      pt.name.replace(/[（）()]/g, '').slice(0, 12)
    ];
    const like = keywords.map((t) =>
      `(q.title LIKE ? OR q.section_name LIKE ? OR q.tags_json LIKE ? OR q.content LIKE ?)`).join(' OR ');
    const scored = q.all(`SELECT q.source_id, ${keywords.length} score FROM qb_questions q${joins}
      WHERE ${where.join(' AND ')} AND (${like})
      ORDER BY ${order} LIMIT ?`, ...params, ...keywords.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]), filters.count);
    ids = scored.map((x) => x.source_id);
    if (ids.length < filters.count) {
      const safe = { ...filters, pointId: '', count: filters.count, subject: pt.subjectId, chapter: pt.chapterId };
      const extra = selectQuestionIds(userId, safe).filter((id) => !ids.includes(id));
      ids = [...ids, ...extra].slice(0, filters.count);
    }
  } else {
    const sql = `SELECT q.source_id FROM qb_questions q${joins}
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`;
    params.push(filters.count);
    ids = q.all(sql, ...params).map((x) => x.source_id);
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
  const filters = safeJson(session.filters_json, {}) || {};
  if (filters.examId) {
    const item = q.get('SELECT order_no, section, score FROM exam_items WHERE source_exam_id=? AND source_id=?',
      Number(filters.examId), sourceId);
    if (item) {
      row.order_no = item.order_no;
      row.exam_section = item.section;
      row.paper_score = item.score;
    }
  }
  const note = q.get('SELECT note FROM quiz_notes WHERE user_id=? AND source_id=?', userId, sourceId);
  return {
    session: sessionState(session),
    index: safeIndex,
    question: publicQuestion(row, bookmark),
    answer: answerView(row, attempt),
    note: note ? note.note : '',
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
      (user_id,session_id,source_id,point_id,subject_key,chapter_name,answer_json,correct,score,elapsed_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    userId, session.id, sourceId, pointId, row.subject_key, row.chapter_name,
    JSON.stringify(input.answer ?? ''), correctValue,
    correctValue === null ? null : null, elapsed);
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
  // 真题允许按卷面分给自己打分（不给分数时按对/错折算）
  const paperScore = q.get('SELECT score FROM exam_items WHERE source_id=? AND source_exam_id=(' +
    "SELECT json_extract(filters_json,'$.examId') FROM quiz_sessions WHERE id=? AND user_id=?)",
  sourceId, session.id, userId);
  let scoreValue = null;
  if (paperScore && Number(input.score) >= 0) {
    scoreValue = Math.max(0, Math.min(Number(paperScore.score || 0), Number(input.score)));
  } else if (paperScore) {
    scoreValue = correct ? Number(paperScore.score || 0) : 0;
  }
  q.tx(() => {
    q.run('UPDATE quiz_attempts SET correct=?, score=? WHERE id=? AND user_id=?', correct, scoreValue, attempt.id, userId);
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
  const rows = q.all(`SELECT a.*, q.title, q.content, q.type, q.difficulty, q.chapter_name, q.subject_key, q.explanation, q.answer_text
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
  const wrongRows = graded.filter((r) => r.correct === 0).slice(0, 20);
  return {
    session: sessionState(session),
    scored: graded.length,
    correct,
    wrong: graded.length - correct,
    pendingSelfGrade: rows.length - graded.length,
    accuracy: graded.length ? Math.round(correct / graded.length * 100) : null,
    mappedCount: rows.filter((r) => r.point_id).length,
    subjects,
    wrongItems: wrongRows.map((r) => ({
      sourceId: r.source_id,
      title: r.title || r.content || '',
      content: r.content || r.title || '',
      explanation: r.explanation || '',
      answerText: r.answer_text || '',
      subjectKey: r.subject_key,
      chapterName: r.chapter_name || '',
      pointId: r.point_id,
      pointName: r.point_id && S.POINT_BY_ID[r.point_id] ? S.POINT_BY_ID[r.point_id].name : '',
      type: r.type,
      difficulty: r.difficulty
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

// 单题笔记：写入或删除（内容留空即删除）
function saveNote(userId, sourceId, note) {
  const id = Number(sourceId);
  if (!getQuestionRow(id)) throw new Error('题目不存在');
  const text = String(note == null ? '' : note).slice(0, 2000).trim();
  if (!text) {
    q.run('DELETE FROM quiz_notes WHERE user_id=? AND source_id=?', userId, id);
    return { note: '' };
  }
  q.run('INSERT INTO quiz_notes (user_id,source_id,note,updated_at) VALUES (?,?,?,datetime(\'now\',\'localtime\')) ' +
    'ON CONFLICT(user_id,source_id) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at',
  userId, id, text);
  return { note: text };
}

// 举一反三：优先同小节、其次同章节里还没做过的题
function similarQuestions(userId, sourceId, limit = 6) {
  const row = getQuestionRow(sourceId);
  if (!row) return { items: [], basis: '' };
  const max = Math.max(1, Math.min(20, Number(limit) || 6));
  const done = new Set(q.all('SELECT DISTINCT source_id FROM quiz_attempts WHERE user_id=?', userId)
    .map((x) => x.source_id));
  const base = 'SELECT * FROM qb_questions WHERE COALESCE(dup_of,0)=0 AND subject_key=? AND source_id<>? ';
  const pickSection = () => row.section_name
    ? q.all(base + 'AND section_name=? ORDER BY RANDOM() LIMIT ?', row.subject_key, Number(sourceId), row.section_name, max)
    : [];
  const pickChapter = () => row.chapter_name
    ? q.all(base + 'AND chapter_name=? ORDER BY RANDOM() LIMIT ?', row.subject_key, Number(sourceId), row.chapter_name, max)
    : [];

  let items = pickSection().filter((x) => !done.has(x.source_id));
  let basis = row.section_name || '';
  if (items.length < max) {
    const extra = pickChapter()
      .filter((x) => !done.has(x.source_id) && !items.some((y) => y.source_id === x.source_id));
    items = items.concat(extra).slice(0, max);
    basis = basis || row.chapter_name || '';
  }
  if (!items.length) {
    items = (pickSection().length ? pickSection() : pickChapter()).slice(0, max);
    basis = basis || row.chapter_name || '';
  }
  return {
    basis,
    items: items.map((x) => {
      const grade = gradeQuestion(x, '');
      return Object.assign(publicQuestion(x, false), {
        correctKeys: grade.correctKeys,
        correctOptions: grade.correctOptions
      });
    })
  };
}

module.exports = {
  SUBJECTS, TYPES, DIFFICULTIES, TYPE_LABEL, DIFF_LABEL,
  POINT_KEYWORDS,
  tableReady, bankSize, overview, createSession, getSessionQuestion,
  getSession,
  submitAnswer, selfGrade, toggleBookmark, collection, finishSession,
  buildReport, inferPointId, learningPointId, displayChapterId, gradeQuestion,
  saveNote, similarQuestions, insights, getQuestionRow, answerView, normalizeOptions, extractReferenceAnswer
};
