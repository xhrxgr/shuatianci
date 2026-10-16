<?php
/**
 * 我的收藏。
 *
 * 收藏与标记都由 PHP 直接查库渲染；页签切换与「取消收藏 / 取消标记」
 * 由 assets/js/profile.js 之外的 collection 逻辑处理——
 * 见文件末尾引入的脚本（取消操作调接口后整页刷新，
 * 当前页签通过 URL 上的 ?tab= 保留）。
 *
 * @var array|null $user
 * @var array      $favorites [['source','note','questionCount','createdAt'], ...]
 * @var array      $marks     [['questionId','label','note','createdAt','sentence','source'], ...]
 * @var string     $tab       当前页签：favorites | marks
 * @var string     $currentPath
 */
$labelStyles = [
    '重点' => 'bg-danger-soft text-danger',
    '难点' => 'bg-warning-soft text-warning',
    '考点回顾' => 'bg-primary-soft text-primary',
];
?>
<?php if ($user === null): ?>
  <div class="rounded-xl border border-dashed border-line bg-surface p-12 text-center">
    <p class="mb-4 text-sm text-muted">登录后可以收藏试卷、标记重点题目。</p>
    <a
      href="/login"
      class="inline-block min-h-11 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-on-primary"
    >去登录</a>
  </div>
<?php else: ?>
  <div class="space-y-5" id="collection-root">
    <div>
      <h2 class="text-lg font-semibold text-ink">我的收藏</h2>
      <p class="mt-1.5 text-xs text-faint">收藏试卷、标记重点题目。仅你本人可查看这些内容。</p>
    </div>

    <div class="space-y-2" id="collection-error" hidden></div>
    <div class="space-y-2" id="collection-notice" hidden></div>

    <div role="tablist" class="flex gap-1 rounded-xl border border-line bg-surface p-1">
      <button
        type="button"
        role="tab"
        aria-selected="<?= $tab === 'favorites' ? 'true' : 'false' ?>"
        data-collection-tab="favorites"
        class="min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-medium transition <?= $tab === 'favorites' ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-alt' ?>"
      >收藏的试卷 <span data-count="favorites"><?= e(count($favorites)) ?></span></button>
      <button
        type="button"
        role="tab"
        aria-selected="<?= $tab === 'marks' ? 'true' : 'false' ?>"
        data-collection-tab="marks"
        class="min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-medium transition <?= $tab === 'marks' ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-alt' ?>"
      >标记的题目 <span data-count="marks"><?= e(count($marks)) ?></span></button>
    </div>

    <!-- 收藏的试卷 -->
    <div data-panel="favorites" <?= $tab === 'favorites' ? '' : 'hidden' ?>>
      <?php if (count($favorites) === 0): ?>
        <p class="rounded-xl border border-dashed border-line bg-surface p-10 text-center text-sm text-muted">
          还没有收藏的试卷。<br>刷题时点「收藏本卷」就会出现在这里。
        </p>
      <?php else: ?>
        <ul class="space-y-2">
          <?php foreach ($favorites as $item): ?>
            <li
              class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4"
              data-favorite-item="<?= e($item['source']) ?>"
            >
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-ink"><?= e($item['source']) ?></p>
                <p class="mt-1.5 text-xs text-faint">
                  共 <?= e($item['questionCount']) ?> 道题
                  <?php if (!empty($item['note'])): ?><span class="ml-2 text-muted">备注：<?= e($item['note']) ?></span><?php endif; ?>
                </p>
              </div>
              <div class="flex gap-2">
                <a
                  href="/practice?source=<?= e(rawurlencode($item['source'])) ?>"
                  class="min-h-11 rounded-lg bg-primary px-3 py-1.5 text-xs text-on-primary transition hover:bg-primary-hover"
                >刷这卷</a>
                <button
                  type="button"
                  data-action="remove-favorite"
                  data-source="<?= e($item['source']) ?>"
                  class="min-h-11 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:bg-surface-alt"
                >取消收藏</button>
              </div>
            </li>
          <?php endforeach; ?>
        </ul>
      <?php endif; ?>
    </div>

    <!-- 标记的题目 -->
    <div data-panel="marks" <?= $tab === 'marks' ? '' : 'hidden' ?>>
      <?php if (count($marks) === 0): ?>
        <p class="rounded-xl border border-dashed border-line bg-surface p-10 text-center text-sm text-muted">
          还没有标记的题目。<br>刷题时点「标记本题」就会出现在这里。
        </p>
      <?php else: ?>
        <ul class="space-y-2">
          <?php foreach ($marks as $item): ?>
            <li
              class="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4"
              data-mark-item="<?= e($item['questionId']) ?>"
            >
              <div class="min-w-0 flex-1">
                <div class="mb-1.5 flex flex-wrap items-center gap-2">
                  <span class="rounded px-2 py-0.5 text-xs font-medium <?= e($labelStyles[$item['label']] ?? 'bg-surface-alt text-muted') ?>">
                    <?= e($item['label']) ?>
                  </span>
                  <span class="blank-slot text-xs text-faint"><?= e($item['questionId']) ?></span>
                </div>
                <p class="text-sm leading-6 text-ink"><?= e($item['sentence'] ?? '（该题已被删除）') ?></p>
                <?php if (!empty($item['note'])): ?>
                  <p class="mt-1.5 text-xs text-faint">备注：<?= e($item['note']) ?></p>
                <?php endif; ?>
                <?php if (!empty($item['source'])): ?>
                  <p class="mt-1.5 text-xs text-faint">来源：<?= e($item['source']) ?></p>
                <?php endif; ?>
              </div>
              <button
                type="button"
                data-action="remove-mark"
                data-question="<?= e($item['questionId']) ?>"
                class="min-h-11 shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:bg-surface-alt"
              >取消标记</button>
            </li>
          <?php endforeach; ?>
        </ul>
      <?php endif; ?>
    </div>
  </div>

  <script type="module" src="<?= e(asset_url('/js/collection.js')) ?>"></script>
<?php endif; ?>
