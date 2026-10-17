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

/*
 * ---- 维护窗口检查（必须在加载任何业务代码之前）----
 *
 * 为什么必须前置：`git reset --hard` 是逐文件改写工作区的，切换那几秒里
 * 并发请求可能 require 到**写了一半**的 PHP 文件，直接 ParseError 就 fatal 了。
 * 检查若排在 require 之后，文件已经加载炸了，维护页根本没机会执行 ——
 * 那正是这个机制要解决的故障本身。
 *
 * maintenance.php 只依赖 errors.php（纯类与函数定义，无执行逻辑），前置是安全的。
 */
require_once __DIR__ . '/app/maintenance.php';

(function () {
    $maint = maintenance_active();
    if ($maint === false) {
        return;
    }
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    http_response_code(503);
    header('Retry-After: 3');
    if (strpos($path, '/api') === 0) {
        // API 必须回 JSON：前端拿到 HTML 会 JSON.parse 失败，最后只显示
        // 「请求失败（503）」这种没有信息量的提示，还会继续傻等
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'ok' => false,
            'error' => '正在更新，请稍候',
            'detail' => (string) ($maint['reason'] ?? ''),
            'retryAfter' => (int) ($maint['secondsLeft'] ?? 3),
            'maintenance' => true,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
    header('Content-Type: text/html; charset=utf-8');
    echo maintenance_page(
        '正在更新，请稍候',
        '服务器正在切换到新版本，通常几秒钟就好，页面会自动刷新。',
        ''
    );
    exit;
})();

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
// 试卷路由在题库之后加载：routes_bank 写入题目时会调用 ensure_paper_by_name
require_once __DIR__ . '/app/routes_papers.php';
// 组卷蓝图依赖试卷路由（生成卷的读写都用 map_paper / paper_items 相关函数）
require_once __DIR__ . '/app/routes_blueprints.php';
require_once __DIR__ . '/app/routes_admin.php';
require_once __DIR__ . '/app/routes_system.php';
require_once __DIR__ . '/app/routes_passages.php';
require_once __DIR__ . '/app/maintenance.php';
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
        // 查重必须在任何 /questions/{id} 形式的路由之前注册：
        // 路由是按顺序匹配的，{id} 会把 check-duplicates 当成一个 id 吃掉
        ['POST', '/questions/check-duplicates', 'route_questions_check_duplicates'],
        // 具体路径必须排在 /questions/{id} 之前：
        // 路由是顺序匹配的，占位符在前会把 paper 当成题目 id 吞掉
        ['PUT', '/questions/paper', 'route_questions_set_paper'],
        ['PUT', '/questions/{id}', 'route_questions_update'],
        ['DELETE', '/questions/{id}', 'route_questions_delete'],
        ['GET', '/tags', 'route_tags_list'],
        ['PUT', '/tags', 'route_tags_save'],
        ['POST', '/bank/reset', 'route_bank_reset'],

        // 试卷
        ['GET', '/papers', 'route_papers_list'],
        ['POST', '/papers', 'route_papers_create'],
        ['GET', '/papers/{id}', 'route_papers_show'],
        ['PUT', '/papers/{id}', 'route_papers_update'],
        ['DELETE', '/papers/{id}', 'route_papers_delete'],

        // 组卷蓝图（题库重构第 2 期）。
        // /blueprints/preview 必须排在 /blueprints/{id} 之前：
        // 路由按顺序匹配，{id} 会把 preview 当成一个蓝图 id 吃掉
        ['GET', '/blueprints', 'route_blueprints_list'],
        ['POST', '/blueprints', 'route_blueprints_create'],
        ['POST', '/blueprints/preview', 'route_blueprints_preview'],
        ['GET', '/blueprints/{id}', 'route_blueprints_show'],
        ['PUT', '/blueprints/{id}', 'route_blueprints_update'],
        ['DELETE', '/blueprints/{id}', 'route_blueprints_delete'],
        ['POST', '/blueprints/{id}/generate', 'route_blueprints_generate'],

        // 生成卷的成员（按篇读写、换题）
        ['GET', '/papers/{id}/items', 'route_paper_items_get'],
        ['PUT', '/papers/{id}/items', 'route_paper_items_put'],
        ['POST', '/papers/{id}/items/replace', 'route_paper_item_replace'],

        // 系统维护
        ['GET', '/system/version', 'route_system_version'],
        ['POST', '/system/check-update', 'route_system_check_update'],
        ['POST', '/system/update', 'route_system_update'],
        ['GET', '/system/update-status', 'route_system_update_status'],
        ['GET', '/system/update-source', 'route_system_update_source_get'],
        ['PUT', '/system/update-source', 'route_system_update_source_set'],
        ['POST', '/system/update-source/test', 'route_system_update_source_test'],

        // 篇章（一道大题共享的完整原文）
        ['GET', '/passages', 'route_passages_list'],
        ['POST', '/passages', 'route_passages_create'],
        ['PUT', '/passages/{id}', 'route_passages_update'],
        ['DELETE', '/passages/{id}', 'route_passages_delete'],
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
 *
 * migrate_schema 必须每次都跑：已有部署不会重新建表，
 * 但新增字段靠 ALTER 补列，否则升级后 SELECT 会因缺列直接失败。
 */
function bootstrap()
{
    db();
    $table = query_one("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
    if ($table === null) {
        ensure_schema();
    } else {
        migrate_schema();
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

// 把 notice / warning / deprecated 从「输出到响应体」改为「只记日志」。
//
// 必须这么做的原因：PHP 的 warning（如「Array to string conversion」）
// 会被直接写进 stdout，于是响应体变成
//     Warning: ... {"ok":true,...}
// 前端 JSON.parse 立刻失败，报的还是一个与真实原因毫无关系的语法错误。
// 代码里有若干处对用户输入做 (string) 转换的地方（validate.php 等），
// 只要传进来的是数组就会触发这类 warning。
//
// 这里统一拦下并转成 error_log，与 errors.php 的既有做法一致；
// 真实错误（Error 异常）仍走 try/catch 的统一出口，不受影响。
set_error_handler(function ($severity, $message, $file, $line) {
    if ((error_reporting() & $severity) === 0) {
        return false; // 被 @ 抑制或本就没开启的错误类型，交回 PHP 默认处理
    }
    error_log(sprintf('[php] %s in %s:%d', $message, $file, $line));
    return true; // 已处理，不输出到响应体
});

// display_errors 在部分环境（php -S 的 dev-router）是 On，
// 它会把上面的 warning 直接打印出来；显式关掉，避免漏网
if (PHP_SAPI !== 'cli') {
    @ini_set('display_errors', '0');
}

try {
    send_security_headers();

    // 更新完成后自动生效：消费后台进程留下的「刷新 opcache」标记
    maybe_apply_reload_flag();

    // CORS 默认关闭；开启时预检请求会在这里结束
    if (send_cors_headers()) {
        exit;
    }

    // ---- 迁移守卫 ----
    // 更新后第一次请求会在这里跑数据库迁移。若迁移抛错，原来是一片 500，
    // 用户既不知道发生了什么，也不知道代码已经换过版本、能不能回滚。
    // 有 pending_migration 标记时把错误变成一句说清怎么办的话。
    $migrating = pending_migration_pending() > 0;
    try {
        bootstrap();
    } catch (Throwable $bootErr) {
        error_log('[bootstrap] ' . $bootErr->getMessage());
        if ($migrating) {
            http_response_code(503);
            header('Content-Type: text/html; charset=utf-8');
            echo maintenance_page(
                '新版本的数据库结构没能初始化成功',
                // 只说结论，不回显异常原文：PDOException 的 getMessage() 会带出
                // SQL 片段、表名列名与数据库绝对路径，而这一页是未登录可见的
                //（在 attach_user() 之前就 exit 了），等于对外公开服务器内部结构。
                // 完整信息已经在上一行 error_log 里。
                '代码已更新到最新版，但数据库结构升级失败。请查看服务器错误日志'
                . '（PHP error log）获取详细信息。',
                '解决办法：在服务器上执行 git reset --hard HEAD~1 回到上一个版本，'
                . '站点会立刻恢复。数据库结构的改动只做加法，旧代码可以继续用新库，'
                . '所以回滚代码是安全的，不会丢数据。'
            );
            exit;
        }
        throw $bootErr;
    }
    if ($migrating) {
        // 迁移成功（bootstrap 没抛）→ 清掉标记，别每次请求都多走一次判断
        pending_migration_clear();
    }
    attach_user();

    // 页面与接口共用同一个入口：/api/* 走 JSON，其余渲染 HTML 页面。
    //
    // 判据必须是「原始 URI 是不是以 /api 开头」，不能用 request_path() 的结果：
    // request_path() 已经把 /api 前缀剥掉了（/api/questions → /questions），
    // 而且路由表里存在**与页面同名的 API 路由**（GET /papers 既在接口表里、
    // 也是学生端页面），改成「匹配路由表」会让 /papers 页面命中接口路由、
    // 直接返回 JSON，页面就白了。
    $uriPath = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    // php -S 的 router 模式下 SCRIPT_NAME 就是请求路径本身，
    // 可能带着 dev-router 前缀，判断前先剥掉
    $scriptPrefix = isset($_SERVER['SCRIPT_NAME']) ? (string) $_SERVER['SCRIPT_NAME'] : '';
    if (strpos((string) $uriPath, $scriptPrefix) === 0 && substr($scriptPrefix, -4) === '.php') {
        $uriPath = substr((string) $uriPath, strlen($scriptPrefix));
    }
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
