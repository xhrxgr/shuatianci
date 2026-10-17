/**
 * 解析 AI 粘贴回来的 JSON。
 *
 * AI 经常忘记转义原句里的引号，所以这里不用 JSON.parse 直接读：
 * 先cleanJson 去掉 markdown 包裹，再用 parseJsonLoose 逐字符容错扫描救回引号，
 * 最后 splitBatch 兼容三种历史批次格式。
 *
 * repairSentences负责在解析后**就地修复**两类高频格式错误（题号被当成空格、
 * 英文直引号），返回修复说明交给界面提示用户——宁可修好，也别整批丢掉。
 */

import { BLANK_PLACEHOLDER, QUOTE_PLACEHOLDER_MARK } from "./ai-constants.js";


/** 去掉可能存在的 markdown 代码块包裹 */
export function cleanJson(text) {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

/**
 * 预检并修复 AI 返回的原句，返回修复说明（供界面提示）。
 *
 * AI 已经两次栽在同一类格式错误上，所以这里不直接报错，而是先尽力纠正：
 * 1. 题号被当成了空格（`The 56 (fashion) sportswear`）——最常见，
 *    会导致整批题目一个空格都识别不出来
 * 2. 英文直引号未替换成中文引号
 *
 * 只在**高置信度**时才动手，宁可漏改交给校验报错，也不能把内容改坏：
 * - 题号只在 50～99 这个窄区间内替换（高考语法填空题号几乎都是 50 上下），
 *   所以 2021、2026、4700、2900 这些年份不会被误伤
 * - 后面紧跟字母的（21st century）不动
 * - 只替换裸编号，已是空格的位置不动
 *
 * @param {object[]} questions 已解析的题目数组（会被就地修改）
 * @returns {string[]} 修复说明，为空表示未做任何修复
 */
export function repairSentences(questions) {
  const notes = [];
  const allNumbers = [];

  questions.forEach((question) => {
    if (typeof question?.originalSentence !== "string") return;
    const before = question.originalSentence;

    // 引号 -> 中文引号。两种来源：
    // ① 容错解析留下的占位符（已确定是内容里的引号）
    // ② JSON 本身就合法，但内容里直接写了英文直引号
    // 两者都按出现顺序第1、3、5…个用左引号 “，第 2、4、6…个用右引号 ”。
    // 直接引语、引号强调在英语里都是成对出现的，所以按序配对不会错。
    let seen = 0;
    let sentence = "";
    for (const char of before) {
      if (char === '"' || char === QUOTE_PLACEHOLDER_MARK) {
        seen += 1;
        sentence += seen % 2 === 1 ? "“" : "”";
        continue;
      }
      sentence += char;
    }
    if (seen > 0) {
      notes.push("原句中的英文引号已自动换成中文引号 “ ”");
    }

    // 题号 -> 空格。高考语法填空的题号都是两位数且多在 50 上下，
    // 限定区间后不会碰到年份、年代（BCE、21st century）等正常数字。
    const isQuestionNumber = (digits) => {
      const value = Number(digits);
      return value >= 50 && value <= 99;
    };
    let numbers = [];
    // 位置一：题号后紧跟提示词括号，如 `56 (fashion)`
    sentence = sentence.replace(/\s+(\d{2,3})(\s*\()/g, (all, digits, tail) => {
      if (!isQuestionNumber(digits)) return all;
      numbers.push(digits);
      return ` ${BLANK_PLACEHOLDER}${tail}`;
    });
    // 位置二：逗号或分号后的题号，如 `praises, 57 people`
    sentence = sentence.replace(/([,;]\s*)(\d{2,3})(?=\s)/g, (all, lead, digits) => {
      if (!isQuestionNumber(digits)) return all;
      numbers.push(digits);
      return `${lead}${BLANK_PLACEHOLDER}`;
    });
    // 位置三：其他空格后的两位数，如 `drew many praises 57 people`
    //
    // ⚠️ 这里必须排除「介词/连词后面的数字」，否则会误伤真题里的正常表达：
    //   "grown from 27 to about 70 since 2017" → 70 后面是 since，被当成题号
    //   → 整句被改写，空格数量就比 blanks 多了，校验直接拦下整批题。
    // 真题号的后面跟的是被考查的那个词（people / cultures / one），
    // 不会是这些虚词。
    const NOT_QUESTION_NUMBER_AFTER =
      /^(since|from|between|among|and|or|but|so|in|on|at|to|of|for|with|about|over|under|near|by|during|before|after|into|onto|than|as)\b/i;
    sentence = sentence.replace(/(\s)(\d{2,3})(?=\s+[a-zA-Z])/g, (all, space, digits, offset, whole) => {
      if (!isQuestionNumber(digits)) return all;
      const after = whole.slice(offset + all.length).match(/^\s+([a-zA-Z]+)/);
      if (after && NOT_QUESTION_NUMBER_AFTER.test(after[1])) return all;
      numbers.push(digits);
      return `${space}${BLANK_PLACEHOLDER}`;
    });

    if (numbers.length > 0) {
      allNumbers.push(...numbers);
    }
    if (sentence !== before) {
      question.originalSentence = sentence;
    }
  });

  if (allNumbers.length > 0) {
    notes.push(
      `已把 ${allNumbers.length} 处卷面题号（${allNumbers.join("、")}）自动替换为空格——题号不应出现在原句里`
    );
  }

  return notes;
}

/**
 * 把 JSON.parse 的报错变成能照着改的信息。
 *
 * 浏览器的原生报错只给一个字符下标（"at position 2350"），
 * 面对几百行的粘贴内容根本无从下手。这里补三样东西：
 * 出错位置落在第几行、该行的内容、以及最可能的原因。
 *
 * @param {string}   text  清洗后的待解析文本
 * @param {Error}    error JSON.parse 抛出的异常
 * @param {string[]} lines 原始文本按行切分
 * @returns {string} 可直接展示给用户的多行提示
 */
export function explainJsonError(text, error, lines) {
  const messages = [`JSON 格式有误：${error.message}`];

  // 从报错信息里取出字符下标（各浏览器措辞不同）
  const match = /position (\d+)/.exec(error.message ?? "");
  const position = match ? Number(match[1]) : null;

  if (position !== null && text.length > 0) {
    const before = text.slice(0, position);
    const line = before.split("\n").length;
    const column = position - before.lastIndexOf("\n");
    messages.push(`出错位置在第 ${line} 行、第 ${column} 个字符。`);
    if (lines[line - 1] !== undefined) {
      messages.push(`该行内容：${lines[line - 1].trim().slice(0, 100)}`);
    }
  }

  // 最常见的原因：原句里的英文直引号提前截断了字符串
  const suspicious = lines.find(
    (item) => /"originalSentence"\s*:\s*"[^"]*"[^"]/.test(item)
  );
  if (suspicious) {
    messages.push(
      "这一行的 originalSentence 里出现了英文直引号 \"，它会提前结束 JSON 字符串。" +
        "请把原句中的英文双引号改成中文引号 “ ”。"
    );
    messages.push(`可疑的一行：${suspicious.trim().slice(0, 100)}`);
  }

  messages.push(
    "另外请确认：没有用 markdown 代码块包裹；字符串内部没有真实换行（需要换行请写 \\n）；最后一项后面没有多余逗号。"
  );
  return messages.join("\n");
}

