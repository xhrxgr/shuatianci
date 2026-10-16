<?php
/**
 * v3.7.2 的回归测试：直接压 update_state 的并发与原子性。
 * 不依赖 HTTP、不依赖浏览器 —— 这几个函数本身就是并发正确性的地基。
 *
 * 跑法：php php/tests/update-state-test.php
 */
require_once __DIR__ . '/../app/system_state.php';

$pass = 0;
$fail = 0;
function check($label, $ok, $detail = '')
{
    global $pass, $fail;
    if ($ok) {
        $pass++;
        echo "  PASS  $label\n";
    } else {
        $fail++;
        echo "  FAIL  $label" . ($detail !== '' ? " → $detail" : '') . "\n";
    }
}

$stateFile = update_state_file();
function reset_state()
{
    @unlink(update_state_file());
    @unlink(update_state_lock_file());
}

echo "更新状态机回归测试\n";

/* ---- 1. 并发 try_start：6 个进程同时抢，只应有一个成功 ---- */
reset_state();
$script = escapeshellarg(__DIR__ . '/update-state-worker.php');
$procs = [];
for ($i = 0; $i < 6; $i++) {
    $descriptors = [1 => ['pipe', 'w']];
    $p = proc_open(PHP_BINARY . ' ' . $script, $descriptors, $pipes, dirname(__DIR__));
    if (is_resource($p)) {
        $procs[] = [$p, $pipes];
    }
}
$results = [];
foreach ($procs as [$p, $pipes]) {
    $results[] = trim((string) stream_get_contents($pipes[1]));
    fclose($pipes[1]);
    proc_close($p);
}
$accepted = count(array_filter($results, function ($r) { return $r === 'A'; }));
check(
    '并发 try_start 只有 1 个能启动（锁必须落在不被 rename 替换的独立文件上）',
    $accepted === 1,
    'accepted=' . $accepted . ' results=' . implode(',', $results)
);

/* ---- 2. 原子写不留半截文件 ---- */
reset_state();
update_state_write(['stage' => '测试阶段', 'log' => ['一行']]);
$raw = (string) @file_get_contents($stateFile);
$decoded = json_decode($raw, true);
check(
    '状态文件写入后是完整合法 JSON（原子替换生效）',
    is_array($decoded) && ($decoded['stage'] ?? '') === '测试阶段',
    'raw=' . substr($raw, 0, 80)
);

/* ---- 3. 并发追加日志不丢行 ---- */
reset_state();
update_state_write(['running' => false, 'log' => []]);
$procs = [];
for ($i = 0; $i < 5; $i++) {
    $descriptors = [1 => ['pipe', 'w']];
    $p = proc_open(PHP_BINARY . ' ' . escapeshellarg(__DIR__ . '/update-state-worker.php') . ' log ' . $i, $descriptors, $pipes, dirname(__DIR__));
    if (is_resource($p)) {
        $procs[] = [$p, $pipes];
    }
}
foreach ($procs as [$p, $pipes]) {
    stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    proc_close($p);
}
$state = update_state_read();
$logCount = count((array) ($state['log'] ?? []));
check('并发追加 5 条日志一条不丢', $logCount === 5, "log 行数=$logCount");

/* ---- 4. stale 阈值边界 ---- */
reset_state();
update_state_write(['running' => true, 'startedAt' => gmdate('c', time() - 601), 'pid' => null]);
$state = update_state_read();
check('601 秒 → 判定为 stale', update_state_is_stale($state) === true);

update_state_write(['startedAt' => gmdate('c', time() - 599)]);
$state = update_state_read();
check('599 秒 → 不判 stale', update_state_is_stale($state) === false);

/* ---- 5. 按 pid 判存活（仅在能判断进程存活的平台上验证）----
   Windows 既无 posix 也无 /proc，update_state_pid_alive() 恒返回 true，
   这条路径只能在服务器（Linux）上验证，本地跳过而不是假装通过。 */
reset_state();
$canJudgePid = function_exists('posix_kill') || is_dir('/proc');
if ($canJudgePid) {
    update_state_write([
        'running' => true,
        'startedAt' => gmdate('c', time() - 1200),
        'pid' => 999999,
    ]);
    check('stale 且进程已死 → 允许解除占用', update_state_lock_is_releasable(update_state_read()) === true);

    update_state_write(['pid' => getmypid()]);
    check(
        'stale 但进程还活着 → 不解除占用（避免两个 reset 互踩）',
        update_state_lock_is_releasable(update_state_read()) === false
    );
} else {
    echo "  SKIP  按 pid 判存活（当前平台无 posix/proc，需在 Linux 服务器上验证）
";
}

/* ---- 6. try_start 自愈解锁：走「无 pid」分支，跨平台可测 ----
   老版本写的状态没有 pid 字段，此时只看超时即可解除 —— 这正是线上
   OOM 之后那批卡住的更新的实际情况。 */
reset_state();
update_state_write([
    'running' => true,
    'startedAt' => gmdate('c', time() - 1800),
    'stage' => '拉取代码',
]);
$ok = update_state_try_start();
$state = update_state_read();
check(
    '自愈：陈旧且失去进程的 running 状态能被下一次更新解除',
    $ok === true && !empty($state['running']),
    'try_start=' . var_export($ok, true)
);
check('自愈过程写入了日志（用户看得见发生了什么）', count((array) ($state['log'] ?? [])) > 0);

/* ---- 7. 未超时的 running 不能被抢 ---- */
reset_state();
update_state_write(['running' => true, 'startedAt' => gmdate('c'), 'pid' => getmypid()]);
check('正常进行中的更新不会被第二次请求抢走', update_state_try_start() === false);

reset_state();

echo "\n通过 $pass 项，失败 $fail 项\n";
exit($fail > 0 ? 1 : 0);