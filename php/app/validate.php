<?php

// normalize_passage_text 会抛 http_error，确保 errors.php 在场
// （require_once 幂等，重复加载无副作用）
require_once __DIR__ . '/errors.php';
/**
 * 服务端题目校验。
 *
 * 前端也有一份校验，但那只在浏览器里跑；绕过前端直接调接口就能写脏数据，
 * 所以入库前必须在服务端再校验一次。
 *
 * 校验口径（不得随意放宽或收紧）：
 * - 空格占位符固定 6 个下划线，数量必须等于 blanks 数量
 * - blankIndex 从 1 开始连续递增
 * - answer 非空、不含空串、忽略大小写去重后不能重复（只 trim，不转大小写）
 * - hintType 必须合法；「无提示词」时 hintWord 必须为 null，其余必须有 hintWord
 * - trapAnalysis 只校验非空，不设字数下限
 * - id 可缺省：AI 导入时编号由系统生成（见 routes_bank.php 的 next_question_id），
 *   只有浏览器整库上云这类需要保留原编号的场景才要求带 id
 */

/** 空格占位符 */
define('BLANK_PLACEHOLDER', '______');

/** 合法提示词类型 */
function hint_types()
{
    return ['给动词', '给名词', '给形容词', '给副词', '无提示词'];
}

/**
 * 校验单道题目。
 *
 * @param mixed $question
 * @return string[] 错误信息数组，空数组表示通过
 */
function validate_question_data($question)
{
    $errors = [];
    if (!is_array($question)) {
        return ['题目数据不是对象'];
    }

    $label = !empty($question['id']) ? (string) $question['id'] : '(未命名题目)';

    // id 允许缺省：缺省或不是字符串时都交给写入环节生成，
    // 这里不报错——AI 导入本来就不该由它决定编号
    if (isset($question['id']) && !is_string($question['id'])) {
        $errors[] = "{$label}：id 必须是字符串";
    }

    $sentence = isset($question['originalSentence']) ? $question['originalSentence'] : '';
    if (!is_string($sentence) || trim($sentence) === '') {
        $errors[] = "{$label}：originalSentence 不能为空";
        return $errors;
    }

    // 完整原文（未挖空）可空：填了就做长度与类型校验，不填完全不影响
    if (isset($question['passageText'])) {
        $passage = normalize_passage_text($question['passageText']);
        if ($passage === null && is_string($question['passageText']) && trim((string) $question['passageText']) !== '') {
            $errors[] = "{$label}：passageText 不合法（需为字符串且不超过 5000 字）";
        }
    }

    $blanks = isset($question['blanks']) && is_array($question['blanks']) ? $question['blanks'] : [];
    if (count($blanks) === 0) {
        $errors[] = "{$label}：原句必须包含至少一个「" . BLANK_PLACEHOLDER . "」空格";
        return $errors;
    }

    // 空格数量与 blanks 数量必须一致
    $blankCount = substr_count($sentence, BLANK_PLACEHOLDER);
    if ($blankCount !== count($blanks)) {
        $errors[] = "{$label}：原句中的空格数量（{$blankCount}）与 blanks 数量（" . count($blanks) . "）不一致";
    }

    $index = 0;
    foreach ($blanks as $blank) {
        $index++;
        $at = "{$label} 第 {$index} 个空";
        if (!is_array($blank)) {
            $errors[] = "{$at}：空格数据格式不正确";
            continue;
        }

        // blankIndex 必须从 1 开始连续递增
        $blankIndex = isset($blank['blankIndex']) ? $blank['blankIndex'] : null;
        if ($blankIndex !== $index) {
            $shown = $blankIndex === null ? 'null' : (string) $blankIndex;
            $errors[] = "{$at}：blankIndex 应为 {$index}，实际为 {$shown}（须从 1 开始连续递增）";
        }

        // 答案不能为空且不能重复
        $answers = isset($blank['answer']) && is_array($blank['answer']) ? $blank['answer'] : [];
        if (count($answers) === 0) {
            $errors[] = "{$at}：answer 不能为空";
        } else {
            $trimmed = array_map(function ($item) {
                return trim((string) $item);
            }, $answers);
            if (in_array('', $trimmed, true)) {
                $errors[] = "{$at}：answer 不能包含空字符串";
            }
            if (count(array_unique($trimmed)) !== count($trimmed)) {
                $errors[] = "{$at}：answer 存在完全重复的项";
            }
        }

        // 提示词类型必须合法，且与 hintWord 匹配
        $hintType = isset($blank['hintType']) ? $blank['hintType'] : null;
        if (!in_array($hintType, hint_types(), true)) {
            $shown = $hintType === null ? 'null' : (string) $hintType;
            $errors[] = "{$at}：hintType「{$shown}」无效，应为 " . implode(" / ", hint_types()) . " 之一";
        }
        $hasHintWord = array_key_exists('hintWord', $blank) && $blank['hintWord'] !== null;
        if ($hintType === '无提示词' && $hasHintWord) {
            $errors[] = "{$at}：hintType 为「无提示词」时 hintWord 必须为 null";
        }
        if ($hintType !== '无提示词' && empty($blank['hintWord'])) {
            $errors[] = "{$at}：hintType 为「{$hintType}」时必须填写 hintWord";
        }

        // 解析不能为空
        if (empty($blank['trapAnalysis']) || trim((string) $blank['trapAnalysis']) === '') {
            $errors[] = "{$at}：trapAnalysis 不能为空";
        }
    }

    return $errors;
}

