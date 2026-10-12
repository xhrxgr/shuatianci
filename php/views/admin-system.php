<?php
/**
 * 系统设置（对应 src/pages/System.tsx，结构与类名逐项一致）。
 *
 * 与 React 版的两点差别（对用户无感知）：
 * - 首屏不请求接口：页面骨架由 PHP 直出，版本信息与更新状态等动态内容
 *   由 assets/js/admin-system.js 调 /api/system/* 后填充（与 React 版一致，
 *   React 版也是在挂载后才拉取）
 * - loading 用「默认展示加载文案、接口回来后切换」实现：与 React 版
 *   `if (loading) return <p>正在读取版本信息...</p>` 同一效果
 *
 * 所有动态文本都由 JS 输出并自行转义。
 *
 * @var string|null $guard 非空时为权限提示 HTML（未登录 / 非管理员），页面只输出它
 * @var string      $currentPath
 */
?>
<?php if ($guard !== null): ?>
  <?= $guard ?>
<?php else: ?>
  <p class="p-10 text-center text-sm text-muted" id="admin-system-loading">正在读取版本信息...</p>

  <div class="space-y-5" id="admin-system-root" hidden>
    <div>
      <h1 class="text-xl font-semibold text-ink">系统设置</h1>
      <p class="mt-1 text-sm text-muted">
        查看当前部署版本，并直接在网页上完成更新，无需登录服务器。
      </p>
    </div>

    <p class="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger" id="admin-system-error" hidden></p>
    <p class="rounded-xl border border-success/40 bg-success-soft px-4 py-3 text-sm text-success" id="admin-system-notice" hidden></p>

    <!-- 当前版本 -->
    <section class="rounded-xl border border-line bg-surface p-5">
      <h2 class="mb-3 text-sm font-semibold text-ink">当前版本</h2>
      <div data-version-body></div>
    </section>

    <!-- 更新 -->
    <section class="rounded-xl border border-line bg-surface p-5">
      <h2 class="mb-1 text-sm font-semibold text-ink">检查更新</h2>
      <div data-update-actions></div>
      <div data-check-result></div>
    </section>

    <!-- 更新进度 -->
    <section class="rounded-xl border border-line bg-surface p-5" id="admin-system-progress" hidden>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-semibold text-ink">更新进度</h2>
        <span class="text-xs text-muted" id="admin-system-stage" hidden></span>
      </div>

      <div class="max-h-72 overflow-y-auto rounded-lg border border-line bg-surface-alt p-3" id="admin-system-logs"></div>

      <p class="mt-3 text-xs text-muted" id="admin-system-updating-hint" hidden>
        更新期间请勿关闭页面。构建通常需要 1 分钟左右。
      </p>

      <button
        type="button"
        data-action="reload"
        id="admin-system-reload"
        class="mt-4 min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover sm:w-auto"
        hidden
      >刷新页面</button>
    </section>
  </div>

  <script type="module" src="/assets/js/admin-system.js"></script>
<?php endif; ?>
