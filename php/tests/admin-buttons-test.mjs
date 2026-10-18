/**
 * 管理端各页签的按钮逐一验证（14 项）。
 *
 * 为什么要有这个
 * --------------
 * v3.8.9 修的 bug：删除试卷弹窗的三个按钮完全无响应——处理它们的 case
 * 写在试卷列表 <ul> 的 click 委托里，而 <dialog> 与 <ul> 平级、不在它内部，
 * 事件冒泡不到。这不是遮挡、不是 z-index、没有任何 JS 报错，
 * 静态读代码也看不出「委托挂错了容器」。
 *
 * 已有的 auth-coverage-test 扫路由鉴权、js-binding-test 扫模块导入，
 * 都覆盖不到这一类。**页面上的按钮到底能不能点，只能真的去点。**
 *
 * 覆盖 7 个页签里最容易「静默失灵」的那类按钮：委托型、innerHTML 重建型、
 * 折叠后才可见型。
 */

import { chromium } from "playwright-core";

const BASE = process.argv[2];
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text().slice(0, 150)); });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForTimeout(1500);
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

const out = [];
const t = async (name, fn) => {
  try { out.push(`${(await fn()) ? "✅" : "❌"} ${name}`); }
  catch (e) { out.push(`❌ ${name} —— ${String(e).split("\n")[0].slice(0, 90)}`); }
};

// 建一张卷 + 一个标签（供各面板有内容可操作）
await page.evaluate(async () => {
  const q = (id, s) => ({
    id, originalSentence: s, source: "审查卷", schemaVersion: 1,
    blanks: [{ blankIndex: 1, answer: ["rains"], hintWord: "rain", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "解析。" }],
  });
  await fetch("/api/questions", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [q("q_rev_1", "It ______ here."), q("q_rev_2", "It ______ there.")] }) });
});
await page.waitForTimeout(600);
await page.reload({ waitUntil: "networkidle" });

/* ---------- 手动录入 ---------- */
await t("手动录入：输入原句后自动拆空，标签可点", async () => {
  await page.locator('[data-admin-tab="manual"]').click();
  await page.waitForTimeout(400);
  // 空位是从原句自动拆出来的（renderBlanks 依赖 #admin-sentence），
  // 没有「加空」按钮——不先输入原句，标签选择器根本不会出现
  await page.locator("#admin-sentence").fill("It ______ here.");
  await page.waitForTimeout(600);
  const b = page.locator("[data-pick-tag]").first();
  if ((await b.count()) === 0) return false;
  const before = await b.getAttribute("class");
  await b.click();
  await page.waitForTimeout(300);
  return (await b.getAttribute("class")) !== before;
});

await t("手动录入：空格数随原句变化", async () => {
  await page.locator("#admin-sentence").fill("It ______ and ______ here.");
  await page.waitForTimeout(600);
  const count = await page.locator("#admin-blanks [data-blank-index]").count();
  return count >= 2;
});

/* ---------- AI 导入 ---------- */
await t("AI 导入：粘贴后预览渲染（面板监听生效）", async () => {
  await page.locator('[data-admin-tab="ai"]').click();
  await page.waitForTimeout(400);
  await page.locator("#admin-ai-json").fill(JSON.stringify({
    source: "审查卷2",
    questions: [{ originalSentence: "It ______ ok.", schemaVersion: 1,
      blanks: [{ blankIndex: 1, answer: ["works"], hintWord: "work", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "解析。" }] }],
  }));
  await page.waitForTimeout(2000);
  return (await page.locator('#admin-ai-preview [data-preview-index]').count()) > 0;
});

await t("AI 导入：原文框出现且能输入", async () => {
  const box = page.locator("#admin-ai-passage-text");
  if (!(await box.isVisible())) return false;
  await box.fill("一段测试原文。");
  await page.waitForTimeout(300);
  return (await box.inputValue()).includes("测试原文");
});

await t("AI 导入：「套用到本批题目」可点", async () => {
  await page.locator("#admin-ai-passage-apply").click();
  await page.waitForTimeout(1200);
  const status = await page.locator("#admin-ai-passage-status").innerText().catch(() => "");
  return status.includes("已套用");
});

