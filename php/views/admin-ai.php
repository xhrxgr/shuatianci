<?php
/**
 * AI 助手标签页（对应 src/components/AiAssistant.tsx，结构与类名逐项一致）。
 *
 * 本文件是「录题后台」的一个页签片段，被 php/views/admin.php 用 include 引入，
 * 因此这里只放两段内容结构，不写 <script>（脚本由 admin.php 统一以
 * <script type="module"> 引入，再由它调用 window.setupAdminAi(...)）。
 *
 * 与 React 版的差别（对用户无感知）：
 * - 第一步文案里的「当前 N 个标签」由 PHP 依据 $tagDictionary 直出
 *   （原版由 JS 计算），JS 挂载时会再同步一次，保证一致
 * - 原版组件内部的 notice（成功导入 / 已创建标签 / 复制失败）迁移到页面顶部的
 *   统一提示条，由 assets/js/admin-ai.js 通过 onNotice 回调触发，这里不再渲染提示行
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
 *   #admin-ai-submit          解析并入库
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
      点一下复制完整提示词（已自动带上当前 <span data-tag-count><?= e($aiActiveCount) ?></span> 个标签），
      去任意支持图片的 AI 工具提问。
    </p>
    <div class="mb-4 rounded-lg bg-surface-alt p-3">
      <p class="mb-1.5 text-xs font-medium text-ink">提问时请一并发送两张图：</p>
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
    </p>

    <!-- 试卷来源：留空时使用 AI 从封面识别出的来源（写在 JSON 每道题的 source 里） -->
    <label class="mb-1.5 block text-sm font-medium text-ink" for="ai-source">试卷来源（可选）</label>
    <input
      id="ai-source"
      type="text"
      placeholder="留空则用 AI 从封面识别的来源；填写后将统一覆盖本批题目"
      class="mb-4 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
    >

    <textarea
      id="admin-ai-json"
      rows="10"
      placeholder='[{"id":"q_0001","originalSentence":"...","blanks":[...]}]'
      class="blank-slot w-full rounded-lg border border-line bg-surface-alt px-3 py-2 text-xs leading-5 outline-none transition focus:border-primary"
    ></textarea>

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

    <ul class="mt-4 space-y-1 rounded-lg border border-danger/30 bg-danger-soft p-4 text-xs text-danger" id="admin-ai-error" hidden></ul>

    <button
      type="button"
      id="admin-ai-submit"
      class="mt-4 min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
    >解析并入库</button>
  </section>
</div>
