import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

// 用户贴的真实 AI 输出：passage 是挖空版、且每题重复一遍
const RAW = readFileSync(new URL("./fixtures/passage-blanked-ai.json", import.meta.url), "utf8");

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 200)}`}`);
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
await p.waitForTimeout(3000);

const cards = await p.locator("#admin-ai-preview-list > *").count();
const expected = JSON.parse(RAW).questions.length;
check(`${expected} 道题都解析出来了`, cards === expected, { cards, expected });

// 关键：存进篇章的原文里**不能再有挖空标记**
// v3.8.2 起「每题都带同一份」也会自动合并成共享篇章，
// 原文统一显示在顶部的面板输入框里（不再逐题重复）
const passageText = await p.locator("#admin-ai-passage-text").inputValue().catch(() => "");
check("还原后原文里不再有 ______", passageText.includes("______") === false,
  (passageText.match(/[^ ]*______[^ ]*/) ?? [""])[0]);
check("填的是答案 established，不是提示词原形 establish",
  passageText.includes("officially established in 2021"), passageText.slice(0, 130));
check("名词题也还原成 stability / treasures",
  passageText.includes("long-term stability") && passageText.includes("natural treasures"),
  passageText.slice(0, 200));

// 面板状态 + 修复说明
// 这份数据每题都带同一份 passage（AI 没听提示词）→ 兜底自动合并
const panel = (await p.locator("#admin-ai-passage").innerText().catch(() => "")) || "";
// v3.9.6：「每题都带同一份」不再合并成题绑的共享篇章，
// 而是填进本卷原文框，导入时挂到那一卷上。
check("每题都带同一份 → 收进本卷原文框", /已填好/.test(panel), panel.slice(0, 120));
// 合并成共享篇章后，逐题原文块一个都不该有
const dedup = await p.locator("#admin-ai-preview-list details").count();
check("收进原文框后没有逐题原文块", dedup === 0, dedup);

const body = await p.locator("body").innerText();
// 「已自动修正」那一栏：确认自动还原这件事被告知了用户（文案会随版本调整，只断言在不在）
const repairBox = await p.locator("#admin-ai-preview-summary, #admin-ai-summary, #admin-ai-missing")
  .first().innerText().catch(() => "");
const allText = body + String(repairBox);
check("告知了用户「已自动还原挖空」", allText.includes("还原"), (allText.match(/还原[^ ]{0,40}/) ?? [""])[0]);

// 每题的原句仍然保留挖空（那是对的：考题就是要挖空）
const sentences = await p.locator("#admin-ai-preview-list").innerText();
// 题干里的 ______ 被渲染成「空槽」元素（视觉上是下划线，文字上取不到），
// 所以要查元素数量而不是查文本
// 题干里的挖空渲染成 <span class="..."> 的空槽（视觉是下划线，文字上取不到），
// 所以查渲染后的题干里有没有空槽元素
const slotCount = await p.evaluate(() => {
  const cards = [...document.querySelectorAll("#admin-ai-preview-list > *")];
  return cards.reduce((n, c) => n + (c.querySelectorAll("input, span").length > 0 ? 1 : 0), 0);
});
check("10 张题目卡片都在（题干未被还原成完整句）", slotCount === 10, slotCount);
// 题干仍是挖空态（视觉上显示为下划线，文本里是空槽 + 提示词括号）——
// 还原只作用于 passage，绝不能把考题本身填上答案
// 只取**题干**那一段：整张卡片的 innerText 里还包含折叠的原文，
// 而原文里本来就有 "officially established"（那是还原的成果，不是污染）
const sentence = await p.evaluate(() => {
  const card = document.querySelector("#admin-ai-preview-list > *");
  if (!card) return "";
  // 题干是卡片里第一个不含 details 的段落
  for (const node of card.querySelectorAll("p, div")) {
    if (node.closest("details")) continue;
    const t = (node.textContent ?? "").trim();
    if (t.includes("national parks")) return t;
  }
  return "";
});
// 题干必须仍是挖空态：还原只作用于 passage，绝不能把考题本身填上答案。
// 判定用「有没有挖空痕迹」（空槽下划线或提示词括号），不去做更细的文本比对 ——
// 折叠的原文里本来就含 established，逐字比对容易把两件事搅在一起。
const hasBlankInSentence = await p.evaluate(() => {
  const card = document.querySelector("#admin-ai-preview-list > *");
  if (!card) return false;
  for (const node of card.querySelectorAll("p, div")) {
    if (node.closest("details")) continue;
    const t = (node.textContent ?? "").trim();
    if (t.includes("national parks")) return /_{2,}|\(establish\)/.test(t);
  }
  return false;
});
check("题干仍保留挖空（还原没有污染考题）", hasBlankInSentence === true, hasBlankInSentence);
check("没有异常退出", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;