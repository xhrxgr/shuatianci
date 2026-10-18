<?php
/**
 * 通用工具：JSON 响应、时间格式转换、请求体解析。
 *
 * 时间口径（全站统一）：
 * 库里是 SQLite 的 datetime('now')（UTC，'Y-m-d H:i:s'），
 * 对外统一转成 ISO 字符串，避免前端拿到两种格式。
 */

/**
 * 把数组编码成 JSON 存库；编码失败直接拒绝入库。
 *
 * 为什么不能直接用 json_encode：它在遇到 INF / NAN、非法 UTF-8、递归引用时
 * 返回 **false**，而 db_params 会把 false 静默转成整数 0（is_bool 分支）。
 * 于是 blanks_json 变成字符串 "0"，题被当成「0 个空」——
 * map_question 还原成空数组返回给学生，全程不报任何错。
 *
 * 这类输入能从 JSON 接口进来（如 answer 里写 1e999 被解析成 INF），
 * 所以必须在入库前拦住。
 *
 * @param mixed $value
 * @param string $label 报错时告诉用户是哪部分内容
 * @return string
 */
function encode_json_for_db($value, $label = '内容')
{
    $json = json_encode($value, JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        throw http_error(400, $label . '无法序列化（可能含非法数值如 Infinity/NaN，或非法字符编码）');
    }
    return $json;
}

/**
 * 输出 JSON 并结束请求。
 *
 * @param mixed $data
 * @param int $status
 */
function json_response($data, $status = 200)
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    // json_encode 失败（非法的 UTF-8、递归引用、INF/NAN）会返回 false，
    // 直接 echo 会输出**空响应体**：状态码已经是 200，前端 JSON.parse 报
    // 的是一个和真实原因完全无关的语法错误，排查起来极其困难。
    // 这里兜底成一段可读的 JSON，并把真实原因写进服务端日志。
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        error_log('[json_response] 编码失败：' . json_last_error_msg());
        if (!headers_sent()) {
            http_response_code(500);
        }
        echo json_encode(
            ['error' => '返回数据包含无法编码的内容（如非法字符编码），详情见服务器日志'],
            JSON_UNESCAPED_UNICODE
        );
        exit;
    }
    echo $json;
    exit;
}

/**
 * 数据库时间 -> ISO 字符串。
 *
 * 做法：把 '2026-10-12 08:00:00' 替换成 '2026-10-12T08:00:00Z' 再解析，
 * 即库里的裸字符串一律按 UTC 处理。这里保持同样口径。
 *
 * @param mixed $value
 * @return string|null
 */
function to_iso($value)
{
    if ($value === null || $value === '') {
        return null;
    }
    $raw = (string) $value;
    // 已经是 ISO（带 T）就按 ISO 解析，否则补 T 并按 UTC 处理
    $normalized = (strpos($raw, 'T') === false)
        ? str_replace(' ', 'T', $raw) . 'Z'
        : $raw;

    try {
        $dt = new DateTime($normalized, new DateTimeZone('UTC'));
    } catch (Exception $e) {
        return null;
    }
    // 与 Date.prototype.toISOString() 同格式：毫秒三位 + Z
    return $dt->format('Y-m-d\TH:i:s') . '.' . substr($dt->format('u'), 0, 3) . 'Z';
}

/**
 * ISO / 任意时间字符串 -> SQLite datetime 格式（UTC，与 datetime('now') 一致）。
 *
 * @param mixed $iso
 * @return string
 */
function to_sql_date($iso)
{
    try {
        $dt = new DateTime((string) $iso ?: 'now', new DateTimeZone('UTC'));
    } catch (Exception $e) {
        $dt = new DateTime('now', new DateTimeZone('UTC'));
    }
    return $dt->format('Y-m-d H:i:s');
}

