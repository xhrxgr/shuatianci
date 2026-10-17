import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

// 用户第二份真实 AI 输出：passage 已是**未挖空的完整原文**（内容全对），
// 但仍然每题重复一遍。这份用来验证「内容正确 + 重复」的情况能正常走完全流程。
const RAW = readFileSync(new URL("./fixtures/passage-clean-ai.json", import.meta.url), "utf8");

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

// 没有校验错误 = 能导入
const errBox = await p.locator("#admin-ai-error").innerText().catch(() => "");
check("没有校验错误（可以导入）", (errBox.trim() === "" || /暂无|没有/.test(errBox)), errBox.slice(0, 120));

// 查重结果已出（state 不是 undefined）
const summary = await p.locator("#admin-ai-preview-summary").innerText().catch(() => "");
check("查重已完成并给出摘要", summary.includes("新增") || summary.includes("已存在"), summary.slice(0, 100));

// 原文已经是完整的 —— 不该触发任何还原，也不该有「已自动修正」提示
const hasRepair = summary.includes("还原");
check("原文本就完整 → 不做还原（不产生多余提示）", hasRepair === false, summary.slice(0, 140));

const firstDetails = await p.evaluate(() => {
  const d = document.querySelector("#admin-ai-preview-list details");
  if (!d) return "";
  d.open = true;
  return d.textContent ?? "";
});
check("原文里没有挖空（AI 这次给对了）", firstDetails.includes("______") === false,
  (firstDetails.match(/[^ ]*______[^ ]*/) ?? [""])[0]);
check("原文是完整句子", /officially established in 2021/.test(firstDetails), firstDetails.slice(0, 110));

// 内容相同 → 折叠入口去重成 1 个
const dedup = await p.locator("#admin-ai-preview-list details").count();
check("10 份相同原文 → 折叠入口去重成 1 个", dedup === 1, dedup);

// 真正走一遍导入
p.once("dialog", (d) => d.accept());
const importBtn = p.locator("button", { hasText: "确认导入这一卷" }).first();
if (await importBtn.count()) {
  await importBtn.click();
  await p.waitForTimeout(3000);
  const done = await p
    .waitForFunction(() => /导入完成|已导入|成功导入/.test(document.body.innerText), { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  const body = await p.locator("body").innerText();
  check("导入成功", done, (body.match(/(导入完成|已导入|成功导入)[^\\n]{0,60}/) ?? [""])[0]);
} else {
  check("找得到导入按钮", false, "按钮未出现");
}

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;