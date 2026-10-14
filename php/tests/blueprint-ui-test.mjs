/**
 * 组卷蓝图与虚拟卷成员 · 浏览器自测（第 2 期）
 *
 * 覆盖：
 *   ① 蓝图列表加载与新建
 *   ② 条件构造器：加标签条件、切类型、试抽预览
 *   ③ 保存与生成虚拟卷（含整页刷新后的提示）
 *   ④ 试卷页签：虚拟卷徽标、成员弹窗（移除一题 → 保存）
 *
 * 用法：node php/tests/blueprint-ui-test.mjs http://127.0.0.1:9002
 * 需要**干净的库**（脚本自己通过接口造数据）。
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:9002";
const SUFFIX = Date.now().toString(36).slice(-5);
const PAPER = `蓝图UI测试卷_${SUFFIX}`;
const BP_NAME = `UI蓝图_${SUFFIX}`;

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

async function api(method, path, options = {}) {
  const { token, body } = options;
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data };
}

/* ---------------- 用接口造数据 ---------------- */
const login = await api("POST", "/auth/login", { body: { username: "admin", password: "123456" } });
const token = login.data?.token;
if (!token) {
  console.error("登录失败", login.status, login.data);
  process.exit(1);
}
await api("POST", "/bank/reset", { token });
await api("PUT", "/tags", {
  token,
  body: {
    tagDictionary: {
      schemaVersion: 1,
      tags: [
        { id: "t_p", name: "语法", parentId: null, color: "#2563eb", isActive: true },
        { id: "t_x", name: "虚拟语气", parentId: "t_p", color: "#2563eb", isActive: true },
      ],
    },
  },
});

const blanks = [
  {
    blankIndex: 1,
    answer: ["were"],
    hintWord: "be",
    hintType: "给动词",
    tagIds: ["t_x"],
    trapAnalysis: "命题意图与判断依据。",
  },
];
const questions = [];
for (let i = 1; i <= 6; i++) {
  questions.push({
    originalSentence: `UI 测试第 ${i} 题 ______ important.`,
    blanks,
    source: PAPER,
  });
}
const created = await api("POST", "/questions", { token, body: { questions } });
check("接口造题 6 道", created.status === 201 && created.data?.added === 6, created.data);

/* ---------------- 浏览器 ---------------- */
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("Failed to load resource")) {
    pageErrors.push(`[console] ${m.text().slice(0, 200)}`);
  }
});

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.locator("#username").fill("admin");
await page.locator("#password").fill("123456");
await page.locator("#login-submit").click();
await page.waitForTimeout(1400);
try {
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle", timeout: 15000 });
} catch {
  await page.waitForTimeout(900);
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle", timeout: 15000 });
}

// ---------------------------------------------------------------------------
console.log("\n【一】蓝图片签与列表\n");
// ---------------------------------------------------------------------------
await page.locator('[data-admin-tab="blueprints"]').click();
await page.waitForTimeout(900);

check("蓝图片签可切换", await page.locator('[data-admin-panel="blueprints"]').isVisible());
check("空态提示可见", await page.locator("#blueprint-list-empty").isVisible());

// ---------------------------------------------------------------------------
console.log("\n【二】新建与条件构造\n");
// ---------------------------------------------------------------------------
await page.locator("#blueprint-new").click();
await page.waitForTimeout(300);
check("编辑器出现名称输入", await page.locator("#bp-name").isVisible());

await page.locator("#bp-name").fill(BP_NAME);
await page.locator("#bp-desc").fill("UI 测试用蓝图");
await page.locator("#bp-sections").fill("2");
await page.locator("#bp-per-section").fill("2");
await page.waitForTimeout(200);
check("合计随篇数×题数更新", (await page.locator("#bp-total").innerText()).includes("4"), await page.locator("#bp-total").innerText());

// 默认已有一个条件行？没有的话点「添加条件」
const condCount = await page.locator("[data-bp-cond-row]").count();
if (condCount === 0) {
  await page.locator('[data-bp-action="add-condition"]').click();
  await page.waitForTimeout(200);
}
check("条件行存在", (await page.locator("[data-bp-cond-row]").count()) >= 1);

// 标签选择面板默认展开（新增条件后 openTagPicker 指向它）
const pickerVisible = await page.locator('input[data-bp-cond-field="tag"]').first().isVisible().catch(() => false);
if (!pickerVisible) {
  await page.locator('[data-bp-action="toggle-tag-picker"]').first().click();
  await page.waitForTimeout(200);
}
await page.locator('input[data-bp-cond-field="tag"][value="t_x"]').check();
await page.waitForTimeout(300);
check("勾选标签后出现 chip", (await page.locator('button[data-bp-action="remove-tag"]').count()) >= 1);

