/**
 * 弹窗在「不支持 top layer」的浏览器上仍可用（5 项）。
 *
 * 为什么要这个
 * ------------
 * 原生 `<dialog>.showModal()` 靠 top layer 把弹窗提升到独立层。
 * 部分手机浏览器（微信 / QQ 内置浏览器、若干国产 WebView）支持不完整：
 * 方法不存在、或调了但不进 top layer —— 表现是**弹窗内容看得见，
 * 但按钮点不动**（有别的东西叠在上面）。
 * v3.8.9 在桌面端修好了，手机端仍复现，根因就在这里。
 *
 * 所以 assets/js/modal.js 做了一次探测，不能用就退回 setAttribute("open")，
 * 样式由 app.css 里 `html.no-dialog dialog` 那段兜住。
 *
 * 测法：addInitScript 把 HTMLDialogElement.prototype.showModal / close
 * 删掉，强制走进降级分支，再逐项验证。
 */

/** 模拟不支持 top layer 的浏览器：把 showModal 抹掉，验证降级路径 */
import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
const ctx = await b.newContext();
await ctx.addInitScript(() => {
  // 让 modal.js 的探测判定为「不支持」
  delete HTMLDialogElement.prototype.showModal;
  delete HTMLDialogElement.prototype.close;
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 250)));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForTimeout(1500);
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

console.log("html.no-dialog 类:", await page.evaluate(() =>
  document.documentElement.classList.contains("no-dialog")) ? "✅ 已标记降级" : "❌ 未标记");

// 自造一张卷 —— 新库是空的，没有「删除」按钮可点。
// 不能依赖外部脚本先塞数据：这个套件得能独立跑。
await page.evaluate(async () => {
  await fetch("/api/papers", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "弹窗降级自测卷" }),
  });
});
await page.reload({ waitUntil: "networkidle" });
await page.locator('[data-admin-tab="papers"]').click();
await page.waitForTimeout(700);

const out = [];
const t = async (n, f) => { try { out.push(`${(await f()) ? "✅" : "❌"} ${n}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0,70)}`); } };

await t("弹窗能显示（降级路径）", async () => {
  await page.locator('button[data-action="delete-paper"]').first().click();
  await page.waitForTimeout(500);
  return page.locator("#delete-paper-dialog").isVisible();
});

await t("弹窗被正确定位（不在左上角）", async () => {
  const r = await page.locator("#delete-paper-dialog").boundingBox();
  return r && r.x > 20 && r.y > 20;
});

// v3.9.1 的降级 CSS 里写过 background:transparent; border:0，
// 特异性 0,1,2 压过 .bg-surface 的 0,1,0 —— 卡片变成全透明，
// 页面上只剩一行字悬着（用户报的）。光测「能不能点」抓不到这种问题，
// 必须断言**看得见的样式**。
await t("弹窗仍有可见背景（不是透明）", async () => {
  const bg = await page.evaluate(() => getComputedStyle(
    document.querySelector("#delete-paper-dialog")).backgroundColor);
  return !/transparent|rgba\(0, 0, 0, 0\)/.test(bg);
});

await t("弹窗仍有边框与圆角", async () => {
  const st = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector("#delete-paper-dialog"));
    return { w: cs.borderTopWidth, r: cs.borderTopLeftRadius };
  });
  return parseFloat(st.w) > 0 && parseFloat(st.r) >= 4;
});

await t("「取消」能点（这是用户报的问题）", async () => {
  await page.locator('[data-action="delete-paper-cancel"]').click();
  await page.waitForTimeout(400);
  return !(await page.locator("#delete-paper-dialog").isVisible());
});

await t("Esc 能关闭", async () => {
  await page.locator('button[data-action="delete-paper"]').first().click();
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  return !(await page.locator("#delete-paper-dialog").isVisible());
});

await t("题目编辑弹窗也能开关", async () => {
  await page.locator('[data-admin-tab="questions"]').click();
  await page.waitForTimeout(700);
  await page.locator('button[data-action="edit-question"]').first().click();
  await page.waitForTimeout(600);
  const opened = await page.locator("#question-edit-dialog").isVisible();
  await page.locator('[data-action="close-edit-question"]').first().click();
  await page.waitForTimeout(400);
  return opened && !(await page.locator("#question-edit-dialog").isVisible());
});

console.log(out.join("\n"));
console.log("JS 错误:", errs.length ? [...new Set(errs)].slice(0,2).join(" | ") : "无");
await b.close();
