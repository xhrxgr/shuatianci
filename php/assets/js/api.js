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

/**
 * 请求错误。
 *
 * details 放服务端给的原始原因（如 git 失败时的 stderr）。
 * 主文案是人话，details 是给排查看的——两者都要，
 * 只有前者用户会看到「失败了」却不知道该查什么。
 */
export class ApiError extends Error {
  constructor(message, status, details = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
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
    // detail 是服务端给的原始原因（如 git fetch 失败时的 stderr）。
    // 以前在这里被丢掉了，界面上只剩一句套话，用户无从判断是
    // 凭据问题、网络问题，还是超时——这一条信息要传到界面上。
    const detail =
      data && typeof data === "object" && typeof data.detail === "string"
        ? data.detail
        : "";
    throw new ApiError(message, response.status, detail);
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
  /**
   * 录入前查重。返回每题的判定（new / duplicate / diff）与匹配到的库内题目。
   * 刻意放在服务端：指纹规则必须与入库时用的完全一致。
   */
  checkDuplicates: (questions) =>
    request("/questions/check-duplicates", { method: "POST", body: { questions } }),
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
  /** 批量把题目移到某张卷；paperId 传 null 表示移出。仅原始卷可用 */
  setQuestionsPaper: (questionIds, paperId) =>
    request("/questions/paper", { method: "PUT", body: { questionIds, paperId } }),

  /* 组卷蓝图（第 2 期） */
  listBlueprints: () => request("/blueprints"),
  createBlueprint: (payload) => request("/blueprints", { method: "POST", body: payload }),
  updateBlueprint: (id, patch) => request(`/blueprints/${id}`, { method: "PUT", body: patch }),
  deleteBlueprint: (id) => request(`/blueprints/${id}`, { method: "DELETE" }),
  /** 试抽：传 blueprintId（用已保存的规则）或 rules（未保存的草稿），不落库 */
  previewBlueprint: (payload) => request("/blueprints/preview", { method: "POST", body: payload }),
  /** 生成 / 重新生成虚拟卷。paperId 给了表示重新生成到那张卷 */
  generateBlueprint: (id, payload = {}) =>
    request(`/blueprints/${id}/generate`, { method: "POST", body: payload }),

  /* 虚拟卷成员 */
  getPaperItems: (id) => request(`/papers/${id}/items`),
  savePaperItems: (id, sections) => request(`/papers/${id}/items`, { method: "PUT", body: { sections } }),
  replacePaperItem: (id, questionId) =>
    request(`/papers/${id}/items/replace`, { method: "POST", body: { questionId } }),

  /* 系统维护 */
  systemVersion: () => request("/system/version"),
  checkUpdate: () => request("/system/check-update", { method: "POST" }),
  startUpdate: () => request("/system/update", { method: "POST" }),
  updateStatus: () => request("/system/update-status"),
  getUpdateSource: () => request("/system/update-source"),
  saveUpdateSource: (config) =>
    request("/system/update-source", { method: "PUT", body: config }),
  testUpdateSource: (config) =>
    request("/system/update-source/test", { method: "POST", body: config }),
};
