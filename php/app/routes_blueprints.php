<?php
/**
 * 组卷蓝图与虚拟卷接口（题库重构第 2 期）。
 *
 * 蓝图 = 可复用的抽题规则；生成 = 按规则抽题并写成一张 kind='generated' 的卷。
 *
 * 三条边界（都与「生成卷不污染原始数据」有关）：
 * 1. 生成卷只写 paper_items，**绝不写 questions.paper_id** —— 那是「主卷」
 *    字段，代表题目真实录入时归属的原卷。生成卷是一次快照，改了它不该
 *    动摇题目的原始归属。
 * 2. 成员编辑（整体替换 / 换一题）只对 generated 卷开放。原始卷的成员
 *    关系由 questions.paper_id 派生，绕过它改 paper_items 会让两份数据打架。
 * 3. 重新生成会整体替换成员，手工调整会被覆盖 —— 接口如实告知，
 *    由前端弹确认。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';
require_once __DIR__ . '/blueprint.php';
require_once __DIR__ . '/routes_papers.php';

/** 生成蓝图 id */
function next_blueprint_id()
{
    return 'bp_' . substr(bin2hex(random_bytes(5)), 0, 10);
}

/** 生成一次 run 的 id */
function next_blueprint_run_id()
{
    return 'br_' . substr(bin2hex(random_bytes(5)), 0, 10);
}

/**
 * 数据库行 -> 前端蓝图对象。
 *
 * @param array $row
 * @return array
 */
function map_blueprint(array $row)
{
    $rules = json_decode((string) ($row['rules_json'] ?? ''), true);
    return [
        'id' => (string) ($row['id'] ?? ''),
        'name' => (string) ($row['name'] ?? ''),
        'description' => (string) ($row['description'] ?? ''),
        'rules' => is_array($rules) ? $rules : null,
        'createdBy' => isset($row['created_by']) ? (int) $row['created_by'] : null,
        'createdAt' => to_iso($row['created_at'] ?? null),
        'updatedAt' => to_iso($row['updated_at'] ?? null),
        // 关联信息由调用方补充（列表页要显示「用过几次、生成过哪张卷」）
    ];
}

/**
 * 校验蓝图名：非空、长度合理、同名拒绝。
 *
 * @param string   $name
 * @param string   $excludeId 更新时排除自己
 */
function assert_blueprint_name($name, $excludeId = '')
{
    $name = trim((string) $name);
    if ($name === '') {
        throw http_error(400, '蓝图名称不能为空');
    }
    if (mb_strlen($name) > 60) {
        throw http_error(400, '蓝图名称不能超过 60 个字');
    }
    $row = query_one('SELECT id FROM blueprints WHERE name = ?', [$name]);
    if ($row !== null && (string) $row['id'] !== $excludeId) {
        throw http_error(409, '同名蓝图已存在');
    }
    return $name;
}

/* ------------------------------------------------------------------ */
/* 蓝图 CRUD                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/blueprints —— 全部蓝图（带生成次数与最近一次生成） */
function route_blueprints_list()
{
    $rows = query('SELECT * FROM blueprints ORDER BY COALESCE(updated_at, created_at) DESC, id');
    $blueprints = array_map('map_blueprint', $rows);

    // 生成次数与最近一张生成的卷：一次聚合查出，避免每条蓝图一次查询
    if (count($blueprints) > 0) {
        $runRows = query(
            'SELECT blueprint_id, COUNT(*) AS runs,
                    MAX(created_at) AS last_at
               FROM blueprint_runs
              GROUP BY blueprint_id'
        );
        $runMap = [];
        foreach ($runRows as $row) {
            $runMap[(string) $row['blueprint_id']] = [
                'runs' => (int) $row['runs'],
                'lastAt' => to_iso($row['last_at']),
            ];
        }

        $paperRows = query(
            "SELECT id, name, blueprint_id, created_at, updated_at
               FROM papers
              WHERE kind = 'generated' AND blueprint_id IS NOT NULL
              ORDER BY created_at DESC"
        );
        $paperMap = [];
        foreach ($paperRows as $row) {
            $bpId = (string) $row['blueprint_id'];
            if (!isset($paperMap[$bpId])) {
                $paperMap[$bpId] = [
                    'id' => (string) $row['id'],
                    'name' => (string) $row['name'],
                    'createdAt' => to_iso($row['created_at']),
                ];
            }
        }

        foreach ($blueprints as $index => $blueprint) {
            $id = $blueprint['id'];
            $blueprints[$index]['runs'] = $runMap[$id]['runs'] ?? 0;
            $blueprints[$index]['lastRunAt'] = $runMap[$id]['lastAt'] ?? null;
            $blueprints[$index]['latestPaper'] = $paperMap[$id] ?? null;
        }
    }

    json_response(['blueprints' => $blueprints]);
}