// ---------------------------------------------------------------------------
console.log("\n【三】试抽预览\n");
// ---------------------------------------------------------------------------
await page.locator('[data-bp-action="preview"]').click();
await page.waitForTimeout(1500);
const previewText = await page.locator("#bp-preview").innerText();
check("预览显示抽到的题数", /本次抽出\s*\d+\s*题/.test(previewText), previewText.slice(0, 160));
check("预览里出现第 1 篇", previewText.includes("第 1 篇"), previewText.slice(0, 200));
check("预览里出现第 2 篇", previewText.includes("第 2 篇"), previewText.slice(0, 240));
check("预览列出题目原句", previewText.includes("UI 测试第"), previewText.slice(0, 240));
check("没有超出预期的放宽提示（条件足够）", previewText.includes("没有放宽"), previewText.slice(0, 240));

// ---------------------------------------------------------------------------
console.log("\n【四】保存与生成虚拟卷\n");
// ---------------------------------------------------------------------------
await page.locator('[data-bp-action="save"]').click();
await page.waitForTimeout(1200);
check("保存后列表里出现该蓝图", (await page.locator("#blueprint-list").innerText()).includes(BP_NAME));

await page.locator('[data-bp-action="generate"]').click();
// 生成后整页刷新（带 hash #papers），等提示出现就说明新页面已就绪
await page.waitForFunction(
  () => (document.getElementById("admin-notice")?.innerText ?? "").includes("已生成虚拟卷"),
  { timeout: 20000 }
);
const noticeText = await page.locator("#admin-notice").innerText().catch(() => "");
check("生成后页面刷新并给出提示", /已生成虚拟卷/.test(noticeText), noticeText.slice(0, 160));

// 刷新后按 hash 自动停在试卷页签（用户不该被踢回「手动精录」）
check("刷新后仍停在试卷页签", await page.locator('[data-admin-panel="papers"]').isVisible());
const paperListText = await page.locator("#paper-manage-list").innerText();
check("试卷列表出现虚拟卷", paperListText.includes("虚拟卷"), paperListText.slice(0, 200));
check("试卷列表标注来自蓝图", paperListText.includes(BP_NAME), paperListText.slice(0, 240));
check("生成卷有「成员」按钮", (await page.locator('button[data-action="edit-paper-items"]').count()) >= 1);
check("生成卷有「重新生成」按钮", (await page.locator('button[data-action="regenerate-paper"]').count()) >= 1);

// ---------------------------------------------------------------------------
console.log("\n【五】成员弹窗\n");
// ---------------------------------------------------------------------------
await page.locator('button[data-action="edit-paper-items"]').first().click();
await page.waitForTimeout(1200);
check("成员弹窗打开", await page.locator("#paper-items-dialog").isVisible());
const memberText = await page.locator("#paper-items-body").innerText();
check("成员按篇分组", memberText.includes("第 1 篇") && memberText.includes("第 2 篇"), memberText.slice(0, 200));
check("成员列出题目", memberText.includes("UI 测试第"), memberText.slice(0, 200));
check("摘要显示总数", /共 \d+ 题 · \d+ 篇/.test(await page.locator("#paper-items-summary").innerText()), await page.locator("#paper-items-summary").innerText());

const beforeCount = await page.locator("#paper-items-body li").count();
await page.locator('button[data-member-action="remove"]').first().click();
await page.waitForTimeout(300);
const afterCount = await page.locator("#paper-items-body li").count();
check("移除一题后列表少一条", afterCount === beforeCount - 1, { beforeCount, afterCount });
check("摘要标注未保存", (await page.locator("#paper-items-summary").innerText()).includes("未保存"), await page.locator("#paper-items-summary").innerText());

await page.locator('[data-action="save-paper-items"]').click();
await page.waitForFunction(
  () => (document.getElementById("admin-notice")?.innerText ?? "").includes("成员已保存"),
  { timeout: 20000 }
);
const afterSaveNotice = await page.locator("#admin-notice").innerText().catch(() => "");
check("保存成员后刷新并提示", /成员已保存/.test(afterSaveNotice), afterSaveNotice.slice(0, 160));

// ---------------------------------------------------------------------------
console.log("\n【六】收尾\n");
// ---------------------------------------------------------------------------
// 请走接口清场，浏览器不再操作
const reset = await api("POST", "/bank/reset", { token });
check("清场成功", reset.status === 200);

console.log(pageErrors.length ? `\n❌ 页面错误：\n${pageErrors.join("\n")}` : "\n✓ 无页面错误");
check("全程无 JS 异常", pageErrors.length === 0, pageErrors);

await browser.close();

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
