/**
 * 一次性页面提示（跨整页刷新传递）。
 *
 * 背景：部分操作成功后需要「整页刷新」来更新列表，
 * 但刷新会把刚刚显示的提示冲掉。
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
 * 也可以存**对象**（结构化提示卡片）——showNotice 这类函数往往同时接受
 * 字符串和对象，刷新前存对象、刷新后原样取回，卡片能完整还原。
 * 字符串调用方（目前 16 处）行为完全不变。
 *
 * 隐私模式等 sessionStorage 不可用的场景静默忽略（退化为无提示，不影响主流程）。
 */

const KEY = "eq_flash_notice";
/** 标记值：说明 sessionStorage 里存的是 JSON 对象而不是普通字符串 */
const OBJECT_MARK = "obj:";

/** 存一条待显示提示（在 location.reload() 之前调用） */
export function setFlash(message) {
  try {
    if (message !== null && typeof message === "object") {
      window.sessionStorage.setItem(KEY, OBJECT_MARK + JSON.stringify(message));
    } else {
      window.sessionStorage.setItem(KEY, String(message));
    }
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
    if (value === null) return null;
    if (value.startsWith(OBJECT_MARK)) {
      try {
        return JSON.parse(value.slice(OBJECT_MARK.length));
      } catch {
        return null;
      }
    }
    return value;
  } catch {
    return null;
  }
}
