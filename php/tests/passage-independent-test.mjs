/**
 * 原文与题目独立（v3.9.5）
 *
 * 模型：一张卷 = 一篇完形填空原文 + N 道独立小题。两者分别录入，
 * 录入时**没有任何自动关联**；做题页按卷取原文，折叠展示。
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2];
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 160)}`}`);
};

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});

// 造一张卷 + 两道独立录的题
const ids = await page.evaluate(async () => {
  // source 必须与卷名一致：服务端导入时是按 source 名归卷的
  // （ensure_paper_by_name），传了 paperId 也不认。名字要唯一，
  // 否则会并到上一轮遗留的同名卷上去。
  const name = "独立模型卷_" + Date.now();
  const r = await fetch("/api/papers", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const paperId = (await r.json()).paper?.id;
  const mk = (id, s) => ({
    id, originalSentence: s, source: name, paperId, schemaVersion: 1,
    blanks: [{ blankIndex: 1, answer: ["rains"], hintWord: "rain", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "例。" }],
  });
  await fetch("/api/questions", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [mk("q_ind_1", "It ______ (rain) here."), mk("q_ind_2", "It ______ (rain) there.")] }),
  });
  return { paperId, q1: "q_ind_1", q2: "q_ind_2" };
});
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await page.locator('[data-admin-tab="papers"]').click();
await page.waitForTimeout(700);

/* ---- 1. 录原文，不应动任何题 ---- */
const before = await page.evaluate(async (id) => {
  const r = await fetch(`/api/questions/${id}`, { credentials: "include" });
  const d = await r.json().catch(() => ({}));
  return { passageId: d?.passageId ?? null, passageText: (d?.passageText ?? "").slice(0, 30) };
}, ids.q1);

await page.locator(`[data-paper-manage="${ids.paperId}"] button[data-action="edit-paper"]`).click();
await page.waitForTimeout(1500);
await page.locator(`[data-paper-manage="${ids.paperId}"] [data-paper-passage-new]`).fill(
  "It rains often here. The committee meets weekly to review the plan."
);
await page.locator(`[data-paper-manage="${ids.paperId}"] button[data-action="save-paper"]`).click();
await page.waitForTimeout(2000);

const after = await page.evaluate(async (id) => {
  const r = await fetch(`/api/questions/${id}`, { credentials: "include" });
  const d = await r.json().catch(() => ({}));
  return { passageId: d?.passageId ?? null, passageText: (d?.passageText ?? "").slice(0, 30) };
}, ids.q1);

check("录原文后，题目完全没被动过（无 passageId、无 passageText）",
  before.passageId === null && after.passageId === null && !after.passageText,
  { before, after });

/* ---- 2. 原文区保存后能读回 ---- */
await page.locator('[data-admin-tab="papers"]').click();
await page.waitForTimeout(700);
await page.locator(`[data-paper-manage="${ids.paperId}"] button[data-action="edit-paper"]`).click();
await page.waitForTimeout(1500);
const shown = await page.locator(`[data-paper-manage="${ids.paperId}"] [data-paper-passage-text]`).first().inputValue().catch(() => "");
check("原文保存后能读回", shown.includes("committee meets weekly"), shown.slice(0, 40));

check("原文区不再显示「N 道题引用」（题不绑原文了）",
  !(await page.locator(`[data-paper-manage="${ids.paperId}"] [data-paper-passage]`).innerText()).includes("道题引用"));

/* ---- 3. 做题页按卷取原文，且折叠 ---- */
// 保存后页面会 reload + 整页跳转，等它彻底落定再 evaluate，
// 否则会撞上「Execution context was destroyed」
await page.waitForLoadState("networkidle").catch(() => {});
await page.goto(`${BASE}/papers/${ids.paperId}`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
const block = page.locator("[data-passage-block]");
check("做题页能拿到该卷的原文", (await block.count()) > 0);
if (await block.count()) {
  check("原文默认折叠（不直接露出答案）", !(await block.first().evaluate((el) => el.open)));
  // 用 textContent 而不是 innerText：details 折叠时内容不渲染，
  // innerText 取不到（会把 summary 那行当成全部内容）
  const txt = await block.first().evaluate((el) => el.textContent ?? "");
  check("原文内容正确（在折叠块里，展开后可见）", txt.includes("committee meets weekly"), txt.slice(0, 40));
}

/* ---- 4. 题库总览里题目独立可用（随机做题的前提）---- */
await page.goto(`${BASE}/practice`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
check("随机刷题页正常（不依赖整卷）", await page.locator("body").isVisible());

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;