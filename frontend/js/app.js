/* 销售邮件发送工作台 - 前端逻辑（原生 JS，无框架） */
const API = "";
let TOKEN = localStorage.getItem("wb_token");
let USER = JSON.parse(localStorage.getItem("wb_user") || "null");
let SETTINGS = {};
const STATE = {
  view: "home", sub: "todos",
  calYear: new Date().getFullYear(), calMonth: new Date().getMonth(),
  selectedDate: null,
  gen: { exhibition: "", customer_type: "", scene: "", tone: "", custom: "", subject: "", body: "" },
  attachments: [], // [{id,name}]
  lang: "zh", // 邮件语言: zh / bilingual / en
  origMail: { subject: "", body: "" }, // 保存原始中文邮件，用于翻译切换
};

/* ---------- 基础工具 ---------- */
/* 运行模式（由 js/config.js 注入）：
   __MODE = "local"   → 纯前端：数据存浏览器，发送生成 .eml（默认，用于无需服务器的公网静态分享）
   __MODE = "backend" → 后端模式：直连真实后端，可真实发送邮件（用于部署带后端的完整版）
   后端模式下 __BACKEND_URL 为空表示同源，否则填完整 https 地址。 */
async function api(method, path, body) {
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 45000; // 45秒超时（CloudBase免费版冷启动可能较慢）
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (window.__MODE === "backend") {
        const base = window.__BACKEND_URL || "";
        const headers = { "Content-Type": "text/plain; charset=utf-8" };
        if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
        // AbortController 实现超时控制
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
        clearTimeout(timer);
        let data = {};
        try { data = await res.json(); } catch (e) {}
        if (res.status === 401) { logout(); throw new Error("登录已过期，请重新登录"); }
        if (!res.ok) throw new Error("服务器返回 " + res.status + (data && data.error ? "：" + data.error : ""));
        return { ok: true, status: res.status, data };
      }
      return window.__localApi(method, path, body);
    } catch (e) {
      lastErr = e;
      // 只对网络错误重试，不重试业务错误
      const m = (e && e.message) || String(e);
      const isNetworkError = m.indexOf("Failed to fetch") >= 0 || m.indexOf("NetworkError") >= 0 || m.indexOf("网络") >= 0 || m.indexOf("abort") >= 0 || m.indexOf("The operation was aborted") >= 0;
      if (!isNetworkError || attempt >= MAX_RETRIES) break;
      // 重试前等待一下，显示提示
      if (attempt === 0) toast("⏳ 服务器唤醒中，正在重连...");
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const m = (lastErr && lastErr.message) || String(lastErr);
  if (m.indexOf("Failed to fetch") >= 0 || m.indexOf("NetworkError") >= 0 || m.indexOf("网络") >= 0 || m.indexOf("abort") >= 0 || m.indexOf("The operation was aborted") >= 0) {
    throw new Error("⚠️ 连接失败：服务器可能正在启动中（首次访问需等待约30秒）。请稍等几秒后点击「登录」重试。");
  }
  throw lastErr;
}
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }
function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in props) {
    if (k === "class") e.className = props[k];
    else if (k === "html") e.innerHTML = props[k];
    else if (k.startsWith("on") && typeof props[k] === "function") e.addEventListener(k.slice(2), props[k]);
    else e.setAttribute(k, props[k]);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return e;
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
}
function openModal(title, innerHtml, widthCls = "") {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-mask"><div class="modal ${widthCls}">
    <span class="modal-close" onclick="closeModal()">×</span>
    <h3>${title}</h3>${innerHtml}</div></div>`;
  root.querySelector(".modal-mask").addEventListener("click", e => { if (e.target.classList.contains("modal-mask")) closeModal(); });
  return root;
}
function closeModal() { $("#modal-root").innerHTML = ""; }
function esc(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ---------- 认证 ---------- */
// 后台唤醒 CloudBase 冷启动容器：打开登录页时先发一个轻量请求把服务叫醒，
// 这样等用户输入完密码点登录时，服务器通常已经热好了，避免“开机无法登录”。
function warmServer() {
  if (window.__MODE !== "backend") return;
  const base = window.__BACKEND_URL || "";
  const msg = $("#auth-msg");
  if (msg && !msg.textContent) msg.textContent = "⏳ 服务器预热中（首次访问较慢，约10-30秒）...";
  fetch(base + "/api/me", { method: "GET", headers: { "Content-Type": "text/plain; charset=utf-8" } })
    .then(() => { if (msg && msg.textContent.indexOf("预热") >= 0) msg.textContent = ""; })
    .catch(() => {});
}

function showAuth() {
  $("#app").style.display = "none"; $("#auth-screen").style.display = "flex";
  warmServer();
  let tab = "login";
  $all(".auth-tabs span").forEach(s => s.onclick = () => {
    tab = s.dataset.tab;
    $all(".auth-tabs span").forEach(x => x.classList.toggle("active", x === s));
    $("#auth-name").style.display = tab === "register" ? "block" : "none";
    $("#auth-btn").textContent = tab === "login" ? "登 录" : "注 册";
    $("#auth-msg").textContent = "";
  });
  $("#auth-btn").onclick = async () => {
    const username = $("#auth-user").value.trim();
    const password = $("#auth-pass").value;
    const name = $("#auth-name").value.trim();
    $("#auth-msg").textContent = "";
    if (!username || !password) { $("#auth-msg").textContent = "请输入用户名和密码"; return; }
    const path = tab === "login" ? "/api/login" : "/api/register";
    let lastErr;
    // 自动重试：冷启动容器唤醒需要时间，连续重试直到成功或耗尽
    for (let i = 0; i <= 4; i++) {
      try {
        $("#auth-msg").textContent = i === 0 ? "正在连接服务器..." : "⏳ 服务器唤醒中，正在重试(" + i + "/4)...";
        const { ok, data } = await api("POST", path, { username, password, display_name: name });
        if (!ok) { $("#auth-msg").textContent = data.error || "操作失败"; return; }
        TOKEN = data.token; USER = data.user;
        localStorage.setItem("wb_token", TOKEN); localStorage.setItem("wb_user", JSON.stringify(USER));
        enterApp();
        return;
      } catch (e) {
        lastErr = e;
        const m = (e && e.message) || "";
        const isNet = m.indexOf("连接失败") >= 0 || m.indexOf("Failed to fetch") >= 0 || m.indexOf("网络") >= 0 || m.indexOf("abort") >= 0 || m.indexOf("aborted") >= 0;
        if (!isNet || i >= 4) break;
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    console.error("[登录错误]", lastErr);
    $("#auth-msg").textContent = "⚠️ 连接失败: " + ((lastErr && lastErr.message) || "未知错误") + " — 稍候点击「登录」再试一次";
  };
}
function logout() { TOKEN = null; USER = null; localStorage.removeItem("wb_token"); localStorage.removeItem("wb_user"); showAuth(); }
function enterApp() {
  $("#auth-screen").style.display = "none"; $("#app").style.display = "block";
  $("#cur-user").textContent = USER.display_name || USER.username;
  const navAdmin = $("#nav-admin");
  if (navAdmin) navAdmin.style.display = (USER && USER.role === "admin" && window.__MODE === "backend") ? "block" : "none";
  loadSettings().then(() => { bindNav(); render(); refreshBell(); setupGlobalSearch(); });
}
async function loadSettings() {
  try { const r = await api("GET", "/api/settings"); SETTINGS = r.data || {}; } catch (e) {}
}

/* ---------- 导航 ---------- */
function bindNav() {
  $all(".nav-item").forEach(it => it.onclick = () => {
    STATE.view = it.dataset.view; STATE.sub = it.dataset.sub || defaultSub(it.dataset.view);
    $all(".nav-item").forEach(x => x.classList.remove("active"));
    it.classList.add("active");
    it.closest(".nav-group").classList.add("open");
    render();
  });
  $all(".nav-leaf").forEach(lf => lf.onclick = () => {
    STATE.view = lf.dataset.view; STATE.sub = lf.dataset.sub;
    $all(".nav-leaf").forEach(x => x.classList.remove("active")); lf.classList.add("active");
    render();
  });
  $("#logout-btn").onclick = logout;
  // 顶栏用户名 → 点击打开个人设置（修改显示名称/密码）
  const curUser = $("#cur-user");
  if (curUser) {
    curUser.style.cursor = "pointer";
    curUser.title = "点击修改个人设置";
    curUser.onclick = () => openChangeMyPassword();
  }
}
function defaultSub(v) { return { home: "todos", ai: "gen", cust: "list", expo: "mat", set: "base" }[v] || ""; }

/* ---------- 总渲染 ---------- */
function render() {
  // 同步侧栏高亮
  $all(".nav-item").forEach(x => x.classList.toggle("active", x.dataset.view === STATE.view && !x.closest(".nav-group").querySelector(".nav-leaf.active" + (STATE.sub ? `[data-sub="${STATE.sub}"]` : ""))));
  $all(".nav-group").forEach(g => g.classList.toggle("open", g.querySelector(`.nav-item[data-view="${STATE.view}"]`)));
  $all(".nav-leaf").forEach(x => x.classList.toggle("active", x.dataset.view === STATE.view && x.dataset.sub === STATE.sub));
  const c = $("#content");
  flushDraftOnLeave(); // 离开页面/切换菜单前把未保存的邮件草稿落盘
  c.innerHTML = "";
  if (STATE.view === "home") c.appendChild(STATE.sub === "calendar" ? viewCalendar() : viewHome());
  else if (STATE.view === "ai") c.appendChild(STATE.sub === "gen" ? viewGen() : STATE.sub === "tpl" ? viewTemplates() : viewLogs());
  else if (STATE.view === "cust") c.appendChild(STATE.sub === "list" ? viewCustomers() : viewTags());
  else if (STATE.view === "expo") c.appendChild(STATE.sub === "manage" ? viewExposManage() : viewExpo());
  else if (STATE.view === "set") c.appendChild(viewSettings());
  else if (STATE.view === "admin") c.appendChild(viewAdmin());
}

/* ================= 首页工作台 ================= */
function viewHome() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "首页工作台"));
  wrap.appendChild(el("div", { class: "section-sub" }, "待办事项提醒 · 悬浮日历可把待办绑定到具体日期"));
  const grid = el("div", { class: "grid2" });
  grid.appendChild(card("📋 今日待办", todoPanel()));
  grid.appendChild(card("📅 日历 / 绑定待办", calendarPanel(false)));
  wrap.appendChild(grid);
  return wrap;
}

/* 客户状态配置 */
const CUSTOMER_STATUS = {
  "成交客户": { color: "#dc2626", bg: "#fef2f2", label: "成交" },
  "高度意向": { color: "#f59e0b", bg: "#fffbeb", label: "高意向" },
  "意向客户": { color: "#3b82f6", bg: "#eff6ff", label: "意向" },
  "潜在客户": { color: "#6b7280", bg: "#f9fafb", label: "潜在" },
};
const STATUS_OPTIONS = Object.keys(CUSTOMER_STATUS);

/* 客户跟踪面板：同步外壳 + 异步填充，避免把 Promise 塞进 appendChild 导致整页崩溃 */
function customerTrackingPanel() {
  const cardEl = el("div", { class: "card" });
  cardEl.appendChild(el("h3", {}, "👥 客户跟踪情况"));
  const body = el("div");
  body.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8">加载中…</div>';
  cardEl.appendChild(body);
  // 异步填充
  (async () => {
    try {
      const r = await api("GET", "/api/customers/stats");
      const stats = r.data || { total: 0, by_status: [] };
      const total = stats.total || 0;
      body.innerHTML = "";
      if (!total) {
        body.appendChild(el("div", { class: "empty" }, "暂无客户，去「客户管理」添加吧"));
        return;
      }
      const statGrid = el("div", { class: "stat-grid" });
      const statusMap = {};
      (stats.by_status || []).forEach(s => { statusMap[s.s || s.status || "潜在客户"] = s.c || s.count || 0; });
      STATUS_OPTIONS.forEach(s => { if (!(s in statusMap)) statusMap[s] = 0; });
      STATUS_OPTIONS.forEach(s => {
        const cfg = CUSTOMER_STATUS[s];
        const count = statusMap[s] || 0;
        const pct = total > 0 ? Math.round(count / total * 100) : 0;
        const sc = el("div", { class: "stat-card", style: `border-left:4px solid ${cfg.color};background:${cfg.bg};cursor:pointer` });
        sc.appendChild(el("div", { class: "stat-count", style: `color:${cfg.color}` }, String(count)));
        sc.appendChild(el("div", { class: "stat-label" }, s));
        sc.appendChild(el("div", { class: "stat-pct" }, `占比 ${pct}%`));
        sc.onclick = () => { STATE.view = "cust"; STATE.sub = "list"; render(); };
        statGrid.appendChild(sc);
      });
      body.appendChild(statGrid);
      body.appendChild(el("div", { class: "section-sub", style: "margin-top:12px" }, "💡 点击状态卡片可跳转到客户列表，在列表中可编辑每位客户的状态"));
      try {
        const cr = await api("GET", "/api/customers");
        const recent = (cr.data || []).slice(0, 5);
        if (recent.length) {
          body.appendChild(el("div", { class: "section-sub", style: "margin-top:14px" }, "最近添加的客户"));
          const list = el("div", { class: "recent-cust-list" });
          recent.forEach(c => {
            const st = c.status || "潜在客户";
            const cfg = CUSTOMER_STATUS[st] || CUSTOMER_STATUS["潜在客户"];
            const row = el("div", { class: "recent-cust-item" });
            row.appendChild(el("span", { class: "pill", style: `background:${cfg.color};color:#fff;font-size:11px` }, cfg.label));
            row.appendChild(el("span", {}, c.company || "-"));
            row.appendChild(el("span", { class: "muted", style: "font-size:11px;margin-left:auto" }, c.contact || c.email || ""));
            list.appendChild(row);
          });
          body.appendChild(list);
        }
      } catch(e) {}
    } catch(e) {
      body.innerHTML = `<div style="color:#ef4444;padding:10px">加载失败：${e.message}</div>`;
    }
  })();
  return cardEl;
}
function todoPanel() {
  const box = el("div");
  const form = el("div", { class: "card", style: "background:#fafcff" });
  form.appendChild(el("div", { class: "label" }, "新增待办"));
  const title = el("input", { class: "inp", placeholder: "任务标题（如：跟进 XX 工厂参展意向）" });
  const due = el("input", { class: "inp", type: "datetime-local", style: "margin-top:8px" });
  const bind = el("input", { class: "inp", type: "date", style: "margin-top:8px", id: "todo-bind" });
  const pri = el("select", { class: "inp", style: "margin-top:8px" }, [
    el("option", { value: "高" }, "优先级：高"), el("option", { value: "中" }, "优先级：中"), el("option", { value: "低" }, "优先级：低")]);
  const add = el("button", { class: "btn btn-primary", style: "margin-top:10px" }, "＋ 新增待办");
  add.onclick = async () => {
    if (!title.value.trim()) { toast("请填写任务标题"); return; }
    await api("POST", "/api/todos", { title: title.value.trim(), due_time: due.value || null, bind_date: bind.value || null, priority: pri.value });
    render(); refreshBell();
  };
  [title, due, bind, pri, add].forEach(e => form.appendChild(e));
  box.appendChild(form);
  box.appendChild(el("div", { id: "todo-list" }));
  loadTodos(box.querySelector("#todo-list"));
  return box;
}
async function loadTodos(target) {
  const r = await api("GET", "/api/todos");
  const list = r.data || [];
  const today = todayStr();
  // 只显示当天需要处理的待办：
  //   ① bind_date == 今天  ② due_time 是今天  ③ 无日期的  ④ 已逾期但未完成
  // 已完成的不显示。
  const todayList = list.filter(t => {
    if (t.done) return false;
    if (t.bind_date === today) return true;
    if (t.due_time && t.due_time.startsWith(today)) return true;
    if (!t.bind_date && !t.due_time) return true; // 无日期的也显示在工作台
    if (t.due_time) { // 有截止时间且已逾期 → 属于"当天需要补做"
      const d = new Date(t.due_time.replace(" ", "T"));
      return d < new Date();
    }
    return false;
  });
  target.innerHTML = "";
  if (!todayList.length) { target.appendChild(el("div", { class: "empty" }, "🎉 今天没有待办事项，工作轻松！")); return; }
  todayList.forEach(t => {
    const item = el("div", { class: "todo-item" + (t.done ? " done" : "") });
    const chk = el("input", { class: "chk", type: "checkbox" }); chk.checked = !!t.done;
    chk.onchange = async () => { await api("PATCH", "/api/todos/" + t.id, { done: chk.checked ? 1 : 0 }); render(); refreshBell(); };
    const main = el("div", { class: "todo-main" });
    main.appendChild(el("div", { class: "todo-title" }, t.title));
    const meta = [];
    if (t.bind_date) meta.push("📅 " + t.bind_date);
    if (t.due_time) meta.push("⏰ " + t.due_time.replace("T", " "));
    const priCls = t.priority === "高" ? "tag-pri-high" : t.priority === "中" ? "tag-pri-mid" : "tag-pri-low";
    if (t.priority) meta.push(`<span class="${priCls}">${t.priority}优先级</span>`);
    if (t.due_time) {
      const d = new Date(t.due_time.replace(" ", "T")); const now = new Date();
      if (!t.done && d < now) meta.push('<span class="tag-pri-high">已逾期</span>');
      else if (!t.done && (d - now) <= 86400000) meta.push('<span class="tag-pri-mid">即将到期</span>');
    }
    main.appendChild(el("div", { class: "todo-meta", html: meta.join(" ｜ ") }));
    const del = el("button", { class: "btn btn-sm btn-danger" }, "删除");
    del.onclick = async () => { await api("DELETE", "/api/todos/" + t.id); render(); refreshBell(); };
    item.appendChild(chk); item.appendChild(main); item.appendChild(del);
    target.appendChild(item);
  });
}
function calendarPanel(floating) {
  const box = el("div", { class: "cal" });
  const head = el("div", { class: "cal-head" });
  const prev = el("button", { class: "btn btn-sm" }, "‹");
  const next = el("button", { class: "btn btn-sm" }, "›");
  const label = el("span", {}, `${STATE.calYear}年${STATE.calMonth + 1}月`);
  prev.onclick = () => { STATE.calMonth--; if (STATE.calMonth < 0) { STATE.calMonth = 11; STATE.calYear--; } box.replaceWith(calendarPanel(floating)); };
  next.onclick = () => { STATE.calMonth++; if (STATE.calMonth > 11) { STATE.calMonth = 0; STATE.calYear++; } box.replaceWith(calendarPanel(floating)); };
  head.appendChild(prev); head.appendChild(label); head.appendChild(next);
  box.appendChild(head);
  const grid = el("div", { class: "cal-grid" });
  ["日", "一", "二", "三", "四", "五", "六"].forEach(d => grid.appendChild(el("div", { class: "cal-dow" }, d)));
  const first = new Date(STATE.calYear, STATE.calMonth, 1).getDay();
  const days = new Date(STATE.calYear, STATE.calMonth + 1, 0).getDate();
  api("GET", "/api/todos").then(r => {
    const todos = r.data || [];
    const map = {};
    todos.forEach(t => { if (t.bind_date) (map[t.bind_date] = map[t.bind_date] || []).push(t); });
    for (let i = 0; i < first; i++) grid.appendChild(el("div"));
    for (let d = 1; d <= days; d++) {
      const ds = `${STATE.calYear}-${String(STATE.calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const cell = el("div", { class: "cal-cell" + (STATE.selectedDate === ds ? " sel" : "") + (ds === todayStr() ? " today" : "") });
      cell.appendChild(el("span", { class: "num" }, String(d)));
      if (map[ds]) {
        const todoList = el("div", { class: "cal-todos" });
        map[ds].forEach(t => {
          const ti = el("div", { class: "cal-todo" + (t.done ? " done" : "") }, t.title);
          if (!t.done) {
            const priColor = t.priority === "高" ? "#dc2626" : t.priority === "中" ? "#d97706" : "#6b7280";
            ti.style.borderLeft = `3px solid ${priColor}`;
          }
          todoList.appendChild(ti);
        });
        cell.appendChild(todoList);
      }
      cell.onclick = () => {
        STATE.selectedDate = ds;
        // 把新增待办的 bind_date 设为该日
        const bindInput = document.querySelector('#todo-bind');
        if (bindInput) bindInput.value = ds;
        box.replaceWith(calendarPanel(floating));
        toast("已选择 " + ds + "，新增待办将绑定该日");
      };
      grid.appendChild(cell);
    }
  });
  box.appendChild(grid);
  return box;
}
function todayStr() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; }
function viewCalendar() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "悬浮日历"));
  wrap.appendChild(el("div", { class: "section-sub" }, "点击日期可将待办绑定到该日；右下角悬浮按钮可随时唤出日历"));
  wrap.appendChild(calendarPanel(false));
  return wrap;
}
async function refreshBell() {
  const r = await api("GET", "/api/todos"); const list = r.data || [];
  const now = new Date(); let n = 0;
  const urgentTodos = []; // 收集临近/逾期待办
  list.forEach(t => { if (!t.done && t.due_time) { const d = new Date(t.due_time.replace(" ", "T")); if (d < now || (d - now) <= 86400000) { n++; urgentTodos.push(t); } } });
  const b = $("#bell-badge"); if (n > 0) { b.style.display = "inline"; b.textContent = n; } else b.style.display = "none";
  // 点击铃铛 → 弹出详情面板(而不是只跳转)
  $("#bell").onclick = () => {
    if (urgentTodos.length === 0) {
      toast("暂无临近或逾期的待办事项 ✅");
      return;
    }
    // 按时间排序：逾期在前，即将到期在后
    urgentTodos.sort((a, b) => new Date(a.due_time) - new Date(b.due_time));
    const itemsHtml = urgentTodos.map(t => {
      const d = new Date(t.due_time.replace(" ", "T"));
      const isOverdue = d < now;
      const timeStr = t.due_time.replace("T", " ").replace(" ", " ").slice(0, 16);
      const priColor = t.priority === "高" ? "#dc2626" : t.priority === "中" ? "#d97706" : "#6b7280";
      const priBg = t.priority === "高" ? "#fef2f2" : t.priority === "中" ? "#fffbeb" : "#f9fafb";
      const statusTag = isOverdue
        ? '<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#fee2e2;color:#dc2626;font-weight:600">⚠️ 已逾期</span>'
        : '<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#dbeafe;color:#2563eb;font-weight:600">🔔 即将到期</span>';
      const bindInfo = t.bind_date ? `<span style="color:#6b7280;font-size:11px">📅 绑定日期：${t.bind_date}</span>` : "";
      return `
        <div style="padding:12px;margin-bottom:8px;border-radius:8px;border-left:3px solid ${priColor};background:${priBg}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-weight:600;font-size:14px">${esc(t.title)}</span>
            ${statusTag}
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#4b5563">
            <span>⏰ ${timeStr}</span>
            <span style="color:${priColor};font-weight:600">${t.priority}优先级</span>
            ${bindInfo}
          </div>
        </div>`;
    }).join("");
    openModal(`🔔 待办提醒（${urgentTodos.length} 条）`, `
      <div style="max-height:400px;overflow-y:auto">
        ${itemsHtml}
        ${urgentTodos.length > 5 ? `<div class="muted" style="text-align:center;font-size:11px;margin-top:8px">仅显示最近 ${Math.min(urgentTodos.length, 10)} 条，完整列表请前往「首页工作台」查看</div>` : ''}
      </div>
      <div style="margin-top:14px;text-align:center">
        <button class="btn btn-primary btn-block" id="bell-go-todo" style="max-width:200px;margin:0 auto">📋 前往待办清单处理</button>
      </div>
    `, "modal-wide");
    $("#bell-go-todo").onclick = () => { closeModal(); STATE.view = "home"; STATE.sub = "todos"; render(); };
  };
}

/* ================= AI 邮件模板中心 ================= */
let EXHIBITIONS = [];
let CUST_TYPES_CACHE = []; // 动态从 /api/tags 加载
async function getExhibitions(force) { if (force || !EXHIBITIONS.length) { const r = await api("GET", "/api/exhibitions"); EXHIBITIONS = r.data || []; } return EXHIBITIONS; }
async function getCustTypes() {
  if (!CUST_TYPES_CACHE.length) {
    const r = await api("GET", "/api/tags");
    const tags = (r.data || []).map(t => t.name);
    // 如果标签为空，给个默认兜底
    if (!tags.length) tags.push("全部客户");
    CUST_TYPES_CACHE = tags;
  }
  return CUST_TYPES_CACHE;
}
const SCENES = [["1", "初次开发陌生客户"], ["2", "跟进意向客户推送最新行业新闻"], ["3", "通知展位余量紧张催单"], ["4", "展会补贴政策通知"], ["5", "发送参展报价方案"], ["6", "客户跟进回访"], ["7", "参展感谢与维系"]];
const TONES = ["正式商务", "简洁干练", "温和友好", "简短"];

/* ===== 草稿箱：自动保存 + 恢复（双保险：后端 drafts 表 + localStorage） ===== */
const DRAFT_LS_KEY = "wb_draft_autosave_v1";
let _draftTimer = null;
let _draftDirty = false;

function _draftField(id, fallback) { const e = document.getElementById(id); return e ? e.value : fallback; }

// 收集当前编辑中的表单状态
function collectDraftPayload() {
  return {
    exhibition: _draftField("cfg-ex", STATE.gen.exhibition || ""),
    customer_type: _draftField("cfg-ct", STATE.gen.customer_type || ""),
    scene: _draftField("cfg-sc", STATE.gen.scene || ""),
    tone: _draftField("cfg-tn", STATE.gen.tone || ""),
    custom: _draftField("cfg-custom", STATE.gen.custom || ""),
    subject: _draftField("pv-subject", STATE.gen.subject || ""),
    body: _draftField("pv-body", STATE.gen.body || ""),
    attachments: STATE.attachments.map(a => ({ id: a.id, name: a.name })),
    lang: STATE.lang || "zh"
  };
}

function draftTitle(p) {
  const sceneName = (SCENES.find(s => s[0] === p.scene) || {})[1] || "";
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0"), dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0"), mi = String(now.getMinutes()).padStart(2, "0");
  return (p.exhibition || "未选展会") + " · " + (sceneName || "邮件草稿") + " · " + mm + "-" + dd + " " + hh + ":" + mi;
}

// 保存到后端 drafts 表（持久化，重部署不丢）+ localStorage（刷新秒恢复）
async function saveDraftPayload(p) {
  let did = localStorage.getItem("wb_current_draft_id");
  if (did) {
    await api("PATCH", "/api/drafts/" + did, { title: draftTitle(p), payload: p });
  } else {
    const r = await api("POST", "/api/drafts", { title: draftTitle(p), payload: p });
    if (r.ok && r.data && r.data.id) localStorage.setItem("wb_current_draft_id", String(r.data.id));
  }
  localStorage.setItem(DRAFT_LS_KEY, JSON.stringify({ t: Date.now(), p }));
}

async function saveDraftNow(silent) {
  const p = collectDraftPayload();
  if (!p.subject && !p.body && !p.custom) { _draftDirty = false; if (!silent) toast("当前没有可保存的内容"); return null; }
  try {
    await saveDraftPayload(p);
    _draftDirty = false;
    if (!silent) toast("💾 草稿已保存");
  } catch (e) {
    // 后端不可达时降级为仅本机保存
    localStorage.setItem(DRAFT_LS_KEY, JSON.stringify({ t: Date.now(), p }));
    _draftDirty = false;
    if (!silent) toast("后端保存失败，已存本机浏览器：" + e.message);
  }
  return p;
}

function markDraftDirty() { _draftDirty = true; }

// 刷新右侧「当前附件」提示
function refreshAttInfo() {
  const el_ = document.getElementById("att-info");
  if (el_) el_.textContent = "当前附件：" + (STATE.attachments.length ? STATE.attachments.map(a => a.name).join("、") : "无");
}

// 10 秒自动保存 + 关页前 localStorage 兜底
function ensureAutoSave() {
  if (_draftTimer) return;
  _draftTimer = setInterval(() => { if (_draftDirty) saveDraftNow(true); }, 10000);
  window.addEventListener("beforeunload", () => {
    if (_draftDirty) {
      const p = collectDraftPayload();
      if (p.subject || p.body || p.custom) localStorage.setItem(DRAFT_LS_KEY, JSON.stringify({ t: Date.now(), p }));
    }
  });
}

// 切换页面/刷新前把未保存内容写入 localStorage（后端异步留给定时器）
function flushDraftOnLeave() {
  if (!_draftDirty) return;
  const p = collectDraftPayload();
  if (!p.subject && !p.body && !p.custom) { _draftDirty = false; return; }
  localStorage.setItem(DRAFT_LS_KEY, JSON.stringify({ t: Date.now(), p }));
  saveDraftPayload(p).catch(() => {});
  _draftDirty = false;
}

// 把草稿数据写入当前表单（含 STATE + DOM）
function applyDraftToForm(p) {
  if (!p) return;
  STATE.gen.exhibition = p.exhibition || "";
  STATE.gen.customer_type = p.customer_type || "";
  STATE.gen.scene = p.scene || SCENES[0][0];
  STATE.gen.tone = p.tone || TONES[0];
  STATE.gen.custom = p.custom || "";
  STATE.gen.subject = p.subject || "";
  STATE.gen.body = p.body || "";
  STATE.attachments = (p.attachments || []).filter(a => a && a.id);
  STATE.lang = p.lang || "zh";
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v || ""; };
  set("cfg-ex", STATE.gen.exhibition); set("cfg-ct", STATE.gen.customer_type);
  set("cfg-sc", STATE.gen.scene); set("cfg-tn", STATE.gen.tone);
  set("cfg-custom", STATE.gen.custom); set("pv-subject", STATE.gen.subject); set("pv-body", STATE.gen.body);
  refreshAttInfo();
  updateLangButtons();
  _draftDirty = false;
}

// 进入生成页时，若有本机未完成草稿且当前表单为空，自动恢复
function restoreLocalDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw); const p = s.p || s;
    if (!p || (!p.subject && !p.body && !p.custom)) return;
    const cur = collectDraftPayload();
    if (cur.subject || cur.body || cur.custom) return; // 当前已有内容（如刚用模板）不覆盖
    setTimeout(() => { applyDraftToForm(p); toast("↩ 已恢复上次未完成的草稿"); }, 150);
  } catch (e) {}
}

// 草稿箱面板：后端草稿 + 本机草稿
async function openDraftsPanel() {
  let drafts = [];
  try {
    const r = await api("GET", "/api/drafts");
    drafts = (r.data || []).map(d => { let p = {}; try { p = JSON.parse(d.payload || "{}"); } catch (e) {} return { id: d.id, title: d.title || "未命名草稿", updated_at: d.updated_at || "", p }; });
  } catch (e) { /* 后端不可达时仅显示本地草稿 */ }
  let lsDraft = null;
  try {
    const raw = localStorage.getItem(DRAFT_LS_KEY);
    if (raw) {
      const s = JSON.parse(raw); const p = s.p || s;
      if (p && (p.subject || p.body || p.custom)) lsDraft = { id: "local", title: "本机未同步草稿", updated_at: new Date(s.t || Date.now()).toISOString(), p, local: true };
    }
  } catch (e) {}
  const list = [];
  if (lsDraft) list.push(lsDraft);
  drafts.forEach(d => list.push(d));
  const rows = list.length ? list.map(d => {
    const preview = (d.p.subject || "(无主题)").slice(0, 46);
    const meta = (d.updated_at || "").replace("T", " ").slice(5, 16) || "刚刚";
    const badge = d.local ? '<span style="margin-left:6px;font-size:11px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;vertical-align:middle">本机未同步</span>' : "";
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px;background:#fff">
      <div style="min-width:0;flex:1">
        <div style="font-weight:600;font-size:13px;color:#111">${esc(d.title)}${badge}</div>
        <div style="font-size:12px;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(meta)} · ${esc(preview)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-sm" data-draft-restore="${d.id}" style="background:#eef2ff;color:#4f46e5">↩ 恢复</button>
        <button class="btn btn-sm btn-danger" data-draft-del="${d.id}">删除</button>
      </div>
    </div>`;
  }).join("") : '<div class="muted" style="padding:18px;text-align:center">暂无草稿。编辑邮件时每 10 秒自动保存，退出页面/关闭浏览器后回来可继续编辑。</div>';
  const html = `
    <div style="font-size:12px;color:#888;margin-bottom:10px">草稿双保险：自动保存到服务器（重新部署不丢）+ 本机浏览器。点击「恢复」继续编辑，同一条草稿会被后续自动保存覆盖。</div>
    <div style="max-height:44vh;overflow:auto">${rows}</div>
    <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:12px;color:#aaa">恢复后请记得手动点一次「💾 保存草稿」固定到服务器</span>
      <button class="btn btn-sm" id="draft-new" style="background:#f3f4f6">🗑 清空当前编辑，开始新草稿</button>
    </div>`;
  openModal("📂 草稿箱", html, "modal-wide");
  setTimeout(() => {
    $all("[data-draft-restore]").forEach(b => b.onclick = async () => {
      const id = b.dataset.draftRestore;
      const d = id === "local" ? lsDraft : drafts.find(x => String(x.id) === String(id));
      if (!d) return;
      applyDraftToForm(d.p);
      if (id !== "local") localStorage.setItem("wb_current_draft_id", String(id));
      closeModal(); toast("已恢复草稿，可继续编辑");
    });
    $all("[data-draft-del]").forEach(b => b.onclick = async () => {
      const id = b.dataset.draftDel;
      if (!confirm("确定删除这条草稿？")) return;
      if (id === "local") localStorage.removeItem(DRAFT_LS_KEY);
      else { try { await api("DELETE", "/api/drafts/" + id); } catch (e) {} }
      closeModal(); openDraftsPanel(); toast("已删除");
    });
    const nb = $("#draft-new");
    if (nb) nb.onclick = () => {
      localStorage.removeItem("wb_current_draft_id");
      localStorage.removeItem(DRAFT_LS_KEY);
      STATE.gen = { exhibition: "", customer_type: "", scene: "", tone: "", custom: "", subject: "", body: "" };
      STATE.attachments = []; STATE.lang = "zh";
      closeModal(); render(); toast("已清空，开始新草稿");
    };
  }, 0);
}

/* ---------- 展会资料自动关联 ---------- */
/** 根据展会名称自动加载该展会绑定的资料附件到 STATE.attachments */
function autoLoadExMaterials(exName) {
  var hint = document.getElementById("ex-mat-hint");
  if (!hint || !exName || !exName.trim()) { if (hint) hint.style.display = "none"; return; }
  hint.style.display = "block";
  hint.style.background = "#eff6ff";
  hint.style.border = "1px solid #93c5fd";
  hint.style.color = "#1e40af";
  hint.innerHTML = "\u23f3 \u6b63\u5728\u67e5\u627e\u5c55\u4f1a\u8d44\u6599\u2026";
  getExhibitions().then(function(exs) {
    var match = null;
    for (var i = 0; i < exs.length; i++) { if (exs[i].name === exName.trim()) { match = exs[i]; break; } }
    if (!match) {
      hint.style.background = "#fefce8"; hint.style.border = "1px solid #fde047"; hint.style.color = "#854d0e";
      hint.innerHTML = "\u26a0\ufe0f \u300c" + esc(exName) + "\u300d\u672a\u5728\u5c55\u4f1a\u5e93\u4e2d\u627e\u5230\uff08\u53ef\u53bb\u300c\u5c55\u4f1a\u7ba1\u7406\u300d\u65b0\u5efa\uff09";
      return;
    }
    api("GET", "/api/materials").then(function(r) {
      var mats = [];
      var data = r.data || [];
      for (var j = 0; j < data.length; j++) { if (Number(data[j].exhibition_id) === Number(match.id)) mats.push(data[j]); }
      if (!mats.length) {
        hint.style.background = "#f5f5f5"; hint.style.border = "1px solid #d1d5db"; hint.style.color = "#6b7280";
        hint.innerHTML = "\ud83d\udcce \u8be5\u5c55\u4f1a\u6682\u65e0\u7ed1\u5b9a\u8d44\u6599\uff08\u53ef\u5728\u300c\u8d44\u6599\u5e93\u300d\u4e0a\u4f20\u65f6\u9009\u62e9\u6240\u5c5e\u5c55\u4f1a\uff09";
        var filtered = [];
        for (var k = 0; k < STATE.attachments.length; k++) { if (STATE.attachments[k]._source !== "auto_ex") filtered.push(STATE.attachments[k]); }
        STATE.attachments = filtered;
        updateAttInfo();
        return;
      }
      var filtered2 = [];
      for (var m = 0; m < STATE.attachments.length; m++) { if (STATE.attachments[m]._source !== "auto_ex") filtered2.push(STATE.attachments[m]); }
      STATE.attachments = filtered2;
      for (var n = 0; n < mats.length; n++) {
        var found = false;
        for (var p = 0; p < STATE.attachments.length; p++) { if (STATE.attachments[p].id === mats[n].id) { found = true; break; } }
        if (!found) STATE.attachments.push({ id: mats[n].id, name: mats[n].name, _source: "auto_ex" });
      }
      var names = [];
      for (var q = 0; q < mats.length; q++) names.push(esc(mats[q].name));
      hint.style.background = "#ecfdf5"; hint.style.border = "1px solid #86efac"; hint.style.color = "#166534";
      hint.innerHTML = "\u2705 \u5df2\u81ea\u52a8\u52a0\u8f7d <b>" + mats.length + "</b> \u4e2a\u5c55\u4f1a\u8d44\u6599\uff1a" + names.join("\u3001") + "<br><span style=\"color:#15803d;font-size:11px\">\ud83d\udca1 AI \u751f\u6210\u90ae\u4ef6\u65f6\u5c06\u4e3b\u8981\u57fa\u4e8e\u8fd9\u4e9b\u8d44\u6599\u5185\u5bb9</span>";
      updateAttInfo();
      markDraftDirty();
    }).catch(function(e) {
      hint.style.background = "#fef2f2"; hint.style.border = "1px solid #fca5a5"; hint.style.color = "#991b1b";
      hint.innerHTML = "\u26a0\ufe0f \u52a0\u8f7d\u5c55\u4f1a\u8d44\u6599\u5931\u8d25\uff1a" + esc(e.message);
    });
  }).catch(function() {});
}

function updateAttInfo() {
  var el = document.getElementById("att-info");
  if (!el) return;
  var names = [];
  for (var i = 0; i < STATE.attachments.length; i++) names.push(STATE.attachments[i].name);
  el.textContent = names.length ? "\u5f53\u524d\u9644\u4ef6\uff1a" + names.join("\u3001") : "\u5f53\u524d\u9644\u4ef6\uff1a\u65e0";
}

function viewGen() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "🤖 AI 一键生成邮件模板"));
  wrap.appendChild(el("div", { class: "section-sub" }, "左侧配置参数 → 右侧预览/编辑 → 保存模板或批量发送（支持变量 {客户名称}{联系人姓名}{销售姓名} 自动替换）。选择目标展会后会自动加载该展会的绑定资料，AI 将主要基于资料内容生成邮件。"));
  // 草稿工具栏：保存草稿 / 草稿箱
  const draftBar = el("div", { style: "display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap" });
  draftBar.appendChild(el("span", { style: "font-size:12px;color:#888" }, "💾 草稿双保险："));
  const bSaveDraft = el("button", { class: "btn btn-sm", style: "background:#eef2ff;color:#4f46e5;font-weight:600" }, "保存草稿");
  bSaveDraft.onclick = () => saveDraftNow(false);
  const bOpenDrafts = el("button", { class: "btn btn-sm", style: "background:#fef3c7;color:#92400e;font-weight:600" }, "📂 草稿箱");
  bOpenDrafts.onclick = openDraftsPanel;
  draftBar.appendChild(bSaveDraft);
  draftBar.appendChild(bOpenDrafts);
  draftBar.appendChild(el("span", { style: "font-size:12px;color:#aaa" }, "编辑中每 10 秒自动保存，误退出/关浏览器后回来可继续编辑"));
  wrap.appendChild(draftBar);
  const split = el("div", { class: "split" });

  // 左：配置
  const left = el("div", { class: "card" });
  left.appendChild(el("div", { class: "label" }, "1. 选择目标展会"));
  // 可搜索的展会选择（input + datalist），支持打字快速筛选
  const exDl = el("datalist", { id: "dl-ex" });
  const exInput = el("input", { class: "inp", id: "cfg-ex", list: "dl-ex", placeholder: "输入或选择目标展会…", autocomplete: "off" });
  left.appendChild(exDl); left.appendChild(exInput);
  // 展会资料自动关联提示区
  const exMatHint = el("div", { id: "ex-mat-hint", style: "display:none;margin-top:6px;padding:8px;border-radius:6px;font-size:12px;line-height:1.5" });
  left.appendChild(exMatHint);
  // 每次进入 AI 生成页都强制刷新展会列表（确保新建的展会立即出现）
  getExhibitions(true).then(exs => {
    exDl.innerHTML = "";
    exs.forEach(e => exDl.appendChild(el("option", { value: e.name })));
    // 如果当前值不在列表中但用户之前选过，保留；否则默认第一个
    if (STATE.gen.exhibition && exs.some(e => e.name === STATE.gen.exhibition)) exInput.value = STATE.gen.exhibition;
    else if (exs.length && !exInput.value) { exInput.value = exs[0].name; STATE.gen.exhibition = exs[0].name; }
    // 进入页面时也触发一次资料关联
    if (typeof autoLoadExMaterials === "function") autoLoadExMaterials(exInput.value);
  });
  // 选择/输入展会名称后，自动关联该展会的资料附件
  var _exMatTimer = null;
  exInput.addEventListener("input", function() {
    clearTimeout(_exMatTimer);
    _exMatTimer = setTimeout(function() {
      STATE.gen.exhibition = exInput.value;
      if (typeof autoLoadExMaterials === "function") autoLoadExMaterials(exInput.value);
    }, 400);
  });
  exInput.addEventListener("change", function() {
    STATE.gen.exhibition = exInput.value;
    if (typeof autoLoadExMaterials === "function") autoLoadExMaterials(exInput.value);
  });
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "2. 选择客户类型"));
  const ctSel = el("select", { class: "inp", id: "cfg-ct" }, [el("option", { value: "" }, "加载中…")]);
  left.appendChild(ctSel);
  getCustTypes().then(types => {
    ctSel.innerHTML = "";
    types.forEach(t => ctSel.appendChild(el("option", { value: t }, t)));
    if (STATE.gen.customer_type && [...ctSel.options].some(o => o.value === STATE.gen.customer_type)) ctSel.value = STATE.gen.customer_type;
    else if (types.length) STATE.gen.customer_type = ctSel.value;
  });
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "3. 选择邮件场景"));
  const scSel = el("select", { class: "inp", id: "cfg-sc" }, SCENES.map(s => el("option", { value: s[0] }, s[1])));
  left.appendChild(scSel);
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "4. 选择语气风格"));
  const tnSel = el("select", { class: "inp", id: "cfg-tn" }, TONES.map(t => el("option", { value: t }, t)));
  left.appendChild(tnSel);
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "5. 自定义补充（粘贴新闻/卖点素材，AI 会融入邮件）"));
  const custom = el("textarea", { class: "inp", id: "cfg-custom", placeholder: "例：加上欧盟 PPWR 包装法规新闻，重点突出展位余量不多。" });
  left.appendChild(custom);
  // 「获取最新资讯」按钮：调用后端抓取真实行业新闻，填入自定义补充框
  const newsBtn = el("button", { class: "btn", style: "margin-top:6px;font-size:12px" }, "🔍 获取最新行业资讯（真实新闻）");
  newsBtn.onclick = async () => {
    newsBtn.disabled = true; newsBtn.textContent = "⏳ 搜索中…";
    try {
      const r = await api("GET", "/api/news/search?q=" + encodeURIComponent("食品包装机械 海外市场 出展 2026"));
      if (r.data && r.data.items && r.data.items.length) {
        const items = r.data.items;
        const isCache = (r.data.source || "").indexOf("缓存") >= 0;
        const srcLabel = isCache ? "近期热点(缓存，非实时)" : (r.data.source || "网络");
        const when = r.data.fetched_at ? ` · 抓取于 ${r.data.fetched_at.slice(0,16)}` : "";
        const head = `【最新行业资讯】来源：${srcLabel}${when}`;
        const lines = items.map((it, i) => {
          if (typeof it === "object" && it) {
            const d = it.date ? `（${it.date.slice(0,10)}）` : "";
            return `${i + 1}. ${it.title}${d}`;
          }
          return `${i + 1}. ${it}`;
        });
        custom.value = head + "\n\n" + lines.join("\n") + (isCache ? "\n\n（提示：实时抓取暂不可用，以上为缓存热点，建议手动补充最新动态）" : "");
        toast(`已加载 ${items.length} 条真实资讯`);
      } else {
        toast("未搜索到相关资讯，请手动输入");
      }
    } catch(e) {
      toast("获取资讯失败：" + e.message);
    }
    newsBtn.disabled = false; newsBtn.textContent = "🔍 获取最新行业资讯（真实新闻）";
  };
  left.appendChild(newsBtn);
  // 生成按钮区：单版本 + 多版本（4-5个不同角度）
  const genWrap = el("div", { style: "margin-top:14px;display:flex;flex-direction:column;gap:8px" });
  const gen = el("button", { class: "btn btn-primary btn-block" }, "⚡ AI 一键生成邮件");
  gen.onclick = async () => {
    gen.disabled = true; gen.textContent = "生成中…";
    try {
      const r = await api("POST", "/api/ai/generate", {
        exhibition: exInput.value, customer_type: ctSel.value, scene: scSel.value, tone: tnSel.value,
        custom_input: custom.value, signature: SETTINGS.signature || USER.display_name || "招展顾问",
        material_ids: STATE.attachments.map(a => a.id)
      });
      if (!r.ok) { toast("生成失败"); return; }
      fillGenerated(r.data.subject, r.data.body);
    } finally {
      gen.disabled = false; gen.textContent = "⚡ AI 一键生成邮件";
    }
  };
  const genMulti = el("button", { class: "btn", style: "background:#7c3aed;color:#fff;font-weight:600" }, "🎲 生成 4-5 个不同版本（多视角）");
  genMulti.onclick = async () => {
    genMulti.disabled = true; genMulti.textContent = "🎲 正在生成 4-5 个不同版本…";
    try {
      const r = await api("POST", "/api/ai/generate-multi", {
        exhibition: exInput.value, customer_type: ctSel.value, scene: scSel.value, tone: tnSel.value,
        custom_input: custom.value, signature: SETTINGS.signature || USER.display_name || "招展顾问",
        material_ids: STATE.attachments.map(a => a.id), n: 5
      });
      if (!r.ok) { toast("生成失败"); return; }
      renderMultiVersions(r.data.versions || []);
    } finally {
      genMulti.disabled = false; genMulti.textContent = "🎲 生成 4-5 个不同版本（多视角）";
    }
  };
  genWrap.appendChild(gen);
  genWrap.appendChild(genMulti);
  left.appendChild(genWrap);
  split.appendChild(left);

  // 右：预览编辑
  const right = el("div", { class: "preview-box" });
  // 多版本切换标签容器（默认隐藏）
  const verTabs = el("div", { id: "ver-tabs", style: "display:none;margin-bottom:12px" });
  right.appendChild(verTabs);
  // 语言切换按钮
  const langBar = el("div", { style: "display:flex;gap:6px;margin-bottom:10px;align-items:center" });
  const langOpts = [
    { key: "zh", label: "🇨🇳 中文" },
    { key: "bilingual", label: "🇨🇳/🇬🇧 中英双语" },
    { key: "en", label: "🇬🇧 英文" }
  ];
  langOpts.forEach(opt => {
    const btn = el("button", {
      class: "btn btn-sm",
      "data-lang": opt.key,
      style: "font-size:12px;padding:4px 10px"
    }, opt.label);
    btn.onclick = () => switchMailLang(opt.key);
    langBar.appendChild(btn);
  });
  right.appendChild(langBar);
  right.appendChild(el("div", { class: "label" }, "邮件主题（可修改）"));
  const subj = el("input", { class: "preview-subject", id: "pv-subject", placeholder: "AI 生成后显示主题" });
  right.appendChild(subj);
  right.appendChild(el("div", { class: "label" }, "邮件正文（可修改）"));
  const body = el("textarea", { class: "preview-body", id: "pv-body", placeholder: "AI 生成后显示正文…" });
  right.appendChild(body);

  // —— 变量替换实时预览区 ——
  const varPreview = el("div", { class: "var-preview-box", style: "margin-top:14px;border:1px solid #e5e7eb;border-radius:10px;padding:14px;background:#fafbfc" });
  varPreview.appendChild(el("div", { class: "label", style: "margin-bottom:8px" }, "🔄 用真实客户数据预览效果（选择一位客户看替换结果）"));
  const varSel = el("select", { class: "inp", id: "var-cust-sel" });
  varSel.appendChild(el("option", { value: "" }, "— 选择客户 —"));
  varPreview.appendChild(varSel);
  // 加载客户列表到下拉框
  api("GET", "/api/customers").then(r => {
    (r.data || []).forEach(c => {
      varSel.appendChild(el("option", { value: c.id }, c.company + " / " + (c.contact || "")));
    });
  });
  const varResult = el("div", { id: "var-result", style: "display:none;margin-top:10px" });
  varPreview.appendChild(varResult);
  // 替换函数
  const doVarReplace = () => {
    const cid = varSel.value;
    if (!cid) { varResult.style.display = "none"; return; }
    const cust = (window._allCustomersForVar || []).find(c => c.id == cid); // loose eq
    if (!cust) return;
    const sName = SETTINGS.signature || USER.display_name || "招展顾问";
    let subjVal = $("#pv-subject").value || "";
    let bodyVal = $("#pv-body").value || "";
    const rep = { "{客户名称}": cust.company || "", "{联系人姓名}": cust.contact || "", "{销售姓名}": sName, "{邮箱}": cust.email || "", "{手机号}": cust.phone || "", "{意向展会}": cust.exhibition || "" };
    for (const k in rep) { subjVal = subjVal.split(k).join(rep[k] || k); bodyVal = bodyVal.split(k).join(rep[k] || k); }
    varResult.style.display = "block";
    varResult.innerHTML = `
      <div style="font-size:12px;color:#6b7280;margin-bottom:6px">替换后效果（收件人：<b>${esc(cust.company)} / ${esc(cust.contact)}</b>）：</div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px">
        <div style="font-weight:600;color:#1f6feb;margin-bottom:6px">${esc(subjVal)}</div>
        <pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.7;margin:0;color:#374151">${esc(bodyVal).replace(/\n/g, "<br>")}</pre>
      </div>`;
  };
  varSel.onchange = doVarReplace;
  // 缓存客户列表供替换使用
  api("GET", "/api/customers").then(r => { window._allCustomersForVar = r.data || []; });
  // 生成后自动触发一次替换预览
  const origGenClick = gen.onclick;
  gen.onclick = async (...a) => {
    await origGenClick(...a);
    setTimeout(doVarReplace, 200);
    if (varSel.options.length > 1) varSel.selectedIndex = 1;
  };
  // 多版本生成后也自动触发变量替换预览
  const origMultiClick = genMulti.onclick;
  genMulti.onclick = async (...a) => {
    await origMultiClick(...a);
    setTimeout(doVarReplace, 200);
    if (varSel.options.length > 1) varSel.selectedIndex = 1;
  };
  right.appendChild(varPreview);
  right.appendChild(el("div", { class: "var-hint" }, "💡 变量说明：{客户名称} {联系人姓名} {销售姓名} 等 — 批量发送时按每位客户自动替换为真实信息，每封邮件都不同。"));
  const bar = el("div", { class: "action-bar" });
  const bSave = el("button", { class: "btn" }, "💾 保存到我的模板库");
  bSave.onclick = saveTemplateModal;
  const bAtt = el("button", { class: "btn" }, "📎 添加附件");
  bAtt.onclick = attachModal;
  const bBatch = el("button", { class: "btn btn-primary" }, "📤 批量发送（预览+确认后发出）");
  bBatch.onclick = batchSendModal;
  const bTest = el("button", { class: "btn btn-ok" }, "✉️ 发一封测试邮件给自己");
  bTest.onclick = testSend;
  [bSave, bAtt, bBatch, bTest].forEach(b => bar.appendChild(b));
  right.appendChild(bar);
  right.appendChild(el("div", { class: "var-hint", id: "att-info" }, "当前附件：无"));
  split.appendChild(right);

  // 自动保存：表单变化标记 dirty → 10 秒定时保存；切页/关页前兜底
  [exInput, ctSel, scSel, tnSel].forEach(s => s.addEventListener("change", markDraftDirty));
  [custom, subj, body].forEach(t => t.addEventListener("input", markDraftDirty));
  ensureAutoSave();
  restoreLocalDraft();

  wrap.appendChild(split);
  return wrap;
}

