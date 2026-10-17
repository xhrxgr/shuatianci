/**
 * AI 导入用到的领域常量。
 *
 * 这些值是**跨模块共享的词汇表**：提示词、校验、预览渲染都要用同一份，
 * 任何一处改动都会同时影响「提示 AI 怎么说」和「我们怎么判」。
 * 所以集中在这里，各模块一律只读引用。
 */


/** 全部合法的提示词类型 */
export const HINT_TYPES = ["给动词", "给名词", "给形容词", "给副词", "无提示词"];
/**
 * 功能词清单（虚词）。
 *
 * 高考语法填空里，无提示词的空只能考功能词——它们的语法位置本身就限定了答案，
 * 不依赖上下文，所以任何一套卷子都能推出唯一答案。实词与各类分词只能出现在
 * 有提示词的空里（那才需要词性转换）。
 */
export const FUNCTION_WORDS = new Set([
  // 冠词
  "a", "an", "the",
  // 介词
  "in", "on", "at", "of", "to", "for", "with", "from", "by", "about",
  "into", "onto", "upon", "over", "under", "through", "across", "against",
  "among", "amongst", "beside", "besides", "between", "beyond", "during",
  "except", "inside", "outside", "since", "till", "until", "within", "without",
  "like", "near", "off", "out", "up", "down", "via", "per",
  // 连词
  "and", "but", "or", "nor", "so", "yet", "while", "although", "though",
  "because", "since", "unless", "if", "as", "than", "when", "where", "whether",
  // 关系副词
  "where", "when", "why",
  // 代词
  "it", "its", "they", "them", "their", "theirs", "he", "him", "his", "she",
  "her", "hers", "we", "us", "our", "ours", "this", "that", "these", "those",
  "one", "ones", "oneself", "what", "which", "who", "whom", "whose",
  // be 动词
  "is", "are", "was", "were", "be", "been", "being", "am",
  // 助动词
  "do", "does", "did", "has", "have", "had", "will", "would", "shall",
  "can", "could", "may", "might", "must", "should", "ought",
  // 情态动词
  "may", "might", "must", "should", "shall", "can", "could", "will", "would",
]);
/** 空格占位符字面量 */
export const BLANK_PLACEHOLDER = "______";
/**
 * 试卷名「由脚本自动清空」的标记。
 *
 * 导入成功后会置为这个值——那时 textarea 被清空、卷名框也清空，
 * 但卡片要保持可见，方便接着录下一卷。
 *
 * 必须与「用户自己清空」区分：这两种情况若一视同仁，导入一卷之后，
 * 下一张卷子粘贴进来时卷名框不会自动填，用户得手敲一遍，
 * 与「粘完就能看到卷名」的设计相悖。
 */
export const IMPORTED_MARK = "__imported__";
/**
 * 容错解析时用来标记「原句里的裸引号」的内部占位符。
 *
 * 选了一个不会出现在英文句子里的字符（`￿` + 私用区字符），
 * 保证不会与任何真实文本冲突，也便于在 repairSentences 里一次性配对替换。
 */
export const QUOTE_PLACEHOLDER_MARK = "\uE000";
