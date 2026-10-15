// -*- coding: utf-8 -*-
/**
 * AI 导入预览的就地编辑 · 浏览器自测
 *
 * 覆盖：改答案 / 改解析 / 改原句文字 / 增删空 / 移除整题 / 保存校验 / 导入用改后的数据
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const SUFFIX = Date.now().toString(36);
const PAPER = `编辑自测卷_${SUFFIX}`;
const JSON_TEXT = JSON.stringify({
  source: PAPER,
  questions: [
    {
      originalSentence: "Editors ______ (fix) the typo before printing.",
      blanks: [
        { blankIndex: 1, answer: ["fixed"], hintType: "给动词", hintWord: "fix", tagIds: ["t_a"], trapAnalysis: "AI 给的解析：过去时。" },
      ],
    },
    {
      originalSentence: "Editors ______ (check) every page twice.",
      blanks: [
        { blankIndex: 1, answer: ["check"], hintType: "给动词", hintWord: "check", tagIds: ["t_a"], trapAnalysis: "AI 给的解析：动词原形。" },
      ],
    },
  ],
});

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  → ${JSON.stringify(detail ?? null).slice(0, 200)}`}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));

/* ---------------- 登录 ---------------- */
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => window.localStorage.getItem("eq_token") !== null, { timeout: 15000 });
// 登录成功会跳转首页，等导航结束再 evaluate，否则执行上下文被销毁
await page.waitForURL((url) => new URL(url).pathname === "/", { timeout: 15000 }).catch(() => {});

/* ---------------- 造数据（必须在打开 /admin 之前） ----------------
 * 页面加载时会把标签字典拍成快照（boot.tagDictionary），
 * 之后再改字典，页面里那份不会变——就地编辑的校验用的就是那份，
 * 于是「标签不在字典中」会把保存拦下。所以先造好再开页面。 */
const seedOk = await page.evaluate(async (paperName) => {
  const token = window.localStorage.getItem("eq_token");
  // 标签必须**在现有字典上追加**：整体替换会撞上服务端的保护逻辑
  // （顶级分类数量不许减少，防止误操作清空标签），直接 400
  const dict = await (await fetch("/api/tags", { headers: { Authorization: `Bearer ${token}` } })).json();
  const existing = dict.tagDictionary?.tags ?? [];
  const tags = existing.some((t) => t.id === "t_a")
    ? existing
    : [...existing, { id: "t_a", name: "自测标签", parentId: null, color: "#2563eb", isActive: true }];
  const put = await fetch("/api/tags", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagDictionary: { schemaVersion: dict.tagDictionary?.schemaVersion ?? 1, tags } }),
  });
  const created = await fetch("/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ questions: [{
      originalSentence: "Editors ______ (check) every page twice.",
      blanks: [{ blankIndex: 1, answer: ["check"], hintType: "给动词", hintWord: "check", tagIds: ["t_a"], trapAnalysis: "库里已有。" }],
    }] }),
  });
  return { putStatus: put.status, createStatus: created.status, tagCount: tags.length };
}, PAPER);
console.log("  [诊断] 造数据：", JSON.stringify(seedOk));

/* ---------------- 打开 AI 页签 ---------------- */
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await page.locator('[data-admin-tab="ai"]').click();
await page.locator("#admin-ai-json").waitFor({ state: "visible", timeout: 15000 });

await page.locator("#admin-ai-json").fill(JSON_TEXT);
await page.waitForFunction(
  () => (document.getElementById("admin-ai-preview-list")?.children.length ?? 0) > 0,
  { timeout: 20000 }
);
check("预览出 2 题", (await page.locator("#admin-ai-preview-list > *").count()) === 2);

const list = page.locator("#admin-ai-preview-list");

/* ---------------- 1) 改答案与解析 ---------------- */
await list.locator("> *").first().locator("button", { hasText: "编辑" }).click();
check("点编辑后卡片变成表单", (await list.locator("textarea").count()) > 0);

const editor = list.locator("> *").first();
await editor.locator('input[type="text"]').first().fill("fixed / corrected");
await editor.locator("textarea").last().fill("改过的解析：印刷前修正，过去时。");
check("原句空格数一致时提示正常",
  (await editor.locator("p", { hasText: "个空，配置" }).first().innerText()).includes("一致"));

await editor.locator("button", { hasText: "保存修改" }).click();
await page.waitForTimeout(1000);
console.log("  [诊断] AI 错误区：", (await page.locator("#admin-ai-error").innerText().catch(() => "(无)"))?.slice(0, 300));
await page.waitForFunction(
  () => !document.getElementById("admin-ai-preview-list")?.textContent.includes("编辑第 1 题"),
  { timeout: 15000 }
);
check("保存后回到预览态", true);
check("保存后出现「已改」徽标", (await list.innerText()).includes("已改"));

