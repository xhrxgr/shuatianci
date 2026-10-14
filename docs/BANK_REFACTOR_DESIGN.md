# 题库全流程管理 · 重构设计（3 个候选方案）

> 目标：把现有「录进去就能刷」的题库，升级为支持**录入 → 分类 → 审核 → 发布 → 组卷 → 考试 → 分析**全流程的管理系统。
> 本文所有现状描述均已在代码中逐条核实，标注了文件与行号；未核实的推测会显式标「未核实」。

---

## 0. 结论速览

| | 方案 A 就地演进 | 方案 B 修订+蓝图（**推荐**） | 方案 C 完全解耦 |
|---|---|---|---|
| 核心动作 | 只加列、加成员表 | A 的全部 + **修订历史表** + **组卷蓝图** | B 的全部 + 知识体系/考试会话/审核任务三张独立表 |
| 新增表 | 1（paper_items） | 5 | 9+ |
| 需改动的读路径 | 3 处 | 3 处（**读路径零改动**） | 15+ 处 |
| 迁移风险 | 低 | 低（可在线幂等执行） | 高（需停机窗口） |
| 能支撑「按条件抽题组卷」 | ✅ | ✅ | ✅ |
| 能支撑「审核与发布」 | 基础 | 完整 | 完整（含多人分工） |
| 能追溯内容修订历史 | ❌ | ✅ | ✅ |
| 适合 | 单人使用、只要抽题 | **本项目当前阶段** | 多教师协作 + 正式考试 |

**推荐方案 B**，核心理由见 §7。关键设计点是：**修订表只写不读**，题目内容列继续物化当前版本 —— 这样历史可追溯而读路径性能零退化。

---

## 1. 现状诊断

### 1.1 结构性问题（模型层的缺失，不是代码 bug）

这些是**改代码改不出来的**，必须改数据模型。

**① 元数据嵌在 `blanks_json` 里，导致无法做任何数据库级筛选**

```
questions(id, original_sentence, blanks_json, source, paper_id, schema_version, created_at)
```

知识点标签 `tagIds` 存在**每个空**的 JSON 里（`routes_bank.php:200` 直接 `json_encode($blank)`），没有独立列、没有中间表、**没有外键**。

后果链：
- `GET /api/questions` **只支持 `?paperId=` 一个筛选参数**，SQL 里唯一的条件是 `WHERE paper_id = ?`（`routes_bank.php:84-102`），**没有 LIKE、没有分页、没有全文检索**
- 所有筛选都在浏览器内存里做（`practice.js:203-216`），必须先把整库题目拉到前端
- `tagCounts()` 对**每个子标签（38 个）都全量 filter 一遍**，复杂度 O(38n)，每次改筛选条件全量重算（`practice.js:226-235`）
- 全库 grep 确认**没有 `RANDOM()` / `ORDER BY random`** —— 「随机抽题」当前物理上做不到

**② 标签按「空」打，但筛选按「题」做，存在两个互相打架的口径**

| 位置 | 口径 | 实现 |
|---|---|---|
| 管理页标签用量统计 | 按**空**累加 | `pages_admin.php:38-45` 逐 blank 遍历 |
| 刷题页筛选栏计数 | 按**题**去重 | `practice.js:232` 用 `some()` |
| 题级筛选 | 把所有空的标签**压平** | `practice.js:211` `blanks.flatMap(...)` |

同一份数据，管理页显示「标签 t_026 被用了 48 次」、刷题页显示「48 道题」，数字含义不同（48 个空 vs 48 道题），**同屏数字对不上**。

压平还有个语义损失：「某题命中 t_026」实际是「该题**至少一个空**打了 t_026」，**丢失了是哪一空的信息** —— 而「这个空考介词搭配」正是短文填空的核心信息。

**③ `source` 与 `papers.name` 双存冗余，靠字符串隐式关联**

- `questions.source`（对外展示）+ `questions.paper_id`（指向实体）+ `papers.name`（实体名）—— **同一个信息存了三份**
- 关联靠 `ensure_paper_by_name()`：trim 后**精确 `=` 匹配**、**区分大小写**（`routes_papers.php:108-116`）
- 写入侧 trim，但唯一索引 `idx_papers_name` 建在**未 trim 的原始值**上（`schema.sql:48`）—— 口径错配

已经咬人的三处（都不是假想）：

| 操作 | 后果 |
|---|---|
| **改卷名** | 只 UPDATE `papers.name`，**不同步 `questions.source`**（`routes_papers.php:215-230`）→ ① 收藏按 source JOIN（`routes_records.php:215`）全部失效、题数显示 0，数据还在；② 下次用旧 source 录题会**新建一张同名重复卷** |
| **删卷** | 题目 `paper_id` 置 NULL 但 `source` 保留（`routes_papers.php:287`）→ 下次同名录入**新建空壳卷**，同一份 source 分裂成「孤儿题 + 新卷」，`practice.js:186-188` 按 source 筛会同时显示两拨，用户看不出分属不同卷 |
| **`source` 为空串** | `ensure_paper_by_name('')` 返回 `''`（`routes_papers.php:129-132`），`''` 被写入 `paper_id` 列 —— 与 NULL 语义不同，`route_questions_set_paper` 明确区分两者（`:251`） |

**④ `paper_id` 是单值 → 无法表达多对多，也无法表达「虚拟组卷」**

`PUT /questions/paper`（`routes_papers.php:319-327`）是**移动**不是复制。一道题不能同时出现在两套卷里。papers 表没有成员表，**卷的题目集合只能反向 `WHERE paper_id = ?` 推导**。

**⑤ 缺状态机、缺审核、缺难度/题型/责任人流转**

grep 确认：**没有 `difficulty`、没有 `questionType`、没有 `status`、没有 `updated_at`、没有 `created_by`/`reviewed_by`、没有 `content_hash`、没有软删**（`schema.sql:56-64`）。

唯一的「状态」是 `user_progress.status`（`unmastered`/`mastered`），那是**每个用户自己的掌握状态**，与题目的发布状态无关 —— 而且它是**手动单向棘轮**：没有「取消掌握」的刷题页入口（`handleMarkMastered` 只置 mastered，`practice.js:691`），没有自动升降级。

后果：**录进去就直接对学生可见**。录错的题、没写解析的题、AI 解析跑偏的题，没有任何拦截机制。

**⑥ 权限表与实际校验脱节，路由表零权限元数据**

`permissions_map()`（`auth.php:35-58`）声明 11 个权限项，其中 **5 项从未被 `require_permission()` 调用过一次**：`question:read`、`record:read:self`、`record:write:self`、`record:read:any`、`tag:read`。

42 条 API 路由，**0 条在路由表层声明权限**，安全全靠每个 handler 第一行自觉。实际有 **10 条 API 完全无权限检查**（含读全部题库、全部试卷）。

`users.role` 只有 `admin` / `user` 两个取值（`auth.php:67-70` 白名单），无教师、无审核员、无出题人。「谁能录题」与「谁在学」完全无关 —— 题目是全局共享单例，`questions` 表无 owner/author 列。

**⑦ 判卷信任前端，`is_correct` 可任意伪造**

判卷 100% 在浏览器（`practice.js:158-166`），后端 `route_records_create`（`routes_records.php:36-78`）直接信任客户端送来的 `isCorrect` / `wrongCount`，不重算。

同时答案明文随 `GET /questions` 全量下发（公开、无鉴权）。判卷逻辑在 `practice.js:158-166` 与 `paper-practice.js:58-72` 是**两份复制粘贴**，注释自己承认「改动时两处要同步」。

**⑧ 无考试实体**

grep 确认：无 `exam_sessions`、无成绩单、无排名、无班级、无限时、无交卷。现在只有「逐题即时上报」（`practice.js:679` `void submitRecord(...)`，fire-and-forget 不 await），`paper-practice.js` 的「小结」只是前端统计本次会话、**不落库**。

上报失败还会**静默降级到 localStorage**（`practice.js:108-110` 只 `console.error`，无用户提示），而 `paper-practice.js:87-95` 用 `notifyWarn` 明确告知 —— 同一份数据两条不同体验路径。

### 1.2 数据完整性问题

