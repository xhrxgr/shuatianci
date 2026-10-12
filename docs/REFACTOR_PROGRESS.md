# 重构进度：从 React + Node 到纯 PHP

> **本文件是重构的进度台账。** 上下文刷新、换会话、换人接手时，先读这个文件，
> 再对照 `git log` 看最新提交，就能接着往下做，不需要重新摸一遍代码。
> 任务清单同时维护在会话的任务列表里（TaskList），两边一致。

## 一、目标与验收标准

**目标**：整个项目变成纯 PHP 项目——服务器上只有 PHP + 静态文件，**不需要 Node、不需要 npm、不需要构建**。

**验收标准**（缺一不可）：

1. 页面上没有任何 React/Node 运行时依赖，`dist/` 与 `src/`（TSX）最终删除
2. 页面结构、样式、交互、文案与 React 版**一致**（逐个页面核对）
3. `/api/*` 接口契约不变（路径、方法、字段、状态码），`php/tests/api-test.mjs` 60 项全过
4. 部署只依赖 PHP（≥7.4，需 `pdo_sqlite`）与 nginx/宝塔
5. 已有数据无需转换、账号密码无需重置

## 二、当前状态（2026-10-12）

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | 后端由 Node/Express 重写为 PHP | ✅ 完成（v2.0.0 之前） |
| Phase 2 | 删除 Node 版 + 建立版本管理 | ✅ 完成（提交 `df6101f`，标签 `v2.0.0`） |
| Phase 3 | **前端由 React 改为 PHP 渲染** | ✅ 完成（13/13） |
| Phase 4 | 清理 React 残留、部署配置更新、发 v3.0.0 | ✅ 完成（v3.0.0） |

整体进度：**Phase 3 约占全部剩余工作**，已完成 2/4 阶段。

## 三、Phase 3 明细（前端 PHP 化）

| # | 项目 | 对应原文件 | 状态 |
|---|---|---|---|
| 3.1 | 渲染框架：`php/app/views.php`（渲染/导航/权限/题目+进度合并） | `src/App.tsx` 的导航与布局 | ✅ 完成 |
| 3.2 | 布局模板 `php/views/layout.php` + `index.php` 页面/接口分流 | `src/App.tsx`、`src/main.tsx` | ✅ 完成 |
| 3.3 | 样式落地 `php/assets/app.css`（复制 Tailwind 产物，24KB） | `src/index.css` + Tailwind 产物 | ✅ 完成 |
| 3.4 | 基础 JS：`api.js`（全量接口）/ `app.js`（菜单、退出） | `src/api/client.ts`、`src/auth/AuthContext.tsx` | ✅ 完成 |
| 3.5 | 首页 | `src/pages/Home.tsx` | ✅ 完成 |
| 3.6 | 登录页（含 `login.js`，登录/注册切换） | `src/pages/Login.tsx` | ✅ 完成 |
| 3.7 | **刷题页（核心）** | `Practice.tsx` + `QuizCard.tsx` + `FilterBar.tsx` | ✅ 完成 |
| 3.8 | 个人中心 | `Profile.tsx` + `utils/records.ts` | ✅ 完成 |
| 3.9 | 收藏与标记 | `Collection.tsx` + `CollectionActions.tsx` | ✅ 完成 |
| 3.10 | **录题后台** | `Admin.tsx` + `ManualEntry.tsx` + `AiAssistant.tsx` + `TagManager.tsx` | ✅ 完成 |
| 3.11 | 用户管理 | `UserAdmin.tsx` | ✅ 完成 |
| 3.12 | 系统设置 | `System.tsx` | ✅ 完成 |
| 3.13 | 404 页 | `App.tsx` 的 `path="*"` | ✅ 完成 |

