'use strict';
// 增量补题：按“科目”口径抓全部列表，只拉取本地尚未同步的新题详情并入库。
// 源站根分类口径会漏掉部分未分类/多分类题目，用本脚本可补齐差异。
const path = require('node:path');
const { q } = require('../lib/db');
const source = require('../lib/question-source');

const SUBJECTS = source.SUBJECTS.map((subject) => ({
  key: subject.key,
  rootId: subject.rootId,
  name: subject.name
}));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAllListed(rootId) {
  const seen = new Map();
  let page = 1;
  for (;;) {
    const payload = await source.fetchQuestionsPage(rootId, page, 50, { scope: 'subject' });
    const questions = payload.questions || [];
    for (const item of questions) {
      const id = Number(item && item.id);
      if (Number.isInteger(id) && !seen.has(id)) seen.set(id, item);
    }
    if (questions.length < 20 || payload.pagination.page >= payload.pagination.totalPages || page > 400) break;
    page += 1;
    if (page % 5 === 0) console.log(`  ${rootId} 列表页 ${page}/${payload.pagination.totalPages}，唯一 ${seen.size}/${payload.pagination.total}`);
    await sleep(40);
  }
  return { items: [...seen.values()], total: seen.size };
}

async function main() {
  const existing = new Set(
    q.all('SELECT source_id FROM qb_questions').map((row) => row.source_id)
  );
  console.log('当前已有题数:', existing.size);
  const categories = await source.fetchCategories();
  const categoryIndex = source.buildCategoryIndex(categories);
  let added = 0;

  for (const subject of SUBJECTS) {
    const { items } = await fetchAllListed(subject.rootId);
    const missing = items.filter((item) => !existing.has(Number(item.id)));
    console.log(`[${subject.key}] 列表 ${items.length} 题，本地差 ${missing.length} 题`);
    if (!missing.length) continue;

    const columns = [
      'source_id', 'subject_key', 'source_category_id', 'chapter_id', 'chapter_name',
      'section_name', 'title', 'content', 'type', 'difficulty', 'options_json',
      'answer_text', 'explanation', 'tags_json', 'correct_count', 'answer_count',
      'source_url', 'source_updated_at', 'synced_at'
    ];
    const placeholders = columns.map(() => '?').join(',');
    const updates = columns.filter((column) => column !== 'source_id')
      .map((column) => `${column}=excluded.${column}`).join(',');
    const statement = q.db.prepare(
      `INSERT INTO qb_questions (${columns.join(',')}) VALUES (${placeholders})
       ON CONFLICT(source_id) DO UPDATE SET ${updates}`
    );

    for (let index = 0; index < missing.length; index += 20) {
      const batch = missing.slice(index, index + 20);
      for (const item of batch) {
        try {
          const detail = await source.fetchQuestionDetail(item);
          const row = source.toQuestionRow(detail, subject, { categoryIndex });
          statement.run(...columns.map((column) => row[column]));
          existing.add(row.source_id);
          added += 1;
        } catch (error) {
          console.warn(`  跳过 ${item.id}: ${error.message}`);
        }
      }
      console.log(`  ${subject.key} 已补 ${Math.min(index + 20, missing.length)}/${missing.length}`);
      await sleep(80);
    }
  }

  q.run(`INSERT OR REPLACE INTO qb_sync_meta (key, value, updated_at)
    VALUES (?, ?, datetime('now','localtime'))`, 'last_sync_at', new Date().toISOString());
  console.log('入库完成，本次新增:', added);
  console.log('最新题量:', q.get('SELECT COUNT(*) n FROM qb_questions').n);
}

main().catch((error) => {
  console.error('补题失败:', error);
  process.exitCode = 1;
});
