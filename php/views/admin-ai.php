<?php
/**
 * AI 助手标签页。
 *
 * 本文件是「题库管理」的一个页签片段，被 php/views/admin.php 用 include 引入，
 * 因此这里只放两段内容结构，不写 <script>（脚本由 admin.php 统一以
 * <script type="module"> 引入，再由它调用 window.setupAdminAi(...)）。
 *
 * 两点实现说明（对用户无感知）：
 * - 第一步文案里的「当前 N 个标签」由 PHP 依据 $tagDictionary 直出，
 *   JS 挂载时会再同步一次，保证一致
 * - 操作结果提示（成功导入 / 已创建标签 / 复制失败）统一显示在页面顶部，
 *   由 assets/js/admin-ai.js 通过 onNotice 回调触发，这里不再渲染提示行
 *
 * 所有动态文本都由 assets/js/admin-ai.js 输出并自行转义（本片段为纯静态结构）。
 * 供脚本使用的钩子：
 *   #admin-ai-root            根容器（页签切换时由 admin.js 控制显隐）
 *   [data-tag-count]          提示词里的标签数量
 *   #admin-ai-copy            复制提示词
 *   #admin-ai-manual-copy     手动复制
 *   #ai-source                试卷来源输入框
 *   #admin-ai-json            粘贴 JSON 的 textarea
 *   #admin-ai-missing         字典里没有的标签提示块
 *   #admin-ai-missing-list    缺失标签的 <span> 容器
 *   #admin-ai-create-tags     创建这些标签
 *   #admin-ai-error           校验错误列表
 *   #admin-ai-submit          确认导入这一卷
 *
 * @var array $tagDictionary 标签字典，结构同 /api/tags 返回的 tagDictionary
 */

$aiTags = isset($tagDictionary['tags']) && is_array($tagDictionary['tags']) ? $tagDictionary['tags'] : [];
$aiActiveCount = 0;
foreach ($aiTags as $aiTag) {
    if (!empty($aiTag['isActive'])) {
        $aiActiveCount++;
    }
}
?>
<div class="space-y-5" id="admin-ai-root" hidden>
  <!-- 第一步：复制提示词 -->
  <section class="rounded-xl border border-line bg-surface p-5">
    <h3 class="mb-1 text-sm font-semibold text-ink">第一步：复制提示词</h3>
    <p class="mb-2 text-xs leading-5 text-muted">
      点击下方按钮复制完整提示词（已自动附带当前 <span data-tag-count><?= e($aiActiveCount) ?></span> 个标签），
      再在任意支持图片的 AI 工具中提交。
    </p>
    <div class="mb-4 rounded-lg bg-surface-alt p-3">
      <p class="mb-1.5 text-xs font-medium text-ink">提问时请同时提供以下两张图片：</p>
      <ul class="space-y-1 text-xs text-muted">
        <li>· 卷子封面图（可选，AI 能从里面读出学校、学期、考试名，用于自动填写来源）</li>
        <li>· 题目页图片（一整段语篇，通常带 56、57 这样的题号）</li>
      </ul>
      <p class="mt-2 text-xs text-faint">
        AI 会按句切分成独立题目：同一句里的几个空会连在一起，答案需要看前后文时会带上相关句子，
        不会把答题依据切掉。题号不会写进原句。
      </p>
    </div>
    <div class="flex flex-col gap-2 sm:flex-row">
      <button
        type="button"
        id="admin-ai-copy"
        class="min-h-11 flex-1 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
      >复制提示词</button>
      <button
        type="button"
        id="admin-ai-manual-copy"
        class="min-h-11 rounded-xl border border-line px-5 py-3 text-sm text-muted transition hover:bg-surface-alt"
      >手动复制</button>
    </div>
  </section>

  <!-- 第二步：粘贴结果并入库 -->
  <section class="rounded-xl border border-line bg-surface p-5">
    <h3 class="mb-1 text-sm font-semibold text-ink">第二步：粘贴 AI 返回的 JSON</h3>
    <p class="mb-4 text-xs leading-5 text-muted">
      校验通过后<span class="font-medium text-success">增量追加</span>到题库，不会覆盖或删除已有题目。
      一次粘贴就是一张卷子：AI 返回的
      <span class="font-medium text-ink">source</span> 会自动填到下面的试卷名框里，
      看一眼要不要改，确认后再导入。
    </p>

    <textarea
      id="admin-ai-json"
      rows="10"
      placeholder='{"source":"试卷名","questions":[{"originalSentence":"...","blanks":[...]}]}'
      class="blank-slot w-full rounded-lg border border-line bg-surface-alt px-3 py-2 text-xs leading-5 outline-none transition focus:border-primary"
    ></textarea>

    <!-- 试卷名：粘贴后由脚本自动填入 AI 给的来源，并标出它是从哪来的，
         让用户在导入前一眼看到、有余地改 -->
    <div class="mt-4 rounded-lg border border-line bg-surface-alt p-4" id="admin-ai-paper" hidden>
      <label class="mb-1.5 block text-sm font-medium text-ink" for="ai-source">
        试卷名（<span class="text-danger">*</span>）
      </label>
      <input
        id="ai-source"
        type="text"
        placeholder="例如：某某中学2026-2027学年高三上学期10月阶段检测试题"
        class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
      >
      <p class="mt-2 text-xs leading-5 text-muted" id="admin-ai-paper-hint"></p>
    </div>

    <!-- 预览区：粘贴即渲染，用户点导入前就能完整看到这批题长什么样、哪几道库里已有 -->
    <div class="mt-4" id="admin-ai-preview" hidden>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs leading-5 text-muted" id="admin-ai-preview-summary"></p>
        <div class="flex items-center gap-2">
          <button
            type="button"
            id="admin-ai-select-all"
            class="min-h-9 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:bg-surface-alt"
          >全选</button>
          <button
            type="button"
            id="admin-ai-select-none"
            class="min-h-9 rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:bg-surface-alt"
          >全不选</button>
        </div>
      </div>
      <div class="max-h-[32rem] space-y-2 overflow-y-auto rounded-lg border border-line bg-surface-alt p-3" id="admin-ai-preview-list"></div>
    </div>

    <div class="mt-4 rounded-lg border border-warning/40 bg-warning-soft p-4" id="admin-ai-missing" hidden>
      <p class="mb-2 text-xs text-warning">
        检测到当前标签字典里没有的标签：<span id="admin-ai-missing-list"></span>
      </p>
      <p class="mb-3 text-xs text-warning">
        创建后会挂到第一个顶级分类下，之后可到「标签管理」里调整归属和颜色。
      </p>
      <button
        type="button"
        id="admin-ai-create-tags"
        class="min-h-11 rounded-lg bg-warning px-4 py-2 text-xs font-medium text-on-primary transition hover:opacity-90"
      >创建这些标签</button>
    </div>

    <!-- 错误块由 feedback.js 往里塞完整的提示条（含图标、详情列表、重试按钮），
         所以这里用 div 而不是原先的 ul —— ul 里塞 div 不合法 -->
    <div class="mt-4" id="admin-ai-error" hidden></div>

    <button
      type="button"
      id="admin-ai-submit"
      class="mt-4 min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
    >确认导入这一卷</button>
  </section>
</div>
