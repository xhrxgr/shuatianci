import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 160)}`}`);
}

const PASSAGE =
  "Last summer I went to a small village in the mountains. " +
  "The air there was fresh and the sky was unusually blue. " +
  "Every morning I walked along the river with my grandfather.";

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

// 3 道题共用同一份原文
const payload = {
  paperName: "折叠原文自测",
  questions: [1, 2, 3].map((i) => ({
    originalSentence: `Last summer I went to a small village blank ${i} ______ in the mountains for the test.`,
    source: "折叠原文自测",
    passage: PASSAGE,
    blanks: [
      { blankIndex: 1, answer: ["went"], hintType: "给动词", hintWord: "went", trapAnalysis: `第 ${i} 空：went 是 go 的过去式。` },
    ],
  })),
};
// 预览是粘贴后自动构建的，没有单独的「预览」按钮
await p.locator("#admin-ai-json").fill(JSON.stringify(payload));
await p.locator("#admin-ai-json").dispatchEvent("input");
await p.waitForSelector("#admin-ai-preview-list > *", { timeout: 25000 });
await p.waitForTimeout(800);

const cardCount = await p.locator("#admin-ai-preview-list > *").count();
check("3 道题都渲染出来了", cardCount === 3, cardCount);

// 关键：全文只应出现在折叠的 summary 里（作为一行标题），不该整段平铺 3 次
const fullTextOccurrences = await p.evaluate(
  (text) => {
    const marker = text.slice(0, 40);
    let visible = 0;
    for (const node of document.querySelectorAll("#admin-ai-preview-list *")) {
      if (node.children.length === 0 && (node.textContent ?? "").includes(marker)) {
        // 祖先里有展开的 details 才算「真的平铺可见」
        let shown = true;
        let el = node;
        while (el && el.id !== "admin-ai-list") {
          if (el.tagName === "DETAILS" && !el.open) { shown = false; break; }
          el = el.parentElement;
        }
        if (shown) visible += 1;
      }
    }
    return visible;
  },
  PASSAGE
);
check("全文没有平铺在预览里（折叠状态下应为 0 处可见）", fullTextOccurrences === 0, fullTextOccurrences);

const summaries = await p.locator('#admin-ai-preview-list details summary').count();
check("每题都有一个「完整原文」的折叠入口", summaries === 3, summaries);

const summaryText = summaries > 0 ? await p.locator('#admin-ai-preview-list details summary').first().innerText() : "";
check("折叠标题写清了字数", /完整原文（\d+ 字/.test(summaryText), summaryText.slice(0, 40));

// 折叠默认收起
const openStates = await p.locator("#admin-ai-preview-list details").evaluateAll((els) => els.map((e) => e.open));
check("原文默认折叠", openStates.every((v) => v === false), openStates);

// 点开第一个能看到全文
await p.locator('#admin-ai-preview-list details summary').first().click();
await p.waitForTimeout(300);
const afterOpen = await p.locator('#admin-ai-preview-list details').first().getAttribute("open");
check("点标题能展开看到全文", afterOpen !== null);

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;