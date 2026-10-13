<?php
/**
 * 试卷相关接口。
 *
 * 一套试卷 = papers 表里的一行，同场考试的题目都挂在同一张试卷下。
 * 题目上的 source 文本继续保留——它是对外展示的来源描述，
 * paper 才是可管理的实体（可改名、设考试日期、加备注）。
 *
 * 两处需要注意：
 * 1. 题目挂卷按**试卷名**匹配：同名即同卷。这样 AI 导入时只要 source 一致，
 *    第二次导入同一套卷会自动归到同一张卷子，不需要人工指定 paper_id。
 * 2. 写操作（改名、删除、题目改卷）都要管理员权限，与题库写入一致。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';

/** 生成试卷 id */
function next_paper_id()
{
    return 'p_' . substr(bin2hex(random_bytes(5)), 0, 10);
}

/**
 * 数据库行 -> 前端试卷对象。
 *
 * questionCount 为题目数；doneCount 只在登录时有意义（游客进度存浏览器），
 * 由调用方按需补。
 *
 * @param array $row
 * @return array
 */
function map_paper(array $row)
{
    // 与 map_question 同理：列缺失一律兜底，绝不让警告混进 JSON 响应
    return [
        'id' => (string) ($row['id'] ?? ''),
        'name' => (string) ($row['name'] ?? ''),
        'examDate' => !empty($row['exam_date']) ? (string) $row['exam_date'] : null,
        'note' => (string) ($row['note'] ?? ''),
        'questionCount' => isset($row['question_count']) ? (int) $row['question_count'] : 0,
        'doneCount' => isset($row['done_count']) ? (int) $row['done_count'] : 0,
        'createdAt' => to_iso($row['created_at'] ?? null),
        'updatedAt' => to_iso($row['updated_at'] ?? $row['created_at'] ?? null),
    ];
}

/**
 * 取当前用户 id；游客返回 null。
 *
 * @return int|null
 */
function current_user_id_or_null()
{
    return isset($GLOBALS['__current_user']['id']) ? (int) $GLOBALS['__current_user']['id'] : null;
}

/**
 * 列出全部试卷（含题数与当前用户的完成数）。
 *
 * 排序：有考试日期的按日期倒序在前，没有日期的按创建时间倒序在后。
 * 这样「刚考完的卷」总在最上面，首页不必再单独排一次。
 *
 * @return array
 */
function query_papers_with_counts()
{
    $userId = current_user_id_or_null();

    $doneSelect = '0 AS done_count';
    if ($userId !== null) {
        $doneSelect = '(SELECT COUNT(DISTINCT r.question_id)
                          FROM practice_records r
                          JOIN questions q2 ON q2.id = r.question_id
                         WHERE q2.paper_id = p.id AND r.user_id = ?) AS done_count';
    }

    $params = [];
    if ($userId !== null) {
        $params[] = $userId;
    }

    return query(
        "SELECT p.*,
                (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id) AS question_count,
                $doneSelect
           FROM papers p
          ORDER BY (p.exam_date IS NULL) ASC, p.exam_date DESC, p.created_at DESC",
        $params
    );
}

/**
 * 按试卷名找卷，找不到返回 null。
 *
 * 名称去首尾空白后精确匹配——同一场考试必须能自动归并，
 * 但不同的卷不能因为名字相近就混在一起。
 *
 * @param string $name
 * @return string|null 试卷 id
 */
function find_paper_by_name($name)
{
    $name = trim((string) $name);
    if ($name === '') {
        return null;
    }
    $row = query_one('SELECT id FROM papers WHERE name = ?', [$name]);
    return $row === null ? null : (string) $row['id'];
}

/**
 * 按 name 取卷，没有就建一张。
 *
 * 题目写入时统一走这里：source 为空时不会建卷，
 * 避免产生大量「手动录入」这种无意义的卷子。
 *
 * @param string $name
 * @return string 试卷 id
 */
function ensure_paper_by_name($name)
{
    $name = trim((string) $name);
    if ($name === '') {
        return '';
    }
    $existing = find_paper_by_name($name);
    if ($existing !== null) {
        return $existing;
    }
    $id = next_paper_id();
    execute(
        "INSERT INTO papers (id, name, exam_date, note, created_at, updated_at)
         VALUES (?, ?, NULL, '', datetime('now'), datetime('now'))",
        [$id, $name]
    );
    return $id;
}

/* ------------------------------------------------------------------ */
/* 读接口                                                                */
/* ------------------------------------------------------------------ */

/** GET /api/papers —— 全部试卷，按考试日期倒序 */
function route_papers_list()
{
    $papers = array_map('map_paper', query_papers_with_counts());
    json_response(['papers' => $papers]);
}

/** GET /api/papers/{id} —— 单张试卷与它的题目 */
function route_papers_show($id)
{
    $row = query_one(
        'SELECT p.*, (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id) AS question_count
           FROM papers p WHERE p.id = ?',
        [$id]
    );
    if ($row === null) {
        throw http_error(404, '试卷不存在或已删除');
    }

    // 列必须与 map_question 期望的一致：少一列就会触发 PHP 警告，
    // 而警告会被输出到 JSON 响应前面，前端 JSON.parse 直接失败
    $questions = query(
        'SELECT id, original_sentence, blanks_json, source, paper_id, schema_version, created_at
           FROM questions WHERE paper_id = ? ORDER BY created_at, id',
        [$id]
    );

    json_response([
        'paper' => map_paper($row),
        'questions' => array_map('map_question', $questions),
    ]);
}

