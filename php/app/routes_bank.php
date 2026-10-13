<?php
/**
 * 题库与标签字典。
 *
 * 接口契约与历史版本完全一致：
 * - 读取公开（游客也能刷题），写入需 question:write / tag:write 权限
 * - 新增支持三种提交形态：裸数组 / { questions: [...] } / { question: {...} }
 * - 整库覆盖（replaceAll）与标签全量覆盖都放进事务
 * - 校验不通过的题目不入库，逐条汇报原因
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';
require_once __DIR__ . '/validate.php';

/**
 * 数据库行 -> 前端题目对象。
 *
 * blanks 从 JSON 文本还原成数组原样返回；
 * 前端依赖 status / wrongCount 字段做合并，这里给默认值。
 *
 * @param array $row
 * @return array
 */
function map_question(array $row)
{
    $blanks = json_decode((string) $row['blanks_json'], true);
    return [
        'id' => (string) $row['id'],
        'originalSentence' => (string) $row['original_sentence'],
        'blanks' => is_array($blanks) ? $blanks : [],
        'source' => (string) $row['source'],
        'schemaVersion' => (int) $row['schema_version'],
        'status' => 'unmastered',
        'wrongCount' => 0,
        'createdAt' => to_iso($row['created_at']),
    ];
}

/** 判断是否为「列表」数组（对应 JS 的 Array.isArray 语义） */
function is_list_array($value)
{
    if (!is_array($value)) {
        return false;
    }
    if ($value === []) {
        return true;
    }
    return array_keys($value) === range(0, count($value) - 1);
}

/**
 * 生成题目 id。
 *
 * AI 导入时不采信 AI 返回的编号——外部 AI 无从得知题库现状，
 * 每次都会从 q_0001 重新数。因此缺 id、或 id 与库中已有冲突时，都在这里重新生成。
 *
 * 格式与前端 admin.js 的手动精录保持一致：q_{时间戳36进制}_{随机}。
 *
 * @param int $attempt 重试次数（同一毫秒内批量生成时避免撞号）
 * @return string
 */
function next_question_id($attempt = 0)
{
    $suffix = $attempt > 0 ? '_' . $attempt : '';
    return 'q_' . base_convert((string) (int) (microtime(true) * 1000), 10, 36)
        . $suffix
        . '_' . substr(bin2hex(random_bytes(3)), 0, 6);
}

/* ---------------- 读取（公开） ---------------- */

/** GET /api/questions */
function route_questions_list()
{
    $rows = query(
        'SELECT id, original_sentence, blanks_json, source, schema_version, created_at
           FROM questions
          ORDER BY created_at DESC, id'
    );
    json_response(['questions' => array_map('map_question', $rows)]);
}

/** GET /api/tags */
function route_tags_list()
{
    $rows = query('SELECT id, name, parent_id, color, is_active FROM tags ORDER BY id');
    json_response([
        'tagDictionary' => [
            'schemaVersion' => 1,
            'tags' => array_map(function ($row) {
                return [
                    'id' => (string) $row['id'],
                    'name' => (string) $row['name'],
                    'parentId' => $row['parent_id'] !== null ? (string) $row['parent_id'] : null,
                    'color' => (string) $row['color'],
                    'isActive' => (int) $row['is_active'] === 1,
                ];
            }, $rows),
        ],
    ]);
}

/* ---------------- 写入（需权限） ---------------- */

/** POST /api/questions —— 新增 / 批量导入 */
function route_questions_create()
{
    require_permission('question:write');

    $body = request_body();
    // 支持三种提交方式：裸数组 / { questions: [...] } / { question: {...} }
    if (is_list_array($body)) {
        $list = $body;
    } elseif (isset($body['questions']) && is_array($body['questions'])) {
        $list = $body['questions'];
    } elseif (isset($body['question'])) {
        $list = [$body['question']];
    } else {
        $list = null;
    }

    if ($list === null || count($list) === 0) {
        throw http_error(400, '缺少题目数据');
    }

    // 服务端独立校验：绕过前端直接调接口也不能写脏数据
    $check = validate_batch($list);
    $valid = $check['valid'];
    $errors = $check['errors'];

    if (count($valid) === 0) {
        json_response([
            'error' => '校验未通过，' . count($errors) . ' 处问题，本次未导入任何题目',
            'details' => $errors,
        ], 400);
    }

    $replaceAll = !empty($body['replaceAll']);

    // 整库覆盖 + 写入放进同一个事务，失败整体回滚
    $result = db_transaction(function () use ($valid, $replaceAll) {
        if ($replaceAll) {
            execute('DELETE FROM questions');
        }

        $added = 0;
        $renamed = 0;
        $attempt = 0;

        foreach ($valid as $question) {
            $id = isset($question['id']) && is_string($question['id']) ? trim($question['id']) : '';

            // 整库覆盖（浏览器题库上云）要保留原编号，删库后不会冲突；
            // 增量追加时若编号缺失或已被占用，就换一个新编号——
            // 直接跳过会让用户以为导入成功，实际一题都没进库
            if ($replaceAll) {
                if ($id === '') {
                    $id = next_question_id($attempt++);
                }
            } else {
                $taken = $id !== ''
                    && count(query('SELECT id FROM questions WHERE id = ?', [$id])) > 0;
                if ($id === '' || $taken) {
                    $id = next_question_id($attempt++);
                    $renamed++;
                }
            }

            execute(
                'INSERT INTO questions
                   (id, original_sentence, blanks_json, source, schema_version, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)',
                [
                    $id,
                    isset($question['originalSentence']) ? $question['originalSentence'] : '',
                    json_encode(isset($question['blanks']) ? $question['blanks'] : [], JSON_UNESCAPED_UNICODE),
                    !empty($question['source']) ? $question['source'] : '手动录入',
                    isset($question['schemaVersion']) ? $question['schemaVersion'] : 1,
                    to_sql_date(isset($question['createdAt']) ? $question['createdAt'] : null),
                ]
            );
            $added++;
        }

        return ['added' => $added, 'renamed' => $renamed];
    });

    // 部分题目校验不通过时照常导入合法的，并说明被拒原因
    $response = ['ok' => true, 'added' => $result['added'], 'renamed' => $result['renamed']];
    if (count($errors) > 0) {
        $response['rejected'] = count($list) - count($valid);
        $response['details'] = $errors;
    }
    json_response($response, 201);
}

