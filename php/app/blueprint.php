<?php
/**
 * 组卷蓝图：规则校验 + 抽题引擎 + 分篇（题库重构第 2 期）。
 *
 * 规则格式见 docs/BANK_REFACTOR_DESIGN.md §4.3。核心思想：
 *
 * 1. **规则是纯数据**（rules_json）：条件 + 数量 + 分篇布局 + 降级步骤。
 *    引擎只认这份数据，UI 怎么编辑与它无关。
 * 2. **抽取全走索引**：标签、提示词类型、空格数都是投影表/投影列
 *    （question_tags / question_hints / questions.blank_count），
 *    不解析 blanks_json —— 几万题的库上 json_each 逐行解析是秒级开销。
 * 3. **题量不足时降级而不是报错**：按 relaxSteps 逐步放宽条件，
 *    每一步都如实记录放宽了什么，让用户看见「这套卷为什么长这样」。
 *    宁可给一套少一点的卷 + 明确说明，也不要一个「抽不出来」的死路。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/errors.php';
require_once __DIR__ . '/validate.php';

/** 允许的降级步骤，顺序即默认顺序（越靠前越先被放宽） */
function blueprint_relax_step_names()
{
    return ['dropHintType', 'dropBlankCount', 'dropSource', 'dropTag'];
}

/** 单次生成的题量上限。太大会让一个请求做太多事（插几千行、渲染几千个预览） */
const BLUEPRINT_MAX_COUNT = 500;

/** 单份卷的篇数上限 */
const BLUEPRINT_MAX_SECTIONS = 50;

/**
 * 校验并归一化规则。抛 400 说明具体哪里不对，不静默丢弃。
 *
 * 归一化的意义：引擎内只处理一种形状（缺省值已填好、类型已转好），
 * 下游代码不必到处写 ?? 兜底。
 *
 * @param mixed $rules
 * @return array
 */
