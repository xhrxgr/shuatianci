<?php
/**
 * /api/system/* —— 版本、检查更新、执行更新、更新进度。
 *
 * 安全设计：
 * 1. 仅管理员可访问（system:read / system:write）
 * 2. 命令一律写死在代码里，参数不接受任何请求输入，不存在命令注入面
 * 3. git 执行时带 GIT_TERMINAL_PROMPT=0，缺凭据时立刻失败而不是挂住等输入
 * 4. 更新失败自动回滚到执行前的提交，并恢复旧的构建产物
 *
 * 两处实现差异（详见迁移文档）：
 * - Node 在进程内异步跑更新、状态存内存；PHP 由独立后台进程跑、状态存文件
 * - Node 用 pm2 restart 重启；PHP-FPM 每次请求都是新进程，代码改动自动生效，
 *   只在开启 opcache 时需要刷新缓存（由 update-status 接口消费标记文件完成）
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';
require_once __DIR__ . '/system_state.php';

/**
 * 执行一条命令并取回输出。
 *
 * PHP 没有 execFile 那种「超时即杀」的内置封装，这里用 proc_open +
 * 轮询 proc_get_status 自己实现超时，行为与 Node 的 timeout 选项对齐。
 *
 * @param string $command
 * @param string $cwd
 * @param int $timeoutSec
 * @return array{out:string,err:string,code:int}
 */
