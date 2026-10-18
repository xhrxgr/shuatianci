/**
 * 页面生命周期：切后台、中断恢复、页面返回（BFCache）。
 *
 * 手机上这三件事发生得远比桌面频繁，而且每个都可能留下脏状态：
 *
 * ① **切后台 / 锁屏**
 * 请求还在飞，回来时可能已经超时或失败，界面停在「加载中」。
 * 正确做法是页面重新可见时，把仍处于加载态的区域重置掉。
 *
 * ② **BFCache（页面返回）**
 * 从详情页返回列表页，页面可能**根本没重新执行**脚本（从内存快照恢复），
 * 而这期间数据可能已经被别的操作改过。不做任何处理的话，
 * 用户会看到返回前的旧数据，并以为那就是最新的。
 *
 * ③ **iOS Safari 杀进程后恢复**
 * 前进/后退缓存把整页恢复出来，但网络连接可能已经变了。
 *
 * 这里统一处理：在 pageshow 的 persisted 阶段（也就是真的走了 BFCache）
 * 派发一个自定义事件，由各页面决定要不要重新取数。
 * 页面可见性变化（切后台回来）也派发同一个事件。
 */

/** 页面「可能已过期」的统一信号 */
export const STALE_EVENT = "app:stale";

/**
 * 登记一个「页面变旧了就要刷新」的回调。
 *
 * @param {() => void} fn
 * @param {{immediate?: boolean}} [options] immediate=true 时首次加载后也调用一次，
 *        用来在恢复可见时把加载态复位
 * @returns {() => void} 取消登记
 */
export function onStale(fn, options = {}) {
  const { immediate = false } = options;
  const handler = () => {
    try {
      fn();
    } catch (error) {
      console.error("[lifecycle] 刷新回调出错", error);
    }
  };
  window.addEventListener(STALE_EVENT, handler);
  if (immediate) handler();
  return () => window.removeEventListener(STALE_EVENT, handler);
}

/** 在页面恢复时派发事件 */
function dispatchStale(reason) {
  window.dispatchEvent(new CustomEvent(STALE_EVENT, { detail: { reason } }));
}

if (typeof window !== "undefined") {
  // pageshow 的 persisted=true 表示页面是从 BFCache 直接取回的，
  // 脚本没有重新执行 —— 这正是必须补一次刷新的场景
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      dispatchStale("bfcache");
    }
  });

  // 从后台回到前台。等一拍再派发：刚恢复时 DOM 可能还没稳定
  let resumeTimer = null;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => dispatchStale("resume"), 250);
  });

  // 网络恢复：断网期间发起的请求多半已经失败，回来后告诉页面可以重试
  window.addEventListener("online", () => dispatchStale("online"));
  window.addEventListener("offline", () => dispatchStale("offline"));
}

/**
 * 页面隐藏时中止在途请求。
 *
 * 不中止的话，用户切走再回来，那些请求还挂着并会继续写入已重渲染的 DOM，
 * 表现为「刷新回来后列表里莫名多出几条」或者提示条重复弹出。
 *
 * @param {AbortSignal} signal
 */
export function abortWhenHidden(signal) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  document.addEventListener("visibilitychange", stop, { once: false });
  signal?.addEventListener?.("abort", () => {
    document.removeEventListener("visibilitychange", stop);
  });
  return controller.signal;
}