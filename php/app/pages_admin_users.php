<?php
/**
 * GET /admin/users —— 用户管理页。
 *
 * 实现要点：
 *   权限守卫 -> guard_admin_page()
 *   首屏数据（users / roles）-> 直接查库，交给 views/admin-users.php 直出
 *   新建 / 重置密码 / 改角色 / 启停 / 删除 -> assets/js/admin-users.js 调 /api/admin/*
 *
 * 权限口径：未登录给「去登录」入口，非管理员提示无权限；
 * 后端接口本身也有鉴权保护（routes_admin.php 要求 user:read / user:write）。
 */

require_once __DIR__ . '/views.php';

/**
 * 渲染用户管理页。
 *
 * @return void
 */
function page_admin_users()
{
    $user = current_user();

    // 未登录 / 非管理员：直接输出 guard 提示，与 App.tsx 的 RequireAdmin 一致
    $guard = guard_admin_page($user);
    if ($guard !== null) {
        render_page('admin-users', [
            'currentPath' => '/admin/users',
            'guard' => $guard,
            'users' => [],
            'roles' => [],
        ]);
        return;
    }

    // 与 routes_admin.php 的 route_admin_users 同一条 SQL，字段完全一致
    $rows = query(
        'SELECT u.id, u.username, u.display_name, u.role, u.status,
                u.created_at,
                COUNT(r.id) AS record_count,
                COALESCE(SUM(CASE WHEN r.is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong_count
           FROM users u
           LEFT JOIN practice_records r ON r.user_id = u.id
          GROUP BY u.id
          ORDER BY u.created_at DESC'
    );

    $users = [];
    foreach ($rows as $row) {
        $users[] = [
            'id' => (int) $row['id'],
            'username' => (string) $row['username'],
            'displayName' => $row['display_name'] !== null ? (string) $row['display_name'] : null,
            'role' => (string) $row['role'],
            'status' => (int) $row['status'],
            'createdAt' => to_iso($row['created_at']),
            'recordCount' => (int) $row['record_count'],
            'wrongCount' => (int) $row['wrong_count'],
        ];
    }

    render_page('admin-users', [
        'currentPath' => '/admin/users',
        'guard' => null,
        'users' => $users,
        'roles' => list_roles(),
    ]);
}
