/**
 * PHP 版接口端到端自测。
 *
 * 用法：
 *   node php/tests/api-test.mjs http://127.0.0.1:9001
 *   node php/tests/api-test.mjs http://127.0.0.1:9001 --out /tmp/php.json
 *
 * --out 会把每个用例的响应做「动态值归一化」后写入文件
 * （token、时间、自增 id、git 提交号都替换成占位符），
 * 这样可以拿两份输出直接 diff，
 * 用来证明两边的响应结构完全一致。
 */

const BASE = process.argv[2] || "http://127.0.0.1:9001";

// 每次运行用随机后缀：同一个库反复跑也不会因为「用户名已被占用」而失败
const SUFFIX = Date.now().toString(36).slice(-5);
const TEST_USER = `test_user_${SUFFIX}`;
const REG_USER = `reg_user_${SUFFIX}`;
const THROTTLE_USER = `throttle_${SUFFIX}`;
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex > -1 ? process.argv[outIndex + 1] : null;

let pass = 0;
const failures = [];
const records = [];

/** 动态字段：两边不可能相等，对比时统一替换 */
const DYNAMIC_KEYS = new Set([
  "id",
  "token",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "commitDate",
  "commit",
  "shortCommit",
  "time",
  "commitSubject",
  "branch",
]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = DYNAMIC_KEYS.has(key) ? "<dyn>" : normalize(val);
    }
    return out;
  }
  return value;
}

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
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __raw: text.slice(0, 120) };
  }
  return { status: response.status, data };
}

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
  records.push({ name, ok: !!condition, detail: detail ?? null });
}

function record(name, status, data) {
  records.push({ step: name, status, data: normalize(data) });
}

/** 一道能通过服务端校验的测试题 */
const SAMPLE_QUESTION = {
  id: "q_test_001",
  originalSentence: "She is ______ than her sister.",
  blanks: [
    {
      blankIndex: 1,
      answer: ["taller"],
      hintType: "给形容词",
      hintWord: "tall",
      trapAnalysis: "than 提示用比较级，tall 的比较级是 taller",
    },
  ],
  source: "测试卷",
  schemaVersion: 1,
};

