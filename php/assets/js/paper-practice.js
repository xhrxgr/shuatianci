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

/**
 * 本卷是否**全部交完**。
 *
 * v3.9.9：整卷做按考试来 —— 做完一题不给即时反馈，对错一律等整卷交完再揭晓。
 * 实时反馈会毁掉整卷做的意义：学生看到前两题都对，后面的题就变成「照着感觉蒙」，
 * 而真正的完形填空考的是通篇理解。
 */
function allSubmitted() {
  return (
    questions.length > 0 &&
    questions.every((q) => Boolean(answers[q.id]?.submitted))
  );
}

/** 本卷已作答的题数（含本次会话与历史） */
function answeredCount() {
  const ids = new Set([...doneBefore]);
  Object.entries(answers).forEach(([id, state]) => {
    if (state.submitted) ids.add(id);
  });
  return ids.size;
}

/**
 * 对错是否已揭晓 —— **整卷交完之前一律 false**。
 *
 * v3.9.9 只把答题卡的对错压到了交卷后，题目卡片本身还在提交那一刻
 * 弹出 ✓/✗、正确答案、「全部正确！」和完整解析 —— 等于还是一题一题看答案，
 * 整卷做就退化成了普通刷题。
 *
 * 现在所有「对错相关」的渲染都统一受它把门：
 *   · 输入框的绿/红配色
 *   · ✓/✗ 图标
 *   · 「正确：xxx」提示
 *   · 结果横幅
 *   · 命题依据解析
 * 提交后只显示中性的「已提交」，交卷后在逐题回顾里一次性全给。
 */
