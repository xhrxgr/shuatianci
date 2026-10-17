/**
 * AI 导入页的**全部业务动作**：构建预览、复制提示词、解析、篇章共享、入库。
 *
 * 与 ai-render.js 的边界：这里决定「数据变成什么」，那里决定「数据长什么样」。
 * 本模块可以调渲染，反过来不行（保持单向，避免循环依赖）。
 *
 * 两条不能改的约定：
 *   - 查重一律走服务端 api.checkDuplicates：前端自己算指纹一旦与后端漂移，
 *     就会出现「预览说已存在、入库却变成新增」；
 *   - hooks.onAppend 必须 await：它自己也会弹一条提示，不等会互相覆盖，
 *     用户永远看不到「跳过 N 道」。
 */

import { api } from "./api.js";
import { notifyError } from "./feedback.js";
import { IMPORTED_MARK } from "./ai-constants.js";
import { buildPrompt } from "./ai-prompt.js";
import {
  cleanJson, explainJsonError, parseJsonLoose, repairSentences, splitBatch,
} from "./ai-parse.js";
import { generateQuestionId, normalizeSentence, restorePassageBlanks } from "./ai-text.js";
import { resolveTag } from "./ai-tags.js";
import { validateQuestions } from "./ai-validate.js";
import { state, syncLastBuild } from "./ai-state.js";
import {
  clearError, renderCopyButton, renderError, renderMissing, renderPassagePanel,
  renderPreview, renderPreviewSummary, renderSubmitting,
} from "./ai-render.js";


/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

/** 复制提示词到剪贴板，不展示内容 */
export async function handleCopy() {
  const promptText = buildPrompt(state.dictionary);
  try {
    await navigator.clipboard.writeText(promptText);
    state.copied = true;
    renderCopyButton();
    if (state.copyTimer !== null) window.clearTimeout(state.copyTimer);
    state.copyTimer = window.setTimeout(() => {
      state.copied = false;
      state.copyTimer = null;
      renderCopyButton();
    }, 2000);
  } catch {
    // 剪贴板不可用时（缺少 HTTPS 等），给出可手动复制的降级方案
    state.hooks.onNotice("当前环境不支持一键复制，请用「手动复制提示词」按钮在弹窗中选取。");
    window.prompt("请手动复制以下提示词：", promptText);
  }
}

/** 「手动复制」：在弹窗中选取（与 navigator.clipboard 不可用时的降级入口一致） */
export function handleManualCopy() {
  window.prompt("请手动复制以下提示词：", buildPrompt(state.dictionary));
}

/** 解析粘贴进来的 JSON 并校验 */
export async function handleParse() {
  if (state.submitting) return;

  clearError();

  if (state.els.textarea.value.trim() === "") {
    renderError("请先粘贴 AI 返回的 JSON。");
    return;
  }

  state.submitting = true;
  renderSubmitting();
  try {
    // 粘贴后立刻点「确认导入」时，防抖的预览可能还没跑。
    // 这里补一次，保证「所见即所导」——导入的永远是与预览同一份数据，
    // 不做二次解析（二次解析在引号修复等路径上可能得到不同结果）。
    if (state.previewSourceText !== state.els.textarea.value || state.previewList.length === 0) {
      const built = await buildPreview();
      if (!built.ok) {
        // 构建没成功。JSON 坏 / 校验没过这两种，预览区已经写了原因；
        // 剩下一种没有提示（期间内容又变了一次，这次构建被更新的一次取代），
        // 补一句话，避免用户面对「点了没反应」干瞪眼
        if (state.els.error && state.els.error.hidden) {
          renderError("内容刚刚发生了变化，请确认预览后重新点一次「确认导入」。");
        }
        return;
      }
    }

    // 卷名预读同样挂在 400ms 防抖上（见 onPaste）。粘贴后立刻点导入时
    // 它还没跑，runImport 就会因为卷名框为空而报「请先填写试卷名」——
    // 用户视角是「JSON 里明明写了 source，却说我没填」。这里补读一次。
    // previewPaperName 只在「输入框空着或还是上次自动填的值」时才写入，
    // 用户自己改过的名字不会被冲掉
    previewPaperName();

    // 有字典里没有的标签时先停下来让用户确认创建，
    // 否则会带着未知 tagId 入库（服务端不校验 tagIds，会留下悬空引用）
    //
    // 必须同时给出文字提示：只显示上面的标签块，用户会以为「点了没反应」
    if (state.missingTags.length > 0) {
      renderMissing();
      renderError(
        `有 ${state.missingTags.length} 个标签不在字典里：${state.missingTags.join("、")}。` +
          "点上面的「创建这些标签」建好后再导一次。"
      );
      return;
    }

    await runImport(state.previewList, state.previewChecks);
  } finally {
    state.submitting = false;
    renderSubmitting();
  }
}

