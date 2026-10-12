/**
 * 系统设置交互（对应 src/pages/System.tsx）。
 *
 * 页面骨架由 PHP 直出，本脚本负责全部动态内容与交互：
 * - 加载当前版本：GET /api/system/version
 * - 检查更新：POST /api/system/check-update（列出待更新提交）
 * - 执行更新：POST /api/system/update，随后每 2 秒轮询 GET /api/system/update-status
 *   （与 React 版同一节奏；服务重启期间轮询失败属预期内，继续等待）
 *
 * 状态机与 React 版逐项对应（version / gitAvailable / check / loading /
 * checking / updating / stage / logs / error / notice / restarting），
 * 所有动态文本都经过 escapeHtml。
 */

import { api } from "./api.js";

const root = document.getElementById("admin-system-root");
const loadingEl = document.getElementById("admin-system-loading");
const errorBox = document.getElementById("admin-system-error");
const noticeBox = document.getElementById("admin-system-notice");

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
  const box = kind === "error" ? errorBox : noticeBox;
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

/** 清掉上一条提示（与 React 版操作前 setError("") / setNotice("") 一致） */
function clearMessages() {
  [errorBox, noticeBox].forEach((box) => {
    if (box) {
      box.hidden = true;
      box.textContent = "";
    }
  });
}

/** ISO 时间转本地可读格式（与 React 版 formatTime 一致） */
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