/** POST /api/blueprints —— 新建蓝图 */
function route_blueprints_create()
{
    $user = require_permission('question:write');
    $body = request_body();

    $name = assert_blueprint_name($body['name'] ?? '');
    $description = isset($body['description']) ? trim((string) $body['description']) : '';
    $rules = blueprint_normalize_rules($body['rules'] ?? null);

    $id = next_blueprint_id();
    execute(
        "INSERT INTO blueprints (id, name, description, rules_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        [$id, $name, $description, json_encode($rules, JSON_UNESCAPED_UNICODE), (int) ($user['id'] ?? 0) ?: null]
    );

    json_response([
        'ok' => true,
        'blueprint' => map_blueprint(query_one('SELECT * FROM blueprints WHERE id = ?', [$id])),
    ], 201);
}

/** GET /api/blueprints/{id} */
function route_blueprints_show($id)
{
    $row = query_one('SELECT * FROM blueprints WHERE id = ?', [$id]);
    if ($row === null) {
        throw http_error(404, '蓝图不存在或已删除');
    }

    $runs = query(
        'SELECT r.*, p.name AS paper_name
           FROM blueprint_runs r
           LEFT JOIN papers p ON p.id = r.paper_id
          WHERE r.blueprint_id = ?
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 20',
        [$id]
    );
    $runList = [];
    foreach ($runs as $run) {
        $result = json_decode((string) ($run['result_json'] ?? ''), true);
        $runList[] = [
            'id' => (string) $run['id'],
            'paperId' => $run['paper_id'] !== null ? (string) $run['paper_id'] : null,
            'paperName' => $run['paper_name'] !== null ? (string) $run['paper_name'] : null,
            'relaxed' => (int) $run['relaxed'] === 1,
            'result' => is_array($result) ? $result : null,
            'createdAt' => to_iso($run['created_at']),
        ];
    }

    json_response([
        'blueprint' => map_blueprint($row),
        'runs' => $runList,
    ]);
}

/** PUT /api/blueprints/{id} */
function route_blueprints_update($id)
{
    require_permission('question:write');

    $row = query_one('SELECT * FROM blueprints WHERE id = ?', [$id]);
    if ($row === null) {
        throw http_error(404, '蓝图不存在或已删除');
    }

    $body = request_body();
    $fields = [];
    $params = [];

    if (array_key_exists('name', $body)) {
        $fields[] = 'name = ?';
        $params[] = assert_blueprint_name($body['name'], $id);
    }
    if (array_key_exists('description', $body)) {
        $fields[] = 'description = ?';
        $params[] = trim((string) $body['description']);
    }
    if (array_key_exists('rules', $body)) {
        $rules = blueprint_normalize_rules($body['rules']);
        $fields[] = 'rules_json = ?';
        $params[] = json_encode($rules, JSON_UNESCAPED_UNICODE);
    }

    if (count($fields) === 0) {
        throw http_error(400, '没有需要更新的字段');
    }

    $fields[] = "updated_at = datetime('now')";
    $params[] = $id;
    execute('UPDATE blueprints SET ' . implode(', ', $fields) . ' WHERE id = ?', $params);

    json_response([
        'ok' => true,
        'blueprint' => map_blueprint(query_one('SELECT * FROM blueprints WHERE id = ?', [$id])),
    ]);
}

