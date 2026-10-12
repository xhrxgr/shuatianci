# Node → PHP 迁移说明

后端由 Node/Express（1.x，**已删除**）重写为 PHP（2.0.0），
**页面结构、样式、交互、文案、业务流程与接口返回格式全部不变**。
前端（React + Vite）一行未改：它本来就是编译后的静态产物 `dist/`，由 nginx 直接托管，
后端换成什么语言对浏览器来说没有区别。

本文件保留 Node → PHP 的逐项对照，用于核对实现是否等价；1.x 的代码已不在仓库里，
需要对照可看 git 历史。

## 一、迁移映射

### 1.1 模块

| Node 版 | PHP 版 | 职责 |
|---|---|---|
| `server/src/index.js` | `php/index.php` | 建表 → 种子 → 安全头 → 登录态 → 路由分发 → 错误出口 |
| `server/src/db/pool.js` | `php/app/db.php` | PDO 连接、PRAGMA、query/queryOne/execute/scalar/事务 |
| `server/src/db/init.js` | `php/app/schema.php` 的 `ensure_schema()` | 执行同一份 `server/sql/schema.sql` |
| `server/src/db/seed.js` | `php/app/schema.php` 的 `seed_if_needed()` | 首启且库为空时导入 `src/data/*.json`，只导一次 |
| `server/src/auth/roles.js` | `php/app/auth.php`（roles/permissions 段） | 角色与权限清单，deny by default |
| `server/src/middleware/auth.js` | `php/app/auth.php`（会话段） | token 解析、会话创建/销毁 |
| `server/src/middleware/permission.js` | `php/app/auth.php` 的 `require_permission()` | 401 / 403 |
| `server/src/middleware/rateLimit.js` | `php/app/auth.php`（限速段） | 登录失败限速，按用户名 |
| `server/src/middleware/security.js` | `php/app/security.php` | CSP 等安全响应头、可选 CORS |
| `server/src/middleware/error.js` | `php/app/errors.php` | SQLite 错误码 → 状态码与中文文案 |
| `server/src/utils/validate.js` | `php/app/validate.php` | 题目校验（口径逐条一致） |
| `server/src/utils/date.js` | `php/app/util.php` 的 `to_iso()` | 库时间 → ISO |
| `server/src/routes/*.js` | `php/app/routes_*.php` | 见 1.2 |
| `server/src/web/frontend.js` | **不需要** | 前端改由 nginx 托管（见第三节） |
| `.env` | 同一个 `server/.env` | 配置单一来源，见 1.4 |

### 1.2 接口（26 个，路径 / 方法 / 字段 / 状态码逐条一致）

| 方法 | 路径 | PHP 处理函数 | 权限 |
|---|---|---|---|
| GET | `/api/health` | `route_health` | 公开 |
| POST | `/api/auth/register` | `route_auth_register` | 公开 |
| POST | `/api/auth/login` | `route_auth_login` | 公开（含限速） |
| POST | `/api/auth/logout` | `route_auth_logout` | 登录 |
| GET | `/api/auth/me` | `route_auth_me` | 登录 |
| POST | `/api/auth/change-password` | `route_auth_change_password` | 登录 |
| GET | `/api/admin/users` | `route_admin_users` | user:read |
| GET | `/api/admin/roles` | `route_admin_roles` | user:read |
| POST | `/api/admin/users` | `route_admin_users_create` | user:read + user:write |
| POST | `/api/admin/users/{id}/reset-password` | `route_admin_reset_password` | user:read + user:write |
| POST | `/api/admin/users/{id}/role` | `route_admin_change_role` | user:read + user:write |
| POST | `/api/admin/users/{id}/status` | `route_admin_change_status` | user:read + user:write |
| GET | `/api/admin/users/{id}/records` | `route_admin_user_records` | user:read |
| DELETE | `/api/admin/users/{id}` | `route_admin_user_delete` | user:read + user:write |
| POST | `/api/records` | `route_records_create` | 登录才落库，游客返回 `stored:false` |
| GET | `/api/records/summary` | `route_records_summary` | 同上 |
| GET | `/api/progress` | `route_progress_list` | 同上 |
| POST | `/api/progress/{questionId}` | `route_progress_set` | 同上 |
| GET | `/api/favorites` | `route_favorites_list` | 同上 |
| POST | `/api/favorites` | `route_favorites_toggle` | 登录 |
| GET | `/api/marks` | `route_marks_list` | 同上 |
| POST | `/api/marks` | `route_marks_toggle` | 登录 |
| GET | `/api/questions` | `route_questions_list` | 公开 |
| POST | `/api/questions` | `route_questions_create` | question:write |
| PUT | `/api/questions/{id}` | `route_questions_update` | question:write |
| DELETE | `/api/questions/{id}` | `route_questions_delete` | question:write |
| GET | `/api/tags` | `route_tags_list` | 公开 |
| PUT | `/api/tags` | `route_tags_save` | tag:write |
| POST | `/api/bank/reset` | `route_bank_reset` | question:write |
| GET | `/api/system/version` | `route_system_version` | system:read |
| POST | `/api/system/check-update` | `route_system_check_update` | system:read |
| POST | `/api/system/update` | `route_system_update` + `php/worker_update.php` | system:write |
| GET | `/api/system/update-status` | `route_system_update_status` | system:read |