/** 单版本生成后填充主题/正文并记录状态 */
function fillGenerated(subject, body) {
  STATE.gen = Object.assign(STATE.gen || {}, {
    exhibition: $("#cfg-ex") ? $("#cfg-ex").value : (STATE.gen && STATE.gen.exhibition),
    customer_type: $("#cfg-ct") ? $("#cfg-ct").value : (STATE.gen && STATE.gen.customer_type),
    scene: $("#cfg-sc") ? $("#cfg-sc").value : (STATE.gen && STATE.gen.scene),
    tone: $("#cfg-tn") ? $("#cfg-tn").value : (STATE.gen && STATE.gen.tone),
    custom: $("#cfg-custom") ? $("#cfg-custom").value : (STATE.gen && STATE.gen.custom),
    subject: subject, body: body
  });
  STATE.origMail = { subject: subject, body: body };
  STATE.lang = "zh";
  updateLangButtons();
  $("#pv-subject").value = subject; $("#pv-body").value = body;
  // 隐藏多版本标签
  const vt = document.getElementById("ver-tabs");
  if (vt) vt.style.display = "none";
  toast("已生成，可在右侧修改");
}

/** 多版本生成后渲染版本切换标签，点击切换主题/正文 */
function renderMultiVersions(versions) {
  const vt = document.getElementById("ver-tabs");
  if (!vt) return;
  if (!versions.length) { toast("未生成任何版本"); return; }
  vt.innerHTML = "";
  vt.style.display = "block";
  vt.appendChild(el("div", { class: "label", style: "margin-bottom:8px" }, "🎲 已生成 " + versions.length + " 个不同视角版本，点击切换（保存/发送将使用当前选中版本）"));
  const tabBar = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
  versions.forEach((v, i) => {
    const tab = el("button", {
      class: "btn btn-sm ver-tab" + (i === 0 ? " ver-tab-active" : ""),
      "data-idx": i,
      style: "font-size:12px;padding:6px 12px;cursor:pointer;" + (i === 0 ? "background:#7c3aed;color:#fff;border-color:#7c3aed" : "background:#fff;color:#374151;border:1px solid #d1d5db")
    }, "V" + (i + 1) + " · " + (v.angle || "角度" + (i + 1)));
    tab.onclick = () => {
      // 高亮当前标签
      var allTabs = vt.querySelectorAll(".ver-tab");
      for (var t = 0; t < allTabs.length; t++) {
        allTabs[t].style.background = "#fff";
        allTabs[t].style.color = "#374151";
        allTabs[t].style.border = "1px solid #d1d5db";
        allTabs[t].classList.remove("ver-tab-active");
      }
      tab.style.background = "#7c3aed";
      tab.style.color = "#fff";
      tab.style.border = "1px solid #7c3aed";
      tab.classList.add("ver-tab-active");
      // 填充该版本到预览框
      STATE.gen = Object.assign(STATE.gen || {}, {
        exhibition: $("#cfg-ex") ? $("#cfg-ex").value : (STATE.gen && STATE.gen.exhibition),
        customer_type: $("#cfg-ct") ? $("#cfg-ct").value : (STATE.gen && STATE.gen.customer_type),
        scene: $("#cfg-sc") ? $("#cfg-sc").value : (STATE.gen && STATE.gen.scene),
        tone: $("#cfg-tn") ? $("#cfg-tn").value : (STATE.gen && STATE.gen.tone),
        custom: $("#cfg-custom") ? $("#cfg-custom").value : (STATE.gen && STATE.gen.custom),
        subject: v.subject, body: v.body
      });
      STATE.origMail = { subject: v.subject, body: v.body };
      STATE.lang = "zh";
      updateLangButtons();
      $("#pv-subject").value = v.subject; $("#pv-body").value = v.body;
      toast("已切换到 V" + (i + 1));
    };
    tabBar.appendChild(tab);
  });
  vt.appendChild(tabBar);
  // 默认选中第 1 个版本
  var first = versions[0];
  STATE.gen = Object.assign(STATE.gen || {}, {
    exhibition: $("#cfg-ex") ? $("#cfg-ex").value : (STATE.gen && STATE.gen.exhibition),
    customer_type: $("#cfg-ct") ? $("#cfg-ct").value : (STATE.gen && STATE.gen.customer_type),
    scene: $("#cfg-sc") ? $("#cfg-sc").value : (STATE.gen && STATE.gen.scene),
    tone: $("#cfg-tn") ? $("#cfg-tn").value : (STATE.gen && STATE.gen.tone),
    custom: $("#cfg-custom") ? $("#cfg-custom").value : (STATE.gen && STATE.gen.custom),
    subject: first.subject, body: first.body
  });
  STATE.origMail = { subject: first.subject, body: first.body };
  STATE.lang = "zh";
  updateLangButtons();
  $("#pv-subject").value = first.subject; $("#pv-body").value = first.body;
  toast("已生成 " + versions.length + " 个版本，默认显示 V1");
}
async function saveTemplateModal() {
  const subj = $("#pv-subject").value, body = $("#pv-body").value;
  if (!subj || !body) { toast("请先生成邮件再保存"); return; }
  const html = `<div class="cfg-row"><label>模板名称</label><input id="tpl-name" class="inp" placeholder="如：SIAL-预制菜-初次开发"></div>
    <div class="cfg-row"><label>所属展会</label><input id="tpl-ex" class="inp" value="${esc(STATE.gen.exhibition)}"></div>
    <button class="btn btn-primary btn-block" id="tpl-save">保存</button>`;
  const m = openModal("保存到我的模板库", html);
  $("#tpl-save").onclick = async () => {
    await api("POST", "/api/templates", {
      name: $("#tpl-name").value.trim() || STATE.gen.exhibition + " 模板", exhibition: $("#tpl-ex").value,
      customer_type: STATE.gen.customer_type, scene: SCENES.find(s => s[0] === STATE.gen.scene)?.[1] || "", tone: STATE.gen.tone,
      subject: subj, body: body, signature: SETTINGS.signature || USER.display_name, attachment_ids: STATE.attachments.map(a => a.id).join(",")
    });
    closeModal(); toast("已保存到模板库");
  };
}
async function attachModal() {
  const r = await api("GET", "/api/materials"); const mats = r.data || [];
  const html = `
    <div class="cfg-row" style="margin-bottom:12px">
      <label style="display:block;margin-bottom:6px;font-weight:bold">📁 从本地上传新文件</label>
      <input type="file" id="att-local-file" class="inp" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.gif" style="padding:6px">
      <div style="font-size:11px;color:#888;margin-top:4px">支持：PDF / Word / Excel / CSV / 图片</div>
    </div>
    <div class="cfg-row" style="border-top:1px solid #eee;padding-top:12px">
      <label style="display:block;margin-bottom:6px;font-weight:bold">📂 或从资料库选择已有文件</label>
      ${mats.length ? mats.map(m => `<label style="display:block;margin:6px 0"><input type="checkbox" class="att-chk" value="${m.id}" ${STATE.attachments.find(a => a.id === m.id) ? "checked" : ""}> ${esc(m.name)}</label>`).join("") : '<div class="muted">资料库暂无文件</div>'}
    </div>
    <button class="btn btn-primary btn-block" id="att-ok">确定</button>`;
  openModal("添加附件", html);

  // 本地上传处理
  $("#att-local-file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(f); });
    const rr = await api("POST", "/api/materials", { name: f.name, content_b64: b64 });
    if (!rr.ok) { toast("上传失败：" + (rr.data.error || "")); return; }
    // 上传成功后，刷新资料库列表并自动勾选新文件
    const r2 = await api("GET", "/api/materials");
    const newMats = r2.data || [];
    const newFile = newMats.find(m => m.name === f.name);
    if (newFile) {
      if (!STATE.attachments.find(a => a.id === newFile.id)) {
        STATE.attachments.push({ id: newFile.id, name: newFile.name });
      }
      $("#att-info").textContent = "当前附件：" + STATE.attachments.map(a => a.name).join("、");
      markDraftDirty();
      toast("已上传并绑定：" + f.name);
    }
    // 重新渲染弹窗内容
    closeModal();
    attachModal();
  };

  $("#att-ok").onclick = () => {
    STATE.attachments = $all(".att-chk:checked").map(c => { const m = mats.find(x => x.id == c.value); return { id: m.id, name: m.name }; });
    $("#att-info").textContent = "当前附件：" + (STATE.attachments.length ? STATE.attachments.map(a => a.name).join("、") : "无");
    markDraftDirty();
    closeModal(); toast("已选择附件");
  };
}
async function testSend() {
  const subj = $("#pv-subject").value, body = $("#pv-body").value;
  if (!subj || !body) { toast("请先生成邮件"); return; }
  const to = SETTINGS.from_email || prompt("请输入接收测试邮件的邮箱：");
  if (!to) return;
  const r = await api("POST", "/api/email/send", { items: [{ company: USER.display_name, contact: USER.display_name, email: to, subject: subj, body: body }], interval: 0, attachment_ids: STATE.attachments.map(a => a.id), exhibition: STATE.gen.exhibition, template_name: "测试发送" });
  if (r.ok) toast(r.data.demo_mode ? "测试邮件已记录（演示模式，未实际外发，请在设置配置 SMTP）" : "测试邮件已发送");
  else toast("发送失败：" + (r.data.error || ""));
}
async function batchSendModal() {
  const subj = $("#pv-subject").value, body = $("#pv-body").value;
  if (!subj || !body) { toast("请先生成邮件再批量发送"); return; }
  let src = "list";
  const html = `
    ${SETTINGS.demo_mode ? `<div style="margin-bottom:12px;padding:12px 14px;border-radius:8px;background:#fffbeb;border:1px solid #f59e0b;color:#92400e;font-size:13px">
      <b>⚠️ 当前为「演示模式」：点击发送只会写日志，不会真正把邮件发到客户邮箱。</b><br>
      要真实群发，请先到左侧「⚙️ 系统设置」：① 填写 SMTP（可一键选 QQ/163）→ ② 取消勾选「开启演示模式」→ ③ 保存。配置并测试通过后，回到这里即可真实发送。
    </div>` : `<div style="margin-bottom:12px;padding:10px 14px;border-radius:8px;background:#e9f9ee;border:1px solid #9fe0b4;color:#0b6b2e;font-size:13px">
      ✅ 演示模式已关闭，邮件将<b>真实外发</b>到客户邮箱（请确认 SMTP 已配置且「测试连接」通过）。
    </div>`}
    <div class="src-tabs">
      <span class="active" data-s="list">方式A：从客户列表勾选</span>
      <span data-s="csv">方式B：导入 Excel/CSV 清单</span>
    </div>
    <div id="src-list">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <button class="btn btn-sm" id="btn-selall">☑ 全选</button>
        <button class="btn btn-sm" id="btn-selnone">☐ 取消全选</button>
        <span class="muted" style="font-size:12px">按标签全选：</span>
        <select id="tag-quick" class="inp" style="width:auto;padding:4px 8px"><option value="">选择标签…</option></select>
      </div>
      <input id="cust-search" class="inp" placeholder="搜索客户公司/联系人" style="margin-bottom:8px">
      <div id="cust-pick" style="max-height:200px;overflow:auto"></div>
    </div>
    <div id="src-csv" style="display:none">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <label class="btn" style="cursor:pointer;font-size:12px;padding:4px 10px">📁 上传文件
          <input type="file" id="batch-file" accept=".csv,.xlsx,.xls" style="display:none">
        </label>
        <span id="batch-fn" class="muted" style="font-size:11px"></span>
      </div>
      <div class="muted" style="font-size:11px;margin-bottom:6px">支持 .csv / .xlsx 文件，表头：客户公司,联系人,邮箱</div>
      <textarea id="csv-text" class="inp" style="min-height:100px" placeholder="客户公司,联系人,邮箱&#10;XX食品厂,王总,wang@xx.com"></textarea>
    </div>
    <div class="cfg-row" style="margin-top:12px"><label>过滤标签（只发送该标签客户）</label>
      <input id="tag-filter" class="inp" placeholder="如：预制菜客户（留空=不过滤）"></div>
    <div class="grid3">
      <div><label class="label">发送间隔(秒)</label><input id="interval" class="inp" type="number" value="${SETTINGS.default_interval || 5}"></div>
      <div><label class="label">抄送 CC</label><input id="cc" class="inp" placeholder="a@x.com,b@y.com"></div>
      <div><label class="label">密送 BCC</label><input id="bcc" class="inp" placeholder="bcc@x.com"></div>
    </div>
    <div class="action-bar">
      <button class="btn btn-primary" id="btn-preview">👁 预览全部客户邮件效果</button>
      <button class="btn btn-ok" id="btn-send" disabled>✅ 确认无误，一键批量发送</button>
    </div>
    <div id="preview-area" style="margin-top:12px"></div>`;
  openModal("批量发送邮件", html, "modal-wide");
  // 客户勾选
  const custPick = $("#cust-pick");
  let allCustomers = [];
  (await api("GET", "/api/customers")).data.forEach(c => allCustomers.push(c));
  const selectedSet = new Set();
  const renderPick = (kw) => {
    custPick.innerHTML = "";
    allCustomers.filter(c => !kw || (c.company + c.contact).includes(kw)).forEach(c => {
      const lab = el("label", { style: "display:block;padding:5px 0;border-bottom:1px solid #f0f0f0" });
      const cb = el("input", { type: "checkbox", class: "cp", value: c.id, "data-email": c.email });
      cb.checked = selectedSet.has(c.id);
      cb.onchange = () => { if (cb.checked) selectedSet.add(c.id); else selectedSet.delete(c.id); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode(" " + c.company + " / " + (c.contact || "") + " / " + (c.email || "")));
      custPick.appendChild(lab);
    });
  };
  renderPick("");
  $("#cust-search").oninput = e => renderPick(e.target.value);
  // 全选 / 取消全选 / 按标签全选
  const tagSet = new Set();
  allCustomers.forEach(c => (c.tags || "").split(",").forEach(t => t.trim() && tagSet.add(t.trim())));
  const tagQuick = $("#tag-quick");
  [...tagSet].sort().forEach(t => tagQuick.appendChild(el("option", { value: t }, t)));
  $("#btn-selall").onclick = () => {
    allCustomers.filter(c => !$("#cust-search").value || (c.company + c.contact).includes($("#cust-search").value))
      .forEach(c => selectedSet.add(c.id));
    renderPick($("#cust-search").value); toast("已全选当前列表");
  };
  $("#btn-selnone").onclick = () => {
    selectedSet.clear(); renderPick($("#cust-search").value); toast("已取消全选");
  };
  tagQuick.onchange = () => {
    const tg = tagQuick.value;
    if (!tg) return;
    $("#cust-search").value = "";
    allCustomers.filter(c => (c.tags || "").split(",").map(x => x.trim()).includes(tg))
      .forEach(c => selectedSet.add(c.id));
    renderPick(""); toast("已全选标签：" + tg);
  };
  $all(".src-tabs span").forEach(s => s.onclick = () => {
    src = s.dataset.s;
    $all(".src-tabs span").forEach(x => x.classList.toggle("active", x === s));
    $("#src-list").style.display = src === "list" ? "block" : "none";
    $("#src-csv").style.display = src === "csv" ? "block" : "none";
  });
  // 批量发送弹窗 - 文件上传处理
  const batchFile = $("#batch-file");
  if (batchFile) {
    batchFile.onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $("#batch-fn").textContent = f.name;
      const ext = f.name.split('.').pop().toLowerCase();
      try {
        if (ext === 'csv') {
          $("#csv-text").value = await f.text();
          toast("已加载 " + f.name);
        } else if (ext === 'xlsx') {
          const buf = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result); rd.readAsArrayBuffer(f); });
          const rows = parseExcelBuffer(buf, ext);
          if (rows.length) { $("#csv-text").value = rows.map(r=>r.join(',')).join('\n'); toast("已解析 Excel " + rows.length + " 行"); }
          else toast("Excel 解析失败");
        } else {
          toast(".xls 旧格式不支持，请用 .xlsx 或 .csv");
        }
      } catch(err) { toast("文件读取失败：" + err.message); }
    };
  }
  let previewItems = null;
  $("#btn-preview").onclick = async () => {
    const payload = { subject: subj, body: body, tag_filter: $("#tag-filter").value.trim(), interval: 0 };
    if (src === "list") {
      const ids = $all(".cp:checked").map(c => +c.value);
      if (!ids.length) { toast("请勾选客户"); return; }
      payload.customer_ids = ids;
    } else {
      if (!$("#csv-text").value.trim()) { toast("请粘贴 CSV"); return; }
      payload.csv = $("#csv-text").value;
    }
    const r = await api("POST", "/api/email/preview", payload);
    previewItems = r.data.items;
    const area = $("#preview-area");
    area.innerHTML = `<div class="muted" style="margin:6px 0">共 ${r.data.count} 封个性化邮件，以下为前 5 封预览：</div>`;
    r.data.items.slice(0, 5).forEach(it => {
      area.appendChild(el("div", { class: "preview-item" }, [
        el("div", { class: "to" }, `→ ${esc(it.contact || "")}（${esc(it.company || "")}） < ${esc(it.email || "")} >`),
        el("div", { class: "ps", html: esc(it.subject) + "<br>" + esc(it.body).replace(/\n/g, "<br>") })
      ]));
    });
    $("#btn-send").disabled = false;
    toast("预览完成，请确认后发送");
  };
  $("#btn-send").onclick = async () => {
    if (!previewItems) { toast("请先预览"); return; }
    if (!confirm("确认发送这 " + previewItems.length + " 封邮件？发送后将写入发送日志。")) return;
    const cc = $("#cc").value.split(",").map(s => s.trim()).filter(Boolean);
    const bcc = $("#bcc").value.split(",").map(s => s.trim()).filter(Boolean);
    const r = await api("POST", "/api/email/send", {
      items: previewItems, cc, bcc, interval: +$("#interval").value || 0,
      attachment_ids: STATE.attachments.map(a => a.id), exhibition: STATE.gen.exhibition, template_name: "AI模板-" + STATE.gen.exhibition
    });
    if (r.ok) {
      const ok = r.data.results.filter(x => x.status === "success").length;
      const fail = r.data.results.length - ok;
      const demo = r.data.demo_mode ? "（演示模式：未实际外发，已写入日志；配置 SMTP 后可真实发送）" : "";
      closeModal();
      toast(`发送完成：成功 ${ok} 封，失败 ${fail} 封 ${demo}`);
    } else toast("发送失败：" + (r.data.error || ""));
  };
}

