# 高考英语短文填空穷举题库

服务端题库 + 刷题 + 错题本，支持多设备、多用户。
当前版本 **3.3.1**（更新记录见 [CHANGELOG.md](CHANGELOG.md)）。

## 快速导航

| 我想… | 去看 |
|---|---|
| 本地跑起来 | [快速开始](#快速开始本地开发) |
| 部署到服务器 | [部署到服务器](#部署到服务器) |
| 从旧版本升级 | [从 2.x / 1.x 升级](#从旧版本升级) |
| Node 换成 PHP 的细节 | [docs/PHP_MIGRATION.md](docs/PHP_MIGRATION.md) |
| 发版流程 | [发版](#发版) |

## 功能

**刷题**

- 五种模式：全部题目、错题本、已掌握、我的标记、我的收藏
- 两级筛选：先按提示词类型（给动词 / 给名词 / 给形容词 / 给副词 / 无提示词）缩小范围，再按 42 个知识点标签细分，多标签取交集
- 回车跳到下一个空，最后一个空回车直接提交
- 判卷严格：区分大小写，仅忽略首尾空格，与高考判分口径一致
- 提示词按真题排版渲染，紧跟在空格后（`______ (hint)`），无提示词就只显示空格
- 提交后展开「出题人视角解析」，含每空的答案、标签与陷阱分析
- 筛选栏实时显示每个标签的命中数量，无命中的标签自动禁用
- 可一键随机打乱刷题顺序，再次点击恢复原顺序
- 收藏本卷、标记本题（标记可写类型与备注），仅自己可见

**题库管理**（仅管理员）

- 手动精录：填入原句后按 `______` 自动拆解空位，逐空配置答案、提示词类型、标签与解析，右侧实时预览
- 试卷管理：一套试卷 = 一次考试。录题时填写相同的试卷来源即自动归卷；
  试卷可设考试日期、加备注，首页按日期倒序显示最近三套
- 两种做题方式：**整卷做**（一题一屏按顺序做，最接近考试状态，带答题卡与小结）
  与**自由刷**（进刷题页按卷筛选，可打乱、按标签筛）
- 题目编辑：题库管理里可逐题改原句、答案、提示词类型、标签与解析；
  也可多选批量改归属试卷或删除
- AI 助手：一键复制提示词（已内置当前全部标签 id）。把**卷子封面图与题目页图一起**发给 AI，它按句切分成独立题目、并从封面读出试卷来源，一并写进返回的 JSON；粘回后校验并**增量入库**
- 题库导入导出：打包导出全部数据，导入时自动做版本升级，支持恢复内置示例数据
- 标签管理：重命名、改色、启用停用、新增子标签

**账号与统计**

- 用户名 + 密码注册登录，服务端会话，支持退出与登录态保持
- 游客可直接刷题，记录只存本机；登录后记录入库，可查正确率与错题排行
- 收藏与标记为个人私有，只有自己看得到
- 管理员可管理用户、重置密码、调整角色
- 角色与权限解耦，新增角色只改一个文件

**系统设置**（仅管理员）

- 查看当前部署的版本（提交号、分支、提交时间与说明）
- 在网页上检查是否有新版本，列出待更新的提交
- **一键更新**：在网页上完成拉取与生效，无需登录服务器（前端是 PHP 渲染，没有构建步骤）
- 更新失败自动回滚到原版本，站点不会中断

## 数据存放

| 数据 | 存放位置 | 说明 |
|---|---|---|
| 题库、标签 | **服务端 SQLite** | 所有设备共用一套，跨设备一致 |
| 做题记录 | 服务端 SQLite | 按用户隔离 |
| 错次、掌握状态 | 服务端 SQLite | 按用户隔离，每个人有自己的错题本 |
| 试卷收藏、题目标记 | 服务端 SQLite | 个人私有 |
| 游客作答 | 浏览器本地 | 不入库，不会上报 |

数据库就是 `php/data/english_quiz.db` 一个文件，**不需要安装数据库服务**，备份直接复制它。

只有管理员能修改题库（录题、改题、删题、改标签）；所有人读取题库并刷题。

## 技术栈

| 层 | 选型 |
|---|---|
| 页面 | **PHP 服务端渲染**（`php/views/*.php`），首屏数据直接查库 |
| 交互 | **原生 JavaScript**（ES module，浏览器直接加载，不打包，无构建步骤） |
| 样式 | Tailwind CSS 的编译产物 `php/assets/app.css`（样式源在 `styles/app.css`） |
| 后端 | **PHP 7.4+**（PDO + pdo_sqlite，零 Composer 依赖） |
| 数据库 | SQLite（嵌入式单文件） |
| 鉴权 | bcrypt 密码哈希 + 服务端会话 token |

页面由 PHP 渲染后直接返回 HTML，样式与脚本是 `php/assets/` 下的静态文件。

> **整站运行时不需要 Node，也没有任何构建步骤**：
> 改 PHP 或 JS 保存即生效，只改样式时直接编辑 `php/assets/app.css` 也能用。

> 与 2.x（Node 后端 + React 前端）相比，本项目现在只有一套实现：PHP。

## 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| PHP | **≥ 7.4**（实测 8.3） | 需启用 `pdo_sqlite` 扩展 |
| Node.js | **不需要** | 只有「改样式（重新生成 CSS）」和「跑测试脚本」时才用得上 |

**不需要数据库服务**（SQLite 是嵌入式单文件），**不需要进程管理器**（PHP-FPM 由系统托管）。

## 目录结构

```
├── php/
│   ├── index.php            唯一入口：/api 返回 JSON，其余渲染页面
│   ├── worker_update.php    在线更新的后台进程
│   ├── dev-router.php       本地开发用的路由脚本（生产环境不需要）
│   ├── app/                 配置 / 数据库 / 鉴权 / 校验 / 路由与数据处理
│   ├── views/               页面模板（PHP 渲染）
│   ├── assets/              前端静态资源：app.css 与原生 JS（浏览器直接加载）
│   ├── seed/                内置示例数据（questions.json / tags.json）
│   ├── sql/schema.sql       建表脚本（首次运行自动执行）
│   ├── data/                数据库与运行时状态（不入库到 git）
│   └── tests/               接口自测与页面交互自测
├── styles/app.css           样式源（Tailwind；`npm run build:css` 生成上面的 app.css）
├── docs/                    设计与迁移文档
├── VERSION                  当前版本号
└── CHANGELOG.md             更新记录
```

## 快速开始（本地开发）

**1. 启动**

```bash
php -S 127.0.0.1:9001 php/dev-router.php
```

浏览器打开 http://127.0.0.1:9001 ，用 `admin / 123456` 登录（**登录后请立即改密码**）。

首次启动会自动建表，并导入 3 道示例题与 42 个标签字典。**没有构建步骤**——
页面由 PHP 渲染，样式与脚本已经是现成的静态文件。

**2. 改代码**

- 改页面文案与结构 → `php/views/*.php`，刷新即生效
- 改交互 → `php/assets/js/*.js`，刷新即生效
- 改后端接口 → `php/app/*.php`，刷新即生效
- 改样式 → 直接编辑 `php/assets/app.css`（纯 CSS，改完刷新即可）；
  有 Node 时也可以改 `styles/app.css` 再执行 `npm run build:css` 重新生成

**3. 跑测试**（可选，需要 Node）

```bash
# 接口自测 60 项
DB_FILE=data/test_api.db php -S 127.0.0.1:9001 php/dev-router.php &
npm run test:api

# 页面交互自测 81 项（需 playwright-core + 本机浏览器）
# 断言依赖干净状态：必须用全新的库，不要与上面的服务共用
rm -f php/data/test_ui.db*
DB_FILE=data/test_ui.db php -S 127.0.0.1:9002 php/dev-router.php &
npm run test:ui
```

## 局域网访问

放行防火墙端口即可（本地开发用的 9001）：

```powershell
New-NetFirewallRule -DisplayName "english-quiz" `
    -Direction Inbound -Protocol TCP -LocalPort 9001 -Profile Private,Public -Enabled True
```

同网段设备访问 `http://<你的内网IP>:9001`。开发服务器没有鉴权，仅适合可信局域网使用。

## 录题流程

题库存在服务端，只有管理员能改。两种方式：

### 方式一：AI 助手（推荐）

1. 进入「题库管理 → AI 助手」，点「复制提示词」
2. 打开任意支持图片的 AI 工具，粘贴提示词，并发送**两张图**：
   - 卷子封面图（强烈建议发送，AI 会从中读出学校、学期与考试名，作为试卷来源）
   - 题目页图片（一整段语篇，通常带 56、57 这样的题号）
3. AI 会按句切分成独立题目并返回 JSON。返回格式是
   `{ "source": "试卷名", "questions": [题目, 题目, …] }`：
   **试卷名整批只给一次**（写在questions 前面），同一批题目都归这张卷子；
   同一句里的几个空放在一起，题号不会写进原句
4. 把 JSON 粘回网页，点「解析并入库」
   （试卷来源已由 AI 写入 JSON，无需再填；只有需要覆盖时才手动填写该输入框）
5. 校验通过后增量追加到题库，不影响已有题目

题目编号**不需要 AI 给**，粘贴的 JSON 里有没有 `id` 都能导入——编号由系统在入库前统一生成。
（外部 AI 无从得知题库里已有哪些编号，每次都会从 `q_0001` 重新数，采信它反而会撞号。）

**格式问题页面会自动修正**，不必手工改 JSON：

- 原句里的英文直引号 `"` —— 会自动换成中文引号 `“ ”`（英文直引号会提前结束 JSON 字符串）
- 卷面题号被当成空格（`The 56 (fashion) sportswear`）—— 会自动替换为 `______`
  （年份如 4700、2900、21st century 不会被误改）
- 以上修正在导入成功的提示里会告诉你做了什么

真正无法自动修正的问题（例如原句与空格数量对不上），页面会逐条列出具体位置。

若 AI 输出了字典里没有的标签，页面会提示你确认创建。

### 方式二：手动精录

1. 进入「题库管理 → 手动精录」
2. 粘贴原句，空格用 6 个下划线 `______` 表示
3. 页面自动拆解空位并提取括号里的提示词，逐空配置答案、提示词类型、标签与解析
4. 右侧实时预览排版效果，确认无误后保存

提示词类型需要人工确认——系统能从括号里读出提示词原文，但判断它是「给动词」还是「给名词」需要看句子结构。

### 旧数据迁移

浏览器里原有的题目会自动保留在本机。到「题库管理 → 题库导入 → 浏览器题库上云」点一次，即可整体上传到服务端并覆盖。

## 页面路由

| 路径 | 说明 | 访问权限 |
|---|---|---|
| `/` | 首页：题库统计与最近录入 | 公开 |
| `/practice` | 刷题，支持 `?source=` 指定卷子 | 公开 |
| `/login` | 登录 / 注册 | 公开 |
| `/profile` | 个人中心：统计、改密码 | 公开（游客显示本机记录） |
| `/collection` | 我的收藏与标记 | 公开（游客提示登录） |
| `/admin` | 题库管理 | 仅管理员 |
| `/admin/users` | 用户管理 | 仅管理员 |
| `/admin/system` | 系统设置：查看版本、检查更新、一键更新 | 仅管理员 |

## 部署到服务器

**只需要 PHP + nginx（或宝塔面板 + PHP）。不需要 Node、不需要数据库服务、不需要进程管理器。**

### 三步

```bash
# 1. 拉取代码（公开仓库直接克隆；私有仓库提示输入时填用户名 + 令牌）
git clone https://github.com/xhrxgr/shuatianci.git
cd shuatianci

# 2. 配置 nginx：站点根指向 php/ 目录（配置见下）
#    没有构建步骤，也不需要装 Node

# 3. 检查三件事并验证（见下方小节）
```


nginx 配置（sock 路径按服务器实际 PHP 版本调整）：

```nginx
server {
    listen 2027;
    server_name example.com;

    # 站点根指向 php/：静态资源在 php/assets，入口是 php/index.php
    root /www/wwwroot/项目目录/php;
    index index.php;

    charset utf-8;

    # 静态资源（CSS / JS）由 nginx 直接吐
    location /assets/ {
        expires 7d;
    }

    # 其余请求全部交给入口：/api/* 返回 JSON，其他路径渲染页面
    location / {
        try_files $uri /index.php?$query_string;
        include fastcgi.conf;
        fastcgi_pass unix:/tmp/php-cgi-82.sock;      # 按服务器实际 PHP 版本调整
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME /www/wwwroot/项目目录/php/index.php;
        fastcgi_read_timeout 120s;
    }

    # ---- 必加：保护后端源码、数据库与内部脚本 ----
    # 必须用 = 与 ^~ 写法：它们的优先级高于所有正则规则。
    # 若写成 location ~ 正则形式，会被面板自动生成的 js/css 缓存正则
    # 或 PHP 处理正则抢先，导致 data/english_quiz.db 等文件可被直接下载。
    location = /.env              { deny all; }
    location = /worker_update.php { deny all; }
    location = /dev-router.php    { deny all; }
    location ^~ /app/   { deny all; }
    location ^~ /views/ { deny all; }
    location ^~ /seed/  { deny all; }
    location ^~ /sql/   { deny all; }
    location ^~ /tests/ { deny all; }
    location ^~ /data/  { deny all; }
}
```

> **宝塔 / 面板环境**：面板已经配好了 PHP 处理（`include enable-php-00.conf;`），
> 上面整段可以简化——把下面两块直接填进站点的「伪静态」框（下拉选「自定义」）即可，
> 不需要碰主配置文件，也不用填 sock 路径：
>
> ```nginx
> location / {
>     try_files $uri /index.php?$query_string;
> }
>
> location = /.env              { deny all; }
> location = /worker_update.php { deny all; }
> location = /dev-router.php    { deny all; }
> location ^~ /app/   { deny all; }
> location ^~ /views/ { deny all; }
> location ^~ /seed/  { deny all; }
> location ^~ /sql/   { deny all; }
> location ^~ /tests/ { deny all; }
> location ^~ /data/  { deny all; }
> ```
>
> 两个要点：
> 1. **`location /` 是页面与接口的兜底**。缺了它，`/login`、`/practice`、`/api/*`
>    这类"不是真实文件"的路径会被 nginx 当文件找、直接 404（首页能开是因为
>    `index index.php` 让 `/` 恰好命中了入口）。
> 2. **`deny` 段负责挡住后端源码和数据库**。这里必须写 `=` / `^~`——它们是
>    "最高优先级"匹配，否则请求会被面板自动生成的 js/css 缓存正则截走，
>    `data/english_quiz.db`（含全部账号密码哈希）就成了人人可下载的文件。

改完 `nginx -t && nginx -s reload`，然后：

```bash
curl -s http://127.0.0.1:2027/api/health      # 应返回 {"ok":true,"time":"..."}
```

浏览器打开站点，用 `admin / 123456` 登录，**第一件事是改掉默认密码**。

### 必须确认的三件事

1. PHP 已启用 `pdo_sqlite` 扩展
2. `php/data/` 可写（数据库、限速状态、更新进度都在这里）
3. `post_max_size` ≥ 20M（题库是整库一次性提交，太小会 413）

### 环境变量

配置在 `php/.env`（找不到时回退到项目根 `.env`）。全部都有默认值，**一般不用建这个文件**：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DB_FILE` | 否 | `data/english_quiz.db` | 数据库路径，相对 `php/` 目录 |
| `CORS_ORIGINS` | 否 | 空（关闭） | 同域部署不需要；跨域时显式声明来源 |
| `CSP_POLICY` | 否 | 内置策略 | 设为 `off` 可关闭 CSP |
| `SEED_ON_EMPTY` | 否 | `1` | 首次且库为空时是否导入示例题与标签 |
| `SEED_DIR` | 否 | `php/seed/` | 种子数据目录（内置示例题与标签） |

### 从旧版本升级

#### 从 2.x（Node 后端 + React 前端）升级到 3.0.0

3.0.0 把前端也改成了 PHP 渲染，**部署形态变了**：站点根从 `dist/` 换成 `php/`。

```bash
cd 你的项目目录

# 1. 拉取新代码。提交历史重写过，必须用 reset 而不是 pull
git config --global --add safe.directory "$(pwd)"   # 只有报 dubious ownership 时才需要
git fetch origin && git reset --hard origin/master

# 2. 迁移旧数据（之前跑起来过才会有 server/data/）
mkdir -p php/data
cp server/data/english_quiz.db php/data/english_quiz.db 2>/dev/null || echo "没有旧库，跳过"
chmod -R 755 php/data

# 3. 改 nginx：站点根改成 php/（配置见上面「部署到服务器」一节）
#    改完执行：nginx -t && nginx -s reload
```

验证：`curl -s http://127.0.0.1:2027/api/health` 返回 `{"ok":true,...}`。

**顺带可以清掉旧进程**：3.0.0 起运行时不需要 Node，也不用 pm2：

```bash
pm2 delete english-quiz-api 2>/dev/null || true
rm -rf server deploy.sh scripts
```

#### 从 1.x（Node 后端）升级

同样两步，区别是旧数据与配置在 `server/` 下：

```bash
git fetch origin && git reset --hard origin/master
mkdir -p php/data
cp server/data/english_quiz.db php/data/english_quiz.db
cp server/.env php/.env 2>/dev/null        # 改过配置才有这个文件
rm -rf server deploy.sh scripts
```

账号密码、题库、做题记录全部保留，不需要重置或转换。

## 更新与维护

### 方式一：网页一键更新（推荐）

管理员进「系统设置 → 检查更新 → 立即更新」，后台会依次完成：
拉代码 → 刷新 PHP 缓存，失败自动回滚（v3.0.0 起没有构建步骤）。

**首次使用前要做三项配置**（只做一次，之后每次更新都能直接点按钮）：

**① 解禁两个 PHP 函数**——面板默认禁用了它们，禁着就无法执行 git：
宝塔 → 软件商店 → PHP-8.x → 设置 →「禁用函数」→ 移除 `proc_open` 和
`proc_get_status` → 保存。

**② 把项目目录交给 PHP 的运行用户**（宝塔上是 `www`）——否则 PHP 进程改不动
代码和 `.git`：

```bash
cd /www/wwwroot/项目目录
chown -R www:www .
```

**③ 配置远端地址**——PHP 进程无法交互式输入账号密码，也不一定有 SSH 密钥，
因此远端必须用 **HTTPS** 形式（`git@github.com:` 开头的 SSH 地址一律要改，
否则会报 `Permission denied (publickey)`）。

**公开仓库**：不需要任何凭据，直接用匿名地址：

```bash
cd /www/wwwroot/项目目录
git remote set-url origin https://github.com/xhrxgr/shuatianci.git
git remote -v    # 应显示 https://github.com/xhrxgr/shuatianci.git
```

**私有仓库**：令牌必须写在 URL 里。把下面命令里的「你的令牌」替换成令牌后再执行
（**不要用尖括号当占位符**——bash 会把 `<` `>` 当成输入重定向，
报 `bash: 用户名: No such file or directory`，命令会静默不执行）：

```bash
cd /www/wwwroot/项目目录
git remote set-url origin "https://xhrxgr:你的令牌@github.com/xhrxgr/shuatianci.git"
git remote -v    # 确认地址已更新（令牌会明文显示，属正常）
```

私有仓库的令牌在 GitHub → Settings → Developer settings → Personal access tokens 生成
（classic 勾 `repo`；建议用 fine-grained 只给这一个仓库的 Contents 只读权限）。
配完以 `www` 身份验证一次，能拉到就全通了：

```bash
sudo -u www git -C /www/wwwroot/项目目录 fetch origin --prune && echo "OK"
```

更新完不需要构建、也不需要重启服务（PHP-FPM 每次请求都重新加载代码）。
若某一步没配好，「检查更新 / 立即更新」会给出对应的中文提示，按提示补配即可。

### 方式二：命令行更新

```bash
git fetch origin && git reset --hard origin/master
```

PHP-FPM 每次请求都会重新加载代码，**不需要重启服务**。
若开了 opcache 且改完没生效，重启 PHP-FPM，或访问一次
`/api/system/update-status`（会自动刷新 opcache）。

### 数据备份与恢复

每次网页更新会自动备份数据库到 `php/data/backups/`（保留 10 份）。手动备份就是复制文件：

```bash
cp php/data/english_quiz.db php/data/backups/english_quiz-$(date +%Y%m%d-%H%M%S).db
```

恢复：

```bash
# 先停掉写入（面板里停用站点，或确保无人使用）
rm -f php/data/english_quiz.db-wal php/data/english_quiz.db-shm
cp php/data/backups/<选一个备份>.db php/data/english_quiz.db
```

表结构变更不会自动执行，需要手动 `ALTER TABLE`——这正是每次更新都自动备份的原因。

## 角色与权限

角色与权限解耦，都在 `php/app/auth.php` 的 `permissions_map()`：

- 角色：`admin` / `user`
- `has_permission($role, $permission)`：唯一判断入口

判断采用 **deny by default**——权限表里未声明的角色一律无权限。
新增角色只改这一个函数，路由里用 `require_permission("xxx")` 声明式保护，不需要改接口代码。

访问控制分三层，前端守卫只挡住页面，**真正的防线在服务端**：

| 层面 | 位置 | 作用 |
|---|---|---|
| 前端路由守卫 | `src/App.tsx` 的 `RequireAdmin` | 页面级提示 |
| 接口权限校验 | `php/app/auth.php` 的 `require_permission()` | 绕过前端直接调接口也拦得住 |
| 数据归属 | SQL 的 `user_id` | 用户只能读写自己的记录 |

## 数据结构

九张表，建表见 `php/sql/schema.sql`。**后端首次运行自动建表**，无需手动导入：

| 表 | 用途 |
|---|---|
| `users` | 用户，`role` 区分角色，`password_hash` 存 bcrypt 哈希 |
| `questions` | 题库，`blanks_json` 存各空配置的 JSON 文本 |
| `tags` | 知识点标签，两级结构，`parent_id` 为 NULL 表示顶级分类 |
| `user_progress` | 学习进度，`user_id + question_id` 唯一，记录个人错次与掌握状态 |
| `practice_records` | 做题记录，删用户级联删除 |
| `user_favorites` | 试卷收藏，`user_id + source` 唯一 |
| `user_marks` | 小题标记，含类型与备注 |
| `sessions` | 服务端会话，退出登录即删除，改密 / 禁用 / 重置密码会强制其他设备下线 |
| `app_config` | 系统配置（记录种子数据是否已导入） |

题目的错次与掌握状态**不在** `questions` 表上，改由 `user_progress` 承载，因此每个人的错题本相互独立。

题目在服务端入库前会经过 `php/app/validate.php` 校验（空格数量、答案去重、提示词类型匹配等），不通过的题目不会被写入。

## 安全说明

已内置：

- 密码用 bcrypt（cost 10）哈希，数据库泄露也拿不到明文
- 登录失败不区分「用户不存在」与「密码错误」，避免暴露用户名是否存在
- 连续失败 8 次锁定该账号 15 分钟（按账号而非 IP，前面有 WAF 时才不会被误伤）
- 注册接口忽略客户端传入的 `role`，强制为普通用户，防止越权提权
- 管理员不能修改自己的角色、不能禁用自己、不能删除自己，防止把系统锁死
- 重置密码、禁用账号会立即清除该用户所有会话
- 错误响应屏蔽数据库错误细节与堆栈，只返回安全文案

**上线后第一件事：登录 admin 修改默认密码。**

### 重置管理员密码

```bash
# 方式一：用管理页的「用户管理 → 重置密码」（推荐）

# 方式二：生成哈希后手动更新
php -r "echo password_hash('新密码', PASSWORD_BCRYPT, ['cost' => 10]), PHP_EOL;"
```

拿到哈希后执行 SQL：

```sql
UPDATE users SET password_hash = '新哈希' WHERE username = 'admin';
```

## 常见问题

**页面一片空白 / 打开是 404 或 500**

按顺序排查：

```bash
curl -s https://你的域名/api/health          # 应返回 {"ok":true,...}
curl -s https://你的域名/ | head -5          # 应看到 <!doctype html> 与页面标题
```

| 现象 | 原因 |
|---|---|
| `/api/health` 返回 nginx 的 404 页 | 请求没进 PHP：检查 `location /` 的 fastcgi 配置与 `SCRIPT_FILENAME` |
| `/api/health` 返回 502 | PHP-FPM 没跑，或 `fastcgi_pass` 的 sock 路径写错 |
| `/api/health` 正常但页面 500 | 看 PHP 错误日志；常见是 `php/data/` 不可写 |
| 页面能开但没有样式 | `location /assets/` 没配，或 `root` 没指向 `php/` 目录 |

**别忘了把 `root` 指向 `php/`**：站点根应该是 `php/`（里面才是 `index.php` 与 `assets/`），
不是项目根。指到项目根会把后端源码变成可公开下载的文件。

**接口全部 404，页面提示「未能连接服务器」**

`/api/` 没有交给 PHP-FPM。检查 nginx 里有没有上面那段 `location /api/`，
以及 `fastcgi_param SCRIPT_FILENAME` 是否指向了真实存在的 `php/index.php`。

**「系统设置」里提示「当前目录不是 git 仓库」**

复制粘贴部署的目录没有 `.git`。在线更新依赖 git，需要初始化一次（不影响数据），
或者干脆用命令行更新。

**「系统设置」里提示「proc_open / proc_get_status 函数被禁用」**

按上面「网页一键更新」的第 ① 步，到面板的 PHP 设置里解禁这两个函数。

**检查更新报「无法连接远端仓库 / Permission denied (publickey)」**

PHP 进程拿不到仓库访问权限。按「网页一键更新」第 ③ 步检查远端地址：
必须是 HTTPS 形式——公开仓库用匿名地址，私有仓库把令牌写进地址；
再看第 ② 步（项目目录属主是否为 `www`）。

**检查更新卡住 / 超时，服务器直连 GitHub 不稳定（国内网络）**

给这个仓库配置 GitHub 加速通道即可（第三方公共服务，仅影响本仓库的拉取；
也可自行换成别的加速服务）：

```bash
cd /www/wwwroot/项目目录
git config url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/"
chown www:www .git/config
```

配置后原生 `git fetch`（含网页「检查更新 / 立即更新」）会自动走加速通道。取消配置：

```bash
git config --unset url."https://gh-proxy.com/https://github.com/".insteadOf
```

## 发版

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，三处保持一致：

- 根目录 `VERSION` 文件
- `package.json` 的 `version`
- git 标签 `v{VERSION}`

流程：

```bash
# 1. 更新 CHANGELOG.md，写下本次变更
# 2. 三处同步版本号
echo "2.0.1" > VERSION
#    package.json 的 version 同步改

# 3. 提交并打标签
git add -A && git commit -m "release: v2.0.1"
git tag -a v2.0.1 -m "v2.0.1"

# 4. 推送（标签要单独推）
git push origin master
git push origin v2.0.1
```

发版前跑一遍自测：

```bash
# 接口 60 项
DB_FILE=data/test_api.db php -S 127.0.0.1:9001 php/dev-router.php &
npm run test:api

# 页面交互 81 项（需 playwright-core + 本机浏览器）；必须用全新的库
rm -f php/data/test_ui.db*
DB_FILE=data/test_ui.db php -S 127.0.0.1:9002 php/dev-router.php &
npm run test:ui
```

## 许可

个人学习项目。