function blueprint_normalize_rules($rules)
{
    if (!is_array($rules)) {
        throw http_error(400, '蓝图规则必须是一个对象');
    }

    $conditions = [];
    $rawConditions = isset($rules['conditions']) && is_array($rules['conditions']) ? $rules['conditions'] : [];
    foreach ($rawConditions as $index => $condition) {
        if (!is_array($condition) || !isset($condition['type'])) {
            throw http_error(400, '第 ' . ($index + 1) . ' 个条件缺少类型');
        }
        $type = (string) $condition['type'];
        switch ($type) {
            case 'tag':
                $ids = blueprint_string_list($condition['ids'] ?? []);
                if (count($ids) === 0) {
                    throw http_error(400, '标签条件至少要选一个标签');
                }
                $conditions[] = [
                    'type' => 'tag',
                    'ids' => $ids,
                    'match' => (isset($condition['match']) && strtolower((string) $condition['match']) === 'any') ? 'any' : 'all',
                ];
                break;

            case 'hintType':
                $values = blueprint_string_list($condition['values'] ?? []);
                $allowed = hint_types();
                foreach ($values as $value) {
                    if (!in_array($value, $allowed, true)) {
                        throw http_error(400, "提示词类型「{$value}」不是合法值");
                    }
                }
                if (count($values) === 0) {
                    throw http_error(400, '提示词条件至少要选一种类型');
                }
                $conditions[] = ['type' => 'hintType', 'values' => array_values(array_unique($values))];
                break;

            case 'blankCount':
                $min = isset($condition['min']) && $condition['min'] !== '' && $condition['min'] !== null
                    ? (int) $condition['min'] : null;
                $max = isset($condition['max']) && $condition['max'] !== '' && $condition['max'] !== null
                    ? (int) $condition['max'] : null;
                if ($min !== null && ($min < 1 || $min > BLUEPRINT_MAX_COUNT)) {
                    throw http_error(400, '空格数下限必须在 1-' . BLUEPRINT_MAX_COUNT . ' 之间');
                }
                if ($max !== null && ($max < 1 || $max > BLUEPRINT_MAX_COUNT)) {
                    throw http_error(400, '空格数上限必须在 1-' . BLUEPRINT_MAX_COUNT . ' 之间');
                }
                if ($min !== null && $max !== null && $min > $max) {
                    throw http_error(400, '空格数下限不能大于上限');
                }
                if ($min === null && $max === null) {
                    throw http_error(400, '空格数条件至少要给一个下限或上限');
                }
                $conditions[] = ['type' => 'blankCount', 'min' => $min, 'max' => $max];
                break;

            case 'source':
                $include = blueprint_string_list($condition['include'] ?? []);
                $exclude = blueprint_string_list($condition['exclude'] ?? []);
                if (count($include) === 0 && count($exclude) === 0) {
                    throw http_error(400, '来源条件至少要给一个包含或排除的卷名');
                }
                $conditions[] = ['type' => 'source', 'include' => $include, 'exclude' => $exclude];
                break;

            case 'publishStatus':
                $values = blueprint_string_list($condition['values'] ?? []);
                if (count($values) === 0) {
                    throw http_error(400, '发布状态条件至少要选一种状态');
                }
                $conditions[] = ['type' => 'publishStatus', 'values' => array_values(array_unique($values))];
                break;

            default:
                throw http_error(400, "不支持的条件类型「{$type}」");
        }
    }

    // 没显式给发布状态时补一条 published：
    // 抽题永远不该把草稿/下架的题混进学生的卷子（决策 D2 的另一面）。
    // 显式给了就尊重调用方（第 3 期的审核流会用到 draft）。
    $hasStatus = false;
    foreach ($conditions as $condition) {
        if ($condition['type'] === 'publishStatus') {
            $hasStatus = true;
            break;
        }
    }
    if (!$hasStatus) {
        $conditions[] = ['type' => 'publishStatus', 'values' => ['published']];
    }

    // ---- 分篇布局 ----
    $layout = [];
    $rawLayout = isset($rules['layout']) && is_array($rules['layout']) ? $rules['layout'] : [];
    $sections = isset($rawLayout['sections']) && $rawLayout['sections'] !== '' ? (int) $rawLayout['sections'] : 0;
    $perSection = isset($rawLayout['perSection']) && $rawLayout['perSection'] !== '' ? (int) $rawLayout['perSection'] : 0;
    if ($sections < 0 || $sections > BLUEPRINT_MAX_SECTIONS) {
        throw http_error(400, '篇数要在 0-' . BLUEPRINT_MAX_SECTIONS . ' 之间（0 表示按题量自动推导）');
    }
    if ($perSection < 0 || $perSection > BLUEPRINT_MAX_COUNT) {
        throw http_error(400, '每篇题数要在 0-' . BLUEPRINT_MAX_COUNT . ' 之间（0 表示按题量自动推导）');
    }
    $layout['sections'] = $sections;
    $layout['perSection'] = $perSection;
    $layout['groupBy'] = (isset($rawLayout['groupBy']) && (string) $rawLayout['groupBy'] === 'tag') ? 'tag' : 'none';

    // ---- 目标题量 ----
    // 篇数 × 每篇题数优先于裸 count：两者都填时以布局为准（布局是更具体的意图）
    $count = isset($rules['count']) && $rules['count'] !== '' ? (int) $rules['count'] : 0;
    if ($sections > 0 && $perSection > 0) {
        $count = $sections * $perSection;
    }
    if ($count < 1) {
        throw http_error(400, '请给出目标题数，或同时给「篇数」与「每篇题数」');
    }
    if ($count > BLUEPRINT_MAX_COUNT) {
        throw http_error(400, '单次生成的题量不能超过 ' . BLUEPRINT_MAX_COUNT . ' 道');
    }
    if ($sections > 0 && $perSection === 0) {
        // 只给了篇数：总量由 count 决定，每篇题数按总量均分（引擎按实际情况分配）
        $perSection = (int) ceil($count / $sections);
        if ($perSection > BLUEPRINT_MAX_COUNT) {
            throw http_error(400, '按「篇数」均分后每篇题数超过 ' . BLUEPRINT_MAX_COUNT . '，请调整篇数或题量');
        }
        $layout['perSection'] = $perSection;
    } elseif ($sections === 0 && $perSection > 0) {
        $sections = (int) ceil($count / $perSection);
        // ⚠️ 推导出来的篇数也要复查上限：上面的检查只管显式传入的值。
        // {count:500, perSection:1} 会推出 500 篇，而 BLUEPRINT_MAX_SECTIONS 是 50 ——
        // 题量上限拦不住它（两个上限互相独立），于是白跑 500 桶 × 500 题的分组。
        if ($sections > BLUEPRINT_MAX_SECTIONS) {
            throw http_error(400, '按「每篇题数」推导出的篇数超过 ' . BLUEPRINT_MAX_SECTIONS . '，请调整每篇题数或总题量');
        }
        $layout['sections'] = $sections;
    } elseif ($sections === 0) {
        // 既没给布局也没法推导：单篇
        $layout['sections'] = 1;
        $layout['perSection'] = $count;
    }

    // ---- 降级 ----
    $rawFallback = isset($rules['fallback']) && is_array($rules['fallback']) ? $rules['fallback'] : [];
    $steps = [];
    // 显式给了 relaxSteps 就照单全收（哪怕是空数组 = 一步都不放宽）：
    // 前端编辑器里的复选框就是让老师关掉某一步的，
    // 这里再「补全」会让界面承诺与实际行为相反——预览说放宽了标签，
    // 而老师说好了不放宽。
    // 只有整个 fallback 都没给时才用默认全顺序。
    $requested = array_key_exists('relaxSteps', $rawFallback) && is_array($rawFallback['relaxSteps'])
        ? $rawFallback['relaxSteps']
        : blueprint_relax_step_names();
    foreach ($requested as $step) {
        $step = (string) $step;
        if (in_array($step, blueprint_relax_step_names(), true) && !in_array($step, $steps, true)) {
            $steps[] = $step;
        }
    }

    return [
        'count' => $count,
        'conditions' => $conditions,
        'layout' => $layout,
        'fallback' => [
            'onInsufficient' => 'relax',
            'relaxSteps' => $steps,
        ],
    ];
}

