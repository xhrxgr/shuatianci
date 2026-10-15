<?php
/**
 * 更新源配置（仓库地址 + 可选的加速通道）。
 *
 * 为什么要做成后台可配
 * --------------------
 * 部署环境能不能直连 GitHub 是**每个服务器不同**的：有的直连就行，
 * 有的（比如境内机房）必须走加速通道。以前这件事只能 SSH 上去敲
 * `git config url."...".insteadOf "..."`，写进 .git/config 里，
 * 换服务器、换方案都要重来一次，还得记得那条命令。
 *
 * 为什么不用 git config，而是把参数挂在命令上
 * -------------------------------------------
 * 写 .git/config 需要目录对该用户可写，而线上恰恰经常因为属主错位
 * （用 root 跑过 git）导致写不进去——「insufficient permission for adding
 * an object」那类故障的同源问题。这里改成给 git 命令临时加
 * `-c url."<加速前缀>".insteadOf "<原始前缀>"`，**完全不碰 .git/config**：
 *   · 不需要目录可写，只对当前这条命令生效
 *   · 不影响服务器上其他项目的 git 配置
 *   · 改配置立刻生效，不需要重开终端
 *
 * 配置文件：php/data/update_source.json（与 update_state.json 同目录）
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/errors.php';

/** 默认仓库地址（官方仓库） */
function update_source_default_remote()
{
    return 'https://github.com/xhrxgr/shuatianci.git';
}

/** 配置文件路径 */
function update_source_file()
{
    $dir = PHP_DATA_DIR;
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir . '/update_source.json';
}

/**
 * 常用加速通道预设。
 *
 * 前缀的用法是「把远端地址里的这一段替换成它」：
 *   https://gh-proxy.com/https://github.com/  +  https://github.com/xhrxgr/x.git
 *   → https://gh-proxy.com/https://github.com/xhrxgr/x.git
 * 所以预设里都以「原地址开头」结束，末尾带一个 /。
 */
function update_source_presets()
{
    return [
        [
            'id' => 'direct',
            'label' => '直连 GitHub',
            'hint' => '服务器能直接访问 github.com 时选这个',
            'proxy' => '',
        ],
        [
            'id' => 'gh-proxy',
            'label' => 'gh-proxy.com',
            'hint' => '最常用的公共加速通道',
            'proxy' => 'https://gh-proxy.com/https://github.com/',
            'thirdParty' => true,
        ],
        [
            'id' => 'ghfast',
            'label' => 'ghfast.top',
            'hint' => 'gh-proxy 的镜像',
            'proxy' => 'https://ghfast.top/https://github.com/',
            'thirdParty' => true,
        ],
        [
            'id' => 'hub-fgit',
            'label' => '自建反代',
            'hint' => '若你有自己的 GitHub 反代，把它的前缀填在下面',
            'proxy' => '',
            'thirdParty' => true,
        ],
    ];
}

/**
 * 当前选的加速通道是不是第三方（会把流量交给别人的服务器）。
 *
 * 这件事必须让用户知道：加速通道是**中间人**，它转发的是另一台机器上的内容。
 * git 只能保证取回来的对象自洽（内容寻址），**无法保证那就是 GitHub 发布的原版**——
 * 代理理论上可以返回构造好的对象，等于在服务器上执行别人的代码。
 * 所以界面上要写明，而不是悄悄走掉。
 *
 * @param array $config update_source_read() 的结果
 * @return bool
 */
function update_source_is_third_party(array $config)
{
    if ($config['preset'] === 'direct' || $config['proxy'] === '') {
        return false;
    }
    foreach (update_source_presets() as $preset) {
        if ($preset['id'] === $config['preset']) {
            return !empty($preset['thirdParty']);
        }
    }
    // 自定义前缀：也是第三方
    return true;
}

/**
 * 仓库里实际配置的 origin 地址（git 眼中的远端）。
 *
 * 网页上填的地址**必须**同步到这里，否则形同虚设：
 * 测试连接与真正更新执行的都是 `git fetch origin` / `ls-remote origin`，
 * 读的是 git 自己记的那个地址，不是我们配置文件里的那个。
 *
 * @return string 取不到返回空串
 */
function update_source_git_remote()
{
    if (!function_exists('git_cmd')) {
        return '';
    }
    $result = git_cmd(['config', '--get', 'remote.origin.url'], 15);
    if ($result['code'] !== 0) {
        return '';
    }
    return trim($result['out']);
}

/**
 * 把地址写进 git 自己的配置（remote.origin.url）。
 *
 * 只写配置文件不够——更新时 git 用的是 `.git/config` 里的 origin。
 * 写失败不阻断保存（多半是属主/权限问题），但要如实告诉用户需要手工补一步。
 *
 * @param string $remote
 * @return array{ok:bool,error:string}
 */
