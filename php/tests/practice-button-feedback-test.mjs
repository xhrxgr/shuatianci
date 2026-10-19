/**
 * 刷题页按钮的「点了有反应」（9 项，v3.11.0）
 *
 * 用户报「下一题」和「标记为已掌握」点击无响应。根因有两类，都不是事件绑定坏了：
 *
 *   ① **按钮不反映当前状态** —— 题目已经是「已掌握」时，按钮仍显示
 *      「标记为已掌握」且可点，但点了 status 本来就是 mastered，什么都不变。
 *      用户看到的就是「点了没反应」。改成双向切换：已掌握时显示「取消『已掌握』」。
 *
 *   ② **末题仍然显示可点的「下一题」** —— 内部 `disabled` 掉了，但没告诉用户
 *      「这是最后一道」，于是点下去毫无反应。现在改成 disabled + 「已是最后一题」。
 *
 * 另外验 CSS 侧的 `flex-1`：v3.10.0 给 flex 容器里的 button 加了 `flex: none`，
 * 会把按钮自带的 `flex-1` 顶掉 —— 两个按钮被压到 134px。已加排除规则。
 *
 * ⚠️ 这个套件**依赖干净库**：它会改题目的掌握状态，
 * 重复跑时第一题的初始状态可能已经是 mastered，断言前提会变。
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
const errs = [];
const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 220)));
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});
await page.goto(`${BASE}/practice`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const out = [];
const t = async (n, f) => { try { out.push(`${(await f()) ? "✅" : "❌"} ${n}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0,70)}`); } };

const badge = () => page.evaluate(() => document.querySelector("#practice-card header span:last-child")?.textContent.trim() ?? "无");
const masterLabel = () => page.evaluate(() => document.querySelector('button[data-action="master"]')?.textContent.trim() ?? "无按钮");

// 造一道未掌握的题：用答案反例填，确保走到「标记为已掌握」形态
const info = await page.evaluate(async () => {
  const d = await (await fetch("/api/questions", { credentials: "include" })).json();
  const q = d.questions?.[0];
  return { ans: q?.blanks?.[0]?.answer?.[0] ?? "x", status: q?.status ?? "?" };
});
console.log("题目初始 status:", info.status, "| 答案:", info.ans);

await page.locator("#practice-card input").first().fill(info.ans);
await page.locator("#practice-card button", { hasText: "提交" }).first().click();
await page.waitForTimeout(1200);

await t("解析区两个按钮撑满整行（flex-1 生效）", async () => {
  const w = await page.evaluate(() => {
    const a = document.querySelector('button[data-action="next"]')?.getBoundingClientRect().width ?? 0;
    const b2 = document.querySelector('button[data-action="master"]')?.getBoundingClientRect().width ?? 0;
    return Math.round(a) + Math.round(b2);
  });
  return w > 400;   // 两个按钮合计应接近容器宽度（~600px）
});

// 这道题初始是未掌握 —— 正好验「未掌握 → 已掌握」这一向
await t("未掌握的题：按钮显示「标记为已掌握」", async () =>
  (await masterLabel()).includes("标记为已掌握"));
await t("未掌握的题：徽标是「未掌握」", async () => (await badge()) === "未掌握");

await t("点一次标记为已掌握", async () => {
  await page.locator('button[data-action="master"]').click();
  await page.waitForTimeout(1200);
  return (await badge()) === "已掌握";
});
await t("已掌握后按钮变成「取消『已掌握』」（不再是无反馈的死按钮）", async () =>
  (await masterLabel()).includes("取消"));

await t("再点一次能取消（双向可用）", async () => {
  await page.locator('button[data-action="master"]').click();
  await page.waitForTimeout(1200);
  return (await badge()) === "未掌握";
});
await t("取消后按钮变回「标记为已掌握」", async () =>
  (await masterLabel()).includes("标记为已掌握"));

// 走到最后一题
for (let i = 0; i < 8; i++) {
  const nx = page.locator('#practice-pager button:last-child');
  if (!(await nx.count()) || (await nx.isDisabled())) break;
  await nx.click().catch(() => {});
  await page.waitForTimeout(450);
}
await page.locator("#practice-card input").first().fill("x");
await page.locator("#practice-card button", { hasText: "提交" }).first().click().catch(() => {});
await page.waitForTimeout(1000);

await t("最后一题：解析区按钮显示「已是最后一题」并禁用", async () =>
  await page.evaluate(() => {
    const el = document.querySelector('button[data-action="next"]');
    if (!el) return false;
    return el.disabled === true && el.textContent.includes("已是最后一题");
  }));
await t("最后一题：底部翻页按钮也禁用（有文案说明）", async () =>
  await page.evaluate(() => {
    const el = document.querySelector("#practice-next");
    return el ? el.disabled === true : true;
  }));

const TOTAL = 9;
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("❌")).length;
const realErrs = [...new Set(errs)].filter((e) => e.startsWith("PAGEERROR"));
console.log(`\n通过 ${TOTAL - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 || realErrs.length > 0 ? 1 : 0;
await b.close();
