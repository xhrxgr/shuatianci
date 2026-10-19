/**
 * 按钮文字对齐的回归检查（v3.10.0）
 *
 * 起因：用户报「按钮内文字未垂直/水平居中，整体偏上」。
 *
 * 排查结论（实测 1280px 视口，扫 190 个 <button> + 36 个链接式按钮）：
 *   · <button> 绝大多数本来就居中，preflight 的 padding:0 + font:inherit
 *     让它靠 line-box 排布，**高度被 min-height 撑起来后文字不跟着居中**；
 *   · 按钮式 <a>（class 含 min-h-11 rounded-…）问题更明确：
 *     `min-h-11` 把它撑到 44px，而 <a> 默认是 inline，
 *     **文字根本不会在 44px 里居中** —— 「开始刷题」实测上下间距 0 / 3。
 *
 * 修法是 flex 居中（align-items 对齐到**盒子**），
 * 而不是拿 line-height 打补丁 —— line-height 只能让文字在自己的
 * line-box 里居中，撑高的那截留白它管不了。
 *
 * 这个套件扫全部页面 × 常规/大字体/悬停/禁用四种情况，
 * 断言「文字外接盒在按钮内容盒里居中且不溢出」。
 * 判据是量出来的间距，不是某一行的 class —— 换模板也不会全红。
 */

import { chromium } from "playwright-core";

const BASE = process.argv[2];
const browser = await chromium.launch({ channel: "chrome" });

/**
 * 量每个按钮里文字相对按钮盒子的偏移。
 * ⚠️ 必须取**所有文本节点矩形的外接盒**：按钮里常是「文字 + 计数」
 * 两个节点，只取第一个会把右侧计数漏掉，凭空报出「水平偏心」。
 */
const AUDIT = () => {
  const out = [];
  const pick = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.width > 2400) return null;
    const cs = getComputedStyle(el);
    let tr;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
      if (!rects.length) return null;
      const left = Math.min(...rects.map((x) => x.left));
      const right = Math.max(...rects.map((x) => x.right));
      const top = Math.min(...rects.map((x) => x.top));
      const bottom = Math.max(...rects.map((x) => x.bottom));
      tr = { left, right, top, bottom, width: right - left, height: bottom - top };
    } catch {
      return null;
    }
    const num = (v) => parseFloat(v) || 0;
    const padT = num(cs.paddingTop), padB = num(cs.paddingBottom);
    const padL = num(cs.paddingLeft), padR = num(cs.paddingRight);
    const bT = num(cs.borderTopWidth), bB = num(cs.borderBottomWidth);
    const bL = num(cs.borderLeftWidth), bR = num(cs.borderRightWidth);
    const dy = tr.top - r.top - (bT + padT);
    const dx = tr.left - r.left - (bL + padL);
    const availH = r.height - bT - bB - padT - padB;
    const availW = r.width - bL - bR - padL - padR;
    return {
      text: (el.textContent || "").trim().slice(0, 16) || "[无文字]",
      tag: el.tagName.toLowerCase(),
      w: Math.round(r.width), h: Math.round(r.height),
      dTop: +dy.toFixed(1), dBot: +(availH - tr.height - dy).toFixed(1),
      dLeft: +dx.toFixed(1), dRight: +(availW - tr.width - dx).toFixed(1),
      overflow: tr.height > availH + 1 || tr.width > availW + 1,
    };
  };
  // button + 按钮式 a（带圆角且够高的链接）
  document.querySelectorAll("button").forEach((el) => {
    const r = pick(el);
    if (r) out.push(r);
  });
  document.querySelectorAll("a").forEach((el) => {
    if (!/rounded/.test(el.className)) return;
    if (el.getBoundingClientRect().height < 28) return;
    const r = pick(el);
    if (r) out.push(r);
  });
  return out;
};

