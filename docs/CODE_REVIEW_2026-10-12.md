# 全链路审查报告

- 审查对象：高考英语短文填空穷举题库（`english-quiz`），提交 `HEAD` 共 39 次提交
- 审查时间：2026-10-12
- 审查范围：前端（Vite + React 18 + TS）→ HTTP → 后端（Express 4 + better-sqlite3）→ SQLite，含构建/部署脚本
- 结论口径：所有「确认」项均经代码定位或实际执行验证；标注「推测」的另行说明

> **修复状态（2026-10-12 同日）**：本报告列出的问题已全部处理，验证见文末「修复验证记录」。
> P3-4 的 react-router 升级已单独完成（commit 见 git log）：升到 7.18.4，
> 四项公告全部消除，并用真实浏览器过全部路由验证；见「react-router 7 升级验证记录」。
> 另：`npm audit` 尚余 2 项，均为 **esbuild/vite 的仅开发期漏洞**（dev server 相关，
> 构建产物不含 esbuild，生产部署不受影响；修复需 vite 大版本升级，建议单独立项）。

---

## react-router 7 升级验证记录（2026-10-12）

6.30.6 → 7.18.4。升级前盘点：项目仅使用声明式 API（`BrowserRouter / Link / NavLink /
Routes / Route / useLocation / useNavigate / useSearchParams`），在 7.x 中语义均未变化；
peer 要求 React≥18（本项目 18.3.1）。`engines: node >=20` 在 Node 18~21 的部署机上
只会产生 EBADENGINE 警告（npm 默认不拒绝安装），运行时是浏览器端代码，不受影响。

真实浏览器验证（Windows + Chromium，对真实 Express + dist，CSP 全程生效）：

| 检查 | 结果 |
|---|---|
| `/` 首页渲染 | 统计卡、最近录入、导航完整 |
| 客户端导航（点「刷题」） | 正常，题卡与输入框渲染 |
| 深链直达 `/practice`（全新文档加载） | 2 输入框 + 题卡，SPA 兜底正常 |
| 深链带中文 query `/practice?source=示例题1` | `useSearchParams` 正确取值，筛选生效 |
| 管理员登录 → `/admin`、`/admin/users`、`/admin/system` | 全部正常，版本号显示正确 |
| `/profile`、`/collection` | 正常 |
| 未知路径 `/no-such-page` | 「页面不存在」正常 |
| **控制台累计（整个遍历过程）** | **0 错误、0 警告**——CSP 下无任何违规 |
| `npm audit` | react-router 相关 4 项公告全部消除 |

顺带在真实浏览器里闭环验证了 P0-1（标签落库）：管理员在标签管理 UI 新增
「浏览器验证A」→ 服务端 42→43（`t_043`，挂在「动词」下）→ 刷新页面后仍在。
修复前该操作会被写权限门控静默吞掉。

「两个默认行为变化」的部署安全复验（Linux + Node 18，模拟已有部署升级）：

| 场景 | 结果 |
|---|---|
| 有数据 + 已有标记，重启 | `未导入（此前已导入过）`，数据不变 |
| 有数据但无标记（旧部署首次升级），重启 | `未导入（库中已有数据，跳过）`，未被注入，标记自动补齐 |

---


## 修复验证记录（同日补充）

在 WSL（Ubuntu + Node 18）干净副本上起真实服务，25 项断言全部通过：

