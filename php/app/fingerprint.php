<?php
/**
 * 题目指纹（去重判定）
 *
 * 规格见 docs/FINGERPRINT_SPEC.md —— 那是唯一真源，本文件是 PHP 侧实现。
 * ⚠️改动这里必须同步 php/assets/js/fingerprint.js，并用同一组用例双向校验
 *    （php/tests/fingerprint-cases.json）。否则会出现「预览显示已存在、入库却变成新增」。
 */

/**
 * 全角转半角的显式映射表。
 *
 * 刻意不用 mb_convert_kana / Normalizer：那些会连片假名、①、上标一起转，
 * 转换范围不受控；显式表只处理「同一句话里可能混用的标点与字母」，
 * 行为可预测，也便于 JS 端逐字对齐。
 */
function fingerprint_fullwidth_map(): array
{
    return [
        // 字母（全角 → 半角）
        'Ａ' => 'A', 'Ｂ' => 'B', 'Ｃ' => 'C', 'Ｄ' => 'D', 'Ｅ' => 'E', 'Ｆ' => 'F',
        'Ｇ' => 'G', 'Ｈ' => 'H', 'Ｉ' => 'I', 'Ｊ' => 'J', 'Ｋ' => 'K', 'Ｌ' => 'L',
        'Ｍ' => 'M', 'Ｎ' => 'N', 'Ｏ' => 'O', 'Ｐ' => 'P', 'Ｑ' => 'Q', 'Ｒ' => 'R',
        'Ｓ' => 'S', 'Ｔ' => 'T', 'Ｕ' => 'U', 'Ｖ' => 'V', 'Ｗ' => 'W', 'Ｘ' => 'X',
        'Ｙ' => 'Y', 'Ｚ' => 'Z',
        // 标点
        '．' => '.', '，' => ',', '　' => ' ',
        '？' => '?', '！' => '!', '：' => ':', '；' => ';',
        '（' => '(', '）' => ')', '［' => '[', '］' => ']',
        '｛' => '{', '｝' => '}', '“' => '"', '”' => '"',
        '‘' => "'", '’' => "'", '・' => ' ', '－' => '-', '─' => '-', '—' => '-',
        // 中文标点：中英混排的题目里很常见，句末的「。」尤其不能漏
        // （漏了会让「他______去学校。」与「他______去学校」变成两道不同的题）
        '。' => '.', '、' => ',', '；' => ';', '：' => ':',
        '？' => '?', '！' => '!', '「' => '"', '」' => '"',
        '『' => '"', '』' => '"', '《' => '"', '》' => '"',
        // 不换行的空格类
        "\xC2\xA0" => ' ', "\xE3\x80\x80" => ' ',
    ];
}

/**
 * 英文标点：视作等价（统一删除）。
 *
 * 只删「英文句读」这几种，不删括号与引号 —— 它们参与语义
 * （"a(b)" 与 "ab" 是不同的句子）。
 */
function fingerprint_english_punctuation(): array
{
    return [',', '.', '?', '!', ';', ':'];
}

/**
 * 归一化原句：去空白 + 全角转半角 + 占位符归一 + 英文标点等价 + 保留大小写。
 */
function normalize_sentence(string $sentence): string
{
    $map = fingerprint_fullwidth_map();
    $text = strtr($sentence, $map);

    // 占位符下划线不参与身份判定（数量已由校验保证与 blanks 对齐）
    $text = str_replace('_', '', $text);

    // 删掉所有空白
    $text = preg_replace('/\s+/u', '', $text);
    $text = $text === null ? '' : $text;

    // 英文标点等价：统一删除
    foreach (fingerprint_english_punctuation() as $ch) {
        $text = str_replace($ch, '', $text);
    }

    // 保留大小写，但统一成小写形态存储指纹：
    // 原句的大小写在语义上不区分（He 与 he 是同一句话）
    // 注意：与「判卷大小写敏感」无关，那是答案的事
    return mb_strtolower($text, 'UTF-8');
}

/** 题目指纹：只由原句决定，与答案无关 */
function sentence_fingerprint(string $sentence): string
{
    return normalize_sentence($sentence);
}

/**
 * 答案的规范形式：切分 → trim → 去空 → 转小写 → 去重 → 排序。
 *
 * 转小写是为了去重宽容（IS 与 is 视为同一答案），避免同一道题录两次；
 * 这与判卷口径（大小写敏感）是两个不同目的，不要混。
 */
