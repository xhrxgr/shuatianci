/**
 * 防重复执行 + 状态占位。
 *
 * 手机端这两个问题特别明显：
 *
 * ① **重复点击**
 * 触摸没有 hover，用户常连点两下确认「刚才那下到底点没点上」。
 * 重复执行的后果不都是幂等的 —— 「保存」会推两次提示、「导入」可能建两份篇章、
 * 「删除」第二次弹窗里的题数已经变了。所以**不能只靠后端幂等兜底**，
 * 按钮层面就得先挡住。
 *
 * ② **占位缺失**
 * 请求在飞的时候界面毫无反应，用户不知道点没点上，于是再点一下（回到 ①）；
 * 空列表与失败也长得一样，分不清是「没有数据」还是「加载失败」。
 */

/* ---------------------------------------------------------------------------
 * 防重复执行
 * ------------------------------------------------------------------------- */

/**
 * 把一个异步操作包成「同一时刻只跑一个」。
 *
 * @param {() => Promise<T>} fn
 * @param {string} key 同名操作之间的去重键（一般用操作名）
 * @returns {() => Promise<T|undefined>}
 */
export function once(fn, key = "default") {
  let running = false;
  return async (...args) => {
    if (running) return undefined;
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;   // 必须放 finally：失败也要解锁，否则一次失败后永久卡死
    }
  };
}

/**
 * 把按钮绑成「点一次、执行中禁用、成功后复原」。
 *
 * 比 once 更适合 UI：期间按钮真的变灰、写着「处理中…」，
 * 用户能看到自己那一下生效了，而不是对着一个毫无反应的按钮再点。
 *
 * @param {HTMLElement|null} button
 * @param {() => Promise<any>} fn
 * @param {{busyText?: string, minBusyMs?: number}} [options]
 */
export function guardButton(button, fn, options = {}) {
  const { busyText = "处理中…", minBusyMs = 0 } = options;
  return async (...args) => {
    if (!button || button.disabled) return undefined;
    const originalText = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = busyText;
    try {
      const result = await fn(...args);
      // 太快复原会让用户以为没点上，反而再点一次；
      // 留一个短下限，体验上更像「确实执行了」
      if (minBusyMs > 0) {
        await new Promise((r) => setTimeout(r, minBusyMs));
      }
      return result;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = originalText;
    }
  };
}

/* ---------------------------------------------------------------------------
 * 状态占位
 * ------------------------------------------------------------------------- */

/** 三种占位的文案与配色，尽量复用现有 token，不引入新视觉语言 */
const PLACEHOLDER = {
  loading: { text: "加载中…", cls: "text-faint" },
  empty: { text: "这里还没有内容", cls: "text-faint" },
  error: { text: "加载失败", cls: "text-danger" },
};

/**
 * 在容器里渲染一种状态占位。
 *
 * 失败态带「重试」按钮 —— 这是最关键的一环：只显示「加载失败」用户只能刷新页面，
 * 而重试按钮让失败变成一次点击就能恢复的事。
 *
 * @param {HTMLElement|null} box
 * @param {"loading"|"empty"|"error"} kind
 * @param {{message?: string, onRetry?: (() => void)|null}} [options]
 */
export function renderState(box, kind, options = {}) {
  if (!box) return;
  const { message, onRetry = null } = options;
  const preset = PLACEHOLDER[kind] ?? PLACEHOLDER.empty;

  if (kind === "error" && typeof onRetry === "function") {
    box.innerHTML = `<div class="flex flex-wrap items-center gap-2 text-sm ${preset.cls}">
      <span>${escapeText(message || preset.text)}</span>
      <button type="button" data-state-retry
        class="min-h-11 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-alt">
        重试
      </button>
    </div>`;
    box.querySelector("[data-state-retry]")?.addEventListener("click", onRetry);
    return;
  }

  const text = message || preset.text;
  box.innerHTML =
    kind === "loading"
      ? `<p class="flex items-center gap-2 text-sm ${preset.cls}">
           <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-primary"></span>
           ${escapeText(text)}
         </p>`
      : `<p class="text-sm ${preset.cls}">${escapeText(text)}</p>`;
}

/**
 * 载入一个列表型数据，自动处理三态。
 *
 * 这是各处「加载列表」的标准写法：调用方只管给渲染函数，
 * 空 / 失败 / 加载中由这里统一接管，不用每处各写一遍。
 *
 * @param {HTMLElement|null} box  容器
 * @param {() => Promise<any>} loader  取数据
 * @param {(data: any, box: HTMLElement) => void} render  有数据时怎么渲染
 * @param {{emptyText?: string, label?: string}} [options]
 */
export async function loadInto(box, loader, render, options = {}) {
  const { emptyText = "这里还没有内容", label = "数据" } = options;
  if (!box) return;

  renderState(box, "loading", { message: `${label}加载中…` });
  try {
    const data = await loader();
    // 空判定要兼容多种形态：null / [] / {} / {items: []}
    const isEmpty =
      data === null ||
      data === undefined ||
      (Array.isArray(data) && data.length === 0) ||
      (typeof data === "object" && !Array.isArray(data) &&
        Array.isArray(data.items) && data.items.length === 0);
    if (isEmpty) {
      renderState(box, "empty", { message: emptyText });
      return;
    }
    render(data, box);
  } catch (error) {
    renderState(box, "error", {
      message: error?.message ?? `${label}加载失败`,
      onRetry: () => void loadInto(box, loader, render, options),
    });
  }
}

/** 占位里也要转义 —— 错误信息可能含服务端原文 */
function escapeText(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}