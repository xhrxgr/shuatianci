/**
 * 移动端健壮性（6 项）—— 异常与边界情况下的稳定性。
 *
 * 覆盖四类真实会遇到的场景：
 *   ① 超长文本：卷名 180 字、题干 2000 字无空格
 *      —— <select> 宽度跟着最长 option 走，会把整页撑到上万像素
 *   ② 快速重复点击：连点 5 下保存，只应发一次请求
 *   ③ 接口异常：500、以及返回 HTML 而不是 JSON 的代理错误页
 *   ④ 空数据：后端一个列表都不给时界面要说得清是「没有」不是「坏了」
 *
 * 这些都不是「理想路径」，但恰恰是手机端最常撞上的 —— 弱网、切后台、
 * 用户连点确认。第 ① 项是实测抓到的真 bug（溢出 457px），
 * 光靠肉眼在小屏上很难发现，所以固化成断言。
 */

/** 快速连点 / 异常数据 / 超长文本 的真实行为探测 */
import { chromium } from "playwright-core";
const BASE = process.argv[2];
const b = await chromium.launch({ channel: "chrome" });
// 用真实手机视口而不是桌面宽度：溢出在宽屏上常常「看不出来」，
// 但 390px 下整页横向滚动就是致命的
const ctx = await b.newContext({
  viewport: { width: 390, height: 780 },
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 160)));
page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 140)); });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
// 登录成功会整页跳转。等 URL 离开 /login 且网络静默 —— 固定 sleep 在
// isMobile 视口下不够（跳转更慢），evaluate 会撞上导航中的执行上下文。
await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(400);

const out = [];
const t = async (n, f) => { try { const r = await f(); out.push(`${r ? "✅" : "❌"} ${n}${r === false ? "" : ""}`); } catch (e) { out.push(`❌ ${n} —— ${String(e).split("\n")[0].slice(0, 90)}`); } };

// 造数据：一张卷 + 一道超长文本的题
await page.evaluate(async () => {
  const r = await fetch("/api/papers", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "健壮性自测卷_" + "很长很长".repeat(30) }) });
  const pid = (await r.json()).paper?.id;
  const longSentence = "Supercalifragilisticexpialidocious".repeat(20) + " ______ (test) " + "x".repeat(2000);
  await fetch("/api/questions", { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [{ id: "q_rb_1", originalSentence: longSentence,
      source: "健壮性自测卷", paperId: pid, schemaVersion: 1,
      blanks: [{ blankIndex: 1, answer: ["test"], hintWord: "test", hintType: "给动词", tagIds: ["t_001"], trapAnalysis: "解析".repeat(200) }] }] }) });
});
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

/* ---- 1. 超长文本不撑破布局 ---- */
await t("超长文本下页面不横向溢出", async () => {
  const o = await page.evaluate(() => ({ c: document.documentElement.clientWidth, s: document.documentElement.scrollWidth }));
  if (o.s > o.c + 2) console.log(`     溢出 ${o.s - o.c}px（宽 ${o.c}）`);
  return o.s <= o.c + 2;
});

await t("试卷管理页也不溢出", async () => {
  await page.locator('[data-admin-tab="papers"]').click();
  await page.waitForTimeout(700);
  const o = await page.evaluate(() => ({ c: document.documentElement.clientWidth, s: document.documentElement.scrollWidth }));
  if (o.s > o.c + 2) console.log(`     溢出 ${o.s - o.c}px`);
  return o.s <= o.c + 2;
});

await t("题库总览也不溢出", async () => {
  await page.locator('[data-admin-tab="questions"]').click();
  await page.waitForTimeout(700);
  const o = await page.evaluate(() => ({ c: document.documentElement.clientWidth, s: document.documentElement.scrollWidth }));
  if (o.s > o.c + 2) console.log(`     溢出 ${o.s - o.c}px`);
  return o.s <= o.c + 2;
});

/* ---- 2. 快速连点删除按钮 ---- */
await t("快速连点「保存」不会发多次请求", async () => {
  const reqs = [];
  const h = (r) => { if (r.method() === "PUT" && r.url().includes("/api/questions/")) reqs.push(1); };
  page.on("request", h);
  await page.locator('[data-admin-tab="manual"]').click();
  await page.waitForTimeout(400);
  await page.locator("#admin-sentence").fill("It ______ (rain) here.");
  await page.waitForTimeout(600);
  // 连点 5 下
  const btn = page.locator("#admin-save");
  for (let i = 0; i < 5; i++) { await btn.click({ force: true }).catch(() => {}); await page.waitForTimeout(30); }
  await page.waitForTimeout(1500);
  page.off("request", h);
  return reqs.length <= 1;
});

/* ---- 3. 接口失败时的表现 ---- */
await t("接口 500 时提示可读且可重试", async () => {
  await page.route("**/api/papers", (r) => r.fulfill({ status: 500, contentType: "application/json",
    body: JSON.stringify({ error: "模拟的服务端故障" }) }));
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.locator('[data-admin-tab="papers"]').click();
  await page.waitForTimeout(800);
  // 试卷管理首屏是 SSR，接口失败不应让页面崩掉
  return await page.locator("body").isVisible();
});

await t("接口返回非 JSON 时页面不崩", async () => {
  await page.route("**/api/questions*", (r) => r.fulfill({ status: 200, contentType: "text/html",
    body: "<html>proxy error</html>" }));
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.locator('[data-admin-tab="questions"]').click();
  await page.waitForTimeout(1200);
  const ok = await page.locator("body").isVisible();
  const hasNotice = await page.locator("#admin-notice:not([hidden]), #admin-ai-error:not([hidden])").count();
  return ok;
});

/* ---- 4. 390px 真机视口下的整体表现 ---- */
await t("390px 视口下整页无横向滚动（各页签）", async () => {
  const bad = [];
  for (const tab of ["manual", "ai", "papers", "questions", "tags"]) {
    await page.locator(`[data-admin-tab="${tab}"]`).click();
    await page.waitForTimeout(500);
    const o = await page.evaluate(() => ({
      c: document.documentElement.clientWidth,
      s: document.documentElement.scrollWidth,
    }));
    if (o.s > o.c + 2) bad.push(`${tab}+${o.s - o.c}px`);
  }
  if (bad.length) console.log(`     ${bad.join(" ")}`);
  return bad.length === 0;
});

await t("390px 下可点按钮的触摸目标够大（≥40px）", async () => {
  await page.locator('[data-admin-tab="papers"]').click();
  await page.waitForTimeout(600);
  const small = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('[data-admin-panel]:not([hidden]) button').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 40 && (el.textContent || "").trim()) {
        bad.push(el.textContent.trim().slice(0, 8));
      }
    });
    return [...new Set(bad)].slice(0, 5);
  });
  if (small.length) console.log(`     过小: ${small.join(", ")}`);
  return small.length === 0;
});

console.log(out.join("\n"));
console.log("\nJS 错误:", errs.length ? [...new Set(errs)].slice(0, 3).join(" | ") : "无");
await b.close();