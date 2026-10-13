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
    db()->exec('PRAGMA foreign_keys = ON');
    ensure_tables();
    migrate_schema();
}

/**
 * 已有库的表结构变更。
 *
 * CREATE TABLE IF NOT EXISTS 只保证「表不存在才建」，
 * **不会给已存在的表补列**。所以新增字段必须在这里显式 ALTER，
 * 否则老部署升上来后 SELECT 就会因为缺列报错。
 *
 * 每条迁移都要幂等：先查列在不在，不在才加。
 */
function migrate_schema()
{
    // 建表脚本里全是 CREATE TABLE IF NOT EXISTS，重复执行安全。
    // 必须先跑一遍再改列：从 v3.0.x 升上来的老库没有 papers 表，
    // 直接 ALTER TABLE papers 会抛「no such table」，
    // 而这个函数在每个请求的 bootstrap 里都会跑——一抛错整站 500。
    ensure_tables();

    // questions.paper_id：题目归属的试卷
    $columns = table_columns('questions');
    if (!in_array('paper_id', $columns, true)) {
        db()->exec('ALTER TABLE questions ADD COLUMN paper_id TEXT');
        db()->exec('CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id)');
    }

    // papers.note：试卷备注（后续若再加列，按同样方式追加）
    $paperColumns = table_columns('papers');
    if (!in_array('note', $paperColumns, true)) {
        db()->exec("ALTER TABLE papers ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    }
}

/**
 * 只执行建表脚本，不做列迁移。
 *
 * 从 migrate_schema 里拆出来，供其先调用；全新安装走 ensure_schema()，
 * 老库升级走 migrate_schema() → ensure_tables()。
 */
function ensure_tables()
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

    foreach ($statements as $statement) {
        $trimmed = trim($statement);
        if ($trimmed === '') {
            continue;
        }
        try {
            db()->exec($trimmed);
        } catch (Throwable $e) {
            // 「对不存在的列建索引」这类语句在老库上必然失败（如 idx_questions_paper
            // 依赖 migrate_schema 刚加的 paper_id）。跳过即可：索引缺失只影响性能，
            // 而让异常冒出去会让每个请求都 500，整站不可用。
            // 建表失败必须继续抛，那是真的脚本缺失或语法错。
            if (is_index_statement($trimmed)) {
                continue;
            }
            throw $e;
        }
    }
}

/**
 * 是否是建索引语句。
 *
 * 只用于让 ensure_tables 跳过老库上注定失败的索引；不是索引的语句一律照抛。
 */
function is_index_statement($statement)
{
    return (bool) preg_match('/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i', $statement);
}

/**
 * 取表的列名数组。
 *
 * @param string $table
 * @return string[]
 */
function table_columns($table)
{
    // 表名来自代码内部，不接受外部输入；这里仍做白名单校验避免拼进 SQL
    $allowed = ['users', 'questions', 'tags', 'papers', 'user_progress',
        'practice_records', 'user_favorites', 'user_marks', 'sessions', 'app_config'];
    if (!in_array($table, $allowed, true)) {
        return [];
    }
    $rows = query('PRAGMA table_info(' . $table . ')');
    return array_map(function ($row) {
        return (string) $row['name'];
    }, $rows);
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
