/**
 * AI 助手标签页。
 *
 * AI 助手标签页的全部交互（本文件不使用任何框架，以原生模块直接加载）：
 * - 生成「复制给 AI 的提示词」并按需复制（内容与原版 buildPrompt 逐字一致）
 * - 解析粘贴回来的 JSON、查出字典里没有的标签、校验后增量入库
 *
 * 与主脚本（assets/js/admin.js）的接口约定：
 *   admin.js 通过 `import { setupAiAssistant } from "./admin-ai.js"` 直接调用，
 *   不依赖 script 标签顺序（模块依赖图保证本文件先求值）。
 *   setupAiAssistant({ tagDictionary, onAppend, onCreateTags, onNotice })
 *   - tagDictionary：{ schemaVersion, tags: [{ id, name, parentId, color, isActive }] }
 *   - papers：库里已有的试卷 [{id, name, questionCount}]，用于提示同名归卷
 *   - onAppend(questions, source)：把校验通过的题目批量入库（返回 Promise）
 *   - onCreateTags(names)：创建字典里没有的新标签
 *   - onNotice(message)：在页面顶部显示一条提示
 *
 * 原版把「成功导入 / 已创建标签 / 复制失败」这类提示放在组件内部的 notice 状态里，
 * 迁移后统一交给页面顶部的 onNotice（与 Admin 页其它标签页的提示同一处），
 * 因此本文件不再自渲染提示条。
 *
 * 动态文本一律先经 escapeHtml 再写入 DOM。
 */

import { notifyError, clearFeedback } from "./feedback.js";


/** 全部合法的提示词类型 */
const HINT_TYPES = ["给动词", "给名词", "给形容词", "给副词", "无提示词"];

/**
 * 功能词清单（虚词）。
 *
 * 高考语法填空里，无提示词的空只能考功能词——它们的语法位置本身就限定了答案，
 * 不依赖上下文，所以任何一套卷子都能推出唯一答案。实词与各类分词只能出现在
 * 有提示词的空里（那才需要词性转换）。
 */
