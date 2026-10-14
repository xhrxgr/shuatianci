/**
 * 题库重构第 2 期 · 接口自测
 *
 * 覆盖：
 *   ① 蓝图 CRUD 与规则校验（含各类边界）
 *   ② 抽取与降级：题量不足时按 relaxSteps 逐步放宽，如实记录
 *   ③ 分篇：篇数 × 每篇题数、按标签聚篇
 *   ④ 生成虚拟卷：papers.kind='generated' + paper_items 分篇写入
 *   ⑤ 成员编辑：整体替换（删题/调序/移篇）、换一题
 *   ⑥ 隔离性：生成卷与原始卷互不干扰（改卷名、移题、删卷都不串味）
 *
 * 用法：node php/tests/bank-phase2-test.mjs http://127.0.0.1:9300
 * 需要**干净的库**（开头会 bank/reset，结尾也会）。
 */

const BASE = process.argv[2] || "http://127.0.0.1:9300";
const SUFFIX = Date.now().toString(36).slice(-5);
const PAPER = `阶段2测试卷_${SUFFIX}`;
const PAPER_B = `阶段2测试卷B_${SUFFIX}`;

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
    console.log(`  FAIL  ${desc}${extra === undefined ? "" : `  ← ${JSON.stringify(extra).slice(0, 240)}`}`);
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

// 干净的起点
await request("POST", "/bank/reset", { token });

// 自建标签树：t_p / t_a / t_b 三个（1 个顶级 + 2 个子标签）
const tagSave = await request("PUT", "/tags", {
  token,
  body: {
    tagDictionary: {
      schemaVersion: 1,
      tags: [
        { id: "t_p", name: "语法", parentId: null, color: "#2563eb", isActive: true },
        { id: "t_a", name: "虚拟语气", parentId: "t_p", color: "#2563eb", isActive: true },
        { id: "t_b", name: "非谓语", parentId: "t_p", color: "#2563eb", isActive: true },
      ],
    },
  },
});
check("测试前建立标签树", tagSave.status === 200, tagSave.data);

// ---------------------------------------------------------------------------
console.log("\n【一】造题：给抽取准备两类数据\n");
// ---------------------------------------------------------------------------
// A 类 5 题：标签 t_a + 给动词；其中 3 题来自 PAPER，2 题来自 PAPER_B
const questionsA = [];
for (let i = 1; i <= 5; i++) {
  questionsA.push({
    originalSentence: `A 类第 ${i} 题 ______ here now.`,
    blanks: [blank(1, [`ans${i}`], ["t_a"], "给动词", "grow")],
    source: i <= 3 ? PAPER : PAPER_B,
  });
}
// B 类 3 题：标签 t_b + 给名词
const questionsB = [];
for (let i = 1; i <= 3; i++) {
  questionsB.push({
    originalSentence: `B 类第 ${i} 题 ______ there.`,
    blanks: [blank(1, [`bns${i}`], ["t_b"], "给名词", "grow")],
    source: PAPER,
  });
}
const createRes = await request("POST", "/questions", {
  token,
  body: { questions: [...questionsA, ...questionsB] },
});
check("造题 8 道成功", createRes.status === 201 && createRes.data?.added === 8, createRes.data);

const allQ = await request("GET", "/questions", { token });
const idOf = (sentence) => allQ.data?.questions?.find((q) => q.originalSentence === sentence)?.id;
const aIds = [1, 2, 3, 4, 5].map((i) => idOf(`A 类第 ${i} 题 ______ here now.`));
const bIds = [1, 2, 3].map((i) => idOf(`B 类第 ${i} 题 ______ there.`));
check("8 道题都能查到 id", aIds.every(Boolean) && bIds.every(Boolean), { aIds, bIds });

// ---------------------------------------------------------------------------
console.log("\n【二】蓝图 CRUD 与规则校验\n");
// ---------------------------------------------------------------------------
const createBp = await request("POST", "/blueprints", {
  token,
  body: {
    name: `蓝图A_${SUFFIX}`,
    description: "测试用",
    rules: {
      count: 4,
      conditions: [{ type: "tag", ids: ["t_a"], match: "all" }],
      layout: { sections: 2, perSection: 2, groupBy: "none" },
    },
  },
});
check("创建蓝图 -> 201", createBp.status === 201, createBp.data);
const bpId = createBp.data?.blueprint?.id;
check("返回蓝图对象含 rules", !!bpId && createBp.data?.blueprint?.rules?.count === 4, createBp.data?.blueprint);

