/**
 * AI 导入页的**唯一可变状态源**。
 *
 * 拆分前的 admin-ai.js 里这些是模块级 let 变量，散落在渲染、预览、
 * 入库各段之间互相读写。拆成多文件后必须有个明确的归属，
 * 否则就会出现「谁改的、谁看到的」对不上的幽灵 bug。
 *
 * 约定：
 *   - 所有跨模块读写一律走 `state.xxx`，**不要**在本文件之外再声明同名变量；
 *   - 只有 setupAiAssistant（入口）负责整体替换 els / hooks；
 *   - 数组字段（previewList 等）就地 splice 后，调用方需自行 syncLastBuild()。
 */

export const state = {
  /** 标签字典，由 setupAiAssistant 注入；主脚本刷新字典后可再次调用以更新 */
  dictionary: { schemaVersion: 1, tags: [] },

  /** 主脚本回调（每次 setup 用最新传入值覆盖） */
  hooks: {
    onAppend: () => {},
    onCreateTags: () => {},
    onNotice: () => {},
  },

  /** 页面元素引用 */
  els: null,

  /** 是否已绑定事件（setup 可能被主脚本多次调用，避免重复绑定） */
  bound: false,

  copyTimer: null,
  /** 待确认创建的标签 */
  pending: null,

  /**
   * 上次由脚本自动填入的试卷名；用于判断用户有没有手动改过。
   *
   * 导入成功后会置为 IMPORTED_MARK——那时 textarea 被清空、卷名框也清空，
   * 但卡片要保持可见，方便接着录下一卷。
   */
  lastAutoFilledName: "",

  /** 库里已有的试卷（由 setupAiAssistant 注入），用于提示同名归卷 */
  allPapers: [],
  /** 本次导入所做的自动修复说明，导入成功后一并告知用户 */
  pendingRepairs: [],
  /** 当前解析出的、字典里没有的标签 */
  missingTags: [],
  /** 解析中标志，防止连点重复入库 */
  submitting: false,

  /**
   * 预览状态（决策 D5）。
   *
   * 粘贴后立刻解析并渲染，用户在点「确认导入」之前就能完整看到这批题：
   * 原句、每空的答案/提示词/标签/解析，以及哪几道库里已经有了。
   *
   * previewList 是**解析 + 修复后的题目全量**（含未勾选的），
   * 真正要导入的是其中被勾选的部分，由 runImport 按 previewChecks 过滤。
   */
  previewList: [],      // 解析 + 修复后的题目（全量，含未勾选的）
  previewEditIndex: null, // 正在编辑的题号（同一时间只编辑一张卡片）
  pendingPassageText: "", // 本篇完整原文（待导入时随题目一起提交，挂到那一卷上）
  // v3.9.6 起不再有 previewPassageId / savedPassageTexts ——
  // 原文是卷的属性，不再建篇章、不再往题上挂 passageId
  previewVerdicts: [],  // 每题查重结果
  previewChecks: [],    // 每题是否勾选
  /** 预览对应的 textarea 内容，用于判断「粘贴后立刻点导入」时预览是否还是新的 */
  previewSourceText: null,
  /** 并发保护：慢的查重响应不能覆盖新一次粘贴的结果 */
  previewSeq: 0,

  /**
   * 在途的预览构建（同一段文本只跑一次）。
   *
   * 不合并会踩这个坑：粘贴后防抖 400ms 触发的构建，与「粘贴后立刻点导入」
   * 触发的构建会**并发**跑。后启动的把 previewSeq 加一，先启动的那次回来
   * 发现序号变了就静默返回 {ok:false} —— 于是提交路径什么也没做：
   * 既不导入也不报错，用户看到的是「点了没反应」。
   * 同一个 textarea 内容复用同一个 Promise，这个竞态就不存在了。
   */
  previewInFlight: null,

  /**
   * 最近一次**已完成**的构建：{ text, ok, list }。
   *
   * 光有 previewInFlight 还不够，实测能复现这条漏网路径（本地服务快时必现）：
   *   粘贴 → 立刻点导入 → 构建 A 启动（几毫秒就跑完，previewInFlight 清空）
   *   → 防抖 400ms 后触发构建 B，此时 A 早已结束，合并不生效
   *   → B 把 previewSeq 加一 → A 的 await 回来被判为过期 → 静默返回
   * 结果同样是「点了没反应」。这里记住「这段文本已经构建过、结果是什么」，
   * 同一段文本再问直接复用，不重复发请求、也不产生新的一代。
   */
  lastBuild: null,
  /** 是否刚复制过提示词 */
  copied: false,
};

export function activeTagCount() {
  return state.dictionary.tags.filter((tag) => tag.isActive).length;
}

/**
 * 编辑后把改动同步进 lastBuild 缓存。
 *
 * 不这么做的话：用户改完题，缓存里存的还是 AI 的原文，下一次 buildPreview
 * 命中同一段文本就会把编辑覆盖掉（「改了却莫名丢了几处修改」的成因）。
 */
export function syncLastBuild() {
  if (state.lastBuild === null) return;
  state.lastBuild.list = [...state.previewList];
  state.lastBuild.verdicts = [...state.previewVerdicts];
  state.lastBuild.checks = [...state.previewChecks];
  state.lastBuild.passageText = state.pendingPassageText;
}
