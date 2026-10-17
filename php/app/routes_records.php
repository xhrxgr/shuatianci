<?php
/**
 * 做题记录 / 个人进度 / 试卷收藏 / 小题标记。
 *
 * 对应：
 *   routes/records.js     -> records_* 系列
 *   routes/collection.js  -> favorites_* / marks_* 系列
 *
 * 未登录时的行为：游客记录由前端存在本地，
 * 接口返回 { ok: true, stored: false }（不落库、不报错），
 * 读取类接口返回 authenticated: false + 空集合。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';

/**
 * 题目是否存在的统一校验。
 *
 * user_progress / user_marks 没有外键约束，不校验的话
 * 拼错或已删除的题目 id 会留下永远指向空处的孤儿数据。
 */
function assert_question_exists($questionId)
{
    $rows = query('SELECT id FROM questions WHERE id = ?', [$questionId]);
    if (count($rows) === 0) {
        throw http_error(404, '题目不存在或已删除');
    }
}

/* ---------------- 做题记录 ---------------- */

/** POST /api/records */
function route_records_create()
{
    $user = current_user();
    if ($user === null) {
        // 游客：前端已在本地保存，这里明确不落库
        json_response(['ok' => true, 'stored' => false]);
    }

    $questionId = trim((string) body_param('questionId', ''));
    $isCorrect = body_param('isCorrect') ? 1 : 0;
    $wrongCount = (int) body_param('wrongCount', 0);
    $answers = body_param('answers');

    if ($questionId === '') {
        throw http_error(400, '缺少题目 ID');
    }
    assert_question_exists($questionId);

    execute(
        'INSERT INTO practice_records (user_id, question_id, is_correct, wrong_count, answers_json)
         VALUES (?, ?, ?, ?, ?)',
        [
            (int) $user['id'],
            $questionId,
            $isCorrect,
            $wrongCount,
            is_array($answers) ? json_encode($answers, JSON_UNESCAPED_UNICODE) : null,
        ]
    );

    // 答错时累加该用户在此题上的错次
    if (!$isCorrect) {
        execute(
            'INSERT INTO user_progress (user_id, question_id, wrong_count)
             VALUES (?, ?, 1)
             ON CONFLICT(user_id, question_id)
             DO UPDATE SET wrong_count = wrong_count + 1, updated_at = datetime(\'now\')',
            [(int) $user['id'], $questionId]
        );
    }

    json_response(['ok' => true, 'stored' => true], 201);
}

/** POST /api/progress/{questionId} —— 标记已掌握 / 未掌握 */
function route_progress_set($questionId)
{
    $user = current_user();
    if ($user === null) {
        json_response(['ok' => true, 'stored' => false]);
    }

    $questionId = trim((string) $questionId);
    $status = body_param('status') === 'mastered' ? 'mastered' : 'unmastered';

    assert_question_exists($questionId);

    execute(
        'INSERT INTO user_progress (user_id, question_id, status)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, question_id)
         DO UPDATE SET status = excluded.status, updated_at = datetime(\'now\')',
        [(int) $user['id'], $questionId, $status]
    );

    json_response(['ok' => true, 'stored' => true]);
}

/** GET /api/progress —— 当前用户的全部进度 */
function route_progress_list()
{
    $user = current_user();
    if ($user === null) {
        json_response(['authenticated' => false, 'progress' => new stdClass()]);
    }

    $rows = query(
        'SELECT question_id, wrong_count, status FROM user_progress WHERE user_id = ?',
        [(int) $user['id']]
    );

    $progress = [];
    foreach ($rows as $row) {
        $progress[$row['question_id']] = [
            'wrongCount' => (int) $row['wrong_count'],
            'status' => (string) $row['status'],
        ];
    }

    json_response(['authenticated' => true, 'progress' => $progress]);
}

/** GET /api/records/summary —— 正确率、题量、最近记录、薄弱题 */
function route_records_summary()
{
    $user = current_user();
    if ($user === null) {
        json_response([
            'authenticated' => false,
            'total' => 0,
            'correct' => 0,
            'wrong' => 0,
            'accuracy' => 0,
        ]);
    }

    $rows = query(
        'SELECT COUNT(*)                       AS total,
                COALESCE(SUM(is_correct), 0)   AS correct,
                COALESCE(SUM(wrong_count), 0) AS wrong
           FROM practice_records r
           JOIN questions q ON q.id = r.question_id
          WHERE r.user_id = ?',
        [(int) $user['id']]
    );

    $total = (int) $rows[0]['total'];
    $correct = (int) $rows[0]['correct'];
    $wrong = (int) $rows[0]['wrong'];

    $recent = query(
        'SELECT r.id, r.question_id, r.is_correct, r.wrong_count, r.created_at
           FROM practice_records r
           JOIN questions q ON q.id = r.question_id
          WHERE r.user_id = ?
          ORDER BY r.created_at DESC
          LIMIT 20',
        [(int) $user['id']]
    );

    $weakList = query(
        'SELECT r.question_id, COUNT(*) AS times
           FROM practice_records r
           JOIN questions q ON q.id = r.question_id
          WHERE r.user_id = ? AND r.is_correct = 0
          GROUP BY r.question_id
          ORDER BY times DESC
          LIMIT 10',
        [(int) $user['id']]
    );

    json_response([
        'authenticated' => true,
        'total' => $total,
        'correct' => $correct,
        'wrong' => $wrong,
        'accuracy' => $total === 0 ? 0 : (int) round(($correct / $total) * 100),
        'recent' => array_map(function ($row) {
            return [
                'id' => (int) $row['id'],
                'questionId' => (string) $row['question_id'],
                'isCorrect' => (int) $row['is_correct'] === 1,
                'wrongCount' => (int) $row['wrong_count'],
                'createdAt' => to_iso($row['created_at']),
            ];
        }, $recent),
        'weakQuestions' => array_map(function ($row) {
            return [
                'questionId' => (string) $row['question_id'],
                'times' => (int) $row['times'],
            ];
        }, $weakList),
    ]);
}

/* ---------------- 试卷收藏 ---------------- */

/** GET /api/favorites */
function route_favorites_list()
{
    $user = current_user();
    if ($user === null) {
        json_response(['authenticated' => false, 'favorites' => []]);
    }

    $rows = query(
        'SELECT f.source, f.note, f.created_at,
                COUNT(q.id) AS question_count
           FROM user_favorites f
           LEFT JOIN questions q ON q.source = f.source
          WHERE f.user_id = ?
          GROUP BY f.source, f.note, f.created_at
          ORDER BY f.created_at DESC',
        [(int) $user['id']]
    );

    json_response([
        'authenticated' => true,
        'favorites' => array_map(function ($row) {
            return [
                'source' => (string) $row['source'],
                'note' => $row['note'] !== null ? (string) $row['note'] : null,
                'questionCount' => (int) $row['question_count'],
                'createdAt' => to_iso($row['created_at']),
            ];
        }, $rows),
    ]);
}

/** POST /api/favorites —— 收藏 / 取消收藏 */
function route_favorites_toggle()
{
    $user = current_user();
    if ($user === null) {
        throw http_error(401, '请先登录后使用该功能');
    }

    $source = trim((string) body_param('source', ''));
    if ($source === '') {
        throw http_error(400, '缺少试卷来源');
    }

    $exists = query('SELECT id FROM user_favorites WHERE user_id = ? AND source = ?', [
        (int) $user['id'],
        $source,
    ]);

    if (count($exists) > 0) {
        execute('DELETE FROM user_favorites WHERE id = ?', [(int) $exists[0]['id']]);
        json_response(['ok' => true, 'favorited' => false, 'message' => '已取消收藏']);
    }

    // 用 mb_substr 而不是 substr：substr 按字节截断，会把多字节字符劈开
    // 产生非法 UTF-8，存库后 json_encode 返回 false，列表接口会输出空响应体
    $note = body_param('note') ? mb_substr((string) body_param('note'), 0, 255, 'UTF-8') : null;
    execute('INSERT INTO user_favorites (user_id, source, note) VALUES (?, ?, ?)', [
        (int) $user['id'],
        $source,
        $note,
    ]);

    json_response(['ok' => true, 'favorited' => true, 'message' => '已收藏']);
}

/* ---------------- 小题标记 ---------------- */

/** GET /api/marks */
function route_marks_list()
{
    $user = current_user();
    if ($user === null) {
        json_response(['authenticated' => false, 'marks' => []]);
    }

    $rows = query(
        'SELECT m.question_id, m.label, m.note, m.created_at
           FROM user_marks m
          WHERE m.user_id = ?
          ORDER BY m.created_at DESC',
        [(int) $user['id']]
    );

    json_response([
        'authenticated' => true,
        'marks' => array_map(function ($row) {
            return [
                'questionId' => (string) $row['question_id'],
                'label' => (string) $row['label'],
                'note' => $row['note'] !== null ? (string) $row['note'] : null,
                'createdAt' => to_iso($row['created_at']),
            ];
        }, $rows),
    ]);
}

/** POST /api/marks —— 标记 / 取消标记 */
function route_marks_toggle()
{
    $user = current_user();
    if ($user === null) {
        throw http_error(401, '请先登录后使用该功能');
    }

    $questionId = trim((string) body_param('questionId', ''));
    if ($questionId === '') {
        throw http_error(400, '缺少题目 ID');
    }

    $exists = query('SELECT id FROM user_marks WHERE user_id = ? AND question_id = ?', [
        (int) $user['id'],
        $questionId,
    ]);

    if (count($exists) > 0) {
        execute('DELETE FROM user_marks WHERE id = ?', [(int) $exists[0]['id']]);
        json_response(['ok' => true, 'marked' => false, 'message' => '已取消标记']);
    }

    // label 与 note 都要用 mb_substr：substr 按**字节**截断，会把多字节字符劈开，
    // 产生非法 UTF-8，存库后 json_encode 返回 false，整个列表接口输出空响应体。
    // 11 个汉字（33 字节）截到 32 字节就会命中——所以下面这行不能图省事用 substr。
    $label = mb_substr((string) (body_param('label') ?: '重点'), 0, 32, 'UTF-8');
    $note = body_param('note') ? mb_substr((string) body_param('note'), 0, 255, 'UTF-8') : null;

    // 确认题目存在，避免标记到已删除的题
    $question = query('SELECT id FROM questions WHERE id = ?', [$questionId]);
    if (count($question) === 0) {
        throw http_error(404, '题目不存在或已删除');
    }

    execute('INSERT INTO user_marks (user_id, question_id, label, note) VALUES (?, ?, ?, ?)', [
        (int) $user['id'],
        $questionId,
        $label,
        $note,
    ]);

    json_response(['ok' => true, 'marked' => true, 'message' => '已标记']);
}
