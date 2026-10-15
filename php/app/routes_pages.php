<?php
/**
 * 页面路由（前端 PHP 化后的「页面」部分）。
 *
 * 页面路由表，与前端单页应用的路由一一对应：
 *   path="/"            -> page_home
 *   path="/practice"    -> page_practice
 *   path="/login"       -> page_login
 *   path="/profile"     -> page_profile
 *   path="/collection"  -> page_collection
 *   path="/admin"       -> page_admin（需管理员）
 *   path="/admin/users" -> page_admin_users（需管理员）
 *   path="/admin/system"-> page_admin_system（需管理员）
 *   path="*"            -> 404 页
 *
 * 逐步替换：每完成一个页面就往表里加一行，没完成的路径暂时落到 404。
 * 当前进度见 docs/REFACTOR_PROGRESS.md。
 */

require_once __DIR__ . '/views.php';
require_once __DIR__ . '/pages_admin_users.php';
require_once __DIR__ . '/pages_admin.php';
require_once __DIR__ . '/pages_admin_system.php';
// 试卷：页面层要用 map_paper 与 query_papers_with_counts
require_once __DIR__ . '/routes_papers.php';

/**
 * 页面路由表。
 *
 * @return array
 */
function page_route_table()
{
    return [
        ['GET', '/', 'page_home'],
        ['GET', '/login', 'page_login'],
        ['GET', '/practice', 'page_practice'],
        ['GET', '/profile', 'page_profile'],
        ['GET', '/collection', 'page_collection'],
        // 试卷：列表与整卷练习。具体路径排在 {id} 之前
        ['GET', '/papers', 'page_papers'],
        ['GET', '/papers/{id}', 'page_paper_practice'],
        ['GET', '/admin', 'page_admin'],
        ['GET', '/admin/users', 'page_admin_users'],
        ['GET', '/admin/system', 'page_admin_system'],
    ];
}

/**
 * 分发页面请求。
 *
 * @param string $method
 * @param string $path
 */
function dispatch_page($method, $path)
{
    $params = [];
    $handler = null;
    foreach (page_route_table() as $route) {
        if ($route[0] !== $method) {
            continue;
        }
        if (route_matches($route[1], $path, $params)) {
            $handler = $route[2];
            break;
        }
    }

    if ($handler === null) {
        http_response_code(404);
        render_page('404', [], 'Page Not Found');
    }
    call_user_func_array($handler, $params);
}

/* ------------------------------------------------------------------ */
/* 首页                                                                */
/* ------------------------------------------------------------------ */

/**
 * GET / —— 题库概览与快捷入口
 */
function page_home()
{
    $user = current_user();
    $questions = load_questions_with_progress($user);
    $tagDictionary = load_tag_dictionary();

    // 统计必须建立在「题目 + 个人进度」的合并结果上，
    // 否则已掌握 / 错题数对登录用户永远是 0
    $total = count($questions);
    $mastered = 0;
    $wrong = 0;
    $blankCount = 0;
    foreach ($questions as $question) {
        if ($question['status'] === 'mastered') {
            $mastered++;
        }
        if ($question['wrongCount'] > 0) {
            $wrong++;
        }
        $blankCount += count($question['blanks']);
    }

    // 按标签累计错次，取前五
    $tagMap = [];
    foreach ($questions as $question) {
        if ($question['wrongCount'] <= 0) {
            continue;
        }
        $ids = [];
        foreach ($question['blanks'] as $blank) {
            if (!empty($blank['tagIds']) && is_array($blank['tagIds'])) {
                foreach ($blank['tagIds'] as $tagId) {
                    $ids[(string) $tagId] = true;
                }
            }
        }
        foreach (array_keys($ids) as $tagId) {
            $tagMap[$tagId] = ($tagMap[$tagId] ?? 0) + $question['wrongCount'];
        }
    }
    arsort($tagMap);
    $nameMap = [];
    foreach ($tagDictionary['tags'] as $tag) {
        $nameMap[$tag['id']] = $tag;
    }
    $topTags = [];
    foreach (array_slice(array_keys($tagMap), 0, 5) as $tagId) {
        if (!isset($nameMap[$tagId])) {
            continue;
        }
        $topTags[] = ['tag' => $nameMap[$tagId], 'count' => $tagMap[$tagId]];
    }

    // 最近录入：按 createdAt 倒序取 5 条
    $recent = $questions;
    usort($recent, function ($a, $b) {
        return strcmp((string) $b['createdAt'], (string) $a['createdAt']);
    });
    $recent = array_slice($recent, 0, 5);

    render_page('home', [
        'currentPath' => '/',
        'stats' => [
            'total' => $total,
            'mastered' => $mastered,
            'wrong' => $wrong,
            'blankCount' => $blankCount,
        ],
        'topTags' => $topTags,
        'recent' => $recent,
        // 最近三张卷，按考试日期倒序（首页不必再排一次）
        'papers' => array_map('map_paper', array_slice(query_papers_with_counts(), 0, 3)),
        'isAdmin' => $user !== null && $user['role'] === ROLE_ADMIN,
    ]);
}