/**
 * 建一篇篇章并把本批所有题指向它。
 *
 * 为什么是建表而不是把文本塞进每题：一道大题 10 道小题共享一篇原文，
 * 塞进每题就要填 10 遍、改 10 遍；建成篇章只存一份，改一处全篇生效。
 */
export async function applyPassageToBatch() {
  const text = (state.els.passageText?.value ?? "").trim();
  if (text === "") {
    renderError("请先粘贴这篇阅读的完整原文");
    return;
  }
  if (state.previewList.length === 0) {
    renderError("先粘贴 AI 返回的 JSON，等预览出现后再套用原文");
    return;
  }
  state.els.passageApply.disabled = true;
  try {
    await sharePassageForBatch(text);
    clearError();
  } catch (error) {
    notifyError(error, { retry: () => void applyPassageToBatch() });
  } finally {
    state.els.passageApply.disabled = false;
  }
}

/**
 * 把一段原文建（或更新）成篇章，并让本批所有题指向它。
 *
 * 抽出来是为了让「按钮手动套用」与「解析后自动套用」走**同一条路径** ——
 * 两条路径各自实现一遍，迟早会出现「自动的漏了备份逻辑，清除时还原不回来」。
 *
 * @param {string} text 原文
 */
async function sharePassageForBatch(text) {
  // 已经建过就改它，不要每点一次建一篇（那会留下一堆空篇章）
  let passageId = state.previewPassageId;
  if (passageId) {
    await api.updatePassage(passageId, { text });
  } else {
    const created = await api.createPassage({ text });
    passageId = created.passage?.id ?? null;
    if (!passageId) throw new Error("建篇章失败");
  }
  state.previewPassageId = passageId;
  // 本批所有题统一指向这篇；各题自己的 passageText 先备份再清掉
  // （清是为了「两处各说各话」，但必须能还原 —— 见 clearPassageFromBatch）
  if (state.savedPassageTexts === null) {
    state.savedPassageTexts = state.previewList.map((q) => q.passageText ?? null);
  }
  state.previewList.forEach((question) => {
    question.passageId = passageId;
    question.passageText = null;
  });
  // 顶部面板的输入框同步成这份原文，用户改的就是它
  if (state.els.passageText) {
    state.els.passageText.value = text;
  }
  syncLastBuild();
  renderPassagePanel();
  renderPreview();
}

/**
 * 解析完 AI 结果后自动套用「本篇完整原文」。
 *
 * AI 的提示词里已明确要求：**整篇原文只放在这一篇 questions 数组的第一道题里**，
 * 其余每道省略 passage。理由很实在 —— 一篇 500 词的短文重复贴 10 遍，
 * 会把 JSON 从 60 行撑到 600 行：生成更慢、更费 token，还极易被长度限制截断。
 *
 * 但**不能只指望 AI 听话**：实测同一个模型、同一份提示词，AI 照样会把
 * 同一篇原文贴进 10 道题里（用户连续两次实测都这样）。所以这里做兜底，
 * 两种形态都自动合并：
 *
 *   1. **只有第一道题带 passage** —— 提示词生效时的形态；
 *   2. **每道题都带、且内容完全一致** —— AI 不听话时的形态。
 *      这一条是关键：不合并的话，10 道题就往库里塞 10 份一模一样的长文本。
 *
 * 只在「内容完全一致」时才合并。有的带有的不带、或内容有出入，一律不动 ——
 * 说不清哪份才是这篇的原文，自动猜反而可能把错的套上去。
 *
 * 失败**不阻断**：套用只是优化，失败就保留 AI 给的原样，导入照常进行。
 */