/** 当前 UTC 时间的 SQLite 格式 */
function now_sql()
{
    return (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
}

/** 当前时间的 ISO 字符串 */
function now_iso()
{
    return to_iso(now_sql());
}

/**
 * 解析请求体 JSON。
 *
 * Express 的 express.json() 在请求体为空或非法时给出 {}，
 * 这里同样返回空数组，调用方用 ?? 取值即可。
 *
 * @return array
 */
function request_body()
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        $cache = [];
        return $cache;
    }
    $parsed = json_decode($raw, true);
    $cache = is_array($parsed) ? $parsed : [];
    return $cache;
}

/**
 * 取请求体字段。
 *
 * @param string $key
 * @param mixed $default
 * @return mixed
 */
function body_param($key, $default = null)
{
    $body = request_body();
    return array_key_exists($key, $body) ? $body[$key] : $default;
}

/**
 * 去掉查询串与 /api 前缀后的路径，如 "/questions/q_0001"。
 *
 * @param string $requestUri
 * @return string
 */
function request_path($requestUri)
{
    $path = parse_url((string) $requestUri, PHP_URL_PATH);
    if ($path === null || $path === false) {
        $path = '/';
    }
    // 只在「脚本路径真的出现在 URI 开头」时才剥离（/php/index.php/api/x 这类部署）。
    // 必须限定以 .php 结尾：php -S 的 router 模式下 SCRIPT_NAME 就是请求路径本身，
    // 不做这个判断会把整个 URI 吃掉，所有路由都匹配不上。
    $scriptName = isset($_SERVER['SCRIPT_NAME']) ? (string) $_SERVER['SCRIPT_NAME'] : '';
    if ($scriptName !== '' && substr($scriptName, -4) === '.php' && strpos($path, $scriptName) === 0) {
        $path = substr($path, strlen($scriptName));
    }
    if (strpos($path, '/api') === 0) {
        // '/api' 是 4 个字符
        $path = substr($path, 4);
        // '/api' 后面可能直接结束，也可能带 '/'，都要能落到 '/'
        if ($path !== '' && $path[0] !== '/') {
            $path = '/' . $path;
        }
    }
    if ($path === '' || $path === false) {
        $path = '/';
    }
    return rtrim($path, '/') === '' ? '/' : rtrim($path, '/');
}

/**
 * 查题的公共列清单与 FROM 子句。
 *
 * 必须 LEFT JOIN passages：完整原文现在挂在篇章上（10 道小题共享一篇），
 * 不 JOIN 的话 map_question 里那两列永远取不到。
 * 用 LEFT 而不是 INNER：老题与单句题没有篇章，也得能查出来。
 */
function questions_select_columns()
{
    return 'q.id, q.original_sentence, q.passage_id, q.passage_text,
            p.title AS passage_title, p.text AS passage_text_now,
            q.blanks_json, q.source, q.paper_id, q.schema_version,
            q.fingerprint, q.publish_status, q.owner_id, q.created_at, q.updated_at';
}

function questions_from_clause()
{
    return ' FROM questions q LEFT JOIN passages p ON p.id = q.passage_id';
}

/**
 * 从一行题目数据里取「完整原文」——**只认 passages 表**。
 *
 * v3.9.0 起彻底单一权威：
 * 一道大题（一篇阅读挖多个空）= 一篇原文 + N 道最小填空题，
 * 原文只存一份在 passages，多道题通过 passage_id 共享它，
 * 改一处全篇立即生效。
 *
 * ⚠️ 不要再回退到 questions.passage_text（v3.6.13 的旧形态，一题一份）。
 * 两套并存会出两类难查的问题：
 *   ① 读的时候优先 passages、存的时候写 passage_text —— 「改了看不到变化」，
 *      同时在 passage_text 里留下一份永远不显示的脏数据
 *   ② 同一篇的两道题能看到不同的原文
 * 数据库里那一列保留着（不做 DROP COLUMN，零迁移风险），
 * 但读写都不再经过它。历史数据由用户重录。
 *
 * @param array $row 已按 questions_select_columns() 选出的行
 * @return string|null 没有原文返回 null（不是空串，前端据此区分）
 */
function questions_passage_text(array $row)
{
    if (isset($row['passage_text_now']) && trim((string) $row['passage_text_now']) !== '') {
        return (string) $row['passage_text_now'];
    }
    return null;
}
