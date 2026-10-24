'use strict';

// 408 公开题库接口与题目字段映射。
// 这里只处理“源数据 -> qb_questions 行”的转换，不负责建表和落库。

const API_BASE = 'https://api.408dao.com/api';
const WEB_BASE = 'https://www.408dao.com';
// list 模式的分页由 limit 控制，接口实际上限为 20。
const PAGE_SIZE = 20;
const LIST_SORT = 'created_desc';
const REQUEST_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 45000;

const SUBJECTS = [
  { key: 'ds', rootId: 1, name: '数据结构' },
  { key: 'co', rootId: 2, name: '计算机组成原理' },
  { key: 'os', rootId: 3, name: '操作系统' },
  { key: 'cn', rootId: 4, name: '计算机网络' },
];

const SUBJECT_BY_KEY = new Map(SUBJECTS.map((item) => [item.key, item]));
const SUBJECT_BY_ROOT = new Map(SUBJECTS.map((item) => [item.rootId, item]));
const KNOWN_TYPES = new Set(['SINGLE', 'MULTIPLE', 'JUDGE', 'FILL', 'SHORT', 'COMPOSITE']);
const CHOICE_TYPES = new Set(['SINGLE', 'MULTIPLE', 'JUDGE']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label}必须是正整数`);
  }
  return number;
}

function normalizeSubjects(value) {
  if (value === undefined || value === null || value === '') {
    return SUBJECTS.map((item) => item.key);
  }

  const requested = Array.isArray(value)
    ? value
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);

  if (requested.length === 0) {
    throw new Error('--subjects 至少需要一个科目');
  }

  const unique = [...new Set(requested)];
  const invalid = unique.filter((key) => !SUBJECT_BY_KEY.has(key));
  if (invalid.length > 0) {
    throw new Error(`未知科目: ${invalid.join(', ')}；可选值: ${SUBJECTS.map((item) => item.key).join(',')}`);
  }

  return SUBJECTS.filter((item) => unique.includes(item.key)).map((item) => item.key);
}

function normalizeType(type) {
  const value = String(type || '').trim().toUpperCase();
  return KNOWN_TYPES.has(value) ? value : value || 'SINGLE';
}

function normalizeDifficulty(difficulty) {
  return String(difficulty || '').trim().toUpperCase() || 'UNKNOWN';
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function letterForIndex(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sortOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option, index) => ({
      content: option && option.content != null ? String(option.content) : '',
      isCorrect: Boolean(option && option.isCorrect),
      displayOrder: Number.isFinite(Number(option && option.displayOrder))
        ? Number(option.displayOrder)
        : index,
      originalIndex: index,
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder || a.originalIndex - b.originalIndex);
}

function choiceAnswerLetters(options) {
  const sorted = sortOptions(options);
  return sorted
    .map((option, index) => ({ option, letter: letterForIndex(index) }))
    .filter((item) => item.option.isCorrect)
    .map((item) => item.letter);
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s*\{[^}]*width[^}]*\}\s*$/gim, '')
    .replace(/\n+[-*_]{3,}\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从 explanation 的“## 正确答案”段落抽取答案，最多保留 2000 字符。
 * COMPOSITE、FILL、SHORT 题使用这个结果。
 */
function extractAnswerFromExplanation(explanation) {
  const text = String(explanation || '');
  if (!text.trim()) return null;

  const heading = /(?:^|\n)(#{1,6})[ \t]*正确答案[ \t]*(?=\r?\n|$)/m;
  const match = heading.exec(text);
  let section = text;

  if (match) {
    const start = match.index + match[0].length;
    section = text.slice(start);
    const headingLevel = match[1].length;
    const nextHeading = new RegExp(
      `(?:^|\\n)#{1,${headingLevel}}[ \\t]+\\S[^\\n]*(?=\\r?\\n|$)`,
    ).exec(section);
    if (nextHeading) {
      section = section.slice(0, nextHeading.index);
    }
  }

  const answer = stripMarkdown(section).slice(0, 2000);
  return answer || null;
}

