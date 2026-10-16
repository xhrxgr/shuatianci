<?php
/**
 * 用户管理页。
 *
 * 与纯前端实现的两点差别（对用户无感知）：
 * - 账号列表由 PHP 直接查库直出（前端原为 JS 拉 /api/admin/users），少一次往返
 * - 角色下拉的选项由 PHP 从 list_roles() 渲染，新建与行内两处共用同一份
 *
 * 交互（新建 / 重置密码 / 改角色 / 启停 / 删除）交给
 * assets/js/admin-users.js：动作调 /api/admin/*，成功后整页刷新以更新列表。
 *
 * @var string|null $guard 非空时为权限提示 HTML（未登录 / 非管理员），页面只输出它
 * @var array       $users [['id','username','displayName','role','status','createdAt','recordCount','wrongCount'], ...]
 * @var array       $roles [['value','label'], ...]
 * @var string      $currentPath
 */
?>
<?php if ($guard !== null): ?>
  <?= $guard ?>
<?php else: ?>
  <div class="space-y-5" id="admin-users-root">
    <div>
      <h2 class="text-lg font-semibold text-ink">用户管理</h2>
      <p class="mt-1 text-xs text-muted">
        共 <?= e(count($users)) ?> 个账号。重置密码或修改角色后，该用户需重新登录。
      </p>
    </div>

    <div class="space-y-2" id="admin-users-error" hidden></div>
    <div class="space-y-2" id="admin-users-notice" hidden></div>

    <!-- 新建用户 -->
    <section class="rounded-xl border border-line bg-surface p-5">
      <h3 class="mb-1 text-sm font-semibold text-ink">新建用户</h3>
      <div class="grid gap-3 sm:grid-cols-4">
        <input
          type="text"
          id="admin-new-username"
          placeholder="用户名"
          autocomplete="off"
          class="min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
        >
        <input
          type="text"
          id="admin-new-password"
          placeholder="初始密码（至少 6 位）"
          autocomplete="off"
          class="min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
        >
        <select
          id="admin-new-role"
          class="min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
        >
          <?php foreach ($roles as $role): ?>
            <option value="<?= e($role['value']) ?>" <?= $role['value'] === ROLE_USER ? 'selected' : '' ?>><?= e($role['label']) ?></option>
          <?php endforeach; ?>
        </select>
        <button
          type="button"
          id="admin-create"
          class="min-h-11 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-on-primary transition hover:bg-primary-hover"
        >创建</button>
      </div>
    </section>

    <!-- 用户列表 -->
    <section class="rounded-xl border border-line bg-surface p-5">
      <h3 class="mb-1 text-sm font-semibold text-ink">账号列表</h3>
      <?php if (count($users) === 0): ?>
        <p class="py-6 text-center text-sm text-muted">还没有账号。用上方的用户名和密码点「创建账号」建第一个。</p>
      <?php else: ?>
        <ul class="space-y-2">
          <?php foreach ($users as $item): ?>
            <li
              class="rounded-lg bg-surface-alt p-3"
              data-user-row
              data-user-id="<?= e($item['id']) ?>"
              data-username="<?= e($item['username']) ?>"
              data-status="<?= e($item['status']) ?>"
            >
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <p class="text-sm text-ink">
                    <?= e($item['username']) ?>
                    <?php if (!empty($item['displayName'])): ?><span class="ml-2 text-muted"><?= e($item['displayName']) ?></span><?php endif; ?>
                  </p>
                  <p class="mt-0.5 text-xs text-faint">
                    做题 <?= e($item['recordCount']) ?> 次 · 错题 <?= e($item['wrongCount']) ?> 次
                    <?php if ($item['status'] === 0): ?><span class="ml-2 text-danger">已禁用</span><?php endif; ?>
                  </p>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <!-- 角色切换 -->
                  <select
                    data-action="change-role"
                    data-current-role="<?= e($item['role']) ?>"
                    class="min-h-11 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none transition focus:border-primary"
                  >
                    <?php foreach ($roles as $role): ?>
                      <option value="<?= e($role['value']) ?>" <?= $role['value'] === $item['role'] ? 'selected' : '' ?>><?= e($role['label']) ?></option>
                    <?php endforeach; ?>
                  </select>

                  <button
                    type="button"
                    data-action="reset-password"
                    class="min-h-11 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:bg-surface"
                  >重置密码</button>

                  <button
                    type="button"
                    data-action="change-status"
                    class="min-h-11 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:bg-surface"
                  ><?= $item['status'] === 1 ? '禁用' : '启用' ?></button>

                  <button
                    type="button"
                    data-action="delete"
                    class="min-h-11 rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger transition hover:bg-danger-soft"
                  >删除</button>
                </div>
              </div>

              <!-- 重置密码（点击「重置密码」展开） -->
              <div class="mt-3 flex flex-wrap gap-2 border-t border-line pt-3" data-panel="reset" hidden>
                <input
                  type="text"
                  data-reset-input
                  placeholder="输入新密码（至少 6 位）"
                  autocomplete="off"
                  class="min-h-11 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
                >
                <button
                  type="button"
                  data-action="reset-confirm"
                  class="min-h-11 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-on-primary transition hover:bg-primary-hover"
                >确认重置</button>
                <button
                  type="button"
                  data-action="reset-cancel"
                  class="min-h-11 rounded-lg border border-line px-4 py-2 text-xs text-muted transition hover:bg-surface"
                >取消</button>
              </div>

            </li>
          <?php endforeach; ?>
        </ul>
      <?php endif; ?>
    </section>
  </div>

  <script type="module" src="<?= e(asset_url('/js/admin-users.js')) ?>"></script>
<?php endif; ?>
