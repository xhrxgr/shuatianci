<?php
/**
 * 个人中心。
 *
 * 登录用户的统计由 PHP 直接查库渲染（原版是 JS 拉 /api/records/summary，
 * 数据完全一样，只是少一次往返）；
 * 游客的统计存在浏览器本地，由 assets/js/profile.js 填充。
 *
 * @var array|null $user         当前用户
 * @var array|null $summary      登录用户的统计（游客为 null）
 * @var string     $currentPath
 */
$isGuest = $user === null;
?>
<div class="space-y-5">
  <div>
    <h2 class="text-lg font-semibold text-ink">我的记录</h2>
    <?php if (!$isGuest): ?>
      <p class="mt-1 text-xs text-muted">
        <?= e($user['username']) ?><?php if (!empty($user['display_name'])): ?> · <?= e($user['display_name']) ?><?php endif; ?> ·
        <?= $user['role'] === ROLE_ADMIN ? '管理员' : '普通用户' ?>
      </p>
    <?php endif; ?>
  </div>

  <?php if ($isGuest): ?>
    <section class="rounded-xl border border-line bg-surface p-6">
      <p class="mb-4 text-sm text-muted">
        当前为游客模式，作答记录仅保存在本设备浏览器，不会同步到服务器。
      </p>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">总作答</p>
          <p class="mt-1 text-xl font-semibold text-ink" data-local-stat="total">0</p>
        </div>
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">答对</p>
          <p class="mt-1 text-xl font-semibold text-success" data-local-stat="correct">0</p>
        </div>
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">答错</p>
          <p class="mt-1 text-xl font-semibold text-danger" data-local-stat="wrong">0</p>
        </div>
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">正确率</p>
          <p class="mt-1 text-xl font-semibold text-primary" data-local-stat="accuracy">0%</p>
        </div>
      </div>
      <div class="mt-3 space-y-2" id="profile-notice" hidden></div>
      <button
        type="button"
        id="profile-clear-local"
        class="mt-4 min-h-11 rounded-lg border border-line px-4 py-2 text-xs text-muted transition hover:bg-surface-alt"
      >清空本地记录</button>
    </section>

    <script type="module" src="<?= e(asset_url('/js/profile.js')) ?>"></script>
  <?php else: ?>
    <div class="space-y-2" id="profile-error" hidden></div>
    <div class="space-y-2" id="profile-notice" hidden></div>

    <section class="rounded-xl border border-line bg-surface p-5">
      <h3 class="mb-1 text-sm font-semibold text-ink">总体统计</h3>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">总作答</p>
          <p class="mt-1 text-xl font-semibold text-ink"><?= e($summary['total']) ?></p>
        </div>
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">答对</p>
          <p class="mt-1 text-xl font-semibold text-success"><?= e($summary['correct']) ?></p>
        </div>
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">答错</p>
          <p class="mt-1 text-xl font-semibold text-danger"><?= e($summary['wrong']) ?></p>
        </div>
        <div class="rounded-lg bg-surface-alt p-3">
          <p class="text-xs text-muted">正确率</p>
          <p class="mt-1 text-xl font-semibold text-primary"><?= e($summary['accuracy']) ?>%</p>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-line bg-surface p-5">
      <h3 class="mb-1 text-sm font-semibold text-ink">错得最多的题</h3>
      <p class="mb-4 text-xs text-muted">按错误次数排序，优先复盘这些题。</p>
      <?php if (count($summary['weakQuestions']) > 0): ?>
        <ul class="space-y-2">
          <?php foreach ($summary['weakQuestions'] as $item): ?>
            <li class="flex items-center justify-between rounded-lg bg-surface-alt px-3 py-2">
              <span class="blank-slot text-xs text-ink"><?= e($item['questionId']) ?></span>
              <span class="text-xs text-danger">错 <?= e($item['times']) ?> 次</span>
            </li>
          <?php endforeach; ?>
        </ul>
      <?php else: ?>
        <p class="py-4 text-center text-xs text-muted">还没有错题记录。</p>
      <?php endif; ?>
    </section>

    <section class="rounded-xl border border-line bg-surface p-5">
      <h3 class="mb-1 text-sm font-semibold text-ink">修改密码</h3>
      <form id="profile-password-form" class="grid gap-3 sm:grid-cols-3">
        <input
          type="password"
          id="profile-old-password"
          placeholder="原密码"
          autocomplete="current-password"
          class="min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
        >
        <input
          type="password"
          id="profile-new-password"
          placeholder="新密码（至少 6 位）"
          autocomplete="new-password"
          class="min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
        >
        <button
          type="submit"
          id="profile-submit"
          class="min-h-11 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >确认修改</button>
      </form>
      <button
        type="button"
        data-action="logout"
        class="mt-4 min-h-11 rounded-lg border border-line px-4 py-2 text-xs text-muted transition hover:bg-surface-alt"
      >退出登录</button>
    </section>

    <script type="module" src="<?= e(asset_url('/js/profile.js')) ?>"></script>
  <?php endif; ?>
</div>
