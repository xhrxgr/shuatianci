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
// 回填与投影需要指纹 / 答案签名（normalize_sentence、answer_signature）
require_once __DIR__ . '/fingerprint.php';

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

    migrate_question_columns();
    migrate_backfill_projection();
}

/**
 * questions 的新增列（题库重构第 1 期）。
 *
 * 逐列判断后 ADD，可重复执行。注意两件事：
 *
 * 1. `ADD COLUMN` 带 NOT NULL 时**必须给静态默认值**，不能写
 *    `DEFAULT (datetime('now'))` —— SQLite 只允许常量默认值，写成函数会直接报错。
 * 2. status 的默认值刻意是 `published`：ALTER TABLE 会让**存量题目**也拿到这个值。
 *    这是决策 D2 —— 迁移后存量题全部可直接刷，否则上线后学生一道题都看不到。
 *    新录入题目进草稿是第 3 期（审核流）的事，那时再改写入侧。
 */
function migrate_question_columns()
{
    $columns = table_columns('questions');

    $additions = [
        // 原句归一化指纹：去重与查重的辅助索引（权威数据仍是 original_sentence，
        // 归一化规则调整后重算即可，不影响题目本身）
        'fingerprint' => 'ALTER TABLE questions ADD COLUMN fingerprint TEXT',
        // 刻意叫 publish_status 而不是 status：user_progress 也有一列 status
        //（每人自己的掌握状态），同名会让 JOIN 查询里的 status 产生歧义
        'publish_status' => "ALTER TABLE questions ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'published'",
        'owner_id' => 'ALTER TABLE questions ADD COLUMN owner_id INTEGER',
        'content_hash' => 'ALTER TABLE questions ADD COLUMN content_hash TEXT',
        'updated_at' => 'ALTER TABLE questions ADD COLUMN updated_at TEXT',
    ];

    $changed = false;
    foreach ($additions as $column => $sql) {
        if (!in_array($column, $columns, true)) {
            db()->exec($sql);
            $changed = true;
        }
    }

    // 新列建完后才能建索引。跟着 ensure_tables 里的 idx_questions_fingerprint
    // 一起做，是因为老库上那条语句会先执行并失败（列还不存在）而被跳过。
    db()->exec('CREATE INDEX IF NOT EXISTS idx_questions_fingerprint ON questions(fingerprint)');
    db()->exec('CREATE INDEX IF NOT EXISTS idx_questions_publish ON questions(publish_status)');

    return $changed;
}

/**
 * 一次性回填：把已有的 blanks_json / paper_id 投影到 question_tags 与 paper_items。
 *
 * ⚠️ 这个函数在**每个请求**的 bootstrap 里都会被执行到，所以有两条硬约束：
 *
 * 1. **必须分批**。几万道题一次性回填会让更新后的第一次请求超时（实测
 *    3 道题就要 4.7 秒，绝大部分是事务提交与 fsync 的固定开销）。
 *    这里每次只处理 BACKFILL_BATCH 道题，用 app_config 里的游标续跑，
 *    多个请求内跑完；跑完才写 done 标记。
 * 2. **幂等**。游标 + `INSERT OR IGNORE` 双保险：即使标记丢失重跑，
 *    也不会产生重复投影行。
 */
