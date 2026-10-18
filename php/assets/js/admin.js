/**
 * 题库管理交互（AI 导入在 admin-ai.js，由本文件初始化）。
 *
 * 覆盖：
 * - 页签切换
 * - 手动录入：原句拆空、逐空配置（答案 / 提示词类型 / 标签 / 解析）、实时预览、校验、保存
 * - 题库导入：导出、导入 JSON、浏览器题库上云、恢复内置示例、清空、题目列表操作
 * - 标签管理：改色、重命名、启用停用、删除、新增子标签
 *
 * 校验口径与后端 php/app/validate.php 一致（错误文案逐条对齐）。
 */

import { api } from "./api.js";
import { setFlash, takeFlash } from "./flash.js";
import { notify, notifyError, clearFeedback } from "./feedback.js";
// AI 导入必须走 import 引入：此前靠 window.setupAdminAi 全局约定，
// 而 admin-ai.js 没有被任何 script 标签加载，导致整个 AI 面板（含"复制提示词"）
// 从未绑定事件、点击无反应。import 由模块依赖图保证求值顺序，不依赖标签顺序。
import { setupAiAssistant } from "./admin-ai.js";
// 试卷管理与题目编辑：拆成独立模块，因为那部分只服务两个页签，
// 与精录、导入、标签管理没有共用状态，混在一个文件里会互相干扰
import { setupPaperAndQuestionPanels } from "./admin-papers.js";
// 组卷蓝图与虚拟卷成员编辑（第 2 期）
import { setupBlueprintPanels } from "./admin-blueprints.js";
import { iconSuccess } from "./icons.js";
import { escapeHtml } from "./escape-html.js";
// 本模块既要用 escapeHtml，也要继续对外提供它（下游模块从这儿 import）。
// 注意：只写 `export { escapeHtml } from "./escape-html.js"` **不够**——
// re-export 只把符号转发给下游，不会在本模块建立本地绑定，
// 本文件里的 escapeHtml(...) 调用会抛 ReferenceError。
export { escapeHtml };

const BLANK_PLACEHOLDER = "______";
const HINT_TYPES = ["给动词", "给名词", "给形容词", "给副词", "无提示词"];
const LOCAL_QUESTIONS_KEY = "eq_questions";
const LOCAL_TAGS_KEY = "eq_tags";

const bootElement = document.getElementById("admin-boot");
const boot = bootElement ? JSON.parse(bootElement.textContent) : null;
if (!boot) throw new Error("缺少启动数据 admin-boot");

let tagDictionary = boot.tagDictionary;
let existingIds = boot.existingIds ?? [];
/**
 * 最近一次 showNotice 的入参（原样保存，不做字符串化）。
 * 「去题库总览看看」触发整页重载时要靠它把结构化卡片交给 flash 带走，
 * 重载后由 init() 的 takeFlash() 还原。
 */
let lastNotice = null;
const tagUsage = boot.tagUsage ?? {};
const colorOptions = boot.colorOptions ?? [];

/** 供 admin-papers.js 复用的上下文（该模块不重复解析 boot） */
export const adminContext = {
  boot,
  api,
  getTagDictionary: () => tagDictionary,
  hintTypes: HINT_TYPES,
};

/**
 * 顶部成功提示（沿用页面原有的 #admin-notice，位置样式不变）。
 *
 * 传空串表示「清掉当前提示」——出错时用它先把上一条成功提示擦掉，
 * 免得两条提示同时挂在页面上。
 */
/**
 * 顶部提示条。
 *
 * 两种用法：
 * - 字符串：一行纯文本（保存成功、导出完成这类简单提示）
 * - 对象：结构化成功卡片，用于「导入 N 道题」这种信息量大的场景 ——
 *   把数量、来源、跳过数、自动修正分开排，长来源名能换行显示，
 *   再给一个「去题库总览看看」的入口，不用用户自己找页签
 *
 * 会把入参记到 lastNotice：「去题库总览看看」需要整页重载（题库总览是 PHP
 * 首屏直出的，不重载就看不到刚导入的题），而重载会把这张卡片一起冲掉，
 * 靠 lastNotice 才能把它完整地交给 flash 带走。
 */
function showNotice(payload) {
  const box = document.getElementById("admin-notice");
  if (!box) return;
  lastNotice = payload || null;
  if (!payload) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }

  if (typeof payload === "string") {
    box.textContent = payload;
    box.hidden = false;
    return;
  }

  const count = Number(payload.count ?? 0);
  const source = String(payload.source ?? "").trim();
  const skipped = Number(payload.skipped ?? 0);
  const repairs = Array.isArray(payload.repairs) ? payload.repairs : [];

  const extras = [];
  if (skipped > 0) extras.push(`跳过 ${skipped} 道（未勾选）`);
  if (repairs.length > 0) extras.push(`已自动修正：${repairs.join("；")}`);

  box.innerHTML = `<div class="rounded-xl border border-success/40 bg-success-soft p-4">
    <div class="flex items-start gap-3">
      ${iconSuccess("mt-0.5 h-5 w-5 shrink-0 text-success")}
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-success">成功导入 ${count} 道题目</p>
        ${source ? `<p class="mt-1 text-xs leading-5 text-muted">来源：<span class="break-all">${escapeHtml(source)}</span></p>` : ""}
        ${extras.length > 0 ? `<p class="mt-1 text-xs leading-5 text-muted">${escapeHtml(extras.join(" · "))}</p>` : ""}
        <button type="button" data-action="notice-goto-questions"
          class="mt-2 min-h-11 rounded-lg border border-success/40 px-3 py-1.5 text-[11px] font-medium text-success transition hover:bg-success-soft">
          去题库总览看看
        </button>
      </div>
    </div>
  </div>`;
  box.hidden = false;
}

/* ---------------- 页签切换 ---------------- */

