# 销售邮件发送工作台 · 带后端完整版（可真实发信）部署包

本目录是一个**自包含**的发布包：后端（Python 标准库，零依赖）+ 前端（原生 JS）打包在一起。
部署到任意支持 Python 的云主机后，好友打开链接即可**真实发送邮件给客户**（不再是 .eml 文件）。

---

## 目录结构

```
deploy/
├── app.py            # 后端服务（同时托管前端 + 提供 API + 真发邮件）
├── frontend/         # 前端（已配置 backend 模式，同源真发）
├── requirements.txt  # 依赖：openpyxl / python-docx / pypdf（资料文本提取）+ COS SDK（云端备份）
├── Procfile          # Heroku / Render 启动命令
├── render.yaml       # Render 一键部署配置
├── railway.json      # Railway 部署配置
└── README_deploy.md  # 本文件
```

---

## 方式一：Render 免费部署（推荐，最简单）

1. 注册 https://render.com （可用 GitHub 登录）
2. 在 GitHub 新建一个仓库，把本 `deploy/` 目录内容**全部**上传（含 app.py、frontend/、配置文件）
3. Render 控制台 → **New → Web Service** → 关联该仓库
4. 设置：
   - **Runtime**: Python 3
   - **Build Command**: 留空（或 `echo ok`）
   - **Start Command**: `python app.py`
   - **Instance Type**: Free
5. 部署完成后，Render 会给一个 `https://xxx.onrender.com` 域名，直接发给好友即可。

> Render 免费版休眠后首次访问会冷启动几秒，属正常。

---

## 方式二：Railway 部署

1. 注册 https://railway.app
2. **New Project → Deploy from GitHub repo**，选择上传了 `deploy/` 的仓库
3. Railway 会自动读取 `railway.json`，使用 `python app.py` 启动
4. 部署完成后在 Settings 里拿到分配的域名。

---

## 方式三：自有 VPS / 服务器（Linux）

```bash
# 1. 上传 deploy/ 到服务器，例如 /opt/mailwb
# 2. 安装 Python 3.8+（一般已自带）
python3 --version

# 3. 后台启动（用 nohup 或 systemd / supervisor 均可）
cd /opt/mailwb
nohup python3 app.py > app.log 2>&1 &

# 4. 默认监听 0.0.0.0:8000，用 Nginx 反代到 80/443 并配域名 + HTTPS 即可
```

Nginx 反代示例：
```nginx
server {
    listen 80;
    server_name mail.你的域名.com;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 上线后怎么用（给好友说明）

1. 打开你的域名 → 点「注册新空间」创建账号（每个销售独立，数据互不可见）
2. 注册后已自动植入示例客户 / 待办 / 模板，进来即可体验
3. **配置发信**：进「系统设置」→ 点邮箱服务商预设（QQ/163/企业微信等）→ 填发件邮箱 + 授权码 → 关闭「演示模式」→ 保存
4. 去「AI 邮件模板中心」一键生成邮件 → 「批量发送」→ 预览每封个性化效果 → 确认发送
5. 邮件**真实到达客户邮箱**，并在「邮件记录」可查每封状态（成功/失败）

---

## 数据安全说明

- 每位用户的数据按账号隔离（`user_id`），互不可见。
- 邮件通过你配置的 SMTP 由**服务器直接发送**，不经过任何第三方。
- 数据库为单文件 `workbench.db`，备份只需复制该文件。
- **云端自动备份（推荐）**：配置腾讯云 COS 环境变量（`COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` / `COS_REGION`）后，每次数据变更自动同步到 COS；重新部署后启动时自动恢复，账号与导入资料不会丢失。管理员中心可查看备份状态并手动「立即备份到云端」。
- 若要重置演示数据：删除 `workbench.db` 重启即可。

---

## 本地调试

```bash
cd deploy
python app.py          # 默认 http://127.0.0.1:8000
# 浏览器打开即后端模式，注册账号后可真发（需先在设置配置 SMTP）
```
