/**
 * AI 录入预览 · 浏览器自测（第 1 期）
 *
 * 覆盖决策 D5：
 *   粘贴即渲染完整预览 → 标注新增/已存在 → 逐题勾选 → 只导入勾选的
 *
 * 用法：node php/tests/ai-preview-test.mjs http://127.0.0.1:9304
 * 需要**干净的库**。
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:9304";
let pass = 0;
const failures = [];

function check(desc, ok, extra) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${desc}`);
  } else {
    failures.push(desc);
    console.log(`  FAIL  ${desc}${extra === undefined ? "" : `  ← ${JSON.stringify(extra).slice(0, 260)}`}`);
  }
}

/** 每题都带一套最小合法配置 */
function q(sentence, answers, tags = ["t_026"]) {
  return {
    originalSentence: sentence,
    blanks: [
      {
        blankIndex: 1,
        answer: answers,
        hintWord: null,
        hintType: "无提示词",
        tagIds: tags,
        trapAnalysis: "命题意图与判断依据。",
      },
    ],
  };
}

const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`[pageerror] ${String(e).slice(0, 200)}`));
// 只收集真正的 JS 报错；资源加载失败单独记 URL，便于判断是不是无害的图标请求
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("Failed to load resource")) {
    pageErrors.push(`[console] ${m.text().slice(0, 200)}`);
  }
});
const failedRequests = [];
page.on("response", (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().replace(BASE, "")}`);
});

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForTimeout(1400);
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await page.locator('[data-admin-tab="ai"]').click();
await page.waitForTimeout(400);

const PAPER = "预览测试卷";
const textarea = page.locator("#admin-ai-json");
const preview = page.locator("#admin-ai-preview");
const items = page.locator("#admin-ai-preview [data-preview-index]");

// ---------------------------------------------------------------------------
console.log("\n【一】粘贴即渲染预览（不用点按钮）\n");
// ---------------------------------------------------------------------------
const batch1 = {
  source: PAPER,
  questions: [
    q("Alpha ______ one.", ["in"]),
    q("Beta ______ two.", ["on"]),
    q("Gamma ______ three.", ["at"]),
  ],
};
await textarea.fill(JSON.stringify(batch1));
await page.waitForTimeout(1400);

check("预览区自动出现", await preview.isVisible());
check("渲染出 3 题", (await items.count()) === 3, await items.count());
check("试卷名框也自动填好", (await page.locator("#ai-source").inputValue()) === PAPER);

const badgeTexts = await page.locator("#admin-ai-preview [data-preview-index] + div > div > span").allInnerTexts();
check("三题都标为「新增」", badgeTexts.filter((t) => t === "新增").length === 3, badgeTexts);

const checkedCount = await page.locator('#admin-ai-preview input[type="checkbox"]:checked').count();
check("新增题默认全部勾选", checkedCount === 3, checkedCount);

const summary = await page.locator("#admin-ai-preview-summary").innerText();
check("汇总显示「共 3 题，新增 3；将导入 3 题」",
  summary.includes("共 3 题") && summary.includes("新增 3") && summary.includes("将导入 3 题"), summary);

// 原句里的空位要高亮出来（不是原样显示 6 个下划线）
const sentenceHtml = await page.locator("#admin-ai-preview p.break-words").first().innerHTML();
check("原句的空位被高亮渲染", !sentenceHtml.includes("______") && sentenceHtml.includes("____"), sentenceHtml.slice(0, 120));

// 逐空明细要能看到答案与标签名
const itemText = await page.locator("#admin-ai-preview label").first().innerText();
check("明细里有答案 in", itemText.includes("in"), itemText.slice(0, 150));
check("明细里有提示词类型", itemText.includes("无提示词"), itemText.slice(0, 150));
check("明细里有解析", itemText.includes("命题意图与判断依据"), itemText.slice(0, 150));

// ---------------------------------------------------------------------------
console.log("\n【二】导入第一批（只导入勾选的）\n");
// ---------------------------------------------------------------------------
// 先取消第 2 题
await page.locator('#admin-ai-preview input[data-preview-index="1"]').uncheck();
await page.waitForTimeout(200);
const summary2 = await page.locator("#admin-ai-preview-summary").innerText();
check("取消勾选后汇总跟着变（将导入 2 题）", summary2.includes("将导入 2 题"), summary2);

await page.locator("#admin-ai-submit").click();
await page.waitForTimeout(1800);

const afterFirst = await page.evaluate(async () => {
  const r = await fetch("/api/questions", { credentials: "include" });
  return (await r.json()).questions.map((x) => x.originalSentence);
});
check("只导入了勾选的 2 题", afterFirst.filter((s) => /Alpha|Beta|Gamma/.test(s)).length === 2,
  afterFirst.filter((s) => /Alpha|Beta|Gamma/.test(s)));
check("Alpha 已入库", afterFirst.some((s) => s.includes("Alpha")));
check("Gamma 已入库", afterFirst.some((s) => s.includes("Gamma")));
check("被取消勾选的 Beta 没有入库", !afterFirst.some((s) => s.includes("Beta")), afterFirst);

const notice = await page.locator("#admin-notice").innerText().catch(() => "");
check("提示里说明跳过了 1 题", notice.includes("跳过 1 道"), notice.replace(/\s+/g, " ").slice(0, 160));
check("提示里带来源", notice.includes("预览测试卷"), notice.replace(/\s+/g, " ").slice(0, 160));

// ---------------------------------------------------------------------------
console.log("\n【三】已存在的题默认不勾选\n");
// ---------------------------------------------------------------------------
// 重新粘贴：Alpha、Gamma 已在库里（应判已存在），Delta 是新的
const batch2 = {
  source: PAPER,
  questions: [
    q("Alpha ______ one.", ["in"]),
    q("Delta ______ four.", ["for"]),
    q("Gamma ______ three.", ["at", "by"]),   // 答案与库里有交集 → 答案不同
  ],
};
await textarea.fill(JSON.stringify(batch2));
await page.waitForTimeout(1600);

check("预览重新渲染 3 题", (await items.count()) === 3, await items.count());

const states = await page.evaluate(() =>
  [...document.querySelectorAll("#admin-ai-preview label")].map((label) => ({
    badge: label.querySelector("span:nth-of-type(2)")?.textContent?.trim(),
    checked: label.querySelector('input[type="checkbox"]')?.checked,
    text: label.innerText.slice(0, 90),
  }))
);
check("第 1 题（Alpha，库里已有）标为「已存在」", states[0]?.badge === "已存在", states[0]);
check("第 1 题默认不勾选", states[0]?.checked === false, states[0]);
check("第 2 题（Delta，新题）标为「新增」", states[1]?.badge === "新增", states[1]);
check("第 2 题默认勾选", states[1]?.checked === true, states[1]);
check("第 3 题（Gamma，答案有出入）标为「答案不同」", states[2]?.badge === "答案不同", states[2]);
check("第 3 题默认不勾选", states[2]?.checked === false, states[2]);
// hint 的两种形态：库里多出答案时写「库里有 X」，本次多出答案时写「本次给了 Y」
// 这里库里是 at、本次是 at+by，所以多出来的是「by」
check("「答案不同」给出具体差异（本次多给了 by）",
  String(states[2]?.text).includes("本次给了 by") || String(states[2]?.text).includes("库里有 at"),
  states[2]);

const summary3 = await page.locator("#admin-ai-preview-summary").innerText();
check("汇总写明已存在/答案不同的数量与将导入数",
  summary3.includes("已存在 1") && summary3.includes("答案不同 1") && summary3.includes("将导入 1 题"), summary3);

// ---------------------------------------------------------------------------
console.log("\n【四】全选 / 全不选\n");
// ---------------------------------------------------------------------------
await page.locator("#admin-ai-select-all").click();
await page.waitForTimeout(200);
check("全选后 3 题都勾上",
  (await page.locator('#admin-ai-preview input[type="checkbox"]:checked').count()) === 3);

await page.locator("#admin-ai-select-none").click();
await page.waitForTimeout(200);
check("全不选后一题都没勾",
  (await page.locator('#admin-ai-preview input[type="checkbox"]:checked').count()) === 0);

// 一题都不勾时导入应被拒绝
await page.locator("#admin-ai-submit").click();
await page.waitForTimeout(1200);
const noneMsg = await page.locator("#admin-ai-error").innerText().catch(() => "");
check("一题都不勾时拒绝导入并提示", noneMsg.includes("都没勾选"), noneMsg.replace(/\s+/g, " ").slice(0, 120));

const afterNone = await page.evaluate(async () => {
  const r = await fetch("/api/questions", { credentials: "include" });
  return (await r.json()).questions.map((x) => x.originalSentence);
});
check("拒绝后库里没有新增 Delta", !afterNone.some((s) => s.includes("Delta")), afterNone);

// ---------------------------------------------------------------------------
console.log("\n【五】重新勾选后导入成功\n");
// ---------------------------------------------------------------------------
await page.locator('#admin-ai-preview input[data-preview-index="1"]').check();
await page.waitForTimeout(200);
await page.locator("#admin-ai-submit").click();
await page.waitForTimeout(1800);

const afterDelta = await page.evaluate(async () => {
  const r = await fetch("/api/questions", { credentials: "include" });
  return (await r.json()).questions.map((x) => x.originalSentence);
});
check("勾上后 Delta 成功入库", afterDelta.some((s) => s.includes("Delta")), afterDelta);

// ---------------------------------------------------------------------------
console.log("\n【七】粘贴后立刻提交（防抖竞态）\n");
// ---------------------------------------------------------------------------
// 粘贴会触发 400ms 防抖的预览构建；如果用户不等它就点「确认导入」，
// 会同时存在两次构建。曾经后启动的那次把先启动的判为「过期」并静默返回，
// 于是提交路径既不导入也不报错 —— 用户视角是「点了没反应」。
const raceSentence = "Race ______ check.";
await textarea.fill(JSON.stringify({
  source: PAPER,
  questions: [q(raceSentence, ["in"])],
}));
// 不等待，立刻提交
await page.locator("#admin-ai-submit").click();
await page.waitForTimeout(2200);

const raceImported = await page.evaluate(async (needle) => {
  const r = await fetch("/api/questions", { credentials: "include" });
  return (await r.json()).questions.some((x) => x.originalSentence.includes(needle));
}, "Race");
const raceError = (await page.locator("#admin-ai-error").innerText().catch(() => "")).trim();
check("粘贴后立刻提交：要么导入成功、要么给出错误（不能静默无反应）",
  raceImported || raceError.length > 0, { raceImported, raceError: raceError.slice(0, 120) });
check("粘贴后立刻提交确实导入了这一题", raceImported, raceImported);

// ---------------------------------------------------------------------------
console.log("\n【八】边界：空输入 / 坏 JSON 不应报错或残留预览\n");
// ---------------------------------------------------------------------------
await textarea.fill("");
await page.waitForTimeout(900);
check("清空输入后预览隐藏", !(await preview.isVisible()));
const emptyErr = await page.locator("#admin-ai-error").innerText().catch(() => "");
check("清空输入不弹解析错误", emptyErr.trim() === "", emptyErr.slice(0, 80));

await textarea.fill("{ 这不是 JSON ");
await page.waitForTimeout(900);
const badMsg = await page.locator("#admin-ai-error").innerText().catch(() => "");
check("坏 JSON 给出可读提示", badMsg.length > 0, badMsg.slice(0, 100));
check("坏 JSON 时预览不显示", !(await preview.isVisible()));

console.log(pageErrors.length ? `\n❌ 页面错误：\n${pageErrors.join("\n")}` : "\n✓ 无页面错误");
check("全程无 JS 异常", pageErrors.length === 0, pageErrors);
if (failedRequests.length > 0) {
  console.log(`\n⚠ 有 ${failedRequests.length} 个失败请求：`);
  for (const r of [...new Set(failedRequests)]) console.log(`    ${r}`);
}

await browser.close();

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
