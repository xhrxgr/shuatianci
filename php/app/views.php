<?php
/**
 * 页面渲染。
 *
 * 与 Node 版「React SPA」的对应关系：
 *   src/App.tsx 的布局与导航 -> views/layout.php
 *   src/pages/*.tsx         -> views/*.php
 *   页面里需要交互的部分    -> assets/js/*.js（原生 JS，浏览器直接加载，不打包）
 *
 * 关键差别（对用户无感知）：
 * - 首屏由 PHP 直接从 SQLite 读数据渲染，不再「先下载 JS 再请求接口」，
 *   页面更快，也不再依赖 /api 才能出内容
 * - /api/* 全部保留且契约不变，只被 JS 的交互动作调用（提交答案、保存标签等）
 * - 页面跳转是普通链接（服务端渲染），刷题/录题等页面内部的交互仍不刷新
 */

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

/** HTML 转义 */
function e($value)
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

/**
 * 静态资源 URL 加缓存戳（文件修改时间）。
 *
 * 代码更新后 URL 随之变化，浏览器会自动重新下载，无需手动 Ctrl+F5；
 * 未变化的文件版本号不变，继续走缓存。
 *
 * @param string $path 形如 /app.css、/js/practice.js
 * @return string
 */
function asset_url($path)
{
    $path = '/' . ltrim((string) $path, '/');
    $url = '/assets' . $path;
    $file = PHP_DIR . '/assets' . $path;
    $mtime = is_file($file) ? filemtime($file) : false;
    return $mtime !== false ? $url . '?v=' . $mtime : $url;
}

/**
 * 渲染一个页面。
 *
 * @param string $view  views/ 下的模板名（不含扩展名）
 * @param array  $data  传给模板的变量
 * @param string $title 页面标题
 */
function render_page($view, array $data = [], $title = '高考英语短文填空题库')
{
    $user = current_user();
    $viewFile = dirname(__DIR__) . '/views/' . $view . '.php';

    if (!is_file($viewFile)) {
        http_response_code(404);
        $viewFile = dirname(__DIR__) . '/views/404.php';
    }

    if (!headers_sent()) {
        header('Content-Type: text/html; charset=utf-8');
    }

    extract($data, EXTR_SKIP);

    ob_start();
    include $viewFile;
    $content = ob_get_clean();

    // 布局里用 $content / $user / $title
    include dirname(__DIR__) . '/views/layout.php';
    exit;
}

/**
 * 导航栏项目（与 src/App.tsx 的 PUBLIC_ITEMS / USER_ITEMS / ADMIN_ITEMS 一致）。
 *
 * @param array|null $user
 * @return array
 */
function nav_items($user)
{
    $items = [
        ['to' => '/', 'label' => '首页'],
        ['to' => '/practice', 'label' => '刷题'],
    ];
    if ($user !== null) {
        $items[] = ['to' => '/profile', 'label' => '我的记录'];
        $items[] = ['to' => '/collection', 'label' => '我的收藏'];
    }
    if ($user !== null && $user['role'] === ROLE_ADMIN) {
        $items[] = ['to' => '/admin', 'label' => '题库管理'];
        $items[] = ['to' => '/admin/users', 'label' => '用户管理'];
        $items[] = ['to' => '/admin/system', 'label' => '系统设置'];
    }
    return $items;
}

/**
 * 判断导航项是否处于选中态。
 * 与 React Router 的 NavLink 口径一致：只有 "/" 与 "/admin" 需要精确匹配，
 * 其余按前缀匹配（/admin/users 会同时点亮 /admin）。
 */
function nav_is_active($to, $currentPath)
{
    if ($to === '/' || $to === '/admin') {
        return $to === $currentPath;
    }
    return strpos($currentPath, $to) === 0;
}

/** 导航链接的样式（选中 / 未选中），与 App.tsx 的 NavLink className 一致 */
function nav_link_class($to, $currentPath, $compact = false)
{
    $active = nav_is_active($to, $currentPath);
    if ($compact) {
        return 'mt-1 block rounded-lg px-4 py-3 text-sm font-medium transition '
            . ($active ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-alt');
    }
    return 'rounded-lg px-3 py-2 text-sm font-medium transition '
        . ($active ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-alt');
}

/**
 * 需要管理员的页面统一提示（对应 App.tsx 的 RequireAdmin）。
 * 未登录给出去登录的入口，非管理员提示无权限。
 *
 * @return string|null 返回 null 表示放行
 */
function guard_admin_page($user)
{
    if ($user === null) {
        return '<div class="rounded-xl border border-dashed border-line bg-surface p-12 text-center">'
            . '<p class="mb-4 text-sm text-muted">该功能需要登录后使用。</p>'
            . '<a href="/login" class="inline-block min-h-11 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-on-primary">去登录</a>'
            . '</div>';
    }
    if ($user['role'] !== ROLE_ADMIN) {
        return '<p class="rounded-xl border border-dashed border-line bg-surface p-12 text-center text-sm text-muted">仅管理员可访问该页面。</p>';
    }
    return null;
}

/**
 * 读取「题目 + 个人进度」的合并结果。
 *
 * 对应前端 hooks/useQuestions.ts：先取题目再取进度，合并出
 * status / wrongCount 供列表与统计使用。游客没有进度，全部按默认值。
 *
 * @param array|null $user
 * @return array
 */
function load_questions_with_progress($user)
{
    $rows = query(
        'SELECT id, original_sentence, blanks_json, source, schema_version, created_at
           FROM questions
          ORDER BY created_at DESC, id'
    );

    $progress = [];
    if ($user !== null) {
        foreach (query('SELECT question_id, wrong_count, status FROM user_progress WHERE user_id = ?', [(int) $user['id']]) as $row) {
            $progress[$row['question_id']] = $row;
        }
    }

    $questions = [];
    foreach ($rows as $row) {
        $blanks = json_decode((string) $row['blanks_json'], true);
        $item = $progress[$row['id']] ?? null;
        $questions[] = [
            'id' => (string) $row['id'],
            'originalSentence' => (string) $row['original_sentence'],
            'blanks' => is_array($blanks) ? $blanks : [],
            'source' => (string) $row['source'],
            'schemaVersion' => (int) $row['schema_version'],
            'status' => $item !== null ? (string) $item['status'] : 'unmastered',
            'wrongCount' => $item !== null ? (int) $item['wrong_count'] : 0,
            'createdAt' => to_iso($row['created_at']),
        ];
    }
    return $questions;
}

/** 读取标签字典 */
function load_tag_dictionary()
{
    $rows = query('SELECT id, name, parent_id, color, is_active FROM tags ORDER BY id');
    $tags = [];
    foreach ($rows as $row) {
        $tags[] = [
            'id' => (string) $row['id'],
            'name' => (string) $row['name'],
            'parentId' => $row['parent_id'] !== null ? (string) $row['parent_id'] : null,
            'color' => (string) $row['color'],
            'isActive' => (int) $row['is_active'] === 1,
        ];
    }
    return ['schemaVersion' => 1, 'tags' => $tags];
}

/**
 * 把数据以 JSON 形式嵌入页面，供页面脚本使用。
 * 用 <script type="application/json"> 而不是直接内联到 JS 里，
 * 避免内容里的字符破坏脚本。
 */
function embed_json($id, $data)
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
    return '<script type="application/json" id="' . e($id) . '">' . ($json === false ? 'null' : $json) . '</script>';
}
