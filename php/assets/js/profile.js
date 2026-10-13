/**
 * 个人中心交互。
 *
 * 登录用户：统计与错题排行由 PHP 直出（不需要这里渲染），
 *   本脚本只负责「修改密码」表单。
 * 游客：统计存在 localStorage，本脚本读取并填充，另提供「清空本地记录」。
 *
 * localStorage 的两个 key 与原版一致，老数据能直接接上。
 */

import { notify, notifyError, notifyWarn, clearFeedback } from "./feedback.js";
import { api } from "./api.js";

const LOCAL_RECORDS_KEY = "eq_local_records";

function readLocalRecords() {
  try {
    const raw = window.localStorage.getItem(LOCAL_RECORDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** 游客统计（与原版 getLocalSummary 同口径） */
function localSummary() {
  const records = readLocalRecords();
  const correct = records.filter((record) => record.isCorrect).length;
  return {
    total: records.length,
    correct,
    wrong: records.length - correct,
    accuracy: records.length === 0 ? 0 : Math.round((correct / records.length) * 100),
  };
}

/** 游客：填充统计数字 */
function renderGuestStats() {
  const summary = localSummary();
  const set = (key, value) => {
    const el = document.querySelector(`[data-local-stat="${key}"]`);
    if (el) el.textContent = String(value);
  };
  set("total", summary.total);
  set("correct", summary.correct);
  set("wrong", summary.wrong);
  set("accuracy", `${summary.accuracy}%`);
}

const clearButton = document.getElementById("profile-clear-local");
if (clearButton) {
  renderGuestStats();
  clearButton.addEventListener("click", () => {
    if (!window.confirm("确定清空本设备上所有游客记录吗？")) return;

    // 先确认真的能删：浏览器隐私模式 / 存储被禁用时 removeItem 会抛。
    // 原先 catch 里只 console.error，照样往下走提示「已清空」——
    // 用户以为清掉了，实际一条没少。
    const before = readLocalRecords().length;
    try {
      window.localStorage.removeItem(LOCAL_RECORDS_KEY);
    } catch (error) {
      console.error("[profile] 清空本地记录失败", error);
      notifyError("清空失败：浏览器不允许访问本地存储", {
        boxId: "profile-notice",
        details: [
          "隐私模式或站点数据被禁用时，浏览器会拒绝读写 localStorage",
          "换普通窗口打开，或在浏览器设置里允许本站使用本地存储",
        ],
        retryable: false,
      });
      return;
    }

    const after = readLocalRecords().length;
    if (after !== 0) {
      // 没抛异常但没清掉（例如有别的标签页正在占用）
      notifyWarn(`还有 ${after} 条记录没能清掉（共 ${before} 条）`, {
        boxId: "profile-notice",
        details: ["可能是另一个标签页正在写入记录，关闭其它标签页后再试"],
        retry: () => clearButton.click(),
      });
      renderGuestStats();
      return;
    }

    renderGuestStats();
    notify("已清空本设备上的游客记录", "success", { boxId: "profile-notice" });
  });
}

/* ---------------- 登录用户：修改密码 ---------------- */

const form = document.getElementById("profile-password-form");
if (form) {
  const oldInput = document.getElementById("profile-old-password");
  const newInput = document.getElementById("profile-new-password");
  const submit = document.getElementById("profile-submit");
  const errorBox = document.getElementById("profile-error");
  const noticeBox = document.getElementById("profile-notice");

  // 呈现交给 feedback.js：改密码失败给「重试」（输入框内容不丢，
  // 点一下再提交即可），成功类自动消失
  const show = (box, message) => {
    if (!box) return;
    if (box === errorBox) {
      notifyError(message, {
        boxId: "profile-error",
        retry: () => document.getElementById("profile-password-form")?.requestSubmit(),
      });
      return;
    }
    notify(message, "success", { boxId: "profile-notice" });
  };
  const clear = () => {
    clearFeedback("profile-error");
    clearFeedback("profile-notice");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clear();

    if (submit) submit.disabled = true;
    try {
      await api.changePassword(oldInput?.value ?? "", newInput?.value ?? "");
      show(noticeBox, "密码已修改");
      if (oldInput) oldInput.value = "";
      if (newInput) newInput.value = "";
    } catch (error) {
      show(errorBox, error);
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}
