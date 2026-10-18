/**
 * 弹窗：一套实现，所有浏览器行为一致。
 *
 * 为什么不用原生 `<dialog>`
 * ----------------------
 * v3.9.1 试过「能用 showModal 就用、不能就降级」，结果是**要维护两套路径**：
 * 两套 CSS 分支、一个 `html.no-dialog` 开关、一个只在降级时生效的遮罩伪元素，
 * 还要单独写一套降级测试。更糟的是它救不了根本问题 —— 部分手机浏览器
 * （微信 / QQ 内置浏览器、若干国产 WebView）对 top layer 支持不完整，
 * 「调了但不进 top layer」这种半支持状态规范里没有对应的降级写法，只能靠猜。
 *
 * 所以彻底不用 `<dialog>`，自己实现。四件事本来就该自己做，
 * 而且自己做反而更可控：
 *   ① 遮罩（fixed 全屏层，pointer-events 吃点击）
 *   ② 滚动锁（body overflow:hidden，iOS 还要补 position:fixed）
 *   ③ 焦点管理（打开时聚焦首个可交互元素，Tab 循环不逃出弹窗）
 *   ④ Esc 关闭 + 点遮罩关闭
 *
 * **只有一条代码路径**，行为在所有浏览器里完全一致 ——
 * 包括那些原生 dialog 会失灵的 WebView。
 *
 * HTML 约定：弹窗容器是
 *   `<div class="modal" id="…" hidden><div class="modal-body">…</div></div>`
 * `.modal` 负责定位与遮罩，`.modal-body` 负责卡片外观。
 * 容器上的 `hidden` 是唯一的开关，`.modal:not([hidden])` 负责显示。
 */

/** 当前打开的弹窗（同一时刻只允许一个） */
let current = null;
/** 上一个获得焦点的元素，关闭后还回去 */
let lastFocused = null;
/** 锁滚动前的页面滚动位置（iOS 用 position:fixed 锁时必须记住） */
let scrollY = 0;

function isOpen(modal) {
  return Boolean(modal) && !modal.hidden;
}

/**
 * 锁住背景滚动。
 *
 * 只用 `overflow:hidden` 的话，iOS Safari 的橡皮筋仍会把背景拖动一段
 * （再往回弹会弹过头），所以 iOS 上额外用 `position:fixed` + `top` 固定住。
 * 用 fixed 就必须记住并还原滚动位置，否则关闭弹窗后页面会跳到顶部。
 */
function lockScroll() {
  scrollY = window.scrollY;
  const body = document.body;
  body.classList.add("modal-locked");
  // 非 iOS 只靠 overflow:hidden 就够，position:fixed 会让某些浏览器丢失滚动位置
  if (/iP(hone|ad|od)/.test(navigator.userAgent) && !window.MSStream) {
    body.style.top = `-${scrollY}px`;
  }
}

function unlockScroll() {
  const body = document.body;
  const hadOffset = body.style.top !== "";
  body.classList.remove("modal-locked");
  body.style.top = "";
  // 只有走过 iOS 那条 position:fixed 分支才需要还原滚动位置
  if (hadOffset) {
    window.scrollTo(0, scrollY);
  }
}

/** 弹窗内可交互的元素（Tab 循环的边界） */
function focusables(modal) {
  return [
    ...modal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * 打开弹窗。
 *
 * @param {HTMLElement|null} modal
 * @param {{focus?: string}} [options] focus 指定要聚焦的元素的 CSS 选择器
 */
export function openModal(modal, options = {}) {
  if (!modal || isOpen(modal)) return;

  if (current && current !== modal) {
    closeModal(current);
  }
  current = modal;
  lastFocused = document.activeElement;

  modal.hidden = false;
  // 下一帧再锁滚动：立刻锁会在某些浏览器里打断滚动位置恢复
  requestAnimationFrame(lockScroll);

  const target =
    (options.focus && modal.querySelector(options.focus)) || focusables(modal)[0] || modal;
  // 没有可交互元素时，容器自己需要能接收焦点
  if (target === modal && !modal.hasAttribute("tabindex")) {
    modal.setAttribute("tabindex", "-1");
  }
  target.focus({ preventScroll: true });
}

/**
 * 关闭弹窗。
 *
 * @param {HTMLElement|null} modal 不传则关掉当前打开的那个
 */
export function closeModal(modal) {
  const target = modal || current;
  if (!isOpen(target)) return;

  target.hidden = true;
  unlockScroll();
  if (current === target) current = null;

  // 焦点还回去，否则键盘用户会「丢失」在页面开头
  if (lastFocused && document.contains(lastFocused)) {
    lastFocused.focus({ preventScroll: true });
  }
  lastFocused = null;
}

/** 弹窗是否开着 */
export function isModalOpen(modal) {
  return isOpen(modal || current);
}

/* ---------------------------------------------------------------------------
 * 全局事件：只绑一次
 * ------------------------------------------------------------------------- */

if (typeof document !== "undefined") {
  document.addEventListener("keydown", (event) => {
    if (!current) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeModal(current);
      return;
    }

    // Tab 循环：焦点不能跑到弹窗外面去，否则用户 Tab 一下就「消失」了
    if (event.key === "Tab") {
      const items = focusables(current);
      if (items.length === 0) {
        event.preventDefault();
        current.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // 点遮罩关闭：命中 `.modal` 自身 == 点在遮罩上（内容在 `.modal-body` 里）
  document.addEventListener("click", (event) => {
    if (!current) return;
    if (event.target === current) {
      closeModal(current);
    }
  });

  // 页面从 BFCache 回来时弹窗状态可能对不上，兜底收掉，避免「关不掉的弹窗」
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && current) {
      closeModal(current);
    }
  });
}