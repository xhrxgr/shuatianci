/**
 * AI 助手标签页（对应 src/components/AiAssistant.tsx）。
 *
 * 前端从 React 改为「PHP 服务端渲染 + 原生 JS」后，本文件承担原组件的全部交互：
 * - 生成「复制给 AI 的提示词」并按需复制（内容与原版 buildPrompt 逐字一致）
 * - 解析粘贴回来的 JSON、查出字典里没有的标签、校验后增量入库
 *
 * 与主脚本（assets/js/admin.js）的接口约定：
 *   window.setupAdminAi({ tagDictionary, onAppend, onCreateTags, onNotice })
 *   - tagDictionary：{ schemaVersion, tags: [{ id, name, parentId, color, isActive }] }
 *   - onAppend(questions, source)：把校验通过的题目批量入库（返回 Promise）
 *   - onCreateTags(names)：创建字典里没有的新标签
 *   - onNotice(message)：在页面顶部显示一条提示
 *
 * 原版把「成功导入 / 已创建标签 / 复制失败」这类提示放在组件内部的 notice 状态里，
 * 迁移后统一交给页面顶部的 onNotice（与 Admin 页其它标签页的提示同一处），
 * 因此本文件不再自渲染提示条。
 *
 * 动态文本一律先经 escapeHtml 再写入 DOM。
 */

/** 全部合法的提示词类型（与 src/types/index.ts 的 HintType 一致） */
const HINT_TYPES = ["给动词", "给名词", "给形容词", "给副词", "无提示词"];

/** 空格占位符字面量（与 src/utils/validate.ts 一致） */
const BLANK_PLACEHOLDER = "______";

/**
 * 规范化原句占位符（与 admin.js 的同名函数一致）：
 * 全角下划线、中文破折号、3+ 连续下划线都统一成标准 "______"，
 * 避免 AI 返回或粘贴内容里的字符差异导致校验误报。
 */
function normalizeSentence(text) {
  return String(text)
    .replace(/＿/g, "_")
    .replace(/[—–]{2,}/g, BLANK_PLACEHOLDER)
    .replace(/_{3,}/g, BLANK_PLACEHOLDER);
}

/** HTML 转义：所有动态文本都要经过它 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 生成给外部 AI 用的提示词。
 *
 * 适用场景：把一整段真题（可能连着多道题、带题号 56~65）
 * 连同卷子封面一起发给 AI，由 AI 按句切分成独立题目。
 *
 * 注意：本函数的返回值必须与 src/components/AiAssistant.tsx 的 buildPrompt
 * 逐字一致——这段文本直接决定 AI 返回的 JSON 能否被解析。
 */
