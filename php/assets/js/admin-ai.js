/**
 * AI 导入标签页 —— 入口与事件绑定。
 *
 * AI 导入标签页的全部交互（本文件不使用任何框架，以原生模块直接加载）：
 * - 生成「复制给 AI 的提示词」并按需复制（内容与原版buildPrompt 逐字一致）
 * - 解析粘贴回来的 JSON、查出字典里没有的标签、校验后增量入库
 *
 * 本文件**只负责挂载与事件绑定**，不含业务逻辑。职责分布：
 *   ai-prompt.js   生成提示词（长文本，改动需人工通读）
 *   ai-parse.js    容错解析 AI 返回的 JSON
 *   ai-validate.js 题目合法性校验
 *   ai-render.js   全部 DOM 渲染
 *   ai-actions.js  构建预览 / 篇章共享 / 入库等业务动作
 *   ai-state.js    唯一可变状态源
 *   ai-constants.js / ai-text.js / ai-tags.js  词汇表与纯工具
 *
 * 与主脚本（assets/js/admin.js）的接口约定：
 *   admin.js 通过 `import { setupAiAssistant } from "./admin-ai.js"` 直接调用，
 *   不依赖 script 标签顺序（模块依赖图保证本文件先求值）。
 *   setupAiAssistant({ tagDictionary, papers, onAppend, onCreateTags, onNotice })
 *   - tagDictionary：{ schemaVersion, tags: [{ id, name, parentId, color, isActive }] }
 *   - papers：库里已有的试卷 [{id, name, questionCount}]，用于提示同名归卷
 *   - onAppend(questions, source)：把校验通过的题目批量入库（返回 Promise）
 *   - onCreateTags(names)：创建字典里没有的新标签
 *   - onNotice(message)：在页面顶部显示一条提示
 *
 * 原版把「成功导入 / 已创建标签 / 复制失败」这类提示放在组件内部的 notice 状态里，
 * 迁移后统一交给页面顶部的 onNotice（与 Admin 页其它标签页的提示同一处），
 * 因此这里不再自渲染提示条。
 *
 * 动态文本一律先经 escapeHtml 再写入 DOM。
 */

import { debounce } from "./ai-text.js";
import { onStale } from "./lifecycle.js";
import { activeTagCount, state } from "./ai-state.js";
import {
  applyPassageToBatch, buildPreview, clearPassageFromBatch, handleCopy,
  handleCreateMissing, handleManualCopy, handleParse, previewPaperName,
  updatePaperHint,
} from "./ai-actions.js";
import {
  renderCopyButton, renderMissing, renderPreview, renderPreviewSummary,
  renderSubmitting,
} from "./ai-render.js";


/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 挂载 AI 导入标签页。主脚本在合适的时机调用（骨架已由 PHP 直出）。
 *
 * @param {object}   options
 * @param {object}   options.tagDictionary
 * @param {Function} options.onAppend
 * @param {Function} options.onCreateTags
 * @param {Function} options.onNotice
 */
