'use strict';
// ============================================================
//  历年真题同步：把研岛的 408 真题卷（年份 + 题目顺序 + 大题分节）落到本地
//  - 复用题库同步的题目表，只建“卷子 -> 题目”的引用关系
//  - 综合应用题源站未给出真实分值，这里按 70 分在 7 道大题间均分（10 分/题），
//    界面上标注为“参考分值”，真实考场分值请以当年试卷为准
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const src = require('../lib/question-source');

const DB_FILE = process.env.KY_DB || path.join(__dirname, '..', 'data', 'kaoyan.db');
const SINGLE_SCORE = 2;
const COMPOSITE_TOTAL = 70;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_papers (
      source_exam_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      year INTEGER,
      duration_min INTEGER DEFAULT 180,
      total_score INTEGER DEFAULT 150,
      question_count INTEGER DEFAULT 0,
      sections_json TEXT NOT NULL DEFAULT '[]',
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS exam_items (
      source_exam_id INTEGER NOT NULL,
      order_no INTEGER NOT NULL,
      section TEXT,
      score REAL DEFAULT 2,
      source_id INTEGER NOT NULL,
      PRIMARY KEY (source_exam_id, order_no)
    );
    CREATE INDEX IF NOT EXISTS idx_exam_items_source ON exam_items (source_id);
  `);

  const exams = (await src.fetchExams({ category: '408' }))
    .filter((e) => /408/.test(e.title) && e.year);
  console.log('上游 408 真题卷:', exams.length, exams.map((e) => e.year).join(','));

  const insertPaper = db.prepare(`
    INSERT INTO exam_papers (source_exam_id,title,year,duration_min,total_score,question_count,sections_json,synced_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(source_exam_id) DO UPDATE SET
      title=excluded.title, year=excluded.year, duration_min=excluded.duration_min,
      total_score=excluded.total_score, question_count=excluded.question_count,
      sections_json=excluded.sections_json, synced_at=excluded.synced_at
  `);
  const insertItem = db.prepare(`
    INSERT INTO exam_items (source_exam_id,order_no,section,score,source_id)
    VALUES (?,?,?,?,?)
    ON CONFLICT(source_exam_id,order_no) DO UPDATE SET
      section=excluded.section, score=excluded.score, source_id=excluded.source_id
  `);
  const hasQuestion = db.prepare('SELECT 1 x FROM qb_questions WHERE source_id=?');

  let papers = 0;
  let items = 0;
  for (const meta of exams) {
    let detail;
    try {
      detail = await src.fetchExamDetail(meta.id);
    } catch (error) {
      console.warn(`  跳过真题 ${meta.id}: ${error.message}`);
      continue;
    }
    const list = Array.isArray(detail.questions) ? detail.questions.slice() : [];
    list.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

    const compositeCount = list.filter((x) => String(x.section || '').includes('综合')).length;
    const compositeScore = compositeCount > 0 ? Math.round((COMPOSITE_TOTAL / compositeCount) * 10) / 10 : 0;
    const sections = new Map();

    const rows = [];
    for (const item of list) {
      const questionId = Number(item.questionId || (item.question && item.question.id));
      if (!Number.isInteger(questionId)) continue;
      if (!hasQuestion.get(questionId)) {
        console.warn(`  真题 ${meta.year} 第 ${item.order} 题(${questionId}) 不在题库，跳过`);
        continue;
      }
      const sectionName = String(item.section || '');
      const isComposite = sectionName.includes('综合');
      const score = isComposite ? compositeScore : SINGLE_SCORE;
      rows.push({ order: Number(item.order || rows.length + 1), section: sectionName, score, questionId });
      const bucket = sections.get(sectionName) || { name: sectionName, count: 0, score: 0 };
      bucket.count += 1;
      bucket.score += score;
      sections.set(sectionName, bucket);
    }
    if (!rows.length) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      insertPaper.run(
        meta.id, meta.title, meta.year, meta.duration || 180, meta.totalScore || 150,
        rows.length, JSON.stringify([...sections.values()]), new Date().toISOString()
      );
      db.prepare('DELETE FROM exam_items WHERE source_exam_id=?').run(meta.id);
      for (const row of rows) insertItem.run(meta.id, row.order, row.section, row.score, row.questionId);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    papers += 1;
    items += rows.length;
    console.log(`  ${meta.year} ${meta.title}: ${rows.length} 题（综合题 ${compositeCount} 道，每题 ${compositeScore} 分）`);
    await sleep(150);
  }

  console.log(`真题同步完成：${papers} 套 / ${items} 题`);
  db.close();
}

main().catch((e) => { console.error('真题同步失败:', e.stack || e.message); process.exitCode = 1; });