/**
 * 把外部传入的值收敛成「非空字符串数组」。
 *
 * @param mixed $value
 * @return string[]
 */
function blueprint_string_list($value)
{
    if (!is_array($value)) {
        return [];
    }
    $list = [];
    foreach ($value as $item) {
        if (!is_string($item) && !is_int($item) && !is_float($item)) {
            continue;
        }
        $item = trim((string) $item);
        if ($item !== '') {
            $list[$item] = true;
        }
    }
    return array_keys($list);
}

/**
 * 把「启用中的条件」翻译成 SQL 片段。
 *
 * @param array $conditions  已归一化的条件数组
 * @param array $enabled     启用的条件类型集合，如 ['tag'=>true,'hintType'=>true]
 * @param array $params      输出：绑定参数
 * @return string[]          SQL 条件片段
 */
function blueprint_condition_sql(array $conditions, array $enabled, array &$params)
{
    $where = [];
    foreach ($conditions as $condition) {
        $type = $condition['type'];
        // publishStatus 不参与降级：它是「只抽已发布的题」这个安全底线，
        // 放宽它会把草稿题混进学生的卷子
        if ($type !== 'publishStatus' && empty($enabled[$type])) {
            continue;
        }

        switch ($type) {
            case 'tag':
                $placeholders = implode(',', array_fill(0, count($condition['ids']), '?'));
                if ($condition['match'] === 'all') {
                    // 交集：必须同时挂上这些标签。
                    // 用 COUNT(*) 而不是 COUNT(DISTINCT tag_id)：question_tags 的
                    // 主键就是 (question_id, tag_id)，同题同标签不可能出现两行
                    $where[] = "id IN (SELECT question_id FROM question_tags
                                        WHERE tag_id IN ($placeholders)
                                        GROUP BY question_id
                                       HAVING COUNT(*) = " . count($condition['ids']) . ')';
                } else {
                    $where[] = "id IN (SELECT question_id FROM question_tags WHERE tag_id IN ($placeholders))";
                }
                foreach ($condition['ids'] as $id) {
                    $params[] = $id;
                }
                break;

            case 'hintType':
                $placeholders = implode(',', array_fill(0, count($condition['values']), '?'));
                $where[] = "id IN (SELECT question_id FROM question_hints WHERE hint_type IN ($placeholders))";
                foreach ($condition['values'] as $value) {
                    $params[] = $value;
                }
                break;

            case 'blankCount':
                // blank_count 是有 INTEGER 亲和性的列，绑参按 TEXT 也能正确比较；
                // 仍显式 CAST 是为了与第 1 期的教训保持一致：凡是数值比较都不赌隐式转换
                if ($condition['min'] !== null) {
                    $where[] = 'blank_count >= CAST(? AS INTEGER)';
                    $params[] = $condition['min'];
                }
                if ($condition['max'] !== null) {
                    $where[] = 'blank_count <= CAST(? AS INTEGER)';
                    $params[] = $condition['max'];
                }
                break;

            case 'source':
                if (count($condition['include']) > 0) {
                    $placeholders = implode(',', array_fill(0, count($condition['include']), '?'));
                    $where[] = "source IN ($placeholders)";
                    foreach ($condition['include'] as $name) {
                        $params[] = $name;
                    }
                }
                if (count($condition['exclude']) > 0) {
                    $placeholders = implode(',', array_fill(0, count($condition['exclude']), '?'));
                    $where[] = "source NOT IN ($placeholders)";
                    foreach ($condition['exclude'] as $name) {
                        $params[] = $name;
                    }
                }
                break;

            case 'publishStatus':
                $placeholders = implode(',', array_fill(0, count($condition['values']), '?'));
                $where[] = "publish_status IN ($placeholders)";
                foreach ($condition['values'] as $value) {
                    $params[] = $value;
                }
                break;
        }
    }

    // 没有显式排除「未回填」的行：blank_count IS NULL 与任何数值比较都是 NULL
    // （SQLite 三值逻辑），>= 与 <= 都取不到它，天然就被排除了。
    // 回填跑完（写入侧已同步、迁移也已落标记）后不会再有这种行。
    return $where;
}

