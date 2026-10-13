/**
 * 用户管理交互（对应 src/pages/UserAdmin.tsx）。
 *
 * 列表由 PHP 直出，本脚本负责全部写操作与按需读取：
 * - 新建用户 / 重置密码 / 调整角色 / 启用禁用 / 删除：调 /api/admin/*
 *
 * 成功后整页刷新，等价于 React 版重新拉取列表（load()）。
 * 提示文案与 React 版逐字一致；三条自我保护（不能改自己角色 / 禁用自己 /
 * 删自己）由后端拦截，这里只负责把后端返回的错误原样提示。
 */

import { api } from "./api.js";
import { setFlash, takeFlash } from "./flash.js";

const root = document.getElementById("admin-users-root");

/** HTML 转义：所有动态文本都要经过它 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 顶部提示条 */
function showMessage(kind, message) {
  const box = document.getElementById(kind === "error" ? "admin-users-error" : "admin-users-notice");
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

/** 清掉上一条提示（与 React 版操作前 setError("") / setNotice("") 一致） */
function clearMessages() {
  ["admin-users-error", "admin-users-notice"].forEach((id) => {
    const box = document.getElementById(id);
    if (box) {
      box.hidden = true;
      box.textContent = "";
    }
  });
}

/** 成功：暂存提示并整页刷新（刷新后由启动处取出显示；对应 React 版 setNotice + load，提示可见） */
function succeed(message) {
  setFlash(message);
  window.location.reload();
}

/** 失败：展示后端错误信息（与 React 版一致，取 err.message） */
function fail(error, fallback) {
  showMessage("error", error?.message ?? fallback);
}

/* ---------------- 新建用户 ---------------- */

async function handleCreate() {
  const username = document.getElementById("admin-new-username");
  const password = document.getElementById("admin-new-password");
  const role = document.getElementById("admin-new-role");
  if (!username || !password || !role) return;

  clearMessages();
  try {
    await api.createUser(username.value.trim(), password.value, role.value);
    succeed("用户创建成功");
  } catch (error) {
    fail(error, "操作失败");
  }
}

/* ---------------- 行内操作 ---------------- */

/** 调整角色 */
async function handleRoleChange(select) {
  const row = select.closest("[data-user-row]");
  if (!row) return;
  clearMessages();
  try {
    await api.changeRole(row.dataset.userId, select.value);
    succeed(`已修改 ${row.dataset.username} 的角色`);
  } catch (error) {
    // 失败（例如改自己的角色被后端拒绝）时把下拉恢复成原角色
    select.value = select.dataset.currentRole;
    fail(error, "操作失败");
  }
}

/** 启用 / 禁用 */
async function handleStatus(row) {
  const current = Number(row.dataset.status);
  clearMessages();
  try {
    await api.changeStatus(row.dataset.userId, current === 1 ? 0 : 1);
    succeed(`已${current === 1 ? "禁用" : "启用"} ${row.dataset.username}`);
  } catch (error) {
    fail(error, "操作失败");
  }
}

/** 删除 */
async function handleDelete(row) {
  if (!window.confirm(`确定删除账号 ${row.dataset.username} 吗？其做题记录将一并删除。`)) return;
  clearMessages();
  try {
    await api.deleteUser(row.dataset.userId);
    succeed(`已删除 ${row.dataset.username}`);
  } catch (error) {
    fail(error, "操作失败");
  }
}

/* ---------------- 重置密码 ---------------- */

/** 展开 / 收起重置面板（对应 React 的 resetting 状态） */
function toggleResetPanel(row) {
  const panel = row.querySelector('[data-panel="reset"]');
  if (panel) panel.hidden = !panel.hidden;
}

function cancelReset(row) {
  const panel = row.querySelector('[data-panel="reset"]');
  const input = row.querySelector("[data-reset-input]");
  if (input) input.value = "";
  if (panel) panel.hidden = true;
}

async function confirmReset(row) {
  const input = row.querySelector("[data-reset-input]");
  if (!input) return;
  if (input.value.length < 6) {
    window.alert("密码至少 6 位");
    return;
  }
  clearMessages();
  try {
    await api.resetPassword(row.dataset.userId, input.value);
    succeed(`已重置 ${row.dataset.username} 的密码`);
  } catch (error) {
    fail(error, "操作失败");
  }
}

/* ---------------- 事件绑定 ---------------- */

if (root) {
  root.addEventListener("click", (event) => {
    if (event.target.closest("#admin-create")) {
      void handleCreate();
      return;
    }

    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;

    const row = button.closest("[data-user-row]");
    if (!row) return;

    switch (button.dataset.action) {
      case "reset-password":
        toggleResetPanel(row);
        break;
      case "reset-confirm":
        void confirmReset(row);
        break;
      case "reset-cancel":
        cancelReset(row);
        break;
      case "change-status":
        void handleStatus(row);
        break;
      case "delete":
        void handleDelete(row);
        break;
      default:
        break;
    }
  });

  // 角色下拉：change 时立即提交（与 React 的 onChange 一致）
  root.addEventListener("change", (event) => {
    const select = event.target.closest('select[data-action="change-role"]');
    if (select) void handleRoleChange(select);
  });

  // 显示上一次操作留下的提示（操作成功后整页刷新，见 succeed）
  const flash = takeFlash();
  if (flash) showMessage("notice", flash);
}