| 分组 | 验证点 |
|---|---|
| P0-2 | 全新库启动自动导入 3 题 / 42 标签（启动日志可见）；清空后重启**不会**重新灌入（app_config 标记）；已有数据的库不被注入示例且标记自动补齐 |
| P1-1 | 同一账号连续失败 9 次后第 10 次 429，提示可读；其他账号不受影响 |
| P1-2 | `SQLITE_CONSTRAINT_UNIQUE → 409 数据已存在`、`SQLITE_BUSY → 503`（单元级） |
| P1-3 | 事务中途抛错后 `q_tx` 无残留（回滚生效） |
| P1-4 | `PUT /questions/:id` 空格数与 blanks 不一致被拒（400 + 详情）；合法字段更新 200 |
| P1-6 | 响应带 CSP 与 nosniff；默认无 `Access-Control-Allow-Origin` |
| P2-2 | 禁用账号后该 token 立即 401（会话缓存已同步失效） |
| P2-4 | `/records`、`/progress/:id` 指向不存在题目 → 404；正常提交 → 201 |
| P2-1 | 批量导入一次请求，重复 id `skipped:1` |
| 回归 | 管理员登录 / `/auth/me` / 标签全量覆盖 / 顶级分类保护 均正常 |

修复过程中端到端测试抓到一个**新引入**的 bug 并已修复：重写 `PUT /questions/:id`
时遗漏了 `values.push(id)`，导致合法更新直接 500（`RangeError: Too few parameter values`）。
这正是「每个修复点都要跑真实请求」的价值——纯靠读代码发现不了参数个数对不上。

前端部分（P0-1 标签落库、P0-3 首页统计、共用 hook、批量导入）经 `tsc --noEmit`
与生产构建验证，服务端链路（`PUT /api/tags`、批量导入）已由上述真实请求覆盖。

---


## 一、链路全景

```
浏览器
  │
  ├─ React 组件 (src/pages/*, src/components/*)
  │     └─ src/utils/storage.ts   题库读写：内存缓存(60s) + localStorage 副本 + 降级
  │     └─ src/utils/records.ts   作答记录：登录走后端，游客走 localStorage
  │     └─ src/auth/AuthContext   登录态：token 存 localStorage(eq_token)
  │            │
  │            └─ src/api/client.ts  统一 fetch，注入 Authorization: Bearer
  │
  ├─ HTTP: 相对路径 /api/*          （生产同域；开发由 Vite 代理到 :9185）
  │
  ▼
Express (server/src/index.js)
  ├─ cors() → compression() → express.json({limit:'2mb'})
  ├─ attachUser            每个请求解析 Bearer → 查 sessions+users
  ├─ /api/auth      注册/登录/登出/me/改密
  ├─ /api/admin     用户 CRUD、角色、状态、重置密码          [user:read / user:write]
  ├─ /api/*         records / progress / summary             [登录可选，游客静默忽略]
  ├─ /api/*         questions / tags 读(公开) 写(question:write)
  ├─ /api/*         favorites / marks                        [需登录]
  ├─ /api/system    version / check-update / update          [system:read / system:write]
  ├─ mountFrontend  express.static(dist) + SPA 兜底 (非 /api 的 GET → index.html)
  └─ errorHandler   统一错误出口
        │
        ▼
  db/pool.js  query/queryOne/execute/scalar + 参数归一化
        │        WAL / busy_timeout=5000 / foreign_keys=ON
        ▼
  server/data/english_quiz.db  (9 张表)
```

### 数据归属

| 数据 | 存储位置 | 隔离方式 |
|---|---|---|
| 题库、标签 | `questions` / `tags` | 全局共享，仅管理员可写 |
| 错次、掌握状态 | `user_progress` | `user_id` |
| 作答明细 | `practice_records` | `user_id` |
| 收藏、标记 | `user_favorites` / `user_marks` | `user_id` |
| 登录会话 | `sessions` | token，30 天 |
| 游客数据 | 浏览器 localStorage | 不上报 |

---

## 二、确认的问题（按优先级）

### P0-1 标签编辑从未写入服务端（静默丢数据）

**证据**

- `src/utils/storage.ts:30` `let canWrite = false;`
- `src/utils/storage.ts:194-198`
  ```ts
  export async function saveTags(dict: TagDictionary): Promise<void> {
    cacheTags(dict);
    if (!canWrite) return;      // ← 永远走到这里
    await api.saveTags(dict);
  }
  ```