/* ------------------------------------------------------------------ */
/* 试卷                                                                */
/* ------------------------------------------------------------------ */

/**
 * GET /papers —— 试卷列表。
 *
 * 按考试日期倒序；没填日期的排在后面（按创建时间）。
 * 登录用户能看到每卷的完成进度，游客只有题数。
 */
function page_papers()
{
    render_page('papers', [
        'currentPath' => '/papers',
        'papers' => array_map('map_paper', query_papers_with_counts()),
        'authenticated' => current_user() !== null,
    ]);
}

/**
 * GET /papers/{id} —— 整卷练习。
 *
 * 一题一屏逐题做：这是「拿一整套卷子直接做」最贴近考试的方式，
 * 顺序固定、做完能看到本卷进度。需要自由筛选、打乱顺序时用刷题页。
 */
function page_paper_practice($id)
{
    $user = current_user();
    $row = query_one(
        'SELECT p.*,
                (SELECT COUNT(*) FROM paper_items i WHERE i.paper_id = p.id) AS question_count,
                (SELECT b.name FROM blueprints b WHERE b.id = p.blueprint_id) AS blueprint_name
           FROM papers p WHERE p.id = ?',
        [$id]
    );
    if ($row === null) {
        http_response_code(404);
        render_page('404', [], '试卷不存在');
        return;
    }

    // 直接取该卷题目并合并个人进度，省掉前端再请求一次。
    // 顺序与分篇以 paper_items 为准（第 2 期起）：生成的虚拟卷只登记在成员表里，
    // 按 questions.paper_id 查会得到空卷；原始卷两边数据一致，改这里不影响它。
    // 同样要 LEFT JOIN passages：整卷练习的题目也可能属于某篇阅读
    $questionRows = query(
        'SELECT ' . questions_select_columns() . ', i.section_no, i.order_no
           FROM paper_items i
           JOIN questions q ON q.id = i.question_id
           LEFT JOIN passages p ON p.id = q.passage_id
          WHERE i.paper_id = ?
          ORDER BY i.section_no, i.order_no',
        [$id]
    );
    $questions = [];
    foreach ($questionRows as $row) {
        $question = map_question($row);
        $question['sectionNo'] = (int) $row['section_no'];
        $questions[] = $question;
    }
    $questions = merge_progress($questions, $user);

    render_page('paper-practice', [
        'currentPath' => '/papers',
        'paper' => map_paper($row),
        'questions' => $questions,
        'authenticated' => $user !== null,
    ]);
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 刷题                                                                */
/* ------------------------------------------------------------------ */

/** GET /practice —— 刷题页 */
function page_practice()
{
    $user = current_user();
    $paperId = isset($_GET['paperId']) ? trim((string) $_GET['paperId']) : '';

    // 从「自由刷这卷」进来：把该卷的名称一并带过去，空状态与提示都要用
    $paperName = null;
    if ($paperId !== '') {
        $row = query_one('SELECT id, name FROM papers WHERE id = ?', [$paperId]);
        if ($row === null) {
            // 试卷不存在时退回全库，而不是 404——刷题页本身仍然可用
            $paperId = '';
        } else {
            $paperName = (string) $row['name'];
        }
    }

    render_page('practice', [
        'currentPath' => '/practice',
        // 登录用户的进度在这里就合并好了，游客的本地进度由 JS 再叠加
        'questions' => load_questions_with_progress($user),
        'tagDictionary' => load_tag_dictionary(),
        'authenticated' => $user !== null,
        // 从「我的收藏」跳转过来时只看这一卷
        'sourceFilter' => isset($_GET['source']) && $_GET['source'] !== '' ? (string) $_GET['source'] : null,
        'paperIdFilter' => $paperId !== '' ? $paperId : null,
        'paperName' => $paperName,
    ]);
}

/* ------------------------------------------------------------------ */
/* 个人中心与收藏                                                      */
/* ------------------------------------------------------------------ */

/**
 * GET /profile —— 个人中心。
 * 登录用户的统计直接查库渲染；游客统计在本地，由页面脚本填充。
 */
function page_profile()
{
    $user = current_user();
    $data = ['currentPath' => '/profile'];

    if ($user !== null) {
        $rows = query(
            'SELECT COUNT(*)                     AS total,
                    COALESCE(SUM(is_correct), 0) AS correct,
                    COALESCE(SUM(wrong_count), 0) AS wrong
               FROM practice_records
              WHERE user_id = ?',
            [(int) $user['id']]
        );
        $total = (int) $rows[0]['total'];
        $correct = (int) $rows[0]['correct'];
        $wrong = (int) $rows[0]['wrong'];

        $weakRows = query(
            'SELECT question_id, COUNT(*) AS times
               FROM practice_records
              WHERE user_id = ? AND is_correct = 0
              GROUP BY question_id
              ORDER BY times DESC
              LIMIT 10',
            [(int) $user['id']]
        );
        $weak = [];
        foreach ($weakRows as $row) {
            $weak[] = ['questionId' => (string) $row['question_id'], 'times' => (int) $row['times']];
        }

        $data['summary'] = [
            'total' => $total,
            'correct' => $correct,
            'wrong' => $wrong,
            'accuracy' => $total === 0 ? 0 : (int) round(($correct / $total) * 100),
            'weakQuestions' => $weak,
        ];
    }

    render_page('profile', $data);
}

/**
 * GET /collection —— 我的收藏。
 * 收藏的试卷与标记的题目都由 PHP 查库渲染，标记项带上题目原句与来源。
 */
function page_collection()
{
    $user = current_user();
    $data = [
        'currentPath' => '/collection',
        'tab' => (isset($_GET['tab']) && $_GET['tab'] === 'marks') ? 'marks' : 'favorites',
        'favorites' => [],
        'marks' => [],
    ];

    if ($user !== null) {
        $favoriteRows = query(
            'SELECT f.source, f.note, f.created_at,
                    COUNT(q.id) AS question_count
               FROM user_favorites f
               LEFT JOIN questions q ON q.source = f.source
              WHERE f.user_id = ?
              GROUP BY f.source, f.note, f.created_at
              ORDER BY f.created_at DESC',
            [(int) $user['id']]
        );
        foreach ($favoriteRows as $row) {
            $data['favorites'][] = [
                'source' => (string) $row['source'],
                'note' => $row['note'],
                'questionCount' => (int) $row['question_count'],
                'createdAt' => to_iso($row['created_at']),
            ];
        }

        $markRows = query(
            'SELECT m.question_id, m.label, m.note, m.created_at,
                    q.original_sentence, q.source
               FROM user_marks m
               LEFT JOIN questions q ON q.id = m.question_id
              WHERE m.user_id = ?
              ORDER BY m.created_at DESC',
            [(int) $user['id']]
        );
        foreach ($markRows as $row) {
            $data['marks'][] = [
                'questionId' => (string) $row['question_id'],
                'label' => (string) $row['label'],
                'note' => $row['note'],
                'createdAt' => to_iso($row['created_at']),
                'sentence' => $row['original_sentence'] !== null ? (string) $row['original_sentence'] : null,
                'source' => $row['source'] !== null ? (string) $row['source'] : null,
            ];
        }
    }

    render_page('collection', $data);
}

/** GET /login —— 登录 / 注册 */
function page_login()
{
    // 已登录则直接回首页
    if (current_user() !== null) {
        header('Location: /');
        exit;
    }
    render_page('login', ['currentPath' => '/login']);
}
