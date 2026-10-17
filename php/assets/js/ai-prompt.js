/**
 * 生成「复制给 AI 的提示词」。
 *
 * 单独成文件是因为它是一段**逐字校对过**的长文本（约 380 行），
 * 与解析、校验、渲染混在一起时，任何一次顺手编辑都可能改坏它，
 * 而且 review 时根本看不出来。
 *
 * ⚠️ 这段文本直接决定 AI 返回的 JSON 能否被解析与正确入库，
 * 修改后必须人工通读一遍（对照提示词里的校验规则），
 * 并跑一次 ui-test 的 AI 页签用例。source 的示例值要与真实填写格式一致、且格式统一，
 * 否则 AI 会照抄示例、不读封面。
 */

import { HINT_TYPES } from "./ai-constants.js";


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
export function buildPrompt(tagDictionary) {
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

顶层结构（passage 与 source、questions 平级）：

interface Batch {
  source: string;            // 试卷名，整批只给一次
  passage?: string;          // 整篇阅读的未挖空原文。一篇只给一次，放在**顶层**；
                              // 每道题里都不要重复写。单句题集合则整个省略这个字段。
  questions: Question[];     // 这一篇挖出来的若干道小题
}

Question（一道题，即一个句子；**不含 passage 字段**）：

interface Question {
  originalSentence: string;   // 挖空后的句子（含做出本题所必需的上下文句子）
  blanks: Blank[];
}

注意：**不要输出 id 字段**。题目编号由我的系统在你返回之后自行生成，
你不需要知道、也不要猜测现有题库里已有哪些编号。

格式要求见开头的「第一步」，务必先按那里做完三步再拆解。

## 可用标签清单（tagIds 只能从中选择）

${activeTags.map((tag) => `- ${tag.id} ${tag.name}`).join("\n")}

## 完整原文（passage）：一篇阅读挖多个空时必须给，**但只给一次**

如果这是「一篇阅读 / 一个大题挖多个空」的题型（高考短文填空就是这个形态）：

- ⚠️ passage 里**不能出现挖空**：不要写 ______，也不要把提示词括号带进去。
  它必须是**完完整整、一字不差**的原文（就像卷子上印的那样），
  错的题目标成 officially established in 2021，不要写成带空格和括号的形式。
- **把整篇未挖掉的原文放进**顶层**的 passage 字段**（与 source、questions 平级），
  每道题里**都不要写** passage。
  这样一眼就能看出「这一篇 = 一个 passage + N 道题」的对应关系，也不会出现
  「到底是第几道题带了原文」这种歧义。
- ⚠️ 同一篇的 10 道题重复贴 10 遍全文，会让输出膨胀十倍以上（一篇 500 词的短文
  能把 JSON 从 60 行撑到 600 行），既拖慢生成、又多花 token，还极易被长度限制截断。
  **这是硬性要求，不是建议。**
- 这一篇是单句题集合（每题独立、互不相关）时，**顶层不要写 passage**。
- 为什么必须给：代词指代、时态呼应、篇章逻辑这类空，只看挖出来的那一句判断不了，
  学生要能随时展开全文对照
- originalSentence 仍然只放「挖空后的本题句子 + 做出本题必需的上下文」——
  两者不重复也不矛盾：originalSentence 是考题，passage 是参照
- 单句题（一空一句、无需上下文）不要 passage；图片里只有单个句子时也留空

**正确写法**（同一篇 3 道题）：

    {
      "source": "某某中学2026-2027学年高三上学期10月阶段检测试题",
      "passage": "整篇未挖空的原文，只在这里出现这一次……",
      "questions": [
        { "originalSentence": "第 1 题……", "blanks": [...] },
        { "originalSentence": "第 2 题……", "blanks": [...] },
        { "originalSentence": "第 3 题……", "blanks": [...] }
      ]
    }

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
11. **不要输出 id 字段**。

## 这些地方最容易被搞错（都踩过，请逐条自查）

这一节不是补充说明，是**我这边会直接判定为错误**的地方：

1. **不要输出 markdown 代码块**。只输出 JSON 本体，第一个字符是左花括号或左方括号，最后一个是右花括号或右方括号。
2. **JSON 里的引号必须用中文引号**「」或英文弯引号，不要用英文直引号 " " ——
   原句里出现英文直引号会让 JSON 直接解析失败，整批导入不了。
   卷面里的引号一律转成中文引号保留。
3. **原句里挖空的数量必须与 blanks 数组长度完全相等**，一个不多一个不少。
   题号（如 56、57）要换成 ______，但**题号本身不出现在任何字段里**。
4. **passage 只能出现在顶层**（与 source、questions 平级），一篇只写一次，
   **每道题里都不要再写一遍**。
5. **顶层 passage 里不能有挖空，也不能带提示词括号** —— 它必须完完整整、一字不差地
   照抄卷面（例：officially established in 2021，不是带空格和括号的形式）。
6. **hintWord 为 null 时必须真的写 null**，不要写空字符串 ""，也不要省略这个字段。
7. **hintType 只能取这五个值之一**：${HINT_TYPES.join(" / ")}。不要自造。
8. **answer 必须是数组**，哪怕只有一个答案也要写成 ["as"] 这种形式，不要写裸字符串。
9. **不要输出 id 字段**，题目编号由我的系统在你返回之后自行生成。
10. **不要输出空题目**：数组里每一项都必须是一个完整可用的 Question 对象，
    不要放占位符、不要放空对象、不要放说明文字。
11. **答案与原文严格一致**：answer 里的大小写、拼写必须与 passage 里的用词完全相同
    （除非原卷就是错的，那就在 trapAnalysis 里指出来）。
12. 整批输出里**不要出现任何解释、开场白、结语**，也不要输出多个 JSON 块。

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
      "passage": "Among the foundational cornerstones of early Chinese civilization, Hongshan Culture holds a place of profound significance. Hongshan Culture, flourishing roughly from 4700 to 2900 BCE in Liaoning Province and neighboring regions, stands as one of China's most remarkable Neolithic (新石器) cultures. The most famous site, Niuheliang, features a magnificent temple and rubble-mound stone tombs.",
      "originalSentence": "Hongshan Culture, flourishing roughly from 4700 to 2900 BCE in ______ is now Liaoning Province and neighboring regions, stands ______ one of China's most remarkable Neolithic (新石器) cultures.",
      "blanks": [
        {
          "blankIndex": 1,
          "answer": ["Liaoning"],
          "hintWord": null,
          "hintType": "无提示词",
          "tagIds": ["t_002", "t_013"],
          "trapAnalysis": "空格作介词 in 的宾语，填红山文化遗址所在的省份。空格后紧跟 is now Liaoning Province，可由后文直接推出该省名。"
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