function buildPrompt(tagDictionary) {
  const activeTags = tagDictionary.tags.filter((tag) => tag.isActive);

  return `你是一位熟悉高考英语命题规律的特级教师。我会把试卷的封面图和题目页图片一起发给你，需要你把题目拆解成结构化的 JSON，用于我的题库系统。

## 数据结构定义

Blank（一个空格）：

interface Blank {
  blankIndex: number;      // 本句内第几个空，从 1 开始，连续递增
  answer: string[];        // 可接受的答案集合，学生答对任意一个即算对
  hintWord: string | null; // 提示词原文；该空无提示词时必须是 null
  hintType: "${HINT_TYPES.join('" | "')}";   // 提示词类型
  tagIds: string[];        // 关联的知识点标签 id，必须取自下方标签清单
  trapAnalysis: string;    // 命题意图与判断依据，说清要点即可，不要求凑字数
}

Question（一道题，即一个句子）：

interface Question {
  id: string;                 // 唯一 id，形如 q_0001
  originalSentence: string;   // 该句原文，空格用 6 个下划线 ______ 表示
  blanks: Blank[];
  source: string;             // 试卷来源
}

## 可用标签清单（tagIds 只能从中选择）

${activeTags.map((tag) => `- ${tag.id} ${tag.name}`).join("\n")}

## 核心要求：按句切分，但不能删掉答题依据

### 最重要的原则
**切分的唯一标准是：保留能让学生做出这道题的全部信息。**

- 如果一个空的答案能从本句直接推出，这一空所在的句子可以独立成题。
- 如果答案需要看前后文才能确定，**必须把相关的句子一起带上**，宁可多带一句，
  也绝不能因为切分导致学生看不到依据。
- 上下文宁多勿少。学生因为看不到线索而做错，比多做一遍上下文题更糟糕。

### 切分规则
1. **默认以句号（. ? !）为准**，一个句子对应一条 Question。
2. **一句话里有几个空，就在这条 Question 里放几个空**，不要把一句话拆成多道题。
   同一句话的空必须连在一起，学生要在一个语境里把它们都填出来。
3. 遇到下列情况时，**向上合并相邻句子**，把线索带进来：
   - 空格在句末，而答案线索在下一句
   - 空格需要靠前文的指代、定义、同位语才能确定
   - 一句话太短（如 "stands ______ one of China's most..."），脱离上下文做不出来
4. 反过来，如果某句是纯粹的背景铺垫、不含任何空，也不需要为它单独输出一条。
   **没有空的句子不要单独作为一道题输出。**
5. blanks 数组只包含**这条 Question 内的空**，句中几个就写几个。
6. 题号（如 56、57）只是标记题序，**不要写进 originalSentence**。

判断标准很简单：**把你输出的这句话单独拿出来给学生看，他能做对吗？** 能，就独立成题；不能，就带上必要的上下文。

## 空格与提示词的写法（严格遵守）

排版上，有提示词的空和没有提示词的空**长得很不一样**：

- **有提示词**：空格后面紧跟括号，括号里是提示词原文
  例如：\`Hongshan Culture is ______ (unique) characterized by\`
  → hintWord 填 "unique"，hintType 填"给形容词"或对应的类型

- **无提示词**：光一个空格，后面什么都没有
  例如：\`flourishing roughly from 4700 to 2900 BCE in ______ is now\`
  → hintWord 必须是 null，hintType 填"无提示词"

所以：
- 句子里空后面**有括号**，hintWord 就填括号里的内容
- 句子里空后面**没有括号**，hintWord 必须是 null，不要自己编一个提示词出来
- 括号里的提示词要照抄，包括中文标注（如「礼仪器」的 \`(ritual (礼仪器))\` 要完整保留）

## 输出要求

1. 只输出一个 JSON 数组，不要输出任何解释文字，不要用 markdown 代码块包裹。
2. 每道题都要写 trapAnalysis，说清两件事即可：命题人为什么这么设计、正确的判断依据是什么。
   只写正确的形式与依据，不要把错误的写法或错误选项列出来（展示错误形式会误导学生）。
   写具体、写到点子上即可，不要为凑字数重复或编造内容。
3. originalSentence 中的空格数量必须与 blanks 数组长度严格相等。
4. blanks[].blankIndex 从 1 开始连续递增，与句中空格的出现顺序一一对应。
5. answer 只收录结构上真正成立的答案，不要塞入冗余或凑数选项。
   每个词按标准拼写和大小写书写。
6. 注意原文中还有中文注释（如"新石器""礼仪器"），这些是原卷的一部分，**原样保留在 originalSentence 里**。

## source 字段怎么填

如果我提供的封面图里能看出卷子信息（学校、学期、考试名称、日期、题型），
就填成完整来源，例如：
"某某中学2026-2027学年高三上学期10月阶段检测试题"
"2024年全国甲卷·语法填空"

如果封面看不清或我没提供封面，填 "AI 生成"，我会在网页上手动改。

## 词形转换必须逐词核实（重要）

tagIds 的判定规则已经按类别分好标签，**不要凭语感随意归类**。以下规则必须严格遵守：

- 形容词变副词，先判断后缀再下结论：
  - 一般情况直接加 ly：quick → quickly
  - 以 -ic 结尾：把 ic 替换为 ically，即"ic 变 ally"型（标签「形容词变副词-ic变ally」）。
    例：energetic → energetically、basic → basically、tragic → tragically。
    注意 public 是例外，变 publicly。
  - 以 -le 结尾：去 e 加 y（标签「形容词变副词-le变ly」）。例：simple → simply。
  - 以 -y 结尾且 y 前为辅音：y 变 i 加 ly（标签「形容词变副词-y变ily」）。例：happy → happily。
  - 只有真正「直接加 ly」才用「形容词变副词-直接加ly」标签。
- 名词变形容词与形容词变名词要注意方向，选对标签。
- trapAnalysis 里如果写了某个词形变化，必须与实际拼写一致；
  写错规则的解析比不写更糟——会直接教坏学生。
- 如果你对某个词的变形没有把握，就在该空的 trapAnalysis 里写明存在多种可能，
  而不是编造一条看似合理的规则。

## 示例输出格式

假设试卷上有这样一段：

  "Among the foundational cornerstones of early Chinese civilization, Hongshan Culture holds a place of
   profound significance. Hongshan Culture, flourishing roughly from 4700 to 2900 BCE in 56 is now
   Liaoning Province and neighboring regions, stands 57 one of China's most remarkable Neolithic (新石器)
   cultures."

应该输出**两条**：

[
  {
    "id": "q_0001",
    "originalSentence": "Hongshan Culture, flourishing roughly from 4700 to 2900 BCE in ______ is now Liaoning Province and neighboring regions, stands ______ one of China's most remarkable Neolithic (新石器) cultures.",
    "blanks": [
      {
        "blankIndex": 1,
        "answer": ["Liaoning"],
        "hintWord": null,
        "hintType": "无提示词",
        "tagIds": ["t_002", "t_013"],
        "trapAnalysis": "空格作 in 的宾语，填红山文化遗址所在省份。后文 is now Liaoning Province 给出提示，考查地理常识与 archaeological site 的对应。"
      },
      {
        "blankIndex": 2,
        "answer": ["as"],
        "hintWord": null,
        "hintType": "无提示词",
        "tagIds": ["t_005", "t_029"],
        "trapAnalysis": "空格与后文 one of 构成 as one of the most... 固定结构，as 在此作介词，与 one of 搭配使用。"
      }
    ],
    "source": "AI 生成"
  },
  {
    "id": "q_0002",
    "originalSentence": "The most famous site, Niuheliang, ______ (feature) a magnificent temple and rubble-mound stone tombs.",
    "blanks": [
      {
        "blankIndex": 1,
        "answer": ["features"],
        "hintWord": "feature",
        "hintType": "给动词",
        "tagIds": ["t_001", "t_012"],
        "trapAnalysis": "空格作主句谓语，主语 Niuheliang 是第三人称单数，故用 features。后文 a temple 是宾语，说明主语主动发掘出该遗址，用主动语态。"
      }
    ],
    "source": "AI 生成"
  }
]

注意示例中：
- **第 1 条里的两个空在同一句话里，就放在一起**，学生要在一个语境里同时填出来，
  没有拆成两道题
- 句子前面的 "Among the foundational cornerstones of early Chinese civilization, Hongshan Culture
  holds a place of profound significance." 这句没有空，**不单独输出成一道题**，
  它只是背景铺垫
- 第 2 条是一个独立的句子（有自己的主语谓语宾语），能单独做出来，所以单独成题
- 两个空后面都没有括号，所以 hintWord 都是 null
- 原文的中文注释「(新石器)」原样保留了
- 题号 56、57 没有出现在任何字段里

## 需要拆解的内容

（把封面图和题目页图片一起发给我即可）`;
}

