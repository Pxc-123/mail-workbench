/* 销售邮件发送工作台 - 前端逻辑（原生 JS，无框架） */
const API = "";
let TOKEN = localStorage.getItem("wb_token");
let USER = JSON.parse(localStorage.getItem("wb_user") || "null");
let SETTINGS = {};
const STATE = {
  view: "home", sub: "todos",
  calYear: new Date().getFullYear(), calMonth: new Date().getMonth(),
  selectedDate: null,
  gen: { exhibition: "", customer_type: "", scene: "", tone: "", subject: "", body: "" },
  attachments: [], // [{id,name}]
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
  loadSettings().then(() => { bindNav(); render(); refreshBell(); });
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
}
function defaultSub(v) { return { home: "todos", ai: "gen", cust: "list", expo: "mat", set: "base" }[v] || ""; }

/* ---------- 总渲染 ---------- */
function render() {
  // 同步侧栏高亮
  $all(".nav-item").forEach(x => x.classList.toggle("active", x.dataset.view === STATE.view && !x.closest(".nav-group").querySelector(".nav-leaf.active" + (STATE.sub ? `[data-sub="${STATE.sub}"]` : ""))));
  $all(".nav-group").forEach(g => g.classList.toggle("open", g.querySelector(`.nav-item[data-view="${STATE.view}"]`)));
  $all(".nav-leaf").forEach(x => x.classList.toggle("active", x.dataset.view === STATE.view && x.dataset.sub === STATE.sub));
  const c = $("#content");
  c.innerHTML = "";
  if (STATE.view === "home") c.appendChild(STATE.sub === "calendar" ? viewCalendar() : viewHome());
  else if (STATE.view === "ai") c.appendChild(STATE.sub === "gen" ? viewGen() : STATE.sub === "tpl" ? viewTemplates() : viewLogs());
  else if (STATE.view === "cust") c.appendChild(STATE.sub === "list" ? viewCustomers() : viewTags());
  else if (STATE.view === "expo") c.appendChild(viewExpo());
  else if (STATE.view === "set") c.appendChild(viewSettings());
  else if (STATE.view === "admin") c.appendChild(viewAdmin());
}

