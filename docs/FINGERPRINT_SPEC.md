# 题目指纹（去重判定）规格

> 用途：AI 录入前的重复检测（D5）。
> **这份规格是唯一真源**，PHP 与 JS 两端各实现一次，必须用第 4 节的同一组用例校验输出一致。

---

## 1. 设计前提：为什么不能直接比答案

一个空可以有多个答案（`answer` 是数组），而 AI 两次解析同一道题的输出**必然会有差异**。
实测 8 组形态，若用朴素的「数组序列相等」判断，其中 3 组会被误判成「不重复」而重复入库：

| 情形 | 旧答案 | 新答案 | 序列相等 | 应判为 |
|---|---|---|---|---|
| 顺序不同 | `["wrote","written"]` | `["written","wrote"]` | 异 | **重复** |
| 首尾空格 | `[" written "]` | `["written"]` | 异 | **重复** |
| 分隔符写法不同 | `["Liaoning, Jilin"]`（单个字符串） | `["Liaoning","Jilin"]` | 异 | **重复** |
| 多了一个同义词 | `["wrote"]` | `["wrote","written"]` | 异 | **重复** |
| 答案个数不同 | `["written"]` | `["written","wrote"]` | 异 | **重复** |
| 一个拆成两个 | `["Liaoning"]` | `["Liaoning","Liaoning Province"]` | 异 | **重复** |
| 大小写不同 | `["written"]` | `["Written"]` | 异 | **需人工判断** |
| 真的换了答案 | `["wrote"]` | `["given"]` | 异 | **不重复** |

最后一行是关键：**答案不一样时不能一律判重**。AI 修正了答案正是我们想要的结果（虽然按现有约定
不覆盖，但要让人看见）。所以规则要分两层。

---

## 2. 两层判定

### 第 1 层：题目指纹（判定「同一道题」）

指纹只由**原句**决定，与答案无关。

```
fingerprint = normalize_sentence(original_sentence)
```

`normalize_sentence()` 的归一化步骤（按顺序）：

1. 去首尾空白
2. 全角字符转半角（`Ａ→A`、`，→,`、`。→.`、`？→?`、`！→!`、`：→:`、`；→;`、`（→(`、`）→)`、`“”→"`、`‘’→'`、`　→空格`）
3. **去掉所有空白字符**（含半角空格、全角空格、制表符）
4. 去掉占位符的下划线（`______` → 空）—— 占位符本身不该参与身份判定
5. 英文标点归一：把 `,` `.` `?` `!` `;` `:` 全部视为等价（统一删除或统一转成同一符号）
6. **保留大小写**（判卷口径大小写敏感，`Written` 与 `written` 是不同答案；原句同理）

示例：

| 原句 | 归一化结果 |
|---|---|
| `The boy ______ there.` | `theboyther` |
| `The  boy______there．` | `theboythere` |
| `He has ______ finished it.` | `hehasfinishedit` |

> 为什么原句用「删除标点 + 保留大小写 + 删空白」而不是更激进的归一：
> 因为原句是**人工可读的**，激进归一会把不同的句子判成同一道题（比如 `a.b` 与 `ab`），
> 那会造成**漏报**（真重复被当成新题）。宁可多报也不漏报。

### 第 2 层：答案关系（判定「重复 / 疑似 / 不重复」）

在第 1 层命中（同原句）之后，再比答案。答案的归一化：

```
normalize_answer_list(answer[]) → Set<string>
```

步骤：

1. 每项 `trim()`
2. **按 `/`、`,`、`，` 再切一次**（前端 `splitAnswers` 的规则）—— 兼容 AI 偶尔把多答案写成一个字符串
3. 去掉空串
4. **去重**
5. **转小写后排序**（→ 规范形式）

排序是为了让 `["a","b"]` 与 `["b","a"]` 得到同一个规范形式。

然后分三种结果：

| 结果 | 条件 | 预览里的标记 | 默认勾选 |
|---|---|---|---|
| **完全重复** | 规范集合**相等** | 「已存在」（灰） | ❌ 不勾 |
| **疑似重复** | 规范集合**不相等但有交集**，或一方是另一方的真子集 | 「答案不同」（黄） | ❌ 不勾 |
| **不重复** | 规范集合**无交集** | 「新增」（绿） | ✅ 勾 |

