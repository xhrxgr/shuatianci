/**
 * AI 导入页的**全部 DOM 渲染**。
 *
 * 统一约定：动态文本一律先经 escapeHtml 或 textContent 写入，
 * 题目内容来自外部 AI，绝不拼 innerHTML。
 *
 * 依赖方向是单向的：本模块只**读** state、只调用校验与文本工具，
 * 不反过来依赖 ai-actions.js。预览卡片里的「移除/ 编辑 / 保存」这些
 * 会改数据的动作也放在这里（removePreviewItem / refreshPreviewVerdict），
 * 因为它们唯一的职责就是「改完立刻重渲染」，与渲染是同一件事的两面。
 */

import { api } from "./api.js";
import { HINT_TYPES } from "./ai-constants.js";
import { iconPlus } from "./icons.js";
import { validateQuestions } from "./ai-validate.js";
import { escapeHtml, findPlaceholderPositions } from "./ai-text.js";
import { resolveTag } from "./ai-tags.js";
import { state, syncLastBuild } from "./ai-state.js";


/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/** 复制按钮文案（state.copied 为真时显示「已复制，去问 AI」） */
export function renderCopyButton() {
  if (state.els.copyBtn) state.els.copyBtn.textContent = state.copied ? "已复制，去问 AI" : "复制提示词";
}

/** 「字典里没有的标签」提示块 */
export function renderMissing() {
  if (!state.els.missing) return;
  state.els.missing.hidden = state.missingTags.length === 0;
  if (state.els.missingList) {
    state.els.missingList.innerHTML = state.missingTags
      .map((tag) => `<span class="ml-1 rounded bg-warning/20 px-1.5 py-0.5">${escapeHtml(tag)}</span>`)
      .join("");
  }
}

/** 校验错误块（原版按 "\n" 拆成多行 li） */
export function renderError(message) {
  if (!state.els.error) return;
  state.els.error.hidden = false;
  state.els.error.innerHTML = message
    .split("\n")
    .map((line) => `<li>· ${escapeHtml(line)}</li>`)
    .join("");
}

/** 清掉错误块（对应原版 setParseError("")） */
export function clearError() {
  if (!state.els.error) return;
  state.els.error.hidden = true;
  state.els.error.innerHTML = "";
}

/** 提交按钮文案与禁用态 */
export function renderSubmitting() {
  if (!state.els.submitBtn) return;
  state.els.submitBtn.textContent = state.submitting ? "导入中…" : "确认导入这一卷";
  state.els.submitBtn.disabled = state.submitting;
}

/** 状态 → 展示文案与配色类 */
const VERDICT_STYLE = {
  new: { label: "新增", cls: "text-success border-success/40 bg-success-soft" },
  duplicate: { label: "已存在", cls: "text-muted border-line bg-surface" },
  diff: { label: "答案不同", cls: "text-warning border-warning/40 bg-warning-soft" },
};

/** 建一个元素（文本一律走 textContent，不拼 HTML —— 题目内容来自外部 AI） */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 这份原文在本批预览里是否已经出现过。
 *
 * 场景：AI 导入时，提示词里明确要求「同一篇下的所有 Question 填**同一份**原文，
 * 一字不差」—— 所以刚粘贴完、还没点「套用到本批」时，N 道题各自都带着
 * **一模一样的** passageText。哪怕每处都改成折叠，10 道题仍有 10 个内容相同的入口，
 * 依然是重复信息。
 *
 * 所以：同一批里只有**第一次出现**的那道题渲染原文入口，其余的只标一句
 * 「与第 N 题相同」，点不开也不占地方。
 *
 * @param {string} text 原文
 * @param {number} currentIndex 当前题的序号
 * @returns {number} 首次出现的序号（与 currentIndex 相同表示该题是首次出现）
 */
function passageFirstIndex(text, currentIndex) {
  const target = String(text ?? "").trim();
  if (target === "") {
    return -1;
  }
  for (let i = 0; i < currentIndex; i += 1) {
    const other = state.previewList[i];
    if (other && String(other.passageText ?? "").trim() === target) {
      return i;
    }
  }
  return currentIndex;
}