function viewTemplates() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "📚 我的邮件模板库"));
  wrap.appendChild(el("div", { class: "section-sub" }, "所有生成的邮件模板均可保存复用，下次直接调用，无需重新 AI 生成"));
  api("GET", "/api/templates").then(r => {
    const list = r.data || [];
    if (!list.length) { wrap.appendChild(el("div", { class: "empty" }, "暂无模板，去「AI 生成邮件」保存第一份吧")); return; }
    const t = el("table", { class: "tbl" });
    t.appendChild(el("tr", {}, ["名称", "展会", "客户类型", "场景", "语气", "操作"].map(h => el("th", {}, h))));
    list.forEach(tp => {
      const tr = el("tr");
      tr.appendChild(el("td", {}, tp.name || "未命名"));
      tr.appendChild(el("td", {}, tp.exhibition || "-"));
      tr.appendChild(el("td", {}, tp.customer_type || "-"));
      tr.appendChild(el("td", {}, tp.scene || "-"));
      tr.appendChild(el("td", {}, tp.tone || "-"));
      const td = el("td");
      const use = el("button", { class: "btn btn-sm" }, "调用编辑");
      use.onclick = () => { STATE.gen = { exhibition: tp.exhibition, customer_type: tp.customer_type, scene: SCENES.find(s => s[1] === tp.scene)?.[0] || "", tone: tp.tone, custom: "", subject: tp.subject, body: tp.body };
        STATE.view = "ai"; STATE.sub = "gen"; render();
        setTimeout(() => { if ($("#pv-subject")) { $("#pv-subject").value = tp.subject; $("#pv-body").value = tp.body; } }, 50);
        toast("已载入模板，可修改后发送");
      };
      const del = el("button", { class: "btn btn-sm btn-danger ml8" }, "删除");
      del.onclick = async () => { await api("DELETE", "/api/templates/" + tp.id); render(); };
      td.appendChild(use); td.appendChild(del); tr.appendChild(td);
      t.appendChild(tr);
    });
    wrap.appendChild(t);
  });
  return wrap;
}
function viewLogs() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "📜 邮件记录 / 发送日志"));
  wrap.appendChild(el("div", { class: "section-sub" }, "记录每一封邮件：展会名称、模板、接收客户、发送时间、状态（成功/失败），可查看已发送原文"));
  api("GET", "/api/email-logs").then(r => {
    const list = r.data || [];
    if (!list.length) { wrap.appendChild(el("div", { class: "empty" }, "暂无发送记录")); return; }
    const t = el("table", { class: "tbl" });
    t.appendChild(el("tr", {}, ["时间", "展会", "模板", "接收客户", "邮箱", "状态", "操作"].map(h => el("th", {}, h))));
    list.forEach(l => {
      const tr = el("tr");
      tr.appendChild(el("td", {}, l.sent_at));
      tr.appendChild(el("td", {}, l.exhibition || "-"));
      tr.appendChild(el("td", {}, l.template_name || "-"));
      tr.appendChild(el("td", {}, l.customer_company || "-"));
      tr.appendChild(el("td", {}, l.email || "-"));
      tr.appendChild(el("td", { html: l.status === "success" ? '<span class="status-ok">成功</span>' : '<span class="status-fail">失败</span>' + (l.error ? '<br><span class="muted">' + esc(l.error) + '</span>' : "") }));
      const td = el("td");
      const view = el("button", { class: "btn btn-sm" }, "查看原文");
      view.onclick = () => openModal("已发送邮件原文", `<div class="preview-item"><div class="to">收件：${esc(l.contact || '')} &lt;${esc(l.email || '')}&gt;</div><div class="ps"><b>${esc(l.subject)}</b><br><br>${esc(l.body).replace(/\n/g, "<br>")}</div></div>`);
      td.appendChild(view);
      // 纯前端模式才有 .eml 文件；后端模式邮件已真实发出，无需下载
      if (window.__MODE !== "backend") {
        const dl = el("button", { class: "btn btn-sm ml8" }, "下载 .eml");
        dl.onclick = () => downloadEML(l);
        td.appendChild(dl);
      }
      tr.appendChild(td);
      t.appendChild(tr);
    });
    wrap.appendChild(t);
  });
  return wrap;
}

