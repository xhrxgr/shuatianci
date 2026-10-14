/**
 * 题库重构第 1 期 · 接口自测
 *
 * 覆盖三块：
 *   ① 投影同步：question_tags / paper_items / fingerprint 在增删改清后始终正确
 *   ② 检索筛选：按标签（交集/并集）、提示词类型、空格数、关键词、分页
 *   ③ 录入查重：new / duplicate / diff 三态，含批内互相重复
 *
 * 用法：node php/tests/bank-phase1-test.mjs http://127.0.0.1:9300
 * 需要**干净的库**（有断言依赖「库里没有同名题」）。
 */

const BASE = process.argv[2] || "http://127.0.0.1:9300";
const SUFFIX = Date.now().toString(36).slice(-5);
const PAPER = `阶段测试卷_${SUFFIX}`;
const PAPER2 = `阶段测试卷2_${SUFFIX}`;

let pass = 0;
const failures = [];

async function request(method, path, options = {}) {
  const { token, body } = options;
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data };
}

function check(desc, ok, extra) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${desc}`);
  } else {
    failures.push(desc);
    console.log(`  FAIL  ${desc}${extra === undefined ? "" : `  ← ${JSON.stringify(extra).slice(0, 220)}`}`);
  }
}

function blank(idx, answers, tags = [], hintType = "无提示词", hintWord = null) {
  return {
    blankIndex: idx,
    answer: answers,
    hintWord,
    hintType,
    tagIds: tags,
    trapAnalysis: "命题意图与判断依据。",
  };
}

const login = await request("POST", "/auth/login", { body: { username: "admin", password: "123456" } });
const token = login.data?.token;
if (!token) {
  console.error("登录失败，无法继续：", login.status, login.data);
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log("\n【一】录入时写入派生数据\n");
// ---------------------------------------------------------------------------
const createRes = await request("POST", "/questions", {
  token,
  body: {
    questions: [
      {
        originalSentence: "The boy ______ there.",
        blanks: [blank(1, ["is"], ["t_001", "t_026"])],
        source: PAPER,
      },
      {
        originalSentence: "A ______ B ______ C.",
        blanks: [blank(1, ["x"], ["t_001"], "给动词", "give"), blank(2, ["y"], ["t_010"])],
        source: PAPER,
      },
    ],
  },
});
check("批量录入 2 题返回 201", createRes.status === 201, createRes.data);
check("added = 2", createRes.data?.added === 2, createRes.data);

const listAll = await request("GET", "/questions", { token });
const mine = (listAll.data?.questions ?? []).filter((q) => q.source === PAPER);
check("按来源能查到这 2 题", mine.length === 2, mine.length);

const q1 = mine.find((q) => q.originalSentence.includes("The boy"));
const q2 = mine.find((q) => q.originalSentence.startsWith("A "));
check("返回体带 fingerprint", typeof q1?.fingerprint === "string" && q1.fingerprint.length > 0, q1?.fingerprint);
check("指纹内容正确", q1?.fingerprint === "theboythere", q1?.fingerprint);
check("返回体带 publishStatus（存量/新增默认 published）", q1?.publishStatus === "published", q1?.publishStatus);
check("返回体带 updatedAt", typeof q1?.updatedAt === "string" && q1.updatedAt.length > 0, q1?.updatedAt);

// ---------------------------------------------------------------------------
console.log("\n【二】按标签筛选（走投影表，不再全量拉到浏览器）\n");
// ---------------------------------------------------------------------------
// 注意：PHP 里重复的同名标量参数只保留最后一个（?tag=a&tag=b → $_GET['tag'] === 'b'），
// 所以多选要用 tag[]=a&tag[]=b 或 tags=a,b。这里用 CSV 形式
const tagAll = await request("GET", "/questions?tags=t_001,t_026", { token });
const tagAllIds = (tagAll.data?.questions ?? []).map((q) => q.id);
check("交集（tagMatch=all）：同时挂 t_001 与 t_026 的只有第 1 题",
  tagAllIds.length === 1 && tagAllIds[0] === q1.id, tagAllIds);

// 回归钉子：内置示例题是在「迁移写标记之后」才导入的，
// 曾经因此拿不到标签投影，按标签筛题永远筛不到它们
const seedByTag = await request("GET", "/questions?tag=t_004", { token });
check("内置示例题也能按标签筛到（种子导入写投影）",
  (seedByTag.data?.questions ?? []).length > 0,
  seedByTag.data?.total);

const tagAny = await request("GET", "/questions?tags=t_026,t_010&tagMatch=any", { token });
// 注意：要限定在本次建的卷里 —— 内置示例题现在同样带标签投影，
// 会一起被筛出来（这正是「种子题的标签也能筛」这一修复的预期行为）
const tagAnyIds = (tagAny.data?.questions ?? [])
  .filter((q) => q.source === PAPER)
  .map((q) => q.id);
check("并集（tagMatch=any）：本卷命中 2 题",
  tagAnyIds.length === 2 && tagAnyIds.includes(q1.id) && tagAnyIds.includes(q2.id), tagAnyIds);

const tagsCsv = await request("GET", "/questions?tags=t_010", { token });
check("tags=csv 形式也可用", (tagsCsv.data?.questions ?? []).some((q) => q.id === q2.id), tagsCsv.data?.total);

// ---------------------------------------------------------------------------
console.log("\n【三】按提示词类型 / 空格数 / 关键词筛选\n");
// ---------------------------------------------------------------------------
const hintRes = await request("GET", `/questions?hintType=${encodeURIComponent("给动词")}&source=${encodeURIComponent(PAPER)}`, { token });
const hintIds = (hintRes.data?.questions ?? []).map((q) => q.id);
check("按提示词类型：只有多空题（第 2 题）命中",
  hintIds.length === 1 && hintIds[0] === q2.id, hintIds);

const blankRes = await request("GET", `/questions?blankCountMin=2&source=${encodeURIComponent(PAPER)}`, { token });
check("按空格数 >=2：只命中多空题",
  (blankRes.data?.questions ?? []).length === 1 && blankRes.data.questions[0].id === q2.id,
  (blankRes.data?.questions ?? []).map((q) => q.id));

const kwRes = await request("GET", `/questions?q=${encodeURIComponent("The boy")}&source=${encodeURIComponent(PAPER)}`, { token });
check("关键词搜原句命中", (kwRes.data?.questions ?? []).length === 1 && kwRes.data.questions[0].id === q1.id);

const kwAnswer = await request("GET", `/questions?q=give&source=${encodeURIComponent(PAPER)}`, { token });
check("关键词能搜到提示词", (kwAnswer.data?.questions ?? []).length === 1 && kwAnswer.data.questions[0].id === q2.id);

const kwPercent = await request("GET", "/questions?q=%25", { token });
check("关键词里的 % 被当字面量（不是通配符）",
  (kwPercent.data?.questions ?? []).length === 0, kwPercent.data?.total);

// ---------------------------------------------------------------------------
console.log("\n【四】分页与排序\n");
// ---------------------------------------------------------------------------
const page1 = await request("GET", "/questions?page=1&pageSize=1", { token });
check("分页返回 page/pageSize/pages/total", page1.data?.page === 1 && page1.data?.pageSize === 1
  && typeof page1.data?.pages === "number" && typeof page1.data?.total === "number", page1.data);
check("pageSize=1 只返回 1 题", (page1.data?.questions ?? []).length === 1);

const page2 = await request("GET", "/questions?page=2&pageSize=1", { token });
check("第 2 页返回不同的题",
  (page2.data?.questions ?? []).length === 1 && page2.data.questions[0].id !== page1.data.questions[0].id);

const noPage = await request("GET", "/questions?source=" + encodeURIComponent(PAPER), { token });
check("不传 page 时返回全部（老调用方行为不变）", (noPage.data?.questions ?? []).length === 2);

const bigSize = await request("GET", "/questions?page=1&pageSize=99999", { token });
check("pageSize 超上限被夹到 500", bigSize.data?.pageSize === 500, bigSize.data?.pageSize);

// ---------------------------------------------------------------------------
console.log("\n【五】录入查重（决策 D5）\n");
// ---------------------------------------------------------------------------
const dupRes = await request("POST", "/questions/check-duplicates", {
  token,
  body: {
    questions: [
      // ① 与原句完全一致 + 答案一致 → duplicate
      { originalSentence: "The boy ______ there.", blanks: [blank(1, ["is"])] },
      // ② 原句细微差异（多余空格、全角句号）+ 答案一致 → duplicate
      { originalSentence: "The  boy______there．", blanks: [blank(1, ["is"])] },
      // ③ 同原句，答案与库里有交集（库 is，本次 is+was）→ diff
      { originalSentence: "The boy ______ there.", blanks: [blank(1, ["is", "was"])] },
      // ④ 同原句但答案完全不相交 → 刻意判 new（见 FINGERPRINT_SPEC：AI 修正答案要让人看见）
      { originalSentence: "The boy ______ there.", blanks: [blank(1, ["was"])] },
      // ⑤ 全新原句 → new
      { originalSentence: "Nobody ______ here.", blanks: [blank(1, ["is"])] },
      // ⑥ 与 ⑤ 同原句同答案 → 批内重复
      { originalSentence: "Nobody ______ here.", blanks: [blank(1, ["is"])] },
    ],
  },
});
check("查重接口 200", dupRes.status === 200, dupRes.data);
const r = dupRes.data?.results ?? [];
check("① 完全一致 → duplicate", r[0]?.state === "duplicate", r[0]);
check("① 指出匹配到哪一题", (r[0]?.matched ?? []).length >= 1 && r[0].matched[0].id === q1.id, r[0]?.matched);
check("② 空格/全角差异也判为 duplicate", r[1]?.state === "duplicate", r[1]);
check("② 匹配到的是同一题", r[1]?.matched?.[0]?.id === q1.id, r[1]?.matched);
check("③ 同原句答案不同 → diff", r[2]?.state === "diff", r[2]);
check("③ 差异说明里带上具体答案", typeof r[2]?.hint === "string" && r[2].hint.length > 0, r[2]?.hint);
check("④ 答案完全不相交 → new（刻意如此，AI 修正答案要让人看见）", r[3]?.state === "new", r[3]);
check("⑤ 全新原句 → new", r[4]?.state === "new", r[4]);
check("⑥ 批内同原句同答案 → duplicate", r[5]?.state === "duplicate", r[5]);
check("⑥ 指出与本批第 5 题重复", String(r[5]?.hint ?? "").includes("本批"), r[5]?.hint);
check("汇总数正确（new=2 / duplicate=3 / diff=1）",
  dupRes.data?.summary?.new === 2 && dupRes.data?.summary?.duplicate === 3
  && dupRes.data?.summary?.diff === 1, dupRes.data?.summary);

const dupNoAuth = await request("POST", "/questions/check-duplicates", {
  body: { questions: [{ originalSentence: "x", blanks: [blank(1, ["y"])] }] },
});
check("未登录查重 → 401", dupNoAuth.status === 401, dupNoAuth.status);

// ---------------------------------------------------------------------------
console.log("\n【六】编辑题目：投影跟着变\n");
// ---------------------------------------------------------------------------
// 把第 1 题的标签换成 t_010（原本是 t_001 + t_026）
const upd = await request("PUT", `/questions/${q1.id}`, {
  token,
  body: { blanks: [blank(1, ["is"], ["t_010"])] },
});
check("编辑成功", upd.status === 200, upd.data);

const afterTag = await request("GET", "/questions?tag=t_010", { token });
const afterTagIds = (afterTag.data?.questions ?? []).map((q) => q.id);
check("新标签能筛到", afterTagIds.includes(q1.id), afterTagIds);

const oldTag = await request("GET", "/questions?tag=t_026", { token });
check("旧标签筛不到了（投影已重建，不是叠加）",
  !(oldTag.data?.questions ?? []).map((q) => q.id).includes(q1.id),
  (oldTag.data?.questions ?? []).map((q) => q.id));

// 改原句 → 指纹要重算
const updSentence = await request("PUT", `/questions/${q1.id}`, {
  token,
  body: { originalSentence: "The girl ______ there.", blanks: [blank(1, ["is"], ["t_010"])] },
});
check("改原句成功", updSentence.status === 200, updSentence.data);
const afterSentence = await request("GET", `/questions?source=${encodeURIComponent(PAPER)}`, { token });
const q1After = (afterSentence.data?.questions ?? []).find((q) => q.id === q1.id);
check("指纹已随原句重算", q1After?.fingerprint === "thegirlthere", q1After?.fingerprint);

const dupAfterEdit = await request("POST", "/questions/check-duplicates", {
  token,
  body: { questions: [{ originalSentence: "The boy ______ there.", blanks: [blank(1, ["is"])] }] },
});
check("改过原句后，旧原句不再被判为重复",
  dupAfterEdit.data?.results?.[0]?.state === "new", dupAfterEdit.data?.results?.[0]);

// ---------------------------------------------------------------------------
console.log("\n【七】改卷名：source 与收藏一起跟随\n");
// ---------------------------------------------------------------------------
const papers = await request("GET", "/papers", { token });
const myPaper = (papers.data?.papers ?? []).find((p) => p.name === PAPER);
check("试卷已自动创建", Boolean(myPaper), myPaper);

// 先收藏这张卷
await request("POST", "/favorites", { token, body: { source: PAPER } });
const favBefore = await request("GET", "/favorites", { token });
check("收藏成功", (favBefore.data?.favorites ?? []).some((f) => f.source === PAPER), favBefore.data?.favorites?.length);

const renamed = await request("PUT", `/papers/${myPaper.id}`, { token, body: { name: PAPER2 } });
check("改卷名成功", renamed.status === 200, renamed.data);

const afterRename = await request("GET", "/questions", { token });
const stillThere = (afterRename.data?.questions ?? []).filter((q) => q.source === PAPER2);
check("题目的 source 跟着卷名一起改了", stillThere.length === 2, {
  newName: stillThere.length,
  oldName: (afterRename.data?.questions ?? []).filter((q) => q.source === PAPER).length,
});

const favAfter = await request("GET", "/favorites", { token });
check("收藏跟着改名，没有失效",
  (favAfter.data?.favorites ?? []).some((f) => f.source === PAPER2)
  && !(favAfter.data?.favorites ?? []).some((f) => f.source === PAPER),
  (favAfter.data?.favorites ?? []).map((f) => f.source));

// 再改回来，方便后面断言
await request("PUT", `/papers/${myPaper.id}`, { token, body: { name: PAPER } });

// ---------------------------------------------------------------------------
console.log("\n【八】删标签：级联清理引用\n");
// ---------------------------------------------------------------------------
// 先确认 t_026 此刻没有被引用，然后造一道引用 t_010 的题，把 t_010 从字典里去掉
const tagsNow = await request("GET", "/tags", { token });
// 注意返回结构是 { tagDictionary: { tags: [...] } }，不是 { tags: [...] }
const dictTags = tagsNow.data?.tagDictionary?.tags ?? [];
const keepTag = dictTags.find((t) => t.id === "t_026");
check("拿到标签字典", Boolean(keepTag), dictTags.length);

const beforeCount = (await request("GET", "/questions?tag=t_010", { token })).data?.questions?.length ?? 0;
check("清理前能按 t_010 筛到题", beforeCount >= 1, beforeCount);

// 提交一份不含 t_010 的字典（其余原样保留，且顶级分类数量不变）
const trimmed = dictTags.filter((t) => t.id !== "t_010");
const saveTags = await request("PUT", "/tags", { token, body: { tags: trimmed.map((t) => ({
  id: t.id, name: t.name, parentId: t.parentId ?? null, color: t.color, isActive: true,
})) } });
check("保存标签字典成功", saveTags.status === 200, saveTags.data);
check("返回清理统计", typeof saveTags.data?.cleanedQuestions === "number", saveTags.data);

const afterClean = (await request("GET", "/questions?tag=t_010", { token })).data?.questions?.length ?? 0;
check("删标签后按它筛不到（投影已清）", afterClean === 0, afterClean);

const q2After = (await request("GET", `/questions?source=${encodeURIComponent(PAPER)}`, { token })).data?.questions
  ?.find((q) => q.id === q2.id);
const allTagIds = (q2After?.blanks ?? []).flatMap((b) => b.tagIds ?? []);
check("blanks_json 里的悬空 tagId 也被清掉", !allTagIds.includes("t_010"), allTagIds);
check("其余标签保留", allTagIds.includes("t_001"), allTagIds);

// 恢复字典，避免影响后续用例
await request("PUT", "/tags", { token, body: { tags: dictTags.map((t) => ({
  id: t.id, name: t.name, parentId: t.parentId ?? null, color: t.color, isActive: true,
})) } });

// ---------------------------------------------------------------------------
console.log("\n【九】标签字典的父级校验\n");
// ---------------------------------------------------------------------------
const badParent = await request("PUT", "/tags", {
  token,
  body: { tags: [{ id: "t_zz1", name: "孤儿", parentId: "t_nope", color: "#64748B", isActive: true }] },
});
check("悬空 parentId 被拒", badParent.status === 400, badParent.data);

const selfParent = await request("PUT", "/tags", {
  token,
  body: { tags: [
    { id: "t_001", name: "动词", parentId: null, color: "#64748B", isActive: true },
    { id: "t_zz2", name: "自环", parentId: "t_zz2", color: "#64748B", isActive: true },
  ] },
});
check("自引用 parentId 被拒", selfParent.status === 400, selfParent.data);

// 上面两次失败不应破坏字典
await request("PUT", "/tags", { token, body: { tags: dictTags.map((t) => ({
  id: t.id, name: t.name, parentId: t.parentId ?? null, color: t.color, isActive: true,
})) } });
const tagsRestored = await request("GET", "/tags", { token });
check("标签字典仍完整", (tagsRestored.data?.tagDictionary?.tags ?? []).length >= dictTags.length,
  tagsRestored.data?.tagDictionary?.tags?.length);

// ---------------------------------------------------------------------------
console.log("\n【十】删题：投影一起清\n");
// ---------------------------------------------------------------------------
const del = await request("DELETE", `/questions/${q2.id}`, { token });
check("删题成功", del.status === 200, del.data);

const afterDel = await request("GET", `/questions?tag=t_001&source=${encodeURIComponent(PAPER)}`, { token });
check("删掉的题不再出现在标签筛选里",
  !(afterDel.data?.questions ?? []).map((q) => q.id).includes(q2.id),
  (afterDel.data?.questions ?? []).map((q) => q.id));

const delAgain = await request("DELETE", `/questions/${q2.id}`, { token });
check("重复删除返回 404", delAgain.status === 404, delAgain.status);

// ---------------------------------------------------------------------------
console.log("\n【十一】批量归卷：paper_items 跟随\n");
// ---------------------------------------------------------------------------
const q3 = await request("POST", "/questions", {
  token,
  body: { question: { originalSentence: "Solo ______ one.", blanks: [blank(1, ["a"])], source: "散题卷" } },
});
check("建一道散题", q3.status === 201, q3.data);
const q3Row = (await request("GET", "/questions?source=" + encodeURIComponent("散题卷"), { token }))
  .data?.questions?.[0];

const move = await request("PUT", "/questions/paper", {
  token,
  body: { questionIds: [q3Row.id], paperId: myPaper.id },
});
check("批量归卷成功", move.status === 200 && move.data?.moved === 1, move.data);

const inPaper = await request("GET", `/questions?paperId=${myPaper.id}`, { token });
check("按卷能筛到刚归入的题", (inPaper.data?.questions ?? []).some((q) => q.id === q3Row.id),
  (inPaper.data?.questions ?? []).map((q) => q.id));

// ---------------------------------------------------------------------------
console.log("\n【十二】清空题库：投影不残留\n");
// ---------------------------------------------------------------------------
const reset = await request("POST", "/bank/reset", { token });
check("清空成功", reset.status === 200, reset.data);

const afterResetAll = await request("GET", "/questions", { token });
check("题库已清空", (afterResetAll.data?.questions ?? []).length === 0, afterResetAll.data?.total);
check("分页 total 也是 0", afterResetAll.data?.total === 0, afterResetAll.data?.total);

const afterResetTag = await request("GET", "/questions?tag=t_001", { token });
check("投影表已清（按标签筛不到任何东西）", (afterResetTag.data?.questions ?? []).length === 0);

const afterResetPaper = await request("GET", "/papers", { token });
check("试卷已清空", (afterResetPaper.data?.papers ?? []).length === 0, afterResetPaper.data?.papers?.length);

// ---------------------------------------------------------------------------
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
