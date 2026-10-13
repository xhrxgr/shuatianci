<?php
/**
 * 刷题页。
 *
 * 分工：
 * - PHP 提供页面骨架、题目数据（登录用户的进度已在服务端合并）、标签字典
 * - assets/js/practice.js 负责全部交互渲染（模式切换、筛选、作答、判卷、解析、
 *   收藏与标记）
 *
 * 之所以把渲染交给 JS：这一页的每一块都随状态变化（模式 / 筛选 / 当前题），
 * 集中在一处渲染，可避免多处分散更新导致状态不一致。
 *
 * @var array      $questions     题目（含 status / wrongCount）
 * @var array      $tagDictionary 标签字典
 * @var bool       $authenticated 是否已登录（决定游客记录走本地还是服务端）
 * @var string|null $sourceFilter 从「我的收藏」跳转过来时带的试卷来源
 * @var string     $currentPath
 */
?>
<div class="space-y-5" id="practice-root">
  <!-- 模式切换 -->
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div
      role="tablist"
      aria-label="刷题模式"
      id="practice-tabs"
      class="flex gap-1 rounded-xl border border-line bg-surface p-1 shadow-sm"
    ></div>

    <div class="flex gap-2">
      <button
        type="button"
        id="practice-shuffle"
        class="min-h-11 rounded-lg border border-line bg-surface px-4 py-2 text-xs text-ink transition hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
      >随机打乱顺序</button>
      <button
        type="button"
        id="practice-restore"
        class="min-h-11 rounded-lg border border-line bg-surface px-4 py-2 text-xs text-ink transition hover:bg-surface-alt"
        hidden
      >恢复原序</button>
    </div>
  </div>

  <!-- 筛选栏 -->
  <section id="practice-filter" class="rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5"></section>

  <!-- 进度与翻页 -->
  <div class="flex items-center justify-between gap-3" id="practice-pager" hidden>
    <span class="text-xs text-muted" id="practice-counter"></span>
    <div class="flex gap-2">
      <button
        type="button"
        id="practice-prev"
        class="min-h-11 rounded-lg border border-line bg-surface px-5 py-2 text-sm text-ink transition hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
      >上一题</button>
      <button
        type="button"
        id="practice-next"
        class="min-h-11 rounded-lg border border-line bg-surface px-5 py-2 text-sm text-ink transition hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
      >下一题</button>
    </div>
  </div>

  <!-- 当前题目（由 practice.js 渲染） -->
  <div id="practice-card"></div>

  <!-- 收藏与标记（由 practice.js 渲染） -->
  <div id="practice-collection"></div>

  <p class="text-center text-xs text-muted" id="practice-wrong-hint" hidden></p>

  <!-- 空状态 -->
  <div class="rounded-2xl border border-dashed border-line bg-surface p-12 text-center" id="practice-empty" hidden>
    <p class="text-sm text-muted" id="practice-empty-text"></p>
  </div>
</div>

<?= embed_json('practice-boot', [
    'authenticated' => $authenticated,
    'questions' => $questions,
    'tagDictionary' => $tagDictionary,
    'sourceFilter' => $sourceFilter,
]) ?>
<script type="module" src="<?= e(asset_url('/js/practice.js')) ?>"></script>
