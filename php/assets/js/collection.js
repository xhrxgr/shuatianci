/**
 * 我的收藏交互。
 *
 * 列表由 PHP 直出，本脚本只做三件事：
 * - 页签切换（同步到 URL 的 ?tab=，刷新后仍停在当前页签）
 * - 取消收藏 / 取消标记（调接口后整页刷新以更新列表）
 * - 操作结果提示
 */

import { api } from "./api.js";
import { setFlash, takeFlash } from "./flash.js";
import { notify, notifyError, clearFeedback } from "./feedback.js";

const root = document.getElementById("collection-root");

/**
 * 提示条。呈现交给 feedback.js，位置仍用页面原有的 id，测试照旧按 id 定位。
 * retry 用于「再点一次就好」的操作（取消收藏 / 取消标记都是点一下生效）。
 */
function showMessage(kind, message, options = {}) {
  return kind === "error"
    ? notifyError(message, { boxId: "collection-error", ...options })
    : notify(message, "success", { boxId: "collection-notice", ...options });
}

/** 清掉上一条提示（每次操作前先调用） */
function clearMessages() {
  clearFeedback("collection-error");
  clearFeedback("collection-notice");
}

/** 页签切换 */
function switchTab(tab) {
  root.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
  root.querySelectorAll("[data-collection-tab]").forEach((button) => {
    const active = button.dataset.collectionTab === tab;
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.className = `min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-medium transition ${
      active ? "bg-ink text-surface" : "text-muted hover:bg-surface-alt"
    }`;
  });
  // 刷新后能停在同一页签
  const url = new URL(window.location.href);
  if (tab === "favorites") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", tab);
  }
  window.history.replaceState(null, "", url);
}

if (root) {
  root.addEventListener("click", async (event) => {
    const tabButton = event.target.closest("[data-collection-tab]");
    if (tabButton) {
      switchTab(tabButton.dataset.collectionTab);
      return;
    }

    const favoriteButton = event.target.closest('[data-action="remove-favorite"]');
    if (favoriteButton) {
      const source = favoriteButton.dataset.source ?? "";
      if (!window.confirm(`确定取消收藏「${source}」吗？`)) return;
      clearMessages();
      favoriteButton.disabled = true;
      try {
        await api.toggleFavorite(source);
        setFlash("已取消收藏");
        window.location.reload();
      } catch (error) {
        // 重试会再弹一次确认框——取消收藏不该「点一下就真取消」
        showMessage("error", error, {
          retry: () => document.querySelector(`[data-action="remove-favorite"][data-source="${CSS.escape(source)}"]`)?.click(),
        });
        favoriteButton.disabled = false;
      }
      return;
    }

    const markButton = event.target.closest('[data-action="remove-mark"]');
    if (markButton) {
      const questionId = markButton.dataset.question ?? "";
      clearMessages();
      markButton.disabled = true;
      try {
        await api.toggleMark(questionId);
        setFlash("已取消标记");
        window.location.reload();
      } catch (error) {
        showMessage("error", error, {
          retry: () => document.querySelector(`[data-action="remove-mark"][data-question="${CSS.escape(questionId)}"]`)?.click(),
        });
        markButton.disabled = false;
      }
    }
  });

  // 显示上一次操作留下的提示（操作成功后整页刷新，见上面的 setFlash）
  const flash = takeFlash();
  if (flash) showMessage("notice", flash);
}