async function autoAdoptSharedPassage(list) {
  if (state.previewPassageId !== null) {
    return false;   // 已经套过了
  }
  if (!Array.isArray(list) || list.length < 2) {
    return false;   // 只有一道题谈不上「共享」
  }

  const texts = list.map((q) => (typeof q?.passageText === "string" ? q.passageText.trim() : ""));

  // 只有第一道题带 —— 提示词生效时的形态
  const onlyFirstHas = texts[0] !== "" && texts.slice(1).every((t) => t === "");
  // 每道题都带、且内容完全一致 —— AI 不听话时的形态，同样要合并
  const allSame =
    texts[0] !== "" && texts.every((t) => t === texts[0]);

  if (!onlyFirstHas && !allSame) {
    return false;   // 有的带有的不带、或内容有出入，不猜
  }

  try {
    await sharePassageForBatch(texts[0]);
    return true;
  } catch (error) {
    console.warn("[admin-ai] 自动套用本篇原文失败，保留原样继续导入", error);
    state.previewPassageId = null;
    return false;
  }
}

/** 清除共用原文：把本批所有题的篇章引用摘掉（不影响已导入的题） */
export function clearPassageFromBatch() {
  if (!state.previewPassageId) return;
  state.previewPassageId = null;
  // 还原套用前各题自带的原文：清空篇章不该顺手把 AI 给的原文也弄丢
  state.previewList.forEach((question, index) => {
    question.passageId = null;
    if (state.savedPassageTexts && index < state.savedPassageTexts.length) {
      question.passageText = state.savedPassageTexts[index];
    }
  });
  state.savedPassageTexts = null;
  syncLastBuild();
  renderPassagePanel();
  renderPreview();
}

/**
 * 解析、校验、查重、渲染预览。不写库。
 *
 * 返回 { ok, list } —— ok 为 false 表示这批题有阻塞性问题（JSON 坏了 / 校验没过），
 * 此时预览会展示问题，但不会导入。
 */
export function buildPreview() {
  const raw = state.els.textarea.value;

  // 同一段文本已经有构建在跑就复用它，不重复发请求、也不让两次构建互相判为过期
  if (state.previewInFlight !== null && state.previewInFlight.text === raw) {
    return state.previewInFlight.promise;
  }

  // 这段文本已经构建完成过：直接复用那一次的结果。
  // 防抖定时器在快速点击后才触发时走的就是这里（见 state.lastBuild 的注释）。
  // 命中时必须把**模块状态一并恢复**（state.previewList/state.previewChecks/… 都在
  // buildPreviewInner 里赋值）：导入成功后这些状态被清空过，
  // 只返回 list 会让预览区空白、点导入时提示「一道题都没勾选」——
  // 用户刚粘了有效 JSON，看到的却是这句
  if (state.lastBuild !== null && state.lastBuild.text === raw && state.lastBuild.ok) {
    state.previewList = [...state.lastBuild.list];
    state.previewVerdicts = [...state.lastBuild.verdicts];
    state.previewChecks = [...state.lastBuild.checks];
    state.pendingRepairs = [...state.lastBuild.repairs];
    state.missingTags = [...state.lastBuild.missingTags];
    state.previewPassageId = state.lastBuild.passageId ?? null;
    state.savedPassageTexts = state.lastBuild.savedPassageTexts ? [...state.lastBuild.savedPassageTexts] : null;
    state.previewSourceText = raw;
    renderMissing();
    renderPreview();
    return Promise.resolve({ ok: true, list: state.previewList });
  }

  const entry = { text: raw, promise: null };
  entry.promise = buildPreviewInner(raw)
    .then((result) => {
      // 无论 ok 与否都记住：ok=false 的那次重跑也只会得到同样的结论，
      // 不如直接复用（错误信息已经渲染在预览区了）。
      // 这里读的是 buildPreviewInner 刚刚赋好的模块级状态，所以一并快照下来
      state.lastBuild = {
        text: raw,
        ok: result.ok,
        list: result.list,
        verdicts: [...state.previewVerdicts],
        checks: [...state.previewChecks],
        repairs: [...state.pendingRepairs],
        missingTags: [...state.missingTags],
        // 篇章引用也要进快照：命中缓存时如果不恢复，面板状态会与实际数据不一致
        // （显示「已套用」而 previewPassageId 是 null，再点「重新套用」会改错篇章）
        passageId: state.previewPassageId,
        savedPassageTexts: state.savedPassageTexts === null ? null : [...state.savedPassageTexts],
      };
      return result;
    })
    .finally(() => {
      // 只清理自己这一条，避免把后来者的记录误删
      if (state.previewInFlight === entry) {
        state.previewInFlight = null;
      }
    });
  state.previewInFlight = entry;
  return entry.promise;
}

