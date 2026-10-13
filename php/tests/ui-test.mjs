/**
 * 页面交互回归测试（浏览器）。
 *
 * 覆盖刷题页的核心交互：模式切换、筛选、逐空作答、回车跳空、提交判卷、
 * 解析展开、翻页、随机打乱、游客记录落本地。
 *
 * 依赖：playwright-core + 本机已有的 Chrome/Edge（不下载浏览器）。
 *   npm install playwright-core        # 在任意目录装一次即可
 *   node php/tests/ui-test.mjs http://127.0.0.1:9001
 *
 * **必须用一个全新的库，且不要与接口测试（api-test.mjs）共用同一个服务**：
 *   rm -f php/data/test_ui.db*
 *   DB_FILE=data/test_ui.db php -S 127.0.0.1:9002 php/dev-router.php
 * 理由：脚本里的断言（错题本数量、收藏与标记状态、本地错次）默认从干净
 * 状态开始；接口测试会创建用户与题目，同库连跑会因残留数据误报。
 */

import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:9001";

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
}

/** 依次尝试本机浏览器通道 */
async function launchBrowser() {
  const channels = ["chrome", "msedge"];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // 换下一个
    }
  }
  throw new Error("未找到可用的 Chrome / Edge，请安装其中之一");
}

async function main() {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  // 「复制提示词」测试需要读写剪贴板（Chromium 默认需显式授权）
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await context.newPage();

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // 删除 / 清空 / 取消收藏等操作都有 confirm，自动确认以便脚本走通
  page.on("dialog", (dialog) => dialog.accept());

  console.log(`\n页面交互测试：${BASE}\n`);

  /* ---------------- 404 页（未登录） ---------------- */
  const resp404 = await page.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
  check("未匹配路径渲染 404 页", (await page.getByText("页面不存在").count()) >= 1);
  check("404 页返回 404 状态码", resp404.status() === 404, resp404.status());

  /* ---------------- 刷题页 ---------------- */
  await page.goto(`${BASE}/practice`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  // 启动数据
  const boot = await page.evaluate(() => {
    const el = document.getElementById("practice-boot");
    return el ? JSON.parse(el.textContent) : null;
  });
  check("页面嵌入了启动数据 practice-boot", boot !== null);
  check("题目数据非空", (boot?.questions?.length ?? 0) > 0, boot?.questions?.length);

  // 模式切换
  const tabs = page.locator("#practice-tabs button");
  check("渲染 5 个模式按钮", (await tabs.count()) === 5, await tabs.count());
  check(
    "首个模式为「全部题目」且计数等于题库总数",
    (await tabs.first().innerText()).includes("全部题目") &&
      (await tabs.first().innerText()).includes(String(boot.questions.length)),
    await tabs.first().innerText()
  );
  const firstTabClass = await tabs.first().getAttribute("class");
  check("选中态使用 bg-ink 样式", firstTabClass.includes("bg-ink"));

  // 筛选栏
  const hintButtons = page.locator("#practice-filter button[data-hint-type]");
  check("筛选栏有 6 个提示词类型按钮（全部 + 5 类）", (await hintButtons.count()) === 6, await hintButtons.count());
  const tagButtons = page.locator("#practice-filter button[data-tag]");
  check("标签按钮已渲染（38 个子标签）", (await tagButtons.count()) === 38, await tagButtons.count());
  check(
    "筛选栏显示题量统计",
    /共 \d+ 题，当前 \d+ 题/.test(await page.locator("#practice-filter span.ml-auto").innerText())
  );

  // 题目卡片
  const card = page.locator("#practice-card article");
  check("题目卡片已渲染", (await card.count()) === 1);
  check("卡片头部显示来源", (await card.locator("header").innerText()).includes("来源："));
  check("状态徽章为「未掌握」", (await card.locator("header").innerText()).includes("未掌握"));

  const firstQuestion = boot.questions[0];
  const sortedBlanks = [...firstQuestion.blanks].sort((a, b) => a.blankIndex - b.blankIndex);
  const inputs = card.locator("input[data-blank]");
  check("输入框数量等于空格数", (await inputs.count()) === sortedBlanks.length, await inputs.count());
  check("第一个空自动聚焦", await inputs.first().evaluate((el) => el === document.activeElement));

  // 回车跳空（只在这道题有多个空时才做，单空按回车会直接提交，会干扰后面的用例）
  if (sortedBlanks.length > 1) {
    await inputs.first().fill("test-value");
    await inputs.first().press("Enter");
    check(
      "回车跳到下一个空",
      await inputs.nth(1).evaluate((el) => el === document.activeElement)
    );
  } else {
    check("当前首题只有 1 个空，跳过「回车跳空」用例", true);
  }

  // 提交判卷：第一空填正确答案、其余故意填错
  await inputs.first().fill(sortedBlanks[0].answer[0]);
  for (let i = 1; i < sortedBlanks.length; i += 1) {
    await inputs.nth(i).fill("__wrong__");
  }
  await inputs.last().press("Enter");

  const bannerVisible = await page.locator("#practice-card .rounded-xl.border-danger\\/30").count();
  const bannerSuccess = await page.locator("#practice-card .rounded-xl.border-success\\/30").count();
  const expectAllCorrect = sortedBlanks.length === 1;
  check(
    "多空时答错显示「答错 N 个，查看解析」",
    expectAllCorrect ? bannerSuccess === 1 : bannerVisible === 1,
    { bannerVisible, bannerSuccess }
  );

  // 判卷后的只读与对错标记
  check("提交后输入框变为只读", await inputs.first().evaluate((el) => el.readOnly));
  check("出现解析区", (await page.locator("#practice-card section").count()) === 1);
  check(
    "解析区含「出题人视角解析」标题",
    (await page.locator("#practice-card section h3").innerText()) === "出题人视角解析"
  );
  check("解析区展示答案", (await page.locator("#practice-card section").innerText()).includes("答案："));
  check("提交后出现「下一题」按钮", (await page.locator('#practice-card button[data-action="next"]').count()) === 1);
  check(
    "提交后出现「标记为已掌握」按钮",
    (await page.locator('#practice-card button[data-action="master"]').count()) === 1
  );

  // 游客记录落本地
  const localRecords = await page.evaluate(() => {
    const raw = window.localStorage.getItem("eq_local_records");
    return raw ? JSON.parse(raw) : [];
  });
  check("游客作答已写入本地记录", localRecords.length === 1, localRecords.length);
  check("本地记录含 questionId 与作答", localRecords[0]?.questionId === firstQuestion.id);

  const localProgress = await page.evaluate(() => {
    const raw = window.localStorage.getItem("eq_local_progress");
    return raw ? JSON.parse(raw) : {};
  });
  check(
    "游客答错已累加本地错次",
    (localProgress[firstQuestion.id]?.wrongCount ?? 0) >= 1,
    localProgress
  );

  // 标记为已掌握
  await page.locator('#practice-card button[data-action="master"]').click();
  await page.waitForTimeout(100);
  check(
    "标记已掌握后状态徽章变化",
    (await card.locator("header").innerText()).includes("已掌握")
  );
  const afterMaster = await page.evaluate(() => {
    const raw = window.localStorage.getItem("eq_local_progress");
    return raw ? JSON.parse(raw) : {};
  });
  check("掌握状态写入本地进度", afterMaster[firstQuestion.id]?.status === "mastered");

  // 下一题
  const counterBefore = await page.locator("#practice-counter").innerText();
  await page.locator("#practice-next").click();
  await page.waitForTimeout(100);
  const counterAfter = await page.locator("#practice-counter").innerText();
  check("「下一题」切换计数器", counterBefore !== counterAfter, { counterBefore, counterAfter });

  // 随机打乱与恢复
  await page.locator("#practice-shuffle").click();
  await page.waitForTimeout(100);
  check("打乱后出现「恢复原序」按钮", await page.locator("#practice-restore").isVisible());
  check("计数器标注「随机顺序」", (await page.locator("#practice-counter").innerText()).includes("随机顺序"));
  await page.locator("#practice-restore").click();
  await page.waitForTimeout(100);
  check("恢复原序后按钮隐藏", !(await page.locator("#practice-restore").isVisible()));

  // 模式切换：答错后错题本应有 1 题
  const wrongTab = page.locator('#practice-tabs button[data-tab="wrong"]');
  await wrongTab.click();
  await page.waitForTimeout(100);
  check(
    "错题本有计数（≥1）",
    /[1-9]/.test(await wrongTab.innerText()),
    await wrongTab.innerText()
  );
  check("错题本有题目卡片", (await page.locator("#practice-card article").count()) === 1);

  // 筛选：提示词类型
  const hintType = sortedBlanks[0].hintType;
  const hintButton = page.locator(`#practice-filter button[data-hint-type="${hintType}"]`);
  await hintButton.click();
  await page.waitForTimeout(100);
  check("选中提示词类型后出现「重置筛选」", (await page.locator('#practice-filter button[data-action="reset-filter"]').count()) === 1);
  await page.locator('#practice-filter button[data-action="reset-filter"]').click();
  await page.waitForTimeout(100);
  check("重置筛选后按钮消失", (await page.locator('#practice-filter button[data-action="reset-filter"]').count()) === 0);

  // 清空数据回到「全部题目」，避免影响后续断言
  await page.locator('#practice-tabs button[data-tab="all"]').click();
  await page.waitForTimeout(100);

  /* ---------------- 首页 / 登录页基础渲染 ---------------- */
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check("首页标题正确", (await page.title()) === "高考英语短文填空穷举题库");
  check("首页有统计卡片", (await page.locator("section.grid > div").count()) === 4);
  check("导航含「刷题」", (await page.locator('header nav a[href="/practice"]').count()) >= 1);

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  check("登录页渲染表单", (await page.locator("#login-form").count()) === 1);
  check("登录页初始为「登录」模式", (await page.locator("#login-title").innerText()) === "登录");
  await page.locator("#login-switch").click();
  check("切换到注册模式", (await page.locator("#login-title").innerText()) === "注册新账号");
  check(
    "注册模式按钮文案变化",
    (await page.locator("#login-submit").innerText()) === "注册并登录"
  );
  // 切回登录模式（下面测的是登录路径，不要在注册模式下跑，否则会真的创建用户）
  await page.locator("#login-switch").click();
  check("切回登录模式", (await page.locator("#login-title").innerText()) === "登录");

  /** 读取提示文案（元素可能带 hidden，用 textContent 避免可见性等待） */
  const errorText = () => page.locator("#login-error").evaluate((el) => el.textContent ?? "");

  // 空提交的校验提示
  await page.locator("#login-submit").click();
  await page.waitForTimeout(100);
  check("空表单提交提示「请填写用户名和密码」", (await errorText()) === "请填写用户名和密码");

  // 登录失败提示。用随机用户名，确保它一定不存在——
  // 固定名字会被上一次测试真的注册掉，导致这一断言反而登录成功
  const ghost = `ghost_${Date.now()}`;
  await page.locator("#username").fill(ghost);
  await page.locator("#password").fill("wrongpass");
  await page.locator("#login-submit").click();
  await page
    .waitForFunction(
      () => {
        const el = document.getElementById("login-error");
        return el && !el.hidden && (el.textContent || "").length > 0;
      },
      { timeout: 5000 }
    )
    .catch(() => {});
  check(
    "错误口令提示「用户名或密码错误」",
    (await errorText()).includes("用户名或密码错误"),
    { text: await errorText(), url: page.url() }
  );

  // 登录成功（admin / 123456）
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill("123456");
  await page.locator("#login-submit").click();
  await page.waitForURL(`${BASE}/`, { timeout: 5000 }).catch(() => {});
  check("登录成功后跳转首页", page.url().replace(/\/$/, "") === BASE);
  const token = await page.evaluate(() => window.localStorage.getItem("eq_token"));
  check("登录后 token 已保存", typeof token === "string" && token.length > 0);
  check(
    "登录后导航出现「我的记录」",
    (await page.locator('header nav a[href="/profile"]').count()) >= 1
  );

  /* ---------------- 个人中心 ---------------- */
  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  check("个人中心标题为「我的记录」", (await page.locator("h2").first().innerText()) === "我的记录");
  check(
    "个人中心显示角色",
    (await page.locator("p").first().innerText()).includes("管理员"),
    await page.locator("p").first().innerText()
  );
  check("个人中心有 4 个统计格", (await page.locator("section").first().locator("div.rounded-lg").count()) === 4);
  check("个人中心有改密码表单", (await page.locator("#profile-password-form").count()) === 1);
  check("个人中心有退出按钮", (await page.locator('[data-action="logout"]').count()) >= 1);

  // 改密码：原密码错误应提示
  await page.locator("#profile-old-password").fill("definitely-wrong");
  await page.locator("#profile-new-password").fill("abcdef");
  await page.locator("#profile-submit").click();
  await page
    .waitForFunction(
      () => {
        const el = document.getElementById("profile-error");
        return el && !el.hidden && (el.textContent || "").length > 0;
      },
      { timeout: 5000 }
    )
    .catch(() => {});
  check(
    "原密码错误提示「原密码不正确」",
    (await page.locator("#profile-error").evaluate((el) => el.textContent ?? "")) === "原密码不正确",
    await page.locator("#profile-error").evaluate((el) => el.textContent ?? "")
  );

  /* ---------------- 收藏与标记 ---------------- */
  // 先清掉上次运行可能留下的收藏与标记，保证从干净状态开始
  // （否则「标记本题」会走成「取消标记」，后面的断言就跟不上了）
  await page.evaluate(async () => {
    const token = window.localStorage.getItem("eq_token");
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const marks = await (await fetch("/api/marks", { headers })).json();
    for (const item of marks.marks ?? []) {
      await fetch("/api/marks", {
        method: "POST",
        headers,
        body: JSON.stringify({ questionId: item.questionId }),
      });
    }
    const favorites = await (await fetch("/api/favorites", { headers })).json();
    for (const item of favorites.favorites ?? []) {
      await fetch("/api/favorites", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: item.source }),
      });
    }
  });

  await page.goto(`${BASE}/practice`, { waitUntil: "networkidle" });
  const favButton = page.locator('#practice-collection button[data-action="favorite"]');
  check("登录后在刷题页出现「收藏本卷」", (await favButton.count()) === 1);
  await favButton.click();
  await page
    .waitForFunction(
      () =>
        (document.querySelector('#practice-collection button[data-action="favorite"]')?.textContent ?? "").includes(
          "已收藏本卷"
        ),
      { timeout: 5000 }
    )
    .catch(() => {});
  check(
    "收藏后按钮变为「已收藏本卷」",
    (await favButton.innerText()).includes("已收藏本卷"),
    await favButton.innerText()
  );

  await page.locator('#practice-collection button[data-action="mark"]').click();
  await page.waitForTimeout(200);
  const noteInput = page.locator("#practice-collection input[data-mark-note]");
  check("点「标记本题」展开标记输入区", (await noteInput.count()) === 1);
  await noteInput.fill("测试备注");
  await page.locator('#practice-collection button[data-action="mark-confirm"]').click();
  await page
    .waitForFunction(
      () =>
        (document.querySelector('#practice-collection button[data-action="mark"]')?.textContent ?? "").includes(
          "取消标记"
        ),
      { timeout: 5000 }
    )
    .catch(() => {});
  check(
    "标记后按钮变为「取消标记」",
    (await page.locator('#practice-collection button[data-action="mark"]').innerText()).includes("取消标记"),
    await page.locator('#practice-collection button[data-action="mark"]').innerText()
  );

  /* ---------------- 我的收藏页 ---------------- */
  await page.goto(`${BASE}/collection`, { waitUntil: "networkidle" });
  check("收藏页显示收藏的试卷", (await page.locator("[data-favorite-item]").count()) >= 1);
  check("收藏页显示标记的题目", (await page.locator("[data-mark-item]").count()) >= 1);
  check(
    "标记项带备注与题目原句",
    (await page.locator("[data-mark-item]").first().innerText()).includes("测试备注"),
    await page.locator("[data-mark-item]").first().innerText()
  );

  await page.locator('[data-collection-tab="marks"]').click();
  check("切到标记页签后 URL 带 tab=marks", page.url().includes("tab=marks"), page.url());
  check("标记面板可见", await page.locator('[data-panel="marks"]').isVisible());
  check("收藏面板已隐藏", !(await page.locator('[data-panel="favorites"]').isVisible()));

  /* ---------------- 取消收藏 / 取消标记（flash 提示在刷新后仍可见） ---------------- */
  await page.locator('[data-collection-tab="favorites"]').click();
  await page.waitForTimeout(200);
  const favCountBefore = await page.locator("[data-favorite-item]").count();
  await page.locator('[data-favorite-item] [data-action="remove-favorite"]').first().click();
  await page.waitForTimeout(1200);
  check(
    "取消收藏后 flash 提示可见「已取消收藏」",
    (await page.locator("#collection-notice").innerText().catch(() => "")).includes("已取消收藏")
  );
  check("取消收藏后列表减少", (await page.locator("[data-favorite-item]").count()) === favCountBefore - 1);

  await page.locator('[data-collection-tab="marks"]').click();
  await page.waitForTimeout(300);
  const markCountBefore = await page.locator("[data-mark-item]").count();
  await page.locator('[data-mark-item] [data-action="remove-mark"]').first().click();
  await page.waitForTimeout(1200);
  check(
    "取消标记后 flash 提示可见「已取消标记」",
    (await page.locator("#collection-notice").innerText().catch(() => "")).includes("已取消标记")
  );
  check("取消标记后列表减少", (await page.locator("[data-mark-item]").count()) === markCountBefore - 1);

  /* ---------------- 题库管理 ---------------- */
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  check("题库管理有 4 个页签", (await page.locator("[data-admin-tab]").count()) === 4);
  check("默认停在手动精录", await page.locator('[data-admin-panel="manual"]').isVisible());
  check("其它页签默认收起", !(await page.locator('[data-admin-panel="import"]').isVisible()));

  // 输入原句 -> 自动拆空 -> 预览
  await page.locator("#admin-sentence").fill("He is an ______ (energy) boy.");
  await page.waitForTimeout(300);
  check(
    "识别到 1 个空格",
    (await page.locator("#admin-blank-count").innerText()).includes("1 个空格"),
    await page.locator("#admin-blank-count").innerText()
  );
  check("生成 1 个空的配置卡", (await page.locator("[data-blank-card]").count()) === 1);
  check("提示词已从括号提取", (await page.locator("[data-blank-card]").first().innerText()).includes("(energy)"));
  check("右侧实时预览出现题目卡片", (await page.locator("#admin-preview article").count()) === 1);

  // 宽容识别：全角下划线 / 中文破折号 / 非 6 个的连续下划线
  await page.locator("#admin-sentence").fill("He is an ＿＿＿＿＿＿ (energy) boy.");
  await page.waitForTimeout(200);
  check(
    "全角下划线也能识别",
    (await page.locator("#admin-blank-count").innerText()).includes("1 个空格"),
    await page.locator("#admin-blank-count").innerText()
  );

  await page.locator("#admin-sentence").fill("He is an —— boy and —— girl.");
  await page.waitForTimeout(200);
  check(
    "中文破折号（Shift+减号）也能识别",
    (await page.locator("#admin-blank-count").innerText()).includes("2 个空格"),
    await page.locator("#admin-blank-count").innerText()
  );

  await page.locator("#admin-sentence").fill("Only four ____ underscores here.");
  await page.waitForTimeout(200);
  check(
    "4 个连续下划线也识别为一个空",
    (await page.locator("#admin-blank-count").innerText()).includes("1 个空格"),
    await page.locator("#admin-blank-count").innerText()
  );

  await page.locator("#admin-sentence").fill("No placeholder in this sentence.");
  await page.waitForTimeout(200);
  check(
    "没有占位符时给出用法提示",
    (await page.locator("#admin-blank-count").innerText()).includes("6 个下划线"),
    await page.locator("#admin-blank-count").innerText()
  );
  check(
    "没有空位时说明配置卡包含标签与解析",
    (await page.locator("#admin-blanks").innerText()).includes("命题意图与判断依据"),
    await page.locator("#admin-blanks").innerText()
  );

  // 恢复为后续保存流程使用的句子
  await page.locator("#admin-sentence").fill("He is an ______ (energy) boy.");
  await page.waitForTimeout(200);

  // 答案为空时保存应报错
  await page.locator("#admin-save").click();
  await page.waitForTimeout(200);
  check("答案为空时保存被拦下", !(await page.locator("#admin-errors").isHidden()));

  // 填好答案与解析后保存
  await page.locator('[data-blank-answer="0"]').fill("energetic");
  await page.locator('[data-blank-hint="0"]').selectOption("给形容词");
  await page.locator('[data-blank-trap="0"]').fill("修饰名词 boy，用形容词形式");
  await page.locator("#admin-save").click();
  await page
    .waitForFunction(
      () => (document.getElementById("admin-notice")?.textContent ?? "").includes("已保存题目"),
      { timeout: 5000 }
    )
    .catch(() => {});
  check(
    "保存题目成功并提示",
    (await page.locator("#admin-notice").innerText()).includes("已保存题目"),
    await page.locator("#admin-notice").innerText()
  );
  check("保存后表单已清空", (await page.locator("#admin-sentence").inputValue()) === "");

  // 全角下划线保存后应自动规范化为标准格式（经公开题库接口验证）
  await page.locator("#admin-sentence").fill("Bracket ＿＿＿＿＿＿ case ＿＿＿＿＿＿ done.");
  await page.waitForTimeout(200);
  await page.locator('[data-blank-answer="0"]').fill("one");
  await page.locator('[data-blank-answer="1"]').fill("two");
  await page.locator('[data-blank-trap="0"]').fill("测试解析一");
  await page.locator('[data-blank-trap="1"]').fill("测试解析二");
  await page.locator("#admin-save").click();
  await page
    .waitForFunction(
      () => (document.getElementById("admin-sentence")?.value ?? "x") === "",
      { timeout: 5000 }
    )
    .catch(() => {});
  const savedSentence = await page.evaluate(async () => {
    const res = await fetch("/api/questions");
    const data = await res.json();
    const found = (data.questions ?? []).filter((item) =>
      String(item.originalSentence ?? "").includes("Bracket")
    );
    return found.length > 0 ? found[found.length - 1].originalSentence : null;
  });
  check(
    "全角下划线保存后规范化为标准占位符",
    typeof savedSentence === "string"
      && !savedSentence.includes("＿")
      && (savedSentence.match(/______/g) ?? []).length === 2,
    savedSentence
  );

  // AI 页签
  await page.locator('[data-admin-tab="ai"]').click();
  check("切到 AI 页签后面板可见", await page.locator("#admin-ai-root").isVisible());
  check("AI 页签有「复制提示词」按钮", (await page.locator("#admin-ai-copy").count()) === 1);
  check("AI 页签显示可用标签数", (await page.locator("[data-tag-count]").count()) === 1);

  // 复制提示词（回归：曾因 admin-ai.js 未被任何 script 加载，整个 AI 面板静默失效）
  check(
    "「复制提示词」初始文案正确",
    (await page.locator("#admin-ai-copy").innerText()).trim() === "复制提示词"
  );
  await page.locator("#admin-ai-copy").click();
  await page.waitForTimeout(400);
  check(
    "点击「复制提示词」后按钮变为已复制态",
    (await page.locator("#admin-ai-copy").innerText()).includes("已复制"),
    await page.locator("#admin-ai-copy").innerText()
  );
  const clipboardText = await page
    .evaluate(() => navigator.clipboard.readText().catch(() => ""))
    .catch(() => "");
  check(
    "剪贴板包含完整提示词（含标签规则与输出格式）",
    clipboardText.length > 500
      && clipboardText.includes("高考英语")
      && clipboardText.includes("trapAnalysis"),
    `剪贴板长度 ${clipboardText.length}`
  );
  // 「手动复制」降级入口存在（clipboard 不可用时的兜底）
  check("AI 页签有「手动复制」降级按钮", (await page.locator("#admin-ai-manual-copy").count()) === 1);

  // AI 导入的来源：输入框留空 -> 采用 JSON 里 AI 生成的来源；填写 -> 覆盖
  // 注意这里不写 id：编号由系统生成（AI 无从得知题库现状）
  await page.locator("#ai-source").fill("");
  await page.locator("#admin-ai-json").fill(
    JSON.stringify([
      {
        originalSentence: "AI source check ______ done.",
        blanks: [
          {
            blankIndex: 1,
            answer: ["is"],
            hintWord: null,
            hintType: "无提示词",
            tagIds: ["t_001"],
            trapAnalysis: "AI 来源字段测试。",
          },
        ],
        source: "某某测试中学2026-2027学年高三上学期10月阶段检测试题",
      },
    ])
  );
  await page.locator("#admin-ai-submit").click();
  await page.waitForTimeout(800);
  const aiSourceValue = await page.evaluate(async (sentence) => {
    const res = await fetch("/api/questions");
    const data = await res.json();
    const found = (data.questions ?? []).find((q) => q.originalSentence === sentence);
    return found ? found.source : null;
  }, "AI source check ______ done.");
  check(
    "AI 导入（来源留空）采用 JSON 里 AI 生成的来源",
    aiSourceValue === "某某测试中学2026-2027学年高三上学期10月阶段检测试题",
    aiSourceValue
  );

  // 不带 id 的 JSON 也要能入库，且编号由系统生成 q_ 前缀
  const generatedId = await page.evaluate(async () => {
    const res = await fetch("/api/questions");
    const data = await res.json();
    const found = (data.questions ?? []).find((q) => q.originalSentence === "AI source check ______ done.");
    return found ? found.id : null;
  });
  check(
    "不带 id 的题目由系统生成编号（q_ 前缀）",
    typeof generatedId === "string" && generatedId.startsWith("q_"),
    generatedId
  );

  await page.locator("#ai-source").fill("手动覆盖来源");
  await page.locator("#admin-ai-json").fill(
    JSON.stringify([
      {
        originalSentence: "AI override check ______ done.",
        blanks: [
          {
            blankIndex: 1,
            answer: ["is"],
            hintWord: null,
            hintType: "无提示词",
            tagIds: ["t_001"],
            trapAnalysis: "覆盖来源字段测试。",
          },
        ],
        source: "不应采用的来源",
      },
    ])
  );
  await page.locator("#admin-ai-submit").click();
  await page.waitForTimeout(800);
  const overriddenSource = await page.evaluate(async (sentence) => {
    const res = await fetch("/api/questions");
    const data = await res.json();
    const found = (data.questions ?? []).find((q) => q.originalSentence === sentence);
    return found ? found.source : null;
  }, "AI override check ______ done.");
  check("手填来源覆盖 AI 生成的来源", overriddenSource === "手动覆盖来源", overriddenSource);
  await page.locator("#ai-source").fill(""); // 复位，避免影响后续断言

  // 原句里带中文引号（AI 换掉英文直引号后的形态）必须能入库
  await page.locator("#admin-ai-json").fill(
    JSON.stringify([
      {
        originalSentence: "“New Chinese Style” reflects ______ mindset among Chinese people.",
        blanks: [
          {
            blankIndex: 1,
            answer: ["a"],
            hintWord: null,
            hintType: "无提示词",
            tagIds: ["t_024"],
            trapAnalysis: "冠词 a/an 考查，New 以辅音音素开头。",
          },
        ],
        source: "引号测试卷",
      },
    ])
  );
  await page.locator("#admin-ai-submit").click();
  await page.waitForTimeout(800);
  const quotedOk = await page.evaluate(async () => {
    const res = await fetch("/api/questions");
    const data = await res.json();
    return (data.questions ?? []).some((q) =>
      q.originalSentence.startsWith("“New Chinese Style”")
    );
  });
  check("原句含中文引号的题目能入库", quotedOk, quotedOk);

  // 原句里残留英文直引号 -> JSON 解析失败，且报错要能定位到行与原因
  await page.locator("#admin-ai-json").fill(
    '[\n  {\n    "originalSentence": ""New Chinese Style" reflects ______ mindset.",\n' +
      '    "blanks": [{ "blankIndex": 1, "answer": ["a"], "hintWord": null, "hintType": "无提示词", "tagIds": ["t_024"], "trapAnalysis": "x" }],\n' +
      '    "source": "坏数据"\n  }\n]'
  );
  await page.locator("#admin-ai-submit").click();
  await page.waitForTimeout(500);
  const aiErrorText = await page.locator("#admin-ai-error").innerText();
  check(
    "英文直引号导致解析失败时，提示能定位到行号",
    /第 \d+ 行/.test(aiErrorText),
    aiErrorText.slice(0, 120)
  );
  check(
    "解析失败提示指出英文直引号这个原因",
    aiErrorText.includes("英文直引号"),
    aiErrorText.slice(0, 160)
  );
  await page.locator("#admin-ai-json").fill("");

  // 导入页签
  await page.locator('[data-admin-tab="import"]').click();
  check("导入页签显示导出按钮", await page.locator("#admin-export").isVisible());
  check("导入页签列出当前题库", (await page.locator("[data-admin-question]").count()) >= 1);

  // 标签页签
  await page.locator('[data-admin-tab="tags"]').click();
  check("标签页签有 4 个顶级分类", (await page.locator("[data-tag-group]").count()) === 4);
  check("标签页签列出子标签", (await page.locator("[data-tag]").count()) >= 30);

  /* ---------------- 题库管理：数据操作（flash 提示在刷新后仍可见） ---------------- */
  const clickReload = async (locator) => {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 12000 }).catch(() => {}),
      locator.click(),
    ]);
    await page.waitForTimeout(400);
  };
  const adminFlash = async () => {
    const box = page.locator("#admin-notice");
    if ((await box.count()) === 0) return "";
    const visible = await box.isVisible().catch(() => false);
    return visible ? await box.innerText().catch(() => "") : "";
  };

  // 删除题目（数量用接口取真实值——页面 DOM 可能是旧快照）
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(200);
  const totalBeforeDelete = await page.evaluate(async () => {
    const res = await fetch("/api/questions");
    return (await res.json()).questions.length;
  });
  const deletedId = await page.locator("[data-action='delete-question']").first().getAttribute("data-id");
  await clickReload(page.locator("[data-action='delete-question']").first());
  check("删除题目后 flash 提示「已删除 xxx」", (await adminFlash()).includes(`已删除 ${deletedId}`), await adminFlash());
  const totalAfterDelete = await page.evaluate(async () => {
    const res = await fetch("/api/questions");
    return (await res.json()).questions.length;
  });
  check("删除后题目数减少", totalAfterDelete === totalBeforeDelete - 1, { totalBeforeDelete, totalAfterDelete });

  // 恢复内置示例（reload 后页面回到手动精录页签，需先切回导入页签）
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(200);
  await clickReload(page.locator("#admin-restore-seed"));
  check(
    "恢复示例后 flash 文案与原版一致",
    (await adminFlash()).includes("已恢复内置示例数据，共 3 道题、42 个标签"),
    await adminFlash()
  );
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(200);
  check("恢复后题目数为 3", (await page.locator("[data-admin-question]").count()) === 3);

  // 标签启停（来回切换）
  await page.locator('[data-admin-tab="tags"]').click();
  await page.waitForTimeout(300);
  const toggleBefore = (await page.locator('[data-tag="t_038"] [data-action="toggle-tag"]').innerText()).trim();
  await clickReload(page.locator('[data-tag="t_038"] [data-action="toggle-tag"]'));
  await page.locator('[data-admin-tab="tags"]').click();
  await page.waitForTimeout(300);
  const toggleAfter = (await page.locator('[data-tag="t_038"] [data-action="toggle-tag"]').innerText()).trim();
  check("标签启停后状态文字翻转", toggleBefore !== toggleAfter, { toggleBefore, toggleAfter });
  await clickReload(page.locator('[data-tag="t_038"] [data-action="toggle-tag"]'));
  await page.locator('[data-admin-tab="tags"]').click();
  await page.waitForTimeout(300);
  check(
    "再次点击恢复原状态",
    (await page.locator('[data-tag="t_038"] [data-action="toggle-tag"]').innerText()).trim() === toggleBefore
  );

  // 新增子标签 -> 删除（标签名在 input[data-tag-name] 的 value 中，用属性选择器定位）
  const auditTagName = `审查标签${Date.now().toString(36).slice(-4)}`;
  await page.locator('[data-tag-group]').first().locator('[data-action="add-tag-open"]').click();
  await page.waitForTimeout(300);
  await page.locator("[data-new-tag-name]").fill(auditTagName);
  await clickReload(page.locator('[data-action="add-tag-confirm"]'));
  await page.locator('[data-admin-tab="tags"]').click();
  await page.waitForTimeout(300);
  const auditTagLi = page.locator(`[data-tag]:has(input[data-tag-name][value="${auditTagName}"])`);
  check("新增子标签出现在列表", (await auditTagLi.count()) >= 1);
  await clickReload(auditTagLi.first().locator('[data-action="delete-tag"]'));
  await page.locator('[data-admin-tab="tags"]').click();
  await page.waitForTimeout(300);
  check(
    "删除后标签消失",
    (await page.locator(`[data-tag]:has(input[data-tag-name][value="${auditTagName}"])`).count()) === 0
  );

  // 清空后恢复（结束在种子状态）
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(200);
  await clickReload(page.locator("#admin-clear-all"));
  check("清空后 flash 提示「已清空服务端数据」", (await adminFlash()).includes("已清空服务端数据"), await adminFlash());
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(200);
  check("清空后题目数为 0", (await page.locator("[data-admin-question]").count()) === 0);
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(200);
  await clickReload(page.locator("#admin-restore-seed"));
  await page.locator('[data-admin-tab="import"]').click();
  await page.waitForTimeout(200);
  check("再次恢复后回到种子状态（3 道题）", (await page.locator("[data-admin-question]").count()) === 3);

  /* ---------------- 用户管理页 ---------------- */
  await page.goto(`${BASE}/admin/users`, { waitUntil: "networkidle" });
  check("用户管理页渲染", (await page.locator("#admin-users-root").count()) === 1);
  const managedUser = `audit_u_${Date.now().toString(36)}`;
  await page.locator("#admin-new-username").fill(managedUser);
  await page.locator("#admin-new-password").fill("123456");
  await page.locator("#admin-create").click();
  await page.waitForTimeout(1200);
  check("新建用户后列表出现该用户", (await page.locator(`li[data-username="${managedUser}"]`).count()) === 1);
  check(
    "新建成功提示在刷新后仍可见（flash）",
    await page.locator("#admin-users-notice").isVisible().catch(() => false)
  );
  await page.locator(`li[data-username="${managedUser}"] [data-action="reset-password"]`).click();
  await page.waitForTimeout(200);
  await page.locator(`li[data-username="${managedUser}"] [data-reset-input]`).fill("654321");
  await page.locator(`li[data-username="${managedUser}"] [data-action="reset-confirm"]`).click();
  await page.waitForTimeout(1200);
  const resetLogin = await page.evaluate(async (user) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ username: user, password: "654321" }),
    });
    const data = await res.json().catch(() => ({}));
    return res.status === 200 && typeof data.token === "string";
  }, managedUser);
  check("重置密码生效（新密码可登录）", resetLogin);
  await page.locator(`li[data-username="${managedUser}"] select[data-action="change-role"]`).selectOption("admin");
  await page.waitForTimeout(1200);
  check(
    "改角色后下拉选中 admin",
    (await page.locator(`li[data-username="${managedUser}"] select[data-action="change-role"]`).inputValue()) === "admin"
  );
  await page.locator(`li[data-username="${managedUser}"] [data-action="change-status"]`).click();
  await page.waitForTimeout(1200);
  check(
    "禁用后行内出现「已禁用」",
    (await page.locator(`li[data-username="${managedUser}"]`).innerText()).includes("已禁用")
  );
  await page.locator(`li[data-username="${managedUser}"] [data-action="delete"]`).click();
  await page.waitForTimeout(1200);
  check("删除后列表不再有该用户", (await page.locator(`li[data-username="${managedUser}"]`).count()) === 0);

  /* ---------------- 系统设置页 ---------------- */
  await page.goto(`${BASE}/admin/system`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const systemText = await page.locator("#admin-system-root").innerText();
  check(
    "系统设置页渲染并显示版本",
    (await page.locator("#admin-system-root").count()) === 1 && /[0-9a-f]{7}/.test(systemText),
    systemText.slice(0, 120)
  );
  check("版本区显示 PHP 版本", /PHP/.test(systemText));
  await page.locator('[data-action="check"]').click();
  let systemCheckText = "";
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    systemCheckText = await page.locator("[data-check-result]").innerText().catch(() => "");
    if (systemCheckText.trim() !== "") break;
  }
  check(
    "检查更新返回结果（已是最新 或 发现新提交）",
    /已是最新|发现\s*\d+\s*个新提交|无法连接|失败/.test(systemCheckText),
    systemCheckText.slice(0, 120)
  );
  if (systemCheckText.includes("已是最新")) {
    check("已是最新时不显示「立即更新」按钮", (await page.locator('[data-action="update"]').count()) === 0);
  }

  /* ---------------- 改密成功 / 退出 / 注册 ---------------- */
  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await page.locator("#profile-old-password").fill("123456");
  await page.locator("#profile-new-password").fill("audit654321");
  await page.locator("#profile-submit").click();
  await page
    .waitForFunction(
      () => (document.getElementById("profile-notice")?.textContent ?? "").includes("密码已修改"),
      { timeout: 5000 }
    )
    .catch(() => {});
  check("改密成功提示「密码已修改」", (await page.locator("#profile-notice").innerText()).includes("密码已修改"));
  await page.locator("#profile-old-password").fill("audit654321");
  await page.locator("#profile-new-password").fill("123456");
  await page.locator("#profile-submit").click();
  await page.waitForTimeout(800);
  check("密码改回成功", (await page.locator("#profile-notice").innerText()).includes("密码已修改"));

  await page.locator('[data-action="logout"]').first().click();
  await page.waitForTimeout(1500);
  check("退出后回到首页", new URL(page.url()).pathname === "/", page.url());
  check("退出后导航为游客态", (await page.locator('a[href="/profile"]').count()) === 0);
  check("退出后 token 已清除", (await page.evaluate(() => window.localStorage.getItem("eq_token"))) === null);

  const registeredUser = `audit_reg_${Date.now().toString(36)}`;
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator("#login-switch").click();
  await page.waitForTimeout(200);
  await page.locator("#username").fill(registeredUser);
  await page.locator("#password").fill("123456");
  await page.locator("#login-submit").click();
  await page.waitForTimeout(1500);
  check("注册成功后跳转首页", new URL(page.url()).pathname === "/", page.url());
  check("注册后 token 已保存", (await page.evaluate(() => window.localStorage.getItem("eq_token"))) !== null);

  check("页面无 JS 报错", pageErrors.length === 0, pageErrors.slice(0, 2));

  await browser.close();

  console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("失败清单：");
    failures.forEach((item) => console.log(`  - ${item}`));
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(2);
});