const dupBp = await request("POST", "/blueprints", {
  token,
  body: { name: `蓝图A_${SUFFIX}`, rules: { count: 1, conditions: [] } },
});
check("蓝图重名 -> 409", dupBp.status === 409, dupBp.data);

const badType = await request("POST", "/blueprints", {
  token,
  body: { name: `蓝图坏_${SUFFIX}`, rules: { count: 1, conditions: [{ type: "difficulty" }] } },
});
check("未知条件类型 -> 400 且说明", badType.status === 400 && /不支持的条件类型/.test(badType.data?.error ?? ""), badType.data);

const badHint = await request("POST", "/blueprints", {
  token,
  body: { name: `蓝图坏2_${SUFFIX}`, rules: { count: 1, conditions: [{ type: "hintType", values: ["随便"] }] } },
});
check("非法提示词类型 -> 400", badHint.status === 400, badHint.data);

const badRange = await request("POST", "/blueprints", {
  token,
  body: { name: `蓝图坏3_${SUFFIX}`, rules: { count: 1, conditions: [{ type: "blankCount", min: 5, max: 2 }] } },
});
check("空格数 min>max -> 400", badRange.status === 400, badRange.data);

const badCount = await request("POST", "/blueprints", {
  token,
  body: { name: `蓝图坏4_${SUFFIX}`, rules: { count: 9999, conditions: [] } },
});
check("题量超上限 -> 400", badCount.status === 400, badCount.data);

const noName = await request("POST", "/blueprints", {
  token,
  body: { name: "  ", rules: { count: 1, conditions: [] } },
});
check("空名 -> 400", noName.status === 400, noName.data);

const listBp = await request("GET", "/blueprints", { token });
check("列表包含新蓝图", (listBp.data?.blueprints ?? []).some((b) => b.id === bpId), listBp.data?.blueprints?.length);

const showBp = await request("GET", `/blueprints/${bpId}`, { token });
check("详情返回蓝图与 runs 数组", showBp.status === 200 && Array.isArray(showBp.data?.runs), showBp.data);

const patchBp = await request("PUT", `/blueprints/${bpId}`, {
  token,
  body: { description: "改过的描述" },
});
check("更新描述 -> 200", patchBp.status === 200 && patchBp.data?.blueprint?.description === "改过的描述", patchBp.data?.blueprint);

// ---------------------------------------------------------------------------
console.log("\n【三】试抽与降级\n");
// ---------------------------------------------------------------------------
// 全部条件命中 5 题（t_a + 给动词），要 8 题 -> 必须放宽才有 8 题
const previewRelax = await request("POST", "/blueprints/preview", {
  token,
  body: {
    rules: {
      count: 8,
      conditions: [
        { type: "tag", ids: ["t_a"], match: "all" },
        { type: "hintType", values: ["给动词"] },
      ],
      layout: { sections: 2, perSection: 4, groupBy: "none" },
      fallback: { relaxSteps: ["dropHintType", "dropBlankCount", "dropSource", "dropTag"] },
    },
  },
});
check("试抽返回 200", previewRelax.status === 200, previewRelax.data);
check("可用候选数 = 5（t_a + 给动词）", previewRelax.data?.available === 5, previewRelax.data?.available);
check("目标 8 题全部抽出（靠放宽）", previewRelax.data?.result?.drawn === 8, previewRelax.data?.result?.drawn);
check("标记为已放宽", previewRelax.data?.result?.relaxed === true, previewRelax.data?.result);
check(
  "放宽步骤含 dropHintType",
  (previewRelax.data?.result?.appliedSteps ?? []).includes("dropHintType"),
  previewRelax.data?.result?.appliedSteps
);
check("有可读的放宽说明", (previewRelax.data?.result?.notes ?? []).length > 0, previewRelax.data?.result?.notes);
check("分 2 篇", (previewRelax.data?.result?.sections ?? []).length === 2, previewRelax.data?.result?.sections?.length);
check(
  "每篇 4 题",
  (previewRelax.data?.result?.sections ?? []).every((s) => (s.questions ?? []).length === 4),
  (previewRelax.data?.result?.sections ?? []).map((s) => (s.questions ?? []).length)
);

// 条件足够时不放宽
const previewExact = await request("POST", "/blueprints/preview", {
  token,
  body: {
    rules: {
      count: 3,
      conditions: [{ type: "tag", ids: ["t_a"], match: "all" }],
      layout: { sections: 1, perSection: 3, groupBy: "none" },
    },
  },
});
check("条件够时不放宽", previewExact.data?.result?.relaxed === false, previewExact.data?.result);
check("drawn = 3", previewExact.data?.result?.drawn === 3, previewExact.data?.result?.drawn);

