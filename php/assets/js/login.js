/**
 * 登录 / 注册页交互。
 *
 * 行为：
 * - 登录 / 注册两种模式，切换时清空错误提示
 * - 空用户名或空密码提示「请填写用户名和密码」
 * - 注册成功后直接登录
 * - 错误提示：文案含「成功」用绿底，否则红底
 * - 成功后跳回首页（或来源页）
 */

import { api, setToken } from "./api.js";

const form = document.getElementById("login-form");
const title = document.getElementById("login-title");
const desc = document.getElementById("login-desc");
const errorBox = document.getElementById("login-error");
const submit = document.getElementById("login-submit");
const switchButton = document.getElementById("login-switch");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");

if (form && submit && switchButton) {
  let mode = "login";

  const showError = (message) => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.className = message.includes("成功")
      ? "rounded-lg bg-success-soft px-3 py-2 text-xs text-success"
      : "rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger";
  };

  const clearError = () => {
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = "";
    }
  };

  const syncMode = () => {
    const isLogin = mode === "login";
    if (title) title.textContent = isLogin ? "登录" : "注册新账号";
    if (desc) {
      desc.textContent = isLogin
        ? "登录后可查看做题记录与正确率统计。"
        : "注册后即可记录做题数据。仅普通用户可自助注册。";
    }
    if (passwordInput) {
      passwordInput.autocomplete = isLogin ? "current-password" : "new-password";
    }
    submit.textContent = isLogin ? "登录" : "注册并登录";
    switchButton.textContent = isLogin ? "还没有账号？立即注册" : "已有账号？立即登录";
  };

  switchButton.addEventListener("click", () => {
    mode = mode === "login" ? "register" : "login";
    clearError();
    syncMode();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const username = (usernameInput?.value ?? "").trim();
    const password = passwordInput?.value ?? "";

    if (username === "" || password === "") {
      showError("请填写用户名和密码");
      return;
    }

    submit.disabled = true;
    submit.textContent = "处理中...";

    try {
      if (mode === "register") {
        await api.register(username, password);
      }
      const result = await api.login(username, password);
      setToken(result.token);
      const redirect = new URLSearchParams(window.location.search).get("from");
      window.location.href = redirect && redirect.startsWith("/") ? redirect : "/";
    } catch (error) {
      showError(error?.message ?? "操作失败，请稍后重试");
      submit.disabled = false;
      syncMode();
    }
  });

  syncMode();
}