- `setWritePermission()`（唯一能把 `canWrite` 置真）在全仓库**零调用点**（已 grep 全仓，仅 `storage.ts` 内定义）。
- 调用链：`Admin.tsx:127 persistTags` → `storage.saveTags` → 本地缓存后 return。

**后果**

标签管理页（改名、改色、停用、新增、删除）以及 AI 助手页的「创建这些标签」，全部只更新内存与 localStorage，**从不落库**。当次会话看不出问题，刷新页面即回退。更隐蔽的连带影响：AI 流程新建的标签只存在于本次会话，随后导入的题目带上了服务端并不存在的 `tagIds`，题目入库成功但标签渲染为空。

`PUT /api/tags` 这个接口（含「顶级分类不得减少」的保护逻辑）实际上从未被这条路径调用过。

**建议**

二选一，推荐后者：

1. 去掉门控，`saveTags` 直接 `await api.saveTags(dict)`。
2. 在 `AuthContext` 中按登录态调用 `setWritePermission(isAdmin)`，保留门控语义。

同时给 `Admin.tsx` 的 `persistTags` 补失败提示（当前 catch 存在，但因短路永不触发）。

---

### P0-2 全新部署题库与标签都是空的，且缺少恢复标签的 UI

**证据（实测）**

在全新数据库上执行 `ensureSchema()` 后：

```
users      1     ← 只有初始管理员
questions  0
tags       0
```

- `server/src/db/init.js:35` 的 `isEmptyBank()` 是**死代码**（无调用点）。
- `ensureSchema()` 只执行 `schema.sql`（建表 + `INSERT OR IGNORE` 管理员），不导入任何题目/标签。
- `src/pages/Admin.tsx:219-231` 的「恢复内置示例数据」只做 `replaceAllQuestions(SEED_QUESTIONS)`，**不含标签**。

**后果**

新服务器首次部署打开即是空题库；AI 提示词里的「可用标签清单」为空、筛选栏无标签、手动录题的 TagPicker 无可选项。唯一能同时恢复题目与 42 个标签的路径是「题库导入 → 浏览器题库上云」（依赖该浏览器 localStorage，否则回落到内置 seed），入口不直观。

**建议**

- 服务端启动时若 `isEmptyBank()` 则导入种子数据（把 `questions.json` / `tags.json` 作为种子随仓库提供，或内联到 `server/sql/seed.sql`），这本来就是 `isEmptyBank()` 的既定用途。
- 把「恢复内置示例数据」扩展为同时恢复标签，避免两条恢复路径行为不一致。

---

### P0-3 首页统计对登录用户恒为 0

**证据**

- `src/pages/Home.tsx:31-37` 直接用 `getQuestions()` 的结果算 `mastered` / `wrong`。
- 服务端 `bank.js:255-266 mapQuestion()` 对每道题硬编码 `status: "unmastered"`, `wrongCount: 0` —— 个人进度不在 `questions` 表上。
- 对比 `src/pages/Practice.tsx:81-105`：那里显式调了 `api.getProgress()` 并把结果合进 state。

**后果**

首页「已掌握」「错题数」永远显示 0，「最容易错的考点 Top 5」永远空。用户会以为记录丢了。

**建议**

把 Practice 里那段 progress 合并逻辑抽成共用 hook（如 `useQuestionsWithProgress()`），Home / Practice / Collection 共用，避免再次出现「一个页面合并了、另一个忘了」。

---

### P1-1 登录接口无速率限制

`server/src/routes/auth.js:47-79` 的 `/api/auth/login` 没有任何限流。bcrypt cost=10 能提高单次成本，但公网暴露时仍可被在线爆破，且每次请求都要跑一次 bcrypt（本身也是 CPU 放大点）。

**建议**：加进程内限流（按 `IP + username`，例如 10 次/分钟），失败计数超限返回 429。当前部署形态下前面有 WAF，但仍建议应用侧兜底。

---

### P1-2 错误中间件仍在判断 MySQL 错误码（已失效）