| 问题 | 证据 | 后果 |
|---|---|---|
| **4 张表无 FK 到 questions** | `practice_records` / `user_progress` / `user_marks` 的 `question_id` 都无外键（`schema.sql:110/93/143`），唯一的 CASCADE 都是指向 `users(id)` | 删题留下孤儿记录（v3.3.3 已在统计口径加 JOIN 绕过） |
| **id 复用会串档** | `replaceAll=true` 导入保留原 id（`routes_bank.php:176-180`） | 旧用户的 wrong_count / mastered 标记**自动挂到新题上** |
| **删标签不清理引用** | `routes_tags_save:363-377` 是全表删+重建，**不碰 questions**；`validate.php` 全文无 `tagIds` | 悬空 tagId 永久滞留，`tagUsage` 继续统计幽灵 id |
| **`replaceAll` 同批 id 重复会整批回滚** | 无 `INSERT OR REPLACE`，无批内去重（`routes_bank.php:166+193`） | 导出文件被文本编辑器改过就可能触发 |
| **导入/上云的题目与标签分属两个事务** | `admin.js:578-580`、`:613-614` 先 `persistTags` 再 `pushQuestions` | 标签成功题目失败 → 不一致状态 |
| **批量删除是前端循环** | `admin-papers.js:243-245` `for (const id of ids) await api.deleteQuestion(id)` | N 题 = N 个独立事务，中途失败**无补偿无回滚**，重试会重遍历全部 |
| **编辑留不下修改时间** | `questions` 表无 `updated_at` | 改了什么、谁改的、何时改的，一概无记录 |
| **编辑路径上 `ensure_paper_by_name` 无事务** | `routes_papers.php:297-304` | 卷已建、题未改的中间态 |

### 1.3 校验体系的裂缝

**`tagIds` 服务端零校验** —— `validate.php` 全文 grep 不到 `tagIds`。存在性校验**只在前端**（`admin.js:438-445`、`admin-ai.js:702-709`）。绕过前端直接调 API 可写入任意字符串数组，包括 `"t_999"`。

**校验规则有 4 份独立副本**需人工同步：服务端 `validate.php`（权威）、`admin.js:379`、`admin-ai.js:632`、`admin-papers.js`（编辑弹窗**无统一校验函数**，只有零散行内检查 `:432-456`）。

**无任何上限**：题数、单题长度、答案个数、空数、单批 body 大小全部无限制。一条 40 万题的 POST 会一次性进单个事务。

**后端会丢弃前端传来的字段**：`status` / `wrongCount` 前端构造了但 INSERT 不含（`routes_bank.php:193-206`），且 `map_question` 把这两个字段**硬编码**为 `'unmastered'` / `0`（`routes_bank.php:40-41`）—— 与页面渲染从 `user_progress` 合并的口径不一致。

### 1.4 ⚠️ 领域适配问题（最容易被忽略，但影响最大）

短文填空不是普通选择题，有三个结构特征被现有模型完全忽略了：

**① 一套卷有「篇」的概念，现有线模型只有一个扁平的原句数组**

高考短文填空通常是 **3~4 篇文章，每篇 5 个空**。题号 1-15 对应「第一篇第 1 空」到「第三篇第 5 空」。所以卷的成员**不能只是有序的题列表，还必须记录「第几篇」** —— 否则组卷时拼出来的卷会跨篇混排，学生看到的是一篇由 20 个不相干句子拼起来的「文章」，完全无法练习。

现有 `paper_items` 概念不存在；即使加，也只想到 `order_no`，没意识到需要 `section_no`。

**② 一篇里的题是「强关联」的，但数据模型里完全独立**

同一篇文章的空共享上下文（前后句、篇章逻辑）。数据模型却把每个 `original_sentence` 当独立题目，**没有任何外键表达「同属一篇」**。导致无法实现「整篇一起练」「换一道同篇的题」这类需求。

**③ 「题型」这个维度对本项目不成立，容易设计错**

用户提的「按题型挑题」—— 短文填空只有一个题型。真正对应的是 **`hintType`（提示词类型：给动词/给名词/给形容词/给副词/无提示词）和空格数**。如果照搬通用题库设计加一个 `question_type` 枚举，会造出一个永远只有一个取值的死字段。

组卷条件应该落到：**知识点标签 / 提示词类型 / 难度 / 空格数 / 来源 / 篇数**。

### 1.5 界面与流程缺口

| 缺口 | 现状 |
|---|---|
| **题目列表无分页、无搜索框、无排序** | `page_admin()` 一次渲染全库（`pages_admin.php:32`），题库多少题就渲染多少 `<li>` |
| **后台无任何关键词搜索** | 全库唯一 `type="search"` 是**标签搜索**（`admin.js:227`），不搜题目 |
| **筛选只能从 URL 进入** | `practice.js:183-188` 读 `?paperId=` / `?source=`，页面上没有下拉框让用户主动切 |
| **批量操作只有 2 种** | 批量归卷 + 批量删。**无批量改标签、无批量上下架、无全选/反选** |
| **批量归卷服务端是循环 UPDATE** | `routes_papers.php:319-327` 逐条 SQL，不是批量 |
| **题目列表展示列太少** | 只有原句、来源、空数、是否归卷。无 id、无答案、无创建时间、无标签、无进度 |
| **后台 6 个页签平铺在一个 view** | `views/admin.php:14-21`，与「题库管理」顶层导航语义颠倒（顶层叫题库管理，进去第一个 tab 是试卷） |

---

## 2. 设计目标与硬约束

### 2.1 功能目标（覆盖用户提出的 8 项）

| # | 目标 | 关键决策点 |
|---|---|---|
| G1 | 题目录入 | 保留现有 4 条通道，统一到**一个服务端写入口**；支持草稿状态 |
| G2 | 分类与标签 | 保留两级标签；**新增题级投影表**让 SQL 可筛；标签可按题打也可按空打 |
| G3 | 审核与发布 | 题目状态机 `draft → in_review → published → archived`（+ `rejected`） |
| G4 | 版本与状态流转 | 每次修改存**修订快照**，可 diff、可回滚、可追溯责任人与时间 |
| G5 | 组卷方式 | ① 单卷直接生成（虚拟卷）② **蓝图按条件抽题**（tag/hintType/difficulty/blankCount/source/section） |
| G6 | 权限与角色 | 2 角色 → 4 角色：`student` / `teacher` / `reviewer` / `admin` |
| G7 | 检索筛选 | 服务端筛选 + 分页 + 关键词；**必须走 SQL**，不在浏览器遍历 |
| G8 | 考试流程衔接 | `exam_sessions` 交卷式作答 + **后端判卷** + 成绩单 |

### 2.2 硬约束（不能违反）

1. **技术栈不变** —— PHP 8 + SQLite + 原生 JS，不引入 ORM、不引入构建步骤、不换数据库
2. **在线迁移，不停机** —— 迁移脚本幂等、可重复执行、失败可回滚
3. **读路径零退化** —— 题目内容列继续物化当前版本，不为了「规范化」让所有查询都去 JOIN 版本表
4. **接口契约不破坏** —— 现有 42 条 API 的响应结构保持兼容，新增字段只增不改
5. **判卷口径不变** —— 大小写敏感、只 trim，多词答案按 `/` 或逗号分隔
6. **不擅自扩大范围** —— 一次性上齐 G1~G8 是不现实的，分期做（§8）

### 2.3 SQLite 的工程约束（决定迁移方案）

| 约束 | 影响 |
|---|---|
| `ALTER TABLE` **只能 ADD COLUMN / RENAME COLUMN** | 加列容易；**加外键、加 CHECK、加 UNIQUE 约束必须重建表**（建新表 → COPY → DROP → RENAME） |
| 新增列**不能是「NOT NULL 且无静态默认值」** | `DEFAULT CURRENT_TIMESTAMP` 在 ADD COLUMN 时不合法 → 先加可空列，回填，再靠应用层保证 |
| 无原生 JSON 列、无 JSON 索引 | tagIds 必须投影成**真实的关系表**才能被索引和 JOIN |
| 自带 FTS5 可用，但中文分词需自备 | unicode61 对中文只能按字符切 → 需预分词 |
| 全库单文件、无并发写压力 | WAL 已开启（`schema.sql:12`），`db_transaction` 足够 |
| 检索量级估算：几千~几万题 | **LIKE 全表扫描是毫秒级**，先不上 FTS5 |