/** 预览构建的实际实现（参数化文本，便于在途合并按内容比对） */
async function buildPreviewInner(raw) {
  // 清空输入框是常态（比如刚导入完一批），这时不该弹「JSON 解析失败」
  if (raw.trim() === "") {
    clearPreview();
    clearError();
    return { ok: false, list: [] };
  }

  const cleaned = cleanJson(raw);
  const repairs = [];

  const result = parseJsonLoose(cleaned);
  if (result === null) {
    let message;
    try {
      JSON.parse(cleaned);
      message = "";
    } catch (error) {
      message = explainJsonError(cleaned, error, cleaned.split("\n"));
    }
    clearPreview();
    renderError(message);
    return { ok: false, list: [] };
  }
  if (result.repaired) {
    repairs.push("JSON 引号转义有误（多半是原句里的引号），已自动修复");
  }

  const batch = splitBatch(result.value);
  const list = batch.list;
  if (batch.perItem && batch.source) {
    repairs.push("source 写在每道题里，已取第一条作为本卷的试卷名");
  }

  const badIndex = list.findIndex(
    (item) => item === null || typeof item !== "object" || Array.isArray(item)
  );
  if (badIndex !== -1) {
    clearPreview();
    renderError(
      `第 ${badIndex + 1} 条不是题目对象。请确认粘贴的是一个 JSON 数组，且数组里每一项都是 { } 形式的对象。`
    );
    return { ok: false, list: [] };
  }

  repairs.push(...repairSentences(list));
  // passage 是**整篇共享**的：一篇文章挖 11 个空，passage 里就有 11 处挖空，
  // 而每道题只知道自己那一个空。所以还原时必须把**全批题的答案按顺序摊平**
  // 一起用 —— 只用当前题的答案，11 处里只能还原第 1 处，其余全部还原不了。
  // 摊平顺序 = 题目顺序 × 每题按 blankIndex 升序，与 passage 里空的出现顺序一致。
  const allAnswers = [];
  for (const q of list) {
    const sorted = (q?.blanks ?? [])
      .slice()
      .sort((a, b) => (a?.blankIndex ?? 0) - (b?.blankIndex ?? 0));
    for (const blank of sorted) {
      allAnswers.push(Array.isArray(blank?.answer) ? blank.answer[0] : blank?.answer);
    }
  }

  list.forEach((question) => {
    if (question && typeof question.originalSentence === "string") {
      question.originalSentence = normalizeSentence(question.originalSentence);
    }
    // 完整原文：AI 那边字段名叫 passage，题库与接口统一叫 passageText，
    // 这里归一一次，后面（预览、就地编辑、导入）就只用同一个名字。
    // 空串 / 全是空白 → null，表示「这道题没有原文」
    if (question) {
      const raw = question.passage ?? question.passageText ?? null;
      question.passageText = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      // AI 经常把 passage 也写成挖空版（______ (establish)）。
      // 那不是「未挖空的原文」—— 括号里就是答案，学生展开对照时等于直接看到答案。
      // 还原时**必须用答案**（established / stability / treasures）而不是括号里的
      // 提示词原形（establish / stable / treasure），否则会造出语法错误的原文，
      // 比留空格更糟。
      if (question.passageText) {
        const { text: fixed, restored, missed } = restorePassageBlanks(
          question.passageText,
          allAnswers
        );
        if (restored > 0) {
          question.passageText = fixed;
          repairs.push(
            `原文里的 ${restored} 处挖空已按答案还原（AI 把 passage 也写成了挖空版）`
          );
        }
        if (missed > 0) {
          repairs.push(
            `原文里有 ${missed} 处挖空没还原（本批答案不够），已按原样保留，请人工确认`
          );
        }
      }
    }
  });

  // 校验：有错就展示出来（保持原有的「整批不导」语义，避免半批入库）
  const { allErrors } = validateQuestions(list, state.dictionary);

  // 查重走服务端：指纹规则必须与入库时用的那份完全一致，
  // 前端自己算一旦与后端漂移，就会出现「预览说已存在、入库却变成新增」
  const seq = ++state.previewSeq;
  let verdicts = [];
  try {
    const res = await api.checkDuplicates(
      list.map((q) => ({ originalSentence: q.originalSentence, blanks: q.blanks ?? [] }))
    );
    if (seq !== state.previewSeq) return { ok: false, list: [] };   // 已被更新的粘贴取代
    verdicts = res?.results ?? [];
  } catch (error) {
    if (seq !== state.previewSeq) return { ok: false, list: [] };
    // 查重失败不阻断录入：降级为「全部按新增处理」并明确告知，
    // 而不是让用户卡在这里无法导入
    console.error("[ai] 查重失败，本批按新增处理", error);
    verdicts = list.map((_, index) => ({ index, state: "new", hint: "", matched: [] }));
  }

  // 找出字典里不存在的标签，交给用户确认是否创建。
  // 放在预览之后、导入之前：用户能先看到题目，再决定要不要建标签
  const unknown = new Set();
  list.forEach((question) => {
    question.blanks?.forEach((blank) => {
      (blank.tagIds ?? []).forEach((tagId) => {
        if (!resolveTag(state.dictionary, tagId)) unknown.add(tagId);
      });
    });
  });
  state.missingTags = [...unknown];
  renderMissing();

  state.previewList = list;
  // 换了一批题，上一篇的共用引用作废（否则会把上一篇的原文套到新一批上）
  state.previewPassageId = null;

  // 原文是 AI 已经填好的，不该再让用户手动点一次「套用到本批」。
  // 必须放在 state.previewList = list 之后：判断与落库都读 state.previewList，
  // 放在赋值前读到的是上一批（首次构建时甚至是空数组），判断永远不成立。
  await autoAdoptSharedPassage(list);
  state.previewVerdicts = list.map((_, index) => verdicts[index] ?? { state: "new", hint: "", matched: [] });
  // 默认勾选规则：新增勾上；已存在 / 答案不同默认不勾（宁可少录，不要默默产生两条互相矛盾的题）
  state.previewChecks = state.previewVerdicts.map((v) => v.state === "new");
  // 修复说明用 state.pendingRepairs：runImport 读的是它，写成别的名字会让
  // 「已自动修正：…」这条提示永远不显示
  state.pendingRepairs = repairs;
  state.previewSourceText = raw;

  renderPreview();

  if (allErrors.length > 0) {
    renderError(`校验未通过，共 ${allErrors.length} 处问题，本次未导入：\n${allErrors.join("\n")}`);
    return { ok: false, list };
  }
  clearError();
  return { ok: true, list };
}