/** DELETE /api/blueprints/{id} */
function route_blueprints_delete($id)
{
    require_permission('question:write');

    $row = query_one('SELECT id FROM blueprints WHERE id = ?', [$id]);
    if ($row === null) {
        throw http_error(404, '蓝图不存在或已删除');
    }

    db_transaction(function () use ($id) {
        // 已生成的卷保留（它们已是独立可用的卷），只解除蓝图引用：
        // 删蓝图不该把老师已经发出去练的卷也一起删掉
        execute("UPDATE papers SET blueprint_id = NULL WHERE blueprint_id = ?", [$id]);
        execute('DELETE FROM blueprint_runs WHERE blueprint_id = ?', [$id]);
        execute('DELETE FROM blueprints WHERE id = ?', [$id]);
    });

    json_response(['ok' => true]);
}

/* ------------------------------------------------------------------ */
/* 试抽与生成                                                            */
/* ------------------------------------------------------------------ */

/** POST /api/blueprints/preview —— 按给定规则试抽（不落库） */
function route_blueprints_preview()
{
    require_permission('question:write');
    $body = request_body();

    // 可以传蓝图 id（用库里已保存的规则）或直接传规则对象（编辑器未保存的草稿）
    $rules = null;
    if (!empty($body['blueprintId'])) {
        $row = query_one('SELECT rules_json FROM blueprints WHERE id = ?', [(string) $body['blueprintId']]);
        if ($row === null) {
            throw http_error(404, '蓝图不存在或已删除');
        }
        $rules = json_decode((string) $row['rules_json'], true);
    } elseif (isset($body['rules'])) {
        $rules = $body['rules'];
    }
    if (!is_array($rules)) {
        throw http_error(400, '缺少蓝图规则');
    }

    $normalized = blueprint_normalize_rules($rules);

    // 「有多少给了多少」：试抽不报错，题量不足如实说明
    $result = blueprint_run($normalized);

    // 条件全集下的候选总数：让用户看到「再严格也能抽几道」
    $available = blueprint_count_candidates($normalized['conditions']);

    json_response([
        'ok' => true,
        'available' => $available,
        'result' => blueprint_preview_payload($result),
    ]);
}

/**
 * 把 blueprint_run 的结果裁剪成预览载荷。
 *
 * 包含：每篇的题目（完整对象，前端直接渲染）、放宽说明、缺口数量。
 *
 * @param array $result
 * @return array
 */
function blueprint_preview_payload(array $result)
{
    $byId = [];
    foreach ($result['questions'] as $question) {
        $byId[(string) $question['id']] = $question;
    }

    $sections = [];
    foreach ($result['sections'] as $index => $ids) {
        $items = [];
        foreach ($ids as $id) {
            if (isset($byId[$id])) {
                $items[] = $byId[$id];
            }
        }
        $sections[] = [
            'sectionNo' => $index + 1,
            'questionIds' => array_values($ids),
            'questions' => $items,
        ];
    }

    return [
        'targetTotal' => (int) $result['targetTotal'],
        'drawn' => (int) $result['drawn'],
        'shortfall' => (int) $result['shortfall'],
        'relaxed' => (bool) $result['relaxed'],
        'appliedSteps' => $result['appliedSteps'],
        'notes' => $result['notes'],
        'sections' => $sections,
        'overflow' => (int) $result['overflow'],
        'primaryTags' => $result['primaryTags'],
    ];
}

/**
 * 把分篇结果写进 paper_items（整体替换）。
 *
 * @param string $paperId
 * @param array  $sections 每个元素是一篇的题目 id 列表
 */
