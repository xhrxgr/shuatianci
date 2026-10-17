/**
 * JS 模块静态自检：抓「用了符号却没导入」这类只在浏览器里暴露的问题。
 *
 * 为什么要有这个
 * --------------
 * v3.8.7 收敛 escapeHtml 时，把每个文件里的本地定义换成
 * `export { escapeHtml } from "./escape-html.js"`。re-export 只把符号转发给
 * 下游模块，**不会在当前模块建立本地绑定**——于是 admin.js 里那26 处
 * `escapeHtml(...)` 全部抛 ReferenceError。
 *
 * 这个错很阴险：
 *   · `node --check` 语法检查通过（语法没问题，是运行期作用域问题）
 *   · 从下游 import 也能正常工作（re-export 确实生效了）
 *   · 只在**真正执行到那段代码**时才炸，所以纯静态检查看不出来，
 *     得靠浏览器端到端测试才能发现。
 *
 * 检查什么
 * --------
 * 对每个 js 文件：若内部调用了某个模块级符号，而该文件既没有
 * `import` 它、也没有在本模块定义它，就报出来。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_DIR = join(HERE, "..", "assets", "js");

/** 这些符号值得查：复制粘贴容易漏、且用错时只在运行期炸 */
const WATCHED = ["escapeHtml", "findPlaceholderPositions", "normalizeSentence",
  "restorePassageBlanks", "generateQuestionId", "notifyError", "notifyWarn",
  "iconCheck", "iconCross", "iconSuccess", "debounce", "api"];

const files = readdirSync(JS_DIR).filter((f) => f.endsWith(".js"));

export function checkJsBindings(check) {
  const bad = [];

  for (const name of files) {
    const src = readFileSync(join(JS_DIR, name), "utf8");
    const lines = src.split("\n");

    // 本模块自己声明的顶层符号（function / const / let / class），以及 re-export
    const declared = new Set();
    for (const re of [
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm,
      /^(?:export\s+)?class\s+(\w+)/gm,
    ]) {
      for (const m of src.matchAll(re)) declared.add(m[1]);
    }

    for (const sym of WATCHED) {
      // 真的调用了：后跟左括号，且不是定义处、不是注释
      const uses = new RegExp(`(?<![.\\w$])${sym}\\s*\\(`);
      let used = false;
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (uses.test(line)) { used = true; break; }
      }
      if (!used) continue;
      if (declared.has(sym)) continue;

      // 导入了没有？只要 import 语句里出现这个符号就算有。
      // 关键：`export { x } from "..."` **不算**导入——它不给本模块建绑定。
      const imported = new RegExp(`^import[^;]*\\b${sym}\\b[^;]*;`, "m").test(src);
      if (!imported) {
        bad.push(`${name}: 调用了 ${sym}(...) 但既没 import 也没在本模块定义`);
      }
    }
  }

  check(
    "JS 模块自检：用到的符号都有 import（re-export 不算）",
    bad.length === 0,
    bad.slice(0, 10)
  );
}