const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` → ${detail}`}`);
};

const TOL = 2; // px，允许亚像素与字体渲染误差

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill("123456");
  await page.locator("#login-submit").click();
  await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  return page;
}

const summarize = (rows) => {
  const bad = rows.filter(
    (r) => Math.abs(r.dTop - r.dBot) > TOL || Math.abs(r.dLeft - r.dRight) > TOL || r.overflow
  );
  return {
    total: rows.length,
    bad,
    detail: bad
      .slice(0, 3)
      .map((r) => `「${r.text}」${r.w}×${r.h} 上下 ${r.dTop}/${r.dBot} 左右 ${r.dLeft}/${r.dRight}`)
      .join("；"),
  };
};

/* ---- 1) 常规字号：全部页面 ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await login(ctx);
  let total = 0;
  const bad = [];
  for (const p of ["/", "/papers", "/practice", "/admin", "/users"]) {
    await page.goto(`${BASE}${p}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    if (p === "/admin") {
      for (const tab of ["papers", "questions", "ai", "tags", "system"]) {
        const t = page.locator(`[data-admin-tab="${tab}"]`);
        if ((await t.count()) > 0) { await t.click().catch(() => {}); await page.waitForTimeout(600); }
      }
    }
    const r = summarize(await page.evaluate(AUDIT));
    total += r.total;
    bad.push(...r.bad);
  }
  check(`常规字号下 ${total} 个按钮文字全部居中`, bad.length === 0,
    summarize([]).detail || bad.slice(0, 3).map((x) => `「${x.text}」上下 ${x.dTop}/${x.dBot}`).join("；"));
  await ctx.close();
}

/* ---- 2) 大字体：250% 下不能溢出（固定宽装不下大字号是最容易漏的） ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.fontSize = "40px";
    });
  });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill("123456");
  await page.locator("#login-submit").click();
  await page.waitForFunction(() => !location.pathname.includes("/login"), null, { timeout: 20000 });
  let total = 0;
  const bad = [];
  for (const p of ["/", "/papers", "/practice"]) {
    await page.goto(`${BASE}${p}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const r = summarize(await page.evaluate(AUDIT));
    total += r.total;
    bad.push(...r.bad);
  }
  check(`250% 字号下 ${total} 个按钮仍居中且不溢出`, bad.length === 0,
    bad.slice(0, 3).map((x) => `「${x.text}」${x.w}×${x.h} 左右 ${x.dLeft}/${x.dRight}`).join("；"));
  await ctx.close();
}

/* ---- 3) 悬停 / 禁用 ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await login(ctx);
  await page.goto(`${BASE}/papers`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => x.offsetParent !== null && x.getBoundingClientRect().width > 20);
    if (b) b.setAttribute("data-probe", "1");
  });
  const probe = page.locator("[data-probe]");
  if ((await probe.count()) > 0) { await probe.hover(); await page.waitForTimeout(250); }
  const hov = summarize(await page.evaluate(AUDIT));
  check(`悬停态 ${hov.total} 个按钮仍居中`, hov.bad.length === 0, hov.detail);

  await page.evaluate(() => {
    document.querySelectorAll("button").forEach((el, i) => { if (i % 2 === 0) el.disabled = true; });
  });
  await page.waitForTimeout(250);
  const dis = summarize(await page.evaluate(AUDIT));
  check(`禁用态 ${dis.total} 个按钮仍居中`, dis.bad.length === 0, dis.detail);
  await ctx.close();
}

/* ---- 4) 触摸目标 ≥40px（改了 display 之后要确认没变小） ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const page = await login(ctx);
  await page.goto(`${BASE}/papers`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const tooSmall = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ t: (el.textContent || "").trim().slice(0, 10), h: el.getBoundingClientRect().height }))
      .filter((x) => x.h > 0 && x.h < 40));
  check("手机上可点按钮的触摸目标 ≥40px", tooSmall.length === 0,
    tooSmall.slice(0, 3).map((x) => `「${x.t}」${Math.round(x.h)}px`).join("；"));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
process.exitCode = failed > 0 ? 1 : 0;