function buildAnswerText(question) {
  const type = normalizeType(question && question.type);
  if (CHOICE_TYPES.has(type)) {
    const letters = choiceAnswerLetters(question && question.options);
    if (letters.length > 0) {
      return type === 'MULTIPLE' ? letters.join('、') : letters.join('');
    }
  }
  return extractAnswerFromExplanation(question && question.explanation);
}

function normalizeOptions(options) {
  return sortOptions(options)
    .filter((option) => option.content.trim() || option.isCorrect)
    .map((option) => ({
      content: option.content,
      isCorrect: option.isCorrect,
      displayOrder: option.displayOrder,
    }));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((item) => (item && item.tag ? item.tag.name : item && item.name))
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim());
}

function buildCategoryIndex(categories) {
  const index = new Map();
  if (!Array.isArray(categories)) return index;
  for (const category of categories) {
    if (category && Number.isInteger(Number(category.id))) {
      index.set(Number(category.id), category);
    }
  }
  return index;
}

function readQuestionCategories(question, categoryIndex = new Map()) {
  const values = Array.isArray(question && question.categories) ? question.categories : [];
  const categories = [];

  for (const value of values) {
    const category = value && value.category ? value.category : value;
    if (category && category.id != null) {
      const resolved = categoryIndex.get(Number(category.id)) || category;
      categories.push(resolved);
    }
  }

  return categories;
}

function mapCategoryFields(question, subject, categoryIndex) {
  const categories = readQuestionCategories(question, categoryIndex);
  const rootId = subject ? subject.rootId : null;
  const root = categories.find((category) => Number(category.id) === Number(rootId))
    || categories.find((category) => Number(category.depth) === 0);
  const chapter = categories.find((category) => Number(category.parentId) === Number(root && root.id))
    || categories.find((category) => Number(category.depth) === 1);
  const section = categories.find((category) => Number(category.parentId) === Number(chapter && chapter.id))
    || categories.find((category) => Number(category.depth) === 2);

  let subjectKey = subject ? subject.key : null;
  let sourceCategoryId = subject ? subject.rootId : null;

  if (!subjectKey && root && SUBJECT_BY_ROOT.has(Number(root.id))) {
    const inferred = SUBJECT_BY_ROOT.get(Number(root.id));
    subjectKey = inferred.key;
    sourceCategoryId = inferred.rootId;
  }

  return {
    subjectKey,
    sourceCategoryId,
    chapterId: chapter ? toInteger(chapter.id, null) : null,
    chapterName: chapter && chapter.name ? String(chapter.name) : null,
    sectionName: section && section.name ? String(section.name) : null,
  };
}

function buildSourceUrl(question) {
  if (!question || question.id == null) return null;
  const id = encodeURIComponent(String(question.id));
  const slug = question.slug ? encodeURIComponent(String(question.slug)) : '';
  return `${WEB_BASE}/questions/${id}/${slug}`;
}

function toQuestionRow(question, subject, options = {}) {
  if (!question || question.id == null) {
    throw new Error('题目缺少 id');
  }

  const sourceId = toInteger(question.id, null);
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error(`题目 id 非法: ${question.id}`);
  }

  const categoryIndex = options.categoryIndex || new Map();
  const syncedAt = options.syncedAt || new Date().toISOString();
  const mapped = mapCategoryFields(question, subject, categoryIndex);

  if (!mapped.subjectKey) {
    throw new Error(`题目 ${question.id} 无法识别所属科目`);
  }

  return {
    source_id: sourceId,
    subject_key: mapped.subjectKey,
    source_category_id: mapped.sourceCategoryId,
    chapter_id: mapped.chapterId,
    chapter_name: mapped.chapterName,
    section_name: mapped.sectionName,
    title: question.title != null ? String(question.title) : '',
    content: question.content != null ? String(question.content) : '',
    type: normalizeType(question.type),
    difficulty: normalizeDifficulty(question.difficulty),
    options_json: JSON.stringify(normalizeOptions(question.options)),
    answer_text: buildAnswerText(question),
    explanation: question.explanation != null ? String(question.explanation) : '',
    tags_json: JSON.stringify(normalizeTags(question.tags)),
    correct_count: toInteger(question.correctCount, 0),
    answer_count: toInteger(question.answerCount, 0),
    source_url: buildSourceUrl(question),
    source_updated_at: question.updatedAt != null ? String(question.updatedAt) : null,
    synced_at: syncedAt,
  };
}

