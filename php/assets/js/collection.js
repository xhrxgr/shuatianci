/**
 * 我的收藏交互（对应 src/pages/Collection.tsx）。
 *
 * 列表由 PHP 直出，本脚本只做三件事：
 * - 页签切换（同步到 URL 的 ?tab=，刷新后仍停在当前页签）
 * - 取消收藏 / 取消标记（调接口后整页刷新，与 React 版重新拉取列表等价）
 * - 操作结果提示
 */

import { api } from "./api.js";

const root = document.getElementById("collection-root");

/** 提示条 */
function showMessage(kind, message) {
  const box = document.getElementById(kind === "error" ? "collection-error" : "collection-notice");
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
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
      favoriteButton.disabled = true;
      try {
        await api.toggleFavorite(source);
        showMessage("notice", "已取消收藏");
        window.location.reload();
      } catch (error) {
        showMessage("error", error?.message ?? "操作失败");
        favoriteButton.disabled = false;
      }
      return;
    }

    const markButton = event.target.closest('[data-action="remove-mark"]');
    if (markButton) {
      const questionId = markButton.dataset.question ?? "";
      markButton.disabled = true;
      try {
        await api.toggleMark(questionId);
        showMessage("notice", "已取消标记");
        window.location.reload();
      } catch (error) {
        showMessage("error", error?.message ?? "操作失败");
        markButton.disabled = false;
      }
    }
  });
}
