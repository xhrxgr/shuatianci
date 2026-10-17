<?php
/**
 * 角色、权限、会话与登录限速。
 *
 * 对应关系：
 *   auth/roles.js              -> 本文件顶部的 ROLES / PERMISSIONS / has_permission
 *   middleware/auth.js         -> read_token / resolve_user / create_session / destroy_*
 *   middleware/permission.js   -> require_auth / require_permission
 *   middleware/rateLimit.js    -> login_throttle / record_login_failure / clear_login_failures
 *
 * 两处**实现差异**（行为等价，见文档「环境差异」一节）：
 * 1. 会话解析结果不做内存缓存。Node 用 30 秒的进程内缓存省掉并发重复查询，
 *    PHP 每个请求独立、没有跨请求的进程内内存，直接查库即可；
 *    反而更安全——「禁用账号后立即失效」不再依赖缓存主动失效。
 * 2. 登录限速状态存文件（加 flock）而不是内存。PHP 同样没有跨请求内存，
 *    用文件是唯一能跨进程生效又不改数据库结构的方案。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/errors.php';

/** 会话有效期（天） */
define('SESSION_TTL_DAYS', 30);

/** 角色常量 */
define('ROLE_ADMIN', 'admin');
define('ROLE_USER', 'user');

/**
 * 角色 -> 权限集合。新增角色只需改这里，调用方不受影响。
 * 未声明的角色没有任何权限（deny by default）。
 *
 * @return array<string,string[]>
 */
function permissions_map()
{
    return [
        ROLE_ADMIN => [
            'question:read',
            'question:write',
            'record:read:self',
            'record:write:self',
            'record:read:any',
            'user:read',
            'user:write',
            'tag:read',
            'tag:write',
            'system:read',
            'system:write',
        ],
        ROLE_USER => [
            'question:read',
            'record:read:self',
            'record:write:self',
            'tag:read',
        ],
    ];
}

/** 角色中文名 */
function role_labels()
{
    return [ROLE_ADMIN => '管理员', ROLE_USER => '普通用户'];
}

/** 是否合法角色 */
function is_valid_role($role)
{
    return $role === ROLE_ADMIN || $role === ROLE_USER;
}

/** 角色是否拥有某权限 */
function has_permission($role, $permission)
{
    $map = permissions_map();
    return isset($map[$role]) && in_array($permission, $map[$role], true);
}

/** 供前端下拉框使用的角色清单 */
function list_roles()
{
    $labels = role_labels();
    return [
        ['value' => ROLE_ADMIN, 'label' => $labels[ROLE_ADMIN]],
        ['value' => ROLE_USER, 'label' => $labels[ROLE_USER]],
    ];
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

/**
 * 登录 Cookie 名。
 *
 * 为什么需要 Cookie：页面由 PHP 服务端渲染，而**浏览器导航（点链接、跳转）不会
 * 带 Authorization 头**——那是 JS 的 fetch 才有的。没有 Cookie 的话，PHP 渲染
 * 页面时读不到登录态，登录后导航栏仍然是「登录」按钮。
 *
 * 两条通道并存、互不影响：
 *   - JS 调 /api 时用 Authorization（localStorage 里的 token，与原版一致）
 *   - 页面导航时浏览器自动带 Cookie，PHP 用它识别登录态
 *
 * 安全性：httpOnly（JS 不需要读它）+ SameSite=Lax（跨站 POST 不带它，等于挡 CSRF）。
 * Cookie 里的 token 就是会话 token 本身，与数据库 sessions 表一一对应，
 * 过期 / 注销 / 被踢下线后立即失效。
 */
function auth_cookie_name()
{
    return 'eq_token';
}

/**
 * 当前请求是否走 HTTPS。
 *
 * 用于给 Cookie 加 Secure 属性。只在 HTTPS 下才加：
 * 本地开发（README 的 http://127.0.0.1:9001）没有 TLS，硬写 secure=true
 * 会让浏览器根本不回传 Cookie，表现为「登录后立刻掉登录」。
 * 线上是 HTTPS（记忆里部署拓扑为 WAF 终止 TLS 后回源），这条会生效。
 *
 * 额外看 X-Forwarded-Proto：宝塔/nginx 常见做法是前置代理终结 TLS，
 * 回源到 PHP 时 HTTPS 变量可能已被清掉。
 */
function request_is_https()
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if (strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https') {
        return true;
    }
    return (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443;
}

/** 写入登录 Cookie */
function set_auth_cookie($token)
{
    if (headers_sent()) {
        return;
    }
    setcookie(auth_cookie_name(), (string) $token, [
        'expires' => time() + SESSION_TTL_DAYS * 24 * 60 * 60,
        'path' => '/',
        'httponly' => true,
        // HTTPS 下加 Secure：该 token 有效期 30 天且与 sessions 表一一对应，
        // 走明文 HTTP 会被中间人直接嗅探走。没条件加时宁可不加，
        // 免得本地 HTTP 开发直接登不上。
        'secure' => request_is_https(),
        'samesite' => 'Lax',
    ]);
}

/** 清除登录 Cookie */
function clear_auth_cookie()
{
    if (headers_sent()) {
        return;
    }
    // 属性必须与写入时一致，否则清不掉
    setcookie(auth_cookie_name(), '', [
        'expires' => time() - 3600,
        'path' => '/',
        'httponly' => true,
        'secure' => request_is_https(),
        'samesite' => 'Lax',
    ]);
}

/**
 * 取请求里的 token。
 * 优先 Authorization: Bearer，其次 token 头，最后登录 Cookie（页面导航用）。
 *
 * @return string
 */
function read_token()
{
    $auth = '';
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $auth = (string) $_SERVER['HTTP_AUTHORIZATION'];
    } elseif (function_exists('getallheaders')) {
        $headers = getallheaders();
        foreach ($headers as $key => $value) {
            if (strtolower((string) $key) === 'authorization') {
                $auth = (string) $value;
                break;
            }
        }
    }
    if ($auth !== '' && stripos($auth, 'Bearer ') === 0) {
        return trim(substr($auth, 7));
    }
    if ($auth !== '') {
        return trim($auth);
    }
    if (isset($_SERVER['HTTP_TOKEN']) && $_SERVER['HTTP_TOKEN'] !== '') {
        return trim((string) $_SERVER['HTTP_TOKEN']);
    }
    // 页面导航（浏览器直接请求）只能靠 Cookie 带登录态
    $cookie = auth_cookie_name();
    return isset($_COOKIE[$cookie]) ? trim((string) $_COOKIE[$cookie]) : '';
}

