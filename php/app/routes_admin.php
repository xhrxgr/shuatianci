<?php
/**
 * /api/admin/* —— 用户管理。
 *
 * 接口契约与历史版本完全一致：
 * - 该组接口整体要求 user:read 权限
 * - 写操作额外要求 user:write
 * - 三条自我保护规则：不能改自己的管理员角色、不能禁用自己、不能删自己
 * - 改密 / 改角色 / 禁用 / 删除都会让该用户的会话失效
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/errors.php';

/** 用户管理组统一的前置权限（对应 adminRouter.use(requirePermission('user:read'))） */
function require_user_read()
{
    return require_permission('user:read');
}

/** GET /api/admin/users —— 用户列表（含做题统计） */
function route_admin_users()
{
    require_user_read();

    $rows = query(
        'SELECT u.id, u.username, u.display_name, u.role, u.status,
                u.created_at,
                COUNT(r.id) AS record_count,
                COALESCE(SUM(CASE WHEN r.is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong_count
           FROM users u
           LEFT JOIN practice_records r ON r.user_id = u.id
          GROUP BY u.id
          ORDER BY u.created_at DESC'
    );

    json_response([
        'users' => array_map(function ($row) {
            return [
                'id' => (int) $row['id'],
                'username' => (string) $row['username'],
                'displayName' => $row['display_name'] !== null ? (string) $row['display_name'] : null,
                'role' => (string) $row['role'],
                'status' => (int) $row['status'],
                'createdAt' => to_iso($row['created_at']),
                'recordCount' => (int) $row['record_count'],
                'wrongCount' => (int) $row['wrong_count'],
            ];
        }, $rows),
    ]);
}

/** GET /api/admin/roles —— 可选角色清单 */
function route_admin_roles()
{
    require_user_read();
    json_response(['roles' => list_roles()]);
}

/** POST /api/admin/users —— 新建用户，管理员可指定角色 */
function route_admin_users_create()
{
    require_user_read();
    require_permission('user:write');

    $username = trim((string) body_param('username', ''));
    $password = (string) body_param('password', '');
    $role = (string) (body_param('role') ?: ROLE_USER);

    if (preg_match('/^[a-zA-Z0-9_]{4,20}$/', $username) !== 1) {
        throw http_error(400, '用户名须为 4-20 位字母、数字或下划线');
    }
    if (strlen($password) < 6) {
        throw http_error(400, '密码至少 ' . MIN_PASSWORD_LENGTH . ' 位');
    }
    if (!is_valid_role($role)) {
        throw http_error(400, '角色无效');
    }

    $exists = query('SELECT id FROM users WHERE username = ?', [$username]);
    if (count($exists) > 0) {
        throw http_error(409, '用户名已被占用');
    }

    $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
    $result = execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [
        $username,
        $hash,
        $role,
    ]);

    json_response(['ok' => true, 'id' => $result['insertId']], 201);
}

/** POST /api/admin/users/{id}/reset-password */
function route_admin_reset_password($id)
{
    require_user_read();
    require_permission('user:write');

    $id = (int) $id;
    $password = (string) body_param('password', '');

    if (strlen($password) < 6) {
        throw http_error(400, '密码至少 ' . MIN_PASSWORD_LENGTH . ' 位');
    }

    $rows = query('SELECT id FROM users WHERE id = ?', [$id]);
    if (count($rows) === 0) {
        throw http_error(404, '账号不存在');
    }

    $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
    execute('UPDATE users SET password_hash = ? WHERE id = ?', [$hash, $id]);
    destroy_user_sessions($id);

    json_response(['ok' => true, 'message' => '密码已重置，该用户需重新登录']);
}

/** POST /api/admin/users/{id}/role */
function route_admin_change_role($id)
{
    require_user_read();
    require_permission('user:write');

    $id = (int) $id;
    $role = (string) body_param('role', '');
    $self = require_auth();

    if (!is_valid_role($role)) {
        throw http_error(400, '角色无效');
    }
    // 不允许把自己降级，避免把系统锁死到无人可管理
    if ($id === (int) $self['id'] && $role !== ROLE_ADMIN) {
        throw http_error(400, '不能修改自己的管理员角色');
    }

    $rows = query('SELECT id FROM users WHERE id = ?', [$id]);
    if (count($rows) === 0) {
        throw http_error(404, '账号不存在');
    }

    execute('UPDATE users SET role = ? WHERE id = ?', [$role, $id]);
    // 角色变了权限就变了，强制重新登录以刷新身份
    if ($role !== ROLE_ADMIN) {
        destroy_user_sessions($id);
    }

    json_response(['ok' => true]);
}

/** POST /api/admin/users/{id}/status */
function route_admin_change_status($id)
{
    require_user_read();
    require_permission('user:write');

    $id = (int) $id;
    $status = (int) body_param('status', -1);
    $self = require_auth();

    if ($status !== 0 && $status !== 1) {
        throw http_error(400, '状态值无效');
    }
    if ($id === (int) $self['id']) {
        throw http_error(400, '不能禁用自己的账号');
    }

    execute('UPDATE users SET status = ? WHERE id = ?', [$status, $id]);
    if ($status === 0) {
        destroy_user_sessions($id);
    }

    json_response(['ok' => true]);
}

/** GET /api/admin/users/{id}/records —— 某用户的做题明细 */
function route_admin_user_records($id)
{
    require_user_read();

    $rows = query(
        'SELECT id, question_id, is_correct, wrong_count, answers_json, created_at
           FROM practice_records
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 200',
        [(int) $id]
    );

    json_response([
        'records' => array_map(function ($row) {
            return [
                'id' => (int) $row['id'],
                'questionId' => (string) $row['question_id'],
                'isCorrect' => (int) $row['is_correct'] === 1,
                'wrongCount' => (int) $row['wrong_count'],
                // 原样返回库里的 answers_json 文本
                'answers' => $row['answers_json'],
                'createdAt' => to_iso($row['created_at']),
            ];
        }, $rows),
    ]);
}

/** DELETE /api/admin/users/{id} —— 级联删除其记录与会话 */
function route_admin_user_delete($id)
{
    require_user_read();
    require_permission('user:write');

    $id = (int) $id;
    $self = require_auth();
    if ($id === (int) $self['id']) {
        throw http_error(400, '不能删除自己的账号');
    }

    destroy_user_sessions($id);
    execute('DELETE FROM users WHERE id = ?', [$id]);
    json_response(['ok' => true]);
}
