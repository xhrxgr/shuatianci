/**
 * 「本卷原文」编辑区（v3.9.0，10 项）。
 *
 * 模型：一道大题 = 一篇原文 + N 道最小填空题，两者独立。
 * 原文只存一份挂在试卷上，编辑入口在**试卷这一层**（题目列表之外），
 * 改一次全卷生效 —— 单题编辑里没有这个字段。
 *
 * 覆盖的关键行为：
 *   · 没原文时给新建表单，填了保存后能回填
 *   · 建篇章时把本卷所有未关联的题都指过来（一卷一篇）
 *   · 改一次原文，所有引用它的题立刻看到新内容
 *   · 单题编辑与手动录入都不再有原文字段
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForTimeout(1500);
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

const out = [];
const t = async (n, fn) => { try { out.push(`${(await fn()) ? "✅" : "❌"} ${n}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0,80)}`); } };

// 造一张卷 + 两道题
const made = await page.evaluate(async () => {
  const r = await fetch("/api/papers", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "原文验证卷" }) });
  const p = await r.json();
  const pid = p.paper?.id;
  const mk = (id, s) => ({ id, originalSentence: s, source: "原文验证卷", paperId: pid, schemaVersion: 1,
    blanks: [{ blankIndex: 1, answer: ["rains"], hintWord: "rain", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "t" }] });
  await fetch("/api/questions", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [mk("q_pp_1", "It ______ here."), mk("q_pp_2", "It ______ there.")] }) });
  return pid;
});
console.log("试卷 id:", made);
await page.reload({ waitUntil: "networkidle" });
await page.locator('[data-admin-tab="papers"]').click();
await page.waitForTimeout(600);

await t("试卷列表出现该卷", async () =>
  (await page.locator(`[data-paper-manage="${made}"]`).count()) === 1);

await t("展开编辑面板后出现「本卷原文」区", async () => {
  await page.locator(`[data-paper-manage="${made}"] button[data-action="edit-paper"]`).click();
  await page.waitForTimeout(900);
  return (await page.locator(`[data-paper-manage="${made}"] [data-paper-passage]`).count()) === 1;
});

await t("没有原文时给出新建表单", async () =>
  (await page.locator(`[data-paper-manage="${made}"] [data-paper-passage-new]`).count()) === 1);

await t("填写原文并保存", async () => {
  await page.locator(`[data-paper-manage="${made}"] [data-paper-passage-new]`).fill("It rains often here. The sun is rare.");
  await page.once("dialog", (d) => d.accept());
  await page.locator(`[data-paper-manage="${made}"] button[data-action="save-paper"]`).click();
  await page.waitForTimeout(2000);
  await page.waitForLoadState("networkidle").catch(() => {});
  return true;
});

await page.locator('[data-admin-tab="papers"]').click();
await page.waitForTimeout(600);
await page.locator(`[data-paper-manage="${made}"] button[data-action="edit-paper"]`).click();
await page.waitForTimeout(900);

await t("保存后原文区显示已有篇章（可编辑）", async () =>
  (await page.locator(`[data-paper-manage="${made}"] [data-paper-passage-text]`).count()) === 1);

const shown = await page.locator(`[data-paper-manage="${made}"] [data-paper-passage-text]`).first().inputValue().catch(() => "");
await t("原文内容正确回填", async () => shown.includes("It rains often"));

await t("改原文后保存生效", async () => {
  await page.locator(`[data-paper-manage="${made}"] [data-paper-passage-text]`).first().fill("CHANGED PASSAGE TEXT HERE.");
  await page.locator(`[data-paper-manage="${made}"] button[data-action="save-paper"]`).click();
  await page.waitForTimeout(2000);
  const after = await page.evaluate(async (pid) => {
    const r = await fetch(`/api/questions?paperId=${pid}`, { credentials: "include" });
    return (await r.json()).questions ?? [];
  }, made);
  return after.length > 0 && (after[0].passageText ?? "").includes("CHANGED PASSAGE TEXT");
});

await t("两题共享同一篇原文（questionCount=2）", async () => {
  await page.locator('[data-admin-tab="papers"]').click();
  await page.waitForTimeout(600);
  await page.locator(`[data-paper-manage="${made}"] button[data-action="edit-paper"]`).click();
  await page.waitForTimeout(900);
  const txt = await page.locator(`[data-paper-manage="${made}"] [data-paper-passage]`).innerText();
  return /2 道题引用/.test(txt);
});

await t("单题编辑弹窗里没有原文字段", async () => {
  await page.locator(`[data-paper-manage="${made}"] button[data-action="edit-paper-question"]`).first().click();
  await page.waitForTimeout(600);
  const has = await page.locator("#edit-question-passage").count();
  await page.locator('[data-action="close-edit-question"]').first().click();
  return has === 0;
});

await t("手动录入页没有原文字段", async () => {
  await page.locator('[data-admin-tab="manual"]').click();
  await page.waitForTimeout(500);
  return (await page.locator("#admin-passage").count()) === 0;
});

console.log(out.join("\n"));
const fail = out.filter((x) => x.startsWith("❌")).length;
console.log(`\n通过 ${out.length - fail} 项，失败 ${fail} 项`);
console.log(errs.length ? "JS 错误: " + [...new Set(errs)].slice(0,3).join(" | ") : "无 JS 错误");
await browser.close();