/**
 * 解析 token 对应的用户，失败返回 null（不抛错，交由调用方决定是否放行）。
 *
 * @param string $token
 * @return array|null
 */
function resolve_user($token)
{
    if ($token === '') {
        return null;
    }
    return query_one(
        "SELECT u.id, u.username, u.role, u.display_name, u.status
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > datetime('now') AND u.status = 1",
        [$token]
    );
}

/** 把登录态挂到全局，等价于 Node 的 attachUser 中间件 */
function attach_user()
{
    $GLOBALS['current_token'] = read_token();
    $GLOBALS['current_user'] = resolve_user($GLOBALS['current_token']);
}

/** 当前登录用户，未登录返回 null */
function current_user()
{
    return isset($GLOBALS['current_user']) ? $GLOBALS['current_user'] : null;
}

/** 当前 token */
function current_token()
{
    return isset($GLOBALS['current_token']) ? $GLOBALS['current_token'] : '';
}

/** 要求已登录，否则 401「请先登录」 */
function require_auth()
{
    if (current_user() === null) {
        throw http_error(401, '请先登录');
    }
    return current_user();
}

/** 要求具备某权限，否则返回 401 / 403 */
function require_permission($permission)
{
    $user = require_auth();
    if (!has_permission($user['role'], $permission)) {
        throw http_error(403, '没有权限执行该操作');
    }
    return $user;
}

/**
 * 创建会话，返回 token。
 *
 * @param int $userId
 * @return string
 */
function create_session($userId)
{
    $token = bin2hex(random_bytes(32));
    $expiresAt = (new DateTime('now', new DateTimeZone('UTC')))
        ->modify('+' . SESSION_TTL_DAYS . ' days')
        ->format('Y-m-d H:i:s');

    execute('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [
        (int) $userId,
        $token,
        $expiresAt,
    ]);
    return $token;
}

/** 注销：删除当前 token 对应会话 */
function destroy_session($token)
{
    if ($token === '') {
        return;
    }
    execute('DELETE FROM sessions WHERE token = ?', [$token]);
}

/**
 * 删除某用户的全部会话（改密 / 改角色 / 禁用 / 删除时调用）。
 *
 * @param int $userId
 * @param string|null $exceptToken 保留的会话（改密时保留当前设备）
 */
