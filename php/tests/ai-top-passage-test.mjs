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

// 核心：顶层 passage 被下发到每一道题，并自动建成共享篇章
const panel = (await p.locator("#admin-ai-passage").innerText().catch(() => "")) || "";
check("顶层 passage 被识别 → 自动套用共享篇章", /已套用到本批/.test(panel), panel.slice(0, 140));

const badges = await p.locator("#admin-ai-preview-list button", { hasText: "共用原文" }).count();
check("每道题都标了「共用原文」（顶层 passage 已下发到每题）", badges === expected, badges);

const errBox = await p.locator("#admin-ai-error").innerText().catch(() => "");
check("没有校验错误", errBox.trim() === "" || /暂无|没有/.test(errBox), errBox.slice(0, 120));

// 试卷名自动取自顶层 source
const nameBox = await p.locator("#ai-source").inputValue().catch(() => "");
check("试卷名自动填成顶层 source", nameBox === "顶层passage自测", nameBox);

// 导入后库里只有一份
p.once("dialog", (d) => d.accept());
await p.locator("button", { hasText: "确认导入这一卷" }).first().click();
await p.waitForTimeout(3500);

const stored = await p.evaluate(async (base) => {
  const res = await fetch(
    base + "/api/questions?source=" + encodeURIComponent("顶层passage自测"),
    { headers: { Authorization: "Bearer " + localStorage.getItem("eq_token") } }
  );
  const data = await res.json();
  const qs = data.questions ?? [];
  return {
    total: qs.length,
    passageIds: [...new Set(qs.map((q) => q.passageId ?? ""))],
    firstPassage: (qs[0]?.passageText ?? "").slice(0, 40),
  };
}, BASE);
check("题目已入库", stored.total === expected, stored);
check("入库后只指向**同一篇**篇章（顶层化生效）",
  stored.passageIds.length === 1 && stored.passageIds[0] !== "", stored);
check("读回来的 passage 内容正确", stored.firstPassage.startsWith("The museum opened a new wing"), stored.firstPassage);

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;