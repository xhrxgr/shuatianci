/**
 * 整卷做页的渲染（v3.9.7）
 *
 * 起因是一个**静默崩溃**：v3.9.5 把原文改成按卷取之后，
 * passageBlock 里写了 `paperPassage.text`，而该卷没有原文时
 * `paperPassage` 是 null —— 直接抛
 * `TypeError: Cannot read properties of null (reading 'text')`。
 *
 * 抛错的时机在渲染链中间，于是答题卡与题目**整块消失**，
 * 页面只剩卷头和两个翻页按钮。不看 JS 控制台根本发现不了，
 * 看上去就是「样式异常」。所以这类测试必须断言**内容真的渲染出来了**，
 * 不能只断言「页面能打开」。
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
const page = await (await b.newContext({ colorScheme: "dark", viewport: { width: 1100, height: 700 } })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 200)); });
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});

const name = "整卷样式卷_" + Date.now();
await page.evaluate(async (n) => {
  const r = await fetch("/api/papers", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  const pid = (await r.json()).paper?.id;
  const qs = Array.from({ length: 6 }, (_, i) => ({
    id: `q_pp_${i}`, originalSentence: `Sentence number ${i} ______ (test) here.`,
    source: n, paperId: pid, schemaVersion: 1,
    blanks: [{ blankIndex: 1, answer: ["test"], hintWord: "test", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "例析。" }],
  }));
  await fetch("/api/questions", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questions: qs }) });
  return pid;
}, name);

await page.goto(`${BASE}/papers`, { waitUntil: "networkidle" });
const pid = await page.evaluate(async (n) => {
  const ps = (await (await fetch("/api/papers", { credentials: "include" })).json()).papers ?? [];
  return ps.find((x) => x.name === n)?.id ?? "";
}, name);
await page.goto(`${BASE}/papers/${pid}`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.screenshot({ path: "E:/pd/shuawanxing/shots/pp-dark.png" });

const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 140)}`}`);
};

// 关键：无原文的卷也必须把题目渲染出来（曾经因为 paperPassage 为 null
// 抛错，答题卡与题目整块消失，只剩卷头和翻页按钮）
const sheet = await page.locator("#paper-sheet").innerText().catch(() => "");
check("答题卡渲染出全部题号", sheet.trim().split(/\s+/).length === 6, sheet.slice(0, 60));

const card = await page.locator("#paper-card").innerText().catch(() => "");
check("题目内容渲染出来了", card.includes("Sentence number 0"), card.slice(0, 60));
// 「第1 空」是空位的 CSS/placeholder 渲染，innerText 抓不到（input 没文本节点）
// 所以断言落在「确实有可填的空」上 —— 视觉标签由样式负责，这里只管功能
const blankCount = await page.locator("#paper-card input, #paper-card textarea").count();
check("题干里的空渲染成可填的输入框", blankCount >= 1, { blankCount });
check("提交按钮存在", await page.locator("#paper-card button", { hasText: "提交答案" }).count() > 0);
check("翻页按钮存在", await page.locator("button", { hasText: "下一题" }).count() > 0);
// 只看 pageerror：资源 404（favicon 之类）不是页面异常
const realErrors = errs.filter((e) => e.startsWith("PAGEERROR"));
check("没有 JS 运行时异常", realErrors.length === 0, realErrors.slice(0, 2));

const st = await page.evaluate(() => {
  const sec = document.querySelector("#paper-practice-root section");
  const track = document.querySelector("#paper-progress-bar")?.parentElement;
  const text = document.getElementById("paper-progress-text");
  const r = track?.getBoundingClientRect();
  const sr = sec?.getBoundingClientRect();
  return {
    trackRight: Math.round(r?.right ?? 0),
    sectionRight: Math.round(sr?.right ?? 0),
    textLeft: Math.round(text?.getBoundingClientRect().left ?? 0),
  };
});
check("进度条不越出容器", st.trackRight <= st.sectionRight, st);
check("进度文字不压住进度条", st.textLeft >= st.trackRight, st);

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`
通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;