**证据（实测 better-sqlite3 抛出的 code）**

```
主键冲突 -> "SQLITE_CONSTRAINT_PRIMARYKEY"
UNIQUE   -> "SQLITE_CONSTRAINT_UNIQUE"
外键     -> "SQLITE_CONSTRAINT_FOREIGNKEY"
```

而 `server/src/middleware/error.js:11-19` 判断的是 `ECONNREFUSED` / `PROTOCOL_CONNECTION_LOST` / `ER_DUP_ENTRY` / `ER_` 前缀——都是 MySQL 时代遗留，**一个都匹配不上**。另外 `error.js:22` 的 `err.status && err.safeMessage` 分支在全项目中**无任何赋值点**。

**后果**：所有约束冲突（并发创建同名用户、双击收藏、并发标记）都会落到兜底分支返回 500「服务器内部错误」，而不是 409「数据已存在」。前端提示因此含糊。

**建议**：改用 `SQLITE_CONSTRAINT` 前缀判断并映射到 409；删掉 `ER_*` 与 `safeMessage` 死分支。

---

### P1-3 批量写库没有事务（有半途损坏风险）

- `server/src/routes/bank.js:94-124`：`replaceAll` 先 `DELETE FROM questions`，再逐条 `INSERT`，全程无事务。
- `server/src/routes/bank.js:220-226`：`PUT /tags` 先 `DELETE FROM tags`，再逐条 `INSERT`，同样无事务。

**后果**：任何一条 INSERT 抛错（磁盘满、进程被杀、极端数据），题库/标签已被清空但只写回一部分，且客户端只拿到 500。这是**不可逆的数据损坏**。

**建议**：用 `db.transaction(fn)` 包住整段（better-sqlite3 原生支持同步事务），并让 `pool.js` 暴露一个 `transaction()` 帮助函数。

---

### P1-4 `PUT /questions/:id` 绕过了服务端校验

`server/src/utils/validate.js` 的注释写着「入库前必须在服务端再校验一次，这是最后一道防线」，但**只有 POST 走 `validateBatch`**（`bank.js:85`）。`bank.js:139-174` 的 PUT 直接写 `source` / `blanks` / `originalSentence`，不校验 `blanks.length` 与原句 `______` 数量是否一致。

**后果**：管理员（或持有管理员令牌者）可以把 blanks 与原句不一致的脏数据写进库，Practice 渲染时按 `segments` 与 `blanks` 下标交错，会渲染错位。

**建议**：PUT 前用同一份 `validateQuestionData` 校验合并后的结果。

---

### P1-5 全量导入受 2MB 请求体上限约束

`server/src/index.js:46` `express.json({ limit: "2mb" })`，而前端两条上传路径都是**一次性提交整库**：

- `storage.ts:144-148 replaceAllQuestions()`
- `storage.ts:206-217 migrateLocalToServer()`

题库超过 2MB（约 1500～2000 题量级）即返回 413，前端只会显示「请求失败（413）」。

**建议**：提高上限（如 20mb）或改成分批提交（前端已有批量接口可复用）。

---

### P1-6 CORS 全开 + 令牌存 localStorage 且无 CSP

- `server/src/index.js:43` `app.use(cors())` 默认放行任意 Origin。当前鉴权走 `Authorization` 头、不依赖 Cookie，因此**不构成 CSRF，也不会被跨站读取 token**，风险等级不高；但同域部署本就不需要 CORS，属于多余暴露面。
- `src/api/client.ts:13` token 存 `localStorage`，TTL 30 天（`middleware/auth.js:5`），且页面未下发 CSP 头。经核实前端无 `dangerouslySetInnerHTML` / `innerHTML` / `eval`，XSS 面很小，但一旦出现 XSS 即等于会话失窃。

**建议**：生产去掉 CORS 或改白名单；给 `index.html` 响应加 `Content-Security-Policy: default-src 'self'`（注意内联引导页脚本需要 `'unsafe-inline'` 或改用 nonce，见 P3-2）。

