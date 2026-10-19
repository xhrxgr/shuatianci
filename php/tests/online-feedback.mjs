// 线上验证提示系统（v3.7.7 修的那个阻断问题）。
// 只调提示组件本身，不触发任何写操作。
import { chromium } from "playwright-core";

/**
 * 被测站点地址。**不要把真实地址写进代码** —— 仓库是公开的。
 * 线上实测时这样跑：
 *   EQ_BASE=https://your.host:port node php/tests/online-check.mjs
 * 默认值指向本地开发服务器，方便不传环境变量时也能跑通。
 */
const BASE = process.env.EQ_BASE || "http://127.0.0.1:9002";
const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-certificate-errors"] });
const p = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));

await p.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 45000 });
await p.locator("#username").fill("admin");
await p.locator("#password").fill("123456");
await p.locator("#login-submit").click();
await p.waitForFunction(() => localStorage.getItem("eq_token") !== null, { timeout: 20000 });
await p.waitForLoadState("networkidle").catch(() => {});
await p.goto(`${BASE}/admin/system`, { waitUntil: "networkidle", timeout: 45000 });
await p.waitForTimeout(1500);

const result = await p.evaluate(async (base) => {
  const mod = await import(base + "/assets/js/feedback.js");
  const out = { ok: [], errors: [] };
  const cases = [
    ["success", () => mod.notifySuccess("线上自测：操作成功")],
    ["error", () => mod.notifyError(new Error("线上自测：这一步失败了"), { details: ["原因一", "原因二"] })],
    ["warn", () => mod.notifyWarn("线上自测：注意这个")],
    ["info", () => mod.notifyInfo("线上自测：提示信息")],
  ];
  for (const [tone, fn] of cases) {
    try {
      fn();
      out.ok.push(tone);
    } catch (e) {
      out.errors.push(`${tone}: ${String(e).slice(0, 140)}`);
    }
  }
  return out;
}, BASE);

console.log("四种语气调用:", result.ok.length === 4 ? "全部成功" : result.ok.join(", "));
console.log("抛错的情况:", result.errors.length ? result.errors.join(" ; ") : "无（提示系统是活的）");

await p.waitForTimeout(600);
const text = await p.locator("body").innerText();
const matched = (text.match(/线上自测/g) ?? []).length;
console.log("页面上出现的提示条数:", matched);
console.log("详情行是否渲染:", text.includes("原因一") ? "是" : "否");
const svgInFeedback = await p.evaluate(() => {
  const box = document.querySelector("#feedback-container, .feedback-box, [data-feedback-box]");
  return box ? box.querySelectorAll("svg").length : 0;
});
console.log("提示里的 SVG 图标数:", svgInFeedback, svgInFeedback > 0 ? "（图标正常渲染）" : "（没有图标）");
console.log("未捕获异常:", errors.length ? errors.join(" ; ") : "无");

await p.screenshot({ path: "tmp/online-feedback.png", fullPage: false });
console.log("截图已存: tmp/online-feedback.png");

await b.close();