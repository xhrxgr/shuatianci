// -*- coding: utf-8 -*-
/** 验证标签分类的折叠行为：默认折叠、概览可见、可展开、批量开关 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 150)}`}`);
}

const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext();
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));

await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await p.locator("#username").fill("admin");
await p.locator("#password").fill("123456");
await p.locator("#login-submit").click();
await p.waitForFunction(() => localStorage.getItem("eq_token") !== null, { timeout: 15000 });

await p.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await p.locator('[data-admin-tab="tags"]').click();
await p.waitForSelector("[data-tag-group]", { timeout: 15000 });

const groups = p.locator("[data-tag-group]");
const count = await groups.count();
check("标签分类渲染出来了", count >= 1, count);

// 1. 默认折叠
const openStates = await groups.evaluateAll((els) => els.map((e) => e.open));
check("默认全部折叠", openStates.every((v) => v === false), openStates);

// 2. 折叠态能看到概览（分类名 + 子标签数 + 标签名预览）
const firstSummary = groups.first().locator("summary");
const summaryText = await firstSummary.innerText();
check("折叠时显示分类名与子标签数", /[0-9]+ 个子标签/.test(summaryText), summaryText.slice(0, 60));
check("折叠时显示标签名概览", summaryText.split(String.fromCharCode(10)).length >= 3, summaryText.slice(0, 80));

// 3. 编辑区在折叠时不可见
check("折叠时看不到编辑表单", (await groups.first().locator("[data-tag-list]").isVisible()) === false);

// 4. 点标题展开
await firstSummary.click();
await p.waitForTimeout(300);
check("点标题可展开", (await groups.first().getAttribute("open")) !== null);
check("展开后能看到标签列表", await groups.first().locator("[data-tag-list]").isVisible());

// 5. 全部收起
await p.locator('[data-action="collapse-all-tag-groups"]').click();
await p.waitForTimeout(200);
const afterCollapse = await groups.evaluateAll((els) => els.map((e) => e.open));
check("「全部收起」生效", afterCollapse.every((v) => v === false), afterCollapse);

// 6. 全部展开
await p.locator('[data-action="expand-all-tag-groups"]').click();
await p.waitForTimeout(200);
const afterExpand = await groups.evaluateAll((els) => els.map((e) => e.open));
check("「全部展开」生效", afterExpand.every((v) => v === true), afterExpand);

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
process.exitCode = failed.length > 0 ? 1 : 0;