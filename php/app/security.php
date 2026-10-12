<?php
/**
 * 安全响应头。
 *
 * 与 Node 版 middleware/security.js 逐条对应：同样的默认 CSP、
 * 同样的 X-Content-Type-Options / Referrer-Policy / X-Frame-Options，
 * 同样的「CSP_POLICY=off 可关闭、非空则整体替换」规则。
 *
 * CSP 里必须保留 'unsafe-inline'：仓库根 index.html 的内联部署引导脚本
 * 是「前端入口没跑起来时唯一还能执行的东西」，禁掉内联会让引导页失效。
 */

require_once __DIR__ . '/config.php';

/** 默认 CSP，与 Node 版 DEFAULT_CSP 完全一致 */
function default_csp()
{
    return implode('; ', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]);
}

/** 下发安全响应头 */
function send_security_headers()
{
    if (headers_sent()) {
        return;
    }
    $configured = trim(env_value('CSP_POLICY', ''));
    $policy = ($configured === 'off') ? '' : ($configured !== '' ? $configured : default_csp());

    if ($policy !== '') {
        header('Content-Security-Policy: ' . $policy);
    }
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    // 旧浏览器不认 CSP 的 frame-ancestors，补一个传统头
    header('X-Frame-Options: DENY');
}

/**
 * CORS。与 Node 版一样默认关闭（同域部署不需要）；
 * 只有显式设置 CORS_ORIGINS 才开启。
 *
 * @return bool 是否本次请求已按预检结束（调用方应立即返回）
 */
function send_cors_headers()
{
    if (headers_sent()) {
        return false;
    }
    $configured = trim(env_value('CORS_ORIGINS', ''));
    if ($configured === '') {
        return false;
    }

    $origin = isset($_SERVER['HTTP_ORIGIN']) ? (string) $_SERVER['HTTP_ORIGIN'] : '';
    if ($configured === '*') {
        header('Access-Control-Allow-Origin: ' . ($origin !== '' ? $origin : '*'));
        header('Vary: Origin');
    } else {
        $allowed = array_map('trim', explode(',', $configured));
        if ($origin !== '' && in_array($origin, $allowed, true)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Vary: Origin');
        }
    }
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, token');
    header('Access-Control-Max-Age: 600');

    // 预检请求直接结束，与 cors 中间件行为一致
    if (strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(204);
        return true;
    }
    return false;
}