function write_generated_paper_items($paperId, array $sections)
{
    execute('DELETE FROM paper_items WHERE paper_id = ?', [$paperId]);

    $order = 0;
    foreach ($sections as $sectionIndex => $ids) {
        foreach ($ids as $questionId) {
            $questionId = trim((string) $questionId);
            if ($questionId === '') {
                continue;
            }
            $order++;
            execute(
                'INSERT OR REPLACE INTO paper_items (paper_id, question_id, order_no, section_no)
                 VALUES (?, ?, ?, ?)',
                [$paperId, $questionId, $order, $sectionIndex + 1]
            );
        }
    }
}

/**
 * 生成一个不重名的卷名：默认「蓝图名 · MM-DD HH:mm」，重名时追加序号。
 *
 * @param string $base
 * @return string
 */
function ensure_unique_paper_name($base)
{
    $base = trim($base);
    if ($base === '') {
        $base = '生成的试卷';
    }
    $name = $base;
    $suffix = 2;
    while (find_paper_by_name($name) !== null) {
        $name = $base . ' (' . $suffix . ')';
        $suffix++;
        if ($suffix > 50) {
            // 极端情况：同分钟内反复生成。加随机串保证必然可用
            $name = $base . ' ' . substr(bin2hex(random_bytes(3)), 0, 6);
            break;
        }
    }
    return $name;
}

/**
 * POST /api/blueprints/{id}/generate —— 按蓝图生成（或重新生成）虚拟卷。
 *
 * Body:
 *   paperId  可选。给了表示「重新生成到这张卷」（必须是生成的卷）；
 *            不给则新建一张卷。
 *   name     可选。新卷的卷名；不给时用「蓝图名 · MM-DD HH:mm」。
 *   rules    可选。用这份规则生成（不保存到蓝图，供「改完直接生成」）。
 *
 * 会先试抽一次：题量不足时如实返回放宽说明，但**仍然生成**
 * （有多少给多少 —— 用户看到说明后可以改规则再生成，或直接用手上的卷）。
 */