if (root) {
  const versionBody = root.querySelector("[data-version-body]");
  const updateActions = root.querySelector("[data-update-actions]");
  const checkResult = root.querySelector("[data-check-result]");
  const progressSection = document.getElementById("admin-system-progress");
  const stageEl = document.getElementById("admin-system-stage");
  const logsEl = document.getElementById("admin-system-logs");
  const updatingHint = document.getElementById("admin-system-updating-hint");
  const reloadBtn = document.getElementById("admin-system-reload");

  /* ---------------- 状态（对应 React 的 useState） ---------------- */

  let version = null;
  /** 项目目录是否为 git 仓库。复制粘贴部署的目录没有 .git，在线更新不可用 */
  let gitAvailable = true;
  let check = null;
  let checking = false;
  let updating = false;
  let stage = "";
  let logs = [];
  /** 更新完成后服务会重启，此时轮询失败属正常，用一个标记区分 */
  let restarting = false;
  let pollTimer = null;

  /* ---------------- 渲染 ---------------- */

  /** 当前版本区块 */
  function renderVersion() {
    if (!versionBody) return;
    if (version && gitAvailable) {
      versionBody.innerHTML = `<dl class="space-y-2 text-sm">
  <div class="flex flex-wrap gap-x-3">
    <dt class="w-20 shrink-0 text-muted">提交</dt>
    <dd class="font-mono text-ink">${escapeHtml(version.shortCommit)}</dd>
  </div>
  <div class="flex flex-wrap gap-x-3">
    <dt class="w-20 shrink-0 text-muted">分支</dt>
    <dd class="text-ink">${escapeHtml(version.branch)}</dd>
  </div>
  ${
    version.phpVersion
      ? `<div class="flex flex-wrap gap-x-3">
    <dt class="w-20 shrink-0 text-muted">PHP</dt>
    <dd class="text-ink">${escapeHtml(version.phpVersion)}</dd>
  </div>`
      : ""
  }
  <div class="flex flex-wrap gap-x-3">
    <dt class="w-20 shrink-0 text-muted">时间</dt>
    <dd class="text-ink">${escapeHtml(formatTime(version.commitDate))}</dd>
  </div>
  <div class="flex flex-wrap gap-x-3">
    <dt class="w-20 shrink-0 text-muted">说明</dt>
    <dd class="text-ink">${escapeHtml(version.commitSubject)}</dd>
  </div>
</dl>`;
    } else {
      // 后端会在 commitSubject 里给出具体原因（不是 git 仓库 / 函数被禁用 / 缺 git 等）
      const reason =
        version && version.commitSubject
          ? escapeHtml(version.commitSubject)
          : "未能读取版本信息";
      versionBody.innerHTML = `<p class="text-sm text-muted">${reason}</p>`;
    }
  }

  /** 「检查更新」区块的顶部动作区（非 git 仓库时是警告，否则是按钮） */
  function renderUpdateActions() {
    if (!updateActions) return;
    if (!gitAvailable) {
      const reason =
        version && version.commitSubject
          ? escapeHtml(version.commitSubject)
          : "项目目录不是 git 仓库。";
      updateActions.innerHTML = `<div class="rounded-lg border border-warning/40 bg-warning-soft p-4">
  <p class="text-sm font-medium text-ink">当前部署不支持在线更新</p>
  <p class="mt-2 text-xs leading-5 text-ink">${reason}</p>
  <p class="mt-2 text-xs leading-5 text-muted">
    在线更新依赖服务器上的 git 与 PHP 的进程函数；按 README「网页一键更新」一节完成配置后，
    这里就能直接检查和更新。
  </p>
</div>`;
      return;
    }

    const disabled = checking || updating;
    updateActions.innerHTML = `<p class="mb-4 text-xs leading-5 text-muted">
  点击后服务器会向代码仓库查询是否有新提交。需要服务器已配置好仓库的访问凭据。
</p>

<button
  type="button"
  data-action="check"
  ${disabled ? "disabled" : ""}
  class="min-h-11 rounded-xl border border-line px-5 py-3 text-sm text-ink transition hover:bg-surface-alt disabled:cursor-not-allowed disabled:text-faint"
>${checking ? "检查中..." : "检查更新"}</button>`;
  }

  /** 检查更新的结果（有无待更新提交） */
  function renderCheckResult() {
    if (!checkResult) return;

    if (check && check.hasUpdate) {
      const commits = check.commits ?? [];
      const items = commits
        .slice(0, 10)
        .map(
          (commit) =>
            `<li class="flex gap-2 text-xs"><span class="shrink-0 font-mono text-muted">${escapeHtml(
              commit.hash
            )}</span><span class="text-ink">${escapeHtml(commit.subject)}</span></li>`
        )
        .join("");
      const more =
        commits.length > 10
          ? `<li class="text-xs text-muted">还有 ${escapeHtml(commits.length - 10)} 个提交未列出</li>`
          : "";
      const dirty = check.dirty
        ? `<p class="mt-3 text-xs text-danger">注意：服务器上的代码有未提交的改动，更新可能失败。建议先在服务器上处理。</p>`
        : "";

      checkResult.innerHTML = `<div class="mt-5 rounded-xl border border-primary/30 bg-primary-soft p-4">
  <p class="text-sm font-medium text-ink">
    发现 ${escapeHtml(check.behind)} 个新提交（${escapeHtml(check.current.shortCommit)} → ${escapeHtml(
        (check.latest && check.latest.shortCommit) || ""
      )}）
  </p>

  <ul class="mt-3 space-y-1.5">${items}${more}</ul>

  ${dirty}

  <button
    type="button"
    data-action="update"
    ${updating ? "disabled" : ""}
    class="mt-4 min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
  >${updating ? "更新中..." : "立即更新"}</button>

  <p class="mt-3 text-xs leading-5 text-muted">
    更新会自动完成：拉取代码 → 应用新版本 → 刷新缓存。
    若中途失败会自动回滚到当前版本，站点不会中断。
  </p>
</div>`;
      return;
    }

    if (check && !check.hasUpdate) {
      checkResult.innerHTML = `<p class="mt-4 text-sm text-success">已是最新版本。</p>`;
      return;
    }

    checkResult.innerHTML = "";
  }

  /** 更新进度区块 */
  function renderProgress() {
    if (!progressSection) return;
    const visible = updating || logs.length > 0;
    progressSection.hidden = !visible;

    if (stageEl) {
      stageEl.hidden = stage === "";
      stageEl.textContent = stage;
    }

    if (logsEl) {
      logsEl.innerHTML =
        logs.length === 0
          ? `<p class="text-xs text-muted">等待服务器响应...</p>`
          : logs
              .map((line) => `<p class="font-mono text-xs leading-6 text-ink">${escapeHtml(line)}</p>`)
              .join("");
    }

    if (updatingHint) updatingHint.hidden = !updating;
    if (reloadBtn) reloadBtn.hidden = !(restarting && !updating);
  }

  /** 页面主体在首次加载完成后才显示（对应 React 的 loading 判断） */
  function revealPage() {
    if (loadingEl) loadingEl.hidden = true;
    root.hidden = false;
  }

  /* ---------------- 动作 ---------------- */

  /** 读取当前版本 */
  async function loadVersion() {
    try {
      const result = await api.systemVersion();
      version = result.version;
      gitAvailable = result.gitAvailable !== false;
    } catch (error) {
      showMessage("error", error?.message ?? "读取版本失败");
    } finally {
      revealPage();
    }
    renderVersion();
    renderUpdateActions();
  }

  /** 检查更新 */
  async function handleCheck() {
    checking = true;
    clearMessages();
    renderUpdateActions();
    try {
      const result = await api.checkUpdate();
      check = result;
      if (!result.hasUpdate) showMessage("notice", "已是最新版本");
    } catch (error) {
      showMessage("error", error?.message ?? "检查更新失败");
    } finally {
      checking = false;
    }
    renderUpdateActions();
    renderCheckResult();
  }

  /** 轮询更新进度（每 2 秒一次，与 React 版一致） */
  function startPolling() {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(async () => {
      try {
        const status = await api.updateStatus();
        stage = status.stage;
        logs = status.log;
        renderProgress();

        if (status.finished) {
          if (pollTimer !== null) window.clearInterval(pollTimer);
          pollTimer = null;
          updating = false;
          if (status.error) {
            showMessage("error", `更新失败：${status.error}`);
          } else {
            showMessage("notice", "更新完成，正在自动刷新页面以应用新版本…（若未自动刷新，点下方按钮）");
            restarting = true;
            // 新代码已就位（opcache 由后端自动刷新），短暂停留后自动重载页面，
            // 让管理员直接看到新版本号与新的前端资源，无需任何手动操作
            window.setTimeout(() => {
              window.location.reload();
            }, 2500);
          }
          renderUpdateActions();
          renderCheckResult();
          renderProgress();
        }
      } catch {
        // 后端重启期间请求会失败，这是预期内的，继续轮询等它回来
        restarting = true;
        renderProgress();
      }
    }, 2000);
  }

  /** 开始更新 */
  async function handleUpdate() {
    if (!window.confirm("确定要更新到最新版本吗？\n\n更新完成后页面会自动刷新；更新过程中站点可能短暂无响应，属正常现象。")) {
      return;
    }

    updating = true;
    clearMessages();
    logs = [];
    stage = "准备中";
    restarting = false;
    renderUpdateActions();
    renderCheckResult();
    renderProgress();

    try {
      await api.startUpdate();
      startPolling();
    } catch (error) {
      updating = false;
      showMessage("error", error?.message ?? "启动更新失败");
      renderUpdateActions();
      renderCheckResult();
      renderProgress();
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;

    switch (button.dataset.action) {
      case "check":
        void handleCheck();
        break;
      case "update":
        void handleUpdate();
        break;
      case "reload":
        window.location.reload();
        break;
      default:
        break;
    }
  });

  // 组件卸载时停止轮询（原生页面直接离开即可，这里保持与 React 版一致的清理习惯）
  window.addEventListener("beforeunload", () => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
  });

  void loadVersion();
}