function update_source_apply_remote($remote)
{
    $remote = update_source_normalize_remote($remote);
    if ($remote === '') {
        return ['ok' => false, 'error' => '仓库地址不合法'];
    }
    if (!function_exists('git_cmd')) {
        return ['ok' => false, 'error' => '当前环境无法执行 git 命令'];
    }
    $result = git_cmd(['remote', 'set-url', 'origin', $remote], 20);
    if ($result['code'] !== 0) {
        $raw = trim($result['err'] !== '' ? $result['err'] : $result['out']);
        return [
            'ok' => false,
            'error' => '已保存配置，但同步到 git 失败（' . ($raw !== '' ? $raw : '未知原因')
                . '）。请在服务器项目目录执行：git remote set-url origin ' . $remote,
        ];
    }
    return ['ok' => true, 'error' => ''];
}

/**
 * 读当前配置。
 *
 * @return array{remote:string,proxy:string,preset:string}
 */
function update_source_read()
{
    $file = update_source_file();
    $defaults = [
        'remote' => update_source_default_remote(),
        'proxy' => '',
        'preset' => 'direct',
    ];
    if (!is_file($file)) {
        return $defaults;
    }
    $raw = @file_get_contents($file);
    if ($raw === false) {
        return $defaults;
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return $defaults;
    }
    // 逐项校验：文件可能被手工改坏，坏的值不能直接拿去拼 git 命令
    $remote = update_source_normalize_remote((string) ($data['remote'] ?? ''));
    $proxy = update_source_normalize_proxy((string) ($data['proxy'] ?? ''));
    $preset = (string) ($data['preset'] ?? 'direct');
    // 读取时同样以 preset 为准：配置文件被手工改坏过（preset=direct 却带着 proxy），
    // 在这里就归一，界面与实际行为不会各说各话
    if ($preset === 'direct') {
        $proxy = '';
    }
    return [
        'remote' => $remote !== '' ? $remote : $defaults['remote'],
        'proxy' => $proxy,
        'preset' => $preset,
    ];
}

/**
 * 校验并规范化仓库地址。
 *
 * 只接受 http/https 与两种 SSH 形式；其余一律拒绝——
 * 这个值会被拼进命令行，必须挡住 shell 元字符。
 *
 * @return string 规范化后的地址；不合法返回空串
 */
function update_source_normalize_remote($remote)
{
    $remote = trim((string) $remote);
    if ($remote === '') {
        return '';
    }
    // 挡住换行、引号、反引号、管道、分号等一切 shell 元字符
    if (preg_match('/[\s"\'`;|&$<>\\\\]/', $remote)) {
        return '';
    }
    // SSH 两种形式：git@github.com:owner/repo.git
    if (preg_match('#^[\w.\-]+@[\w.\-]+:[\w./\-]+$#', $remote) === 1) {
        return $remote;
    }
    $scheme = parse_url($remote, PHP_URL_SCHEME);
    $host = parse_url($remote, PHP_URL_HOST);
    if ($scheme !== 'http' && $scheme !== 'https') {
        return '';
    }
    if (!is_string($host) || $host === '') {
        return '';
    }
    // 端口限制在合法范围
    $port = parse_url($remote, PHP_URL_PORT);
    if ($port !== null && ((int) $port < 1 || (int) $port > 65535)) {
        return '';
    }
    return rtrim($remote, '/');
}

/**
 * 校验并规范化加速前缀。
 *
 * 同样必须以 http/https 开头（加速地址基本都是 https 站点）。
 * 末尾统一补一个 /，避免拼接时把原路径的首个字符吃掉。
 *
 * @return string；不合法返回空串
 */
function update_source_normalize_proxy($proxy)
{
    $proxy = trim((string) $proxy);
    if ($proxy === '') {
        return '';
    }
    if (preg_match('/[\s"\'`;|&$<>\\\\]/', $proxy)) {
        return '';
    }
    $scheme = parse_url($proxy, PHP_URL_SCHEME);
    $host = parse_url($proxy, PHP_URL_HOST);
    if ($scheme !== 'http' && $scheme !== 'https') {
        return '';
    }
    if (!is_string($host) || $host === '') {
        return '';
    }
    return rtrim($proxy, '/') . '/';
}

/**
 * 保存配置。
 *
 * @param array $input { remote, proxy, preset }
 * @return array{ok:bool,error?:string,config?:array}
 */
