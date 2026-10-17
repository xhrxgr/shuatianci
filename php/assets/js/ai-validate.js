/**
 * 题目合法性校验。
 *
 * 与服务端 app/validate.php 是**两套独立实现**，规则需要人工保持同步
 * （改了一边必须记得改另一边）。前端校验的价值在于「整批拦下并逐条列错」，
 * 避免用户点一次导入、库里多出一半错题。
 *
 * 有错就整批不导，不做「能导几道导几道」——半批入库比不导入更难收拾。
 */

import { BLANK_PLACEHOLDER, FUNCTION_WORDS, HINT_TYPES } from "./ai-constants.js";
import { allTagsUnder, findPlaceholderPositions } from "./ai-text.js";


/**
 * 找出原句里残留的卷面题号。
 *
 * 与 repairSentences 用同一套判据（50～99 的两位数、后面不接字母），
 * 所以「能自动修的」绝不会在这里再报一次；只有修不了（漏网的）才会报出来。
 *
 * @param {string} sentence
 * @returns {string[]} 残留的题号
 */
function findStrayQuestionNumbers(sentence) {
  // 题号的真正特征是**前面是句首或标点，后面不是单位**，
  // 而不是「数值落在 50~99 之间」。
  //
  // 原来只按数值范围判定，实测把真题里的正常数字全当成题号了：
  //   "water flow ______ nearly 50% in the past five years"  → 50 被当成题号
  //   "grown from 27 to about 70 since 2017"                 → 70 被当成题号
  // 于是本来合格的题被判成「残留题号」，整批导入不了 —— 而这恰恰是
  // 这套校验要防的那类问题的**误报**版本。
  //
  // 卷面题号长这样：56 is now Liaoning / 57 one of China's…
  // 也就是「前面是句首或句末标点，后面跟空格或标点」。按这个形态匹配，
  // 上面的 50% 与 about 70 都不再命中。
  const found = [];
  // 前面是句首或句末标点，后面跟空格/标点/结尾 —— 这两条限定一起，
  // 才能把 "nearly 50%" 与 "about 70" 排除掉。
  const pattern = new RegExp(
    "(^|[.;:!?\\n]\\s*)(\\d{1,3})(?=\\s|[.,;:!?]|$)",
    "g"
  );
  let match;
  while ((match = pattern.exec(sentence)) !== null) {
    const value = Number(match[2]);
    if (value >= 1 && value <= 99) {
      found.push(match[2]);
    }
  }
  return found;
}

