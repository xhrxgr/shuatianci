<?php
/**
 * 配置管理。
 *
 * 配置只有一个来源：php/.env（找不到时回退项目根 .env）。
 * 找不到 .env 时全部走代码内默认值，保证「拷上去就能跑」。
 *
 * PHP 没有内置 dotenv，这里自行解析 .env（同样的 key=value 格式）
 * （KEY=VALUE，# 开头为注释，忽略空行），不引入 Composer 依赖。
 */

/**
 * 项目根。
 * 本文件位于 php/app/，上两级才是项目根。
 */
define('APP_DIR', dirname(__DIR__, 2));
/** php/ 目录本身：.env、data/、sql/ 都在这里，后端的东西收在一处 */
define('PHP_DIR', dirname(__DIR__));
/** PHP 侧私有数据：数据库、登录限速状态、更新进度 */
define('PHP_DATA_DIR', PHP_DIR . '/data');

/**
 * 解析 .env 文件。
 *
 * @param string $path
 * @return array<string,string>
 */
function read_env_file($path)
{
    $result = [];
    if (!is_file($path) || !is_readable($path)) {
        return $result;
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        return $result;
    }
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') {
            continue;
        }
        $pos = strpos($line, '=');
        if ($pos === false) {
            continue;
        }
        $key = trim(substr($line, 0, $pos));
        $value = trim(substr($line, $pos + 1));
        // 去掉成对引号，与 dotenv 的行为对齐
        if (strlen($value) >= 2) {
            $first = $value[0];
            $last = $value[strlen($value) - 1];
            if (($first === '"' || $first === "'") && $last === $first) {
                $value = substr($value, 1, -1);
            }
        }
        $result[$key] = $value;
    }
    return $result;
}

/** 环境变量缓存 */
$GLOBALS['__env'] = null;

/**
 * 配置文件路径：php/.env 优先，找不到时回退到项目根 .env。
 *
 * @return string|null
 */
function env_file_path()
{
    $primary = PHP_DIR . '/.env';
    if (is_file($primary)) {
        return $primary;
    }
    $fallback = APP_DIR . '/.env';
    return is_file($fallback) ? $fallback : null;
}

/**
 * 读取配置项。优先级：真实环境变量 > .env > 默认值。
 *
 * @param string $key
 * @param string $default
 * @return string
 */
function env_value($key, $default = '')
{
    if ($GLOBALS['__env'] === null) {
        $path = env_file_path();
        $GLOBALS['__env'] = $path === null ? [] : read_env_file($path);
    }

    $fromServer = getenv($key);
    if ($fromServer !== false && $fromServer !== '') {
        return $fromServer;
    }
    if (isset($GLOBALS['__env'][$key]) && $GLOBALS['__env'][$key] !== '') {
        return $GLOBALS['__env'][$key];
    }
    return $default;
}

/**
 * 数据库文件绝对路径。
 *
 * DB_FILE 是相对 php/ 目录解析的（默认 php/data/english_quiz.db）。
 * 从旧的 server/data/english_quiz.db 迁移过来时，把文件复制过去即可，
 * 表结构完全一致，不需要任何转换。
 *
 * @return string
 */
function database_file()
{
    $configured = env_value('DB_FILE', 'data/english_quiz.db');
    if ($configured !== '' && $configured[0] === '/') {
        return $configured;
    }
    // Windows 盘符路径（C:\... 或 C:/...）也视为绝对路径
    if (preg_match('/^[A-Za-z]:[\/\\\\]/', $configured) === 1) {
        return $configured;
    }
    return PHP_DIR . '/' . ltrim($configured, '/');
}