---

### P1-7 `restartService()` 未监听子进程 error 事件

`server/src/routes/system.js:301-307`：

```ts
const child = spawn(PM2_BIN, ["restart", PM2_NAME], { detached: true, stdio: "ignore" });
child.unref();      // 没有 child.on("error", ...)
```

Windows 上 `pm2.cmd` 被直接 spawn 会 `EINVAL`，而 EventEmitter 的 `error` 事件无人接管会抛未捕获异常，**可能直接终止服务进程**。Linux 生产环境影响小（pm2 是带 shebang 的可执行文件），但这是零成本加固点。

**建议**：补 `child.on("error", (e) => log(...))`。

---

### P2-1 批量导入是 N 次串行 HTTP 请求

`src/utils/storage.ts:133-141`：

```ts
export async function appendQuestions(questions: Question[]): Promise<number> {
  for (const question of questions) {
    const result = await api.pushQuestion(question);   // 一道题一次往返
  }
}
```

服务端 `POST /api/questions` 已支持 `{ questions: [...], replaceAll }` 批量形态（`bank.js:64-136`），前端却没用。AI 一次导入 50 题 = 50 次串行请求，移动网络下体感明显。

**建议**：改为一次 `api.pushQuestions(questions, false)`，服务端已经做了「已存在 id 跳过」的处理。

---

### P2-2 `attachUser` 每个请求都查一次库

`server/src/middleware/auth.js:21-45`：每个 `/api/*` 请求都执行一次 `sessions JOIN users`。静态资源请求不带 Authorization，会在 `readToken` 后直接 `if (!token) return null`，**不产生查询**（这点是对的）。但页面加载时的并发接口（Practice 会打 progress + marks + favorites）各自查一次会话。

**建议**：加 token → user 的短 TTL（如 30s）内存缓存；改密/禁用/改角色时按 `user_id` 清缓存（`admin.js` 与 `auth.js` 已有多处强制下线逻辑，正好可挂清理）。

---

### P2-3 `sessions` 表只在启动时清理

`middleware/auth.js:74-76` 的 `purgeExpiredSessions()` 只在 `index.js:123` 启动时调用一次。`resolveUser` 用 `expires_at > datetime('now')` 过滤，功能没问题，但长期运行表会缓慢膨胀（本地库里已有 7 条残留会话即为佐证）。

**建议**：登录成功时顺带清理该用户过期会话，或加定时任务。

---

### P2-4 作答接口不校验 questionId 是否存在

`server/src/routes/records.js:11-49`（提交记录）与 `:55-76`（设置进度）都不校验题目是否存在；`user_progress.question_id` 也没有外键指向 `questions`。而标记路径（`collection.js:139-142`）是校验了的。

**后果**：可以写入指向不存在题目的孤儿进度/记录；删除题目后已有记录同样变孤儿（`practice_records` 无该外键）。

**建议**：要么在写入前校验存在性，要么接受孤儿但定期清理。当前危害很低，属一致性瑕疵。

---

### P2-5 本地 `server/node_modules` 缺 `compression`

`server/package.json:14` 声明了 `compression@^1.7.4`，`package-lock.json` 里也有，但本地 `server/node_modules/compression` **不存在**——实测 `import('compression')` 报 `ERR_MODULE_NOT_FOUND`。原因是在补加该依赖后本地没重跑 `npm install`。

**后果**：本地直接 `npm start`（或 `npm run dev:all`）会启动失败。**部署路径不受影响**（`deploy.sh` 会 `npm install`，WSL 端到端验证时是通过的）。

**建议**：本地执行一次 `cd server && npm install`。

---

### P3-1 死代码与未使用导出

