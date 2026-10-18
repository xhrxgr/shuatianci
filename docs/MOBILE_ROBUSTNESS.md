# 移动端健壮性改造说明（v3.9.3）

面向异常与边界情况的稳定性改进。**不改变现有视觉风格与业务逻辑** ——
所有改动都在「出错时怎么办」这一层，理想路径上的界面与流程完全不变。

---

## 一、改动总览

| 方向 | 改了什么 | 主要文件 |
|---|---|---|
| 网络请求失败 | 加超时、按错误类型给不同文案、离线识别 | `php/assets/js/api.js` |
| 加载超时 | 默认 20s 超时，可按调用覆盖 | `php/assets/js/api.js` |
| 空数据 / 格式异常 | 三态占位（加载中 / 空 / 失败可重试） | `php/assets/js/ui-guard.js`（新增） |
| 超长文本、大字体 | 全局断行兜底 + flex 收缩 + select 限宽 + option 截断 | `styles/app.css`、`php/app/views.php`、`php/views/admin.php` |
| 快速重复点击 | `once()` / `guardButton()` 封装 | `php/assets/js/ui-guard.js`（新增） |
| 页面返回 / 进程恢复 | BFCache 与切后台的统一刷新信号 | `php/assets/js/lifecycle.js`（新增） |

---

## 二、逐项说明

### 1. 网络请求失败与超时

**改动前**：`fetch` 没有超时控制。手机切后台、断网重连、中间代理挂起时，
请求会永远挂着 —— 界面既看不到结果也走不掉，只能杀进程重开。

**改动后**：

- 用 `AbortController` 加默认 **20 秒**超时（每个请求的计时器在 `finally` 里清理）
- 超时与「网络断了」分开报，两者的下一步完全不同：

| 情况 | 提示 | 可重试 |
|---|---|---|
| 超时 | 「请求超时（路径）。可能是网络较慢或题量较多，可以再试一次。」 | ✅ |
| 离线 | 「当前没有网络连接。请连上网络后重试。」 | ✅ |
| 网络失败 | 「网络请求失败，请检查网络后重试。」 | ✅ |
| 5xx | 服务端原文 + `kind: server` | ✅ |
| 返回非 JSON | 「服务器返回了无法解析的内容（HTTP 502）。请稍后重试。」 | ❌ |

- `ApiError` 新增 `kind` 字段与 `retryable` getter，
  调用方可以据此决定要不要显示「重试」按钮

**兼容性**：`ApiError(message, status, details)` 的既有调用方式不变
（`kind` 有默认值），16 处现有错误处理无需修改。

### 2. 状态占位：加载中 / 空 / 失败重试

**新增 `php/assets/js/ui-guard.js`**：

- `renderState(box, kind, options)` —— 渲染三态之一。
  失败态自带「重试」按钮，只显示「加载失败」用户只能刷新页面，
  而重试让失败变成一次点击就能恢复的事。
- `loadInto(box, loader, render, options)` —— 列表型数据的标准写法，
  自动处理三态，空判定兼容 `null` / `[]` / `{}` / `{ items: [] }` 四种形态。
- 占位文案会做 HTML 转义（错误信息可能含服务端原文）。

**已接入**：试卷编辑面板的「本卷原文」区。
这一块是管理端唯一靠接口取数的面板，没有 SSR 兜底 ——
之前一失败就永远停在 HTML 里那句「正在读取…」。

### 3. 超长文本与大字体

这是本轮**实测抓到的真问题**，不是预防性改动。

**根因**：`<select>` 的宽度是**内容驱动**的 —— 它会撑到能放下最长那个
`<option>`，而 `<option>` 内部无法换行。
实测：卷名 180 字符 → select 宽 1564px（视口 1280px），
390px 真机视口下整页横向滚动 146px。

**三层修复**：

1. **option 文本截断**（`views.php` 新增 `ellipsis()`，截到 28 字，`title` 保留全名）
2. **`select` 按容器分配宽度**：`flex: 1 1 0%`。
   关键在 `flex-basis: 0` —— 它把宽度计算的起点从「内容宽度」换成「0」
