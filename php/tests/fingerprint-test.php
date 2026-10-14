<?php
/**
 * 指纹用例自测：跑 php/tests/fingerprint-cases.json 的全部用例
 * （cases + edge_cases + sentence_cases）。
 *
 * JS 侧 ui-test 会跑同一份文件，两端结果必须逐条一致 —— 这是防口径漂移的唯一手段。
 * 规格见 docs/FINGERPRINT_SPEC.md。
 */
require_once __DIR__ . '/../app/fingerprint.php';

$cases = json_decode(file_get_contents(__DIR__ . '/fingerprint-cases.json'), true);
$fail = 0; $n = 0;
$bad = [];

$run = function (string $id, string $desc, array $existing, array $incoming, string $expect) use (&$fail, &$n, &$bad): void {
    // E13 用占位符，换成超长原句
    if ($incoming['sentence'] === 'PLACEHOLDER') {
        $incoming['sentence'] = str_repeat('word ', 5000) . '______ end.';
    }
    $candidates = [];
    foreach ($existing as $e) {
        $c = ['id' => $e['id']];
        if (array_key_exists('sentence', $e)) {
            $c['originalSentence'] = $e['sentence'];
        }
        if (array_key_exists('answers', $e)) {
            $c['answers'] = $e['answers'];
        }
        $candidates[] = $c;
    }
    $r = classify_duplicate($incoming['sentence'], $incoming['answers'], $candidates);
    $n++;
    if ($r['state'] !== $expect) {
        $fail++;
        $bad[] = sprintf('%s(%s) 实际=%s 期望=%s', $id, $desc, $r['state'], $expect);
    }
};

echo "=== 原句归一化 ===\n";
foreach ($cases['sentence_cases'] as $c) {
    $got = sentence_fingerprint($c['in']);
    $n++;
    $ok = $got === $c['expect'];
    if (!$ok) { $fail++; $bad[] = "原句: '{$c['in']}' 实际=$got 期望={$c['expect']}"; }
    printf("  %-26s -> %-20s %s\n", $c['in'], $got, $ok ? '通过' : '★不符');
}

echo "\n=== 重复分类（主用例）===\n";
foreach ($cases['cases'] as $c) {
    $run($c['id'], $c['desc'] ?? '', $c['existing'], $c['incoming'], $c['expect']);
    printf("  %-4s %-40s %s\n", $c['id'],
        mb_substr($c['desc'] ?? '', 0, 20),
        in_array($c['id'], array_column($bad, ''), true) ? '★' : '通过');
}

echo "\n=== 边界与鲁棒性 ===\n";
foreach ($cases['edge_cases'] as $c) {
    $run($c['id'], $c['desc'], $c['existing'], $c['incoming'], $c['expect']);
    printf("  %-4s %-40s %s\n", $c['id'],
        mb_substr($c['desc'], 0, 20),
        in_array($c['id'], array_column($bad, ''), true) ? '★' : '通过');
}

if ($bad !== []) {
    echo "\n失败明细:\n";
    foreach ($bad as $b) {
        echo "  - $b\n";
    }
}
echo "\n共 $n 项，失败 $fail 项\n";
exit($fail === 0 ? 0 : 1);