/** 清空预览状态（textarea 被清空或 JSON 解析失败时） */
function clearPreview() {
  state.previewList = [];
  state.previewEditIndex = null;   // 收起可能开着的编辑表单，否则会残留一张空表单
  state.previewPassageId = null;   // 篇章引用也要清，否则上一批的引用会漏到下一批
  state.savedPassageTexts = null;
  state.previewVerdicts = [];
  state.previewChecks = [];
  state.previewSourceText = null;
  state.missingTags = [];
  renderMissing();
  renderPreview();
}

/** 试卷名是否与库里已有的某张卷同名（同名即同一张卷，会归到一起） */
function findPaperByName(name) {
  const target = String(name ?? "").trim();
  if (target === "") return null;
  return state.allPapers.find((paper) => String(paper.name ?? "").trim() === target) ?? null;
}

/**
 * 试卷名下方的说明文字。
 *
 * 说清三件事，用户不用猜：
 *   · 这个名字从哪来（AI 读到 / 你手填的）
 *   · 与库里的哪张卷相同（同名会自动归到那张卷，而不是新建）
 *   · 改这个名字会新建另一张卷
 */
export function updatePaperHint(autoFilled) {
  if (!state.els.paperHint) return;
  const name = (state.els.source?.value ?? "").trim();

  if (name === "") {
    state.els.paperHint.textContent = "试卷名是必填项。同名会自动归到库里已有的那张卷，不会重复建卷。";
    state.els.paperHint.className = "mt-2 text-xs leading-5 text-muted";
    return;
  }

  const existing = findPaperByName(name);
  if (existing) {
    const count = Number(existing.questionCount ?? 0);
    const countText = count > 0 ? "当前 " + count + " 道" : "当前 0 道";
    state.els.paperHint.textContent =
      "库里已有同名试卷「" + name + "」，这批题目会归到它下面（" + countText + "）。换个名字则会新建一张卷。";
    state.els.paperHint.className = "mt-2 text-xs leading-5 text-muted";
    return;
  }

  state.els.paperHint.textContent = autoFilled
    ? "已按 AI 从封面读出的名称填好，可直接改。确认无误后点下方按钮导入。"
    : "将新建一张试卷，题目会归到这张新卷下。确认名称无误再导入。";
  state.els.paperHint.className = "mt-2 text-xs leading-5 text-muted";
}

