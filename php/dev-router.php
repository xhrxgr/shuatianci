<?php
/**
 * 仅供本地验证使用的开发路由脚本（生产环境不需要）。
 *
 * 用法（在项目根目录执行）：
 *   php -S 127.0.0.1:9001 php/dev-router.php
 *
 * 它模拟生产环境 nginx 干的三件事：
 *   /api/*     -> php/index.php（接口）
 *   /assets/*  -> php/assets/*（静态 JS / CSS，直接吐文件）
 *   其余       -> php/index.php（页面，服务端渲染）
 *
 * 生产环境里这三件事分别由 nginx 的 location /api、location /assets 与
 * location / 完成，部署时不要把这个文件暴露出去。
 */

// 只允许 php -S（cli-server）使用。生产环境（nginx + PHP-FPM）下这个文件
// 没有任何用途，浏览器直接访问它也没有意义，直接挡掉。
if (PHP_SAPI !== 'cli-server') {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"禁止访问"}';
    exit;
}

$uri = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);

// 静态资源：CSS 与 JS 直接吐，不进 PHP 渲染流程
if (strpos($uri, '/assets/') === 0) {
    $relative = substr($uri, strlen('/assets'));
    // 防目录穿越
    if (strpos($relative, '..') !== false) {
        http_response_code(403);
        return true;
    }
    $file = __DIR__ . '/assets' . $relative;
    if (is_file($file)) {
        $types = [
            'css' => 'text/css; charset=utf-8',
            'js' => 'text/javascript; charset=utf-8',
            'svg' => 'image/svg+xml',
            'png' => 'image/png',
            'jpg' => 'image/jpeg',
            'ico' => 'image/x-icon',
            'woff2' => 'font/woff2',
        ];
        $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
        readfile($file);
        return true;
    }
    http_response_code(404);
    return true;
}

// 接口与页面都由入口处理
require __DIR__ . '/index.php';
return true;