export function setupAiAssistant({
  tagDictionary,
  papers,
  onAppend,
  onCreateTags,
  onNotice,
}) {
  const root = document.getElementById("admin-ai-root");
  if (!root) return;

  if (tagDictionary) state.dictionary = tagDictionary;
  // 已有试卷列表：用于提示「这个名字库里已经有了，会归到那张卷」
  if (Array.isArray(papers)) state.allPapers = papers;
  state.hooks = {
    onAppend: typeof onAppend === "function" ? onAppend : state.hooks.onAppend,
    onCreateTags: typeof onCreateTags === "function" ? onCreateTags : state.hooks.onCreateTags,
    onNotice: typeof onNotice === "function" ? onNotice : state.hooks.onNotice,
  };

  state.els = {
    root,
    count: root.querySelector("[data-tag-count]"),
    copyBtn: document.getElementById("admin-ai-copy"),
    manualBtn: document.getElementById("admin-ai-manual-copy"),
    source: document.getElementById("ai-source"),
    paper: document.getElementById("admin-ai-paper"),
    paperHint: document.getElementById("admin-ai-paper-hint"),
    textarea: document.getElementById("admin-ai-json"),
    missing: document.getElementById("admin-ai-missing"),
    missingList: document.getElementById("admin-ai-missing-list"),
    createTagsBtn: document.getElementById("admin-ai-create-tags"),
    error: document.getElementById("admin-ai-error"),
    submitBtn: document.getElementById("admin-ai-submit"),
    preview: document.getElementById("admin-ai-preview"),
    previewSummary: document.getElementById("admin-ai-preview-summary"),
    previewList: document.getElementById("admin-ai-preview-list"),
    passageBox: document.getElementById("admin-ai-passage"),
    passageText: document.getElementById("admin-ai-passage-text"),
    passageApply: document.getElementById("admin-ai-passage-apply"),
    passageClear: document.getElementById("admin-ai-passage-clear"),
    passageStatus: document.getElementById("admin-ai-passage-status"),
    selectAllBtn: document.getElementById("admin-ai-select-all"),
    selectNoneBtn: document.getElementById("admin-ai-select-none"),
  };

  // 提示词里会带上「当前 N 个标签」，字典变化时同步刷新
  if (state.els.count) state.els.count.textContent = String(activeTagCount());

  if (!state.bound) {
    state.bound = true;
    state.els.copyBtn?.addEventListener("click", () => void handleCopy());
    state.els.manualBtn?.addEventListener("click", handleManualCopy);
    state.els.createTagsBtn?.addEventListener("click", handleCreateMissing);
    state.els.submitBtn?.addEventListener("click", () => void handleParse());

    // 粘贴后立刻把卷名显示出来，用户在点导入前就能看到并改——
    // 不用等到点按钮才发现卷名不对
    //
    // 同时（防抖后）解析并渲染完整预览：这一步会调一次服务端查重，
    // 让用户在点导入之前就看到「哪几道库里已经有了」。
    // 合并到同一个防抖里，避免一次粘贴触发两轮解析。
    const onPaste = debounce(() => {
      previewPaperName();
      void buildPreview();
    }, 400);
    state.els.textarea?.addEventListener("input", onPaste);

    // 勾选 / 取消勾选：只改标记并刷新汇总，不重新解析
    state.els.previewList?.addEventListener("change", (event) => {
      const box = event.target;
      if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
      const index = Number(box.dataset.previewIndex);
      if (!Number.isInteger(index) || index < 0 || index >= state.previewChecks.length) return;
      state.previewChecks[index] = box.checked;
      renderPreviewSummary();
    });

    state.els.selectAllBtn?.addEventListener("click", () => {
      state.previewChecks = state.previewChecks.map(() => true);
      renderPreview();
    });
    state.els.selectNoneBtn?.addEventListener("click", () => {
      state.previewChecks = state.previewChecks.map(() => false);
      renderPreview();
    });
    state.els.source?.addEventListener("input", () => updatePaperHint(false));
    state.els.passageApply?.addEventListener("click", () => void applyPassageToBatch());
    state.els.passageClear?.addEventListener("click", clearPassageFromBatch);
    window.addEventListener("beforeunload", () => {
      if (state.copyTimer !== null) window.clearTimeout(state.copyTimer);
    });
  }

  renderCopyButton();
  renderMissing();
  renderSubmitting();

  // 页面从后台 / BFCache 回来时，如果上一次解析的结果还挂在预览区，
  // 用户看到的是「几分钟前的旧预览」，改一下就会基于过期状态操作。
  // 这里在页面变旧时把提交按钮的 loading 态复位 —— 解析过程本身是
  // 纯前端同步计算、不发请求，所以不需要重新跑，只需要解除可能的卡住。
  onStale(() => {
    if (state.submitting) {
      state.submitting = false;
      renderSubmitting();
    }
    // 清掉可能已经失效的错误提示，避免一屏都是红条
    const err = state.els.error;
    if (err && err.textContent && !state.previewList.length) {
      err.textContent = "";
    }
  });
}

// 兼容挂载：主脚本现走 import 调用；保留此全局入口便于控制台调试
// （注意：不要把它当作初始化依赖——曾因本文件未被加载导致面板静默失效）
window.setupAdminAi = setupAiAssistant;