/** 把标签 id 或标签名解析成字典中的标签对象 */
function resolveTag(tagDictionary, raw) {
  const key = raw.trim();
  if (!key) return null;
  return (
    tagDictionary.tags.find((tag) => tag.id === key) ??
    tagDictionary.tags.find((tag) => tag.name === key) ??
    null
  );
}

/** 去掉可能存在的 markdown 代码块包裹 */
function cleanJson(text) {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

/** 取每段文本里占位符的起始下标（迁移自 src/utils/validate.ts） */
function findPlaceholderPositions(sentence) {
  const positions = [];
  const step = BLANK_PLACEHOLDER.length;
  let from = 0;
  for (;;) {
    const index = sentence.indexOf(BLANK_PLACEHOLDER, from);
    if (index === -1) break;
    positions.push(index);
    from = index + step;
  }
  return positions;
}

/** 校验一道题目是否合法（迁移自 src/utils/validate.ts 的 validateQuestion） */
function validateQuestion(question, tagDictionary, existingIds = []) {
  const errors = [];
  const sentence = typeof question.originalSentence === "string" ? question.originalSentence : "";

  // 1. 原句至少有一个空格
  const positions = findPlaceholderPositions(sentence);
  if (positions.length < 1) {
    errors.push(`原句必须包含至少一个 "${BLANK_PLACEHOLDER}" 空格`);
  }

  // 2. 空格数量与 blanks 数量一致
  if (positions.length !== question.blanks.length) {
    errors.push(
      `原句中的空格数量(${positions.length})与 blanks 数量(${question.blanks.length})不一致`
    );
  }

  // 3. blankIndex 必须从 1 开始且连续递增，用于精确定位第 N 个空格
  question.blanks.forEach((blank, index) => {
    if (blank.blankIndex !== index + 1) {
      errors.push(
        `第 ${index + 1} 个空的 blankIndex 应为 ${index + 1}，实际为 ${blank.blankIndex}（需从 1 开始连续递增）`
      );
    }
  });

  // 4. 逐个空校验
  question.blanks.forEach((blank, index) => {
    const label = `第 ${index + 1} 个空`;

    if (!Array.isArray(blank.answer) || blank.answer.length === 0) {
      errors.push(`${label}: answer 数组不能为空`);
    } else {
      blank.answer.forEach((ans, ansIndex) => {
        if (typeof ans !== "string" || ans.trim() === "") {
          errors.push(`${label}: answer[${ansIndex}] 不能为空字符串`);
        }
      });

      // 答案去重：与判卷口径一致，只忽略首尾空格，保留大小写差异
      // （Written 与 written 属于不同答案，不能合并）
      const normalized = blank.answer.map((ans) => ans.trim());
      const unique = new Set(normalized);
      if (unique.size !== normalized.length) {
        errors.push(`${label}: answer 存在完全重复的项`);
      }
    }

    if (!HINT_TYPES.includes(blank.hintType)) {
      errors.push(`${label}: hintType 必须是 ${HINT_TYPES.join(" / ")} 之一`);
    }

    if (blank.hintType !== "无提示词" && (blank.hintWord === null || blank.hintWord.trim() === "")) {
      errors.push(`${label}: hintType 为「${blank.hintType}」时 hintWord 不能为空`);
    }

    if (blank.hintType === "无提示词" && blank.hintWord !== null && blank.hintWord.trim() !== "") {
      errors.push(`${label}: hintType 为「无提示词」时 hintWord 应为 null`);
    }

    const tagMap = new Map(tagDictionary.tags.map((tag) => [tag.id, tag]));
    (blank.tagIds ?? []).forEach((tagId) => {
      const tag = tagMap.get(tagId);
      if (!tag) {
        errors.push(`${label}: 标签 ${tagId} 在标签字典中不存在`);
      } else if (!tag.isActive) {
        errors.push(`${label}: 标签 ${tagId}(${tag.name}) 已停用`);
      }
    });

    // 解析只要求非空：内容质量靠人工复核，不做字数下限，
    // 免得为了凑字数写废话或编造内容
    if ((blank.trapAnalysis ?? "").trim() === "") {
      errors.push(`${label}: trapAnalysis 不能为空`);
    }
  });

  // 5. id 查重
  if (existingIds.includes(question.id)) {
    errors.push(`题目 id 重复: ${question.id}`);
  }

  return { isValid: errors.length === 0, errors };
}

/** 批量校验，逐条收集全部错误（迁移自 src/utils/validate.ts 的 validateQuestions） */
function validateQuestions(questions, tagDictionary) {
  const existingIds = [];
  const results = [];
  const validIndexes = [];
  const allErrors = [];

  questions.forEach((question, index) => {
    const result = validateQuestion(question, tagDictionary, existingIds);
    results.push(result);
    if (result.isValid) {
      validIndexes.push(index);
      existingIds.push(question.id);
    } else {
      result.errors.forEach((error) => allErrors.push(`第 ${index + 1} 条: ${error}`));
    }
  });

  return { results, validIndexes, allErrors };
}

/* ------------------------------------------------------------------ */
/* 组件状态（对应 React 的 useState）与 DOM 引用                        */
/* ------------------------------------------------------------------ */

/** 标签字典，由 setupAiAssistant 注入；主脚本刷新字典后可再次调用以更新 */
let dictionary = { schemaVersion: 1, tags: [] };

/** 主脚本回调（每次 setup 用最新传入值覆盖） */
let hooks = {
  onAppend: () => {},
  onCreateTags: () => {},
  onNotice: () => {},
};

/** 页面元素引用 */
let els = null;

/** 是否已绑定事件（setup 可能被主脚本多次调用，避免重复绑定） */
let bound = false;

let copyTimer = null;
/** 待确认创建的标签 */
let pending = null;
/** 当前解析出的、字典里没有的标签 */
let missingTags = [];
/** 解析中标志，防止连点重复入库 */
let submitting = false;
/** 是否刚复制过提示词 */
let copied = false;

function activeTagCount() {
  return dictionary.tags.filter((tag) => tag.isActive).length;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/** 复制按钮文案（对应原版 {copied ? "已复制，去问 AI 吧" : "复制提示词"}） */
function renderCopyButton() {
  if (els.copyBtn) els.copyBtn.textContent = copied ? "已复制，去问 AI 吧" : "复制提示词";
}

/** 「字典里没有的标签」提示块 */
function renderMissing() {
  if (!els.missing) return;
  els.missing.hidden = missingTags.length === 0;
  if (els.missingList) {
    els.missingList.innerHTML = missingTags
      .map((tag) => `<span class="ml-1 rounded bg-warning/20 px-1.5 py-0.5">${escapeHtml(tag)}</span>`)
      .join("");
  }
}

/** 校验错误块（原版按 "\n" 拆成多行 li） */
function renderError(message) {
  if (!els.error) return;
  els.error.hidden = false;
  els.error.innerHTML = message
    .split("\n")
    .map((line) => `<li>· ${escapeHtml(line)}</li>`)
    .join("");
}

/** 清掉错误块（对应原版 setParseError("")） */
function clearError() {
  if (!els.error) return;
  els.error.hidden = true;
  els.error.innerHTML = "";
}

/** 提交按钮文案与禁用态（对应原版 {submitting ? "导入中..." : "解析并入库"}） */
function renderSubmitting() {
  if (!els.submitBtn) return;
  els.submitBtn.textContent = submitting ? "导入中..." : "解析并入库";
  els.submitBtn.disabled = submitting;
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

/** 复制提示词到剪贴板，不展示内容 */
async function handleCopy() {
  const promptText = buildPrompt(dictionary);
  try {
    await navigator.clipboard.writeText(promptText);
    copied = true;
    renderCopyButton();
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied = false;
      copyTimer = null;
      renderCopyButton();
    }, 2000);
  } catch {
    // 剪贴板不可用时（缺少 HTTPS 等），给出可手动复制的降级方案
    hooks.onNotice("当前环境不支持一键复制，请用「手动复制提示词」按钮在弹窗中选取。");
    window.prompt("请手动复制以下提示词：", promptText);
  }
}

/** 「手动复制」：在弹窗中选取（与 navigator.clipboard 不可用时的降级入口一致） */
function handleManualCopy() {
  window.prompt("请手动复制以下提示词：", buildPrompt(dictionary));
}

/** 解析粘贴进来的 JSON 并校验 */
async function handleParse() {
  if (submitting) return;

  clearError();
  missingTags = [];
  renderMissing();

  if (els.textarea.value.trim() === "") {
    renderError("请先粘贴 AI 返回的 JSON。");
    return;
  }

  submitting = true;
  renderSubmitting();
  try {
    parseAndImport();
  } finally {
    submitting = false;
    renderSubmitting();
  }
}

/** 实际解析与导入流程 */
function parseAndImport() {
  let parsed;
  try {
    parsed = JSON.parse(cleanJson(els.textarea.value));
  } catch (error) {
    renderError(`JSON 格式错误：${error.message}`);
    return;
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];

  // 先规范化每题原句的占位符（全角下划线 / 中文破折号 / 数量不为 6），
  // 保证后续校验与入库都使用标准格式
  list.forEach((question) => {
    if (question && typeof question.originalSentence === "string") {
      question.originalSentence = normalizeSentence(question.originalSentence);
    }
  });

  // 找出字典里不存在的标签，交给用户确认是否创建
  const unknown = new Set();
  list.forEach((question) => {
    question.blanks?.forEach((blank) => {
      (blank.tagIds ?? []).forEach((tagId) => {
        if (!resolveTag(dictionary, tagId)) unknown.add(tagId);
      });
    });
  });

  if (unknown.size > 0) {
    missingTags = [...unknown];
    renderMissing();
    pending = list;
    return;
  }

  runImport(list);
}

/** 正式校验并增量入库 */
function runImport(list) {
  const { allErrors } = validateQuestions(list, dictionary);

  if (allErrors.length > 0) {
    renderError(`校验未通过，共 ${allErrors.length} 处问题，本次未导入：`);
    pending = list;
    return;
  }

  // 统一打上来源：优先用户在页面上填的
  const finalSource = els.source.value.trim();
  const stamped = list.map((question) => ({
    ...question,
    source: finalSource || question.source || "AI 生成",
    status: "unmastered",
    wrongCount: 0,
    createdAt: new Date().toISOString(),
  }));

  hooks.onAppend(stamped, finalSource);
  hooks.onNotice(`成功导入 ${stamped.length} 道题目${finalSource ? `，来源：${finalSource}` : ""}`);
  els.textarea.value = "";
  pending = null;
}

/**
 * 确认创建新标签。
 * 新标签由主脚本写入字典，用户再点一次「解析并入库」即可按新标签校验。
 */
function handleCreateMissing() {
  if (!pending) return;
  // 先取出名字：原版 setMissingTags([]) 是异步的，这里要保留同一份用于提示文案
  const names = missingTags.slice();
  hooks.onCreateTags(names);
  missingTags = [];
  renderMissing();
  pending = null;
  hooks.onNotice(`已创建标签：${names.join("、")}。请再次点击「解析并入库」，本次将按新标签校验。`);
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 挂载 AI 助手标签页。主脚本在合适的时机调用（骨架已由 PHP 直出）。
 *
 * @param {object}   options
 * @param {object}   options.tagDictionary
 * @param {Function} options.onAppend
 * @param {Function} options.onCreateTags
 * @param {Function} options.onNotice
 */
export function setupAiAssistant({ tagDictionary, onAppend, onCreateTags, onNotice }) {
  const root = document.getElementById("admin-ai-root");
  if (!root) return;

  if (tagDictionary) dictionary = tagDictionary;
  hooks = {
    onAppend: typeof onAppend === "function" ? onAppend : hooks.onAppend,
    onCreateTags: typeof onCreateTags === "function" ? onCreateTags : hooks.onCreateTags,
    onNotice: typeof onNotice === "function" ? onNotice : hooks.onNotice,
  };

  els = {
    root,
    count: root.querySelector("[data-tag-count]"),
    copyBtn: document.getElementById("admin-ai-copy"),
    manualBtn: document.getElementById("admin-ai-manual-copy"),
    source: document.getElementById("ai-source"),
    textarea: document.getElementById("admin-ai-json"),
    missing: document.getElementById("admin-ai-missing"),
    missingList: document.getElementById("admin-ai-missing-list"),
    createTagsBtn: document.getElementById("admin-ai-create-tags"),
    error: document.getElementById("admin-ai-error"),
    submitBtn: document.getElementById("admin-ai-submit"),
  };

  // 提示词里会带上「当前 N 个标签」，字典变化时同步刷新
  if (els.count) els.count.textContent = String(activeTagCount());

  if (!bound) {
    bound = true;
    els.copyBtn?.addEventListener("click", () => void handleCopy());
    els.manualBtn?.addEventListener("click", handleManualCopy);
    els.createTagsBtn?.addEventListener("click", handleCreateMissing);
    els.submitBtn?.addEventListener("click", () => void handleParse());
    window.addEventListener("beforeunload", () => {
      if (copyTimer !== null) window.clearTimeout(copyTimer);
    });
  }

  renderCopyButton();
  renderMissing();
  renderSubmitting();
}

window.setupAdminAi = setupAiAssistant;