---

## 3. 方案 A：就地演进（最小改动）

> 保留现有 `questions` 单表结构，只**加列** + 把 `paper_id` 单值改成成员表。适合「只要能按条件抽题组卷」。

### 3.1 数据模型增量

```sql
-- questions 加列（SQLite ADD COLUMN，不能加外键/约束）
ALTER TABLE questions ADD COLUMN status      TEXT    NOT NULL DEFAULT 'draft'; -- 状态机（D2：存量置 published）
ALTER TABLE questions ADD COLUMN updated_at  TEXT;
ALTER TABLE questions ADD COLUMN created_by  INTEGER;
ALTER TABLE questions ADD COLUMN owner_id    INTEGER;   -- 出题人（可为空=系统导入）
ALTER TABLE questions ADD COLUMN content_hash TEXT;     -- 变更检测/去重

-- 新增：题级标签投影（关键！让 SQL 可筛）
CREATE TABLE question_tags (
  question_id TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'auto',  -- auto=由空标签并集投影 / manual=人工打题级标签
  PRIMARY KEY (question_id, tag_id)
);
CREATE INDEX idx_qtags_tag ON question_tags(tag_id);

-- 新增：试卷成员表（把单值 paper_id 变成多对多）
CREATE TABLE paper_items (
  paper_id    TEXT NOT NULL,
  question_id TEXT NOT NULL,
  order_no    INTEGER NOT NULL,   -- 第几题
  section_no  INTEGER NOT NULL DEFAULT 1,  -- 第几篇文章（§1.4 ① 关键）
  PRIMARY KEY (paper_id, question_id)
);
CREATE INDEX idx_pitems_order ON paper_items(paper_id, order_no);

-- papers 加列：区分「原始卷」与「虚拟生成卷」
ALTER TABLE papers ADD COLUMN kind TEXT NOT NULL DEFAULT 'source'; -- source | generated
ALTER TABLE papers ADD COLUMN blueprint_json TEXT;  -- 生成条件快照
```

### 3.2 管理流程

```
录入 ──▶ draft ──提交审核──▶ in_review ──通过──▶ published ──下架──▶ archived
  ▲                        │                                        │
  └──── 退回 ◀── rejected ─┘                        恢复 ──────────┘
```

组卷：
```
① 单卷直生：选「整份导入的卷」→ papers(kind='source')
② 蓝图抽题：选条件 → SQL 抽 N 道 → 生成 papers(kind='generated') + paper_items 落库
              → 之后「整卷做」走同一条路径，只是成员来源不同
```

### 3.3 优缺点

**优点**
- 改动最小，迁移只需 ADD COLUMN + 建 3 张表，**不需要重建任何表**
- 抽题组卷能力一次到位（G5）
- 状态机（G3）基本满足单人/小团队审核
- 读路径只多改 `routes_papers.php` 的 4 处反向查询改为 JOIN `paper_items`

**缺点**
- **没有修订历史**（G4 基本不满足）。AI 重新解析会覆盖、老师改错题改错了都不知道，只能靠 git 历史（数据库不在 git 里）
- 题目内容与「修订快照」不分家，将来想做 diff 要重新加表并二次迁移
- 审核只有单级状态，没有审核人/审核意见/审核时间（可在 questions 上加 3 个列凑合，但没有多轮驳回的记录）
- 无考试实体（G8 不满足）

### 3.4 适用场景

**单人使用或两人以内**，主要诉求是「录题更顺手 + 能按条件抽题组卷」，暂不需要内容追溯与正式考试。

### 3.5 迁移影响

| 项 | 影响 |
|---|---|
| 表结构 | 5 × ADD COLUMN + 3 张新表，**无重建表** |
| 数据回填 | `question_tags` 从 `blanks_json` 解析 `tagIds` 取并集写入（幂等：`INSERT OR IGNORE`） |
| 数据量 | 全库扫一遍 questions + json_decode，几万题约 1~3 秒 |
| 停机 | **不需要** |
| 代码 | `routes_papers.php` 4 处反向查询改 JOIN；`routes_bank.php` 加筛选参数；`admin-papers.js` 加筛选 UI |
| 接口 | 现有响应只增字段（`difficulty`/`status`/`tags`），不删不改 |
| 回滚 | DROP 3 张新表 + 列可留（SQLite 删列需重建表，建议保留不删） |

---

## 4. 方案 B：修订历史 + 组卷蓝图（推荐）

> 在方案 A 之上加**修订快照表**与**蓝图表**。核心设计：**修订表只写不读**，题目内容列继续物化当前版本 —— 历史可追溯，读路径零退化。

### 4.1 数据模型增量（在方案 A 基础上再加 3 张表）

```sql
-- ★ 修订快照表：append-only 审计轨
CREATE TABLE question_revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id       TEXT    NOT NULL,
  revision_no       INTEGER NOT NULL,
  original_sentence TEXT    NOT NULL,
  blanks_json       TEXT    NOT NULL,
  change_kind       TEXT    NOT NULL DEFAULT 'edit', -- create/edit/ai_import/batch_edit/publish
  change_note       TEXT,                            -- 改了什么（一句话）
  content_hash      TEXT    NOT NULL,               -- 相邻版本相同则不写新行
  created_by        INTEGER,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (question_id, revision_no)
);
CREATE INDEX idx_qrev_qid ON question_revisions(question_id, revision_no DESC);

-- 题目上的发布绑定：发布的是「哪个版本」
ALTER TABLE questions ADD COLUMN current_revision_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE questions ADD COLUMN reviewed_by   INTEGER;
ALTER TABLE questions ADD COLUMN reviewed_at   TEXT;
ALTER TABLE questions ADD COLUMN review_note   TEXT;   -- 审核意见（驳回原因）

-- ★ 组卷蓝图：一等公民，可复用、可版本化
CREATE TABLE blueprints (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  rules_json   TEXT NOT NULL,   -- 见 §4.3
  created_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT
);

-- 蓝图使用记录（谁在什么时候用它组了哪套卷）
CREATE TABLE blueprint_runs (
  id          TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL,
  paper_id    TEXT    NOT NULL,
  result_json TEXT,      -- 抽了多少、缺哪些、是否降级
  relaxed     INTEGER NOT NULL DEFAULT 0,  -- 是否触发了降级
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ★ 审核留痕（支持多轮驳回，不只是 questions 上的 3 个列）
CREATE TABLE question_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  action      TEXT NOT NULL,   -- submit/approve/reject/withdraw
  comment     TEXT,
  reviewer_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_qrev_review ON question_reviews(question_id);
```

### 4.2 修订的写入策略（关键设计）

```
写路径：任何修改 questions 内容的操作
  1. 计算新的 content_hash
  2. 若与 current revision 的 hash 相同 → 只更新 updated_at（内容没变，不产生新版本）
  3. 否则 INSERT INTO question_revisions（revision_no = current + 1）
  4. UPDATE questions 的物化列（原句/blanks/difficulty）+ current_revision_no
  5. 两步包在同一个 db_transaction 里
```

**为什么不把读路径改成读版本表**：
- 现有 `GET /questions` 一次要返回几百道题的完整 blanks_json；改成 JOIN 版本表意味着每题多一次行读取
- 更重要的是**语义**：版本表回答「这道题改过几次」，内容列回答「这道题现在长什么样」。绝大多数查询问的是后者

**回滚**：把目标版本的 `original_sentence` / `blanks_json` 覆盖回内容列，并写一条新的 revision（`change_kind='rollback'`，`change_note` 记录回滚自哪个版本）。**不物理删除版本**，保持审计完整。

### 4.3 组卷蓝图规则格式

```jsonc
{
  "name": "虚拟语气专项 20 题",
  "mode": "random",                    // random=随机 | fixed=固定顺序 | balanced=难度配比
  "count": 20,
  "conditions": [
    { "type": "tag",       "ids": ["t_020"], "match": "all" },
    { "type": "hintType",  "values": ["给动词"], "match": "any" },
    { "type": "blankCount","min": 1, "max": 2 },
    { "type": "source",    "include": ["某某中学2026-2027学年高三上学期10月阶段检测试题"] },
    { "type": "status",    "values": ["published"] }   // 默认就是 published，写出来是为了可读
  ],
  "layout": {                          // ★ 分篇规则（§1.4 ①）
    "sections": 4,                     // 目标 4 篇
    "perSection": 5,                   // 每篇 5 空
    "groupBy": "tag"                   // 按知识点把同类题聚到一篇
  },
  "fallback": {
    "onInsufficient": "relax",         // 题量不够时逐步放宽
    "relaxSteps": ["dropHintType", "dropBlankCount"]
  }
}
```

