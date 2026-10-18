import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

// 提示词现在要求的形态：passage 在**顶层**（与 source、questions 平级），
// 每道题里不重复带。
const RAW = readFileSync(new URL("./fixtures/top-passage-ai.json", import.meta.url), "utf8");

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 180)}`}`);
}

const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await (await b.newContext()).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));

await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await p.locator("#username").fill("admin");
await p.locator("#password").fill("123456");
await p.locator("#login-submit").click();
await p.waitForFunction(() => localStorage.getItem("eq_token") !== null, { timeout: 15000 });
await p.waitForLoadState("networkidle").catch(() => {});
await p.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await p.locator('[data-admin-tab="ai"]').click();
await p.waitForSelector("#admin-ai-json", { timeout: 15000 });

await p.locator("#admin-ai-json").fill(RAW);
await p.locator("#admin-ai-json").dispatchEvent("input");
await p.waitForSelector("#admin-ai-preview-list > *", { timeout: 25000 });
await p.waitForTimeout(2500);

const expected = JSON.parse(RAW).questions.length;
const cards = await p.locator("#admin-ai-preview-list > *").count();
check(`${expected} 道题全部解析出来`, cards === expected, { cards, expected });

// 核心（v3.9.6）：顶层 passage 被识别并**填进原文框** ——
// 原文是**卷的属性**，不再自动套用到每一道题，所以面板上不该再出现「套用」字样。
const panel = (await p.locator("#admin-ai-passage").innerText().catch(() => "")) || "";
check("顶层 passage 被识别 → 填入本卷原文框", /已填好/.test(panel), panel.slice(0, 140));
check("原文区不再出现「套用」（题不绑原文了）", !/套用/.test(panel), panel.slice(0, 140));

const applyText = (await p.locator("#admin-ai-passage-text").inputValue().catch(() => "")) || "";
check("原文框里确实是那篇全文", applyText.includes("The museum opened a new wing"), applyText.slice(0, 50));

const errBox = await p.locator("#admin-ai-error").innerText().catch(() => "");
check("没有校验错误", errBox.trim() === "" || /暂无|没有/.test(errBox), errBox.slice(0, 120));

// 试卷名自动取自顶层 source
const nameBox = await p.locator("#ai-source").inputValue().catch(() => "");
check("试卷名自动填成顶层 source", nameBox === "顶层passage自测", nameBox);

// v3.9.6：不再断言「入库后每题都指向同一篇篇章」——
// 原文已经是**卷的属性**，题不再带 passageId。
//
// 这一段原本要验证「顶层 passage 落库后仍只有一份」。现在它由
// `ai-passage-attaches-test` 覆盖（那里走完整导入流程，逐项验：
// 原文挂在那一卷、只有一篇、题目完全没有 passageId/passageText、
// 二次导入不堆积）。这里只保留**录入阶段**的断言，避免两处重复且
// 各自维护一套导入流程。

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;