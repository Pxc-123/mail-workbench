# 销售邮件发送工作台 - CloudBase 云托管容器镜像
FROM python:3.13-slim

WORKDIR /app

# 先装依赖（利用 Docker 缓存层）
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
# 显式确保 openpyxl 已安装（防止 requirements.txt 缓存/遗漏）
RUN pip install --no-cache-dir openpyxl==3.1.5

# 复制应用代码
COPY app.py /app/app.py
COPY frontend /app/frontend

# 注意：不要将 workbench.db 烤进镜像。
# 数据库由 init_db() 在首次启动时自动创建（含 admin/admin123）。
# 生产环境必须在 CloudBase 控制台挂载持久化存储（如 CFS），并把
# 环境变量 DB_PATH 指向挂载目录（例如 /data/workbench.db），
# 否则容器重启/重部署会导致数据丢失。

# CloudBase 云托管服务端口（必须与控制台配置的「服务端口」一致）
ENV PORT=8080
EXPOSE 8080

CMD ["python", "app.py"]