抽取 SQL（真随机，且走索引）：

```sql
SELECT q.id
  FROM questions q
  JOIN question_tags qt ON qt.question_id = q.id AND qt.tag_id IN (:tags)
 WHERE q.status = 'published'
   AND q.id IN (                       -- 题级条件子查询
        SELECT question_id FROM question_tags
         WHERE tag_id IN (:tags)
         GROUP BY question_id
        HAVING COUNT(DISTINCT tag_id) = :tagCount)
   AND EXISTS (SELECT 1 FROM json_each(q.blanks_json)      -- hintType / blankCount 条件
                WHERE json_extract(value,'$.hintType') IN :hints)
   AND json_array_length(q.blanks_json) BETWEEN :bmin AND :bmax
 ORDER BY RANDOM()
 LIMIT :count
```

> ⚠️ 注意 `json_each` 在 SQLite 上对几万行 JSON 解析有开销。**落地策略**：先把 `blank_count` 和「该题有哪些 hintType」也投影成列/关系表（`question_hints(question_id, hint_type)`），让上面这条 SQL 完全走索引，只在需要复杂条件时才落到 JSON。

### 4.4 权限矩阵（G6）

| 操作 | student | teacher | reviewer | admin |
|---|---|---|---|---|
| 读题库 / 刷题 | ✓ | ✓ | ✓ | ✓ |
| 录题、建草稿 | | ✓ | | ✓ |
| 编辑**自己**的题 | | ✓ | | ✓ |
| 编辑**他人的**题 | | | ✓ | ✓ |
| 删除题 | | 自己的 | | ✓ |
| 提交审核 | | ✓ | | ✓ |
| 审核发布 / 驳回 | | | ✓ | ✓ |
| 管理标签体系 | | | | ✓ |
| 建蓝图 / 组卷 / 发布试卷 | | ✓ | ✓ | ✓ |
| 发起考试 / 查看本班成绩 | | ✓ | ✓ | ✓ |
| 管理用户 / 系统配置 | | | | ✓ |

落地成本极低：`permissions_map()` 加角色、`is_valid_role()` 加白名单、`register` 的强制 role 改一行。

### 4.5 考试流程衔接（G8）

```sql
-- 交卷式考试会话（与现有「逐题即时上报」并存，按 mode 区分）
CREATE TABLE exam_sessions (
  id             TEXT PRIMARY KEY,
  paper_id       TEXT NOT NULL,
  user_id        INTEGER NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'practice',  -- practice=即时上报 | exam=交卷
  status         TEXT NOT NULL DEFAULT 'in_progress', -- in_progress/submitted/abandoned
  duration_sec   INTEGER,                            -- 限时，NULL=不限时
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at   TEXT,
  total_score    REAL,
  obtained_score REAL,
  correct_count  INTEGER,
  wrong_count    INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_esess_user ON exam_sessions(user_id, submitted_at DESC);

-- 逐空作答明细（**后端判卷的依据**）
CREATE TABLE exam_answers (
  session_id  TEXT NOT NULL,
  question_id TEXT NOT NULL,
  blank_index INTEGER NOT NULL,
  answer      TEXT,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, question_id, blank_index)
);

-- 成绩单（按会话固化，交卷时快照，之后题库改了也不影响历史成绩）
CREATE TABLE exam_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  question_id  TEXT NOT NULL,
  blank_total  INTEGER NOT NULL,
  blank_correct INTEGER NOT NULL,
  is_correct   INTEGER NOT NULL,   -- 全部空对才算对（与现有 practice_records 口径一致）
  PRIMARY KEY (session_id, question_id)
);
```

**后端判卷**（修 §1.1 ⑦）：

```php
// POST /api/exam-sessions/{id}/submit
// 关键：is_correct 一律由服务端按 blanks_json 重算，忽略客户端送来的值
foreach ($answers as $a) {
    $blank = $blanks[$a['blankIndex'] - 1] ?? null;
    $ok = $blank !== null && in_array(trim((string)$a['answer']), array_map('trim', $blank['answer']), true);
    // 注意：严格 ===，不转小写（§2.2 约束 5）
}
```

**与现有记录的衔接**：`mode='practice'` 的会话在交卷时仍照旧写 `practice_records` + `user_progress`（保持现有口径与统计不变）；`mode='exam'` 只写 `exam_results`，**不污染掌握度** —— 学生考试时不该把「蒙对的」记成掌握。

### 4.6 检索与筛选（G7）

```
GET /api/questions
  ?q=关键词              原句/答案/解析 任一命中（LIKE '%kw%'）
  &tag=t_020&tagMatch=all|any
  &hintType=给动词
  &difficultyMin=2&difficultyMax=4
  &blankCountMin=1&blankCountMax=3
  &paperId=p_0001
  &source=某某中学...
  &status=published
  &owner=3
  &order=created_at|updated_at|difficulty|random
  &page=1&pageSize=50         ← 终于有分页了
```

**关键词检索先不上 FTS5**：SQLite 扫描几万行 TEXT 是毫秒级。预留触发条件 —— 超过 5 万题，或需要中文分词相关性排序时，再加 `question_search(question_id, tokens)` + FTS5 虚拟表（**自备分词**：按空格与标点切好后用 unicode61 索引，对中文有效）。

**标签统计口径统一**：管理页与刷题页都改读 `question_tags`（题级），不再各算各的。空级用量作为独立指标单独展示（「标签 t_026：48 道题 / 52 个空」）。

### 4.7 优缺点

**优点**
- **修订历史解决真实痛点**：AI 重新解析覆盖原题、老师改错题，都能回滚与对比 —— 这在纯 SQLite 单文件（数据库不在 git 里）时是唯一出路
- **读路径零退化**（修订只写不读），性能与现状持平
- 抽题组卷 + 分篇布局，是三个方案里唯一真正解决「短文填空是分篇的」这个领域特性的
- 审核留痕支持多轮驳回 + 审核意见
- 考试流程与后端判卷，能出成绩单，且不污染掌握度
- 权限从 2 角色扩到 4 角色，改动集中在 `permissions_map()` 一个函数

**缺点**
- 表数量增至 16 张（+4），**需要认真写文档说明每张表的职责边界**，否则半年后没人敢动
- 状态机 + 权限矩阵会**显著增加测试面**（现有 ui-test 182 项、api-test 83 项，状态流转的组合需要补测试）
- 权限升级需要迁移已有 admin 账号的映射（admin 保留全部 11 项权限即可，实际影响小）
- 「写两遍」（revision + questions 内容列）意味着**每次编辑多一次 INSERT**，编辑高频场景下有写放大

### 4.8 适用场景

**本项目当前阶段**。用户已经在用 AI 批量录题（说明内容会反复重生成）、有 4 万+ 题的趋势、需要按条件组卷、是老师自用的教学工具。修订历史能解决「AI 改完发现跑偏了找不回来」这个必然会遇到的问题。

---

## 5. 方案 C：完全解耦的题库-考试架构

> 把「知识体系」「题目内容」「组卷规则」「考试会话」彻底分层，每层独立演进。适合多教师协作 + 正式考试场景。

### 5.1 数据模型增量（在 B 基础上再加 5 张表）

