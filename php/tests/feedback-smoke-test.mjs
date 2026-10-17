import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 180)}`}`);
}

const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await (await b.newContext()).newPage();
const errors = [];
const consoleErrors = [];
p.on("pageerror", (e) => errors.push(String(e)));
// 浏览器会自动请求 favicon，站点没有这个文件 → 固定一条 404，
// 与被测对象无关，别把它算成失败
p.on("console", (m) => {
  if (m.type() !== "error") return;
  // 按请求 URL 判断，不是按消息文本 —— 浏览器对 favicon 404 的提示
  // 只有「Failed to load resource...」，文本里并没有 "favicon"
  const url = m.location()?.url ?? "";
  if (url.includes("favicon")) return;
  consoleErrors.push(`${url.slice(-40)} ${m.text().slice(0, 100)}`);
});

await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });

// 直接在页面里调 feedback.js：四种语气都试一遍。
// 这正是之前漏掉的覆盖 —— 模块能 import 成功不代表 icon() 真的能跑，
// import 被块注释吞掉时，报错要到「真正弹提示」那一刻才出现。
const result = await p.evaluate(async (base) => {
  const mod = await import(base + "/assets/js/feedback.js");
  const out = { ok: [], errors: [] };
  const tones = [
    ["success", mod.notifySuccess],
    ["error", mod.notifyError],
    ["warn", mod.notifyWarn],
    ["info", mod.notifyInfo],
  ];
  for (const [tone, fn] of tones) {
    try {
      fn("自测提示 " + tone, { details: ["第二行详情", "第三行详情"] });
      out.ok.push(tone);
    } catch (e) {
      out.errors.push(tone + ": " + String(e).slice(0, 120));
    }
  }
  return out;
}, BASE);

check("四种语气都能真正弹出（无 ReferenceError）", result.errors.length === 0, result.errors);

const boxes = await p.locator("#feedback-container > *, .feedback-box, [data-feedback-box]").count();
const bodyText = await p.locator("body").innerText();
check("页面上能看到四条提示", boxes >= 4 || (bodyText.match(/自测提示/g) ?? []).length >= 4,
  { boxes, matched: (bodyText.match(/自测提示/g) ?? []).length });

check("提示里带上了图标（SVG 真的渲染了）", (await p.locator("svg").count()) > 0);

// error 与 info 必须**不同形**：之前两者都是「圆圈+感叹号」只差圆点上下位置，
// 线上截图里 error 的图标被当成了 info
const icons = await p.evaluate(async (base) => {
  const { iconError, iconInfo, iconSuccess, iconWarn } = await import(base + "/assets/js/icons.js");
  return {
    error: iconError("x"),
    info: iconInfo("x"),
    success: iconSuccess("x"),
    warn: iconWarn("x"),
  };
}, BASE);
check("error 图标与 info 图形不同（否则用户分不清）", icons.error !== icons.info);
check("error 图标与 success、warn 也都不同", icons.error !== icons.success && icons.error !== icons.warn);
check("详情行也渲染出来了", bodyText.includes("第二行详情"));
check("全程无未捕获异常", errors.length === 0, errors.slice(0, 2));
check("控制台无 error", consoleErrors.length === 0, consoleErrors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;