/* ---------------- 2) 移除第二题 ---------------- */
page.once("dialog", (dialog) => dialog.accept());
await list.locator("> *").nth(1).locator("button", { hasText: "移除" }).click();
await page.waitForFunction(
  () => (document.getElementById("admin-ai-preview-list")?.children.length ?? 0) === 1,
  { timeout: 15000 }
);
check("移除后只剩 1 题", (await list.locator("> *").count()) === 1);

/* ---------------- 3) 改原句文字 ---------------- */
await list.locator("> *").first().locator("button", { hasText: "编辑" }).click();
const editor2 = list.locator("> *").first();
await editor2.locator("textarea").first().fill("The editors ______ (correct) the typo before printing.");
check("改原句后空格数仍一致",
  (await editor2.locator("p", { hasText: "个空，配置" }).first().innerText()).includes("一致"));
await editor2.locator("button", { hasText: "保存修改" }).click();
await page.waitForFunction(
  () => !document.getElementById("admin-ai-preview-list")?.textContent.includes("编辑第 1 题"),
  { timeout: 15000 }
);
check("改原句后保存成功", true);

/* ---------------- 4) 增删空 ---------------- */
await list.locator("> *").first().locator("button", { hasText: "编辑" }).click();
const editor3 = list.locator("> *").first();
await editor3.locator("button", { hasText: "+ 增加一个空" }).click();
check("增加一个空后出现空 2", (await editor3.innerText()).includes("空 2"));
const afterAdd = await editor3.locator("textarea").first().inputValue();
check("原句自动补了一个 ______", afterAdd.split("______").length - 1 === 2, afterAdd);
await editor3.locator("button", { hasText: "删除这个空" }).first().click();
check("删除空后回到 1 个空", !(await editor3.innerText()).includes("空 2"));
await editor3.locator("button", { hasText: "取消" }).click();

/* ---------------- 5) 保存校验：空格数不符时拦住 ---------------- */
await list.locator("> *").first().locator("button", { hasText: "编辑" }).click();
const editor4 = list.locator("> *").first();
await editor4.locator("textarea").first().fill("The editors corrected the typo before printing.");
check("空格数不符时给出红色提示",
  (await editor4.locator("p", { hasText: "不一致" }).first().innerText()).includes("不一致"));
await editor4.locator("button", { hasText: "保存修改" }).click();
await page.waitForTimeout(800);
check("空格数不符时保存被拦下", (await list.innerText()).includes("编辑第 1 题"));
check("错误提示说明了原因",
  (await page.locator("#admin-ai-error").innerText().catch(() => "")).includes("空格数量"));
await editor4.locator("button", { hasText: "取消" }).click();

/* ---------------- 6) 导入用的是改后的数据 ---------------- */
await page.locator("#ai-source").fill(PAPER);
await page.locator("button", { hasText: "确认导入" }).first().click();
await page.waitForFunction(
  () => (document.getElementById("admin-notice")?.innerText ?? "").length > 0,
  { timeout: 25000 }
);
const notice = await page.locator("#admin-notice").innerText();
check("导入成功", notice.includes("导入"), notice.slice(0, 120));

const imported = await page.evaluate(async (paperName) => {
  const token = window.localStorage.getItem("eq_token");
  const res = await fetch("/api/questions", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return (data.questions ?? []).find((q) => q.source === paperName) ?? null;
}, PAPER);
check("导入的是改过的原句", imported?.originalSentence?.includes("(correct)") === true, imported?.originalSentence);
check("导入的是改过的答案", (imported?.blanks?.[0]?.answer ?? []).join("/") === "fixed/corrected", imported?.blanks?.[0]?.answer);
check("导入的是改过的解析", imported?.blanks?.[0]?.trapAnalysis?.includes("改过的解析") === true, imported?.blanks?.[0]?.trapAnalysis);

/* ---------------- 收尾 ---------------- */
await page.evaluate(async (paperName) => {
  const token = window.localStorage.getItem("eq_token");
  const res = await fetch("/api/questions", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const ids = (data.questions ?? []).filter((q) => String(q.source).startsWith("编辑自测卷_")).map((q) => q.id);
  if (ids.length > 0) {
    await fetch("/api/questions/batch", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids }),
    });
  }
  await fetch("/api/bank/reset", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}, PAPER);

check("全程无 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 3));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length > 0) {
  console.log("失败清单：");
  failed.forEach((f) => console.log(`  - ${f.label}`));
  process.exitCode = 1;
}
