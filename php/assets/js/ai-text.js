/**
 * 纯文本工具：HTML 转义、原句归一、挖空还原、占位符定位。
 *
 * 全部无副作用、不碰 DOM、不碰共享状态，因此可以被任意模块直接引用。
 * 挖空还原（restorePassageBlanks）是这一组里最有讲究的一个：
 * AI 经常把 passage 也写成挖空版，必须按**答案**而不是括号里的提示词还原，
 * 否则会造出语法错误的原文。
 */

import { BLANK_PLACEHOLDER } from "./ai-constants.js";


/**
 * 某组标签是否都属于指定父分类（允许带上该分类自身）。
 *
 * 用于核对「无提示词」的标签是否挂对：AI 常同时给出顶级分类 id（如 t_004）
 * 和子标签 id（如 t_032 定语从句-where），这种组合是合法的，
 * 顶级分类自身要放行，否则会把正确标签误判为错误。
 *
 * @param {string[]} tagIds
 * @param {Map<string, string|null>} parentMap 标签 id -> 父分类 id
 * @param {string} parentId
 * @returns {boolean}
 */
export function allTagsUnder(tags, parentMap, parentId) {
  if (tags.length === 0) return false;
  return tags.every((tagId) => tagId === parentId || parentMap.get(tagId) === parentId);
}

/**
 * 把 passage 里的挖空痕迹还原成**原文**。
 *
 * 实测 AI 经常把 passage 也写成挖空版：
 *
 *   "…national parks, officially ______ (establish) in 2021, cover 230,000…"
 *
 * 这有两个问题：它不是「未挖空的原文」；而且括号里就是答案，学生展开对照时
 * 等于直接看到答案 —— 对照功能完全失效。
 *
 * 还原时**必须用答案，不能用括号里的提示词**：提示词是词原形（establish），
 * 而句子里要的是变形后的形式（established / stability / treasures）。
 * 填回原形会造出语法错误的原文，比留空格更糟。
 *
 * 还原不了的位置（没有括号、或答案缺失）保持原样，不猜。
 *
 * @param {string} text passage 原文
 * @param {string[]} answers 该题各空的答案（按 blankIndex 顺序）
 * @returns {{ text: string, restored: number, missed: number }}
 */
export function restorePassageBlanks(text, answers) {
  if (typeof text !== "string" || text === "") {
    return { text: text ?? null, restored: 0, missed: 0 };
  }
  const pool = (Array.isArray(answers) ? answers : []).map((a) => String(a ?? "").trim());
  const mark = BLANK_PLACEHOLDER;      // "______"
  let cursor = 0;
  let restored = 0;
  let missed = 0;
  let out = "";
  let pos = 0;

  while (pos < text.length) {
    const hit = text.indexOf(mark, pos);
    if (hit === -1) {
      out += text.slice(pos);
      break;
    }
    out += text.slice(pos, hit);

    // 从挖空后面跳过空白；若接着是括号，就把它一并纳入替换区间
    let end = hit + mark.length;
    let probe = end;
    while (probe < text.length && /[ 	]/.test(text[probe])) probe += 1;
    const open = text[probe];
    if (open === "(" || open === "（") {
      const close = open === "(" ? ")" : "）";
      const closeAt = text.indexOf(close, probe + 1);
      // 只在括号内容较短（提示词不会很长）且确实闭合时才吃掉它
      if (closeAt !== -1 && closeAt - probe <= 62) {
        end = closeAt + 1;
      }
    }

    const answer = pool[cursor] ?? "";
    cursor += 1;
    if (answer === "") {
      missed += 1;
      out += text.slice(hit, end);      // 没有对应答案，保持原样，不猜
    } else {
      restored += 1;
      out += answer;
    }
    pos = end;
  }

  return { text: out, restored, missed };
}

/**
 * 检查 passage 里是否还残留挖空标记。
 *
 * @param {string} text
 * @returns {number} 残留的挖空个数
 */
function countRemainingBlanks(text) {
  if (typeof text !== "string") return 0;
  return (text.match(/______/g) ?? []).length;
}

export function normalizeSentence(text) {
  return String(text)
    .replace(/＿/g, "_")
    .replace(/[—–]{2,}/g, BLANK_PLACEHOLDER)
    .replace(/_{3,}/g, BLANK_PLACEHOLDER);
}

/** HTML 转义：所有动态文本都要经过它 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 生成题目 id。
 *
 * 外部 AI 不知道题库里已有哪些编号，每次都会从 q_0001 重新数，
 * 所以 id 一律由本系统生成，不采信 AI 返回的值。
 *
 * 格式与 admin.js 的手动录入保持一致：q_{时间戳36进制}，
 * 末尾再拼一段随机数以防同一批内多次调用撞号。
 */
export function generateQuestionId() {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 取每段文本里占位符的起始下标（迁移自原校验实现） */
export function findPlaceholderPositions(sentence) {
  const positions = [];
  const step = BLANK_PLACEHOLDER.length;
  let from = 0;
  for (;;) {
    const index = sentence.indexOf(BLANK_PLACEHOLDER, from);
    if (index === -1) break;
    positions.push(index);
    from = index + step;
  }
  return positions;
}

export function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}