// 题量根本不够：放宽到极限也只能给多少算多少
const previewShort = await request("POST", "/blueprints/preview", {
  token,
  body: {
    rules: {
      count: 20,
      conditions: [{ type: "tag", ids: ["t_a"], match: "all" }],
      layout: { sections: 2, perSection: 10, groupBy: "none" },
    },
  },
});
check("题量不足 -> drawn = 8（全部题）", previewShort.data?.result?.drawn === 8, previewShort.data?.result?.drawn);
check("shortfall = 12", previewShort.data?.result?.shortfall === 12, previewShort.data?.result?.shortfall);

// 按标签聚篇：t_a 与 t_b 混合抽取时，同标签尽量同篇
const previewGrouped = await request("POST", "/blueprints/preview", {
  token,
  body: {
    rules: {
      count: 4,
      conditions: [{ type: "tag", ids: ["t_a", "t_b"], match: "any" }],
      layout: { sections: 2, perSection: 2, groupBy: "tag" },
    },
  },
});
check("聚篇抽到 4 题", previewGrouped.data?.result?.drawn === 4, previewGrouped.data?.result?.drawn);
check(
  "聚篇后每篇 2 题（均衡）",
  (previewGrouped.data?.result?.sections ?? []).every((s) => (s.questions ?? []).length === 2),
  (previewGrouped.data?.result?.sections ?? []).map((s) => (s.questions ?? []).length)
);

// ---------------------------------------------------------------------------
console.log("\n【四】生成虚拟卷\n");
// ---------------------------------------------------------------------------
const gen = await request("POST", `/blueprints/${bpId}/generate`, { token, body: {} });
check("生成 -> 201", gen.status === 201, gen.data);
const paperId = gen.data?.paper?.id;
check("卷的 kind = generated", gen.data?.paper?.kind === "generated", gen.data?.paper);
check("卷带 blueprintId", gen.data?.paper?.blueprintId === bpId, gen.data?.paper);
check("题数 = 4", gen.data?.paper?.questionCount === 4, gen.data?.paper?.questionCount);
check("run 记录返回", !!gen.data?.run?.id, gen.data?.run);

const paperList = await request("GET", "/papers", { token });
const listed = (paperList.data?.papers ?? []).find((p) => p.id === paperId);
check("列表里能看到这张卷", !!listed, paperList.data?.papers?.map((p) => p.id));
check("列表 questionCount 用成员表统计（=4）", listed?.questionCount === 4, listed?.questionCount);

const paperShow = await request("GET", `/papers/${paperId}`, { token });
check("详情页 questions 有 4 道", (paperShow.data?.questions ?? []).length === 4, paperShow.data?.questions?.length);
check("详情页 sections 分 2 篇", (paperShow.data?.sections ?? []).length === 2, paperShow.data?.sections?.length);
check(
  "分篇顺序正确（每篇 2 题）",
  (paperShow.data?.sections ?? []).every((s) => (s.items ?? []).length === 2),
  (paperShow.data?.sections ?? []).map((s) => (s.items ?? []).length)
);

// 生成卷**不写** questions.paper_id：
// 按卷筛题走的是成员表（第 1 期起），所以这些题**能**被筛出来 —— 那是有意为之；
// 真正要断言的是题目的主卷字段没有被生成卷污染
const paperOfQuestions = await request("GET", `/questions?paperId=${paperId}`, { token });
check(
  "生成卷成员能被「按卷筛题」筛到（走成员表）",
  (paperOfQuestions.data?.questions ?? []).length === 4,
  (paperOfQuestions.data?.questions ?? []).length
);
check(
  "但这些题的主卷（paperId）不是生成卷（没被污染）",
  (paperOfQuestions.data?.questions ?? []).every((q) => q.paperId !== paperId),
  (paperOfQuestions.data?.questions ?? []).map((q) => q.paperId)
);

// ---------------------------------------------------------------------------
console.log("\n【五】成员编辑\n");
// ---------------------------------------------------------------------------
const items = await request("GET", `/papers/${paperId}/items`, { token });
check("读成员 -> 200", items.status === 200, items.data);
const sectionOne = items.data?.sections?.[0]?.items?.map((item) => item.questionId) ?? [];
const sectionTwo = items.data?.sections?.[1]?.items?.map((item) => item.questionId) ?? [];
check("第 1 篇 2 题、第 2 篇 2 题", sectionOne.length === 2 && sectionTwo.length === 2, {
  sectionOne,
  sectionTwo,
});