function destroy_user_sessions($userId, $exceptToken = null)
{
    if ($exceptToken !== null && $exceptToken !== '') {
        execute('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [(int) $userId, $exceptToken]);
    } else {
        execute('DELETE FROM sessions WHERE user_id = ?', [(int) $userId]);
    }
}

/** 清理过期会话；传 userId 则只清该用户 */
function purge_expired_sessions($userId = null)
{
    if ($userId === null) {
        execute("DELETE FROM sessions WHERE expires_at < datetime('now')");
        return;
    }
    execute("DELETE FROM sessions WHERE user_id = ? AND expires_at < datetime('now')", [(int) $userId]);
}

/* ------------------------------------------------------------------ */
/* 登录限速                                                            */
/* ------------------------------------------------------------------ */

/** 统计窗口（秒） */
define('LOGIN_WINDOW_SECONDS', 15 * 60);
/** 窗口内允许的失败次数，超过则锁定 */
define('LOGIN_MAX_FAILURES', 8);

/**
 * 限速状态文件。
 *
 * 放在 php/data/ 下（PHP 没有跨请求内存，只能落文件）：
 * PHP 没有跨请求内存，用文件是等价且唯一可行的做法（不改动数据库结构）。
 *
 * @return string
 */
function throttle_file()
{
    $dir = PHP_DATA_DIR;
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir . '/login_throttle.json';
}

/** 统一的小写 key，避免大小写差异绕过限制 */
function throttle_key($username)
{
    return strtolower(trim((string) $username));
}

/**
 * 读限速状态（加共享锁）。
 *
 * @return array<string,array>
 */
function throttle_read()
{
    $file = throttle_file();
    if (!is_file($file)) {
        return [];
    }
    $fp = @fopen($file, 'c+');
    if ($fp === false) {
        return [];
    }
    @flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    @flock($fp, LOCK_UN);
    fclose($fp);

    $data = json_decode((string) $raw, true);
    return is_array($data) ? $data : [];
}

/** 记一次登录失败 */
/**
 * 在一把独占锁内完成「读 → 改 → 写」。
 *
 * 为什么必须这样：限速原来是 throttle_read()（LOCK_SH）+ throttle_write()（LOCK_EX）
 * 两次独立的开锁，中间没有临界区。并发 N 个错误登录会各自读到同一份旧快照、
 * 各自 +1 再互相覆盖 —— 8 次失败只记成 1 次，LOGIN_MAX_FAILURES 永远触发不了，
 * 限速器形同虚设。
 *
 * @param callable $mutator 接收当前数据，返回写入的数据；返回 null 表示放弃写入
 */
function throttle_update(callable $mutator)
{
    $file = throttle_file();
    $fp = @fopen($file, 'c+');
    if ($fp === false) {
        return;
    }
    // 全程持有 LOCK_EX：读也在锁内，杜绝 read-modify-write 的竞态
    @flock($fp, LOCK_EX);

    $raw = stream_get_contents($fp);
    $data = json_decode((string) $raw, true);
    $data = is_array($data) ? $data : [];

    $updated = $mutator($data);
    if (is_array($updated)) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($updated));
        fflush($fp);
    }

    @flock($fp, LOCK_UN);
    fclose($fp);
}
/**
 * 写限速状态（加独占锁）。
 *
 * @param array $data
 */
function throttle_write(array $data)
{
    // 顺手清理过期条目，避免文件无限增长
    $now = time();
    foreach ($data as $key => $entry) {
        // 条目被外部改坏时可能不是数组，直接下标访问会产生
        // "Trying to access array offset on value of type int" 警告
        if (!is_array($entry)) {
            unset($data[$key]);
            continue;
        }
        $firstAt = (int) ($entry['firstAt'] ?? 0);
        $blockedUntil = (int) ($entry['blockedUntil'] ?? 0);
        $expired = ($now - $firstAt > LOGIN_WINDOW_SECONDS) && ($blockedUntil <= 0 || $blockedUntil <= $now);
        if ($expired) {
            unset($data[$key]);
        }
    }

    // 复用 throttle_update 的单锁写入，避免 read-modify-write 竞态
    throttle_update(function () use ($data) {
        return $data;
    });
}

/**
 * 登录前置检查：处于锁定状态时抛 429。
 *
 * 登录失败次数超限的提示文案：
 * 「登录失败次数过多，请 {minutes} 分钟后再试」
 *
 * @param string $username
 */
function login_throttle($username)
{
    $key = throttle_key($username);
    if ($key === '') {
        return;
    }
    $data = throttle_read();
    if (!isset($data[$key]['blockedUntil'])) {
        return;
    }
    $left = (int) ceil(((int) $data[$key]['blockedUntil'] - time()) / 1);
    if ($left <= 0) {
        return;
    }
    $minutes = (int) ceil($left / 60);
    throw http_error(429, "登录失败次数过多，请 {$minutes} 分钟后再试");
}


/**
 * 记一次登录失败，返回记完之后该账号的失败次数（供测试断言）。
 *
 * @return int
 */
function record_login_failure($username)
{
    $key = throttle_key($username);
    if ($key === '') {
        return 0;
    }
    $now = time();
    $result = 0;

    throttle_update(function ($data) use ($key, $now, &$result) {
        // 文件被外部改坏时条目可能不是数组，直接丢弃重建
        $entry = isset($data[$key]) && is_array($data[$key]) ? $data[$key] : null;

        if ($entry === null || $now - (int) $entry['firstAt'] > LOGIN_WINDOW_SECONDS) {
            $data[$key] = ['count' => 1, 'firstAt' => $now, 'blockedUntil' => 0];
            $result = 1;
            return $data;
        }

        $data[$key]['count'] = (int) $entry['count'] + 1;
        if ((int) $data[$key]['count'] >= LOGIN_MAX_FAILURES) {
            $data[$key]['blockedUntil'] = $now + LOGIN_WINDOW_SECONDS;
            $data[$key]['count'] = 0;
            $data[$key]['firstAt'] = $now;
        }
        $result = (int) $data[$key]['count'];
        return $data;
    });

    return $result;
}

/** 登录成功后清空该账号的失败记录 */
function clear_login_failures($username)
{
    $key = throttle_key($username);
    if ($key === '') {
        return;
    }
    $data = throttle_read();
    unset($data[$key]);
    throttle_write($data);
}