/**
 * 数一数当前条件下有多少道候选题（不含排除项）。
 *
 * 预览用：让用户在选择条件时就看到「这样能抽到几道题」，
 * 而不是生成完才发现只有 3 道。
 *
 * @param array $conditions 归一化后的条件
 * @param array $excludeIds
 * @return int
 */
function blueprint_count_candidates(array $conditions, array $excludeIds = [])
{
    $enabled = [];
    foreach (blueprint_relax_step_names() as $step) {
        $enabled[blueprint_step_to_type($step)] = true;
    }

    $params = [];
    $where = blueprint_condition_sql($conditions, $enabled, $params);
    blueprint_append_exclude_sql($excludeIds, $where, $params);

    $sql = 'SELECT COUNT(*) AS n FROM questions';
    if (count($where) > 0) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    return scalar_int($sql, $params);
}

/** 降级步骤名 -> 条件类型名 */
function blueprint_step_to_type($step)
{
    $map = [
        'dropHintType' => 'hintType',
        'dropBlankCount' => 'blankCount',
        'dropSource' => 'source',
        'dropTag' => 'tag',
    ];
    return $map[$step] ?? '';
}

/**
 * 把排除列表接到 WHERE 上。
 *
 * @param array $excludeIds
 * @param array $where  就地追加
 * @param array $params 就地追加
 */
