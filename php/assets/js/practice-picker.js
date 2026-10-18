/**
 * 选题面板（首页 `#pick`）—— 筛选发生在**进入做题页之前**。
 *
 * 为什么把筛选从做题页搬到这里
 * ------------------------------
 * 原来筛选栏在刷题页里（考点 + 提示词类型）。实测手机 420×900 下那块高 1034px，
 * 题目要滚过 58% 屏高才出现，而那一屏几乎全是「介词-时间 0」这种筛不了的标签。
 *
 * 筛选本质是**选题**：先决定练哪些，再去做。现在这个分工是：
 *   · 这里：勾考点 → 跳 `/practice?tags=t_001,t_002`
 *   · 刷题页：只负责把选好的题一道道做完，顶部一条说明 + 一个「换个考点」
 *
 * 标签数据由 home.php 以 `<script type="application/json">` 内联，
 * 与题目列表无关，单独一个模块、不依赖 practice.js 的任何状态。
 */

/** 勾选的考点 id */
let picked = new Set();

const groupsBox = document.getElementById("pick-groups");
const statusEl = document.getElementById("pick-status");
const goBtn = document.getElementById("pick-go");
const resetBtn = document.getElementById("pick-reset");

/** 读内联的标签树；读不到就静默不渲染（页面其余部分照常可用） */
function readTags() {
  const raw = document.getElementById("pick-tags")?.textContent ?? "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function renderGroups() {
  if (!groupsBox) return;
  const tags = readTags().filter((t) => t.isActive);
  if (tags.length === 0) {
    groupsBox.innerHTML = `<p class="rounded-lg bg-surface-alt px-4 py-6 text-center text-xs text-faint">
      还没有知识点标签。先去「题库管理 → 知识点标签」建一些。
    </p>`;
    return;
  }

  const parents = tags.filter((t) => t.parentId === null);
  const html = parents.map((parent) => {
    const children = tags.filter((t) => t.parentId === parent.id);
    if (children.length === 0) return "";
    const chips = children
      .map(
        (t) => `<button
          type="button"
          data-pick-tag="${escapeAttr(t.id)}"
          aria-pressed="false"
          class="min-h-11 shrink-0 whitespace-nowrap rounded-lg border border-line px-3 py-2 text-xs text-ink transition hover:bg-surface-alt"
        >${escapeText(t.name)}</button>`
      )
      .join("");
    return `<div class="flex flex-wrap items-center gap-2">
      <span class="mr-1 flex-shrink-0 text-xs font-semibold text-muted">${escapeText(parent.name)}</span>
      ${chips}
    </div>`;
  })
    .filter(Boolean)
    .join("");

  groupsBox.innerHTML = html || `<p class="text-xs text-faint">没有可用的考点。</p>`;
}

function syncUi() {
  groupsBox?.querySelectorAll("[data-pick-tag]").forEach((btn) => {
    const on = picked.has(btn.dataset.pickTag);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("bg-ink", on);
    btn.classList.toggle("text-surface", on);
    btn.classList.toggle("border-line", !on);
  });
  if (statusEl) {
    statusEl.textContent =
      picked.size === 0
        ? "未勾选，将刷全部题目"
        : `已选 ${picked.size} 个考点`;
  }
}

groupsBox?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-pick-tag]");
  if (!btn) return;
  const id = btn.dataset.pickTag;
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  syncUi();
});

resetBtn?.addEventListener("click", () => {
  picked.clear();
  syncUi();
});

goBtn?.addEventListener("click", () => {
  const url = picked.size === 0 ? "/practice" : `/practice?tags=${encodeURIComponent([...picked].join(","))}`;
  window.location.href = url;
});

renderGroups();
syncUi();

/* 小工具：这里的文本来自服务端内联的标签名，仍按 HTML 转义处理 */
function escapeText(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}
function escapeAttr(value) {
  return escapeText(value).replace(/`/g, "&#96;");
}