/* ================= 客户管理 ================= */
function viewCustomers() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "👥 客户列表"));
  wrap.appendChild(el("div", { class: "section-sub" }, "支持 Excel 批量导入（另存为 CSV）｜ 字段：客户公司、联系人、邮箱、手机号、意向展会、客户标签｜ 勾选后可批量删除"));
  const bar = el("div", { class: "action-bar" });
  const add = el("button", { class: "btn btn-primary" }, "＋ 新增客户");
  add.onclick = addCustomerModal;
  const imp = el("button", { class: "btn" }, "📥 Excel/CSV 批量导入");
  imp.onclick = importModal;
  const selAll = el("button", { class: "btn" }, "☑ 全选");
  const selNone = el("button", { class: "btn" }, "☐ 取消全选");
  const delBatch = el("button", { class: "btn btn-danger" }, "🗑 批量删除");
  const selInfo = el("span", { class: "muted", id: "cust-sel-info", style: "font-size:12px" }, "已选 0 项");
  bar.appendChild(add); bar.appendChild(imp); bar.appendChild(selAll); bar.appendChild(selNone); bar.appendChild(delBatch); bar.appendChild(selInfo);
  wrap.appendChild(bar);
  const listBox = el("div", { id: "cust-list" });
  wrap.appendChild(listBox);
  renderCustomerTable(listBox);
  selAll.onclick = async () => {
    const r = await api("GET", "/api/customers"); const list = r.data || [];
    window._custSel = new Set(list.map(c => String(c.id)));
    renderCustomerTable(listBox);
  };
  selNone.onclick = () => {
    window._custSel = new Set();
    renderCustomerTable(listBox);
  };
  delBatch.onclick = async () => {
    const ids = Array.from(window._custSel || new Set());
    if (!ids.length) { toast("请先勾选要删除的客户"); return; }
    if (!confirm("确定删除选中的 " + ids.length + " 位客户吗？此操作不可恢复。")) return;
    const r = await api("POST", "/api/customers/batch-delete", { ids });
    if (!r.ok) { toast("删除失败：" + (r.data && r.data.error || "")); return; }
    const n = (r.data && r.data.deleted) || ids.length;
    window._custSel = new Set();
    renderCustomerTable(listBox);
    toast("已删除 " + n + " 位客户");
  };
  return wrap;
}
async function renderCustomerTable(target) {
  const r = await api("GET", "/api/customers"); const list = r.data || [];
  if (!window._custSel) window._custSel = new Set();
  target.innerHTML = "";
  if (!list.length) { target.appendChild(el("div", { class: "empty" }, "暂无客户，点击「新增」或「批量导入」")); return; }
  const t = el("table", { class: "tbl" });
  t.appendChild(el("tr", {}, ["", "客户公司", "联系人", "邮箱", "手机号", "意向展会", "状态", "标签", "操作"].map(h => el("th", {}, h))));
  list.forEach(c => {
    const tr = el("tr");
    const chk = el("input", { type: "checkbox", class: "cust-chk", value: String(c.id) });
    if (window._custSel.has(String(c.id))) chk.checked = true;
    chk.onchange = () => {
      if (chk.checked) window._custSel.add(String(c.id)); else window._custSel.delete(String(c.id));
      const info = document.getElementById("cust-sel-info");
      if (info) info.textContent = "已选 " + window._custSel.size + " 项";
    };
    const td0 = el("td"); td0.appendChild(chk); tr.appendChild(td0);
    tr.appendChild(el("td", {}, c.company || "-"));
    tr.appendChild(el("td", {}, c.contact || "-"));
    tr.appendChild(el("td", {}, c.email || "-"));
    tr.appendChild(el("td", {}, c.phone || "-"));
    tr.appendChild(el("td", {}, c.exhibition || "-"));
    // 状态列（颜色标记）
    const st = c.status || "潜在客户";
    const cfg = CUSTOMER_STATUS[st] || CUSTOMER_STATUS["潜在客户"];
    const stTd = el("td");
    const stBadge = el("span", { class: "pill", style: `background:${cfg.color};color:#fff;font-size:11px;font-weight:600` }, cfg.label);
    if (st === "成交客户") stBadge.style.cssText += ";animation:pulse-red 1.5s infinite;";
    stTd.appendChild(stBadge);
    tr.appendChild(stTd);
    tr.appendChild(el("td", {}, (c.tags || "").split(",").filter(Boolean).map(tg => `<span class="pill">${esc(tg)}</span>`).join("") || "-"));
    const td = el("td");
    const editBtn = el("button", { class: "btn btn-sm" }, "编辑");
    editBtn.onclick = () => editCustomerModal(c, target);
    const del = el("button", { class: "btn btn-sm btn-danger" }, "删除");
    del.onclick = async () => { await api("DELETE", "/api/customers/" + c.id); window._custSel.delete(String(c.id)); renderCustomerTable(target); };
    td.appendChild(editBtn); td.appendChild(del); tr.appendChild(td);
    t.appendChild(tr);
  });
  const info = document.getElementById("cust-sel-info");
  if (info) info.textContent = "已选 " + window._custSel.size + " 项";
  target.appendChild(t);
}
function addCustomerModal() {
  const statusOpts = STATUS_OPTIONS.map(s => `<option value="${s}">${s}</option>`).join("");
  const html = `<div class="cfg-row"><label>客户公司 *</label><input id="c-company" class="inp"></div>
    <div class="cfg-row"><label>联系人</label><input id="c-contact" class="inp"></div>
    <div class="cfg-row"><label>邮箱</label><input id="c-email" class="inp"></div>
    <div class="cfg-row"><label>手机号</label><input id="c-phone" class="inp"></div>
    <div class="cfg-row"><label>意向展会</label><input id="c-ex" class="inp"></div>
    <div class="cfg-row"><label>客户状态</label><select id="c-status" class="inp">${statusOpts}</select></div>
    <div class="cfg-row"><label>客户标签（逗号分隔）</label><input id="c-tags" class="inp" placeholder="预制菜客户,高意向"></div>
    <button class="btn btn-primary btn-block" id="c-save">保存</button>`;
  openModal("新增客户", html);
  $("#c-save").onclick = async () => {
    if (!$("#c-company").value.trim()) { toast("客户公司必填"); return; }
    await api("POST", "/api/customers", { company: $("#c-company").value.trim(), contact: $("#c-contact").value, email: $("#c-email").value, phone: $("#c-phone").value, exhibition: $("#c-ex").value, status: $("#c-status").value, tags: $("#c-tags").value });
    closeModal(); toast("客户已添加"); render();
  };
}
function editCustomerModal(c, target) {
  const curStatus = c.status || "潜在客户";
  const statusOpts = STATUS_OPTIONS.map(s => `<option value="${s}" ${s === curStatus ? "selected" : ""}>${s}</option>`).join("");
  const html = `<div class="cfg-row"><label>客户公司 *</label><input id="c-company" class="inp" value="${esc(c.company || "")}"></div>
    <div class="cfg-row"><label>联系人</label><input id="c-contact" class="inp" value="${esc(c.contact || "")}"></div>
    <div class="cfg-row"><label>邮箱</label><input id="c-email" class="inp" value="${esc(c.email || "")}"></div>
    <div class="cfg-row"><label>手机号</label><input id="c-phone" class="inp" value="${esc(c.phone || "")}"></div>
    <div class="cfg-row"><label>意向展会</label><input id="c-ex" class="inp" value="${esc(c.exhibition || "")}"></div>
    <div class="cfg-row"><label>客户状态</label><select id="c-status" class="inp">${statusOpts}</select></div>
    <div class="cfg-row"><label>客户标签（逗号分隔）</label><input id="c-tags" class="inp" placeholder="预制菜客户,高意向" value="${esc(c.tags || "")}"></div>
    <button class="btn btn-primary btn-block" id="c-save">保存修改</button>`;
  openModal("编辑客户", html);
  $("#c-save").onclick = async () => {
    if (!$("#c-company").value.trim()) { toast("客户公司必填"); return; }
    await api("PUT", "/api/customers/" + c.id, { company: $("#c-company").value.trim(), contact: $("#c-contact").value, email: $("#c-email").value, phone: $("#c-phone").value, exhibition: $("#c-ex").value, status: $("#c-status").value, tags: $("#c-tags").value });
    closeModal(); toast("客户已更新"); if (target) renderCustomerTable(target); else render();
  };
}
function importModal() {
  const html = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <label class="btn btn-primary" style="cursor:pointer;margin:0;display:inline-flex;align-items:center;gap:4px">
        📁 选择文件上传（CSV / Excel）
        <input type="file" id="imp-file" accept=".csv,.xlsx,.xls" style="display:none">
      </label>
      <button class="btn btn-sm" id="dl-tpl" style="background:#10b981;color:#fff;border-color:#059669">📥 下载导入模板</button>
      <span id="imp-file-name" class="muted" style="font-size:12px">未选择文件</span>
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">
      支持格式：<b>.xlsx / .xls</b>（推荐，后端可靠解析）｜ <b>.csv</b><br>
      ✅ <b>自动识别列名</b>：只要表格中有「公司名称」「联系人」「邮箱」即可（列名含这些关键字就认）<br>
      ✅ 不要求固定格式、不要求固定列顺序，任意 Excel 表格都能导
    </div>
    <div style="border-top:1px dashed #d1d5db;margin:10px 0;padding-top:8px;font-size:12px;color:#6b7280">或者直接粘贴 CSV 内容：</div>
    <textarea id="imp-csv" class="inp" style="min-height:140px" placeholder="销售跟进情况表模板会自动识别列名&#10;或标准格式：客户公司,联系人,邮箱,手机号,意向展会,客户标签"></textarea>
    <button class="btn btn-primary btn-block" id="imp-go" style="margin-top:10px">📥 导入客户</button>`;
  openModal("批量导入客户（支持文件上传）", html);

  // 下载导入模板（CSV 格式，Excel 可直接打开）
  $("#dl-tpl").onclick = () => {
    const BOM = "\uFEFF";
    const csv = BOM + "客户公司,联系人,邮箱,手机号,意向展会,客户标签\n" +
      "XX食品有限公司,张经理,zhang@xxfood.com,13800138000,SIAL Paris 2026,预制菜客户\n" +
      "YY食品集团,李总,li@yygroup.com,13900139000,Anuga 2026,调味品客户,高意向\n" +
      "ZZ原料工厂,王工,wang@zzraw.com,13700137000,Foodex Japan 2026,原料客户,待跟进";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "客户导入模板.csv";
    a.click(); URL.revokeObjectURL(url);
    toast("模板已下载，用 Excel 打开填写后导入即可");
  };

  // 文件上传处理 —— Excel 转 base64 后交由后端 openpyxl 可靠解析
  const fileInput = $("#imp-file");
  const fileName = $("#imp-file-name");
  let pendingFile = null;

  fileInput.onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    pendingFile = f;
    fileName.textContent = "已选择：" + f.name + "（" + (f.size/1024).toFixed(1) + "KB）";
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'csv') {
      try { const text = await f.text(); $("#imp-csv").value = text; toast("已加载 CSV：" + f.name); }
      catch(err) { toast("文件读取失败：" + err.message); }
    } else if (ext === 'xlsx' || ext === 'xls') {
      $("#imp-csv").value = "[✅ Excel 已就绪，点击「导入客户」自动解析导入]";
      toast("已选择 Excel，将交由后端智能识别列名并导入");
    } else { toast("不支持的格式，请用 .csv / .xlsx"); pendingFile = null; }
  };

  $("#imp-go").onclick = async () => {
    // Excel → FileReader base64 → 后端 openpyxl 解析
    if (pendingFile && (pendingFile.name.endsWith('.xlsx') || pendingFile.name.endsWith('.xls'))) {
      toast("正在上传并解析 Excel…");
      try {
        const reader = new FileReader();
        const b64 = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(pendingFile);
        });
        const r = await api("POST", "/api/customers/upload-excel", {
          file_base64: b64, filename: pendingFile.name
        });
        if (r.ok) {
          const d = r.data || {};
          let msg = "✅ 成功导入 " + (d.imported ?? 0) + " 位客户";
          if (d.detected_columns) {
            const c = [];
            if (d.detected_columns.company !== undefined) c.push("公司名✓"); else c.push("公司名✗");
            if (d.detected_columns.contact !== undefined) c.push("联系人✓"); else c.push("联系人✗");
            if (d.detected_columns.email !== undefined) c.push("邮箱✓"); else c.push("邮箱✗（需手动补充）");
            if (d.detected_columns.phone !== undefined) c.push("电话✓");
            msg += "\n📋 识别列：" + c.join(" | ");
          }
          if (d.preview && d.preview.length > 0)
            msg += "\n前几条：" + d.preview.slice(0,3).map(p => p.company || "(无公司名)").join(", ");
          // 导入0行时显示诊断信息
          if ((d.imported ?? 0) === 0 && d.diagnostic) {
            const diag = d.diagnostic;
            msg += "\n\n⚠️ 未导入任何数据，可能原因：";
            msg += "\n• 文件表头(列名): " + (diag.headers || []).join(" / ");
            if (diag.skipped_empty_company > 0)
              msg += "\n• 共 " + diag.total_rows + " 行数据，但 " + diag.skipped_empty_company + " 行的'公司名'列为空";
            if (diag.sample_skipped_rows && diag.sample_skipped_rows.length > 0)
              msg += "\n• 示例数据: " + diag.sample_skipped_rows.map(r => JSON.stringify(r)).join(" | ");
          }
          closeModal(); toast(msg); render();
        } else { toast("❌ 导入失败：" + (r.error || "")); }
      } catch(err) { toast("❌ 上传异常：" + err.message); }
      return;
    }
    // CSV 或粘贴文本
    if (!$("#imp-csv").value.trim() || $("#imp-csv").value.startsWith("[Excel") || $("#imp-csv").value.startsWith("[✅")) {
      toast("请先上传 Excel/CSV 文件或粘贴内容"); return;
    }
    const r = await api("POST", "/api/customers/import", { csv: $("#imp-csv").value });
    if (r.ok) { let msg = "✅ 成功导入 " + r.data.imported + " 位客户"; closeModal(); toast(msg); render(); }
    else toast("导入失败：" + (r.data.error || ""));
  };
}

/* 简易 Excel (.xlsx) 解析器 - 纯 JS 无依赖 */
function parseExcelBuffer(buf, ext) {
  try {
    const bytes = new Uint8Array(buf);
    if (ext === 'xls') return parseXLS(bytes);
    return parseXLSX(bytes);
  } catch(e) { return []; }
}
function parseXLSX(bytes) {
  /* 简易 XLSX ZIP 解包 + SharedStrings + Sheet1 XML 解析
     仅处理最常见的 OOXML 格式，覆盖绝大多数 Excel 文件 */
  const rows = [];
  // 找 ZIP 分段记录
  const view = new DataView(bytes.buffer || bytes);
  const len = bytes.length;
  // PK header check
  if (len < 4 || view.getUint32(0,true)!==0x04034b50) throw new Error("非有效 XLSX 文件");
  const files = {};
  let pos = 0;
  while (pos < len) {
    if (view.getUint32(pos,true)!==0x04034b50) break;
    const comp = view.getUint16(pos+8,true);
    const csize = view.getUint32(pos+18,true);
    const usize = view.getUint32(pos+22,true);
    const fnLen = view.getUint16(pos+26,true);
    let fname = "";
    for(let i=0;i<fnLen;i++) fname += String.fromCharCode(view.getUint8(pos+28+i));
    let dataStart = pos + 30 + fnLen;
    if (comp===8) { // stored
      files[fname] = bytes.slice(dataStart, dataStart + usize);
    } else if (comp===0) { // no compression
      files[fname] = bytes.slice(dataStart, dataStart + csize);
    }
    pos = dataStart + csize;
  }
  // 解析 shared strings
  let ss = [];
  if (files['xl/sharedStrings.xml']) {
    const ssXml = decodeUTF8(files['xl/sharedStrings.xml']);
    const si = ssXml.match(/<si[^>]*>[\s\S]*?<\/si>/g)||[];
    si.forEach(s => { const t = s.match(/<t[^>]*>([^<]*)<\/t>/g); ss.push(t?t.map(x=>x.replace(/<[^>]+>/g,'')).join(''):'' ); });
  }
  // 解析 sheet1
  let sheetXml = '';
  for (const k in files) { if (k.match(/xl\/worksheets\/sheet\d*\.xml/i)) { sheetXml=decodeUTF8(files[k]); break; } }
  if (!sheetXml) return rows;
  // 提取行
  const rowMatches = sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g)||[];
  rowMatches.forEach(rm => {
    const cells = [];
    const cellMatches = rm.match(/<c\s+r="([A-Z]+)(\d+)"[^>]*>(?:<v>([^<]*)<\/v>)?/g)||[];
    // 按列排序
    const cellMap = {};
    (rm.match(/<c\s+r="([A-Z]+)(\d+)"(?:\s[^>]*)?>(?:<v>([^<]*)<\/v>)?\s*(?:<is><t>([^<]*)<\/t><\/is>)?/g)||[]).forEach(cm=>{
      const m = cm.match(/<c\s+r="([A-Z]+)(\d+)"(?:\s[^>]*)?>(?:<v>([^<]*)<\/v>)?\s*(?:<is><t>([^<]*)<\/t><\/is>)?/);
      if(m) cellMap[m[1]] = m[4]||(m[3]!==undefined?(ss[+m[3]]||m[3]):'');
    });
    // 按字母顺序排列
    Object.keys(cellMap).sort().forEach(k => cells.push(cellMap[k]));
    if(cells.length) rows.push(cells);
  });
  return rows;
}
function parseXLS(bytes) {
  /* BIFF 格式提示 */
  throw new Error(".xls 旧格式暂不支持，请将文件另存为 .xlsx 或 .csv 格式后重试");
}
function decodeUTF8(arr) {
  if (typeof arr === 'string') return arr;
  const u = new Uint8Array(arr);
  let s = ''; for(let i=0;i<u.length;i++) s += String.fromCharCode(u[i]);
  try { return decodeURIComponent(escape(s)); } catch(e){ return s; }
}
function viewTags() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "🏷 客户标签管理"));
  wrap.appendChild(el("div", { class: "section-sub" }, "点击标签可筛选该标签下的客户，方便批量操作"));

  const resultArea = el("div"); // 筛选结果区域（最后插入，位于标签操作栏下方）

  Promise.all([api("GET", "/api/tags"), api("GET", "/api/customers")]).then(async ([tr, cr]) => {
    let tags = tr.data || [];
    const customers = cr.data || [];

    // 统计每个标签的客户数
    const tagCount = {};
    customers.forEach(c => {
      (c.tags || "").split(",").filter(Boolean).forEach(tg => {
        tagCount[tg] = (tagCount[tg] || 0) + 1;
      });
    });

    if (!tags.length) {
      const presets = ["预制菜客户", "调味品客户", "零食客户", "原料客户", "高意向", "待跟进"];
      for (const p of presets) await api("POST", "/api/tags", { name: p });
      tags = (await api("GET", "/api/tags")).data || [];
    }

    const box = el("div", { class: "card" });

    // 新增标签表单
    const addForm = el("div", { class: "flex" });
    const inp = el("input", { class: "inp", placeholder: "新增标签名" });
    const add = el("button", { class: "btn btn-primary" }, "＋ 新增");
    add.onclick = async () => { if (!inp.value.trim()) return; const rr = await api("POST", "/api/tags", { name: inp.value.trim() }); if (!rr.ok) toast(rr.data.error || ""); else { inp.value = ""; render(); } };
    addForm.appendChild(inp); addForm.appendChild(add); box.appendChild(addForm);

    // 标签列表（可点击筛选）
    const tagsBox = el("div", { style: "margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center" });
    // 「查看全部」按钮
    const showAllBtn = el("button", { class: "btn btn-sm", style: "background:#3b82f6;color:#fff" }, `📋 查看全部客户（${customers.length}）`);
    showAllBtn.onclick = () => showCustomerResult(customers, "全部客户", resultArea);
    tagsBox.appendChild(showAllBtn);
    tagsBox.appendChild(el("span", { style: "color:#9ca3af;margin:0 4px" }, "|"));

    tags.forEach(t => {
      const count = tagCount[t.name] || 0;
      const pill = el("span", {
        class: "pill",
        style: "cursor:pointer;user-select:none;" + (count > 0 ? "background:#dbeafe;color:#1d4ed8;border-color:#93c5fd" : ""),
        title: count > 0 ? `点击筛选 ${count} 个客户` : "暂无客户使用此标签"
      }, t.name + ` (${count}) `);
      pill.onclick = () => {
        if (count === 0) { toast(`暂无标记为「${t.name}」的客户`); return; }
        const filtered = customers.filter(c => (c.tags || "").split(",").some(tg => tg.trim() === t.name));
        showCustomerResult(filtered, t.name, resultArea);
      };
      const x = el("span", { style: "cursor:pointer;color:#dc2626;margin-left:2px" }, "×");
      x.onclick = async (ev) => { ev.stopPropagation(); await api("DELETE", "/api/tags/" + t.id); render(); };
      pill.appendChild(x); tagsBox.appendChild(pill);
    });
    box.appendChild(tagsBox); wrap.appendChild(box);

    // 客户列表表格放在标签操作栏下方，默认显示全部客户
    wrap.appendChild(resultArea);
    showCustomerResult(customers, "全部客户", resultArea);
  });
  return wrap;
}

/** 在标签页的结果区域显示筛选后的客户表格 */
function showCustomerResult(list, tagName, container) {
  container.innerHTML = "";
  if (!list.length) {
    const emptyText = tagName === "全部客户" ? "暂无客户" : `没有标记为「${tagName}」的客户`;
    container.appendChild(el("div", { class: "empty" }, emptyText));
    return;
  }
  const t = el("table", { class: "tbl" });
  t.appendChild(el("tr", {}, ["客户公司", "联系人", "邮箱", "手机号", "意向展会", "标签"].map(h => el("th", {}, h))));
  list.forEach(c => {
    const tr = el("tr");
    tr.appendChild(el("td", {}, c.company || "-"));
    tr.appendChild(el("td", {}, c.contact || "-"));
    tr.appendChild(el("td", {}, c.email || "-"));
    tr.appendChild(el("td", {}, c.phone || "-"));
    tr.appendChild(el("td", {}, c.exhibition || "-"));
    tr.appendChild(el("td", {}, (c.tags || "").split(",").filter(Boolean).map(tg => `<span class="pill">${esc(tg)}</span>`).join("") || "-"));
    t.appendChild(tr);
  });
  const header = el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px" });
  const titleText = tagName === "全部客户" ? `📋 全部客户 — 共 ${list.length} 位` : `📋 ${tagName} — 共 ${list.length} 位客户`;
  header.appendChild(el("span", { style: "font-weight:bold;font-size:14px" }, titleText));
  container.appendChild(header);
  container.appendChild(t);
}

/* ================= 展会资料库 ================= */
function viewExpo() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "📁 展会资料库"));
  wrap.appendChild(el("div", { class: "section-sub" }, "上传展位资料、展会手册 PDF，发送邮件时可一键绑定为附件"));
  const upbar = el("div", { class: "action-bar" });
  const up = el("button", { class: "btn btn-primary" }, "⬆ 上传资料");
  up.onclick = uploadModal;
  upbar.appendChild(up); wrap.appendChild(upbar);
  // 提示：资料默认绑定到具体展会（不再默认"通用"）
  const hint = el("div", { class: "muted", style: "font-size:13px;margin:4px 0 12px;padding:8px 12px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;color:#7a5a00" },
    "💡 建议每个资料都指定所属展会——这样在「AI 邮件模板中心」选择目标展会时，可以自动勾选该展会下的所有资料，邮件内容会真正反映最新资料。");
  wrap.appendChild(hint);
  api("GET", "/api/materials").then(async r => {
    const mats = r.data || [];
    const exs = (await api("GET", "/api/exhibitions")).data || [];
    const exName = id => (exs.find(e => e.id == id) || {}).name || "通用";
    if (!mats.length) { wrap.appendChild(el("div", { class: "empty" }, "暂无资料，点击「⬆ 上传资料」开始添加")); return; }
    const t = el("table", { class: "tbl" });
    t.appendChild(el("tr", {}, ["资料名称", "所属展会", "上传时间", "操作"].map(h => el("th", {}, h))));
    mats.forEach(m => {
      const tr = el("tr");
      tr.appendChild(el("td", {}, m.name));
      tr.appendChild(el("td", {}, exName(m.exhibition_id)));
      tr.appendChild(el("td", {}, m.created_at));
      const td = el("td");
      const edit = el("button", { class: "btn btn-sm", style: "margin-right:6px" }, "✏️ 编辑");
      edit.onclick = () => editMaterialModal(m, exs);
      const del = el("button", { class: "btn btn-sm btn-danger" }, "删除");
      del.onclick = async () => {
        if (!confirm("确认删除资料「" + m.name + "」？此操作不可恢复。")) return;
        await api("DELETE", "/api/materials/" + m.id);
        toast("已删除"); render();
      };
      td.appendChild(edit); td.appendChild(del); tr.appendChild(td); t.appendChild(tr);
    });
    wrap.appendChild(t);
  });
  return wrap;
}

async function editMaterialModal(m, exs) {
  exs = exs || (await api("GET", "/api/exhibitions")).data || [];
  const html = `<div class="cfg-row">
    <label>资料名称</label>
    <input id="em-name" class="inp" value="${esc(m.name || '')}">
  </div>
  <div class="cfg-row">
    <label>所属展会 <span style="font-size:11px;color:#888;font-weight:normal">（可输入新名称或选择已有）</span></label>
    <input id="em-ex" class="inp" list="em-ex-dl" value="${esc(exName(m.exhibition_id, exs))}" placeholder="输入或选择展会名称">
    <datalist id="em-ex-dl">${exs.map(e => `<option value="${esc(e.name)}">`).join("")}</datalist>
  </div>
  <div class="cfg-row">
    <label>替换文件（可选，不选则保留原文件）</label>
    <input id="em-file" type="file" class="inp">
    <div class="muted" style="font-size:12px;margin-top:4px">支持 PDF / Word / Excel / 图片，新文件将覆盖旧文件</div>
  </div>
  <button class="btn btn-primary btn-block" id="em-go">保存</button>`;
  openModal("编辑资料", html);
  $("#em-go").onclick = async () => {
    const newName = ($("#em-name").value || "").trim() || m.name;
    const exName = ($("#em-ex").value || "").trim();
    const body = { name: newName };
    if (exName) body.exhibition_id = exName; // 后端会判断是 ID 还是字符串
    const f = $("#em-file").files[0];
    if (f) {
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(f); });
      body.content_b64 = b64;
    }
    const r = await api("PATCH", "/api/materials/" + m.id, body);
    if (!r.ok) { toast("保存失败：" + (r.data.error || "")); return; }
    closeModal(); toast("已保存"); render();
  };
}

async function uploadModal() {
  const exs = (await api("GET", "/api/exhibitions")).data || [];
  // 不再默认「通用」——但允许用户主动选「通用」作为兜底
  const html = `<div class="cfg-row"><label>资料名称</label><input id="m-name" class="inp" placeholder="如：SIAL展位图2026.pdf"></div>
    <div class="cfg-row">
      <label>所属展会 <span style="font-size:11px;color:#D35400;font-weight:normal">★ 必选（在下方选择或输入新展会）</span></label>
      <input id="m-ex" class="inp" list="m-ex-dl" placeholder="输入新展会名称或选择已有">
      <datalist id="m-ex-dl">${exs.map(e => `<option value="${esc(e.name)}">`).join("")}</datalist>
      <div class="muted" style="font-size:12px;margin-top:4px">输入新名称将自动创建该展会；选择已有则绑定到该展会</div>
    </div>
    <div class="cfg-row"><label>选择文件（PDF/Word/图片）</label><input id="m-file" type="file" class="inp" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.csv"></div>
    <button class="btn btn-primary btn-block" id="m-go">上传</button>`;
  openModal("上传展会资料", html);
  $("#m-go").onclick = async () => {
    const f = $("#m-file").files[0];
    if (!f) { toast("请选择文件"); return; }
    const exName = ($("#m-ex").value || "").trim();
    if (!exName) { toast("请输入或选择所属展会（不再默认『通用』）"); return; }
    const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(f); });
    // 如果输入了展会名称，先查找或创建
    let exId = null;
    const matched = exs.find(e => e.name === exName);
    if (matched) { exId = matched.id; }
    else {
      const cr = await api("POST", "/api/exhibitions", { name: exName, city: "", date_text: "", note: "" });
      if (cr.ok) {
        exId = cr.data?.id;
        toast("已自动新建展会：" + exName);
      } else {
        toast("新建展会失败：" + (cr.data.error || "")); return;
      }
    }
    const r = await api("POST", "/api/materials", { name: $("#m-name").value || f.name, exhibition_id: exId, content_b64: b64 });
    if (!r.ok) { toast("上传失败：" + (r.data.error || "")); return; }
    closeModal(); toast("资料已上传"); render();
  };
}

function exName(id, exs) {
  return (exs.find(e => e.id == id) || {}).name || "通用";
}

/* ================= 展会管理（独立二级页面） ================= */
function viewExposManage() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "📅 展会管理"));
  wrap.appendChild(el("div", { class: "section-sub" }, "在此维护展会信息：名称、城市、档期、备注。新建展会后，可在「AI 邮件模板中心」自动出现在目标展会下拉里。"));
  const bar = el("div", { class: "action-bar" });
  const btnNew = el("button", { class: "btn btn-primary" }, "➕ 新建展会");
  btnNew.onclick = () => editExhibitionModal(null);
  bar.appendChild(btnNew);
  const btnImport = el("button", { class: "btn", style: "margin-left:8px;background:#f0fdf4;color:#166534;border-color:#86efac" }, "📥 批量导入（Excel/表格）");
  btnImport.onclick = openExpoImportModal;
  bar.appendChild(btnImport);
  const btnRefresh = el("button", { class: "btn", style: "margin-left:8px" }, "🔄 刷新");
  btnRefresh.onclick = () => render();
  bar.appendChild(btnRefresh);
  wrap.appendChild(bar);
  // 异步加载列表（同步外壳 + 异步填充，避免 Promise 被 appendChild 导致白屏）
  const listArea = el("div");
  wrap.appendChild(listArea);
  (async () => {
    try {
      const r = await api("GET", "/api/exhibitions/summary");
      const exs = r.data || [];
      if (!exs.length) {
        listArea.innerHTML = `<div style="text-align:center;padding:40px 20px;color:#94a3b8;font-size:14px">
          <div style="font-size:36px;margin-bottom:10px">📭</div>
          暂无展会，点击上方「➕ 新建展会」开始<br>
          <span style="font-size:12px;color:#b0b8c4">提示：新建的展会会立即出现在「AI 邮件模板中心」的目标展会下拉中</span>
        </div>`;
        return;
      }
      const t = el("table", { class: "tbl" });
      t.appendChild(el("tr", {}, ["#", "展会名称", "城市", "档期", "备注", "资料数", "归属", "操作"].map(h => el("th", {}, h))));
      exs.forEach((e, idx) => {
        const tr = el("tr");
        tr.appendChild(el("td", {}, String(idx + 1)));
        tr.appendChild(el("td", {}, e.name || ""));
        tr.appendChild(el("td", {}, e.city || "—"));
        tr.appendChild(el("td", {}, e.date_text || "—"));
        tr.appendChild(el("td", {}, e.note || "—"));
        tr.appendChild(el("td", { style: "text-align:center;font-weight:bold;color:" + (e.material_count > 0 ? "#D35400" : "#999") },
          String(e.material_count || 0)));
        tr.appendChild(el("td", {}, e.user_id == 0 ? "🌐 系统" : "👤 我的"));
        const td = el("td");
        const e1 = el("button", { class: "btn btn-sm", style: "margin-right:6px" }, "✏️ 编辑");
        e1.onclick = () => editExhibitionModal(e);
        td.appendChild(e1);
        if (e.user_id != 0) {
          const d1 = el("button", { class: "btn btn-sm btn-danger" }, "删除");
          d1.onclick = async () => {
            const cnt = e.material_count || 0;
            let msg = "确认删除展会「" + e.name + "」？";
            if (cnt > 0) msg += "该展会下有 " + cnt + " 个资料，删除后这些资料的『所属展会』会变成『通用』。";
            if (!confirm(msg)) return;
            const r2 = await api("DELETE", "/api/exhibitions/" + e.id);
            if (!r2.ok) { toast("删除失败：" + (r2.data.error || "")); return; }
            toast("已删除"); render();
          };
          td.appendChild(d1);
        } else {
          td.appendChild(el("span", { class: "muted", style: "font-size:12px" }, "系统级不可删"));
        }
        tr.appendChild(td);
        t.appendChild(tr);
      });
      listArea.innerHTML = "";
      listArea.appendChild(t);
    } catch (err) {
      listArea.innerHTML = `<div style="text-align:center;padding:40px;color:#ef4444;font-size:14px">
        ⚠️ 加载失败：${esc(err.message || "未知错误")}<br>
        <button class="btn btn-sm" style="margin-top:10px" onclick="render()">重试</button>
      </div>`;
    }
  })();
  return wrap;
}

async function editExhibitionModal(e) {
  const isNew = !e;
  const html = `<div class="cfg-row">
    <label>展会名称 <span style="color:#D35400">★</span></label>
    <input id="ex-name" class="inp" value="${esc(e?.name || '')}" placeholder="如：迪拜配料展 2027">
  </div>
  <div class="cfg-row">
    <label>举办城市</label>
    <input id="ex-city" class="inp" value="${esc(e?.city || '')}" placeholder="如：阿联酋迪拜">
  </div>
  <div class="cfg-row">
    <label>展期（可写年份或具体日期）</label>
    <input id="ex-date" class="inp" value="${esc(e?.date_text || '')}" placeholder="如：2027-02-15 ~ 02-19 或 2027 年 2 月">
  </div>
  <div class="cfg-row">
    <label>备注 / 亮点</label>
    <textarea id="ex-note" class="inp" rows="3" placeholder="如：聚焦食品配料与添加剂；上届 2000+ 参展商；中东最大食品行业盛会">${esc(e?.note || '')}</textarea>
  </div>
  <button class="btn btn-primary btn-block" id="ex-go">${isNew ? "新建" : "保存"}</button>`;
  openModal(isNew ? "新建展会" : "编辑展会「" + (e.name || "") + "」", html);
  $("#ex-go").onclick = async () => {
    const name = ($("#ex-name").value || "").trim();
    if (!name) { toast("展会名称必填"); return; }
    const body = {
      name,
      city: ($("#ex-city").value || "").trim(),
      date_text: ($("#ex-date").value || "").trim(),
      note: ($("#ex-note").value || "").trim(),
    };
    let r;
    if (isNew) r = await api("POST", "/api/exhibitions", body);
    else r = await api("PATCH", "/api/exhibitions/" + e.id, body);
    if (!r.ok) { toast("保存失败：" + (r.data.error || "")); return; }
    closeModal(); toast(isNew ? "已新建：" + name : "已保存"); render();
  };
}

/* ---------- 展会批量导入 ---------- */
function openExpoImportModal() {
  const html = `
    <div style="margin-bottom:14px">
      <div style="font-weight:bold;margin-bottom:6px">📁 选择 Excel / CSV 文件</div>
      <input type="file" id="expo-import-file" class="inp" accept=".xlsx,.xls,.csv" style="padding:8px">
      <div style="font-size:11px;color:#888;margin-top:4px">支持 .xlsx / .xls / .csv 格式</div>
    </div>
    <div style="background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:12px;font-size:12px;color:#854d0e;margin-bottom:14px">
      <b>📋 表格格式要求（第一行为表头）：</b><br>
      必填：<b>展会名称</b>（也支持「名称」「name」）<br>
      可选：城市 / 档期 / 备注<br>
      <span style="color:#a16207">💡 每行一场展会，空名称行自动跳过</span>
    </div>
    <div id="expo-import-preview" style="display:none;margin-bottom:12px">
      <b>预览（前 5 行）：</b>
      <table class="tbl" id="expo-import-tbl" style="font-size:12px;margin-top:6px"></table>
    </div>
    <button class="btn btn-primary btn-block" id="expo-import-go" disabled>📥 确认导入</button>`;
  openModal("📥 批量导入展会", html);
  const fileInput = $("#expo-import-file");
  const btnGo = $("#expo-import-go");
  let parsedData = null; // { headers, rows }
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    btnGo.disabled = true;
    btnGo.textContent = "⏳ 解析中…";
    try {
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(f); });
      // 先本地预览解析
      const r = await api("POST", "/api/exhibitions/batch-import", { content_b64: b64, filename: f.name, dry_run: true });
      // 后端不支持 dry_run，直接用正式接口但前端只预览
      // 改为：先读本地做预览展示，确认后再调接口
      parsedData = await parseExpoFileLocal(b64, f.name);
      if (parsedData.error) { toast(parsedData.error); btnGo.textContent = "📥 确认导入"; return; }
      // 显示预览表
      const prevArea = $("#expo-import-preview");
      const tbl = $("#expo-import-tbl");
      tbl.innerHTML = "";
      const hr = el("tr", {}, parsedData.headers.map(h => el("th", {}, h)));
      tbl.appendChild(hr);
      parsedData.rows.slice(0, 5).forEach(row => {
        const tr = el("tr", {}, row.map(c => el("td", {}, c || "—")));
        tbl.appendChild(tr);
      });
      if (parsedData.rows.length > 5) {
        tbl.appendChild(el("tr", {}, [el("td", { colspan: parsedData.headers.length, style: "text-align:center;color:#888;font-size:11px" },
          `... 还有 ${parsedData.rows.length - 5} 行`)]));
      }
      prevArea.style.display = "block";
      btnGo.disabled = false;
      btnGo.textContent = `📥 确认导入（${parsedData.rows.length} 场展会）`;
    } catch(e) {
      toast("文件解析失败：" + e.message);
      btnGo.textContent = "📥 确认导入";
    }
  };
  btnGo.onclick = async () => {
    if (!parsedData || !parsedData.rows.length) return;
    const f = fileInput.files[0];
    if (!f) { toast("请先选择文件"); return; }
    btnGo.disabled = true;
    btnGo.textContent = "⏳ 导入中…";
    try {
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(f); });
      const r = await api("POST", "/api/exhibitions/batch-import", { content_b64: b64, filename: f.name });
      if (!r.ok) { toast("导入失败：" + (r.data.error || "")); btnGo.textContent = "📥 确认导入"; btnGo.disabled = false; return; }
      const msg = `成功导入 ${r.data.imported} 场展会` + (r.data.errors?.length ? `，${r.data.errors.length} 行跳过` : "");
      toast(msg);
      closeModal(); render();
      // 刷新展会缓存，让 AI 页立即可用
      EXHIBITIONS = [];
    } catch(e) {
      toast("导入出错：" + e.message);
      btnGo.textContent = "📥 确认导入"; btnGo.disabled = false;
    }
  };
}

/** 本地预览解析 Excel/CSV（仅用于展示，不写入数据库） */
async function parseExpoFileLocal(b64, filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const raw = atob(b64);
  const rows = [];
  let headers = [];
  try {
    if (ext === "csv") {
      const lines = raw.split("\n").filter(l => l.trim());
      if (!lines.length) return { error: "CSV 文件为空" };
      headers = lines[0].split(",").map(h => h.trim());
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
        if (cells.some(c => c)) rows.push(cells);
      }
    } else {
      // xlsx/xls — 无法在纯前端无依赖解析，返回提示让用户直接点导入
      headers = ["展会名称", "城市", "档期", "备注"];
      return { headers, rows: [], hint: "xlsx 文件将在服务端解析，请直接点击「确认导入」" };
    }
  } catch(e) {
    return { error: "解析失败：" + e.message };
  }
  return { headers, rows };
}

/* ================= 系统设置 ================= */
function viewSettings() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "⚙️ 系统设置"));
  if (window.__MODE === "backend") {
    wrap.appendChild(el("div", { class: "section-sub" }, "已连接后端，配置 SMTP 后「发送」将真实外发给客户。"));
    wrap.appendChild(el("div", { style: "margin:10px 0;padding:12px;border-radius:8px;background:#e9f9ee;border:1px solid #9fe0b4;color:#0b6b2e;font-size:13px" },
      "🌐 这是「后端模式」：已连接真实后端，邮件会真实发送到客户邮箱。填写下方 SMTP 并关闭演示模式即可正式群发。"));
  } else {
    wrap.appendChild(el("div", { class: "section-sub" }, "本分享版使用您浏览器本地存储，数据独立隔离；发送以 .eml 文件形式下载，用邮件客户端即可真实发出。"));
    wrap.appendChild(el("div", { style: "margin:10px 0;padding:12px;border-radius:8px;background:#eef6ff;border:1px solid #bcdcff;color:#0b3d91;font-size:13px" },
      "🌐 这是「公网分享版」：数据保存在您自己的浏览器里（独立空间，互不可见）。因为纯前端无法直连邮件服务器，「发送」会生成标准 .eml 邮件文件——下载后双击用 Outlook / Foxmail / 网页邮箱打开，即可真实发送给客户。"));
  }

  // 个人设置卡片（所有用户可见：修改显示名称 + 密码）
  const profileCard = el("div", { class: "card" });
  profileCard.appendChild(el("div", { class: "label" }, "👤 个人设置"));
  profileCard.appendChild(el("div", { class: "muted", style: "margin-bottom:10px;font-size:13px" },
    "修改您的显示名称（用于邮件署名）和登录密码。也可点击右上角用户名快速进入。"));
  const profileBar = el("div", { class: "action-bar" });
  const btnProfile = el("button", { class: "btn btn-ok" }, "✏️ 修改名称 / 密码");
  btnProfile.onclick = () => openChangeMyPassword();
  profileBar.appendChild(btnProfile);
  profileCard.appendChild(profileBar);
  wrap.appendChild(profileCard);

  // 快速预设
  const presets = [
    { name: "QQ 邮箱", host: "smtp.qq.com", port: 465, hint: "QQ邮箱 → 设置 → 账户 → 开启 SMTP → 获取授权码（非登录密码）" },
    { name: "163 网易邮箱", host: "smtp.163.com", port: 465, hint: "网易邮箱 → 设置 → POP3/SMTP → 开启 → 获取授权码" },
    { name: "企业微信/腾讯企业邮", host: "smtp.exmail.qq.com", port: 465, hint: "使用企业微信账号密码或专用密码" },
    { name: "阿里云邮件推送", host: "smtpdm.aliyun.com", port: 465, hint: "阿里云控制台 → 邮件推送 → 创建发信地址 + SMTP 密码" },
    { name: "Gmail", host: "smtp.gmail.com", port: 587, hint: "Google 账户 → 安全 → 两步验证 → 应用专用密码" },
  ];
  const presetCard = el("div", { class: "card", style: "background:#fafcff" });
  presetCard.appendChild(el("div", { class: "label" }, "🚀 快速选择邮箱服务商（自动填充 SMTP 参数）"));
  const presetRow = el("div", { class: "row", style: "flex-wrap:wrap;gap:8px;margin-top:8px" });
  presets.forEach(p => {
    const btn = el("button", { class: "btn btn-sm pill-gray" }, p.name);
    btn.onclick = () => {
      $("#s-host").value = p.host;
      $("#s-port").value = p.port;
      $("#s-preset-hint").textContent = "💡 " + p.hint;
      toast("已填入 " + p.name + " 的 SMTP 参数，请补充账号和授权码");
    };
    presetRow.appendChild(btn);
  });
  presetCard.appendChild(presetRow);
  presetCard.appendChild(el("div", { id: "s-preset-hint", class: "muted", style: "font-size:12px;margin-top:8px" }));
  wrap.appendChild(presetCard);

  const card = el("div", { class: "card" });
  card.innerHTML = `
    <div style="font-weight:700;margin-bottom:12px">✉️ 发件邮箱配置</div>
    <div class="grid2">
      <div class="cfg-row"><label>发件人名称（显示在收件人看到的「来自」）</label><input id="s-from-name" class="inp" value="${esc(SETTINGS.from_name || USER.display_name || '')}" placeholder="如：张三｜SIAL招展团队"></div>
      <div class="cfg-row"><label>发件邮箱 (From) *</label><input id="s-from-email" class="inp" value="${esc(SETTINGS.from_email || '')}" placeholder="your@qq.com"></div>
      <div class="cfg-row"><label>SMTP 服务器 *</label><input id="s-host" class="inp" value="${esc(SETTINGS.smtp_host || '')}" placeholder="smtp.qq.com"></div>
      <div class="cfg-row"><label>SMTP 端口 *</label><input id="s-port" class="inp" type="number" value="${SETTINGS.smtp_port || 465}" placeholder="465"></div>
      <div class="cfg-row"><label>SMTP 登录账号（通常与发件邮箱相同）*</label><input id="s-user" class="inp" value="${esc(SETTINGS.smtp_user || '')}" placeholder="your@qq.com"></div>
      <div class="cfg-row"><label>SMTP 授权码 / 密码 *</label><input id="s-pass" class="inp" type="password" value="${esc(SETTINGS.smtp_pass || '')}" placeholder="不是登录密码，是授权码"></div>
    </div>
    <div style="font-weight:700;margin:16px 0 10px">⏱ 发送规则 & 签名</div>
    <div class="grid2">
      <div class="cfg-row"><label>默认发送间隔(秒) · 防垃圾邮件</label><input id="s-interval" class="inp" type="number" value="${SETTINGS.default_interval || 5}"></div>
      <div class="cfg-row"><label>邮件落款签名</label><input id="s-sign" class="inp" value="${esc(SETTINGS.signature || '招展顾问')}" placeholder="如：张三｜SIAL招展团队"></div>
    </div>
    <div style="margin:14px 0;padding:12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a">
      <b style="color:#92400e">⚠️ 演示模式说明：</b><br>
      <span style="color:#92400e;font-size:13px">
        当前为<span id="demo-label">${SETTINGS.demo_mode ? "<b>开启</b>" : "<b>关闭</b>"}</span>状态。
        开启时所有「发送」操作仅写入日志，不真正发出邮件——适合先试用功能。
        填好 SMTP 并关闭此开关后，邮件将真实外发。
      </span>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin:10px 0;font-size:13px"><input type="checkbox" id="s-demo" ${SETTINGS.demo_mode ? "checked" : ""}> 开启演示模式（不实际外发邮件，仅记录日志）</label>
    <div class="action-bar" style="margin-top:12px">
      <button class="btn btn-primary" id="s-save">💾 保存设置</button>
      <button class="btn btn-ok" id="s-test-conn">🧪 测试连接</button>
    </div>`;
  wrap.appendChild(card);
  setTimeout(() => {
    $("#s-demo").onchange = () => {
      $("#demo-label").innerHTML = $("#s-demo").checked ? "<b>开启</b>" : "<b>关闭</b>";
    };
    $("#s-save").onclick = async () => {
      if (!$("#s-from-email").value.trim() || !$("#s-host").value.trim()) {
        toast("请至少填写发件邮箱和 SMTP 服务器"); return;
      }
      await api("POST", "/api/settings", {
        smtp_host: $("#s-host").value, smtp_port: +$("#s-port").value || 465, smtp_user: $("#s-user").value,
        smtp_pass: $("#s-pass").value, from_email: $("#s-from-email").value, from_name: $("#s-from-name").value,
        default_interval: +$("#s-interval").value || 5, demo_mode: $("#s-demo").checked ? 1 : 0, signature: $("#s-sign").value
      });
      await loadSettings(); toast("设置已保存" + ($("#s-demo").checked ? "（演示模式）" : "（可真实发邮件了）"));
    };
    $("#s-test-conn").onclick = async () => {
      if (!$("#s-host").value || !$("#s-user").value) { toast("请先填 SMTP 服务器和账号"); return; }
      toast("正在测试连接…");
      try {
        const r = await api("POST", "/api/email/send", {
          items: [{ company: "测试", contact: USER.display_name, email: $("#s-from-email").value || "test@localhost",
            subject: "【工作台】SMTP 连接测试", body: "这是一封来自销售邮件发送工作台的连接测试邮件。如果您收到此邮件，说明 SMTP 配置正确。\n\n—" + ($("#s-sign").value || "招展顾问") }],
          interval: 0, exhibition: "", template_name: "连接测试"
        });
        if (r.ok && r.data.results[0].status === "success") {
          toast(r.data.demo_mode ? "连接参数格式正确（演示模式未实际发送）。关闭演示模式后可真实发送。" : "✅ 连接成功！请检查收件箱是否收到测试邮件。");
        } else {
          toast("❌ 连接失败：" + (r.data.error || "未知错误"));
        }
      } catch (e) { toast("❌ 测试异常：" + e.message); }
    };
  }, 30);
  return wrap;
}

/* ================= 管理员中心 ================= */
function viewAdmin() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "🛡️ 管理员中心"));
  wrap.appendChild(el("div", { class: "section-sub" }, "管理所有成员账号：重置密码、新建/删除成员、设置管理员。各成员数据仍互相隔离。"));

  // 数据备份卡片（防止重部署/换服务器导致数据丢失）
  const backupCard = el("div", { class: "card" });
  backupCard.appendChild(el("div", { class: "label" }, "💾 数据备份与恢复（推荐定期导出）"));
  backupCard.appendChild(el("div", { class: "muted", style: "margin-bottom:10px;font-size:13px" },
    "导出会下载一个包含所有客户、账号、发送日志的备份文件。重部署或换服务器前先导出，部署后再「导入备份」即可零丢失恢复。"));
  const backupBar = el("div", { class: "action-bar" });
  const btnExport = el("button", { class: "btn btn-primary" }, "⬇️ 导出备份");
  btnExport.onclick = async () => {
    try {
      const r = await api("GET", "/api/backup/export");
      if (!r.ok) { toast("导出失败：" + (r.data.error || "")); return; }
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mailwb-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("✅ 备份已下载");
    } catch (e) { toast("导出异常：" + e.message); }
  };
  const btnImport = el("button", { class: "btn btn-ok" }, "⬆️ 导入备份");
  btnImport.onclick = () => {
    const html = `<div class="muted" style="margin-bottom:10px;font-size:13px">选择之前导出的备份 JSON 文件。导入会<b>覆盖</b>当前所有数据，请谨慎操作。</div>
      <input id="bk-file" type="file" accept="application/json,.json" class="inp">
      <div class="action-bar"><button class="btn btn-primary" id="bk-ok">确认导入</button></div>`;
    openModal("导入备份（将覆盖当前数据）", html);
    $("#bk-ok").onclick = async () => {
      const f = $("#bk-file").files[0];
      if (!f) { toast("请先选择备份文件"); return; }
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const r = await api("POST", "/api/backup/import", { data });
        if (!r.ok) { toast("导入失败：" + (r.data.error || "")); return; }
        closeModal();
        toast("✅ 备份已导入，请刷新页面");
        setTimeout(() => location.reload(), 800);
      } catch (e) { toast("导入异常：" + e.message); }
    };
  };
  // 导出/导入「全部（含附件）zip」——用于挂持久盘前完整备份，避免附件丢失
  const btnExportZip = el("button", { class: "btn" }, "📦 导出全部(含附件)");
  btnExportZip.onclick = async () => {
    try {
      const base = window.__BACKEND_URL || "";
      const headers = { "Content-Type": "text/plain" };
      if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
      const res = await fetch(base + "/api/admin/backup/export-zip", { method: "GET", headers });
      if (!res.ok) { toast("导出失败：" + res.status); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "mailwb-full-backup-" + new Date().toISOString().slice(0,10) + ".zip";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast("✅ 全部备份已下载（含附件）");
    } catch (e) { toast("导出异常：" + e.message); }
  };
  const btnImportZip = el("button", { class: "btn" }, "📦 导入全部(含附件)");
  btnImportZip.onclick = () => {
    const html = `<div class="muted" style="margin-bottom:10px;font-size:13px">选择之前下载的「全部备份」zip 文件。导入会<b>覆盖</b>当前数据库与所有附件，请谨慎操作。</div>
      <input type="file" id="bk-zip" accept=".zip" class="input"/>
      <div class="action-bar" style="margin-top:12px"><button class="btn btn-primary" id="bk-zip-ok">确认导入</button></div>`;
    openModal("导入全部备份(含附件，将覆盖)", html);
    $("bk-zip-ok").onclick = async () => {
      const f = $("bk-zip").files[0];
      if (!f) { toast("请先选择备份文件"); return; }
      const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(f); });
      const r = await api("POST", "/api/admin/backup/import-zip", { zip_b64: b64 });
      if (!r.ok) { toast("导入失败：" + (r.data.error || "")); return; }
      closeModal();
      toast("✅ 已恢复，请刷新页面重新登录");
    };
  };
  backupBar.appendChild(btnExport); backupBar.appendChild(btnImport);
  backupBar.appendChild(btnExportZip); backupBar.appendChild(btnImportZip);
  backupCard.appendChild(backupBar);
  wrap.appendChild(backupCard);

  // —— 云端自动备份状态（部署稳定性：数据自动同步腾讯云 COS，重部署不丢）——
  const autoCard = el("div", { class: "card" });
  autoCard.appendChild(el("div", { class: "label" }, "🔄 云端自动备份状态"));
  autoCard.appendChild(el("div", { class: "muted", style: "margin-bottom:10px;font-size:13px" },
    "客户/资料/草稿/模板/发送日志每次变更都会自动同步到腾讯云 COS；重新部署后启动时自动从云端恢复，账号与导入的资料不会丢失。"));
  const statusRow = el("div", { id: "bk-status", class: "muted" }, "正在检查…");
  autoCard.appendChild(statusRow);
  const autoBar = el("div", { class: "action-bar" });
  const btnSync = el("button", { class: "btn" }, "⚡ 立即备份到云端");
  btnSync.onclick = async () => {
    btnSync.disabled = true; btnSync.textContent = "备份中…";
    try {
      const r = await api("POST", "/api/admin/backup/auto-trigger");
      if (!r.ok) { toast("备份失败：" + (r.data.error || "")); }
      else toast(r.data.db_synced ? "✅ 云端备份完成（DB + " + r.data.uploads_synced + " 个附件）" : "⚠️ 备份执行完成，但数据库同步失败，请检查 COS 配置");
      loadBackupStatus();
    } catch (e) { toast("备份异常：" + e.message); }
    btnSync.disabled = false; btnSync.textContent = "⚡ 立即备份到云端";
  };
  autoBar.appendChild(btnSync);
  autoCard.appendChild(autoBar);
  wrap.appendChild(autoCard);

  // —— AI 大模型配置（可绑定 DeepSeek / 通义千问 / OpenAI / 本地 Ollama）——
  const aiCard = el("div", { class: "card" });
  aiCard.appendChild(el("div", { class: "label" }, "🤖 AI 大模型配置（让邮件由真实大模型生成）"));
  aiCard.appendChild(el("div", { class: "muted", style: "margin-bottom:10px;font-size:13px" },
    "启用后，AI 生成邮件将调用真实大模型写作（更自然、可结合附件与网络资讯），不再是固定模板。不启用则继续用内置模板引擎。"));
  const s = SETTINGS || {};
  const aiHtml = `
    <div class="cfg-row"><label>启用真实大模型生成</label>
      <label class="switch"><input type="checkbox" id="ai-on" ${s.ai_enabled === "1" || s.ai_enabled === "true" ? "checked" : ""}><span class="slider"></span></label>
      <span class="muted" style="font-size:12px">关闭则使用免费模板引擎</span>
    </div>
    <div class="cfg-row"><label>服务商</label>
      <select id="ai-provider" class="inp">
        <option value="deepseek" ${s.ai_provider === "deepseek" ? "selected" : ""}>DeepSeek（推荐，最便宜）</option>
        <option value="qwen" ${s.ai_provider === "qwen" ? "selected" : ""}>通义千问 Qwen（有免费额度）</option>
        <option value="openai" ${s.ai_provider === "openai" ? "selected" : ""}>OpenAI（GPT-4o-mini）</option>
        <option value="ollama" ${s.ai_provider === "ollama" ? "selected" : ""}>本地 Ollama（完全免费）</option>
        <option value="zhipu" ${s.ai_provider === "zhipu" ? "selected" : ""}>智谱 GLM-4-Flash（完全免费·推荐）</option>
        <option value="custom" ${s.ai_provider === "custom" ? "selected" : ""}>自定义兼容接口</option>
      </select>
    </div>
    <div class="cfg-row"><label>API Key</label><input id="ai-key" class="inp" type="password" value="${esc(s.ai_api_key || "")}" placeholder="粘贴服务商 API Key（本地 Ollama 可留空）"></div>
    <div class="cfg-row"><label>Base URL</label><input id="ai-base" class="inp" value="${esc(s.ai_base_url || "")}" placeholder="留空则按服务商自动填充"></div>
    <div class="cfg-row"><label>模型名</label><input id="ai-model" class="inp" value="${esc(s.ai_model || "")}" placeholder="留空则按服务商默认"></div>
    <div class="muted" style="font-size:12px;line-height:1.7;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;margin-top:6px">
      <b>💰 收费参考（按 token 计费，一封邮件约 ¥0.001~0.01）：</b><br>
      · DeepSeek：约 ¥1 / 百万 token，单封招展邮件 ≈ <b>¥0.001</b>，最省；<br>
      · 通义千问：新用户有免费额度，qwen-plus 约 ¥0.004/封，qwen-max 稍贵；<br>
      · OpenAI GPT-4o-mini：约 ¥0.01/封；<br>
      · 智谱 GLM-4-Flash：<b>完全免费、无额度限制</b>，国内 API 不受 GFW，最推荐；<br>
      · 本地 Ollama（如 qwen2.5:7b）：<b>完全免费</b>，需自备机器/容器算力。<br>
      <span style="color:#64748b">多版本一次生成 5 封，按 5 倍折算，仍极低。调用失败会自动回退模板，不影响出信。</span>
    </div>`;
  const aiBox = el("div");
  aiBox.innerHTML = aiHtml;
  aiCard.appendChild(aiBox);
  const aiBar = el("div", { class: "action-bar" });
  const btnSaveAI = el("button", { class: "btn btn-primary" }, "💾 保存 AI 配置");
  btnSaveAI.onclick = async () => {
    const payload = Object.assign({}, SETTINGS, {
      ai_enabled: $("#ai-on").checked ? "1" : "0",
      ai_provider: $("#ai-provider").value,
      ai_api_key: $("#ai-key").value.trim(),
      ai_base_url: $("#ai-base").value.trim(),
      ai_model: $("#ai-model").value.trim(),
    });
    const r = await api("POST", "/api/settings", payload);
    if (!r.ok) { toast("保存失败：" + (r.data.error || "")); return; }
    SETTINGS = payload;
    toast("✅ AI 配置已保存" + (payload.ai_enabled === "1" ? "，已启用大模型生成" : "，当前为模板引擎"));
  };
  const btnTestAI = el("button", { class: "btn" }, "🔌 测试连接");
  btnTestAI.onclick = async () => {
    btnTestAI.disabled = true; btnTestAI.textContent = "测试中…";
    try {
      const r = await api("POST", "/api/ai/generate", {
        exhibition: "测试展会", customer_type: "食品企业", scene: "1", tone: "正式商务",
        custom_input: "", signature: "招展顾问",
        material_ids: [],
        _llm_test: true,
        ai_provider: $("#ai-provider").value,
        ai_api_key: $("#ai-key").value.trim(),
        ai_base_url: $("#ai-base").value.trim(),
        ai_model: $("#ai-model").value.trim(),
      });
      if (r.ok && r.data && r.data.body && r.data.body.length > 30) toast("✅ 大模型连接成功，已生成测试邮件");
      else toast("⚠️ 生成返回异常，请检查 Key / Base URL");
    } catch (e) { toast("测试异常：" + e.message); }
    btnTestAI.disabled = false; btnTestAI.textContent = "🔌 测试连接";
  };
  aiBar.appendChild(btnSaveAI); aiBar.appendChild(btnTestAI);
  aiCard.appendChild(aiBar);
  // 切换服务商时自动填充默认 Base URL / 模型
  aiBox.querySelector("#ai-provider").onchange = function () {
    const presets = {
      deepseek: ["https://api.deepseek.com/v1", "deepseek-chat"],
      qwen: ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
      openai: ["https://api.openai.com/v1", "gpt-4o-mini"],
      ollama: ["http://localhost:11434/v1", "qwen2.5:7b"],
      zhipu: ["https://open.bigmodel.cn/api/paas/v4", "glm-4-flash"],
      custom: ["", "gpt-4o-mini"],
    };
    const p = presets[this.value] || presets.custom;
    if (!$("#ai-base").value) $("#ai-base").value = p[0];
    if (!$("#ai-model").value) $("#ai-model").value = p[1];
  };
  wrap.appendChild(aiCard);

  const actionBar = el("div", { class: "action-bar" });
  const btnCreate = el("button", { class: "btn btn-primary" }, "➕ 新建成员 / 管理员");
  btnCreate.onclick = () => openCreateUser();
  const btnMyPwd = el("button", { class: "btn btn-ok" }, "👤 个人设置（名称/密码）");
  btnMyPwd.onclick = () => openChangeMyPassword();
  actionBar.appendChild(btnCreate); actionBar.appendChild(btnMyPwd);
  wrap.appendChild(actionBar);

  const card = el("div", { class: "card" });
  card.appendChild(el("div", { class: "label" }, "成员账号列表"));
  const table = el("table", { class: "tbl" });
  table.innerHTML = `<thead><tr><th>ID</th><th>用户名</th><th>显示名称</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="admin-users-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>`;
  card.appendChild(table);
  wrap.appendChild(card);

  async function loadBackupStatus() {
    const box = $("#bk-status");
    if (!box) return;
    try {
      const r = await api("GET", "/api/admin/backup/status");
      if (!r.ok) { box.innerHTML = '<span class="status-fail">状态获取失败：' + esc(r.data.error || "") + "</span>"; return; }
      const d = r.data;
      const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : b >= 1024 ? (b / 1024).toFixed(1) + " KB" : b + " B";
      const totalRows = (d.tables || []).reduce((s, t) => s + (t.rows > 0 ? t.rows : 0), 0);
      const cosTag = d.cos_enabled
        ? '<span class="pill" style="background:#dcfce7;color:#166534">☁️ COS 自动备份已启用</span>'
        : '<span class="pill pill-gray">COS 未配置（仅本地存储，重部署可能丢失）</span>';
      const lastTxt = d.last_backup_at ? d.last_backup_at.replace("T", " ").slice(0, 19) : "尚未备份";
      box.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:8px">
          ${cosTag}
          <span class="muted" style="font-size:12px">存储桶：${esc(d.cos_bucket || "—")}${d.cos_enabled ? "" : "（需在系统设置配置 COS 后启用）"}</span>
        </div>
        <table class="tbl" style="font-size:13px">
          <tbody>
            <tr><td style="width:130px">数据库大小</td><td>${fmtSize(d.db_size_bytes)}</td><td style="width:140px">附件文件数</td><td>${d.upload_count} 个（${fmtSize(d.upload_bytes)}）</td></tr>
            <tr><td>数据总记录数</td><td>${totalRows} 条</td><td>上次云端备份</td><td>${esc(lastTxt)}</td></tr>
          </tbody>
        </table>`;
    } catch (e) { box.innerHTML = '<span class="status-fail">状态获取异常：' + esc(e.message) + "</span>"; }
  }
  loadBackupStatus();

  async function loadUsers() {
    const body = $("#admin-users-body");
    try {
      const r = await api("GET", "/api/admin/users");
      if (!r.ok) { body.innerHTML = `<tr><td colspan="6" class="status-fail">加载失败：${esc(r.data.error || "")}</td></tr>`; return; }
      if (!r.data.length) { body.innerHTML = `<tr><td colspan="6" class="muted">暂无成员</td></tr>`; return; }
      body.innerHTML = "";
      r.data.forEach(u => {
        const tr = el("tr");
        const roleTag = u.role === "admin"
          ? '<span class="pill" style="background:#fde68a;color:#92400e">管理员</span>'
          : '<span class="pill pill-gray">成员</span>';
        const isSelf = u.id === USER.id;
        const ops = el("td");
        const resetBtn = el("button", { class: "btn btn-sm" }, "重置密码");
        resetBtn.onclick = () => openResetPassword(u);
        ops.appendChild(resetBtn);
        if (!isSelf) {
          const roleBtn = el("button", { class: "btn btn-sm" }, u.role === "admin" ? "降为成员" : "设为管理员");
          roleBtn.style.marginLeft = "6px";
          roleBtn.onclick = () => openChangeRole(u);
          ops.appendChild(roleBtn);
          const delBtn = el("button", { class: "btn btn-sm btn-danger" }, "删除");
          delBtn.style.marginLeft = "6px";
          delBtn.onclick = () => delUser(u);
          ops.appendChild(delBtn);
        } else {
          const me = el("span", { class: "muted", style: "font-size:12px;margin-left:6px" }, "(本人)");
          ops.appendChild(me);
        }
        tr.innerHTML = `<td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.display_name || "")}</td><td>${roleTag}</td><td>${esc((u.created_at || "").slice(0, 10))}</td>`;
        tr.appendChild(ops);
        body.appendChild(tr);
      });
    } catch (e) { body.innerHTML = `<tr><td colspan="6" class="status-fail">异常：${esc(e.message)}</td></tr>`; }
  }

  function openResetPassword(u) {
    const html = `<div class="cfg-row"><label>为「${esc(u.username)}」设置新密码</label><input id="rp-pwd" class="inp" type="password" placeholder="输入新密码（至少 4 位）"></div>
      <div class="action-bar"><button class="btn btn-primary" id="rp-ok">确认重置</button></div>`;
    openModal("重置成员密码", html);
    $("#rp-ok").onclick = async () => {
      const pw = $("#rp-pwd").value;
      if (pw.length < 4) { toast("密码至少 4 位"); return; }
      const r = await api("POST", "/api/admin/reset-password", { user_id: u.id, new_password: pw });
      if (r.ok) { toast("已重置 " + u.username + " 的密码"); closeModal(); loadUsers(); }
      else toast("失败：" + (r.data.error || ""));
    };
  }

  function openChangeRole(u) {
    const target = u.role === "admin" ? "member" : "admin";
    const label = target === "admin" ? "设为管理员" : "降为普通成员";
    if (!confirm(`确认将「${u.username}」${label}？`)) return;
    (async () => {
      const r = await api("POST", "/api/admin/update-role", { user_id: u.id, role: target });
      if (r.ok) { toast("已" + label + "：" + u.username); loadUsers(); }
      else toast("失败：" + (r.data.error || ""));
    })();
  }

  function delUser(u) {
    if (!confirm(`确认删除成员「${u.username}」？其全部客户/待办/模板/日志将一并清除，不可恢复。`)) return;
    (async () => {
      const r = await api("DELETE", "/api/admin/users/" + u.id);
      if (r.ok) { toast("已删除 " + u.username); loadUsers(); }
      else toast("失败：" + (r.data.error || ""));
    })();
  }

  wrap._loadUsers = loadUsers;
  setTimeout(loadUsers, 0);
  return wrap;
}

function openCreateUser() {
  const html = `
    <div class="cfg-row"><label>用户名 / 工号 *</label><input id="cu-user" class="inp" placeholder="如 bob"></div>
    <div class="cfg-row"><label>显示名称</label><input id="cu-name" class="inp" placeholder="如 李四"></div>
    <div class="cfg-row"><label>初始密码 *</label><input id="cu-pwd" class="inp" type="password" placeholder="至少 4 位"></div>
    <div class="cfg-row"><label>角色</label>
      <select id="cu-role" class="inp">
        <option value="member">成员（普通销售，独立空间）</option>
        <option value="admin">管理员（可管理成员）</option>
      </select>
    </div>
    <div class="action-bar"><button class="btn btn-primary" id="cu-ok">创建账号</button></div>`;
  openModal("新建成员 / 管理员", html);
  $("#cu-ok").onclick = async () => {
    const username = $("#cu-user").value.trim();
    const password = $("#cu-pwd").value;
    if (!username || password.length < 4) { toast("请填写用户名，且密码至少 4 位"); return; }
    const r = await api("POST", "/api/admin/create-user", {
      username, password, display_name: $("#cu-name").value.trim(), role: $("#cu-role").value
    });
    if (r.ok) { toast("已创建 " + username); closeModal(); if (STATE.view === "admin") render(); }
    else toast("失败：" + (r.data.error || ""));
  };
}

function openChangeMyPassword() {
  const html = `
    <div class="cfg-row"><label>当前用户名</label><input class="inp" value="${esc(USER.username)}" disabled style="background:#f3f4f6;color:#6b7280"></div>
    <div class="cfg-row"><label>显示名称 <span style="color:#D35400">★</span></label><input id="mp-dn" class="inp" value="${esc(USER.display_name || '')}" placeholder="用于邮件署名、界面展示"></div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0">
    <div class="cfg-row"><label>原密码</label><input id="mp-old" class="inp" type="password" placeholder="留空则不修改密码"></div>
    <div class="cfg-row"><label>新密码</label><input id="mp-new" class="inp" type="password" placeholder="留空则不修改密码（至少 4 位）"></div>
    <div class="action-bar"><button class="btn btn-primary" id="mp-ok">保存修改</button></div>`;
  openModal("👤 个人设置（密码 / 显示名称）", html);
  $("#mp-ok").onclick = async () => {
    const dn = ($("#mp-dn").value || "").trim();
    const oldp = $("#mp-old").value, newp = $("#mp-new").value;
    if (!dn) { toast("显示名称不能为空"); return; }
    if (newp && newp.length < 4) { toast("新密码至少 4 位"); return; }
    // 更新显示名称
    const r1 = await api("POST", "/api/me/profile", { display_name: dn });
    if (!r1.ok) { toast("显示名称修改失败：" + (r1.data.error || "")); return; }
    USER.display_name = dn;
    $("#cur-user").textContent = dn || USER.username;
    // 如果填了新密码就一起改
    if (newp) {
      const r2 = await api("POST", "/api/me/change-password", { old_password: oldp, new_password: newp });
      if (!r2.ok) { toast("密码修改失败：" + (r2.data.error || "")); return; }
      closeModal(); toast("✅ 显示名称和密码都已更新");
    } else {
      closeModal(); toast("✅ 显示名称已更新");
    }
  };
}

/* ---------- 邮件语言切换 ---------- */
function updateLangButtons() {
  $all('[data-lang]').forEach(btn => {
    const active = btn.dataset.lang === STATE.lang;
    btn.style.background = active ? '#1f6feb' : '#f3f4f6';
    btn.style.color = active ? '#fff' : '#374151';
    btn.style.borderColor = active ? '#1f6feb' : '#d1d5db';
  });
}
async function switchMailLang(lang) {
  if (!STATE.origMail.subject) { toast("请先生成邮件"); return; }
  STATE.lang = lang;
  updateLangButtons();
  if (lang === 'zh') {
    $("#pv-subject").value = STATE.origMail.subject;
    $("#pv-body").value = STATE.origMail.body;
    toast("已切换为中文");
    return;
  }
  // 调用后端翻译
  const r = await api("POST", "/api/ai/translate", {
    subject: STATE.origMail.subject,
    body: STATE.origMail.body,
    target: lang // 'en' 或 'bilingual'
  });
  if (r.ok && r.data) {
    $("#pv-subject").value = r.data.subject || STATE.origMail.subject;
    $("#pv-body").value = r.data.body || STATE.origMail.body;
    toast(lang === 'en' ? "已切换为英文" : "已切换为中英双语");
  } else {
    toast("翻译失败：" + (r.data?.error || "请稍后重试"));
  }
}

/* ---------- 启动 ---------- */
function card(title, child) { const c = el("div", { class: "card" }); c.appendChild(el("h3", {}, title)); c.appendChild(child); return c; }
/* 全局错误捕获：防止 JS 报错导致页面无响应 */
window.onerror = function(msg, src, line, col, err) {
  console.error("[全局错误]", msg, "at", src, ":", line);
  const m = $("#auth-msg");
  if (m) m.textContent = "⚠️ 页面错误: " + msg + " (行" + line + ")";
  return false;
};
window.addEventListener("unhandledrejection", function(e) {
  console.error("[未捕获Promise]", e.reason);
  const m = $("#auth-msg");
  if (m) m.textContent = "⚠️ 连接异常: " + (e.reason?.message || String(e.reason));
});
function init() { if (TOKEN && USER) enterApp(); else showAuth(); }

/* ---------- 全局搜索（顶栏 搜索客户/模板/展会…）---------- */
let _searchTimer = null;
let _searchResults = [];
function setupGlobalSearch() {
  const inp = $("#global-search");
  if (!inp) return;
  // 搜索结果下拉容器
  let dropdown = null;
  function showDropdown(items) {
    if (!dropdown) {
      dropdown = el("div", { id: "search-dropdown", class: "search-dropdown" });
      document.body.appendChild(dropdown);
    }
    dropdown.innerHTML = "";
    if (!items.length) { dropdown.style.display = "none"; return; }
    items.forEach(it => {
      const row = el("div", { class: "search-result-item" });
      const tag = el("span", { class: "search-result-tag", style: `background:${it.color || "#6366f1"}` }, it.type);
      row.appendChild(tag);
      row.appendChild(el("span", {}, it.label));
      row.onclick = () => {
        dropdown.style.display = "none";
        inp.value = "";
        STATE.view = it.view; STATE.sub = it.sub || defaultSub(it.view); render();
        // 如果有回调（如高亮某行），延迟执行等DOM渲染完
        if (it.cb) setTimeout(it.cb, 100);
      };
      dropdown.appendChild(row);
    });
    dropdown.style.display = "block";
    // 定位到输入框下方
    const rect = inp.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + window.scrollY + 4) + "px";
    dropdown.style.left = rect.left + "px";
    dropdown.style.width = rect.width + "px";
  }
  inp.oninput = () => {
    clearTimeout(_searchTimer);
    const kw = inp.value.trim().toLowerCase();
    if (!kw.length) { showDropdown([]); return; }
    _searchTimer = setTimeout(async () => {
      const results = [];
      // 搜索客户
      try {
        const r = await api("GET", "/api/customers");
        (r.data || []).filter(c =>
          (c.company || "").toLowerCase().includes(kw) ||
          (c.contact || "").toLowerCase().includes(kw) ||
          (c.email || "").toLowerCase().includes(kw)
        ).slice(0, 5).forEach(c => results.push({
          type: "👥 客户", label: `${c.company} / ${c.contact || "-"} / ${c.email || "-"}`,
          color: "#10b981", view: "cust", sub: "list",
          cb: () => { /* 高亮该客户 */ }
        }));
      } catch(e) {}
      // 搜索展会
      try {
        const r = await api("GET", "/api/exhibitions");
        (r.data || []).filter(e => (e.name || "").toLowerCase().includes(kw)).slice(0, 4).forEach(e => results.push({
          type: "📁 展会", label: `${e.name} (${e.city || ""} ${e.date_text || ""})`,
          color: "#f59e0b", view: "expo", sub: "mat"
        }));
      } catch(e) {}
      // 搜索模板
      try {
        const r = await api("GET", "/api/templates");
        (r.data || []).filter(t => (t.name || "").toLowerCase().includes(kw) || (t.exhibition || "").toLowerCase().includes(kw)).slice(0, 4).forEach(t => results.push({
          type: "📧 模板", label: `${t.name} [${t.scene || ""}]`,
          color: "#8b5cf6", view: "ai", sub: "tpl"
        }));
      } catch(e) {}
      _searchResults = results;
      showDropdown(results);
      if (!results.length) showDropdown([{type:"无结果", label:`未找到与「${inp.value.trim()}」相关的内容`,color:"#94a3b8",view:"",sub:"",cb:null}]);
    }, 300);
  };
  // 点击外部关闭下拉
  document.addEventListener("click", e => {
    if (dropdown && e.target !== inp && !dropdown.contains(e.target)) dropdown.style.display = "none";
  });
  // ESC 关闭
  inp.addEventListener("keydown", e => { if (e.key === "Escape") { inp.value = ""; showDropdown([]); } });
}

init();
// 登录后初始化全局搜索
const _origEnterApp = typeof enterApp === "function" ? enterApp : null;
