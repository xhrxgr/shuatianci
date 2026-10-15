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
require_once __DIR__ . '/update_source.php';

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
    // 退出码要在「检测到进程结束」的那一刻从 proc_get_status() 的 exitcode 取走。
    // 不能依赖 proc_close() 的返回值：PHP 官方文档明确 —— PHP < 8.3 时，
    // 调用过 proc_get_status() 之后 proc_close() 会返回 -1（8.3.0 才修复），
    // 会把「命令成功」误判成失败（如宝塔常见的老版本 PHP）。
    // 而旧版本下 exitcode 只有在第一次观察到进程退出时有效，所以要立刻保存。
    $exitCode = null;

    while (true) {
        $out .= (string) fread($pipes[1], 8192);
        $err .= (string) fread($pipes[2], 8192);
        $status = proc_get_status($process);
        if (!$status['running']) {
            if (isset($status['exitcode']) && (int) $status['exitcode'] >= 0) {
                $exitCode = (int) $status['exitcode'];
            }
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
    $closeCode = (int) proc_close($process);
    $code = $exitCode !== null ? $exitCode : $closeCode;

    return ['out' => trim($out), 'err' => trim($err), 'code' => $code];
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
    // 若后台配了加速通道，把 -c url.X.insteadOf=Y 临时挂在这条命令上。
    // 刻意**不写进 .git/config**：那个文件需要目录对该用户可写，
    // 而线上恰恰常因属主错位写不进去（同「insufficient permission」那类故障）。
    // 临时参数不碰任何文件，也就不受权限影响，改完配置立刻生效。
    $args = array_merge(update_source_git_args(), $args);

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
 * 把 git 的原始报错翻译成可操作的中文提示；无法归类时返回空串。
 *
 * 触发场景：网页更新以 PHP 的运行用户（宝塔上是 www）执行 git，
 * 该用户往往没有 SSH 密钥、也没有配 HTTPS 凭据，报错全是英文，
 * 直接贴给用户看等于没说，这里逐类给出具体做法。
 *
 * @param string $err
 * @return string
 */
/**
 * git fetch 失败时给出一句能照着做的说明。
 *
 * 设计要点：**永远不给「无法连接远端仓库」这种没法行动的话**。
 * git 在连接超时被中断时**一个字的错误都不打印**（stderr 为空），
 * 这时只能靠「没有输出」这件事本身来判断，并给出最可能的场景。
 *
 * @param string $err git 的 stderr（为空说明是被超时掐断的）
 * @param array|null $result git_cmd 的完整返回（含 code / timedOut）
 * @return string 一句带下一步操作的话
 */
function git_failure_hint($err, $result = null)
{
    $err = (string) $err;

    // 远端是 SSH 地址（git@github.com:...）但运行用户没有密钥
    if (stripos($err, 'Permission denied (publickey)') !== false) {
        return '远端仓库是 SSH 地址（git@github.com:...），但 PHP 的运行用户没有 SSH 密钥。'
            . '请把远端地址改成带令牌的 HTTPS 形式（README「网页一键更新」一节的 git remote set-url 命令），'
            . '或在 GitHub 仓库的 Deploy keys 中为该用户添加部署密钥。';
    }
    // HTTPS 凭据缺失或无效（令牌没配 / 写错 / 过期 / 误用账号密码）
    if (stripos($err, 'Authentication failed') !== false
        || stripos($err, 'Invalid username or password') !== false
        || stripos($err, 'could not read Username') !== false
        || stripos($err, 'terminal prompts disabled') !== false
        || stripos($err, 'Support for password authentication was removed') !== false) {
        return '仓库凭据缺失或无效：请确认远端地址里带上了有效的只读令牌且未过期'
            . '（README「网页一键更新」一节有完整的 git remote set-url 命令）。';
    }
    // 网络 / DNS
    if (stripos($err, 'Could not resolve host') !== false
        || stripos($err, 'Failed to connect') !== false
        || stripos($err, 'Connection timed out') !== false
        || stripos($err, 'network is unreachable') !== false) {
        return '无法连接 GitHub：请检查服务器的网络与出站防火墙规则（能否正常访问 github.com）。';
    }

    // 仓库不可写（root 跑过 git 导致属主错位）——这个提示比任何猜测都准
    if (stripos($err, 'insufficient permission') !== false
        || stripos($err, 'failed to write object') !== false
        || stripos($err, 'unpack-objects failed') !== false
        || stripos($err, 'Permission denied') !== false && stripos($err, '.git') !== false) {
        return '网络与凭据都没问题——仓库目录的写入权限不足，'
            . 'git 已经连上远端但无法把代码写进 .git 目录。'
            . '原因是文件属主变成了 root，而 PHP 运行时用户没有写权限。'
            . '解决办法：在项目目录执行 bash update.sh，'
            . '它会让 git 全程以 PHP 的运行用户身份执行，属主从头到尾正确，'
            . '不需要 sudo 也不需要 chown。'
            . '（服务器只能用 root 登录也没关系，脚本已处理。）';
    }

    // git 报「仓库不存在 / 拒绝访问」——公开仓库不该出现，出现就是地址写错
    if (stripos($err, 'not found') !== false
        || stripos($err, 'Repository not found') !== false
        || stripos($err, '403') !== false) {
        return '远端仓库不存在或拒绝访问：请确认仓库地址与访问权限（公开仓库不该出现这个错误）。';
    }

    // 执行超时：run_command 会往 err 里追加「执行超时（Ns），已终止」
    if (stripos($err, '执行超时') !== false) {
        return '连接 GitHub 超时（git 一直没等到响应，已被终止）。'
            . '常见原因：服务器出站被限制，或未配置加速通道。'
            . '请先在服务器上以运行 PHP 的那个用户手动执行 git fetch origin 看真实报错，'
            . '或按 README 配置 gh-proxy 加速通道。';
    }

    // 一个字都没打印 = 连接被防火墙丢弃（SYN 无响应，git 静静等到被掐断）。
    // 本项目部署环境已知的情况是：服务器无法直连 github.com，必须走加速通道。
    if (trim($err) === '') {
        return '连不上 GitHub，且 git 没有输出任何错误——通常是出站连接被静默丢弃（网络不通或被防火墙拦截）。'
            . '本项目的部署环境无法直连 github.com，需要配置加速通道：'
            . '在项目目录执行 git config url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/" '
            . '并 chown www:www .git/config；'
            . '若已配置仍失败，请以运行 PHP 的用户（通常是 www）手动执行 git fetch origin 查看真实报错。';
    }

    // 兜底：把 git 的原话带上，别让它无声消失
    $short = trim(preg_replace('/\s+/', ' ', substr($err, 0, 160)));
    return '拉取远端失败：' . $short . '（若为网络问题，请检查服务器能否访问 github.com，'
        . '或配置 gh-proxy 加速通道，命令见 README）';
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
        // rev-parse 只读不写，能成功不代表能写入。
        // 典型事故：用root 跑 git reset --hard 更新后，.git 下的文件属主变成
        // root，PHP 以 www 运行就写不进去——此时读版本一切正常，
        // 一到 git fetch 才报「insufficient permission for adding an object」。
        // 所以这里额外检查一次「能不能写」，把这类问题挡在更新之前。
        $writeProblem = git_objects_not_writable();
        if ($writeProblem !== null) {
            return $writeProblem;
        }
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
    // git 拒绝：目录属主与运行用户不一致（git 2.35+ 的 dubious ownership 保护）。
    // 典型场景：root 克隆的目录，而 PHP-FPM 以 www 运行。
    // 旧版 git（2.35.1/2.35.2）的措辞是 "unsafe repository"，一并识别。
    if (stripos($result['err'], 'dubious ownership') !== false
        || stripos($result['err'], 'unsafe repository') !== false
        || stripos($result['err'], 'safe.directory') !== false) {
        return 'PHP 的运行用户与项目目录的属主不一致，git 出于安全拒绝操作。'
            . '在服务器上执行 chown -R www:www 项目目录（www 换成 PHP 的实际运行用户）即可解决。';
    }
    // 其余未知原因：不能再"猜"，直接跑一遍环境诊断（运行账号、HOME/PATH、
    // git 能否找到、关键路径属主、真实报错），把结果附在提示里，一次定位。
    $raw = 'php=' . PHP_VERSION . '; exit=' . $result['code']
        . '; out=' . $result['out'] . '; err=' . $result['err'];
    if (PHP_OS_FAMILY !== 'Windows') {
        $diag = run_command(
            'pwd -P 2>&1; id 2>&1; echo "HOME=$HOME"; echo "PATH=$PATH"; '
                . 'command -v git || echo "git-not-found"; git --version 2>&1; '
                . 'ls -ld . .git .git/config 2>&1; '
                . 'git rev-parse HEAD 2>&1; echo "rev-parse-exit=$?"',
            APP_DIR,
            15
        );
        $extra = trim($diag['out'] . ' ' . $diag['err']);
        if ($extra !== '') {
            $raw .= '; ' . $extra;
        }
    }
    $raw = preg_replace('/\s+/', ' ', $raw);
    $raw = function_exists('mb_substr') ? mb_substr($raw, 0, 900, 'UTF-8') : substr($raw, 0, 900);
    return '当前目录不是 git 仓库，无法使用在线更新。如果是复制粘贴部署的，请先按 README「让项目支持在线更新」一节初始化。'
        . '（诊断信息：' . $raw . '）';
}

/**
 * 工作区里**会被 reset --hard 覆盖**的本地改动。
 *
 * 只算已跟踪文件的改动：未跟踪文件（??）不在 git 的对象管理里，
 * `reset --hard` 不会动它们，把它们算作"危险"会拦住大量正常场景
 * （比如用户只是在项目目录里放了个备份文件）。
 *
 * @return array|null 改动的文件列表（相对路径）；查不出来返回 null
 */
function git_tracked_changes()
{
    $result = git_cmd(['status', '--porcelain'], 20);
    if ($result['code'] !== 0) {
        // 查不出来就不拦：不能因为探测失败而永远禁止更新
        return null;
    }
    $files = [];
    foreach (explode("\n", (string) $result['out']) as $line) {
        // 只能用 rtrim：porcelain 每行开头是「两个状态字符 + 一个空格」，
        // 第一个状态字符常常是空格（如 " M README.md"）。用 trim 会把这个空格
        // 也去掉，后面 substr(3) 就会多切掉路径的第一个字符（实测出过 "EADME.md"）
        $line = rtrim($line);
        if ($line === '') {
            continue;
        }
        // 未跟踪文件：reset --hard 不会动它们，不算危险
        if (strpos($line, '??') === 0) {
            continue;
        }
        // 不能用固定偏移 substr(3)：run_command 会对整个输出做 trim()，
        // 第一行的行首空格（状态位的一部分）被吃掉，固定偏移就多切一个字符
        // （实测出现过 "hp/app/routes_system.php" 这种缺字母的路径）。
        // 去掉两个状态字符后再 ltrim，两种行都正确
        $files[] = ltrim(substr($line, 2));
    }
    return $files;
}

/**
 * 把「有本地改动」这件事说清楚，并给出下一步。
 *
 * @param array $files git_tracked_changes() 的结果
 * @return string
 */
function git_dirty_message(array $files)
{
    $count = count($files);
    $list = implode('、', array_slice($files, 0, 5));
    $more = $count > 5 ? " 等 {$count} 个" : "";
    return "检测到 {$count} 个已跟踪文件有本地改动（{$list}{$more}），"
        . '更新会用 git reset --hard 覆盖它们且无法恢复，因此已取消。'
        . '请先处理这些改动：需要保留就 git stash 或提交，不需要就 git checkout -- <文件>，'
        . '或直接改用 bash update.sh（同样会覆盖，但你会先看到提示）。';
}

/**
 * 检查 git 能否往仓库里写东西（.git/objects 不可写时 fetch 必然失败）。
 *
 * 为什么必须实测而不是看属主：
 *   · 属主对但权限位不对（如 755 的目录只对属主可写）照样写不了
 *   · 属主不对时 git 2.35+ 会先报 dubious ownership，那是另一个问题
 *   · 只读类命令（rev-parse、log）完全正常，掩盖了写权限的问题
 * 所以直接写一个探针文件、写完即删——最接近 fetch 的真实动作。
 *
 * @return string|null 有问题返回可执行的中文说明，没问题返回 null
 */
function git_objects_not_writable()
{
    if (PHP_OS_FAMILY === 'Windows') {
        return null; // 本地开发不涉及属主问题
    }

    $probe = '.git/objects/.eq-write-probe-' . getmypid();
    $probePath = APP_DIR . '/' . $probe;
    // 上次探测可能因进程被杀而留下文件，先清掉，否则会误判为「可写」
    @unlink($probePath);
    $written = @file_put_contents($probePath, 'probe');
    if ($written !== false) {
        @unlink($probePath);
        return null;
    }
    @unlink($probePath);

    // 写不进去：查清是哪个目录、当前以谁的身份在跑，一次把话说全
    $diag = run_command(
        'id -un 2>&1; ls -ld . .git .git/objects 2>&1; test -w .git/objects && echo "objects-writable" || echo "objects-NOT-writable"',
        APP_DIR,
        10
    );
    $info = trim($diag['out']);
    $info = preg_replace('/\s+/', ' ', $info);
    $info = function_exists('mb_substr') ? mb_substr($info, 0, 400, 'UTF-8') : substr($info, 0, 400);

    return '无法把代码写入仓库目录，在线更新会失败（git fetch 会报 '
        . '"insufficient permission for adding an object"）。'
        . '原因是文件属主变成了 root，而 PHP 运行时用户没有写权限'
        . '（多半是用 root 直接跑过 git 命令）。'
        . '解决办法：在项目目录执行 bash update.sh ——'
        . '它会让 git 全程以 PHP 的运行用户身份执行，属主从头到尾正确，'
        . '不需要 sudo 也不需要 chown（root 直接跑即可）。'
        . '（当前状态：' . $info . '）';
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
        // 显示运行中的 PHP 版本：排障时经常需要（不同 PHP 版本行为有差异）
        'phpVersion' => PHP_VERSION,
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
        $raw = trim($fetch['err'] !== '' ? $fetch['err'] : $fetch['out']);
        $hint = git_failure_hint($raw, $fetch);
        json_response([
            'ok' => false,
            'error' => $hint,
            'detail' => $raw !== '' ? $raw : '(git fetch 没有输出任何错误信息，通常意味着连接超时被中断)',
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

    // 检查与置位在同一个独占锁里（update_state_try_start）：
    // 分开做会有时间窗，两个请求能同时通过、各启一个后台进程互相踩
    if (!update_state_try_start()) {
        json_response(['ok' => false, 'error' => '已有更新正在进行中'], 409);
    }

    // 先确认环境可用，避免点了按钮才发现问题
    $problem = git_repo_problem();
    if ($problem !== null) {
        update_state_finish($problem);
        json_response(['ok' => false, 'error' => $problem], 500);
    }

    // 本地改动会被 reset --hard 抹掉且无法恢复，必须在动手之前挡住。
    // 光在「检查更新」里提示不够——用户可以直接点更新按钮。
    $dirty = git_tracked_changes();
    if (!empty($dirty)) {
        // 已经置了 running，这里要把状态收掉，否则界面会一直显示「更新中」
        update_state_finish('已取消：存在未提交的本地改动');
        json_response([
            'ok' => false,
            'error' => git_dirty_message($dirty),
            'details' => array_slice($dirty, 0, 20),
            'dirtyCount' => count($dirty),
        ], 409);
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
    // CLI 进程无法刷新 FPM 的 opcache，由请求消费标记（入口 index.php 也做了同样的
    // 兜底：即使管理员中途关闭页面，新代码也会在下一个请求自动生效）。
    maybe_apply_reload_flag();

    $state = update_state_read();
    // 后台进程若异常退出（致命错误来不及写状态），界面会永远停在「更新中」，
    // 且后续更新被 409 挡死。这里按耗时判定并如实告知，让用户可以重试
    $stale = update_state_is_stale($state);
    json_response([
        'ok' => true,
        'running' => !empty($state['running']),
        'stage' => $stale ? '更新进程已超时未响应' : (string) $state['stage'],
        'log' => array_values((array) $state['log']),
        'error' => $stale
            ? '更新进程超过 10 分钟没有进展，多半已异常退出（详见 php/data/update_worker.log）。可重新发起更新。'
            : $state['error'],
        'finished' => !empty($state['finished']),
        'stale' => $stale,
        'startedAt' => $state['startedAt'],
        'finishedAt' => $state['finishedAt'],
    ]);
}

/* ------------------------------------------------------------------ */
/* 更新源配置（后台可配，不必 SSH 上去敲 git config）                  */
/* ------------------------------------------------------------------ */

/** GET /api/system/update-source —— 读取当前配置与可用预设 */
function route_system_update_source_get()
{
    require_permission('system:read');

    json_response([
        'ok' => true,
        'config' => update_source_read(),
        'effective' => update_source_effective_url(),
        'presets' => update_source_presets(),
        'defaultRemote' => update_source_default_remote(),
    ]);
}

/** PUT /api/system/update-source —— 保存配置 */
function route_system_update_source_set()
{
    require_permission('system:write');

    $body = request_body();
    $result = update_source_save([
        'remote' => $body['remote'] ?? '',
        'proxy' => $body['proxy'] ?? '',
        'preset' => $body['preset'] ?? 'direct',
    ]);

    if (!$result['ok']) {
        json_response(['ok' => false, 'error' => $result['error']], 400);
    }

    // 光写进配置文件没用：更新跑的是 `git fetch origin`，读的是 .git/config
    // 里那个地址。所以保存后立刻同步一次，让「网页上填的」与「git 实际用的」
    // 永远一致——两者不一致时界面显示的一切都是假象。
    $config = update_source_read();
    $applied = update_source_apply_remote($config['remote']);

    json_response([
        'ok' => true,
        'config' => $config,
        'effective' => update_source_effective_url(),
        // 同步失败也要如实回给前端（多半是属主/权限问题），让用户知道还得手工补一步
        'remoteSynced' => $applied['ok'],
        'remoteWarn' => $applied['ok'] ? '' : $applied['error'],
    ]);
}

/**
 * POST /api/system/update-source/test —— 拿这组参数真的拉一次远端。
 *
 * 这是这个功能最要紧的一环：配置错了如果只有「保存成功」，
 * 用户还是得等「检查更新」失败才知道。而这里能立刻告诉他通不通，
 * 而且用的是**和真正更新时完全一样的 git 命令**（同一个 git_cmd + 同一份配置），
 * 所以测出来的结果就是真的。
 */
function route_system_update_source_test()
{
    require_permission('system:write');

    $body = request_body();
    // 不落盘，只验证传进来的这一组
    $remote = update_source_normalize_remote((string) ($body['remote'] ?? ''));
    if ($remote === '') {
        json_response(['ok' => false, 'error' => '仓库地址不合法：只支持 https:// 或 http:// 开头的地址'], 400);
    }
    $rawProxy = trim((string) ($body['proxy'] ?? ''));
    $proxy = update_source_normalize_proxy($rawProxy);
    if ($rawProxy !== '' && $proxy === '') {
        json_response(['ok' => false, 'error' => '加速地址不合法：只支持 https:// 或 http:// 开头的地址'], 400);
    }

    // 临时把配置写成这组，测完恢复——保证走的是与真正更新时一致的代码路径
    $backup = update_source_read();
    $saved = update_source_save([
        'remote' => $remote,
        'proxy' => $proxy,
        'preset' => (string) ($body['preset'] ?? 'direct'),
    ]);
    if (!$saved['ok']) {
        json_response(['ok' => false, 'error' => $saved['error']], 400);
    }

    // 这里**不能**写成 try { ... json_response(...) } finally { 还原 }。
    // json_response() 内部是 exit，而 PHP 的 exit 会**跳过 finally**——
    // 于是「测试后还原配置」根本不会执行（实测：连点几次测试后，
    // 用户的配置被留在测试用的那组参数上）。所以先跑命令、
    // 还原配置，最后再响应。
    //
    // 命令选型踩过两个坑，都是实测出来的：
    //
    // 1) 不能用 `ls-remote <完整URL>`：显式传 URL 时 git **绕过** insteadOf
    //    直接连原地址，于是配了不通的代理也会报「连接成功」（假阳性）。
    //    必须用 `ls-remote origin`，让它去读仓库里配置的远端。
    // 2) 不能用 `fetch --dry-run`：实测它连接失败时退出码不稳定，
    //    判定要同时看 stderr 里有没有 fatal，不能只看 code。
    //    `ls-remote origin` 两者都可靠（成功 0 / 失败 128 + fatal）。
    $result = git_cmd(['ls-remote', 'origin'], 45);

    // 先还原配置，再响应：无论如何都不留下测试用的临时设置
    update_source_save($backup);

    $raw = trim($result['err'] !== '' ? $result['err'] : $result['out']);
    // 双重判定：退出码非 0，或 stderr 里有 fatal，都算失败。
    // 只看退出码会漏掉「报错但 code=0」的情况，那时会误报成连接成功。
    $failed = $result['code'] !== 0 || stripos($raw, 'fatal:') !== false;
    if (!$failed) {
        json_response([
            'ok' => true,
            'reachable' => true,
            'effective' => update_source_effective_url(),
            'message' => '连接成功',
        ]);
    }
    json_response([
        'ok' => false,
        'reachable' => false,
        'hint' => git_failure_hint($raw, $result),
        'detail' => $raw !== '' ? $raw : '(git 没有输出任何错误)',
        'effective' => update_source_effective_url(),
    ], 200);
}
