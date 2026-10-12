<?php
/**
 * 数据访问层。
 *
 * 同一个 SQLite 文件、同一套
 * query / queryOne / execute / scalar / transaction 接口，
 * 因此路由层的写法可以逐条对照迁移。
 *
 * 两点 PHP 特有的处理：
 * 1. PDO 在低版本会把整数读成字符串，这里统一由调用方按需 (int) 转换，
 *    保证 JSON 里的数字仍是数字（前端有 === 1 这类强比较）。
 * 2. SQLite 只能绑定标量，数组/对象在绑定前统一 JSON 序列化，
 *    与 Node 版 normalize() 的行为一致。
 */

require_once __DIR__ . '/config.php';

/** @var PDO|null */
$GLOBALS['__pdo'] = null;

/**
 * 获取数据库连接（单例）。首次调用时建库目录、设置 PRAGMA。
 *
 * @return PDO
 */
function db()
{
    if ($GLOBALS['__pdo'] instanceof PDO) {
        return $GLOBALS['__pdo'];
    }

    $file = database_file();
    $dir = dirname($file);
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }

    $pdo = new PDO('sqlite:' . $file, null, null, [
        // 出错抛异常，交给统一错误出口处理
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        // 等锁释放而不是立刻报 SQLITE_BUSY（单位：秒）
        PDO::ATTR_TIMEOUT => 5,
    ]);

    // 与 Node 版连接层完全相同的三条 PRAGMA
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA foreign_keys = ON');

    $GLOBALS['__pdo'] = $pdo;
    return $pdo;
}

/**
 * 参数归一化：把 PHP 侧的布尔、数组、对象、null 转成 SQLite 能绑定的标量。
 *
 * @param array $params
 * @return array
 */
function db_params(array $params)
{
    $out = [];
    foreach ($params as $value) {
        if ($value === null) {
            $out[] = null;
        } elseif (is_bool($value)) {
            $out[] = $value ? 1 : 0;
        } elseif (is_array($value) || is_object($value)) {
            $out[] = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        } else {
            $out[] = $value;
        }
    }
    return $out;
}

/**
 * 查询，返回行数组。
 *
 * @param string $sql
 * @param array $params
 * @return array<int,array<string,mixed>>
 */
function query($sql, array $params = [])
{
    $stmt = db()->prepare($sql);
    $stmt->execute(db_params($params));
    $rows = $stmt->fetchAll();
    return $rows === false ? [] : $rows;
}

/**
 * 查询单行，无结果返回 null。
 *
 * @param string $sql
 * @param array $params
 * @return array<string,mixed>|null
 */
function query_one($sql, array $params = [])
{
    $stmt = db()->prepare($sql);
    $stmt->execute(db_params($params));
    $row = $stmt->fetch();
    return $row === false ? null : $row;
}

/**
 * 写入。返回与 Node 版一致的 { insertId, affectedRows, changes }。
 *
 * @param string $sql
 * @param array $params
 * @return array{insertId:int,affectedRows:int,changes:int}
 */
function execute($sql, array $params = [])
{
    $stmt = db()->prepare($sql);
    $stmt->execute(db_params($params));
    return [
        'insertId' => (int) db()->lastInsertId(),
        'affectedRows' => $stmt->rowCount(),
        'changes' => $stmt->rowCount(),
    ];
}

/**
 * 取单行第一个值，常用于 COUNT(*)；无结果返回 0。
 *
 * @param string $sql
 * @param array $params
 * @return int
 */
function scalar_int($sql, array $params = [])
{
    $row = query_one($sql, $params);
    if ($row === null) {
        return 0;
    }
    $values = array_values($row);
    return (int) ($values[0] ?? 0);
}

/**
 * 在一个事务里执行 $fn。抛错自动回滚。
 *
 * 与 Node 版用法一致：「先删后写」这类操作必须包进来，
 * 否则中途失败会留下删了一半的库。
 *
 * @param callable $fn
 * @return mixed
 */
function db_transaction(callable $fn)
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $result = $fn();
        $pdo->commit();
        return $result;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}
