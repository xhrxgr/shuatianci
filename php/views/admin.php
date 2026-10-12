<?php
/**
 * 录题后台（对应 src/pages/Admin.tsx + ManualEntry.tsx + TagManager.tsx，
 * AI 助手在 admin-ai.php）。
 *
 * 四个页签的内容一次性渲染，非当前页签用 hidden 收起（React 是条件渲染，
 * 视觉结果相同）；页签切换、表单交互、预览都由 assets/js/admin.js 处理。
 *
 * @var array      $tagDictionary 标签字典
 * @var array      $questions     题目列表（导出与「当前题库」用）
 * @var array      $tagUsage      标签被引用的次数：[tagId => int]
 * @var string     $currentPath
 */
$adminTabs = [
    ['id' => 'manual', 'label' => '手动精录'],
    ['id' => 'ai', 'label' => 'AI 助手'],
    ['id' => 'import', 'label' => '题库导入'],
    ['id' => 'tags', 'label' => '标签管理'],
];
?>
<?php if (!empty($guard)): ?>
  <?= $guard ?>
  <?php return; ?>
<?php endif; ?>
<div class="space-y-5" id="admin-root">
  <!-- 页签 -->
  <div role="tablist" class="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
    <?php foreach ($adminTabs as $index => $item): ?>
      <button
        type="button"
        role="tab"
        aria-selected="<?= $item['id'] === 'manual' ? 'true' : 'false' ?>"
        data-admin-tab="<?= e($item['id']) ?>"
        class="min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-medium transition sm:flex-none <?= $item['id'] === 'manual' ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-alt' ?>"
      ><?= e($item['label']) ?></button>
    <?php endforeach; ?>
  </div>

  <p class="rounded-lg bg-success-soft px-4 py-2 text-xs text-success" id="admin-notice" hidden></p>

  <!-- ============ 手动精录 ============ -->
  <div data-admin-panel="manual">
    <div class="grid gap-6 lg:grid-cols-2">
      <div class="space-y-4">
        <div class="rounded-xl border border-line bg-surface p-5">
          <label class="mb-1.5 block text-sm font-medium text-ink" for="admin-sentence">原句（用 6 个下划线表示一个空）</label>
          <textarea
            id="admin-sentence"
            rows="3"
            placeholder="He is an ______ (energy) boy, and he always does everything ______ (energetic)."
            class="blank-slot w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
          ></textarea>
          <p class="mt-1.5 text-xs text-faint" id="admin-blank-count">输入或粘贴原句后，这里会自动拆出各个空位</p>

          <label class="mb-1.5 mt-4 block text-sm font-medium text-ink" for="admin-source">题目来源</label>
          <input
            id="admin-source"
            type="text"
            placeholder="如：某某中学2026-2027学年高三上学期10月阶段检测试题"
            class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
          >
          <p class="mt-1.5 text-xs text-faint">保存后来源会保留，题目列表里可直接看到出处。</p>
        </div>

        <!-- 逐空配置（由 admin.js 按原句动态生成） -->
        <div id="admin-blanks" class="space-y-4"></div>

        <ul class="space-y-1 rounded-xl border border-danger/30 bg-danger-soft p-4 text-xs text-danger" id="admin-errors" hidden></ul>

        <div class="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            id="admin-save"
            class="min-h-11 flex-1 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >保存题目</button>
          <button
            type="button"
            id="admin-clear"
            class="min-h-11 rounded-xl border border-line px-6 py-3 text-sm text-muted transition hover:bg-surface-alt"
          >清空</button>
        </div>
        <p class="text-center text-xs text-success" id="admin-save-notice" hidden></p>
      </div>

      <!-- 右侧实时预览 -->
      <div class="lg:sticky lg:top-24 lg:self-start">
        <p class="mb-2 text-xs text-faint">实时预览（与刷题页排版一致）</p>
        <div id="admin-preview">
          <div class="rounded-2xl border border-dashed border-line bg-surface p-10 text-center text-sm text-faint">
            在左侧填写原句后，这里会实时显示效果。
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ============ AI 助手 ============ -->
  <div data-admin-panel="ai">
    <?php include __DIR__ . '/admin-ai.php'; ?>
  </div>

  <!-- ============ 题库导入 ============ -->
  <div data-admin-panel="import" hidden>
    <div class="space-y-5">
      <section class="rounded-xl border border-line bg-surface p-5">
        <h3 class="mb-1 text-sm font-semibold text-ink">导出 / 导入</h3>
        <p class="mb-4 text-xs text-muted">
          题库现在存在服务端。导出内容包含全部题目、标签字典和导出时间；
          导入时选择覆盖或增量追加，已存在的 id 会自动跳过。
        </p>
        <div class="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            id="admin-export"
            class="min-h-11 flex-1 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
          >导出全部数据</button>
          <button
            type="button"
            id="admin-import-trigger"
            class="min-h-11 flex-1 rounded-xl border border-line px-6 py-3 text-sm text-muted transition hover:bg-surface-alt"
          >导入 JSON</button>
          <button
            type="button"
            id="admin-migrate-local"
            class="min-h-11 flex-1 rounded-xl border border-line px-6 py-3 text-sm text-muted transition hover:bg-surface-alt"
          >浏览器题库上云</button>
          <input id="admin-file" type="file" accept="application/json" hidden>
        </div>
        <p class="mt-3 text-xs text-faint">
          「浏览器题库上云」用于首次迁移：把本浏览器里已有的题目与标签整体上传到服务端并覆盖。
          迁移完成后就不再需要它了。
        </p>
      </section>

      <section class="rounded-xl border border-danger/30 bg-surface p-5">
        <h3 class="mb-1 text-sm font-semibold text-danger">危险操作</h3>
        <p class="mb-4 text-xs text-muted">
          以下操作会清空当前题库并恢复为内置示例数据，已录入的题目会丢失，请先导出备份。
        </p>
        <div class="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            id="admin-restore-seed"
            class="min-h-11 flex-1 rounded-xl border border-line px-6 py-3 text-sm text-muted transition hover:bg-surface-alt"
          >恢复内置示例数据</button>
          <button
            type="button"
            id="admin-clear-all"
            class="min-h-11 flex-1 rounded-xl border border-danger/40 bg-danger-soft px-6 py-3 text-sm font-medium text-danger transition hover:bg-danger/20"
          >清空所有数据</button>
        </div>
      </section>

      <section class="rounded-xl border border-line bg-surface p-5">
        <h3 class="mb-4 text-sm font-semibold text-ink">当前题库（<?= e(count($questions)) ?> 题）</h3>
        <?php if (count($questions) === 0): ?>
          <p class="py-8 text-center text-sm text-faint">题库为空，去「手动精录」添加第一道题。</p>
        <?php else: ?>
          <ul class="space-y-2">
            <?php foreach ($questions as $question): ?>
              <li class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-alt p-3" data-admin-question="<?= e($question['id']) ?>">
                <div class="min-w-0 flex-1">
                  <p class="text-sm text-ink"><?= e($question['originalSentence']) ?></p>
                  <p class="mt-1 text-xs text-faint">
                    <?= e($question['id']) ?> · <?= e($question['source']) ?> · v<?= e($question['schemaVersion']) ?>
                  </p>
                </div>
                <div class="flex gap-2">
                  <button
                    type="button"
                    data-action="toggle-status"
                    data-id="<?= e($question['id']) ?>"
                    class="min-h-11 rounded-lg border border-line px-3 py-2 text-xs text-muted transition hover:bg-surface"
                  ><?= $question['status'] === 'mastered' ? '标记未掌握' : '标记已掌握' ?></button>
                  <button
                    type="button"
                    data-action="delete-question"
                    data-id="<?= e($question['id']) ?>"
                    class="min-h-11 rounded-lg border border-danger/40 px-3 py-2 text-xs text-danger transition hover:bg-danger-soft"
                  >删除</button>
                </div>
              </li>
            <?php endforeach; ?>
          </ul>
        <?php endif; ?>
      </section>
    </div>
  </div>

  <!-- ============ 标签管理 ============ -->
  <div data-admin-panel="tags" hidden>
    <div class="space-y-6" id="admin-tags-root">
      <?php
      $parents = [];
      foreach ($tagDictionary['tags'] as $tag) {
          if ($tag['parentId'] === null) {
              $parents[] = $tag;
          }
      }
      ?>
      <?php foreach ($parents as $parent): ?>
        <?php
        $children = [];
        foreach ($tagDictionary['tags'] as $tag) {
            if ($tag['parentId'] === $parent['id']) {
                $children[] = $tag;
            }
        }
        ?>
        <div class="rounded-xl border border-line bg-surface p-4" data-tag-group="<?= e($parent['id']) ?>">
          <div class="mb-3 flex items-center gap-2">
            <span class="rounded px-2 py-0.5 text-xs font-semibold text-white" style="background-color: <?= e($parent['color']) ?>"><?= e($parent['name']) ?></span>
            <span class="text-xs text-faint"><?= e(count($children)) ?> 个子标签</span>
          </div>

          <ul class="space-y-2" data-tag-list>
            <?php foreach ($children as $tag): ?>
              <li class="flex flex-wrap items-center gap-2 rounded-lg bg-surface-alt px-3 py-2" data-tag="<?= e($tag['id']) ?>">
                <input
                  type="color"
                  value="<?= e($tag['color']) ?>"
                  aria-label="<?= e($tag['name']) ?> 颜色"
                  data-tag-color
                  class="h-7 w-7 cursor-pointer rounded border border-line bg-surface p-0"
                >
                <input
                  type="text"
                  value="<?= e($tag['name']) ?>"
                  data-tag-name
                  class="min-h-11 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
                >
                <button
                  type="button"
                  data-action="toggle-tag"
                  class="min-h-11 rounded-lg px-3 py-2 text-xs transition <?= $tag['isActive'] ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-surface-alt text-muted hover:bg-surface-alt' ?>"
                ><?= $tag['isActive'] ? '使用中' : '已停用' ?></button>
                <button
                  type="button"
                  data-action="delete-tag"
                  class="min-h-11 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 transition hover:bg-red-100"
                >删除</button>
              </li>
            <?php endforeach; ?>
          </ul>

          <button
            type="button"
            data-action="add-tag-open"
            class="mt-3 min-h-11 w-full rounded-lg border border-dashed border-line py-2 text-xs text-muted transition hover:border-primary hover:text-primary"
          >+ 在「<?= e($parent['name']) ?>」下新增子标签</button>
        </div>
      <?php endforeach; ?>

      <p class="text-xs leading-5 text-faint">
        标签为两级结构：顶级分类固定四项，新增标签只能挂在顶级分类下。停用的标签不会出现在筛选栏和录题页，
        但已引用它的题目不受影响。
      </p>
    </div>
  </div>
</div>

<?php
// 内置示例数据（「恢复内置示例数据」按钮用）。直接读前端那份 JSON，
// 保持单一数据源，不在仓库里维护第二份。
$seedQuestionsRaw = @file_get_contents(PHP_DIR . '/seed/questions.json');
$seedTagsRaw = @file_get_contents(PHP_DIR . '/seed/tags.json');
$seedQuestions = $seedQuestionsRaw !== false ? json_decode($seedQuestionsRaw, true) : [];
$seedTags = $seedTagsRaw !== false ? json_decode($seedTagsRaw, true) : null;
?>
<?= embed_json('admin-boot', [
    'tagDictionary' => $tagDictionary,
    'seedQuestions' => is_array($seedQuestions) ? $seedQuestions : [],
    'seedTags' => $seedTags,
    'existingIds' => array_map(function ($question) {
        return $question['id'];
    }, $questions),
    'tagUsage' => $tagUsage,
    'colorOptions' => ['#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16', '#10B981', '#14B8A6', '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6', '#A855F7', '#EC4899', '#F43F5E', '#64748B', '#0F172A'],
    'schemaVersion' => 1,
]) ?>
<script type="module" src="/assets/js/admin.js"></script>