function renderPreviewItem(item, verdict, index) {
  // 正在编辑这张卡片：整个卡片换成表单，保存/取消后再回到预览态
  if (state.previewEditIndex === index) {
    return renderPreviewEditor(item, index);
  }

  const wrapper = el("label", "flex cursor-pointer gap-3 rounded-lg border border-line bg-surface p-3 transition hover:border-primary/40");
  const checked = state.previewChecks[index] !== false;

  const box = el("input", "mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary");
  box.type = "checkbox";
  box.checked = checked;
  box.dataset.previewIndex = String(index);
  wrapper.appendChild(box);

  const body = el("div", "min-w-0 flex-1 space-y-2");

  // 首行：序号 + 状态徽标
  const head = el("div", "flex flex-wrap items-center gap-2");
  head.appendChild(el("span", "text-xs font-medium text-faint", `第 ${index + 1} 题`));
  const style = VERDICT_STYLE[verdict?.state] ?? VERDICT_STYLE.new;
  head.appendChild(el("span", `rounded border px-1.5 py-0.5 text-[11px] ${style.cls}`, style.label));
  // 人工改过的题要有痕迹：AI 给错答案/解析/文字时，改完要能一眼看出哪几题动过
  if (item.__edited) {
    head.appendChild(el("span", "rounded border border-success/40 bg-success-soft px-1.5 py-0.5 text-[11px] text-success", "已改"));
  }
  head.appendChild(previewItemActions(index));
  body.appendChild(head);

  // 原句：把 ______ 拆出来单独高亮
  const sentence = el("p", "break-words text-sm leading-6 text-ink");
  const parts = String(item.originalSentence ?? "").split("______");
  parts.forEach((part, i) => {
    if (i > 0) {
      sentence.appendChild(el("span", "mx-0.5 inline-block min-w-8 rounded border-b-2 border-primary/60 bg-primary/10 px-1 text-center text-primary", "____"));
    }
    sentence.appendChild(document.createTextNode(part));
  });
  body.appendChild(sentence);

  // 逐空明细
  const blankBox = el("div", "space-y-1.5");
  for (const blank of item.blanks ?? []) {
    const row = el("div", "rounded border border-line bg-surface-alt px-2.5 py-1.5 text-xs leading-5");
    const line1 = el("div", "flex flex-wrap items-baseline gap-x-2 gap-y-0.5");
    line1.appendChild(el("span", "font-medium text-faint", `空 ${blank.blankIndex}`));
    line1.appendChild(el("span", "font-medium text-ink", (blank.answer ?? []).join(" / ")));
    if (blank.hintType) {
      line1.appendChild(el("span", "text-muted", blank.hintType));
    }
    if (blank.hintWord) {
      line1.appendChild(el("span", "text-muted", `提示词 ${blank.hintWord}`));
    }
    row.appendChild(line1);

    const tagNames = (blank.tagIds ?? [])
      .map((id) => resolveTag(state.dictionary, id)?.name ?? id)
      .filter(Boolean);
    if (tagNames.length > 0) {
      row.appendChild(el("div", "mt-0.5 flex flex-wrap gap-1", ""));
      const tagLine = row.lastElementChild;
      for (const name of tagNames) {
        tagLine.appendChild(el("span", "rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-muted", name));
      }
    }
    if (blank.trapAnalysis) {
      row.appendChild(el("div", "mt-0.5 break-words text-muted", blank.trapAnalysis));
    }
    blankBox.appendChild(row);
  }
  body.appendChild(blankBox);

  // 所属篇章：套用了共用原文时显示一句，让用户知道这题有全文对照。
  // 做成可点的：点了直接滚到顶部「本篇完整原文」面板，省得手动翻。
  if (item.passageId) {
    const badge = el(
      "button",
      "rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary transition hover:bg-primary/20",
      "共用原文"
    );
    badge.type = "button";
    badge.addEventListener("click", () => {
      const panel = state.els.passageBox;
      if (panel && !panel.hidden) {
        panel.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    head.appendChild(badge);
  }

  // 完整原文
  //
  // 一道大题挖 10 个空就有 10 道小题，10 份一模一样的全文堆在预览里
  // 是纯粹的累赘（一屏全被原文占满，真正要看的内容被挤到下面）。
  // 所以分两种情况：
  //   1. 已套用共用篇章 → 顶部「本篇完整原文」面板已经有一份，
  //      这里只留一个「共用原文」徽标指过去，**不再重复渲染全文**；
  //   2. 这道题自带原文但本批前面已有一样的 → 只标一句「与第 N 题相同」；
  //   3. 这道题的原文本批独有 → 默认折叠，标题写清字数与「本批几道题共用」。
  const firstAt = item.passageId ? -1 : passageFirstIndex(item.passageText, index);

  if (item.passageId) {
    // 已套用共用篇章：全文在顶部面板，这里什么都不用渲染（徽标在上面）
  } else if (firstAt >= 0 && firstAt !== index) {
    // 本批里前面已有一样的原文：只标一句，指回第一次出现的那道题
    body.appendChild(
      el(
        "p",
        "text-[11px] text-faint",
        `完整原文与第 ${firstAt + 1} 题相同（${String(item.passageText).length} 字）`
      )
    );
  } else if (item.passageText) {
    const passageBox = el("details", "rounded border border-line bg-surface-alt");
    const sameCount = state.previewList.filter(
      (q) => String(q?.passageText ?? "").trim() === String(item.passageText).trim()
    ).length;
    passageBox.appendChild(
      el(
        "summary",
        "cursor-pointer list-none px-2.5 py-2 text-[11px] font-medium text-faint transition hover:text-muted",
        sameCount > 1
          ? `完整原文（本批 ${sameCount} 道题共用这一份，${String(item.passageText).length} 字，点击展开）`
          : `完整原文（${String(item.passageText).length} 字，点击展开对照）`
      )
    );
    passageBox.appendChild(
      el(
        "p",
        "whitespace-pre-wrap break-words border-t border-line px-2.5 py-2 text-xs leading-5 text-muted",
        item.passageText
      )
    );
    body.appendChild(passageBox);
  }

  // 查重的具体差异说明
  if (verdict?.hint) {
    body.appendChild(el("p", "text-xs leading-5 text-warning", verdict.hint));
  }
  if ((verdict?.matched ?? []).length > 0) {
    const matched = verdict.matched
      .slice(0, 3)
      .map((m) => `${m.id}${m.source ? `（${m.source}）` : ""}`)
      .join("、");
    body.appendChild(el("p", "text-xs leading-5 text-faint", `库中已有：${matched}`));
  }

  wrapper.appendChild(body);
  return wrapper;
}

/** 卡片右上角的操作按钮（编辑 / 移除） */
function previewItemActions(index) {
  const box = el("div", "ml-auto flex shrink-0 gap-1.5");

  const edit = el("button", "min-h-11 shrink-0 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-alt", "编辑");
  edit.type = "button";
  // 整张卡片是 <label>，点按钮会被浏览器转成「切换勾选」，
  // 必须两个事件都拦住，否则一编辑就顺手把题取消勾选了
  edit.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.previewEditIndex = index;
    renderPreview();
  });

  const remove = el("button", "min-h-11 shrink-0 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] text-muted transition hover:text-danger", "移除");
  remove.type = "button";
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    removePreviewItem(index);
  });

  box.appendChild(edit);
  box.appendChild(remove);
  return box;
}

