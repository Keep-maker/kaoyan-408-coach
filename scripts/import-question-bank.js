'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  PAGE_SIZE,
  SUBJECTS,
  SUBJECT_BY_KEY,
  normalizeSubjects,
  parsePositiveInteger,
  buildCategoryIndex,
  toQuestionRow,
  fetchCategories,
  fetchQuestionsPage,
  fetchQuestionDetail,
} = require('../lib/question-source');

const DEFAULT_DB_FILE = path.join(__dirname, '..', 'data', 'kaoyan.db');
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const DETAIL_BATCH_SIZE = 50;

const QUESTION_COLUMNS = [
  'source_id',
  'subject_key',
  'source_category_id',
  'chapter_id',
  'chapter_name',
  'section_name',
  'title',
  'content',
  'type',
  'difficulty',
  'options_json',
  'answer_text',
  'explanation',
  'tags_json',
  'correct_count',
  'answer_count',
  'source_url',
  'source_updated_at',
  'synced_at',
];

const MIGRATION_COLUMNS = {
  id: 'INTEGER',
  source_id: 'INTEGER',
  subject_key: 'TEXT',
  source_category_id: 'INTEGER',
  chapter_id: 'INTEGER',
  chapter_name: 'TEXT',
  section_name: 'TEXT',
  title: 'TEXT',
  content: 'TEXT',
  type: 'TEXT',
  difficulty: 'TEXT',
  options_json: 'TEXT',
  answer_text: 'TEXT',
  explanation: 'TEXT',
  tags_json: 'TEXT',
  correct_count: 'INTEGER',
  answer_count: 'INTEGER',
  source_url: 'TEXT',
  source_updated_at: 'TEXT',
  synced_at: 'TEXT',
};

function buildUpsertSql(whereClause = '') {
  const updateColumns = QUESTION_COLUMNS
    .filter((column) => column !== 'source_id')
    .map((column) => `${column}=excluded.${column}`)
    .join(', ');
  const placeholders = QUESTION_COLUMNS.map(() => '?').join(', ');
  const suffix = whereClause ? ` WHERE ${whereClause}` : '';

  return `
    INSERT INTO qb_questions (${QUESTION_COLUMNS.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(source_id) DO UPDATE SET ${updateColumns}${suffix}
  `;
}

const UPSERT_SQL_FORCE = buildUpsertSql();
const UPSERT_SQL_SMART = buildUpsertSql(`
  excluded.source_updated_at IS NOT NULL
  AND (
    qb_questions.source_updated_at IS NULL
    OR qb_questions.source_updated_at <> excluded.source_updated_at
  )
`);

