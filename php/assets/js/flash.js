/**
 * 一次性页面提示（跨整页刷新传递）。
 *
 * 背景：PHP 版的部分操作成功后需要「整页刷新」来更新列表（等价 React 版重新拉数据），
 * 但刷新会把刚刚显示的提示冲掉——React 版是 SPA 内更新，提示能保留可见。
 * 这里用 sessionStorage 暂存一条提示，刷新后由页面脚本取出并显示，还原原版体验。
 *
 * 用法：
 *   setFlash("已删除 xxx");
 *   window.location.reload();
 *
 *   // 页面加载后（脚本启动处）
 *   const message = takeFlash();
 *   if (message) showMessage("notice", message);
 *
 * 隐私模式等 sessionStorage 不可用的场景静默忽略（退化为无提示，不影响主流程）。
 */

const KEY = "eq_flash_notice";

/** 存一条待显示提示（在 location.reload() 之前调用） */
export function setFlash(message) {
  try {
    window.sessionStorage.setItem(KEY, String(message));
  } catch {
    /* 忽略：storage 不可用时仅失去提示 */
  }
}

/** 取出并清除待显示提示（页面加载时调用一次） */
export function takeFlash() {
  try {
    const value = window.sessionStorage.getItem(KEY);
    if (value !== null) {
      window.sessionStorage.removeItem(KEY);
    }
    return value;
  } catch {
    return null;
  }
}