3. **flex 子项允许收缩**：`[class*="flex"] > * { min-width: 0 }`。
   flex item 的 `min-width` 默认是 `auto`（不小于内容宽度），
   所以**只给 select 限宽是不够的**，它的父容器仍会拒绝收缩

**大字体**：表单控件统一 `min-height` 而非 `height`，
用户放大浏览器字号时文字不会被裁掉；iOS 上字号不小于 16px，
避免聚焦时页面自动放大（用户体验上像是页面失控）。

**全局断行**：`overflow-wrap: anywhere`，
让长英文单词与无空格长 URL 在容器内断行。

### 4. 快速重复点击

**新增 `ui-guard.js` 的两个封装**：

- `once(fn)` —— 同一时刻只跑一个。`running` 标志放在 `finally` 里复位，
  否则一次失败后永久卡死。
- `guardButton(button, fn, { busyText, minBusyMs })` —— 点一次、执行中禁用、
  成功后复原。`minBusyMs` 给一个短下限，避免「复原太快 → 用户以为没点上 → 再点一次」。

**现状核查**：保存、删除、导入、解析等已有防护（`savingPaper` / `savingEdit` /
`saveButton.disabled`），未改动。新封装供后续新代码使用。

### 5. 页面返回与进程恢复

**新增 `php/assets/js/lifecycle.js`**：

- `onStale(fn)` —— 登记「页面变旧了就要刷新」的回调
- 统一在四个时机派发 `app:stale` 事件：
  - `pageshow` 且 `event.persisted` —— **BFCache 恢复**（脚本根本没重新执行）
  - `visibilitychange` → 可见 —— 从后台切回
  - `online` / `offline` —— 网络变化
- `abortWhenHidden(signal)` —— 页面隐藏时中止在途请求。
  不中止的话，切走再回来那些请求会继续写入已重渲染的 DOM，
  表现为「刷新回来后列表里莫名多出几条」。

**已接入**：AI 导入面板在页面变旧时复位提交按钮的 loading 态。

---

## 三、受影响的文件

### 新增（3 个）

| 文件 | 用途 |
|---|---|
| `php/assets/js/ui-guard.js` | 防重复执行 + 三态占位 |
| `php/assets/js/lifecycle.js` | BFCache / 切后台 / 网络变化 |
| `php/tests/mobile-robustness-test.mjs` | 健壮性回归测试（8 项） |

### 修改（8 个）

| 文件 | 改动 |
|---|---|
| `php/assets/js/api.js` | 超时、错误分类、离线识别 |
| `php/assets/js/admin-papers.js` | 原文区接入三态占位 |
| `php/assets/js/admin-ai.js` | 接入 `onStale` |
| `php/app/views.php` | 新增 `ellipsis()`；`import_map_json()` 注释更新 |
| `php/views/admin.php` | option 截断 + `flex-wrap` 加 `min-w-0` |
| `styles/app.css` | 全局布局兜底（断行、flex 收缩、select 限宽、大字体） |
| `php/assets/app.css` | 上述样式的构建产物 |
| `package.json` | 新增 `test:mobile-robust` 脚本 |

---

## 四、验证

新增 `npm run test:mobile-robust`（8 项），在 **390px 真机视口**下跑 ——
溢出类问题在桌面宽度上常常「看不出来」，必须用真实手机宽度测：

- 超长文本下三个页签均无横向溢出
- 连点 5 下保存，只发一次请求
- 接口 500 时页面可读、可重试
- 接口返回 HTML（代理错误页）时页面不崩
- 390px 下五个页签整页无横向滚动
- 390px 下触摸目标均 ≥ 40px

**回归**：干净串行跑 20 个套件全部通过（含 api 128、bank-phase1 66、
bank-phase2 88、paper-passage 10、paper-delete 17、dialog-fallback 7、
admin-buttons 14、blueprint-ui 30、passage-entry 11、passage-leak 9、
tag-collapse 10、update-trigger 11、feedback-smoke 8、AI 7 套件 109）。

---

## 五、部署注意

本轮改了 `php/assets/app.css`（Tailwind 产物），**必须更新服务器才会生效**：

```bash
bash /www/wwwroot/你的项目目录/update.sh
```

无数据库变更，无需迁移。