**为什么「疑似重复」默认也不勾**：答案不一致可能是 AI 修错了，也可能是你上次录错了。
让默认行为是「不导入」，你想覆盖就手动勾上 —— **宁可少录，不要默默产生两条互相矛盾的题**。

---

## 3. 完整判定流程

```
① 归一化原句 → 指纹
② 在库内查同指纹的题目
   ├─ 无 → 标记「新增」，默认勾选
   └─ 有 → 进入第 3 步
③ 逐个候选比对答案集合
   ├─ 存在候选与本次规范集合相等   → 标记「已存在」，附该题 id/来源/录入时间
   ├─ 存在候选与本次有交集或子集关系 → 标记「答案不同」，附差异说明（库里有 X，本次给了 X、Y）
   └─ 所有候选都不相交            → 标记「新增」，默认勾选
```

**只在同原句的候选里比答案** —— 不比不同原句的题，答案撞车是巧合（不同句子完全可能有相同答案）。

**批内也要比**：一次粘 40 道题里若有两道同原句，后一道要标成与前一道重复，不能都勾上。

---

## 4. 测试用例（两端必须跑出相同结果）

标记：`DUP` = 完全重复 / `DIFF` = 答案不同（疑似）/ `NEW` = 新增

| # | 库中原句 | 库中答案 | 新原句 | 新答案 | 期望 |
|---|---|---|---|---|---|
| T1 | `The boy ______ there.` | `["is"]` | `The boy ______ there.` | `["is"]` | DUP |
| T2 | `The boy ______ there.` | `["is"]` | `The  boy______there．` | `["is"]` | DUP |
| T3 | `The boy ______ there.` | `["is"]` | `The boy ______ there.` | `["was"]` | DIFF |
| T4 | `The boy ______ there.` | `["wrote","written"]` | `The boy ______ there.` | `["written","wrote"]` | DUP |
| T5 | `The boy ______ there.` | `["wrote"]` | `The boy ______ there.` | `["wrote","written"]` | DIFF |
| T6 | `The boy ______ there.` | `["Liaoning, Jilin"]` | `The boy ______ there.` | `["Liaoning","Jilin"]` | DUP |
| T7 | `The boy ______ there.` | `["Liaoning"]` | `The boy ______ there.` | `["Liaoning","Liaoning Province"]` | DIFF |
| T8 | `The boy ______ there.` | `["is"]` | `He also ______ there.` | `["is"]` | NEW |
| T9 | （库空） | — | `The boy ______ there.` | `["is"]` | NEW |
| T10 | `The boy ______ there.` | `["is"]` | `The boy ______ there.` | `["IS"]` | DUP |
| T11 | 多空题 `A ______ B ______ C.` | `["x","y"]` | `A ______ B ______ C.` | `["y","x"]` | DUP |
| T12 | 多空题 `A ______ B ______ C.` | `["x","y"]` | `A ______ B ______ C.` | `["x","z"]` | DIFF |
| T13 | 多候选：一个完全相同、一个答案不同 | — | 同上 | `["wrote","written"]` | DUP（完全相同优先） |
| T14 | `The boy ______ there.` | `[" written "]` | `The boy ______ there.` | `["written"]` | DUP（trim 后一致） |
| T15 | `The boy ______ there.` | `["Liaoning，Jilin"]` | `The boy ______ there.` | `["Liaoning","Jilin"]` | DUP（全角逗号切分） |

以上共 15 组，收在 `php/tests/fingerprint-cases.json` 的 `cases`。

**边界用例（`edge_cases`，13 组）** 覆盖：空原句、空答案、候选缺字段、
答案含嵌套数组 / null / 重复项 / 斜杠分隔、纯空白原句、无下划线原句、
中英混排、emoji、超长原句（5000 词不崩溃）。

**T10 说明**：答案比对时**转小写**，所以 `IS` 与 `is` 判为重复。
这与「判卷大小写敏感」不冲突 —— 判卷口径与去重口径是两个目的：
判卷要严格（`is` 不能算 `IS`），去重要宽容（避免同一道题录两次）。

---

## 4.1 实现现状

