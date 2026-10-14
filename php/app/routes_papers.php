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
 * kind 区分「原始卷」（真实录入）与「生成的卷」（蓝图抽题产出）；
 * 生成卷带 blueprintId / blueprintName 以便「一键重新生成」。
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
        'kind' => !empty($row['kind']) ? (string) $row['kind'] : 'original',
        'blueprintId' => !empty($row['blueprint_id']) ? (string) $row['blueprint_id'] : null,
        'blueprintName' => !empty($row['blueprint_name']) ? (string) $row['blueprint_name'] : null,
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
    // 必须走 current_user()：attach_user() 写入的键是 'current_user'，
    // 直接读 $GLOBALS['__current_user'] 永远拿到 null，
    // 那样 done_count 的子查询整段都不会执行，整卷进度恒为 0（静默出错）。
    $user = current_user();
    return is_array($user) && isset($user['id']) ? (int) $user['id'] : null;
}

/**
 * 列出全部试卷（含题数与当前用户的完成数）。
 *
 * 排序：有考试日期的按日期倒序在前，没有日期的按创建时间倒序在后。
 * 这样「刚考完的卷」总在最上面，首页不必再单独排一次。
 *
 * 题数与完成数都**以 paper_items 为准**（第 2 期起）：
 * 生成的虚拟卷不进 questions.paper_id，只查那里会把它算成 0 题。
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
                         WHERE r.user_id = ?
                           AND r.question_id IN (SELECT question_id FROM paper_items WHERE paper_id = p.id)) AS done_count';
    }

    $params = [];
    if ($userId !== null) {
        $params[] = $userId;
    }

    return query(
        "SELECT p.*,
                (SELECT COUNT(*) FROM paper_items i WHERE i.paper_id = p.id) AS question_count,
                (SELECT b.name FROM blueprints b WHERE b.id = p.blueprint_id) AS blueprint_name,
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
 * 名字撞上一张**虚拟卷**（蓝图生成的）时拒绝而不是塞进去：
 * 虚拟卷的成员由抽题产生、会被「重新生成」整体覆盖，
 * 把真实录入的题塞进去，下一次重新生成就找不回来了。
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
    $existing = query_one('SELECT id, kind FROM papers WHERE name = ?', [$name]);
    if ($existing !== null) {
        if ((string) ($existing['kind'] ?? 'original') === 'generated') {
            throw http_error(400, '试卷名「' . $name . '」已被一张虚拟卷占用。请换一个来源名，或先删除那张虚拟卷。');
        }
        return (string) $existing['id'];
    }
    $id = next_paper_id();
    execute(
        "INSERT INTO papers (id, name, exam_date, note, kind, created_at, updated_at)
         VALUES (?, ?, NULL, '', 'original', datetime('now'), datetime('now'))",
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

/**
 * GET /api/papers/{id} —— 单张试卷与它的题目。
 *
 * 题目以 paper_items 为准（含排序与分篇）：
 * 生成的虚拟卷只有成员表里有归属，查 questions.paper_id 会得到空卷。
 */
