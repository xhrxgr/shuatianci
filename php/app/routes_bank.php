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
    $blanks = json_decode((string) ($row['blanks_json'] ?? '[]'), true);
    return [
        'id' => (string) ($row['id'] ?? ''),
        'originalSentence' => (string) ($row['original_sentence'] ?? ''),
        // 未挖空的完整原文：老题没有这一列时给 null（不是空串），
        // 前端据此区分「没有原文」与「原文是空的」
        'passageText' => isset($row['passage_text']) && trim((string) $row['passage_text']) !== ''
            ? (string) $row['passage_text']
            : null,
        'blanks' => is_array($blanks) ? $blanks : [],
        'source' => (string) ($row['source'] ?? ''),
        'paperId' => !empty($row['paper_id']) ? (string) $row['paper_id'] : null,
        // schema_version 等列一律用 ?? 兜底：调用方少选一列时，
        // 直接取下标会触发 PHP 警告，而警告会被输出到 JSON 响应前面，
        // 前端 JSON.parse 立刻失败——比字段缺失更糟
        'schemaVersion' => (int) ($row['schema_version'] ?? 1),
        // 注意：status / wrongCount 是**每个用户自己的**掌握状态，
        // 由调用方从 user_progress 合并进来；这里的默认值只保证字段存在。
        'status' => 'unmastered',
        'wrongCount' => 0,
        'createdAt' => to_iso($row['created_at'] ?? null),
        // 下面三个是题目自身的属性，与用户无关。
        // 刻意叫 publishStatus 而不是 status —— 后者已被「用户掌握状态」占用，
        // 两个 status 混在一起会让调用方分不清哪个是哪个
        'fingerprint' => (string) ($row['fingerprint'] ?? ''),
        'publishStatus' => (string) ($row['publish_status'] ?? 'published'),
        'ownerId' => isset($row['owner_id']) ? (int) $row['owner_id'] : null,
        'updatedAt' => to_iso($row['updated_at'] ?? null),
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
 * 格式与前端 admin.js 的手动录入保持一致：q_{时间戳36进制}_{随机}。
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

/**
 * GET /api/questions —— 题库列表（公开）
 *
 * 支持的筛选参数（都可组合，全部走参数绑定）：
 *   paperId           按卷
 *   source            按来源（精确）
 *   tag / tags        按标签，可重复传：?tag=t_001&tag=t_006，或 ?tags=t_001,t_006
 *   tagMatch          all（默认，交集）| any（并集）
 *   hintType          含该提示词类型的题：给动词 / 给名词 / 给形容词 / 给副词 / 无提示词
 *   blankCountMin/Max 空格数区间
 *   q                 关键词：原句 / 答案 / 解析 任一命中
 *   publishStatus     发布状态（默认不过滤）
 *   owner             录入人 id
 *   order             created_at(默认,倒序) | updated_at | source | fingerprint
 *   page / pageSize   不给 page 时返回全部（保持老调用方的行为不变）
 *
 * 为什么要服务端筛：以前只有 paperId 一个条件，前端得把整库拉到浏览器里遍历，
 * 按标签筛更是对 38 个子标签各扫一遍全量（O(38n)）。题目上万后打不开。
 */
function route_questions_list()
{
    $where = [];
    $params = [];

    // ---- 按卷 ----
    $paperId = isset($_GET['paperId']) ? trim((string) $_GET['paperId']) : '';
    if ($paperId !== '') {
        if (query_one('SELECT id FROM papers WHERE id = ?', [$paperId]) === null) {
            throw http_error(404, '试卷不存在或已删除');
        }
        // 走成员表而不是 questions.paper_id：成员表才是完整归属关系，
        // 将来一题多卷时这里不用改
        $where[] = 'id IN (SELECT question_id FROM paper_items WHERE paper_id = ?)';
        $params[] = $paperId;
    }

    // ---- 按来源 ----
    $source = isset($_GET['source']) ? trim((string) $_GET['source']) : '';
    if ($source !== '') {
        $where[] = 'source = ?';
        $params[] = $source;
    }

    // ---- 按发布状态 ----
    $publishStatus = isset($_GET['publishStatus']) ? trim((string) $_GET['publishStatus']) : '';
    if ($publishStatus !== '') {
        $where[] = 'publish_status = ?';
        $params[] = $publishStatus;
    }

    // ---- 按录入人 ----
    if (isset($_GET['owner']) && $_GET['owner'] !== '') {
        $where[] = 'owner_id = ?';
        $params[] = (int) $_GET['owner'];
    }

    // ---- 按标签（交集 / 并集）----
    $tagIds = [];
    if (isset($_GET['tag'])) {
        foreach ((array) $_GET['tag'] as $t) {
            $t = trim((string) $t);
            if ($t !== '') {
                $tagIds[$t] = true;
            }
        }
    }
    if (isset($_GET['tags'])) {
        foreach (explode(',', (string) $_GET['tags']) as $t) {
            $t = trim($t);
            if ($t !== '') {
                $tagIds[$t] = true;
            }
        }
    }
    $tagIds = array_keys($tagIds);
    if (count($tagIds) > 0) {
        $placeholders = implode(',', array_fill(0, count($tagIds), '?'));
        $tagMatch = isset($_GET['tagMatch']) && strtolower((string) $_GET['tagMatch']) === 'any' ? 'any' : 'all';
        if ($tagMatch === 'all') {
            // 交集：必须同时挂上这些标签
            $where[] = "id IN (SELECT question_id FROM question_tags WHERE tag_id IN ($placeholders)
                                GROUP BY question_id HAVING COUNT(DISTINCT tag_id) = " . count($tagIds) . ')';
        } else {
            $where[] = "id IN (SELECT question_id FROM question_tags WHERE tag_id IN ($placeholders))";
        }
        foreach ($tagIds as $t) {
            $params[] = $t;
        }
    }

    // ---- 按提示词类型：任意一个空命中即算 ----
    $hintType = isset($_GET['hintType']) ? trim((string) $_GET['hintType']) : '';
    if ($hintType !== '') {
        // JSON1 的 json_each 逐空展开。hintType 取值受限（5 个常量），
        // 但这里仍走参数绑定，不做字符串拼接
        $where[] = "EXISTS (SELECT 1 FROM json_each(questions.blanks_json)
                             WHERE json_extract(value, '$.hintType') = ?)";
        $params[] = $hintType;
    }

    // ---- 按空格数区间 ----
    $blankMin = isset($_GET['blankCountMin']) && $_GET['blankCountMin'] !== '' ? (int) $_GET['blankCountMin'] : null;
    $blankMax = isset($_GET['blankCountMax']) && $_GET['blankCountMax'] !== '' ? (int) $_GET['blankCountMax'] : null;
    // ⚠️ 必须 CAST：db_params 交给 PDO::execute() 批量绑定时，所有值都按
    // TEXT 绑。跟「有类型亲和性的列」比较时 SQLite 会自动转换（所以
    // owner_id = ? 之类没问题），但 json_array_length() 是**计算表达式、
    // 没有亲和性**，此时 `2 >= '2'` 按 SQLite 的类型序（INTEGER < TEXT）
    // 恒为假 —— 实测「>= 2」返回 0 条、「<= 1」返回全部，筛选静默失效。
    if ($blankMin !== null) {
        $where[] = 'json_array_length(blanks_json) >= CAST(? AS INTEGER)';
        $params[] = $blankMin;
    }
    if ($blankMax !== null) {
        $where[] = 'json_array_length(blanks_json) <= CAST(? AS INTEGER)';
        $params[] = $blankMax;
    }

    // ---- 关键词：原句 / 答案 / 解析 任一命中 ----
    $keyword = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
    if ($keyword !== '') {
        // LIKE 的通配符必须转义，否则用户搜 "50%" 会变成「以 50 开头」
        $escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $keyword);
        $like = '%' . $escaped . '%';
        $where[] = "(original_sentence LIKE ? ESCAPE '\\' OR blanks_json LIKE ? ESCAPE '\\')";
        $params[] = $like;
        $params[] = $like;
    }

    $whereSql = count($where) > 0 ? ' WHERE ' . implode(' AND ', $where) : '';

    // ---- 排序：白名单映射，绝不把用户输入拼进 SQL ----
    $orderMap = [
        'created_at' => 'created_at DESC, id',
        'updated_at' => 'COALESCE(updated_at, created_at) DESC, id',
        'source' => 'source ASC, created_at DESC, id',
        'sentence' => 'original_sentence ASC, id',
    ];
    $orderKey = isset($_GET['order']) ? (string) $_GET['order'] : 'created_at';
    $orderSql = $orderMap[$orderKey] ?? $orderMap['created_at'];

    // passage_text 也要选出来：完整原文是题目的一部分，列表页（题库总览）
    // 与详情都要能读到。不选的话 map_question 里那一列永远是 null
    $columns = 'id, original_sentence, passage_text, blanks_json, source, paper_id, schema_version,
                fingerprint, publish_status, owner_id, created_at, updated_at';

    // ---- 分页：不传 page 时返回全部（老调用方行为不变）----
    $page = isset($_GET['page']) && $_GET['page'] !== '' ? max(1, (int) $_GET['page']) : null;
    $pageSize = isset($_GET['pageSize']) && $_GET['pageSize'] !== '' ? (int) $_GET['pageSize'] : 50;
    // 上限 500：一次拉太多会让响应体和前端渲染都变慢
    $pageSize = max(1, min(500, $pageSize));

    $total = scalar_int('SELECT COUNT(*) AS n FROM questions' . $whereSql, $params);

    if ($page === null) {
        $rows = query("SELECT $columns FROM questions$whereSql ORDER BY $orderSql", $params);
        json_response(['questions' => array_map('map_question', $rows), 'total' => $total]);
    }

    $offset = ($page - 1) * $pageSize;
    // LIMIT/OFFSET 用 intval 后的值内联：PDO 在部分驱动下会把绑定的数字当字符串，
    // SQLite 对 LIMIT '50' 是容忍的，但显式整数更保险
    $rows = query(
        "SELECT $columns FROM questions$whereSql ORDER BY $orderSql LIMIT " . (int) $pageSize . ' OFFSET ' . (int) $offset,
        $params
    );

    json_response([
        'questions' => array_map('map_question', $rows),
        'total' => $total,
        'page' => $page,
        'pageSize' => $pageSize,
        'pages' => $pageSize > 0 ? (int) ceil($total / $pageSize) : 1,
    ]);
}

