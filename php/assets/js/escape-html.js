/**
 * HTML 转义：把不可信文本变成可以安全写进 innerHTML 的字符串。
 *
 * 为什么单独成文件
 * --------------
 * 这份实现此前在 6 个文件里各抄了一份（admin.js、admin-papers.js 之外的
 * admin-system.js / admin-users.js，以及练习页的 practice.js / paper-practice.js，
 * 还有 ai-text.js），**逐字节相同**。副本的危害不是「多占几行」：
 *   · 要改转义规则（比如补上反引号，挡markdown 里的属性注入）时改一处漏五处，
 *     而漏掉的那份就成了 XSS 口子；
 *   · 审查时看到「这个文件用了 escapeHtml」会误以为它用的是统一实现，
 *     实际可能是一份早已过时的副本。
 *
 * 转义顺序不可调换
 * --------------
 * `&` 必须第一个替换：若先替换 `<` / `"`，它们产生的 `&lt;` / `&quot;`
 * 里的 `&` 会被后续规则再转义一次，变成 `&amp;lt;`，页面上就会显示出
 * 字面量 "&lt;" 而不是 "<"。
 *
 * 用法
 * ----
 *   import { escapeHtml } from "./escape-html.js";
 *
 *   el.innerHTML = `<span>${escapeHtml(userInput)}</span>`;
 *
 * 注意：本函数只保证「作为文本安全」。属性值、URL、<script> 内容
 * 各有额外要求，不要指望它一个函数包打天下。
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}