// -*- coding: utf-8 -*-
/** 最小验证：v3.6.14 的两个新入口（试卷管理看题目 + 导入成功卡片） */
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 160)}`}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => window.localStorage.getItem("eq_token") !== null, { timeout: 15000 });
await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 15000 }).catch(() => {});

/* ---- 0) 先建一张卷并归一道题（种子库不一定有 papers 行，不依赖它）---- */
await page.evaluate(async () => {
  const token = window.localStorage.getItem("eq_token");
  const name = `入口自测卷_${Date.now().toString(36)}`;
  const created = await fetch("/api/papers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, examDate: "2026-10-16" }),
  });
  const paper = (await created.json()).paper;
  const q = await fetch("/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ questions: [{
      originalSentence: "The passage ______ (read) clearly in the preview.",
      blanks: [{ blankIndex: 1, answer: ["reads"], hintType: "给动词", hintWord: "read", tagIds: [], trapAnalysis: "入口自测解析。" }],
    }] }),
  });
  const added = await q.json();
  const list = await (await fetch("/api/questions", { headers: { Authorization: `Bearer ${token}` } })).json();
  const mine = (list.questions ?? []).find((x) => String(x.originalSentence).startsWith("The passage ______"));
  if (mine) {
    await fetch(`/api/questions/${mine.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ paperId: paper.id }),
    });
  }
  window.__testPaperId = paper?.id ?? "";
});

/* ---- 1) 试卷管理：展开一张卷能看到题目 + 查看/编辑入口 ---- */
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
// 首屏可能还在 bootstrap（建库 + 导种子要十几秒），等试卷列表真的渲染出来再操作
await page.waitForFunction(
  () => document.querySelectorAll("[data-paper-manage]").length > 0,
  { timeout: 40000 }
);
await page.locator('[data-admin-tab="papers"]').click();
const firstPaper = page.locator("[data-paper-manage]").first();
await firstPaper.locator('[data-action="edit-paper"]').click();
const qBox = firstPaper.locator("[data-paper-questions]");
await qBox.waitFor({ state: "visible", timeout: 15000 });
const qCount = await qBox.locator("li").count();
check("展开试卷后列出该卷题目", qCount >= 1, qCount);
check("有「编辑」入口", (await qBox.locator('[data-action="edit-paper-question"]').count()) >= 1);
check("有「查看」入口", (await qBox.locator('[data-action="view-paper-question"]').count()) >= 1);

await qBox.locator('[data-action="view-paper-question"]').first().click();
await page.waitForTimeout(500);
check("查看后展开题目明细", (await qBox.locator("[data-paper-q-detail]:not([hidden])").count()) >= 1);

/* ---- 2) 编辑弹窗：提示词输入框在（v3.6.13 补的）---- */
await qBox.locator('[data-action="edit-paper-question"]').first().click();
await page.waitForTimeout(500);
const dialog = page.locator("#question-edit-dialog");
check("编辑弹窗打开", await dialog.isVisible());
check("编辑弹窗有「完整原文」框", (await page.locator("#edit-question-passage").count()) === 1);
check("编辑弹窗有「提示词」输入框（v3.6.13 补）",
  (await page.locator("[data-edit-hint-word]").count()) >= 1);
await page.locator('#question-edit-dialog [data-action="close-edit-question"]').first().click();

/* ---- 3) 导入成功卡片 ---- */
await page.locator('[data-admin-tab="ai"]').click();
await page.locator("#admin-ai-json").fill(JSON.stringify({
  source: `提示样式自测_${Date.now().toString(36)}`,
  questions: [{
    originalSentence: "The notice ______ (show) clearly now.",
    blanks: [{ blankIndex: 1, answer: ["shows"], hintType: "给动词", hintWord: "show", tagIds: [], trapAnalysis: "自测。" }],
  }],
}));
await page.waitForFunction(
  () => (document.getElementById("admin-ai-preview-list")?.children.length ?? 0) > 0,
  { timeout: 20000 }
);
await page.locator("#ai-source").fill(`提示样式自测_${Date.now().toString(36)}`);
await page.locator("button", { hasText: "确认导入" }).first().click();
await page.waitForFunction(
  () => {
    const box = document.getElementById("admin-notice");
    return box && !box.hidden && box.textContent.includes("成功导入");
  },
  { timeout: 25000 }
);
const noticeText = await page.locator("#admin-notice").innerText();
check("导入成功提示出现", noticeText.includes("成功导入"), noticeText.slice(0, 80));
check("提示里分行显示来源", noticeText.includes("来源："), noticeText.slice(0, 120));
check("提示带「去题库总览看看」入口",
  (await page.locator('#admin-notice [data-action="notice-goto-questions"]').count()) === 1);

// 清理
await page.evaluate(async () => {
  const token = window.localStorage.getItem("eq_token");
  const res = await fetch("/api/questions", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const ids = (data.questions ?? []).filter((q) => String(q.source).startsWith("提示样式自测_")).map((q) => q.id);
  if (ids.length > 0) {
    await fetch("/api/questions/batch", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids }),
    });
  }
  await fetch("/api/bank/reset", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
});

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
process.exitCode = failed.length > 0 ? 1 : 0;
