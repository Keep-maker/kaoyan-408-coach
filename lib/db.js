// ============================================================
//  数据层：Node 内置 SQLite（零依赖）
// ============================================================
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.KY_DB || path.join(DATA_DIR, 'kaoyan.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  exam_date TEXT NOT NULL,          -- 考研初试日期
  daily_minutes INTEGER NOT NULL,   -- 每天可投入分钟
  target_score INTEGER DEFAULT 110,
  start_date TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  minutes INTEGER DEFAULT 0,
  mood INTEGER DEFAULT 3,           -- 1-5 状态
  note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  point_id TEXT NOT NULL,           -- 知识点 id
  date TEXT NOT NULL,
  minutes INTEGER DEFAULT 0,
  kind TEXT NOT NULL,               -- study(学习新知识) / review(复习) / quiz(测试)
  correct INTEGER DEFAULT 0,        -- 答对题数
  total INTEGER DEFAULT 0,          -- 总题数
  self_rating INTEGER DEFAULT 0,    -- 自评掌握 1-5
  note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS mastery (
  user_id INTEGER NOT NULL,
  point_id TEXT NOT NULL,
  p REAL DEFAULT 0,                 -- 掌握概率 0-1
  stability REAL DEFAULT 0,         -- 记忆稳定度(天)
  reps INTEGER DEFAULT 0,           -- 累计复习次数
  streak INTEGER DEFAULT 0,         -- 连续答对次数
  attempts INTEGER DEFAULT 0,
  correct INTEGER DEFAULT 0,
  wrong INTEGER DEFAULT 0,
  last_at TEXT,                     -- 最后一次接触时间
  next_review TEXT,                 -- 建议下次复习日期
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, point_id)
);

CREATE TABLE IF NOT EXISTS plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  point_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- new / review / drill
  minutes INTEGER NOT NULL,
  priority INTEGER DEFAULT 0,
  reason TEXT,
  status TEXT DEFAULT 'todo',       -- todo / done / skipped
  UNIQUE(user_id, date, point_id, kind)
);

CREATE TABLE IF NOT EXISTS hot_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at TEXT DEFAULT (datetime('now','localtime')),
  source TEXT,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS advice_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  date TEXT,
  content TEXT,
  engine TEXT,                      -- local / llm
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS agent_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,               -- user / agent
  content TEXT,
  trace TEXT,                       -- JSON：本轮的工具调用轨迹
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS agent_state (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, key)
);

-- 刷题会话：选中题目、答题进度与最终报告
CREATE TABLE IF NOT EXISTS quiz_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  filters_json TEXT,
  question_ids TEXT NOT NULL,
  total INTEGER NOT NULL,
  current_index INTEGER DEFAULT 0,
  answered INTEGER DEFAULT 0,
  correct INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  duration_ms INTEGER DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);

-- 每道题的作答记录；correct = NULL 表示主观题等待自评
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  point_id TEXT,
  subject_key TEXT NOT NULL,
  chapter_name TEXT,
  answer_json TEXT,
  correct INTEGER,
  elapsed_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (user_id, session_id, source_id)
);

-- 题目收藏
CREATE TABLE IF NOT EXISTS quiz_bookmarks (
  user_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_quiz_sessions_user_time
  ON quiz_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_question
  ON quiz_attempts (user_id, source_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_session
  ON quiz_attempts (user_id, session_id, id);
`);

// 会话表：sid -> user_id（访客身份，实现数据隔离）
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  last_seen TEXT
);
`);

const q = {
  get: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
  tx: (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }
};

module.exports = { db, q, DB_FILE };