function route_blueprints_generate($id)
{
    $user = require_permission('question:write');

    $row = query_one('SELECT * FROM blueprints WHERE id = ?', [$id]);
    if ($row === null) {
        throw http_error(404, '蓝图不存在或已删除');
    }

    $body = request_body();
    $rules = json_decode((string) $row['rules_json'], true);
    if (isset($body['rules'])) {
        $rules = $body['rules'];
    }
    $normalized = blueprint_normalize_rules($rules);

    $paperId = isset($body['paperId']) ? trim((string) $body['paperId']) : '';
    $isRegenerate = $paperId !== '';

    if ($isRegenerate) {
        $paper = query_one('SELECT * FROM papers WHERE id = ?', [$paperId]);
        if ($paper === null) {
            throw http_error(404, '试卷不存在或已删除');
        }
        if ((string) ($paper['kind'] ?? 'original') !== 'generated') {
            throw http_error(400, '只能重新生成由蓝图创建的虚拟卷，原始录入的卷不能这样覆盖');
        }
        // 重新生成必须针对同一张蓝图：允许 blueprint_id 为空（蓝图被删过）
        // 或就是当前蓝图；否则「用 B 的规则重抽一张属于 A 的卷」会让成员、
        // 归属与使用记录三方不一致。这里顺手把归属写正。
        $paperBlueprintId = isset($paper['blueprint_id']) ? (string) $paper['blueprint_id'] : '';
        if ($paperBlueprintId !== '' && $paperBlueprintId !== $id) {
            throw http_error(400, '这张卷是由另一张蓝图生成的。要换成这份蓝图，请删掉它后重新生成。');
        }
    }

    // 重新生成时整体替换成员，不需要排除卷内已有的题；
    // 首次生成同样不排除——题目本来就不该在候选池里出现第二次
    $result = blueprint_run($normalized);

    if ($result['drawn'] === 0) {
        // 一道题都抽不到：不生成空卷（空卷会让用户以为是 bug），
        // 直接把放宽结果作为提示返回
        json_response([
            'ok' => false,
            'error' => '当前条件一道题都抽不到，请检查条件或先录入更多题目',
            'result' => blueprint_preview_payload($result),
        ], 400);
    }

    $runId = next_blueprint_run_id();
    $resultSummary = [
        'targetTotal' => $result['targetTotal'],
        'drawn' => $result['drawn'],
        'shortfall' => $result['shortfall'],
        'relaxed' => $result['relaxed'],
        'appliedSteps' => $result['appliedSteps'],
        'notes' => $result['notes'],
        'sectionCounts' => array_map('count', $result['sections']),
    ];

    $paper = db_transaction(function () use (
        $id, $paperId, $isRegenerate, $body, $row, $result, $resultSummary, $runId, $user, $paper
    ) {
        if ($isRegenerate) {
            execute(
                "UPDATE papers SET updated_at = datetime('now') WHERE id = ?",
                [$paperId]
            );
            // 蓝图此前被删过（blueprint_id 为空）又重新生成：把归属补回来，
            // 否则试卷页的「重新生成」按钮找不到蓝图可用
            if ((string) ($paper['blueprint_id'] ?? '') === '') {
                execute('UPDATE papers SET blueprint_id = ? WHERE id = ?', [$id, $paperId]);
            }
            $finalPaperId = $paperId;
            $created = false;
        } else {
            // 卷名时间用 UTC：库里 datetime('now') 也是 UTC，
            // 混用会让卷名时间与 updated_at 差几个时区
            $defaultName = (string) $row['name'] . ' · ' . gmdate('m-d H:i');
            $name = isset($body['name']) && trim((string) $body['name']) !== ''
                ? trim((string) $body['name'])
                : $defaultName;
            if (find_paper_by_name($name) !== null) {
                $name = ensure_unique_paper_name($name);
            }
            $finalPaperId = next_paper_id();
            execute(
                "INSERT INTO papers (id, name, exam_date, note, kind, blueprint_id, created_at, updated_at)
                 VALUES (?, ?, NULL, ?, 'generated', ?, datetime('now'), datetime('now'))",
                [$finalPaperId, $name, (string) $row['description'], $id]
            );
            $created = true;
        }

        write_generated_paper_items($finalPaperId, $result['sections']);

        execute(
            'INSERT INTO blueprint_runs (id, blueprint_id, paper_id, result_json, relaxed, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))',
            [
                $runId,
                $id,
                $finalPaperId,
                json_encode($resultSummary, JSON_UNESCAPED_UNICODE),
                $result['relaxed'] ? 1 : 0,
                (int) ($user['id'] ?? 0) ?: null,
            ]
        );

        return [
            'id' => $finalPaperId,
            'created' => $created,
        ];
    });

    json_response([
        'ok' => true,
        'paper' => map_paper(query_one(
            "SELECT p.*,
                    (SELECT COUNT(*) FROM paper_items i WHERE i.paper_id = p.id) AS question_count
               FROM papers p WHERE p.id = ?",
            [$paper['id']]
        )),
        'run' => [
            'id' => $runId,
            'created' => $paper['created'],
        ],
        'result' => $resultSummary,
    ], $paper['created'] ? 201 : 200);
}

/* ------------------------------------------------------------------ */
/* 生成卷的成员编辑                                                       */
/* ------------------------------------------------------------------ */

/**
 * GET /api/papers/{id}/items —— 读生成卷的成员（按篇分组）。
 *
 * 原始卷不开放此接口：它的成员由 questions.paper_id 派生，
 * 要看那套数据请走 GET /questions?paperId=。
 */