/* ------------------------------------------------------------------ */
/* 写接口（管理员）                                                       */
/* ------------------------------------------------------------------ */

/** POST /api/papers —— 新建试卷 */
function route_papers_create()
{
    require_permission('question:write');

    $body = request_body();
    $name = isset($body['name']) ? trim((string) $body['name']) : '';
    if ($name === '') {
        throw http_error(400, '试卷名不能为空');
    }
    if (find_paper_by_name($name) !== null) {
        throw http_error(409, '同名试卷已存在');
    }

    $examDate = normalize_exam_date(isset($body['examDate']) ? $body['examDate'] : null);
    $note = isset($body['note']) ? trim((string) $body['note']) : '';

    $id = next_paper_id();
    execute(
        'INSERT INTO papers (id, name, exam_date, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
        [$id, $name, $examDate, $note]
    );

    json_response(['ok' => true, 'paper' => map_paper(query_one('SELECT * FROM papers WHERE id = ?', [$id]))], 201);
}

/** PUT /api/papers/{id} —— 改名 / 设日期 / 改备注 */
function route_papers_update($id)
{
    require_permission('question:write');

    $row = query_one('SELECT * FROM papers WHERE id = ?', [$id]);
    if ($row === null) {
        throw http_error(404, '试卷不存在或已删除');
    }

    $body = request_body();
    $fields = [];
    $params = [];

    if (array_key_exists('name', $body)) {
        $name = trim((string) $body['name']);
        if ($name === '') {
            throw http_error(400, '试卷名不能为空');
        }
        $other = find_paper_by_name($name);
        if ($other !== null && $other !== $id) {
            throw http_error(409, '同名试卷已存在');
        }
        $fields[] = 'name = ?';
        $params[] = $name;
    }

    if (array_key_exists('examDate', $body)) {
        $fields[] = 'exam_date = ?';
        $params[] = normalize_exam_date($body['examDate']);
    }

    if (array_key_exists('note', $body)) {
        $fields[] = 'note = ?';
        $params[] = trim((string) $body['note']);
    }

    if (count($fields) === 0) {
        throw http_error(400, '没有需要更新的字段');
    }

    $fields[] = "updated_at = datetime('now')";
    $params[] = $id;
    execute('UPDATE papers SET ' . implode(', ', $fields) . ' WHERE id = ?', $params);

    json_response([
        'ok' => true,
        'paper' => map_paper(query_one(
            'SELECT p.*, (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id) AS question_count
               FROM papers p WHERE p.id = ?',
            [$id]
        )),
    ]);
}

/**
 * DELETE /api/papers/{id} —— 删除试卷
 *
 * 题目本身不删：只把 paper_id 置空，题目回到「未归卷」状态。
 * 删卷不删题——一套卷子重复录入或归错了组，不该连带丢掉题目本身。
 */
function route_papers_delete($id)
{
    require_permission('question:write');

    $row = query_one('SELECT id FROM papers WHERE id = ?', [$id]);
    if ($row === null) {
        throw http_error(404, '试卷不存在或已删除');
    }

    db_transaction(function () use ($id) {
        execute('UPDATE questions SET paper_id = NULL WHERE paper_id = ?', [$id]);
        execute('DELETE FROM papers WHERE id = ?', [$id]);
    });

    json_response(['ok' => true, 'unlinkedQuestions' => 0]);
}

/**
 * PUT /api/questions/paper —— 批量把题目移到某张卷（传 paperId，null 表示移出）
 *
 * 批量操作，因为录同一套卷时经常要重整归属，逐题改太慢。
 */
function route_questions_set_paper()
{
    require_permission('question:write');

    $body = request_body();
    $ids = isset($body['questionIds']) && is_array($body['questionIds']) ? $body['questionIds'] : [];
    if (count($ids) === 0) {
        throw http_error(400, '请先选择题目');
    }

    $paperId = null;
    if (!empty($body['paperId'])) {
        $paperId = (string) $body['paperId'];
        if (query_one('SELECT id FROM papers WHERE id = ?', [$paperId]) === null) {
            throw http_error(404, '试卷不存在或已删除');
        }
    }

    $moved = 0;
    db_transaction(function () use ($ids, $paperId, &$moved) {
        foreach ($ids as $id) {
            if (!is_string($id) || $id === '') {
                continue;
            }
            $result = execute('UPDATE questions SET paper_id = ? WHERE id = ?', [$paperId, $id]);
            $moved += $result['changes'];
        }
    });

    json_response(['ok' => true, 'moved' => $moved, 'paperId' => $paperId]);
}

/**
 * 归一化考试日期：只接受 YYYY-MM-DD，空值视为清空。
 *
 * 存别的格式会让「按日期排序」失效，所以这里严格校验而不是尽量解析。
 *
 * @param mixed $value
 * @return string|null
 */
function normalize_exam_date($value)
{
    if ($value === null) {
        return null;
    }
    $value = trim((string) $value);
    if ($value === '') {
        return null;
    }
    if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $parts) !== 1) {
        throw http_error(400, '考试日期格式应为 YYYY-MM-DD');
    }
    if (!checkdate((int) $parts[2], (int) $parts[3], (int) $parts[1])) {
        throw http_error(400, '考试日期不是一个真实存在的日期');
    }
    return $value;
}