await t("AI 导入：「清除」可点", async () => {
  await page.locator("#admin-ai-passage-clear").click();
  await page.waitForTimeout(500);
  const status = await page.locator("#admin-ai-passage-status").innerText().catch(() => "");
  return !status.includes("已套用");
});

await t("AI 导入：全选/全不选可点", async () => {
  await page.locator("#admin-ai-select-all").click();
  await page.waitForTimeout(300);
  const on = await page.locator('#admin-ai-preview input[data-preview-index]:checked').count();
  await page.locator("#admin-ai-select-none").click();
  await page.waitForTimeout(300);
  const off = await page.locator('#admin-ai-preview input[data-preview-index]:checked').count();
  return on > 0 && off === 0;
});

/* ---------- 试卷管理 ---------- */
await t("试卷管理：「成员」展开可点", async () => {
  await page.locator('[data-admin-tab="papers"]').click();
  await page.waitForTimeout(500);
  // 成员列表由 renderPaperQuestions() 渲染，而它只在点「编辑」展开后才跑
  await page.locator('button[data-action="edit-paper"]').first().click();
  await page.waitForTimeout(500);
  const viewBtn = page.locator('button[data-action="view-paper-question"]').first();
  if ((await viewBtn.count()) === 0) return false;
  await viewBtn.click();
  await page.waitForTimeout(500);
  return (await page.locator("[data-paper-q-detail]:not([hidden])").count()) > 0;
});

await t("试卷管理：卷名输入框输入有响应（编辑面板）", async () => {
  const input = page.locator("[data-edit-paper-name]");
  if ((await input.count()) === 0) return false;
  await input.fill("改名试试");
  await page.waitForTimeout(200);
  return (await input.inputValue()) === "改名试试";
});

/* ---------- 题库总览 ---------- */
await t("题库总览：试卷筛选下拉可切换", async () => {
  await page.locator('[data-admin-tab="questions"]').click();
  await page.waitForTimeout(400);
  const sel = page.locator("#question-paper-filter");
  const opts = await sel.locator("option").count();
  if (opts < 2) return true;
  await sel.selectOption({ index: 1 });
  await page.waitForTimeout(400);
  return (await sel.inputValue()) !== "";
});

await t("题库总览：勾选后批量操作条出现", async () => {
  const cb = page.locator("#question-manage-list input[type=checkbox]").first();
  if ((await cb.count()) === 0) return false;
  await cb.check();
  await page.waitForTimeout(300);
  return await page.locator("#question-bulk-bar").isVisible();
});

/* ---------- 知识点标签 ---------- */
await t("标签页签：展开/收起分组可点", async () => {
  await page.locator('[data-admin-tab="tags"]').click();
  await page.waitForTimeout(500);
  const expand = page.locator('[data-action="expand-all-tag-groups"]');
  if ((await expand.count()) === 0) return false;
  await expand.click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="collapse-all-tag-groups"]').click();
  await page.waitForTimeout(400);
  return true;
});

await t("标签页签：启停标签可点", async () => {
  await page.locator('[data-admin-tab="tags"]').click();
  await page.waitForTimeout(500);
  // 子标签默认收在折叠的分组里（按钮 0×0 不可见），必须先展开全部分组
  await page.locator('[data-action="expand-all-tag-groups"]').click();
  await page.waitForTimeout(500);
  const btn = page.locator('[data-action="toggle-tag"]').first();
  if (!(await btn.isVisible())) return false;
  const before = await btn.innerText();
  await btn.click();
  await page.waitForTimeout(1500);      // 会 reload 落回 tags 页签
  await page.locator('[data-action="expand-all-tag-groups"]').click();
  await page.waitForTimeout(500);
  const after = await page.locator('[data-action="toggle-tag"]').first().innerText();
  return before !== after;
});

/* ---------- 数据迁移 ---------- */
await t("数据迁移页签能打开", async () => {
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(400);
  return page.locator('[data-admin-panel="import"]').isVisible();
});

console.log(out.join("\n"));
const fail = out.filter((x) => x.startsWith("❌")).length;
console.log(`\n通过 ${out.length - fail} 项，失败 ${fail} 项`);
console.log(errs.length ? "JS 错误: " + [...new Set(errs)].slice(0, 3).join(" | ") : "无 JS 错误");
await browser.close();