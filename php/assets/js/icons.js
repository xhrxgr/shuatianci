// 内联 SVG 图标 · 全站唯一来源
//
// 为什么要抽出来：此前同一批图标散在五处、各自一套画法——
// viewBox 有 16 / 20 / 24 三种，实际尺寸 h-4 / h-5 / h-6 三档，
// 描边有 stroke-width 2 / 1.6 / 实心填充三种。
// practice.js 与 paper-practice.js 里甚至**逐字节复制**了同一对
// correctIcon() / wrongIcon()，改一处不漏另一处就是个定时炸弹。
//
// 规范（改图标前先看这里）：
//   - 统一 viewBox="0 0 24 24"、fill="none"、stroke="currentColor"
//   - 统一 stroke-width="2"、stroke-linecap="round"、stroke-linejoin="round"
//   - 尺寸两档：行内 16px（h-4 w-4）、独立 20px（h-5 w-5）
//   - 颜色交给调用方（class 里写 text-success / text-danger / text-muted）
//   - 一律 aria-hidden：图标是装饰，旁边一定有文字

/** @param {string} cls 追加到 svg 上的类（尺寸与颜色） */
function svg(inner, cls) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

/** 判对 */
export function iconCheck(cls = "h-4 w-4") {
  return svg('<path d="M4 12.5l5 5L20 6.5"/>', cls);
}

/** 判错 */
export function iconCross(cls = "h-4 w-4") {
  return svg('<path d="M6 6l12 12M18 6L6 18"/>', cls);
}

/** 成功（提示条标题前的圆对勾） */
export function iconSuccess(cls = "h-5 w-5") {
  return svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>', cls);
}

/** 失败 */
export function iconError(cls = "h-5 w-5") {
  // 用叉号而不是「圆圈+感叹号」：iconInfo 已经是圆圈+感叹号，
  // 两者只差圆点上下位置，肉眼几乎分不出来（线上截图里 error 就被当成了 info）。
  // 叉号与 iconSuccess 的对勾同族，一眼可辨。
  return svg('<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>', cls);
}

/** 警告 */
export function iconWarn(cls = "h-5 w-5") {
  return svg('<path d="M12 3.6L2.8 19.2h18.4L12 3.6z"/><path d="M12 9.5v4.2M12 16.6v.3"/>', cls);
}

/** 提示 */
export function iconInfo(cls = "h-5 w-5") {
  return svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.3"/>', cls);
}

/** 菜单（汉堡） */
export function iconMenu(cls = "h-6 w-6") {
  return svg('<path d="M4 7h16M4 12h16M4 17h16"/>', cls);
}

/** 关闭 */
export function iconClose(cls = "h-6 w-6") {
  return svg('<path d="M6 6l12 12M18 6L6 18"/>', cls);
}

/** 加号（新增类操作；此前用字符 "+"，字形随系统字体变化） */
export function iconPlus(cls = "h-4 w-4") {
  return svg('<path d="M12 5v14M5 12h14"/>', cls);
}

/** 减号 / 叉（紧凑删除；同上，此前用字符 "×"） */
export function iconTinyCross(cls = "h-4 w-4") {
  return svg('<path d="M7 7l10 10M17 7L7 17"/>', cls);
}