async function requestJson(url, label) {
  let lastError;

  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const payload = await response.json();
      if (!payload || payload.code !== 0) {
        throw new Error(`接口返回 code=${payload && payload.code} ${payload && payload.msg ? `(${payload.msg})` : ''}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        await sleep(500 * 2 ** attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`${label}失败（已重试 ${REQUEST_RETRIES} 次）: ${lastError && lastError.message ? lastError.message : lastError}`);
}

async function fetchCategories() {
  const payload = await requestJson(`${API_BASE}/categories?flat=true`, '获取分类');
  if (!Array.isArray(payload.data)) {
    throw new Error('分类接口 data 不是数组');
  }
  return payload.data;
}

async function fetchQuestionsPage(rootId, page, pageSize = PAGE_SIZE) {
  const subject = SUBJECT_BY_ROOT.get(Number(rootId));
  if (!subject) throw new Error(`未知根分类 id: ${rootId}`);

  const query = new URLSearchParams({
    categoryId: String(rootId),
    page: String(page),
    limit: String(pageSize),
    list: 'true',
    sortBy: LIST_SORT,
  });
  const url = `${API_BASE}/questions?${query.toString()}`;
  const payload = await requestJson(url, `获取题目 ${subject.key} 第 ${page} 页`);
  const data = payload.data;

  if (!data || !data.pagination || !Array.isArray(data.questions)) {
    throw new Error(`题目接口 ${subject.key} 第 ${page} 页结构异常`);
  }

  return {
    pagination: {
      page: toInteger(data.pagination.page, page),
      pageSize: toInteger(data.pagination.pageSize, pageSize),
      total: toInteger(data.pagination.total, 0),
      totalPages: toInteger(data.pagination.totalPages, 0),
    },
    questions: data.questions,
    url,
  };
}

async function fetchQuestionDetail(question) {
  if (!question || question.id == null) {
    throw new Error('题目缺少 id，无法获取详情');
  }
  const type = normalizeType(question.type);
  const id = encodeURIComponent(String(question.id));
  const encodedType = encodeURIComponent(type);
  const url = `${API_BASE}/questions/${id}/${encodedType}`;
  const payload = await requestJson(url, `获取题目 ${question.id} 详情`);

  if (!payload.data || payload.data.id == null) {
    throw new Error(`题目 ${question.id} 详情结构异常`);
  }
  if (Number(payload.data.id) !== Number(question.id)) {
    throw new Error(`题目 ${question.id} 详情返回了错误的 id: ${payload.data.id}`);
  }
  return payload.data;
}

// server 调用入口。延迟 require，避免入口脚本与本模块形成加载期循环依赖。
function syncQuestionBank(options = {}, onProgress = () => {}) {
  return require('../scripts/import-question-bank').syncQuestionBank(options, onProgress);
}

function getSyncState(options = {}) {
  return require('../scripts/import-question-bank').getSyncState(options);
}

module.exports = {
  API_BASE,
  WEB_BASE,
  PAGE_SIZE,
  LIST_SORT,
  REQUEST_RETRIES,
  REQUEST_TIMEOUT_MS,
  SUBJECTS,
  SUBJECT_BY_KEY,
  SUBJECT_BY_ROOT,
  normalizeSubjects,
  normalizeType,
  normalizeDifficulty,
  parsePositiveInteger,
  buildCategoryIndex,
  mapCategoryFields,
  normalizeOptions,
  normalizeTags,
  choiceAnswerLetters,
  extractAnswerFromExplanation,
  buildAnswerText,
  buildSourceUrl,
  toQuestionRow,
  fetchCategories,
  fetchQuestionsPage,
  fetchQuestionDetail,
  syncQuestionBank,
  getSyncState,
};