const FUNCTION_WORDS = new Set([
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
function allTagsUnder(tags, parentMap, parentId) {
  if (tags.length === 0) return false;
  return tags.every((tagId) => tagId === parentId || parentMap.get(tagId) === parentId);
}

/** 空格占位符字面量 */
const BLANK_PLACEHOLDER = "______";

/**
 * 容错解析时用来标记「原句里的裸引号」的内部占位符。
 *
 * 选了一个不会出现在英文句子里的字符（`￿` + 私用区字符），
 * 保证不会与任何真实文本冲突，也便于在 repairSentences 里一次性配对替换。
 */
const QUOTE_PLACEHOLDER_MARK = "\uE000";

/**
 * 规范化原句占位符（与 admin.js 的同名函数一致）：
 * 全角下划线、中文破折号、3+ 连续下划线都统一成标准 "______"，
 * 避免 AI 返回或粘贴内容里的字符差异导致校验误报。
 */
function normalizeSentence(text) {
  return String(text)
    .replace(/＿/g, "_")
    .replace(/[—–]{2,}/g, BLANK_PLACEHOLDER)
    .replace(/_{3,}/g, BLANK_PLACEHOLDER);
}

/** HTML 转义：所有动态文本都要经过它 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 生成给外部 AI 用的提示词。
 *
 * 适用场景：把一整段真题（可能连着多道题、带题号 56~65）
 * 连同卷子封面一起发给 AI，由 AI 按句切分成独立题目，
 * 并从封面读出试卷来源，整批只写一次（顶层 source 字段）。
 *
 * 注意：这段文本直接决定 AI 返回的 JSON 能否被解析与正确入库，
 * 修改后必须人工通读一遍（对照提示词里的校验规则），
 * 并跑一次 ui-test 的 AI 页签用例。source 的示例值要与真实填写格式一致、且格式统一，
 * 否则 AI 会照抄示例、不读封面。
 */
function buildPrompt(tagDictionary) {
  const activeTags = tagDictionary.tags.filter((tag) => tag.isActive);

  return `你是一位熟悉高考英语命题规律的特级教师。我会把试卷的封面图和题目页图片一起发给你，需要你把题目拆解成结构化的 JSON，用于我的题库系统。

## 第一步：先做格式转换，再考虑内容

**下面三件事是硬约束，做错任何一件，我这边整批题目都会因为格式问题导入失败。**
请在读完试卷后，先在脑子里把原文过一遍这三步，再开始拆解。

### 1-1题号必须替换成空格

试卷上的题号（56、57、58……）**不是内容**，必须删除，并在原位写成 6 个下划线。

- 错：The 56 (fashion) sportswear, ... drew many praises, 57 people curious...
- 对：The ______ (fashion) sportswear, ... drew many praises, ______ people curious...

每一个题号都要替换，**不能漏掉任何一个**。替换完请逐句数一遍：
这句里应该有几个空格，句中就必须有几个______。

### 1-2 原句里的引号必须换成中文引号

英文原句常有对话引语或引号强调，例如试卷原文是：

    "New Chinese Style" reflects a shift in mindset...
    "It's not simply a fashion trend," Yang said.

这些英文直引号（"）会**提前结束 JSON 字符串，让整批数据作废**。必须换成中文引号，
成对使用，前一个 “ 后一个 ”：

- 错："originalSentence": ""New Chinese Style" reflects..."
- 对："originalSentence": "“New Chinese Style” reflects..."

中文引号在 JSON 里不需要转义，所以这是最安全的写法。其他标点（逗号、句号、
括号、破折号）照原样保留。

### 1-3 JSON 自身的三条硬规则

- 字符串内部不能出现真实换行，要换行就写\\n 两个字符
- 最后一个元素后面**不能有多余逗号**（JSON 不允许尾逗号）
- 不要用 markdown 代码块包裹（不要出现 \`\`\`json 这种标记），不要输出任何解释文字

完成这三步之后，再按下面的规则拆解内容。

## 数据结构定义

Blank（一个空格）：

interface Blank {
  blankIndex: number;      // 本句内第几个空，从 1 开始，连续递增
  answer: string[];        // 可接受的答案集合，学生答对任意一个即算对
  hintWord: string | null; // 提示词原文；该空无提示词时必须是 null
  hintType: "${HINT_TYPES.join('" | "')}";   // 提示词类型
  tagIds: string[];        // 关联的知识点标签 id，必须取自下方标签清单
  trapAnalysis: string;    // 命题意图与判断依据，说清要点即可，不要求凑字数
}

Question（一道题，即一个句子）：

interface Question {
  originalSentence: string;   // 该句原文，空格用 6 个下划线 ______ 表示
  blanks: Blank[];
}

注意：**不要输出 id 字段**。题目编号由我的系统在你返回之后自行生成，
你不需要知道、也不要猜测现有题库里已有哪些编号。

格式要求见开头的「第一步」，务必先按那里做完三步再拆解。

## 可用标签清单（tagIds 只能从中选择）

${activeTags.map((tag) => `- ${tag.id} ${tag.name}`).join("\n")}

## 核心要求：按句切分，但不能删掉答题依据

### 最重要的原则
**切分的唯一标准是：保留能让学生做出这道题的全部信息。**

- 如果一个空的答案能从本句直接推出，这一空所在的句子可以独立成题。
- 如果答案需要看前后文才能确定，**必须把相关的句子一起带上**，宁可多带一句，
  也绝不能因为切分导致学生看不到依据。
- 上下文宁多勿少。学生因为看不到线索而做错，比多做一遍上下文题更糟糕。

### 切分规则
1. **默认以句号（. ? !）为准**，一个句子对应一条 Question。
2. **一句话里有几个空，就在这条 Question 里放几个空**，不要把一句话拆成多道题。
   同一句话的空必须连在一起，学生要在一个语境里把它们都填出来。
3. 遇到下列情况时，**向上合并相邻句子**，把线索带进来：
   - 空格在句末，而答案线索在下一句
   - 空格需要靠前文的指代、定义、同位语才能确定
   - 一句话太短（如 "stands ______ one of China's most..."），脱离上下文做不出来
4. 反过来，如果某句是纯粹的背景铺垫、不含任何空，也不需要为它单独输出一条。
   **没有空的句子不要单独作为一道题输出。**
5. blanks 数组只包含**这条 Question 内的空**，句中几个就写几个。
6. 题号（如 56、57）只是标记题序，**不要写进 originalSentence**。

判断标准很简单：**把你输出的这句话单独拿出来给学生看，他能做对吗？** 能，就独立成题；不能，就带上必要的上下文。

## 空格与提示词的写法（严格遵守）

排版上，有提示词的空和没有提示词的空**长得很不一样**：

- **有提示词**：空格后面紧跟括号，括号里是提示词原文
  例如：\`Hongshan Culture is ______ (unique) characterized by\`
  → hintWord 填 "unique"，hintType 填"给形容词"或对应的类型

- **无提示词**：光一个空格，后面什么都没有
  例如：\`flourishing roughly from 4700 to 2900 BCE in ______ is now\`
  → hintWord 必须是 null，hintType 填"无提示词"

所以：
- 句子里空后面**有括号**，hintWord 就填括号里的内容
- 句子里空后面**没有括号**，hintWord 必须是 null，不要自己编一个提示词出来
- 括号里的提示词要照抄，包括中文标注（如「礼仪器」的 \`(ritual (礼仪器))\` 要完整保留）

## 「无提示词」是高考语法填空的固定题型（极重要）

高考语法填空的空格按提示方式分成两类：

- **有提示词的空**：括号里已给出原词，学生只需做**词性转换或形式变化**。
- **无提示词的空**：不给任何提示，学生必须**仅凭语法位置和上下文**推出唯一答案。

所以无提示词的空，答案只能是**功能词**（也叫虚词）。它们在句中的位置本身就限定了答案，
不依赖上下文，所以任何一套卷子都能推出唯一答案。

**功能词只有这些**（对照检查，答案不在表内就说明这道空不该设成无提示词）：

| 类别 | 可填内容 |
|---|---|
| 冠词 | a、an、the |
| 介词 | in、on、at、of、for、with、to、from、by、about 等 |
| 连词 | and、but、or、so、yet、for、nor |
| 关系副词 | where、when、why |
| 代词 | it、they、them、its、their 等 |
| 助动词与be 动词 | is、are、was、were、do、does、did、has、have、had、will、would、can、could 等 |
| 情态动词 | may、might、must、should、shall |

**不属于功能词的一律不能填进无提示词的空**：实词（动词、名词、形容词、副词）、
各类分词（doing / done / to do）。比如 making、viewing、definition、simply
都只能出现在**有提示词**的空里。

由此产生三条要求：

1. **answer 必须是功能词**。如果某个空只能靠语义猜测、需要多种说法都成立，
   那它不是合格的填空，不要把它当作无提示词的空输出。
2. **tagIds 必须从「无提示词」这个分类下的子标签里选**（冠词、介词、连词、
   关系副词等），不要挂到「动词」「名词」这类需要词性转换的分类下。
3. **不要给无提示词的空编造 hintWord**。原卷没提示就是没提示。

自检方法：把答案换成另一个词，句子还成立、还会是原卷答案吗？
如果换一个也说得通，它就不该出现在无提示词的位置上。

## 输出要求

1. 只输出一个 JSON 数组，不要输出任何解释文字，不要用 markdown 代码块包裹。
   格式细节见上文「JSON 格式要求」，尤其是**原句里的引号必须换成中文引号**。
2. 每道题都要写 trapAnalysis，说清两件事即可：命题人为什么这么设计、正确的判断依据是什么。
   只写正确的形式与依据，不要把错误的写法或错误选项列出来（展示错误形式会误导学生）。
   写具体、写到点子上即可，不要为凑字数重复或编造内容。
3. originalSentence 中的空格数量必须与 blanks 数组长度严格相等。
4. blanks[].blankIndex 从 1 开始连续递增，与句中空格的出现顺序一一对应。
5. answer 只收录结构上真正成立的答案，不要塞入冗余或凑数选项。
   每个词按标准拼写和大小写书写。
6. 注意原文中还有中文注释（如"新石器""礼仪器"），这些是原卷的一部分，**原样保留在 originalSentence 里**。
7. **不要输出 id 字段**。

## 试卷来源：整批只给一次，放在数组最前面

一次粘贴就是**一整张卷子**，所有题目来自同一张卷。所以来源不是每道题各写一遍，
而是在数组**第一个元素之前**单独给一次。

返回格式（注意最前面那个 source 和 questions）：

    {
      "source": "某某中学2026-2027学年高三上学期10月阶段检测试题",
      "questions": [
        { "originalSentence": "...", "blanks": [ ... ] },
        { "originalSentence": "...", "blanks": [ ... ] }
      ]
    }

**每道题里不要再写 source 字段**，写了我也会忽略。

### 来源怎么写

从封面图读出卷子信息，**写成一行完整、格式统一的名称**。统一格式是：

    学校 + 年学年学期 + 考试名称 + 题型

对照例子（请照这个格式写，不要自由发挥）：

- 某某中学2026-2027学年高三上学期10月阶段检测试题
- 某某中学2026-2027学年高三上学期期中考试英语试题
- 2024年全国甲卷·语法填空

规则：

- **同一场考试只写一次**，不要每道题重复
- **格式与该场考试保持一致**：同校同期的卷子，写法要统一
  （都用「2026-2027学年」而不是有的写「2026-2027 学年」、有的写「26-27学年」）
- 考试名称用卷面原文，不要自行改写（「适应性练习」就不要写成「适应性训练」）
- 封面能辨认出多少信息就写多完整；只能看出考试名称时也照实写
- 只有封面确实看不清、或我没有提供封面图时，才写 "AI 生成"

## 词形转换必须逐词核实（重要）

tagIds 的判定规则已经按类别分好标签，**不要凭语感随意归类**。以下规则必须严格遵守：

- 形容词变副词，先判断后缀再下结论：
  - 一般情况直接加 ly：quick → quickly
  - 以 -ic 结尾：把 ic 替换为 ically，即"ic 变 ally"型（标签「形容词变副词-ic变ally」）。
    例：energetic → energetically、basic → basically、tragic → tragically。
    注意 public 是例外，变 publicly。
  - 以 -le 结尾：去 e 加 y（标签「形容词变副词-le变ly」）。例：simple → simply。
  - 以 -y 结尾且 y 前为辅音：y 变 i 加 ly（标签「形容词变副词-y变ily」）。例：happy → happily。
  - 只有真正「直接加 ly」才用「形容词变副词-直接加ly」标签。
- 名词变形容词与形容词变名词要注意方向，选对标签。
- trapAnalysis 里如果写了某个词形变化，必须与实际拼写一致；
  写错规则的解析比不写更糟——会直接教坏学生。
- 如果你对某个词的变形没有把握，就在该空的 trapAnalysis 里写明存在多种可能，
  而不是编造一条看似合理的规则。

## 示例输出格式

假设试卷上有这样一段（题号 56、57 原样照抄试卷）：

  “Among the foundational cornerstones of early Chinese civilization, Hongshan Culture holds a place
   of profound significance. Hongshan Culture, flourishing roughly from 4700 to 2900 BCE in 56 is now
   Liaoning Province and neighboring regions, stands 57 one of China's most remarkable Neolithic
   (新石器) cultures.”

对照一下原句和输出，就可以看清题号是怎么处理的：

- 卷面原文：in **56** is now Liaoning Province
- 输出内容：in **______** is now Liaoning Province

**题号 56 换成空格 ______，题号 57 同样换成 ______。** 题号本身不出现在任何字段里。

应该输出**两条**（注意最前面那个 source 只写一次）：

{
  "source": "某某中学2026-2027学年高三上学期10月阶段检测试题",
  "questions": [
    {
      "originalSentence": "Hongshan Culture, flourishing roughly from 4700 to 2900 BCE in ______ is now Liaoning Province and neighboring regions, stands ______ one of China's most remarkable Neolithic (新石器) cultures.",
      "blanks": [
        {
          "blankIndex": 1,
          "answer": ["Liaoning"],
          "hintWord": null,
          "hintType": "无提示词",
          "tagIds": ["t_002", "t_013"],
          "trapAnalysis": "空格作 in 的宾语，填红山文化遗址所在省份。后文 is now Liaoning Province 给出提示，考查地理常识与 archaeological site 的对应。"
        },
        {
          "blankIndex": 2,
          "answer": ["as"],
          "hintWord": null,
          "hintType": "无提示词",
          "tagIds": ["t_005", "t_029"],
          "trapAnalysis": "空格与后文 one of 构成 as one of the most... 固定结构，as 在此作介词，与 one of 搭配使用。"
        }
      ]
    },
    {
      "originalSentence": "The most famous site, Niuheliang, ______ (feature) a magnificent temple and rubble-mound stone tombs.",
      "blanks": [
        {
          "blankIndex": 1,
          "answer": ["features"],
          "hintWord": "feature",
          "hintType": "给动词",
          "tagIds": ["t_001", "t_012"],
          "trapAnalysis": "空格作主句谓语，主语 Niuheliang 是第三人称单数，故用 features。后文 a temple 是宾语，说明主语主动发掘出该遗址，用主动语态。"
        }
      ]
    }
  ]
}

若试卷里有带引号的句子，例如原文是 “It's not simply a fashion trend,” Yang said.
则原句写成 “It's not simply a fashion trend,” Yang said.——用中文引号 “ ”，
不要用英文直引号 "。

注意示例中：
- **每条都没有 id 字段**，编号由系统生成
- **第 1 条里的两个空在同一句话里，就放在一起**，学生要在一个语境里同时填出来，
  没有拆成两道题
- 句子前面的 "Among the foundational cornerstones of early Chinese civilization, Hongshan Culture
  holds a place of profound significance." 这句没有空，**不单独输出成一道题**，
  它只是背景铺垫
- 第 2 条是一个独立的句子（有自己的主语谓语宾语），能单独做出来，所以单独成题
- 两个空后面都没有括号，所以 hintWord 都是 null
- 原文的中文注释「(新石器)」原样保留了
- 题号 56、57 没有出现在任何字段里
- **source 写在 questions 前面，整批只写一次**（本示例假设封面是某某中学的
  月考试卷）；两条题里都没有再写 source

## 需要拆解的内容

（把封面图和题目页图片一起发给我即可）`;
}

/** 把标签 id 或标签名解析成字典中的标签对象 */
function resolveTag(tagDictionary, raw) {
  const key = raw.trim();
  if (!key) return null;
  return (
    tagDictionary.tags.find((tag) => tag.id === key) ??
    tagDictionary.tags.find((tag) => tag.name === key) ??
    null
  );
}

/** 去掉可能存在的 markdown 代码块包裹 */
function cleanJson(text) {
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
function repairSentences(questions) {
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
    sentence = sentence.replace(/(\s)(\d{2,3})(?=\s+[a-zA-Z])/g, (all, space, digits) => {
      if (!isQuestionNumber(digits)) return all;
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
 * 生成题目 id。
 *
 * 外部 AI 不知道题库里已有哪些编号，每次都会从 q_0001 重新数，
 * 所以 id 一律由本系统生成，不采信 AI 返回的值。
 *
 * 格式与 admin.js 的手动精录保持一致：q_{时间戳36进制}，
 * 末尾再拼一段随机数以防同一批内多次调用撞号。
 */
function generateQuestionId() {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
function explainJsonError(text, error, lines) {
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

/** 取每段文本里占位符的起始下标（迁移自原校验实现） */
function findPlaceholderPositions(sentence) {
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
  const found = [];
  const pattern = /(?<![\w-])(\d{2,3})(?![\w-])/g;
  let match;
  while ((match = pattern.exec(sentence)) !== null) {
    const value = Number(match[1]);
    if (value >= 50 && value <= 99) found.push(match[1]);
  }
  return found;
}

/** 校验一道题目是否合法（迁移自原校验实现 的 validateQuestion） */
function validateQuestion(question, tagDictionary) {
  const errors = [];
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
function validateQuestions(questions, tagDictionary) {
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

/* ------------------------------------------------------------------ */
/* 组件状态与 DOM 引用                                                     */
/* ------------------------------------------------------------------ */

/** 标签字典，由 setupAiAssistant 注入；主脚本刷新字典后可再次调用以更新 */
let dictionary = { schemaVersion: 1, tags: [] };

/** 主脚本回调（每次 setup 用最新传入值覆盖） */
let hooks = {
  onAppend: () => {},
  onCreateTags: () => {},
  onNotice: () => {},
};

/** 页面元素引用 */
let els = null;

/** 是否已绑定事件（setup 可能被主脚本多次调用，避免重复绑定） */
let bound = false;

let copyTimer = null;
/** 待确认创建的标签 */
let pending = null;

/**
 * 上次由脚本自动填入的试卷名；用于判断用户有没有手动改过。
 *
 * 导入成功后会置为 IMPORTED_MARK——那时 textarea 被清空、卷名框也清空，
 * 但卡片要保持可见，方便接着录下一卷。
 */
const IMPORTED_MARK = "__imported__";
let lastAutoFilledName = "";

/** 库里已有的试卷（由 setupAiAssistant 注入），用于提示同名归卷 */
let allPapers = [];
/** 本次导入所做的自动修复说明，导入成功后一并告知用户 */
let pendingRepairs = [];
/** 当前解析出的、字典里没有的标签 */
let missingTags = [];
/** 解析中标志，防止连点重复入库 */
let submitting = false;
/** 是否刚复制过提示词 */
let copied = false;

function activeTagCount() {
  return dictionary.tags.filter((tag) => tag.isActive).length;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/** 复制按钮文案（copied 为真时显示「已复制，去问 AI」） */
function renderCopyButton() {
  if (els.copyBtn) els.copyBtn.textContent = copied ? "已复制，去问 AI" : "复制提示词";
}

/** 「字典里没有的标签」提示块 */
function renderMissing() {
  if (!els.missing) return;
  els.missing.hidden = missingTags.length === 0;
  if (els.missingList) {
    els.missingList.innerHTML = missingTags
      .map((tag) => `<span class="ml-1 rounded bg-warning/20 px-1.5 py-0.5">${escapeHtml(tag)}</span>`)
      .join("");
  }
}

/** 校验错误块（原版按 "\n" 拆成多行 li） */
function renderError(message) {
  if (!els.error) return;
  els.error.hidden = false;
  els.error.innerHTML = message
    .split("\n")
    .map((line) => `<li>· ${escapeHtml(line)}</li>`)
    .join("");
}

/** 清掉错误块（对应原版 setParseError("")） */
function clearError() {
  if (!els.error) return;
  els.error.hidden = true;
  els.error.innerHTML = "";
}

/** 提交按钮文案与禁用态 */
function renderSubmitting() {
  if (!els.submitBtn) return;
  els.submitBtn.textContent = submitting ? "导入中…" : "确认导入这一卷";
  els.submitBtn.disabled = submitting;
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

/** 复制提示词到剪贴板，不展示内容 */
async function handleCopy() {
  const promptText = buildPrompt(dictionary);
  try {
    await navigator.clipboard.writeText(promptText);
    copied = true;
    renderCopyButton();
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied = false;
      copyTimer = null;
      renderCopyButton();
    }, 2000);
  } catch {
    // 剪贴板不可用时（缺少 HTTPS 等），给出可手动复制的降级方案
    hooks.onNotice("当前环境不支持一键复制，请用「手动复制提示词」按钮在弹窗中选取。");
    window.prompt("请手动复制以下提示词：", promptText);
  }
}

/** 「手动复制」：在弹窗中选取（与 navigator.clipboard 不可用时的降级入口一致） */
function handleManualCopy() {
  window.prompt("请手动复制以下提示词：", buildPrompt(dictionary));
}

/** 解析粘贴进来的 JSON 并校验 */
async function handleParse() {
  if (submitting) return;

  clearError();
  missingTags = [];
  renderMissing();

  if (els.textarea.value.trim() === "") {
    renderError("请先粘贴 AI 返回的 JSON。");
    return;
  }

  submitting = true;
  renderSubmitting();
  try {
    parseAndImport();
  } finally {
    submitting = false;
    renderSubmitting();
  }
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
function parseJsonLoose(text) {
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
 * 拆出「题目列表」与「本批的试卷名」。
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
function splitBatch(parsed) {
  // 新格式：顶层有 questions
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.questions)
  ) {
    return {
      list: parsed.questions,
      source: typeof parsed.source === "string" ? parsed.source.trim() : "",
      perItem: false,
    };
  }

  if (Array.isArray(parsed)) {
    const first = parsed.find((item) => item && typeof item === "object" && !Array.isArray(item));
    // 老写法：source 写在每道题里
    const perItem = first && typeof first.source === "string";
    const source = perItem ? first.source.trim() : "";
    return { list: parsed, source, perItem: Boolean(perItem) };
  }

  // 误粘了单个对象
  if (parsed && typeof parsed === "object") {
    return { list: [parsed], source: typeof parsed.source === "string" ? parsed.source.trim() : "", perItem: true };
  }

  return { list: [], source: "", perItem: false };
}

/** 简易防抖：粘贴大段 JSON 时不必每敲一下就解析 */
function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** 试卷名是否与库里已有的某张卷同名（同名即同一张卷，会归到一起） */
function findPaperByName(name) {
  const target = String(name ?? "").trim();
  if (target === "") return null;
  return allPapers.find((paper) => String(paper.name ?? "").trim() === target) ?? null;
}

/**
 * 试卷名下方的说明文字。
 *
 * 说清三件事，用户不用猜：
 *   · 这个名字从哪来（AI 读到 / 你手填的）
 *   · 与库里的哪张卷相同（同名会自动归到那张卷，而不是新建）
 *   · 改这个名字会新建另一张卷
 */
function updatePaperHint(autoFilled) {
  if (!els.paperHint) return;
  const name = (els.source?.value ?? "").trim();

  if (name === "") {
    els.paperHint.textContent = "试卷名是必填项。同名会自动归到库里已有的那张卷，不会重复建卷。";
    els.paperHint.className = "mt-2 text-xs leading-5 text-muted";
    return;
  }

  const existing = findPaperByName(name);
  if (existing) {
    const count = Number(existing.questionCount ?? 0);
    const countText = count > 0 ? "当前 " + count + " 道" : "当前 0 道";
    els.paperHint.textContent =
      "库里已有同名试卷「" + name + "」，这批题目会归到它下面（" + countText + "）。换个名字则会新建一张卷。";
    els.paperHint.className = "mt-2 text-xs leading-5 text-muted";
    return;
  }

  els.paperHint.textContent = autoFilled
    ? "已按 AI 从封面读出的名称填好，可直接改。确认无误后点下方按钮导入。"
    : "将新建一张试卷，题目会归到这张新卷下。确认名称无误再导入。";
  els.paperHint.className = "mt-2 text-xs leading-5 text-muted";
}

/**
 * 粘贴后预读卷名：能解析出source 就自动填进输入框。
 *
 * 只在「输入框还是空的」或「值与上次自动填的一模一样」时覆盖——
 * 用户已经手动改过的名字不能被后续粘贴冲掉。
 */
function previewPaperName() {
  const raw = els.textarea?.value ?? "";
  if (raw.trim() === "") {
    // 导入成功后我们主动清空 textarea 让用户接着录下一卷，
    // 这时保留卡片（卷名框可见），只把提示改成「已清空，可继续粘贴」
    if (lastAutoFilledName === IMPORTED_MARK) {
      if (els.paper) els.paper.hidden = false;
      return;
    }
    if (els.paper) els.paper.hidden = true;
    return;
  }

  const result = parseJsonLoose(cleanJson(raw));
  if (result === null) return; // 还没粘完，等下一次输入

  const batch = splitBatch(result.value);
  if (!els.paper) return;

  if (batch.source !== "") {
    const current = (els.source?.value ?? "").trim();
    // 只在「还是上次自动填的那个」时覆盖：
    // 用户手动改过的名字不能被后续粘贴冲掉。
    // current === "" 的情况交给导入时提示「请先填写试卷名」，
    // 不在这里替他填——主动清空就是想自己写。
    if (current === lastAutoFilledName) {
      els.source.value = batch.source;
      lastAutoFilledName = batch.source;
    } else if (current === "") {
      // 输入框空着：仍然把 AI 读到的名字显示出来供参考，但不写进输入框，
      // 用户复制过去或自己敲
      if (els.paperHint) {
        els.paperHint.textContent =
          "AI 读到「" + batch.source + "」。请填入下面的试卷名框，确认或修改后再导入。";
      }
      els.paper.hidden = false;
      return;
    }
    // 输入框里的名字（可能已被用户改过）与库里的卷比对，
    // 不管它是不是 AI 给的那个，都要说清会不会归到已有的卷
    updatePaperHint(current === batch.source);
  } else {
    updatePaperHint(false);
  }
  els.paper.hidden = false;
}

/** 实际解析与导入流程 */
function parseAndImport() {
  const raw = els.textarea.value;
  const cleaned = cleanJson(raw);
  const repairs = [];

  const result = parseJsonLoose(cleaned);
  if (result === null) {
    let message;
    try {
      JSON.parse(cleaned);
      message = "";
    } catch (error) {
      message = explainJsonError(cleaned, error, cleaned.split("\n"));
    }
    renderError(message);
    return;
  }
  if (result.repaired) {
    repairs.push("JSON 引号转义有误（多半是原句里的引号），已自动修复");
  }

  const batch = splitBatch(result.value);
  const list = batch.list;

  if (batch.perItem && batch.source) {
    repairs.push("source 写在每道题里，已取第一条作为本卷的试卷名");
  }

  // 数组里混入非对象（null、数字、字符串）时后续会崩，先拦下来给出可读的提示
  const badIndex = list.findIndex(
    (item) => item === null || typeof item !== "object" || Array.isArray(item)
  );
  if (badIndex !== -1) {
    renderError(
      `第 ${badIndex + 1} 条不是题目对象。请确认粘贴的是一个 JSON 数组，且数组里每一项都是 { } 形式的对象。`
    );
    return;
  }

  // 修正 AI 最容易犯的两类错误：题号被当成空格、原句里的英文直引号。
  // 放在解析之后（引号不修就没法解析）、校验之前（校验需要正确的空格数）。
  repairs.push(...repairSentences(list));

  // 再规范化占位符（全角下划线 / 中文破折号 / 数量不为 6），
  // 保证后续校验与入库都使用标准格式
  list.forEach((question) => {
    if (question && typeof question.originalSentence === "string") {
      question.originalSentence = normalizeSentence(question.originalSentence);
    }
  });

  pendingRepairs = repairs;

  // 找出字典里不存在的标签，交给用户确认是否创建
  const unknown = new Set();
  list.forEach((question) => {
    question.blanks?.forEach((blank) => {
      (blank.tagIds ?? []).forEach((tagId) => {
        if (!resolveTag(dictionary, tagId)) unknown.add(tagId);
      });
    });
  });

  if (unknown.size > 0) {
    missingTags = [...unknown];
    renderMissing();
    pending = list;
    return;
  }

  runImport(list);
}

/** 正式校验并增量入库 */
function runImport(list) {
  const { allErrors } = validateQuestions(list, dictionary);

  if (allErrors.length > 0) {
    // 修复：原先只渲染了标题行，allErrors 从未拼进去，
    // 用户看到「共 3 处问题」却看不到是哪 3 处，无从修改
    renderError(`校验未通过，共 ${allErrors.length} 处问题，本次未导入：\n${allErrors.join("\n")}`);
    pending = list;
    return;
  }

  // 整批共用一个试卷名：用户在页面上确认/修改过的那个值。
  // 卷名为空不导入——「AI 生成」这种占位名会把题库塞满无意义的碎片卷。
  const finalSource = els.source.value.trim();
  if (finalSource === "") {
    renderError("请先填写试卷名");
    updatePaperHint(false);
    els.source?.focus();
    return;
  }

  const stamped = list.map((question) => ({
    ...question,
    // 编号一律由本系统生成，丢弃 AI 返回的 id（它无从得知题库现状）
    id: generateQuestionId(),
    // 同一批全部用这个卷名；AI 写在每道题里的 source 一律忽略
    source: finalSource,
    status: "unmastered",
    wrongCount: 0,
    createdAt: new Date().toISOString(),
  }));

  hooks.onAppend(stamped, finalSource);
  // 提示里的来源取实际写库的值，便于当即核对 AI 有没有读对封面信息
  const displaySource = stamped.length > 0 ? String(stamped[0].source ?? "").trim() : "";
  const repairText = pendingRepairs.length > 0 ? `（已自动修正：${pendingRepairs.join("；")}）` : "";
  hooks.onNotice(
    `成功导入 ${stamped.length} 道题目${displaySource ? `，来源：${displaySource}` : ""}${repairText}`
  );
  // 把这批题目所属的卷登记进本地列表。
  // allPapers 是页面加载时的快照，不更新的话「库里已有同名卷」的提示
  // 在导入后就没用了——刚建的卷查不到。
  const knownPaper = allPapers.find((paper) => String(paper.name ?? "").trim() === finalSource);
  if (!knownPaper) {
    allPapers = [{ id: "", name: finalSource, questionCount: stamped.length }, ...allPapers];
  } else {
    knownPaper.questionCount = Number(knownPaper.questionCount ?? 0) + stamped.length;
  }

  els.textarea.value = "";
  if (els.paper) els.paper.hidden = false; // 保留卡片，方便连续录下一卷时直接改名字
  lastAutoFilledName = IMPORTED_MARK;
  if (els.source) els.source.value = "";
  if (els.paperHint) {
    els.paperHint.textContent =
      "已导入 " + stamped.length + " 道题到「" + finalSource + "」。可继续粘贴下一张卷子的 JSON。";
  }
  pending = null;
  pendingRepairs = [];
}

/**
 * 确认创建新标签。
 * 新标签由主脚本写入字典，用户再点一次「确认导入这一卷」即可按新标签校验。
 */
function handleCreateMissing() {
  if (!pending) return;
  // 先取出名字：原版 setMissingTags([]) 是异步的，这里要保留同一份用于提示文案
  const names = missingTags.slice();
  hooks.onCreateTags(names);
  missingTags = [];
  renderMissing();
  pending = null;
  hooks.onNotice(`已创建标签：${names.join("、")}。请再次点击「确认导入这一卷」，本次将按新标签校验。`);
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 挂载 AI 助手标签页。主脚本在合适的时机调用（骨架已由 PHP 直出）。
 *
 * @param {object}   options
 * @param {object}   options.tagDictionary
 * @param {Function} options.onAppend
 * @param {Function} options.onCreateTags
 * @param {Function} options.onNotice
 */
export function setupAiAssistant({
  tagDictionary,
  papers,
  onAppend,
  onCreateTags,
  onNotice,
}) {
  const root = document.getElementById("admin-ai-root");
  if (!root) return;

  if (tagDictionary) dictionary = tagDictionary;
  // 已有试卷列表：用于提示「这个名字库里已经有了，会归到那张卷」
  if (Array.isArray(papers)) allPapers = papers;
  hooks = {
    onAppend: typeof onAppend === "function" ? onAppend : hooks.onAppend,
    onCreateTags: typeof onCreateTags === "function" ? onCreateTags : hooks.onCreateTags,
    onNotice: typeof onNotice === "function" ? onNotice : hooks.onNotice,
  };

  els = {
    root,
    count: root.querySelector("[data-tag-count]"),
    copyBtn: document.getElementById("admin-ai-copy"),
    manualBtn: document.getElementById("admin-ai-manual-copy"),
    source: document.getElementById("ai-source"),
    paper: document.getElementById("admin-ai-paper"),
    paperHint: document.getElementById("admin-ai-paper-hint"),
    textarea: document.getElementById("admin-ai-json"),
    missing: document.getElementById("admin-ai-missing"),
    missingList: document.getElementById("admin-ai-missing-list"),
    createTagsBtn: document.getElementById("admin-ai-create-tags"),
    error: document.getElementById("admin-ai-error"),
    submitBtn: document.getElementById("admin-ai-submit"),
  };

  // 提示词里会带上「当前 N 个标签」，字典变化时同步刷新
  if (els.count) els.count.textContent = String(activeTagCount());

  if (!bound) {
    bound = true;
    els.copyBtn?.addEventListener("click", () => void handleCopy());
    els.manualBtn?.addEventListener("click", handleManualCopy);
    els.createTagsBtn?.addEventListener("click", handleCreateMissing);
    els.submitBtn?.addEventListener("click", () => void handleParse());

    // 粘贴后立刻把卷名显示出来，用户在点导入前就能看到并改——
    // 不用等到点按钮才发现卷名不对
    els.textarea?.addEventListener("input", debounce(previewPaperName, 400));
    els.source?.addEventListener("input", () => updatePaperHint(false));
    window.addEventListener("beforeunload", () => {
      if (copyTimer !== null) window.clearTimeout(copyTimer);
    });
  }

  renderCopyButton();
  renderMissing();
  renderSubmitting();
}

// 兼容挂载：主脚本现走 import 调用；保留此全局入口便于控制台调试
// （注意：不要把它当作初始化依赖——曾因本文件未被加载导致面板静默失效）
window.setupAdminAi = setupAiAssistant;
