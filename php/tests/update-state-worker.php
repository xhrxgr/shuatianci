<?php
/**
 * update-state-test.php 的子进程入口（由父测试并发拉起多个）。
 * 用法：php update-state-worker.php [log <n>]
 */
require_once __DIR__ . '/../app/system_state.php';

$mode = $argv[1] ?? 'start';

if ($mode === 'log') {
    // 追加一条日志；父测试期望 5 个并发进程写 5 条，一条都不能丢
    update_state_log('并发日志 ' . (int) ($argv[2] ?? 0));
    echo "L";
    exit(0);
}

echo update_state_try_start() ? 'A' : 'B';