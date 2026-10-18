import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:9002";
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${JSON.stringify(detail ?? null).slice(0, 160)}`}`);
}

const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await (await b.newContext()).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));

const call = async (m, path, body) => {
  const r = await p.evaluate(
    async ([method, url, payload]) => {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + localStorage.getItem("eq_token"),
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    },
    [m, path, body ?? null]
  );
  return r;
};

await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await p.locator("#username").fill("admin");
await p.locator("#password").fill("123456");
await p.locator("#login-submit").click();
await p.waitForFunction(() => localStorage.getItem("eq_token") !== null, { timeout: 15000 });
// 登录成功后会跳页，等它落定，否则 evaluate 会撞上导航中的执行上下文
await p.waitForLoadState("networkidle").catch(() => {});
await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

// 造一张卷 + 2 道题
const paperName = "待删卷_" + Date.now();
const paper = await call("POST", "/api/papers", { name: paperName, note: "自测" });
check("建卷成功", paper.status === 201 || paper.status === 200, paper.data);
const paperId = paper.data?.paper?.id ?? paper.data?.id;

// POST /questions 只返回 { added, renamed }，不带 id，建完再按 source 查回来
const source1 = paperName;   // 必须与卷名一致：服务端按 source 归卷
for (const [i, ans] of ["alpha", "beta"].entries()) {
  await call("POST", "/api/questions", {
    question: {
      originalSentence: `Deleting paper sample blank ${i + 1} ______ (${ans}) for test.`,
      source: source1,
      paperId,
      blanks: [{ blankIndex: 1, answer: [ans], hintType: "给名词", hintWord: ans, trapAnalysis: `第 ${i + 1} 空的自测解析。` }],
    },
  });
}
const made1 = await call("GET", `/api/questions?source=${encodeURIComponent(source1)}`);
check("建 2 道题成功", (made1.data?.questions ?? []).length === 2, made1.data);

/* ---- 路径一：只删卷，题目保留 ---- */
const keep = await call("DELETE", `/api/papers/${paperId}`, {});
check("只删卷返回 unlinkedQuestions=2", keep.data?.unlinkedQuestions === 2, keep.data);
const afterKeep = await call("GET", `/api/questions?source=${encodeURIComponent(source1)}`);
check("题目仍留在题库里", (afterKeep.data?.questions ?? []).length === 2, afterKeep.data?.questions?.length);

/* ---- 路径二：连题目一起删 ---- */
const paperName2 = "待删卷2_" + Date.now();
const paper2 = await call("POST", "/api/papers", { name: paperName2 });
const paperId2 = paper2.data?.paper?.id ?? paper2.data?.id;
const source2 = paperName2;
for (const [i, ans] of ["gamma", "delta"].entries()) {
  await call("POST", "/api/questions", {
    question: {
      originalSentence: `Deleting with questions blank ${i + 1} ______ (${ans}) for test.`,
      source: source2,
      paperId: paperId2,
      blanks: [{ blankIndex: 1, answer: [ans], hintType: "给名词", hintWord: ans, trapAnalysis: `第 ${i + 1} 空的自测解析。` }],
    },
  });
}
const made2 = await call("GET", `/api/questions?source=${encodeURIComponent(source2)}`);
check("第二批 2 道题建成", (made2.data?.questions ?? []).length === 2, made2.data);

const withDel = await call("DELETE", `/api/papers/${paperId2}`, { deleteQuestions: true });
check("连题删除返回 deletedQuestions=2", withDel.data?.deletedQuestions === 2, withDel.data);
const afterDel = await call("GET", `/api/questions?source=${encodeURIComponent(source2)}`);
check("题目确实被删掉了", (afterDel.data?.questions ?? []).length === 0, afterDel.data?.questions?.length);

// 清理第一批
if (paperId) await call("DELETE", `/api/papers/${paperId}`, { deleteQuestions: true });

