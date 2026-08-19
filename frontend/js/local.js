/* 纯前端数据层：替代后端 API，使用浏览器 localStorage 持久化。
   用于把工作台部署为「无需服务器、可公网分享」的版本。
   关键说明：纯前端无法直连 SMTP，所有“发送”都会生成标准 .eml 邮件文件，
   由您用自己的邮件客户端（Outlook / Foxmail / 网页邮箱 等）打开后真正发送。 */
(function (global) {
  const LS_USERS = "wb_users";
  const LS_CUR = "wb_cur_user";
  const LS_DATA = "wb_data";
  const LS_USEROBJ = "wb_user";

  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function curUser() { return localStorage.getItem(LS_CUR) || ""; }
  function nowISO() { return new Date().toISOString().slice(0, 19).replace("T", " "); }
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str || "");
    let bin = ""; bytes.forEach(b => bin += String.fromCharCode(b)); return btoa(bin);
  }
  function nid(d) { return d.seq++; }

  function getData() {
    const u = curUser();
    if (!u) return null;
    const all = lsGet(LS_DATA, {});
    if (!all[u]) all[u] = { seq: 1, todos: [], customers: [], tags: [], templates: [], materials: [], logs: [], settings: { signature: "招展顾问", default_interval: 5 } };
    return all[u];
  }
  function setData(d) { const all = lsGet(LS_DATA, {}); all[curUser()] = d; lsSet(LS_DATA, all); }

  const EXHIBITIONS = [
    { id: 1, name: "SIAL 巴黎食品展" },
    { id: 2, name: "越南食品展 VietFood" },
    { id: 3, name: "德国科隆食品展 Anuga" },
    { id: 4, name: "日本国际食品展 Foodex Japan" },
    { id: 5, name: "泰国 THAIFEX 食品展" },
    { id: 6, name: "印尼 SIAL InterFood" },
    { id: 7, name: "迪拜 Gulfood 食品展" },
  ];

  const SCENE_LABELS = { "1": "初次开发陌生客户", "2": "跟进意向客户推送最新行业新闻", "3": "通知展位余量紧张催单", "4": "展会补贴政策通知", "5": "发送参展报价方案", "6": "客户跟进回访", "7": "参展感谢与维系" };
  const TONE_LABELS = { "正式商务": "正式商务", "简洁干练": "简洁干练", "温和友好": "温和友好", "简短": "简短" };
  const TYPE_INTRO = {
    "预制菜": "贵司在预制菜领域的产品矩阵与出海布局",
    "调味品": "贵司在调味品赛道的产品创新与海外渠道拓展",
    "零食": "贵司在休闲零食品类的爆款打造与跨境销售",
    "原料": "贵司作为食品原料供应商的产能与品质优势",
    "综合食品企业": "贵司综合食品业务的多品类出海机会",
  };

  function buildEmail(exhibition, customer_type, scene, tone, custom_input, signature) {
    const ex = exhibition || "本次海外食品展";
    const ctype = customer_type || "食品企业";
    const scene_key = SCENE_LABELS[scene] ? scene : "1";
    const tone_key = TONE_LABELS[tone] ? tone : "正式商务";
    const intro = TYPE_INTRO[ctype] || "贵司在食品领域的产品与渠道优势";
    const news = (custom_input || "").trim();
    const salutation = "尊敬的 {联系人姓名}（{客户名称}）：";
    const scene_body = {
      "1": `您好！我是「${ex}」中国区招展团队的{销售姓名}。${ex}作为全球食品行业最具影响力的专业展会之一，每年汇聚来自世界各地的采购商、品牌商与渠道方。结合${intro}，我们相信贵司非常契合本次展会的买家画像。\n\n借此邮件，诚挚邀请贵司莅临${ex}，与海外买家面对面洽谈、拓展订单。如您方便，我可先发送展位图与参展方案供参考。`,
      "2": `您好！持续关注贵司在海外市场的进展。近期食品行业有几条值得留意的动态，特别与${intro}相关：\n\n${news ? "【行业资讯】\n" + news : "【行业资讯】近期多国进口食品需求回暖，买家采购意愿明显增强。"}\n\n结合上述趋势，${ex}将是贵司触达精准海外买家的优质窗口。如需，我可补充本次展会的买家结构与往届成交数据。`,
      "3": `您好！关于${ex}，需向您同步一个重要进展：目前优质展位余量已非常紧张，尤其贴合${intro}的展区所剩无几。\n\n${news ? "您此前关注的重点如下：\n" + news + "\n" : ""}为保障贵司的参展位置与最佳曝光，建议尽快确认展位意向，避免错失黄金档期。我可为您预留 48 小时优先选位。`,
      "4": `您好！就贵司关注出海拓展的成本问题，特向您同步${ex}相关的参展补贴政策：多地商务主管部门对中小企业海外参展给予展位费补贴（通常 50%~70% 不等），可显著降低出海门槛。\n\n${news ? "政策要点：\n" + news + "\n" : ""}如贵司计划参展，建议尽早确认以赶上补贴申报周期，我可协助准备相关材料。`,
      "5": `您好！关于贵司关注的${ex}，我们已初步测算参展投入与回报，现将报价方案同步如下：\n\n【展位方案】\n· 标准展位（9㎡）：含基础搭建、楣板、照明、洽谈桌 —— 适合首次试水\n· 光地展位（18㎡起）：可定制特装，最大化品牌曝光\n· 双开口/角位：+15%，人流与曝光更优\n\n结合${intro}，建议优先选择贴合贵司品类的展区，预计可触达大量精准海外买家。\n\n以上为初步报价框架，最终方案可据贵司展品种类与预算灵活调整。如需要，我可发送完整版报价单与展位图。`,
      "6": `您好！距我们上次沟通已有一段时间，特来跟进贵司关于${ex}的参展意向，也想确认接下来的配合节奏。\n\n想和您对齐三点：\n1）参展预算与档期是否已排定？\n2）希望重点对接哪类海外买家（经销商/品牌方/商超采购）？\n3）是否需要我们协助准备展品运输与人员签证材料？\n\n${news ? "【您之前关注的信息】\n" + news + "\n" : ""}目前${ex}优质展位余量有限，若确定参展建议尽快锁定，以免错失黄金位置。我可先为贵司预留 48 小时优先选位。`,
      "7": `您好！感谢贵司对${ex}的关注与支持！无论最终是否成行，都十分珍视与贵司的交流。\n\n如贵司后续有出海拓展、买家对接或展会相关的任何需求，我们随时提供协助——包括展后买家名单、行业报告与下一届档期预告。\n\n期待未来有机会与贵司在展会现场或线上深入合作。祝生意兴隆！`,
    }[scene_key];
    const tone_tail = { "正式商务": "静候佳音，顺颂商祺。", "简洁干练": "期待您的回复，we can move fast.", "温和友好": "无论是否参展，都欢迎随时交流，祝生意兴隆！", "简短": "盼复，谢谢。" }[tone_key];
    let body = scene_body;
    if (tone_key === "简短") body = scene_body.split("\n\n")[0];
    body = `${salutation}\n\n${body}\n\n${tone_tail}\n\n${signature || "{销售姓名}"}｜${ex} 招展团队`;
    const subject_map = {
      "1": `邀您共赴 ${ex}｜拓展海外买家渠道`,
      "2": `[${ctype}行业资讯] 附 ${ex} 出海机会`,
      "3": `【展位余量提醒】${ex} 优质展区所剩无几`,
      "4": `【补贴政策】${ex} 参展补贴可显著降低出海成本`,
      "5": `【参展报价方案】${ex} 展位费用与投入回报`,
      "6": `【跟进】${ex} 参展意向确认，请查收`,
      "7": `【感谢】感谢关注 ${ex}，后续资源持续开放`,
    };
    return { subject: subject_map[scene_key], body };
  }

  function personalize(text, customer, salesName) {
    if (!text) return "";
    const rep = { "{客户名称}": customer.company || "", "{联系人姓名}": customer.contact || "", "{销售姓名}": salesName || "", "{邮箱}": customer.email || "", "{手机号}": customer.phone || "", "{意向展会}": customer.exhibition || "" };
    for (const k in rep) text = text.split(k).join(rep[k]);
    return text;
  }

  function parseCSV(text) {
    const lines = (text || "").replace(/\r/g, "").split("\n").filter(l => l.trim().length);
    if (!lines.length) return [];
    const headers = lines[0].split(",").map(h => h.trim());
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(",");
      const row = {};
      headers.forEach((h, idx) => row[h] = (cells[idx] || "").trim());
      out.push(row);
    }
    return out;
  }

  function buildEML(o) {
    const subjB64 = "=?UTF-8?B?" + b64encode(o.subject || "") + "?=";
    const lines = [];
    lines.push("From: " + (o.fromName ? `${o.fromName} <${o.fromEmail}>` : (o.fromEmail || "noreply@workbench.local")));
    lines.push("To: " + o.toEmail);
    if (o.cc && o.cc.length) lines.push("Cc: " + o.cc.join(", "));
    if (o.bcc && o.bcc.length) lines.push("Bcc: " + o.bcc.join(", "));
    lines.push("Subject: " + subjB64);
    lines.push("Date: " + new Date().toUTCString());
    lines.push("MIME-Version: 1.0");
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("");
    lines.push(o.body || "");
    return lines.join("\r\n");
  }
  function downloadEMLFile(filename, content) {
    try {
      const blob = new Blob([content], { type: "message/rfc822;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    } catch (e) {}
  }
  global.downloadEML = function (log) {
    if (!log || !log.eml) { alert("该邮件未生成 .eml 内容"); return; }
    downloadEMLFile("邮件_" + (log.contact || log.customer_company || "客户") + ".eml", log.eml);
  };

  function seedDemo(d) {
    const today = new Date();
    const fmt = n => { const x = new Date(today); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
    const presets = ["预制菜客户", "调味品客户", "零食客户", "原料客户", "高意向", "待跟进"];
    presets.forEach(p => d.tags.push({ id: nid(d), name: p }));
    [["XX预制菜工厂", "王总", "wang@xx-food.com", "13800000001", "SIAL 巴黎食品展", "预制菜客户,高意向"],
     ["YY调味品", "李总", "li@yy-sauce.com", "13800000002", "SIAL 巴黎食品展", "调味品客户"],
     ["ZZ休闲零食", "陈经理", "chen@zz-snack.com", "13800000003", "越南食品展 VietFood", "零食客户,待跟进"]].forEach(c =>
      d.customers.push({ id: nid(d), company: c[0], contact: c[1], email: c[2], phone: c[3], exhibition: c[4], tags: c[5], created_at: nowISO() }));
    [["跟进XX预制菜厂参展意向", fmt(1), "高"], ["发送SIAL展位图给YY调味品", fmt(2), "中"],
     ["整理越南食品展客户名单", fmt(0), "低"]].forEach(t =>
      d.todos.push({ id: nid(d), title: t[0], due_time: null, bind_date: t[1], priority: t[2], done: 0 }));
    const g = buildEmail("SIAL 巴黎食品展", "预制菜", "1", "正式商务", "", "招展顾问");
    d.templates.push({ id: nid(d), name: "SIAL-预制菜-初次开发", exhibition: "SIAL 巴黎食品展", customer_type: "预制菜", scene: "初次开发陌生客户", tone: "正式商务", subject: g.subject, body: g.body, signature: "招展顾问", attachment_ids: "", created_at: nowISO() });
  }

  /* 预置账号（方便直接登录体验） */
  const PRESET_USERS = {
    "alice": { pw: "123", name: "Alice" },
  };

  function route(method, path, body) {
    if (path === "/api/register" || path === "/api/login") {
      const users = lsGet(LS_USERS, {});
      // 注入预置账号（仅当不存在时）
      for (const [u, info] of Object.entries(PRESET_USERS)) { if (!users[u]) users[u] = info; }
      lsSet(LS_USERS, users);
      const uname = (body.username || "").trim();
      const pw = body.password || "";
      if (!uname || !pw) throw new Error("用户名和密码必填");
      if (path === "/api/register") {
        if (users[uname]) throw new Error("用户名已存在");
        users[uname] = { pw: pw, name: body.display_name || uname };
        lsSet(LS_USERS, users);
      } else {
        if (!users[uname] || users[uname].pw !== pw) throw new Error("用户名或密码错误");
      }
      localStorage.setItem(LS_CUR, uname);
      const uobj = { id: 1, username: uname, display_name: users[uname].name };
      localStorage.setItem(LS_USEROBJ, JSON.stringify(uobj));
      const d = getData();
      if (d.todos.length === 0 && d.customers.length === 0) seedDemo(d);
      setData(d);
      return { token: "local-" + uname, user: uobj };
    }

    if (method === "GET" && path === "/api/exhibitions") return EXHIBITIONS;

    const d = getData();
    if (!d) return method === "GET" ? [] : {};

    if (method === "GET") {
      if (path === "/api/todos") return d.todos.slice().sort((a, b) => (a.done - b.done));
      if (path === "/api/customers") return d.customers.slice();
      if (path === "/api/customers/stats") {
        const total = d.customers.length;
        const byStatus = {}; d.customers.forEach(c => { const s = c.status || "潜在客户"; byStatus[s] = (byStatus[s] || 0) + 1; });
        return { total, by_status: Object.entries(byStatus).map(([s, count]) => ({ s, c: count })) };
      }
      if (path === "/api/news/search") {
        return { source: "离线模式(缓存)", items: [
          "2026年全球食品包装机械市场规模预计突破580亿美元，亚太地区增速领跑",
          "RCEP全面生效两周年，中国食品机械对东盟出口同比增长28%",
          "欧盟新版食品接触材料法规(FCM)将于2026年底实施，出口企业需提前合规",
          "智能包装与可持续包装成为2026年国际展会核心主题，买家关注度提升40%",
          "东南亚食品加工市场快速扩张，越南、印尼、泰国成中国设备主要出口目的地",
        ], fetched_at: new Date().toISOString(), note: "离线模式显示缓存热点，联网后可获取实时资讯" };
      }
      if (path === "/api/tags") return d.tags.slice();
      if (path === "/api/templates") return d.templates.slice();
      if (path === "/api/materials") return d.materials.slice();
      if (path === "/api/email-logs") return d.logs.slice().sort((a, b) => b.id - a.id);
      if (path === "/api/settings") return d.settings;
      if (path.startsWith("/api/email-logs/")) { const id = +path.split("/").pop(); return d.logs.find(l => l.id === id) || {}; }
      throw new Error("not found");
    }

    if (method === "POST") {
      if (path === "/api/settings") { d.settings = Object.assign({}, d.settings, body); setData(d); return {}; }
      if (path === "/api/todos") {
        const t = { id: nid(d), title: body.title || "未命名", due_time: body.due_time || null, bind_date: body.bind_date || null, priority: body.priority || "中", done: 0 };
        d.todos.push(t); setData(d); return t;
      }
      if (path === "/api/customers") {
        const c = { id: nid(d), company: body.company || "", contact: body.contact || "", email: body.email || "", phone: body.phone || "", exhibition: body.exhibition || "", tags: body.tags || "", status: body.status || "潜在客户", created_at: nowISO() };
        d.customers.push(c); setData(d); return c;
      }
      if (path === "/api/customers/batch-delete") {
        const ids = (body.ids || []).map(String);
        const before = d.customers.length;
        d.customers = d.customers.filter(c => !ids.includes(String(c.id)));
        setData(d);
        return { ok: true, deleted: before - d.customers.length };
      }
      if (path === "/api/customers/import") {
        const rows = parseCSV(body.csv || "");
        let count = 0;
        rows.forEach(r => {
          const company = r["客户公司"] || r["company"] || "";
          if (!company) return;
          d.customers.push({ id: nid(d), company, contact: r["联系人"] || r["contact"] || "", email: r["邮箱"] || r["email"] || "", phone: r["手机号"] || r["phone"] || "", exhibition: r["意向展会"] || r["exhibition"] || "", tags: r["客户标签"] || r["tags"] || "", created_at: nowISO() });
          count++;
        });
        setData(d); return { imported: count };
      }
      if (path === "/api/tags") {
        const ex = d.tags.find(t => t.name === body.name);
        if (ex) return ex;
        const t = { id: nid(d), name: body.name };
        d.tags.push(t); setData(d); return t;
      }
      if (path === "/api/templates") {
        const t = { id: nid(d), name: body.name || "未命名", exhibition: body.exhibition || "", customer_type: body.customer_type || "", scene: body.scene || "", tone: body.tone || "", subject: body.subject || "", body: body.body || "", signature: body.signature || "", attachment_ids: body.attachment_ids || "", created_at: nowISO() };
        d.templates.push(t); setData(d); return t;
      }
      if (path === "/api/materials") {
        const m = { id: nid(d), name: body.name || "资料", exhibition_id: body.exhibition_id || null, created_at: nowISO(), content_b64: body.content_b64 || "" };
        d.materials.push(m); setData(d); return m;
      }
      if (path === "/api/ai/generate") { return buildEmail(body.exhibition, body.customer_type, body.scene, body.tone, body.custom_input, body.signature); }
      if (path === "/api/email/preview") {
        let customers = [];
        if (body.customer_ids && body.customer_ids.length) customers = d.customers.filter(c => body.customer_ids.includes(c.id));
        if (body.csv && body.csv.trim()) parseCSV(body.csv).forEach(r => customers.push({ company: r["客户公司"] || r["company"] || "", contact: r["联系人"] || r["contact"] || "", email: r["邮箱"] || r["email"] || "", phone: r["手机号"] || r["phone"] || "", exhibition: r["意向展会"] || r["exhibition"] || "" }));
        const tag_filter = (body.tag_filter || "").trim();
        if (tag_filter) customers = customers.filter(c => (c.tags || "").split(",").map(s => s.trim()).includes(tag_filter));
        const seen = new Set(); const uniq = [];
        customers.forEach(c => { const e = (c.email || "").trim().toLowerCase(); if (e && seen.has(e)) return; seen.add(e); uniq.push(c); });
        const salesName = d.settings.signature || curUser();
        const items = uniq.map(c => ({ company: c.company, contact: c.contact, email: c.email, subject: personalize(body.subject || "", c, salesName), body: personalize(body.body || "", c, salesName) }));
        return { count: items.length, items };
      }
      if (path === "/api/email/send") {
        const items = body.items || [];
        const cc = body.cc || []; const bcc = body.bcc || [];
        const salesName = d.settings.signature || curUser();
        const fromEmail = d.settings.from_email || "noreply@workbench.local";
        const fromName = d.settings.from_name || salesName;
        const results = [];
        items.forEach((it, i) => {
          const c = { company: it.company, contact: it.contact, email: it.email };
          const subject = personalize(it.subject || "", c, salesName);
          const bodyText = personalize(it.body || "", c, salesName);
          const to = (it.email || "").trim();
          const status = to ? "success" : "failed";
          const error = to ? "" : "缺少收件邮箱";
          const eml = to ? buildEML({ fromName, fromEmail, toEmail: to, subject, body: bodyText, cc, bcc }) : "";
          d.logs.push({ id: nid(d), sent_at: nowISO(), exhibition: body.exhibition || "", template_name: body.template_name || "", customer_company: it.company, contact: it.contact, email: to, subject, body: bodyText, status, error, eml });
          results.push({ email: to, status });
          if (i === 0 && to) downloadEMLFile("示例邮件_" + (it.contact || "客户") + ".eml", eml);
        });
        setData(d);
        return { results, demo_mode: false };
      }
      throw new Error("not found");
    }

    if (method === "PATCH") {
      const m = path.match(/^\/api\/todos\/(\d+)$/);
      if (m) { const t = d.todos.find(x => x.id === +m[1]); if (t) { Object.assign(t, body); setData(d); } return t || {}; }
      throw new Error("not found");
    }

    if (method === "PUT") {
      let m = path.match(/^\/api\/customers\/(\d+)$/);
      if (m) { const c = d.customers.find(x => x.id === +m[1]); if (c) { Object.assign(c, body); setData(d); } return c || {}; }
      throw new Error("not found");
    }

    if (method === "DELETE") {
      let m = path.match(/^\/api\/todos\/(\d+)$/);
      if (m) { d.todos = d.todos.filter(x => x.id !== +m[1]); setData(d); return {}; }
      m = path.match(/^\/api\/customers\/(\d+)$/);
      if (m) { d.customers = d.customers.filter(x => x.id !== +m[1]); setData(d); return {}; }
      m = path.match(/^\/api\/templates\/(\d+)$/);
      if (m) { d.templates = d.templates.filter(x => x.id !== +m[1]); setData(d); return {}; }
      m = path.match(/^\/api\/materials\/(\d+)$/);
      if (m) { d.materials = d.materials.filter(x => x.id !== +m[1]); setData(d); return {}; }
      m = path.match(/^\/api\/tags\/(\d+)$/);
      if (m) { d.tags = d.tags.filter(x => x.id !== +m[1]); setData(d); return {}; }
      throw new Error("not found");
    }
    throw new Error("method not allowed");
  }

  global.__localApi = async function (method, path, body) {
    try {
      const data = route(method, path, body || {});
      return { ok: true, status: 200, data };
    } catch (e) {
      return { ok: false, status: 400, data: { error: e.message } };
    }
  };
})(window);
