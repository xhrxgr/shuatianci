<?php
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