/* ================================================================== */
/* 弹窗交互（v3.8.9 补）                                              */
/* ================================================================== */
// 上面全是 API 层直接调 DELETE，**完全没碰过弹窗里的按钮** —— 而 v3.8.9 修的
// 正是这个：删除试卷弹窗的三个按钮用 data-action，事件委托却挂在试卷列表那个
// <ul> 上，而 <dialog> 与 <ul> 平级、不在它内部，事件冒泡不到，
// 三个按钮全部无响应（用户只能刷新页面）。
// API 层测试抓不到这类问题，必须真的去点。
const uiName = "弹窗自测卷_" + Date.now();
const uiPaper = await call("POST", "/api/papers", { name: uiName });
const uiPaperId = uiPaper.data?.paper?.id ?? uiPaper.data?.id;
check("弹窗自测：建卷成功", Boolean(uiPaperId), uiPaper.data);
for (const ans of ["epsilon", "zeta"]) {
  await call("POST", "/api/questions", {
    question: {
      originalSentence: `Dialog sample ______ (${ans}) sentence.`,
      source: uiName,
      paperId: uiPaperId,
      blanks: [{ blankIndex: 1, answer: [ans], hintType: "给名词", hintWord: ans, trapAnalysis: "弹窗自测解析。" }],
    },
  });
}
// 列表是 PHP 首屏直出的，建卷要刷新后才看得到
await p.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await p.locator('[data-admin-tab="papers"]').click();
await p.waitForTimeout(600);

const uiRow = p.locator(`[data-paper-manage="${uiPaperId}"]`);
check("弹窗自测：试卷出现在列表里", (await uiRow.count()) === 1, await uiRow.count());

await uiRow.locator('button[data-action="delete-paper"]').click();
await p.waitForTimeout(500);
check("点「删除」后弹窗打开", await p.locator("#delete-paper-dialog").evaluate((d) => d.open));

const descText = await p.locator("#delete-paper-desc").innerText().catch(() => "");
check("弹窗里写出了卷名与题目数", /弹窗自测卷/.test(descText) && /2 道题/.test(descText), descText.slice(0, 80));

// 「取消」必须能关掉 —— v3.8.9 之前它和另外两个按钮一样点不动
await p.locator('[data-action="delete-paper-cancel"]').click();
await p.waitForTimeout(400);
check(
  "「取消」能关掉弹窗（v3.8.9 修的三个按钮之一）",
  !(await p.locator("#delete-paper-dialog").evaluate((d) => d.open))
);

// 「只删除试卷，保留题目」必须真的执行
await uiRow.locator('button[data-action="delete-paper"]').click();
await p.waitForTimeout(500);
await p.locator('[data-action="delete-paper-keep-questions"]').click();
await p.waitForTimeout(1500);
const afterUi = await call("GET", `/api/questions?source=${encodeURIComponent(uiName)}`);
const papersAfter = await call("GET", "/api/papers");
check(
  "「只删除试卷，保留题目」真的执行了（卷没了、题还在）",
  !(papersAfter.data?.papers ?? []).some((x) => x.id === uiPaperId)
    && (afterUi.data?.questions ?? []).length === 2,
  { paperGone: !(papersAfter.data?.papers ?? []).some((x) => x.id === uiPaperId), questions: afterUi.data?.questions?.length }
);

// 连题一起删那条路径也点一遍
const uiName2 = "弹窗自测卷2_" + Date.now();
const uiPaper2 = await call("POST", "/api/papers", { name: uiName2 });
const uiPaper2Id = uiPaper2.data?.paper?.id ?? uiPaper2.data?.id;
check("弹窗自测：第二张卷建卷成功", Boolean(uiPaper2Id), uiPaper2.data);
for (const ans of ["eta"]) {
  await call("POST", "/api/questions", {
    question: {
      originalSentence: `Dialog sample two ______ (${ans}) sentence.`,
      source: uiName2,
      paperId: uiPaper2Id,
      blanks: [{ blankIndex: 1, answer: [ans], hintType: "给名词", hintWord: ans, trapAnalysis: "弹窗自测解析二。" }],
    },
  });
}
await p.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
await p.locator('[data-admin-tab="papers"]').click();
await p.waitForTimeout(600);
const uiRow2 = p.locator(`[data-paper-manage="${uiPaper2Id}"]`);
check("弹窗自测：第二张卷出现在列表里", (await uiRow2.count()) === 1, await uiRow2.count());
await uiRow2.locator('button[data-action="delete-paper"]').click();
await p.waitForTimeout(500);
// 「连题一起删」有一道二次 window.confirm（会说明连带清掉掌握状态/记录/标记），
// Playwright 默认 dismiss 等于按了取消，必须显式 accept
p.once("dialog", (d) => d.accept());
await p.locator('[data-action="delete-paper-with-questions"]').click();
await p.waitForTimeout(1500);
const afterUi2 = await call("GET", `/api/questions?source=${encodeURIComponent(uiName2)}`);
check(
  "「删除试卷，并删除这些题目」也真的执行了",
  (afterUi2.data?.questions ?? []).length === 0,
  afterUi2.data?.questions?.length
);

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;