### 1.3 前端页面路由（未改动，仍由 SPA 自己处理）

`/`、`/practice`、`/login`、`/profile`、`/collection`、`/admin`、`/admin/users`、`/admin/system`、`*`（页面不存在）。
这些是 react-router 的前端路由，nginx 只需要一条 `try_files ... /index.html` 兜底，
**不是**后端接口，PHP 侧没有对应代码。

### 1.4 数据表与配置

- **数据表：零改动。** PHP 读的是同一份 `server/sql/schema.sql`、同一个 `server/data/english_quiz.db`，
  表、索引、外键、初始管理员完全一样，**现有数据无需迁移**。
- **配置：同一个 `server/.env`**，PHP 用自写的解析器读取（不引入 Composer 依赖）。
  - 生效：`DB_FILE`、`SEED_ON_EMPTY`、`SEED_DIR`、`CORS_ORIGINS`、`CSP_POLICY`
  - 不再需要：`PORT`、`HOST`、`SSL_CERT`、`SSL_KEY`、`JSON_LIMIT`（由 PHP-FPM / nginx 控制）

## 二、不可避免的技术替换及理由

| 原实现 | PHP 实现 | 理由 |
|---|---|---|
| Express 路由 | `php/index.php` 自建路由表 | 不引入 Composer 依赖（要求 4）；路由只有 26 条，一个表就够 |
| better-sqlite3 | PDO + `pdo_sqlite` | PHP 标准扩展，宝塔默认开启 |
| bcryptjs | `password_hash` / `password_verify` | 同为标准 bcrypt，**已实测双向兼容**：PHP 能校验 Node 写的 `$2a$`，Node 也能校验 PHP 写的 `$2y$`，**已有账号密码无需重置** |
| dotenv | 自写 `read_env_file()` | 只有 `KEY=VALUE` 一种语法，不必为它装包 |
| 会话解析内存缓存 | 每次请求直接查库 | PHP 每个请求独立进程，没有跨请求内存。不缓存反而更安全：禁用账号后立即生效，不再依赖缓存失效 |
| 登录限速存内存 | 存 `php/data/login_throttle.json` + `flock` | 同上。用文件而不是新增表，是为了不改数据库结构 |
| 更新在进程内异步跑、状态存内存 | 后台 CLI 进程 + `php/data/update_state.json` | 同上。字段名与含义保持不变，前端轮询逻辑无需改动 |
| `pm2 restart` | 无需重启（PHP-FPM 每请求重载）；开启 opcache 时由 `/api/system/update-status` 消费标记文件刷新 | PHP 没有常驻进程 |
| **前端构建仍需 npm** | 保留 `npm run build` | React/Vite 无法用 PHP 构建。但 `dist/` 是纯静态产物，**运行时不需要 Node** |

## 三、部署（nginx + PHP-FPM）

> **时效说明**：本节描述的是 2.0.0 时期的形态（前端仍是 React 构建产物 `dist/`，
> 仅 `/api/` 交给 PHP）。**3.0.0 起前端也由 PHP 渲染，部署形态已变**——站点根指向
> `php/`，页面与接口共用同一入口；并且**必须**用 `=` / `^~` 写法的 deny 段挡住
> `app / views / seed / sql / tests / data` 与 `worker_update.php`、`dev-router.php`、
> `.env`（否则数据库可被 js/css 缓存正则截走、变成可公开下载的文件）。
> **当前部署配置以 README「部署到服务器」一节为准**；下面的配置块仅作历史参考。

站点根目录仍指向 `dist/`，只额外把 `/api/` 交给 PHP：

```nginx
server {
    listen 2027;
    server_name example.com;
    root /www/wwwroot/项目目录/dist;
    index index.html;

    # 前端：静态资源 + SPA 路由兜底
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 接口：交给 PHP-FPM（sock 路径按服务器实际 PHP 版本调整）
    location /api/ {
        try_files $uri /php/index.php;
        include fastcgi.conf;
        fastcgi_pass unix:/tmp/php-cgi-82.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME /www/wwwroot/项目目录/php/index.php;
        fastcgi_read_timeout 120s;
    }
}
```

要点：