/** PUT /api/questions/{id} —— 更新题目（支持只改部分字段） */
function route_questions_update($id)
{
    require_permission('question:write');

    $patch = request_body();
    if ($patch === null) {
        $patch = [];
    }

    $fields = [];
    $values = [];

    if (array_key_exists('source', $patch)) {
        $fields[] = 'source = ?';
        $values[] = (string) $patch['source'];
    }
    if (array_key_exists('blanks', $patch)) {
        $fields[] = 'blanks_json = ?';
        $values[] = json_encode($patch['blanks'], JSON_UNESCAPED_UNICODE);
    }
    if (array_key_exists('originalSentence', $patch)) {
        $fields[] = 'original_sentence = ?';
        $values[] = (string) $patch['originalSentence'];
    }

    if (count($fields) === 0) {
        throw http_error(400, '没有需要更新的字段');
    }

    // 与新增走同一套校验：未提及的字段取库里的现值一起校验，
    // 否则「只改 blanks 不改原句」会让空格数量与 blanks 数量对不上
    $rows = query('SELECT id, original_sentence, blanks_json, source FROM questions WHERE id = ?', [$id]);
    if (count($rows) === 0) {
        throw http_error(404, '题目不存在或已删除');
    }
    $row = $rows[0];

    $merged = [
        'id' => $row['id'],
        'originalSentence' => array_key_exists('originalSentence', $patch)
            ? $patch['originalSentence']
            : $row['original_sentence'],
        'blanks' => array_key_exists('blanks', $patch)
            ? $patch['blanks']
            : json_decode((string) $row['blanks_json'], true),
        'source' => array_key_exists('source', $patch) ? $patch['source'] : $row['source'],
    ];

    $errors = validate_question_data($merged);
    if (count($errors) > 0) {
        json_response([
            'error' => '校验未通过，' . count($errors) . ' 处问题，本次未修改',
            'details' => $errors,
        ], 400);
    }

    // WHERE id = ? 的参数放最后
    $values[] = $id;
    $result = execute('UPDATE questions SET ' . implode(', ', $fields) . ' WHERE id = ?', $values);

    if ($result['affectedRows'] === 0) {
        throw http_error(404, '题目不存在或已删除');
    }
    json_response(['ok' => true]);
}

/** DELETE /api/questions/{id} */
function route_questions_delete($id)
{
    require_permission('question:write');
    $result = execute('DELETE FROM questions WHERE id = ?', [$id]);
    if ($result['affectedRows'] === 0) {
        throw http_error(404, '题目不存在或已删除');
    }
    json_response(['ok' => true]);
}

/** PUT /api/tags —— 保存整个标签字典（全量覆盖） */
function route_tags_save()
{
    require_permission('tag:write');

    $body = request_body();
    $dict = isset($body['tagDictionary']) ? $body['tagDictionary'] : $body;
    if (!is_array($dict) || !isset($dict['tags']) || !is_array($dict['tags'])) {
        throw http_error(400, '标签数据格式不正确');
    }
    $tags = $dict['tags'];

    // 保护：顶级分类不应少于现有数量，避免误操作把标签清空
    $currentParents = scalar_int('SELECT COUNT(*) AS n FROM tags WHERE parent_id IS NULL');
    $newParents = 0;
    foreach ($tags as $tag) {
        $parentId = is_array($tag) && isset($tag['parentId']) ? $tag['parentId'] : null;
        if ($parentId === null) {
            $newParents++;
        }
    }
    if ($newParents < $currentParents) {
        throw http_error(
            400,
            "顶级分类数量从 {$currentParents} 减少到 {$newParents}，疑似误操作，已拒绝。如确实要删除请手动确认。"
        );
    }

    // 每条标签必须有 id 与 name
    $invalidCount = 0;
    foreach ($tags as $tag) {
        if (!is_array($tag) || empty($tag['id']) || empty($tag['name']) || trim((string) $tag['name']) === '') {
            $invalidCount++;
        }
    }
    if ($invalidCount > 0) {
        throw http_error(400, "{$invalidCount} 个标签缺少 id 或名称，已拒绝保存");
    }

    // 全量覆盖放进事务，中途失败回滚
    $count = db_transaction(function () use ($tags) {
        execute('DELETE FROM tags');
        $written = 0;
        foreach ($tags as $tag) {
            execute('INSERT INTO tags (id, name, parent_id, color, is_active) VALUES (?, ?, ?, ?, ?)', [
                $tag['id'],
                $tag['name'],
                isset($tag['parentId']) ? $tag['parentId'] : null,
                !empty($tag['color']) ? $tag['color'] : '#64748B',
                (isset($tag['isActive']) && $tag['isActive'] === false) ? 0 : 1,
            ]);
            $written++;
        }
        return $written;
    });

    json_response(['ok' => true, 'count' => $count]);
}

/** POST /api/bank/reset —— 清空题库与标签（危险操作） */
function route_bank_reset()
{
    require_permission('question:write');
    db_transaction(function () {
        execute('DELETE FROM questions');
        execute('DELETE FROM tags');
    });
    json_response(['ok' => true]);
}
