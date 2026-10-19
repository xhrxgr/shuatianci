/**
 * 选题在进入之前做（8 项，v3.9.8）
 *
 * 用户原话：「筛选做的题目应该在进入之前选好了再进去，
 * 这样既可以筛选也可以干净做题页面」。
 *
 * 刷题页原来的筛选栏实测在手机 420×900 下高 1034px，
 * 题目要滚过 58% 屏高才出现 —— 而那一屏几乎全是
 * 「介词-时间 0」这种筛不了的标签。
 *
 * 现在的分工：
 *   首页 #pick 面板 → 勾考点 → 跳 /practice?tags=…
 *   刷题页         → 只有题目 + 一条范围说明 + 「换个考点」
 *
 * 走一遍完整链路：勾选 → 跳转 → 说明对得上 → 页面干净。
 */

import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
const errs = [];
const page = await (await b.newContext({ colorScheme: "dark", viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 })).newPage();
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 200)));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});

const out = [];
const t = async (n, f) => { try { out.push(`${(await f()) ? "✅" : "❌"} ${n}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0,70)}`); } };

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

await t("首页有「按考点选题」面板", async () =>
  (await page.locator("#pick-groups button[data-pick-tag]").count()) > 0);

const tagId = await page.evaluate(() =>
  document.querySelector("#pick-groups button[data-pick-tag]")?.dataset.pickTag ?? "");

await t("勾选考点后状态更新", async () => {
  await page.locator(`[data-pick-tag="${tagId}"]`).click();
  await page.waitForTimeout(300);
  return (await page.locator("#pick-status").innerText()).includes("已选 1 个考点");
});

await page.locator("#pick-go").click();
await page.waitForTimeout(2200);

await t("跳转到 /practice?tags=…", async () =>
  page.url().includes("tags="));

await t("做题页顶部说明「正在刷考点」", async () => {
  const txt = await page.locator("#practice-root").innerText();
  return txt.includes("正在刷考点");
});

await t("做题页有「换个考点」入口", async () =>
  (await page.locator('a', { hasText: "换个考点" }).count()) > 0);

await t("做题页没有筛选栏", async () =>
  await page.evaluate(() => {
    const el = document.getElementById("practice-filter");
    return !el || el.offsetParent === null;
  }));

await t("题目出现在首屏上半部分", async () => {
  const m = await page.evaluate(() => {
    const c = document.querySelector("#practice-card") || document.querySelector("[id*=card]");
    return c ? Math.round(c.getBoundingClientRect().top) / window.innerHeight : 1;
  });
  return m < 0.5;
});
await page.screenshot({ path: "E:/pd/shuawanxing/shots/pick-practice.png" });

await t("清空勾选后能刷全部", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.locator(`[data-pick-tag="${tagId}"]`).click();
  await page.locator("#pick-reset").click();
  await page.waitForTimeout(300);
  return (await page.locator("#pick-status").innerText()).includes("未勾选");
});

console.log(out.join("\n"));
// 汇总 + 退出码：缺了这条，测试失败时进程仍返回 0，
// 批处理里会被当成「通过」，绿得莫名其妙。
const jsErrors = [...new Set(errs)].filter((e) => e.startsWith("PAGEERROR"));
console.log("JS 错误:", jsErrors.length ? jsErrors.slice(0, 2).join(" | ") : "无");
const failed = out.filter((line) => line.startsWith("❌")).length;
  console.log(`
通过 8 项，失败 ${failed} 项`);
process.exitCode = failed > 0 || jsErrors.length > 0 ? 1 : 0;
await b.close();