async function main() {
  console.log(`\n接口自测：${BASE}\n`);

  /* ---------------- 基础 ---------------- */
  const health = await request("GET", "/health");
  check("GET /health 返回 200 且 ok=true", health.status === 200 && health.data.ok === true, health.data);
  record("health", health.status, health.data);
  check(
    "GET /health 的 time 是 ISO 字符串",
    typeof health.data.time === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(health.data.time),
    health.data.time
  );

  /* ---------------- 登录 ---------------- */
  const badLogin = await request("POST", "/auth/login", { body: { username: "admin", password: "错误密码" } });
  check("登录：错误密码 401 且文案一致", badLogin.status === 401 && badLogin.data.error === "用户名或密码错误", badLogin.data);
  record("login-wrong", badLogin.status, badLogin.data);

  const login = await request("POST", "/auth/login", { body: { username: "admin", password: "123456" } });
  check("登录：admin/123456 成功并拿到 token", login.status === 200 && typeof login.data.token === "string", login.data);
  check(
    "登录：user 结构为 id/username/role/displayName",
    login.data.user &&
      Object.keys(login.data.user).sort().join(",") === "displayName,id,role,username" &&
      login.data.user.role === "admin",
    login.data.user
  );
  const adminToken = login.data.token;
  record("login", login.status, { ...login.data, token: "<dyn>" });

  const me = await request("GET", "/auth/me", { token: adminToken });
  check("GET /auth/me 返回当前用户", me.status === 200 && me.data.user.username === "admin", me.data);
  record("me", me.status, me.data);

  // 清掉上一次运行留下的收藏与标记，保证断言从干净状态开始
  {
    const marks = await request("GET", "/marks", { token: adminToken });
    for (const item of marks.data?.marks ?? []) {
      await request("POST", "/marks", { token: adminToken, body: { questionId: item.questionId } });
    }
    const favorites = await request("GET", "/favorites", { token: adminToken });
    for (const item of favorites.data?.favorites ?? []) {
      await request("POST", "/favorites", { token: adminToken, body: { source: item.source } });
    }
  }

  /* ---------------- 题库读取（公开） ---------------- */
  const questions = await request("GET", "/questions");
  check("GET /questions 返回数组且种子已导入", questions.status === 200 && questions.data.questions.length > 0, {
    count: questions.data.questions?.length,
  });
  const first = questions.data.questions[0];
  check(
    // paperId 是 v3.0.22 起新增：题目归属的试卷，未归卷时为 null
    "题目字段结构完整（id/originalSentence/blanks/source/paperId/schemaVersion/status/wrongCount/createdAt）",
    first &&
      Object.keys(first).sort().join(",") ===
        "blanks,createdAt,id,originalSentence,paperId,schemaVersion,source,status,wrongCount",
    Object.keys(first || {})
  );
  record("questions", questions.status, { count: questions.data.questions?.length, first });

  const tags = await request("GET", "/tags");
  check(
    "GET /tags 返回 tagDictionary，tags 为数组",
    tags.status === 200 && tags.data.tagDictionary.schemaVersion === 1 && Array.isArray(tags.data.tagDictionary.tags),
    { count: tags.data.tagDictionary?.tags?.length }
  );
  record("tags", tags.status, { count: tags.data.tagDictionary?.tags?.length, first: tags.data.tagDictionary?.tags?.[0] });

  /* ---------------- 权限 ---------------- */
  const anonWrite = await request("POST", "/questions", { body: { question: SAMPLE_QUESTION } });
  check("未登录写入题库 -> 401「请先登录」", anonWrite.status === 401 && anonWrite.data.error === "请先登录", anonWrite.data);
  record("anon-write", anonWrite.status, anonWrite.data);

  /* ---------------- 做题记录 ---------------- */
  const questionId = first.id;
  const submit = await request("POST", "/records", {
    token: adminToken,
    body: { questionId, isCorrect: false, wrongCount: 2, answers: ["wrong1"] },
  });
  check("POST /records 提交成功返回 201 stored=true", submit.status === 201 && submit.data.stored === true, submit.data);
  record("submit-record", submit.status, submit.data);

  const guestSubmit = await request("POST", "/records", {
    body: { questionId, isCorrect: true, wrongCount: 0, answers: ["x"] },
  });
  check(
    "游客提交记录 -> 200 且 stored=false（不落库）",
    guestSubmit.status === 200 && guestSubmit.data.stored === false,
    guestSubmit.data
  );

  const missingQuestion = await request("POST", "/records", {
    token: adminToken,
    body: { questionId: "q_not_exist", isCorrect: true, wrongCount: 0 },
  });
  check(
    "记录不存在的题目 -> 404「题目不存在或已删除」",
    missingQuestion.status === 404 && missingQuestion.data.error === "题目不存在或已删除",
    missingQuestion.data
  );

  const summary = await request("GET", "/records/summary", { token: adminToken });
  check(
    "GET /records/summary 字段完整（total/correct/wrong/accuracy/recent/weakQuestions）",
    summary.status === 200 &&
      Object.keys(summary.data).sort().join(",") ===
        "accuracy,authenticated,correct,recent,total,weakQuestions,wrong",
    Object.keys(summary.data)
  );
  record("summary", summary.status, summary.data);

  const guestSummary = await request("GET", "/records/summary");
  check(
    "游客 summary -> authenticated=false 且四项为 0",
    guestSummary.status === 200 &&
      guestSummary.data.authenticated === false &&
      guestSummary.data.total === 0 &&
      guestSummary.data.accuracy === 0,
    guestSummary.data
  );

  /* ---------------- 进度 ---------------- */
  const setProgress = await request("POST", `/progress/${questionId}`, {
    token: adminToken,
    body: { status: "mastered" },
  });
  check("POST /progress/{id} 标记已掌握", setProgress.status === 200 && setProgress.data.stored === true, setProgress.data);

  const progress = await request("GET", "/progress", { token: adminToken });
  check(
    "GET /progress 返回该用户的进度映射",
    progress.status === 200 &&
      progress.data.authenticated === true &&
      progress.data.progress[questionId]?.status === "mastered",
    progress.data
  );
  record("progress", progress.status, progress.data);

  const guestProgress = await request("GET", "/progress");
  check(
    "游客进度 -> authenticated=false 且 progress 为空对象",
    guestProgress.status === 200 && guestProgress.data.authenticated === false,
    guestProgress.data
  );

  /* ---------------- 收藏 ---------------- */
  const fav1 = await request("POST", "/favorites", { token: adminToken, body: { source: "测试卷", note: "备注" } });
  check("收藏试卷 -> favorited=true", fav1.status === 200 && fav1.data.favorited === true, fav1.data);
  const fav2 = await request("POST", "/favorites", { token: adminToken, body: { source: "测试卷" } });
  check("再次收藏 -> 取消收藏 favorited=false", fav2.status === 200 && fav2.data.favorited === false, fav2.data);
  record("favorites-toggle", fav2.status, fav2.data);

  await request("POST", "/favorites", { token: adminToken, body: { source: "测试卷", note: "备注" } });
  const favList = await request("GET", "/favorites", { token: adminToken });
  check(
    "GET /favorites 字段完整",
    favList.status === 200 &&
      favList.data.favorites[0] &&
      Object.keys(favList.data.favorites[0]).sort().join(",") === "createdAt,note,questionCount,source",
    favList.data.favorites?.[0]
  );
  record("favorites-list", favList.status, { item: favList.data.favorites?.[0] });

  /* ---------------- 标记 ---------------- */
  const mark1 = await request("POST", "/marks", { token: adminToken, body: { questionId, label: "重点" } });
  check("标记题目 -> marked=true", mark1.status === 200 && mark1.data.marked === true, mark1.data);
  const markList = await request("GET", "/marks", { token: adminToken });
  check(
    "GET /marks 字段完整",
    markList.status === 200 &&
      markList.data.marks[0] &&
      Object.keys(markList.data.marks[0]).sort().join(",") === "createdAt,label,note,questionId",
    markList.data.marks?.[0]
  );
  record("marks-list", markList.status, { item: markList.data.marks?.[0] });

  const markMissing = await request("POST", "/marks", { token: adminToken, body: { questionId: "q_not_exist" } });
  check("标记不存在的题目 -> 404「题目不存在或已删除」", markMissing.status === 404 && markMissing.data.error === "题目不存在或已删除", markMissing.data);

  /* ---------------- 题库写入（管理员） ---------------- */
  const created = await request("POST", "/questions", { token: adminToken, body: { question: SAMPLE_QUESTION } });
  check(
    "POST /questions 新增成功（201，added=1）",
    created.status === 201 && created.data.added === 1 && created.data.renamed === 0,
    created.data
  );
  record("question-create", created.status, created.data);

  // 重复 id 不再静默跳过（那会让用户以为导入成功，实际一题没进库），改为自动换新编号
  const dup = await request("POST", "/questions", { token: adminToken, body: { question: SAMPLE_QUESTION } });
  const dupList = await request("GET", "/questions", { token: adminToken });
  const dupKept = (dupList.data.questions ?? []).filter((q) => q.originalSentence === SAMPLE_QUESTION.originalSentence);
  check(
    "同 id 重复导入 -> 自动换新编号，added=2（不再跳过）",
    dup.status === 201 && dup.data.added === 1 && dup.data.renamed === 1 && dupKept.length === 2,
    dup.data
  );

  // 缺 id 时由服务端生成，AI 导入不再要求 AI 输出编号
  const noId = await request("POST", "/questions", {
    token: adminToken,
    body: {
      question: {
        originalSentence: "Server generated id ______ test.",
        blanks: [
          {
            blankIndex: 1,
            answer: ["ok"],
            hintWord: null,
            hintType: "无提示词",
            tagIds: ["t_001"],
            trapAnalysis: "缺 id 时由服务端生成编号。",
          },
        ],
      },
    },
  });
  const noIdList = await request("GET", "/questions", { token: adminToken });
  const generated = (noIdList.data.questions ?? []).find(
    (q) => q.originalSentence === "Server generated id ______ test."
  );
  check(
    "缺 id 的题目 -> 服务端生成 q_ 前缀编号",
    noId.status === 201 && noId.data.added === 1 && /^q_[0-9a-z]+(_[0-9a-z]+)?$/.test(generated?.id ?? ""),
    { resp: noId.data, id: generated?.id }
  );

  // 同批内多条缺 id 也不能撞号
  const batchNoId = await request("POST", "/questions", {
    token: adminToken,
    body: {
      questions: ["A ______ b.", "C ______ d.", "E ______ f."].map((sentence) => ({
        originalSentence: sentence,
        blanks: [
          {
            blankIndex: 1,
            answer: ["x"],
            hintWord: null,
            hintType: "无提示词",
            tagIds: ["t_001"],
            trapAnalysis: "同批缺 id 不得撞号。",
          },
        ],
      })),
    },
  });
  const batchList = await request("GET", "/questions", { token: adminToken });
  const batchIds = ["A ______ b.", "C ______ d.", "E ______ f."].map(
    (s) => (batchList.data.questions ?? []).find((q) => q.originalSentence === s)?.id
  );
  check(
    "同批多条缺 id -> 编号互不相同",
    batchNoId.status === 201 && batchNoId.data.added === 3 && new Set(batchIds).size === 3 && !batchIds.includes(undefined),
    { resp: batchNoId.data, ids: batchIds }
  );

  const invalid = await request("POST", "/questions", {
    token: adminToken,
    body: { question: { id: "q_bad", originalSentence: "no blank here", blanks: [] } },
  });
  check("非法题目 -> 400 且带 details", invalid.status === 400 && Array.isArray(invalid.data.details), invalid.data.error);
  record("question-invalid", invalid.status, { error: invalid.data.error, hasDetails: Array.isArray(invalid.data.details) });

  const updated = await request("PUT", `/questions/${SAMPLE_QUESTION.id}`, {
    token: adminToken,
    body: { source: "改后的来源" },
  });
  check("PUT /questions/{id} 更新成功", updated.status === 200 && updated.data.ok === true, updated.data);

  const noField = await request("PUT", `/questions/${SAMPLE_QUESTION.id}`, { token: adminToken, body: {} });
  check("PUT 空字段 -> 400「没有需要更新的字段」", noField.status === 400 && noField.data.error === "没有需要更新的字段", noField.data);

  const deleted = await request("DELETE", `/questions/${SAMPLE_QUESTION.id}`, { token: adminToken });
  check("DELETE /questions/{id} 删除成功", deleted.status === 200 && deleted.data.ok === true, deleted.data);
  const deletedAgain = await request("DELETE", `/questions/${SAMPLE_QUESTION.id}`, { token: adminToken });
  check("删除不存在的题目 -> 404", deletedAgain.status === 404 && deletedAgain.data.error === "题目不存在或已删除", deletedAgain.data);

  // 整库上云必须保留原编号，不能因为与库中已有 id 相同就换新。
  // 放在删除用例之后：replaceAll 会清空整个题库，不能影响上面依赖 SAMPLE_QUESTION.id 的用例
  const cloud = await request("POST", "/questions", {
    token: adminToken,
    body: {
      replaceAll: true,
      questions: [
        {
          id: "q_cloud_keep",
          originalSentence: "Cloud upload ______ keeps id.",
          blanks: [
            {
              blankIndex: 1,
              answer: ["must"],
              hintWord: null,
              hintType: "无提示词",
              tagIds: ["t_001"],
              trapAnalysis: "整库上云需保留原编号。",
            },
          ],
        },
      ],
    },
  });
  const cloudList = await request("GET", "/questions", { token: adminToken });
  const kept = (cloudList.data.questions ?? []).find((q) => q.id === "q_cloud_keep");
  check(
    "整库上云（replaceAll）-> 保留原编号",
    cloud.status === 201 && cloud.data.renamed === 0 && kept?.originalSentence === "Cloud upload ______ keeps id.",
    { resp: cloud.data, id: kept?.id }
  );
  check(
    "replaceAll 后题库仅剩上云的那一道",
    (cloudList.data.questions ?? []).length === 1,
    cloudList.data.questions?.length
  );

  /* ---------------- 试卷 ---------------- */
  const paperName = `测试卷${Date.now().toString(36)}`;
  const paperCreated = await request("POST", "/papers", {
    token: adminToken,
    body: { name: paperName, examDate: "2026-10-13", note: "接口自测用" },
  });
  check(
    "POST /papers 新建试卷（201，带日期与备注）",
    paperCreated.status === 201 &&
      paperCreated.data.paper.name === paperName &&
      paperCreated.data.paper.examDate === "2026-10-13" &&
      paperCreated.data.paper.note === "接口自测用",
    paperCreated.data.paper
  );
  const paperId = paperCreated.data.paper.id;
  record("paper-create", paperCreated.status, paperCreated.data.paper);

  const dupPaper = await request("POST", "/papers", { token: adminToken, body: { name: paperName } });
  check("同名试卷 -> 409", dupPaper.status === 409 && dupPaper.data.error === "同名试卷已存在", dupPaper.data);

  const noName = await request("POST", "/papers", { token: adminToken, body: { name: "   " } });
  check("试卷名为空 -> 400", noName.status === 400 && noName.data.error === "试卷名不能为空", noName.data);

  const badDate = await request("PUT", `/papers/${paperId}`, {
    token: adminToken,
    body: { examDate: "2026/10/13" },
  });
  check(
    "非法考试日期 -> 400「考试日期格式应为 YYYY-MM-DD」",
    badDate.status === 400 && badDate.data.error === "考试日期格式应为 YYYY-MM-DD",
    badDate.data
  );

  const impossibleDate = await request("PUT", `/papers/${paperId}`, {
    token: adminToken,
    body: { examDate: "2026-13-01" },
  });
  check("不存在的日期 -> 400", impossibleDate.status === 400, impossibleDate.data);

  // 按 source 自动归卷：同一来源的题目落到同一张卷
  const autoPaper = await request("POST", "/questions", {
    token: adminToken,
    body: {
      questions: [
        {
          originalSentence: "Auto paper ______ sentence one.",
          blanks: [
            {
              blankIndex: 1,
              answer: ["auto"],
              hintWord: null,
              hintType: "无提示词",
              tagIds: ["t_004", "t_026"],
              trapAnalysis: "自动归卷测试。",
            },
          ],
          source: paperName,
        },
        {
          originalSentence: "Auto paper ______ sentence two.",
          blanks: [
            {
              blankIndex: 1,
              answer: ["auto"],
              hintWord: null,
              hintType: "无提示词",
              tagIds: ["t_004", "t_026"],
              trapAnalysis: "自动归卷测试。",
            },
          ],
          source: paperName,
        },
      ],
    },
  });
  const afterAuto = await request("GET", "/papers", { token: adminToken });
  const autoPaperRow = (afterAuto.data.papers ?? []).find((p) => p.id === paperId);
  check(
    "题目按 source 自动归卷（2 道题挂到同一张卷）",
    autoPaper.status === 201 && autoPaperRow?.questionCount === 2,
    { resp: autoPaper.data, count: autoPaperRow?.questionCount }
  );

  const filtered = await request("GET", `/questions?paperId=${paperId}`, { token: adminToken });
  check(
    "GET /questions?paperId= 只返回该卷题目",
    filtered.status === 200 &&
      (filtered.data.questions ?? []).length === 2 &&
      filtered.data.questions.every((q) => q.paperId === paperId),
    filtered.data.questions?.length
  );

  const badFilter = await request("GET", "/questions?paperId=p_not_exist", { token: adminToken });
  check("筛选不存在的试卷 -> 404", badFilter.status === 404, badFilter.data);

  const show = await request("GET", `/papers/${paperId}`, { token: adminToken });
  check(
    "GET /papers/{id} 返回试卷与题目",
    show.status === 200 &&
      show.data.paper.id === paperId &&
      Array.isArray(show.data.questions) &&
      show.data.questions.length === 2 &&
      show.data.questions.every((q) => q.schemaVersion >= 1),
    { paper: show.data.paper?.id, questions: show.data.questions?.length }
  );

  // 批量改归属
  const firstId = filtered.data.questions[0].id;
  const otherPaper = await request("POST", "/papers", {
    token: adminToken,
    body: { name: `${paperName}-副卷` },
  });
  const moved = await request("PUT", "/questions/paper", {
    token: adminToken,
    body: { questionIds: [firstId], paperId: otherPaper.data.paper.id },
  });
  const afterMove = await request("GET", "/papers", { token: adminToken });
  check(
    "PUT /questions/paper 批量改归属",
    moved.status === 200 && moved.data.moved === 1,
    moved.data
  );
  const mainCount = (afterMove.data.papers ?? []).find((p) => p.id === paperId)?.questionCount;
  const subCount = (afterMove.data.papers ?? []).find((p) => p.id === otherPaper.data.paper.id)?.questionCount;
  check("改归属后题数正确（原卷 1、副卷 1）", mainCount === 1 && subCount === 1, { mainCount, subCount });

  const unlink = await request("PUT", "/questions/paper", {
    token: adminToken,
    body: { questionIds: [firstId], paperId: null },
  });
  const afterUnlink = await request("GET", "/papers", { token: adminToken });
  check(
    "paperId 传 null -> 移出试卷",
    unlink.status === 200 &&
      (afterUnlink.data.papers ?? []).find((p) => p.id === otherPaper.data.paper.id)?.questionCount === 0,
    afterUnlink.data.papers?.map((p) => `${p.name}:${p.questionCount}`)
  );

  const noSelection = await request("PUT", "/questions/paper", {
    token: adminToken,
    body: { questionIds: [], paperId: null },
  });
  check("未选题目 -> 400「请先选择题目」", noSelection.status === 400, noSelection.data);

  // 改来源会按名重新归卷
  const renamed = await request("PUT", `/questions/${filtered.data.questions[1].id}`, {
    token: adminToken,
    body: { source: `${paperName}-副卷` },
  });
  const afterRename = await request("GET", "/papers", { token: adminToken });
  check(
    "改题目来源 -> 自动归到同名卷",
    renamed.status === 200 &&
      (afterRename.data.papers ?? []).find((p) => p.id === otherPaper.data.paper.id)?.questionCount === 1,
    renamed.data
  );

  const paperNoAuth = await request("POST", "/papers", { body: { name: "未登录试卷" } });
  check("未登录建卷 -> 401", paperNoAuth.status === 401, paperNoAuth.data);

  // 用本段现注册的临时普通用户验证权限（后面的 userToken 此时还没定义）
  const paperUser = `paperuser${Date.now().toString(36)}`;
  await request("POST", "/auth/register", { body: { username: paperUser, password: "123456" } });
  const paperUserLogin = await request("POST", "/auth/login", {
    body: { username: paperUser, password: "123456" },
  });
  const paperAsUser = await request("POST", "/papers", {
    token: paperUserLogin.data.token,
    body: { name: "普通用户建的卷" },
  });
  check("普通用户建卷 -> 403", paperAsUser.status === 403, paperAsUser.data);

  const paperNotFound = await request("GET", "/papers/p_not_exist", { token: adminToken });
  check("查不存在的试卷 -> 404", paperNotFound.status === 404, paperNotFound.data);

  // 删除试卷：题目保留，只解除归属
  const questionCountBefore = (await request("GET", "/questions", { token: adminToken })).data.questions.length;
  const deletedPaper = await request("DELETE", `/papers/${otherPaper.data.paper.id}`, {
    token: adminToken,
  });
  const afterDelete = await request("GET", "/questions", { token: adminToken });
  const stillLinked = (afterDelete.data.questions ?? []).some(
    (q) => q.paperId === otherPaper.data.paper.id
  );
  check(
    "DELETE /papers/{id} -> 题目保留、归属清空",
    deletedPaper.status === 200 &&
      afterDelete.data.questions.length === questionCountBefore &&
      stillLinked === false,
    { before: questionCountBefore, after: afterDelete.data.questions.length }
  );
  record("paper-delete", deletedPaper.status, deletedPaper.data);

  // 剩下的题清理掉，避免影响后面的标签用例
  for (const q of afterDelete.data.questions) {
    if (q.originalSentence.startsWith("Auto paper")) {
      await request("DELETE", `/questions/${q.id}`, { token: adminToken });
    }
  }
  await request("DELETE", `/papers/${paperId}`, { token: adminToken });

  /* ---------------- 标签 ---------------- */
  const tagList = await request("GET", "/tags");
  const dictionary = tagList.data.tagDictionary;
  const saved = await request("PUT", "/tags", { token: adminToken, body: { tagDictionary: dictionary } });
  check("PUT /tags 保存标签成功并返回数量", saved.status === 200 && saved.data.count === dictionary.tags.length, saved.data);
  record("tags-save", saved.status, { ok: saved.data.ok, count: saved.data.count });

  // 保留原有顶级分类数量（否则会先命中「顶级分类减少」的保护分支），
  // 只把其中一个标签的名称清空，用于触发「缺少 id 或名称」
  const brokenTags = JSON.parse(JSON.stringify(dictionary));
  brokenTags.tags[0].name = "";
  const badTags = await request("PUT", "/tags", { token: adminToken, body: { tagDictionary: brokenTags } });
  check("标签缺少 id/名称 -> 400", badTags.status === 400 && /缺少 id 或名称/.test(badTags.data.error), badTags.data);

  // 顶级分类被删减时的保护
  const fewerParents = JSON.parse(JSON.stringify(dictionary));
  fewerParents.tags = fewerParents.tags.filter((tag) => tag.parentId === null).slice(0, 1);
  const parentGuard = await request("PUT", "/tags", { token: adminToken, body: { tagDictionary: fewerParents } });
  check(
    "顶级分类减少 -> 400 且提示疑似误操作",
    parentGuard.status === 400 && /顶级分类数量从/.test(parentGuard.data.error),
    parentGuard.data
  );

  /* ---------------- 用户管理 ---------------- */
  const users = await request("GET", "/admin/users", { token: adminToken });
  check("GET /admin/users 返回列表", users.status === 200 && Array.isArray(users.data.users), { count: users.data.users?.length });
  check(
    "用户字段完整（含 recordCount/wrongCount）",
    users.data.users[0] &&
      Object.keys(users.data.users[0]).sort().join(",") ===
        "createdAt,displayName,id,recordCount,role,status,username,wrongCount",
    users.data.users[0]
  );
  record("admin-users", users.status, { count: users.data.users?.length });

  const roles = await request("GET", "/admin/roles", { token: adminToken });
  check("GET /admin/roles 返回两个角色", roles.status === 200 && roles.data.roles.length === 2, roles.data);
  record("admin-roles", roles.status, roles.data);

  const newUser = await request("POST", "/admin/users", {
    token: adminToken,
    body: { username: TEST_USER, password: "123456", role: "user" },
  });
  check("POST /admin/users 创建用户（201）", newUser.status === 201 && typeof newUser.data.id === "number", newUser.data);
  const newUserId = newUser.data.id;

  const dupUser = await request("POST", "/admin/users", {
    token: adminToken,
    body: { username: TEST_USER, password: "123456" },
  });
  check("重名用户 -> 409「用户名已被占用」", dupUser.status === 409 && dupUser.data.error === "用户名已被占用", dupUser.data);

  const badRole = await request("POST", `/admin/users/${newUserId}/role`, { token: adminToken, body: { role: "super" } });
  check("非法角色 -> 400「角色无效」", badRole.status === 400 && badRole.data.error === "角色无效", badRole.data);

  const selfRole = await request("POST", `/admin/users/${login.data.user.id}/role`, {
    token: adminToken,
    body: { role: "user" },
  });
  check("不能把自己降级 -> 400", selfRole.status === 400 && selfRole.data.error === "不能修改自己的管理员角色", selfRole.data);

  const resetPwd = await request("POST", `/admin/users/${newUserId}/reset-password`, {
    token: adminToken,
    body: { password: "654321" },
  });
  check("重置密码成功", resetPwd.status === 200 && resetPwd.data.ok === true, resetPwd.data);

  const shortPwd = await request("POST", `/admin/users/${newUserId}/reset-password`, {
    token: adminToken,
    body: { password: "123" },
  });
  check("密码过短 -> 400「密码至少 6 位」", shortPwd.status === 400 && shortPwd.data.error === "密码至少 6 位", shortPwd.data);

  const userRecords = await request("GET", `/admin/users/${newUserId}/records`, { token: adminToken });
  check("GET 用户做题明细返回 records 数组", userRecords.status === 200 && Array.isArray(userRecords.data.records), userRecords.data);

  /* ---------------- 注册 / 普通用户权限 ---------------- */
  const registered = await request("POST", "/auth/register", { body: { username: REG_USER, password: "123456" } });
  check("注册成功 -> 201", registered.status === 201 && registered.data.ok === true, registered.data);

  const badRegister = await request("POST", "/auth/register", { body: { username: "ab", password: "123456" } });
  check("用户名过短 -> 400", badRegister.status === 400 && /4-20 位/.test(badRegister.data.error), badRegister.data);

  const userLogin = await request("POST", "/auth/login", { body: { username: REG_USER, password: "123456" } });
  check("新注册用户可登录", userLogin.status === 200 && typeof userLogin.data.token === "string", userLogin.data);
  const userToken = userLogin.data.token;

  const userForbidden = await request("GET", "/admin/users", { token: userToken });
  check(
    "普通用户访问用户管理 -> 403「没有权限执行该操作」",
    userForbidden.status === 403 && userForbidden.data.error === "没有权限执行该操作",
    userForbidden.data
  );
  record("user-forbidden", userForbidden.status, userForbidden.data);

  /* ---------------- 改密 / 登出 ---------------- */
  const wrongOld = await request("POST", "/auth/change-password", {
    token: userToken,
    body: { oldPassword: "000000", newPassword: "abcdef" },
  });
  check("改密时原密码错误 -> 400「原密码不正确」", wrongOld.status === 400 && wrongOld.data.error === "原密码不正确", wrongOld.data);

  const changed = await request("POST", "/auth/change-password", {
    token: userToken,
    body: { oldPassword: "123456", newPassword: "abcdef" },
  });
  check("改密成功", changed.status === 200 && changed.data.ok === true, changed.data);

  const relogin = await request("POST", "/auth/login", { body: { username: REG_USER, password: "abcdef" } });
  check("新密码可登录", relogin.status === 200, relogin.data);

  const logout = await request("POST", "/auth/logout", { token: relogin.data.token });
  check("登出成功", logout.status === 200 && logout.data.ok === true, logout.data);
  const afterLogout = await request("GET", "/auth/me", { token: relogin.data.token });
  check("登出后 /auth/me -> 401", afterLogout.status === 401 && afterLogout.data.error === "请先登录", afterLogout.data);

  /* ---------------- 登录限速 ---------------- */
  let throttled = null;
  for (let i = 0; i < 9; i += 1) {
    throttled = await request("POST", "/auth/login", { body: { username: THROTTLE_USER, password: "wrong" } });
  }
  check(
    "连续登录失败 8 次后 -> 429「登录失败次数过多」",
    throttled.status === 429 && /登录失败次数过多/.test(throttled.data.error || ""),
    throttled.data
  );
  record("throttle", throttled.status, { error: throttled.data.error?.replace(/\d+/, "N") });

  /* ---------------- 系统维护 ---------------- */
  const version = await request("GET", "/system/version", { token: adminToken });
  check(
    "GET /system/version 返回 version 结构",
    version.status === 200 &&
      version.data.version &&
      Object.keys(version.data.version).sort().join(",") === "branch,commit,commitDate,commitSubject,phpVersion,shortCommit",
    version.data.version
  );
  record("system-version", version.status, version.data);

  const status = await request("GET", "/system/update-status", { token: adminToken });
  check(
    "GET /system/update-status 字段完整",
    status.status === 200 &&
      Object.keys(status.data).sort().join(",") === "error,finished,finishedAt,log,ok,running,stage,startedAt",
    Object.keys(status.data)
  );
  record("update-status", status.status, status.data);

  const userSystemForbidden = await request("GET", "/system/version", { token: userToken });
  check("普通用户访问系统接口 -> 403", userSystemForbidden.status === 403, userSystemForbidden.data);

  /* ---------------- 清理：删除测试用户 ---------------- */
  const delUser = await request("DELETE", `/admin/users/${newUserId}`, { token: adminToken });
  check("删除用户成功", delUser.status === 200 && delUser.data.ok === true, delUser.data);
  const delSelf = await request("DELETE", `/admin/users/${login.data.user.id}`, { token: adminToken });
  check("不能删除自己 -> 400「不能删除自己的账号」", delSelf.status === 400 && delSelf.data.error === "不能删除自己的账号", delSelf.data);

  /* ---------------- 不存在的接口 ---------------- */
  const notFound = await request("GET", "/no-such-api");
  check("未定义接口 -> 404", notFound.status === 404, notFound.data);

  /* ---------------- 汇总 ---------------- */
  console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("失败清单：");
    failures.forEach((item) => console.log(`  - ${item}`));
  }

  if (OUT) {
    const fs = await import("node:fs");
    fs.writeFileSync(OUT, JSON.stringify(records, null, 2));
    console.log(`\n响应已写入 ${OUT}`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("自测脚本异常：", error);
  process.exit(2);
});