```sql
-- ① 知识体系独立成表（替代 tags 的两级硬编码，支持任意层级 + 稳定编码）
CREATE TABLE knowledge_points (
  id          TEXT PRIMARY KEY,          -- kp_0001（稳定编码，不随改名变化）
  name        TEXT NOT NULL,
  code        TEXT UNIQUE,               -- 业务编码：VIRTUAL / TENSE 等
  parent_id   TEXT,
  level       INTEGER NOT NULL DEFAULT 1,
  path        TEXT,                      -- 物化路径 /t_001/t_020，任意层级可查子树
  sort_order  INTEGER NOT NULL DEFAULT 0,  -- ★ 修现状「顺序依赖 id 字典序、破千后错乱」
  description TEXT,                      -- ★ 现状 tags 表没有
  is_active   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_kp_path ON knowledge_points(path);

-- question_tags 改为指向 knowledge_points，且保留 origin 区分来源

-- ② 篇章（§1.4 ②：同篇的题强关联，当前完全无表达）
CREATE TABLE passages (
  id         TEXT PRIMARY KEY,
  paper_id   TEXT NOT NULL,
  section_no INTEGER NOT NULL,
  title      TEXT,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
-- question_revisions 增列 passage_id

-- ③ 审核任务（把审核从题目属性提升为独立实体，支持多人分工与并行审）
CREATE TABLE review_tasks (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  assignee_id INTEGER,                    -- 分配给谁
  state       TEXT NOT NULL DEFAULT 'pending', -- pending/claimed/approved/rejected
  priority    INTEGER NOT NULL DEFAULT 0,
  due_at      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rt_state ON review_tasks(state, assignee_id);

-- ④ 班级 / 用户组（当前完全不存在）
CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'class'  -- class=班级 / team=教研组
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL,
  user_id  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
-- users 加 group 相关查询权限；题目可按 group 做可见性隔离（visibility 字段）

-- ⑤ 题目可见性（当前题目是全局共享单例，无 owner 无 visibility）
ALTER TABLE questions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all'; -- all | private | group
ALTER TABLE questions ADD COLUMN group_id TEXT;
```

### 5.2 管理流程

```
录入 ──▶ draft ──提交──▶ review_tasks(pending) ──认领──▶ claimed
                                                      │
                                    ┌─────────────────┴──────────────┐
                                  approve                          reject
                                    │                                 │
                              questions.status              questions.status=rejected
                              = published                     + question_reviews 留痕
                                                              │
                                                          编辑后重新提交（版本+1）
```

组卷进阶：
```
① 原始卷   整份导入 → passages + paper_items（含 section_no）
② 蓝图卷   blueprints.rules_json → 抽题 → 按 layout 分篇 → passages 自动生成
③ 模板卷   一次组卷的完整条件+篇序可存为 templates，后续一键复用
考试       papers → exam_sessions → 逐空作答 → 交卷后端判卷 → exam_results
           → 按 group 聚合成绩单、知识点得分率、薄弱点报告
```

### 5.3 优缺点

**优点**
- **知识体系可无限层级 + 有稳定编码**：`code` 字段让「虚拟语气」这种跨改名的统计口径稳定下来（现状只有中文 name，改名即断链）
- **篇章实体**让「整篇替换一道同篇题」「按文章分析得分率」成为可能 —— 这是短文填空教学的真实需求
- **审核任务实体**支持多人并行审、认领、超时提醒
- **班级 + 可见性**支持「这个班只能用这套题」的校本题库场景
- 未来接 LLM 生成题目时，知识体系编码是 prompt 上下文的天然载体

**缺点**
- **改动面最大**：读路径涉及 questions 的地方全部要改（现状 15+ 处），每处都要考虑 passage/group/visibility
- **迁移窗口更长**，且部分改动（重建 questions 表加外键）需要停机
- **能力上限远超当前需要**：现在没有班级、没有多人审核、没有校本题库，加这些是一次性投入，回报不确定
- 表数量将达 21 张，对一个「一个老师用的 SQLite 单文件」来说**运维负担明显偏重**

### 5.4 适用场景

**多教师协作的校本题库**：多所学校/教研组共用、需要审核流程、需要按班级发卷与出成绩单、需要知识体系跨学年稳定编码。若确定要走这条路，B 是它的必经中间态。

### 5.5 迁移影响

| 项 | 影响 |
|---|---|
| 表结构 | 需**重建 questions 表**（加 visibility/group_id 外键约束），`PRAGMA foreign_keys=OFF` → 建新表 → INSERT SELECT → DROP → RENAME → 重建索引 |
| 停机 | 建议**约 30 秒维护窗口**（数据量小，SQLite 事务内可完成，但要谨慎） |
| 数据回填 | knowledge_points 从 tags 迁移（保留原 id 作为 code 前缀）；question_tags 重挂；passages 从 paper_items 的 section_no 聚合生成 |
| 代码 | 读路径 15+ 处改造；路由层要加 visibility/group 过滤 |
| 接口 | 需要新的一组 group/review 接口；questions 响应增加字段 |
| 回滚 | 复杂 —— 重建表后无法简单回退，需要迁移前备份（项目已有自动备份机制可用） |

---

## 6. 三个方案横向对比

### 6.1 能力矩阵

| 能力 | 现状 | A 就地演进 | B 修订+蓝图 | C 完全解耦 |
|---|---|---|---|---|
| 题目录入（4 通道统一） | ⚠️ 有 4 通道但收敛到 1 入口，前端差异服务端无法拦 | ✅ 收口 | ✅ 收口 | ✅ 收口 + 分篇录入 |
| 分类与标签（题级可筛） | ❌ 标签藏在 JSON，SQL 不可筛 | ✅ | ✅ | ✅ + 任意层级 + 稳定编码 |
| 状态机 | ❌ 无 | ✅ 单级 | ✅ 多轮驳回 | ✅ 任务化并行审 |
| 修订历史 / 回滚 | ❌ 无 | ❌ | ✅ | ✅ |
| 按条件抽题组卷 | ❌ 物理上做不到 | ✅（不含难度，D1） | ✅ + 分篇布局 | ✅ + 模板卷 |
| AI 录入实时预览 + 勾选 | ❌ | ✅（D5） | ✅ | ✅ |
| 单卷直接生成 | ⚠️ 只能整份导入的卷 | ✅ | ✅ | ✅ |
| 权限与角色 | ⚠️ 2 角色，5 项权限零调用 | ✅ 2→3 | ✅ 2→4 | ✅ + 班级维度 |
| 检索筛选 / 分页 | ❌ 1 个参数，全在浏览器 | ✅ | ✅ | ✅ + FTS5 |
| 后端判卷 / 成绩单 | ❌ 判卷在前端 | ❌ | ✅ | ✅ + 班级聚合报告 |
| 篇章（passage）概念 | ❌ 无 | ❌ | ✅ 分篇布局 | ✅ 篇章实体 |
| 知识体系编码 | ❌ 只有中文 name | ❌ | ❌ | ✅ |
| 班级 / 可见性 | ❌ 无 | ❌ | ❌ | ✅ |

### 6.2 成本与风险

| | A | B | C |
|---|---|---|---|
| 新增表 | 1 | 5 | 10 |
| 需重建的表 | 0 | 0 | 1（questions 加外键） |
| 读路径改造 | 3 处 | 3 处（零退化） | 15+ 处 |
| 停机窗口 | 不需要 | 不需要 | 建议 30 秒 |
| 新增测试量 | +15 项 | +40 项 | +80 项 |
| 长期维护复杂度 | 低 | 中 | 高 |
| 未来扩展弹性 | 低（无版本→ 要二次迁移） | 中（知识体系可加） | 高 |

### 6.3 关键取舍

三个决策点决定选哪个：

**① 题库内容会不会被反复重写？**（决定是否值得上修订历史）

AI 批量解析已经是主力录入方式，且提示词会迭代、AI 会对同一份卷子跑出不同结果。**会。** → 排除 A。

**② 现在有没有班级/多人审核的实际需求？**

用户是单人使用（`admin` 1 个、`user` 2 个，内存记忆中未提过班级需求）。**没有。** → 排除 C。

**③ 一道题能不能同时出现在多套卷里？**

「按条件抽题组卷」生成的是**虚拟卷**，与原始卷并存；同一道高质量题很可能同时被抽进多套模拟卷。**能且必须。** → A 和 B 都解决了（成员表），这是本次重构的**硬需求**。

---

## 7. 推荐方案

### 推荐：**方案 B（修订历史 + 组卷蓝图）**

### 7.1 推荐理由

**① 它解决的不是「未来可能需要」，而是「已经在发生的损失」**

用户已经用 AI 批量录题，而 AI 提示词在迭代、同一份卷子会跑出不同结果。当 AI 把一道题的答案判错覆盖掉了，现在**唯一的找回方式是人工记忆 + git 历史**（数据库不在 git 里）。每跑一次 AI 就多一份不可逆的风险敞口。修订历史是把这类损失归零的最低成本手段。