| 位置 | 说明 |
|---|---|
| `server/src/db/init.js:35` | `isEmptyBank()` 未被调用（本是种子导入的判据，见 P0-2） |
| `src/utils/storage.ts:46,51` | `setWritePermission()` / `canWriteBank()` 无调用点（P0-1 根因） |
| `src/utils/storage.ts:227` | `clearCache()` 从未被调用——**登出时不清缓存**（`AuthContext.logout` 只清 token 与 user） |
| `src/constants/tags.ts:4` | `INITIAL_TAGS`（42 个标签）未被引用，实际种子走 `data/tags.json` |
| `server/src/middleware/error.js:14-23` | MySQL 错误码与 `safeMessage` 分支 |

**建议**：能接上的接上（`isEmptyBank`→种子导入、`setWritePermission`→登录态、`clearCache`→登出），纯冗余的直接删，减少误读。

`clearCache()` 接上登出还有一个实际好处：避免上一会话的内存缓存在切号后继续被 Home/Practice 复用。

---

### P3-2 引导页内联脚本与未来 CSP 的冲突

`index.html:95-122` 的部署引导页必须用内联 `<script>`（该故障态下任何联网加载的 JS 都跑不起来，这是硬约束，设计正确）。但一旦上 CSP（P1-6），内联脚本会被拦掉。二者需要一起考虑：给这段脚本加 nonce，或对 `/index.html` 单独放宽 `script-src 'unsafe-inline'`。

---

### P3-3 文案与行为不一致

- `src/pages/Home.tsx:72`：「数据保存在浏览器本地，可随时导出备份」——数据早已迁到服务端（SQLite），这句是异步化改造前的遗留。
- `server/sql/schema.sql:160-166` 硬编码 admin 哈希，而 `.env` 的 `ADMIN_USERNAME/PASSWORD` 仅在首次建表时生效（`INSERT OR IGNORE`），`create-admin.js` 也只 INSERT 不 UPDATE。改 `.env` 不会改已有管理员密码——这一点用户容易误解，建议在 README 与环境变量模板里各点一句。

---

### P3-4 依赖版本公告

- `react-router-dom@6.x`：`npm audit` 报 4 项（1 high / 3 moderate），含开放重定向（`<Link>` / `useNavigate` 中的反斜杠）与 SSR 期构造器注入。本项目无 SSR；所有 `navigate` 目标都是内部常量或 `encodeURIComponent` 后的查询串（`Collection.tsx:89`），实际风险很低。升级到 7.x 是 breaking change，建议单独立项排期，不与其他修复混做。
- 后端依赖：`npm audit` 报 0 项漏洞。

---

## 三、已验证为正常的部分（避免误改）

- **SQL 注入**：全部走参数绑定（`pool.js` 的 `query/execute` 统一 `prepare().all(...params)`），`bank.js:165` 的动态 `SET` 子句只拼接**白名单字段名**，值仍绑参。无注入面。
- **越权**：三层防护成立——前端路由守卫只是体验，接口层 `requirePermission`（deny by default）是真防线，SQL 按 `user_id` 归属。注册接口忽略客户端 `role`（`auth.js:34-38`）；管理员不能改自己角色 / 禁自己 / 删自己（`admin.js:117,147,193`）。`/api/admin/*` 在 router 层挂了 `user:read`，写操作再叠加 `user:write`。
- **命令执行面**：`system.js` 的 git / npm 命令全部写死、走 `execFile`、不接受任何请求参数；`GIT_TERMINAL_PROMPT=0` 防挂死。未发现注入路径。
- **密码**：bcryptjs cost 10；登录失败对「用户不存在」与「密码错误」返回同一文案（`auth.js:58-61`），不泄露账号是否存在。
- **判卷口径**：`QuizCard.tsx:37-39` 只 `trim()`、不做大小写归一，与服务端答案去重口径一致（`validate.js:80`）。符合「严格判分」的既定要求。
- **时间处理**：`datetime('now')` 为 UTC，`createSession` 写入的 `expires_at` 经 `convert()` 归一为同格式，`toIso()` 补 `Z` 解析——比较与展示一致，无时区错位。
- **前端 XSS 面**：无 `dangerouslySetInnerHTML` / `innerHTML` / `eval`。题目文本一律经由 React 文本节点渲染（`QuizCard` 逐段拼接），标签 pill 只把 `tag.color` 用作 `style.backgroundColor`。
- **更新回滚**：`system.js:313-405` 失败时 `git reset --hard` + 还原 `dist` 备份 + 重装依赖，路径完整。
- **构建/部署**：`deploy.sh` 幂等；不覆盖已有 `.env`；数据库用 `VACUUM INTO` 做一致性快照并保留 10 份；自检真读 `/api/questions` 与 `/practice`，能发现「进程活着但连不上库」的假成功。

