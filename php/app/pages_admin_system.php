<?php
/**
 * GET /admin/system —— 系统设置页。
 *
 * 实现要点：
 *   权限守卫 -> guard_admin_page()
 *   版本信息、检查更新结果、更新进度 -> assets/js/admin-system.js 调 /api/system/*
 *
 * 权限口径：未登录给「去登录」入口，非管理员提示无权限。
 * 后端接口本身也有鉴权保护（routes_system.php 要求 system:read / system:write）。
 *
 * 版本信息与更新进度都由 JS 调接口获取，PHP 侧不查 git，
 * 只负责渲染静态骨架与权限提示。
 */

require_once __DIR__ . '/views.php';

/**
 * 渲染系统设置页。
 *
 * @return void
 */
function page_admin_system()
{
    $user = current_user();

    // 未登录 / 非管理员：直接输出 guard 提示，与 App.tsx 的 RequireAdmin 一致
    $guard = guard_admin_page($user);
    if ($guard !== null) {
        render_page('admin-system', [
            'currentPath' => '/admin/system',
            'guard' => $guard,
        ]);
        return;
    }

    render_page('admin-system', [
        'currentPath' => '/admin/system',
        'guard' => null,
    ]);
}
