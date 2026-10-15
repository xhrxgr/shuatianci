-- =============================================================================
-- English Cloze Question Bank · 数据库结构（SQLite）
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
  kind          TEXT NOT NULL DEFAULT 'original', -- original=录入的真实卷 / generated=蓝图生成的虚拟卷
  blueprint_id  TEXT,                          -- generated 卷的来源蓝图（original 恒为 NULL）
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
  original_sentence TEXT NOT NULL,            -- 原句（挖空后的全文），空格用 ______ 表示
  passage_text     TEXT,                      -- 未挖空的完整原文，可空。短文填空的答案常依赖上下文
                                              --（代词指代/时态呼应/篇章逻辑），只存挖空句等于让学生做单句填空，
                                              -- 与卷面形态不符。同一大题（一篇阅读多个空）录成一道题时填这份全文
  blanks_json      TEXT NOT NULL,             -- JSON 数组：各空配置
  source           TEXT NOT NULL DEFAULT '手动录入',
  paper_id         TEXT,                      -- 所属试卷，可空（未归卷的题）
  schema_version   INTEGER NOT NULL DEFAULT 1,-- 数据结构版本，用于迁移
  fingerprint      TEXT,                      -- 原句归一化指纹，去重与查重用的辅助索引
  publish_status   TEXT NOT NULL DEFAULT 'published', -- 发布状态（刻意不叫 status：那张 user_progress.status 是每人自己的掌握状态，同名会在 JOIN 里产生歧义）
  owner_id         INTEGER,                   -- 录入人，可空（系统导入/种子）
  content_hash     TEXT,                      -- 内容摘要，用于判断内容是否真的变了
  blank_count      INTEGER,                   -- 空格数的索引副本（抽取 SQL 直接用它比较，避免 json_array_length 全表解析）
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_source ON questions(source);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions(created_at);
CREATE INDEX IF NOT EXISTS idx_questions_fingerprint ON questions(fingerprint);
CREATE INDEX IF NOT EXISTS idx_questions_publish ON questions(publish_status);
-- idx_questions_paper 不在这里建：老库的 questions 表还没有 paper_id 列，
-- 对不存在的列建索引会直接报错。它由 app/schema.php 的 migrate_schema()
-- 在 ALTER TABLE 加完列之后再建。

-- ------------------------------------------------------------
-- 题级标签投影（从 blanks_json 里各空的 tagIds 取并集自动生成）
--
-- 为什么要单独一张表：tagIds 存在 JSON 里，SQL 无法索引与 JOIN，
-- 于是所有按标签筛题、按标签统计都得把整库拉到浏览器遍历。
-- 这张表是「同一份数据的可索引投影」——权威数据仍是 blanks_json，
-- 本表可随时由它重建。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_tags (
  question_id TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'auto',   -- auto=由空标签并集投影（当前只有这一种）
  PRIMARY KEY (question_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_qtags_tag ON question_tags(tag_id);

-- ------------------------------------------------------------
-- 题级提示词类型投影（从 blanks_json 里各空的 hintType 取并集）
--
-- 与 question_tags 同理由：组卷蓝图要按「给动词 / 给名词 / …」抽题，
-- 而 hintType 存在 JSON 里没法索引。存成关系表后抽取 SQL 完全走索引，
-- 不必让 json_each 逐行解析 blanks_json（几万题时那是秒级的开销）。
-- 权威数据仍是 blanks_json，本表可随时重建。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_hints (
  question_id TEXT NOT NULL,
  hint_type   TEXT NOT NULL,                  -- 给动词 / 给名词 / 给形容词 / 给副词 / 无提示词
  PRIMARY KEY (question_id, hint_type)
);

CREATE INDEX IF NOT EXISTS idx_qhints_type ON question_hints(hint_type);

-- ------------------------------------------------------------
-- 组卷蓝图（题库重构第 2 期）
--
-- 蓝图 = 一份可复用的抽题规则：条件（标签 / 提示词 / 空格数 / 来源）
-- + 数量 + 分篇布局 + 题量不足时的降级步骤。
-- 规则是纯数据（rules_json），抽题引擎读它生成虚拟卷。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blueprints (
  id           TEXT PRIMARY KEY,               -- 如 bp_xxxx
  name         TEXT NOT NULL,
  description  TEXT,
  rules_json   TEXT NOT NULL,                  -- 见 docs/BANK_REFACTOR_DESIGN.md §4.3
  created_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT
);

-- 与 papers 同名索引同理：应用层的 409 挡不住并发创建两条同名蓝图，
-- 列表页会因此出现两行「同名但不同规则」而无法区分
CREATE UNIQUE INDEX IF NOT EXISTS idx_blueprints_name ON blueprints(name);

-- ------------------------------------------------------------
-- 蓝图使用记录（谁在什么时候用它组了哪套卷、有没有降级）
-- 一次生成 = 一行；重新生成 = 再记一行，历史不覆盖。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blueprint_runs (
  id           TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL,
  paper_id     TEXT,                           -- 生成到哪张卷；删卷时随之删除本条
  result_json  TEXT,                           -- 抽了多少题、每篇几道、放宽了什么
  relaxed      INTEGER NOT NULL DEFAULT 0,     -- 是否触发过降级
  created_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bruns_bp ON blueprint_runs(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_bruns_paper ON blueprint_runs(paper_id);

-- ------------------------------------------------------------
-- 试卷成员表（把 questions.paper_id 的单值关系升级为多对多）
--
-- 目的：同一道题可以同时属于原始卷与蓝图生成的虚拟卷。
-- section_no 是短文填空特有的维度——一套卷是 3~4 篇文章、每篇 5 个空，
-- 只记 order_no 会让组卷拼出「跨篇混排」的卷子，学生没法练。
--
-- 过渡期与 questions.paper_id 双写：paper_id 保留为「主卷」快捷字段，
-- 本表是完整的归属关系。将来确认无引用后再停用 paper_id。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_items (
  paper_id    TEXT NOT NULL,
  question_id TEXT NOT NULL,
  order_no    INTEGER NOT NULL DEFAULT 0,     -- 第几题
  section_no  INTEGER NOT NULL DEFAULT 1,     -- 第几篇（短文填空的分篇）
  PRIMARY KEY (paper_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_pitems_order ON paper_items(paper_id, order_no);

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
