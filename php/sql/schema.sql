-- =============================================================================
-- 高考英语短文填空穷举题库 · 数据库结构（SQLite）
--
-- 不需要安装数据库服务，整个库就是一个文件：php/data/english_quiz.db
-- 导入方式：
--   sqlite3 php/data/english_quiz.db < php/sql/schema.sql
-- 或直接启动后端，首次运行会自动建表。
--
-- 备份 = 复制这个 .db 文件
-- =============================================================================

PRAGMA journal_mode = WAL;      -- 读写并发更稳，避免 database is locked
PRAGMA foreign_keys = ON;       -- 启用外键约束（SQLite 默认关闭）

-- ------------------------------------------------------------
-- 用户表
-- role: user | admin，预留扩展（后续可加 guest、teacher 等）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- bcrypt 哈希，绝不存明文
  role          TEXT NOT NULL DEFAULT 'user',   -- user / admin
  display_name  TEXT,
  status        INTEGER NOT NULL DEFAULT 1,      -- 1 正常 0 禁用
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ------------------------------------------------------------
-- 试卷表
-- 一套试卷 = 一行。同一场考试的题目都挂在同一张试卷下，
-- 这样「按卷练习」「整卷做」「按日期看最近的卷」才有落点。
-- source 文本仍保留在 questions 上：它是对外展示的来源描述，
-- paper 才是可管理的实体（可改名、设考试日期、加备注）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS papers (
  id            TEXT PRIMARY KEY,              -- 如 p_0001
  name          TEXT NOT NULL,                 -- 试卷名，同名即同卷
  exam_date     TEXT,                          -- 考试日期 YYYY-MM-DD，可空
  note          TEXT NOT NULL DEFAULT '',      -- 备注
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_name ON papers(name);
CREATE INDEX IF NOT EXISTS idx_papers_date ON papers(exam_date);

-- ------------------------------------------------------------
-- 题库表
-- 题目结构嵌套较深（原句 + 多空 + 答案数组 + 标签数组），用 JSON 文本存
-- id 用题目自身 id，不用自增主键，方便与 practice_records.question_id 对应
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id               TEXT PRIMARY KEY,           -- 如 q_0001
  original_sentence TEXT NOT NULL,            -- 原句，空格用 ______ 表示
  blanks_json      TEXT NOT NULL,             -- JSON 数组：各空配置
  source           TEXT NOT NULL DEFAULT '手动录入',
  paper_id         TEXT,                      -- 所属试卷，可空（未归卷的题）
  schema_version   INTEGER NOT NULL DEFAULT 1,-- 数据结构版本，用于迁移
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_source ON questions(source);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions(created_at);
CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id);

-- ------------------------------------------------------------
-- 标签表（两级结构：parent_id 为 NULL 表示顶级分类）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id        TEXT PRIMARY KEY,               -- 如 t_001
  name      TEXT NOT NULL,
  parent_id TEXT,                            -- NULL 为顶级分类
  color     TEXT NOT NULL DEFAULT '#64748B',
  is_active INTEGER NOT NULL DEFAULT 1      -- 1 启用 0 停用
);

CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
CREATE INDEX IF NOT EXISTS idx_tags_active ON tags(is_active);

-- ------------------------------------------------------------
-- 学习进度表（每人一份，与题库分离）
-- 游客没有 user_id，因此不写入本表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_progress (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'unmastered',  -- unmastered / mastered
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, question_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progress_user ON user_progress(user_id);

-- ------------------------------------------------------------
-- 做题记录
-- 游客不落库，因此 user_id 非空
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS practice_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  question_id  TEXT NOT NULL,
  is_correct   INTEGER NOT NULL,            -- 1 全对 0 有错
  wrong_count  INTEGER NOT NULL DEFAULT 0,
  answers_json TEXT,                          -- 学生各空作答，JSON 数组
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_records_user_time ON practice_records(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_correct ON practice_records(is_correct);

-- ------------------------------------------------------------
-- 试卷收藏（个人私有）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  source     TEXT NOT NULL,                  -- 与 questions.source 对应
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fav_user ON user_favorites(user_id);

-- ------------------------------------------------------------
-- 小题标记（个人私有）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_marks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '重点',   -- 重点 / 难点 / 考点回顾
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, question_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mark_user ON user_marks(user_id);

-- ------------------------------------------------------------
-- 服务端会话（退出登录即删除）
-- token: 随机串，前端存 localStorage
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token      TEXT NOT NULL UNIQUE,           -- crypto.randomBytes(32) 十六进制
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ------------------------------------------------------------
-- 系统配置表（预留）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_config (
  config_key   TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- 初始管理员：admin / 123456（仅首次建库时写入；已有库不受影响，改密码请用后台功能）
-- 这里用 INSERT OR IGNORE：已存在同名账号时不覆盖，也不影响其他数据。
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO users (username, password_hash, role, display_name)
VALUES (
  'admin',
  '$2a$10$jaY/wlfX54G.Hey2WvqjyuVSE2LdUygBEBxIQG99YRp8ldy.mMeWu',
  'admin',
  '系统管理员'
);