**② 读路径零退化，是 A 与 B 之间最关键的技术分水岭**

A 与 B 的表结构差异很小，但 B 需要一个「修订只写不读」的纪律。一旦为了「规范化」把读路径改成 JOIN 版本表，现有 `GET /questions`（一次返回几百道题完整 blanks_json）会退化到每次多 N 次行读取，并且所有现有接口都要改。**保留物化列**让 B 的读路径与 A 完全相同 —— 这是 B 能低风险落地的关键。

**③ 分篇布局是唯一真正解决领域特性的部分**

现有「一套卷 = 若干独立句子」的模型，做不出「像样的模拟卷」。`paper_items.section_no` 加上 `layout` 规则是短文填空组卷的**必要条件**，不是锦上添花。A 支持 `section_no`，B 额外支持「按知识点聚到一篇」的自动分篇。

**④ 权限升级是未来 3 个月大概率会用到的**

`teacher` / `reviewer` 两个角色对应「录题的人」和「把关的人」。即使是同一个人用，也应该让「录完的题默认是 draft，需要自己点一下发布」——这直接解决了 §1.1 ⑤ 的「录错的题直接对学生可见」。**状态机 + 两个角色是当前阶段就能吃到的收益，不需要等到班级需求出现。**

**⑤ 它是 C 的必经中间态，且不浪费**

将来真要走 C（校本题库、多校共用），B 的 `question_revisions` / `blueprints` / `exam_sessions` 三张表可以原样保留，只需再加 knowledge_points / passages / groups。**B 不是走弯路，是 C 的第一阶段。**

### 7.2 推荐方案的边界（明确不做什么）

为避免范围膨胀，以下**明确推迟**：

| 推迟项 | 推迟到 |
|---|---|
| knowledge_points 独立表 + 稳定编码 | 需要跨学年统计口径稳定时（v4.x） |
| passages 篇章实体 | 需要「整篇替换」「按文章分析」时（v4.x） |
| review_tasks 审核任务并行化 | 有第二个录题人时 |
| 班级 / 可见性 | 真有班级概念时 |
| FTS5 全文检索 | 题量超 5 万时 |
| `question_hints` 投影表 | 组卷 SQL 实测慢于 1 秒时 |

### 7.3 落地后能立刻用上的能力

1. **录题不再直接对学生可见** —— 新题进 `draft`，审核后才 `published`
2. **AI 跑偏了能一键回滚** —— 版本列表 + 差异对比 + 回滚
3. **「给我 20 道虚拟语气的题」** —— 蓝图抽题，点一下就生成一套新卷
4. **抽出来的卷自动分篇** —— 按知识点聚成 3~4 篇，能直接当模拟卷用
5. **题目列表能搜能筛能翻页** —— 从「几千行全渲染」变成真正的管理界面
6. **标签统计口径统一** —— 管理页和刷题页数字终于对得上
7. **改卷名不再丢收藏** —— source 单一真源
8. **正式考试有了成绩单** —— 交卷式 + 后端判卷 + 不污染掌握度

---

## 8. 推荐方案的落地分期

按「每期都能独立产生价值」切，不追求一次做完。

### 第 1 期：让题库可管可搜（地基 + 检索）—— ✅ **已实施（v3.5.0）**

**范围**
- 4 × ADD COLUMN（status / updated_at / owner_id / content_hash）—— **不含 difficulty**（D1）
- 建 `question_tags`（题级投影，origin 固定 auto）、`paper_items`（含 `section_no`）
- **AI 录入的实时完整预览 + 逐题勾选 + 重复项默认不勾选**（D5，详见 §10）
- 新增指纹归一化规则（前后端各一份 + 同一组测试用例校验口径一致）
- 新增 `POST /api/questions/check-duplicates`
- 数据回填：`question_tags` 从 `blanks_json` 的 tagIds 并集投影
- `GET /questions` 加筛选参数 + 分页 + 排序 + 关键词
- 后台题目列表：搜索框 + 筛选栏 + 分页 + 展示列补齐（id/标签/难度/状态/更新时间）
- 修 `source` 双存：改卷名同步 `questions.source`；删卷时 source 跟随处理
- 删标签时级联清理 `question_tags` 与 `blanks_json` 内的 tagIds
- 修「卷改名后收藏失效」

**为什么先做这期**：抽题组卷的**数据基础**在这里（`question_tags` + `paper_items` + status 列）；录入主路径的预览与勾选是每天都用的交互；检索是当前最痛的手工活；`source` 双存是正在咬人的数据 bug。

**验收**：
- 能按标签 / 提示词类型 / 空格数 / 来源筛出题目并分页
- 粘贴 AI 输出后即时看到完整预览，每题标注新增/已存在，重复题默认不勾选
- 「预览显示已存在」与「入库时判为新增」永远一致（指纹口径校验用例通过）
- 改卷名后收藏仍可用；删标签后无悬空 id；存量题目全部可正常刷

### 第 2 期：组卷蓝图与抽题 —— ✅ **已实施（v3.6.0）**

**范围**
- 建 `blueprints` / `blueprint_runs`
- 蓝图规则 UI：条件构造器（tag / hintType / blankCount / source）+ 数量 + 布局（篇数、每篇空数）
  —— **不含 difficulty**（D1）
- 抽取 SQL + 降级策略（题量不足时逐步放宽并明示）
- 生成虚拟卷：写 `papers(kind='generated')` + `paper_items`（含 section_no）
- 卷管理页区分「原始卷 / 生成卷」，支持「一键按蓝图重新生成」
- `paper_items` 手工调整：换题、删题、调顺序、拖到别的篇

**为什么第二**：这期直接交付用户最想要的能力，且不依赖审核流。

**验收**：按「虚拟语气 + 给动词 + 20 题 + 4 篇每篇 5 空」能生成一套分篇正确的卷；
题量不足时明确提示放宽了什么。（难度维度按决策 D1 不在本期范围内。）

### 第 3 期：修订历史与审核发布

**范围**
- 建 `question_revisions` / `question_reviews`
- 写路径统一：所有内容修改先写 revision 再更新物化列（同一事务）
- 版本列表 UI：版本号、时间、操作人、变更类型、content_hash 变化标记
- 差异对比：逐字段（题级）+ 逐空（blankIndex 对齐后的增删改）
- 回滚：选版本恢复，写一条 `rollback` revision
- 状态机落地：草稿 → 提交审核 → 通过/驳回 + 审核意见
- 角色升级：`teacher` / `reviewer`，`permissions_map()` 扩到 4 角色
- 题目列表加状态筛选与批量操作（批量提交审核 / 批量发布 / 批量改标签）

**为什么第三**：需要第 1 期的 status 列与 owner_id 打底；角色升级会让所有需要权限的接口都过一遍测试，所以放在有了前面地基之后做。

**验收**：AI 重解析后能回到上一版；驳回意见可见；teacher 不能编辑他人的题。

### 第 4 期：考试流程与后端判卷

**范围**
- 建 `exam_sessions` / `exam_answers` / `exam_results`
- 考试模式 UI：整卷计时、答题卡、交卷确认
- 后端判卷（忽略客户端 is_correct）
- 成绩单页：总分/正确率/逐空明细/按知识点得分率
- 考试模式**不污染** `user_progress`
- `mode='practice'` 路径完全保持现状（不回归）

**为什么最后**：考试是最独立的一块（不改现有任何路径，纯新增），但它依赖第 1 期的 `paper_items`（要按 `section_no` 分篇展示）。

**验收**：考试交卷后改题库，历史成绩不变；篡改请求体的 is_correct 无效。

---

## 9. 迁移方案

### 9.1 迁移脚本设计原则

1. **幂等** —— 每一步都能重复执行（`CREATE TABLE IF NOT EXISTS`、`INSERT OR IGNORE`、`ADD COLUMN` 前先查 `PRAGMA table_info`）
2. **在线执行** —— 全部包在事务里，失败回滚，不需要停机
3. **先备份** —— 项目已有自动备份机制（网页更新前备份到 `data/backups/`），迁移脚本也应强制先备份
4. **分步可观测** —— 每步输出受影响行数，超过预期就中止
5. **可回滚** —— 优先「只增不删」；DDL 无法回滚的部分（ADD COLUMN）**保留不删**，多留一列无害