function switchTab(tab) {
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== tab;
  });
  const aiRoot = document.getElementById("admin-ai-root");
  if (aiRoot) aiRoot.hidden = tab !== "ai";

  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    const active = button.dataset.adminTab === tab;
    button.setAttribute("aria-selected", active ? "true" : "false");
    // 只切配色，**不重建整个 className**。
    // 布局类（shrink-0 / whitespace-nowrap / 横滚容器）由 PHP 模板统一负责，
    // JS 再抄一份的话，改模板时很容易漏掉这边——v3.6.8 就漏过一次：
    // 模板改成了手机横滚，JS 里还是旧的 flex-1，一点页签布局就被打回原形
    // （手机上 7 个页签重新折成 7 行，用户描述为「原形毕露」）。
    button.classList.toggle("bg-ink", active);
    button.classList.toggle("text-surface", active);
    button.classList.toggle("text-muted", !active);
    button.classList.toggle("hover:bg-surface-alt", !active);
  });

  // 页签写回 URL：7 个平级页签的页签栏是**唯一的定位信号**，
  // 不写 hash 的话浏览器后退 / 刷新都会跳回「手动录入」，
  // 用户刚在题库总览改完东西一按后退就丢了位置。
  // 用 replaceState 而不是直接赋值 location.hash：后者每切一次就往历史里塞一条，
  // 后退键会退化成「逐个页签回退」，比现在更糟。
  if (window.location.hash !== "#" + tab) {
    history.replaceState(null, "", "#" + tab);
  }

  // 切页签时收掉上一条提示，并把 lastNotice 一起清掉——
  // 否则提示条虽然看不见了，lastNotice 还留着上一条，flash 会把它带去重载后的页面。
  //
  // ⚠️ 不能走 showNotice(null)：它会清空 box.innerHTML。而 init() 的顺序是
  // 「先 takeFlash() 恢复提示，再按 hash 点页签按钮」——走 showNotice 的话，
  // 刚由 flash 还原的「导入 N 道题」卡片会被这一步立刻擦掉，用户看到的就是
  // 「点完按钮提示消失了」。所以这里只隐藏 + 清变量，不动 DOM 内容。
  const notice = document.getElementById("admin-notice");
  if (notice) notice.hidden = true;
  lastNotice = null;
}

/**
 * 导入成功卡片里的「去题库总览看看」。
 *
 * 必须**整页重载**，不能只切页签
 * --------------------------------
 * 题库总览面板是 PHP 首屏直出的（views/admin.php 里 foreach 出题目列表），
 * 不是客户端渲染。切页签只是把 hidden 属性翻过来，**列表里的 HTML 还是
 * 首屏那份**——刚导入的题不会出现在里面，用户以为没导入成功，只能手动刷新。
 *
 * 带 hash 是为了重载后仍落在「题库总览」页签，不用自己再切回来
 * （admin.js 启动时读 hash 决定落在哪个页签，与 admin-blueprints.js 的
 * reloadKeepingTab 同一套做法）。
 */
document.getElementById("admin-notice")?.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="notice-goto-questions"]')) {
    // 整页重载会把提示条一起刷掉，先用 flash 把导入结果挪过去，由 init() 重载后
    // 还原成同一张卡片——不然用户点完按钮提示就消失了，像是白点了一下。
    // 存结构化 payload 而非 innerText：showNotice 能重绘出带数量/来源/跳过数的
    // 完整卡片，存纯文本只会退化成一两行字。
    if (lastNotice) setFlash(lastNotice);
    window.location.hash = "questions";
    window.location.reload();
  }
});

/* ================================================================== */
/* 手动录入                                                            */
/* ================================================================== */

/**
 * 规范化原句里的空格占位符。
 * 手输、粘贴、中文输入法、从网页复制都可能混入"长得像下划线"的字符：
 * - 全角下划线 ＿（中文标点 / 复制来源常见）
 * - 中文输入法 Shift+减号 打出的破折号 ——（连续 em/en dash）
 * - 下划线数量不是 6 个（连打 3 个以上也视为一个空）
 * 全部统一成标准占位符，保证识别、预览与入库的数据格式一致。
 */
function normalizeSentence(text) {
  return String(text)
    .replace(/＿/g, "_")
    .replace(/[—–]{2,}/g, BLANK_PLACEHOLDER)
    .replace(/_{3,}/g, BLANK_PLACEHOLDER);
}

/** 空格位置与提示词提取（与 ManualEntry 的 parseSentence 同规则） */
function parseSentence(sentence) {
  const segments = normalizeSentence(sentence).split(BLANK_PLACEHOLDER);
  const count = segments.length - 1;
  const hintWords = [];
  for (let i = 0; i < count; i += 1) {
    const next = segments[i + 1] ?? "";
    const matched = /\(\s*([^)]*?)\s*\)/.exec(next);
    hintWords.push(matched ? matched[1] : null);
  }
  return { hintWords, count };
}