function route_paper_items_get($id)
{
    require_permission('question:write');

    $paper = query_one('SELECT * FROM papers WHERE id = ?', [$id]);
    if ($paper === null) {
        throw http_error(404, '试卷不存在或已删除');
    }
    if ((string) ($paper['kind'] ?? 'original') !== 'generated') {
        throw http_error(400, '只有蓝图生成的虚拟卷支持成员编辑');
    }

    json_response([
        'paper' => map_paper($paper),
        'sections' => paper_items_grouped($id),
    ]);
}

/**
 * 读一张卷的成员并按篇分组。
 *
 * @param string $paperId
 * @return array 每项：{sectionNo, items: [{orderNo, question}]}
 */
function paper_items_grouped($paperId)
{
    $rows = query(
        'SELECT i.order_no, i.section_no, i.question_id,
                q.id, q.original_sentence, q.blanks_json, q.source, q.paper_id,
                q.schema_version, q.fingerprint, q.publish_status, q.owner_id,
                q.created_at, q.updated_at, q.blank_count
           FROM paper_items i
           LEFT JOIN questions q ON q.id = i.question_id
          WHERE i.paper_id = ?
          ORDER BY i.section_no, i.order_no',
        [$paperId]
    );

    $sections = [];
    foreach ($rows as $row) {
        $sectionNo = (int) $row['section_no'];
        if (!isset($sections[$sectionNo])) {
            $sections[$sectionNo] = ['sectionNo' => $sectionNo, 'items' => []];
        }
        $question = null;
        // LEFT JOIN：题被删了但成员行残留时（理论上不该发生），
        // 这里就不会崩，前端能看到「缺失的题」并清掉它
        if (!empty($row['question_id']) && $row['original_sentence'] !== null) {
            $question = map_question([
                'id' => $row['question_id'],
                'original_sentence' => $row['original_sentence'],
                'blanks_json' => $row['blanks_json'],
                'source' => $row['source'],
                'paper_id' => $row['paper_id'],
                'schema_version' => $row['schema_version'],
                'fingerprint' => $row['fingerprint'],
                'publish_status' => $row['publish_status'],
                'owner_id' => $row['owner_id'],
                'created_at' => $row['created_at'],
                'updated_at' => $row['updated_at'],
            ]);
        }
        $sections[$sectionNo]['items'][] = [
            'orderNo' => (int) $row['order_no'],
            'questionId' => (string) $row['question_id'],
            'question' => $question,
        ];
    }

    return array_values($sections);
}

/**
 * PUT /api/papers/{id}/items —— 整体替换生成卷的成员。
 *
 * Body: { sections: [[questionId, ...], [questionId, ...]] }
 * 篇号 = 数组下标 + 1；order_no 跨篇连续累加。
 *
 * 为什么是整体替换而不是逐条增删：前端本地编辑（删题、移动、换篇）
 * 后提交一次即可，不必为每种操作设计一个接口，也不会出现
 * 「删了一半网络断了」的中间态 —— 一次事务要么全成要么全败。
 */
