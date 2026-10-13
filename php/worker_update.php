<?php
/**
 * 后台更新进程：由 /api/system/update 拉起，独立于 Web 请求运行。
 *
 * 流程极简：拉代码 → 刷新 opcache。任何一步失败都回滚到执行前的提交。
 *
 * 两个与早期版本不同的地方：
 * 1. **没有构建步骤**——v3.0.0 起前端由 PHP 渲染，页面与脚本都是仓库里的源文件，
 *    拉完代码就已完成更新，不需要 npm，也不需要备份/还原构建产物。
 * 2. **用 reset --hard 而不是 pull --ff-only**——这个仓库的提交历史被重写过，
 *    pull 会因「无法快进」失败。服务器上不该有本地提交，reset 到远端分支正是期望语义。
 */

// 只允许命令行执行（拉起方式：nohup php worker_update.php &）。
// 直接通过浏览器访问会触发一次真实的代码更新，必须在入口挡掉。
// nginx 层的 deny 是第二道防线，这里不依赖它。
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"禁止访问"}';
    exit;
}

require_once __DIR__ . '/app/config.php';
require_once __DIR__ . '/app/util.php';
require_once __DIR__ . '/app/system_state.php';
require_once __DIR__ . '/app/routes_system.php';

/** 标记需要刷新 opcache（由 update-status 接口消费） */
function mark_reload()
{
    @file_put_contents(reload_flag_file(), (string) time());
}

$version = read_version();
$branch = $version !== null ? $version['branch'] : 'master';
$rollback = git_cmd(['rev-parse', 'HEAD'], 20);
$rollbackCommit = $rollback['out'];

try {
    update_state_start();
    update_state_log("开始更新，当前分支 {$branch}，提交 " . substr($rollbackCommit, 0, 7));

    // ---- 1. 拉取代码 ----
    update_state_write(['stage' => '拉取代码']);
    update_state_log('git fetch origin');
    $fetch = git_cmd(['fetch', 'origin', '--prune'], 60);
    if ($fetch['code'] !== 0) {
        $raw = trim($fetch['err'] !== '' ? $fetch['err'] : $fetch['out']);
        update_state_log('git 报错：' . $raw);
        // 常见的凭据 / 网络故障翻译成可操作的中文（git_failure_hint）
        // 现在 hint 永不为空（含超时场景），但仍保留 $raw 兜底以防后端被改动
        $hint = git_failure_hint($raw, $fetch);
        throw new RuntimeException($hint !== '' ? $hint : $raw);
    }

    $target = 'origin/' . $branch;
    update_state_log("git reset --hard {$target}");
    $reset = git_cmd(['reset', '--hard', $target], 60);
    if ($reset['code'] !== 0) {
        throw new RuntimeException(trim($reset['err'] !== '' ? $reset['err'] : $reset['out']));
    }

    $new = git_cmd(['rev-parse', 'HEAD'], 20);
    update_state_log('代码已更新到 ' . substr($new['out'], 0, 7));

    // ---- 2. 收尾：刷新 PHP 缓存 ----
    update_state_write(['stage' => '应用新代码']);
    update_state_log('前端为 PHP 渲染，无构建步骤；代码已生效');
    mark_reload();
    update_state_log('已刷新 PHP 缓存');
    update_state_finish(null);
} catch (Throwable $e) {
    // ---- 回滚 ----
    update_state_write(['stage' => '回滚中']);
    $detail = trim($e->getMessage());
    update_state_log('更新失败：' . $detail);
    update_state_log('正在回滚到 ' . substr($rollbackCommit, 0, 7));

    $resetBack = git_cmd(['reset', '--hard', $rollbackCommit], 30);
    if ($resetBack['code'] === 0) {
        update_state_log('代码已回滚');
    } else {
        update_state_log('代码回滚失败：' . trim($resetBack['err']));
    }

    update_state_log('已停止在旧版本，站点仍可正常使用');
    update_state_finish($detail);
}
