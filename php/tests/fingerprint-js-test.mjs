/**
 * 指纹用例 · JS 侧自测
 *
 * 跑的是**与 PHP 侧完全相同的那份用例集**
 * （php/tests/fingerprint-cases.json），两端结论必须逐条一致。
 * 这是防口径漂移的唯一手段——PHP 与浏览器无法共享代码。
 *
 * 用法：node php/tests/fingerprint-js-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runFingerprintCases,
  normalizeSentence,
  answerSignature,
  classifyDuplicate,
} from "../assets/js/fingerprint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(here, "fingerprint-cases.json"), "utf-8"));

const results = runFingerprintCases(cases);
const bad = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.log(`  FAIL  ${r.kind} ${r.id}  实际=${r.got} 期望=${r.expect}`);
}
console.log(`\nJS 侧：共 ${results.length} 项，失败 ${bad.length} 项`);

// 抽样核对（与 PHP 侧同一批断言，确保两边归一化结果逐字相同）
const samples = [
  ["The  boy______there．", "theboythere"],
  ["A（______）B", "a()b"],
  ["他 ______ 去学校。", "他去学校"],
  ["Ａ ______ Ｂ", "ab"],
  ["He has ______ finished it!", "hehasfinishedit"],
];
let sampleFail = 0;
console.log("\n抽样核对（期望值与 PHP 一致）：");
for (const [input, expect] of samples) {
  const got = normalizeSentence(input);
  const ok = got === expect;
  if (!ok) sampleFail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(input).padEnd(26)} -> ${JSON.stringify(got)}${ok ? "" : `  期望 ${JSON.stringify(expect)}`}`);
}

const sigChecks = [
  [["x/y", "X "], ["x", "y"]],
  [[["a", "b"]], ["a", "b"]],
  [[" written "], ["written"]],
  [[null, "a"], ["a"]],
];
console.log("\n答案签名：");
for (const [input, expect] of sigChecks) {
  const got = JSON.stringify(answerSignature(input));
  const ok = got === JSON.stringify(expect);
  if (!ok) sampleFail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(input).padEnd(22)} -> ${got}${ok ? "" : `  期望 ${JSON.stringify(expect)}`}`);
}

const total = bad.length + sampleFail;
console.log(`\n失败合计 ${total} 项`);
process.exit(total === 0 ? 0 : 1);
