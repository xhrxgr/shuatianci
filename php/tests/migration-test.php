<?php
/**
 * 老库迁移自测：验证「无新列的老库 → 跑一次请求 → 结构完整且有数据」。
 *
 * 为什么必须有这个测试：迁移代码在**每个请求**的 bootstrap 里跑，
 * 一旦在线上抛错，整站 500；一旦漏回填，筛题/查重会静默失效。
 * 本地全新安装永远走不到「老库」分支，所以必须手工造一个老结构来测。
 *
 * 用法：php php/tests/migration-test.php
 */

$root = dirname(__DIR__);
$db = sys_get_temp_dir() . '/eq-migtest-' . getmypid() . '.db';
foreach ([$db, $db . '-wal', $db . '-shm'] as $f) {
    @unlink($f);
}
putenv('DB_FILE=' . $db);
$_ENV['DB_FILE'] = $db;
$_SERVER['DB_FILE'] = $db;

$fail = 0;
$n = 0;
function chk($desc, $ok, $extra = '')
{
    global $fail, $n;
    $n++;
    if (!$ok) {
        $fail++;
    }
    printf("  %-44s %s%s\n", $desc, $ok ? '通过' : '★不符', $extra !== '' && !$ok ? "  实际: $extra" : '');
}

// ---------------------------------------------------------------------------
// ① 造一个「老库」：只有 v3.4.x 的列，没有 fingerprint / status / 投影表
// ---------------------------------------------------------------------------
$pdo = new PDO('sqlite:' . $db);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec("CREATE TABLE questions (
  id TEXT PRIMARY KEY, original_sentence TEXT NOT NULL, blanks_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '手动录入', paper_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
$pdo->exec("CREATE TABLE papers (id TEXT PRIMARY KEY, name TEXT NOT NULL, exam_date TEXT,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
$pdo->exec("CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
  color TEXT NOT NULL DEFAULT '#64748B', is_active INTEGER NOT NULL DEFAULT 1)");
$pdo->exec("CREATE TABLE app_config (config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')))");

$pdo->exec("INSERT INTO papers (id, name) VALUES ('p_0001', '甲卷')");
$pdo->exec("INSERT INTO papers (id, name) VALUES ('p_0002', '乙卷')");

$insert = $pdo->prepare(
    'INSERT INTO questions (id, original_sentence, blanks_json, source, paper_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)'
);
$blank = function ($idx, array $answers, array $tags) {
    return [
        'blankIndex' => $idx, 'answer' => $answers, 'hintWord' => null,
        'hintType' => '无提示词', 'tagIds' => $tags, 'trapAnalysis' => '测试解析',
    ];
};
// 甲卷 2 题、乙卷 1 题、未归卷 1 题
$insert->execute(['q_a', 'The boy ______ there.', json_encode([$blank(1, ['is'], ['t_001', 't_006'])], JSON_UNESCAPED_UNICODE), '甲卷', 'p_0001', '2026-10-01 09:00:00']);
$insert->execute(['q_b', 'A ______ B ______ C.', json_encode([$blank(1, ['x'], ['t_006']), $blank(2, ['y'], ['t_010'])], JSON_UNESCAPED_UNICODE), '甲卷', 'p_0001', '2026-10-01 10:00:00']);
$insert->execute(['q_c', 'Second ______ here.', json_encode([$blank(1, ['is'], [])], JSON_UNESCAPED_UNICODE), '乙卷', 'p_0002', '2026-10-02 09:00:00']);
$insert->execute(['q_d', 'Loose ______ one.', json_encode([$blank(1, ['w'], ['t_006'])], JSON_UNESCAPED_UNICODE), '手动录入', null, '2026-10-03 09:00:00']);
$pdo = null;

echo "① 老库已建：4 题（甲卷 2 / 乙卷 1 / 未归卷 1）、2 卷\n\n";

// ---------------------------------------------------------------------------
// ② 跑迁移
// ---------------------------------------------------------------------------
require_once $root . '/app/db.php';
require_once $root . '/app/util.php';
require_once $root . '/app/errors.php';
require_once $root . '/app/fingerprint.php';
require_once $root . '/app/schema.php';

echo "② 迁移\n";
$t0 = microtime(true);
for ($i = 0; $i < 3; $i++) {
    $t = microtime(true);
    ensure_schema();
    printf("   第 %d 次 ensure_schema: %d ms\n", $i + 1, round((microtime(true) - $t) * 1000));
}
printf("   合计 %d ms\n\n", round((microtime(true) - $t0) * 1000));

// ---------------------------------------------------------------------------
// ③ 结构验证
// ---------------------------------------------------------------------------
echo "③ 结构\n";
$cols = table_columns('questions');
foreach (['fingerprint', 'publish_status', 'owner_id', 'content_hash', 'updated_at'] as $c) {
    chk("questions 有 $c 列", in_array($c, $cols, true));
}
foreach (['question_tags', 'paper_items'] as $t) {
    chk("$t 表存在", table_columns($t) !== []);
}

// ---------------------------------------------------------------------------
// ④ 数据回填验证
// ---------------------------------------------------------------------------
echo "\n④ 回填\n";
chk('存量题目全部 published（决策 D2）', scalar_int("SELECT COUNT(*) FROM questions WHERE publish_status='published'") === 4,
    scalar_int("SELECT COUNT(*) FROM questions WHERE publish_status='published'"));

chk('指纹已全部回填', scalar_int("SELECT COUNT(*) FROM questions WHERE fingerprint IS NOT NULL AND fingerprint != ''") === 4,
    scalar_int("SELECT COUNT(*) FROM questions WHERE fingerprint IS NOT NULL AND fingerprint != ''"));
chk('指纹内容正确（去空白/标点/小写）',
    (string) query_one("SELECT fingerprint FROM questions WHERE id='q_a'")['fingerprint'] === 'theboythere',
    (string) query_one("SELECT fingerprint FROM questions WHERE id='q_a'")['fingerprint']);

// 题级标签并集：q_a=t_001,t_006 / q_b=t_006,t_010 / q_c=无 / q_d=t_006
chk('question_tags 行数正确', scalar_int('SELECT COUNT(*) FROM question_tags') === 5,
    scalar_int('SELECT COUNT(*) FROM question_tags'));
chk('多空题的标签取并集',
    scalar_int("SELECT COUNT(*) FROM question_tags WHERE question_id='q_b'") === 2,
    scalar_int("SELECT COUNT(*) FROM question_tags WHERE question_id='q_b'"));
chk('无标签的题不产生行',
    scalar_int("SELECT COUNT(*) FROM question_tags WHERE question_id='q_c'") === 0);
chk('同一标签只算一行（q_a 的 t_006 与其他空重复）',
    scalar_int("SELECT COUNT(*) FROM question_tags WHERE question_id='q_a' AND tag_id='t_006'") === 1);

// paper_items
chk('paper_items 总数正确（3 题归卷）', scalar_int('SELECT COUNT(*) FROM paper_items') === 3,
    scalar_int('SELECT COUNT(*) FROM paper_items'));
chk('甲卷 2 题', scalar_int("SELECT COUNT(*) FROM paper_items WHERE paper_id='p_0001'") === 2);
chk('乙卷 1 题', scalar_int("SELECT COUNT(*) FROM paper_items WHERE paper_id='p_0002'") === 1);
chk('序号从 1 连续',
    scalar_int("SELECT MIN(order_no) FROM paper_items WHERE paper_id='p_0001'") === 1
    && scalar_int("SELECT MAX(order_no) FROM paper_items WHERE paper_id='p_0001'") === 2);
chk('未归卷的题不进 paper_items',
    scalar_int("SELECT COUNT(*) FROM paper_items WHERE question_id='q_d'") === 0);

chk('完成标记已写', query_one("SELECT config_value FROM app_config WHERE config_key='backfill_v350_done'") !== null);

// ---------------------------------------------------------------------------
// ⑤ 幂等：再跑一遍不应产生任何变化
// ---------------------------------------------------------------------------
echo "\n⑤ 幂等\n";
$before = [
    'tags' => scalar_int('SELECT COUNT(*) FROM question_tags'),
    'items' => scalar_int('SELECT COUNT(*) FROM paper_items'),
    'fp' => scalar_int("SELECT COUNT(*) FROM questions WHERE fingerprint != ''"),
];
for ($i = 0; $i < 3; $i++) {
    ensure_schema();
}
chk('question_tags 不重复累加', scalar_int('SELECT COUNT(*) FROM question_tags') === $before['tags'],
    scalar_int('SELECT COUNT(*) FROM question_tags'));
chk('paper_items 不重复累加', scalar_int('SELECT COUNT(*) FROM paper_items') === $before['items'],
    scalar_int('SELECT COUNT(*) FROM paper_items'));
chk('指纹行数不变', scalar_int("SELECT COUNT(*) FROM questions WHERE fingerprint != ''") === $before['fp']);

// ---------------------------------------------------------------------------
// ⑥ 全新安装也应有完整结构（走的是另一条路径：schema.sql 直接建好）
// ---------------------------------------------------------------------------
echo "\n⑥ 全新安装\n";
$fresh = sys_get_temp_dir() . '/eq-freshtest-' . getmypid() . '.db';
foreach ([$fresh, $fresh . '-wal', $fresh . '-shm'] as $f) {
    @unlink($f);
}
// 换库需要重置连接（db() 把连接缓存在 $GLOBALS['__pdo']）
$GLOBALS['__pdo'] = null;
putenv('DB_FILE=' . $fresh);
$_ENV['DB_FILE'] = $fresh;
ensure_schema();

// ⚠️ 关键：必须完全照 bootstrap 的真实顺序走一遍。
// ensure_schema 在空库上会直接写「回填已完成」标记（没有可回填的行），
// **之后**才由 bootstrap 调 seed_if_needed 导种子 ——
// 如果种子导入不自己写指纹与投影，种子题就会永远缺这两样，
// 表现为「按标签筛题筛不到内置示例」。曾实际踩到。
if (query_one('SELECT config_value FROM app_config WHERE config_key = ?', [SEED_FLAG]) === null) {
    seed_if_needed();
}

$freshCols = table_columns('questions');
chk('全新库直接带 fingerprint 列', in_array('fingerprint', $freshCols, true));
chk('全新库直接带 publish_status 列', in_array('publish_status', $freshCols, true));
chk('全新库有 question_tags', table_columns('question_tags') !== []);
chk('全新库有 paper_items', table_columns('paper_items') !== []);
chk('全新库的标记已写（不会重复回填）',
    query_one("SELECT config_value FROM app_config WHERE config_key='backfill_v350_done'") !== null);

$seedCount = scalar_int('SELECT COUNT(*) FROM questions');
if ($seedCount > 0) {
    chk('种子题带指纹', scalar_int("SELECT COUNT(*) FROM questions WHERE fingerprint IS NOT NULL") === $seedCount,
        scalar_int("SELECT COUNT(*) FROM questions WHERE fingerprint IS NOT NULL") . "/$seedCount");
    chk('种子题带题级标签投影', scalar_int('SELECT COUNT(*) FROM question_tags') > 0,
        scalar_int('SELECT COUNT(*) FROM question_tags'));
}

// 重复请求不应累加投影
$beforeSeedTags = scalar_int('SELECT COUNT(*) FROM question_tags');
for ($i = 0; $i < 2; $i++) {
    ensure_schema();
}
chk('重复请求不累加种子题的投影', scalar_int('SELECT COUNT(*) FROM question_tags') === $beforeSeedTags,
    scalar_int('SELECT COUNT(*) FROM question_tags'));

foreach ([$db, $db . '-wal', $db . '-shm', $fresh, $fresh . '-wal', $fresh . '-shm'] as $f) {
    @unlink($f);
}

echo "\n共 $n 项，失败 $fail 项\n";
exit($fail === 0 ? 0 : 1);
