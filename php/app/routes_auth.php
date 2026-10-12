<?php
/**
 * /api/auth/* —— 注册、登录、登出、登录态、改密。
 *
 * 同样的校验规则、同样的文案、
 * 同样的状态码（201 注册成功 / 401 用户名或密码错误 / 403 账号被禁用 /
 * 409 用户名已被占用 / 400 原密码不正确）。
 *
 * 密码哈希用 PHP 内置 password_hash(PASSWORD_BCRYPT, cost 10)，
 * 与 bcryptjs 同为标准 bcrypt：
 * - 库里已有的 $2a$ 哈希（Node 写入的）能被 password_verify 正常校验
 * - PHP 新写入的是 $2y$，Node 的 bcryptjs 同样认
 * 因此切换实现后所有已存在的账号密码不变，无需重置。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';

/** 用户名规则：4-20 位字母数字下划线 */
define('USERNAME_RE', '/^[a-zA-Z0-9_]{4,20}$/');
/** 密码最短长度 */
define('MIN_PASSWORD_LENGTH', 6);

/** 统一的用户信息输出结构（id/username/role/displayName） */
function auth_user_payload(array $row)
{
    return [
        'id' => (int) $row['id'],
        'username' => (string) $row['username'],
        'role' => (string) $row['role'],
        'displayName' => $row['display_name'] !== null ? (string) $row['display_name'] : null,
    ];
}

/** POST /api/auth/register —— 注册，只能创建普通用户（防越权提权） */
function route_auth_register()
{
    $username = trim((string) body_param('username', ''));
    $password = (string) body_param('password', '');

    if (preg_match(USERNAME_RE, $username) !== 1) {
        throw http_error(400, '用户名需为 4-20 位字母、数字或下划线');
    }
    if (strlen($password) < MIN_PASSWORD_LENGTH) {
        throw http_error(400, '密码至少 ' . MIN_PASSWORD_LENGTH . ' 位');
    }

    $exists = query('SELECT id FROM users WHERE username = ?', [$username]);
    if (count($exists) > 0) {
        throw http_error(409, '用户名已被占用');
    }

    $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
    // 忽略客户端传入的 role，强制为 user
    execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [
        $username,
        $hash,
        ROLE_USER,
    ]);

    json_response(['ok' => true, 'message' => '注册成功'], 201);
}

/** POST /api/auth/login —— 登录，失败次数过多会被限速 */
function route_auth_login()
{
    $username = trim((string) body_param('username', ''));
    $password = (string) body_param('password', '');

    // 与 Node 版一致：限速挂在登录处理之前，锁定中直接 429
    login_throttle($username);

    $rows = query(
        'SELECT id, username, password_hash, role, display_name, status FROM users WHERE username = ?',
        [$username]
    );
    $user = $rows[0] ?? null;

    // 用户不存在与密码错误返回同一提示，避免暴露用户名是否存在
    if ($user === null || !password_verify($password, (string) $user['password_hash'])) {
        record_login_failure($username);
        throw http_error(401, '用户名或密码错误');
    }
    if ((int) $user['status'] !== 1) {
        record_login_failure($username);
        throw http_error(403, '账号已被禁用，请联系管理员');
    }

    $token = create_session((int) $user['id']);
    // 同时写入 Cookie：页面导航（浏览器请求）拿不到 Authorization 头，
    // PHP 服务端渲染要靠它识别登录态
    set_auth_cookie($token);
    clear_login_failures($username);
    purge_expired_sessions((int) $user['id']);

    json_response([
        'token' => $token,
        'user' => auth_user_payload($user),
    ]);
}

/** POST /api/auth/logout */
function route_auth_logout()
{
    require_auth();
    destroy_session(current_token());
    clear_auth_cookie();
    json_response(['ok' => true]);
}

/** GET /api/auth/me —— 前端启动时调用，恢复登录态 */
function route_auth_me()
{
    $user = require_auth();

    // 兼容路径：老用户升级时 token 只在 localStorage、Cookie 还没有。
    // 页面加载时 JS 会调一次 me，这里顺手把 Cookie 补上，
    // 否则之后每次页面导航都会显示成未登录。
    $cookie = auth_cookie_name();
    if (!isset($_COOKIE[$cookie]) || $_COOKIE[$cookie] !== current_token()) {
        set_auth_cookie(current_token());
    }

    json_response(['user' => auth_user_payload($user)]);
}

/** POST /api/auth/change-password —— 改密后踢掉其它会话，仅保留当前设备 */
function route_auth_change_password()
{
    $user = require_auth();
    $oldPassword = (string) body_param('oldPassword', '');
    $newPassword = (string) body_param('newPassword', '');

    if (strlen($newPassword) < MIN_PASSWORD_LENGTH) {
        throw http_error(400, '新密码至少 ' . MIN_PASSWORD_LENGTH . ' 位');
    }

    $rows = query('SELECT password_hash FROM users WHERE id = ?', [(int) $user['id']]);
    $row = $rows[0] ?? null;
    if ($row === null || !password_verify($oldPassword, (string) $row['password_hash'])) {
        throw http_error(400, '原密码不正确');
    }

    $hash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => 10]);
    execute('UPDATE users SET password_hash = ? WHERE id = ?', [$hash, (int) $user['id']]);

    destroy_user_sessions((int) $user['id'], current_token());

    json_response(['ok' => true, 'message' => '密码已修改']);
}
