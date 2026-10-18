/**
 * 弹窗的打开 / 关闭，带降级。
 *
 * 为什么要这层
 * ------------
 * 原生 `<dialog>.showModal()` 依赖浏览器的 **top layer**：弹窗被提升到
 * 独立层，天然盖住整页、点空白处不会误触背后的元素。
 *
 * 但部分手机浏览器（微信 / QQ 内置浏览器、若干国产 WebView）对这个 API
 * 支持不完整：方法不存在、或调了但不进 top layer。表现是**弹窗里的按钮点不动**
 * —— 内容能看见，却有别的东西叠在上面。v3.8.9 在桌面端修好了，手机端仍复现，
 * 根因就是这里。
 *
 * 所以探测一次：能用就用原生，不能就走 `setAttribute("open")` 的降级路径
 * （样式由 app.css 里 `html.no-dialog dialog` 那段兜住）。
 *
 * ⚠️ 探测必须在**第一次开弹窗之前**做完，并且只做一次：
 * `no-dialog` 这个类是全局开关，中途加会让已经打开的原生弹窗样式突变。
 */

/** 浏览器是否支持 top layer 版 dialog */
const supportsTopLayer = (() => {
  try {
    if (typeof HTMLDialogElement === "undefined") return false;
    if (typeof HTMLDialogElement.prototype.showModal !== "function") return false;
    // 有实现不等于能用：老 WebView 里 showModal 存在但调用即抛。
    // 造一个一次性的探测弹窗真调一次，比查版本号可靠。
    const probe = document.createElement("dialog");
    probe.showModal();
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

if (!supportsTopLayer) {
  document.documentElement.classList.add("no-dialog");
}

/**
 * 打开弹窗。
 *
 * @param {HTMLDialogElement|null} dialog
 */
export function openModal(dialog) {
  if (!dialog) return;
  if (dialog.open) return;
  if (supportsTopLayer) {
    try {
      dialog.showModal();
      return;
    } catch {
      // 真机上仍可能抛 —— 落回降级路径，别让用户看到「点了没反应」
    }
  }
  dialog.setAttribute("open", "");
}

/**
 * 关闭弹窗。
 *
 * @param {HTMLDialogElement|null} dialog
 */
export function closeModal(dialog) {
  if (!dialog) return;
  if (!dialog.open && !dialog.hasAttribute("open")) return;
  if (supportsTopLayer && typeof dialog.close === "function") {
    try {
      dialog.close();
      return;
    } catch {
      // 降级路径见下
    }
  }
  dialog.removeAttribute("open");
}

/**
 * 弹窗是否处于打开状态。降级路径下 `open` 属性照样反映状态，
 * 但统一从这里读，免得各处自己判断 open / hasAttribute 两套口径。
 *
 * @param {HTMLDialogElement|null} dialog
 * @returns {boolean}
 */
export function isModalOpen(dialog) {
  if (!dialog) return false;
  return dialog.open || dialog.hasAttribute("open");
}

/**
 * 降级路径补上原生 dialog 自带的两项行为：
 *   · Esc 关闭（top layer 下是浏览器做的，这里自己接）
 *   · 点遮罩空白处关闭
 *
 * 两条都只对降级路径生效，支持 top layer 时由浏览器负责，不重复接管
 * （否则 Esc 会被关两次：先浏览器关、再我们关，虽然不至于出错但没必要）。
 *
 * @param {HTMLDialogElement} dialog
 */
function bindFallbackDismiss(dialog) {
  if (dialog.dataset.fallbackBound === "1") return;
  dialog.dataset.fallbackBound = "1";

  dialog.addEventListener("click", (event) => {
    // 命中 dialog 自身的区域 == 点在遮罩上（内容在 dialog 的子元素里）
    if (event.target === dialog) {
      closeModal(dialog);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isModalOpen(dialog)) {
      closeModal(dialog);
    }
  });
}

/** 打开弹窗（同 openModal，额外接上降级路径的关闭方式） */
export function openDialog(dialog) {
  if (!dialog) return;
  if (!supportsTopLayer) {
    bindFallbackDismiss(dialog);
  }
  openModal(dialog);
}