/**
 * 整卷练习（一题一屏）。
 *
 * 与刷题页共用同一套判卷口径与记录方式——同一道题在两处必须判定一致，
 * 所以 isBlankCorrect 与 submitRecord 这里的实现刻意与 practice.js 保持相同，
 * 改动时两处要同步。
 *
 * 与刷题页的分工：
 * - 刷题页：可打乱、可按标签筛、自由切页签，用来查漏补缺
 * - 这里：固定顺序、一题一屏、做完给小结，用来「这套卷从头做一遍」
 */

import { api } from "./api.js";
import { notifyWarn } from "./feedback.js";
import { iconCheck, iconCross } from "./icons.js";
import { escapeHtml } from "./escape-html.js";

/** 空格占位符字面量 */
const BLANK_PLACEHOLDER = "______";

/** 输入框宽度上下限（ch 单位，按最长答案自适应） */
const MIN_INPUT_CH = 4;
const MAX_INPUT_CH = 20;

/** 游客的本地存储键，与刷题页一致，才能读到同一份记录 */
const LOCAL_RECORDS_KEY = "eq_local_records";

const bootNode = document.getElementById("paper-practice-boot");
if (!bootNode) throw new Error("缺少页面数据节点");
const boot = JSON.parse(bootNode.textContent);
const paper = boot.paper;
// 该卷的完整原文（可选）。取不到就是空 —— 原文是补充材料，不是做题的前提。
const paperPassage = boot.passage ?? null;
const authenticated = Boolean(boot.authenticated);

/* ------------------------------------------------------------------ */
/* 本地存储（游客路径）                                                  */
/* ------------------------------------------------------------------ */

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下写入会失败，忽略即可：本次做题仍能正常进行 */
  }
}

/* ------------------------------------------------------------------ */
/* 判卷与记录                                                          */
/* ------------------------------------------------------------------ */

/** 归一化：只去首尾空格。判卷大小写敏感，绝不转小写 */
function normalize(value) {
  return String(value ?? "").trim();
}

/**
 * 单个空是否正确。
 *
 * 判卷口径：只 trim、不转大小写。高考填空严格判分，
 * 宽松判卷会教坏学生。
 */
function isBlankCorrect(blank, userInput) {
  const value = normalize(userInput);
  if (value === "") return false;
  return (blank.answer ?? []).some((answer) => normalize(answer) === value);
}

/**
 * 记录一次作答：登录走服务端，失败或游客退回本地。
 *
 * 上报失败会退回本地保存，但**必须告诉用户**——不然他会以为进度已经
 * 上去了，换台设备发现进度没了。警告语里说清差异与补救办法。
 */
