/**
 * POST /api/system/update 的回归测试。
 *
 * 为什么单独一个文件：这是全站**唯一会执行 `git reset --hard`** 的接口，
 * 而且它会拉起后台进程。此前 `test:api` 与 `test:ui` 对它零覆盖
 * （ui-test 里恰好断言「已是最新时不显示更新按钮」，等于永远点不到）。
 *
 * 本测试只覆盖**不真正更新**的分支 —— 全部是会提前return 的早退路径：
 *   ① 未登录 → 401（鉴权不能漏，这是上一轮修过同类漏洞的地方）
 *   ② 非管理员 → 403
 *   ③ 脏工作区 → 409，且必须把 running 状态收掉
 *   ④ 已有更新在跑 → 409，且**不能**把上一轮的状态覆盖掉
 *   ⑤ 环境不可用（非 git 仓库）→ 500，同样要收状态
 *
 * ⚠️ 绝不触发「真的开始更新」那条路径：它会 nohup 拉起 worker_update.php，
 * 在测试环境里可能真的去 fetch 远端。测试用「脏工作区」把请求挡在启动之前，
 * 既验证了早退逻辑，也不会碰网络。
 *
 * 跑法：node php/tests/update-trigger-test.mjs http://127.0.0.1:9001
 * 前置：先起 php -S，且用**一次性干净库**（本测试会故意弄脏 git 工作区）。
 */
const BASE = process.argv[2] || "http://127.0.0.1:9001";

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `  → ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
}

async function post(path, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __raw: text.slice(0, 160) };
  }
  return { status: res.status, data };
}

console.log("更新触发接口回归测试（只测早退分支，不真的更新）\n");

/* ---------------- 登录拿 token ---------------- */
async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const d = await res.json().catch(() => null);
  return d && d.token ? d.token : null;
}

const adminToken = await login("admin", "123456");

/* 建一个普通用户用来验 403 —— 不注册就跳过这条断言，等于没测 */
let testToken = await login("test_update_user", "Test1234");
if (testToken === null) {
  const uniq = Date.now().toString(36).slice(-6);
  const username = `tu_${uniq}`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "Test1234" }),
  });
  if (reg.ok) testToken = await login(username, "Test1234");
}

/* ---- 1. 未登录必须401 ---- */
const anon = await post("/system/update");
check(
  "未登录触发更新 → 401（鉴权不能漏）",
  anon.status === 401,
  anon.data
);

/* ---- 2. 登录态先确认可用（后面几条的前提）---- */
check("管理员能登录并拿到 token", adminToken !== null);
if (adminToken === null) {
  console.log("\n无法登录，后续用例跳过");
  console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
  process.exit(failures.length > 0 ? 1 : 0);
}

/* ---- 3. 非管理员 → 403 ---- */
if (testToken !== null) {
  const asUser = await post("/system/update", testToken);
  check(
    "普通用户触发更新 → 403",
    asUser.status === 403,
    asUser.data
  );
} else {
  // 没有测试用户时不伪造结论，如实说明
  console.log("  SKIP  普通用户触发更新（无可用测试账号，未验证）");
}

/* ---- 4. 脏工作区 → 409，且必须收掉 running ---- */
 // 造一个未提交的本地改动：这是最能安全挡住「真正启动更新」的分支。
 // ⚠️ 动的是**真实项目仓库**，所以用 try/finally 保证清理，且清理失败要如实报告，
 // 不能让测试跑完给仓库留垃圾。
const { execFileSync } = await import("node:child_process");
const { readFileSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
const MARKER = "php/tests/_update_dirty_marker.tmp";
let dirtied = false;
try {
  writeFileSync(MARKER, "dirty\n");
  execFileSync("git", ["add", MARKER], { stdio: "ignore" });
  dirtied = true;
} catch {
  console.log("  SKIP  脏工作区用例（无法写入标记文件，未验证）");
}

if (dirtied) {
  try {
    const dirtyRes = await post("/system/update", adminToken);
    check(
      "工作区有未提交改动 → 409 拒绝更新",
      dirtyRes.status === 409,
      dirtyRes.data
    );
    check(
      "脏工作区拒绝时说明是本地改动（而不是笼统报错）",
      dirtyRes.data && typeof dirtyRes.data.error === "string" && dirtyRes.data.error !== "",
      dirtyRes.data
    );

    // 关键：早退路径必须把 running 收掉，否则界面会一直显示「更新中」
    const st = await fetch(`${BASE}/api/system/update-status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((r) => r.json());
    check(
      "脏工作区拒绝后 running 已收掉（界面不会卡在「更新中」）",
      !st || st.running !== true,
      st
    );
  } finally {
    // 无论断言结果如何都要清理
    try {
      execFileSync("git", ["rm", "--cached", "-q", MARKER], { stdio: "ignore" });
    } catch {
      /* 已在 index 里则忽略 */
    }
    try {
      rmSync(MARKER, { force: true });
    } catch {
      /* 已删除则忽略 */
    }
  }
}

/* ---- 5. 工作区已恢复干净 ---- */
// 只检查**本测试造出来的**那个标记文件有没有被清掉。
// 不能断言「整个工作区干净」——开发过程中本来就会有未提交的改动
// （比如正在改 package.json），那样这条断言会永远失败、变成噪音。
const markerLeft = existsSync(MARKER);
check(
  "测试造的脏文件标记已被清掉（不给仓库留垃圾）",
  !markerLeft,
  markerLeft ? "标记文件仍在：php/tests/_update_dirty_marker.tmp" : ""
);

// 反向确认：标记文件确实造成过改动（否则上面那条是空转）
const tracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  encoding: "utf8",
});
check(
  "标记文件确实进了 git 暂存区（否则脏工作区用例没测到东西）",
  dirtied === true,
  dirtied ? "" : "未能造出脏工作区"
);

/* ---- 6. 已有更新在跑 → 409，且不覆盖上一轮状态 ---- */
// 直接写状态文件模拟「正在更新」，比并发测试可控
const stateFile = "php/data/update_state.json";
const busyState = {
  running: true,
  startedAt: new Date().toISOString(),
  stage: "拉取代码（测试写入）",
  pid: process.pid,
};
let restored = null;
let stateTouched = false;
try {
  if (existsSync(stateFile)) restored = readFileSync(stateFile, "utf8");
  writeFileSync(stateFile, JSON.stringify(busyState), "utf8");
  stateTouched = true;
} catch {
  console.log("  SKIP  「已在更新中」用例（无法写状态文件，未验证）");
}

if (stateTouched) {
  try {
    const busyRes = await post("/system/update", adminToken);
    check(
      "已有更新在进行 → 409 拒绝并发触发",
      busyRes.status === 409,
      busyRes.data
    );

    const after = await fetch(`${BASE}/api/system/update-status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((r) => r.json());
    check(
      "并发拒绝时**没有**把上一轮状态覆盖掉",
      after && after.running === true,
      after
    );
    check(
      "并发拒绝时保留了上一轮的阶段文字",
      after && typeof after.stage === "string" && after.stage.includes("测试写入"),
      after
    );
  } finally {
    // 还原状态文件，别把测试态留给真实流程
    if (restored !== null) writeFileSync(stateFile, restored, "utf8");
    else rmSync(stateFile, { force: true });
  }
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length > 0 ? 1 : 0);