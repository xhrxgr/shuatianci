<?php
/**
 * 首页。
 *
 * @var array $stats   total / mastered / wrong / blankCount
 * @var array $topTags 高频错题考点 Top5，元素 ['tag' => [...], 'count' => int]
 * @var array $recent  最近录入的题目
 * @var array $papers  最近三张卷，按考试日期倒序
 * @var bool  $isAdmin
 */
$cards = [
    ['label' => '题目总数', 'value' => $stats['total'], 'tone' => 'text-primary'],
    ['label' => '已掌握', 'value' => $stats['mastered'], 'tone' => 'text-success'],
    ['label' => '错题数', 'value' => $stats['wrong'], 'tone' => 'text-danger'],
    ['label' => '空格总数', 'value' => $stats['blankCount'], 'tone' => 'text-muted'],
];
?>
<div class="space-y-6">
  <section class="rounded-2xl border border-line bg-surface p-6 sm:p-8">
    <h2 class="text-xl font-semibold text-ink">English Cloze Question Bank</h2>
    <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
      按知识点整理短文填空题目，每道题均附标准答案、可接受答案集合，以及命题意图与判断依据。
      数据保存在服务器，登录后更换设备也可继续练习。
    </p>
    <div class="mt-5 flex flex-col gap-3 sm:flex-row">
      <a
        href="/practice"
        class="min-h-11 rounded-xl bg-primary px-5 py-3 text-center text-sm font-medium text-on-primary transition hover:bg-primary-hover"
      >开始刷题</a>
      <a
        href="/practice#pick"
        class="min-h-11 rounded-xl border border-line bg-surface px-5 py-3 text-center text-sm font-medium text-ink transition hover:bg-surface-alt"
      >按考点选题</a>
      <?php if (!empty($isAdmin)): ?>
        <a
          href="/admin"
          class="min-h-11 rounded-xl border border-line px-5 py-3 text-center text-sm text-muted transition hover:bg-surface-alt"
        >去录题</a>
      <?php endif; ?>
    </div>
  </section>

  <section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
    <?php foreach ($cards as $card): ?>
      <div class="rounded-xl border border-line bg-surface p-4">
        <p class="text-xs text-muted"><?= e($card['label']) ?></p>
        <p class="mt-1 text-2xl font-semibold <?= e($card['tone']) ?>"><?= e($card['value']) ?></p>
      </div>
    <?php endforeach; ?>
  </section>

  <!-- 选题面板（v3.9.8）
       筛选属于「选题」不属于「做题」：在这里勾好考点，跳到 /practice?tags=…，
       做题页就只有题目，没有筛选栏要滚过。
       勾选逻辑在 assets/js/practice-picker.js（页面加载时挂上）。 -->
  <section id="pick" class="rounded-xl border border-line bg-surface p-5">
    <h3 class="mb-1 text-sm font-semibold text-ink">按考点选题</h3>
    <p class="mb-4 text-xs text-muted">
      勾选要练的考点，再点「开始刷这些题」。不勾就是全部题目。
    </p>
    <div id="pick-groups" class="space-y-3"></div>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        id="pick-go"
        class="min-h-11 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
      >开始刷这些题</button>
      <button
        type="button"
        id="pick-reset"
        class="min-h-11 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-muted transition hover:bg-surface-alt"
      >清空勾选</button>
      <span class="text-xs text-faint" id="pick-status">未勾选，将刷全部题目</span>
    </div>
  </section>

  <script type="application/json" id="pick-tags"><?= json_encode(
      $tagDictionary['tags'] ?? [],
      JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
  ) ?></script>
  <script type="module" src="<?= e(asset_url('/js/practice-picker.js')) ?>"></script>

  <section class="rounded-xl border border-line bg-surface p-5">
    <h3 class="mb-1 text-sm font-semibold text-ink">最容易错的考点 Top 5</h3>
    <p class="mb-4 text-xs text-muted">按标签累计的错误次数排序，用于定位薄弱环节。</p>
    <?php if (count($topTags) === 0): ?>
      <p class="rounded-lg bg-surface-alt px-4 py-6 text-center text-xs text-faint">
        还没有错题数据。刷题时答错的题目会自动统计到这里。
      </p>
    <?php else: ?>
      <ul class="space-y-2">
        <?php foreach ($topTags as $index => $item): ?>
          <li class="flex items-center gap-3">
            <span class="w-5 text-xs text-faint"><?= e($index + 1) ?></span>
            <!-- v3.9.8：考点直接可点 —— 筛选在**进入之前**做，
                 选题结果编码进 URL，做题页就不用再摆一屏筛选栏了 -->
            <a
              href="/practice?tags=<?= e(rawurlencode($item['tag']['id'])) ?>"
              class="min-h-11 rounded px-2 py-0.5 text-xs font-medium text-white transition hover:opacity-80"
              style="background-color: <?= e($item['tag']['color']) ?>"
              title="只刷这个考点"
            ><?= e($item['tag']['name']) ?></a>
            <span class="ml-auto text-xs text-danger">错 <?= e($item['count']) ?> 次</span>
          </li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </section>

  <section class="rounded-xl border border-line bg-surface p-5">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold text-ink">最近的卷</h3>
      <?php if (count($papers) > 0): ?>
        <a href="/papers" class="text-xs text-primary transition hover:opacity-80">全部试卷</a>
      <?php endif; ?>
    </div>
    <?php if (count($papers) === 0): ?>
      <p class="py-6 text-center text-xs text-faint">
        还没有试卷。题目按来源自动归卷，录完同一场考试的题目就会出现在这里。
      </p>
    <?php else: ?>
      <ul class="space-y-2">
        <?php foreach ($papers as $paper): ?>
          <li class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-alt p-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-ink"><?= e($paper['name']) ?></p>
              <p class="mt-0.5 text-xs text-faint">
                <?php if (!empty($paper['examDate'])): ?>
                  <?= e($paper['examDate']) ?> ·
                <?php endif; ?>
                共 <?= e($paper['questionCount']) ?> 道题
                <?php if ($paper['questionCount'] > 0): ?>
                  · 已完成 <?= e($paper['doneCount']) ?>
                <?php endif; ?>
              </p>
            </div>
            <a
              href="/papers/<?= e($paper['id']) ?>"
              class="min-h-11 rounded-lg bg-primary px-4 py-2 text-center text-xs font-medium text-on-primary transition hover:bg-primary-hover"
            >整卷做</a>
          </li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </section>

  <section class="rounded-xl border border-line bg-surface p-5">
    <h3 class="mb-1 text-sm font-semibold text-ink">最近录入</h3>
    <?php if ($stats['total'] === 0): ?>
      <p class="py-8 text-center text-sm text-faint">题库还是空的，去「题库管理」录入第一道题。</p>
    <?php else: ?>
      <ul class="space-y-2">
        <?php foreach ($recent as $question): ?>
          <li class="rounded-lg bg-surface-alt p-3">
            <p class="text-sm text-ink"><?= e($question['originalSentence']) ?></p>
            <p class="mt-1.5 text-xs text-faint">
              <?= e($question['source']) ?> · <?= e(count($question['blanks'])) ?> 个空
            </p>
          </li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </section>
</div>