/**
 * 容错解析：AI 经常忘记转义原句里的引号，这里尽量救回来。
 *
 * 做法是逐字符扫描，跟踪「当前是否在字符串内」；当判定某个引号属于
 * 字符串内容（而不是字符串的结束符）时，就把它改写成中文引号。
 *
 * 判定规则借用了 JSON 语法本身：字符串的结束引号后面只允许跟
 * 结构字符（逗号、冒号、右括号、右花括号）或空白，其他情况一律视为内容。
 *
 * @param {string} text 待解析文本
 * @returns {{value: any, repaired: boolean}|null} 解析失败时返回 null
 */
export function parseJsonLoose(text) {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    // 落到这里继续尝试容错解析
  }

  let output = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      output += char;
      continue;
    }

    if (char === "\\") {
      // 转义序列原样保留（跳过下一个字符）
      output += char + (text[i + 1] ?? "");
      i += 1;
      continue;
    }

    if (char === '"') {
      // 往后看第一个非空白字符：合法的结束符后面只能是结构字符
      let lookahead = i + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      const next = text[lookahead];
      const isClosingQuote = next === undefined || ",:}]".includes(next);
      if (isClosingQuote) {
        inString = false;
        output += char;
      } else {
        // 引号属于句子内容。单个裸引号没有配对信息，这里无法判断它是左引号
        // 还是右引号，一律先记成占位符，交给 repairSentences 按出现顺序
        // 成对改写为 “ 与 ”（靠后文内容判断左右比在这里猜要准）
        output += QUOTE_PLACEHOLDER_MARK;
      }
      continue;
    }

    output += char;
  }

  try {
    return { value: JSON.parse(output), repaired: true };
  } catch {
    return null;
  }
}

/**
 * 拆出「题库总览」与「本批的试卷名」。
 *
 * 目标格式（一次粘贴 = 一张卷子）：
 *   { "source": "某某中学2026-2027学年高三上学期10月阶段检测试题",
 *     "questions": [ {originalSentence, blanks}, ... ] }
 *
 * 同时兼容三种历史写法，避免旧数据/旧提示词直接失效：
 *   1. 裸数组 [ {..}, {..} ]—— 每道题各带 source
 *   2. 单个对象 { originalSentence, blanks }  —— 误粘了一道题
 *   3. 新格式的变体：source 写在数组第一个元素里
 *
 * @returns {{list: object[], source: string, perItem: boolean}}
 */
export function splitBatch(parsed) {
  // 新格式：顶层有 questions
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.questions)
  ) {
    // 顶层 passage（提示词现在要求的写法）：整篇原文与 questions 平级，
    // 一眼就能看出「一篇 = 一个 passage + N 道题」，题里不再重复带 passage。
    const topPassage =
      typeof parsed.passage === "string" && parsed.passage.trim() !== ""
        ? parsed.passage.trim()
        : "";
    const list = topPassage
      ? parsed.questions.map((q) =>
          q && typeof q === "object" && !Array.isArray(q)
            ? { ...q, passage: q.passage ?? topPassage }
            : q
        )
      : parsed.questions;
    return {
      list,
      source: typeof parsed.source === "string" ? parsed.source.trim() : "",
      perItem: false,
      topPassage,
    };
  }

  if (Array.isArray(parsed)) {
    const first = parsed.find((item) => item && typeof item === "object" && !Array.isArray(item));
    // 老写法：source 写在每道题里
    const perItem = first && typeof first.source === "string";
    const source = perItem ? first.source.trim() : "";
    return { list: parsed, source, perItem: Boolean(perItem), topPassage: "" };
  }

  // 误粘了单个对象
  if (parsed && typeof parsed === "object") {
    return { list: [parsed], source: typeof parsed.source === "string" ? parsed.source.trim() : "", perItem: true };
  }

  return { list: [], source: "", perItem: false };
}
