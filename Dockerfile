# 销售邮件发送工作台 - CloudBase 云托管容器镜像
FROM python:3.13-slim

WORKDIR /app

# 先装依赖（利用 Docker 缓存层）
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
# 显式确保关键依赖已安装（防止 requirements.txt 缓存/遗漏）
RUN pip install --no-cache-dir openpyxl==3.1.5 "cos-python-sdk-v5>=1.9.30"

# 复制应用代码
COPY app.py /app/app.py
COPY frontend /app/frontend

# 注意：不要将 workbench.db 烤进镜像。
# 数据库由 init_db() 在首次启动时自动创建（含 admin/admin123）。
# 数据持久化通过腾讯云 COS 实现（见 app.py 的 COS 同步逻辑）：
# 配置 COS_SECRET_ID / COS_SECRET_KEY / COS_REGION / COS_BUCKET 后，
# 数据库与附件会自动同步到 COS，容器重部署不会丢失数据。

# CloudBase 云托管服务端口（必须与控制台配置的「服务端口」一致）
ENV PORT=8080
EXPOSE 8080

CMD ["python", "app.py"]
