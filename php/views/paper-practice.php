<?php
/**
 * 整卷练习页。
 *
 * 一套试卷一题一屏按顺序做，最接近考试时的状态：
 * 看不到别的题、不能跳着挑，做完一题才知道下一题。
 *
 * 与刷题页的区别：
 * - 刷题页可以打乱顺序、按标签筛、自由切换页签，适合查漏
 * - 这里固定顺序、一题一屏，适合「这套卷我要从头做一遍」
 *
 * 判卷口径、记录方式与刷题页完全一致（大小写敏感、只 trim），
 * 两边对同一道题的判定不会打架。
 *
 * @var array $paper         试卷信息
 * @var array $questions     该卷题目（已合并个人进度）
 * @var bool  $authenticated 是否已登录
 */
?>
<div class="mx-auto max-w-3xl space-y-5" id="paper-practice-root">
  <!-- 卷头：卷名、日期、进度 -->
  <section class="rounded-2xl border border-line bg-surface p-5 sm:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="flex flex-wrap items-center gap-2 text-lg font-semibold text-ink">
          <span><?= e($paper['name']) ?></span>
          <?php if (($paper['kind'] ?? 'original') === 'generated'): ?>
            <span class="rounded-full border border-line bg-surface-alt px-2 py-0.5 text-xs font-normal text-muted">虚拟卷</span>
          <?php endif; ?>
        </h2>
        <?php
        // 分篇信息（蓝图按知识点聚篇时才有意义）：一套卷是 3~4 篇短文填空，
        // 只说「共 N 道题」学生不知道自己要连续做几篇
        $sectionNos = [];
        foreach ($questions as $q) {
            $sectionNos[(int) ($q['sectionNo'] ?? 1)] = true;
        }
        $sectionCount = count($sectionNos);
        ?>
        <p class="mt-1 text-xs text-muted">
          <?php if (!empty($paper['examDate'])): ?>
            <?= e($paper['examDate']) ?> ·
          <?php endif; ?>
          共 <?= e(count($questions)) ?> 道题
          <?= $sectionCount > 1 ? ' · ' . e($sectionCount) . ' 篇' : '' ?>
          <?php if (!empty($paper['blueprintName'])): ?>
            · 由「<?= e($paper['blueprintName']) ?>」抽出
          <?php endif; ?>
        </p>
      </div>
      <div class="flex gap-2">
        <a
          href="/practice?paperId=<?= e(rawurlencode($paper['id'])) ?>"
          class="min-h-11 rounded-lg border border-line px-4 py-2 text-center text-xs text-muted transition hover:bg-surface-alt"
        >自由刷这卷</a>
        <a
          href="/papers"
          class="min-h-11 rounded-lg border border-line px-4 py-2 text-center text-xs text-muted transition hover:bg-surface-alt"
        >全部试卷</a>
      </div>
    </div>

    <?php if (!empty($paper['note'])): ?>
      <p class="mt-3 rounded-lg bg-surface-alt px-4 py-3 text-xs leading-5 text-muted">
        <?= e($paper['note']) ?>
      </p>
    <?php endif; ?>

    <!-- 本卷完成情况 -->
    <div class="mt-4">
      <div class="flex items-center gap-3">
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-alt">
          <div id="paper-progress-bar" class="h-full rounded-full bg-primary transition-all" style="width: 0%"></div>
        </div>
        <span id="paper-progress-text" class="shrink-0 text-xs text-muted">
          已完成 0 / <?= e(count($questions)) ?>
        </span>
      </div>
    </div>
  </section>

  <!-- 本卷答题卡：一眼看到哪些题做过、对错如何 -->
  <section class="rounded-2xl border border-line bg-surface p-5" id="paper-sheet-wrap">
    <h3 class="mb-3 text-sm font-semibold text-ink">答题卡</h3>
    <div id="paper-sheet" class="flex flex-wrap gap-2"></div>
  </section>

  <!-- 当前题（由 paper-practice.js 渲染） -->
  <section id="paper-card"></section>

  <!-- 上一题 / 下一题 -->
  <div class="flex items-center justify-between gap-3">
    <button
      type="button"
      id="paper-prev"
      class="min-h-11 rounded-lg border border-line bg-surface px-5 py-2 text-sm text-ink transition hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
    >上一题</button>
    <span id="paper-counter" class="text-xs text-muted"></span>
    <button
      type="button"
      id="paper-next"
      class="min-h-11 rounded-lg bg-primary px-6 py-2 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
    >下一题</button>
  </div>

  <!-- 做完本卷 -->
  <section class="rounded-2xl border border-line bg-surface p-6 text-center" id="paper-finish" hidden>
    <h3 class="text-base font-semibold text-ink">本卷已全部做完</h3>
    <p class="mt-2 text-sm text-muted" id="paper-finish-text"></p>
    <div class="mt-5 flex flex-wrap justify-center gap-3">
      <button
        type="button"
        id="paper-restart"
        class="min-h-11 rounded-xl border border-line px-5 py-2 text-sm text-muted transition hover:bg-surface-alt"
      >重做本卷</button>
      <a
        href="/practice?paperId=<?= e(rawurlencode($paper['id'])) ?>"
        class="min-h-11 rounded-xl bg-primary px-5 py-2 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
      >只练做错的</a>
      <a
        href="/papers"
        class="min-h-11 rounded-xl border border-line px-5 py-2 text-sm text-muted transition hover:bg-surface-alt"
      >换一套卷</a>
    </div>
  </section>
</div>

<?= embed_json('paper-practice-boot', [
    'authenticated' => $authenticated,
    'paper' => $paper,
    'questions' => $questions,
    // 解析里要显示考点标签，否则学生不知道自己错在哪个知识点上
    'tagDictionary' => load_tag_dictionary(),
]) ?>
<script type="module" src="<?= e(asset_url('/js/paper-practice.js')) ?>"></script>