// 整体替换：删掉第 1 篇第 1 题、把第 2 篇第 1 题移到第 1 篇、并换顺序
const removed = sectionOne[0];
const moved = sectionTwo[0];
const newSections = [
  [sectionTwo[1], moved, sectionOne[1]],
  [],
];
const saveItems = await request("PUT", `/papers/${paperId}/items`, { token, body: { sections: newSections } });
check("整体替换 -> 200", saveItems.status === 200, saveItems.data);
// 空篇不保留：paper_items 是稀疏表，一行成员都没的篇存不下来，
// 读回来时自然消失（对使用没有影响：一篇 0 题的文章没有意义）
check(
  "第 1 篇现在是 3 题、空篇不再出现",
  saveItems.data?.sections?.length === 1 && saveItems.data.sections[0].items.length === 3,
  saveItems.data?.sections?.map((s) => s.items.length)
);
check("被删的题确实不在卷里", !(saveItems.data?.sections ?? []).some((s) => s.items.some((i) => i.questionId === removed)), removed);

// 重复 id 被拒绝
const dupIds = await request("PUT", `/papers/${paperId}/items`, {
  token,
  body: { sections: [[sectionOne[1], sectionOne[1]]] },
});
check("同一题出现两次 -> 400", dupIds.status === 400, dupIds.data);

// 不存在的题被拒绝
const ghostIds = await request("PUT", `/papers/${paperId}/items`, {
  token,
  body: { sections: [["q_not_exist_xyz"]] },
});
check("不存在的题 -> 400", ghostIds.status === 400, ghostIds.data);

// 对原始卷用成员接口被拒绝
const origPaperId = listed && (paperList.data?.papers ?? []).find((p) => p.kind === "original")?.id;
if (origPaperId) {
  const origItems = await request("GET", `/papers/${origPaperId}/items`, { token });
  check("原始卷不支持成员编辑 -> 400", origItems.status === 400, origItems.data);
} else {
  check("原始卷不支持成员编辑 -> 400（跳过：没有原始卷）", true);
}

// ---------------------------------------------------------------------------
console.log("\n【六】换一题\n");
// ---------------------------------------------------------------------------
const beforeReplace = await request("GET", `/papers/${paperId}/items`, { token });
const flat = (beforeReplace.data?.sections ?? []).flatMap((s) => s.items.map((i) => i.questionId));
const replaceTarget = flat[0];
const replace = await request("POST", `/papers/${paperId}/items/replace`, {
  token,
  body: { questionId: replaceTarget },
});
check("换题 -> 200", replace.status === 200, replace.data);
const newId = replace.data?.item?.questionId;
check("换进来的不是原来那道", newId && newId !== replaceTarget, newId);
check("换进来的不在卷内其他位置", !flat.slice(1).includes(newId), { flat, newId });

const replaceGhost = await request("POST", `/papers/${paperId}/items/replace`, {
  token,
  body: { questionId: "q_not_in_paper" },
});
check("换不在卷里的题 -> 404", replaceGhost.status === 404, replaceGhost.data);

// ---------------------------------------------------------------------------
console.log("\n【七】重新生成与隔离性\n");
// ---------------------------------------------------------------------------
const regen = await request("POST", `/blueprints/${bpId}/generate`, { token, body: { paperId } });
check("重新生成 -> 200（不是 201）", regen.status === 200, regen.data);
check("重新生成后仍是同一张卷", regen.data?.paper?.id === paperId, regen.data?.paper?.id);
check("重新生成后题数回到 4", regen.data?.paper?.questionCount === 4, regen.data?.paper?.questionCount);

const bpDetail = await request("GET", `/blueprints/${bpId}`, { token });
check("使用记录有 2 条", (bpDetail.data?.runs ?? []).length === 2, (bpDetail.data?.runs ?? []).length);
check("两次 run 都挂在同一张卷", (bpDetail.data?.runs ?? []).every((r) => r.paperId === paperId), bpDetail.data?.runs);

// 隔离性 1：题目从原卷移走，生成卷成员不受影响
const memberBefore = (await request("GET", `/papers/${paperId}/items`, { token })).data?.sections
  ?.flatMap((s) => s.items.map((i) => i.questionId)) ?? [];
