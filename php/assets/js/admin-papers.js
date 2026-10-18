/**
 * 试卷管理与题目编辑（题库管理页的「试卷管理」「题库总览」两个页签）。
 *
 * 与 admin.js 的分工：手动录入、数据迁移、知识点标签留在 admin.js；
 * 这里只管试卷与已入库题目的修改，两者互不干扰。
 *
 * 关键约定：
 * - 改完一律「整页刷新」，不追求局部更新。题目列表可能很长，
 *   局部刷新容易让用户怀疑数据没存上；刷新后看到的就是库里真实的。
 *   刷新前的提示统一走 flash.js 的 sessionStorage，否则会被刷新抹掉。
 * - 删除试卷不删题目，只解除归属——一套卷子录重复或归错组时，
 *   不该连带丢掉题目本身。
 */

import { setFlash } from "./flash.js";
import { notify, notifyError } from "./feedback.js";
import { openDialog, closeModal } from "./modal.js";
import { renderState } from "./ui-guard.js";

/**
 * 由 admin.js 调用完成绑定。
 *
 * 上下文从 admin.js 传入而不是各自 import——
 * admin.js 已经 import 了本模块，反向 import 会形成循环依赖，
 * ES 模块能处理但求值顺序会变得难以推理。
 */
export function setupPaperAndQuestionPanels(context) {
  const { boot, api, getTagDictionary, hintTypes } = context;

  /* ---------------- 局部状态 ---------------- */
  let allPapers = boot.papers ?? [];
  let allQuestions = boot.questions ?? [];
  /** 题目列表按试卷筛选的当前值 */
  let questionPaperFilter = "";
  /** 正在编辑的题目 id 与草稿 */
  let editing = { id: null, blanks: [] };

  const tagDictionaryNow = () => getTagDictionary();
  const escape = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  function findQuestion(id) {
    return allQuestions.find((question) => question.id === id) ?? null;
  }

  /**
   * 页面顶部的成功 / 失败提示。
   *
   * 呈现交给 feedback.js：失败时给「重试」入口（都是点一下就能重做的操作），
   * 位置仍用页面原有的 #admin-notice。
   */
  function showFlash(message, tone = "success", options = {}) {
    const boxId = "admin-notice";
    const result =
      tone === "success"
        ? notify(message, "success", { boxId, ...options })
        : notifyError(message, { boxId, ...options });
    // 旧的 #admin-notice 元素仍留在 DOM 里（别的模块会读它的 textContent），
    // 提示条插在它内部，两者共存不冲突
    return result;
  }

  /**
   * 编辑弹窗里的校验错误：逐条列出「哪里错了、怎么改」。
   *
   * 超过 3 条默认折叠，避免弹窗被撑得很长——用户先看第一条改掉即可。
   */
  function showEditErrors(errors, options = {}) {
    const box = document.getElementById("edit-question-errors");
    if (!box) return;
    const list = (errors ?? []).map((item) => String(item));
    box.hidden = list.length === 0;
    if (list.length === 0) {
      box.innerHTML = "";
      return;
    }
    notifyError(list.length === 1 ? list[0] : `有 ${list.length} 处需要修改`, {
      boxId: "edit-question-errors",
      details: list,
      retry: options.retry,
      // 校验错误重试也没用（内容没变），所以不自动给重试按钮
      retryable: false,
      sticky: true,
    });
  }

  /* ---------------- 试卷管理 ---------------- */

  /** 新建试卷 */
  async function handleCreatePaper() {
    const nameInput = document.getElementById("paper-name");
    const dateInput = document.getElementById("paper-date");
    if (!nameInput || !dateInput) return;
    const noteInput = document.getElementById("paper-note");
    const name = nameInput.value.trim();

    if (name === "") {
      showFlash("请填写试卷名", "danger", {
        details: ["试卷名是必填项，同名会自动归到同一张卷"],
        retryable: false,
      });
      document.getElementById("paper-name")?.focus();
      nameInput.focus();
      return;
    }

    try {
      await api.createPaper({
        name,
        examDate: dateInput.value || null,
        note: noteInput.value.trim() || undefined,
      });
      window.location.reload();
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handleCreatePaper() });
    }
  }

  /** 展开 / 收起某张卷的编辑表单 */
  function togglePaperEdit(item) {
    const panel = item.querySelector("[data-paper-edit]");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      panel.querySelector("input")?.focus();
      renderPaperQuestions(item);
      void renderPaperPassage(item);
    }
  }

  /**
   * 渲染「本卷原文」编辑区。
   *
   * 一卷一篇（v3.9.0）：原文只存一份，所有引用它的题共用，
   * 改一次全卷生效 —— 所以编辑入口在**试卷这一层**，不在单题里。
   *
   * 找篇章的方式要**两条路都走**，缺一不可：
   * ① passages.paper_id 指向本卷 —— 在试卷层新建的篇章在这里，
   *    但它刚建好时可能还没有任何题引用（用户是先填原文、再录题）
   * ② 本卷题目实际引用的 passageId —— AI 导入建的篇章在**预览阶段**就建好了，
   *    那时卷还没落地（题目入库时才 ensure_paper_by_name），paper_id 是空的
   *
   * 只走 ① 会漏掉 AI 导入的那些；只走 ② 会漏掉「先填原文后录题」——
   * 那种篇章还没被任何题引用，从题目反查是查不到的。
   * 篇章总量很小（一个学期几十篇），一次 listPassages() 拉全再筛即可。
   */
  async function renderPaperPassage(item) {
    const box = item?.querySelector("[data-paper-passage-body]");
    if (!box) return;
    const paperId = item.dataset.paperManage ?? "";

    // 这一块是**唯一靠接口取数**的面板，没有 SSR 兜底 —— 之前一失败就永远
    // 停在 HTML 里那句「正在读取…」，用户完全不知道该怎么办。
    // 现在三态齐全：加载中 / 空（给新建表单）/ 失败（带重试）。
    renderState(box, "loading", { message: "本卷原文读取中…" });

    // 读回来的是共享数据，改一下会影响所有引用它的题。
    // 界面自己的文案要跟着改，不要把「改一处影响全卷」这件事藏起来。
    let all = [];
    try {
      all = (await api.listPassages())?.passages ?? [];
    } catch (error) {
      renderState(box, "error", {
        message: `原文读取失败：${error?.message ?? "未知错误"}`,
        onRetry: () => void renderPaperPassage(item),
      });
      return;
    }

    const usedIds = new Set(
      allQuestions
        .filter((q) => (q.paperId ?? "") === paperId && q.passageId)
        .map((q) => q.passageId)
    );

    // ① paper_id 指向本卷的 + ② 本卷题目引用的，去重后按 id 排
    const found = all.filter((p) => (p.paperId ?? "") === paperId || usedIds.has(p.id));
    const dangling = [...usedIds].filter((pid) => !all.some((p) => p.id === pid));

    if (found.length === 0) {
      box.innerHTML = newPassageFormHtml(
        dangling.length > 0
          ? `有 ${dangling.length} 道题指向的原文已不存在，可能被手动删过。`
          : ""
      );
      return;
    }

    const warn = dangling.length > 0
      ? `<p class="mb-2 text-[11px] text-danger">
          有 ${dangling.length} 道题指向的原文已不存在，可能被手动删过。
        </p>`
      : "";

    box.innerHTML = warn + found
      .map(
        (p) => `<div class="mb-3">
          <input
            type="text"
            data-paper-passage-title="${escape(p.id)}"
            value="${escape(p.title ?? "")}"
            placeholder="标题（选填，如「A 篇」）"
            class="mb-1.5 min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs outline-none transition focus:border-primary"
          >
          <textarea
            data-paper-passage-text="${escape(p.id)}"
            rows="6"
            placeholder="把这卷阅读未挖空的原文粘在这里。学生做题时可以展开对照。"
            class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-6 outline-none transition focus:border-primary"
          >${escape(p.text ?? "")}</textarea>
          <div class="mt-1.5 flex items-center justify-between gap-2">
            <span class="text-[11px] text-faint">本篇共 ${p.questionCount ?? 0} 道题引用（保存后即时生效）</span>
            <button
              type="button"
              data-action="delete-paper-passage"
              data-id="${escape(p.id)}"
              class="min-h-11 rounded-lg border border-danger/40 px-2.5 py-1 text-[11px] text-danger transition hover:bg-danger-soft"
            >删除本篇原文</button>
          </div>
        </div>`
      )
      .join("");
  }

  /**
   * 「本卷还没有原文」时显示的表单。
   *
   * 一卷一篇（v3.9.0）：所以是直接展开的表单，不是「先点添加再填」——
   * 这卷本来就该有原文，没有才是异常。
   */
  function newPassageFormHtml(note) {
    return `<div>
      <p class="mb-1.5 text-[11px] text-faint">${note || "这卷还没有原文。填一次，这卷所有题都会共用这一份。"}</p>
      <input
        type="text"
        data-paper-passage-new-title
        placeholder="标题（选填，如「A 篇」）"
        class="mb-1.5 min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs outline-none transition focus:border-primary"
      >
      <textarea
        data-paper-passage-new
        rows="6"
        placeholder="把这卷阅读未挖空的原文粘在这里。学生做题时可以展开对照。"
        class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-6 outline-none transition focus:border-primary"
      ></textarea>
    </div>`;
  }

  /**
   * 保存「本卷原文」。
   *
   * 篇章可能还没建（比如这卷的题还没录、或全是指向已删篇章的悬空引用），
   * 这时先 POST 建一篇再关联。已存在的直接 PUT —— 改的是共享那一份，
   * 所有引用它的题立刻看到新原文。
   */
  async function handleSavePaperPassage(item) {
    const paperId = item?.dataset.paperManage ?? "";
    if (!paperId) return;

    const boxes = Array.from(item.querySelectorAll("[data-paper-passage-text]"));
    const newBox = item.querySelector("[data-paper-passage-new]");
    if (boxes.length === 0 && !newBox) return;   // 展开着但没填任何东西

    for (const box of boxes) {
      const passageId = box.dataset.paperPassageText;
      const title = item.querySelector(`[data-paper-passage-title="${CSS.escape(passageId)}"]`)?.value ?? "";
      const text = box.value.trim();
      if (text === "") continue;
      await api.updatePassage(passageId, { title: title.trim(), text });
    }

    if (newBox && newBox.value.trim() !== "") {
      const title = (item.querySelector("[data-paper-passage-new-title]")?.value ?? "").trim();
      const created = await api.createPassage({ paperId, title, text: newBox.value.trim() });
      const passageId = created?.passage?.id ?? null;
      if (passageId) {
        // 一卷一篇（v3.9.0）：这卷里**所有还没关联篇章的题**都指过来。
        //
        // 不只关联「本来就有 passageText 的」—— 那是 v3.8.x 老数据的思路。
        // 现在的正常工作流是「先在试卷层填原文，再录题」，录进来的题本来就没有
        // 任何 passage 字段（手动录入已不再传 passageText），
        // 按老条件关联会一道都关联不上，原文区显示 0 道题引用，等于白填。
        const orphans = allQuestions.filter(
          (q) => (q.paperId ?? "") === paperId && !q.passageId
        );
        for (const question of orphans) {
          await api.updateQuestion(question.id, {
            passageId,
            originalSentence: question.originalSentence,
            blanks: question.blanks,
          });
        }
        // 返回条数让调用方决定提示语；不在这里 reload ——
        // 整条保存链路由 handleSavePaper 统一 reload，重复 reload 会闪两次
        return orphans.length;
      }
    }
    return 0;
  }

  /**
   * 渲染「该卷题目」列表（在试卷管理页就能看内容、跳编辑）。
   *
   * 数据用页面加载时那份 boot.questions，不额外发请求 —— 试卷与题目是一次性
   * 直出的，展开时同步过滤即可。题目很多时也只是内存过滤，没有性能问题。
   */
  function renderPaperQuestions(item) {
    const box = item?.querySelector("[data-paper-questions]");
    if (!box) return;
    const paperId = item.dataset.paperManage ?? "";
    const list = allQuestions.filter((q) => (q.paperId ?? "") === paperId);
    const counter = item.querySelector("[data-paper-q-count]");
    if (counter) counter.textContent = String(list.length);

    if (list.length === 0) {
      box.innerHTML = `<li class="rounded-lg border border-dashed border-line p-3 text-xs text-faint">
        这张卷还没有题目。可以到「题库总览」把题归到这张卷，或用 AI 导入时填这个卷名。
      </li>`;
      return;
    }

    box.innerHTML = list
      .map((question, index) => {
        const summary = String(question.originalSentence ?? "").replace(/\s+/g, " ").trim();
        const short = summary.length > 70 ? summary.slice(0, 70) + "…" : summary;
        return `<li class="rounded-lg border border-line bg-surface p-2.5" data-paper-q="${escape(question.id)}">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="min-w-0 flex-1 text-xs leading-5 text-ink">${index + 1}. ${escape(short)}</p>
          <div class="flex shrink-0 gap-1.5">
            <button type="button" data-action="view-paper-question" data-id="${escape(question.id)}"
              class="min-h-11 shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-alt">查看</button>
            <button type="button" data-action="edit-paper-question" data-id="${escape(question.id)}"
              class="min-h-11 shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-alt">编辑</button>
          </div>
        </div>
        <div class="mt-2 space-y-2 border-t border-line pt-2" data-paper-q-detail hidden></div>
      </li>`;
      })
      .join("");
  }

  /** 「查看」：内联展开这道题的完整内容（原句 / 各空 / 完整原文） */
  function togglePaperQuestionDetail(questionId) {
    const item = document.querySelector(`[data-paper-q="${CSS.escape(questionId)}"]`);
    const detail = item?.querySelector("[data-paper-q-detail]");
    if (!item || !detail) return;

    if (!detail.hidden) {
      detail.hidden = true;
      return;
    }

    const question = findQuestion(questionId);
    if (!question) return;
    const blanks = question.blanks ?? [];
    const tagMap = new Map((boot.tagDictionary?.tags ?? []).map((tag) => [tag.id, tag]));
    const passage = typeof question.passageText === "string" ? question.passageText.trim() : "";

    detail.innerHTML = `
      <p class="whitespace-pre-wrap break-words text-xs leading-5 text-ink">${escape(question.originalSentence ?? "")}</p>
      <div class="space-y-1.5">
        ${blanks
          .map((blank) => {
            const tags = (blank.tagIds ?? [])
              .map((id) => tagMap.get(id)?.name ?? id)
              .filter(Boolean)
              .map((name) => `<span class="rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-muted">${escape(name)}</span>`)
              .join(" ");
            const hint = blank.hintType && blank.hintType !== "无提示词"
              ? `${escape(blank.hintType)}${blank.hintWord ? ` · ${escape(blank.hintWord)}` : ""}`
              : "无提示词";
            return `<div class="rounded border border-line bg-surface-alt p-2 text-[11px] leading-5">
              <p class="font-medium text-ink">空 ${escape(String(blank.blankIndex))}：${escape((blank.answer ?? []).join(" / "))}</p>
              <p class="text-muted">${hint}${tags ? ` · ${tags}` : ""}</p>
              <p class="mt-0.5 text-muted">${escape(blank.trapAnalysis ?? "")}</p>
            </div>`;
          })
          .join("")}
      </div>
      ${passage ? `<div class="rounded border border-line bg-surface-alt p-2">
        <p class="mb-1 text-[11px] font-medium text-faint">完整原文（未挖空）</p>
        <p class="whitespace-pre-wrap break-words text-[11px] leading-5 text-muted">${escape(passage)}</p>
      </div>` : ""}
    `;
    detail.hidden = false;
  }

  // 保存进行中：reload() 不是立即发生的，这个窗口内再点一次会并发两个请求，
  // 后到的覆盖先到的（题目编辑尤其危险：刚改完的答案可能被上一次的旧值盖掉）
  let savingPaper = false;
  let savingEdit = false;

  /** 保存试卷的改名 / 日期 / 备注 */
  async function handleSavePaper(item) {
    if (savingPaper) return;
    const id = item.dataset.paperManage;
    const name = item.querySelector("[data-edit-paper-name]").value.trim();
    const date = item.querySelector("[data-edit-paper-date]").value;
    const note = item.querySelector("[data-edit-paper-note]").value.trim();

    if (name === "") {
      showFlash("请填写试卷名", "danger", { retryable: false });
      item.querySelector("[data-edit-paper-name]")?.focus();
      return;
    }

    savingPaper = true;
    const saveButton = item.querySelector('[data-action="save-paper"]');
    const originalLabel = saveButton?.textContent ?? "";
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = "保存中…";
    }
    try {
      await api.updatePaper(id, { name, examDate: date || null, note });
      // 同一个「保存」按钮也存本卷原文：原文区就在这个面板里，
      // 分成两个按钮会让用户以为「保存试卷名」不管原文
      const linked = await handleSavePaperPassage(item);
      setFlash(
        linked > 0
          ? `已保存，并把本卷 ${linked} 道题关联到了这一篇原文`
          : "试卷与本卷原文已保存"
      );
      window.location.reload();
    } catch (error) {
      // 重试沿用同一行元素，用户改过的名字与日期都还在输入框里
      showFlash(error, "danger", { retry: () => void handleSavePaper(item) });
    } finally {
      savingPaper = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = originalLabel;
      }
    }
  }

  /** 打开「删除试卷」确认弹窗：题目留不留由用户在弹窗里选 */
  function openDeletePaperDialog(paperId, name, count) {
    const dialog = document.getElementById("delete-paper-dialog");
    if (!dialog) return;
    const desc = document.getElementById("delete-paper-desc");
    if (desc) {
      desc.textContent = count > 0
        ? `确定删除试卷「${name}」吗？该卷下有 ${count} 道题。`
        : `确定删除试卷「${name}」吗？`;
    }
    const withBtn = dialog.querySelector('[data-action="delete-paper-with-questions"]');
    // 没有题目的卷就不必给「连题一起删」这个选项
    if (withBtn) {
      withBtn.hidden = count <= 0;
    }
    dialog.dataset.paperId = paperId;
    openDialog(dialog);
  }

  /** 真正执行删除。withQuestions 决定题目是保留还是一起删。 */
  async function confirmDeletePaper(withQuestions) {
    const dialog = document.getElementById("delete-paper-dialog");
    if (!dialog) return;
    const paperId = dialog.dataset.paperId;
    const count = Number(dialog.dataset.questionCount || 0);

    if (withQuestions && count > 0) {
      const ok = window.confirm(
        `最后确认：这会连同「${dialog.dataset.paperName || "该试卷"}」下的 ${count} 道题一起删除，\n\n` +
          "题目的掌握状态、做题记录、标记会一并清掉，无法恢复。\n确定继续吗？"
      );
      if (!ok) return;
    }

    try {
      const result = await api.deletePaper(paperId, { deleteQuestions: withQuestions });
      closeModal(dialog);
      const deleted = Number(result?.deletedQuestions ?? 0);
      if (deleted > 0) {
        setFlash(`已删除试卷及其下 ${deleted} 道题`);
      } else {
        setFlash(count > 0 ? `已删除试卷，其下 ${count} 道题已移出该卷` : "已删除试卷");
      }
      window.location.reload();
    } catch (error) {
      closeModal(dialog);
      showFlash(error, "danger", {
        retry: () => {
          if (withQuestions) void confirmDeletePaper(true);
          else void confirmDeletePaper(false);
        },
      });
    }
  }

  /* ---------------- 题目列表 ---------------- */

  let bulkDeleting = false; // 批量删除进行中：防止连点重复删除

  /** 按试卷筛选题目列表 */
  function applyQuestionFilter() {
    const list = document.getElementById("question-manage-list");
    if (!list) return;

    list.querySelectorAll("[data-admin-question]").forEach((item) => {
      const paperId = item.dataset.paper ?? "";
      let visible = true;
      if (questionPaperFilter === "__none__") {
        visible = paperId === "";
      } else if (questionPaperFilter !== "") {
        visible = paperId === questionPaperFilter;
      }
      // 隐藏时顺手取消勾选，避免批量操作作用到看不见的题
      if (!visible) {
        const box = item.querySelector("[data-question-check]");
        if (box?.checked) box.checked = false;
      }
      item.hidden = !visible;
    });

    renderSelectedCount();
  }

  /** 已勾选题数与批量条显隐 */
  function renderSelectedCount() {
    const checked = [...document.querySelectorAll("[data-question-check]:checked")];
    const count = document.getElementById("question-selected-count");
    const bar = document.getElementById("question-bulk-bar");
    if (count) count.textContent = String(checked.length);
    if (bar) bar.hidden = checked.length === 0;
  }

  function selectedQuestionIds() {
    return [...document.querySelectorAll("[data-question-check]:checked")].map(
      (box) => box.dataset.id
    );
  }

  /** 批量把所选题目移到某张卷 */
  async function handleBulkPaper() {
    const select = document.getElementById("question-bulk-paper");
    const value = select.value;
    if (value === "") {
      showFlash("请先选择要移到哪张卷", "danger", {
        details: ["用上方的下拉框挑目标试卷，再点「应用到已选」"],
        retryable: false,
      });
      return;
    }

    const ids = selectedQuestionIds();
    if (ids.length === 0) return;

    // 移出试卷这一步要确认：它会让题目从卷子上消失，可逆但用户容易没看清下拉当前值
    if (value === "__none__") {
      if (
        !window.confirm(
          `确定把 ${ids.length} 道题移出试卷吗？

题目本身会保留在题库中，只是不再归属任何试卷。`
        )
      ) {
        return;
      }
    }

    try {
      await api.setQuestionsPaper(ids, value === "__none__" ? null : value);
      setFlash(`已将 ${ids.length} 道题移入指定试卷`);
      window.location.reload();
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handleBulkPaper() });
    }
  }

  /** 批量删除所选题目 */
  async function handleBulkDelete() {
    if (bulkDeleting) return;
    const ids = selectedQuestionIds();
    if (ids.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 道题吗？此操作不可撤销。`)) return;

    bulkDeleting = true;
    const button = document.getElementById("question-bulk-delete");
    const originalLabel = button?.textContent ?? "";
    let done = 0;
    try {
      for (const id of ids) {
        // 进度可见：删 20 道要跑 20 个请求，不给进度用户会以为卡死而重复点
        if (button) button.textContent = `删除中 ${done + 1}/${ids.length}`;
        await api.deleteQuestion(id);
        done += 1;
      }
      setFlash(`已删除 ${ids.length} 道题`);
      window.location.reload();
    } catch (error) {
      // 半途失败要说清「已经删了几道」——否则用户以为一道没删。
      // 且**不提供重试**：服务端删除不是幂等的，从头重跑会在已删的那个 id 上 404，
      // 于是永远删不完剩下的（用户被卡死）。改成给一个「刷新看最新状态」的出口。
      const remaining = ids.length - done;
      showFlash(error, "danger", {
        details: [
          `已删除 ${done} 道${remaining > 0 ? `，剩余 ${remaining} 道没有删除` : ""}`,
          "已删除的题目无法恢复；剩下的题请刷新页面后重新勾选再删",
        ],
        retry: () => window.location.reload(),
      });
    } finally {
      bulkDeleting = false;
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  }

  /** 删除单题 */
  async function handleDeleteSingleQuestion(id) {
    const question = findQuestion(id);
    const text = question ? question.originalSentence : id;
    const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    if (!window.confirm(`确定删除这道题吗？\n\n${preview}`)) return;

    try {
      await api.deleteQuestion(id);
      // 整页刷新会抹掉提示，所以先经 flash.js 暂存
      setFlash(`已删除 ${id}`);
      window.location.reload();
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handleDeleteSingleQuestion(id) });
    }
  }

  /* ---------------- 题目编辑 ---------------- */

  /** 答案切分：按 / 或逗号，不能用空格切（多词答案会被拆散） */
  function splitAnswers(text) {
    return String(text)
      .split(/[/,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function editBlankCount() {
    const sentence = document.getElementById("edit-question-sentence")?.value ?? "";
    return (sentence.match(/______/g) ?? []).length;
  }

  /**
   * 打开编辑弹窗。
   *
   * 草稿先整份拷出来，改动期间不动原始数据；
   * 点取消直接丢弃草稿，不会留下半改状态。
   */
  function openEditQuestion(id) {
    const question = findQuestion(id);
    if (!question) return;

    editing = {
      id,
      // hintWord 必须原样带进来：编辑弹窗没有这个输入框，
      // 若不保留就会在保存时被写成 null，而后端对非「无提示词」的空
      // hintWord 一律返回 400 —— 结果是带提示词的题根本改不了。
      blanks: (question.blanks ?? []).map((blank) => ({
        answer: (blank.answer ?? []).join(" / "),
        hintWord: blank.hintWord ?? null,
        hintType: blank.hintType ?? "无提示词",
        tagIds: [...(blank.tagIds ?? [])],
        trapAnalysis: blank.trapAnalysis ?? "",
      })),
    };

    document.getElementById("edit-question-sentence").value = question.originalSentence;
    // 完整原文（passage）**不在这里编辑**：它是整篇共享的，改单题那一份没有意义，
    // 而且保存时也写不进共享的那篇。录入与修改见「AI 导入」页签的「本篇完整原文」区。
    document.getElementById("edit-question-source").value = question.source;
    const paperSelect = document.getElementById("edit-question-paper");
    if (paperSelect) paperSelect.value = question.paperId ?? "__none__";

    showEditErrors([]);
    renderEditBlanks();
    openDialog(document.getElementById("question-edit-dialog"));
  }

  /** 编辑弹窗里的逐空配置 */
  function renderEditBlanks() {
    const container = document.getElementById("edit-question-blanks");
    if (!container) return;

    const count = editBlankCount();
    if (count === 0) {
      container.innerHTML = `<p class="rounded-lg border border-danger/40 bg-danger-soft p-3 text-xs text-danger">
        原句里没有识别到空格（需用 6 个下划线 ______ 表示一个空），无法配置答案与解析。
      </p>`;
      return;
    }

    const active = tagDictionaryNow().tags.filter((tag) => tag.isActive);
    const groups = active
      .filter((tag) => tag.parentId === null)
      .map((parent) => ({
        parent,
        children: active.filter((tag) => tag.parentId === parent.id),
      }))
      .filter((group) => group.children.length > 0);

    // 空格数变多时补空配置，少了则忽略多余的
    while (editing.blanks.length < count) {
      editing.blanks.push({ answer: "", hintType: "无提示词", tagIds: [], trapAnalysis: "" });
    }

    container.innerHTML = editing.blanks
      .slice(0, count)
      .map((blank, index) => {
        const tagGroups = groups
          .map(
            (group) => `<div>
            <p class="mb-1.5 text-xs font-semibold text-muted">${escape(group.parent.name)}</p>
            <div class="flex flex-wrap gap-1.5">${group.children
              .map((tag) => {
                const selected = blank.tagIds.includes(tag.id);
                const cls = selected
                  ? "rounded-full px-2.5 py-1 text-xs transition font-medium text-white"
                  : "rounded-full px-2.5 py-1 text-xs transition border border-line bg-surface text-ink hover:bg-surface-alt";
                const style = selected ? ` style="background-color: ${escape(tag.color)}"` : "";
                return `<button type="button" data-edit-pick-tag="${escape(tag.id)}" data-edit-blank-index="${index}" class="${cls}"${style}>${escape(tag.name)}</button>`;
              })
              .join("")}</div>
          </div>`
          )
          .join("");

        return `<div class="rounded-xl border border-line bg-surface-alt p-4">
        <h4 class="mb-1 text-sm font-semibold text-ink">第 ${index + 1} 个空</h4>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted">答案（多个用 / 分隔）</label>
            <input type="text" data-edit-answer="${index}" value="${escape(blank.answer)}" placeholder="written / was written" class="blank-slot w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
            <p class="mt-1.5 text-xs text-faint">解析为 [${escape(splitAnswers(blank.answer).join(", ") || "空")}]</p>
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted">提示词类型</label>
            <select data-edit-hint="${index}" class="min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
              ${hintTypes.map((type) => `<option value="${escape(type)}"${type === blank.hintType ? " selected" : ""}>${escape(type)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted">提示词</label>
            <input type="text" data-edit-hint-word="${index}" value="${escape(blank.hintWord ?? "")}" placeholder="如 sit"${blank.hintType === "无提示词" ? " disabled" : ""} class="blank-slot w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary disabled:opacity-40">
            <p class="mt-1.5 text-xs text-faint">选了「无提示词」就不需要填。</p>
          </div>
        </div>

        <div class="mt-3">
          <label class="mb-1.5 block text-xs font-medium text-muted">知识点标签</label>
          <div class="max-h-56 space-y-3 overflow-y-auto rounded-lg border border-line bg-surface p-3">${tagGroups}</div>
        </div>

        <div class="mt-3">
          <label class="mb-1.5 block text-xs font-medium text-muted">命题意图与判断依据</label>
          <textarea data-edit-trap="${index}" rows="2" placeholder="空格位于名词与介词之间，是过去分词作后置定语。" class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">${escape(blank.trapAnalysis)}</textarea>
        </div>
      </div>`;
      })
      .join("");
  }

  /** 从弹窗的输入框收集草稿 */
  function collectEditBlanks() {
    const count = editBlankCount();

    document.querySelectorAll("[data-edit-answer]").forEach((input) => {
      const index = Number(input.dataset.editAnswer);
      if (editing.blanks[index]) editing.blanks[index].answer = input.value;
    });
    document.querySelectorAll("[data-edit-hint]").forEach((select) => {
      const index = Number(select.dataset.editHint);
      if (editing.blanks[index]) editing.blanks[index].hintType = select.value;
    });
    document.querySelectorAll("[data-edit-hint-word]").forEach((input) => {
      const index = Number(input.dataset.editHintWord);
      if (editing.blanks[index]) editing.blanks[index].hintWord = input.value;
    });
    document.querySelectorAll("[data-edit-trap]").forEach((area) => {
      const index = Number(area.dataset.editTrap);
      if (editing.blanks[index]) editing.blanks[index].trapAnalysis = area.value;
    });

    return editing.blanks.slice(0, count).map((blank, index) => ({
      blankIndex: index + 1,
      answer: splitAnswers(blank.answer),
      // 提示词与类型联动：选了「无提示词」就归一成 null ——
      // 服务端校验「无提示词时 hintWord 必须为 null」，留着旧词会被拒
      hintWord: blank.hintType === "无提示词" ? null : (blank.hintWord ?? "").trim() || null,
      hintType: blank.hintType,
      tagIds: blank.tagIds,
      trapAnalysis: blank.trapAnalysis.trim(),
    }));
  }

  /** 保存题目修改 */
  async function handleSaveEditQuestion() {
    if (savingEdit) return;
    const sentence = document.getElementById("edit-question-sentence").value.trim();
    const source = document.getElementById("edit-question-source").value.trim();
    const paperValue = document.getElementById("edit-question-paper")?.value ?? "__none__";

    if (sentence === "") {
      showEditErrors(["原句不能为空"]);
      return;
    }

    const blanks = collectEditBlanks();
    const count = editBlankCount();
    if (count === 0) {
      showEditErrors(["原句里必须至少有一个空格（用 6 个下划线 ______ 表示）"]);
      return;
    }
    if (count !== blanks.length) {
      showEditErrors([`原句有 ${count} 个空格，但只配置了 ${blanks.length} 个空`]);
      return;
    }
    const emptyAnswer = blanks.findIndex((blank) => blank.answer.length === 0);
    if (emptyAnswer !== -1) {
      showEditErrors([`第 ${emptyAnswer + 1} 个空的答案不能为空`]);
      return;
    }
    const emptyTrap = blanks.findIndex((blank) => blank.trapAnalysis === "");
    if (emptyTrap !== -1) {
      showEditErrors([`第 ${emptyTrap + 1} 个空的解析不能为空`]);
      return;
    }

    savingEdit = true;
    const saveButton = document.getElementById("edit-question-save");
    const originalLabel = saveButton?.textContent ?? "";
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = "保存中…";
    }
    try {
      await api.updateQuestion(editing.id, {
        originalSentence: sentence,
        // 不传 passageText：原文是整篇共享的，单题编辑不该改它。
        // 传了反而会写进 questions.passage_text（每题那一列），而读取时优先取
        // 共享的那篇 —— 结果是「改了看不到变化」，还留下一份永远不显示的脏数据。
        source,
        // 同时给 source 与 paperId：paperId 是用户的明确选择，优先于按名归卷
        paperId: paperValue === "__none__" ? null : paperValue,
        blanks,
      });
      window.location.reload();
    } catch (error) {
      showEditErrors([error?.message ?? "保存失败"], {
        retry: () => void handleSaveEditQuestion(),
      });
    } finally {
      savingEdit = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = originalLabel;
      }
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  document.getElementById("paper-create")?.addEventListener("click", () => void handleCreatePaper());

  document.getElementById("paper-manage-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const item = button.closest("[data-paper-manage]");

    switch (button.dataset.action) {
      case "edit-paper":
        togglePaperEdit(item);
        break;
      case "cancel-edit-paper":
        const editPanel = item?.querySelector("[data-paper-edit]");
      if (editPanel) editPanel.hidden = true;
        break;
      case "save-paper":
        void handleSavePaper(item);
        break;
      case "delete-paper": {
        // 打开确认弹窗：题目留不留由用户在弹窗里选
        // 题目数从这一行已有的「共 N 道题」文字里取，不额外加 data 属性
        // （加了在页面上就会出现两个数字）
        const rowText = button.closest("[data-paper-manage]")?.innerText ?? "";
        const count = Number((rowText.match(/共 ([0-9,]+) 道题/) ?? ["0", "0"])[1].replace(/,/g, ""));
        const dialog = document.getElementById("delete-paper-dialog");
        if (dialog) {
          dialog.dataset.questionCount = String(count);
          dialog.dataset.paperName = button.dataset.name ?? "";
        }
        openDeletePaperDialog(button.dataset.id, button.dataset.name ?? "", count);
        break;
      }
      // 弹窗里的三个按钮（delete-paper-keep-questions / -with-questions / -cancel）
      // 不在这里处理：dialog 与这个 <ul> 平级，事件冒泡不到，写了也永远不执行。
      // 它们直接绑在 delete-paper-dialog 上，见本函数末尾。
      case "view-paper-question":
        togglePaperQuestionDetail(button.dataset.id);
        break;
      case "delete-paper-passage": {
        // 删篇章不删题：题目还在，只是变回「没有原文」。
        // 这跟删试卷是同一套语义，所以确认文案要说清。
        const ok = window.confirm(
          "删除本卷原文？\n\n这卷的题目会全部保留，只是不再有原文对照。"
        );
        if (!ok) break;
        void (async () => {
          try {
            await api.deletePassage(button.dataset.id);
            setFlash("本卷原文已删除");
            window.location.reload();
          } catch (error) {
            showFlash(error, "danger", {
              retry: () => void api.deletePassage(button.dataset.id).then(() => window.location.reload()),
            });
          }
        })();
        break;
      }
      case "edit-paper-question":
        openEditQuestion(button.dataset.id);
        break;
      default:
        break;
    }
  });

  document.getElementById("question-manage-list")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-question-check]")) {
      renderSelectedCount();
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;

    if (button.dataset.action === "edit-question") {
      openEditQuestion(button.dataset.id);
    } else if (button.dataset.action === "delete-question") {
      void handleDeleteSingleQuestion(button.dataset.id);
    }
  });

  document.getElementById("question-paper-filter")?.addEventListener("change", (event) => {
    questionPaperFilter = event.target.value;
    applyQuestionFilter();
  });

  document
    .getElementById("question-bulk-apply")
    ?.addEventListener("click", () => void handleBulkPaper());
  document
    .getElementById("question-bulk-delete")
    ?.addEventListener("click", () => void handleBulkDelete());

  // 提示词类型改「无提示词」时，把提示词输入框禁用并清空 ——
  // 服务端要求「无提示词时 hintWord 必须为 null」，不禁用的话用户填了也被丢掉，
  // 看起来像「填了没保存」的 bug
  document.getElementById("edit-question-blanks")?.addEventListener("change", (event) => {
    const select = event.target.closest("[data-edit-hint]");
    if (!select) return;
    const index = Number(select.dataset.editHint);
    const word = document.querySelector(`[data-edit-hint-word="${index}"]`);
    if (!word) return;
    const off = select.value === "无提示词";
    word.disabled = off;
    word.value = off ? "" : word.value;
    if (editing.blanks[index]) {
      editing.blanks[index].hintWord = off ? "" : word.value;
    }
  });

  // 逐空配置区：事件委托，因为每次重绘都会换掉 DOM
  document.getElementById("edit-question-blanks")?.addEventListener("click", (event) => {
    const tagButton = event.target.closest("[data-edit-pick-tag]");
    if (!tagButton) return;
    const index = Number(tagButton.dataset.editBlankIndex);
    const tagId = tagButton.dataset.editPickTag;
    const list = editing.blanks[index]?.tagIds ?? [];
    const at = list.indexOf(tagId);
    if (at === -1) {
      list.push(tagId);
    } else {
      list.splice(at, 1);
    }
    renderEditBlanks();
  });

  // 原句变化时空格数可能变了，配置卡要跟着重画
  document.getElementById("edit-question-sentence")?.addEventListener("input", () => {
    if (editBlankCount() !== editing.blanks.length) renderEditBlanks();
  });

  document
    .getElementById("edit-question-save")
    ?.addEventListener("click", () => void handleSaveEditQuestion());
  document.querySelectorAll('[data-action="close-edit-question"]').forEach((button) => {
    button.addEventListener("click", () => closeModal(document.getElementById("question-edit-dialog")));
  });

  /**
   * 删除试卷确认弹窗的三个按钮。
   *
   * 必须**直接绑在 dialog 上**，不能靠 paper-manage-list 的 click 委托：
   * <dialog> 是 body 级元素，与试卷列表那个 <ul> 平级，不在它内部，
   * 点按钮时事件冒泡不到 ul，委托里的三个 case 永远收不到。
   * （v3.8.9 修：此前这三个按钮完全无响应，用户只能刷新页面。）
   *
   * 与 admin-blueprints.js 对 paper-items-dialog 的做法一致 ——
   * 那里同样是 itemsDialog.addEventListener(...)。
   */
  const deleteDialog = document.getElementById("delete-paper-dialog");
  deleteDialog?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset?.action;
    if (action === "delete-paper-keep-questions") {
      void confirmDeletePaper(false);
    } else if (action === "delete-paper-with-questions") {
      void confirmDeletePaper(true);
    } else if (action === "delete-paper-cancel") {
      closeModal(deleteDialog);
    }
  });

  applyQuestionFilter();
}