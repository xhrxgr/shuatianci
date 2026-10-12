<?php
/**
 * 统一错误出口。
 *
 * 与 Node 版 middleware/error.js 等价：
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
 * SQLite 的扩展码是「主码 | (子码 << 8)」：
 *   19 主码为约束冲突，UNIQUE=531、PRIMARYKEY=787、FOREIGNKEY=1043、
 *   NOTNULL=1299、CHECK=1555 —— 与 Node 版判断的
 *   SQLITE_CONSTRAINT_UNIQUE 等字符串一一对应。
 */
function sqlite_constraint_message($extendedCode)
{
    switch ($extendedCode) {
        case 531:  // SQLITE_CONSTRAINT_UNIQUE
        case 787:  // SQLITE_CONSTRAINT_PRIMARYKEY
            return [409, '数据已存在'];
        case 1043: // SQLITE_CONSTRAINT_FOREIGNKEY
            return [400, '关联的数据不存在'];
        case 1299: // SQLITE_CONSTRAINT_NOTNULL
            return [400, '缺少必填字段'];
        case 1555: // SQLITE_CONSTRAINT_CHECK
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

        if ($extended > 0) {
            $mapped = sqlite_constraint_message($extended);
            if ($mapped !== null) {
                return ['status' => $mapped[0], 'body' => ['error' => $mapped[1]]];
            }
            // 其余约束（如 SQLITE_CONSTRAINT_TRIGGER）统一按 400 处理
            if ($primary === 19) {
                return ['status' => 400, 'body' => ['error' => '数据不符合约束']];
            }
            if (sqlite_is_unavailable($primary)) {
                return ['status' => 503, 'body' => ['error' => '数据库暂时不可用，请稍后重试']];
            }
        }

        // 部分环境拿不到扩展码，退而按消息文本判断
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
    }

    $status = ($e instanceof Exception && method_exists($e, 'getCode'))
        ? (int) $e->getCode()
        : 0;
    if ($status < 400 || $status > 599) {
        $status = 500;
    }
    return ['status' => $status, 'body' => ['error' => '服务器内部错误']];
}
