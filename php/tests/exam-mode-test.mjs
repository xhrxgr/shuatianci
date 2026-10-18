/**
 * 整卷做的「考试模式」（12 项，v3.9.9）
 *
 * 用户提了两条，方向一致 —— **整卷做要当考试做，全程不泄露答案**：
 *   ① 「既然叫答题卡，那就应该全部做完提交了才显示对错，而不是实时查看」
 *   ② 「展开原文可以一起改成跟题目一样的形式，不填正确答案进去」
 *
 * 实现要点：
 *   · 对错只在 allSubmitted()（整卷全交完）后揭晓，之前已答的题只标中性色
 *   · 原文按**答案词在原文中的位置**逐个挖成可填的空（用户选的对位方式），
 *     与题目视图共用同一份 answers，判卷只判一次
 *   · 交卷后不清空题目区 —— 原来 `card.innerHTML = ""` 会让交卷瞬间
 *     只剩一个百分比，逐题对错与原文对照全丢。现在渲染**逐题回顾**
 *
 * 走完整流程：做 3 题（中间故意错一题）→ 交卷 → 逐项验。
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
const errs = [];
const page = await (await b.newContext({ colorScheme: "dark", viewport: { width: 900, height: 900 } })).newPage();
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 200)));
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});

// 一卷 3 题 + 一篇含这 3 个答案词的原文
const name = "考试模式卷_" + Date.now();
const pid = await page.evaluate(async (n) => {
  const r = await fetch("/api/papers", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  const p = (await r.json()).paper?.id;
  const qs = [
    { id: "q_m_1", s: "It ______ (rain) here.", a: ["rains"] },
    { id: "q_m_2", s: "They ______ (play) football.", a: ["play"] },
    { id: "q_m_3", s: "She ______ (eat) an apple.", a: ["eats"] },
  ].map((x) => ({ id: x.id, originalSentence: x.s, source: n, paperId: p, schemaVersion: 1,
    blanks: [{ blankIndex: 1, answer: x.a, hintWord: null, hintType: "无提示词", tagIds: ["t_001"], trapAnalysis: "例。" }] }));
  await fetch("/api/questions", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questions: qs }) });
  await fetch("/api/passages", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paperId: p, title: "", text: "It rains here. They play football every day. She eats an apple at school." }) });
  return p;
}, name);

await page.goto(`${BASE}/papers/${pid}`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

const out = [];
const t = async (n, f) => { try { out.push(`${(await f()) ? "✅" : "❌"} ${n}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0,70)}`); } };

const sheetText = () => page.locator("#paper-sheet").innerText();

// 第 1 题作答并提交
await page.locator("#paper-card input[data-blank]").fill("rains");
await page.locator("#paper-card button", { hasText: "提交答案" }).click();
await page.waitForTimeout(800);

await t("答完 1 题后答题卡不显示对错", async () => {
  const txt = await sheetText();
  const html = await page.locator("#paper-sheet").innerHTML();
  return !html.includes("✓") && !html.includes("×");
});

await t("答题卡标成「已答」的中性色", async () => {
  const html = await page.locator("#paper-sheet").innerHTML();
  return html.includes("bg-primary-soft") || html.includes("·");
});

// 做第 2、3 题：用答题卡跳题，避开翻页按钮在提交后的时序问题
for (const [no, val] of [[2, "play"], [3, "eats"]]) {
  await page.locator(`#paper-sheet [data-index="${no - 1}"]`).click();
  await page.waitForTimeout(600);
  await page.locator("#paper-card input[data-blank]").fill(val);
  await page.locator("#paper-card button", { hasText: "提交答案" }).click();
  await page.waitForTimeout(800);
}
// 从答题卡跳回第 3 题，再点「完成本卷」
await page.locator('#paper-sheet [data-index="2"]').click();
await page.waitForTimeout(600);
await page.locator("#paper-next").click();
await page.waitForTimeout(1500);

await t("全部交完后答题卡显示对错", async () => {
  const html = await page.locator("#paper-sheet").innerHTML().catch(() => "");
  return html.includes("✓");
});

await t("完成态给出正确率", async () =>
  (await page.locator("#paper-finish-text").innerText()).includes("正确率"));

// —— 第二轮：一道对一道错，验原文视图 ——
// 第 1 题对（第一轮已提交过，先重做）
await page.locator("#paper-restart").click();
await page.waitForTimeout(1000);
await page.locator("#paper-card input[data-blank]").fill("rains");
await page.locator("#paper-card button", { hasText: "提交答案" }).click();
await page.waitForTimeout(700);
// 第 2 题故意错
await page.locator('#paper-sheet [data-index="1"]').click();
await page.waitForTimeout(700);
await page.locator("#paper-card input[data-blank]").fill("xxx");
await page.locator("#paper-card button", { hasText: "提交答案" }).click();
await page.waitForTimeout(700);
// 第 3 题对
await page.locator('#paper-sheet [data-index="2"]').click();
await page.waitForTimeout(700);
await page.locator("#paper-card input[data-blank]").fill("eats");
await page.locator("#paper-card button", { hasText: "提交答案" }).click();
await page.waitForTimeout(700);
// 交卷
await page.locator('#paper-sheet [data-index="2"]').click();
await page.waitForTimeout(700);
await page.locator("#paper-next").click();
await page.waitForTimeout(1500);

await t("交卷后答题卡区分对错", async () => {
  const html = await page.locator("#paper-sheet").innerHTML().catch(() => "");
  return html.includes("✓") && html.includes("×");
});
await t("原文块存在且自动展开", async () => {
  if ((await page.locator("[data-passage-block]").count()) === 0) return false;
  return page.locator("[data-passage-block]").first().evaluate((el) => el.open);
});
await t("原文被挖成 3 个可填的空", async () =>
  (await page.locator("[data-passage-blank]").count()) === 3);
await t("原文空位不泄漏答案词", async () => {
  const txt = await page.locator("[data-passage-block]").innerText();
  return !txt.includes("rains") && !txt.includes("eats");
});
await t("原文空位显示已填的作答（与题目共享）", async () => {
  const vals = await page.evaluate(() =>
    [...document.querySelectorAll("[data-passage-blank]")].map((i) => i.value));
  return vals[0] === "rains" && vals[1] === "xxx" && vals[2] === "eats";
});
await t("原文空位标出对错（对绿错红）", async () =>
  await page.evaluate(() => {
    const list = [...document.querySelectorAll("[data-passage-blank]")];
    const cls = (el) => el.className || "";
    return cls(list[0]).includes("border-success") && cls(list[1]).includes("border-danger");
  }));
await t("交卷后原文空位只读（已判过不能再改）", async () =>
  await page.evaluate(() =>
    [...document.querySelectorAll("[data-passage-blank]")].every((el) => el.readOnly)));

await t("交卷后逐题回顾列出全部题目与对错", async () => {
  const txt = await page.locator("#paper-card").innerText();
  return txt.includes("你的答案") && txt.includes("正确答案") && txt.includes("第 3 题");
});
await page.screenshot({ path: "E:/pd/shuawanxing/shots/exam-mode.png" });

console.log(out.join("\n"));
console.log("JS 错误:", errs.length ? [...new Set(errs)].slice(0,2).join(" | ") : "无");
await page.screenshot({ path: "E:/pd/shuawanxing/shots/exam-mode.png" });
await b.close();
