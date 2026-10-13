/**
 * 登录 / 注册页交互。
 *
 * 行为：
 * - 登录 / 注册两种模式，切换时清空错误提示
 * - 空用户名或空密码提示「请填写用户名和密码」
 * - 注册成功后直接登录
 * - 提示的呈现统一交给 feedback.js（原先靠「文案里有没有『成功』二字」
 *   来决定配色，文案一改颜色就错）
 * - 成功后跳回首页（或来源页）
 */

import { api, setToken } from "./api.js";
import { notifyError, clearFeedback } from "./feedback.js";

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

  // 复用页面预留的 #login-error 作为反馈容器（它已带基础样式与位置），
  // 由 feedback.js 往里塞完整的提示条
  //
  // retryable 默认**不开**：只有明确的接口失败才可重试。
  // 校验类错误（字段没填）重试多少次都是同一个结果，给按钮反而误导。
  const showError = (message, options = {}) =>
    notifyError(message, { boxId: "login-error", retryable: false, ...options });

  const clearError = () => {
    clearFeedback("login-error");
    // 容器本身留着（占位与布局不变），只清空里面的提示条
    if (errorBox) errorBox.textContent = "";
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
      showError("请填写用户名和密码", {
        details: ["用户名与密码都不能为空"],
        // 光标停在第一个空字段上，直接改就行
        retryable: false,
      });
      (usernameInput?.value.trim() === "" ? usernameInput : passwordInput)?.focus();
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
      // 登录/注册失败也给重试入口：多数情况是「手滑输错」，
      // 让用户原样再提交一次比让他手动重新敲一遍省事
      showError(error, { retryable: true, retry: () => form.requestSubmit() });
      submit.disabled = false;
      syncMode();
    }
  });

  syncMode();
}
