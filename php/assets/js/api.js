/**
 * 后端接口客户端。
 *
 * 两个约定与传统前端库不同，但不影响调用方式：
 * - 这是浏览器直接加载的原生 ES module，不经过打包
 * - 401 时清掉 token 并刷新页面（由服务端重新渲染为未登录态），
 *   效果一样：刷新后 PHP 按未登录状态重新渲染导航与页面
 */

const TOKEN_KEY = "eq_token";

/** 读取本地 token */
export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** 写入 / 清除本地 token */
export function setToken(token) {
  try {
    if (token === null) {
      window.localStorage.removeItem(TOKEN_KEY);
    } else {
      window.localStorage.setItem(TOKEN_KEY, token);
    }
  } catch (error) {
    console.error("[api] 保存 token 失败", error);
  }
}

/** 请求错误 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, options = {}) {
  const { method = "GET", body, skipAuthReload = false } = options;
  const token = getToken();

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("网络连接失败，请检查后端服务是否已启动", 0);
  }

  // 401：登录态失效，清 token 并刷新，让页面按未登录重新渲染。
  // 两个例外：登录/注册接口本身失败（密码错误就是 401）不能刷新——那样会把
  // 页面上的「用户名或密码错误」提示冲掉；而且无 token 时的 401 本来也不是
  // 「登录态失效」，直接交给调用方展示错误即可。
  if (response.status === 401) {
    setToken(null);
    if (!skipAuthReload && token) {
      window.location.reload();
      throw new ApiError("登录已失效，请重新登录", 401);
    }
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }

  return data;
}

export const api = {
  /* 认证 */
  register: (username, password) =>
    request("/auth/register", { method: "POST", body: { username, password }, skipAuthReload: true }),
  login: (username, password) =>
    request("/auth/login", { method: "POST", body: { username, password }, skipAuthReload: true }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),
  changePassword: (oldPassword, newPassword) =>
    request("/auth/change-password", { method: "POST", body: { oldPassword, newPassword } }),

  /* 管理端 */
  listUsers: () => request("/admin/users"),
  listRoles: () => request("/admin/roles"),
  createUser: (username, password, role) =>
    request("/admin/users", { method: "POST", body: { username, password, role } }),
  resetPassword: (id, password) =>
    request(`/admin/users/${id}/reset-password`, { method: "POST", body: { password } }),
  changeRole: (id, role) => request(`/admin/users/${id}/role`, { method: "POST", body: { role } }),
  changeStatus: (id, status) =>
    request(`/admin/users/${id}/status`, { method: "POST", body: { status } }),
  deleteUser: (id) => request(`/admin/users/${id}`, { method: "DELETE" }),
  userRecords: (id) => request(`/admin/users/${id}/records`),

  /* 做题记录 */
  submitRecord: (questionId, isCorrect, wrongCount, answers) =>
    request("/records", {
      method: "POST",
      body: { questionId, isCorrect, wrongCount, answers },
    }),
  recordSummary: () => request("/records/summary"),

  /* 个人进度 */
  getProgress: () => request("/progress"),
  setProgress: (questionId, status) =>
    request(`/progress/${questionId}`, { method: "POST", body: { status } }),

  /* 收藏与标记 */
  getFavorites: () => request("/favorites"),
  toggleFavorite: (source, note) =>
    request("/favorites", { method: "POST", body: { source, note } }),
  getMarks: () => request("/marks"),
  toggleMark: (questionId, label, note) =>
    request("/marks", { method: "POST", body: { questionId, label, note } }),

  /* 题库 */
  getQuestions: () => request("/questions"),
  getTags: () => request("/tags"),
  pushQuestion: (question) => request("/questions", { method: "POST", body: { question } }),
  pushQuestions: (questions, replaceAll = false) =>
    request("/questions", { method: "POST", body: { questions, replaceAll } }),
  updateQuestion: (id, patch) => request(`/questions/${id}`, { method: "PUT", body: patch }),
  deleteQuestion: (id) => request(`/questions/${id}`, { method: "DELETE" }),
  saveTags: (tagDictionary) => request("/tags", { method: "PUT", body: { tagDictionary } }),
  resetBank: () => request("/bank/reset", { method: "POST" }),

  /* 试卷 */
  getPapers: () => request("/papers"),
  getPaper: (id) => request(`/papers/${id}`),
  createPaper: (paper) => request("/papers", { method: "POST", body: paper }),
  updatePaper: (id, patch) => request(`/papers/${id}`, { method: "PUT", body: patch }),
  deletePaper: (id) => request(`/papers/${id}`, { method: "DELETE" }),
  /** 批量把题目移到某张卷；paperId 传 null 表示移出 */
  setQuestionsPaper: (questionIds, paperId) =>
    request("/questions/paper", { method: "PUT", body: { questionIds, paperId } }),

  /* 系统维护 */
  systemVersion: () => request("/system/version"),
  checkUpdate: () => request("/system/check-update", { method: "POST" }),
  startUpdate: () => request("/system/update", { method: "POST" }),
  updateStatus: () => request("/system/update-status"),
};