/** 移除一道题（AI 偶尔会混进不是题的条目，或用户临时不想要某一题） */
function removePreviewItem(index) {
  const item = state.previewList[index];
  if (!item) return;
  const head = String(item.originalSentence ?? "").slice(0, 24);
  if (!window.confirm("移除第 " + (index + 1) + " 题？\n\n" + head + "…\n\n只是从本批预览里去掉，不会影响已入库的题。")) {
    return;
  }
  state.previewList.splice(index, 1);
  state.previewVerdicts.splice(index, 1);
  state.previewChecks.splice(index, 1);
  if (state.previewEditIndex !== null) {
    // 被移除的正是正在编辑的那张：收起表单；在它后面的要相应前移
    if (state.previewEditIndex === index) state.previewEditIndex = null;
    else if (state.previewEditIndex > index) state.previewEditIndex -= 1;
  }
  syncLastBuild();
  renderPreview();
  renderPreviewSummary();
  renderPassagePanel();
}

/** 刷新原文区的显隐与状态文字（预览有题时才显示这一块） */
export function renderPassagePanel() {
  if (!state.els.passageBox) return;
  const has = state.previewList.length > 0;
  state.els.passageBox.hidden = !has;
  if (!has) return;
  if (state.previewPassageId) {
    state.els.passageStatus.textContent = `已套用到本批 ${state.previewList.length} 道题（改原文只改一处，全部立即生效）`;
    state.els.passageApply.textContent = "重新套用";
  } else {
    const own = state.previewList.filter((q) => typeof q.passageText === "string" && q.passageText.trim() !== "").length;
    state.els.passageStatus.textContent = own > 0
      ? `尚未设置共用原文（当前有 ${own} 道题各带一份自己的原文）`
      : "尚未设置原文";
    state.els.passageApply.textContent = "套用到本批题目";
  }
}

