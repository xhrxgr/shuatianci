/**
 * 用户管理交互。
 *
 * 列表由 PHP 直出，本脚本负责全部写操作与按需读取：
 * - 新建用户 / 重置密码 / 调整角色 / 启用禁用 / 删除：调 /api/admin/*
 *
 * 成功后整页刷新以更新列表。
 * 三条自我保护（不能改自己角色 / 禁用自己 /
 * 删自己）由后端拦截，这里只负责把后端返回的错误原样提示。
 */

import { api } from "./api.js";
import { setFlash, takeFlash } from "./flash.js";
import { notify, notifyError, clearFeedback } from "./feedback.js";
import { escapeHtml } from "./escape-html.js";

const root = document.getElementById("admin-users-root");

/**
 * 顶部提示条。
 *
 * 呈现交给 feedback.js：按语义选配色、错误常驻、成功自动消失。
 * boxId 用页面原有的 id，位置与样式不变，测试仍能按 id 定位。
 */
function showMessage(kind, message, options = {}) {
  return kind === "error"
    ? notifyError(message, { boxId: "admin-users-error", ...options })
    : notify(message, "success", { boxId: "admin-users-notice", ...options });
}

/** 清掉上一条提示（每次操作前先调用） */
function clearMessages() {
  ["admin-users-error", "admin-users-notice"].forEach((id) => clearFeedback(id));
}

/** 成功：暂存提示并整页刷新（刷新后由启动处取出显示） */
function succeed(message) {
  setFlash(message);
  window.location.reload();
}

/**
 * 失败：展示后端返回的错误信息（取 err.message）。
 *
 * retry 用于「点重试就重新执行这次操作」——重置密码、改角色这类
 * 点一下就生效的操作，不该让用户刷新页面重新填一遍。
 */
function fail(error, fallback, retry) {
  showMessage("error", error ?? fallback, { retry });
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
    // 重试用同一份输入（用户名/密码框内容不清空），
    // 典型场景是「用户名撞了，改个名再点重试」
    fail(error, "操作失败", () => void handleCreate());
  }
}

/* ---------------- 行内操作 ---------------- */

/** 调整角色 */
async function handleRoleChange(select) {
  const row = select.closest("[data-user-row]");
  if (!row) return;
  clearMessages();
  try {
    const userId = row.dataset.userId;
    const nextRole = select.value;
    await api.changeRole(userId, nextRole);
    succeed(`已修改 ${row.dataset.username} 的角色`);
  } catch (error) {
    // 失败（例如改自己的角色被后端拒绝）时把下拉恢复成原角色
    select.value = select.dataset.currentRole;
    fail(error, "操作失败", () => void handleRoleChange(select));
  }
}

/** 启用 / 禁用 */
async function handleStatus(row) {
  const current = Number(row.dataset.status);
  const userId = row.dataset.userId;
  clearMessages();
  try {
    await api.changeStatus(userId, current === 1 ? 0 : 1);
    succeed(`已${current === 1 ? "禁用" : "启用"} ${row.dataset.username}`);
  } catch (error) {
    fail(error, "操作失败", () => void handleStatus(row));
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
    // 删除要再确认一次，不能「点重试就真删了」
    fail(error, "操作失败", () => void handleDelete(row));
  }
}

/* ---------------- 重置密码 ---------------- */

/** 展开 / 收起重置面板 */
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
    // 原先用 window.alert，样式与页面不一致、还阻塞整个交互，
    // 改成页面内的提示条；输入内容不清空，改完就能再提交
    showMessage("error", "密码至少 6 位，请改后再提交", {
      details: ["当前填写 " + input.value.length + " 位"],
    });
    input.focus();
    return;
  }
  clearMessages();
  try {
    await api.resetPassword(row.dataset.userId, input.value);
    succeed(`已重置 ${row.dataset.username} 的密码`);
  } catch (error) {
    // 输入框内容保留，「重试」即可再次提交
    fail(error, "操作失败", () => void confirmReset(row));
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

  // 角色下拉：change 时立即提交
  root.addEventListener("change", (event) => {
    const select = event.target.closest('select[data-action="change-role"]');
    if (select) void handleRoleChange(select);
  });

  // 显示上一次操作留下的提示（操作成功后整页刷新，见 succeed）
  const flash = takeFlash();
  if (flash) showMessage("notice", flash);
}
