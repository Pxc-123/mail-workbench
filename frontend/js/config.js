/* 运行模式配置（由 index.html 在 app.js 之前加载）
 *
 * __MODE:
 *   "local"   → 纯前端模式（默认）。数据存浏览器本地，发送生成 .eml 文件。
 *              适合无需服务器的公网静态分享（如 CloudStudio 静态托管）。
 *   "backend" → 后端模式。直连真实后端，可真实发送邮件（好友打开即真发，无需 .eml）。
 *              __BACKEND_URL 填后端 API 基地址：同源部署留空 ""；跨域部署填完整 https 地址。
 *
 * 部署带后端的完整版时，把本文件改为：
 *   window.__MODE = "backend";
 *   window.__BACKEND_URL = "";   // 同源；或填 "https://你的后端域名"
 */
window.__MODE = "backend";
window.__BACKEND_URL = "";
