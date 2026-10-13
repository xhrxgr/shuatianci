/**
 * 统一反馈组件：成功 / 失败 / 警告 / 提示的呈现方式。
 *
 * 为什么要有这个
 * --------------
 * 之前每个页面各写一套 showNotice / showMessage / showFlash：
 * 12 个提示条、4 种写法、有的能自动消失有的不能、错误一律只有一行纯文本。
 * 结果是「哪里出错、错在哪、我该怎么办」三件事都答不上来。
 *
 * 这里定下四条规矩
 *   1. 按**语义**分级，不按出现位置分级：success / error / warn / info
 *   2. 错误可以带**详情**（多条逐行列出），可以带**重试**
 *   3. 只有成功类会自动消失；错误**留在页面上**直到下一次操作或用户关掉它
 *   4. 可访问性：role="status" / role="alert"，错误条能 Tab 到、能回车关
 *
 * 用法
 * ----
 *   import { notify, notifyError } from "./feedback.js";
 *
 *   notify("已保存");                                  // 成功，3 秒后自动消失
 *   notify("有 3 个标签待确认", "warn");
 *   notifyError(err.message);                          // 错误，常驻
 *   notifyError("校验未通过", {
 *     details: ["第 1 空：答案不能为空", "第 2 空：标签已停用"],
 *     retry: () => void submit(),// 给出重试入口
 *   });
 *   notifyError(err.message, { retry: () => void save() });
 *
 * 从 ApiError 自动判断：5xx 与网络错误默认带「重试」按钮，
 * 因为这两类重试有意义；4xx 是请求本身有问题，重试也白试。
 */

/* ---------------- 语气 ---------------- */

/** 各语气的 class。刻意用现有的设计变量，不引入新色 */
const TONES = {
  success: {
    box: "border-success/40 bg-success-soft text-success",
    icon: "M4 10.5 8 14.5l8-9",
    label: "成功",
    autoDismiss: true,
  },
  error: {
    box: "border-danger/40 bg-danger-soft text-danger",
    icon: "M10 6v5m0 3h.01M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z",
    label: "出错",
    autoDismiss: false,
  },
  warn: {
    box: "border-warning/40 bg-warning-soft text-warning",
    icon: "M10 7v4m0 3h.01M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z",
    label: "注意",
    autoDismiss: false,
  },
  info: {
    box: "border-line bg-surface-alt text-muted",
    icon: "M10 9v5m0-8h.01M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z",
    label: "提示",
    autoDismiss: true,
  },
};

/** 成功类停留时长（毫秒）。比常见的 3s 略长，文案通常带具体内容 */
const AUTO_DISMISS_MS = 4000;

/** 同一容器同时最多留几条（多了把最旧的清掉，避免刷屏） */
const MAX_PER_BOX = 3;

/* ---------------- 内部工具 ---------------- */

/** 提示条容器：优先用页面给定的，否则动态建一个挂在 main 里 */
function resolveContainer(boxId) {
  if (boxId) {
    const existing = document.getElementById(boxId);
    if (existing) return existing;
  }
  const host = document.getElementById("root") || document.body;
  const created = document.createElement("div");
  created.className = "mx-auto w-full max-w-3xl px-4 pt-4";
  host.insertBefore(created, host.firstChild);
  return created;
}

/** 给容器加上「这是个反馈区」的基础样式（只设一次） */
function ensureContainerStyle(container) {
  if (container.dataset.feedbackReady === "1") return;
  container.dataset.feedbackReady = "1";
  container.classList.add("space-y-2");
  container.classList.remove("hidden");
  container.hidden = false;
}

/** 把 details 里可能是数组 / 字符串 / 异常的值统一成字符串数组 */
function normalizeDetails(details) {
  if (!details) return [];
  const list = Array.isArray(details) ? details : [details];
  return list
    .map((item) => (item instanceof Error ? item.message : String(item)).trim())
    .filter((item) => item !== "");
}

/** SVG 图标（24 视口的描边路径，跟现有内联图标同一套画法） */
function icon(path, tone) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("h-4", "w-4", "shrink-0", "mt-0.5");
  svg.dataset.toneIcon = tone;
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.appendChild(p);
  return svg;
}

/* ---------------- 主入口 ---------------- */

/**
 * 显示一条反馈。
 *
 * @param {string} message 主文案，一句话说清发生了什么
 * @param {"success"|"error"|"warn"|"info"} tone 语气
 * @param {object} [options]
 * @param {string[]} [options.details] 详情逐条（校验失败的具体位置等）
 * @param {() => void} [options.retry] 给「重试」按钮；不传则不显示
 * @param {string} [options.boxId] 指定容器；不传则用默认容器
 * @param {string} [options.action] 追加操作按钮的文字（如「查看详情」）
 * @param {() => void} [options.onAction] 追加操作按钮的回调
 * @param {boolean} [options.sticky] 强制常驻（成功类也可以指定常驻）
 * @returns {HTMLElement} 生成的提示条，便于调用方继续操作
 */