function blueprint_append_exclude_sql(array $excludeIds, array &$where, array &$params)
{
    $ids = blueprint_string_list($excludeIds);
    if (count($ids) === 0) {
        return;
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $where[] = "id NOT IN ($placeholders)";
    foreach ($ids as $id) {
        $params[] = $id;
    }
}

/**
 * 按规则抽题（不含分篇）。返回题目行数组。
 *
 * 降级流程：先用全部条件抽目标数量；不够就按 relaxSteps 的顺序
 * 依次放弃一个条件再抽。每次放宽都记账，最后一起返回。
 *
 * @param array $rules       归一化后的规则
 * @param array $excludeIds  不要抽中的题（如「换一题」时排除卷内已有的）
 * @return array{drawn:array,relaxed:bool,appliedSteps:string[],notes:string[]}
 */
function blueprint_draw_raw(array $rules, array $excludeIds = [])
{
    $conditions = $rules['conditions'];
    $target = $rules['count'];

    // 条件类型的可见性：全部先打开
    $enabled = [];
    foreach (blueprint_relax_step_names() as $step) {
        $enabled[blueprint_step_to_type($step)] = true;
    }

    $appliedSteps = [];
    $notes = [];
    $drawn = [];

    // ⚠️ $enabled 必须**按引用**捕获（&$enabled）：PHP 闭包对数组是值捕获，
    // 循环里放宽条件后，值捕获的闭包读到的还是最初那份 —— 表现为
    // 「降级逻辑看起来跑了，但抽出来的题数一点没变」，很难从结果上看出来
    $attempt = function () use (&$enabled, $conditions, $excludeIds, $target) {
        $params = [];
        $where = blueprint_condition_sql($conditions, $enabled, $params);
        blueprint_append_exclude_sql($excludeIds, $where, $params);
        $sql = 'SELECT id, original_sentence, blanks_json, source, paper_id, schema_version,
                       fingerprint, publish_status, owner_id, created_at, updated_at,
                       blank_count
                  FROM questions';
        if (count($where) > 0) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY RANDOM() LIMIT ' . (int) $target;
        return query($sql, $params);
    };

    $drawn = $attempt();

    if (count($drawn) < $target) {
        foreach ($rules['fallback']['relaxSteps'] as $step) {
            $type = blueprint_step_to_type($step);
            if ($type === '' || empty($enabled[$type])) {
                continue;
            }
            // 只有「确实被用到」的条件放宽才有意义
            $hasCondition = false;
            foreach ($conditions as $condition) {
                if ($condition['type'] === $type && $type !== 'publishStatus') {
                    $hasCondition = true;
                    break;
                }
            }
            if (!$hasCondition) {
                continue;
            }

            $enabled[$type] = false;
            $appliedSteps[] = $step;
            $notes[] = blueprint_step_note($step);

            $drawn = $attempt();
            if (count($drawn) >= $target) {
                break;
            }
        }
    }

    $rows = array_map('map_question', $drawn);
    // blank_count 是内部投影列，不进 API 对象（map_question 不含它，这里显式丢弃）

    return [
        'drawn' => $rows,
        'relaxed' => count($appliedSteps) > 0,
        'appliedSteps' => $appliedSteps,
        'notes' => $notes,
        'shortfall' => max(0, $target - count($rows)),
    ];
}

/** 把降级步骤翻译成一句人话（给用户看「放宽了什么」） */
function blueprint_step_note($step)
{
    $map = [
        'dropHintType' => '放宽「提示词类型」（不再限定给动词/给名词等）',
        'dropBlankCount' => '放宽「空格数」（不再限定每篇几空）',
        'dropSource' => '放宽「来源」（不再限定只从指定卷抽题）',
        'dropTag' => '放宽「标签」（不再限定知识点，从整个题库抽）',
    ];
    return $map[$step] ?? $step;
}

/**
 * 分篇：把抽到的题分配到各篇。
 *
 * groupBy='none'：按抽出的随机顺序依次切分（每篇 perSection 道）。
 * groupBy='tag'：逐题分配，两条规则——
 *   ① 优先放进「已有同标签题且还没满」的篇（同知识点聚到一篇）
 *   ② 否则放进「题数最少且还没满」的篇（篇内均衡）
 *   ③ 所有篇都满了才放进题数最少的（超员兜底，保证不丢题）
 *
 * 为什么逐题而不是「按标签切块再贪心」：切块贪心只看放入前的篇内题数，
 * 6 题 / 2 篇 × 3 / 三个标签各 2 题时会分出 4/2 而不是 3/3。
 * 逐题分配天然均衡，且同标签仍能聚在一篇。
 *
 * @param array  $questions  map_question 后的题目数组
 * @param array  $primaryTag [questionId => tagId] 每题的主标签（可为空串）
 * @param int    $sections
 * @param int    $perSection
 * @param string $groupBy
 * @return array{ids:array<int,string[]>,tagNames:array<string,string>,overflow:int}
 */
function blueprint_distribute(array $questions, array $primaryTag, $sections, $perSection, $groupBy)
{
    $sections = max(1, (int) $sections);
    $perSection = max(1, (int) $perSection);

    $idOrder = [];
    foreach ($questions as $question) {
        $idOrder[] = (string) $question['id'];
    }

    if ($groupBy !== 'tag' || count($idOrder) === 0) {
        $buckets = array_fill(0, $sections, []);
        $overflow = 0;
        foreach ($idOrder as $index => $id) {
            $bucket = intdiv($index, $perSection);
            if ($bucket >= $sections) {
                $overflow++;
                continue;
            }
            $buckets[$bucket][] = $id;
        }
        return ['ids' => $buckets, 'tagNames' => [], 'overflow' => $overflow];
    }

    // ---- 按标签聚篇：逐题分配 ----
    $buckets = array_fill(0, $sections, []);
    // 每篇已经收了哪些主标签：用于规则 ①
    $bucketTags = array_fill(0, $sections, []);
    $overflow = 0;

    foreach ($idOrder as $id) {
        $tagId = isset($primaryTag[$id]) ? (string) $primaryTag[$id] : '';
        $target = -1;

        // ① 已有同标签且未满
        if ($tagId !== '') {
            for ($i = 0; $i < $sections; $i++) {
                if (isset($bucketTags[$i][$tagId]) && count($buckets[$i]) < $perSection) {
                    $target = $i;
                    break;
                }
            }
        }

        // ② 题数最少且未满
        if ($target === -1) {
            $minCount = PHP_INT_MAX;
            for ($i = 0; $i < $sections; $i++) {
                $count = count($buckets[$i]);
                if ($count >= $perSection) {
                    continue;
                }
                if ($count < $minCount) {
                    $minCount = $count;
                    $target = $i;
                }
            }
        }

        // ③ 全满：放进题数最少的（超员，但不丢题）
        if ($target === -1) {
            $overflow++;
            $minCount = PHP_INT_MAX;
            for ($i = 0; $i < $sections; $i++) {
                $count = count($buckets[$i]);
                if ($count < $minCount) {
                    $minCount = $count;
                    $target = $i;
                }
            }
        }

        $buckets[$target][] = $id;
        if ($tagId !== '') {
            $bucketTags[$target][$tagId] = true;
        }
    }

    return ['ids' => $buckets, 'tagNames' => [], 'overflow' => $overflow];
}

/**
 * 取一组题目的主标签：[questionId => tagId]。
 *
 * 主标签 = 该题标签里 id 最小的那个。用「最小 id」而不是「最热标签」，
 * 是为了让分篇结果稳定：同样的题集分出来的篇永远一致。
 *
 * @param string[] $questionIds
 * @return array
 */
function blueprint_primary_tags(array $questionIds)
{
    $ids = blueprint_string_list($questionIds);
    if (count($ids) === 0) {
        return [];
    }
    $map = [];
    // 分批查：IN 列表过长在部分 SQLite 构建上会超参数上限
    foreach (array_chunk($ids, 400) as $chunk) {
        $placeholders = implode(',', array_fill(0, count($chunk), '?'));
        $rows = query(
            "SELECT question_id, tag_id FROM question_tags
              WHERE question_id IN ($placeholders)
              ORDER BY question_id, tag_id",
            $chunk
        );
        foreach ($rows as $row) {
            $questionId = (string) $row['question_id'];
            if (!isset($map[$questionId])) {
                $map[$questionId] = (string) $row['tag_id'];
            }
        }
    }
    return $map;
}

/**
 * 抽题主入口：抽取 + 分篇 + 组装预览数据。
 *
 * @param array $rules      归一化后的规则
 * @param array $excludeIds 排除题 id（重新生成时不需要；换题时用）
 * @return array
 */
function blueprint_run(array $rules, array $excludeIds = [])
{
    $result = blueprint_draw_raw($rules, $excludeIds);
    $questions = $result['drawn'];

    $idOrder = [];
    foreach ($questions as $question) {
        $idOrder[] = (string) $question['id'];
    }
    $primaryTags = blueprint_primary_tags($idOrder);

    $layout = $rules['layout'];
    $distributed = blueprint_distribute(
        $questions,
        $primaryTags,
        $layout['sections'],
        $layout['perSection'],
        $layout['groupBy']
    );

    // 分篇里的 id 顺序要与题目展示顺序一致
    $byId = [];
    foreach ($questions as $question) {
        $byId[(string) $question['id']] = $question;
    }

    return [
        'targetTotal' => $rules['count'],
        'drawn' => count($questions),
        'shortfall' => $result['shortfall'],
        'relaxed' => $result['relaxed'],
        'appliedSteps' => $result['appliedSteps'],
        'notes' => $result['notes'],
        'sections' => $distributed['ids'],
        'overflow' => $distributed['overflow'],
        'questions' => $questions,
        'primaryTags' => $primaryTags,
    ];
}