/**
 * 就地编辑表单：原句 + 每个空的答案/提示词/标签/解析，全可改。
 *
 * 做成「卡片原位变成表单」而不是弹窗：弹窗要处理定位、滚动、移动端键盘，
 * 而用户此时正盯着这张卡片，原地改最直观。
 */
function renderPreviewEditor(item, index) {
  const blanks = (item.blanks ?? []).map((blank) => ({
    blankIndex: blank.blankIndex,
    answer: [...(blank.answer ?? [])],
    hintType: blank.hintType ?? "无提示词",
    hintWord: blank.hintWord ?? null,
    tagIds: [...(blank.tagIds ?? [])],
    trapAnalysis: blank.trapAnalysis ?? "",
  }));

  const box = el("div", "space-y-3 rounded-lg border border-primary/50 bg-surface p-3");

  const head = el("div", "flex flex-wrap items-center gap-2");
  head.appendChild(el("span", "text-xs font-medium text-faint", "编辑第 " + (index + 1) + " 题"));
  head.appendChild(el("span", "text-[11px] text-faint", "改完点「保存修改」，导入时会用改后的内容"));
  box.appendChild(head);

  // ---- 原句 ----
  box.appendChild(el("label", "mb-1 block text-xs font-medium text-muted", "原句（空格用 ______ 表示，数量要与下面的空一致）"));
  const sentence = el("textarea", "w-full rounded-lg border border-line bg-surface-alt px-3 py-2 text-sm leading-6 outline-none transition focus:border-primary");
  sentence.rows = 3;
  sentence.value = String(item.originalSentence ?? "");
  box.appendChild(sentence);
  const counter = el("p", "text-[11px] text-faint", "");
  box.appendChild(counter);
  const syncCounter = () => {
    const inSentence = findPlaceholderPositions(sentence.value).length;
    const mismatch = inSentence !== blanks.length;
    counter.textContent = mismatch
      ? "原句里有 " + inSentence + " 个空，下面配了 " + blanks.length + " 个空 —— 不一致会导致保存被拦下"
      : "原句 " + inSentence + " 个空，配置 " + blanks.length + " 个空，一致";
    counter.className = mismatch ? "text-[11px] text-danger" : "text-[11px] text-faint";
  };
  sentence.addEventListener("input", syncCounter);

  // ---- 完整原文 ----
  // 这题用了共用篇章时，它的 passageText 是空的（套用时被清掉了，避免两处各说各话）。
  // 给一个空 textarea 只会让人以为「这题没原文」—— 改成指路到顶部面板。
  const passage = el("textarea", "w-full rounded-lg border border-line bg-surface-alt px-3 py-2 text-xs leading-5 outline-none transition focus:border-primary");
  passage.rows = 4;
  passage.value = item.passageText ?? "";
  passage.placeholder = "一篇阅读挖多个空时，把整篇未挖掉的原文粘在这里；单句题留空即可。";

  if (item.passageId) {
    box.appendChild(
      el(
        "p",
        "rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-[11px] leading-5 text-primary",
        "本题使用顶部「本篇完整原文」里的那份全文（同一批题共用，改一处全部生效）。要修改请到顶部面板改。"
      )
    );
  } else {
    box.appendChild(el("label", "mb-1 block text-xs font-medium text-muted", "完整原文（未挖空，选填；学生做题时可展开对照）"));
    box.appendChild(passage);
  }

  // ---- 每个空 ----
  const blankBox = el("div", "space-y-2");
  box.appendChild(blankBox);

  const renderBlank = (blank, blankIdx) => {
    const card = el("div", "space-y-2 rounded-lg border border-line bg-surface-alt p-2.5");

    const line1 = el("div", "flex flex-wrap items-end gap-2");
    line1.appendChild(el("span", "shrink-0 pb-2 text-xs font-medium text-faint", "空 " + blank.blankIndex));

    // 答案：多个可接受答案用 / 分隔（与判卷口径一致）
    const answerWrap = el("div", "min-w-40 flex-1");
    answerWrap.appendChild(el("label", "mb-1 block text-[11px] text-faint", "答案（多个用 / 分隔）"));
    const answer = el("input", "w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary");
    answer.type = "text";
    answer.value = (blank.answer ?? []).join(" / ");
    answerWrap.appendChild(answer);
    line1.appendChild(answerWrap);

    // 提示词类型
    const hintWrap = el("div", "w-32 shrink-0");
    hintWrap.appendChild(el("label", "mb-1 block text-[11px] text-faint", "提示词类型"));
    const hintType = el("select", "w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary");
    for (const type of HINT_TYPES) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      if (type === blank.hintType) option.selected = true;
      hintType.appendChild(option);
    }
    hintWrap.appendChild(hintType);
    line1.appendChild(hintWrap);

    // 提示词（选了「无提示词」就禁用）
    const wordWrap = el("div", "w-32 shrink-0");
    wordWrap.appendChild(el("label", "mb-1 block text-[11px] text-faint", "提示词"));
    const hintWord = el("input", "w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary disabled:opacity-40");
    hintWord.type = "text";
    hintWord.value = blank.hintWord ?? "";
    hintWord.disabled = blank.hintType === "无提示词";
    hintWord.placeholder = blank.hintType === "无提示词" ? "（不需要）" : "如 sit";
    wordWrap.appendChild(hintWord);
    line1.appendChild(wordWrap);

    hintType.addEventListener("change", () => {
      hintWord.disabled = hintType.value === "无提示词";
      hintWord.placeholder = hintWord.disabled ? "（不需要）" : "如 sit";
    });

    card.appendChild(line1);

    // 标签：chips 点选，省得记 tagId
    card.appendChild(el("label", "mb-1 block text-[11px] text-faint", "标签（点选，可多选）"));
    const tagBox = el("div", "flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded-lg border border-line bg-surface p-1.5");
    const activeTags = (state.dictionary?.tags ?? []).filter((tag) => tag.isActive);
    if (activeTags.length === 0) {
      tagBox.appendChild(el("span", "text-[11px] text-faint", "标签库是空的，可先到「知识点标签」页签添加"));
    }
    for (const tag of activeTags) {
      const on = blank.tagIds.includes(tag.id);
      const chip = el("button", "min-h-7 rounded-full border px-2 py-0.5 text-[11px] transition "
        + (on ? "border-primary bg-primary/10 text-primary" : "border-line bg-surface text-muted hover:bg-surface-alt"), tag.name);
      chip.type = "button";
      chip.addEventListener("click", () => {
        const at = blank.tagIds.indexOf(tag.id);
        if (at === -1) blank.tagIds.push(tag.id);
        else blank.tagIds.splice(at, 1);
        const now = blank.tagIds.includes(tag.id);
        chip.className = "min-h-7 rounded-full border px-2 py-0.5 text-[11px] transition "
          + (now ? "border-primary bg-primary/10 text-primary" : "border-line bg-surface text-muted hover:bg-surface-alt");
      });
      tagBox.appendChild(chip);
    }
    card.appendChild(tagBox);

    // 解析
    card.appendChild(el("label", "mb-1 block text-[11px] text-faint", "解析（命题意图与判断依据）"));
    const trap = el("textarea", "w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs leading-5 outline-none focus:border-primary");
    trap.rows = 2;
    trap.value = blank.trapAnalysis ?? "";
    card.appendChild(trap);

    // 删除这个空
    const delBlank = el("button", "text-[11px] text-faint transition hover:text-danger", "删除这个空");
    delBlank.type = "button";
    delBlank.addEventListener("click", () => {
      if (blanks.length <= 1) {
        renderError("至少要留一个空；整题不想要可以用上面的「移除」。");
        return;
      }
      blanks.splice(blankIdx, 1);
      // blankIndex 必须从 1 连续递增，删了中间的要重排
      blanks.forEach((b, i) => { b.blankIndex = i + 1; });
      // 原句末尾对应的 ______ 也去掉一个，否则空格数对不上
      sentence.value = sentence.value.replace(/\_\_\_\_\_\_\s*$/, "").trimEnd();
      rerenderEditor();
    });
    card.appendChild(delBlank);

    // 输入先落在 dataset 上，保存时统一收集（避免每次输入都动数据）。
    // ⚠️ 必须先把**当前值**写进去：只监听 input/change 的话，用户没碰过的字段
    // dataset 里是 undefined，保存时会当成空串——改一个答案却把解析冲掉了。
    card.dataset.answer = answer.value;
    card.dataset.hintType = hintType.value;
    card.dataset.hintWord = hintWord.value;
    card.dataset.trap = trap.value;
    answer.addEventListener("input", () => { card.dataset.answer = answer.value; });
    hintType.addEventListener("change", () => { card.dataset.hintType = hintType.value; });
    hintWord.addEventListener("input", () => { card.dataset.hintWord = hintWord.value; });
    trap.addEventListener("input", () => { card.dataset.trap = trap.value; });

    blankBox.appendChild(card);
  };

  const rerenderEditor = () => {
    blankBox.textContent = "";
    blanks.forEach((blank, blankIdx) => renderBlank(blank, blankIdx));
    syncCounter();
  };
  rerenderEditor();

  // ---- 增加一个空 ----
  const addBlank = el("button", "min-h-11 inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-alt");
  addBlank.innerHTML = `${iconPlus("h-4 w-4 shrink-0")}增加一个空`;
  addBlank.type = "button";
  addBlank.addEventListener("click", () => {
    blanks.push({
      blankIndex: blanks.length + 1,
      answer: [""],
      hintType: "无提示词",
      hintWord: null,
      tagIds: [],
      trapAnalysis: "",
    });
    sentence.value = sentence.value.trimEnd() + " ______";
    rerenderEditor();
  });
  box.appendChild(addBlank);

  // ---- 保存 / 取消 ----
  const footer = el("div", "flex flex-wrap gap-2 border-t border-line pt-3");

  const save = el("button", "min-h-11 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-on-primary transition hover:bg-primary-hover", "保存修改");
  save.type = "button";
  save.addEventListener("click", () => {
    // 从 DOM 收集每个空的最终输入
    const collected = [];
    const cards = blankBox.children;
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      const answerText = card.dataset.answer ?? "";
      const hintTypeValue = card.dataset.hintType ?? "无提示词";
      const hintWordValue = card.dataset.hintWord ?? "";
      const trapValue = card.dataset.trap ?? "";
      collected.push({
        ...blanks[i],
        answer: answerText.split("/").map((a) => a.trim()).filter((a) => a !== ""),
        hintType: hintTypeValue,
        hintWord: hintTypeValue === "无提示词" ? null : (hintWordValue.trim() || null),
        trapAnalysis: trapValue.trim(),
      });
    }

    const passageText = passage.value.trim();
    const updated = { ...item, originalSentence: sentence.value, passageText: passageText === "" ? null : passageText, blanks: collected };

    // 复用同一套校验：空格数、题号残留、blankIndex、答案、提示词、解析全查
    const { allErrors } = validateQuestions([updated], state.dictionary);
    if (allErrors.length > 0) {
      renderError("第 " + (index + 1) + " 题还没改好，共 " + allErrors.length + " 处问题：\n" + allErrors.join("\n"));
      return;
    }

    updated.__edited = true;
    state.previewList[index] = updated;
    state.previewEditIndex = null;
    syncLastBuild();
    clearError();
    renderPreview();
    renderPreviewSummary();
    // 内容变了，原来的查重结论可能不再成立，重查一次
    void refreshPreviewVerdict(index);
  });

  const cancel = el("button", "min-h-11 rounded-lg border border-line px-4 py-2 text-xs text-muted transition hover:bg-surface-alt", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    state.previewEditIndex = null;
    renderPreview();
  });

  footer.appendChild(save);
  footer.appendChild(cancel);
  box.appendChild(footer);
  return box;
}