1. `SCRIPT_FILENAME` 必须写**绝对路径**指向 `php/index.php`。
2. `php/data/`（数据库、WAL、限速状态、更新进度）**必须可写**，属主一般是 `www`。
3. PHP 需启用 `pdo_sqlite` 扩展（宝塔默认已开）。
4. Node 实现已在 2.0.0 删除，需要回退请用 git 历史里的 1.x 版本（表结构与数据完全兼容，直接把 `.db` 复制回去即可）。

## 四、本地启动与验证

### 4.1 启动

```bash
# 3.0.0 起没有任何构建步骤，直接起服务（内置服务器，仅用于本地验证）
cd 项目目录
DB_FILE=data/test_php.db php -S 127.0.0.1:9001 php/dev-router.php
```

`php/dev-router.php` 是**本地验证专用**的路由脚本（`/api/*` 交给 index.php，
`/assets/*` 直出静态文件，其余渲染页面），生产环境由 nginx 完成这三件事。
它和 `worker_update.php` 都带 SAPI 守卫：非本机开发场景（nginx + PHP-FPM）
访问会直接返回 403。

### 4.2 自测

```bash
node php/tests/api-test.mjs http://127.0.0.1:9001
```

覆盖 60 项断言：登录/注册/改密/登出、权限 401/403、限速 429、题库增删改与校验、
标签保护、进度、记录统计、收藏、标记、用户管理、系统接口、404。

### 4.3 与 Node 版逐字节对比

```bash
node php/tests/api-test.mjs http://127.0.0.1:9185 --out /tmp/node-result.json   # Node 版
node php/tests/api-test.mjs http://127.0.0.1:9001 --out /tmp/php-result.json   # PHP 版
```

两份输出会把 token、时间、自增 id、git 提交号等**动态值归一化**，可直接 diff。
实测结果：**22 个接口快照逐字节一致，两边各 60 项断言全过。**

## 五、需要人工确认的兼容性 / 环境差异点

| # | 差异 | 影响 | 需要你确认的事 |
|---|---|---|---|
| 1 | PHP 版本 | 代码按 7.4+ 语法编写（不使用 8.0+ 独占语法），实测 8.3.33 | 服务器 PHP 版本 ≥ 7.4 即可；宝塔一般默认 7.4/8.0/8.1/8.2 |
| 2 | `pdo_sqlite` 扩展 | 没有它数据库完全不可用 | 宝塔「软件商店 → PHP → 安装扩展」里确认已装 |
| 3 | `exec` / `proc_open` / `shell_exec` | 在线更新依赖它们；被 `disable_functions` 禁用时，更新接口会提示「无法启动后台更新进程」，但**站点其它功能不受影响** | 是否要用「网页一键更新」；不用则可忽略 |
| 4 | 服务器上的 git 与凭据 | 检查更新 / 执行更新需要项目是 git 仓库且凭据已配置 | 若不需要在线更新，可忽略（接口会返回可读的提示文案） |
| 5 | 服务器上的 npm | 前端构建产物 `dist/` 只能由 npm 生成。更新时检测到没有 npm 会跳过构建并写进日志 | 若 npm 不可用，需在有 Node 的机器上 `npm run build` 后上传 `dist/` |
| 6 | 未定义的 `/api/*` 路径 | Node 版会 SPA 兜底返回 `index.html`（200），PHP 版返回 `404 {"error":"接口不存在"}` | 这是**有意收紧**：返回 HTML 会让前端 `response.json()` 失败、报「网络连接失败」，404 JSON 更准确。若你要求严格一致，我可以改成返回 index.html |
| 7 | `php/data/` 目录权限 | 限速与更新状态要写这里 | 属主与 PHP-FPM 运行用户一致（一般 `www`），或 755/775 |
| 8 | opcache | 开启后代码更新不会立即生效 | 已处理：`/api/system/update-status` 会消费标记文件并 `opcache_reset()`。若你手动改代码不生效，重启 PHP-FPM 即可 |
| 9 | 请求体大小 | Node 用 `JSON_LIMIT=20mb` | PHP 侧由 `post_max_size` 控制，建议 ≥ 20M（题库是整库一次性提交，太小会 413） |
| 10 | 时间口径 | 库里是 UTC（`datetime('now')`），对外转 ISO | 与 Node 版一致；PHP 服务器时区设置不影响，代码内部全部按 UTC 处理 |

## 六、实测记录

- 环境：PHP 8.3.33（Windows，仅本地验证用）、Node 22（跑测试脚本与 Node 版对照）
- 建库：全新空库自动建表 + 导入 3 道示例题、42 个标签
- 登录：`admin / 123456` 直接用 Node 写入的 `$2a$` 哈希登录成功
- 断言：Node 版 60/60，PHP 版 60/60
- 对比：22 个接口快照逐字节一致（动态字段归一化后）
