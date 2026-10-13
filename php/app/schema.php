<?php
/**
 * 建表与种子数据导入。
 *
 * 初始化时做两件事：
 *   ensure_schema()：执行 php/sql/schema.sql
 *   seed_if_needed()：首次且库为空时导入 php/seed/*.json，只导一次
 *
 * 关键点：PHP 读的是**同一份** schema.sql 与**同一份**种子 JSON，
 * 不存在两套定义，也不会出现两边表结构漂移。
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

/**
 * 首次运行时自动建表。
 *
 * 去掉注释行后按分号切分，逐条执行。
 * CREATE TABLE IF NOT EXISTS 与 INSERT OR IGNORE 都可重复执行，
 * 因此已有库不会受影响，初始管理员也不会被覆盖。
 */
function ensure_schema()
{
    $sqlFile = dirname(__DIR__) . '/sql/schema.sql';
    if (!is_file($sqlFile)) {
        throw http_error(500, '缺少建表脚本 php/sql/schema.sql');
    }

    $sql = file_get_contents($sqlFile);
    if ($sql === false) {
        throw http_error(500, '建表脚本读取失败');
    }

    // 去掉整行注释
    $lines = array_filter(explode("\n", $sql), function ($line) {
        return strpos(trim($line), '--') !== 0;
    });
    $statements = explode(';', implode("\n", $lines));

    db()->exec('PRAGMA foreign_keys = ON');
    foreach ($statements as $statement) {
        $trimmed = trim($statement);
        if ($trimmed === '') {
            continue;
        }
        db()->exec($trimmed);
    }
}

/** app_config 里的种子标记键（换种子数据时改版本号即可重导） */
define('SEED_FLAG', 'seed_v1_done');

/**
 * 按顺序尝试的候选种子目录，取第一个同时含两个文件的。
 *
 * @return string|null
 */
function resolve_seed_dir()
{
    $candidates = [];
    $configured = env_value('SEED_DIR', '');
    if ($configured !== '') {
        $candidates[] = $configured;
    }
    
    // 种子数据源（questions.json 与 tags.json），随代码一起发布
    $candidates[] = PHP_DIR . '/seed';

    foreach ($candidates as $dir) {
        if (is_file($dir . '/tags.json') && is_file($dir . '/questions.json')) {
            return $dir;
        }
    }
    return null;
}

/** 读 JSON，失败返回 null */
function read_seed_json($file)
{
    $raw = @file_get_contents($file);
    if ($raw === false) {
        return null;
    }
    $parsed = json_decode($raw, true);
    return is_array($parsed) ? $parsed : null;
}

/** 库里是否已有内容（题目或标签） */
function seed_has_existing_data()
{
    return scalar_int('SELECT COUNT(*) FROM questions') > 0
        || scalar_int('SELECT COUNT(*) FROM tags') > 0;
}

/** 写入「已导入」标记（UPSERT，重复调用安全） */
function seed_mark_done()
{
    execute(
        "INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, '1', datetime('now'))
         ON CONFLICT(config_key)
         DO UPDATE SET config_value = '1', updated_at = datetime('now')",
        [SEED_FLAG]
    );
}

/**
 * 需要时导入种子数据。
 *
 * @return array{seeded:bool,reason?:string,questions?:int,tags?:int}
 */
function seed_if_needed()
{
    if (env_value('SEED_ON_EMPTY', '1') === '0') {
        return ['seeded' => false, 'reason' => '已通过 SEED_ON_EMPTY=0 关闭'];
    }

    try {
        // 已导过一次就不再动
        if (query_one('SELECT config_value FROM app_config WHERE config_key = ?', [SEED_FLAG]) !== null) {
            return ['seeded' => false, 'reason' => '此前已导入过'];
        }

        // 库里已有内容：这是已经在用的部署，绝不注入示例数据，只补标记
        if (seed_has_existing_data()) {
            seed_mark_done();
            return ['seeded' => false, 'reason' => '库中已有数据，跳过'];
        }

        $dir = resolve_seed_dir();
        if ($dir === null) {
            error_log('未找到种子数据（php/seed/tags.json 与 questions.json），本次不导入');
            return ['seeded' => false, 'reason' => '找不到种子数据文件'];
        }

        $tagsFile = read_seed_json($dir . '/tags.json');
        $questionsFile = read_seed_json($dir . '/questions.json');
        $tags = isset($tagsFile['tags']) && is_array($tagsFile['tags']) ? $tagsFile['tags'] : [];
        $questions = is_array($questionsFile) ? $questionsFile : [];

        if (count($tags) === 0 && count($questions) === 0) {
            return ['seeded' => false, 'reason' => '种子数据为空'];
        }

        // 一个事务里写完，避免只导入一半
        db_transaction(function () use ($tags, $questions) {
            foreach ($tags as $tag) {
                if (!is_array($tag) || empty($tag['id']) || empty($tag['name'])) {
                    continue;
                }
                execute('INSERT INTO tags (id, name, parent_id, color, is_active) VALUES (?, ?, ?, ?, ?)', [
                    $tag['id'],
                    $tag['name'],
                    isset($tag['parentId']) ? $tag['parentId'] : null,
                    !empty($tag['color']) ? $tag['color'] : '#64748B',
                    (isset($tag['isActive']) && $tag['isActive'] === false) ? 0 : 1,
                ]);
            }
            foreach ($questions as $question) {
                if (!is_array($question) || empty($question['id'])) {
                    continue;
                }
                execute(
                    'INSERT INTO questions
                       (id, original_sentence, blanks_json, source, schema_version, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        $question['id'],
                        isset($question['originalSentence']) ? $question['originalSentence'] : '',
                        json_encode(isset($question['blanks']) ? $question['blanks'] : [], JSON_UNESCAPED_UNICODE),
                        !empty($question['source']) ? $question['source'] : '内置示例',
                        isset($question['schemaVersion']) ? $question['schemaVersion'] : 1,
                        to_sql_date(isset($question['createdAt']) ? $question['createdAt'] : null),
                    ]
                );
            }
            seed_mark_done();
        });

        return ['seeded' => true, 'questions' => count($questions), 'tags' => count($tags)];
    } catch (Throwable $e) {
        // 种子导入失败绝不能让服务起不来
        error_log('种子数据导入失败（不影响启动）：' . $e->getMessage());
        return ['seeded' => false, 'reason' => $e->getMessage()];
    }
}
