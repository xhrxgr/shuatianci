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

check("全程无 JS 异常", errors.length === 0, errors.slice(0, 2));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;