<?php
/**
 * 维护模式与迁移守卫。
 *
 * 解决两个「代码切换期间」的窗口：
 *
 * 1. **reset --hard 不是原子的**
 *    git 逐文件改写工作区，没有「一次性切换」这个动作。切换那几秒里，
 *    并发请求可能读到**半新半旧**的代码组合（新 index.php + 旧 routes_*.php），
 *    于是 parse error 或函数不存在 → 整站 500，而且往往查不出原因。
 *
 *    对策：worker 在 reset 前写 `maintenance.flag`，bootstrap 看到这个标记
 *    就返回 503 维护页而不是半新半旧的代码。标记带时间戳，
 *    **超过 TTL 自动失效** —— worker 若被强杀，站点不会一直 503。
 *
 * 2. **数据库迁移失败会让整站 500**
 *    迁移在 bootstrap 里跑。若它抛错（ALTER TABLE 被锁、磁盘满、缺扩展），
 *    用户看到的是一个没有任何解释的白屏/500，而且此时 git 已经切到新版、
 *    worker 已经报「更新完成」，回滚逻辑根本不会触发。
 *
 *    对策：更新成功后写 `pending_migration.flag`，bootstrap 检测到它就先跑迁移；
 *    迁移失败则返回一个**说清原因与怎么办**的页面，并明确提示可以回滚代码
 *    （迁移只做加法，旧代码能兼容新的库结构）。
 */

require_once __DIR__ . '/errors.php';

/** 维护标记：worker 切换代码期间写，切换完成后删 */
function maintenance_flag_file()
{
    return dirname(__DIR__) . '/data/maintenance.flag';
}

/** 待迁移标记：更新成功后写，迁移成功后删 */
function pending_migration_flag_file()
{
    return dirname(__DIR__) . '/data/pending_migration.flag';
}

/**
 * 标记的有效期（秒）。超时即视为失效 —— 这是「worker 被强杀后站点一直
 * 维护中」的唯一防线，所以不能设太大：正常切换只有几秒。
 */
const MAINTENANCE_FLAG_TTL = 180;

function maintenance_mark($reason = '')
{
    $payload = ['at' => time(), 'reason' => (string) $reason];
    @file_put_contents(maintenance_flag_file(), json_encode($payload, JSON_UNESCAPED_UNICODE));
}

function maintenance_clear()
{
    @unlink(maintenance_flag_file());
}

/**
 * 当前是否处于维护窗口。
 *
 * 标记文件存在且未过期才算数：worker 在 reset 前写、reset 成功后删；
 * 若它在中途被强杀，标记会因过期而自动失效，不会把站点永久锁住。
 */
function maintenance_active()
{
    $file = maintenance_flag_file();
    if (!is_file($file)) {
        return false;
    }
    $raw = @file_get_contents($file);
    if ($raw === false || trim($raw) === '') {
        return false;
    }
    $data = json_decode($raw, true);
    $at = is_array($data) ? (int) ($data['at'] ?? 0) : (int) trim($raw);
    if ($at <= 0) {
        return false;
    }
    if ((time() - $at) > MAINTENANCE_FLAG_TTL) {
        return false;
    }
    return [
        'reason' => is_array($data) ? (string) ($data['reason'] ?? '') : '',
        'secondsLeft' => max(1, MAINTENANCE_FLAG_TTL - (time() - $at)),
    ];
}

function pending_migration_mark($commit = '')
{
    @file_put_contents(pending_migration_flag_file(), json_encode(
        ['at' => time(), 'commit' => (string) $commit],
        JSON_UNESCAPED_UNICODE
    ));
}

function pending_migration_clear()
{
    @unlink(pending_migration_flag_file());
}

function pending_migration_pending()
{
    $file = pending_migration_flag_file();
    return is_file($file) ? (int) @filemtime($file) : 0;
}

/**
 * 返回一段极简的 HTML（维护中 / 迁移失败都用它）。
 * 不引项目里的任何代码 —— 此刻项目代码本身可能正处于「半新半旧」状态。
 */
function maintenance_page($title, $detail, $hint = '')
{
    $esc = function ($v) {
        return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
    };
    $detailHtml = $detail === '' ? '' : '<p style="margin:12px 0 0;color:#64748B;line-height:1.8">' . $esc($detail) . '</p>';
    $hintHtml = $hint === '' ? '' : '<p style="margin:16px 0 0;padding:12px 14px;background:#F8FAFC;border-left:3px solid #94A3B8;'
        . 'color:#475569;line-height:1.8;border-radius:4px">' . $esc($hint) . '</p>';
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>' . $esc($title) . '</title>'
        . '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
        . 'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;'
        . 'background:#F8FAFC;color:#0F172A;padding:24px}'
        . '.box{max-width:32rem;width:100%;background:#fff;border:1px solid #E2E8F0;border-radius:12px;'
        . 'padding:28px 24px;box-shadow:0 1px 3px rgba(15,23,42,.06)}'
        . 'h1{margin:0;font-size:1.05rem;font-weight:600;letter-spacing:.01em}'
        . '@media(prefers-color-scheme:dark){body{background:#0B1220;color:#E2E8F0}'
        . '.box{background:#111827;border-color:#1F2937}'
        . '.box p{color:#94A3B8}.box .hint{background:#1E293B;border-left-color:#475569;color:#CBD5E1}}</style>'
        . '</head><body><div class="box"><h1>' . $esc($title) . '</h1>'
        . $detailHtml . $hintHtml
        . '</div><script>setTimeout(function(){location.reload()},3000)</script></body></html>';
}