/* ================= 首页工作台 ================= */
function viewHome() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "首页工作台"));
  wrap.appendChild(el("div", { class: "section-sub" }, "待办事项提醒 · 悬浮日历可把待办绑定到具体日期"));
  const grid = el("div", { class: "grid2" });
  grid.appendChild(card("📝 待办清单", todoPanel()));
  grid.appendChild(card("📅 日历 / 绑定待办", calendarPanel(false)));
  wrap.appendChild(grid);
  return wrap;
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
  target.innerHTML = "";
  if (!list.length) { target.appendChild(el("div", { class: "empty" }, "暂无待办，上方添加一条吧")); return; }
  list.forEach(t => {
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
async function getExhibitions() { if (!EXHIBITIONS.length) { const r = await api("GET", "/api/exhibitions"); EXHIBITIONS = r.data || []; } return EXHIBITIONS; }
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
const SCENES = [["1", "初次开发陌生客户"], ["2", "跟进意向客户推送最新行业新闻"], ["3", "通知展位余量紧张催单"], ["4", "通知创新大奖申报截止提醒"], ["5", "展会补贴政策通知"], ["6", "发送参展报价方案"], ["7", "客户跟进回访"], ["8", "参展感谢与维系"]];
const TONES = ["正式商务", "简洁干练", "温和友好", "简短"];

function viewGen() {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-title" }, "🤖 AI 一键生成邮件模板"));
  wrap.appendChild(el("div", { class: "section-sub" }, "左侧配置参数 → 右侧预览/编辑 → 保存模板或批量发送（支持变量 {客户名称}{联系人姓名}{销售姓名} 自动替换）"));
  const split = el("div", { class: "split" });

  // 左：配置
  const left = el("div", { class: "card" });
  left.appendChild(el("div", { class: "label" }, "1. 选择目标展会"));
  const exSel = el("select", { class: "inp", id: "cfg-ex" });
  getExhibitions().then(exs => { exs.forEach(e => exSel.appendChild(el("option", { value: e.name }, e.name))); STATE.gen.exhibition = exSel.value; });
  left.appendChild(exSel);
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "2. 选择客户类型"));
  const ctSel = el("select", { class: "inp" }, [el("option", { value: "" }, "加载中…")]);
  left.appendChild(ctSel);
  getCustTypes().then(types => {
    ctSel.innerHTML = "";
    types.forEach(t => ctSel.appendChild(el("option", { value: t }, t)));
    if (types.length) STATE.gen.customer_type = ctSel.value;
  });
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "3. 选择邮件场景"));
  const scSel = el("select", { class: "inp" }, SCENES.map(s => el("option", { value: s[0] }, s[1])));
  left.appendChild(scSel);
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "4. 选择语气风格"));
  const tnSel = el("select", { class: "inp" }, TONES.map(t => el("option", { value: t }, t)));
  left.appendChild(tnSel);
  left.appendChild(el("div", { class: "label", style: "margin-top:12px" }, "5. 自定义补充（粘贴新闻/卖点素材，AI 会融入邮件）"));
  const custom = el("textarea", { class: "inp", placeholder: "例：加上欧盟 PPWR 包装法规新闻，重点突出展位余量不多。" });
  left.appendChild(custom);
  const gen = el("button", { class: "btn btn-primary btn-block", style: "margin-top:14px" }, "⚡ AI 一键生成邮件");
  gen.onclick = async () => {
    gen.textContent = "生成中…"; gen.disabled = true;
    const r = await api("POST", "/api/ai/generate", {
      exhibition: exSel.value, customer_type: ctSel.value, scene: scSel.value, tone: tnSel.value,
      custom_input: custom.value, signature: SETTINGS.signature || USER.display_name || "招展顾问"
    });
    gen.textContent = "⚡ AI 一键生成邮件"; gen.disabled = false;
    if (!r.ok) { toast("生成失败"); return; }
    STATE.gen = { exhibition: exSel.value, customer_type: ctSel.value, scene: scSel.value, tone: tnSel.value, subject: r.data.subject, body: r.data.body };
    $("#pv-subject").value = r.data.subject; $("#pv-body").value = r.data.body;
    toast("已生成，可在右侧修改");
  };
  left.appendChild(gen);
  split.appendChild(left);

  // 右：预览编辑
  const right = el("div", { class: "preview-box" });
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

  wrap.appendChild(split);
  return wrap;
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
  const html = `<div class="cfg-row">${mats.length ? mats.map(m => `<label style="display:block;margin:6px 0"><input type="checkbox" class="att-chk" value="${m.id}" ${STATE.attachments.find(a => a.id === m.id) ? "checked" : ""}> ${esc(m.name)}</label>`).join("") : '<div class="muted">资料库暂无文件，请先到「展会资料库」上传</div>'}</div>
    <button class="btn btn-primary btn-block" id="att-ok">确定</button>`;
  openModal("添加附件（绑定展会手册 PDF）", html);
  $("#att-ok").onclick = () => {
    STATE.attachments = $all(".att-chk:checked").map(c => { const m = mats.find(x => x.id == c.value); return { id: m.id, name: m.name }; });
    $("#att-info").textContent = "当前附件：" + (STATE.attachments.length ? STATE.attachments.map(a => a.name).join("、") : "无");
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
      use.onclick = () => { STATE.gen = { exhibition: tp.exhibition, customer_type: tp.customer_type, scene: SCENES.find(s => s[1] === tp.scene)?.[0] || "", tone: tp.tone, subject: tp.subject, body: tp.body };
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
  t.appendChild(el("tr", {}, ["", "客户公司", "联系人", "邮箱", "手机号", "意向展会", "标签", "操作"].map(h => el("th", {}, h))));
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
  const html = `<div class="cfg-row"><label>客户公司 *</label><input id="c-company" class="inp"></div>
    <div class="cfg-row"><label>联系人</label><input id="c-contact" class="inp"></div>
    <div class="cfg-row"><label>邮箱</label><input id="c-email" class="inp"></div>
    <div class="cfg-row"><label>手机号</label><input id="c-phone" class="inp"></div>
    <div class="cfg-row"><label>意向展会</label><input id="c-ex" class="inp"></div>
    <div class="cfg-row"><label>客户标签（逗号分隔）</label><input id="c-tags" class="inp" placeholder="预制菜客户,高意向"></div>
    <button class="btn btn-primary btn-block" id="c-save">保存</button>`;
  openModal("新增客户", html);
  $("#c-save").onclick = async () => {
    if (!$("#c-company").value.trim()) { toast("客户公司必填"); return; }
    await api("POST", "/api/customers", { company: $("#c-company").value.trim(), contact: $("#c-contact").value, email: $("#c-email").value, phone: $("#c-phone").value, exhibition: $("#c-ex").value, tags: $("#c-tags").value });
    closeModal(); toast("客户已添加"); render();
  };
}
function editCustomerModal(c, target) {
  const html = `<div class="cfg-row"><label>客户公司 *</label><input id="c-company" class="inp" value="${esc(c.company || "")}"></div>
    <div class="cfg-row"><label>联系人</label><input id="c-contact" class="inp" value="${esc(c.contact || "")}"></div>
    <div class="cfg-row"><label>邮箱</label><input id="c-email" class="inp" value="${esc(c.email || "")}"></div>
    <div class="cfg-row"><label>手机号</label><input id="c-phone" class="inp" value="${esc(c.phone || "")}"></div>
    <div class="cfg-row"><label>意向展会</label><input id="c-ex" class="inp" value="${esc(c.exhibition || "")}"></div>
    <div class="cfg-row"><label>客户标签（逗号分隔）</label><input id="c-tags" class="inp" placeholder="预制菜客户,高意向" value="${esc(c.tags || "")}"></div>
    <button class="btn btn-primary btn-block" id="c-save">保存修改</button>`;
  openModal("编辑客户", html);
  $("#c-save").onclick = async () => {
    if (!$("#c-company").value.trim()) { toast("客户公司必填"); return; }
    await api("PUT", "/api/customers/" + c.id, { company: $("#c-company").value.trim(), contact: $("#c-contact").value, email: $("#c-email").value, phone: $("#c-phone").value, exhibition: $("#c-ex").value, tags: $("#c-tags").value });
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
  const resultArea = el("div"); // 筛选结果区域
  wrap.appendChild(resultArea);

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

    // 默认显示全部客户
    showCustomerResult(customers, "全部客户", resultArea);
  });
  return wrap;
}