function resolveDbPath(options = {}) {
  const value = options.dbPath || process.env.KY_DB || DEFAULT_DB_FILE;
  if (value === ':memory:' || String(value).startsWith('file:')) return value;
  return path.resolve(String(value));
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qb_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL UNIQUE,
      subject_key TEXT NOT NULL,
      source_category_id INTEGER,
      chapter_id INTEGER,
      chapter_name TEXT,
      section_name TEXT,
      title TEXT,
      content TEXT,
      type TEXT,
      difficulty TEXT,
      options_json TEXT NOT NULL DEFAULT '[]',
      answer_text TEXT,
      explanation TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      correct_count INTEGER NOT NULL DEFAULT 0,
      answer_count INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      source_updated_at TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qb_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  const existing = new Set(
    db.prepare('PRAGMA table_info(qb_questions)').all().map((column) => column.name),
  );
  for (const [column, type] of Object.entries(MIGRATION_COLUMNS)) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE qb_questions ADD COLUMN ${column} ${type}`);
    }
  }

  const metaColumns = new Set(
    db.prepare('PRAGMA table_info(qb_sync_meta)').all().map((column) => column.name),
  );
  if (!metaColumns.has('key')) db.exec('ALTER TABLE qb_sync_meta ADD COLUMN key TEXT');
  if (!metaColumns.has('value')) db.exec('ALTER TABLE qb_sync_meta ADD COLUMN value TEXT');
  if (!metaColumns.has('updated_at')) db.exec('ALTER TABLE qb_sync_meta ADD COLUMN updated_at TEXT');

  if (!hasUniqueSourceIdIndex(db)) {
    try {
      db.exec('CREATE UNIQUE INDEX ux_qb_questions_source_id ON qb_questions(source_id)');
    } catch (error) {
      throw new Error(`qb_questions.source_id 无法建立唯一索引，请先清理重复数据: ${error.message}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_qb_questions_subject
      ON qb_questions(subject_key);
    CREATE INDEX IF NOT EXISTS idx_qb_questions_chapter
      ON qb_questions(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_qb_questions_type
      ON qb_questions(type);
    CREATE INDEX IF NOT EXISTS idx_qb_questions_difficulty
      ON qb_questions(difficulty);
  `);
}

function hasUniqueSourceIdIndex(db) {
  const indexes = db.prepare('PRAGMA index_list(qb_questions)').all();
  for (const index of indexes) {
    if (!index.unique) continue;
    const safeName = String(index.name).replace(/'/g, "''");
    const columns = db.prepare(`PRAGMA index_info('${safeName}')`).all();
    if (columns.length === 1 && columns[0].name === 'source_id') return true;
  }
  return false;
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:' && !String(dbPath).startsWith('file:')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  ensureSchema(db);
  return db;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // 保留原始异常。
    }
    throw error;
  }
}

function setMeta(db, key, value, now = new Date().toISOString()) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(`
    INSERT INTO qb_sync_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,
      updated_at=excluded.updated_at
  `).run(key, text, now);
}

function parseStoredValue(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value;
  try {
    return JSON.parse(text);
  } catch (_) {
    return value;
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(concurrency, items.length);

  const runners = Array.from({ length: workerCount }, async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
        return;
      }
    }
  });

  await Promise.allSettled(runners);
  if (firstError) throw firstError;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (number === 0) return null;
  return parsePositiveInteger(value, '--limit-per-subject');
}

function normalizeConcurrency(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CONCURRENCY;
  const number = parsePositiveInteger(value, '--concurrency');
  if (number > MAX_CONCURRENCY) {
    throw new Error(`--concurrency 不能超过 ${MAX_CONCURRENCY}`);
  }
  return number;
}

function createSubjectState(subject, firstPage, limit) {
  const pagination = firstPage.pagination;
  const pageSize = pagination.pageSize > 0 ? pagination.pageSize : PAGE_SIZE;
  const totalPages = pagination.totalPages > 0
    ? pagination.totalPages
    : Math.max(1, Math.ceil(pagination.total / pageSize));
  const target = limit ? Math.min(limit, pagination.total) : pagination.total;
  const pagesPlanned = target > 0
    ? Math.min(totalPages, Math.ceil(target / pageSize))
    : 0;

  return {
    key: subject.key,
    name: subject.name,
    rootId: subject.rootId,
    totalAvailable: pagination.total,
    target,
    pageSize,
    pagesPlanned,
    pagesFetched: 0,
    listDownloaded: 0,
    downloaded: 0,
    processed: 0,
    upserted: 0,
    unchanged: 0,
    invalid: 0,
    duplicates: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function rowsForPage(state, pageNumber) {
  if (!state.target) return 0;
  return Math.max(0, Math.min(state.pageSize, state.target - (pageNumber - 1) * state.pageSize));
}

function processDetailBatch(db, statement, state, listItems, details, context) {
  const before = {
    upserted: state.upserted,
    unchanged: state.unchanged,
    invalid: state.invalid,
    duplicates: state.duplicates,
  };

  transaction(db, () => {
    for (let index = 0; index < details.length; index += 1) {
      const listItem = listItems[index] || {};
      const detail = details[index] || {};
      const question = {
        ...listItem,
        ...detail,
        categories: Array.isArray(detail.categories) && detail.categories.length > 0
          ? detail.categories
          : listItem.categories,
        options: detail.options !== undefined ? detail.options : listItem.options,
      };
      let row;
      try {
        row = toQuestionRow(question, SUBJECT_BY_KEY.get(state.key), {
          categoryIndex: context.categoryIndex,
          syncedAt: context.syncedAt,
        });
      } catch (error) {
        state.invalid += 1;
        if (context.errors.length < 5) {
          context.errors.push(`题目 ${listItem.id || '?'}: ${error.message}`);
        }
        continue;
      }

      if (!Number.isInteger(row.source_id) || row.source_id <= 0) {
        state.invalid += 1;
        if (context.errors.length < 5) {
          context.errors.push(`题目 ${listItem.id || '?'}: source_id 非法`);
        }
        continue;
      }

      if (context.seenSourceIds.has(row.source_id)) {
        state.duplicates += 1;
        continue;
      }

      try {
        const result = statement.run(...QUESTION_COLUMNS.map((column) => row[column] ?? null));
        const changes = Number(result.changes || 0);
        if (changes > 0) state.upserted += 1;
        else state.unchanged += 1;
        state.processed += 1;
        context.seenSourceIds.add(row.source_id);
      } catch (error) {
        state.invalid += 1;
        if (context.errors.length < 5) {
          context.errors.push(`题目 ${row.source_id}: ${error.message}`);
        }
      }
    }
  });

  state.downloaded += details.length;
  context.onProgress({
    type: 'detail-progress',
    subject: state.key,
    downloaded: state.downloaded,
    processed: state.processed,
    target: state.target,
    batchUpserted: state.upserted - before.upserted,
    batchUnchanged: state.unchanged - before.unchanged,
    batchInvalid: state.invalid - before.invalid,
    batchDuplicates: state.duplicates - before.duplicates,
  });
}

function summarizeTotals(states) {
  return states.reduce((total, state) => {
    total.available += state.totalAvailable;
    total.target += state.target;
    total.pages += state.pagesFetched;
    total.listed += state.listDownloaded;
    total.downloaded += state.downloaded;
    total.processed += state.processed;
    total.upserted += state.upserted;
    total.unchanged += state.unchanged;
    total.invalid += state.invalid;
    total.duplicates += state.duplicates;
    return total;
  }, {
    available: 0,
    target: 0,
    pages: 0,
    listed: 0,
    downloaded: 0,
    processed: 0,
    upserted: 0,
    unchanged: 0,
    invalid: 0,
    duplicates: 0,
  });
}

/**
 * 同步 408 题库。
 * @param {object} options
 * @param {string|string[]} options.subjects ds/co/os/cn，默认全部
 * @param {number} options.limitPerSubject 每科最多题数，默认不限
 * @param {number} options.concurrency 请求并发数，默认 4
 * @param {boolean} options.force 强制覆盖更新，即使 source_updated_at 未变
 * @param {string} options.dbPath 可选数据库路径，优先级高于 KY_DB
 * @param {(event: object) => void} onProgress 进度回调
 */
async function syncQuestionBank(options = {}, onProgress = () => {}) {
  const subjectKeys = normalizeSubjects(options.subjects);
  const limit = normalizeLimit(options.limitPerSubject);
  const concurrency = normalizeConcurrency(options.concurrency);
  const force = Boolean(options.force);
  const dbPath = resolveDbPath(options);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const syncedAt = startedAt;
  let db;
  let stats;

  onProgress({
    type: 'start',
    dbPath,
    subjects: subjectKeys,
    limit,
    concurrency,
    force,
  });

  try {
    db = openDatabase(dbPath);
    const categories = await fetchCategories();
    const categoryIndex = buildCategoryIndex(categories);
    const syncErrors = [];
    onProgress({ type: 'categories', count: categories.length });

    const selectedSubjects = subjectKeys.map((key) => SUBJECT_BY_KEY.get(key));
    const firstPages = new Map();

    await runWithConcurrency(selectedSubjects, concurrency, async (subject) => {
      const pageData = await fetchQuestionsPage(subject.rootId, 1);
      firstPages.set(subject.key, pageData);
    });

    const states = selectedSubjects.map((subject) => {
      const state = createSubjectState(subject, firstPages.get(subject.key), limit);
      onProgress({
        type: 'subject-start',
        subject: state.key,
        name: state.name,
        available: state.totalAvailable,
        target: state.target,
        pages: state.pagesPlanned,
      });
      return state;
    });

    const stateByKey = new Map(states.map((state) => [state.key, state]));
    const listedPagesBySubject = new Map(
      states.map((state) => [state.key, new Map()]),
    );

    const storeListPage = (state, pageNumber, pageData) => {
      const rowsToTake = rowsForPage(state, pageNumber);
      const questions = rowsToTake > 0 ? pageData.questions.slice(0, rowsToTake) : [];
      listedPagesBySubject.get(state.key).set(pageNumber, questions);
      state.pagesFetched += 1;
      state.listDownloaded += pageData.questions.length;
      onProgress({
        type: 'list-page',
        subject: state.key,
        page: pageNumber,
        pages: state.pagesPlanned,
        listed: state.listDownloaded,
        target: state.target,
      });
    };

    for (const subject of selectedSubjects) {
      const state = stateByKey.get(subject.key);
      if (state.pagesPlanned > 0) {
        storeListPage(state, 1, firstPages.get(subject.key));
      }
    }

    const remainingPages = [];
    for (const subject of selectedSubjects) {
      const state = stateByKey.get(subject.key);
      for (let page = 2; page <= state.pagesPlanned; page += 1) {
        remainingPages.push({ subject, page });
      }
    }

    await runWithConcurrency(remainingPages, concurrency, async (task) => {
      const state = stateByKey.get(task.subject.key);
      const pageData = await fetchQuestionsPage(task.subject.rootId, task.page);
      if (pageData.questions.length === 0 && task.page <= state.pagesPlanned) {
        throw new Error(`[${task.subject.key}] 第 ${task.page} 页意外为空，停止同步以免漏题`);
      }
      storeListPage(state, task.page, pageData);
    });

    const listedBySubject = new Map();
    for (const state of states) {
      const pageMap = listedPagesBySubject.get(state.key);
      const seen = new Set();
      const unique = [];
      for (const pageNumber of [...pageMap.keys()].sort((a, b) => a - b)) {
        for (const item of pageMap.get(pageNumber) || []) {
          const sourceId = item && Number(item.id);
          if (!Number.isInteger(sourceId) || sourceId <= 0) {
            state.invalid += 1;
            if (syncErrors.length < 5) {
              syncErrors.push(`[${state.key}] 列表题缺少有效 id`);
            }
            continue;
          }
          if (seen.has(sourceId)) {
            state.duplicates += 1;
            continue;
          }
          seen.add(sourceId);
          unique.push(item);
        }
      }

      const missing = state.target - unique.length;
      const tolerated = Math.max(5, Math.ceil(state.target * 0.005));
      if (!limit && missing > tolerated) {
        throw new Error(
          `[${state.key}] 列表仅取得 ${unique.length}/${state.target} 题，停止同步以免把不完整结果标记为全量`,
        );
      }
      if (!limit && missing > 0) {
        syncErrors.push(
          `[${state.key}] 列表去重后少 ${missing} 题（允许范围内的分页重复/并发更新）`,
        );
      }

      const selectedItems = unique;
      listedBySubject.set(state.key, selectedItems);
      onProgress({
        type: 'details-start',
        subject: state.key,
        details: selectedItems.length,
      });
    }

    const statement = db.prepare(force ? UPSERT_SQL_FORCE : UPSERT_SQL_SMART);
    const context = {
      categoryIndex,
      syncedAt,
      seenSourceIds: new Set(),
      errors: syncErrors,
      onProgress,
    };
    const detailBatches = [];

    for (const state of states) {
      const items = listedBySubject.get(state.key) || [];
      for (let index = 0; index < items.length; index += DETAIL_BATCH_SIZE) {
        detailBatches.push({
          state,
          items: items.slice(index, index + DETAIL_BATCH_SIZE),
        });
      }
    }

    const detailStartedAt = Date.now();
    console.log(`[同步] 列表阶段完成，共 ${detailBatches.reduce((n, b) => n + b.items.length, 0)} 道题待取详情`);

    await runWithConcurrency(detailBatches, concurrency, async (batch) => {
      const details = [];
      for (const listItem of batch.items) {
        details.push(await fetchQuestionDetail(listItem));
      }
      processDetailBatch(db, statement, batch.state, batch.items, details, context);
    });

    const invalidCount = states.reduce((count, state) => count + state.invalid, 0);
    if (invalidCount > 0) {
      throw new Error(
        `有 ${invalidCount} 道题处理失败，未标记同步完成`
        + (syncErrors.length > 0 ? `；${syncErrors.join(' | ')}` : ''),
      );
    }

    for (const state of states) {
      state.finishedAt = new Date().toISOString();
      onProgress({
        type: 'subject-done',
        subject: state.key,
        name: state.name,
        target: state.target,
        listDownloaded: state.listDownloaded,
        downloaded: state.downloaded,
        processed: state.processed,
        upserted: state.upserted,
        unchanged: state.unchanged,
        invalid: state.invalid,
        duplicates: state.duplicates,
      });
    }

    const finishedAt = new Date().toISOString();
    console.log(`[同步] 详情阶段完成，耗时 ${Math.round((Date.now() - detailStartedAt) / 1000)} 秒`);
    const totals = summarizeTotals(states);
    stats = {
      dbPath,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      force,
      limitPerSubject: limit,
      subjects: states,
      totals,
    };

    const isFullSync = !limit && subjectKeys.length === SUBJECTS.length;
    transaction(db, () => {
      for (const state of states) {
        setMeta(db, `subject:${state.key}`, {
          subjectKey: state.key,
          rootId: state.rootId,
          name: state.name,
          available: state.totalAvailable,
          listDownloaded: state.listDownloaded,
          downloaded: state.downloaded,
          processed: state.processed,
          upserted: state.upserted,
          unchanged: state.unchanged,
          invalid: state.invalid,
          duplicates: state.duplicates,
          pages: state.pagesFetched,
          limit,
          syncedAt: finishedAt,
        }, finishedAt);
      }
      setMeta(db, 'last_sync_at', finishedAt, finishedAt);
      setMeta(db, 'last_run', stats, finishedAt);
      db.prepare('DELETE FROM qb_sync_meta WHERE key = ?').run('last_error');
      if (isFullSync) setMeta(db, 'last_full_sync_at', finishedAt, finishedAt);
    });

    onProgress({ type: 'complete', stats });
    return stats;
  } catch (error) {
    if (db) {
      try {
        const at = new Date().toISOString();
        setMeta(db, 'last_error', {
          message: error && error.message ? error.message : String(error),
          at,
        }, at);
      } catch (_) {
        // 记录错误状态失败时不覆盖原始异常。
      }
    }
    throw error;
  } finally {
    if (db) db.close();
  }
}

/**
 * 读取题库同步状态与当前落库统计。
 */
function getSyncState(options = {}) {
  const dbPath = resolveDbPath(options);
  const db = openDatabase(dbPath);

  try {
    const metaRows = db.prepare(`
      SELECT key, value, updated_at
      FROM qb_sync_meta
      ORDER BY key
    `).all();
    const meta = {};
    const subjects = {};

    for (const row of metaRows) {
      const parsed = parseStoredValue(row.value);
      meta[row.key] = {
        value: parsed,
        updatedAt: row.updated_at,
      };
      if (row.key.startsWith('subject:')) {
        subjects[row.key.slice('subject:'.length)] = parsed;
      }
    }

    const countBySubject = db.prepare(`
      SELECT subject_key, COUNT(*) AS count
      FROM qb_questions
      GROUP BY subject_key
      ORDER BY subject_key
    `).all().map((row) => ({
      subjectKey: row.subject_key,
      count: Number(row.count),
    }));

    const countByType = db.prepare(`
      SELECT type, COUNT(*) AS count
      FROM qb_questions
      GROUP BY type
      ORDER BY type
    `).all().map((row) => ({
      type: row.type,
      count: Number(row.count),
    }));

    const totalRow = db.prepare('SELECT COUNT(*) AS count FROM qb_questions').get();

    return {
      dbPath,
      lastSyncAt: meta.last_sync_at ? meta.last_sync_at.value : null,
      lastFullSyncAt: meta.last_full_sync_at ? meta.last_full_sync_at.value : null,
      lastError: meta.last_error ? meta.last_error.value : null,
      lastRun: meta.last_run ? meta.last_run.value : null,
      subjects,
      counts: {
        total: Number(totalRow.count),
        bySubject: countBySubject,
        byType: countByType,
      },
      meta,
    };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }

    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inlineValue = equals >= 0 ? arg.slice(equals + 1) : null;
    const readValue = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      if (index >= argv.length || String(argv[index]).startsWith('--')) {
        throw new Error(`${name} 缺少值`);
      }
      return argv[index];
    };

    if (name === '--subjects') {
      options.subjects = readValue();
    } else if (name === '--limit-per-subject') {
      options.limitPerSubject = readValue();
    } else if (name === '--concurrency') {
      options.concurrency = readValue();
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderProgress(event) {
  if (event.type === 'start') {
    const scope = event.limit ? `每科前 ${event.limit} 题` : '全量';
    console.log(`开始同步题库（${event.subjects.join(',')}，${scope}，并发 ${event.concurrency}，force=${event.force}）`);
    console.log(`数据库: ${event.dbPath}`);
  } else if (event.type === 'categories') {
    console.log(`分类接口加载完成: ${event.count} 条`);
  } else if (event.type === 'subject-start') {
    console.log(`[${event.subject}] ${event.name}: 接口总数 ${event.available}，本次目标 ${event.target}，计划 ${event.pages} 页`);
  } else if (event.type === 'list-page') {
    console.log(
      `[${event.subject}] 第 ${event.page}/${event.pages} 页，`
      + `列表已取得 ${event.listed}/${event.target} 题`,
    );
  } else if (event.type === 'details-start') {
    console.log(`[${event.subject}] 开始获取 ${event.details} 道题详情`);
  } else if (event.type === 'detail-progress') {
    console.log(
      `[${event.subject}] 详情 ${event.downloaded}/${event.target}，`
      + `本批新增或更新 ${event.batchUpserted}，未变 ${event.batchUnchanged}`,
    );
  } else if (event.type === 'subject-done') {
    console.log(
      `[${event.subject}] 完成: 写入/更新 ${event.upserted}，未变 ${event.unchanged}，`
      + `无效 ${event.invalid}，重复 ${event.duplicates}`,
    );
  }
}

function printHelp() {
  console.log(`
408 题库同步器

用法:
  node scripts/import-question-bank.js [选项]

选项:
  --subjects=ds,os          只同步指定科目，默认 ds,co,os,cn
  --limit-per-subject=50    每科最多同步多少题
  --concurrency=4           并发请求数，默认 4
  --force                   即使 source_updated_at 未变也强制覆盖更新
  --help, -h                显示帮助

环境变量:
  KY_DB                     数据库路径，默认 data/kaoyan.db
`.trim());
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  if (cliOptions.help) {
    printHelp();
    return;
  }

  const stats = await syncQuestionBank(cliOptions, renderProgress);
  console.log('');
  console.log(`同步完成，耗时 ${formatDuration(stats.durationMs)}`);
  for (const subject of stats.subjects) {
    console.log(
      `${subject.key} ${subject.name}: 目标 ${subject.target}，下载 ${subject.downloaded}，`
      + `写入/更新 ${subject.upserted}，未变 ${subject.unchanged}，无效 ${subject.invalid}，重复 ${subject.duplicates}`,
    );
  }
  console.log(
    `合计: 目标 ${stats.totals.target}，下载 ${stats.totals.downloaded}，`
    + `写入/更新 ${stats.totals.upserted}，未变 ${stats.totals.unchanged}，`
    + `无效 ${stats.totals.invalid}，重复 ${stats.totals.duplicates}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`同步失败: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  syncQuestionBank,
  getSyncState,
  resolveDbPath,
  ensureSchema,
  openDatabase,
};
