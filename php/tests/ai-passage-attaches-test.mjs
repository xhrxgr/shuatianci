/**
 * AI 导入的原文挂到**卷**上（6 项，v3.9.6）
 *
 * 模型：一张卷一篇完形填空 = 一篇原文 + N 道独立小题。
 * AI 导入页填的「本卷完整原文」不写进题目，而是随这批题一起提交，
 * 由服务端挂到那一卷上（routes_bank.php 的 paperPassageText）。
 *
 * 覆盖的关键点：
 *   · 录入阶段没有任何副作用（不建篇章、不给题挂 passageId）
 *   · 导入后原文落在**那一卷**上，题目完全没有 passageId / passageText
 *   · 一卷一篇：同一卷二次导入只更新，不堆积多篇
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
const page = await (await b.newContext()).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

const out = [];
const t = async (n, f) => { try { out.push(`${(await f()) ? "✅" : "❌"} ${n}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0,80)}`); } };

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

const src = "AI原文卷_" + Date.now();
await page.locator('[data-admin-tab="ai"]').click();
await page.waitForTimeout(900);
// 直接用 evaluate 填值：AI 面板的分步结构让 textarea 在某些视口下不可见，
// 这里要验的是「原文挂到卷上」这条链路，不需要经���交互层
const setValue = (sel, val) => page.evaluate(([s, v]) => {
  const el = document.querySelector(s);
  el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, [sel, val]);
await setValue("#ai-source", src);
const json = JSON.stringify([
  { originalSentence: "It ______ (rain) often here.", source: src,
    blanks: [{ blankIndex: 1, answer: ["rains"], hintWord: "rain", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "例。" }] },
  { originalSentence: "It ______ (rain) often there.", source: src,
    blanks: [{ blankIndex: 1, answer: ["rains"], hintWord: "rain", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "例。" }] },
]);
await setValue("#admin-ai-json", json);
await page.waitForTimeout(1400);

await t("原文区出现且不再写「套用」", async () => {
  const box = page.locator("#admin-ai-passage");
  if (await box.isHidden()) return false;
  const txt = await box.innerText();
  return !txt.includes("套用");
});

await t("填入原文后状态变成「已填好」", async () => {
  await setValue("#admin-ai-passage-text", "IT RAINS OFTEN HERE AND THERE. THE COMMITTEE MEETS WEEKLY.");
  await page.locator("#admin-ai-passage-apply").click({ force: true });
  await page.waitForTimeout(500);
  return (await page.locator("#admin-ai-passage-status").innerText()).includes("已填好");
});

await t("导入成功", async () => {
  await page.evaluate(() => {
    document.querySelectorAll('#admin-ai-preview-list input[type="checkbox"]').forEach((c) => { c.checked = true; });
  });
  await page.locator("#admin-ai-submit").click({ force: true });
  await page.waitForTimeout(2500);
  return (await page.locator("#admin-notice").innerText()).includes("成功导入");
});

await t("原文已挂到那一卷上", async () => {
  const r = await page.evaluate(async (s) => {
    const papers = (await (await fetch("/api/papers", { credentials: "include" })).json()).papers ?? [];
    const p = papers.find((x) => x.name === s);
    if (!p) return { found: false };
    const ps = (await (await fetch(`/api/passages?paperId=${p.id}`, { credentials: "include" })).json()).passages ?? [];
    return { found: true, n: ps.length, text: ps[0]?.text ?? "" };
  }, src);
  return r.found && r.n === 1 && r.text.includes("COMMITTEE MEETS");
});

await t("题目完全没有绑定原文", async () => {
  const r = await page.evaluate(async (s) => {
    const papers = (await (await fetch("/api/papers", { credentials: "include" })).json()).papers ?? [];
    const p = papers.find((x) => x.name === s);
    const qs = (await (await fetch(`/api/questions?paperId=${p.id}`, { credentials: "include" })).json()).questions ?? [];
    return { n: qs.length, allClean: qs.every((q) => !q.passageId && !q.passageText) };
  }, src);
  return r.n === 2 && r.allClean;
});

await t("再做一次导入，原文不重复堆积（一卷一篇）", async () => {
  await page.waitForTimeout(400);
  await page.evaluate(async (s) => {
    const papers = (await (await fetch("/api/papers", { credentials: "include" })).json()).papers ?? [];
    const p = papers.find((x) => x.name === s);
    const ps = (await (await fetch(`/api/passages?paperId=${p.id}`, { credentials: "include" })).json()).passages ?? [];
    // 直接用接口再写一次，模拟二次导入同一卷
    await fetch("/api/questions", { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: [{ id: "q_e2e_9", originalSentence: "A ______ (new) one.", source: s,
        blanks: [{ blankIndex: 1, answer: ["new"], hintWord: "new", hintType: "给形容词", tagIds: ["t_001"], trapAnalysis: "例。" }] }],
        paperPassageText: "REPLACED PASSAGE TEXT." }) });
    return ps.length;
  }, src);
  const after = await page.evaluate(async (s) => {
    const papers = (await (await fetch("/api/papers", { credentials: "include" })).json()).papers ?? [];
    const p = papers.find((x) => x.name === s);
    return ((await (await fetch(`/api/passages?paperId=${p.id}`, { credentials: "include" })).json()).passages ?? []);
  }, src);
  return after.length === 1 && after[0].text === "REPLACED PASSAGE TEXT.";
});

console.log(out.join("\n"));
console.log("JS 错误:", errs.length ? [...new Set(errs)].slice(0,2).join(" | ") : "无");
await b.close();
