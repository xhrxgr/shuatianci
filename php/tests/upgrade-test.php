<?php
/**
 * 升级路径自测：从旧版本数据库升级到当前版本，验证不报错、数据不丢。
 *
 * 为什么必须有这个测试
 * ------------------
 * 接口与页面测试**全都跑在全新库上**，所以「老库没有新表 / 没有新列」
 * 这类问题测不出来——而它恰恰是升级时必然踩到的：
 *   · 新增表：老库里不存在，代码里直接 ALTER TABLE 会抛「no such table」
 *   · 新增列：老库里没有，代码里 SELECT 新列会抛「no such column」
 *   · 依赖新列的索引：老库上建索引必然失败
 * 这三种都在 bootstrap() 里跑，**一抛错就是每个请求 500、整站不可用**。
 *
 * 用法：
 *   DB_FILE=/tmp/upgrade.db php php/tests/upgrade-test.php
 *
 * 旧版 schema 用仓库里的夹具php/tests/fixtures/schema-v3.0.21.sql
 * （v3.1.0 引入 papers 之前的那一版）。固定用夹具而不是从 git 取上一版——
 * 上一版一旦也带了新表，这个测试就测不出问题，变成假的安全感。
 */

$phpRoot = dirname(__DIR__);
require_once $phpRoot . '/app/config.php';
require_once $phpRoot . '/app/db.php';
require_once $phpRoot . '/app/schema.php';

$failures = 0;
function ok($condition, $label)
{
    global $failures;
    if ($condition) {
        echo "  PASS  {$label}\n";
    } else {
        $failures++;
        echo "  FAIL  {$label}\n";
    }
}

// ---- 旧版 schema：夹具优先，也可传路径覆盖 ----
$oldSchemaPath = isset($argv[1]) && $argv[1] !== ''
    ? $argv[1]
    : __DIR__ . '/fixtures/schema-v3.0.21.sql';

if (!is_file($oldSchemaPath)) {
    echo "SKIP  找不到旧版 schema（{$oldSchemaPath}），跳过升级自测\n";
    exit(0);
}

echo "旧版 schema: {$oldSchemaPath}\n";

// ---- 第一步：按旧版 schema 建库（模拟线上现状） ----
$oldSql = file_get_contents($oldSchemaPath);
$lines = array_filter(explode("\n", $oldSql), function ($line) {
    return strpos(trim($line), '--') !== 0;
});
foreach (explode(';', implode("\n", $lines)) as $statement) {
    $statement = trim($statement);
    if ($statement !== '') {
        db()->exec($statement);
    }
}
db()->exec("INSERT INTO questions (id, original_sentence, blanks_json, source)
            VALUES ('q_upgrade_old', 'Old ______ sentence.', '[]', '旧试卷')");

$beforeTableCount = count(query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));
$beforeQuestions = count(query('SELECT id FROM questions'));
$beforeTags = count(query('SELECT id FROM tags'));
echo "\n升级前：{$beforeTableCount} 张表，{$beforeQuestions} 道题，{$beforeTags} 个标签\n\n";

// ---- 第二步：跑 bootstrap 的分支判断（与 index.php 保持一致） ----
$usersTable = query_one("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
if ($usersTable === null) {
    ensure_schema();
} else {
    migrate_schema();
}
ok(true, '升级过程没有抛异常（这一项失败=整站 500）');

$afterTableCount = count(query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));
ok($afterTableCount >= $beforeTableCount, "表数没减少（{$beforeTableCount} -> {$afterTableCount}）");

// ---- 第三步：老数据一条不少 ----
ok(count(query('SELECT id FROM questions')) === $beforeQuestions, "题目数量不变（{$beforeQuestions}）");
ok(count(query('SELECT id FROM tags')) === $beforeTags, "标签数量不变（{$beforeTags}）");
$old = query_one('SELECT * FROM questions WHERE id = ?', ['q_upgrade_old']);
ok($old !== null && $old['source'] === '旧试卷', '老题目的内容与来源保持原样');

// ---- 第四步：当前代码用到的每一张表、每一列都在 ----
require_once $phpRoot . '/app/util.php';
require_once $phpRoot . '/app/validate.php';
require_once $phpRoot . '/app/routes_bank.php';
require_once $phpRoot . '/app/routes_papers.php';

ok(count(table_columns('papers')) > 0, 'papers 表可用');
ok(in_array('paper_id', table_columns('questions'), true), 'questions.paper_id 已加上');
ok(in_array('note', table_columns('papers'), true), 'papers.note 已加上');

$rows = query('SELECT id, original_sentence, blanks_json, source, paper_id, schema_version, created_at FROM questions');
ok(count($rows) === $beforeQuestions, '首页用的查询（含 paper_id）能跑通');
ok(count(map_question($rows[0])) > 0, 'map_question 能跑通');
ok(is_array(query_papers_with_counts()), '试卷列表查询能跑通');
ok(ensure_paper_by_name('旧试卷') !== '', 'ensure_paper_by_name 能跑通');

// ---- 第五步：迁移幂等（每个请求都会跑，不能第二次就炸） ----
try {
    migrate_schema();
    migrate_schema();
    migrate_schema();
    ok(true, '重复迁移 3 次不报错（幂等）');
} catch (Throwable $e) {
    ok(false, '重复迁移 3 次不报错（幂等）：' . $e->getMessage());
}

// ---- 清理 ----
echo "\n" . ($failures === 0 ? "升级自测全部通过\n" : "升级自测失败 {$failures} 项\n");
exit($failures === 0 ? 0 : 1);