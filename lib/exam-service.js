'use strict';
// ============================================================
//  历年真题卷服务：卷子列表 / 组卷 / 计时 / 150 分制算分 / 分大题得分
//  卷子本身来自 scripts/sync-exams.js 落库的 exam_papers + exam_items
// ============================================================
const crypto = require('node:crypto');
const { q } = require('./db');
const quiz = require('./quiz-service');

const MODE = 'exam';

function tableReady() {
  return Boolean(q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='exam_papers'"));
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function paperRows() {
  if (!tableReady()) return [];
  return q.all('SELECT * FROM exam_papers ORDER BY year DESC');
}

// 每套卷子的个人完成状态（最近一次该卷子的练习）
function listPapers(userId) {
  const papers = paperRows();
  const sessions = q.all(`SELECT * FROM quiz_sessions
    WHERE user_id=? AND mode=? ORDER BY started_at DESC`, userId, MODE);
  const byExam = new Map();
  for (const s of sessions) {
    const f = safeJson(s.filters_json, {}) || {};
    const examId = Number(f.examId);
    if (!examId || byExam.has(examId)) continue;
    byExam.set(examId, s);
  }

  return papers.map((p) => {
    const sections = safeJson(p.sections_json, []);
    const session = byExam.get(p.source_exam_id) || null;
    let score = null;
    const answered = session ? (session.answered || 0) : 0;
    if (session && session.status === 'completed') score = examScore(userId, session.id).total;
    return {
      examId: p.source_exam_id,
      title: p.title,
      year: p.year,
      durationMin: p.duration_min || 180,
      totalScore: p.total_score || 150,
      questionCount: p.question_count || 0,
      sections,
      lastSessionId: session ? session.id : null,
      lastStatus: session ? session.status : null,
      lastScore: session && session.status === 'completed' ? score : null,
      answered,
      attempts: session ? 1 : 0
    };
  });
}

function paperItems(examId) {
  return q.all(`SELECT i.*, q2.type, q2.subject_key, q2.title, q2.dup_of
    FROM exam_items i JOIN qb_questions q2 ON q2.source_id=i.source_id
    WHERE i.source_exam_id=? ORDER BY i.order_no`, Number(examId));
}

function createExamSession(userId, examId) {
  const id = Number(examId);
  const paper = q.get('SELECT * FROM exam_papers WHERE source_exam_id=?', id);
  if (!paper) throw new Error('真题卷不存在，请先同步真题');
  const items = paperItems(id).filter((x) => !x.dup_of);
  if (!items.length) throw new Error('该真题卷没有可用题目');

  const sessionId = crypto.randomUUID();
  const filters = {
    mode: MODE, examId: id, examTitle: paper.title, durationMin: paper.duration_min || 180,
    totalScore: paper.total_score || 150, count: items.length, readyOnly: false
  };
  q.run(`INSERT INTO quiz_sessions
    (id,user_id,mode,filters_json,question_ids,total,current_index,answered,correct,duration_ms)
    VALUES (?,?,?,?,?,?,0,0,0,0)`,
  sessionId, userId, MODE, JSON.stringify(filters), JSON.stringify(items.map((x) => x.source_id)), items.length);

  const first = quiz.getSessionQuestion(userId, sessionId, 0);
  return { session: first.session, question: first.question, answer: first.answer, statuses: first.statuses, exam: examMeta(paper) };
}

function examMeta(paper) {
  return {
    examId: paper.source_exam_id,
    title: paper.title,
    year: paper.year,
    durationMin: paper.duration_min || 180,
    totalScore: paper.total_score || 150,
    questionCount: paper.question_count || 0,
    sections: safeJson(paper.sections_json, [])
  };
}

function sessionExam(userId, sessionId) {
  const session = q.get('SELECT * FROM quiz_sessions WHERE id=? AND user_id=?', String(sessionId || ''), userId);
  if (!session) throw new Error('练习记录不存在或已失效');
  const filters = safeJson(session.filters_json, {}) || {};
  if (!filters.examId) return null;
  const paper = q.get('SELECT * FROM exam_papers WHERE source_exam_id=?', Number(filters.examId));
  return paper ? { paper, session, filters } : null;
}

// 剩余时间（秒）：开始时间 + 考试时长 - 已用时
function remainingSeconds(session, durationMin) {
  const started = Date.parse(String(session.started_at || '').replace(' ', 'T'));
  const base = Number.isFinite(started) ? started : Date.now();
  const limit = Number(durationMin || 180) * 60 * 1000;
  const elapsed = Number(session.duration_ms || 0);
  const left = Math.max(0, Math.round((limit - Math.max(Date.now() - base, elapsed)) / 1000));
  return left;
}

// 150 分制得分：客观题按卷面分值，主观题按自评得分（0~卷面分）
// 分大题统计按整卷题目算分母（未作答计 0 分），这样每题的满分就是该大题的卷面满分
function examScore(userId, sessionId) {
  const info = sessionExam(userId, sessionId);
  if (!info) throw new Error('练习记录不存在或已失效');
  const { paper } = info;
  const items = paperItems(paper.source_exam_id).filter((x) => !x.dup_of);
  const attempts = q.all('SELECT source_id, correct, score FROM quiz_attempts WHERE user_id=? AND session_id=?',
    userId, sessionId);
  const attemptMap = new Map(attempts.map((a) => [a.source_id, a]));

  let total = 0;
  const sections = new Map();
  for (const item of items) {
    const full = Number(item.score || 0);
    const attempt = attemptMap.get(item.source_id);
    let got = 0;
    if (attempt) {
      if (attempt.correct === 1) got = full;
      const manual = Number(attempt.score);
      if (Number.isFinite(manual) && attempt.score !== null && manual > 0) {
        got = Math.max(0, Math.min(full, manual));
      }
    }
    total += got;
    const key = item.section || '未分节';
    const bucket = sections.get(key) || { name: key, score: 0, full: 0, total: 0, answered: 0 };
    bucket.score += got;
    bucket.full += full;
    bucket.total += 1;
    if (attempt) bucket.answered += 1;
    sections.set(key, bucket);
  }
  return {
    total: Math.round(total * 10) / 10,
    sections: [...sections.values()].map((x) => ({
      ...x, score: Math.round(x.score * 10) / 10, full: Math.round(x.full * 10) / 10
    }))
  };
}

// 练习页顶部展示的考试信息
function examState(userId, sessionId) {
  const info = sessionExam(userId, sessionId);
  if (!info) return null;
  const { paper, session, filters } = info;
  const durationMin = Number(filters.durationMin || paper.duration_min || 180);
  return {
    paper: examMeta(paper),
    remainingSeconds: session.status === 'active' ? remainingSeconds(session, durationMin) : 0,
    durationMin,
    elapsedMs: Number(session.duration_ms || 0),
    status: session.status
  };
}

// 考完的真题报告：总分 / 分大题 / 分科目
function examReport(userId, sessionId) {
  const info = sessionExam(userId, sessionId);
  if (!info) return null;
  const { paper } = info;
  const base = quiz.buildReport(userId, q.get('SELECT * FROM quiz_sessions WHERE id=? AND user_id=?', sessionId, userId));
  const score = examScore(userId, sessionId);

  const items = paperItems(paper.source_exam_id);
  const attempted = q.all(`SELECT source_id, correct, score FROM quiz_attempts WHERE user_id=? AND session_id=?`, userId, sessionId);
  const attemptMap = new Map(attempted.map((a) => [a.source_id, a]));

  const subjectBuckets = new Map();
  for (const item of items) {
    const a = attemptMap.get(item.source_id);
    const key = item.subject_key;
    const b = subjectBuckets.get(key) || { subjectKey: key, full: 0, score: 0, total: 0, correct: 0 };
    b.full += Number(item.score || 0);
    b.total += 1;
    if (a && a.correct === 1) { b.correct += 1; }
    if (a) {
      let got = a.correct === 1 ? Number(item.score || 0) : 0;
      if (Number(a.score) > 0) got = Math.max(0, Math.min(Number(item.score || 0), Number(a.score)));
      b.score += got;
    }
    subjectBuckets.set(key, b);
  }

  return {
    ...base,
    exam: examMeta(paper),
    score: score.total,
    fullScore: paper.total_score || 150,
    sections: score.sections,
    subjects: [...subjectBuckets.values()].map((b) => ({
      ...b,
      score: Math.round(b.score * 10) / 10,
      accuracy: b.total ? Math.round((b.correct / b.total) * 100) : null
    }))
  };
}

module.exports = {
  MODE, tableReady, listPapers, createExamSession, examState, examReport, examScore, paperItems, examMeta
};
