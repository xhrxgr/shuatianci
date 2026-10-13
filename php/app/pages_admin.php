<?php
/**
 * GET /admin —— 题库管理。
 *
 * 管理员才能进；题目与标签由 PHP 查库渲染，其余交互（精录、导入、
 * 标签管理、AI 助手）交给 assets/js/admin.js。
 */

require_once __DIR__ . '/views.php';
// 试卷页签要列出全部试卷
require_once __DIR__ . '/routes_papers.php';

/** 题库管理 */
function page_admin()
{
    $user = current_user();

    // 未登录 / 非管理员：只渲染提示（对应 App.tsx 的 RequireAdmin）
    $guard = guard_admin_page($user);
    if ($guard !== null) {
        render_page('admin', [
            'currentPath' => '/admin',
            'guard' => $guard,
            'tagDictionary' => ['schemaVersion' => 1, 'tags' => []],
            'questions' => [],
            'papers' => [],
            'tagUsage' => [],
        ]);
        return;
    }

    $questions = load_questions_with_progress($user);
    $tagDictionary = load_tag_dictionary();
    $papers = array_map('map_paper', query_papers_with_counts());

    // 各标签被多少道题引用，供标签管理页删除前提示影响范围
    $tagUsage = [];
    foreach ($questions as $question) {
        foreach ($question['blanks'] as $blank) {
            foreach (($blank['tagIds'] ?? []) as $tagId) {
                $tagId = (string) $tagId;
                $tagUsage[$tagId] = ($tagUsage[$tagId] ?? 0) + 1;
            }
        }
    }

    render_page('admin', [
        'currentPath' => '/admin',
        'guard' => null,
        'tagDictionary' => $tagDictionary,
        'questions' => $questions,
        'papers' => $papers,
        'tagUsage' => $tagUsage,
    ]);
}