function run_command($command, $cwd, $timeoutSec = 60)
{
    // 被 disable_functions 禁用的函数不能直接调用：function_exists 会返回 false，
    // 强行调用会抛 Error（"Call to undefined function"）——@ 抑制不住，会变成接口 500。
    // 所以必须先检查并给出可读原因（宝塔默认禁用 proc_open 与 proc_get_status）。
    $missing = [];
    if (!function_exists('proc_open')) {
        $missing[] = 'proc_open';
    }
    if (!function_exists('proc_get_status')) {
        $missing[] = 'proc_get_status';
    }
    if ($missing !== []) {
        return [
            'out' => '',
            'err' => 'PHP 函数被禁用：' . implode('、', $missing) . '（php.ini 的 disable_functions）',
            'code' => -1,
        ];
    }

    $descriptors = [
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    $process = @proc_open($command, $descriptors, $pipes, $cwd);
    if (!is_resource($process)) {
        return ['out' => '', 'err' => '无法启动进程（exec 系列函数可能被禁用）', 'code' => -1];
    }

    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $out = '';
    $err = '';
    $deadline = time() + max(1, $timeoutSec);

    while (true) {
        $out .= (string) fread($pipes[1], 8192);
        $err .= (string) fread($pipes[2], 8192);
        $status = proc_get_status($process);
        if (!$status['running']) {
            break;
        }
        if (time() > $deadline) {
            proc_terminate($process);
            $err .= "\n执行超时（{$timeoutSec}s），已终止";
            break;
        }
        usleep(100000);
    }

    $out .= (string) stream_get_contents($pipes[1]);
    $err .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($process);

    return ['out' => trim($out), 'err' => trim($err), 'code' => (int) $code];
}

/**
 * 执行 git 子命令。参数全部由代码给出。
 *
 * @param array $args
 * @param int $timeoutSec
 * @return array{out:string,err:string,code:int}
 */
function git_cmd(array $args, $timeoutSec = 30)
{
    if (PHP_OS_FAMILY === 'Windows') {
        // Windows 下不能用 escapeshellarg：它会把参数里的 % 和 ! 替换成空格，
        // 而 git 的 --format=%cI / --format=%s 这类参数必须保留 %。
        // 这里自己加引号即可（参数都是代码里写死的，不含需要转义的元字符）。
        $escaped = implode(' ', array_map(function ($arg) {
            return '"' . str_replace('"', '""', $arg) . '"';
        }, $args));
    } else {
        $escaped = implode(' ', array_map('escapeshellarg', $args));
    }
    // GIT_TERMINAL_PROMPT=0：没有凭据时立刻失败，不卡在交互式输入上
    $prefix = (PHP_OS_FAMILY === 'Windows') ? 'set GIT_TERMINAL_PROMPT=0 && ' : 'GIT_TERMINAL_PROMPT=0 ';
    return run_command($prefix . 'git ' . $escaped, APP_DIR, $timeoutSec);
}

/**
 * 找一个能执行 CLI 脚本的 php 可执行文件，找不到返回 null。
 *
 * 不能直接用 PHP_BINARY：在 PHP-FPM 下它指向 php-fpm 本身
 * （宝塔环境形如 /www/server/php/82/sbin/php-fpm），而 php-fpm 无法执行脚本。
 * 按可靠性依次探测：CLI 命名 → 宝塔同版本 → 从 php-fpm 路径推断 →
 * 宝塔其他版本 → 系统通用位置。
 *
 * @return string|null
 */
function find_php_cli()
{
    $binary = (string) PHP_BINARY;
    $basename = $binary !== '' ? basename($binary) : '';

    // 命名本身就是 CLI 的（php / php8 / php8.2 / php.exe），直接用
    if ($basename !== '' && preg_match('/^php(\d+(\.\d+)*)?(\.exe)?$/', $basename) === 1) {
        return $binary;
    }

    $short = PHP_MAJOR_VERSION . PHP_MINOR_VERSION;
    $candidates = [];

    // 宝塔：与当前 FPM 同版本的 CLI
    $candidates[] = '/www/server/php/' . $short . '/bin/php';

    // 从 php-fpm 路径推断：.../sbin/php-fpm -> .../bin/php
    if (strpos($binary, DIRECTORY_SEPARATOR) !== false) {
        $candidates[] = dirname(dirname($binary)) . '/bin/php';
    }

    // 宝塔装了多个版本时，退而求其次用任一可用版本（worker 只用核心函数）
    foreach (glob('/www/server/php/*/bin/php') ?: [] as $path) {
        $candidates[] = $path;
    }

    $candidates[] = '/usr/local/bin/php';
    $candidates[] = '/usr/bin/php';

    foreach ($candidates as $path) {
        if ($path !== '' && @is_executable($path)) {
            return $path;
        }
    }

    return null;
}

/**
 * 项目目录是否为可用的 git 仓库。有问题返回原因，正常返回 null。
 *
 * 报错要区分成因，否则用户会被误导（以为是仓库问题，实际是函数被禁）。
 *
 * @return string|null
 */
function git_repo_problem()
{
    $result = git_cmd(['rev-parse', 'HEAD'], 15);
    if ($result['code'] === 0) {
        return null;
    }
    // proc_open / proc_get_status 被禁用（宝塔默认禁用它们）
    if ($result['code'] === -1 && (strpos($result['err'], '被禁用') !== false
            || strpos($result['err'], '无法启动进程') !== false)) {
        return 'PHP 的 proc_open / proc_get_status 函数被禁用，无法执行 git 命令。'
            . '请到面板的 PHP 设置 →「禁用函数」里移除这两个函数，在线更新才能使用。';
    }
    // 系统没有 git
    if ($result['code'] === 127) {
        return '服务器上找不到 git 命令，无法使用在线更新（面板软件商店可安装 git）。';
    }
    return '当前目录不是 git 仓库，无法使用在线更新。如果是复制粘贴部署的，请先按 README「让项目支持在线更新」一节初始化。';
}

/**
 * 读取当前部署的版本信息。
 *
 * @return array|null
 */
function read_version()
{
    $commit = git_cmd(['rev-parse', 'HEAD']);
    if ($commit['code'] !== 0) {
        return null;
    }
    $date = git_cmd(['log', '-1', '--format=%cI']);
    $subject = git_cmd(['log', '-1', '--format=%s']);
    $branch = git_cmd(['rev-parse', '--abbrev-ref', 'HEAD']);

    $hash = $commit['out'];
    return [
        'commit' => $hash,
        'shortCommit' => substr($hash, 0, 7),
        'commitDate' => $date['out'],
        'commitSubject' => $subject['out'],
        'branch' => $branch['out'],
    ];
}

/** GET /api/system/version */
function route_system_version()
{
    require_permission('system:read');

    $problem = git_repo_problem();
    if ($problem !== null) {
        // 不是 git 仓库时不报错，返回可读的占位信息，前端能正常渲染
        json_response([
            'ok' => true,
            'gitAvailable' => false,
            'version' => [
                'commit' => '',
                'shortCommit' => '未知',
                'commitDate' => '',
                'commitSubject' => $problem,
                'branch' => '',
            ],
        ]);
    }

    json_response(['ok' => true, 'gitAvailable' => true, 'version' => read_version()]);
}

/** POST /api/system/check-update */
function route_system_check_update()
{
    require_permission('system:read');

    $problem = git_repo_problem();
    if ($problem !== null) {
        json_response(['ok' => false, 'error' => $problem], 500);
    }

    $current = read_version();

    // 有未提交改动时提示用户
    $status = git_cmd(['status', '--porcelain'], 20);
    $dirty = trim($status['out']) !== '';

    $fetch = git_cmd(['fetch', 'origin', '--prune'], 60);
    if ($fetch['code'] !== 0) {
        json_response([
            'ok' => false,
            'error' => '无法连接远端仓库，请检查服务器上的 git 凭据是否已配置',
            'detail' => trim($fetch['err'] !== '' ? $fetch['err'] : $fetch['out']),
        ], 502);
    }

    $remote = git_cmd(['rev-parse', 'origin/' . $current['branch']], 20);
    $remoteCommit = $remote['out'];

    if ($remoteCommit === $current['commit']) {
        json_response(['ok' => true, 'hasUpdate' => false, 'current' => $current, 'dirty' => $dirty]);
    }

    // 列出落后的提交，最新的在前
    $log = git_cmd(['log', '--pretty=format:%h|%cI|%s', 'HEAD..origin/' . $current['branch']], 30);
    $commits = [];
    foreach (explode("\n", $log['out']) as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $parts = explode('|', $line, 3);
        $commits[] = [
            'hash' => $parts[0] ?? '',
            'date' => $parts[1] ?? '',
            'subject' => $parts[2] ?? '',
        ];
    }

    json_response([
        'ok' => true,
        'hasUpdate' => true,
        'behind' => count($commits),
        'commits' => $commits,
        'current' => $current,
        'latest' => [
            'commit' => $remoteCommit,
            'shortCommit' => substr($remoteCommit, 0, 7),
        ],
        'dirty' => $dirty,
    ]);
}

/** POST /api/system/update —— 启动更新（异步执行，立即返回） */
function route_system_update()
{
    require_permission('system:write');

    $state = update_state_read();
    if (!empty($state['running'])) {
        json_response(['ok' => false, 'error' => '已有更新正在进行中'], 409);
    }

    // 先确认环境可用，避免点了按钮才发现问题
    $problem = git_repo_problem();
    if ($problem !== null) {
        json_response(['ok' => false, 'error' => $problem], 500);
    }

    // 先占位，防止并发触发两次更新
    update_state_start();

    // 启动独立的后台进程执行更新，本请求立即返回，前端轮询进度。
    // 不能用 PHP_BINARY：FPM 下它指向 php-fpm，无法执行脚本（见 find_php_cli）
    $phpBin = find_php_cli();
    if ($phpBin === null) {
        update_state_finish('找不到可用的 php 命令行程序（CLI），无法启动后台更新');
        json_response([
            'ok' => false,
            'error' => '找不到可用的 php 命令行程序（CLI）。如果 PHP 由面板安装，请检查 /www/server/php/<版本>/bin/php 是否存在且可执行',
        ], 500);
    }
    $worker = dirname(__DIR__) . '/worker_update.php';
    $logFile = PHP_DATA_DIR . '/update_worker.log';
    if (!is_dir(PHP_DATA_DIR)) {
        @mkdir(PHP_DATA_DIR, 0755, true);
    }

    if (PHP_OS_FAMILY === 'Windows') {
        $command = 'start /B "" ' . escapeshellarg($phpBin) . ' ' . escapeshellarg($worker)
            . ' > ' . escapeshellarg($logFile) . ' 2>&1';
    } else {
        $command = 'nohup ' . escapeshellarg($phpBin) . ' ' . escapeshellarg($worker)
            . ' > ' . escapeshellarg($logFile) . ' 2>&1 &';
    }
    $result = run_command($command, APP_DIR, 10);
    if ($result['code'] !== 0 && $result['code'] !== -1) {
        update_state_finish('无法启动后台更新进程，请检查 PHP 是否禁用了 exec 系列函数');
        json_response(['ok' => false, 'error' => '无法启动后台更新进程'], 500);
    }

    json_response(['ok' => true, 'started' => true]);
}

/** GET /api/system/update-status —— 查询更新进度 */
function route_system_update_status()
{
    require_permission('system:read');

    // 后台进程更新完代码后，需要刷新 opcache 才能让新代码生效。
    // CLI 进程无法刷新 FPM 的 opcache，所以由这个接口来消费标记。
    $flag = reload_flag_file();
    if (is_file($flag)) {
        if (function_exists('opcache_reset')) {
            @opcache_reset();
        }
        @unlink($flag);
    }

    $state = update_state_read();
    json_response([
        'ok' => true,
        'running' => !empty($state['running']),
        'stage' => (string) $state['stage'],
        'log' => array_values((array) $state['log']),
        'error' => $state['error'],
        'finished' => !empty($state['finished']),
        'startedAt' => $state['startedAt'],
        'finishedAt' => $state['finishedAt'],
    ]);
}
