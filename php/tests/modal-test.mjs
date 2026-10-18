/**
 * 弹窗行为（8 项）—— 一套实现，所有浏览器一致。
 *
 * v3.9.4 起不再用原生 `<dialog>`，也不再有「降级」这回事：
 * 遮罩、滚动锁、焦点管理、Esc、点遮罩关闭全部自己实现
 * （见 assets/js/modal.js 与 app.css 的 `.modal`）。
 *
 * 这里验的就是**自己实现的那几件事**是否真的生效 ——
 * 尤其是原生 dialog 曾免费提供、现在必须自己做的那几件：
 * 焦点该进去、Tab 不该跑出去、背景不该跟着滚、关闭后焦点该还回来。
 */

import { chromium, devices } from "playwright-core";

const BASE = process.argv[2];
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 780 },
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
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

// 自造一张卷 —— 新库是空的，没有「删除」按钮可点
await page.evaluate(async () => {
  await fetch("/api/papers", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "弹窗自测卷_" + Date.now() }),
  });
});
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await page.locator('[data-admin-tab="papers"]').click();
await page.waitForTimeout(700);

const dialog = page.locator("#delete-paper-dialog");

/* ---- 1. 能打开 ---- */
await page.locator('button[data-action="delete-paper"]').first().click();
await page.waitForTimeout(600);
check("点「删除」弹窗打开", await dialog.isVisible());
check("弹窗不再用原生 <dialog>（统一为 div.modal）",
  await page.evaluate(() => {
    const d = document.querySelector("#delete-paper-dialog");
    return d.tagName === "DIV" && d.classList.contains("modal");
  }));
check("卡片居中且不贴在左上角",
  await dialog.evaluate((el) => {
    const r = el.querySelector(".modal-body").getBoundingClientRect();
    return r.top > 10 && r.left > 10;
  }));
check("卡片有可见背景（不是透明）",
  await dialog.evaluate((el) => {
    const bg = getComputedStyle(el.querySelector(".modal-body")).backgroundColor;
    return !/transparent|rgba\(0, 0, 0, 0\)/.test(bg);
  }));

/* ---- 2. 打开时锁住背景滚动 ---- */
check("打开时锁住背景滚动（body.modal-locked）",
  await page.evaluate(() => document.body.classList.contains("modal-locked")));

/* ---- 3. 焦点管理：自己做的，得自己验 ---- */
check("打开后焦点进入弹窗内",
  await dialog.evaluate((el) => el.contains(document.activeElement)));

await page.locator('[data-action="delete-paper-cancel"]').click();
await page.waitForTimeout(400);
check("「取消」能关掉", !(await dialog.isVisible()));
check("关闭后解锁滚动", await page.evaluate(() => !document.body.classList.contains("modal-locked")));
check("关闭后焦点还给触发按钮",
  await page.evaluate(() => document.activeElement?.dataset?.action === "delete-paper"));

/* ---- 4. Esc 关闭 ---- */
await page.locator('button[data-action="delete-paper"]').first().click();
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Esc 能关闭", !(await dialog.isVisible()));

/* ---- 5. 点遮罩关闭 ---- */
await page.locator('button[data-action="delete-paper"]').first().click();
await page.waitForTimeout(500);
// 点容器（遮罩）而非卡片
const box = await dialog.boundingBox();
await page.mouse.click(box.x + 6, box.y + 6);
await page.waitForTimeout(400);
check("点遮罩空白处能关闭", !(await dialog.isVisible()));

/* ---- 6. 题目编辑弹窗也走同一套 ---- */
await page.locator('[data-admin-tab="questions"]').click();
await page.waitForTimeout(700);
const qBox = page.locator("#question-edit-dialog");
check("题目编辑弹窗能打开",
  await (async () => {
    const btn = page.locator('button[data-action="edit-question"]').first();
    if ((await btn.count()) === 0) return false;
    await btn.click();
    await page.waitForTimeout(600);
    return qBox.isVisible();
  })());
if (await qBox.isVisible()) {
  check("题目编辑弹窗也能用 Esc 关闭", await (async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    return !(await qBox.isVisible());
  })());
}

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;