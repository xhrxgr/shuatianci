/**
 * 鉴权兜底检查 —— 防止「路由表没有鉴权层 + 新 handler 忘了自己调」这类漏洞回归。
 *
 * 背景（v3.8.5）：index.php 的路由表只做路由匹配，**没有兜底鉴权层**，
 * 每个 handler 必须自己调 require_permission() / require_user_read()。
 * 当时蓝图 list/show 就漏了，未登录 GET /api/blueprints 返回 200，
 * 能拉到 rules_json（= 完整抽题条件，标签/提示词/来源的组合）。
 *
 * 两道检查：
 *   ① 静态：解析 index.php 的路由表 + 各 handler 函数体，逐个确认有鉴权调用
 *   ② 运行时：匿名请求几个敏感端点，必须是 401
 *
 * 静态那道是主防线 —— 漏加鉴权的 handler 在代码层就能发现，不必等运行时。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..", "app");
const INDEX = join(HERE, "..", "index.php");

/** 认这些函数名就算做了鉴权 */
const AUTH_FNS = [
  "require_permission",
  "require_user_read",
  "require_login",
  "require_admin",
  "require_auth",
  "current_user",
  "attach_user",
];

/**
 * 确实允许匿名访问的端点。
 *
 * 前四个是「游客可刷题」的设计（README：游客可直接刷题，/practice 标注公开），
 * 后两个是登录/注册入口本身。**往这里加东西前先想清楚是不是漏了鉴权。**
 */
const PUBLIC_HANDLERS = new Set([
  "route_auth_login",
  "route_auth_register",
  "route_questions_list",
  "route_tags_list",
  "route_papers_list",
  "route_papers_show",
]);

/** 取出 PHP 文件里某个函数的完整函数体（按花括号配平，忽略字符串里的括号） */
function functionBody(source, name) {
  const decl = new RegExp(`^function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, "m").exec(source);
  if (!decl) return null;
  let i = decl.index + decl[0].length;
  let depth = 1;
  let inStr = null;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (inStr) {
      if (c === "\\") i += 1;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    i += 1;
  }
  return source.slice(decl.index, i);
}

/** 收集所有 routes_*.php 的源码，按函数名索引 */
function loadHandlers() {
  const map = new Map();
  for (const f of readdirSync(APP_DIR)) {
    if (!f.startsWith("routes_") || !f.endsWith(".php")) continue;
    const src = readFileSync(join(APP_DIR, f), "utf8");
    for (const m of src.matchAll(/^function\s+(\w+)\s*\(/gm)) {
      map.set(m[1], { file: f, body: functionBody(src, m[1]) });
    }
  }
  return map;
}

/**
 * ① 静态：每个非公开 handler 的函数体里必须有鉴权调用。
 *
 * 只在函数体**首几行**里找 —— 有些 handler 先做参数解析再鉴权是合理的，
 * 但为了避免「函数末尾随手补一句」的假通过，这里只在开头 12 行内匹配，
 * 足够覆盖 require_permission 这类习惯性写法。
 */
function staticAuthCheck() {
  const indexSrc = readFileSync(INDEX, "utf8");
  const routes = [...indexSrc.matchAll(/\[\s*'(GET|POST|PUT|DELETE)',\s*'([^']+)',\s*'(\w+)'\s*\]/g)].map(
    (m) => ({ method: m[1], path: m[2], fn: m[3] })
  );
  const handlers = loadHandlers();
  const missing = [];

  for (const r of routes) {
    if (PUBLIC_HANDLERS.has(r.fn)) continue;
    const h = handlers.get(r.fn);
    if (!h || h.body === null) continue; // 定义在别处（如 index.php 里的 route_health）
    const head = h.body.split("\n").slice(0, 12).join("\n");
    if (!AUTH_FNS.some((fn) => head.includes(fn))) {
      missing.push(`${r.method} ${r.path} => ${r.fn}（${h.file}）`);
    }
  }
  return { total: routes.length, missing };
}

export async function checkAuthCoverage(request, check) {
  console.log("\n【鉴权兜底】（路由表无鉴权层，handler 必须自查）\n");

  // ---- ① 静态扫描 ----
  const { total, missing } = staticAuthCheck();
  check(
    `静态：${total} 条路由里非公开端点都调用了鉴权`,
    missing.length === 0,
    missing.slice(0, 8)
  );
  if (missing.length > 0) {
    console.log("        缺鉴权的端点：");
    for (const m of missing) console.log(`          - ${m}`);
  }

  // ---- ② 运行时抽查 ----
  // 匿名（无 token）必须 401。任一返回 200 且**带出了真实数据**就算漏了。
  //
  // 不能只看状态码：游客模式的端点（/records/summary、/favorites、/marks…）
  // 匿名会返回 {"authenticated":false,...} 的空壳，那是设计（README：游客显示
  // 本机记录），不是泄露。所以这里判定「泄露」的标准是：
  //   状态码是 2xx **且** 响应里没有 authenticated:false 这个游客标记。
  // 这样新增游客端点不用改清单，也不会把游客功能误判成漏洞。
  const probes = [
    ["GET", "/blueprints"],
    ["GET", "/blueprints/bp_x"],
    ["GET", "/admin/users"],
    ["GET", "/admin/roles"],
    ["GET", "/system/update-source"],
    ["GET", "/system/version"],
    ["GET", "/passages"],
    ["GET", "/records/summary"],
    ["GET", "/favorites"],
    ["GET", "/marks"],
  ];

  /** 游客空壳响应不算泄露 */
  const isGuestShell = (data) =>
    data && typeof data === "object" && data.authenticated === false;

  const leaks = [];
  for (const [method, path] of probes) {
    const res = await request(method, path);
    const okish = res.status >= 200 && res.status < 300;
    if (okish && !isGuestShell(res.data)) leaks.push(`${method} ${path} -> ${res.status}`);
  }
  check(
    "运行时：匿名访问敏感端点不泄露数据",
    leaks.length === 0,
    leaks
  );

  // 反向确认：公开端点仍然要能匿名访问（别把游客刷题功能误封了）
  for (const [method, path] of [["GET", "/tags"], ["GET", "/papers"]]) {
    const res = await request(method, path);
    check(
      `公开端点仍可匿名访问：${method} ${path}`,
      res.status === 200,
      { status: res.status, data: res.data }
    );
  }
}