export function notify(message, tone = "info", options = {}) {
  const config = TONES[tone] || TONES.info;
  const container = resolveContainer(options.boxId);
  ensureContainerStyle(container);

  // 刷屏保护：超过上限就把最旧的一条收掉
  while (container.children.length >= MAX_PER_BOX) {
    const oldest = container.firstElementChild;
    dismiss(oldest);
  }

  const box = document.createElement("div");
  box.className = `flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${config.box}`;
  box.setAttribute("role", tone === "error" ? "alert" : "status");
  box.dataset.tone = tone;

  // 正文区（可点击展开详情）
  const body = document.createElement("div");
  body.className = "min-w-0 flex-1";

  const text = document.createElement("p");
  text.className = "font-medium leading-6";
  text.textContent = String(message ?? "");
  body.appendChild(text);

  // 详情：默认折叠（一条就一行免得占地方），点「详细 N 条」展开
  const detailList = normalizeDetails(options.details);
  if (detailList.length > 0) {
    const details = document.createElement("ul");
    details.className = "mt-2 list-disc space-y-1 pl-5 text-xs leading-5 opacity-90";
    details.hidden = detailList.length > 3; // 超过 3 条默认折叠，少量直接展开
    detailList.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      details.appendChild(li);
    });
    body.appendChild(details);

    if (detailList.length > 3) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className =
        "mt-2 text-xs font-medium underline underline-offset-2 transition hover:opacity-80";
      const sync = () => {
        toggle.textContent = details.hidden
          ? `展开详细 ${detailList.length} 条问题`
          : "收起";
      };
      sync();
      toggle.addEventListener("click", () => {
        details.hidden = !details.hidden;
        sync();
      });
      body.appendChild(toggle);
    }
  }

  box.appendChild(icon(config.icon, tone));
  box.appendChild(body);

  // 尾部操作区
  const tail = document.createElement("div");
  tail.className = "flex shrink-0 items-center gap-2";

  // retryable 为真但调用方没给回调时，退化成「刷新页面重试」——
  // 总比只留一句「操作失败」让用户干瞪眼强
  const retryHandler =
    typeof options.retry === "function"
      ? options.retry
      : options.retryable
        ? () => window.location.reload()
        : null;

  if (retryHandler) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className =
      "rounded-md border border-current/30 px-3 py-1 text-xs font-medium transition hover:bg-surface";
    retryButton.textContent = "重试";
    retryButton.addEventListener("click", () => {
      dismiss(box);
      retryHandler();
    });
    tail.appendChild(retryButton);
  }

  if (options.action && typeof options.onAction === "function") {
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className =
      "rounded-md border border-current/30 px-3 py-1 text-xs font-medium transition hover:bg-surface";
    actionButton.textContent = options.action;
    actionButton.addEventListener("click", () => {
      dismiss(box);
      options.onAction();
    });
    tail.appendChild(actionButton);
  }

  // 关闭按钮：错误类常驻，必须给一条明确的出路
  if (!config.autoDismiss || options.sticky) {
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className =
      "rounded-md px-2 py-1 text-xs opacity-60 transition hover:opacity-100";
    closeButton.textContent = "关闭";
    closeButton.setAttribute("aria-label", "关闭这条提示");
    closeButton.addEventListener("click", () => dismiss(box));
    tail.appendChild(closeButton);
  }

  if (tail.childElementCount > 0) {
    box.appendChild(tail);
  }

  container.appendChild(box);

  // 自动消失只用于不需要用户处理的消息；错误一律留着
  if (config.autoDismiss && !options.sticky) {
    const timer = window.setTimeout(() => dismiss(box), options.duration ?? AUTO_DISMISS_MS);
    box.addEventListener("mouseenter", () => window.clearTimeout(timer), { once: true });
  }

  // 供键盘用户聚焦到新出现的错误
  if (tone === "error") {
    box.tabIndex = -1;
    box.focus({ preventScroll: true });
  }

  return box;
}

/**
 * 报错。会自动判断是否值得给「重试」。
 *
 * 判据（options.retryable 可覆盖）：
 *   - 传进来的**字符串**：多半是校验类错误（不是接口失败），默认不给重试。
 *     校验错误重试多少次都是同一个结果，给按钮反而误导用户。
 *   - 传进来的 **ApiError**：看 status。5xx 与网络错误（0）重试有意义；
 *     4xx 是请求本身有问题，试了也白试。
 *
 * @param {string|Error} message
 * @param {object} [options] 同 notify
 */
export function notifyError(message, options = {}) {
  const text = message instanceof Error ? message.message : String(message ?? "操作失败");
  const status = message?.status;
  let retryable;
  if (options.retryable !== undefined) {
    retryable = options.retryable;
  } else if (typeof message === "string") {
    retryable = false; // 校验类错误：内容没变，重试无意义
  } else {
    retryable = status === 0 || status === undefined || status >= 500;
  }
  return notify(text, "error", { ...options, retryable });
}

/** 便捷出口 */
export const notifySuccess = (message, options) => notify(message, "success", options);
export const notifyWarn = (message, options) => notify(message, "warn", options);
export const notifyInfo = (message, options) => notify(message, "info", options);

/** 清掉指定容器（或默认容器）里的全部提示 */
export function clearFeedback(boxId) {
  const container = boxId
    ? document.getElementById(boxId)
    : document.querySelector('[data-feedback-ready="1"]');
  if (!container) return;
  Array.from(container.children).forEach(dismiss);
}

/** 移除一条提示（带淡出，动画期间先脱离布局避免跳动） */
function dismiss(box) {
  if (!box || box.dataset.dismissing === "1") return;
  box.dataset.dismissing = "1";
  box.style.opacity = "0";
  box.style.transition = "opacity .18s ease";
  window.setTimeout(() => box.remove(), 180);
}

/**
 * 展开的详情用 <ul>，这里判断某条提示是否处于展开态（测试用）。
 * 不作为业务接口，仅让页面测试能断言「详情确实能看到」。
 */
export function isExpanded(box) {
  const list = box?.querySelector("ul");
  return !!list && !list.hidden;
}