/** 校验一道题目是否合法（迁移自原校验实现 的 validateQuestion） */
function validateQuestion(question, tagDictionary) {
  const errors = [];
  // 完整原文：选填，填了才校验（与服务端 normalize_passage_text 同一套口径）
  if (question.passageText !== undefined && question.passageText !== null) {
    if (typeof question.passageText !== "string") {
      errors.push("passageText 必须是字符串");
    } else if (question.passageText.trim() === "") {
      errors.push("passageText 不能是空串（不想给原文就整个省略这个字段）");
    } else if (question.passageText.length > 5000) {
      errors.push(`passageText 过长：上限 5000 字（当前 ${question.passageText.length} 字）`);
    }
  }
  const sentence = typeof question.originalSentence === "string" ? question.originalSentence : "";

  // 1. 原句至少有一个空格
  const positions = findPlaceholderPositions(sentence);
  if (positions.length < 1) {
    errors.push(`原句必须包含至少一个「${BLANK_PLACEHOLDER}」空格`);
  }

  // 2. 空格数量与 blanks 数量一致
  if (positions.length !== question.blanks.length) {
    errors.push(
      `原句中的空格数量（${positions.length}）与 blanks 数量（${question.blanks.length}）不一致`
    );
  }

  // 2-1. 残留题号：AI 偶尔会把卷面题号（56、57…）原样留在句中。
  // 这类数字必须替换成空格，否则学生会看到一个没有下划线的「伪空格」。
  const strayNumbers = findStrayQuestionNumbers(sentence);
  if (strayNumbers.length > 0) {
    errors.push(
      `原句里残留题号 ${strayNumbers.join("、")}，题号必须删除并改写为 ${BLANK_PLACEHOLDER}`
    );
  }

  // 3. blankIndex 必须从 1 开始且连续递增，用于精确定位第 N 个空格
  question.blanks.forEach((blank, index) => {
    if (blank.blankIndex !== index + 1) {
      errors.push(
        `第 ${index + 1} 个空的 blankIndex 应为 ${index + 1}，实际为 ${blank.blankIndex}（须从 1 开始连续递增）`
      );
    }
  });

  // 4. 逐个空校验
  question.blanks.forEach((blank, index) => {
    const label = `第 ${index + 1} 个空`;

    if (!Array.isArray(blank.answer) || blank.answer.length === 0) {
      errors.push(`${label}：answer 不能为空`);
    } else {
      blank.answer.forEach((ans, ansIndex) => {
        if (typeof ans !== "string" || ans.trim() === "") {
          errors.push(`${label}：answer 不能包含空字符串`);
        }
      });

      // 答案去重：与判卷口径一致，只忽略首尾空格，保留大小写差异
      // （Written 与 written 属于不同答案，不能合并）
      const normalized = blank.answer.map((ans) => ans.trim());
      const unique = new Set(normalized);
      if (unique.size !== normalized.length) {
        errors.push(`${label}：answer 存在完全重复的项`);
      }
    }

    if (!HINT_TYPES.includes(blank.hintType)) {
      errors.push(`${label}：hintType「${blank.hintType}」无效，应为 ${HINT_TYPES.join(" / ")} 之一`);
    }

    if (blank.hintType !== "无提示词" && (blank.hintWord === null || blank.hintWord.trim() === "")) {
      errors.push(`${label}：hintType 为「${blank.hintType}」时必须填写 hintWord`);
    }

    if (blank.hintType === "无提示词" && blank.hintWord !== null && blank.hintWord.trim() !== "") {
      errors.push(`${label}：hintType 为「无提示词」时 hintWord 必须为 null`);
    }

    const tagMap = new Map(tagDictionary.tags.map((tag) => [tag.id, tag]));
    (blank.tagIds ?? []).forEach((tagId) => {
      const tag = tagMap.get(tagId);
      if (!tag) {
        errors.push(`${label}：标签 ${tagId} 在标签字典中不存在`);
      } else if (!tag.isActive) {
        errors.push(`${label}：标签 ${tagId}（${tag.name}）已停用`);
      }
    });

    // 无提示词的空只能考功能词：高考语法填空把「答案唯一、可客观评分」
    // 作为命题前提，实词太开放（换任何一个也说得通），无法评分。
    if (blank.hintType === "无提示词") {
      const notFunction = (blank.answer ?? []).filter(
        (ans) => !FUNCTION_WORDS.has(String(ans).trim().toLowerCase())
      );
      if (notFunction.length > 0) {
        errors.push(
          `${label}：无提示词的空只能填功能词（冠词、介词、连词、代词、助动词、情态动词、关系副词等），` +
            `而「${notFunction.join("、")}」是实词或分词。` +
            `若这处空格确实只能靠语义猜测，它就不是合格的无提示词填空——请核对原卷该处是否本来就有提示词`
        );
      }

      // 标签也必须挂在「无提示词」分类下，不能挂到需要词性转换的分类
      const parentMap = new Map(tagDictionary.tags.map((tag) => [tag.id, tag.parentId]));
      const noHintRoot = tagDictionary.tags.find((tag) => tag.name === "无提示词")?.id;
      if (noHintRoot && (blank.tagIds ?? []).length > 0 && !allTagsUnder(blank.tagIds, parentMap, noHintRoot)) {
        const names = (blank.tagIds ?? [])
          .map((id) => tagMap.get(id)?.name ?? id)
          .join("、");
        errors.push(
          `${label}：无提示词的空，标签应挂在「无提示词」分类下（冠词、介词、连词、关系副词等），` +
            `当前挂的是「${names}」——那是需要词性转换的分类，只用于有提示词的空`
        );
      }
    }

    // 解析只要求非空：内容质量靠人工复核，不做字数下限，
    // 免得为了凑字数写废话或编造内容
    if ((blank.trapAnalysis ?? "").trim() === "") {
      errors.push(`${label}：trapAnalysis 不能为空`);
    }
  });

  return { isValid: errors.length === 0, errors };
}

/** 批量校验，逐条收集全部错误（迁移自原校验实现 的 validateQuestions） */
export function validateQuestions(questions, tagDictionary) {
  const results = [];
  const validIndexes = [];
  const allErrors = [];

  questions.forEach((question, index) => {
    const result = validateQuestion(question, tagDictionary);
    results.push(result);
    if (result.isValid) {
      validIndexes.push(index);
    } else {
      result.errors.forEach((error) => allErrors.push(`第 ${index + 1} 条: ${error}`));
    }
  });

  return { results, validIndexes, allErrors };
}