/** 在标签页的结果区域显示筛选后的客户表格 */
function showCustomerResult(list, tagName, container) {
  container.innerHTML = "";
  if (!list.length) { container.appendChild(el("div", { class: "empty" }, `没有标记为「${tagName}」的客户`)); return; }
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
  header.appendChild(el("span", { style: "font-weight:bold;font-size:14px" }, `📋 ${tagName} — 共 ${list.length} 位客户`));
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
  api("GET", "/api/materials").then(async r => {
    const mats = r.data || [];
    const exs = (await api("GET", "/api/exhibitions")).data || [];
    const exName = id => (exs.find(e => e.id == id) || {}).name || "通用";
    if (!mats.length) { wrap.appendChild(el("div", { class: "empty" }, "暂无资料，点击上传")); return; }
    const t = el("table", { class: "tbl" });
    t.appendChild(el("tr", {}, ["资料名称", "所属展会", "上传时间", "操作"].map(h => el("th", {}, h))));
    mats.forEach(m => {
      const tr = el("tr");
      tr.appendChild(el("td", {}, m.name));
      tr.appendChild(el("td", {}, exName(m.exhibition_id)));
      tr.appendChild(el("td", {}, m.created_at));
      const td = el("td");
      const del = el("button", { class: "btn btn-sm btn-danger" }, "删除");
      del.onclick = async () => { await api("DELETE", "/api/materials/" + m.id); render(); };
      td.appendChild(del); tr.appendChild(td); t.appendChild(tr);
    });
    wrap.appendChild(t);
  });
  return wrap;
}
async function uploadModal() {
  const exs = (await api("GET", "/api/exhibitions")).data || [];
  const html = `<div class="cfg-row"><label>资料名称</label><input id="m-name" class="inp" placeholder="如：SIAL展位图2026.pdf"></div>
    <div class="cfg-row"><label>所属展会 <span style="font-size:11px;color:#888;font-weight:normal">（可输入新名称或选择已有）</span></label>
      <input id="m-ex" class="inp" list="m-ex-dl" placeholder="输入或选择展会名称，留空=通用">
      <datalist id="m-ex-dl">${exs.map(e => `<option value="${esc(e.name)}">`).join("")}</datalist>
    </div>
    <div class="cfg-row"><label>选择文件（PDF/图片，演示以 base64 存储）</label><input id="m-file" type="file" class="inp"></div>
    <button class="btn btn-primary btn-block" id="m-go">上传</button>`;
  openModal("上传展会资料", html);
  $("#m-go").onclick = async () => {
    const f = $("#m-file").files[0];
    if (!f) { toast("请选择文件"); return; }
    const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(f); });
    const exName = ($("#m-ex").value || "").trim();
    // 如果输入了展会名称，先查找或创建
    let exId = null;
    if (exName) {
      const matched = exs.find(e => e.name === exName);
      if (matched) { exId = matched.id; }
      else {
        // 新展会：自动创建
        const cr = await api("POST", "/api/exhibitions", { name: exName, city: "", date_text: "", note: "上传资料时创建" });
        if (cr.ok) {
          exs.push({ id: cr.data?.id || exs.length + 1, name: exName });
          toast("已自动新建展会：" + exName);
        }
      }
    }
    await api("POST", "/api/materials", { name: $("#m-name").value || f.name, exhibition_id: exId, content_b64: b64 });
    closeModal(); toast("资料已上传"); render();
  };
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

  const actionBar = el("div", { class: "action-bar" });
  const btnCreate = el("button", { class: "btn btn-primary" }, "➕ 新建成员 / 管理员");
  btnCreate.onclick = () => openCreateUser();
  const btnMyPwd = el("button", { class: "btn btn-ok" }, "🔑 修改我的密码");
  btnMyPwd.onclick = () => openChangeMyPassword();
  actionBar.appendChild(btnCreate); actionBar.appendChild(btnMyPwd);
  wrap.appendChild(actionBar);

  const card = el("div", { class: "card" });
  card.appendChild(el("div", { class: "label" }, "成员账号列表"));
  const table = el("table", { class: "tbl" });
  table.innerHTML = `<thead><tr><th>ID</th><th>用户名</th><th>显示名称</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="admin-users-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>`;
  card.appendChild(table);
  wrap.appendChild(card);

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
    <div class="cfg-row"><label>原密码 *</label><input id="mp-old" class="inp" type="password" placeholder="当前登录密码"></div>
    <div class="cfg-row"><label>新密码 *</label><input id="mp-new" class="inp" type="password" placeholder="至少 4 位"></div>
    <div class="action-bar"><button class="btn btn-primary" id="mp-ok">确认修改</button></div>`;
  openModal("修改我的密码", html);
  $("#mp-ok").onclick = async () => {
    const oldp = $("#mp-old").value, newp = $("#mp-new").value;
    if (newp.length < 4) { toast("新密码至少 4 位"); return; }
    const r = await api("POST", "/api/me/change-password", { old_password: oldp, new_password: newp });
    if (r.ok) { toast("密码已修改，下次登录请使用新密码"); closeModal(); }
    else toast("失败：" + (r.data.error || ""));
  };
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
init();