| 文件 | 内容 | 状态 |
|---|---|---|
| `php/app/fingerprint.php` | PHP 侧实现：`sentence_fingerprint` / `answer_signature` / `explode_signature_separators` / `answer_relation` / `classify_duplicate` | ✅ 已实现 |
| `php/tests/fingerprint-cases.json` | **共享用例集**：7 组原句归一化 + 15 组主用例 + 13 组边界用例 | ✅ 已建 |
| `php/tests/fingerprint-test.php` | PHP 侧自测，跑共享用例集 | ✅ **35/35 通过** |
| `php/assets/js/fingerprint.js` | JS 侧实现 | ⏳ 第 1 期落地 |
| ui-test 中的指纹用例 | 跑同一份 JSON | ⏳ 待加 |

**实现过程中实测踩到的 4 个坑**（都已修，且每一条都补进了用例集）：

| # | 坑 | 症状 | 教训 |
|---|---|---|---|
| 1 | 正则里的 `/` 未转义 | `Unknown modifier` warning，**答案切分静默失效** | 分隔符本身在字符类里也要转义 |
| 2 | `classify_duplicate` 假设调用方已按指纹过滤 | T8「不同原句 + 相同答案」被误判成重复 | 判重的**前置条件要放在函数内部**，不信任调用方 |
| 3 | 中文标点「。」「、」漏在映射表外 | `他______去学校。` 与 `他______去学校` 判成两道题 | 映射表要覆盖**中英混排**，不能只做全角字母 |
| 4 | 非标量答案项直接 skip | 嵌套数组让签名变空集合，反而漏判重复 | 畸形输入要**摊平**而不是丢弃 |

第 4 条最值得记：**在判重逻辑里「跳过异常数据」是有害的** ——
它不会让程序报错，只会让该抓的重复悄悄溜过去，而且是静默的。

---

## 5. 口径一致性要求（硬约束）

PHP 与 JS 各实现一份 `fingerprint` 与 `answer_signature`。**任何一边改动，另一边必须同步**，
否则会出现「预览显示已存在 → 入库又变成新增」或反之。

防漂移做法：
- 在 `php/tests/fingerprint-cases.json` 放上表 13 组用例（库中的原句/答案、新原句/答案、期望标记）
- api-test 跑一遍 PHP 实现
- ui-test 跑一遍 JS 实现（通过 `page.evaluate` 调用页面里的函数）
- 两边结果必须与期望逐条一致

**不要试图让两端共用一份代码**（PHP 与浏览器无法共享运行时），靠**同一组用例 + 双向校验**来保证一致。

---

## 6. 实现要点

### PHP 侧（`php/app/fingerprint.php`）

```php
function normalize_sentence(string $sentence): string
function sentence_fingerprint(string $sentence): string
function answer_signature(array $answers): array   // 返回已排序去重的小写列表
function classify_duplicate(string $newSentence, array $newAnswers, array $candidates): array
    // 返回 ['state' => 'duplicate'|'diff'|'new', 'matched' => [...], 'hint' => '...']
function check_duplicates(array $incoming): array
    // 入库前批量查，返回每题的 state + matched 信息
```

### 查询方式

`questions` 表加一列存指纹，比每次 `LIKE` 全库扫描快得多、也更省事：

```sql
ALTER TABLE questions ADD COLUMN fingerprint TEXT;
CREATE INDEX idx_questions_fingerprint ON questions(fingerprint);
```

迁移时回填：`UPDATE questions SET fingerprint = <逐行计算>`。
**存的是指纹而不是原句** —— 指纹只是去重用的辅助索引，不参与任何展示。

> 注意：指纹是**辅助索引**，权威数据永远是 `original_sentence`。
> 将来若归一化规则调整，重算指纹即可，不影响题目本身。

### JS 侧（`php/assets/js/fingerprint.js`）

同样三个函数，用同一组用例校验。
注意 JS 的全角转半角用 `String.normalize('NFKC')` 可以覆盖大部分情况，
但 `NFKC` 会把 `①` 转成 `1`、把 `　` 转成空格 —— 需确认不会造成误判，
必要时改为显式字符映射表（与 PHP 保持一致）。
**建议两端都用显式映射表**，行为最可控。