## 四、关键决策（改动前先读，别推翻重来）

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 前端形态 = **PHP 服务端渲染 + 原生 JS（ES modules，不打包）** | 浏览器原生支持 `<script type="module">`，无需构建；PHP 直出首屏，页面更快 |
| D2 | **首屏数据由 PHP 直接读 SQLite**，/api 只被 JS 的交互动作调用 | 真正像 PHP 项目；接口契约不变，交互仍走 /api |
| D3 | 样式 = 生成好的 Tailwind CSS 作为静态文件（`php/assets/app.css`）提交进仓库 | Tailwind 只能用 Node 编译，但**编译产物是纯 CSS**，运行时不需要 Node；改样式时可直接编辑该 CSS，有 Node 时也可用样式源重新生成 |
| D4 | 样式源保留为 `styles/app.css`（`@import "tailwindcss"` + 主题变量 + `@source ../php/views`） | 保留重新生成的能力；它不是 React 代码，不违反"删 React"的目标 |
| D5 | 导航改为**普通链接跳转**（服务端渲染），页面内部交互（筛选、判卷、展开解析）**不刷新** | 保持 PHP 项目形态；交互体验与 SPA 接近 |
| D6 | 页面模板里的类名**沿用 React 版同一套语义类**（`bg-surface`/`text-ink`/`border-line`/`text-muted`/`text-faint`） | 保证视觉一致，主题跟随系统 |
| D7 | 后端接口**一个都不改**，继续用 `php/app/routes_*.php` | 契约已在 v2.0.0 验证过（与 Node 版逐字节一致） |
| D8 | 页面与接口共用同一个入口 `php/index.php`：非 `/api` 渲染页面，`/api` 返回 JSON | 部署只需一条规则，减少 nginx 配置 |

## 五、文件映射（React → PHP）

| React 版 | PHP 版 |
|---|---|
| `src/main.tsx` + `index.html` | `php/views/layout.php` |
| `src/App.tsx`（导航、路由、RequireAdmin） | `php/app/views.php` + `php/views/layout.php` + index.php 路由表 |
| `src/pages/Home.tsx` | `php/views/home.php` |
| `src/pages/Login.tsx` | `php/views/login.php` |
| `src/pages/Practice.tsx` + `components/QuizCard.tsx` + `components/FilterBar.tsx` | `php/views/practice.php` + `php/assets/js/practice.js` |
| `src/pages/Profile.tsx` + `utils/records.ts` | `php/views/profile.php` + `php/assets/js/profile.js` |
| `src/pages/Collection.tsx` | `php/views/collection.php` + `php/assets/js/collection.js` |
| `src/pages/Admin.tsx` + `ManualEntry.tsx` + `AiAssistant.tsx` + `TagManager.tsx` | `php/views/admin.php` + `php/assets/js/admin.js` |
| `src/pages/UserAdmin.tsx` | `php/views/admin-users.php` |
| `src/pages/System.tsx` | `php/views/admin-system.php` |
| `src/api/client.ts` | `php/assets/js/api.js` |
| `src/auth/AuthContext.tsx` | 登录态由 PHP 会话直出，JS 侧只存 token |
| `src/utils/storage.ts` | PHP 直读数据库 + JS 调 `/api` |
| `src/hooks/useQuestions.ts` | `views.php` 的 `load_questions_with_progress()` |

## 六、验证方式

```bash
# 1. 启动（无需构建）
php -S 127.0.0.1:9001 php/dev-router.php     # dev-router 会同时处理页面与 /api

# 2. 接口回归（60 项，改任何后端都要跑）
node php/tests/api-test.mjs http://127.0.0.1:9001

# 3. 页面核对（逐个页面）：渲染是否正常、导航高亮、权限提示、交互是否生效
curl -s http://127.0.0.1:9001/ | grep -o '<title>.*</title>'
curl -s http://127.0.0.1:9001/practice | grep -c '开始'
```

**每个页面完成时必须同时满足**：渲染无报错 + 交互可用 + 与 React 版视觉一致。
React 版的 `dist/` 在清理前会保留，可随时打开对比（同一份 CSS，样式应完全相同）。

## 七、如何接续（下一次会话）

1. 读本文件，看「三、Phase 3 明细」找到第一个 ⏳ 待办项
2. `git log --oneline -5` 看最新提交，确认代码状态
3. 打开对应的 React 原文件（在 `src/` 下，清理前都在）与 PHP 目标文件，照着结构改
4. 改完更新本文件的状态（🔄 → ✅），并跑第六节的验证
5. 每完成一个阶段提交一次，commit message 里写清「完成哪个页面」

**不要做的事**：不要推翻第四节的关键决策；不要在没有对比 React 原文件的情况下凭印象写页面；不要在页面还没完成时删除 `src/`（它是对照依据）。

## 八、风险与未决