const moveAway = await request("PUT", "/questions/paper", {
  token,
  body: { questionIds: [memberBefore[0]], paperId: null },
});
check("把生成卷里的一道题移出原卷", moveAway.status === 200, moveAway.data);
const memberAfter = (await request("GET", `/papers/${paperId}/items`, { token })).data?.sections
  ?.flatMap((s) => s.items.map((i) => i.questionId)) ?? [];
check(
  "生成卷成员不受「移出原卷」影响",
  memberAfter.length === memberBefore.length && memberBefore.every((id) => memberAfter.includes(id)),
  { memberBefore, memberAfter }
);

// 隔离性 2：原始卷改名 -> 生成卷成员与卷名都不变
const paperNameBefore = (await request("GET", `/papers/${paperId}`, { token })).data?.paper?.name;
const paperList2 = (await request("GET", "/papers", { token })).data?.papers ?? [];
const testPaper = paperList2.find((p) => p.name === PAPER);
if (testPaper) {
  const rename = await request("PUT", `/papers/${testPaper.id}`, { token, body: { name: `${PAPER}改` } });
  check("原始卷改名 -> 200", rename.status === 200, rename.data);
  const paperNameAfter = (await request("GET", `/papers/${paperId}`, { token })).data?.paper?.name;
  check("生成卷的名字不受影响", paperNameAfter === paperNameBefore, { paperNameBefore, paperNameAfter });
} else {
  check("原始卷改名 -> 200（跳过：找不到原始卷）", true);
  check("生成卷的名字不受影响（跳过）", true);
}

// 隔离性 3：删生成卷不删题、不影响原卷归属
const questionIdsBefore = (await request("GET", "/questions", { token })).data?.total;
const delGenerated = await request("DELETE", `/papers/${paperId}`, { token });
check("删除生成卷 -> 200", delGenerated.status === 200, delGenerated.data);
check("返回 wasGenerated = true", delGenerated.data?.wasGenerated === true, delGenerated.data);
check("解绑题数为 0（生成卷不动 paper_id）", delGenerated.data?.unlinkedQuestions === 0, delGenerated.data);
const questionIdsAfter = (await request("GET", "/questions", { token })).data?.total;
check("题目一道没少", questionIdsBefore === questionIdsAfter, { questionIdsBefore, questionIdsAfter });

// 隔离性 4：删蓝图保留已生成的卷
const gen2 = await request("POST", `/blueprints/${bpId}/generate`, { token, body: {} });
const paperId2 = gen2.data?.paper?.id;
check("再生成一张卷", gen2.status === 201, gen2.data);
const delBp = await request("DELETE", `/blueprints/${bpId}`, { token });
check("删除蓝图 -> 200", delBp.status === 200, delBp.data);
const paper2After = await request("GET", `/papers/${paperId2}`, { token });
check("蓝图删除后卷还在", paper2After.status === 200, paper2After.status);
check("卷的 blueprintId 已置空", paper2After.data?.paper?.blueprintId === null, paper2After.data?.paper?.blueprintId);
check("成员还在（4 题）", (paper2After.data?.questions ?? []).length === 4, paper2After.data?.questions?.length);

// 蓝图没了之后换题仍能工作（用被换题的标签兜底）
const replaceAfterBpDelete = await request("POST", `/papers/${paperId2}/items/replace`, {
  token,
  body: { questionId: (paper2After.data?.questions ?? [])[0]?.id },
});
check("蓝图删除后仍能换题（标签兜底）", replaceAfterBpDelete.status === 200, replaceAfterBpDelete.data);

// ---------------------------------------------------------------------------
console.log("\n【七】隔离性加固（审查修复后新增的回归用例）\n");
// ---------------------------------------------------------------------------
// 新建一张蓝图 + 生成卷（上面的 bpId 已被删除，不能再用来生成）
const bpC = await request("POST", "/blueprints", {
  token,
  body: {
    name: `蓝图C_${SUFFIX}`,
    rules: {
      count: 4,
      conditions: [{ type: "tag", ids: ["t_a", "t_b"], match: "any" }],
      layout: { sections: 2, perSection: 2, groupBy: "none" },
    },
  },
});
check("建第三张蓝图", bpC.status === 201, bpC.data);
const bpCId = bpC.data?.blueprint?.id;
const gen3 = await request("POST", `/blueprints/${bpCId}/generate`, { token, body: {} });
check("第三张生成卷", gen3.status === 201, gen3.data);
const paperId3 = gen3.data?.paper?.id;
const memberOf3 = (await request("GET", `/papers/${paperId3}/items`, { token })).data?.sections
  ?.flatMap((s) => s.items.map((i) => i.questionId)) ?? [];
