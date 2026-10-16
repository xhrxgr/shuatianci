/**
 * 刷题页交互。
 *
 * 判卷口径与原版完全相同：只 trim 首尾空格，**区分大小写**——
 * 高考填空严格判分，不做大小写归一。
 * 游客的记录与进度存 localStorage（key 与原版一致，老用户数据能直接接上）；
 * 登录用户的记录与进度走服务端接口。
 */

import { notifyError, notifyWarn } from "./feedback.js";
import { api } from "./api.js";

const BLANK_PLACEHOLDER = "______";
const MIN_INPUT_CH = 5;
const MAX_INPUT_CH = 22;
const LOCAL_RECORDS_KEY = "eq_local_records";
const LOCAL_PROGRESS_KEY = "eq_local_progress";

const TABS = [
  { id: "all", label: "全部题目" },
  { id: "wrong", label: "错题本" },
  { id: "mastered", label: "已掌握" },
  { id: "marked", label: "我的标记" },
  { id: "favorites", label: "我的收藏" },
];

const EMPTY_TEXT = {
  all: "题库还是空的，先去「题库管理」录入题目或用 AI 导入生成。",
  wrong: "还没有错题。答错的题目会自动进入这里。",
  mastered: "还没有已掌握的题目。答对后点击「标记为已掌握」即可归入此处。",
  marked: "还没有标记的题目。刷题时点「标记本题」即可归入此处。",
  favorites: "还没有收藏的试卷。刷题时点「收藏本卷」即可归入此处。",
};

const HINT_TYPES = ["给动词", "给名词", "给形容词", "给副词", "无提示词"];
const HINT_TYPE_COLORS = {
  给动词: "#EF4444",
  给名词: "#3B82F6",
  给形容词: "#10B981",
  给副词: "#8B5CF6",
  无提示词: "#F59E0B",
};
const MARK_LABELS = ["重点", "难点", "考点回顾"];

/* ---------------- 启动数据 ---------------- */

const bootElement = document.getElementById("practice-boot");
const boot = bootElement ? JSON.parse(bootElement.textContent) : null;
if (!boot) {
  throw new Error("缺少启动数据 practice-boot");
}

const authenticated = Boolean(boot.authenticated);
const tagDictionary = boot.tagDictionary;
const sourceFilter = boot.sourceFilter || null;
/** 按试卷筛选（从「自由刷这卷」进来时），与 sourceFilter 可同时存在 */
const paperIdFilter = boot.paperIdFilter || null;

/* ---------------- 游客本地存储（key 与原版一致） ---------------- */

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
  } catch (error) {
    console.error("[practice] 本地保存失败", error);
  }
}

/** 游客：把本地进度合并进题目列表（登录用户由服务端合并） */
function applyLocalProgress(list) {
  const progress = readJson(LOCAL_PROGRESS_KEY, {});
  return list.map((question) => {
    const item = progress[question.id];
    if (!item) return { ...question, wrongCount: 0, status: "unmastered" };
    return { ...question, wrongCount: item.wrongCount ?? 0, status: item.status ?? "unmastered" };
  });
}

function bumpLocalProgress(questionId) {
  const all = readJson(LOCAL_PROGRESS_KEY, {});
  const current = all[questionId] ?? { wrongCount: 0, status: "unmastered" };
  all[questionId] = { ...current, wrongCount: (current.wrongCount ?? 0) + 1 };
  writeJson(LOCAL_PROGRESS_KEY, all);
}

function setLocalProgressStatus(questionId, status) {
  const all = readJson(LOCAL_PROGRESS_KEY, {});
  const current = all[questionId] ?? { wrongCount: 0, status: "unmastered" };
  all[questionId] = { ...current, status };
  writeJson(LOCAL_PROGRESS_KEY, all);
}