/**
 * 粘贴后预读卷名：能解析出source 就自动填进输入框。
 *
 * 只在「输入框还是空的」或「值与上次自动填的一模一样」时覆盖——
 * 用户已经手动改过的名字不能被后续粘贴冲掉。
 */
export function previewPaperName() {
  const raw = state.els.textarea?.value ?? "";
  if (raw.trim() === "") {
    // 导入成功后我们主动清空 textarea 让用户接着录下一卷，
    // 这时保留卡片（卷名框可见），只把提示改成「已清空，可继续粘贴」
    if (state.lastAutoFilledName === IMPORTED_MARK) {
      if (state.els.paper) state.els.paper.hidden = false;
      return;
    }
    if (state.els.paper) state.els.paper.hidden = true;
    return;
  }

  const result = parseJsonLoose(cleanJson(raw));
  if (result === null) return; // 还没粘完，等下一次输入

  const batch = splitBatch(result.value);
  if (!state.els.paper) return;

  if (batch.source !== "") {
    const current = (state.els.source?.value ?? "").trim();
    // 只在「还是上次自动填的那个」时覆盖：
    // 用户手动改过的名字不能被后续粘贴冲掉。
    // current === "" 的情况交给导入时提示「请先填写试卷名」，
    // 不在这里替他填——主动清空就是想自己写。
    // IMPORTED_MARK 表示「上一次是脚本导入完主动清空的」，不是用户自己清空——
    // 这两种情况必须区别对待，否则导入一卷之后，下一张卷子粘贴进来时
    // 卷名框不会自动填，用户得手敲一遍，与「粘完就能看到卷名」的设计相悖。
    const scriptCleared = state.lastAutoFilledName === IMPORTED_MARK;
    if (current === state.lastAutoFilledName || (scriptCleared && current === "")) {
      state.els.source.value = batch.source;
      state.lastAutoFilledName = batch.source;
    } else if (current === "") {
      // 输入框空着：仍然把 AI 读到的名字显示出来供参考，但不写进输入框，
      // 用户复制过去或自己敲
      if (state.els.paperHint) {
        state.els.paperHint.textContent =
          "AI 读到「" + batch.source + "」。请填入下面的试卷名框，确认或修改后再导入。";
      }
      state.els.paper.hidden = false;
      return;
    }
    // 输入框里的名字（可能已被用户改过）与库里的卷比对，
    // 不管它是不是 AI 给的那个，都要说清会不会归到已有的卷
    updatePaperHint(current === batch.source);
  } else {
    updatePaperHint(false);
  }
  state.els.paper.hidden = false;
}

/**
 * 正式校验并增量入库。
 *
 * @param {Array}  list    候选题目（全量）
 * @param {Array}  checks  与 list 等长的勾选标记；缺省视为全选
 */