function migrate_backfill_projection()
{
    if (query_one('SELECT config_value FROM app_config WHERE config_key = ?', ['backfill_v350_done']) !== null) {
        return false;
    }

    // 每次请求处理多少道题。取 200 是权衡：单次事务足够短（毫秒级），
    // 几万题的库也只需一两百个请求就能跑完，用户完全无感。
    $batch = 200;

    // ① 指纹 + 标签投影：按 id 顺序推进游标
    $cursor = (string) (query_one(
        'SELECT config_value FROM app_config WHERE config_key = ?',
        ['backfill_v350_cursor']
    )['config_value'] ?? '');

    $rows = query(
        'SELECT id, original_sentence, blanks_json FROM questions
          WHERE id > ? ORDER BY id LIMIT ' . $batch,
        [$cursor]
    );

    if (count($rows) > 0) {
        db_transaction(function () use ($rows) {
            foreach ($rows as $row) {
                $blanks = json_decode((string) $row['blanks_json'], true);
                $blanks = is_array($blanks) ? $blanks : [];

                // 无条件写：同一份原句算出的指纹是不变的，重复写也是幂等；
                // 用 COALESCE 保留旧值反而会让空原句的行一直是 NULL，自愈扫描就会反复重跑
                execute(
                    'UPDATE questions SET fingerprint = ? WHERE id = ?',
                    [sentence_fingerprint((string) $row['original_sentence']), (string) $row['id']]
                );
                sync_question_tags((string) $row['id'], $blanks);
            }
        });

        write_config('backfill_v350_cursor', (string) $rows[count($rows) - 1]['id']);

        // 还有下一批，本次先返回——剩下的留给后续请求
        if (count($rows) === $batch) {
            return true;
        }
    }

    // ② 试卷成员表：只在题目全部处理完之后做一次，也是分批
    $paperCursor = (string) (query_one(
        'SELECT config_value FROM app_config WHERE config_key = ?',
        ['backfill_v350_paper_cursor']
    )['config_value'] ?? '');

    $papers = query(
        'SELECT id FROM papers WHERE id > ? ORDER BY id LIMIT 50',
        [$paperCursor]
    );

    if (count($papers) > 0) {
        db_transaction(function () use ($papers) {
            foreach ($papers as $paper) {
                $paperId = (string) $paper['id'];
                // 顺序必须与迁移前的展示顺序一致（routes_bank 的 ORDER BY created_at DESC, id
                // 是倒序展示，这里按正序写入 order_no，等价于「最早录入的是第 1 题」）
                $items = query(
                    'SELECT id FROM questions WHERE paper_id = ? ORDER BY created_at, id',
                    [$paperId]
                );
                $order = 0;
                foreach ($items as $item) {
                    $order++;
                    execute(
                        'INSERT OR IGNORE INTO paper_items (paper_id, question_id, order_no, section_no)
                         VALUES (?, ?, ?, 1)',
                        [$paperId, (string) $item['id'], $order]
                    );
                }
            }
        });

        write_config('backfill_v350_paper_cursor', (string) $papers[count($papers) - 1]['id']);
        return true;
    }

    // ③ 收尾前自愈扫描：抓「在标记写入之后才进来的行」——
    //    典型场景是全新安装（先迁移写标记、后导种子），或任何绕过写入侧同步的路径。
    //    只查 NULL（不是空串）：空原句的指纹合法地就是空串，用空串判断会死循环。
    $missing = query('SELECT id FROM questions WHERE fingerprint IS NULL LIMIT 1');
    if (count($missing) > 0) {
        // 游标退回起点重走一遍。因为每行的指纹都会被无条件写成非 NULL 值，
        // 这一趟之后必然没有 NULL 了，不会反复循环。
        write_config('backfill_v350_cursor', '');
        return true;
    }

    // ④ 全部完成，落标记
    write_config('backfill_v350_done', '1');
    return true;
}

/**
 * 写一条 app_config（存在则更新）。
 */
function write_config($key, $value)
{
    execute(
        'INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, ?, datetime(\'now\'))
         ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value,
                                               updated_at = excluded.updated_at',
        [$key, $value]
    );
}

/**
 * 重建一道题的题级标签投影。
 *
 * 权威数据永远是 blanks_json 里各空的 tagIds，本表只是它的可索引副本——
 * 因此每次题目内容变化都整体重建这一题的投影，不做增量比对。
 *
 * @param string $questionId
 * @param array  $blanks 题目各空配置数组
 */