/** 记录一次作答：登录走服务端，失败或游客退回本地（与原版一致） */
async function submitRecord(questionId, isCorrect, wrongCount, answers) {
  if (authenticated) {
    try {
      await api.submitRecord(questionId, isCorrect, wrongCount, answers);
      return;
    } catch (error) {
      console.error("[practice] 上报失败，已退回本地保存", error);
      // 与 paper-practice.js 保持同一口径：没同步到账号这件事必须让用户知道，
      // 否则他以为错题本已经更新，换设备后发现进度全没了
      notifyWarn("作答记录暂存在本设备，没有同步到账号", {
        details: [
          "换设备或清除浏览器数据后，这批记录会丢失",
          `失败原因：${error?.message ?? "未知"}`,
        ],
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

/* ---------------- 状态 ---------------- */

// boot.questions 理论上由服务端保证存在，但这里做一次兜底：
// 数组一旦缺失，下面所有 .map / .filter 都会在加载时抛错，整页白屏
const bootQuestions = Array.isArray(boot.questions) ? boot.questions : [];
let questions = authenticated ? bootQuestions : applyLocalProgress(bootQuestions);
let tab = "all";
let selectedHintType = null;
let selectedTagIds = [];
let shuffledIds = null;
let currentIndex = 0;
let markedIds = new Set();
let favoritedSources = new Set();

/** 当前题的作答状态（换题即重置） */
let answerState = { questionId: null, inputs: {}, submitted: false };
/** 收藏 / 标记操作后的提示文案 */
let collectionMessage = "";
/** 标记输入区是否展开 */
let showMarkInput = false;
let markLabel = MARK_LABELS[0];
let markNote = "";

/* ---------------- 纯函数 ---------------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 答案比对前的处理：只去首尾空格，不做大小写归一 */
function normalize(value) {
  return String(value ?? "").trim();
}

function isBlankCorrect(blank, userInput) {
  const value = normalize(userInput);
  if (value === "") return false;
  return (blank.answer ?? []).some((answer) => normalize(answer) === value);
}

function inputWidth(blank) {
  const longest = (blank.answer ?? []).reduce((max, ans) => Math.max(max, ans.length), 0);
  return Math.min(MAX_INPUT_CH, Math.max(MIN_INPUT_CH, longest + 2));
}

function blankList(question) {
  return [...question.blanks].sort((a, b) => a.blankIndex - b.blankIndex);
}

/* ---------------- 筛选与统计 ---------------- */

/**
 * 当前作用域内的题目（按卷 / 按来源收窄）。
 *
 * 抽成独立函数是因为它有两个消费者：byTab() 与 tabCounts()。
 * 此前 tabCounts 直接对全量 questions 计数，于是从「自由刷这卷」进来时
 * 页签上写着 500、下面却写「当前 3 题」——用户会以为筛选坏了。
 */
function scopedQuestions() {
  // 两级作用域：先按试卷收窄（从「自由刷这卷」进来时），再按来源。
  // 试卷优先于 source——同一场考试的 source 文本可能因手改而略有出入，
  // paperId 才是可靠归属。
  let scoped = paperIdFilter
    ? questions.filter((question) => question.paperId === paperIdFilter)
    : questions;
  if (sourceFilter) {
    scoped = scoped.filter((question) => question.source === sourceFilter);
  }
  return scoped;
}

function byTab() {
  const scoped = scopedQuestions();

  if (tab === "wrong") return scoped.filter((question) => question.wrongCount > 0);
  if (tab === "mastered") return scoped.filter((question) => question.status === "mastered");
  if (tab === "marked") return scoped.filter((question) => markedIds.has(question.id));
  if (tab === "favorites") {
    return scoped.filter((question) => favoritedSources.has(question.source));
  }
  return scoped;
}

function filtered() {
  const base = byTab();
  if (selectedHintType === null && selectedTagIds.length === 0) return base;

  return base.filter((question) => {
    if (
      selectedHintType !== null &&
      !question.blanks.some((blank) => blank.hintType === selectedHintType)
    ) {
      return false;
    }
    if (selectedTagIds.length > 0) {
      const questionTags = question.blanks.flatMap((blank) => blank.tagIds ?? []);
      // 多标签取交集：题目必须同时命中所有选中标签
      if (!selectedTagIds.every((tagId) => questionTags.includes(tagId))) return false;
    }
    return true;
  });
}

function tagCounts() {
  const map = new Map();
  const base = byTab();
  const matchesHint = (question) =>
    selectedHintType === null ||
    question.blanks.some((blank) => blank.hintType === selectedHintType);

  (tagDictionary?.tags ?? []).forEach((tag) => {
    if (tag.parentId === null) return;
    map.set(
      tag.id,
      base.filter((question) => {
        if (!matchesHint(question)) return false;
        return question.blanks.some((blank) => (blank.tagIds ?? []).includes(tag.id));
      }).length
    );
  });
  return map;
}

function ordered() {
  const list = filtered();
  if (!shuffledIds) return list;
  const visible = new Map(list.map((question) => [question.id, question]));
  return shuffledIds.map((id) => visible.get(id)).filter(Boolean);
}

function tabCounts() {
  // 与 byTab 同口径：数字必须反映「当前范围内有多少题」，
  // 而不是全库有多少题，否则页签上的角标和下面的「当前 N 题」自相矛盾
  const scoped = scopedQuestions();
  return {
    all: scoped.length,
    wrong: scoped.filter((question) => question.wrongCount > 0).length,
    mastered: scoped.filter((question) => question.status === "mastered").length,
    marked: scoped.filter((question) => markedIds.has(question.id)).length,
    favorites: scoped.filter((question) => favoritedSources.has(question.source)).length,
  };
}

function currentQuestion() {
  const list = ordered();
  return list[Math.min(currentIndex, Math.max(0, list.length - 1))];
}

/* ---------------- 渲染：模式切换 ---------------- */

function renderTabs() {
  const container = document.getElementById("practice-tabs");
  if (!container) return;
  const counts = tabCounts();

  container.innerHTML = TABS.map((item) => {
    const active = tab === item.id;
    return `
      <button
        type="button"
        role="tab"
        aria-selected="${active ? "true" : "false"}"
        data-tab="${item.id}"
        class="min-h-11 rounded-lg px-4 py-2 text-xs font-medium transition ${
          active ? "bg-ink text-surface" : "text-ink hover:bg-surface-alt"
        }"
      >${escapeHtml(item.label)}<span class="${active ? "ml-1.5 text-surface opacity-60" : "ml-1.5 text-faint"}">${counts[item.id]}</span></button>
    `;
  }).join("");

  const restore = document.getElementById("practice-restore");
  if (restore) restore.hidden = !shuffledIds;

  const shuffle = document.getElementById("practice-shuffle");
  if (shuffle) shuffle.disabled = ordered().length < 2;
}

/* ---------------- 渲染：筛选栏 ---------------- */

function renderFilter() {
  const container = document.getElementById("practice-filter");
  if (!container) return;

  const counts = tagCounts();
  const hasFilter = selectedHintType !== null || selectedTagIds.length > 0;
  const list = ordered();

  const hintButtons = [
    `<button
        type="button"
        data-hint-type=""
        class="min-h-11 rounded-full border px-4 py-2 text-xs font-medium transition ${
          selectedHintType === null ? "bg-ink text-surface" : "border-line text-ink hover:bg-surface-alt"
        }"
      >全部</button>`,
    ...HINT_TYPES.map((hintType) => {
      const selected = selectedHintType === hintType;
      const color = HINT_TYPE_COLORS[hintType];
      const style = selected
        ? `background-color: ${color}; border-color: ${color}; color: #ffffff;`
        : `border-color: ${color}66; color: ${color};`;
      return `<button
        type="button"
        data-hint-type="${escapeHtml(hintType)}"
        class="min-h-11 rounded-full border px-4 py-2 text-xs font-medium transition"
        style="${style}"
      >${escapeHtml(hintType)}</button>`;
    }),
  ].join("");

  const active = (tagDictionary?.tags ?? []).filter((tag) => tag.isActive);
  const groups = active
    .filter((tag) => tag.parentId === null)
    .map((parent) => ({
      parent,
      children: active.filter((tag) => tag.parentId === parent.id),
    }));

  const groupHtml = groups.map((group) => {
    const children = group.children.map((tag) => {
      const selected = selectedTagIds.includes(tag.id);
      const count = counts.get(tag.id) ?? 0;
      const cls = selected
        ? "font-medium text-white"
        : count === 0
          ? "cursor-not-allowed text-faint"
          : "border border-line text-ink hover:bg-surface-alt";
      const style = selected ? `background-color: ${tag.color};` : "";
      return `<button
        type="button"
        data-tag="${escapeHtml(tag.id)}"
        ${count === 0 && !selected ? "disabled" : ""}
        class="min-h-11 rounded-lg px-3 py-2 text-xs transition ${cls}"
        ${style ? `style="${style}"` : ""}
      >${escapeHtml(tag.name)}<span class="${selected ? "ml-1 text-surface opacity-60" : "ml-1 text-faint"}">${count}</span></button>`;
    }).join("");

    return `<div class="flex flex-wrap items-center gap-2">
      <span class="mr-1 flex-shrink-0 text-xs font-semibold text-muted">${escapeHtml(group.parent.name)}</span>
      ${children}
    </div>`;
  }).join("");

  container.innerHTML = `
    <div class="mb-4 flex flex-wrap items-center gap-2">
      ${hintButtons}
      <span class="ml-auto text-xs text-muted">共 ${tabCounts()[tab]} 题，当前 ${list.length} 题</span>
      ${
        hasFilter
          ? `<button type="button" data-action="reset-filter" class="min-h-11 rounded-lg px-3 py-2 text-xs text-muted transition hover:bg-surface-alt">重置筛选</button>`
          : ""
      }
    </div>
    <div class="space-y-3">${groupHtml}</div>
  `;
}

/* ---------------- 渲染：进度与翻页 ---------------- */

function renderPager() {
  const pager = document.getElementById("practice-pager");
  const counter = document.getElementById("practice-counter");
  const prev = document.getElementById("practice-prev");
  const next = document.getElementById("practice-next");
  if (!pager) return;

  const list = ordered();
  if (list.length === 0) {
    pager.hidden = true;
    return;
  }
  pager.hidden = false;
  if (counter) {
    counter.textContent = `第 ${currentIndex + 1} / ${list.length} 题${shuffledIds ? " · 随机顺序" : ""}`;
  }
  if (prev) prev.disabled = currentIndex === 0;
  if (next) next.disabled = currentIndex >= list.length - 1;
}

/* ---------------- 渲染：题目卡片 ---------------- */

function correctIcon() {
  return `<svg viewBox="0 0 16 16" aria-hidden="true" class="h-4 w-4 shrink-0 text-success" fill="none"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function wrongIcon() {
  return `<svg viewBox="0 0 16 16" aria-hidden="true" class="h-4 w-4 shrink-0 text-danger" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function renderCard() {
  const container = document.getElementById("practice-card");
  const emptyBox = document.getElementById("practice-empty");
  const emptyText = document.getElementById("practice-empty-text");
  const wrongHint = document.getElementById("practice-wrong-hint");
  const collection = document.getElementById("practice-collection");
  if (!container) return;

  const question = currentQuestion();

  if (!question) {
    container.innerHTML = "";
    if (collection) collection.innerHTML = "";
    if (wrongHint) wrongHint.hidden = true;
    if (emptyBox) emptyBox.hidden = false;
    if (emptyText) {
      // 按卷筛选时空，说清是哪一卷没有符合条件的题，
      // 否则用户会以为是整个题库空了
      const scope = paperIdFilter
        ? `${boot.paperName ?? "这一卷"}`
        : sourceFilter
          ? sourceFilter
          : "";
      emptyText.textContent = scope
        ? `${EMPTY_TEXT[tab]}（当前范围：${scope}）`
        : EMPTY_TEXT[tab];
    }
    return;
  }

  if (emptyBox) emptyBox.hidden = true;

  const blanks = blankList(question);
  const submitted = answerState.submitted && answerState.questionId === question.id;
  const results = submitted
    ? blanks.map((blank) => isBlankCorrect(blank, answerState.inputs[blank.blankIndex] ?? ""))
    : null;
  const wrongCount = results ? results.filter((ok) => !ok).length : 0;
  const allCorrect = results !== null && wrongCount === 0;

  const tagMap = new Map((tagDictionary?.tags ?? []).map((tag) => [tag.id, tag]));

  // 原句按空格拆片段，交错渲染
  const segments = question.originalSentence.split(BLANK_PLACEHOLDER);
  const sentenceHtml = segments.map((text, index) => {
    const blank = blanks[index];
    if (!blank) return escapeHtml(text);

    const isCorrect = results ? results[index] : null;
    const nextSegment = segments[index + 1] ?? "";
    // 原句里空格后已有括号时，认为提示词已内嵌，不再补写
    const hintInSentence = /^\s*\(/.test(nextSegment);
    const hint =
      blank.hintWord && !hintInSentence
        ? `<span class="blank-slot ml-0.5 whitespace-nowrap text-base sm:text-lg">(${escapeHtml(blank.hintWord)})</span>`
        : "";

    let boxClass = "border-line text-ink focus:border-primary focus:bg-primary-soft/40";
    if (submitted) {
      boxClass = isCorrect
        ? "border-success bg-success-soft text-success"
        : "border-danger bg-danger-soft text-danger";
    }

    const inputHtml = `<input
      type="text"
      data-blank="${blank.blankIndex}"
      value="${escapeHtml(answerState.inputs[blank.blankIndex] ?? "")}"
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
  }).join("");

  const submitBlock = submitted
    ? ""
    : `<div class="mt-6">
        <button type="button" data-action="submit" class="min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover sm:w-auto sm:px-8">提交答案</button>
        <p class="mt-2 text-xs text-faint">输入答案后按回车可跳到下一个空，最后一个空回车直接提交。注意区分大小写，按考试要求精确拼写。</p>
      </div>`;

  const resultBanner = results
    ? `<div class="${
        allCorrect
          ? "mt-5 rounded-xl border border-success/40 bg-success-soft px-4 py-3 text-sm font-medium text-success"
          : "mt-5 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-medium text-danger"
      }">${allCorrect ? "全部正确！" : `答错 ${wrongCount} 个，查看解析`}</div>`
    : "";

  let analysisHtml = "";
  if (submitted) {
    const blanksHtml = blanks.map((blank, index) => {
      const isCorrect = results ? results[index] : false;
      const tags = (blank.tagIds ?? []).map((id) => tagMap.get(id)).filter(Boolean);
      const tagPills = tags
        .map(
          (tag) =>
            `<span class="rounded-full px-2 py-0.5 text-xs font-medium text-white" style="background-color: ${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>`
        )
        .join("");

      return `<div class="rounded-xl border border-line bg-surface p-4">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="text-sm font-semibold text-ink">第 ${blank.blankIndex} 空</span>
          <span class="${
            isCorrect
              ? "rounded bg-success-soft px-2 py-0.5 text-xs font-medium text-success"
              : "rounded bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger"
          }">${isCorrect ? "答对" : "答错"}</span>
          <span class="rounded bg-surface-alt px-2 py-0.5 text-xs text-muted">${escapeHtml(blank.hintType)}</span>
          <span class="blank-slot rounded bg-surface-alt px-2 py-0.5 text-xs text-ink">答案：${escapeHtml((blank.answer ?? []).join(" / ") || "未填写")}</span>
        </div>
        ${tags.length > 0 ? `<div class="mb-3 flex flex-wrap gap-1.5">${tagPills}</div>` : ""}
        <p class="text-sm leading-6 text-muted">${escapeHtml(blank.trapAnalysis || "尚未填写命题意图与判断依据。")}</p>
      </div>`;
    }).join("");

    analysisHtml = `<section class="border-t border-line bg-surface-alt px-5 py-6 sm:px-7">
      <h3 class="mb-4 text-sm font-semibold text-ink">出题人视角解析</h3>
      <div class="space-y-4">${blanksHtml}</div>
      <p class="mt-4 text-xs text-faint">来源：${escapeHtml(question.source)}</p>
      <div class="mt-5 flex flex-col gap-3 sm:flex-row">
        <button type="button" data-action="next" class="min-h-11 flex-1 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover">下一题</button>
        <button type="button" data-action="master" class="min-h-11 flex-1 rounded-xl border border-success/40 bg-success-soft px-6 py-3 text-sm font-medium text-success transition hover:bg-success/20">标记为已掌握</button>
      </div>
    </section>`;
  }

  container.innerHTML = `<article class="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
    <header class="flex items-center justify-between border-b border-line px-5 py-3 sm:px-7">
      <span class="text-xs text-muted">来源：${escapeHtml(question.source)}</span>
      <span class="${
        question.status === "mastered"
          ? "rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success"
          : "rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-medium text-warning"
      }">${question.status === "mastered" ? "已掌握" : "未掌握"}</span>
    </header>
    <div class="px-5 py-6 sm:px-7 sm:py-8">
      ${passageBlock(question)}
      <p class="text-base leading-loose text-ink sm:text-lg">${sentenceHtml}</p>
      ${submitBlock}
      ${resultBanner}
    </div>
    ${analysisHtml}
  </article>`;

  if (wrongHint) {
    // 从没做错的题（绝大多数新题）不该显示「做错了 0 次」：
    // 既是无意义信息，又让学生以为系统在没作答时就判定了结果
    if (Number(question.wrongCount) > 0) {
      wrongHint.hidden = false;
      wrongHint.textContent = `本题做错了 ${question.wrongCount} 次`;
    } else {
      wrongHint.hidden = true;
      wrongHint.textContent = "";
    }
  }

  renderCollection(question);

  // 换题后自动聚焦第一个空（每题只聚焦一次，避免重渲染抢焦点；提交后不聚焦）
  if (!submitted && blanks.length > 0 && container.dataset.focusedFor !== question.id) {
    const first = container.querySelector('input[data-blank="' + blanks[0].blankIndex + '"]');
    if (first) {
      first.focus();
      container.dataset.focusedFor = question.id;
    }
  }
}

/* ---------------- 渲染：收藏与标记 ---------------- */

function renderCollection(question) {
  const container = document.getElementById("practice-collection");
  if (!container) return;

  if (!authenticated) {
    container.innerHTML = "";
    return;
  }

  const isMarked = markedIds.has(question.id);
  const isFavorited = favoritedSources.has(question.source);

  const markInput = showMarkInput
    ? `<div class="mt-3 space-y-2 border-t border-line pt-3">
        <div class="flex flex-wrap items-center gap-2">
          ${MARK_LABELS.map(
            (item) => `<button type="button" data-mark-label="${escapeHtml(item)}" class="min-h-11 rounded-full px-3 py-1 text-xs transition ${
              markLabel === item
                ? "bg-primary text-on-primary"
                : "border border-line bg-surface text-muted hover:bg-surface-alt"
            }">${escapeHtml(item)}</button>`
          ).join("")}
        </div>
        <input type="text" data-mark-note value="${escapeHtml(markNote)}" placeholder="备注（可选），如：课上重点讲过" class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs outline-none transition focus:border-primary">
        <div class="flex gap-2">
          <button type="button" data-action="mark-confirm" class="min-h-11 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-on-primary transition hover:bg-primary-hover">确认标记</button>
          <button type="button" data-action="mark-cancel" class="min-h-11 rounded-lg border border-line px-4 py-1.5 text-xs text-muted transition hover:bg-surface-alt">取消</button>
        </div>
      </div>`
    : "";

  container.innerHTML = `<div class="rounded-xl border border-line bg-surface-alt px-4 py-3">
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" data-action="favorite" class="min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        isFavorited
          ? "bg-warning-soft text-warning"
          : "border border-line bg-surface text-muted hover:bg-surface-alt"
      }">${isFavorited ? "已收藏本卷" : "收藏本卷"}</button>
      <button type="button" data-action="mark" class="min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        isMarked
          ? "bg-danger-soft text-danger"
          : "border border-line bg-surface text-muted hover:bg-surface-alt"
      }">${isMarked ? "取消标记" : "标记本题"}</button>
      ${collectionMessage ? `<span class="text-xs text-muted">${escapeHtml(collectionMessage)}</span>` : ""}
    </div>
    ${markInput}
  </div>`;
}

/* ---------------- 渲染入口 ---------------- */

function renderAll() {
  const list = ordered();
  if (currentIndex > Math.max(0, list.length - 1)) {
    currentIndex = Math.max(0, list.length - 1);
  }
  renderTabs();
  renderFilter();
  renderPager();
  renderCard();
}

/** 首次进入某题时重置作答状态并聚焦 */
function ensureAnswerState(question) {
  if (!question) return;
  if (answerState.questionId !== question.id) {
    answerState = { questionId: question.id, inputs: {}, submitted: false };
    collectionMessage = "";
    showMarkInput = false;
    markNote = "";
  }
}

/* ---------------- 交互 ---------------- */

function goTo(index) {
  const list = ordered();
  currentIndex = Math.min(Math.max(index, 0), Math.max(0, list.length - 1));
  ensureAnswerState(currentQuestion());
  renderAll();
}

function handleSubmit() {
  const question = currentQuestion();
  if (!question || answerState.submitted) return;

  const blanks = blankList(question);
  // 从 DOM 读最新输入，避免依赖重渲染
  document.querySelectorAll("#practice-card input[data-blank]").forEach((input) => {
    answerState.inputs[input.dataset.blank] = input.value;
  });

  const perBlank = blanks.map((blank) => isBlankCorrect(blank, answerState.inputs[blank.blankIndex] ?? ""));
  const isAllCorrect = perBlank.every(Boolean);
  const wrongCount = perBlank.filter((ok) => !ok).length;
  const answers = blanks.map((blank) => normalize(answerState.inputs[blank.blankIndex] ?? ""));

  answerState.submitted = true;
  renderAll();

  // 上报记录；答错时累加错次并即时更新界面
  void submitRecord(question.id, isAllCorrect, wrongCount, answers);
  if (!isAllCorrect) {
    if (!authenticated) {
      bumpLocalProgress(question.id);
    }
    questions = questions.map((item) =>
      item.id === question.id ? { ...item, wrongCount: item.wrongCount + 1 } : item
    );
    renderAll();
  }
}

async function handleMarkMastered() {
  const question = currentQuestion();
  if (!question) return;

  if (!authenticated) {
    setLocalProgressStatus(question.id, "mastered");
  } else {
    // 失败必须告诉用户，而且**不要先改本地状态**：之前是无 catch 的 fire-and-forget，
    // 界面稳稳显示「已掌握」，刷新后打回原形，用户整理错题的成果看起来白干
    try {
      await api.setProgress(question.id, "mastered");
    } catch (error) {
      notifyError(error, {
        details: ["这道题的掌握状态没有被保存，刷新后会恢复原样"],
        retry: () => void handleMarkMastered(),
      });
      return;
    }
  }
  questions = questions.map((item) =>
    item.id === question.id ? { ...item, status: "mastered" } : item
  );
  renderAll();
}

/**
 * 收藏 / 取消收藏。
 *
 * busy 守卫是必需的：服务端是 toggle 语义，网络慢时双击会「加了又取消」，
 * 最终状态与用户预期相反，而且第二次点击的 collectionMessage 会覆盖第一次的结果。
 */
let favoriteBusy = false;

async function toggleFavorite() {
  const question = currentQuestion();
  if (!question || !authenticated || favoriteBusy) return;
  favoriteBusy = true;
  collectionMessage = "";
  try {
    const result = await api.toggleFavorite(question.source);
    collectionMessage = result.message;
    await loadCollectionState(true);
  } catch (error) {
    collectionMessage = error?.message ?? "操作失败";
    notifyError(error, { retry: () => void toggleFavorite() });
  } finally {
    favoriteBusy = false;
  }
  renderAll();
}

let markBusy = false;

async function toggleMark() {
  const question = currentQuestion();
  if (!question || !authenticated || markBusy) return;
  markBusy = true;
  collectionMessage = "";
  const isMarked = markedIds.has(question.id);
  try {
    const result = isMarked
      ? await api.toggleMark(question.id)
      : await api.toggleMark(question.id, markLabel, markNote.trim() || undefined);
    collectionMessage = result.message;
    if (!isMarked) {
      showMarkInput = false;
      markNote = "";
    }
    await loadCollectionState(true);
  } catch (error) {
    collectionMessage = error?.message ?? "操作失败";
    notifyError(error, { retry: () => void toggleMark() });
  } finally {
    markBusy = false;
  }
  renderAll();
}

function shuffle() {
  const ids = ordered().map((question) => question.id);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  shuffledIds = ids;
  currentIndex = 0;
  ensureAnswerState(currentQuestion());
  renderAll();
}

function restoreOrder() {
  shuffledIds = null;
  currentIndex = 0;
  ensureAnswerState(currentQuestion());
  renderAll();
}

function handleTagClick(tagId) {
  const isSelected = selectedTagIds.includes(tagId);
  if (isSelected) {
    selectedTagIds = selectedTagIds.filter((id) => id !== tagId);
  } else {
    // 同父分类内互斥，跨分类可多选
    const tag = (tagDictionary?.tags ?? []).find((item) => item.id === tagId);
    const siblings = (tagDictionary?.tags ?? [])
      .filter((item) => item.parentId === (tag?.parentId ?? null) && item.parentId !== null)
      .map((item) => item.id);
    const next = selectedTagIds.filter((id) => !siblings.includes(id));
    selectedTagIds = [...next, tagId];
  }
  currentIndex = 0;
  ensureAnswerState(currentQuestion());
  renderAll();
}

/** 读取收藏与标记状态（登录用户） */
async function loadCollectionState(silent = false) {
  if (!authenticated) return;
  try {
    const marks = await api.getMarks();
    if (marks.authenticated) markedIds = new Set(marks.marks.map((m) => m.questionId));
    const favorites = await api.getFavorites();
    if (favorites.authenticated) {
      favoritedSources = new Set(favorites.favorites.map((f) => f.source));
    }
  } catch (error) {
    if (!silent) console.warn("[practice] 收藏与标记加载失败", error);
  }
}

/* ---------------- 事件绑定 ---------------- */

const root = document.getElementById("practice-root");

if (root) {
  root.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target || target.disabled) return;

    // 模式切换
    if (target.dataset.tab) {
      tab = target.dataset.tab;
      currentIndex = 0;
      ensureAnswerState(currentQuestion());
      renderAll();
      return;
    }

    // 提示词类型筛选（data-hint-type="" 表示「全部」）
    if ("hintType" in target.dataset) {
      const value = target.dataset.hintType;
      selectedHintType = value === "" ? null : value;
      currentIndex = 0;
      ensureAnswerState(currentQuestion());
      renderAll();
      return;
    }

    // 标签筛选
    if (target.dataset.tag) {
      handleTagClick(target.dataset.tag);
      return;
    }

    if (target.dataset.markLabel) {
      markLabel = target.dataset.markLabel;
      const noteInput = root.querySelector("input[data-mark-note]");
      if (noteInput) markNote = noteInput.value;
      renderAll();
      return;
    }

    switch (target.dataset.action) {
      case "reset-filter":
        selectedHintType = null;
        selectedTagIds = [];
        currentIndex = 0;
        ensureAnswerState(currentQuestion());
        renderAll();
        break;
      case "submit":
        handleSubmit();
        break;
      case "next":
        goTo(currentIndex + 1);
        break;
      case "master":
        handleMarkMastered();
        break;
      case "favorite":
        void toggleFavorite();
        break;
      case "mark":
        if (markedIds.has(currentQuestion()?.id ?? "")) {
          void toggleMark();
        } else {
          showMarkInput = !showMarkInput;
          renderAll();
        }
        break;
      case "mark-confirm":
        void toggleMark();
        break;
      case "mark-cancel":
        showMarkInput = false;
        renderAll();
        break;
      default:
        break;
    }
  });

  root.addEventListener("click", (event) => {
    if (event.target.id === "practice-shuffle") shuffle();
    if (event.target.id === "practice-restore") restoreOrder();
    if (event.target.id === "practice-prev") goTo(currentIndex - 1);
    if (event.target.id === "practice-next") goTo(currentIndex + 1);
  });

  // 输入：记录到状态但**不重渲染**，避免打断输入
  root.addEventListener("input", (event) => {
    const input = event.target.closest("input[data-blank]");
    if (input) {
      answerState.inputs[input.dataset.blank] = input.value;
      return;
    }
    const note = event.target.closest("input[data-mark-note]");
    if (note) markNote = note.value;
  });

  // 回车：非最后一个空跳到下一个，最后一个空提交
  root.addEventListener("keydown", (event) => {
    const input = event.target.closest("input[data-blank]");
    if (!input || event.key !== "Enter") return;
    event.preventDefault();

    const question = currentQuestion();
    if (!question || answerState.submitted) return;

    const blanks = blankList(question);
    const position = blanks.findIndex((blank) => String(blank.blankIndex) === input.dataset.blank);
    const nextBlank = blanks[position + 1];
    if (nextBlank) {
      const nextInput = root.querySelector('input[data-blank="' + nextBlank.blankIndex + '"]');
      if (nextInput) nextInput.focus();
    } else {
      handleSubmit();
    }
  });
}

/* ---------------- 启动 ---------------- */

async function init() {
  await loadCollectionState();
  ensureAnswerState(currentQuestion());
  renderAll();
}

void init();

/**
 * 完整原文（未挖空）展示块。
 *
 * 为什么要有：短文填空一道大题是一篇阅读挖多个空，代词指代、时态呼应、
 * 篇章逻辑这类空，只看挖出来的那一句判断不了。默认展开——学生特意需要
 * 上下文时才来找它，收起是例外；文章长了也可以点标题收起来。
 *
 * 没有原文的题（老题、单句题）什么都不渲染，不占地方。
 *
 * @param {object} question
 * @returns {string} HTML
 */
function passageBlock(question) {
  const passage = typeof question.passageText === "string" ? question.passageText.trim() : "";
  if (passage === "") return "";
  return `<details class="mb-5 rounded-xl border border-line bg-surface-alt p-3 sm:p-4" data-passage-block open>
    <summary class="cursor-pointer select-none text-xs font-medium text-muted">
      完整原文（未挖空，供对照；文章长了可以点这里收起）
    </summary>
    <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">${escapeHtml(passage)}</p>
  </details>`;
}
