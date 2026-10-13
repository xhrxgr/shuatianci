<?php
/**
 * PHP 版后端唯一入口：所有 /api/* 请求都落到这里。
 *
 * 请求入口的职责：
 *   建表 -> 种子 -> 安全头 -> 解析登录态 -> 路由分发 -> 统一错误出口
 *
 * 差别只有两点，都不影响接口契约：
 * - 前端静态资源改由 nginx 直接托管（PHP 不提供页面），
 *   因此这里没有 SPA 兜底；未命中的 /api 路径返回 404 JSON。
 * - PHP-FPM 每次请求都是独立进程，没有「启动时执行一次」的时机，
 *   建表与种子改为「首次发现表不存在时才执行」，效果等价。
 */

require_once __DIR__ . '/app/config.php';
require_once __DIR__ . '/app/db.php';
require_once __DIR__ . '/app/errors.php';
require_once __DIR__ . '/app/util.php';
require_once __DIR__ . '/app/security.php';
require_once __DIR__ . '/app/auth.php';
require_once __DIR__ . '/app/schema.php';
require_once __DIR__ . '/app/routes_auth.php';
require_once __DIR__ . '/app/routes_records.php';
require_once __DIR__ . '/app/routes_bank.php';
require_once __DIR__ . '/app/routes_admin.php';
require_once __DIR__ . '/app/routes_system.php';
require_once __DIR__ . '/app/routes_pages.php';

/**
 * 路由表。
 *
 * 分组顺序：health -> auth -> admin -> records
 * -> bank -> collection -> system。占位符用 {name} 表示。
 *
 * @return array
 */
function route_table()
{
    return [
        ['GET', '/health', 'route_health'],

        // 认证
        ['POST', '/auth/register', 'route_auth_register'],
        ['POST', '/auth/login', 'route_auth_login'],
        ['POST', '/auth/logout', 'route_auth_logout'],
        ['GET', '/auth/me', 'route_auth_me'],
        ['POST', '/auth/change-password', 'route_auth_change_password'],

        // 用户管理
        ['GET', '/admin/users', 'route_admin_users'],
        ['GET', '/admin/roles', 'route_admin_roles'],
        ['POST', '/admin/users', 'route_admin_users_create'],
        ['POST', '/admin/users/{id}/reset-password', 'route_admin_reset_password'],
        ['POST', '/admin/users/{id}/role', 'route_admin_change_role'],
        ['POST', '/admin/users/{id}/status', 'route_admin_change_status'],
        ['GET', '/admin/users/{id}/records', 'route_admin_user_records'],
        ['DELETE', '/admin/users/{id}', 'route_admin_user_delete'],

        // 做题记录与进度
        ['POST', '/records', 'route_records_create'],
        ['GET', '/records/summary', 'route_records_summary'],
        ['POST', '/progress/{questionId}', 'route_progress_set'],
        ['GET', '/progress', 'route_progress_list'],

        // 收藏与标记
        ['GET', '/favorites', 'route_favorites_list'],
        ['POST', '/favorites', 'route_favorites_toggle'],
        ['GET', '/marks', 'route_marks_list'],
        ['POST', '/marks', 'route_marks_toggle'],

        // 题库与标签
        ['GET', '/questions', 'route_questions_list'],
        ['POST', '/questions', 'route_questions_create'],
        ['PUT', '/questions/{id}', 'route_questions_update'],
        ['DELETE', '/questions/{id}', 'route_questions_delete'],
        ['GET', '/tags', 'route_tags_list'],
        ['PUT', '/tags', 'route_tags_save'],
        ['POST', '/bank/reset', 'route_bank_reset'],

        // 系统维护
        ['GET', '/system/version', 'route_system_version'],
        ['POST', '/system/check-update', 'route_system_check_update'],
        ['POST', '/system/update', 'route_system_update'],
        ['GET', '/system/update-status', 'route_system_update_status'],
    ];
}

/** GET /api/health */
function route_health()
{
    json_response(['ok' => true, 'time' => now_iso()]);
}

/**
 * 路径与路由模式是否匹配（支持 {name} 占位符）。
 *
 * @param string $pattern
 * @param string $path
 * @param array $params 输出参数
 * @return bool
 */
function route_matches($pattern, $path, &$params)
{
    $patternParts = explode('/', trim($pattern, '/'));
    $pathParts = explode('/', trim($path, '/'));
    if (count($patternParts) !== count($pathParts)) {
        return false;
    }
    $params = [];
    foreach ($patternParts as $index => $segment) {
        if (preg_match('/^\{.+\}$/', $segment) === 1) {
            $params[] = $pathParts[$index];
            continue;
        }
        if ($segment !== $pathParts[$index]) {
            return false;
        }
    }
    return true;
}

/**
 * 首次运行时建表与导入种子。
 *
 * 建表只在缺表时执行；种子靠 app_config 的标记位判断，
 * 正常请求只多一次主键查询，开销可忽略。
 */
function bootstrap()
{
    db();
    $table = query_one("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
    if ($table === null) {
        ensure_schema();
    }
    $flag = query_one('SELECT config_value FROM app_config WHERE config_key = ?', [SEED_FLAG]);
    if ($flag === null) {
        seed_if_needed();
    }
}

/* ------------------------------------------------------------------ */
/* 请求入口                                                            */
/* ------------------------------------------------------------------ */

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$path = request_path((string) ($_SERVER['REQUEST_URI'] ?? '/'));

send_security_headers();

// 更新完成后自动生效：消费后台进程留下的「刷新 opcache」标记
maybe_apply_reload_flag();

try {
    // CORS 默认关闭；开启时预检请求会在这里结束
    if (send_cors_headers()) {
        exit;
    }

    bootstrap();
    attach_user();

    // 页面与接口共用同一个入口：/api 返回 JSON，其余渲染 HTML 页面
    $uriPath = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    if (strpos((string) $uriPath, '/api') !== 0) {
        dispatch_page($method, $path);
        return;
    }

    $params = [];
    $handler = null;
    foreach (route_table() as $route) {
        if ($route[0] !== $method) {
            continue;
        }
        if (route_matches($route[1], $path, $params)) {
            $handler = $route[2];
            break;
        }
    }

    if ($handler === null) {
        json_response(['error' => '接口不存在'], 404);
    }

    call_user_func_array($handler, $params);
} catch (Throwable $e) {
    $response = error_to_response($e);
    json_response($response['body'], $response['status']);
}
