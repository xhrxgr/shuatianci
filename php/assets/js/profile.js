/**
 * 个人中心交互。
 *
 * 登录用户：统计与错题排行由 PHP 直出（不需要这里渲染），
 *   本脚本只负责「修改密码」表单。
 * 游客：统计存在 localStorage，本脚本读取并填充，另提供「清空本地记录」。
 *
 * localStorage 的两个 key 与原版一致，老数据能直接接上。
 */

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
    if (!window.confirm("确定清空本机所有游客记录吗？")) return;
    try {
      window.localStorage.removeItem(LOCAL_RECORDS_KEY);
    } catch (error) {
      console.error("[profile] 清空本地记录失败", error);
    }
    renderGuestStats();
    const notice = document.getElementById("profile-notice");
    if (notice) {
      notice.textContent = "已清空本地记录";
      notice.hidden = false;
    }
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

  const show = (box, message) => {
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  };
  const clear = () => {
    if (errorBox) errorBox.hidden = true;
    if (noticeBox) noticeBox.hidden = true;
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
      show(errorBox, error?.message ?? "修改失败");
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}
