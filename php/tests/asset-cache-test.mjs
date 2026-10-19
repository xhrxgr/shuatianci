/**
 * 静态资源缓存戳（import map）。
 *
 * 为什么必须有这个
 * --------------
 * 项目用原生 ES module，模块之间靠 `import "./x.js"` 静态串联。
 * 页面里的 <script src="...admin.js?v=戳"> 变了会重新下载**入口**，
 * 但那串 import 说明符是源码里的字面量，URL 永远不变 ——
 * 浏览器于是继续用缓存里的旧子模块。结果是「入口是新的、子模块是旧的」，
 * 混出来一个改了却没反应的页面。
 *
 * 实际踩过：v3.8.9 修好了「删除试卷弹窗三个按钮点不动」，服务器也更新了，
 * 用户刷新后依然点不动 —— 浏览器拿着缓存里的旧 admin-papers.js，
 * 那三个按钮在旧文件里根本没绑定。
 *
 * 所以用 import map 在**运行时**给所有模块补上戳。
 * 这里断言的就是「每一个被加载的 JS 都带 ?v=」，一个都不能漏。
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext()).newPage();

const jsRequests = [];
page.on("request", (r) => {
  if (r.url().includes("/assets/js/")) jsRequests.push(r.url().replace(BASE, ""));
});

const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text().slice(0, 150)); });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForTimeout(1500);
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const withStamp = jsRequests.filter((u) => u.includes("?v="));
const without = jsRequests.filter((u) => !u.includes("?v="));

console.log("=== admin 页加载的 JS 模块 ===");
console.log(`带缓存戳: ${withStamp.length} 个`);
console.log(`无缓存戳: ${without.length} 个`, without.length ? without : "✅ 全部带戳");

console.log("\n=== admin-papers.js 是否带戳 ===");
const ap = jsRequests.filter((u) => u.includes("admin-papers.js"));
console.log(ap.length ? ap.join("\n") : "未加载（admin 页没用到？）");

console.log("\n=== import map 是否被浏览器接受（无解析错误）===");
console.log(errs.filter((e) => /import ?map|importmap/i.test(e)).length === 0
  ? "✅ 无 import map 相关错误" : errs.join(" | "));

console.log("\n=== 页面功能是否正常（模块能解析执行）===");
await page.locator('[data-admin-tab="papers"]').click();
await page.waitForTimeout(600);
const papersTabWorks = await page.locator('[data-admin-panel="papers"]').isVisible();
console.log(papersTabWorks ? "✅ 页签切换正常（模块解析成功）" : "❌ 页签切换异常");

console.log("\nJS 错误:", errs.length ? [...new Set(errs)].slice(0, 3).join(" | ") : "无");
// 退出码：没有它，测试失败时进程仍返回 0 ——
// 批处理里会被当成「通过」，绿得莫名其妙。
// 这个套件的判据是「有没有漏戳的模块」，不是 ❌ 行（它本来就没有 out 数组）。
// 只把 pageerror 算失败：errs 里混着 favicon 之类的 404，那是无害的资源缺失。
const REAL_JS_ERRORS = Array.isArray(errs)
  ? [...new Set(errs)].filter((e) => !/Failed to load resource|404|403/.test(String(e)))
  : [];
process.exitCode =
  without.length > 0 || !papersTabWorks || REAL_JS_ERRORS.length > 0 ? 1 : 0;
await browser.close();