function route_paper_items_put($id)
{
    require_permission('question:write');

    $paper = query_one('SELECT * FROM papers WHERE id = ?', [$id]);
    if ($paper === null) {
        throw http_error(404, '试卷不存在或已删除');
    }
    if ((string) ($paper['kind'] ?? 'original') !== 'generated') {
        throw http_error(400, '只有蓝图生成的虚拟卷支持成员编辑');
    }

    $body = request_body();
    $sections = isset($body['sections']) && is_array($body['sections']) ? $body['sections'] : null;
    if ($sections === null) {
        throw http_error(400, '缺少 sections 字段');
    }

    // 逐篇校验：必须是数组、id 是字符串、全局不重复
    $seen = [];
    $clean = [];
    foreach ($sections as $index => $ids) {
        if (!is_array($ids)) {
            throw http_error(400, '第 ' . ($index + 1) . ' 篇的题目列表格式不对');
        }
        $list = [];
        foreach ($ids as $questionId) {
            if (!is_string($questionId) || trim($questionId) === '') {
                continue;
            }
            $questionId = trim($questionId);
            if (isset($seen[$questionId])) {
                throw http_error(400, "题目 {$questionId} 在同一张卷子里出现了两次");
            }
            $seen[$questionId] = true;
            $list[] = $questionId;
        }
        $clean[] = $list;
    }

    // 校验题目都存在：不存在的 id 直接写进成员表会产生「点进去 404」的幽灵条目
    $allIds = array_keys($seen);
    $missing = [];
    foreach (array_chunk($allIds, 400) as $chunk) {
        $placeholders = implode(',', array_fill(0, count($chunk), '?'));
        $found = query("SELECT id FROM questions WHERE id IN ($placeholders)", $chunk);
        $foundSet = [];
        foreach ($found as $row) {
            $foundSet[(string) $row['id']] = true;
        }
        foreach ($chunk as $questionId) {
            if (!isset($foundSet[$questionId])) {
                $missing[] = $questionId;
            }
        }
    }
    if (count($missing) > 0) {
        throw http_error(400, '有 ' . count($missing) . ' 道题不存在或已删除：' . implode('、', array_slice($missing, 0, 5)));
    }

    db_transaction(function () use ($id, $clean) {
        write_generated_paper_items($id, $clean);
        execute("UPDATE papers SET updated_at = datetime('now') WHERE id = ?", [$id]);
    });

    json_response([
        'ok' => true,
        'sections' => paper_items_grouped($id),
    ]);
}

/**
 * POST /api/papers/{id}/items/replace —— 换一道题（服务端挑替身）。
 *
 * Body: { questionId, sectionNo? }
 *
 * 替身的来源，按优先级：
 * 1. 卷有蓝图 → 用蓝图条件（全体条件 + 降级），排除卷内已有的题
 * 2. 卷没有蓝图（蓝图被删了）→ 用被换题的「标签」当条件
 * 3. 都没有 → 从整个题库随机（仍然排除卷内题）
 *
 * 直接写库：替换 paper_items 里的那一行（篇与序号不变），
 * 前端刷新后看到新题。比「返回候选让前端提交」少一次往返，
 * 也少一个「候选与提交之间题目被别人删了」的竞态。
 */
function route_paper_item_replace($id)
{
    $user = require_permission('question:write');

    $paper = query_one('SELECT * FROM papers WHERE id = ?', [$id]);
    if ($paper === null) {
        throw http_error(404, '试卷不存在或已删除');
    }
    if ((string) ($paper['kind'] ?? 'original') !== 'generated') {
        throw http_error(400, '只有蓝图生成的虚拟卷支持换题');
    }

    $body = request_body();
    $questionId = isset($body['questionId']) ? trim((string) $body['questionId']) : '';
    if ($questionId === '') {
        throw http_error(400, '请说明要换掉哪道题');
    }

    $itemRow = query_one(
        'SELECT question_id, order_no, section_no FROM paper_items WHERE paper_id = ? AND question_id = ?',
        [$id, $questionId]
    );
    if ($itemRow === null) {
        throw http_error(404, '这道题不在该卷中');
    }

    // 卷内已有的题全部排除：换进来的不能是卷里已经有的
    $existing = query('SELECT question_id FROM paper_items WHERE paper_id = ?', [$id]);
    $exclude = [];
    foreach ($existing as $row) {
        $exclude[] = (string) $row['question_id'];
    }

    // 挑选与写进同一个事务：SQLite 的写事务会串行化，
    // 「挑完替身、题被并发删掉」这个窗口就不存在了
    // （曾经是事务外挑、事务内写，回读 JOIN 到 null 直接 500）
    $replacementId = db_transaction(function () use ($paper, $questionId, $exclude, $id) {
        $replacementId = blueprint_pick_replacement($paper, $questionId, $exclude);
        if ($replacementId === null) {
            return null;
        }
        $updated = execute(
            'UPDATE paper_items SET question_id = ? WHERE paper_id = ? AND question_id = ?',
            [$replacementId, $id, $questionId]
        );
        if ($updated['changes'] === 0) {
            // 成员行已经不在了（这张卷刚被重新生成过）：当作没挑到处理
            return null;
        }
        execute("UPDATE papers SET updated_at = datetime('now') WHERE id = ?", [$id]);
        return $replacementId;
    });

    if ($replacementId === null) {
        throw http_error(409, '题库里找不到可替换的题（卷外的题都不符合条件）。可以先放宽蓝图条件，或录入更多题目。');
    }

    // 回读用单表查询 + 之前读到的位置：JOIN 在极端并发下可能取不到行，
    // 而位置信息本来就是上面查出来的，不必再查一次
    $newRow = query_one('SELECT * FROM questions WHERE id = ?', [$replacementId]);
    if ($newRow === null) {
        // 挑到的题在同一瞬间被删了（事务外）——极少见，但要让用户看到可读的错误
        throw http_error(409, '刚挑到的替换题已被删除，请重试一次。');
    }

    json_response([
        'ok' => true,
        'replaced' => $questionId,
        'item' => [
            'orderNo' => (int) $itemRow['order_no'],
            'sectionNo' => (int) $itemRow['section_no'],
            'questionId' => (string) $replacementId,
            'question' => map_question($newRow),
        ],
    ]);
}