/** 答案切分：按 / 或逗号，不能用空格切（多词答案会被拆散） */
function splitAnswers(text) {
  return String(text)
    .split(/[/,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 录题草稿状态 */
let draft = {
  sentence: "",
  source: "",
  blanks: [], // { answer, hintType, tagIds, trapAnalysis }
};

/** 逐空配置区 */
function renderBlanks() {
  const container = document.getElementById("admin-blanks");
  const countBox = document.getElementById("admin-blank-count");
  if (!container) return;

  const parsed = parseSentence(draft.sentence);
  if (countBox) {
    if (parsed.count > 0) {
      countBox.textContent = `识别到 ${parsed.count} 个空格，空位已自动拆好`;
      countBox.className = "mt-1.5 text-xs text-faint";
    } else if (String(draft.sentence).trim() === "") {
      countBox.textContent = "输入或粘贴原句后，这里会自动拆出各个空位";
      countBox.className = "mt-1.5 text-xs text-faint";
    } else {
      countBox.textContent = "未识别到空格：请在要填空的位置放 6 个下划线（英文半角），例如 ______";
      countBox.className = "mt-1.5 text-xs text-danger";
    }
  }

  // 还没有空位时，先说明"拆出空位后会有什么"，
  // 避免用户以为页面只能填原句和来源（标签、解析都挂在每个空的配置卡里）
  if (parsed.count === 0) {
    container.innerHTML = `<div class="rounded-xl border border-dashed border-line bg-surface p-5 text-sm leading-6 text-muted">
  还没有空位。识别出空位后，<span class="font-medium text-ink">每个空会生成一张配置卡</span>：答案、提示词类型、知识点标签、命题意图与判断依据。
</div>`;
    renderPreview();
    return;
  }

  const active = tagDictionary.tags.filter((tag) => tag.isActive);
  const groups = active
    .filter((tag) => tag.parentId === null)
    .map((parent) => ({
      parent,
      children: active.filter((tag) => tag.parentId === parent.id),
    }))
    .filter((group) => group.children.length > 0);

  container.innerHTML = draft.blanks
    .map((blank, index) => {
      const hintWord = parsed.hintWords[index];
      const hintBadge = hintWord
        ? `<span class="blank-slot rounded bg-surface-alt px-2 py-0.5 text-xs text-muted">提示词 (${escapeHtml(hintWord)})</span>`
        : `<span class="rounded bg-surface-alt px-2 py-0.5 text-xs text-faint">无提示词</span>`;

      const tagGroups = groups
        .map(
          (group) => `<div>
            <p class="mb-1.5 text-xs font-semibold text-muted">${escapeHtml(group.parent.name)}</p>
            <div class="flex flex-wrap gap-1.5">${group.children
              .map((tag) => {
                const selected = blank.tagIds.includes(tag.id);
                const cls = selected
                  ? "rounded-full px-2.5 py-1 text-xs transition font-medium text-white"
                  : "rounded-full px-2.5 py-1 text-xs transition border border-line bg-surface text-ink hover:bg-surface-alt";
                const style = selected ? ` style="background-color: ${escapeHtml(tag.color)}"` : "";
                return `<button type="button" data-blank-index="${index}" data-pick-tag="${escapeHtml(tag.id)}" data-tag-name="${escapeHtml(tag.name)}" class="${cls}"${style}>${escapeHtml(tag.name)}</button>`;
              })
              .join("")}</div>
          </div>`
        )
        .join("");

      return `<div class="rounded-xl border border-line bg-surface p-5" data-blank-card="${index}">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-semibold text-ink">第 ${index + 1} 个空</h3>
          ${hintBadge}
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted">答案（多个用 / 分隔）</label>
            <input type="text" data-blank-answer="${index}" value="${escapeHtml(blank.answer)}" placeholder="written / was written" class="blank-slot w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
            <p class="mt-1.5 text-xs text-faint">解析为 [${escapeHtml(splitAnswers(blank.answer).join(", ") || "空")}]</p>
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted">提示词类型（需人工确认）</label>
            <select data-blank-hint="${index}" class="min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
              ${HINT_TYPES.map((type) => `<option value="${escapeHtml(type)}"${type === blank.hintType ? " selected" : ""}>${escapeHtml(type)}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="mt-3">
          <label class="mb-1.5 block text-xs font-medium text-muted">知识点标签</label>
          <input type="search" data-blank-tag-search="${index}" placeholder="搜索标签" class="mb-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
          <div class="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-line bg-surface-alt p-3" data-blank-tag-box="${index}">${tagGroups}</div>
          ${blank.tagIds.length > 0 ? `<p class="mt-2 text-xs text-muted">已选 ${blank.tagIds.length} 个标签</p>` : ""}
        </div>

        <div class="mt-3">
          <label class="mb-1.5 block text-xs font-medium text-muted">命题意图与判断依据</label>
          <textarea data-blank-trap="${index}" rows="3" placeholder="空格位于名词与介词之间，是过去分词作后置定语，修饰被动含义的 book。" class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">${escapeHtml(blank.trapAnalysis)}</textarea>
        </div>
      </div>`;
    })
    .join("");

  renderPreview();
}

/** 组装成题目对象 */
function buildQuestion(id) {
  const parsed = parseSentence(draft.sentence);
  return {
    id,
    originalSentence: normalizeSentence(draft.sentence),
    blanks: draft.blanks.map((blank, index) => ({
      blankIndex: index + 1,
      answer: splitAnswers(blank.answer),
      hintWord: blank.hintType === "无提示词" ? null : (parsed.hintWords[index] ?? null),
      hintType: blank.hintType,
      tagIds: blank.tagIds,
      trapAnalysis: blank.trapAnalysis.trim(),
    })),
    source: draft.source.trim() || "手动录入",
    // 完整原文可空：没填就不给上下文对照
    passageText: (document.getElementById("admin-passage")?.value ?? "").trim() || null,
    schemaVersion: boot.schemaVersion ?? 1,
    status: "unmastered",
    wrongCount: 0,
    createdAt: new Date().toISOString(),
  };
}

/** 实时预览：与刷题页排版一致（只读） */
function renderPreview() {
  const container = document.getElementById("admin-preview");
  if (!container) return;

  const parsed = parseSentence(draft.sentence);
  if (parsed.count === 0) {
    container.innerHTML = `<div class="rounded-2xl border border-dashed border-line bg-surface p-10 text-center text-sm text-faint">在左侧填写原句后，这里会实时显示效果。</div>`;
    return;
  }

  const question = buildQuestion("preview");
  const tagMap = new Map(tagDictionary.tags.map((tag) => [tag.id, tag]));
  const blanks = [...question.blanks].sort((a, b) => a.blankIndex - b.blankIndex);
  const segments = question.originalSentence.split(BLANK_PLACEHOLDER);

  const sentenceHtml = segments
    .map((text, index) => {
      const blank = blanks[index];
      if (!blank) return escapeHtml(text);
      const nextSegment = segments[index + 1] ?? "";
      const hintInSentence = /^\s*\(/.test(nextSegment);
      const hint =
        blank.hintWord && !hintInSentence
          ? `<span class="blank-slot ml-0.5 whitespace-nowrap text-base sm:text-lg">(${escapeHtml(blank.hintWord)})</span>`
          : "";
      return `${escapeHtml(text)}<span class="mx-1 inline-flex items-baseline align-baseline"><span class="blank-slot border-b-2 border-line px-1.5 py-0.5 text-center text-base text-faint sm:text-lg">${escapeHtml(blank.answer[0] ?? "?")}</span>${hint}</span>`;
    })
    .join("");

  const analysis = blanks
    .map((blank) => {
      const tags = (blank.tagIds ?? []).map((id) => tagMap.get(id)).filter(Boolean);
      const pills = tags
        .map(
          (tag) =>
            `<span class="rounded-full px-2 py-0.5 text-xs font-medium text-white" style="background-color: ${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>`
        )
        .join("");
      return `<div class="rounded-xl border border-line bg-surface p-4">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="text-sm font-semibold text-ink">第 ${blank.blankIndex} 空</span>
          <span class="rounded bg-surface-alt px-2 py-0.5 text-xs text-muted">${escapeHtml(blank.hintType)}</span>
          <span class="blank-slot rounded bg-surface-alt px-2 py-0.5 text-xs text-ink">答案：${escapeHtml((blank.answer ?? []).join(" / ") || "未填写")}</span>
        </div>
        ${tags.length > 0 ? `<div class="mb-3 flex flex-wrap gap-1.5">${pills}</div>` : ""}
        <p class="text-sm leading-6 text-muted">${escapeHtml(blank.trapAnalysis || "尚未填写命题意图与判断依据。")}</p>
      </div>`;
    })
    .join("");

  container.innerHTML = `<article class="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
    <header class="flex items-center justify-between border-b border-line px-5 py-3 sm:px-7">
      <span class="text-xs text-muted">实时预览</span>
      <span class="rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-medium text-warning">未掌握</span>
    </header>
    <div class="px-5 py-6 sm:px-7 sm:py-8">
      <p class="text-base leading-loose text-ink sm:text-lg">${sentenceHtml}</p>
    </div>
    <section class="border-t border-line bg-surface-alt px-5 py-6 sm:px-7">
      <h3 class="mb-1 text-sm font-semibold text-ink">出题人视角解析</h3>
      <div class="space-y-4">${analysis}</div>
    </section>
  </article>`;
}

/** 原句变化：同步空位草稿（多退少补，尽量保留已填内容） */
function handleSentenceChange(value) {
  draft.sentence = value;
  const { hintWords, count } = parseSentence(value);
  const next = [...draft.blanks];

  if (next.length < count) {
    for (let i = next.length; i < count; i += 1) {
      next.push({
        answer: "",
        // 有提示词时默认「给名词」（需人工确认），无提示词直接「无提示词」
        hintType: hintWords[i] ? "给名词" : "无提示词",
        tagIds: [],
        trapAnalysis: "",
      });
    }
  } else if (next.length > count) {
    next.length = count;
  }

  // 提示词是在 ______ 之后才输入的，创建草稿那一刻往往还识别不到，
  // 这里按当前解析结果再同步一次；只覆盖仍是初始默认值的那些
  draft.blanks = next.map((blank, i) => {
    const hasHint = Boolean(hintWords[i]);
    if (!hasHint && blank.hintType === "无提示词") return blank;
    if (hasHint && blank.hintType === "无提示词") return { ...blank, hintType: "给名词" };
    return blank;
  });

  clearErrors();
  renderBlanks();
}

function showErrors(errors) {
  const box = document.getElementById("admin-errors");
  if (!box) return;
  box.innerHTML = errors.map((error) => `<li>· ${escapeHtml(error)}</li>`).join("");
  box.hidden = errors.length === 0;
}

function clearErrors() {
  showErrors([]);
}

/**
 * 校验一道题目（口径与后端一致）。
 * @returns {string[]} 错误列表，空数组表示通过
 */
function validateQuestion(question) {
  const errors = [];
  const sentence = typeof question.originalSentence === "string" ? question.originalSentence : "";

  const positions = [];
  const step = BLANK_PLACEHOLDER.length;
  let from = 0;
  for (;;) {
    const index = sentence.indexOf(BLANK_PLACEHOLDER, from);
    if (index === -1) break;
    positions.push(index);
    from = index + step;
  }

  if (positions.length < 1) {
    errors.push(`原句必须包含至少一个「${BLANK_PLACEHOLDER}」空格`);
  }
  if (positions.length !== question.blanks.length) {
    errors.push(
      `原句中的空格数量（${positions.length}）与 blanks 数量（${question.blanks.length}）不一致`
    );
  }

  question.blanks.forEach((blank, index) => {
    if (blank.blankIndex !== index + 1) {
      errors.push(
        `第 ${index + 1} 个空的 blankIndex 应为 ${index + 1}，实际为 ${blank.blankIndex}（须从 1 开始连续递增）`
      );
    }
  });

  const tagMap = new Map(tagDictionary.tags.map((tag) => [tag.id, tag]));
  question.blanks.forEach((blank, index) => {
    const label = `第 ${index + 1} 个空`;

    if (!Array.isArray(blank.answer) || blank.answer.length === 0) {
      errors.push(`${label}：answer 不能为空`);
    } else {
      blank.answer.forEach((ans, ansIndex) => {
        if (typeof ans !== "string" || ans.trim() === "") {
          errors.push(`${label}：answer 不能包含空字符串`);
        }
      });
      const normalized = blank.answer.map((ans) => ans.trim());
      if (new Set(normalized).size !== normalized.length) {
        errors.push(`${label}：answer 存在完全重复的项`);
      }
    }

    if (!HINT_TYPES.includes(blank.hintType)) {
      errors.push(`${label}：hintType「${blank.hintType}」无效，应为 ${HINT_TYPES.join(" / ")} 之一`);
    }
    if (blank.hintType !== "无提示词" && (blank.hintWord === null || String(blank.hintWord).trim() === "")) {
      errors.push(`${label}：hintType 为「${blank.hintType}」时必须填写 hintWord`);
    }
    if (blank.hintType === "无提示词" && blank.hintWord !== null && String(blank.hintWord).trim() !== "") {
      errors.push(`${label}：hintType 为「无提示词」时 hintWord 必须为 null`);
    }

    (blank.tagIds ?? []).forEach((tagId) => {
      const tag = tagMap.get(tagId);
      if (!tag) {
        errors.push(`${label}：标签 ${tagId} 在标签字典中不存在`);
      } else if (!tag.isActive) {
        errors.push(`${label}：标签 ${tagId}（${tag.name}）已停用`);
      }
    });

    if (String(blank.trapAnalysis ?? "").trim() === "") {
      errors.push(`${label}：trapAnalysis 不能为空`);
    }
  });

  if (existingIds.includes(question.id)) {
    errors.push(`题目 ID 重复：${question.id}`);
  }

  return errors;
}

// 保存进行中：没有这个守卫时，用户点一下觉得慢再点一下，两次请求并发，
// 会入库两道重复题，第二个回调回来还会把用户正在录入的下一道题草稿一起清空。
let savingQuestion = false;

async function handleSave() {
  if (savingQuestion) return;
  const saveButton = document.getElementById("admin-save");
  const errors0 = (() => {
    const candidate = buildQuestion(`q_${Date.now().toString(36)}`);
    return { candidate, errors: validateQuestion(candidate) };
  })();
  if (errors0.errors.length > 0) {
    showErrors(errors0.errors);
    const notice = document.getElementById("admin-save-notice");
    if (notice) notice.hidden = true;
    return;
  }

  savingQuestion = true;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "保存中…";
  }
  // 编号在 await 之后才落定：并发时两次不会共用同一个候选 id
  const id = `q_${Date.now().toString(36)}`;
  const candidate = { ...errors0.candidate, id };
  try {
    await api.pushQuestion(candidate);
    existingIds = [...existingIds, id];
    showNotice(`已保存题目 ${id}`);
    // 保留来源，方便连续录入同一套试卷
    draft = { sentence: "", source: draft.source, blanks: [] };
    const sentenceInput = document.getElementById("admin-sentence");
    if (sentenceInput) sentenceInput.value = "";
    clearErrors();
    renderBlanks();
    const saveNotice = document.getElementById("admin-save-notice");
    if (saveNotice) {
      saveNotice.textContent = "保存成功";
      saveNotice.hidden = false;
    }
  } catch (error) {
    showErrors([error?.message ?? "保存失败"]);
  } finally {
    savingQuestion = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "保存题目";
    }
  }
}