async function submitRecord(questionId, isCorrect, wrongCount, answers) {
  if (authenticated) {
    try {
      await api.submitRecord(questionId, isCorrect, wrongCount, answers);
      return;
    } catch (error) {
      console.error("[paper-practice] 上报失败，已退回本地保存", error);
      notifyWarn("作答记录暂存在本设备，没有同步到账号", {
        details: [
          "换设备或清除浏览器数据后，这批记录会丢失",
          "常见原因：网络不稳定，或服务器正在忙，稍后可再试一次本卷",
          `失败原因：${error?.message ?? "未知"}`,
        ],
        // 同一次作答重复上报不会出错，所以重试是安全的
        retry: () => void submitRecord(questionId, isCorrect, wrongCount, answers),
      });
    }
  }
  const records = readJson(LOCAL_RECORDS_KEY, []);
  records.unshift({
    questionId,
    isCorrect,
    wrongCount,
    answers,
    createdAt: new Date().toISOString(),
  });
  writeJson(LOCAL_RECORDS_KEY, records.slice(0, 200));
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

/** 本卷题目，顺序即卷面顺序 */
const questions = boot.questions ?? [];
/**
 * 标签字典：解析里要显示考点标签。
 *
 * 必须由页面注入——整卷页不像刷题页那样要支持筛选，
 * 但答案解析仍然要显示考点，否则学生不知道自己错在哪个知识点上。
 */
const tagMap = new Map((boot.tagDictionary?.tags ?? []).map((tag) => [tag.id, tag]));
let currentIndex = 0;
/** 每题的作答状态：{ [questionId]: { inputs, submitted, correct } } */
let answers = {};
/** 本次进入时已做过的题（从历史记录或进度恢复），用于答题卡与小结 */
const doneBefore = new Set(
  questions.filter((q) => q.status === "mastered" || q.wrongCount > 0).map((q) => q.id)
);

function stateOf(questionId) {
  if (!answers[questionId]) {
    answers[questionId] = { inputs: {}, submitted: false, correct: false, wrongCount: 0 };
  }
  return answers[questionId];
}

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

function blankList(question) {
  return [...(question.blanks ?? [])].sort((a, b) => a.blankIndex - b.blankIndex);
}

function inputWidth(blank) {
  const longest = (blank.answer ?? []).reduce((max, ans) => Math.max(max, ans.length), 0);
  return Math.min(MAX_INPUT_CH, Math.max(MIN_INPUT_CH, longest + 2));
}

// 对勾与叉号统一走 icons.js：此前这两个文件里是**逐字节复制**的同一对函数，
// 现在尺寸与画法全站只有一处定义
const correctIcon = () => iconCheck("h-4 w-4 shrink-0 text-success");
const wrongIcon = () => iconCross("h-4 w-4 shrink-0 text-danger");

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function currentQuestion() {
  return questions[currentIndex] ?? null;
}

/** 本卷已作答的题数（含本次会话与历史） */
function answeredCount() {
  const ids = new Set([...doneBefore]);
  Object.entries(answers).forEach(([id, state]) => {
    if (state.submitted) ids.add(id);
  });
  return ids.size;
}

/** 答题卡：一眼看出哪些做过、对错如何 */
function renderSheet() {
  const sheet = document.getElementById("paper-sheet");
  if (!sheet) return;

  if (questions.length === 0) {
    sheet.innerHTML = `<p class="text-xs text-faint">这套卷还没有题目。</p>`;
    return;
  }

  // 分篇的卷（蓝图按知识点聚篇）在答题卡上按篇断开，篇与篇之间留一点空隙：
  // 一篇 10 个空连成一片数字，学生看不出自己换到下一篇了
  const grouped = [];
  let lastSection = null;
  questions.forEach((question, index) => {
    const section = question.sectionNo ?? 1;
    if (lastSection !== null && section !== lastSection) {
      grouped.push({ divider: true, index });
    }
    grouped.push({ question, index });
    lastSection = section;
  });

  sheet.innerHTML = grouped
    .map((entry) => {
      if (entry.divider) {
        return `<span class="mx-1 h-10 w-px shrink-0 bg-line" aria-hidden="true"></span>`;
      }
      const question = entry.question;
      const index = entry.index;
      const state = answers[question.id];
      const isCurrent = index === currentIndex;
      let tone = "border-line bg-surface text-muted";
      let mark = "";
      if (state?.submitted) {
        tone = state.correct
          ? "border-success bg-success-soft text-success"
          : "border-danger bg-danger-soft text-danger";
        mark = state.correct ? "✓" : "×";
      } else if (doneBefore.has(question.id)) {
        // 历史做过但本次没作答：标成中性色，和「没做过」区分开
        tone = "border-line bg-surface-alt text-faint";
      }
      if (isCurrent) tone += " ring-2 ring-primary";
      return `<button
        type="button"
        data-index="${index}"
        class="relative h-10 w-10 rounded-lg border text-xs font-medium transition ${tone}"
        aria-label="第 ${index + 1} 题${mark ? "，已作答" : ""}"
      >${index + 1}${mark ? `<span class="absolute -right-1 -top-1 text-[10px] leading-none">${mark}</span>` : ""}</button>`;
    })
    .join("");
}

/** 进度条与小结数据 */
function renderProgress() {
  const bar = document.getElementById("paper-progress-bar");
  const text = document.getElementById("paper-progress-text");
  const done = answeredCount();
  const total = questions.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  if (bar) bar.style.width = `${percent}%`;
  if (text) text.textContent = `已完成 ${done} / ${total}`;
}

/** 当前题卡片 */
function renderCard() {
  const container = document.getElementById("paper-card");
  if (!container) return;

  const question = currentQuestion();
  if (!question) {
    container.innerHTML = "";
    return;
  }

  const blanks = blankList(question);
  const state = stateOf(question.id);
  const submitted = state.submitted;

  const segments = question.originalSentence.split(BLANK_PLACEHOLDER);
  const sentenceHtml = segments
    .map((text, index) => {
      const blank = blanks[index];
      if (!blank) return escapeHtml(text);

      const nextSegment = segments[index + 1] ?? "";
      // 原句里空格后已有括号时，提示词已内嵌，不再补写
      const hintInSentence = /^\s*\(/.test(nextSegment);
      const hint =
        blank.hintWord && !hintInSentence
          ? `<span class="blank-slot ml-0.5 whitespace-nowrap text-base sm:text-lg">(${escapeHtml(blank.hintWord)})</span>`
          : "";

      const isCorrect = submitted ? isBlankCorrect(blank, state.inputs[blank.blankIndex] ?? "") : null;

      let boxClass = "border-line text-ink focus:border-primary focus:bg-primary-soft/40";
      if (submitted) {
        boxClass = isCorrect
          ? "border-success bg-success-soft text-success"
          : "border-danger bg-danger-soft text-danger";
      }

      const inputHtml = `<input
        type="text"
        data-blank="${blank.blankIndex}"
        value="${escapeHtml(state.inputs[blank.blankIndex] ?? "")}"
        placeholder="第${blank.blankIndex}空"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        ${submitted ? "readonly" : ""}
        style="width: ${inputWidth(blank)}ch"
        class="blank-slot border-b-2 bg-transparent px-1.5 py-0.5 text-center text-base outline-none transition sm:text-lg ${boxClass}${submitted ? " cursor-default" : ""}"
      >`;

      const iconHtml = submitted ? (isCorrect ? correctIcon() : wrongIcon()) : "";
      const answerHint =
        submitted && !isCorrect
          ? `<span class="blank-slot ml-1 text-sm text-danger">正确：${escapeHtml((blank.answer ?? []).join(" / "))}</span>`
          : "";

      return `${escapeHtml(text)}<span class="mx-1 inline-flex items-baseline align-baseline">${inputHtml}${iconHtml}${hint}</span>${answerHint}`;
    })
    .join("");

  const submitBlock = submitted
    ? ""
    : `<div class="mt-6">
        <button type="button" data-action="submit" class="min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover sm:w-auto sm:px-8">提交答案</button>
        <p class="mt-2 text-xs text-faint">输入答案后按回车可跳到下一个空，最后一个空回车直接提交。注意区分大小写，按考试要求精确拼写。</p>
      </div>`;

  const resultBanner = submitted
    ? `<div class="${
        state.correct
          ? "mt-5 rounded-xl border border-success/40 bg-success-soft px-6 py-3 text-sm font-medium text-success"
          : `mt-5 rounded-xl border border-danger/40 bg-danger-soft px-6 py-3 text-sm font-medium text-danger`
      }">${state.correct ? "全部正确！" : `答错 ${state.wrongCount} 个，查看解析`}</div>`
    : "";

  let analysisHtml = "";
  if (submitted) {
    const blanksHtml = blanks
      .map((blank, index) => {
        const isCorrect = isBlankCorrect(blank, state.inputs[blank.blankIndex] ?? "");
        const tags = (blank.tagIds ?? []).map((id) => tagMap.get(id)).filter(Boolean);
        const tagPills = tags
          .map(
            (tag) =>
              `<span class="rounded px-2 py-0.5 text-xs font-medium text-white" style="background-color: ${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>`
          )
          .join("");
        return `<li class="rounded-lg bg-surface-alt p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-ink">第 ${blank.blankIndex} 空</span>
              <span class="text-sm ${isCorrect ? "text-success" : "text-danger"}">${escapeHtml(
                state.inputs[blank.blankIndex] ?? "（未作答）"
              )}</span>
              ${tagPills}
            </div>
            <p class="mt-2 text-xs leading-5 text-muted">${escapeHtml(blank.trapAnalysis ?? "")}</p>
          </li>`;
      })
      .join("");
    analysisHtml = `<div class="mt-5 rounded-xl border border-line bg-surface-alt p-4">
        <h4 class="text-xs font-semibold text-ink">命题意图与判断依据</h4>
        <ul class="mt-2 space-y-2">${blanksHtml}</ul>
      </div>`;
  }

  container.innerHTML = `<article class="rounded-2xl border border-line bg-surface p-5 sm:p-6">
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold text-ink">第 ${currentIndex + 1} 题</h3>
      <span class="text-xs text-faint">${blanks.length} 个空</span>
    </div>
    ${passageBlock(submitted)}
    <div class="mt-4 text-base leading-9 text-ink sm:text-lg">${sentenceHtml}</div>
    ${submitBlock}
    ${resultBanner}
    ${analysisHtml}
  </article>`;
}

function renderPager() {
  const counter = document.getElementById("paper-counter");
  const prev = document.getElementById("paper-prev");
  const next = document.getElementById("paper-next");
  const finish = document.getElementById("paper-finish");

  // 分篇的卷（蓝图按知识点聚篇）要在计数器上说清「第几篇」：
  // 一题一屏看不到整体结构，学生不知道自己换没换篇
  const sections = new Set(questions.map((question) => question.sectionNo ?? 1));
  const sectionText = sections.size > 1 ? ` · 第 ${questions[currentIndex]?.sectionNo ?? 1} 篇` : "";

  if (counter) counter.textContent = `第 ${currentIndex + 1} / ${questions.length} 题${sectionText}`;
  if (prev) prev.disabled = currentIndex === 0;
  // 最后一题的「下一题」改为「完成」
  if (next) {
    next.textContent = currentIndex === questions.length - 1 ? "完成本卷" : "下一题";
    next.disabled = questions.length === 0;
  }
  if (finish) finish.hidden = true;
}

function renderAll() {
  renderCard();
  renderSheet();
  renderProgress();
  renderPager();
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

function goTo(index) {
  if (index < 0 || index >= questions.length) return;
  currentIndex = index;
  renderAll();
}

function collectInputs() {
  const question = currentQuestion();
  if (!question) return;
  const state = stateOf(question.id);
  document.querySelectorAll("#paper-card input[data-blank]").forEach((input) => {
    const key = Number(input.dataset.blank);
    state.inputs[key] = input.value;
  });
}

async function handleSubmit() {
  const question = currentQuestion();
  if (!question) return;
  const state = stateOf(question.id);
  if (state.submitted) return;

  collectInputs();

  const blanks = blankList(question);
  const results = blanks.map((blank) => isBlankCorrect(blank, state.inputs[blank.blankIndex] ?? ""));
  const wrongCount = results.filter((ok) => !ok).length;
  state.submitted = true;
  state.correct = wrongCount === 0;
  state.wrongCount = wrongCount;

  renderAll();

  // 上报放到渲染之后：先让用户看到结果，不被网络等待卡住。
  // answers 必须与 practice.js 一样先 trim：判卷时 isBlankCorrect 内部会 trim，
  // 但落库的原始值若带空格，错题本/回顾里显示的作答就和判卷结论对不上。
  void submitRecord(
    question.id,
    state.correct,
    wrongCount,
    blanks.map((blank) => normalize(state.inputs[blank.blankIndex] ?? ""))
  );

  // 全对时自动进入下一题——连续做题时少点一次
  if (state.correct && currentIndex < questions.length - 1) {
    currentIndex += 1;
    renderAll();
  }
}

function showFinish() {
  const finish = document.getElementById("paper-finish");
  const text = document.getElementById("paper-finish-text");
  const card = document.getElementById("paper-card");
  const sheet = document.getElementById("paper-sheet-wrap");
  const pager = document.getElementById("paper-next");

  if (!finish) return;

  // 只统计本次会话里做过的题，避免把历史错题也算进本次成绩
  const attempted = Object.entries(answers).filter(([, state]) => state.submitted);
  const total = attempted.length;
  const right = attempted.filter(([, state]) => state.correct).length;

  if (card) card.innerHTML = "";
  if (sheet) sheet.hidden = true;
  if (pager) pager.disabled = true;
  if (text) {
    text.textContent =
      total === 0
        ? "本卷还没有作答记录。点答题卡上的题号可以跳回去做。"
        : `本次共作答 ${total} 题，答对 ${right} 题，正确率 ${Math.round((right / total) * 100)}%。`;
  }
  finish.hidden = false;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function init() {
  if (questions.length === 0) {
    const card = document.getElementById("paper-card");
    if (card) {
      card.innerHTML = `<p class="rounded-2xl border border-dashed border-line bg-surface p-10 text-center text-sm text-muted">这套卷还没有题目。</p>`;
    }
    renderProgress();
    return;
  }

  document.getElementById("paper-prev")?.addEventListener("click", () => goTo(currentIndex - 1));
  document.getElementById("paper-next")?.addEventListener("click", () => {
    collectInputs();
    if (currentIndex === questions.length - 1) {
      showFinish();
      return;
    }
    goTo(currentIndex + 1);
  });
  document.getElementById("paper-restart")?.addEventListener("click", () => {
    answers = {};
    currentIndex = 0;
    const finish = document.getElementById("paper-finish");
    const sheet = document.getElementById("paper-sheet-wrap");
    const next = document.getElementById("paper-next");
    if (finish) finish.hidden = true;
    if (sheet) sheet.hidden = false;
    if (next) next.disabled = false;
    renderAll();
  });

  // 答题卡跳题
  document.getElementById("paper-sheet")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-index]");
    if (!button) return;
    collectInputs();
    goTo(Number(button.dataset.index));
  });

  // 提交按钮（事件委托，因为卡片每次都重绘）
  document.getElementById("paper-card")?.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="submit"]')) void handleSubmit();
  });

  // 输入与回车
  document.getElementById("paper-card")?.addEventListener("input", (event) => {
    const input = event.target.closest("input[data-blank]");
    if (!input) return;
    const question = currentQuestion();
    if (!question) return;
    stateOf(question.id).inputs[Number(input.dataset.blank)] = input.value;
  });

  document.getElementById("paper-card")?.addEventListener("keydown", (event) => {
    const input = event.target.closest("input[data-blank]");
    if (!input || event.key !== "Enter") return;
    event.preventDefault();

    const question = currentQuestion();
    if (!question) return;
    const blanks = blankList(question);
    const currentBlank = Number(input.dataset.blank);
    const index = blanks.findIndex((b) => b.blankIndex === currentBlank);

    // 最后一个空回车 = 提交
    if (index === blanks.length - 1) {
      void handleSubmit();
      return;
    }
    const nextKey = blanks[index + 1].blankIndex;
    const nextInput = document.querySelector(`#paper-card input[data-blank="${nextKey}"]`);
    nextInput?.focus();
    nextInput?.select();
  });

  renderAll();
}

