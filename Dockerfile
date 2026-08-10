# 销售邮件发送工作台 - CloudBase 云托管容器镜像
FROM python:3.13-slim

WORKDIR /app

# 先装依赖（利用 Docker 缓存层）
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
# 显式确保 openpyxl 已安装（防止 requirements.txt 缓存/遗漏）
RUN pip install --no-cache-dir openpyxl==3.1.5

# 复制应用代码与数据
COPY app.py /app/app.py
COPY frontend /app/frontend
# 初始数据库（含 admin/admin123、alice/123 与演示客户）
# 生产环境请将 DB_PATH 指向云托管挂载的持久卷，避免容器重启丢数据
COPY workbench.db /app/workbench.db

# CloudBase 云托管默认转发到容器监听端口，这里用 80
ENV PORT=80
EXPOSE 80

CMD ["python", "app.py"]
