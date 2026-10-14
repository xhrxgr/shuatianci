/**
 * 题目指纹（去重判定）· 浏览器侧实现
 *
 * ⚠️ 本文件是 php/app/fingerprint.php 的**逐条对照实现**，规格见
 *    docs/FINGERPRINT_SPEC.md。两份实现无法共享代码（PHP 与浏览器环境不同），
 *    靠**同一组用例双向校验**来防漂移：
 *      php/tests/fingerprint-cases.json  ← 唯一真源
 *      后端 api-test / fingerprint-test.php 跑一遍
 *      前端 ui-test 跑一遍（通过 window.__fingerprintSelfTest）
 *    改这里必须同步改 PHP 侧，否则会出现「预览说已存在、入库却变成新增」。
 *
 * 为什么不用 String.normalize('NFKC')：它会把 ① 转成 1、把片假名、上标
 * 一并转换，范围不受控；显式映射表只处理「同一句话里可能混用的标点与字母」，
 * 行为可预测，也能与 PHP 的 strtr 逐字对齐。
 */

/** 全角 → 半角（与 PHP fingerprint_fullwidth_map 保持一致） */
const FULLWIDTH_MAP = {
  // 字母
  "Ａ": "A", "Ｂ": "B", "Ｃ": "C", "Ｄ": "D", "Ｅ": "E", "Ｆ": "F",
  "Ｇ": "G", "Ｈ": "H", "Ｉ": "I", "Ｊ": "J", "Ｋ": "K", "Ｌ": "L",
  "Ｍ": "M", "Ｎ": "N", "Ｏ": "O", "Ｐ": "P", "Ｑ": "Q", "Ｒ": "R",
  "Ｓ": "S", "Ｔ": "T", "Ｕ": "U", "Ｖ": "V", "Ｗ": "W", "Ｘ": "X",
  "Ｙ": "Y", "Ｚ": "Z",
  // 标点
  "．": ".", "，": ",", "　": " ", "？": "?", "！": "!", "：": ":", "；": ";",
  "（": "(", "）": ")", "［": "[", "］": "]", "｛": "{", "｝": "}",
  "“": "\"", "”": "\"", "‘": "'", "’": "'", "・": " ", "－": "-", "─": "-", "—": "-",
  // 中文标点（图文填空常见中英混排，句末的「。」尤其不能漏）
  "。": ".", "、": ",", "「": "\"", "」": "\"", "『": "\"", "』": "\"",
  "《": "\"", "》": "\"",
  // 不换行空格
  "\u00A0": " ", "\u3000": " ",
};

/** 英文句读：视作等价，统一删除（与 PHP fingerprint_english_punctuation 一致） */
const ENGLISH_PUNCTUATION = [",", ".", "?", "!", ";", ":"];

/**
 * 归一化原句：全角转半角 → 删占位符下划线 → 删所有空白 → 删英文句读 → 转小写。
 *
 * 括号**不删**：`a(b)` 与 `ab` 是不同的句子。
 */
export function normalizeSentence(text) {
  let out = "";
  const input = String(text ?? "");
  for (const ch of input) {
    out += Object.prototype.hasOwnProperty.call(FULLWIDTH_MAP, ch) ? FULLWIDTH_MAP[ch] : ch;
  }
  out = out.replace(/_/g, "");
  out = out.replace(/\s+/g, "");
  for (const ch of ENGLISH_PUNCTUATION) {
    out = out.split(ch).join("");
  }
  return out.toLowerCase();
}

/** 题目指纹：只由原句决定，与答案无关 */
export function sentenceFingerprint(sentence) {
  return normalizeSentence(sentence);
}

/**
 * 按分隔符切分一个答案项（规则与前端 splitAnswers 一致：/ 半角逗号 全角逗号，另加顿号）
 */
function explodeSeparators(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return [];
  return trimmed
    .split(/[/,，、]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * 答案的规范形式：摊平 → 切分 → 去空 → 转小写 → 去重 → 排序。
 *
 * 转小写是为了去重宽容（IS 与 is 视为同一答案），与判卷口径
 * （大小写敏感）是两个不同目的，不要混。
 */
export function answerSignature(answers) {
  const set = new Set();

  // 递归摊平：AI 输出畸形数据时 answer 里可能嵌套数组。
  // 刻意不跳过非标量——跳过会让签名变成空集合，于是所有同原句的题
  // 都判成「答案不相交」= 新题，恰好漏掉最该抓的那类重复。
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (Array.isArray(item)) {
        walk(item);
        continue;
      }
      if (item === null || typeof item === "boolean" || item === undefined) continue;
      for (const part of explodeSeparators(item)) {
        set.add(part.toLowerCase());
      }
    }
  };
  walk(answers);

  return [...set].sort();
}