| 项 | 说明 |
|---|---|
| CSS 覆盖率 | PHP 模板若用到 React 版没用过的 Tailwind 类，需要重新生成 CSS（有 Node 时执行；无 Node 则需手工补 CSS 规则） |
| 刷题页复杂度 | 是交互最重的页面（多空输入、判卷、解析展开、筛选），预计工作量最大 |
| 移动端菜单 | React 版用状态控制展开，PHP 版需要一小段 JS |
| 游客模式 | 游客记录存 localStorage 的逻辑需要在 JS 侧重写（原 `utils/storage.ts`） |
| 白屏引导页 | 原 `index.html` 里的内联引导页随 React 一起删除；PHP 版不会白屏（服务端直出），不再需要 |

## 九、进度日志

### 2026-10-12（第一批：骨架 + 首页 + 登录）

完成 3.1～3.6：

- `php/app/views.php`：render_page / e / nav_items / nav_is_active / nav_link_class /
  guard_admin_page / load_questions_with_progress / load_tag_dictionary / embed_json
- `php/views/layout.php`：复刻 App.tsx 的 NavBar（桌面导航 + 移动端汉堡菜单 + 退出按钮），
  容器 id 保持 `#root`（复用 CSS 里的 `html,body,#root{height:100%}`），
  **body 不加背景类**（React 版 body 也没设，深色模式下表现与原来一致）
- `php/index.php`：入口按 URI 分流，`/api` 走 JSON，其余走 `dispatch_page()`
- `php/app/routes_pages.php`：页面路由表 + page_home / page_login
- `php/views/home.php`、`login.php`、`404.php`
- `php/assets/app.css`：复制 Tailwind 产物（24358 字节），关键类已核对存在
- `php/assets/js/api.js`（全量接口，与 client.ts 等价）、`app.js`（菜单/退出）、`login.js`
- `php/dev-router.php`：本地 `/assets/*` 直出 php/assets，其余进 index.php

验证结果：
- 首页 PHP 直出，统计 题目3/已掌握0/错题0/空格4，与数据库一致
- 导航随登录态变化：游客「首页 刷题 登录」，admin 追加「我的记录/我的收藏/题库管理/
  用户管理/系统设置 + 退出」
- `/assets/app.css` 与 `/assets/js/app.js` 均 200
- `/api/health` 正常；未接入的 `/practice` 返回 404 页（预期）

下一步：3.7 刷题页（交互最重，需对照 Practice.tsx + QuizCard.tsx + FilterBar.tsx）。


### 2026-10-12（第二批：刷题页与个人中心；第三批：后台三页；第四批：清理与发版）

**3.7 刷题页**（提交 df1c6d1）：`php/views/practice.php` + `assets/js/practice.js`，
含模式切换、两级筛选、逐空作答、回车跳空、严格判卷、解析展开、翻页、随机打乱、
收藏与标记；游客记录与进度沿用原 localStorage key。
**关键修复**：页面导航不带 Authorization 头，PHP 读不到登录态 —— 新增登录 Cookie
（httpOnly + SameSite=Lax），登录/登出/me 三个接口负责写入与清除，JS 的 token 机制不变。

**3.8 个人中心 / 3.9 收藏页**（提交 0ff5f34）：统计与列表全部由 PHP 直查渲染，
游客统计走本地；改密、取消收藏/标记由 JS 调接口后刷新。

**3.10 录题后台 / 3.11 用户管理 / 3.12 系统设置**（提交 59b929e）：
- `views/admin.php` + `assets/js/admin.js`：四个页签、手动精录（拆空/逐空配置/标签选择器/
  实时预览/校验）、导入导出与危险操作、标签管理
- `views/admin-ai.php` + `assets/js/admin-ai.js`：AI 助手（提示词从 TSX 精确切片注入，
  脚本比对逐字节一致）
- 用户管理与系统设置由子任务实现，主会话复审（删掉了子任务擅自新增的「做题明细」UI，
  保持与原版一致）

**3.13 / Phase 4**（本提交）：
- 种子数据 `src/data/` → `php/seed/`
- 样式源 `styles/app.css`（含 `@source` 扫描 php/views 与 php/assets/js），
  用 Tailwind CLI 重新生成 `php/assets/app.css`（确认新类全部覆盖）
- 删除 `src/`、`dist/`、`vite.config.ts`、`tsconfig*.json`、根 `index.html`、`public/`
  与 React 相关依赖；package.json 精简为 CSS 构建与测试脚本
- README 全面更新（部署配置改为「站点根指向 php/」，常见问题改为新的排查表）
- 版本 3.0.0

**测试现状**：接口 60/60；页面交互 81/81（首页/登录/刷题/个人中心/收藏/录题后台/权限拦截）。