function answer_signature(array $answers): array
{
    $out = [];

    // 递归摊平：AI 输出畸形数据时 answer 里可能嵌套数组（如 [["a","b"]]）。
    //
    // 这里刻意不 skip 非标量：跳过后答案签名会变成空集合，
    // 于是所有同原句的题都判成「答案不相交」= 新题，
    // 恰好漏掉最该抓的那类重复。逐层摊平才是正确行为。
    $flatten = function (array $items) use (&$flatten, &$out): void {
        foreach ($items as $item) {
            if (is_array($item)) {
                $flatten($item);
                continue;
            }
            if ($item === null || is_bool($item)) {
                continue;   // null / bool 不是答案
            }
            foreach (explode_signature_separators((string) $item) as $part) {
                $out[mb_strtolower($part, 'UTF-8')] = true;
            }
        }
    };
    $flatten($answers);

    $list = array_keys($out);
    sort($list, SORT_STRING);
    return $list;
}

/**
 * 按分隔符切分一个答案项。
 *
 * 规则必须与前端 splitAnswers 一致：/ 半角逗号 全角逗号（另加顿号，容错）。
 *
 * ⚠️ 斜杠本身是分隔符之一，在正则字符类里必须写成 `\/`，
 * 否则会提前结束模式（PHP 报 "Unknown modifier"），切分静默失效。
 */
function explode_signature_separators(string $text): array
{
    $text = trim($text);
    if ($text === '') {
        return [];
    }
    $parts = preg_split('/[\/,，、]+/u', $text);
    if ($parts === false) {
        // 正则失败（理论上不会）：保守按原样返回，不丢数据
        return [$text];
    }
    $out = [];
    foreach ($parts as $part) {
        $part = trim($part);
        if ($part !== '') {
            $out[] = $part;
        }
    }
    return $out;
}

/**
 * 比对两个答案规范集合的关系。
 *
 * @return string equal|overlap|subset|disjoint
 */
function answer_relation(array $a, array $b): string
{
    $setA = array_flip($a);
    $setB = array_flip($b);

    if ($setA === $setB) {
        return 'equal';
    }
    $inter = array_intersect_key($setA, $setB);
    if ($inter === []) {
        return 'disjoint';
    }
    // 交集非空：再判断是否有一方是另一方的子集
    if (count($inter) === count($setA) || count($inter) === count($setB)) {
        return 'subset';
    }
    return 'overlap';
}

/**
 * 把一组候选题与新题比对，给出分类结论。
 *
 * @param array $newSentence
 * @param array $newAnswers
 * @param array $candidates 形如 [['id'=>..,'originalSentence'=>..,'answers'=>[..],'source'=>..], ...]
 * @return array{state:string, matched:array, hint:string}
 */
function classify_duplicate(string $newSentence, array $newAnswers, array $candidates): array
{
    // 先自己按指纹过滤，不信任调用方已经过滤过。
    //
    // 这一步不能省：不同原句的题可能有完全相同的答案（「他______去」与
    // 「她______去」答案都是 is），若不按原句过滤就会把两道不同的题
    // 判成重复，导致真实的重复反而被漏掉。指纹过滤是判重的**前置条件**，
    // 放在函数内部才安全。
    $fingerprint = sentence_fingerprint($newSentence);
    $sig = answer_signature($newAnswers);

    $equal = [];
    $diff = [];
    $hints = [];

    foreach ($candidates as $c) {
        if (sentence_fingerprint((string) ($c['originalSentence'] ?? '')) !== $fingerprint) {
            continue;   // 原句不同 = 不同的题，答案撞车是巧合
        }
        $relation = answer_relation($sig, answer_signature((array) ($c['answers'] ?? [])));
        if ($relation === 'equal') {
            $equal[] = $c;
        } elseif ($relation === 'disjoint') {
            // 答案完全不相交 = 这次 AI 给的是另一个答案，视为新题
            continue;
        } else {
            $diff[] = $c;
            $libSig = answer_signature((array) ($c['answers'] ?? []));
            $onlyNew = array_values(array_diff($sig, $libSig));
            $onlyOld = array_values(array_diff($libSig, $sig));
            $parts = [];
            if ($onlyOld !== []) {
                $parts[] = '库里有 ' . implode('/', $onlyOld);
            }
            if ($onlyNew !== []) {
                $parts[] = '本次给了 ' . implode('/', $onlyNew);
            }
            if ($parts !== []) {
                $hints[] = implode('，', $parts);
            }
        }
    }

    if ($equal !== []) {
        return [
            'state' => 'duplicate',
            'matched' => $equal,
            'hint' => '与已有第 ' . implode('、', array_column($equal, 'id')) . ' 题相同',
        ];
    }
    if ($diff !== []) {
        return [
            'state' => 'diff',
            'matched' => $diff,
            'hint' => $hints !== [] ? implode('；', $hints) : '答案与已有题不同',
        ];
    }
    return ['state' => 'new', 'matched' => [], 'hint' => ''];
}