### 9.2 第 1 期迁移骨架

```php
// php/app/migrations/m1_bank_columns.php
// 幂等：可重复执行

// ① ADD COLUMN（SQLite 不允许重复 ADD，先查）—— 注意 D1：无 difficulty 列
function add_column_if_absent(string $table, string $column, string $definition): void {
    foreach (query("PRAGMA table_info($table)") as $row) {
        if ($row['name'] === $column) return;   // 已有，跳过
    }
    execute("ALTER TABLE $table ADD COLUMN $column $definition");
}

// ② 建表（IF NOT EXISTS 天然幂等）
execute("CREATE TABLE IF NOT EXISTS question_tags (
  question_id TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'auto',
  PRIMARY KEY (question_id, tag_id)
)");
execute("CREATE INDEX IF NOT EXISTS idx_qtags_tag ON question_tags(tag_id)");

execute("CREATE TABLE IF NOT EXISTS paper_items (
  paper_id    TEXT NOT NULL,
  question_id TEXT NOT NULL,
  order_no    INTEGER NOT NULL DEFAULT 0,
  section_no  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (paper_id, question_id)
)");

// ③ 回填：tagIds 并集投影到题级（幂等）
db_transaction(function () {
    $rows = query('SELECT id, blanks_json FROM questions');
    $n = 0;
    foreach ($rows as $row) {
        $blanks = json_decode((string) $row['blanks_json'], true);
        if (!is_array($blanks)) continue;
        $ids = [];
        foreach ($blanks as $b) {
            foreach ((array) ($b['tagIds'] ?? []) as $t) {
                if (is_string($t) && $t !== '') $ids[$t] = true;
            }
        }
        foreach (array_keys($ids) as $t) {
            execute('INSERT OR IGNORE INTO question_tags (question_id, tag_id, origin)
                     VALUES (?, ?, ?)', [$row['id'], $t, 'auto']);   // 幂等键
            $n++;
        }
    }
    return $n;
});

// ④ paper_items 回填：order_no 用 created_at 排序，保证与现状展示顺序一致
db_transaction(function () {
    $rows = query('SELECT id, paper_id FROM questions
                    WHERE paper_id IS NOT NULL AND paper_id != \'\'
                    ORDER BY created_at, id');
    $no = []; $n = 0;
    foreach ($rows as $row) {
        $no[$row['paper_id']] = ($no[$row['paper_id']] ?? 0) + 1;
        execute('INSERT OR IGNORE INTO paper_items (paper_id, question_id, order_no, section_no)
                 VALUES (?, ?, ?, 1)', [$row['paper_id'], $row['id'], $no[$row['paper_id']]]);
        $n++;
    }
    return $n;
});
```

### 9.3 兼容性保证

| 项 | 保证 |
|---|---|
| 现有 42 条 API | 响应**只增字段不改不改删**；新参数可选，不传走原路径 |
| `GET /questions` 不传参 | 行为与现状完全一致（但内部改走 `paper_items`，需要对比测试确认顺序一致） |
| `paper_id` 列 | **保留**，与 `paper_items` 双写过渡；第 2 期完成后停止写旧列，第 3 期确认无引用后考虑删 |
| 前端旧 JS | 新接口字段都是可选的，旧代码不受影响 |
| 现有测试 | api-test 83 项 / ui-test 182 项**必须全绿**；涉及改动的用例要**加断言钉住行为不变** |

### 9.4 主要风险与对策

| 风险 | 对策 |
|---|---|
| `paper_items` 回填后顺序与现状不一致 | `ORDER BY created_at, id` 与现状 SQL 一致；补一条断言「迁移前后同一卷的题序一致」 |
| 迁移脚本在几万题上超时 | 分批处理（每 1000 行一次 commit）+ 输出进度 |
| 改卷名同步 source 触发唯一索引冲突 | 先查重名，报 409 而不是 500 |
| 状态机上线后现有题目全是 draft 导致学生看不到 | **迁移时把存量题目默认置为 `published`**，只有新入库的才是 draft |
| 角色升级后 admin 账号权限丢失 | admin 保留全部权限项；补一条「admin 仍能访问所有接口」的断言 |
| 抽题 SQL 在大数据量下慢 | 先测；超过 1 秒则加 `question_hints` / `blank_count` 投影列 |
| `RANDOM()` 大数据量下性能差 | 抽题量级通常 ≤ 50 道，`ORDER BY RANDOM()` 可接受；若超 1s 改为「先按条件取 id 池，再随机洗牌」 |

---

## 10. 已确认的决策（2026-10-14）

### D1 · 难度维度：**先不建字段**

不往 `questions` 加 `difficulty`。组卷条件只放：**知识点标签 / 提示词类型 / 空格数 / 来源 / 篇数**。

理由：难度是主观判断，模型或人工给出的数字都不够可信，一旦进入组卷条件反而会误导筛选。
将来真有需求、且有可靠的标注流程了再加，届时抽题 SQL 只需加一个 WHERE 条件。

### D2 · 存量题目：迁移后全部置为 `published`

避免上线即「学生进去一道题都看不到」。审核机制只拦**新增**内容。
迁移脚本里存量题目统一写 `status='published'`，只有迁移后新录入的题才进 `draft`。

### D3 · 题级标签：只用「空标签并集」自动投影，不做人工维护

`question_tags` 由 `blanks_json` 里各空 `tagIds` 取并集自动生成（`origin='auto'`），
不提供人工给整题打标的入口。

理由：这保证了筛题口径与现有刷题页**完全一致**（`practice.js:211` 现在做的也是 `flatMap` 并集），
**零行为变化**；也避免维护两套可能互相矛盾的标签。
表里保留 `origin` 字段（固定 `auto`），将来若真需要人工打标不必改结构。

### D4 · 同一张卷：沿用现有的 trim + 精确匹配

不改 `ensure_paper_by_name()` 的匹配规则。AI 这次写 `2026-2027学年`、下次写 `2026-2027 学年`
仍会被视为两张卷 —— 这是已知的既有行为，本次不扩大改动范围。

> 后续若发现碎片卷变多，再单独提「归一化后比对」的改进（归一化规则：去首尾空白、全角转半角、
> 中文数字/阿拉伯数字统一、忽略「试卷/试题/测试卷」后缀差异）。

### D5 · AI 重新解析：**录入前实时预览 + 逐题勾选 + 重复项可单独取消**

这是本轮新增的核心需求，取代原设想的「同卷同原句自动存为新版本」。流程：

```
粘贴 AI 输出
   ↓
① 实时完整预览（尚未入库）
   ├─ 每题按「真实刷题页」渲染：原句（空位高亮）、每空的答案/提示词/标签/解析
   ├─ 页签切换：预览 / 校验结果 / 原始 JSON
   └─ 粘贴即渲染，无需点按钮
   ↓
② 标记每题为「新增」或「已存在」
   └─ 已存在判定：**原句（去空格、全半角与标点归一）+ 各空答案（trim 后有序）均一致**
   ↓
③ 每题一个勾选框
   ├─ 新增题：默认勾选
   └─ 重复题：默认不勾选
   ↓
④ 顶部汇总条「共 N 题：新增 X 题，已存在 Y 题（未勾选），将导入 Z 题」
   ↓
⑤ 点「确认导入这一卷」→ 只导入勾选中的
```

**要点**
- 勾选与预览共用一份数据，不做二次解析
- 重复题**不删除、不覆盖**，只是默认不勾选；用户想覆盖就勾上（覆盖行为沿用现有「整卷重录」语义）
- 卷名仍沿用现有规则：粘贴后自动填入卷名框、可改、为空拒绝导入
- 这个交互让 D4 的「精确匹配不够用」变得可接受：即使 AI 卷名有细微差异造成新卷，
  重复题也会被默认标出，你一眼能看到

### D6 · 交付顺序调整：预览区提前到第 1 期

原计划第 1 期只做检索筛选。既然「实时预览 + 勾选」是录入主路径的核心体验，
把它并入第 1 期，与题级标签投影、`paper_items` 一起落地。

### D5 的技术落点

