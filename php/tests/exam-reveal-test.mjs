/**
 * 整卷做：交卷前不揭晓任何对错（12 项，v3.11.1）
 *
 * 用户反馈：「做答题卡不是延迟看答案吗，怎么还是一题一题」。
 *
 * v3.9.9 只把**答题卡**的对错压到了交卷后，**题目卡片本身**在提交那一刻
 * 就弹出了：绿/红配色、✓/✗ 图标、「正确：xxx」、「全部正确！」横幅、
 * 以及含标准答案与命题意图的完整解析 —— 等于还是一题一题看答案，
 * 整卷做退化成了普通刷题。
 *
 * 现在所有「对错相关」的渲染统一受 `revealed()`（= allSubmitted()）把门，
 * 提交后只剩一句中性的「已提交，对错等整卷做完一起揭晓」。
 * 另外去掉了「全对就自动跳下一题」—— 自动跳与否本身就是对错的信号。
 *
 * 顺带修掉一个真 bug：交卷后的逐题回顾读的是 `question.trapAnalysis`，
 * 而解析实际存在**空级** `blanks[].trapAnalysis`，题目级没这个字段 ——
 * 于是回顾里永远显示不出解析，而整卷做恰恰是唯一会看到回顾的地方。
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
const errs = [];
const page = await (await b.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 900 } })).newPage();
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 220)));
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});

// 一卷 3 题 + 一篇原文
const name = "考试卷_" + Date.now();
const pid = await page.evaluate(async (n) => {
  const r = await fetch("/api/papers", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  const p = (await r.json()).paper?.id;
  const qs = [
    { id: "q_e_1", s: "It ______ (rain) here.", a: ["rains"] },
    { id: "q_e_2", s: "They ______ (play) football.", a: ["play"] },
    { id: "q_e_3", s: "She ______ (eat) an apple.", a: ["eats"] },
  ].map((x) => ({ id: x.id, originalSentence: x.s, source: n, paperId: p, schemaVersion: 1,
    blanks: [{ blankIndex: 1, answer: x.a, hintWord: null, hintType: "无提示词", tagIds: ["t_001"], trapAnalysis: "例析内容。" }] }));
  await fetch("/api/questions", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questions: qs }) });
  await fetch("/api/passages", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paperId: p, title: "", text: "It rains here. They play football every day. She eats an apple at school." }) });
  return p;
}, name);
await page.goto(`${BASE}/papers/${pid}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const out = [];
const t = async (n, f) => { try { out.push(`${(await f()) ? "✅" : "❌"} ${n}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0,60)}`); } };
const cardText = () => page.locator("#paper-card").innerText();
const cardHTML = () => page.locator("#paper-card").innerHTML();

// 第 1 题：答对
await page.locator("#paper-card input[data-blank]").fill("rains");
await page.locator("#paper-card button", { hasText: "提交答案" }).click();
await page.waitForTimeout(1000);

await t("提交后不给「全部正确」", async () => !(await cardText()).includes("全部正确"));
await t("提交后不给正确答案", async () => !(await cardText()).includes("正确："));
await t("提交后不给解析（命题依据）", async () => !(await cardText()).includes("例析内容"));
await t("提交后显示「已提交…一起揭晓」", async () => (await cardText()).includes("一起揭晓"));
await t("提交后没有对错图标", async () => {
  const h = await cardHTML();
  return !h.includes("text-success") || !(await cardText()).includes("答对");
});
await t("提交后停留在原题（不自动跳）", async () =>
  (await page.locator("#paper-card").innerText()).includes("It"));
await t("答题卡不显示对错", async () => {
  const h = await page.locator("#paper-sheet").innerHTML();
  return !h.includes("✓") && !h.includes("×");
});

// 第 2 题故意错
await page.locator('#paper-sheet [data-index="1"]').click();
await page.waitForTimeout(600);
await page.locator("#paper-card input[data-blank]").fill("zzz");
await page.locator("#paper-card button", { hasText: "提交答案" }).click();
await page.waitForTimeout(900);
await t("答错的题同样不给正确答案", async () => !(await cardText()).includes("正确："));

// 第 3 题
await page.locator('#paper-sheet [data-index="2"]').click();
await page.waitForTimeout(600);
await page.locator("#paper-card input[data-blank]").fill("eats");
await page.locator("#paper-card button", { hasText: "提交答案" }).click();
await page.waitForTimeout(900);

// 交卷
await page.locator('#paper-sheet [data-index="2"]').click();
await page.waitForTimeout(500);
await page.locator("#paper-next").click();
await page.waitForTimeout(1500);

await t("交卷后答题卡揭晓对错", async () => {
  const h = await page.locator("#paper-sheet").innerHTML();
  return h.includes("✓") && h.includes("×");
});
await t("交卷后逐题回顾给出正确答案", async () => (await cardText()).includes("正确答案"));
await t("交卷后给出解析", async () => (await cardText()).includes("例析内容"));
await t("交卷后原文挖空可填", async () => (await page.locator("[data-passage-blank]").count()) === 3);

const TOTAL = 12;
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("❌")).length;
const realErrs = [...new Set(errs)].filter((e) => e.startsWith("PAGEERROR"));
console.log(`\n通过 ${TOTAL - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 || realErrs.length > 0 ? 1 : 0;
await page.screenshot({ path: "E:/pd/shuawanxing/shots/exam-reveal.png" });
await b.close();