async function runImport(list, checks = null) {
  const { allErrors } = validateQuestions(list, state.dictionary);

  if (allErrors.length > 0) {
    // 校验错误要逐条列出来，只说「共 3 处问题」用户无从修改
    renderError(`校验未通过，共 ${allErrors.length} 处问题，本次未导入：\n${allErrors.join("\n")}`);
    state.pending = list;
    return;
  }

  // 只导入勾选的题。重复题默认不勾（见 buildPreview），
  // 用户想覆盖某一道就单独勾上——而不是一律覆盖或一律跳过
  const selected = [];
  const skipped = [];
  list.forEach((question, index) => {
    if (checks === null || checks[index]) {
      selected.push(question);
    } else {
      skipped.push(question);
    }
  });

  if (selected.length === 0) {
    renderError("一道题都没勾选。已存在的题默认不勾选，如需重新录入请勾上后再试。");
    return;
  }

  // 整批共用一个试卷名：用户在页面上确认/修改过的那个值。
  // 卷名为空不导入——「AI 生成」这种占位名会把题库塞满无意义的碎片卷。
  const finalSource = state.els.source.value.trim();
  if (finalSource === "") {
    renderError("请先填写试卷名");
    updatePaperHint(false);
    state.els.source?.focus();
    return;
  }

  const stamped = selected.map((question) => ({
    ...question,
    // 编号一律由本系统生成，丢弃 AI 返回的 id（它无从得知题库现状）
    id: generateQuestionId(),
    // 同一批全部用这个卷名；AI 写在每道题里的 source 一律忽略
    source: finalSource,
    status: "unmastered",
    wrongCount: 0,
    createdAt: new Date().toISOString(),
  }));

  // 必须 await：onAppend 内部是异步的，它自己也会弹一条提示。
  // 不等它就会变成两条提示互相覆盖——后到的那条（不带「跳过 N 道」信息）
  // 反而把更完整的那条盖掉，用户永远看不到跳过了几题。
  try {
    await state.hooks.onAppend(stamped, finalSource);
  } catch (error) {
    notifyError(error, { retry: () => void handleParse() });
    return;
  }

  // 提示里的来源取实际写库的值，便于当即核对 AI 有没有读对封面信息
  // 来源取实际写库的值，便于当即核对 AI 有没有读对封面信息
  const displaySource = stamped.length > 0 ? String(stamped[0].source ?? "").trim() : "";
  // 结构化传给 showNotice：数量、来源、跳过数、自动修正分开排成长卡片，
  // 比挤成一行纯文本好读得多（长来源名也不会把整行撑爆）
  state.hooks.onNotice({
    count: stamped.length,
    source: displaySource,
    skipped: skipped.length,
    repairs: state.pendingRepairs,
  });
  // 把这批题目所属的卷登记进本地列表。
  // state.allPapers 是页面加载时的快照，不更新的话「库里已有同名卷」的提示
  // 在导入后就没用了——刚建的卷查不到。
  const knownPaper = state.allPapers.find((paper) => String(paper.name ?? "").trim() === finalSource);
  if (!knownPaper) {
    state.allPapers = [{ id: "", name: finalSource, questionCount: stamped.length }, ...state.allPapers];
  } else {
    knownPaper.questionCount = Number(knownPaper.questionCount ?? 0) + stamped.length;
  }

  // 篇章引用必须一起清：否则下一批题如果**文本与这一批相同**，
  // buildPreview 会命中 state.lastBuild 缓存直接返回（那条路径不经过 buildPreviewInner，
  // 不会重置 passageId），面板就会显示「已套用到本批 N 道题」而实际一题都没挂。
  // 更糟的是用户点「重新套用」会 updatePassage 改到**别的批次**的篇章上。
  state.previewPassageId = null;
  state.savedPassageTexts = null;
  renderPassagePanel();

  state.els.textarea.value = "";
  if (state.els.paper) state.els.paper.hidden = false; // 保留卡片，方便连续录下一卷时直接改名字
  state.lastAutoFilledName = IMPORTED_MARK;
  if (state.els.source) state.els.source.value = "";
  if (state.els.paperHint) {
    state.els.paperHint.textContent =
      "已导入 " + stamped.length + " 道题到「" + finalSource + "」。可继续粘贴下一张卷子的 JSON。";
  }
  state.pending = null;
  state.pendingRepairs = [];
  // 预览清空：导入完成后应回到干净的起点，避免旧的勾选状态被误当成新粘贴的结果
  state.previewSourceText = null;
  state.previewList = [];
  state.previewVerdicts = [];
  state.previewChecks = [];
  renderPreview();
}

/**
 * 确认创建新标签。
 * 新标签由主脚本写入字典，用户再点一次「确认导入这一卷」即可按新标签校验。
 */
export function handleCreateMissing() {
  // 前置条件是「确实有未知标签」，而不是「有解析结果」——
  // 预览流程下 state.pending 不再承载这个信息，用它判断会让按钮静默失效
  if (state.missingTags.length === 0) return;

  // 先取出名字：原版 setMissingTags([]) 是异步的，这里要保留同一份用于提示文案
  const names = state.missingTags.slice();
  state.hooks.onCreateTags(names);
  state.missingTags = [];
  renderMissing();
  state.pending = null;
  // 主脚本创建标签后会整页重载（浏览器会自动恢复 textarea 的内容），
  // 重载后字典是新的，再点一次导入即可按新标签校验
  state.hooks.onNotice(`已创建标签：${names.join("、")}。请再次点击「确认导入这一卷」，本次将按新标签校验。`);
}
