// 线上实测：只做只读操作。不点「开始更新」（会真的执行 git reset），
// 也不点「测试更新源」（会临时改写服务器上的更新配置）。
import { chromium } from "playwright-core";

const BASE = "https://stc.364354.xyz:2022";
const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-certificate-errors"] });
const p = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();

const errors = [];
const consoleErrors = [];
const apiCalls = [];
p.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
p.on("console", (m) => {
  if (m.type() !== "error") return;
  const url = m.location()?.url ?? "";
  if (url.includes("favicon")) return;
  consoleErrors.push(`${url.slice(-30)} ${m.text().slice(0, 100)}`);
});
p.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/system")) apiCalls.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, "")}`);
});

console.log("1) 打开登录页…");
await p.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 45000 });
await p.locator("#username").fill("admin");
await p.locator("#password").fill("123456");
await p.locator("#login-submit").click();
await p.waitForFunction(() => localStorage.getItem("eq_token") !== null, { timeout: 20000 });
await p.waitForLoadState("networkidle").catch(() => {});

console.log("2) 进系统设置页…");
await p.goto(`${BASE}/admin/system`, { waitUntil: "networkidle", timeout: 45000 });
await p.waitForTimeout(2000);

const body = await p.locator("body").innerText();
const version = (body.match(/[0-9a-f]{7}/) ?? ["(未识别)"])[0];
console.log("   页面上显示的提交:", version);

// 区块顺序：进度块现在应该在「检查更新」之后
const order = await p.evaluate(() => {
  const secs = [...document.querySelectorAll("#admin-system-root section")];
  return secs.map((s) => {
    const h = s.querySelector("h2");
    return h ? h.textContent.trim() : "(无标题)";
  });
});
console.log("3) 区块顺序:", order.join(" → "));
const progressIdx = order.indexOf("更新进度");
const checkIdx = order.indexOf("检查更新");
console.log(
  "   进度紧跟检查更新:",
  progressIdx === checkIdx + 1 ? "是" : `否（进度在第 ${progressIdx + 1} 位，检查更新在第 ${checkIdx + 1} 位）`
);

console.log("4) 点「检查更新」（只读，会跑 git fetch）…");
const btn = p.locator("button", { hasText: "检查更新" }).first();
if (await btn.count()) {
  const t0 = Date.now();
  await btn.click();
  const done = await p
    .waitForFunction(() => !document.body.innerText.includes("检查中"), { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const text = await p.locator("body").innerText();
  const result = (text.match(/(已是最新版本|发现新版本|正在更新|执行超时[^）\n]*|连不上[^）\n]*|失败|错误)[^\n]{0,90}/) ?? ["(未匹配到已知文案)"])[0];
  console.log(`   ${done ? "有返回" : "仍在检查中"}，耗时 ${secs}s`);
  console.log("   结果:", result.slice(0, 130));
} else {
  console.log("   没找到「检查更新」按钮");
}

console.log("5) API 调用:", apiCalls.length ? apiCalls.join(" | ") : "(无)");
console.log("6) 未捕获异常:", errors.length ? errors.slice(0, 3).join(" ; ") : "(无)");
console.log("7) 控制台错误:", consoleErrors.length ? consoleErrors.slice(0, 3).join(" ; ") : "(无)");

await b.close();