init();

/**
 * 完整原文（未挖空）展示块 —— **按卷取，不是按题取**。
 *
 * 模型（v3.9.5）：原文挂在**卷**上，与具体题目无关。
 * 每道小题自带最小答题上下文，所以可以脱离整卷随机出题；
 * 原文只是整卷作答时的补充材料，折叠着放，需要才展开。
 *
 * 原来是从 `question.passageText` 读（每题一份「共享」的），那是
 * 「题要绑原文」时代的旧模型，已经去掉。现在一次取整卷那篇，
 * 整卷页所有题共用同一个块。
 *
 * ⚠️ 必须守住的红线：**原文是未挖空的全文，展开它等于直接看到答案。**
 * 所以默认收起，标题明写「展开会直接看到本题答案」，
 * 提交判卷之后才自动展开 —— 那正是需要对照原文的时刻。
 *
 * @param {boolean} submitted 本题是否已提交判卷
 * @returns {string} HTML
 */
function passageBlock(submitted) {
  const passage = typeof paperPassage?.text === "string" ? paperPassage.text.trim() : "";
  if (passage === "") return "";
  // submitted 时自动展开：那是对答案阶段，需要对照原文
  return `<details class="mb-5 rounded-xl border border-line bg-surface-alt p-3 sm:p-4" data-passage-block${
    submitted ? " open" : ""
  }>
    <summary class="cursor-pointer select-none text-xs font-medium text-muted">
      ${
        submitted
          ? "完整原文（未挖空，供对照）"
          : "完整原文（未挖空）—— 展开会直接看到本题答案"
      }
    </summary>
    <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">${escapeHtml(passage)}</p>
  </details>`;
}
