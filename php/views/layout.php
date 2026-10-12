<?php
/**
 * 页面布局模板。
 *
 * 与 React 版的对应关系：
 *   src/App.tsx 的 <div class="flex min-h-full flex-col"> + NavBar + <main>
 *   src/main.tsx 的挂载节点 #root
 *
 * 两个刻意的细节：
 * 1. 容器 id 保持 #root——样式里有 `html, body, #root { height: 100% }`，
 *    沿用同一个 id 才能直接复用同一份 CSS，不用改样式。
 * 2. 导航结构、类名、图标（内联 SVG）逐项照搬 App.tsx，视觉与交互一致；
 *    移动端菜单的展开收起改由 assets/js/app.js 处理（原来是 React 状态）。
 *
 * @var string      $content     页面主体 HTML
 * @var array|null  $user        当前登录用户
 * @var string      $title       页面标题
 * @var string      $currentPath 当前路径（导航高亮用）
 * @var array       $scripts     额外脚本（assets/js/ 下的文件名）
 */
$scripts = isset($scripts) && is_array($scripts) ? $scripts : [];
$currentPath = isset($currentPath) ? (string) $currentPath : '/';
$items = nav_items($user);
?>
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title><?= e($title) ?></title>
  <link rel="stylesheet" href="<?= e(asset_url('/app.css')) ?>">
</head>
<!-- data-authenticated 供 app.js 判断服务端是否已识别登录态 -->
<body data-authenticated="<?= $user !== null ? '1' : '0' ?>">
  <div id="root">
    <div class="flex min-h-full flex-col">
      <header class="sticky top-0 z-50 border-b border-line bg-surface/90 backdrop-blur">
        <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <a href="/" class="text-sm font-semibold text-ink sm:text-base">英语短文填空题库</a>

          <!-- 移动端汉堡按钮 -->
          <button
            type="button"
            id="menu-toggle"
            aria-label="打开菜单"
            aria-expanded="false"
            class="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-muted transition hover:bg-surface-alt md:hidden"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" class="h-6 w-6" fill="none" data-icon="open">
              <path d="M4 7H20M4 12H20M4 17H20" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
            <svg viewBox="0 0 24 24" aria-hidden="true" class="h-6 w-6" fill="none" data-icon="close" hidden>
              <path d="M5 5L19 19M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>

          <!-- 桌面端导航 -->
          <nav class="hidden items-center gap-1 md:flex">
            <?php foreach ($items as $item): ?>
              <a
                href="<?= e($item['to']) ?>"
                class="<?= e(nav_link_class($item['to'], $currentPath)) ?>"
              ><?= e($item['label']) ?></a>
            <?php endforeach; ?>

            <?php if ($user !== null): ?>
              <button
                type="button"
                data-action="logout"
                class="rounded-lg px-3 py-2 text-xs text-muted transition hover:bg-surface-alt"
              >退出</button>
            <?php else: ?>
              <a
                href="/login"
                class="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-on-primary transition hover:bg-primary-hover"
              >登录</a>
            <?php endif; ?>
          </nav>
        </div>

        <!-- 移动端下拉菜单（默认收起，由 app.js 切换） -->
        <nav id="mobile-menu" class="border-t border-line bg-surface px-4 pb-3 md:hidden" hidden>
          <?php foreach ($items as $item): ?>
            <a
              href="<?= e($item['to']) ?>"
              class="<?= e(nav_link_class($item['to'], $currentPath, true)) ?>"
            ><?= e($item['label']) ?></a>
          <?php endforeach; ?>

          <?php if ($user !== null): ?>
            <button
              type="button"
              data-action="logout"
              class="mt-1 w-full rounded-lg px-4 py-3 text-left text-sm text-muted transition hover:bg-surface-alt"
            >退出登录（<?= e($user['username']) ?>）</button>
          <?php else: ?>
            <a
              href="/login"
              class="mt-1 block rounded-lg bg-primary px-4 py-3 text-center text-sm font-medium text-on-primary"
            >登录</a>
          <?php endif; ?>
        </nav>
      </header>

      <main class="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <?= $content ?>
      </main>
    </div>
  </div>

  <script type="module" src="<?= e(asset_url('/js/app.js')) ?>"></script>
  <?php foreach ($scripts as $script): ?>
    <script type="module" src="<?= e(asset_url('/js/' . $script)) ?>"></script>
  <?php endforeach; ?>
</body>
</html>