function handleClearDraft() {
  draft = { sentence: "", source: "", blanks: [] };
  const sentenceInput = document.getElementById("admin-sentence");
  const sourceInput = document.getElementById("admin-source");
  if (sentenceInput) sentenceInput.value = "";
  if (sourceInput) sourceInput.value = "";
  clearErrors();
  renderBlanks();
  const saveNotice = document.getElementById("admin-save-notice");
  if (saveNotice) saveNotice.hidden = true;
}

/* ================================================================== */
/* 数据迁移                                                            */
/* ================================================================== */

function readLocalQuestions() {
  try {
    const raw = window.localStorage.getItem(LOCAL_QUESTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function readLocalTags() {
  try {
    const raw = window.localStorage.getItem(LOCAL_TAGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearLocalCache() {
  try {
    window.localStorage.removeItem(LOCAL_QUESTIONS_KEY);
    window.localStorage.removeItem(LOCAL_TAGS_KEY);
  } catch (error) {
    console.error("[admin] 清理本地缓存失败", error);
  }
}

function handleExport(currentQuestions) {
  if (!Array.isArray(currentQuestions)) return;
  const payload = {
    questions: currentQuestions,
    tags: tagDictionary,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `english-quiz-backup-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showNotice(`已导出 ${currentQuestions.length} 道题目`);
}

/** 最近一次选择的导入文件，供「重试」复用 */
let lastImportFile = null;

async function handleImportFile(file) {
  // 记下这次的文件，重试用；File 对象读过一次后不能重复读，
  // 所以失败后靠这里再取一次（浏览器允许对同一个 File 多次 text()）
  lastImportFile = file;
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    showNotice("");
    notifyError(`文件解析失败：${error.message}`, {
      details: [
        "请确认选中的是本系统导出的 .json 文件（题库导出 / 标签导出）",
        "文件若由文本编辑器改过，检查有没有多删或多加逗号、引号",
      ],
    });
    return;
  }
  if (!Array.isArray(parsed?.questions)) {
    showNotice("");
    notifyError("文件解析失败：questions 字段必须是数组", {
      details: ["文件里应当有 questions 数组；若只是想导入标签，请选标签导出文件"],
    });
    return;
  }

  if (parsed.tags?.tags?.length) {
    await persistTags(parsed.tags);
  }

  const overwrite = window.confirm(
    `已读取 ${parsed.questions.length} 道题目。\n\n点「确定」覆盖服务端题库，点「取消」增量追加。`
  );
  try {
    if (overwrite) {
      const result = await api.pushQuestions(parsed.questions, true);
      setFlash(`已覆盖导入 ${result.added ?? parsed.questions.length} 道题目`);
    } else {
      const result = await api.pushQuestions(parsed.questions, false);
      setFlash(`已导入 ${result.added ?? 0} 道题目`);
    }
    window.location.reload();
  } catch (error) {
    notifyError(error, {
      retry: lastImportFile ? () => void handleImportFile(lastImportFile) : undefined,
    });
  }
}

/** 浏览器题库上云：把本地存储里的题目与标签整体上传覆盖 */
async function handleMigrateLocal() {
  if (!window.confirm("将把浏览器里现有的题库整体上传到服务端并覆盖，确定继续吗？")) return;

  const localQuestions = readLocalQuestions();
  const localTags = readLocalTags();
  if (localQuestions.length === 0) {
    showNotice("浏览器里没有找到题库数据");
    return;
  }

  try {
    await api.pushQuestions(localQuestions, true);
    if (localTags?.tags?.length) await api.saveTags(localTags);
    setFlash(`已上传 ${localQuestions.length} 道题目、${localTags?.tags?.length ?? 0} 个标签到服务端`);
    clearLocalCache();
    window.location.reload();
  } catch (error) {
    // 重试要调的是 handleMigrateLocal（浏览器题库上云）：
    // 之前这里写成了不存在的 handleCloudUpload，点「重试」会抛 ReferenceError
    notifyError(error, { retry: () => void handleMigrateLocal() });
  }
}

/** 恢复内置示例数据（题目 + 标签一起恢复） */
async function handleRestoreSeed() {
  const seedQuestions = boot.seedQuestions ?? [];
  const seedTags = boot.seedTags;
  if (seedQuestions.length === 0) {
    showNotice("未找到内置示例数据");
    return;
  }
  if (!window.confirm("确定要全部清除并恢复示例数据吗？")) return;
  if (!window.confirm("再次确认：已录入的题目会永久丢失，建议先导出备份。")) return;

  try {
    await api.pushQuestions(seedQuestions, true);
    if (seedTags?.tags?.length) await api.saveTags(seedTags);
    // 提示在整页刷新后由启动处取出显示（见 flash.js）
    setFlash(`已恢复内置示例数据，共 ${seedQuestions.length} 道题、${seedTags?.tags?.length ?? 0} 个标签`);
    window.location.reload();
  } catch (error) {
    notifyError(error, { retry: () => void handleRestoreSeed() });
  }
}

async function handleClearAll() {
  if (!window.confirm("确定清空服务端全部题目和标签吗？此操作不可撤销。")) return;
  if (!window.confirm("再次确认：清空后数据无法恢复，建议先导出备份。")) return;
  try {
    await api.resetBank();
    // 提示在整页刷新后由启动处取出显示（见 flash.js）
    setFlash("已清空服务端数据");
    window.location.reload();
  } catch (error) {
    notifyError(error, { retry: () => void handleClearAll() });
  }
}

/* ================================================================== */
/* 标签管理                                                            */
/* ================================================================== */

/** 下一个标签 id，如 t_043 */
function nextTagId(tags) {
  const max = tags.reduce((acc, tag) => {
    const num = Number(String(tag.id).replace(/^t_/, ""));
    return Number.isFinite(num) ? Math.max(acc, num) : acc;
  }, 0);
  return `t_${String(max + 1).padStart(3, "0")}`;
}

/**
 * 保存标签字典到服务端。
 *
 * 失败时把异常继续抛出，交给调用方提示——这里吞掉异常的话，
 * 调用方会以为保存成功，接着做下一步（比如整页刷新），改动就丢了。
 */
async function persistTags(dict) {
  const previous = tagDictionary;
  tagDictionary = dict;
  try {
    await api.saveTags(dict);
  } catch (error) {
    tagDictionary = previous; // 回滚，页面上的标签名还是原来那份
    throw error;
  }
}

function updateTags(updater) {
  const next = updater(tagDictionary.tags.map((tag) => ({ ...tag })));
  return persistTags({ ...tagDictionary, tags: next });
}

/* ---------------- 标签操作（供事件处理与「重试」共用） ---------------- */

/**
 * 点击某个标签的按钮。
 *
 * 重试时复用同一条路径——注意删除类操作会再弹一次确认框，
 * 这是有意的：不能「点重试就直接删掉」。
 */
function clickTagButton(tagId, action) {
  const selector = `[data-tag="${CSS.escape(tagId)}"] [data-action="${action}"]`;
  document.querySelector(selector)?.click();
}

/** 新增一个子标签。表单里的名字与颜色原样取用，重试时不丢用户输入 */
async function submitNewTag(parentId) {
  const form = document.querySelector(`[data-add-form][data-tag-group-parent="${CSS.escape(parentId)}"]`)
    ?? document.querySelector('[data-add-form]:not([hidden])');
  const errorBox = form?.querySelector("[data-new-tag-error]");
  const showFormError = (message) => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  };
  if (!form) return;
  if (errorBox) errorBox.hidden = true;

  const name = (form.querySelector("[data-new-tag-name]")?.value ?? "").trim();
  if (name === "") {
    showFormError("标签名不能为空");
    return;
  }
  if (tagDictionary.tags.some((tag) => tag.name === name)) {
    showFormError("已有同名标签，请换一个");
    return;
  }

  const color = form.dataset.selectedColor ?? "#64748B";
  try {
    await updateTags((tags) => [
      ...tags,
      { id: nextTagId(tags), name, parentId, color, isActive: true },
    ]);
    window.location.reload();
  } catch (error) {
    notifyError(error, { retry: () => void submitNewTag(parentId) });
  }
}

/** 改标签配色 */
async function applyTagColor(tagId, color) {
  try {
    await updateTags((tags) =>
      tags.map((tag) => (tag.id === tagId ? { ...tag, color } : tag))
    );
  } catch (error) {
    notifyError(error, { retry: () => void applyTagColor(tagId, color) });
  }
}

/** 改标签名（重试沿用用户刚输入的名字） */
async function applyTagName(tagId, name) {
  try {
    await updateTags((tags) => tags.map((tag) => (tag.id === tagId ? { ...tag, name } : tag)));
  } catch (error) {
    notifyError(error, { retry: () => void applyTagName(tagId, name) });
  }
}

/** AI 导入：把解析出的题目增量入库（来源统一打上） */
async function handleAiAppend(incoming, source) {
  const stamped = incoming.map((question) => ({
    ...question,
    // 页面上手填的来源优先；留空则用 AI 从封面生成、写在 JSON 里的来源
    source: source || question.source || "AI 生成",
  }));
  const result = await api.pushQuestions(stamped, false);
  // 提示里展示实际写库的来源（可能来自手填，也可能来自 AI 识别封面），
  // 便于当即核对 AI 有没有读对卷子信息
  const finalSource = stamped.length > 0 ? String(stamped[0].source ?? "").trim() : "";
  showNotice(`已导入 ${result.added ?? 0} 道题目${finalSource ? `，来源：${finalSource}` : ""}`);
  existingIds = [...existingIds, ...stamped.map((question) => question.id)];
  renderAi(); // 标签字典可能变化时重刷预览
}

/** AI 导入：创建字典里没有的新标签，统一挂到第一个顶级分类下 */
async function handleCreateTags(names) {
  const firstParent = tagDictionary.tags.find((tag) => tag.parentId === null);
  if (!firstParent) return;

  const next = [...tagDictionary.tags];
  names.forEach((name) => {
    if (next.some((tag) => tag.name === name)) return;
    next.push({
      id: nextTagId(next),
      name,
      parentId: firstParent.id,
      color: "#64748B",
      isActive: true,
    });
  });
  await persistTags({ ...tagDictionary, tags: next });
  setFlash(`已创建 ${names.length} 个标签`);
  window.location.reload();
}

/** 标签管理：新增子标签（在分组卡片里展开一段输入区） */
function openAddTag(parentId) {
  const group = document.querySelector(`[data-tag-group="${CSS.escape(parentId)}"]`);
  if (!group) return;
  // 分组默认是折叠的，不先展开的话新输入区会渲染在看不见的地方 ——
  // 表现为「点了没反应」
  if (typeof group.open === "boolean") {
    group.open = true;
  }
  const trigger = group.querySelector('[data-action="add-tag-open"]');
  if (!trigger || group.querySelector("[data-add-form]")) return;

  const form = document.createElement("div");
  form.setAttribute("data-add-form", "1");
  form.className = "mt-3 rounded-lg border border-primary/30 bg-primary-soft p-3";
  form.innerHTML = `
    <input type="text" placeholder="新标签名" data-new-tag-name class="mb-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
    <div class="mb-3 flex flex-wrap gap-1.5">
      ${colorOptions
        .map(
          (color, index) =>
            `<button type="button" data-new-tag-color="${escapeHtml(color)}" class="h-7 w-7 rounded-full border-2 ${index === 0 ? "border-ink" : "border-transparent"} transition" style="background-color: ${escapeHtml(color)}" aria-label="选择颜色 ${escapeHtml(color)}"></button>`
        )
        .join("")}
    </div>
    <p class="mb-2 text-xs text-danger" data-new-tag-error hidden></p>
    <div class="flex gap-2">
      <button type="button" data-action="add-tag-confirm" class="min-h-11 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-on-primary transition hover:bg-primary-hover">添加</button>
      <button type="button" data-action="add-tag-cancel" class="min-h-11 rounded-lg border border-line px-4 py-2 text-xs text-ink transition hover:bg-surface-alt">取消</button>
    </div>`;
  form.dataset.selectedColor = colorOptions[0] ?? "#EF4444";
  trigger.after(form);
  trigger.hidden = true;
  form.querySelector("[data-new-tag-name]")?.focus();
}

function closeAddTag() {
  document.querySelectorAll("[data-add-form]").forEach((form) => form.remove());
  document.querySelectorAll('[data-action="add-tag-open"]').forEach((button) => {
    button.hidden = false;
  });
}

/* ================================================================== */
/* 事件绑定                                                            */
/* ================================================================== */

const root = document.getElementById("admin-root");

if (root) {
  root.addEventListener("click", (event) => {
    // 页签
    const tabButton = event.target.closest("[data-admin-tab]");
    if (tabButton) {
      switchTab(tabButton.dataset.adminTab);
      return;
    }

    // 手动录入：标签选择
    const tagButton = event.target.closest("[data-pick-tag]");
    if (tagButton) {
      const index = Number(tagButton.dataset.blankIndex);
      const tagId = tagButton.dataset.pickTag;
      const blank = draft.blanks[index];
      if (!blank) return;
      blank.tagIds = blank.tagIds.includes(tagId)
        ? blank.tagIds.filter((id) => id !== tagId)
        : [...blank.tagIds, tagId];
      renderBlanks();
      return;
    }

    // 标签管理：颜色选择
    const colorButton = event.target.closest("[data-new-tag-color]");
    if (colorButton) {
      const form = colorButton.closest("[data-add-form]");
      if (form) {
        form.dataset.selectedColor = colorButton.dataset.newTagColor;
        form.querySelectorAll("[data-new-tag-color]").forEach((dot) => {
          dot.className = `h-7 w-7 rounded-full border-2 ${
            dot.dataset.newTagColor === form.dataset.selectedColor ? "border-ink" : "border-transparent"
          } transition`;
        });
      }
      return;
    }

    const actionButton = event.target.closest("button[data-action]");
    if (!actionButton || actionButton.disabled) return;

    const action = actionButton.dataset.action;
    const tagItem = actionButton.closest("[data-tag]");
    const tagId = tagItem?.dataset.tag;
    const group = actionButton.closest("[data-tag-group]");

    switch (action) {
      case "toggle-status": {
        const id = actionButton.dataset.id;
        const current = document.querySelector(`[data-admin-question="${CSS.escape(id)}"]`);
        const isMastered = actionButton.textContent.trim() === "标记未掌握";
        api
          .setProgress(id, isMastered ? "unmastered" : "mastered")
          .then(() => {
            showNotice(`已将 ${id} 标记为${isMastered ? "未掌握" : "已掌握"}`);
            if (current) {
              const button = current.querySelector('[data-action="toggle-status"]');
              if (button) button.textContent = isMastered ? "标记已掌握" : "标记未掌握";
            }
          })
          .catch((error) => notifyError(error));
        break;
      }
      case "delete-question": {
        // 题目删除已移到 admin-papers.js（连同确认文案与刷新逻辑），
        // 这里不再处理——同一个 data-action 被两个模块响应会重复删
        break;
      }
      case "toggle-tag": {
        const tag = tagDictionary.tags.find((item) => item.id === tagId);
        if (!tag) return;
        void updateTags((tags) =>
          tags.map((item) => (item.id === tagId ? { ...item, isActive: !item.isActive } : item))
        )
          .then(() => window.location.reload())
          // 保存失败时 tagDictionary 已回滚，重试再执行一次同样的切换即可
          .catch((error) => notifyError(error, { retry: () => clickTagButton(tagId, "toggle-tag") }));
        break;
      }
      case "delete-tag": {
        const tag = tagDictionary.tags.find((item) => item.id === tagId);
        if (!tag) return;
        const hasChildren = tagDictionary.tags.some((item) => item.parentId === tag.id);
        if (hasChildren) {
          const children = tagDictionary.tags
            .filter((item) => item.parentId === tag.id)
            .map((item) => item.name);
          notifyError(`「${tag.name}」下还有 ${children.length} 个子标签，请先删除它们`, {
            details: children,
          });
          return;
        }
        const used = tagUsage[tag.id] ?? 0;
        const warning =
          used > 0
            ? `有 ${used} 道题正在使用「${tag.name}」。删除后这些题将无法按该标签筛选。\n\n确定删除吗？`
            : `确定删除标签「${tag.name}」吗？此操作不可撤销。`;
        if (!window.confirm(warning)) return;
        void updateTags((tags) => tags.filter((item) => item.id !== tagId))
          .then(() => window.location.reload())
          .catch((error) => notifyError(error, { retry: () => clickTagButton(tagId, "delete-tag") }));
        break;
      }
      case "add-tag-open":
        if (group) openAddTag(group.dataset.tagGroup);
        break;
      case "expand-all-tag-groups":
        document.querySelectorAll("[data-tag-group]").forEach((item) => {
          item.open = true;
        });
        break;
      case "collapse-all-tag-groups":
        document.querySelectorAll("[data-tag-group]").forEach((item) => {
          item.open = false;
        });
        break;
      case "add-tag-confirm": {
        const form = actionButton.closest("[data-add-form]");
        const parentId = group?.dataset.tagGroup;
        if (form && parentId) submitNewTag(parentId);
        break;
      }
      case "add-tag-cancel":
        closeAddTag();
        break;
      default:
        break;
    }
  });

  // 手动录入：输入同步（不重渲染，避免打断输入）
  root.addEventListener("input", (event) => {
    const sentence = event.target.closest("#admin-sentence");
    if (sentence) {
      handleSentenceChange(sentence.value);
      return;
    }

    const answer = event.target.closest("[data-blank-answer]");
    if (answer) {
      const blank = draft.blanks[Number(answer.dataset.blankAnswer)];
      if (blank) blank.answer = answer.value;
      return;
    }

    const trap = event.target.closest("[data-blank-trap]");
    if (trap) {
      const blank = draft.blanks[Number(trap.dataset.blankTrap)];
      if (blank) {
        blank.trapAnalysis = trap.value;
        renderPreview();
      }
      return;
    }

    const source = event.target.closest("#admin-source");
    if (source) {
      draft.source = source.value;
      return;
    }

    // 标签名重命名
    const tagName = event.target.closest("[data-tag-name]");
    if (tagName) {
      const item = tagName.closest("[data-tag]");
      if (item) item.dataset.pendingName = tagName.value;
      return;
    }

    // 标签搜索：过滤当前空的标签按钮
    const search = event.target.closest("[data-blank-tag-search]");
    if (search) {
      const index = search.dataset.blankTagSearch;
      const box = document.querySelector(`[data-blank-tag-box="${CSS.escape(index)}"]`);
      if (!box) return;
      const keyword = search.value.trim().toLowerCase();
      box.querySelectorAll("button[data-pick-tag]").forEach((button) => {
        const name = (button.dataset.tagName ?? "").toLowerCase();
        button.hidden = keyword !== "" && !name.includes(keyword);
      });
      return;
    }
  });

  // 下拉与颜色、改名提交
  root.addEventListener("change", (event) => {
    const select = event.target.closest("[data-blank-hint]");
    if (select) {
      const blank = draft.blanks[Number(select.dataset.blankHint)];
      if (blank) {
        blank.hintType = select.value;
        renderBlanks();
      }
      return;
    }

    const color = event.target.closest("[data-tag-color]");
    if (color) {
      const item = color.closest("[data-tag]");
      if (!item) return;
      void applyTagColor(item.dataset.tag, color.value);
      return;
    }

    const nameInput = event.target.closest("[data-tag-name]");
    if (nameInput) {
      const item = nameInput.closest("[data-tag]");
      if (!item) return;
      const nextName = nameInput.value.trim();
      if (nextName === "") {
        // 原先这里 alert + reload：提示与页面样式不一致，
        // 而且整页刷新会把用户刚改好的其他标签名一起丢掉。
        // 现在只提示并把光标留在这一格，改完继续。
        showNotice("");
        notifyError("标签名不能为空", {
          details: ["清空后会与已有的空标签重名，请填一个名字"],
        });
        nameInput.focus();
        return;
      }
      void applyTagName(item.dataset.tag, nextName);
    }
  });

  // 按钮类操作
  const saveButton = document.getElementById("admin-save");
  if (saveButton) saveButton.addEventListener("click", () => void handleSave());

  const clearButton = document.getElementById("admin-clear");
  if (clearButton) clearButton.addEventListener("click", handleClearDraft);

  const exportButton = document.getElementById("admin-export");
  if (exportButton) {
    exportButton.addEventListener("click", () => {
      const list = [];
      document.querySelectorAll("[data-admin-question]").forEach((item) => {
        list.push({ id: item.dataset.adminQuestion });
      });
      // 导出用完整数据：从服务端重新取一次，避免页面里只有渲染出的字段。
      // 重试回调必须是**同一个完整流程**：之前直接重试 handleExport() 而没传参，
      // currentQuestions 是 undefined → 读 .length 抛错 → 用户点了「重试」没反应，
      // 备份文件一个字节都没落盘，却以为导出成功了（数据保护操作的静默失败）
      const runExport = () =>
        api
          .getQuestions()
          .then((data) => handleExport(data.questions ?? []))
          .catch((error) => notifyError(error, { retry: runExport }));
      runExport();
    });
  }

  const importTrigger = document.getElementById("admin-import-trigger");
  const fileInput = document.getElementById("admin-file");
  if (importTrigger && fileInput) {
    importTrigger.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void handleImportFile(file);
      fileInput.value = "";
    });
  }

  const migrateButton = document.getElementById("admin-migrate-local");
  if (migrateButton) migrateButton.addEventListener("click", () => void handleMigrateLocal());

  const seedButton = document.getElementById("admin-restore-seed");
  if (seedButton) seedButton.addEventListener("click", () => void handleRestoreSeed());

  const clearAllButton = document.getElementById("admin-clear-all");
  if (clearAllButton) clearAllButton.addEventListener("click", () => void handleClearAll());
}

/** AI 面板可能已经渲染过预览（AI 模块自带），这里只在标签变化时重刷手动录入的标签选择器 */
function renderAi() {
  renderBlanks();
}

/* ---------------- 启动 ---------------- */

function init() {
  const sourceInput = document.getElementById("admin-source");
  if (sourceInput) draft.source = sourceInput.value;
  renderBlanks();

  // 显示上一次操作留下的提示（部分操作整页刷新后展示，见各处 setFlash 调用）
  const flash = takeFlash();
  if (flash) showNotice(flash);

  // 生成虚拟卷 / 保存成员这些操作会带 hash 刷新（见 admin-blueprints.js 的
  // reloadKeepingTab）：刷新后按 hash 落在原页签，不让用户自己切回来。
  // 放在 setup* 之前，页签内容此时都已渲染，切换即可见
  const hashTab = (window.location.hash || "").replace("#", "");
  if (hashTab !== "") {
    const tabButton = document.querySelector(`[data-admin-tab="${hashTab}"]`);
    if (tabButton) tabButton.click();
  }

  // 初始化 AI 导入（模块自带幂等，重复调用只更新字典与回调）
  setupAiAssistant({
    tagDictionary,
    // 让 AI 导入知道库里已有哪些卷，粘贴后能提示「同名会归到那张卷」
    papers: boot.papers ?? [],
    onAppend: handleAiAppend,
    onCreateTags: handleCreateTags,
    onNotice: showNotice,
  });

  // 试卷与题目列表（独立模块，只服务这两个页签）
  setupPaperAndQuestionPanels(adminContext);

  // 组卷蓝图与虚拟卷成员（列表在首次切换到该页签时才拉取）
  setupBlueprintPanels(adminContext);
}

init();