function route_papers_show($id)
{
    $row = query_one(
        'SELECT p.*,
                (SELECT COUNT(*) FROM paper_items i WHERE i.paper_id = p.id) AS question_count,
                (SELECT b.name FROM blueprints b WHERE b.id = p.blueprint_id) AS blueprint_name
           FROM papers p WHERE p.id = ?',
        [$id]
    );
    if ($row === null) {
        throw http_error(404, '试卷不存在或已删除');
    }

    $sections = paper_items_grouped($id);

    // questions 保持一层扁平列表（老调用方按数组用），顺序与分篇一致
    $questions = [];
    foreach ($sections as $section) {
        foreach ($section['items'] as $item) {
            if ($item['question'] !== null) {
                $questions[] = $item['question'];
            }
        }
    }

    json_response([
        'paper' => map_paper($row),
        'questions' => $questions,
        'sections' => $sections,
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

    $newName = array_key_exists('name', $body) ? trim((string) $body['name']) : null;
    $oldName = (string) $row['name'];
    $isGenerated = (string) ($row['kind'] ?? 'original') === 'generated';

    db_transaction(function () use ($fields, $params, $newName, $oldName, $id, $isGenerated) {
        execute('UPDATE papers SET ' . implode(', ', $fields) . ' WHERE id = ?', $params);

        // 改了卷名要把 questions.source 一起改。
        //
        // 不改的后果（线上真实发生过）：
        //   ① 收藏是按 source 文本关联的，改名后收藏全部「失效」——题数显示 0，数据还在；
        //   ② 之后再用旧卷名录入，ensure_paper_by_name 找不到这张卷（名字已变），
        //      于是新建一张语义重复的卷，同一场考试裂成两张。
        //
        // 之所以能这么修：source 是 papers.name 的冗余副本，两者本应一致。
        // 长期方案是让 source 单一真源化（见 docs/BANK_REFACTOR_DESIGN.md）。
        //
        // 虚拟卷除外：它的成员来自抽题，题目各自保留真实的 source（来自哪张原卷），
        // 改名不该、也不会影响它们（生成卷成员从不写 questions.paper_id）
        if (!$isGenerated && $newName !== null && $newName !== $oldName) {
            execute('UPDATE questions SET source = ? WHERE paper_id = ?', [$newName, $id]);

            // 收藏也要跟着走。这里用「先补后删」而不是直接 UPDATE：
            // user_favorites 有 UNIQUE(user_id, source)，若某个用户同时收藏了
            // 旧名与新名，直接 UPDATE 会撞唯一约束导致整个改名失败。
            execute(
                'INSERT OR IGNORE INTO user_favorites (user_id, source, note, created_at)
                 SELECT user_id, ?, note, created_at FROM user_favorites WHERE source = ?',
                [$newName, $oldName]
            );
            execute('DELETE FROM user_favorites WHERE source = ?', [$oldName]);
        }
    });

    json_response([
        'ok' => true,
        'paper' => map_paper(query_one(
            // 题数以成员表为准（与列表、详情页同一口径）：
            // 虚拟卷只登记在 paper_items，按 paper_id 数会恒为 0
            "SELECT p.*,
                    (SELECT COUNT(*) FROM paper_items i WHERE i.paper_id = p.id) AS question_count,
                    (SELECT b.name FROM blueprints b WHERE b.id = p.blueprint_id) AS blueprint_name
               FROM papers p WHERE p.id = ?",
            [$id]
        )),
    ]);
}

/**
 * DELETE /api/papers/{id} —— 删除试卷
 *
 * 题目本身不删：只把 paper_id 置空，题目回到「未归卷」状态。
 * 删卷不删题——一套卷子重复录入或归错了组，不该连带丢掉题目本身。
 *
 * 生成的虚拟卷另有一条：它的 member 关系只存在于 paper_items，
 * 从不写 questions.paper_id，所以删它不会（也不该）动题目的原始归属。
 */
function route_papers_delete($id)
{
    require_permission('question:write');

    $row = query_one('SELECT id, kind FROM papers WHERE id = ?', [$id]);
    if ($row === null) {
        throw http_error(404, '试卷不存在或已删除');
    }
    $isGenerated = (string) ($row['kind'] ?? 'original') === 'generated';

    // 把 UPDATE 的实际影响行数带出事务：
    // 原来直接写死 0，前端会据此提示「已解绑 0 道题」，与事实不符
    $unlinked = db_transaction(function () use ($id, $isGenerated) {
        $unlinked = 0;
        if (!$isGenerated) {
            $result = execute('UPDATE questions SET paper_id = NULL WHERE paper_id = ?', [$id]);
            $unlinked = (int) $result['changes'];
        }
        // 生成记录随卷删除：它记的是「这张卷是哪次生成的」，卷没了记录就没意义
        execute('DELETE FROM blueprint_runs WHERE paper_id = ?', [$id]);
        execute('DELETE FROM papers WHERE id = ?', [$id]);
        // 成员投影一并清掉：卷都没了，留着这些行会让「按卷看题」查出已删的卷
        execute('DELETE FROM paper_items WHERE paper_id = ?', [$id]);
        return $unlinked;
    });

    json_response(['ok' => true, 'unlinkedQuestions' => $unlinked, 'wasGenerated' => $isGenerated]);
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
        $target = query_one('SELECT id, kind, name FROM papers WHERE id = ?', [$paperId]);
        if ($target === null) {
            throw http_error(404, '试卷不存在或已删除');
        }
        // 虚拟卷的成员由蓝图抽题产出、会被「重新生成」整体覆盖，
        // 手工把题塞进去等于下次重新生成就丢——直接拒绝并说清去哪改
        if ((string) ($target['kind'] ?? 'original') === 'generated') {
            throw http_error(400, '「' . (string) $target['name'] . '」是蓝图生成的虚拟卷，请在组卷蓝图的成员编辑里调整，或直接重新生成。');
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

            // 投影跟随。目标卷里的顺序保持调用顺序：先到的排前面，
            // 这样「按选择顺序归卷」得到的就是用户看到的选择顺序
            sync_question_paper_item($id, $paperId);
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