/**
 * POST /api/questions/check-duplicates —— 录入前查重（决策 D5）
 *
 * 传入待录入的题目列表，返回每一题的判定结果：
 *   new       库里没有同原句的题 → 默认勾选
 *   duplicate 有同原句且答案一致 → 默认不勾
 *   diff      有同原句但答案有出入 → 默认不勾，并说明差异
 *
 * 判定规则见 docs/FINGERPRINT_SPEC.md；核心是「同原句 + 答案签名相等才叫重复」。
 * 刻意放在服务端：指纹规则必须与入库时用的完全一致，
 * 若让前端自己算，两边规则一旦漂移就会出现「预览说已存在、入库却变成新增」。
 */
function route_questions_check_duplicates()
{
    require_permission('question:write');

    $body = request_body();
    $list = isset($body['questions']) && is_array($body['questions']) ? $body['questions'] : null;
    if ($list === null || count($list) === 0) {
        throw http_error(400, '缺少待检查的题目');
    }

    // 收集指纹一次查出候选，避免逐题查库（40 道题 = 40 次查询）
    $fingerprints = [];
    $sentences = [];
    foreach ($list as $item) {
        if (!is_array($item)) {
            continue;
        }
        $sentence = isset($item['originalSentence']) ? (string) $item['originalSentence'] : '';
        $fp = sentence_fingerprint($sentence);
        if ($fp !== '') {
            $fingerprints[$fp] = true;
        }
        if ($sentence !== '') {
            $sentences[] = $sentence;
        }
    }

    // 候选池：按指纹查。
    // 顺带把「指纹还没回填（NULL）」的题按原句也捞进来 —— 分批回填期间
    // 仍有一部分题没指纹，只用指纹查会漏判重复。
    $candidatesByFingerprint = [];
    if (count($fingerprints) > 0) {
        $placeholders = implode(',', array_fill(0, count($fingerprints), '?'));
        $rows = query(
            "SELECT id, original_sentence, blanks_json, source, fingerprint
               FROM questions
              WHERE fingerprint IN ($placeholders) OR original_sentence IN (" .
              implode(',', array_fill(0, max(1, count($sentences)), '?')) . ')
              LIMIT 500',
            array_merge(array_keys($fingerprints), $sentences === [] ? [''] : $sentences)
        );

        foreach ($rows as $row) {
            $blanks = json_decode((string) $row['blanks_json'], true);
            $answers = [];
            foreach (is_array($blanks) ? $blanks : [] as $blank) {
                if (!is_array($blank)) {
                    continue;
                }
                foreach ((array) ($blank['answer'] ?? []) as $a) {
                    $answers[] = $a;
                }
            }
            $fp = (string) ($row['fingerprint'] ?? '');
            if ($fp === '') {
                $fp = sentence_fingerprint((string) $row['original_sentence']);
            }
            if (!isset($candidatesByFingerprint[$fp])) {
                $candidatesByFingerprint[$fp] = [];
            }
            $candidatesByFingerprint[$fp][] = [
                'id' => (string) $row['id'],
                'originalSentence' => (string) $row['original_sentence'],
                'answers' => $answers,
                'source' => (string) $row['source'],
            ];
        }
    }

    $results = [];
    $summary = ['new' => 0, 'duplicate' => 0, 'diff' => 0];
    // 批内去重：40 道题里若有两道一模一样，第二道也要标出来
    $seenInBatch = [];

    foreach ($list as $index => $item) {
        if (!is_array($item)) {
            $results[] = ['index' => $index, 'state' => 'new', 'matched' => [], 'hint' => ''];
            $summary['new']++;
            continue;
        }

        $sentence = isset($item['originalSentence']) ? (string) $item['originalSentence'] : '';
        $answers = [];
        foreach ((array) ($item['blanks'] ?? []) as $blank) {
            if (!is_array($blank)) {
                continue;
            }
            foreach ((array) ($blank['answer'] ?? []) as $a) {
                $answers[] = $a;
            }
        }

        $fp = sentence_fingerprint($sentence);
        $candidates = $candidatesByFingerprint[$fp] ?? [];

        // 把批内先出现的同原句题目也当作候选——它们的答案我们已经知道
        if (isset($seenInBatch[$fp])) {
            $candidates = array_merge($candidates, [$seenInBatch[$fp]]);
        }

        $verdict = classify_duplicate($sentence, $answers, $candidates);

        if ($verdict['state'] === 'new' && $fp !== '' && !isset($seenInBatch[$fp])) {
            // 第一道「新」题登记进批内表，供后续同原句的题比对
            $seenInBatch[$fp] = [
                'id' => '本批第 ' . ((int) $index + 1) . ' 题',
                'originalSentence' => $sentence,
                'answers' => $answers,
                'source' => '',
            ];
        }

        $summary[$verdict['state']]++;
        $results[] = [
            'index' => (int) $index,
            'fingerprint' => $fp,
            'state' => $verdict['state'],
            'hint' => $verdict['hint'],
            // 只回传必要字段，避免把整题的解析都塞进响应
            'matched' => array_map(function ($c) {
                return [
                    'id' => (string) ($c['id'] ?? ''),
                    'source' => (string) ($c['source'] ?? ''),
                    'originalSentence' => (string) ($c['originalSentence'] ?? ''),
                ];
            }, array_slice($verdict['matched'], 0, 5)),
        ];
    }

    json_response(['ok' => true, 'results' => $results, 'summary' => $summary]);
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
    $user = require_permission('question:write');
    $ownerId = (int) ($user['id'] ?? 0);

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
    $result = db_transaction(function () use ($valid, $replaceAll, $ownerId) {
        if ($replaceAll) {
            execute('DELETE FROM questions');
            // 投影表跟着清空：题目都没了，投影留着就是孤儿行，
            // 会让「按标签筛题」命中不存在的题目
            execute('DELETE FROM question_tags');
            execute('DELETE FROM question_hints');
            execute('DELETE FROM paper_items');
        }

        $added = 0;
        $renamed = 0;
        $attempt = 0;

        foreach ($valid as $question) {
            $id = isset($question['id']) && is_string($question['id']) ? trim($question['id']) : '';
            $source = !empty($question['source']) ? trim((string) $question['source']) : '手动录入';

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

            $sentence = isset($question['originalSentence']) ? (string) $question['originalSentence'] : '';
            $blanks = isset($question['blanks']) && is_array($question['blanks']) ? $question['blanks'] : [];
            $paperId = ensure_paper_by_name($source);
            $createdAt = to_sql_date(isset($question['createdAt']) ? $question['createdAt'] : null);
            // 完整原文可空：没填就不给上下文对照，老题与单句题都是这个形态
            $passage = normalize_passage_text(isset($question['passageText']) ? $question['passageText'] : null);

            execute(
                'INSERT INTO questions
                   (id, original_sentence, passage_text, blanks_json, source, paper_id, schema_version,
                    fingerprint, content_hash, owner_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $id,
                    $sentence,
                    $passage,
                    json_encode($blanks, JSON_UNESCAPED_UNICODE),
                    $source,
                    $paperId,
                    isset($question['schemaVersion']) ? $question['schemaVersion'] : 1,
                    // 指纹与内容摘要是派生数据，写入时就算好并落库：
                    // 查重与「内容是否真的变了」都靠它们，不能等到用时才算
                    sentence_fingerprint($sentence),
                    compute_content_hash($sentence, $blanks),
                    $ownerId > 0 ? $ownerId : null,
                    $createdAt,
                    $createdAt,
                ]
            );

            // 同步投影（题级标签 + 提示词 + 空格数 + 试卷成员），与题目同事务：
            // 否则会出现「筛得到但点不开」的幽灵题
            sync_question_tags($id, $blanks);
            sync_question_hints($id, $blanks);
            sync_question_paper_item($id, $paperId);
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
    // 完整原文：显式传 null 表示清除（老题补录后想删掉）
    if (array_key_exists('passageText', $patch)) {
        $fields[] = 'passage_text = ?';
        $values[] = normalize_passage_text($patch['passageText']);
    }

    // 显式指定所属试卷（null 表示移出该卷）
    if (array_key_exists('paperId', $patch)) {
        $paperId = $patch['paperId'];
        if ($paperId === null || $paperId === '') {
            $fields[] = 'paper_id = ?';
            $values[] = null;
        } else {
            $paperId = (string) $paperId;
            $target = query_one('SELECT id, kind, name FROM papers WHERE id = ?', [$paperId]);
            if ($target === null) {
                throw http_error(404, '试卷不存在或已删除');
            }
            // 与 route_questions_set_paper 同一道闸：虚拟卷的成员由蓝图抽题产出、
            // 会被「重新生成」整体覆盖。走这条路径把题塞进去，等于让它悄悄消失
            if ((string) ($target['kind'] ?? 'original') === 'generated') {
                throw http_error(400, '「' . (string) $target['name'] . '」是蓝图生成的虚拟卷，请在组卷蓝图的成员编辑里调整，或直接重新生成。');
            }
            $fields[] = 'paper_id = ?';
            $values[] = $paperId;
        }
    }

    if (count($fields) === 0) {
        throw http_error(400, '没有需要更新的字段');
    }

    // 与新增走同一套校验：未提及的字段取库里的现值一起校验，
    // 否则「只改 blanks 不改原句」会让空格数量与 blanks 数量对不上
    $rows = query('SELECT id, original_sentence, passage_text, blanks_json, source, paper_id FROM questions WHERE id = ?', [$id]);
    if (count($rows) === 0) {
        throw http_error(404, '题目不存在或已删除');
    }
    $row = $rows[0];

    $merged = [
        'id' => $row['id'],
        'originalSentence' => array_key_exists('originalSentence', $patch)
            ? $patch['originalSentence']
            : $row['original_sentence'],
        'passageText' => array_key_exists('passageText', $patch)
            ? $patch['passageText']
            : ($row['passage_text'] ?? null),
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

    // 改了来源但没指定试卷时，按试卷名自动归卷——
    // 同一场考试再次录入时，题目会落到同一张卷子下
    if (array_key_exists('source', $patch) && !array_key_exists('paperId', $patch)) {
        $fields[] = 'paper_id = ?';
        $values[] = ensure_paper_by_name($merged['source']);
    }

    // 内容变了就重算指纹与摘要。原句改动直接影响查重判定，
    // 不重算会拿旧指纹去比，把改过的题误判成重复。
    $finalBlanks = is_array($merged['blanks']) ? $merged['blanks'] : [];
    $fields[] = 'fingerprint = ?';
    $values[] = sentence_fingerprint((string) $merged['originalSentence']);
    $fields[] = 'content_hash = ?';
    $values[] = compute_content_hash((string) $merged['originalSentence'], $finalBlanks);
    // 改动留痕：此前 questions 表没有这一列，何时改的无从查起
    $fields[] = "updated_at = datetime('now')";

    $result = db_transaction(function () use ($fields, $values, $id, $finalBlanks) {
        // WHERE id = ? 的参数放最后
        $values[] = $id;
        $r = execute('UPDATE questions SET ' . implode(', ', $fields) . ' WHERE id = ?', $values);

        // 投影重建：标签整体重算（增删空位会改变并集），
        // 提示词与空格数副本同理
        sync_question_tags($id, $finalBlanks);
        sync_question_hints($id, $finalBlanks);

        $paperRow = query_one('SELECT paper_id FROM questions WHERE id = ?', [$id]);
        $finalPaper = $paperRow === null ? null : $paperRow['paper_id'];
        // 卷没变就保持原题序；换卷则追加到新卷末尾
        //（沿用旧序号会和目标卷里已有的题撞号）
        // 只看原始卷的归属行：虚拟卷的成员是快照，不参与这里的顺序判断
        $prev = query_one(
            "SELECT i.paper_id, i.order_no
               FROM paper_items i
               JOIN papers p ON p.id = i.paper_id
              WHERE i.question_id = ? AND p.kind = 'original'",
            [$id]
        );
        $keepOrder = ($prev !== null && (string) $prev['paper_id'] === (string) $finalPaper)
            ? (int) $prev['order_no']
            : null;
        sync_question_paper_item($id, $finalPaper, $keepOrder);

        return $r;
    });

    if ($result['affectedRows'] === 0) {
        throw http_error(404, '题目不存在或已删除');
    }
    json_response(['ok' => true]);
}

/** DELETE /api/questions/{id} */
function route_questions_delete($id)
{
    require_permission('question:write');

    // 题目与投影同事务：留着投影会产生「按标签筛得到、点进去题目不存在」的幽灵条目
    $result = db_transaction(function () use ($id) {
        $r = execute('DELETE FROM questions WHERE id = ?', [$id]);
        if ($r['affectedRows'] === 0) {
            return $r;
        }
        execute('DELETE FROM question_tags WHERE question_id = ?', [$id]);
        execute('DELETE FROM question_hints WHERE question_id = ?', [$id]);
        execute('DELETE FROM paper_items WHERE question_id = ?', [$id]);
        return $r;
    });

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

    // parentId 必须指向本次提交里真实存在的标签，且不能是自己。
    // 服务端原先完全不校验：传一个不存在的 parentId 会造出悬空父级，
    // 传自己会造出环 —— 两种都会让标签树渲染不出来，而前端是照单全收。
    $idSet = [];
    foreach ($tags as $tag) {
        $idSet[(string) $tag['id']] = true;
    }
    foreach ($tags as $tag) {
        $parentId = isset($tag['parentId']) ? $tag['parentId'] : null;
        if ($parentId === null || $parentId === '') {
            continue;
        }
        $parentId = (string) $parentId;
        if ($parentId === (string) $tag['id']) {
            throw http_error(400, "标签「{$tag['name']}」的父级指向自己，已拒绝保存");
        }
        if (!isset($idSet[$parentId])) {
            throw http_error(400, "标签「{$tag['name']}」的父级不存在（{$parentId}），已拒绝保存");
        }
    }

    // 全量覆盖放进事务，中途失败回滚
    // ⚠️ $idSet 必须一起 use 进来：漏掉它会让闭包内的 $idSet 变成未定义变量，
    // 而 `isset($idSet[$tagId])` 对未定义变量**不报错、直接返回 false** ——
    // 结果是清理时把每道题的标签**全部**删光，而不是只删被移除的那些。
    // 这是一个静默的数据损坏，靠断言「其余标签保留」才抓到。
    $result = db_transaction(function () use ($tags, $idSet) {
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

        // 删标签必须连引用一起清掉。
        //
        // 原先只重建 tags 表、完全不动 question（blanks_json 是 TEXT，没有外键），
        // 于是题里留着悬空的 tagId：统计照旧把它算进用量、编辑弹窗静默不显示、
        // 按标签筛题再也筛不出这些题 —— 「标签信息永久静默丢失，但垃圾 id 留在库里」。
        $orphanIds = query('SELECT DISTINCT tag_id FROM question_tags WHERE tag_id NOT IN (SELECT id FROM tags)');
        $cleaned = 0;
        if (count($orphanIds) > 0) {
            // 哪些题受影响（要在删投影行之前查）
            $affected = query(
                'SELECT DISTINCT question_id FROM question_tags WHERE tag_id NOT IN (SELECT id FROM tags)'
            );
            execute('DELETE FROM question_tags WHERE tag_id NOT IN (SELECT id FROM tags)');

            foreach ($affected as $row) {
                $questionId = (string) $row['question_id'];
                $q = query_one('SELECT original_sentence, blanks_json FROM questions WHERE id = ?', [$questionId]);
                if ($q === null) {
                    continue;
                }
                $blanks = json_decode((string) $q['blanks_json'], true);
                if (!is_array($blanks)) {
                    continue;
                }
                $touched = false;
                foreach ($blanks as $i => $blank) {
                    if (!is_array($blank) || !isset($blank['tagIds']) || !is_array($blank['tagIds'])) {
                        continue;
                    }
                    $kept = [];
                    foreach ($blank['tagIds'] as $tagId) {
                        if (isset($idSet[(string) $tagId])) {
                            $kept[] = $tagId;
                        } else {
                            $touched = true;
                        }
                    }
                    $blanks[$i]['tagIds'] = $kept;
                }
                if (!$touched) {
                    continue;
                }
                // 内容变了，摘要也要跟着重算，否则「内容是否真的变了」的判断会失真
                execute(
                    'UPDATE questions SET blanks_json = ?, content_hash = ?, updated_at = datetime(\'now\') WHERE id = ?',
                    [
                        json_encode($blanks, JSON_UNESCAPED_UNICODE),
                        compute_content_hash((string) $q['original_sentence'], $blanks),
                        $questionId,
                    ]
                );
                $cleaned++;
            }
        }

        return ['written' => $written, 'cleanedQuestions' => $cleaned, 'removedTags' => count($orphanIds)];
    });

    json_response([
        'ok' => true,
        'count' => $result['written'],
        'cleanedQuestions' => $result['cleanedQuestions'],
        'removedTags' => $result['removedTags'],
    ]);
}

/** POST /api/bank/reset —— 清空题库与标签（危险操作） */
function route_bank_reset()
{
    require_permission('question:write');
    $cleared = db_transaction(function () {
        // 先解绑再删卷：papers 留着会变成永久空卷——
        // 题目都删了，卷子列表里还挂着一堆 0 题的记录
        execute('UPDATE questions SET paper_id = NULL WHERE paper_id IS NOT NULL');

        // 蓝图也要一并清掉：蓝图条件里引用标签 id，标签清空后
        // 规则全部失效，留着只会让用户以为「还能按它抽题」
        $blueprints = execute('DELETE FROM blueprints');

        execute('DELETE FROM papers');
        execute('DELETE FROM questions');
        execute('DELETE FROM tags');
        // 投影表一并清空，否则清库后「按标签筛题」「按卷看题」还会命中已删数据
        execute('DELETE FROM question_tags');
        execute('DELETE FROM question_hints');
        execute('DELETE FROM paper_items');
        execute('DELETE FROM blueprint_runs');

        return (int) $blueprints['changes'];
    });
    json_response(['ok' => true, 'clearedBlueprints' => $cleared]);
}
