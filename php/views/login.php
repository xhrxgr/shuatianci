<?php
/**
 * 登录 / 注册页（对应 src/pages/Login.tsx，结构与类名逐项一致）。
 *
 * 登录态的切换、提交、错误提示由 assets/js/login.js 处理；
 * 页面首次渲染按「登录」模式输出，与 React 版的初始状态一致。
 *
 * @var string $currentPath
 */
?>
<div class="mx-auto max-w-sm py-10">
  <div class="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
    <h2 class="text-lg font-semibold text-ink" id="login-title">登录</h2>
    <p class="mt-1 text-xs text-muted" id="login-desc">登录后可查看做题记录与正确率统计。</p>

    <form id="login-form" class="mt-6 space-y-4" method="post" action="#">
      <div>
        <label class="mb-1.5 block text-sm font-medium text-ink" for="username">用户名</label>
        <input
          id="username"
          name="username"
          type="text"
          placeholder="4-20 位字母、数字或下划线"
          autocomplete="username"
          class="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-primary"
        >
      </div>

      <div>
        <label class="mb-1.5 block text-sm font-medium text-ink" for="password">密码</label>
        <input
          id="password"
          name="password"
          type="password"
          placeholder="至少 6 位"
          autocomplete="current-password"
          class="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-primary"
        >
      </div>

      <p
        id="login-error"
        class="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger"
        hidden
      ></p>

      <button
        type="submit"
        id="login-submit"
        class="min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >登录</button>
    </form>

    <button
      type="button"
      id="login-switch"
      class="mt-4 w-full text-center text-xs text-muted transition hover:text-primary"
    >还没有账号？去注册</button>
  </div>

  <p class="mt-4 text-center text-xs text-faint">不登录也可以正常刷题，只是不会记录数据。</p>
</div>

<script type="module" src="<?= e(asset_url('/js/login.js')) ?>"></script>
