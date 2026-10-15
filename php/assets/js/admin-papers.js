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
    if (!panel.hidden) panel.querySelector("input")?.focus();
  }

  /** 保存试卷的改名 / 日期 / 备注 */
  async function handleSavePaper(item) {
    const id = item.dataset.paperManage;
    const name = item.querySelector("[data-edit-paper-name]").value.trim();
    const date = item.querySelector("[data-edit-paper-date]").value;
    const note = item.querySelector("[data-edit-paper-note]").value.trim();

    if (name === "") {
      showFlash("请填写试卷名", "danger", { retryable: false });
      item.querySelector("[data-edit-paper-name]")?.focus();
      return;
    }

    try {
      await api.updatePaper(id, { name, examDate: date || null, note });
      window.location.reload();
    } catch (error) {
      // 重试沿用同一行元素，用户改过的名字与日期都还在输入框里
      showFlash(error, "danger", { retry: () => void handleSavePaper(item) });
    }
  }

  /** 删除试卷（题目保留，只解除归属） */
  async function handleDeletePaper(id, name) {
    const count = allPapers.find((paper) => paper.id === id)?.questionCount ?? 0;
    const message =
      count > 0
        ? `确定删除试卷「${name}」吗？\n\n该卷下的 ${count} 道题会保留在题库中，只是不再归属任何试卷。`
        : `确定删除试卷「${name}」吗？`;
    if (!window.confirm(message)) return;

    try {
      await api.deletePaper(id);
      setFlash(count > 0 ? `已删除试卷，其下 ${count} 道题已移出该卷` : "已删除试卷");
      window.location.reload();
    } catch (error) {
      // 删除会再弹一次确认框，这是有意的
      showFlash(error, "danger", { retry: () => void handleDeletePaper(id, name) });
    }
  }

  /* ---------------- 题目列表 ---------------- */

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
    const ids = selectedQuestionIds();
    if (ids.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 道题吗？此操作不可撤销。`)) return;

    try {
      for (const id of ids) {
        await api.deleteQuestion(id);
      }
      setFlash(`已删除 ${ids.length} 道题`);
      window.location.reload();
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handleBulkDelete() });
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
    document.getElementById("edit-question-source").value = question.source;
    const paperSelect = document.getElementById("edit-question-paper");
    if (paperSelect) paperSelect.value = question.paperId ?? "__none__";

    showEditErrors([]);
    renderEditBlanks();
    document.getElementById("question-edit-dialog")?.showModal();
  }

  /** 编辑弹窗里的逐空配置 */
  function renderEditBlanks() {
    const container = document.getElementById("edit-question-blanks");
    if (!container) return;

    const count = editBlankCount();
    if (count === 0) {
      container.innerHTML = `<p class="rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger">
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
        <h4 class="mb-3 text-sm font-semibold text-ink">第 ${index + 1} 个空</h4>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted">答案（多个用 / 分隔）</label>
            <input type="text" data-edit-answer="${index}" value="${escape(blank.answer)}" placeholder="written / was written" class="blank-slot w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
            <p class="mt-1 text-xs text-faint">解析为 [${escape(splitAnswers(blank.answer).join(", ") || "空")}]</p>
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted">提示词类型</label>
            <select data-edit-hint="${index}" class="min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary">
              ${hintTypes.map((type) => `<option value="${escape(type)}"${type === blank.hintType ? " selected" : ""}>${escape(type)}</option>`).join("")}
            </select>
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
    document.querySelectorAll("[data-edit-trap]").forEach((area) => {
      const index = Number(area.dataset.editTrap);
      if (editing.blanks[index]) editing.blanks[index].trapAnalysis = area.value;
    });

    return editing.blanks.slice(0, count).map((blank, index) => ({
      blankIndex: index + 1,
      answer: splitAnswers(blank.answer),
      // 原样保留原题的提示词（见 openEditQuestion 里的说明）
      hintWord: blank.hintWord ?? null,
      hintType: blank.hintType,
      tagIds: blank.tagIds,
      trapAnalysis: blank.trapAnalysis.trim(),
    }));
  }

  /** 保存题目修改 */
  async function handleSaveEditQuestion() {
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

    try {
      await api.updateQuestion(editing.id, {
        originalSentence: sentence,
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
      case "delete-paper":
        void handleDeletePaper(button.dataset.id, button.dataset.name);
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
    button.addEventListener("click", () => document.getElementById("question-edit-dialog")?.close());
  });

  applyQuestionFilter();
}