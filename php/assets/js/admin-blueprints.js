/**
 * 组卷蓝图与虚拟卷成员编辑（题库重构第 2 期）。
 *
 * 两块界面：
 * 1. 「蓝图组卷」页签：蓝图列表 + 规则编辑器 + 试抽预览 + 生成虚拟卷
 * 2. 试卷页签里生成卷的「成员」按钮：编辑卷成员的弹窗（删题 / 调序 / 移篇 / 换题）
 *
 * 交互约定与 admin-papers.js 保持一致：
 * - 结构化操作（生成、重新生成）完成后整页刷新 + flash 提示，
 *   不追求局部更新 —— 刷新后看到的就是库里的真实状态
 * - 编辑器是「本地草稿」模型：输入直接改内存里的 draft，
 *   只有增删条件、切换条件类型、加载别的蓝图时才重渲染 DOM，
 *   避免每敲一个字就丢输入焦点
 */

import { api } from "./api.js";
import { notify, notifyError } from "./feedback.js";
import { openModal, closeModal } from "./modal.js";
import { setFlash } from "./flash.js";
import { iconPlus, iconTinyCross } from "./icons.js";

/**
 * 由 admin.js 调用完成绑定。
 *
 * @param {{boot: object, api: object, getTagDictionary: Function, hintTypes: string[]}} context
 */