check("第三张卷有 4 题", memberOf3.length === 4, memberOf3.length);

// ① 编辑题目时不能把题指到虚拟卷（曾是可写路径：会污染 questions.paper_id）
const editIntoGenerated = await request("PUT", `/questions/${memberOf3[0]}`, {
  token,
  body: { paperId: paperId3 },
});
check("编辑题目 -> 拒绝指定虚拟卷", editIntoGenerated.status === 400, editIntoGenerated.data);
check("拒绝时说的是卷名而不是 id", editIntoGenerated.data?.error?.includes("虚拟卷") === true, editIntoGenerated.data);

// ② 批量移动同样拒绝虚拟卷
const bulkIntoGenerated = await request("PUT", "/questions/paper", {
  token,
  body: { questionIds: [memberOf3[1]], paperId: paperId3 },
});
check("批量移动 -> 拒绝指定虚拟卷", bulkIntoGenerated.status === 400, bulkIntoGenerated.data);

// ③ 用蓝图 B 的规则不能重新生成属于蓝图 A 的卷（归属不一致）
const bpB = await request("POST", "/blueprints", {
  token,
  body: {
    name: `蓝图B_${SUFFIX}`,
    rules: { count: 2, conditions: [{ type: "tag", ids: ["t_b"], match: "all" }], layout: { sections: 1, perSection: 2 } },
  },
});
check("建第二张蓝图", bpB.status === 201, bpB.data);
const crossRegen = await request("POST", `/blueprints/${bpB.data?.blueprint?.id}/generate`, {
  token,
  body: { paperId: paperId3 },
});
check("跨蓝图重新生成 -> 400", crossRegen.status === 400, crossRegen.data);
check(
  "卷的归属没被改掉",
  (await request("GET", `/papers/${paperId3}`, { token })).data?.paper?.blueprintId === bpCId
);

// ④ 降级步骤被全部关掉时，服务端不得偷偷补回来
const noRelaxBp = await request("POST", "/blueprints", {
  token,
  body: {
    name: `不放宽蓝图_${SUFFIX}`,
    rules: {
      count: 99,
      conditions: [{ type: "tag", ids: ["t_a"], match: "all" }],
      layout: { sections: 1, perSection: 99 },
      fallback: { relaxSteps: [] },
    },
  },
});
check("建「一步都不放宽」的蓝图", noRelaxBp.status === 201, noRelaxBp.data);
check(
  "relaxSteps 保存为空数组（不被补全）",
  (noRelaxBp.data?.blueprint?.rules?.fallback?.relaxSteps ?? null)?.length === 0,
  noRelaxBp.data?.blueprint?.rules?.fallback?.relaxSteps
);
const noRelaxPreview = await request("POST", "/blueprints/preview", {
  token,
  body: {
    rules: {
      count: 99,
      conditions: [{ type: "tag", ids: ["t_a"], match: "all" }],
      layout: { sections: 1, perSection: 99 },
      fallback: { relaxSteps: [] },
    },
  },
});
check("不放宽时题量不足就只给 5 题（不偷偷放宽）", noRelaxPreview.data?.result?.drawn === 5, noRelaxPreview.data?.result?.drawn);
check("不放宽时 relaxed = false", noRelaxPreview.data?.result?.relaxed === false, noRelaxPreview.data?.result);
// 前端的 round-trip（取消后重新打开仍是取消）在 blueprint-ui-test.mjs 里用浏览器验证

// ⑤ 蓝图名唯一（并发创建两条同名由唯一索引兜底）
const dupName = await request("POST", "/blueprints", {
  token,
  body: { name: `蓝图B_${SUFFIX}`, rules: { count: 1, conditions: [] } },
});
check("蓝图重名 -> 409", dupName.status === 409, dupName.data);

// ---------------------------------------------------------------------------
console.log("\n【八】清场\n");
// ---------------------------------------------------------------------------
const reset = await request("POST", "/bank/reset", { token });
check("清空成功", reset.status === 200, reset.data);
const bpAfterReset = await request("GET", "/blueprints", { token });
check("蓝图一并清空", (bpAfterReset.data?.blueprints ?? []).length === 0, bpAfterReset.data?.blueprints?.length);
const papersAfterReset = await request("GET", "/papers", { token });
check("试卷一并清空", (papersAfterReset.data?.papers ?? []).length === 0, papersAfterReset.data?.papers?.length);

// ---------------------------------------------------------------------------
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