function revealed() {
  return allSubmitted();
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
      // ⚠️ 对错只在**整卷交完**后揭晓（v3.9.9）。未交完时，已答的题只标成
      // 中性色表示「做过」—— 提前露出对错等于把整卷做降级成逐题刷题。
      if (state?.submitted && allSubmitted()) {
        tone = state.correct
          ? "border-success bg-success-soft text-success"
          : "border-danger bg-danger-soft text-danger";
        mark = state.correct ? "✓" : "×";
      } else if (state?.submitted) {
        tone = "border-primary bg-primary-soft text-primary";
        mark = "·";
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

// 已提交但没揭晓时保持中性 —— 绿/红本身就是「这题对了/错了」的信号
        let boxClass = "border-line text-ink focus:border-primary focus:bg-primary-soft/40";
        if (submitted) boxClass += " border-primary/60 bg-primary-soft/40 text-primary";
        if (submitted && revealed()) {
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

const showVerdict = submitted && revealed();
        const iconHtml = showVerdict ? (isCorrect ? correctIcon() : wrongIcon()) : "";
        const answerHint =
          showVerdict && !isCorrect
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

// 交卷前只说「记下了」，一个字都不透露对错；交卷后才给真实结论
    const resultBanner = submitted
      ? revealed()
        ? `<div class="${
            state.correct
              ? "mt-5 rounded-xl border border-success/40 bg-success-soft px-6 py-3 text-sm font-medium text-success"
              : `mt-5 rounded-xl border border-danger/40 bg-danger-soft px-6 py-3 text-sm font-medium text-danger`
          }">${state.correct ? "全部正确！" : `答错 ${state.wrongCount} 个，查看解析`}</div>`
        : `<div class="mt-5 rounded-xl border border-primary/30 bg-primary-soft px-6 py-3 text-sm font-medium text-primary">
             已提交。对错与解析等本卷全部做完后一起揭晓。
           </div>`
      : "";

  let analysisHtml = "";
  // 解析区藏着标准答案与命题意图 —— 交卷前一律不渲染
  if (submitted && revealed()) {
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
  // 原文视图里的空也要一起收 —— 两处共用同一份 answers，
  // 只收题目视图的话，学生在原文里填的会在判卷时丢掉。
  collectPassageInputs();
}

/** 把展开的原文里填的空，按「题号:空号」写回对应题目的 answers */
function collectPassageInputs() {
  document.querySelectorAll("[data-passage-blank]").forEach((input) => {
    const [qid, no] = String(input.dataset.passageBlank).split(":");
    if (!qid || !no) return;
    stateOf(qid).inputs[Number(no)] = input.value;
  });
}

/**
 * 原文视图里的输入也要能实时回写到题目卡片 ——
 * 两边是同一份作答，改一处另一处跟着变，否则用户会以为填了两遍。
 */
document.addEventListener("input", (event) => {
  const input = event.target.closest?.("[data-passage-blank]");
  if (!input) return;
  const [qid, no] = String(input.dataset.passageBlank).split(":");
  if (!qid || !no) return;
  stateOf(qid).inputs[Number(no)] = input.value;
  const twin = document.querySelector(`#paper-card input[data-blank="${Number(no)}"]`);
  if (twin) twin.value = input.value;
});

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

  // 注意：这里**不再**「全对就自动跳下一题」。
  // 整卷做是考试 —— 自动跳与否本身就是「这题对不对」的信号，
  // 而且学生连自己刚填的答案都还没看见就被换页了。
  // 现在无论对错都停在原题，由学生自己决定什么时候翻页。
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

  // ⚠️ 交卷后**不能清空题目区**（v3.9.9）。
  // 原来这里 `card.innerHTML = ""` + `sheet.hidden = true`，
  // 交卷瞬间学生面前只剩一个百分比 —— 逐题对错、原文对照、解析全都没了，
  // 等于「交卷」变成了「查不到成绩」。
  // 现在改成渲染一份**逐题回顾**：题干、你的答案、对错、正确答案、原文挖空对照。
  if (card) card.innerHTML = renderReview();
  if (sheet) sheet.hidden = false;      // 答题卡保持可见 —— 这正是揭晓对错的地方
  if (pager) pager.disabled = true;
  if (text) {
    text.textContent =
      total === 0
        ? "本卷还没有作答记录。点答题卡上的题号可以跳回去做。"
        : `本次共作答 ${total} 题，答对 ${right} 题，正确率 ${Math.round((right / total) * 100)}%。`;
  }
  finish.hidden = false;
  finish.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 交卷后的逐题回顾 */
function renderReview() {
  const rows = questions.map((question, index) => {
    const state = answers[question.id];
    if (!state?.submitted) return "";
    const ok = state.correct;
    const yourAnswer = blankList(question)
      .map((b) => state.inputs[b.blankIndex] ?? "")
      .filter((v) => v !== "")
      .join(" / ");
    const right = blankList(question)
      .map((b) => (b.answer ?? []).join(" / "))
      .join("　");
    // 解析存在**空级**（blanks[].trapAnalysis），题目级没有这个字段。
    // 之前这里读的是 question.trapAnalysis，于是交卷后的回顾永远显示不出解析 ——
    // 而整卷做恰恰是唯一会看到回顾的地方。
    const analyses = blankList(question)
      .filter((b) => (b.trapAnalysis ?? "").trim() !== "")
      .map(
        (b) => `<p class="rounded-lg bg-surface-alt px-3 py-2 text-xs leading-5 text-muted">
          <span class="font-medium text-ink">第 ${b.blankIndex} 空解析：</span>${escapeHtml(b.trapAnalysis)}
        </p>`
      )
      .join("");
    return `<article class="rounded-xl border ${ok ? "border-line" : "border-danger/50"} bg-surface p-4">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold text-muted">第 ${index + 1} 题</span>
        <span class="rounded px-2 py-0.5 text-xs font-medium ${ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}">
          ${ok ? "答对" : `错 ${state.wrongCount} 空`}
        </span>
      </div>
      <p class="text-sm leading-6 text-ink">${escapeHtml(question.originalSentence ?? "")}</p>
      <p class="mt-2 text-xs text-muted">
        你的答案：<span class="${ok ? "text-success" : "text-danger"}">${escapeHtml(yourAnswer || "（未作答）")}</span>
        ${ok ? "" : `　正确答案：<span class="text-success">${escapeHtml(right)}</span>`}
      </p>
      ${
          analyses
            ? `<div class="mt-2 space-y-1.5">${analyses}</div>`
            : ""
        }
      </article>`;
    });

  const passage = renderPassageBlanked(
    typeof paperPassage?.text === "string" ? paperPassage.text.trim() : "",
    true   // 已交卷，只读
  );
  return `
    ${
      passage
        ? `<details class="mb-4 rounded-xl border border-line bg-surface-alt p-4" data-passage-block open>
            <summary class="cursor-pointer select-none text-xs font-medium text-muted">完整原文对照（空位显示你的作答）</summary>
            <div class="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-ink">${passage}</div>
          </details>`
        : ""
    }
    <div class="space-y-3">${rows.filter(Boolean).join("")}</div>`;
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
    // ⚠️ 这里原本叫 `revealed`，和全局的 revealed() 同名 ——
    // 局部 const 会把它遮蔽掉，之后调用 revealed() 直接 TypeError。
    // 局部变量统一加 `is` 前缀区分。
    const isRevealed = revealed();
    // 未整卷交完时不挖空 —— 挖空视图和题目视图共用同一份作答与判卷，
    // 直接给全文等于当场把答案摊开。
    const html = isRevealed ? renderPassageBlanked(passage) : escapeHtml(passage);
    return `<details class="mb-4 rounded-xl border border-line bg-surface-alt p-4" data-passage-block${
      isRevealed ? " open" : ""
    }>
      <summary class="cursor-pointer select-none text-xs font-medium text-muted">
        ${
        revealed
          ? "完整原文（空位可填，作答与题目共享）"
          : "完整原文 —— 展开会直接看到本题答案"
      }
    </summary>
    <div class="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-ink">${html}</div>
  </details>`;
}

/**
 * 把原文挖成可填的空位 —— **按答案词在原文中的位置**逐个替换。
 *
 * 规则（v3.9.9，用户定的「按词对位」）：
 *   · 按题目顺序遍历，每题的每个空取 `answer[0]` 作为要挖的词
 *   · 用一个游标往后找，**不允许回头** —— 否则同一个词会被挖掉多次
 *   · 词形不一致（原文写 `rain`、答案写 `rains`）时试几种常见变形：
 *     去掉词尾 s / ed / ing，以及反过来加
 *   · 一个空都找不到就保留原词，并在末尾列一张「未能对位」清单 ——
 *     宁可让学生看见原文里那个词，也不要静默挖错位置
 *
 * 每个空渲染成一个输入框，与题目视图共用 `answers[questionId].inputs`，
 * 所以在原文里填和在题目里填是同一份，判卷也只判一次。
 */
function renderPassageBlanked(passage, readonly = false) {
  const pieces = [];
  let cursor = 0;
  const unmatched = [];

  for (const question of questions) {
    for (const blank of blankList(question)) {
      const word = (blank.answer ?? [])[0] ?? "";
      const hit = findWord(passage, word, cursor);
      if (!hit) {
        if (word) unmatched.push({ no: blank.blankIndex, word });
        continue;
      }
      pieces.push(escapeHtml(passage.slice(cursor, hit.start)));
      pieces.push(blankInputHtml(question, blank, readonly));
      cursor = hit.end;
    }
  }
  pieces.push(escapeHtml(passage.slice(cursor)));

  if (unmatched.length > 0) {
    pieces.push(
      `<p class="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-[11px] text-warning">` +
        `原文里没能对上位置的空（已保留原词）：` +
        unmatched.map((u) => `第 ${u.no} 空 ${escapeHtml(u.word)}`).join("、") +
        `</p>`
    );
  }
  return pieces.join("");
}

/** 从 from 起往后找 word（含常见变形），返回 {start,end} 或 null */
function findWord(text, word, from) {
  const base = String(word ?? "").trim();
  if (!base) return null;
  // 先长的后短的（rains 要排在 rain 前面，否则会挖到词干）
  const variants = [base, base.replace(/s$/i, ""), base.replace(/e?s$/i, ""), base.replace(/ing$/i, "")];
  const unique = [...new Set(variants.filter(Boolean))].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  for (const v of unique) {
    const idx = lower.indexOf(v.toLowerCase(), from);
    if (idx >= 0) return { start: idx, end: idx + v.length };
  }
  return null;
}

/**
 * 原文里的空输入框 —— 与题目视图共用同一份 answers。
 * readonly=true 用于**交卷后的回顾**：那时已经判过分，再改动不会重新判卷，
 * 界面就会自相矛盾（答题卡说对、原文里却填着别的词）。
 */
function blankInputHtml(question, blank, readonly = false) {
  const state = stateOf(question.id);
  const value = state.inputs[blank.blankIndex] ?? "";
  const shown = submittedAndRevealed(state) && value !== "" && !isBlankCorrect(blank, value)
    ? `border-danger text-danger`
    : submittedAndRevealed(state) && value !== ""
      ? `border-success text-success`
      : "";
  return `<input
    type="text"
    value="${escapeHtml(value)}"
    data-passage-blank="${escapeHtml(question.id)}:${blank.blankIndex}"
    placeholder="第${blank.blankIndex}空"
    aria-label="第 ${blank.blankIndex} 空"
    ${readonly ? "readonly" : ""}
    class="mx-0.5 inline-block h-8 w-[7.5rem] rounded border border-line bg-surface px-2 text-center align-baseline text-sm outline-none transition focus:border-primary ${shown} ${readonly ? "cursor-default" : ""}"
  >`;
}

function submittedAndRevealed(state) {
  return Boolean(state?.submitted) && allSubmitted();
}
