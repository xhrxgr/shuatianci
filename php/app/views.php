<?php
/**
 * 页面渲染。
 *
 * 分工：
 *   布局与导航 -> views/layout.php
 *   各页面骨架 -> views/*.php
 *   页面内交互 -> assets/js/*.js（原生 JS，浏览器直接加载，不打包）
 *
 * 与「先下载 JS 再请求接口」的传统做法相比：
 * - 首屏由 PHP 直接从 SQLite 读数据渲染，页面更快，也不依赖 /api 才能出内容
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
 * 截断过长文本，用在 <option> 与窄容器里。
 *
 * 为什么需要：`<select>` 的宽度是**内容驱动**的 —— 它会撑到能放下最长那个
 * `<option>`，而 `<option>` 内部无法换行。卷名动辄三四十个汉字
 * （实测 180 字符时 select 宽 1564px，视口才 1280px），整页跟着横向滚，
 * 移动端横向滚动基本等于页面坏了。
 *
 * CSS 的 max-width:100% 在这里救不了：它参照的是父容器宽度，而 flex 父容器
 * 的宽度又是被这个 select 撑出来的 —— 循环依赖。只能从文本本身下手。
 *
 * 调用方负责配 title= 原值，让用户悬停/长按仍能看到全名。
 *
 * @param string $text
 * @param int $max 按字符计（中文按 1 计，与 mb_* 一致）
 */
function ellipsis($text, $max = 28)
{
    $text = (string) $text;
    if (mb_strlen($text) <= $max) {
        return $text;
    }
    return mb_substr($text, 0, $max) . '…';
}

/**
 * 静态资源 URL 加缓存戳（文件修改时间）。
 *
 * 代码更新后 URL 随之变化，浏览器会自动重新下载，无需手动 Ctrl+F5；
 * 未变化的文件版本号不变，继续走缓存。
 *
 * ⚠️ 这个戳只保护**入口**。页面里的 <script src="...?v=X"> 变了会重新下载，
 * 但模块内部的 `import "./admin-papers.js"` URL 是不带戳的静态字符串，
 * 浏览器照样会用缓存里的旧模块 —— 入口是新的、子模块是旧的，
 * 混起来就是一个「改了却没反应」的页面。
 *
 * 所以子模块统一由 import_map_json() 生成的 import map 接管，
 * 见那个函数的说明。
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
 * 生成 import map 的 JSON，给**所有** JS 模块带上缓存戳。
 *
 * 背景：项目用原生 ES module，模块之间靠 `import "./x.js"` 静态串联。
 * 那些相对路径是源码里的字面量，没法逐个加戳（无构建步骤，改了就得手工维护）。
 * import map 正好能在**运行时**把它们重定向到带戳的 URL：
 *
 *     import "./admin-papers.js"  →  /assets/js/admin-papers.js?v=1758...
 *
 * 少一个 import map 就会命中一个陈旧模块。实际踩过的坑：
 * v3.8.9 修好了「删除试卷弹窗三个按钮点不动」，服务器也更新了，
 * 用户刷新后依然点不动 —— 浏览器拿着缓存里的旧 admin-papers.js，
 * 那三个按钮在旧文件里根本没绑定。反复 Ctrl+F5 才生效。
 *
 * 版本戳用整个 assets/js 目录的**最新** mtime：任何一个模块改动，
 * 全部模块的 URL 都变。子模块数量少（几十个），一次多带几个参数没有代价；
 * 换来的是「只要 git pull 过就一定是最新的」，不需要推理哪个文件变了。
 *
 * 键必须是**绝对路径** "/assets/js/xxx.js"，不能用 "./xxx.js"。
 * import map 匹配时会把 key 相对于**文档 base** 解析再和 import 说明符的
 * 解析结果比较：文档在 /admin，"./x.js" 解析成 /x.js，
 * 而模块实际解析成 /assets/js/x.js —— 对不上，import map 会被静默忽略。
 * 带前导 / 的 key 则解析成绝对 URL，与模块的真实地址一致。
 *
 * @return string 可直接嵌入 <script type="importmap"> 的 JSON
 */
function import_map_json()
{
    $dir = PHP_DIR . '/assets/js';
    $mtime = 0;
    $map = [];

    foreach (glob($dir . '/*.js') ?: [] as $file) {
        $mtime = max($mtime, (int) filemtime($file));
        $url = '/assets/js/' . basename($file);
        // key 与 value 同一个绝对 URL —— 把 "./xxx.js" 重定向到带戳的同名文件
        $map[$url] = $url . '?v=' . $mtime;
    }

    if ($mtime === 0) {
        $mtime = time();
    }

    $json = json_encode(
        ['imports' => $map],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );

    return $json === false ? '{"imports":{}}' : $json;
}

/**
 * 渲染一个页面。
 *
 * @param string $view  views/ 下的模板名（不含扩展名）
 * @param array  $data  传给模板的变量
 * @param string $title 浏览器标签标题（英文；页面内容与导航仍是中文）
 */
function render_page($view, array $data = [], $title = 'English Cloze Question Bank')
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
 * 导航栏项目。
 *
 * @param array|null $user
 * @return array
 */
function nav_items($user)
{
    $items = [
        ['to' => '/', 'label' => '首页'],
        ['to' => '/practice', 'label' => '刷题'],
        // 试卷页是「做一套卷」这件事的唯一集中入口，之前只能从首页那个
        // 「全部试卷」链接摸过去，而题库为空时那个链接根本不渲染
        ['to' => '/papers', 'label' => '试卷'],
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
 * 只有 "/" 与 "/admin" 需要精确匹配，其余按前缀匹配
 * （/admin/users 会同时点亮 /admin）。
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
/**
 * 把个人进度合并进题目列表。
 *
 * 题目与进度分表存，渲染前必须合并——只查题目的话，
 * 已掌握 / 错题数对登录用户永远是 0。
 *
 * @param array $questions map_question() 的结果
 * @param array|null $user 游客传 null，此时全部为默认进度
 * @return array
 */
function merge_progress(array $questions, $user)
{
    if ($user === null || count($questions) === 0) {
        return $questions;
    }

    $progress = [];
    foreach (query('SELECT question_id, wrong_count, status FROM user_progress WHERE user_id = ?', [(int) $user['id']]) as $row) {
        $progress[$row['question_id']] = $row;
    }

    foreach ($questions as $index => $question) {
        $item = $progress[$question['id']] ?? null;
        if ($item === null) {
            continue;
        }
        $questions[$index]['status'] = (string) $item['status'];
        $questions[$index]['wrongCount'] = (int) $item['wrong_count'];
    }
    return $questions;
}

function load_questions_with_progress($user)
{
    // 必须 LEFT JOIN passages：完整原文挂在篇章上（一道大题 10 道小题共享一篇）。
    // 列清单走公共函数，避免以后加列时漏掉 JOIN —— 漏了 map/取原文就永远是 null
    $rows = query(
        'SELECT ' . questions_select_columns() . '
           FROM questions q
           LEFT JOIN passages p ON p.id = q.passage_id
          ORDER BY q.created_at DESC, q.id'
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
            'paperId' => $row['paper_id'] !== null ? (string) $row['paper_id'] : null,
            'passageId' => !empty($row['passage_id']) ? (string) $row['passage_id'] : null,
            'passageTitle' => isset($row['passage_title']) ? (string) $row['passage_title'] : '',
            'passageText' => questions_passage_text($row),
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