/**
 * 批量校验。
 *
 * @param array $questions
 * @return array{valid:array,errors:array}
 */
function validate_batch(array $questions)
{
    $valid = [];
    $errors = [];
    foreach ($questions as $question) {
        $result = validate_question_data($question);
        if (count($result) === 0) {
            $valid[] = $question;
        } else {
            $errors = array_merge($errors, $result);
        }
    }
    return ['valid' => $valid, 'errors' => $errors];
}

/**
 * 规范化「完整原文」（passageText）。
 *
 * 用途：短文填空一道大题是一篇阅读挖多个空，answers 常依赖上下文
 * （代词指代 / 时态呼应 / 篇章逻辑）。存一份未挖空的原文，做题时给学生对照。
 *
 * 规则：
 * - 没传 / 空串 / 全是空白 → null（表示「没有原文」，与「原文为空」区分）
 * - 非字符串 → null（宽松处理：忽略而不是报错，避免老数据升级时卡住）
 * - 超过 5000 字 → 抛 400。**不静默截断**：截断会让学生看到半篇文章，
 *   比没有原文更糟
 *
 * 注意：这一列**不参与** fingerprint 与 content_hash —— 那是题目身份的依据，
 * 加了它会让所有存量题的哈希变化，查重与「内容是否变了」的结论全部翻转。
 * 原文只是附属的展示数据，改它不改变「这是哪道题」。
 */
function normalize_passage_text($value)
{
    if ($value === null || !is_string($value)) {
        return null;
    }
    $text = trim($value);
    if ($text === '') {
        return null;
    }
    if (function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') > 5000 : strlen($text) > 5000) {
        throw http_error(400, '完整原文过长：上限 5000 字（当前 ' . (function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text)) . ' 字）');
    }
    return $text;
}

/**
 * 规范化「所属篇章」id。
 *
 * 规则：
 * - null / 空串 → null（表示不挂篇章）
 * - 必须是字符串，且指向真实存在的篇章——否则会留下悬空引用，
 *   做题时取不到原文，而且没有任何报错（最难查的那类）
 */
function normalize_passage_id($value)
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_string($value)) {
        throw http_error(400, 'passageId 必须是字符串');
    }
    $value = trim($value);
    if ($value === '') {
        return null;
    }
    $row = function_exists('query_one')
        ? query_one('SELECT id FROM passages WHERE id = ?', [$value])
        : null;
    if ($row === null) {
        throw http_error(400, '篇章不存在或已删除：' . $value);
    }
    return (string) $row['id'];
}
