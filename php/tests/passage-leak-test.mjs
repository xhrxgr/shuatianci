import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 180)}`}`);
}

const PASSAGE =
  "Last summer I went to a small village in the mountains. " +
  "The air there was fresh and the sky was unusually blue. " +
  "Every morning I walked along the river with my grandfather.";

const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext();
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));

// 先登录（登录后会跳页，必须等它落定才能安全地 evaluate）
await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await p.locator("#username").fill("admin");
await p.locator("#password").fill("123456");
await p.locator("#login-submit").click();
await p.waitForFunction(() => localStorage.getItem("eq_token") !== null, { timeout: 15000 });
await p.waitForLoadState("networkidle").catch(() => {});
await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
const token = await p.evaluate(() => localStorage.getItem("eq_token"));

// 造一道带原文的题
const created = await p.evaluate(
  async ([tk, text]) => {
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk },
      body: JSON.stringify({
        question: {
          originalSentence: "Leak check sentence blank ______ (silent) for the test run.",
          source: "泄题自测",
          // 服务端只认 passageText / passageId；`passage` 是 AI JSON 里的字段名，
          // 由前端解析时转换成 passageText
          passageText: text,
          blanks: [{ blankIndex: 1, answer: ["silent"], hintType: "给形容词", hintWord: "silent", trapAnalysis: "自测解析。" }],
        },
      }),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  },
  [token, PASSAGE]
);
check("造题成功", created.status === 201, created.data);

// 同一个会话继续用（学生端看到的界面与管理员账号无关，界面行为一致）

// 进刷题页，切到「按来源筛选」找这道题不方便 —— 直接用筛选参数
await p.goto(`${BASE}/practice?source=${encodeURIComponent("泄题自测")}`, { waitUntil: "networkidle" });
await p.waitForSelector("#practice-card", { timeout: 20000 });
await p.waitForTimeout(1200);

const block = p.locator("[data-passage-block]");
check("题目卡片里有原文块", (await block.count()) > 0, await block.count());

// 核心断言：未作答时原文必须收起，且**看不到答案所在的全文**
const openBefore = await block.first().getAttribute("open");
check("未作答时原文默认收起（之前带 open，等于直接给答案）", openBefore === null, openBefore);

const visibleBefore = await block.first().locator("p").first().isVisible();
check("未作答时看不到原文正文", visibleBefore === false);

const summaryText = await block.first().locator("summary").innerText();
check("标题写明「展开会直接看到本题答案」", /展开会直接看到本题答案/.test(summaryText), summaryText.slice(0, 60));

// 作答并提交 → 原文应自动展开（那正是需要对照的时刻）
await block.first().locator("summary").click();
await p.waitForTimeout(300);
check("学生主动点开仍能看到原文（保留自行查看的能力）", await block.first().locator("p").first().isVisible());

const answerBox = p.locator("#practice-card input[data-blank-input], #practice-card .blank-slot").first();
if (await answerBox.count()) {
  await answerBox.fill("silent");
  const submit = p.locator("#practice-submit, button", { hasText: "提交" }).first();
  if (await submit.count()) {
    await submit.click();
    await p.waitForTimeout(1200);
    const openAfter = await block.first().getAttribute("open");
    check("提交判卷后原文自动展开", openAfter !== null, openAfter);
    const textAfter = await block.first().locator("summary").innerText();
    check("提交后标题不再警示（此时看原文是正常的）", !/展开会直接看到本题答案/.test(textAfter), textAfter.slice(0, 60));
  }
}

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;