---

## 四、改进建议汇总（按优先级）

| 优先级 | 问题 | 影响 | 建议动作 | 预估改动量 |
|---|---|---|---|---|
| **P0-1** | 标签编辑不落库 | 静默丢数据 | `saveTags` 去掉 `canWrite` 门控，或登录时 `setWritePermission(true)` | ~3 行 |
| **P0-2** | 新部署空库、无恢复标签入口 | 首启不可用 | 启动时 `isEmptyBank()` 则导入种子；「恢复示例数据」补标签 | ~40 行 |
| **P0-3** | 首页统计恒为 0 | 功能失效 | 抽 `useQuestionsWithProgress()`，Home 复用 | ~20 行 |
| **P1-1** | 登录无限流 | 可被爆破 | 加进程内限流中间件 | ~25 行 |
| **P1-2** | 错误码判断失效 | 提示含糊 | 改判 `SQLITE_CONSTRAINT*`，删死分支 | ~10 行 |
| **P1-3** | 批量写无事务 | 可致数据损坏 | `db.transaction()` 包住 replaceAll 与 tag 覆盖 | ~15 行 |
| **P1-4** | PUT 绕过校验 | 可写脏数据 | PUT 前跑 `validateQuestionData` | ~8 行 |
| **P1-5** | 2MB 请求体上限 | 大题量导入失败 | 提上限或分批 | ~10 行 |
| **P1-6** | CORS 全开、无 CSP | 暴露面 | 去 CORS / 白名单；加 CSP（配合 P3-2） | ~10 行 |
| **P1-7** | spawn 无 error 监听 | 潜在进程崩溃 | 补 `child.on('error')` | ~3 行 |
| **P2-1** | 逐题串行导入 | 导入慢 | 改用批量接口 | ~5 行 |
| **P2-2** | 每请求查会话 | 无谓查询 | token→user 短 TTL 缓存 | ~30 行 |
| **P2-3** | 会话表不清理 | 缓慢膨胀 | 登录时顺带清理 | ~5 行 |
| **P2-4** | 孤儿记录 | 一致性瑕疵 | 写入前校验或定期清理 | ~10 行 |
| **P2-5** | 本地缺 compression | 本地起不来 | `cd server && npm install` | 0 行 |
| **P3-1** | 死代码 | 易误读 | 接上或删除 | ~10 行 |
| **P3-2** | 内联脚本 vs CSP | 未来冲突 | 上 CSP 时一起处理 nonce | — |
| **P3-3** | 文案过时 | 误导 | 改 Home 文案 + README 补一句 | ~3 行 |
| **P3-4** | react-router 公告 | 低 | 单独立项升级 7.x | 排期 |

---

## 五、建议的推进顺序

1. **先做 P0 三项**——都是「用户可感知的功能已经坏了」，改动小、收益直接。其中 P0-1 和 P0-2 有耦合：标签不落库会让「新部署空标签」问题更难被发现，建议同批修。
2. **再做 P1-1 ~ P1-3**——安全与数据完整性，避免线上出不可逆事故。
3. **P1-4 ~ P1-7 + P2 若干**——加固与性能，可在同一批里顺手完成。
4. **P3 清理**——随相关改动一起做；`react-router` 升级单独排期。