| 能力 | 实现位置 |
|---|---|
| 预览渲染 | `php/views/admin-ai.php` 新增预览容器 + `php/assets/js/admin-ai.js` 的 `renderPreview()` |
| 归一化指纹 | 新增 `normalize_sentence_fingerprint()` 与 `question_fingerprint()`，前后端共用同一套规则（PHP + JS 各一份，**必须同源**） |
| 重复检测 | 后端新增 `POST /api/questions/check-duplicates`（传入题目列表，返回每题的指纹与库内命中 id），避免前端为了比对而全量拉库 |
| 勾选状态 | 复用现有 `pending` 机制，扩展为「题目 + 是否勾选」 |

**注意口径一致性**：指纹规则（去空格、全半角统一、标点忽略、答案有序比对）
必须在 PHP 与 JS 两端**完全一致**，否则预览显示「已存在」但入库时又变成新增。
建议把归一化规则写成一份文档，两端各实现一次并用同一组测试用例校验。

## 11. 实施记录

### 第 1 期（v3.5.0，2026-10-14）—— 已交付

**数据层**

| 改动 | 说明 |
|---|---|
| `questions` 加 5 列 | `fingerprint` / `publish_status` / `owner_id` / `content_hash` / `updated_at` |
| `question_tags` | 题级标签投影（空标签并集），可索引可 JOIN |
| `paper_items` | 试卷成员表（含 `section_no`），支持一题多卷 |
| 分批回填 | 每次 200 题、游标续跑；种子导入一并写派生数据 |

**接口层**

- `POST /api/questions/check-duplicates` —— 录入前查重（new / duplicate / diff）
- `GET /api/questions` 扩展 12 个筛选参数 + 分页 + 排序（不传 page 时行为不变）

**界面层**

- AI 录入的实时完整预览 + 逐题勾选 + 重复项默认不勾

**顺带修掉的既有问题**

改卷名不同步 source（含收藏迁移）、删标签不清理悬空引用、标签父级零校验、
种子数据缺派生数据、两条导入提示互相覆盖、导入后不自填卷名。

**实测踩到并记录在案的 5 个坑**（详见 CHANGELOG「实现中踩到的坑」一节）：

1. `EXPR >= ?` 与无亲和性的计算表达式比较**恒为假**（PDO 全按 TEXT 绑）→ 必须 `CAST`
2. `publish_status` 不能叫 `status`（与 `user_progress.status` 在 JOIN 里歧义）
3. 闭包 `use` 漏变量 → `isset($undefined[$k])` 静默返回 false → 曾把标签全删光
4. 同一预览的两次并发调用互相判过期 → 提交路径静默无反应 → 按文本合并在途请求
5. 回填必须分批（它在每个请求的 bootstrap 里跑）

**验证**：页面 182/182、接口 83/83、第 1 期接口 66/66、AI 预览 38/38、
指纹 PHP 35/35、指纹 JS 35/35（同一份用例集）、迁移 31/31、升级全过。

**下一期**：第 2 期（组卷蓝图与抽题）。届时需要先定「蓝图规则 UI 的复杂度」
—— 条件构造器做到什么程度，以及分篇布局是自动推导还是手工指定。

---

### 第 2 期（v3.6.0，2026-10-15）—— 已交付

**数据层**

| 改动 | 说明 |
|---|---|
| `papers.kind` | `original` / `generated`，存量卷靠列默认值自动落在 original 一侧，不需要回填 |
| `papers.blueprint_id` | 生成卷记来源蓝图，删蓝图时置空（卷保留） |
| `questions.blank_count` | 空格数索引副本，抽取 SQL 直接比较列（不解析 `blanks_json`） |
| `question_hints(question_id, hint_type)` | 提示词类型投影，与 `question_tags` 同理由 |
| `blueprints` | 蓝图（规则纯数据 `rules_json`） |
| `blueprint_runs` | 一次生成一行，记录抽了多少、缺哪些、是否降级；历史不覆盖 |

**接口**

| 接口 | 说明 |
|---|---|
| `GET/POST /api/blueprints` | 列表（含生成次数与最近一张卷）/ 新建 |
| `GET/PUT/DELETE /api/blueprints/{id}` | 详情（含 runs）/ 更新 / 删除（保留已生成的卷） |
| `POST /api/blueprints/preview` | 试抽：可传 `blueprintId` 或未保存的 `rules` 草稿 |
| `POST /api/blueprints/{id}/generate` | 生成；带 `paperId` 表示重新生成到那张卷 |
| `GET/PUT /api/papers/{id}/items` | 生成卷成员（按篇读 / 整体替换），只对 `generated` 开放 |
| `POST /api/papers/{id}/items/replace` | 换一题：蓝图条件 → 被换题标签 → 全库随机，三级兜底 |

**与设计文档的差异（落地时的取舍）**

1. **§4.3 的抽取 SQL 改为全索引版**：文档里给出的 SQL 含
   `EXISTS (json_each(...))`，并备注「先把 blank_count 与 question_hints 投影出来」。
   实际落地时把投影补齐了（`blank_count` 列 + `question_hints` 表），
   最终 SQL 不碰 JSON。
2. **`publishStatus` 由引擎自动补齐**：规则里没写时引擎追加
   `publishStatus = ['published']`，抽题永远不把草稿混进学生的卷子
   （与决策 D2 同一立场；显式传别的状态仍然被尊重）。
3. **分篇的 groupBy='tag' 用「主标签 = 题级标签里 id 最小的那个」**：
   没有按「最热标签」算，那样分篇结果不可复现。大知识点切块 + 贪心
   放进当前题数最少的篇，保证篇内均衡。
4. **成员编辑只开放给生成卷**：原始卷的成员由 `questions.paper_id` 派生，
   绕过它改 `paper_items` 会让两份数据打架，所以接口直接拒绝并说明去哪改。

**下一期**：第 3 期（修订历史与审核发布），需要先定角色升级的影响面
（`teacher` / `reviewer` 会让所有写接口都过一遍权限）。

---

## 附：本次诊断的关键事实来源

| 结论 | 证据 |
|---|---|
| 标签藏在 JSON、SQL 不可筛 | `routes_bank.php:200`（直接 `json_encode`）、`routes_bank.php:84-102`（唯一条件 `WHERE paper_id = ?`）、全库无 `LIKE`/`RANDOM()` |
| `tagIds` 服务端零校验 | `validate.php` 全文 grep 无 `tagIds`；校验仅存在于 `admin.js:438-445`、`admin-ai.js:702-709` |
| 两个标签统计口径打架 | `pages_admin.php:38-45`（按空）vs `practice.js:232`（按题 `some()`）vs `practice.js:211`（压平） |
| 改卷名不同步 source | `routes_papers.php:215-230` 只 UPDATE `papers.name`；收藏按 source JOIN `routes_records.php:215` |
| 删卷留下 source | `routes_papers.php:287` 只置 `paper_id = NULL` |
| 一题只能属一卷 | `questions.paper_id` 单值列；`routes_papers.php:319-327` 是 UPDATE 不是 INSERT |
| 无难度/题型/状态/更新时间/责任人 | `schema.sql:56-64` 字段清单 |
| 权限表 5 项零调用 | `auth.php:35-58` 声明 11 项，`grep require_permission` 仅命中 6 项 |
| 路由表零权限元数据 | `index.php:39-101`，42 条路由无权限字段 |
| 判卷纯前端、后端信任客户端 | `practice.js:158-166`；`routes_records.php:36-78` 直接取 `body_param('isCorrect')` |
| 判卷逻辑两份副本 | `practice.js:158-166` vs `paper-practice.js:58-72` |
| 无考试实体 | 全库无 `exam_sessions`/`exam_results`/限时/交卷 |
| 批量删是前端循环 | `admin-papers.js:243-245` |
| 导入的标签与题目分两事务 | `admin.js:578-580`、`:613-614` |
| `replaceAll` 同批 id 重复会整批回滚 | `routes_bank.php:166` DELETE + `:193` 裸 INSERT，无 `OR REPLACE` |
| tags 顺序依赖 id 字典序 | `tags` 表无 `sort_order`；`routes_bank.php:109` `ORDER BY id` |
| 上报失败静默降级不一致 | `practice.js:108-110`（仅 console.error）vs `paper-practice.js:87-95`（notifyWarn） |
| 题目列表无分页搜索 | `pages_admin.php:32` 全量渲染；全库唯一 `type="search"` 是标签搜索 `admin.js:227` |