export function setupBlueprintPanels(context) {
  const { getTagDictionary, hintTypes } = context;

  const listEl = document.getElementById("blueprint-list");
  const editorEl = document.getElementById("blueprint-editor");
  const itemsDialog = document.getElementById("paper-items-dialog");
  // 非管理员看到的页面没有这些容器，直接不绑定
  if (!listEl || !editorEl) return;

  /* ---------------- 状态 ---------------- */

  /** 蓝图列表（服务端返回） */
  let blueprints = [];
  let loadedForTab = false;

  /**
   * 编辑器状态。
   * id 为 null 表示新建（还没保存过）。
   * draft 是前端形状，提交时再转成后端 rules。
   */
  let editing = null;
  /** 上一次试抽结果（渲染用） */
  let previewResult = null;
  /** 标签选择面板：当前展开的条件下标，-1 表示没展开 */
  let openTagPicker = -1;

  /** 成员编辑状态：{ paperId, paperName, sections: [[qid]], questionMap, dirty } */
  let memberState = null;

  const escape = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  /**
   * 整页刷新，并让刷新后仍停在指定页签。
   *
   * 生成虚拟卷、保存成员这些操作会刷新页面，而刷新后页面默认回到
   * 「手动录入」页签 —— 用户刚在蓝图页点了生成，一刷新就跳走了，
   * 还得自己切回来。带上 hash 让刷新后落在原处。
   */
  function reloadKeepingTab(tab) {
    window.location.hash = tab;
    window.location.reload();
  }

  /** 顶部提示（沿用 admin-notice 容器） */
  function showFlash(message, tone = "success", options = {}) {
    const boxId = "admin-notice";
    return tone === "success"
      ? notify(message, "success", { boxId, ...options })
      : notifyError(message, { boxId, ...options });
  }

  /** 标签 id -> 名称（含父级名字，便于区分同名子标签） */
  function tagName(tagId) {
    const dict = getTagDictionary();
    const tags = dict?.tags ?? [];
    const tag = tags.find((item) => item.id === tagId);
    if (!tag) return tagId;
    const parent = tag.parentId ? tags.find((item) => item.id === tag.parentId) : null;
    return parent ? `${parent.name} / ${tag.name}` : tag.name;
  }

  function allTags() {
    const dict = getTagDictionary();
    return dict?.tags ?? [];
  }

  /* ------------------------------------------------------------------ */
  /* 蓝图列表                                                            */
  /* ------------------------------------------------------------------ */

  async function loadBlueprints() {
    const loading = document.getElementById("blueprint-list-loading");
    try {
      const data = await api.listBlueprints();
      blueprints = data.blueprints ?? [];
      loadedForTab = true;
      renderList();
    } catch (error) {
      showFlash(error, "danger", { retry: () => void loadBlueprints() });
    } finally {
      // 失败也要收掉「加载中…」：否则它一直挂在那儿，
      // 用户以为还在转，而错误提示其实早就出来了
      if (loading) loading.hidden = true;
    }
  }

  function renderList() {
    // 「加载中…」由 loadBlueprints 的 finally 统一收掉（失败时也要收）
    const empty = document.getElementById("blueprint-list-empty");
    if (empty) empty.hidden = blueprints.length > 0;

    listEl.innerHTML = blueprints
      .map((item) => {
        const active = editing && editing.id === item.id;
        const rule = item.rules ?? {};
        const layout = rule.layout ?? {};
        const pieces = [];
        if (layout.sections && layout.perSection) {
          pieces.push(`${layout.sections} 篇 × ${layout.perSection} 题`);
        } else if (rule.count) {
          pieces.push(`${rule.count} 题`);
        }
        const condCount = Array.isArray(rule.conditions) ? rule.conditions.length : 0;
        if (condCount > 0) pieces.push(`${condCount} 个条件`);

        const meta = [];
        if (item.runs > 0) {
          meta.push(`生成过 ${item.runs} 次`);
        }
        if (item.latestPaper) {
          meta.push(`最近：${item.latestPaper.name}`);
        }

        return `
          <li>
            <button
              type="button"
              data-blueprint-select="${escape(item.id)}"
              class="w-full rounded-lg border px-3 py-2.5 text-left transition ${
                active
                  ? "border-primary bg-primary/5"
                  : "border-line bg-surface-alt hover:border-primary/50"
              }"
            >
              <p class="text-sm font-medium text-ink">${escape(item.name)}</p>
              <p class="mt-0.5 text-xs text-faint">${escape(pieces.join(" · ") || "未配置")}</p>
              ${
                meta.length > 0
                  ? `<p class="mt-0.5 text-xs text-muted">${escape(meta.join(" · "))}</p>`
                  : ""
              }
            </button>
          </li>
        `;
      })
      .join("");
  }

  /* ------------------------------------------------------------------ */
  /* 编辑器                                                              */
  /* ------------------------------------------------------------------ */

  /** 从服务端的 rules 反解出前端 draft */
  function draftFromRules(name, description, rules) {
    const layout = rules?.layout ?? {};
    const conditions = Array.isArray(rules?.conditions) ? rules.conditions : [];
    return {
      name: name ?? "",
      description: description ?? "",
      sections: layout.sections || 1,
      perSection: layout.perSection || rules?.count || 10,
      groupBy: layout.groupBy === "tag" ? "tag" : "none",
      // 规范化每个条件：缺字段补默认，保证渲染函数不用到处判空
      conditions: conditions.map((condition) => {
        switch (condition.type) {
          case "tag":
            return {
              type: "tag",
              ids: Array.isArray(condition.ids) ? [...condition.ids] : [],
              match: condition.match === "any" ? "any" : "all",
            };
          case "hintType":
            return {
              type: "hintType",
              values: Array.isArray(condition.values) ? [...condition.values] : [],
            };
          case "blankCount":
            return {
              type: "blankCount",
              min: condition.min ?? "",
              max: condition.max ?? "",
            };
          case "source":
            return {
              type: "source",
              include: Array.isArray(condition.include) ? [...condition.include] : [],
              exclude: Array.isArray(condition.exclude) ? [...condition.exclude] : [],
            };
          default:
            // 未知类型（如第 3 期审核流会用到的 publishStatus）**原样保留**：
            // 这里默默丢掉，等于打开一次编辑器就把用户的规则改小了。
            // 保存时它会原样回到 rules_json，由服务端决定是否合法
            return { ...condition };
        }
      }).filter(Boolean),
      // 库里存的是空数组（用户把所有降级步骤都关了）也要如实还原，
      // 不能退回默认全顺序——那等于悄悄取消用户的设置
      relaxSteps: Array.isArray(rules?.fallback?.relaxSteps)
        ? [...rules.fallback.relaxSteps]
        : ["dropHintType", "dropBlankCount", "dropSource", "dropTag"],
    };
  }

  /** draft -> 提交给服务端的 rules */
  function rulesFromDraft(draft) {
    const conditions = [];
    for (const condition of draft.conditions) {
      if (condition.type === "tag" && condition.ids.length > 0) {
        conditions.push({ type: "tag", ids: condition.ids, match: condition.match });
      } else if (condition.type === "hintType" && condition.values.length > 0) {
        conditions.push({ type: "hintType", values: condition.values });
      } else if (condition.type === "blankCount") {
        const min = condition.min === "" ? null : Number(condition.min);
        const max = condition.max === "" ? null : Number(condition.max);
        if (min !== null || max !== null) {
          conditions.push({ type: "blankCount", min, max });
        }
      } else if (condition.type === "source") {
        if (condition.include.length > 0 || condition.exclude.length > 0) {
          conditions.push({
            type: "source",
            include: condition.include,
            exclude: condition.exclude,
          });
        }
      } else if (condition.type) {
        // 未知类型原样带回（publishStatus 与未来新增的类型）。
        // 服务端若不认识会明确报 400，比静默丢掉用户的规则好
        conditions.push(condition);
      }
    }

    return {
      count: Math.max(1, (Number(draft.sections) || 1) * (Number(draft.perSection) || 1)),
      conditions,
      layout: {
        sections: Number(draft.sections) || 1,
        perSection: Number(draft.perSection) || 1,
        groupBy: draft.groupBy,
      },
      fallback: { relaxSteps: draft.relaxSteps },
    };
  }

  function renderEditor() {
    if (!editing) {
      editorEl.innerHTML = `
        <div class="py-12 text-center text-sm text-faint">
          从左侧选择一份蓝图进行编辑，或点「新建蓝图」。
        </div>
      `;
      return;
    }

    const draft = editing.draft;
    const total = Math.max(1, (Number(draft.sections) || 1) * (Number(draft.perSection) || 1));

    editorEl.innerHTML = `
      <div class="space-y-5">
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-medium text-ink" for="bp-name">蓝图名称</label>
            <input
              id="bp-name"
              type="text"
              value="${escape(draft.name)}"
              data-bp-field="name"
              placeholder="如：虚拟语气专项 20 题"
              class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
            >
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium text-ink" for="bp-desc">描述（可选）</label>
            <input
              id="bp-desc"
              type="text"
              value="${escape(draft.description)}"
              data-bp-field="description"
              placeholder="给卷子加的备注"
              class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
            >
          </div>
        </div>

        <div>
          <div class="mb-1.5 flex items-center justify-between gap-2">
            <p class="text-sm font-medium text-ink">抽题条件</p>
            <button
              type="button"
              data-bp-action="add-condition"
              class="min-h-11 rounded-lg border border-dashed border-line px-3 py-1.5 text-xs text-muted transition hover:border-primary hover:text-primary"
            >${iconPlus("h-4 w-4 shrink-0")} 添加条件</button>
          </div>
          <div class="space-y-2" id="bp-conditions">
            ${
              draft.conditions.length === 0
                ? `<p class="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                     还没有条件：会从整个题库随机抽。至少加一个条件才能抽得有针对性。
                   </p>`
                : draft.conditions.map((condition, index) => conditionRowHtml(condition, index)).join("")
            }
          </div>
        </div>

        <div class="rounded-lg border border-line bg-surface-alt p-4">
          <p class="mb-3 text-sm font-medium text-ink">分篇布局</p>
          <div class="grid gap-3 sm:grid-cols-4">
            <div>
              <label class="mb-1 block text-xs text-muted" for="bp-sections">篇数</label>
              <input
                id="bp-sections"
                type="number"
                min="1"
                max="50"
                value="${escape(draft.sections)}"
                data-bp-field="sections"
                class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
              >
            </div>
            <div>
              <label class="mb-1 block text-xs text-muted" for="bp-per-section">每篇题数</label>
              <input
                id="bp-per-section"
                type="number"
                min="1"
                max="50"
                value="${escape(draft.perSection)}"
                data-bp-field="perSection"
                class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
              >
            </div>
            <div>
              <label class="mb-1 block text-xs text-muted" for="bp-groupby">分组方式</label>
              <select
                id="bp-groupby"
                data-bp-field="groupBy"
                class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
              >
                <option value="none" ${draft.groupBy === "none" ? "selected" : ""}>按抽取顺序</option>
                <option value="tag" ${draft.groupBy === "tag" ? "selected" : ""}>按知识点聚篇</option>
              </select>
            </div>
            <div>
              <p class="mb-1 text-xs text-muted">合计</p>
              <p class="px-1 py-2 text-sm font-medium text-ink" id="bp-total">${total} 题</p>
            </div>
          </div>
          <p class="mt-2 text-xs text-faint">
            「按知识点聚篇」会把同一标签的题尽量放进同一篇，篇内题数仍保持均衡。
          </p>
        </div>

        <div class="rounded-lg border border-line bg-surface-alt p-4">
          <p class="mb-1 text-sm font-medium text-ink">题量不足时逐步放宽</p>
          <p class="mb-3 text-xs text-faint">
            条件太严抽不够时，按下面的顺序依次放弃条件，直到凑够题量；每一步都会如实告诉你放宽了什么。
          </p>
          <div class="flex flex-wrap gap-4">
            ${relaxStepCheckbox("dropHintType", "提示词类型", draft)}
            ${relaxStepCheckbox("dropBlankCount", "空格数", draft)}
            ${relaxStepCheckbox("dropSource", "来源", draft)}
            ${relaxStepCheckbox("dropTag", "标签", draft)}
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <button
            type="button"
            data-bp-action="preview"
            class="min-h-11 rounded-xl border border-line px-5 py-2.5 text-sm text-muted transition hover:bg-surface-alt"
          >试抽预览</button>
          <button
            type="button"
            data-bp-action="save"
            class="min-h-11 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
          >${editing.id ? "保存修改" : "保存蓝图"}</button>
          <button
            type="button"
            data-bp-action="generate"
            class="min-h-11 rounded-xl border border-primary px-6 py-3 text-sm font-medium text-primary transition hover:bg-primary/5"
          >${editing.id ? "生成新卷" : "保存并生成卷"}</button>
          ${
            editing.id
              ? `<button
                   type="button"
                   data-bp-action="delete"
                   class="ml-auto min-h-11 rounded-xl border border-danger/40 px-5 py-2.5 text-sm text-danger transition hover:bg-danger-soft"
                 >删除蓝图</button>`
              : ""
          }
        </div>

        <div id="bp-preview">${previewResult ? previewHtml(previewResult) : ""}</div>
      </div>
    `;
  }

  function relaxStepCheckbox(step, label, draft) {
    const checked = draft.relaxSteps.includes(step);
    return `
      <label class="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" data-bp-relax="${step}" ${checked ? "checked" : ""} class="h-4 w-4">
        ${label}
      </label>
    `;
  }

  function conditionRowHtml(condition, index) {
    const typeOptions = [
      ["tag", "标签"],
      ["hintType", "提示词类型"],
      ["blankCount", "空格数"],
      ["source", "来源（试卷）"],
    ];

    let body = "";
    if (condition.type === "tag") {      const chips =
        condition.ids.length > 0
          ? condition.ids
              .map(
                (id) => `
                  <span class="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-muted">
                    ${escape(tagName(id))}
                    <button type="button" data-bp-action="remove-tag" data-cond="${index}" data-tag="${escape(id)}" class="inline-flex min-h-8 w-8 shrink-0 items-center justify-center rounded text-faint transition hover:bg-danger-soft hover:text-danger">${iconTinyCross("h-4 w-4")}</button>
                  </span>`
              )
              .join("")
          : `<span class="text-xs text-faint">还没选标签</span>`;

      body = `
        <div class="flex flex-wrap items-center gap-2">
          ${chips}
          <button
            type="button"
            data-bp-action="toggle-tag-picker"
            data-cond="${index}"
            class="min-h-8 rounded-lg border border-dashed border-line px-2.5 py-1 text-xs text-muted transition hover:border-primary hover:text-primary"
          >选择标签</button>
          <select data-bp-cond-field="match" data-cond="${index}" class="min-h-8 rounded-lg border border-line bg-surface px-2 py-1 text-xs">
            <option value="all" ${condition.match === "all" ? "selected" : ""}>同时满足</option>
            <option value="any" ${condition.match === "any" ? "selected" : ""}>满足任一</option>
          </select>
        </div>
        ${openTagPicker === index ? tagPickerHtml(index, condition) : ""}
      `;
    } else if (condition.type === "hintType") {
      body = `
        <div class="flex flex-wrap gap-3">
          ${hintTypes
            .map(
              (type) => `
                <label class="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    data-bp-cond-field="hintValue"
                    data-cond="${index}"
                    value="${escape(type)}"
                    ${condition.values.includes(type) ? "checked" : ""}
                    class="h-4 w-4"
                  >
                  ${escape(type)}
                </label>`
            )
            .join("")}
        </div>
      `;
    } else if (condition.type === "blankCount") {
      body = `
        <div class="flex items-center gap-2 text-xs text-muted">
          <span>每个空的空格数从</span>
          <input
            type="number" min="1" max="50"
            value="${escape(condition.min)}"
            data-bp-cond-field="min" data-cond="${index}"
            class="w-20 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
          >
          <span>到</span>
          <input
            type="number" min="1" max="50"
            value="${escape(condition.max)}"
            data-bp-cond-field="max" data-cond="${index}"
            class="w-20 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
          >
          <span>（留空表示不限）</span>
        </div>
      `;
    } else if (condition.type === "source") {
      body = `
        <div class="grid gap-2 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-xs text-faint">只从这些卷抽（每行一个，可留空）</label>
            <textarea
              rows="2"
              data-bp-cond-field="include" data-cond="${index}"
              placeholder="如：某某中学2026届高三10月月考试题"
              class="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary"
            >${escape(condition.include.join("\n"))}</textarea>
          </div>
          <div>
            <label class="mb-1 block text-xs text-faint">排除这些卷（每行一个，可留空）</label>
            <textarea
              rows="2"
              data-bp-cond-field="exclude" data-cond="${index}"
              placeholder="如：不想要的卷名"
              class="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary"
            >${escape(condition.exclude.join("\n"))}</textarea>
          </div>
        </div>
      `;
    } else {
      // 未知类型（publishStatus 等）：没有可视化控件，但要说清楚它会被保留
      body = `
        <p class="text-xs text-faint">
          该条件类型（<code>${escape(condition.type)}</code>）暂不支持可视化编辑，保存时会原样保留。
          切到其它类型会把它替换掉。
        </p>
      `;
    }

    // 类型下拉：已知类型之外，未知类型本身也要成为一个可选项，
    // 否则 select 会显示空白，用户一保存就把它丢了
    const knownTypes = new Set(typeOptions.map(([value]) => value));
    const typeOptionHtml = typeOptions
      .map(
        ([value, label]) =>
          `<option value="${value}" ${condition.type === value ? "selected" : ""}>${label}</option>`
      )
      .join("");
    const unknownTypeOption = knownTypes.has(condition.type)
      ? ""
      : `<option value="${escape(condition.type)}" selected>${escape(condition.type)}（保留）</option>`;

    return `
      <div class="rounded-lg border border-line bg-surface px-3 py-2.5" data-bp-cond-row="${index}">
        <div class="flex items-center justify-between gap-2">
          <select
            data-bp-cond-field="type" data-cond="${index}"
            class="min-h-8 rounded-lg border border-line bg-surface px-2 py-1 text-xs font-medium"
          >
            ${typeOptionHtml}${unknownTypeOption}
          </select>
          <button
            type="button"
            data-bp-action="remove-condition"
            data-cond="${index}"
            class="min-h-8 rounded-lg px-2 py-1 text-xs text-faint transition hover:text-danger"
          >删除条件</button>
        </div>
        <div class="mt-2">${body}</div>
      </div>
    `;
  }

  /** 标签选择面板：按父级分组列出全部标签 */
  function tagPickerHtml(index, condition) {
    const tags = allTags();
    const parents = tags.filter((tag) => tag.parentId === null);
    const groups = parents
      .map((parent) => {
        const children = tags.filter((tag) => tag.parentId === parent.id);
        if (children.length === 0) return "";
        return `
          <div>
            <p class="mb-1 text-xs font-medium text-ink">${escape(parent.name)}</p>
            <div class="flex flex-wrap gap-x-4 gap-y-1.5">
              ${children
                .map(
                  (child) => `
                    <label class="flex items-center gap-1.5 text-xs text-muted">
                      <input
                        type="checkbox"
                        data-bp-cond-field="tag"
                        data-cond="${index}"
                        value="${escape(child.id)}"
                        ${condition.ids.includes(child.id) ? "checked" : ""}
                        class="h-4 w-4"
                      >
                      ${escape(child.name)}
                    </label>`
                )
                .join("")}
            </div>
          </div>
        `;
      })
      .join("");

    return `
      <div class="mt-2 max-h-56 space-y-3 overflow-y-auto rounded-lg border border-line bg-surface-alt p-3">
        ${groups || `<p class="text-xs text-faint">标签库是空的，请先到「知识点标签」页签添加标签。</p>`}
      </div>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* 试抽预览                                                            */
  /* ------------------------------------------------------------------ */

  function previewHtml(result) {
    const sections = result.sections ?? [];
    const notes = result.notes ?? [];
    const target = result.targetTotal ?? 0;
    const drawn = result.drawn ?? 0;

    const head = `
      <div class="rounded-lg border ${
        result.relaxed ? "border-danger/30 bg-danger-soft" : "border-line bg-surface-alt"
      } p-4">
        <p class="text-sm font-medium text-ink">
          本次抽出 ${drawn} 题
          ${drawn < target ? `（目标 ${target} 题，还差 ${target - drawn} 题）` : `（目标 ${target} 题）`}
        </p>
        ${
          result.relaxed
            ? `<ul class="mt-2 space-y-1 text-xs text-danger">
                 ${notes.map((note) => `<li>· 已放宽：${escape(note)}</li>`).join("")}
               </ul>`
            : `<p class="mt-1.5 text-xs text-faint">全部条件都满足，没有放宽。</p>`
        }
        ${
          drawn < target
            ? `<p class="mt-2 text-xs text-muted">
                 题目不够时仍会生成（有多少给多少）。想凑满可以放宽条件，或先录入更多题目。
               </p>`
            : ""
        }
      </div>
    `;

    const sectionHtml = sections
      .map((section) => {
        const items = section.questions ?? [];
        return `
          <div class="rounded-lg border border-line bg-surface p-3">
            <p class="mb-2 text-xs font-medium text-ink">
              第 ${section.sectionNo} 篇 · ${items.length} 题
            </p>
            <ul class="space-y-1.5">
              ${items
                .map((question, index) => {
                  const tagIds = [];
                  for (const blank of question.blanks ?? []) {
                    for (const id of blank.tagIds ?? []) {
                      if (!tagIds.includes(id)) tagIds.push(id);
                    }
                  }
                  const tagsText = tagIds.slice(0, 4).map(tagName).join("、");
                  return `
                    <li class="flex items-start gap-2 text-xs text-muted">
                      <span class="mt-0.5 shrink-0 text-faint">${index + 1}.</span>
                      <span class="min-w-0">
                        <span class="text-ink">${escape(question.originalSentence)}</span>
                        ${
                          tagsText
                            ? `<span class="ml-1 text-faint">[${escape(tagsText)}]</span>`
                            : ""
                        }
                      </span>
                    </li>
                  `;
                })
                .join("")}
            </ul>
          </div>
        `;
      })
      .join("");

    return `<div class="space-y-3">${head}${sectionHtml}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 编辑器事件处理                                                       */
  /* ------------------------------------------------------------------ */

  /** 输入类字段：只更新 draft，不重渲染（保焦点） */
  editorEl.addEventListener("input", (event) => {
    if (!editing) return;
    const draft = editing.draft;

    const field = event.target.dataset?.bpField;
    if (field) {
      if (field === "sections" || field === "perSection") {
        draft[field] = event.target.value;
        // 合计数字要实时更新
        const total = Math.max(1, (Number(draft.sections) || 1) * (Number(draft.perSection) || 1));
        const totalEl = document.getElementById("bp-total");
        if (totalEl) totalEl.textContent = `${total} 题`;
      } else {
        draft[field] = event.target.value;
      }
      return;
    }

    const condField = event.target.dataset?.bpCondField;
    if (condField) {
      const index = Number(event.target.dataset.cond);
      const condition = draft.conditions[index];
      if (!condition) return;

      if (condField === "min" || condField === "max") {
        condition[condField] = event.target.value;
      } else if (condField === "include" || condField === "exclude") {
        condition[condField] = event.target.value
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
      } else if (condField === "hintValue") {
        const checked = [...editorEl.querySelectorAll(`input[data-bp-cond-field="hintValue"][data-cond="${index}"]:checked`)].map(
          (input) => input.value
        );
        condition.values = checked;
      } else if (condField === "tag") {
        const checked = [...editorEl.querySelectorAll(`input[data-bp-cond-field="tag"][data-cond="${index}"]:checked`)].map(
          (input) => input.value
        );
        condition.ids = checked;
        // 勾选标签后 chips 要跟着变，且标签面板保持展开
        openTagPicker = index;
        renderEditor();
      } else if (condField === "match") {
        condition.match = event.target.value === "any" ? "any" : "all";
      }
      return;
    }

    const relax = event.target.dataset?.bpRelax;
    if (relax) {
      const steps = new Set(draft.relaxSteps);
      if (event.target.checked) {
        steps.add(relax);
      } else {
        steps.delete(relax);
      }
      // 保持标准顺序，避免顺序随机化导致行为不可预期
      const order = ["dropHintType", "dropBlankCount", "dropSource", "dropTag"];
      draft.relaxSteps = order.filter((step) => steps.has(step));
    }
  });

  editorEl.addEventListener("change", (event) => {
    if (!editing) return;
    const condField = event.target.dataset?.bpCondField;
    const index = Number(event.target.dataset?.cond);
    if (condField === "type") {
      const draft = editing.draft;
      const newType = event.target.value;
      const defaults = {
        tag: { type: "tag", ids: [], match: "all" },
        hintType: { type: "hintType", values: [] },
        blankCount: { type: "blankCount", min: 1, max: 2 },
        source: { type: "source", include: [], exclude: [] },
      };
      // 切到未知类型（「publishStatus（保留）」）时不能替换成默认 tag ——
      // 那会把这条条件悄悄改掉
      draft.conditions[index] = defaults[newType]
        ? defaults[newType]
        : { ...draft.conditions[index] };
      openTagPicker = -1;
      renderEditor();
      return;
    }
    if (event.target.dataset?.bpField === "groupBy") {
      editing.draft.groupBy = event.target.value === "tag" ? "tag" : "none";
      return;
    }
    if (condField === "match") {
      const condition = editing.draft.conditions[index];
      if (condition) condition.match = event.target.value === "any" ? "any" : "all";
    }
  });

  editorEl.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-bp-action]");
    if (!actionEl || !editing) return;
    const action = actionEl.dataset.bpAction;
    const index = Number(actionEl.dataset.cond);

    switch (action) {
      case "add-condition":
        editing.draft.conditions.push({ type: "tag", ids: [], match: "all" });
        openTagPicker = editing.draft.conditions.length - 1;
        renderEditor();
        break;

      case "remove-condition":
        editing.draft.conditions.splice(index, 1);
        openTagPicker = -1;
        renderEditor();
        break;

      case "toggle-tag-picker":
        openTagPicker = openTagPicker === index ? -1 : index;
        renderEditor();
        break;

      case "remove-tag": {
        const condition = editing.draft.conditions[index];
        const tagId = actionEl.dataset.tag;
        if (condition) {
          condition.ids = condition.ids.filter((id) => id !== tagId);
          renderEditor();
        }
        break;
      }

      case "preview":
        void handlePreview();
        break;

      case "save":
        void handleSave();
        break;

      case "generate":
        void handleGenerate();
        break;

      case "delete":
        void handleDelete();
        break;
    }
  });

  /* ---------------- 蓝图操作 ---------------- */

  async function handlePreview() {
    const rules = rulesFromDraft(editing.draft);
    if (rules.conditions.length === 0) {
      showFlash("至少添加一个条件再试抽，否则等于从整个题库随机抓题", "danger", {
        retryable: false,
      });
      return;
    }
    try {
      // 只传 rules（当前草稿），不传 blueprintId：
      // 编辑器里可能还有未保存的改动，传 id 会让服务端用旧规则预览
      const data = await api.previewBlueprint({ rules });
      previewResult = data.result;
      const box = document.getElementById("bp-preview");
      if (box) box.innerHTML = previewHtml(previewResult);
      // 预览不弹全局提示，信息都在预览区里
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handlePreview() });
    }
  }

  /** 保存（新建或更新）。返回是否成功与蓝图 id */
  async function saveCurrent() {
    const draft = editing.draft;
    const name = (draft.name ?? "").trim();
    if (name === "") {
      showFlash("请填写蓝图名称", "danger", { retryable: false });
      return null;
    }
    const rules = rulesFromDraft(draft);
    const payload = { name, description: (draft.description ?? "").trim(), rules };

    if (editing.id) {
      const data = await api.updateBlueprint(editing.id, payload);
      return data.blueprint;
    }
    const data = await api.createBlueprint(payload);
    return data.blueprint;
  }

  async function handleSave() {
    try {
      const blueprint = await saveCurrent();
      if (!blueprint) return;
      editing.id = blueprint.id;
      showFlash(`蓝图「${blueprint.name}」已保存`);
      await loadBlueprints();
      renderEditor();
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handleSave() });
    }
  }

  async function handleGenerate() {
    // 防重入：抽 100 道题要数秒，期间用户以为卡死会连点；
    // 服务端在 paperId 为空时走新建路径，连点会建出多张同名虚拟卷
    if (generating) return;
    const draft = editing.draft;
    if (rulesFromDraft(draft).conditions.length === 0) {
      showFlash("至少添加一个条件再生成，否则抽取的是随机题", "danger", { retryable: false });
      return;
    }

    generating = true;
    const button = document.querySelector('[data-bp-action="generate"]');
    const originalLabel = button?.textContent ?? "";
    if (button) {
      button.disabled = true;
      button.textContent = "生成中…";
    }
    try {
      // 先保存（新建的蓝图必须先有 id 才能生成；已有蓝图顺带保存最新改动）
      const blueprint = await saveCurrent();
      if (!blueprint) return;
      editing.id = blueprint.id;

      const data = await api.generateBlueprint(blueprint.id, {
        rules: rulesFromDraft(draft),
      });
      const result = data.result ?? {};
      let message = `已生成虚拟卷「${data.paper?.name ?? ""}」，共 ${result.drawn ?? 0} 题`;
      if (result.relaxed) {
        message += `（题量不足，已放宽 ${(result.appliedSteps ?? []).length} 个条件）`;
      }
      if (result.shortfall > 0) {
        message += `，距目标还差 ${result.shortfall} 题`;
      }
      setFlash(message);
      reloadKeepingTab("papers");
    } catch (error) {
      // 抽不到题时后端返回 400 且带 result：把可读的原因展示出来
      showFlash(error, "danger", { retry: () => void handleGenerate() });
    } finally {
      generating = false;
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  }

  async function handleDelete() {
    if (!editing.id) return;
    const name = editing.draft.name;
    if (!window.confirm(`删除蓝图「${name}」？\n已生成的虚拟卷会保留，只是不再关联这张蓝图。`)) {
      return;
    }
    try {
      await api.deleteBlueprint(editing.id);
      editing = null;
      previewResult = null;
      setFlash(`蓝图「${name}」已删除`);
      reloadKeepingTab("blueprints");
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handleDelete() });
    }
  }

  /* ---------------- 列表点击 ---------------- */

  listEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-blueprint-select]");
    if (!button) return;
    const id = button.dataset.blueprintSelect;
    const item = blueprints.find((blueprint) => blueprint.id === id);
    if (!item) return;
    editing = {
      id: item.id,
      draft: draftFromRules(item.name, item.description, item.rules),
    };
    previewResult = null;
    openTagPicker = -1;
    renderList();
    renderEditor();
  });

  const newButton = document.getElementById("blueprint-new");
  if (newButton) {
    newButton.addEventListener("click", () => {
      editing = { id: null, draft: draftFromRules("", "", null) };
      previewResult = null;
      openTagPicker = -1;
      renderList();
      renderEditor();
      document.getElementById("bp-name")?.focus();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 虚拟卷成员编辑                                                       */
  /* ------------------------------------------------------------------ */

  /** 打开成员编辑弹窗 */
  async function openMemberDialog(paperId) {
    if (!itemsDialog) return;
    memberState = { paperId, paperName: "", sections: [], questionMap: {}, dirty: false };
    const body = document.getElementById("paper-items-body");
    const subtitle = document.getElementById("paper-items-subtitle");
    if (subtitle) subtitle.textContent = "加载中…";
    if (body) body.innerHTML = `<p class="py-8 text-center text-sm text-faint">加载中…</p>`;
    openModal(itemsDialog);

    try {
      const data = await api.getPaperItems(paperId);
      memberState.paperName = data.paper?.name ?? "";
      memberState.sections = (data.sections ?? []).map((section) =>
        (section.items ?? []).map((item) => {
          if (item.question) memberState.questionMap[item.questionId] = item.question;
          return item.questionId;
        })
      );
      if (memberState.sections.length === 0) memberState.sections = [[]];
      if (subtitle) subtitle.textContent = memberState.paperName;
      renderMemberBody();
    } catch (error) {
      if (body) {
        body.innerHTML = `<p class="py-8 text-center text-sm text-danger">${escape(
          error.message ?? "加载失败"
        )}</p>`;
      }
    }
  }

  function renderMemberBody() {
    if (!memberState) return;
    const body = document.getElementById("paper-items-body");
    if (!body) return;

    const total = memberState.sections.reduce((sum, ids) => sum + ids.length, 0);

    body.innerHTML = `
      <div class="space-y-4">
        ${memberState.sections
          .map((ids, sectionIndex) => {
            const items = ids
              .map((questionId, orderIndex) => {
                const question = memberState.questionMap[questionId];
                if (!question) return "";
                const tagIds = [];
                for (const blank of question.blanks ?? []) {
                  for (const id of blank.tagIds ?? []) {
                    if (!tagIds.includes(id)) tagIds.push(id);
                  }
                }
                const tagsText = tagIds.slice(0, 4).map(tagName).join("、");
                return `
                  <li class="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                    <span class="mt-0.5 shrink-0 text-xs text-faint">${orderIndex + 1}.</span>
                    <div class="min-w-0 flex-1">
                      <p class="text-xs text-ink">${escape(question.originalSentence)}</p>
                      <p class="mt-0.5 text-xs text-faint">
                        ${escape(question.source)}
                        ${tagsText ? ` · [${escape(tagsText)}]` : ""}
                      </p>
                    </div>
                    <div class="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      <button type="button" data-member-action="up" data-section="${sectionIndex}" data-index="${orderIndex}"
                        class="min-h-8 rounded border border-line px-2 py-0.5 text-xs text-muted transition hover:bg-surface-alt"
                        ${orderIndex === 0 ? "disabled" : ""}>↑</button>
                      <button type="button" data-member-action="down" data-section="${sectionIndex}" data-index="${orderIndex}"
                        class="min-h-8 rounded border border-line px-2 py-0.5 text-xs text-muted transition hover:bg-surface-alt"
                        ${orderIndex === ids.length - 1 ? "disabled" : ""}>↓</button>
                      <button type="button" data-member-action="move-prev" data-section="${sectionIndex}" data-index="${orderIndex}"
                        class="min-h-8 rounded border border-line px-2 py-0.5 text-xs text-muted transition hover:bg-surface-alt"
                        ${sectionIndex === 0 ? "disabled" : ""}>← 上一篇</button>
                      <button type="button" data-member-action="move-next" data-section="${sectionIndex}" data-index="${orderIndex}"
                        class="min-h-8 rounded border border-line px-2 py-0.5 text-xs text-muted transition hover:bg-surface-alt"
                        ${sectionIndex === memberState.sections.length - 1 ? "disabled" : ""}>下一篇 →</button>
                      <button type="button" data-member-action="replace" data-section="${sectionIndex}" data-index="${orderIndex}"
                        class="min-h-8 rounded border border-line px-2 py-0.5 text-xs text-muted transition hover:bg-surface-alt">换一题</button>
                      <button type="button" data-member-action="remove" data-section="${sectionIndex}" data-index="${orderIndex}"
                        class="min-h-8 rounded border border-danger/40 px-2 py-0.5 text-xs text-danger transition hover:bg-danger-soft">移除</button>
                    </div>
                  </li>
                `;
              })
              .join("");

            return `
              <section class="rounded-lg border border-line bg-surface-alt p-3">
                <p class="mb-2 text-xs font-medium text-ink">
                  第 ${sectionIndex + 1} 篇 · ${ids.length} 题
                </p>
                <ul class="space-y-2">
                  ${items || `<li class="py-4 text-center text-xs text-faint">这一篇还没有题</li>`}
                </ul>
              </section>
            `;
          })
          .join("")}
        <button
          type="button"
          data-member-action="add-section"
          class="min-h-11 w-full rounded-lg border border-dashed border-line py-2 text-xs text-muted transition hover:border-primary hover:text-primary"
        >${iconPlus("h-4 w-4 shrink-0")} 增加一篇</button>
      </div>
    `;

    const summary = document.getElementById("paper-items-summary");
    if (summary) {
      summary.textContent = `共 ${total} 题 · ${memberState.sections.length} 篇${
        memberState.dirty ? " · 有未保存的修改" : ""
      }`;
    }
  }

  function memberBodyClick(event) {
    const button = event.target.closest("[data-member-action]");
    if (!button || !memberState) return;
    const action = button.dataset.memberAction;
    const sectionIndex = Number(button.dataset.section);
    const index = Number(button.dataset.index);

    const sections = memberState.sections;

    switch (action) {
      case "up": {
        if (index <= 0) return;
        const ids = sections[sectionIndex];
        [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
        break;
      }
      case "down": {
        const ids = sections[sectionIndex];
        if (index >= ids.length - 1) return;
        [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]];
        break;
      }
      case "move-prev": {
        if (sectionIndex <= 0) return;
        const [id] = sections[sectionIndex].splice(index, 1);
        sections[sectionIndex - 1].push(id);
        break;
      }
      case "move-next": {
        if (sectionIndex >= sections.length - 1) return;
        const [id] = sections[sectionIndex].splice(index, 1);
        sections[sectionIndex + 1].push(id);
        break;
      }
      case "remove": {
        sections[sectionIndex].splice(index, 1);
        break;
      }
      case "replace": {
        void handleReplace(sectionIndex, index);
        return;
      }
      case "add-section": {
        sections.push([]);
        break;
      }
      default:
        return;
    }

    memberState.dirty = true;
    renderMemberBody();
  }

  /** 换一题：服务端挑替身并直接写库，本地同步替换 */
  async function handleReplace(sectionIndex, index) {
    const questionId = memberState.sections[sectionIndex][index];
    try {
      const data = await api.replacePaperItem(memberState.paperId, questionId);
      const item = data.item;
      memberState.sections[sectionIndex][index] = item.questionId;
      memberState.questionMap[item.questionId] = item.question;
      renderMemberBody();
      // 换题是立即落库的，和「有未保存的修改」不是一回事：这里明确提示一下
      showFlash(`已换题：${(item.question?.originalSentence ?? "").slice(0, 24)}…（已保存）`);
    } catch (error) {
      showFlash(error, "danger", { retry: () => void handleReplace(sectionIndex, index) });
    }
  }

  async function saveMemberChanges() {
    if (!memberState) return;
    // 空篇前端也保留：允许老师先占好篇结构
    const sections = memberState.sections.map((ids) => [...ids]);
    try {
      await api.savePaperItems(memberState.paperId, sections);
      setFlash(`「${memberState.paperName}」的成员已保存`);
      reloadKeepingTab("papers");
    } catch (error) {
      showFlash(error, "danger", { retry: () => void saveMemberChanges() });
    }
  }

  if (itemsDialog) {
    const body = document.getElementById("paper-items-body");
    if (body) body.addEventListener("click", memberBodyClick);

    itemsDialog.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset?.action;
      if (action === "close-paper-items") {
        if (memberState?.dirty && !window.confirm("还有未保存的成员调整，确定关闭吗？")) {
          return;
        }
        closeModal(itemsDialog);
        memberState = null;
      } else if (action === "save-paper-items") {
        void saveMemberChanges();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 试卷页签里的生成卷操作（事件委托到 document，由 PHP 渲染的按钮触发）      */
  /* ------------------------------------------------------------------ */

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "edit-paper-items") {
      void openMemberDialog(button.dataset.id);
      return;
    }

    if (action === "regenerate-paper") {
      const id = button.dataset.id;
      const name = button.dataset.name ?? "";
      if (
        !window.confirm(
          `按蓝图重新生成「${name}」？\n\n会重新抽题并整体替换现有成员，手工做过的成员调整会被覆盖。`
        )
      ) {
        return;
      }
      void (async () => {
        try {
          // 卷上记着蓝图；服务端按该蓝图当前规则重抽
          const paper = await api.getPaper(id);
          const blueprintId = paper.paper?.blueprintId;
          if (!blueprintId) {
            showFlash("这张卷已经和蓝图解除关联（蓝图可能被删除了），无法重新生成", "danger", {
              retryable: false,
            });
            return;
          }
          const data = await api.generateBlueprint(blueprintId, { paperId: id });
          const result = data.result ?? {};
          let message = `已重新生成，共 ${result.drawn ?? 0} 题`;
          if (result.relaxed) {
            message += `（已放宽 ${(result.appliedSteps ?? []).length} 个条件）`;
          }
          setFlash(message);
          reloadKeepingTab("papers");
        } catch (error) {
          showFlash(error, "danger");
        }
      })();
    }
  });

  /* ------------------------------------------------------------------ */
  /* 懒加载：首次切到「蓝图组卷」页签时才请求列表                            */
  /* ------------------------------------------------------------------ */

  function ensureLoaded() {
    if (loadedForTab) return;
    void loadBlueprints();
  }

  document.querySelectorAll("[data-admin-tab]").forEach((tabButton) => {
    tabButton.addEventListener("click", () => {
      if (tabButton.dataset.adminTab === "blueprints") {
        ensureLoaded();
      }
    });
  });
}

// 蓝图生成进行中：防止连点建出多张同名虚拟卷
let generating = false;