/**
 * 两个答案规范集合的关系：equal | overlap | subset | disjoint
 */
export function answerRelation(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === setB.size && [...setA].every((x) => setB.has(x))) return "equal";
  let inter = 0;
  for (const x of setA) {
    if (setB.has(x)) inter++;
  }
  if (inter === 0) return "disjoint";
  if (inter === setA.size || inter === setB.size) return "subset";
  return "overlap";
}

/**
 * 把新题与候选比对，给出分类结论。
 *
 * @param {string} newSentence
 * @param {string[]} newAnswers
 * @param {Array} candidates [{id, originalSentence, answers, source}]
 * @returns {{state: 'new'|'duplicate'|'diff', matched: Array, hint: string}}
 */
export function classifyDuplicate(newSentence, newAnswers, candidates) {
  // 先自己按指纹过滤，不信任调用方。不同原句的题可能有完全相同的答案，
  // 不过滤会把两道不同的题判成重复，导致真实的重复反而被漏掉。
  const fingerprint = sentenceFingerprint(newSentence);
  const sig = answerSignature(newAnswers);

  const equal = [];
  const diff = [];
  const hints = [];

  for (const candidate of candidates ?? []) {
    if (sentenceFingerprint(candidate?.originalSentence ?? "") !== fingerprint) continue;
    const relation = answerRelation(sig, answerSignature(candidate?.answers ?? []));
    if (relation === "equal") {
      equal.push(candidate);
    } else if (relation === "disjoint") {
      // 答案完全不相交 = 本次给的是另一个答案，视为新题（让人看见 AI 的修正）
      continue;
    } else {
      diff.push(candidate);
      const libSig = answerSignature(candidate?.answers ?? []);
      const onlyNew = sig.filter((x) => !libSig.includes(x));
      const onlyOld = libSig.filter((x) => !sig.includes(x));
      const parts = [];
      if (onlyOld.length > 0) parts.push(`库里有 ${onlyOld.join("/")}`);
      if (onlyNew.length > 0) parts.push(`本次给了 ${onlyNew.join("/")}`);
      if (parts.length > 0) hints.push(parts.join("，"));
    }
  }

  if (equal.length > 0) {
    return { state: "duplicate", matched: equal, hint: `与已有第 ${equal.map((c) => c.id).join("、")} 题相同` };
  }
  if (diff.length > 0) {
    return { state: "diff", matched: diff, hint: hints.length > 0 ? hints.join("；") : "答案与已有题不同" };
  }
  return { state: "new", matched: [], hint: "" };
}

/**
 * 取一道题的全部答案（各空的答案拍平），用于构造查重请求。
 */
export function collectAnswers(question) {
  const out = [];
  for (const blank of question?.blanks ?? []) {
    for (const a of blank?.answer ?? []) {
      out.push(a);
    }
  }
  return out;
}

/**
 * 自测：跑同一份用例集，供 UI 测试调用。
 *
 * 存在的意义是「两端口径一致性」——用例集是唯一真源，
 * PHP 与 JS 必须对每组用例给出相同结论。
 * 用法（在页面里）：await window.__fingerprintSelfTest('/api/...') 不适用，
 * 用例由测试脚本注入，见 php/tests/ui-test.mjs。
 */
export function runFingerprintCases(cases) {
  const results = [];
  for (const c of cases.sentence_cases ?? []) {
    const got = sentenceFingerprint(c.in);
    results.push({ kind: "sentence", id: c.in, got, expect: c.expect, ok: got === c.expect });
  }
  const runList = [
    ...(cases.cases ?? []).map((c) => ({ ...c, kind: "case" })),
    ...(cases.edge_cases ?? []).map((c) => ({ ...c, kind: "edge" })),
  ];
  for (const c of runList) {
    let sentence = c.incoming.sentence;
    if (sentence === "PLACEHOLDER") {
      sentence = "word ".repeat(5000) + "______ end.";
    }
    const candidates = (c.existing ?? []).map((e) => ({
      id: e.id,
      ...(Object.prototype.hasOwnProperty.call(e, "sentence") ? { originalSentence: e.sentence } : {}),
      ...(Object.prototype.hasOwnProperty.call(e, "answers") ? { answers: e.answers } : {}),
    }));
    const verdict = classifyDuplicate(sentence, c.incoming.answers ?? [], candidates);
    results.push({ kind: c.kind, id: c.id, got: verdict.state, expect: c.expect, ok: verdict.state === c.expect });
  }
  return results;
}