/** 重新查一道题的重复情况（编辑后原结论可能失效） */
async function refreshPreviewVerdict(index) {
  const question = state.previewList[index];
  if (!question) return;
  try {
    const res = await api.checkDuplicates([
      { originalSentence: question.originalSentence, blanks: question.blanks ?? [] }
    ]);
    const verdict = res?.results?.[0];
    if (!verdict) return;
    state.previewVerdicts[index] = verdict;
    // 勾选状态跟着结论走：改成「已存在」时自动取消勾选，
    // 否则会导入一条与库里互相矛盾的题（默认规则本来就是「已存在不勾」）
    state.previewChecks[index] = verdict.state === "new";
    renderPreview();
    renderPreviewSummary();
  } catch {
    // 查重失败不打扰用户：保持原结论，导入时服务端还会再判一次
  }
}

/** 只刷新汇总行（勾选变化时用，避免重建整个列表导致滚动位置丢失） */
export function renderPreviewSummary() {
  if (!state.els?.previewSummary || state.previewList.length === 0) return;

  const counts = { new: 0, duplicate: 0, diff: 0 };
  for (const v of state.previewVerdicts) {
    counts[v?.state ?? "new"] = (counts[v?.state ?? "new"] ?? 0) + 1;
  }
  const willImport = state.previewChecks.filter(Boolean).length;

  const bits = [`共 ${state.previewList.length} 题`, `新增 ${counts.new}`];
  if (counts.duplicate > 0) bits.push(`已存在 ${counts.duplicate}`);
  if (counts.diff > 0) bits.push(`答案不同 ${counts.diff}`);
  const head = bits.join("，");

  // 自动修正的说明在这里也显示一次。
  //
  // 原来只在**导入后**才提示（runImport 读 state.pendingRepairs），于是预览阶段
  // 用户看不到自己的数据被改过什么 —— 比如 AI 把原文也写成了挖空版、
  // 我们按答案还原了 10 处，这种事应该**导入前**就说清楚，而不是事后才知道。
  const repaired = (state.pendingRepairs ?? []).filter((line) => String(line).trim() !== "");
  const tail = repaired.length
    ? `；已自动修正 ${repaired.length} 处：${repaired.join("；")}`
    : "";
  state.els.previewSummary.textContent = `${head}；将导入 ${willImport} 题${tail}`;
}

/** 渲染整个预览区（含汇总与全选/全不选状态） */
export function renderPreview() {
  if (!state.els?.preview || !state.els?.previewList) return;

  const total = state.previewList.length;
  if (total === 0) {
    state.els.preview.hidden = true;
    if (state.els.previewList) state.els.previewList.textContent = "";
    return;
  }
  state.els.preview.hidden = false;

  renderPreviewSummary();

  state.els.previewList.textContent = "";
  state.previewList.forEach((item, index) => {
    state.els.previewList.appendChild(renderPreviewItem(item, state.previewVerdicts[index], index));
  });
  // 原文面板跟着预览一起显隐。它初始是 hidden 的，只有这里会取消隐藏——
  // 少了这一句，粘贴 JSON 后预览出来了、面板却还藏着，用户根本看不到入口
  // （v3.6.15 首版就漏在这儿，审查时被抓出来）
  renderPassagePanel();
}
