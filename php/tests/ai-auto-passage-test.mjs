import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 180)}`}`);
}

const PASSAGE =
  "Last autumn the museum opened a new wing for ancient coins. " +
  "Most visitors walked past it without a second glance, which surprised the curators.";

const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await (await b.newContext()).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));

await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await p.locator("#username").fill("admin");
await p.locator("#password").fill("123456");
await p.locator("#login-submit").click();
await p.waitForFunction(() => localStorage.getItem("eq_token") !== null, { timeout: 15000 });
await p.waitForLoadState("networkidle").catch(() => {});
await p.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await p.locator('[data-admin-tab="ai"]').click();
await p.waitForSelector("#admin-ai-json", { timeout: 15000 });

// 提示词现在要求：整篇原文只放在第一道题里，其余省略 —— 这才是要走的路径
const same = [1, 2, 3].map((i) => ({
  originalSentence: `The museum opened a new wing blank ${i} ______ in the autumn for test.`,
  source: "自动套用自测",
  // 只有第 1 题带 passage，其余省略 —— 这正是提示词现在要求的写法
  ...(i === 1 ? { passage: PASSAGE } : {}),
  blanks: [{ blankIndex: 1, answer: ["auto"], hintType: "给动词", hintWord: "auto", trapAnalysis: `第 ${i} 空的自测解析。` }],
}));

await p.locator("#admin-ai-json").fill(JSON.stringify(same));
await p.locator("#admin-ai-json").dispatchEvent("input");
// 自动套用会发一次 createPassage 的网络请求，给它时间
await p.waitForSelector("#admin-ai-preview-list > *", { timeout: 25000 });
await p.waitForTimeout(2500);

const panelText = (await p.locator("#admin-ai-passage").innerText().catch(() => "")) || "";
check("原文面板自动出现（说明自动套用触发了）", panelText.includes("已套用到本批"), panelText.slice(0, 120));
check("面板写明改一处全部生效", /改原文只改一处/.test(panelText), panelText.slice(0, 160));

const badges = await p.locator("#admin-ai-preview-list button", { hasText: "共用原文" }).count();
check("每题都标了「共用原文」徽标", badges === 3, badges);

const details = await p.locator("#admin-ai-preview-list details").count();
check("预览里不再有逐题的原文折叠块", details === 0, details);

const applyLabel = await p.locator("#admin-ai-passage-apply").innerText();
check("按钮变成「重新套用」（说明已套用过）", /重新套用/.test(applyLabel), applyLabel);

// 明确不做兼容：每道题都带 passage（旧行为）不再自动套用，
// 免得 AI 没听提示词时把内容判断的责任也揽过来
const everyOne = [1, 2, 3].map((i) => ({ ...same[i - 1], passage: i === 2 ? PASSAGE + " Different." : PASSAGE }));
await p.locator("#admin-ai-json").fill(JSON.stringify(everyOne));
await p.locator("#admin-ai-json").dispatchEvent("input");
await p.waitForTimeout(3000);
const everyOnePanel = (await p.locator("#admin-ai-passage").innerText().catch(() => "")) || "";
check("每题都带 passage 时不自动套用（不做兼容）", !/已套用到本批/.test(everyOnePanel), everyOnePanel.slice(0, 140));

// 内容不一致的情况，同样不该自动套用
const mixed = [
  { ...same[0] },
  { ...same[1], passage: "A completely different passage text for this particular question." },
  { ...same[2] },
];
await p.locator("#admin-ai-json").fill(JSON.stringify(mixed));
await p.locator("#admin-ai-json").dispatchEvent("input");
await p.waitForTimeout(3000);
const mixedPanel = (await p.locator("#admin-ai-passage").innerText().catch(() => "")) || "";
check("内容不一致时不自动套用（留给用户判断）", !/已套用到本批/.test(mixedPanel), mixedPanel.slice(0, 140));

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;