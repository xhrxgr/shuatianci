/**
 * 全站脚本：移动端菜单、退出登录。
 *
 * 对应 React 版里由状态控制的两个交互：
 * - src/App.tsx 的汉堡菜单展开 / 收起
 * - 导航栏的「退出」按钮
 *
 * 切换到其它页面是普通链接跳转（服务端渲染），不在这里拦截。
 */

import { api, getToken, setToken } from "./api.js";

/**
 * 老 token 同步（升级兼容）。
 *
 * 页面由 PHP 渲染，靠 Cookie 识别登录态。如果浏览器里只有 localStorage 的 token
 * （升级到 PHP 版之前登录的），页面会被渲染成未登录——此时调一次 /api/auth/me，
 * 服务端会顺手把 Cookie 补上，再刷新一次即可恢复正常，且只会发生一次。
 */
async function syncLegacyToken() {
  const serverKnowsLoggedIn = document.body.dataset.authenticated === "1";
  if (serverKnowsLoggedIn || !getToken()) return;
  try {
    await api.me();
    window.location.reload();
  } catch {
    // token 已失效：api.js 已清掉本地 token，这里无需再做处理
  }
}

/** 移动端菜单 */
function setupMenu() {
  const toggle = document.getElementById("menu-toggle");
  const menu = document.getElementById("mobile-menu");
  if (!toggle || !menu) return;

  const iconOpen = toggle.querySelector('[data-icon="open"]');
  const iconClose = toggle.querySelector('[data-icon="close"]');

  const setOpen = (open) => {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
    if (iconOpen) iconOpen.hidden = open;
    if (iconClose) iconClose.hidden = !open;
  };

  toggle.addEventListener("click", () => {
    setOpen(menu.hidden);
  });

  // 点到菜单里的链接就收起（等价于 React 版路由变化后自动关闭）
  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });
}

/** 退出登录 */
function setupLogout() {
  document.querySelectorAll('[data-action="logout"]').forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api.logout();
      } catch (error) {
        // 退出失败也要把本地 token 清掉，否则页面一直显示已登录
        console.warn("[app] 退出登录失败", error);
      }
      setToken(null);
      window.location.href = "/";
    });
  });
}

setupMenu();
setupLogout();
void syncLegacyToken();
