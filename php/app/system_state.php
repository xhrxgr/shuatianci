<?php
/**
 * 在线更新的进度状态。
 *
 * 原先把状态放在进程内存里；PHP 没有跨请求内存，改为存文件。
 * PHP 每个请求是独立的，后台更新必须落在**另一个进程**里跑，
 * 因此状态改用文件存（php/data/update_state.json），接口读文件即可。
 *
 * 这是本模块唯一的实现差异，对外的接口契约（字段名与含义）完全一致。
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/util.php';

/** 状态文件路径 */
function update_state_file()
{
    $dir = PHP_DATA_DIR;
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir . '/update_state.json';
}

/** opcache 刷新标记：由后台进程写、由下一次接口请求消费 */
function reload_flag_file()
{
    return PHP_DATA_DIR . '/reload.flag';
}

/**
 * 若存在「刷新 opcache」标记，则立即刷新并消费掉。
 *
 * 更新进程跑完后由**任意请求**触发（index.php 入口与更新状态接口都调用）：
 * PHP-FPM 的 opcache 无法被 CLI 进程刷新；这样无论管理员接下来打开哪个页面，
 * 第一个到达的请求都会让新代码生效 —— 「更新完成后自动生效」。
 */
function maybe_apply_reload_flag()
{
    $flag = reload_flag_file();
    if (!is_file($flag)) {
        return;
    }
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }
    @unlink($flag);
}

/** 空状态 */
function update_state_blank()
{
    return [
        'running' => false,
        'stage' => '',
        'log' => [],
        'error' => null,
        'finished' => false,
        'startedAt' => null,
        'finishedAt' => null,
    ];
}

/**
 * 读取状态（带独占锁，避免与后台进程写冲突）。
 *
 * @return array
 */
function update_state_read()
{
    $file = update_state_file();
    if (!is_file($file)) {
        return update_state_blank();
    }
    $fp = @fopen($file, 'c+');
    if ($fp === false) {
        return update_state_blank();
    }
    @flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    @flock($fp, LOCK_UN);
    fclose($fp);

    $data = json_decode((string) $raw, true);
    if (!is_array($data)) {
        return update_state_blank();
    }
    return array_merge(update_state_blank(), $data);
}

/**
 * 写入状态（合并式，带独占锁）。
 *
 * @param array $patch
 */
function update_state_write(array $patch)
{
    $fp = @fopen(update_state_file(), 'c');
    if ($fp === false) {
        return;
    }
    @flock($fp, LOCK_EX);

    // 在锁内重新读一次，避免覆盖后台进程刚写的内容
    $raw = stream_get_contents($fp);
    $current = json_decode((string) $raw, true);
    if (!is_array($current)) {
        $current = update_state_blank();
    }

    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode(array_merge($current, $patch), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    fflush($fp);
    @flock($fp, LOCK_UN);
    fclose($fp);
}

/**
 * 追加一行日志（只保留最近 200 行）。
 *
 * @param string $line
 */
function update_state_log($line)
{
    $state = update_state_read();
    $state['log'][] = '[' . date('H:i:s') . '] ' . $line;
    if (count($state['log']) > 200) {
        $state['log'] = array_slice($state['log'], -200);
    }
    update_state_write(['log' => $state['log']]);
}

/** 重置状态，开始一次新的更新 */
function update_state_start()
{
    update_state_write([
        'running' => true,
        'stage' => '准备中',
        'log' => [],
        'error' => null,
        'finished' => false,
        'startedAt' => now_iso(),
        'finishedAt' => null,
    ]);
}

/**
 * 尝试开始一次更新：只有在「当前没在跑」时才置位。
 *
 * 与「先 read 再 start」的区别：那两步之间有时间窗，两个请求可以同时通过检查、
 * 各启一个后台进程，两个 git reset --hard 互相踩。
 * 这里把「检查」与「置位」放进同一个独占锁里，只有一个请求能成功。
 *
 * @return bool true 表示由本次调用启动；false 表示已有更新在跑
 */
function update_state_try_start()
{
    $fp = @fopen(update_state_file(), 'c');
    if ($fp === false) {
        return false;
    }
    @flock($fp, LOCK_EX);

    $raw = stream_get_contents($fp);
    $current = json_decode((string) $raw, true);
    if (!is_array($current)) {
        $current = update_state_blank();
    }
    if (!empty($current['running'])) {
        @flock($fp, LOCK_UN);
        fclose($fp);
        return false;
    }

    $next = array_merge($current, [
        'running' => true,
        'stage' => '准备中',
        'log' => [],
        'error' => null,
        'finished' => false,
        'startedAt' => now_iso(),
        'finishedAt' => null,
    ]);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($next, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    fflush($fp);
    @flock($fp, LOCK_UN);
    fclose($fp);

    return true;
}

/**
 * 这次「进行中」的更新是不是已经明显超时（多半是后台进程挂了）。
 *
 * worker 正常流程最长不过两三分钟（fetch / reset 各有 60s 超时），
 * 超过这个量级还停在 running，基本可以确定进程已经异常退出——
 * 而它退出时可能来不及写状态，界面就会永远转圈、且后续更新被 409 挡死。
 *
 * @param array $state
 * @param int   $staleSeconds 判定时长，默认 10 分钟
 * @return bool
 */
function update_state_is_stale(array $state, $staleSeconds = 600)
{
    if (empty($state['running']) || empty($state['startedAt'])) {
        return false;
    }
    $started = strtotime((string) $state['startedAt']);
    if ($started <= 0) {
        return false;
    }
    return (time() - $started) > $staleSeconds;
}

/** 结束一次更新 */
function update_state_finish($error = null)
{
    update_state_write([
        'running' => false,
        'finished' => true,
        'finishedAt' => now_iso(),
        'error' => $error,
    ]);
}
