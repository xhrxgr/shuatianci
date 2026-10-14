<?php
/**
 * 统一错误出口。
 *
 * 错误码与提示文案的统一出口：
 * - 业务错误抛 HttpError(状态码, 可安全展示的中文文案)
 * - SQLite 约束冲突映射成对应的状态码与文案（用户名重复 -> 409 等）
 * - 绝不把 SQL、堆栈、路径泄漏给前端，详情只写服务端日志
 */

/** 带状态码与安全文案的业务异常 */
class HttpError extends Exception
{
    /** @var int */
    public $status;
    /** @var string */
    public $safeMessage;

    public function __construct($status, $safeMessage)
    {
        parent::__construct($safeMessage);
        $this->status = (int) $status;
        $this->safeMessage = (string) $safeMessage;
    }
}

/**
 * 构造业务错误。
 *
 * @param int $status
 * @param string $safeMessage
 * @return HttpError
 */
function http_error($status, $safeMessage)
{
    return new HttpError($status, $safeMessage);
}

/**
 * SQLite 扩展错误码 -> [状态码, 文案]。
 *
 * SQLite 的扩展码是「主码 | (子码 << 8)」，19 = 约束冲突：
 *   UNIQUE=2067、PRIMARYKEY=1555、FOREIGNKEY=787、NOTNULL=1299、CHECK=275。
 *
 * ⚠️ 实测（PHP 8.3 + pdo_sqlite）：**PHP 的 PDO 驱动只填主码 19，
 * 扩展码这一位始终是 0**，所以下面的 switch 在本项目里基本不会命中。
 * 这不是 bug，是驱动限制——因此 error_to_response() 必须以**消息文本**
 * 为主要判据，这个表只作为扩展码确实可用时的补充。
 * （早先这里写的是 531/787/1043/1555 这组数，与 SQLite 的定义不符，
 *   且会与真实值错位命中，比如 FOREIGNKEY 的 787 被当成 PRIMARYKEY。）
 */
function sqlite_constraint_message($extendedCode)
{
    switch ($extendedCode) {
        case 2067: // SQLITE_CONSTRAINT_UNIQUE
        case 1555: // SQLITE_CONSTRAINT_PRIMARYKEY
            return [409, '数据已存在'];
        case 787:  // SQLITE_CONSTRAINT_FOREIGNKEY
            return [400, '关联的数据不存在'];
        case 1299: // SQLITE_CONSTRAINT_NOTNULL
            return [400, '缺少必填字段'];
        case 275:  // SQLITE_CONSTRAINT_CHECK
            return [400, '数据不符合要求'];
        default:
            return null;
    }
}

/** 数据库不可用类主码（磁盘、权限、并发锁、损坏） */
function sqlite_is_unavailable($primaryCode)
{
    return in_array($primaryCode, [5, 6, 8, 10, 11, 13, 14], true);
}

/**
 * 把异常翻译成响应。
 *
 * @param Throwable $e
 * @return array{status:int,body:array}
 */
function error_to_response($e)
{
    // 详情只进服务端日志
    error_log('[error] ' . $e->getMessage());

    if ($e instanceof HttpError) {
        return ['status' => $e->status, 'body' => ['error' => $e->safeMessage]];
    }

    if ($e instanceof PDOException) {
        $info = $e->errorInfo;
        $extended = isset($info[1]) ? (int) $info[1] : 0;
        $primary = $extended & 0xFF;

        // 先按扩展码判（信息更精确），但不命中就继续往下走——
        // 原来这里对主码 19 直接 return 400，导致下面的消息文本兜底
        // 在「扩展码只填主码」的驱动（PHP 的 pdo_sqlite 就是）下**永远不可达**，
        // 于是 UNIQUE 冲突被误报成「数据不符合约束」而不是「数据已存在」。
        $mapped = $extended > 0 ? sqlite_constraint_message($extended) : null;
        if ($mapped !== null) {
            return ['status' => $mapped[0], 'body' => ['error' => $mapped[1]]];
        }

        if (sqlite_is_unavailable($primary)) {
            return ['status' => 503, 'body' => ['error' => '数据库暂时不可用，请稍后重试']];
        }

        // 主要判据：消息文本。PHP 的 PDO SQLite 不填扩展码，只能靠它区分约束类型。
        $message = isset($info[2]) ? (string) $info[2] : $e->getMessage();
        if (stripos($message, 'UNIQUE constraint failed') !== false) {
            return ['status' => 409, 'body' => ['error' => '数据已存在']];
        }
        if (stripos($message, 'FOREIGN KEY constraint failed') !== false) {
            return ['status' => 400, 'body' => ['error' => '关联的数据不存在']];
        }
        if (stripos($message, 'NOT NULL constraint failed') !== false) {
            return ['status' => 400, 'body' => ['error' => '缺少必填字段']];
        }
        if (stripos($message, 'CHECK constraint failed') !== false) {
            return ['status' => 400, 'body' => ['error' => '数据不符合要求']];
        }
        if (stripos($message, 'database is locked') !== false
            || stripos($message, 'database or disk is full') !== false
            || stripos($message, 'disk I/O error') !== false) {
            return ['status' => 503, 'body' => ['error' => '数据库暂时不可用，请稍后重试']];
        }

        // 其余约束（如 SQLITE_CONSTRAINT_TRIGGER）统一按 400 处理。
        // 放在文本兜底之后：只有确认不是上面任何一种已知类型，才归到这个笼统文案。
        if ($primary === 19) {
            return ['status' => 400, 'body' => ['error' => '数据不符合约束']];
        }
    }

    $status = ($e instanceof Exception && method_exists($e, 'getCode'))
        ? (int) $e->getCode()
        : 0;
    if ($status < 400 || $status > 599) {
        $status = 500;
    }
    return ['status' => $status, 'body' => ['error' => '服务器内部错误']];
}
