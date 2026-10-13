<?php
/**
 * 通用工具：JSON 响应、时间格式转换、请求体解析。
 *
 * 时间口径（全站统一）：
 * 库里是 SQLite 的 datetime('now')（UTC，'Y-m-d H:i:s'），
 * 对外统一转成 ISO 字符串，避免前端拿到两种格式。
 */

/**
 * 输出 JSON 并结束请求。
 *
 * @param mixed $data
 * @param int $status
 */
function json_response($data, $status = 200)
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * 数据库时间 -> ISO 字符串。
 *
 * 做法：把 '2026-10-12 08:00:00' 替换成 '2026-10-12T08:00:00Z' 再解析，
 * 即库里的裸字符串一律按 UTC 处理。这里保持同样口径。
 *
 * @param mixed $value
 * @return string|null
 */
function to_iso($value)
{
    if ($value === null || $value === '') {
        return null;
    }
    $raw = (string) $value;
    // 已经是 ISO（带 T）就按 ISO 解析，否则补 T 并按 UTC 处理
    $normalized = (strpos($raw, 'T') === false)
        ? str_replace(' ', 'T', $raw) . 'Z'
        : $raw;

    try {
        $dt = new DateTime($normalized, new DateTimeZone('UTC'));
    } catch (Exception $e) {
        return null;
    }
    // 与 Date.prototype.toISOString() 同格式：毫秒三位 + Z
    return $dt->format('Y-m-d\TH:i:s') . '.' . substr($dt->format('u'), 0, 3) . 'Z';
}

/**
 * ISO / 任意时间字符串 -> SQLite datetime 格式（UTC，与 datetime('now') 一致）。
 *
 * @param mixed $iso
 * @return string
 */
function to_sql_date($iso)
{
    try {
        $dt = new DateTime((string) $iso ?: 'now', new DateTimeZone('UTC'));
    } catch (Exception $e) {
        $dt = new DateTime('now', new DateTimeZone('UTC'));
    }
    return $dt->format('Y-m-d H:i:s');
}

/** 当前 UTC 时间的 SQLite 格式 */
function now_sql()
{
    return (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
}

/** 当前时间的 ISO 字符串 */
function now_iso()
{
    return to_iso(now_sql());
}

/**
 * 解析请求体 JSON。
 *
 * Express 的 express.json() 在请求体为空或非法时给出 {}，
 * 这里同样返回空数组，调用方用 ?? 取值即可。
 *
 * @return array
 */
function request_body()
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        $cache = [];
        return $cache;
    }
    $parsed = json_decode($raw, true);
    $cache = is_array($parsed) ? $parsed : [];
    return $cache;
}

/**
 * 取请求体字段。
 *
 * @param string $key
 * @param mixed $default
 * @return mixed
 */
function body_param($key, $default = null)
{
    $body = request_body();
    return array_key_exists($key, $body) ? $body[$key] : $default;
}

/**
 * 去掉查询串与 /api 前缀后的路径，如 "/questions/q_0001"。
 *
 * @param string $requestUri
 * @return string
 */
function request_path($requestUri)
{
    $path = parse_url((string) $requestUri, PHP_URL_PATH);
    if ($path === null || $path === false) {
        $path = '/';
    }
    // 只在「脚本路径真的出现在 URI 开头」时才剥离（/php/index.php/api/x 这类部署）。
    // 必须限定以 .php 结尾：php -S 的 router 模式下 SCRIPT_NAME 就是请求路径本身，
    // 不做这个判断会把整个 URI 吃掉，所有路由都匹配不上。
    $scriptName = isset($_SERVER['SCRIPT_NAME']) ? (string) $_SERVER['SCRIPT_NAME'] : '';
    if ($scriptName !== '' && substr($scriptName, -4) === '.php' && strpos($path, $scriptName) === 0) {
        $path = substr($path, strlen($scriptName));
    }
    if (strpos($path, '/api') === 0) {
        // '/api' 是 4 个字符
        $path = substr($path, 4);
        // '/api' 后面可能直接结束，也可能带 '/'，都要能落到 '/'
        if ($path !== '' && $path[0] !== '/') {
            $path = '/' . $path;
        }
    }
    if ($path === '' || $path === false) {
        $path = '/';
    }
    return rtrim($path, '/') === '' ? '/' : rtrim($path, '/');
}