function update_source_save(array $input)
{
    $remote = update_source_normalize_remote((string) ($input['remote'] ?? ''));
    if ($remote === '') {
        return ['ok' => false, 'error' => '仓库地址不合法：只支持 https:// 或 http:// 开头的地址'];
    }
    $proxy = update_source_normalize_proxy((string) ($input['proxy'] ?? ''));
    $rawProxy = trim((string) ($input['proxy'] ?? ''));
    if ($rawProxy !== '' && $proxy === '') {
        return ['ok' => false, 'error' => '加速地址不合法：只支持 https:// 或 http:// 开头的地址'];
    }
    $preset = (string) ($input['preset'] ?? 'direct');

    // preset 是唯一权威：选了「直连」就一定不挂加速地址。
    // 否则会出现「界面显示直连 GitHub，实际访问 gh-proxy.com」这种自相矛盾的状态
    // ——成因是 proxy 字段与 preset 不同步（比如切回直连时前端仍提交了上次的 proxy，
    //   或配置文件被手工改过）。这里在落盘前就归一，脏数据不留。
    if ($preset === 'direct') {
        $proxy = '';
        $rawProxy = '';
    }

    $data = ['remote' => $remote, 'proxy' => $proxy, 'preset' => $preset];
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        return ['ok' => false, 'error' => '配置内容无法编码'];
    }

    $file = update_source_file();
    $fp = @fopen($file, 'c');
    if ($fp === false) {
        return ['ok' => false, 'error' => '无法写入配置文件，请检查 php/data 目录是否可写'];
    }
    @flock($fp, LOCK_EX);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, $json);
    fflush($fp);
    @flock($fp, LOCK_UN);
    fclose($fp);

    return ['ok' => true, 'config' => $data];
}

/**
 * 算出该给 git 加的 `-c` 参数。
 *
 * 关键点：**不改 .git/config**，只给当前这条命令临时加参数。
 * 于是：目录不需要可写、换个服务器重新配一次即可、改完立刻生效。
 *
 * 另外要注意：如果远端是 SSH 形式（git@github.com:...），
 * insteadOf 要匹配的是 git 实际会去连的那个 URL，
 * 此时用户应该改用 HTTPS 远端 + https 加速前缀。
 *
 * @return array<int,string> 形如 ['-c', 'url."https://gh-proxy.com/https://github.com/".insteadOf="https://github.com/"']
 */
function update_source_git_args()
{
    $config = update_source_read();
    // preset 说走直连就一定不加 insteadOf —— 即使配置文件里还留着 proxy。
    // 「界面显示直连、实际访问加速地址」是最难排查的一类问题，
    // 在这里堵住，比在界面上解释得清楚
    if ($config['preset'] === 'direct') {
        return [];
    }
    $proxy = $config['proxy'];
    if ($proxy === '') {
        return [];
    }
    // 远端本身若已被加速前缀覆盖（例如用户把 remote 直接填成加速地址），
    // 就不再叠加 insteadOf，否则会套出 https://gh-proxy.com/https://gh-proxy.com/...
    if (strpos($config['remote'], $proxy) === 0) {
        return [];
    }
    $target = 'https://github.com/';
    if (parse_url($config['remote'], PHP_URL_SCHEME) === 'http') {
        $target = 'http://github.com/';
    }
    // ⚠️ 这里**绝不能**用带双引号的写法 url."X".insteadOf="Y"：
    // run_command 在 Windows 下用 str_replace('"', '""', $arg) 转义，
    // 而 cmd 的解析规则里 "" 表示**字面两个引号**而不是转义，
    // git 于是收到 url.""X"".insteadOf=""Y"" 这个无效配置并**静默忽略**。
    // 实测：带引号时配一个必定不通的代理，ls-remote 依然 exit=0（假成功）；
    //       去掉引号后同一命令 exit=128 且确实走了代理。
    // git 支持「键=值」且值里不含空格时不加引号，这里两个值都不含空格。
    return [
        '-c',
        'url.' . $proxy . '.insteadOf=' . $target,
    ];
}

/**
 * 按配置算出实际会去访问的远端地址（用于界面展示，让用户知道走的是哪条路）。
 */
function update_source_effective_url()
{
    $config = update_source_read();
    $presetId = '';
    foreach (update_source_presets() as $preset) {
        if ($preset['proxy'] !== '' && $preset['proxy'] === $config['proxy']) {
            $presetId = $preset['id'];
            break;
        }
    }
    $args = update_source_git_args();
    // git 自己记的远端地址：更新时真正用的是它，不是我们配置文件里的那个。
    // 两者不一致时网页上填的地址就是空文，必须在界面上指出
    $gitRemote = update_source_git_remote();
    $common = [
        'gitRemote' => $gitRemote,
        // 拿不到 git 的地址（非 git 仓库 / git 不可用）时给 null，让前端区别「未知」与「不一致」
        'synced' => $gitRemote === '' ? null : ($gitRemote === $config['remote']),
        'thirdParty' => update_source_is_third_party($config),
    ];
    if ($args === []) {
        return [
            'direct' => $config['remote'],
            'proxy' => '',
            'preset' => $presetId === '' ? 'direct' : $presetId,
            'actual' => $config['remote'],
        ] + $common;
    }
    $proxy = $config['proxy'];
    $target = 'https://github.com/';
    // 只有远端本身就是 github.com 的地址时才做前缀替换；
    // 换成别的托管时 insteadOf 不匹配，实际访问的仍是原地址
    $actual = strpos($config['remote'], $target) === 0
        ? $proxy . substr($config['remote'], strlen($target))
        : $config['remote'];
    return [
        'direct' => $config['remote'],
        'proxy' => $proxy,
        'preset' => $presetId,
        'actual' => $actual,
    ] + $common;
}