function sync_question_tags($questionId, array $blanks)
{
    execute('DELETE FROM question_tags WHERE question_id = ?', [$questionId]);

    $ids = [];
    foreach ($blanks as $blank) {
        if (!is_array($blank)) {
            continue;
        }
        foreach ((array) ($blank['tagIds'] ?? []) as $tagId) {
            if (is_string($tagId) && $tagId !== '') {
                $ids[$tagId] = true;
            }
        }
    }
    foreach (array_keys($ids) as $tagId) {
        execute(
            'INSERT OR IGNORE INTO question_tags (question_id, tag_id, origin) VALUES (?, ?, ?)',
            [$questionId, $tagId, 'auto']
        );
    }
}

/**
 * 维护一道题的试卷归属（paper_items 投影）。
 *
 * @param string      $questionId
 * @param string|null $paperId    null 或空串表示移出所有卷
 * @param int|null    $orderNo    不给则追加到该卷末尾
 */
function sync_question_paper_item($questionId, $paperId, $orderNo = null)
{
    execute('DELETE FROM paper_items WHERE question_id = ?', [$questionId]);

    $paperId = $paperId === null ? '' : trim((string) $paperId);
    if ($paperId === '') {
        return;
    }

    if ($orderNo === null) {
        $max = query_one('SELECT MAX(order_no) AS n FROM paper_items WHERE paper_id = ?', [$paperId]);
        $orderNo = ((int) ($max['n'] ?? 0)) + 1;
    }

    execute(
        'INSERT OR REPLACE INTO paper_items (paper_id, question_id, order_no, section_no)
         VALUES (?, ?, ?, 1)',
        [$paperId, $questionId, (int) $orderNo]
    );
}

/**
 * 题目内容摘要。用于判断「内容是否真的变了」，与指纹的区别是：
 * 指纹只看原句（判「是不是同一道题」），内容摘要覆盖原句 + 答案 + 提示 + 解析。
 */
function compute_content_hash($sentence, array $blanks)
{
    $parts = [normalize_sentence((string) $sentence)];
    foreach ($blanks as $blank) {
        if (!is_array($blank)) {
            continue;
        }
        $parts[] = implode('/', answer_signature((array) ($blank['answer'] ?? [])));
        $parts[] = (string) ($blank['hintType'] ?? '');
        $parts[] = (string) ($blank['hintWord'] ?? '');
        $parts[] = (string) ($blank['trapAnalysis'] ?? '');
    }
    return sha1(implode("\x1f", $parts));
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
        'practice_records', 'user_favorites', 'user_marks', 'sessions', 'app_config',
        'question_tags', 'paper_items'];
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
                $sentence = isset($question['originalSentence']) ? (string) $question['originalSentence'] : '';
                $blanks = isset($question['blanks']) && is_array($question['blanks']) ? $question['blanks'] : [];

                execute(
                    'INSERT INTO questions
                       (id, original_sentence, blanks_json, source, schema_version,
                        fingerprint, content_hash, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        $question['id'],
                        $sentence,
                        json_encode($blanks, JSON_UNESCAPED_UNICODE),
                        !empty($question['source']) ? $question['source'] : '内置示例',
                        isset($question['schemaVersion']) ? $question['schemaVersion'] : 1,
                        // 派生数据必须在这里一并写入。
                        // 否则会踩这个坑：全新安装时 bootstrap 先跑 migrate_schema()
                        // （那时库是空的 → 回填直接写「已完成」标记），**之后**才导种子，
                        // 于是种子题永远拿不到指纹与投影——按标签筛题筛不到它们。
                        sentence_fingerprint($sentence),
                        compute_content_hash($sentence, $blanks),
                        to_sql_date(isset($question['createdAt']) ? $question['createdAt'] : null),
                        to_sql_date(isset($question['createdAt']) ? $question['createdAt'] : null),
                    ]
                );

                // 题级标签投影（种子题的标签同样要能筛）
                sync_question_tags((string) $question['id'], $blanks);
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
