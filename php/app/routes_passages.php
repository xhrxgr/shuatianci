<?php
/**
 * /api/passages/* —— 篇章（一道大题共享的完整原文）。
 *
 * 为什么有这一组：一道大题是「一篇阅读挖多个空」，卷子上是 10 道小题，
 * 它们共享同一篇原文。原文挂在题目上就要填 10 遍、改 10 遍；
 * 挂成篇章只存一份，10 道题通过 passage_id 指向它 —— 改一处，全篇立即生效。
 *
 * 与 v3.6.13 的 questions.passage_text 并存：
 * - 新数据走这里（共享）
 * - 老数据还在题目自己那一列（一题一份，用户明确说不迁移）
 * 读取时 passages.text 优先，见 util.php 的 questions_passage_text()。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';

/** 篇章的序列化（与 map_question 的风格保持一致） */
function map_passage(array $row)
{
    return [
        'id' => (string) ($row['id'] ?? ''),
        'paperId' => !empty($row['paper_id']) ? (string) $row['paper_id'] : null,
        'title' => (string) ($row['title'] ?? ''),
        'text' => (string) ($row['text'] ?? ''),
        'createdAt' => to_iso($row['created_at'] ?? null),
        'updatedAt' => to_iso($row['updated_at'] ?? null),
    ];
}

/** 规范化篇章正文：复用题目那边的口径（非空、上限 5000、不静默截断） */
function normalize_passage_body($value)
{
    return normalize_passage_text($value);
}

/**
 * GET /api/passages?paperId=xxx —— 列出篇章。
 *
 * 不传 paperId 时返回全部（量通常很小：一个学期几十篇）。
 * questionCount 是挂在这篇上的题目数，UI 上要显示「本篇 10 道题」。
 */
function route_passages_list()
{
    require_permission('question:read');

    $paperId = isset($_GET['paperId']) ? trim((string) $_GET['paperId']) : '';
    if ($paperId !== '') {
        $rows = query(
            'SELECT p.*, (SELECT COUNT(*) FROM questions q WHERE q.passage_id = p.id) AS question_count
               FROM passages p
              WHERE p.paper_id = ?
              ORDER BY p.created_at, p.id',
            [$paperId]
        );
    } else {
        $rows = query(
            'SELECT p.*, (SELECT COUNT(*) FROM questions q WHERE q.passage_id = p.id) AS question_count
               FROM passages p
              ORDER BY p.created_at, p.id'
        );
    }

    $items = [];
    foreach ($rows as $row) {
        $item = map_passage($row);
        $item['questionCount'] = (int) ($row['question_count'] ?? 0);
        $items[] = $item;
    }
    json_response(['ok' => true, 'passages' => $items]);
}

/** POST /api/passages —— 新建篇章 */
function route_passages_create()
{
    require_permission('question:write');

    $body = request_body();
    $text = normalize_passage_body(isset($body['text']) ? $body['text'] : null);
    if ($text === null) {
        json_response(['ok' => false, 'error' => '篇章正文不能为空'], 400);
    }

    $title = isset($body['title']) ? trim((string) $body['title']) : '';
    // 标题也走同一套长度上限：它不是正文，但同样不该无限长
    if (mb_strlen($title) > 100) {
        json_response(['ok' => false, 'error' => '篇章标题过长：上限 100 字'], 400);
    }

    // paperId 可选：传了就必须存在，否则留下悬空引用
    $paperId = null;
    if (isset($body['paperId']) && (string) $body['paperId'] !== '') {
        $paperId = (string) $body['paperId'];
        $paper = query_one('SELECT id FROM papers WHERE id = ?', [$paperId]);
        if ($paper === null) {
            json_response(['ok' => false, 'error' => '试卷不存在或已删除'], 404);
        }
    }

    // 与 next_question_id 同一套生成方式：时间戳 base36 + 随机后缀，
    // 保证同一毫秒内建多篇也不会撞
    $id = 'p_' . base_convert((string) (int) (microtime(true) * 1000), 10, 36)
        . '_' . substr(bin2hex(random_bytes(3)), 0, 6);
    execute(
        'INSERT INTO passages (id, paper_id, title, text, created_at) VALUES (?, ?, ?, ?, ?)',
        [$id, $paperId, $title, $text, to_sql_date(null)]
    );

    $row = query_one('SELECT * FROM passages WHERE id = ?', [$id]);
    json_response(['ok' => true, 'passage' => map_passage($row)], 201);
}

/** PUT /api/passages/{id} —— 改篇章标题或正文（改一处，挂在这篇上的题全部跟着变） */
function route_passages_update($id)
{
    require_permission('question:write');

    $existing = query_one('SELECT * FROM passages WHERE id = ?', [$id]);
    if ($existing === null) {
        json_response(['ok' => false, 'error' => '篇章不存在或已删除'], 404);
    }

    $patch = request_body();
    $fields = [];
    $values = [];

    if (array_key_exists('title', $patch)) {
        $title = trim((string) $patch['title']);
        if (mb_strlen($title) > 100) {
            json_response(['ok' => false, 'error' => '篇章标题过长：上限 100 字'], 400);
        }
        $fields[] = 'title = ?';
        $values[] = $title;
    }
    if (array_key_exists('text', $patch)) {
        $text = normalize_passage_body($patch['text']);
        if ($text === null) {
            json_response(['ok' => false, 'error' => '篇章正文不能为空'], 400);
        }
        $fields[] = 'text = ?';
        $values[] = $text;
    }
    if (array_key_exists('paperId', $patch)) {
        $paperId = $patch['paperId'] === null || (string) $patch['paperId'] === '' ? null : (string) $patch['paperId'];
        if ($paperId !== null) {
            $paper = query_one('SELECT id FROM papers WHERE id = ?', [$paperId]);
            if ($paper === null) {
                json_response(['ok' => false, 'error' => '试卷不存在或已删除'], 404);
            }
        }
        $fields[] = 'paper_id = ?';
        $values[] = $paperId;
    }

    if (count($fields) === 0) {
        json_response(['ok' => false, 'error' => '没有需要更新的字段'], 400);
    }

    $fields[] = 'updated_at = ?';
    $values[] = to_sql_date(null);
    $values[] = $id;
    execute('UPDATE passages SET ' . implode(', ', $fields) . ' WHERE id = ?', $values);

    $row = query_one('SELECT * FROM passages WHERE id = ?', [$id]);
    json_response(['ok' => true, 'passage' => map_passage($row)]);
}

/**
 * DELETE /api/passages/{id} —— 删除篇章。
 *
 * 题目不删，只把 passage_id 置空（变回"没有原文"）。
 * 直接删题是错的：用户可能只是不想要这篇原文了。
 */
function route_passages_delete($id)
{
    require_permission('question:write');

    $existing = query_one('SELECT id FROM passages WHERE id = ?', [$id]);
    if ($existing === null) {
        json_response(['ok' => false, 'error' => '篇章不存在或已删除'], 404);
    }

    db_transaction(function () use ($id) {
        execute('UPDATE questions SET passage_id = NULL WHERE passage_id = ?', [$id]);
        execute('DELETE FROM passages WHERE id = ?', [$id]);
    });

    json_response(['ok' => true, 'deleted' => true]);
}
