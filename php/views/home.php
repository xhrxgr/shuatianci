<?php
/**
 * 首页。
 *
 * @var array $stats   total / mastered / wrong / blankCount
 * @var array $topTags 高频错题考点 Top5，元素 ['tag' => [...], 'count' => int]
 * @var array $recent  最近录入的题目
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
    <h2 class="text-xl font-semibold text-ink">高考英语短文填空穷举题库</h2>
    <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
      按知识点穷举整理短文填空题目，每道题均附标准答案、可接受答案集合，以及命题意图与判断依据。
      数据保存在服务器，登录后更换设备也可继续练习。
    </p>
    <div class="mt-5 flex flex-col gap-3 sm:flex-row">
      <a
        href="/practice"
        class="min-h-11 rounded-xl bg-primary px-5 py-3 text-center text-sm font-medium text-on-primary transition hover:bg-primary-hover"
      >开始刷题</a>
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
            <span
              class="rounded px-2 py-0.5 text-xs font-medium text-white"
              style="background-color: <?= e($item['tag']['color']) ?>"
            ><?= e($item['tag']['name']) ?></span>
            <span class="ml-auto text-xs text-danger">错 <?= e($item['count']) ?> 次</span>
          </li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </section>

  <section class="rounded-xl border border-line bg-surface p-5">
    <h3 class="mb-4 text-sm font-semibold text-ink">最近录入</h3>
    <?php if ($stats['total'] === 0): ?>
      <p class="py-8 text-center text-sm text-faint">题库还是空的，去「题库管理」录入第一道题。</p>
    <?php else: ?>
      <ul class="space-y-2">
        <?php foreach ($recent as $question): ?>
          <li class="rounded-lg bg-surface-alt p-3">
            <p class="text-sm text-ink"><?= e($question['originalSentence']) ?></p>
            <p class="mt-1 text-xs text-faint">
              <?= e($question['source']) ?> · <?= e(count($question['blanks'])) ?> 个空
            </p>
          </li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </section>
</div>
