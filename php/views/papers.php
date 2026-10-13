<?php
/**
 * 试卷列表。
 *
 * 一套试卷 = 同一次考试。按考试日期倒序，最近考过的在最上面；
 * 没填日期的按录入时间排在后面。
 *
 * 每张卷直接给出两个入口：
 * - 整卷做：一题一屏按顺序做，最接近考试时的状态
 * - 自由刷：进刷题页按卷筛选，可以打乱顺序、按标签筛
 *
 * @var array  $papers       map_paper() 的结果
 * @var bool   $authenticated 是否已登录（游客看不到完成进度）
 */
?>
<div class="space-y-6">
  <section class="rounded-2xl border border-line bg-surface p-6 sm:p-8">
    <h2 class="text-xl font-semibold text-ink">试卷</h2>
    <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
      每套试卷对应一次考试。题目按来源自动归卷——录同一场考试的题目时会落到同一张卷下。
    </p>
    <div class="mt-5 flex flex-col gap-3 sm:flex-row">
      <a
        href="/practice"
        class="min-h-11 rounded-xl bg-primary px-5 py-3 text-center text-sm font-medium text-on-primary transition hover:bg-primary-hover"
      >自由刷题</a>
    </div>
  </section>

  <?php if (count($papers) === 0): ?>
    <section class="rounded-xl border border-dashed border-line bg-surface p-10 text-center">
      <p class="text-sm text-muted">还没有试卷。</p>
      <p class="mt-2 text-xs text-faint">
        在「题库管理」里录入题目并填写试卷来源，同来源的题目会自动归到同一张卷。
      </p>
    </section>
  <?php else: ?>
    <ul class="space-y-3" id="paper-list">
      <?php foreach ($papers as $paper): ?>
        <li
          class="rounded-xl border border-line bg-surface p-5"
          data-paper-id="<?= e($paper['id']) ?>"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold text-ink"><?= e($paper['name']) ?></h3>
              <p class="mt-1 text-xs text-muted">
                <?php if (!empty($paper['examDate'])): ?>
                  <span class="text-ink"><?= e($paper['examDate']) ?></span> ·
                <?php else: ?>
                  未设考试日期 ·
                <?php endif; ?>
                共 <?= e($paper['questionCount']) ?> 道题
              </p>
              <?php if (!empty($paper['note'])): ?>
                <p class="mt-2 text-xs leading-5 text-muted"><?= e($paper['note']) ?></p>
              <?php endif; ?>
            </div>
            <div class="flex flex-wrap gap-2">
              <?php if ($paper['questionCount'] > 0): ?>
                <a
                  href="/papers/<?= e($paper['id']) ?>"
                  class="min-h-11 rounded-lg bg-primary px-4 py-2 text-center text-xs font-medium text-on-primary transition hover:bg-primary-hover"
                >整卷做</a>
                <a
                  href="/practice?paperId=<?= e(rawurlencode($paper['id'])) ?>"
                  class="min-h-11 rounded-lg border border-line px-4 py-2 text-center text-xs text-muted transition hover:bg-surface-alt"
                >自由刷这卷</a>
              <?php else: ?>
                <span class="rounded-lg bg-surface-alt px-4 py-2 text-xs text-faint">暂无题目</span>
              <?php endif; ?>
            </div>
          </div>

          <?php if ($authenticated && $paper['questionCount'] > 0): ?>
            <div class="mt-4">
              <?php
              $percent = (int) round(($paper['doneCount'] / $paper['questionCount']) * 100);
              $percent = max(0, min(100, $percent));
              ?>
              <div class="flex items-center gap-3">
                <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-alt">
                  <div class="h-full rounded-full bg-primary" style="width: <?= e($percent) ?>%"></div>
                </div>
                <span class="shrink-0 text-xs text-muted">
                  已完成 <?= e($paper['doneCount']) ?> / <?= e($paper['questionCount']) ?>
                </span>
              </div>
            </div>
          <?php endif; ?>
        </li>
      <?php endforeach; ?>
    </ul>
  <?php endif; ?>
</div>