/**
 * 为一道题挑替身。
 *
 * @param array  $paper       卷行
 * @param string $questionId  被换的题
 * @param array  $exclude     排除的题 id
 * @return string|null 替身 id；找不到返回 null
 */
function blueprint_pick_replacement(array $paper, $questionId, array $exclude)
{
    $blueprintId = isset($paper['blueprint_id']) ? (string) $paper['blueprint_id'] : '';
    if ($blueprintId !== '') {
        $blueprint = query_one('SELECT rules_json FROM blueprints WHERE id = ?', [$blueprintId]);
        if ($blueprint !== null) {
            $rules = json_decode((string) $blueprint['rules_json'], true);
            if (is_array($rules)) {
                // 换题只要 1 道，布局无关紧要
                $rules['count'] = 1;
                $rules['layout'] = ['sections' => 1, 'perSection' => 1, 'groupBy' => 'none'];
                $normalized = blueprint_normalize_rules($rules);
                $result = blueprint_run($normalized, $exclude);
                if ($result['drawn'] > 0) {
                    return (string) $result['questions'][0]['id'];
                }
            }
        }
    }

    // 蓝图没了（被删）或抽不到：用被换题的标签兜底 —— 换进来的题
    // 至少应该和原来的题考同一个知识点
    $tagRows = query('SELECT tag_id FROM question_tags WHERE question_id = ? ORDER BY tag_id', [$questionId]);
    $tagIds = [];
    foreach ($tagRows as $row) {
        $tagIds[] = (string) $row['tag_id'];
    }

    if (count($tagIds) > 0) {
        $rules = blueprint_normalize_rules([
            'count' => 1,
            'conditions' => [
                ['type' => 'tag', 'ids' => $tagIds, 'match' => 'any'],
                ['type' => 'publishStatus', 'values' => ['published']],
            ],
            'layout' => ['sections' => 1, 'perSection' => 1],
        ]);
        $result = blueprint_run($rules, $exclude);
        if ($result['drawn'] > 0) {
            return (string) $result['questions'][0]['id'];
        }
    }

    // 最后的兜底：整个题库随机一道（仍然排除卷内题）
    $rules = blueprint_normalize_rules([
        'count' => 1,
        'conditions' => [
            ['type' => 'publishStatus', 'values' => ['published']],
        ],
        'layout' => ['sections' => 1, 'perSection' => 1],
    ]);
    $result = blueprint_run($rules, $exclude);
    if ($result['drawn'] > 0) {
        return (string) $result['questions'][0]['id'];
    }

    return null;
}
