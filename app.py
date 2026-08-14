# -*- coding: utf-8 -*-
"""
销售邮件发送工作台 - 后端服务（Python 标准库，零外部依赖）
提供：多用户注册/登录（独立空间隔离）、待办、客户、标签、邮件模板、
展会资料、AI 生成、邮件预览/发送、发送日志、系统设置。
运行：python app.py  （默认 http://127.0.0.1:8000）
"""
import http.server
import socketserver
import sqlite3
import json
import os
import re
import random
import string
import hashlib
import datetime
import threading
import time
import urllib.parse
import csv
import io
import smtplib
import ssl
import mimetypes
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from http.server import BaseHTTPRequestHandler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 数据库路径支持环境变量覆盖（云托管/容器场景挂载持久盘时使用）
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "workbench.db"))
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", os.path.join(BASE_DIR, "..", "uploads"))
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ---------------------------- COS 持久化同步 ----------------------------
# 当配置了 COS 环境变量（COS_SECRET_ID / COS_SECRET_KEY / COS_REGION /
# COS_BUCKET）时，数据库文件与附件会自动同步到腾讯云 COS 对象存储。
# 这样即使 CloudBase 容器重部署 / 重启（本地文件系统是临时的），
# 客户数据、发送日志和附件都不会丢失。未配置时以下函数均为空操作，
# 不影响本地开发。
def _cos_cfg_ok():
    return all([
        os.environ.get("COS_SECRET_ID"),
        os.environ.get("COS_SECRET_KEY"),
        os.environ.get("COS_REGION"),
        os.environ.get("COS_BUCKET"),
    ])

COS_ENABLED = _cos_cfg_ok()
COS_PREFIX = os.environ.get("COS_PREFIX", "mailwb/").strip()
if COS_PREFIX and not COS_PREFIX.endswith("/"):
    COS_PREFIX += "/"

_cos_client = None
_cos_client_lock = threading.Lock()
_cos_sync_lock = threading.Lock()
_cos_sync_pending = False
_cos_worker = None

def get_cos_client():
    global _cos_client
    if not COS_ENABLED:
        return None
    if _cos_client is None:
        with _cos_client_lock:
            if _cos_client is None:
                try:
                    from qcloud_cos import CosConfig, CosS3Client
                    _cos_client = CosS3Client(CosConfig(
                        Region=os.environ["COS_REGION"],
                        SecretId=os.environ["COS_SECRET_ID"],
                        SecretKey=os.environ["COS_SECRET_KEY"],
                    ))
                except Exception as e:
                    print("[COS] 初始化失败：", e, flush=True)
                    _cos_client = False
    return _cos_client or None

def _cos_db_key():
    return COS_PREFIX + "workbench.db"

def _cos_upload_file(local_path, cos_key):
    client = get_cos_client()
    if not client or not os.path.exists(local_path):
        return False
    try:
        with open(local_path, "rb") as f:
            client.put_object(
                Bucket=os.environ["COS_BUCKET"],
                Key=cos_key,
                Body=f,
            )
        return True
    except Exception as e:
        # 打印完整错误信息，便于排查（如密钥/桶名/地域不匹配）
        import traceback
        print("[COS] 上传失败 %s: %s" % (cos_key, e), flush=True)
        traceback.print_exc()
        return False

def cos_upload_db():
    return _cos_upload_file(DB_PATH, _cos_db_key())

def cos_upload_attachment(local_path):
    rel = os.path.relpath(local_path, UPLOAD_DIR)
    key = COS_PREFIX + "uploads/" + rel.replace(os.sep, "/")
    return _cos_upload_file(local_path, key)

def cos_download_db():
    if not COS_ENABLED:
        return False
    client = get_cos_client()
    if not client:
        return False
    tmp = DB_PATH + ".cosdl"
    try:
        resp = client.get_object(Bucket=os.environ["COS_BUCKET"], Key=_cos_db_key())
        resp["Body"].get_stream_to_file(tmp)
        os.replace(tmp, DB_PATH)
        print("[COS] 数据库已从云端恢复", flush=True)
        return True
    except Exception as e:
        try:
            os.remove(tmp)
        except Exception:
            pass
        print("[COS] 数据库下载失败（可能尚未存在）：", e, flush=True)
        return False

def cos_download_all_uploads():
    if not COS_ENABLED:
        return 0
    client = get_cos_client()
    if not client:
        return 0
    prefix = COS_PREFIX + "uploads/"
    n = 0
    try:
        marker = ""
        while True:
            resp = client.list_objects(Bucket=os.environ["COS_BUCKET"], Prefix=prefix,
                                       Marker=marker, MaxKeys=1000)
            for item in (resp.get("Contents") or []):
                key = item["Key"]
                rel = key[len(prefix):]
                if not rel or rel.endswith("/"):
                    continue
                dst = os.path.join(UPLOAD_DIR, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                try:
                    r = client.get_object(Bucket=os.environ["COS_BUCKET"], Key=key)
                    r["Body"].get_stream_to_file(dst)
                    n += 1
                except Exception as e:
                    print("[COS] 下载附件失败 %s: %s" % (key, e), flush=True)
            if resp.get("IsTruncated") == "true":
                marker = resp.get("NextMarker", "") or ""
            else:
                break
        print("[COS] 已恢复 %d 个附件到本地" % n, flush=True)
    except Exception as e:
        print("[COS] 列举附件失败：", e, flush=True)
    return n

def cos_clear_uploads():
    if not COS_ENABLED:
        return
    client = get_cos_client()
    if not client:
        return
    prefix = COS_PREFIX + "uploads/"
    try:
        marker = ""
        while True:
            resp = client.list_objects(Bucket=os.environ["COS_BUCKET"], Prefix=prefix,
                                       Marker=marker, MaxKeys=1000)
            objs = [{"Key": i["Key"]} for i in (resp.get("Contents") or [])]
            if objs:
                client.delete_objects(Bucket=os.environ["COS_BUCKET"], Delete={"Object": objs})
            if resp.get("IsTruncated") == "true":
                marker = resp.get("NextMarker", "") or ""
            else:
                break
    except Exception as e:
        print("[COS] 清理云端附件失败：", e, flush=True)

def _cos_worker_loop():
    while True:
        time.sleep(2)
        with _cos_sync_lock:
            if not _cos_sync_pending:
                continue
            _cos_sync_pending = False
        try:
            cos_upload_db()
        except Exception as e:
            print("[COS] 同步失败（不影响系统运行）：%s" % e, flush=True)

def _schedule_cos_db_sync():
    global _cos_worker
    if not COS_ENABLED:
        return
    with _cos_sync_lock:
        _cos_sync_pending = True
        if _cos_worker is None:
            _cos_worker = threading.Thread(target=_cos_worker_loop, daemon=True)
            _cos_worker.start()

# 内存会话表 token -> user_id
SESSIONS = {}
SESS_LOCK = threading.Lock()

# ---------------------------- 数据库 ----------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH, factory=_PersistedConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

class _PersistedConnection(sqlite3.Connection):
    """包装 SQLite 连接，每次 commit 后自动把数据库同步到 COS。"""
    def commit(self):
        super().commit()
        _schedule_cos_db_sync()

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT,
        pass_hash TEXT,
        salt TEXT,
        created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER PRIMARY KEY,
        smtp_host TEXT, smtp_port INTEGER, smtp_user TEXT, smtp_pass TEXT,
        from_email TEXT, from_name TEXT,
        default_interval INTEGER DEFAULT 5,
        demo_mode INTEGER DEFAULT 1,
        signature TEXT
    );
    CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        due_time TEXT,
        bind_date TEXT,
        priority TEXT DEFAULT '中',
        customer_id INTEGER,
        done INTEGER DEFAULT 0,
        created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        company TEXT,
        contact TEXT,
        email TEXT,
        phone TEXT,
        exhibition TEXT,
        tags TEXT DEFAULT '',
        remark TEXT DEFAULT '',
        region TEXT DEFAULT '',
        source TEXT DEFAULT '',
        created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS exhibitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        city TEXT,
        date_text TEXT,
        note TEXT
    );
    CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        exhibition_id INTEGER,
        name TEXT,
        file_path TEXT,
        created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT,
        exhibition TEXT,
        customer_type TEXT,
        scene TEXT,
        tone TEXT,
        subject TEXT,
        body TEXT,
        signature TEXT,
        attachment_ids TEXT DEFAULT '',
        created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS email_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        exhibition TEXT,
        template_name TEXT,
        customer_company TEXT,
        contact TEXT,
        email TEXT,
        subject TEXT,
        body TEXT,
        status TEXT,
        error TEXT,
        sent_at TEXT
    );
    """)
    # 预置展会（全局共享只读，存到 user_id=0 表示系统级）
    c.execute("SELECT COUNT(*) AS n FROM exhibitions WHERE user_id=0")
    if c.fetchone()["n"] == 0:
        for ex in [("SIAL 巴黎食品展","法国巴黎","2026-10-18 ~ 10-22"),
                   ("越南国际食品展","越南胡志明市","2026-08-12 ~ 08-15"),
                   ("德国 ANUGA 食品展","德国科隆","2026-10-07 ~ 10-11"),
                   ("日本 FOODEX","日本千叶","2027-03-09 ~ 03-12"),
                   ("泰国 THAIFEX","泰国曼谷","2026-05-26 ~ 05-30")]:
            c.execute("INSERT INTO exhibitions (user_id,name,city,date_text) VALUES (0,?,?,?)", ex)
    # 用户角色列（admin / member），旧库安全添加
    try:
        c.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'member'")
    except Exception:
        pass
    # 客户扩展列（remark/region/source），旧库安全添加
    for col in ["remark TEXT DEFAULT ''", "region TEXT DEFAULT ''", "source TEXT DEFAULT ''"]:
        try:
            c.execute(f"ALTER TABLE customers ADD COLUMN {col}")
        except Exception:
            pass
    # 预置管理员账号（保证系统始终至少有一个管理员）
    try:
        admin_count = c.execute("SELECT COUNT(*) AS n FROM users WHERE role='admin'").fetchone()["n"]
        if admin_count == 0:
            user_count = c.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
            if user_count == 0:
                # 空库：创建系统管理员
                ah, asalt = hash_pass("admin123")
                c.execute("INSERT INTO users (username,display_name,pass_hash,salt,created_at,role) VALUES (?,?,?,?,?,'admin')",
                          ("admin", "系统管理员", ah, asalt, now_iso()))
            else:
                # 有用户但无管理员：把第一个注册的用户提升为管理员
                first_uid = c.execute("SELECT id FROM users ORDER BY id ASC LIMIT 1").fetchone()["id"]
                c.execute("UPDATE users SET role='admin' WHERE id=?", (first_uid,))
    except Exception:
        pass
    conn.commit()
    conn.close()

# ---------------------------- 工具函数 ----------------------------
def now_iso():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def hash_pass(password, salt=None):
    if salt is None:
        salt = ''.join(random.choices(string.ascii_letters + string.digits, k=16))
    h = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
    return h, salt

def gen_token():
    return ''.join(random.choices(string.hexdigits, k=40))

def auth_user(handler):
    """从 Authorization: Bearer <token> 或 ?token= 解析用户"""
    auth = handler.headers.get("Authorization", "")
    token = None
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
    if not token:
        qs = urllib.parse.urlparse(handler.path).query
        token = urllib.parse.parse_qs(qs).get("token", [None])[0]
    if not token:
        # 也尝试从 body
        return None
    with SESS_LOCK:
        uid = SESSIONS.get(token)
    if not uid:
        return None
    conn = get_db()
    u = conn.execute("SELECT id,username,display_name,role FROM users WHERE id=?", (uid,)).fetchone()
    conn.close()
    return dict(u) if u else None

def require_user(handler):
    u = auth_user(handler)
    if not u:
        return None, json_resp({"error": "未登录或登录已过期"}, 401)
    return u, None

def require_admin(handler):
    u, err = require_user(handler)
    if err:
        return None, err
    if u.get("role") != "admin":
        return None, json_resp({"error": "需要管理员权限"}, 403)
    return u, None

def json_resp(obj, code=200):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return code, {"Content-Type": "application/json; charset=utf-8"}, body

def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}

def read_multipart(handler):
    """兼容接口：实际不再使用（改用 base64 JSON 方式传文件）"""
    return {}, {}

def row_to_dict(r):
    return dict(r) if r else None

# ---------------------------- AI 邮件生成（模板引擎，离线可用） ----------------------------
SCENE_LABELS = {
    "1": "初次开发陌生客户",
    "2": "跟进意向客户推送最新行业新闻",
    "3": "通知展位余量紧张催单",
    "4": "通知创新大奖申报截止提醒",
    "5": "展会补贴政策通知",
    "6": "发送参展报价方案",
    "7": "客户跟进回访",
    "8": "参展感谢与维系",
}
TONE_LABELS = {"正式商务": "正式商务", "简洁干练": "简洁干练", "温和友好": "温和友好", "简短": "简短"}

TYPE_INTRO = {
    "预制菜": "贵司在预制菜领域的产品矩阵与出海布局",
    "调味品": "贵司在调味品赛道的产品创新与海外渠道拓展",
    "零食": "贵司在休闲零食品类的爆款打造与跨境销售",
    "原料": "贵司作为食品原料供应商的产能与品质优势",
    "综合食品企业": "贵司综合食品业务的多品类出海机会",
}

# 展会特色数据(用于生成差异化文案)
# 说明：以下数据基于公开网络检索（各展会官网 / 行业资讯）整理，覆盖城市、档期、
# 规模、核心亮点与差异化的开场白，确保不同展会生成出来的邮件内容各不相同。
EXHIBITION_PROFILES = {
    "SIAL 巴黎食品展": {
        "city": "法国巴黎", "date_hint": "2026年10月", "scale": "全球最大食品展之一，70+国家参展商，30万+专业观众",
        "highlights": ["欧洲买家集中度最高", "新品发布首选平台", "OEM/ODM对接效率极高"],
        "openings": [
            "作为全球食品行业的风向标，SIAL Paris 每年都是中国食品企业进入欧洲市场的黄金跳板。",
            "SIAL Paris 2026 即将开幕——这是中国预制菜/调味品企业触达欧洲采购决策者的最佳窗口期。",
            "每届 SIAL 都有超过 70% 的参观者拥有直接采购权，这正是贵司需要的精准买家群体。",
        ],
    },
    "越南国际食品展": {
        "city": "越南胡志明市", "date_hint": "2026年8月", "scale": "东南亚增长最快食品展，覆盖东盟10国+日韩澳新",
        "highlights": ["RCEP红利直接受益", "越南制造+出口双需求", "中企入驻成本低于欧美"],
        "openings": [
            "越南食品市场正以年均12%的速度增长，而 VietFood 是切入这一市场的最短路径。",
            "RCEP 生效后，越南已成为中国食品企业布局东南亚的桥头堡——VietFood 正是入场券。",
            "胡志明市作为越南经济中心，其食品加工产业对华合作意愿强烈，正是拓展良机。",
        ],
    },
    "德国 ANUGA 食品展": {
        "city": "德国科隆", "date_hint": "2026年10月", "scale": "世界最大食品饮料展，每两年一届，180+国家参与",
        "highlights": ["全球食品行业奥林匹克", "B2B成交额行业第一", "趋势发布权威平台"],
        "openings": [
            "ANUGA 被誉为食品行业的'奥林匹克'——每两年一次，错过就要再等两年。",
            "科隆 ANUGA 是全球唯一能同时见到 180+ 国家顶级买家的展会，对出海战略意义非凡。",
            "往届 ANUGA 中国展区一位难求，今年我们提前锁定了一批优质展位资源。",
        ],
    },
    "日本 FOODEX": {
        "city": "日本千叶", "date_hint": "2027年3月", "scale": "亚洲最大食品展之一，日本7万+专业买家到场",
        "highlights": ["日本食品安全标准最高", "单价/利润空间最优", "健康/功能性食品需求爆发"],
        "openings": [
            "日本市场以高门槛、高利润著称——FOODEX Japan 是打开这扇门的钥匙。",
            "日本消费者对海外优质食品的需求持续攀升，尤其是健康、功能性品类。",
            "FOODEX Japan 的买家质量在亚洲首屈一指，单客订单价值远超其他区域。",
        ],
    },
    "泰国 THAIFEX": {
        "city": "泰国曼谷", "date_hint": "2026年5月", "scale": "东盟核心食品展，连接南亚+中东+非洲买家",
        "highlights": ["东盟美食之都", "清真认证枢纽", "酒店餐饮业采购集中"],
        "openings": [
            "曼谷 THAIFEX 已成为连接东盟、南亚乃至中东食品买家的核心枢纽。",
            "泰国作为东盟美食中心，其辐射力可直达迪拜、印度等新兴市场。",
            "THAIFEX 独特的'酒店+零售'双渠道买家结构，让参展效果倍增。",
        ],
    },
    # ----------------- 包装机械 / 食品加工技术类（联网检索整理） -----------------
    "Interpack": {
        "city": "德国杜塞尔多夫", "date_hint": "2026年5月7-13日", "scale": "全球最大包装技术展，2800+展商来自67国，17万+专业观众",
        "highlights": ["智能智造与AI驱动产线", "欧洲PPWR包装法规落地前沿", "循环经济与可持续材料", "初创专区22家新锐企业"],
        "openings": [
            "Interpack 2026 刚于5月在杜塞尔多夫落幕，作为全球包装技术的'奥林匹克'，它集中展示了从智能产线到可持续材料的全产业链创新——这正是贵司设备触达欧洲买家的最佳参照窗口。",
            "每届 Interpack 都有 2800+ 展商、17万+ 观众，74% 展商来自境外，是包装机械企业进入欧洲市场不可替代的平台。",
            "今年 Interpack 的核心命题是 PPWR 法规与循环经济，欧洲买家对高效、合规的包装设备需求空前迫切，这正是贵司的强项。",
        ],
    },
    "ProPak China": {
        "city": "中国上海（国家会展中心）", "date_hint": "2026年6月15-17日", "scale": "20万㎡全产业链盛会，2500+展商来自135国，12万+专业观众",
        "highlights": ["包装机械+食品加工一站式", "智能装备与机器人产线", "覆盖食品饮料乳品日化制药", "四展联动贯通上下游"],
        "openings": [
            "ProPak China & FoodPack China 2026 将于6月在上海国家会展中心举办，20万㎡、2500+ 展商，是亚太规模最大的加工包装联展，贵司的装备能在这里直面全球采购商。",
            "本届联展以'马跃新程·智链未来'为主题，八大主题板块聚焦前沿科技与落地方案，对贵司这样的设备厂商是绝佳的曝光舞台。",
            "上海加工包装联展背靠长三角制造集群，买家覆盖食品、饮料、乳品、日化、制药等全行业，参展即等于一次精准的渠道总动员。",
        ],
    },
    "Gulfood Manufacturing": {
        "city": "阿联酋迪拜（世界贸易中心）", "date_hint": "2026年11月3-5日", "scale": "中东最大食品制造展，2500+展商来自79国，6.1万+专业观众，21个馆",
        "highlights": ["中东/非洲食品制造枢纽", "加工·包装·配料·自动化全链", "阿联酋粮食安全战略驱动", "GulfHost/自有品牌/糖果展同馆"],
        "openings": [
            "Gulfood Manufacturing 是中东地区最具影响力的食品饮料制造展，迪拜正借'2051粮食安全战略'大力扶持本地化生产，对包装与加工设备需求井喷。",
            "2026 年海湾食品加工展将于11月在迪拜世贸中心举办，2500+ 全球展商、21个展馆，是中企切入中东+非洲市场的核心跳板。",
            "阿联酋食品市场进口依赖度高达80%-90%，同时转向本地化智造——这意味着贵司的包装机械在迪拜有着确定性的刚需。",
        ],
    },
    "Anuga FoodTec": {
        "city": "德国科隆", "date_hint": "2027年2月23-26日", "scale": "全球食品加工技术标杆展，1300+展商，4万+观众来自130国",
        "highlights": ["Smart·Safe·Sustainable 主题", "AI与数字化工厂", "Inline检测与全程可追溯", "循环经济与节能降耗"],
        "openings": [
            "Anuga FoodTec 2027 将于2月在科隆举办，主题'Navigate Complexity——智能、安全、可持续'，是全球食品饮料技术最重要的风向标。",
            "作为每三年一届的技术标杆展，Anuga FoodTec 汇聚1300+ 展商、4万+ 来自130国的观众，是贵司对接欧洲高端食品工程客户的必争之地。",
            "今年展会聚焦 AI、数字孪生与端到端可追溯，欧洲买家对'聪明又合规'的产线方案求贤若渴，这恰是贵司技术的用武之地。",
        ],
    },
    "PACK EXPO": {
        "city": "美国芝加哥（麦考密克）", "date_hint": "2026年10月18-21日", "scale": "北美最大包装展，2600展商，4.8万+专业观众，两年一届",
        "highlights": ["北美市场订单质量高", "智能包装与减塑轻量化", "覆盖40+垂直行业", "食品医药日化采购集中"],
        "openings": [
            "PACK EXPO International 2026 将于10月在芝加哥举办，是北美规模最大的包装旗舰展，北美买家对自动化、可持续与智能包装需求强劲。",
            "作为两年一届的北美包装盛会，PACK EXPO 汇聚2600家展商、4.8万专业观众，是中国包装设备打入美洲市场的高效通道。",
            "当前北美正加速向'减塑、轻量化、高效产线'转型，贵司在高速立式包装机、AI视觉质检等领域的优势正对买家胃口。",
        ],
    },
    "ProPak Asia": {
        "city": "泰国曼谷（IMPACT）", "date_hint": "2026年6月10-13日", "scale": "东南亚最大加工包装展，2500+品牌来自45国，6.5万㎡",
        "highlights": ["东盟加工包装旗舰展", "AI自动化与智慧工厂", "冷链与创新可持续包装", "15个国际展团同台"],
        "openings": [
            "ProPak Asia 2026 将于6月在曼谷 IMPACT 举办，是东南亚最大的食品加工与包装技术展，2500+ 品牌来自45国，是中企扎根东盟的门户。",
            "今年展会面积扩大20%至6.5万㎡，聚焦 AI 自动化、冷链与可持续包装，RCEP 红利下东盟买家采购意愿持续走强。",
            "曼谷作为东盟制造中心，ProPak Asia 的买家辐射泰国、越南、马来、新加坡，参展一次即可覆盖整个东南亚渠道。",
        ],
    },
    "FHA Food & Beverage": {
        "city": "新加坡博览中心", "date_hint": "2026年4月21-24日", "scale": "亚太最大食品饮料展，2750+展商来自115国，8万+观众，10万㎡",
        "highlights": ["东盟采购枢纽门户", "欧盟'荣誉展区'背书", "FutureFWD食品科技专区", "契合新加坡30×30国策"],
        "openings": [
            "FHA Food & Beverage 2026 将于4月在新加坡举办，是亚太规模最大的食品饮料 B2B 展，2750+ 展商、8万+ 观众，是中企进军东盟的总入口。",
            "新加坡是东盟的战略枢纽与转口贸易中心，FHA 汇聚115国买家，贵司可借此一站触达东南亚分销与零售巨头。",
            "今年欧盟作为'荣誉展区'亮相，加上 FutureFWD 食品科技专区，FHA 已成为亚洲食品创新与贸易配对的核心舞台。",
        ],
    },
    "IPACK-IMA": {
        "city": "意大利米兰（Fiera Milano）", "date_hint": "2026年5月27-30日", "scale": "欧洲第二大包装展，13万㎡，1300+展商，7万+观众",
        "highlights": ["欧洲高端包装市场精准对接", "智能与绿色包装技术", "契合欧盟PPWR新法规", "中意经贸合作深化"],
        "openings": [
            "IPACK-IMA 2026 将于5月在米兰举办，是欧洲第二大包装与食品加工展，13万㎡、1300+ 展商，直通意大利及南欧高端市场。",
            "米兰依托欧盟统一市场与高端制造底蕴，IPACK-IMA 对智能、绿色包装技术需求旺盛，是贵司对接欧洲高端终端的桥梁。",
            "在欧盟 PPWR 新法规背景下，欧洲买家急需合规又高效的包装产线，这恰是贵司技术切入意大利市场的窗口。",
        ],
    },
}

# 别名映射：让用户即使输入简称/中文名也能命中对应展会资料（大小写、空格、连字符均已归一化）
EXHIBITION_ALIASES = {
    "interpack": "Interpack", "interpack2026": "Interpack", "杜塞尔多夫包装展": "Interpack", "杜塞尔多夫": "Interpack",
    "propak china": "ProPak China", "propakchina": "ProPak China", "上海加工包装展": "ProPak China",
    "上海国际食品加工与包装机械展": "ProPak China", "上海包装展": "ProPak China",
    "gulfood manufacturing": "Gulfood Manufacturing", "gulfoodmanufacturing": "Gulfood Manufacturing",
    "迪拜海湾食品工业展": "Gulfood Manufacturing", "迪拜包装展": "Gulfood Manufacturing", "迪拜食品制造展": "Gulfood Manufacturing",
    "anuga foodtec": "Anuga FoodTec", "anugafoodtec": "Anuga FoodTec", "科隆食品加工展": "Anuga FoodTec", "科隆食品技术展": "Anuga FoodTec",
    "pack expo": "PACK EXPO", "packexpo": "PACK EXPO", "芝加哥包装展": "PACK EXPO", "美国包装展": "PACK EXPO",
    "propak asia": "ProPak Asia", "propakasia": "ProPak Asia", "曼谷包装展": "ProPak Asia", "泰国包装展": "ProPak Asia", "泰国加工包装展": "ProPak Asia",
    "fha": "FHA Food & Beverage", "fha food & beverage": "FHA Food & Beverage", "fha foodandbeverage": "FHA Food & Beverage",
    "新加坡食品展": "FHA Food & Beverage", "新加坡食品饮料展": "FHA Food & Beverage", "新加坡fha": "FHA Food & Beverage",
    "ipack-ima": "IPACK-IMA", "ipack ima": "IPACK-IMA", "ipackima": "IPACK-IMA", "米兰包装展": "IPACK-IMA", "意大利包装展": "IPACK-IMA",
    "sial": "SIAL 巴黎食品展", "sial paris": "SIAL 巴黎食品展", "巴黎食品展": "SIAL 巴黎食品展",
    "foodex": "日本 FOODEX", "foodex japan": "日本 FOODEX", "日本食品展": "日本 FOODEX",
    "thaifex": "泰国 THAIFEX", "曼谷食品展": "泰国 THAIFEX", "越南食品展": "越南国际食品展", "anuga": "德国 ANUGA 食品展",
}

def _norm_ex_name(s):
    return re.sub(r"[\s\-–—_.()（）【】\[\]]", "", (s or "").lower())

def resolve_exhibition_profile(name):
    """根据展会名称在内置检索资料中匹配（支持别名与包含匹配）。"""
    if not name:
        return {}
    n = _norm_ex_name(name)
    # 1) 精确（归一化）匹配
    for k, v in EXHIBITION_PROFILES.items():
        if _norm_ex_name(k) == n:
            return v
    # 2) 别名匹配
    if n in EXHIBITION_ALIASES:
        return EXHIBITION_PROFILES.get(EXHIBITION_ALIASES[n], {})
    # 3) 双向包含匹配
    for k, v in EXHIBITION_PROFILES.items():
        nk = _norm_ex_name(k)
        if nk and (nk in n or n in nk):
            return v
    return {}

def _normalize_date_text(s):
    """把 Excel 序列号（如 46508）统一为 YYYY-MM-DD；已合规或无法识别则原样返回。"""
    if not s:
        return s
    s = str(s).strip()
    if re.match(r"^\d{4,6}$", s):
        try:
            return (datetime.datetime(1899, 12, 30) + datetime.timedelta(days=int(s))).strftime("%Y-%m-%d")
        except Exception:
            return s
    return s

def get_exhibition_profile(name, uid=None):
    """读取「展会资料库」中维护的真实展会资料（城市/档期/简介）。
    展会资料库是共享资料，对所有账号生效：优先匹配本人维护的条目，
    否则匹配任意条目（含全局/其他账号导入的）。
    最终与内置检索资料（含真实亮点）做合并：内置亮点/规模优先保留，
    DB 提供的真实城市/档期若有则覆盖，确保“不同展会不同亮点”且不全空。"""
    builtin = resolve_exhibition_profile(name)  # 内置检索资料（真实亮点）
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT user_id,name,city,date_text,note FROM exhibitions"
        ).fetchall()
        conn.close()
        n = _norm_ex_name(name)
        best = None
        for r in rows:
            rn = _norm_ex_name(r["name"])
            if rn == n or rn in n or n in rn:
                cand = {
                    "city": r["city"] or "",
                    "date_hint": _normalize_date_text(r["date_text"] or ""),
                    "scale": "",
                    "highlights": [(r["note"] or "").strip()] if (r["note"] or "").strip() else [],
                    "openings": [],
                    "_from_db": True,
                }
                if r["user_id"] == (uid or -1):  # 优先本人维护的
                    best = cand
                    break
                if best is None:
                    best = cand
        if best is not None or builtin:
            merged = {"city": "", "date_hint": "", "scale": "", "highlights": [], "openings": []}
            merged.update(builtin)  # 先铺内置（含真实亮点/规模）
            if best:
                if best["city"]:
                    merged["city"] = best["city"]
                if best["date_hint"]:
                    merged["date_hint"] = best["date_hint"]
                if best["highlights"]:
                    merged["highlights"] = best["highlights"]
                merged["_from_db"] = True
            return merged
    except Exception:
        pass
    return builtin

# 差异化开场白池(随机选取避免雷同)
OPENING_VARIANTS = [
    "您好！希望这封邮件没有打扰您的工作节奏。",
    "您好！感谢您抽出时间阅读这封信。",
    "您好！冒昧来信，是觉得以下信息可能对贵司有价值。",
    "您好！在这个信息过载的时代，我只说重点。",
    "您好！直接切入正题——有一个机会想和您同步。",
]

# 差异化结尾池
CLOSING_VARIANTS = [
    "如需进一步了解展会详情或展位方案，随时欢迎联系我。期待您的回复！",
    "我会在本周内跟进您的反馈。如有任何疑问，请随时告知。",
    "附件中包含本次展会的详细资料供您参考。期待与贵司在展会现场相见！",
    "如方便的话，我们可以安排一个简短的电话沟通具体需求。",
    "无论最终是否参展，都感谢您的时间。祝生意兴隆！",
]

def _build_ex_info(ex, profile):
    """根据展会资料（可能只有城市/档期/亮点中的部分字段）构建信息段落。"""
    if not profile:
        return f"【{ex}】"
    lines = [f"【{ex}】"]
    if profile.get("city"):
        lines.append(f"📍 举办地：{profile['city']}")
    if profile.get("date_hint"):
        lines.append(f"📅 展期：{_normalize_date_text(profile['date_hint'])}")
    if profile.get("scale"):
        lines.append(f"📊 规模：{profile['scale']}")
    hl = profile.get("highlights") or []
    if hl:
        lines.append("✨ 核心亮点：" + "、".join(hl[:3]))
    return "\n".join(lines)

def build_email(exhibition, customer_type, scene, tone, custom_input, signature, uid=None):
    ex = exhibition or "本次海外食品展"
    ctype = customer_type or "食品企业"
    scene_key = scene if scene in SCENE_LABELS else "1"
    tone_key = tone if tone in TONE_LABELS else "正式商务"
    intro = TYPE_INTRO.get(ctype, "贵司在食品领域的产品与渠道优势")
    news = (custom_input or "").strip()

    # 获取展会特色数据：优先用户在「展会资料库」维护的真实资料，其次内置检索资料
    profile = get_exhibition_profile(ex, uid)
    ex_city = profile.get("city", "")
    ex_scale = profile.get("scale", "")
    ex_highlights = profile.get("highlights", [])
    hl2 = "、".join(ex_highlights[:2]) if ex_highlights else ""
    # 随机选取开场白和结尾（有展会专属开场白时优先用，内容更贴合）
    opening = random.choice(profile["openings"]) if profile.get("openings") else random.choice(OPENING_VARIANTS)
    closing = random.choice(CLOSING_VARIANTS)
    ex_info_para = _build_ex_info(ex, profile)

    # 称呼占位（发送时按客户替换）
    salutation = "尊敬的 {联系人姓名}（{客户名称}）："

    scene_body = {
        "1": (
            f"{opening}\n\n"
            f"我是「{ex}」中国区招展团队的成员。本次致信是希望向贵司介绍这一重要的海外拓展机会。\n\n"
            f"{ex_info_para}\n\n"
            f"结合{intro}，我们相信贵司的产品与本次展会的买家画像高度契合。\n\n"
            f"借此邮件，诚挚邀请贵司莅临{ex}，与海外买家面对面洽谈、拓展订单。如您方便，我可先发送展位图与参展方案供参考。\n\n"
            f"{closing}"
        ),
        "2": (
            f"{opening}\n\n"
            f"持续关注贵司在海外市场的进展。近期食品行业有几条值得留意的动态，特别与{intro}相关：\n\n"
            f"{ ('【行业资讯】\n' + news) if news else '【行业资讯】近期多国进口食品需求回暖，买家采购意愿明显增强；RCEP 框架下亚洲区内贸易成本持续下降。' }\n\n"
            f"在此背景下，{ex}将是贵司触达精准海外买家的优质窗口——{ex_scale or '汇聚全球优质采购商'}。如需，我可补充本次展会的买家结构与往届成交数据。\n\n"
            f"{closing}"
        ),
        "3": (
            f"{opening}\n\n"
            f"关于{ex}，需向您同步一个重要进展：目前优质展位余量已非常紧张，尤其贴合{intro}的展区所剩无几。\n\n"
            f"{ ('您此前关注的重点如下：\n' + news + '\n') if news else '' }"
            f"为保障贵司的参展位置与最佳曝光，建议尽快确认展位意向，避免错失黄金档期。我可为您预留 48 小时优先选位。\n\n"
            f"{closing}"
        ),
        "4": (
            f"{opening}\n\n"
            f"{ex}「创新大奖」申报通道现已开启，申报截止日期临近。该奖项面向具有产品创新力的食品企业，"
            f"与{intro}高度契合，是提升品牌国际曝光、获得海外买家信任的绝佳机会。\n\n"
            f"{ ('补充信息：\n' + news + '\n') if news else '' }"
            f"如贵司有意向参与，我可协助整理申报材料并对接组委会。请勿错过截止时间。\n\n"
            f"{closing}"
        ),
        "5": (
            f"{opening}\n\n"
            f"就贵司关注出海拓展的成本问题，特向您同步{ex}相关的参展补贴政策：多地商务主管部门对中小企业海外参展给予"
            f"展位费补贴（通常 50%~70% 不等），可显著降低出海门槛。\n\n"
            f"{ ('政策要点：\n' + news + '\n') if news else '' }"
            f"如贵司计划参展，建议尽早确认以赶上补贴申报周期（通常需提前2-3个月），我可协助准备相关材料。\n\n"
            f"{closing}"
        ),
        # ---- 新增场景：报价 / 客户跟进 / 感谢 ----
        "6": (
            f"{opening}\n\n"
            f"关于贵司关注的{ex}，我们已为贵司初步测算了参展投入与回报，现将报价方案同步如下：\n\n"
            f"【展位方案】\n"
            f"· 标准展位（9㎡）：含基础搭建、楣板、照明、洽谈桌 —— 适合首次试水\n"
            f"· 光地展位（18㎡起）：可定制特装，最大化品牌曝光\n"
            f"· 双开口 / 角位：+15%，人流与曝光更优\n\n"
            f"{ ('【展会亮点】' + hl2 + '\n\n') if hl2 else '' }"
            f"结合{intro}，建议优先选择贴合贵司品类的展区，预计可触达大量精准海外买家。\n\n"
            f"以上为初步报价框架，最终方案可据贵司展品种类与预算灵活调整。如需要，我可发送完整版报价单与展位图。\n\n"
            f"{closing}"
        ),
        "7": (
            f"{opening}\n\n"
            f"距我们上次沟通已有一段时间，特来跟进贵司关于{ex}的参展意向，也想确认接下来的配合节奏。\n\n"
            f"想和您对齐三点：\n"
            f"1）参展预算与档期是否已排定？\n"
            f"2）希望重点对接哪类海外买家（经销商 / 品牌方 / 商超采购）？\n"
            f"3）是否需要我们协助准备展品运输与人员签证材料？\n\n"
            f"{ ('【您之前关注的信息】\n' + news + '\n\n') if news else '' }"
            f"目前{ex}优质展位余量有限{ex_city and '（' + ex_city + '）' or ''}，若确定参展建议尽快锁定，以免错失黄金位置。我可先为贵司预留 48 小时优先选位。\n\n"
            f"{closing}"
        ),
        "8": (
            f"{opening}\n\n"
            f"感谢贵司对{ex}的关注与支持！无论最终是否成行，都十分珍视与贵司的交流。\n\n"
            f"{ ('【本次展会价值】' + hl2 + '\n\n') if hl2 else '' }"
            f"如贵司后续有出海拓展、买家对接或展会相关的任何需求，我们随时提供协助——包括展后买家名单、行业报告与下一届档期预告。\n\n"
            f"期待未来有机会与贵司在展会现场或线上深入合作。祝生意兴隆！\n\n"
            f"{closing}"
        ),
    }[scene_key]

    tone_tail = {
        "正式商务": "",
        "简洁干练": " we can move fast.",
        "温和友好": "无论是否参展，都欢迎随时交流！",
        "简短": "",
    }[tone_key]

    if tone_key == "简短":
        lines = [l for l in scene_body.split("\n") if l.strip()]
        scene_body = "\n".join(lines[:3])  # 只保留前3段

    body = f"{salutation}\n\n{scene_body}{tone_tail}\n\n— {signature or '{销售姓名}'}｜{ex} 招展团队"

    subject_map = {
        "1": f"邀您共赴 {ex}｜拓展海外买家渠道",
        "2": f"[{ctype}行业资讯] 附 {ex} 出海机会",
        "3": f"【展位余量提醒】{ex} 优质展区所剩无几",
        "4": f"【申报截止提醒】{ex} 创新大奖即将关闭通道",
        "5": f"【补贴政策】{ex} 参展补贴可显著降低出海成本",
        "6": f"【参展报价方案】{ex} 展位费用与投入回报",
        "7": f"【跟进】{ex} 参展意向确认，请查收",
        "8": f"【感谢】感谢关注 {ex}，后续资源持续开放",
    }
    subject = subject_map[scene_key]
    return subject, body

# ---------------------------- 邮件发送 ----------------------------
def load_settings(user_id):
    conn = get_db()
    s = conn.execute("SELECT * FROM settings WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    if not s:
        return {"demo_mode": 1, "default_interval": 5, "signature": ""}
    return row_to_dict(s)

def personalize(text, customer, sales_name):
    if not text:
        return ""
    rep = {
        "{客户名称}": customer.get("company") or "",
        "{联系人姓名}": customer.get("contact") or "",
        "{销售姓名}": sales_name or "",
        "{邮箱}": customer.get("email") or "",
        "{手机号}": customer.get("phone") or "",
        "{意向展会}": customer.get("exhibition") or "",
    }
    for k, v in rep.items():
        text = text.replace(k, v)
    return text

def send_one_email(user_id, to_email, subject, html_body, settings, attachments, cc, bcc):
    """返回 (status, error)"""
    if settings.get("demo_mode"):
        return "success", "演示模式（未实际外发）"
    if not (settings.get("smtp_host") and settings.get("from_email")):
        return "success", "未配置 SMTP，演示记录"
    try:
        msg = MIMEMultipart()
        msg["Subject"] = subject
        msg["From"] = f"{settings.get('from_name','')} <{settings.get('from_email')}>"
        msg["To"] = to_email
        if cc:
            msg["Cc"] = ", ".join(cc)
        if bcc:
            msg["Bcc"] = ", ".join(bcc)
        msg.attach(MIMEText(html_body, "plain", "utf-8"))
        for att in attachments or []:
            path = att.get("file_path")
            if path and os.path.exists(path):
                with open(path, "rb") as f:
                    part = MIMEApplication(f.read(), Name=att.get("name", "attachment"))
                    part["Content-Disposition"] = f'attachment; filename="{att.get("name","attachment")}"'
                    msg.attach(part)
        recipients = [to_email] + (cc or []) + (bcc or [])
        port = int(settings.get("smtp_port", 25))
        # 465 为 SSL 直连端口；587/25 等用 STARTTLS
        ssl_ctx = ssl.create_default_context()
        if port == 465:
            server = smtplib.SMTP_SSL(settings["smtp_host"], port, timeout=20, context=ssl_ctx)
        else:
            server = smtplib.SMTP(settings["smtp_host"], port, timeout=20)
            server.starttls()
        with server:
            if settings.get("smtp_user"):
                server.login(settings["smtp_user"], settings.get("smtp_pass", ""))
            server.sendmail(settings["from_email"], recipients, msg.as_string())
        return "success", ""
    except Exception as e:
        return "failed", str(e)

# ---------------------------- 路由处理 ----------------------------
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, headers, body):
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {}, b"")

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        # 静态文件（兼容两种部署：/static/ 前缀 与 根相对路径 /css/ /js/）
        if path == "/" or path == "/index.html":
            return self.serve_static("index.html", "text/html")
        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            return self.serve_static(rel, None)
        # 根相对路径：/css/... /js/... 直接映射到 frontend 目录（同源部署用）
        if path.startswith("/css/") or path.startswith("/js/"):
            return self.serve_static(path.lstrip("/"), None)
        # 其它带扩展名的静态资源（favicon.ico 等）
        last = path.split("/")[-1]
        if "." in last and not path.startswith("/api/"):
            return self.serve_static(path.lstrip("/"), None)
        # API
        code, headers, body = self.route_get(path)
        self._send(code, headers, body)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        code, headers, body = self.route_post(path)
        self._send(code, headers, body)

    def do_PATCH(self):
        path = urllib.parse.urlparse(self.path).path
        code, headers, body = self.route_patch(path)
        self._send(code, headers, body)

    def do_PUT(self):
        """PUT 请求复用 POST 路由（编辑客户等操作）"""
        self.do_POST()

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        code, headers, body = self.route_delete(path)
        self._send(code, headers, body)

    def serve_static(self, rel, ctype):
        # 兼容两种目录布局：部署布局(deploy/app.py + deploy/frontend/) 与 开发布局(backend/app.py + ../frontend/)
        candidates = [
            os.path.normpath(os.path.join(BASE_DIR, "frontend", rel)),
            os.path.normpath(os.path.join(BASE_DIR, "..", "frontend", rel)),
        ]
        fp = next((c for c in candidates if os.path.isfile(c)), None)
        if not fp:
            self._send(404, {"Content-Type": "text/plain"}, b"Not Found")
            return
        if ctype is None:
            ctype, _ = mimetypes.guess_type(fp)
            ctype = ctype or "application/octet-stream"
        with open(fp, "rb") as f:
            data = f.read()
        self._send(200, {"Content-Type": ctype + "; charset=utf-8"}, data)

    # ---------------- GET API ----------------
    def route_get(self, path):
        u, err = require_user(self)
        if err:
            return err
        if path.startswith("/api/admin/"):
            a, aerr = require_admin(self)
            if aerr:
                return aerr
            return self.admin_get(path, a)
        uid = u["id"]
        conn = get_db()
        try:
            if path == "/api/me":
                return json_resp(u)
            if path == "/api/todos":
                rows = conn.execute("SELECT * FROM todos WHERE user_id=? ORDER BY done, due_time", (uid,)).fetchall()
                return json_resp([row_to_dict(r) for r in rows])
            if path == "/api/customers":
                rows = conn.execute("SELECT * FROM customers WHERE user_id=? ORDER BY id DESC", (uid,)).fetchall()
                return json_resp([row_to_dict(r) for r in rows])
            if path == "/api/tags":
                rows = conn.execute("SELECT * FROM tags WHERE user_id=?", (uid,)).fetchall()
                return json_resp([row_to_dict(r) for r in rows])
            if path == "/api/templates":
                rows = conn.execute("SELECT * FROM templates WHERE user_id=? ORDER BY id DESC", (uid,)).fetchall()
                return json_resp([row_to_dict(r) for r in rows])
            if path == "/api/exhibitions":
                rows = conn.execute("SELECT * FROM exhibitions WHERE user_id=0 OR user_id=?", (uid,)).fetchall()
                return json_resp([row_to_dict(r) for r in rows])
            if path == "/api/materials":
                rows = conn.execute("SELECT * FROM materials WHERE user_id=0 OR user_id=?", (uid,)).fetchall()
                return json_resp([row_to_dict(r) for r in rows])
            if path == "/api/email-logs":
                rows = conn.execute("SELECT * FROM email_logs WHERE user_id=? ORDER BY id DESC", (uid,)).fetchall()
                return json_resp([row_to_dict(r) for r in rows])
            if path == "/api/settings":
                s = load_settings(uid)
                return json_resp(s)
            if path.startswith("/api/email-logs/"):
                lid = path.split("/")[-1]
                row = conn.execute("SELECT * FROM email_logs WHERE id=? AND user_id=?", (lid, uid)).fetchone()
                return json_resp(row_to_dict(row) if row else {})
        finally:
            conn.close()
        return json_resp({"error": "not found"}, 404)

    # ---------------- 管理员接口 ----------------
    def admin_get(self, path, admin):
        if path == "/api/admin/users":
            conn = get_db()
            rows = conn.execute("SELECT id,username,display_name,role,created_at FROM users ORDER BY id").fetchall()
            conn.close()
            return json_resp([row_to_dict(r) for r in rows])
        if path == "/api/backup/export":
            # 全量导出（管理员）：用于跨重部署/换服务器迁移数据，防止数据丢失
            conn = get_db()
            try:
                tables = [r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
                data = {"version": 1, "exported_at": now_iso(), "app": "mail-workbench", "tables": {}}
                for t in tables:
                    rows = conn.execute(f"SELECT * FROM {t}").fetchall()
                    data["tables"][t] = [dict(r) for r in rows]
                return json_resp(data)
            finally:
                conn.close()
        if path == "/api/admin/backup/export-zip":
            # 全量导出（含数据库 + 所有附件文件）为 zip，用于挂持久盘前完整备份
            import io, zipfile
            c2 = get_db(); c2.close()  # 确保落盘
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                if os.path.exists(DB_PATH):
                    zf.write(DB_PATH, "workbench.db")
                if os.path.isdir(UPLOAD_DIR):
                    for root, dirs, files in os.walk(UPLOAD_DIR):
                        for fn in files:
                            fp = os.path.join(root, fn)
                            arc = os.path.relpath(fp, UPLOAD_DIR)
                            zf.write(fp, os.path.join("uploads", arc))
            data = buf.getvalue()
            fname = "mailwb-full-backup-%s.zip" % now_iso()[:10]
            return 200, {
                "Content-Type": "application/zip",
                "Content-Disposition": 'attachment; filename="%s"' % fname,
                "Content-Length": str(len(data)),
            }, data
        return json_resp({"error": "not found"}, 404)

    def admin_post(self, path, admin):
        d = read_json_body(self)
        conn = get_db()
        try:
            if path == "/api/admin/create-user":
                uname = (d.get("username") or "").strip()
                pw = d.get("password") or ""
                role = d.get("role") or "member"
                if not uname or not pw:
                    return json_resp({"error": "用户名和密码必填"}, 400)
                if conn.execute("SELECT id FROM users WHERE username=?", (uname,)).fetchone():
                    return json_resp({"error": "用户名已存在"}, 409)
                h, salt = hash_pass(pw)
                conn.execute("INSERT INTO users (username,display_name,pass_hash,salt,created_at,role) VALUES (?,?,?,?,?,?)",
                             (uname, d.get("display_name") or uname, h, salt, now_iso(), role))
                uid = conn.execute("SELECT id FROM users WHERE username=?", (uname,)).fetchone()["id"]
                conn.execute("INSERT INTO settings (user_id,signature) VALUES (?,?)", (uid, "招展顾问"))
                self.seed_demo_data(conn, uid)
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/admin/reset-password":
                uid = d.get("user_id")
                pw = d.get("new_password") or ""
                if not pw:
                    return json_resp({"error": "新密码必填"}, 400)
                if int(uid) == admin["id"]:
                    return json_resp({"error": "不能重置自己的密码，请在设置页修改"}, 400)
                h, salt = hash_pass(pw)
                conn.execute("UPDATE users SET pass_hash=?, salt=? WHERE id=?", (h, salt, uid))
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/admin/update-role":
                uid = d.get("user_id")
                role = d.get("role")
                if role not in ("member", "admin"):
                    return json_resp({"error": "角色非法"}, 400)
                if int(uid) == admin["id"]:
                    return json_resp({"error": "不能修改自己的角色"}, 400)
                conn.execute("UPDATE users SET role=? WHERE id=?", (role, uid))
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/backup/import":
                # 全量导入（管理员）：清空并重建各表，用于迁移恢复
                payload = d.get("data") or d
                tables = payload.get("tables") or {}
                if not isinstance(tables, dict) or not tables:
                    return json_resp({"error": "备份数据为空或格式不正确"}, 400)
                try:
                    conn.execute("PRAGMA foreign_keys=OFF")
                    restored = []
                    for t, rows in tables.items():
                        if not isinstance(rows, list) or not rows:
                            continue
                        # 只恢复已知业务表，防止误导入系统表
                        conn.execute(f"DELETE FROM {t}")
                        for row in rows:
                            cols = [c for c in row.keys() if c != "rowid"]
                            if not cols:
                                continue
                            col_names = ",".join(cols)
                            placeholders = ",".join("?" for _ in cols)
                            conn.execute(f"INSERT INTO {t} ({col_names}) VALUES ({placeholders})",
                                         [row[c] for c in cols])
                        restored.append(t)
                    # 修正自增序列，避免后续插入主键冲突
                    for t in restored:
                        try:
                            maxid = conn.execute(f"SELECT MAX(id) FROM {t}").fetchone()[0]
                            if maxid is not None:
                                conn.execute("INSERT OR REPLACE INTO sqlite_sequence(name,seq) VALUES (?,?)", (t, maxid))
                        except Exception:
                            pass
                    conn.execute("PRAGMA foreign_keys=ON")
                    conn.commit()
                    return json_resp({"ok": True, "restored_tables": restored})
                except Exception as e:
                    conn.rollback()
                    return json_resp({"error": f"导入失败：{str(e)}"}, 500)
        finally:
            conn.close()
        if path == "/api/admin/backup/import-zip":
            # 全量恢复（含数据库 + 附件），会覆盖当前数据，用于迁移后恢复
            import io, zipfile, base64, tempfile, shutil
            zip_b64 = d.get("zip_b64") or ""
            if not zip_b64:
                return json_resp({"error": "未收到备份文件"}, 400)
            try:
                conn.close()
            except Exception:
                pass
            try:
                raw = base64.b64decode(zip_b64)
            except Exception:
                return json_resp({"error": "备份文件解码失败"}, 400)
            tmp = tempfile.mkdtemp()
            try:
                with zipfile.ZipFile(io.BytesIO(raw), "r") as zf:
                    zf.extractall(tmp)
                db_src = os.path.join(tmp, "workbench.db")
                if os.path.exists(db_src):
                    if os.path.exists(DB_PATH):
                        try:
                            os.remove(DB_PATH)
                        except Exception:
                            pass
                    shutil.move(db_src, DB_PATH)
                up_src = os.path.join(tmp, "uploads")
                if os.path.isdir(up_src):
                    if os.path.isdir(UPLOAD_DIR):
                        for fn in os.listdir(UPLOAD_DIR):
                            fp = os.path.join(UPLOAD_DIR, fn)
                            try:
                                if os.path.isfile(fp):
                                    os.remove(fp)
                                elif os.path.isdir(fp):
                                    shutil.rmtree(fp)
                            except Exception:
                                pass
                    cos_clear_uploads()
                    for root, dirs, files in os.walk(up_src):
                        for fn in files:
                            src = os.path.join(root, fn)
                            rel = os.path.relpath(src, up_src)
                            dst = os.path.join(UPLOAD_DIR, rel)
                            os.makedirs(os.path.dirname(dst), exist_ok=True)
                            shutil.copy2(src, dst)
                            cos_upload_attachment(dst)
                    cos_upload_db()
                return json_resp({"ok": True, "note": "数据库与附件已恢复，请刷新页面重新登录"})
            except Exception as e:
                return json_resp({"error": "恢复失败：" + str(e)}, 500)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        return json_resp({"error": "not found"}, 404)

    def admin_delete(self, path, admin):
        if path.startswith("/api/admin/users/"):
            tid = path.split("/")[-1]
            try:
                tid = int(tid)
            except Exception:
                return json_resp({"error": "bad id"}, 400)
            if tid == admin["id"]:
                return json_resp({"error": "不能删除自己的账号"}, 400)
            conn = get_db()
            try:
                conn.execute("DELETE FROM users WHERE id=?", (tid,))
                conn.execute("DELETE FROM settings WHERE user_id=?", (tid,))
                conn.execute("DELETE FROM todos WHERE user_id=?", (tid,))
                conn.execute("DELETE FROM customers WHERE user_id=?", (tid,))
                conn.execute("DELETE FROM tags WHERE user_id=?", (tid,))
                conn.execute("DELETE FROM templates WHERE user_id=?", (tid,))
                conn.execute("DELETE FROM email_logs WHERE user_id=?", (tid,))
                conn.commit()
                return json_resp({"ok": True})
            finally:
                conn.close()
        return json_resp({"error": "not found"}, 404)

    # ---------------- 演示数据种子 ----------------
    @staticmethod
    def seed_demo_data(conn, uid):
        """新用户注册后植入示例数据，进来即可直接体验（与纯前端版一致）。"""
        now = now_iso()
        # 预制标签
        for name in ["预制菜客户", "调味品客户", "零食客户", "原料客户", "高意向", "待跟进"]:
            try:
                conn.execute("INSERT OR IGNORE INTO tags (user_id,name) VALUES (?,?)", (uid, name))
            except Exception:
                pass
        # 示例客户
        demo_cust = [
            ("XX预制菜工厂", "王总", "wang@xx-food.com", "13800000001", "SIAL 巴黎食品展", "预制菜客户,高意向"),
            ("YY调味品有限公司", "李总", "li@yy-seasoning.com", "13800000002", "SIAL 巴黎食品展", "调味品客户"),
            ("ZZ休闲零食", "赵经理", "zhao@zz-snack.com", "13800000003", "越南食品展 VietFood", "零食客户,待跟进"),
        ]
        for c in demo_cust:
            conn.execute("INSERT INTO customers (user_id,company,contact,email,phone,exhibition,tags,created_at) VALUES (?,?,?,?,?,?,?,?)",
                         (uid, c[0], c[1], c[2], c[3], c[4], c[5], now))
        # 示例待办（带绑定日期）
        import datetime
        base = datetime.date.today()
        demo_todos = [
            ("跟进XX预制菜厂参展意向", (base + datetime.timedelta(days=1)).isoformat(), "高"),
            ("发送SIAL展位图给YY调味品", (base + datetime.timedelta(days=2)).isoformat(), "中"),
            ("准备创新大奖申报材料", (base + datetime.timedelta(days=4)).isoformat(), "高"),
            ("整理越南食品展客户名单", base.isoformat(), "低"),
        ]
        for t in demo_todos:
            conn.execute("INSERT INTO todos (user_id,title,due_time,bind_date,priority,done,created_at) VALUES (?,?,?,?,?,?,?)",
                         (uid, t[0], t[1] + " 18:00", t[1], t[2], 0, now))
        # 示例邮件模板
        conn.execute("""INSERT INTO templates (user_id,name,exhibition,customer_type,scene,tone,subject,body,signature,created_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?)""",
                     (uid, "SIAL初次开发-预制菜", "SIAL 巴黎食品展", "预制菜", "1", "正式商务",
                      "【{客户名称}】诚邀莅临 SIAL 巴黎食品展",
                      "尊敬的{联系人姓名}（{客户名称}）：\n您好！我是「SIAL 巴黎食品展」中国区招展团队的{销售姓名}。\n\n结合贵司在预制菜领域的产品矩阵与出海布局，我们相信贵司非常契合本次展会的买家画像。诚挚邀请贵司莅临SIAL，与海外买家面对面洽谈。\n\n——{销售姓名}",
                      "招展顾问", now))

    # ---------------- POST API ----------------
    def route_post(self, path):
        # 注册 / 登录 不需要鉴权
        if path == "/api/register":
            d = read_json_body(self)
            uname = (d.get("username") or "").strip()
            pw = d.get("password") or ""
            if not uname or not pw:
                return json_resp({"error": "用户名和密码必填"}, 400)
            conn = get_db()
            if conn.execute("SELECT id FROM users WHERE username=?", (uname,)).fetchone():
                conn.close()
                return json_resp({"error": "用户名已存在"}, 409)
            h, salt = hash_pass(pw)
            conn.execute("INSERT INTO users (username,display_name,pass_hash,salt,created_at) VALUES (?,?,?,?,?)",
                         (uname, d.get("display_name") or uname, h, salt, now_iso()))
            uid = conn.execute("SELECT id FROM users WHERE username=?", (uname,)).fetchone()["id"]
            conn.execute("INSERT INTO settings (user_id,signature) VALUES (?,?)", (uid, "招展顾问"))
            self.seed_demo_data(conn, uid)
            conn.commit()
            conn.close()
            token = gen_token()
            with SESS_LOCK:
                SESSIONS[token] = uid
            return json_resp({"token": token, "user": {"id": uid, "username": uname, "display_name": d.get("display_name") or uname, "role": "member"}})

        if path == "/api/login":
            d = read_json_body(self)
            uname = (d.get("username") or "").strip()
            pw = d.get("password") or ""
            conn = get_db()
            row = conn.execute("SELECT * FROM users WHERE username=?", (uname,)).fetchone()
            conn.close()
            if not row:
                return json_resp({"error": "用户不存在"}, 404)
            h, _ = hash_pass(pw, row["salt"])
            if h != row["pass_hash"]:
                return json_resp({"error": "密码错误"}, 401)
            token = gen_token()
            with SESS_LOCK:
                SESSIONS[token] = row["id"]
            return json_resp({"token": token, "user": {"id": row["id"], "username": row["username"], "display_name": row["display_name"], "role": row["role"]}})

        if path.startswith("/api/admin/"):
            a, aerr = require_admin(self)
            if aerr:
                return aerr
            return self.admin_post(path, a)

        u, err = require_user(self)
        if err:
            return err
        uid = u["id"]
        d = read_json_body(self)
        conn = get_db()
        try:
            if path == "/api/todos":
                conn.execute("INSERT INTO todos (user_id,title,due_time,bind_date,priority,customer_id,created_at) VALUES (?,?,?,?,?,?,?)",
                             (uid, d.get("title",""), d.get("due_time"), d.get("bind_date"), d.get("priority","中"), d.get("customer_id"), now_iso()))
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/tags":
                name = (d.get("name") or "").strip()
                if not name:
                    return json_resp({"error":"标签名必填"},400)
                try:
                    conn.execute("INSERT INTO tags (user_id,name) VALUES (?,?)", (uid, name))
                    conn.commit()
                except sqlite3.IntegrityError:
                    return json_resp({"error":"标签已存在"},409)
                return json_resp({"ok": True})
            if path == "/api/customers":
                tags = d.get("tags")
                if isinstance(tags, list):
                    tags = ",".join(tags)
                conn.execute("INSERT INTO customers (user_id,company,contact,email,phone,exhibition,tags,created_at) VALUES (?,?,?,?,?,?,?,?)",
                             (uid, d.get("company"), d.get("contact"), d.get("email"), d.get("phone"), d.get("exhibition"), tags or "", now_iso()))
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/customers/batch-delete":
                ids = d.get("ids") or []
                ids = [str(i) for i in ids if i not in (None, "")]
                deleted = 0
                if ids:
                    qmarks = ",".join("?" * len(ids))
                    cur = conn.execute(
                        f"DELETE FROM customers WHERE user_id=? AND id IN ({qmarks})",
                        [uid] + ids,
                    )
                    deleted = cur.rowcount
                    conn.commit()
                return json_resp({"ok": True, "deleted": deleted})
            if path == "/api/customers/import":
                text = d.get("csv") or ""
                return self.import_csv(conn, uid, text)
            if path == "/api/customers/upload-excel":
                # 接收 base64 编码的文件数据（前端 FileReader → base64）
                b64_data = d.get("file_base64") or d.get("file_data") or ""
                filename = d.get("filename") or "data.xlsx"
                if not b64_data:
                    return json_resp({"error": "未上传文件，请先选择 Excel/CSV 文件"}, 400)
                import base64 as b64mod
                try:
                    raw = b64mod.b64decode(b64_data)
                except Exception as e:
                    return json_resp({"error": f"文件数据解码失败：{str(e)}。请确认文件未损坏后重试。"}, 400)
                ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "xlsx"
                # 文件大小检查(限制50MB)
                if len(raw) > 50 * 1024 * 1024:
                    return json_resp({"error": f"文件过大({len(raw)//1024//1024}MB)，请控制在50MB以内或拆分上传"}, 400)
                try:
                    result = self.parse_excel_file(raw, ext)
                    if result.get("error"):
                        return json_resp({"error": result["error"]}, 400)
                    imp_result = self.import_parsed_data(conn, uid, result["rows"], result.get("headers", []))
                    # imp_result 现在是 dict: {imported: N, diagnostic?: {...}}
                    imported_count = imp_result.get("imported", 0) if isinstance(imp_result, dict) else imp_result
                    resp = {"ok": True, "imported": imported_count, "total_rows": len(result["rows"]),
                            "preview": result["preview"], "headers": result.get("headers", []),
                            "detected_columns": result.get("detected_columns", {})}
                    # 导入0行时附加诊断信息
                    if isinstance(imp_result, dict) and imp_result.get("diagnostic"):
                        resp["diagnostic"] = imp_result["diagnostic"]
                    return json_resp(resp)
                except ImportError as e:
                    return json_resp({"error": f"服务器缺少文件解析依赖（{str(e)}）。请联系管理员安装 openpyxl。"}, 500)
                except Exception as e:
                    # 记录详细错误到stderr(容器日志可见)
                    import traceback
                    tb = traceback.format_exc()
                    print(f"[Excel导入错误] 用户={uid} 文件={filename} 大小={len(raw)} 错误: {tb}", flush=True)
                    err_msg = str(e)
                    # 对常见错误给出友好提示
                    if "openpyxl" in str(type(e).__module__).lower() and "No module" in err_msg:
                        err_msg = "服务器未安装 Excel 解析库(openpyxl)，请联系管理员"
                    elif "zip" in err_msg.lower() or "not a valid" in err_msg.lower():
                        err_msg = "文件格式异常，请确认是有效的 .xlsx 文件（尝试用 Excel 另存为一次）"
                    return json_resp({"error": f"文件解析失败：{err_msg}"}, 400)
            if path == "/api/templates":
                conn.execute("INSERT INTO templates (user_id,name,exhibition,customer_type,scene,tone,subject,body,signature,attachment_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                             (uid, d.get("name"), d.get("exhibition"), d.get("customer_type"), d.get("scene"), d.get("tone"),
                              d.get("subject"), d.get("body"), d.get("signature"), d.get("attachment_ids",""), now_iso()))
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/ai/generate":
                subject, body = build_email(d.get("exhibition"), d.get("customer_type"), d.get("scene"),
                                            d.get("tone"), d.get("custom_input"), d.get("signature"), uid)
                return json_resp({"subject": subject, "body": body})
            if path == "/api/exhibitions":
                conn.execute("INSERT INTO exhibitions (user_id,name,city,date_text,note) VALUES (?,?,?,?,?)",
                             (uid, d.get("name"), d.get("city"), d.get("date_text"), d.get("note")))
                conn.commit()
                new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                return json_resp({"ok": True, "id": new_id})
            if path == "/api/materials":
                # 接收文件内容（base64）或直接记录 URL；演示以名称 + 路径记录
                name = d.get("name") or "资料"
                ex_id = d.get("exhibition_id")
                fpath = os.path.join(UPLOAD_DIR, f"{uid}_{int(datetime.datetime.now().timestamp())}_{name}")
                content = d.get("content_b64")
                if content:
                    import base64
                    with open(fpath, "wb") as f:
                        f.write(base64.b64decode(content))
                else:
                    fpath = d.get("file_path") or ""
                if os.path.exists(fpath):
                    cos_upload_attachment(fpath)
                conn.execute("INSERT INTO materials (user_id,exhibition_id,name,file_path,created_at) VALUES (?,?,?,?,?)",
                             (uid, ex_id, name, fpath, now_iso()))
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/email/preview":
                return self.preview_emails(conn, uid, u, d)
            if path == "/api/email/send":
                return self.send_emails(conn, uid, u, d)
            if path == "/api/settings":
                s = d
                conn.execute("""INSERT OR REPLACE INTO settings
                    (user_id,smtp_host,smtp_port,smtp_user,smtp_pass,from_email,from_name,default_interval,demo_mode,signature)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (uid, s.get("smtp_host"), s.get("smtp_port"), s.get("smtp_user"), s.get("smtp_pass"),
                     s.get("from_email"), s.get("from_name"), s.get("default_interval",5),
                     s.get("demo_mode",1),                      s.get("signature")))
                conn.commit()
                return json_resp({"ok": True})
            if path == "/api/me/change-password":
                old = d.get("old_password") or ""
                new = d.get("new_password") or ""
                if not new:
                    return json_resp({"error": "新密码必填"}, 400)
                row = conn.execute("SELECT pass_hash,salt FROM users WHERE id=?", (uid,)).fetchone()
                oh, _ = hash_pass(old, row["salt"])
                if oh != row["pass_hash"]:
                    return json_resp({"error": "原密码不正确"}, 400)
                h, salt = hash_pass(new)
                conn.execute("UPDATE users SET pass_hash=?, salt=? WHERE id=?", (h, salt, uid))
                conn.commit()
                return json_resp({"ok": True})
        finally:
            conn.close()
        return json_resp({"error": "not found"}, 404)

    # ---------------- PATCH API ----------------
    def route_patch(self, path):
        u, err = require_user(self)
        if err:
            return err
        uid = u["id"]
        d = read_json_body(self)
        conn = get_db()
        try:
            if path.startswith("/api/todos/"):
                tid = path.split("/")[-1]
                fields = []
                vals = []
                for k in ("title","due_time","bind_date","priority","customer_id","done"):
                    if k in d:
                        fields.append(f"{k}=?")
                        vals.append(d[k])
                if fields:
                    conn.execute(f"UPDATE todos SET {','.join(fields)} WHERE id=? AND user_id=?", vals+[tid, uid])
                    conn.commit()
                return json_resp({"ok": True})
            if path.startswith("/api/customers/"):
                cid = path.split("/")[-1]
                fields = []
                vals = []
                for k in ("company","contact","email","phone","exhibition","tags"):
                    if k in d:
                        v = d[k]
                        if k == "tags" and isinstance(v, list):
                            v = ",".join(v)
                        fields.append(f"{k}=?")
                        vals.append(v)
                if fields:
                    conn.execute(f"UPDATE customers SET {','.join(fields)} WHERE id=? AND user_id=?", vals+[cid, uid])
                    conn.commit()
                return json_resp({"ok": True})
            if path.startswith("/api/exhibitions/"):
                eid = path.split("/")[-1]
                fields = []
                vals = []
                for k in ("name", "city", "date_text", "note"):
                    if k in d:
                        v = d[k]
                        if k == "date_text":
                            v = _normalize_date_text(v)
                        fields.append(f"{k}=?")
                        vals.append(v)
                if fields:
                    # 同时允许修改全局展会(user_id=0)与本人维护的展会
                    conn.execute(
                        f"UPDATE exhibitions SET {','.join(fields)} WHERE id=? AND (user_id=? OR user_id=0)",
                        vals + [eid, uid])
                    conn.commit()
                return json_resp({"ok": True})
            if path.startswith("/api/templates/"):
                tid = path.split("/")[-1]
                fields = []
                vals = []
                for k in ("name","exhibition","customer_type","scene","tone","subject","body","signature","attachment_ids"):
                    if k in d:
                        fields.append(f"{k}=?")
                        vals.append(d[k])
                if fields:
                    conn.execute(f"UPDATE templates SET {','.join(fields)} WHERE id=? AND user_id=?", vals+[tid, uid])
                    conn.commit()
                return json_resp({"ok": True})
        finally:
            conn.close()
        return json_resp({"error": "not found"}, 404)

    # ---------------- DELETE API ----------------
    def route_delete(self, path):
        u, err = require_user(self)
        if err:
            return err
        if path.startswith("/api/admin/"):
            a, aerr = require_admin(self)
            if aerr:
                return aerr
            return self.admin_delete(path, a)
        uid = u["id"]
        conn = get_db()
        try:
            if path.startswith("/api/todos/"):
                tid = path.split("/")[-1]
                conn.execute("DELETE FROM todos WHERE id=? AND user_id=?", (tid, uid))
            elif path.startswith("/api/customers/"):
                cid = path.split("/")[-1]
                conn.execute("DELETE FROM customers WHERE id=? AND user_id=?", (cid, uid))
            elif path.startswith("/api/tags/"):
                tid = path.split("/")[-1]
                conn.execute("DELETE FROM tags WHERE id=? AND user_id=?", (tid, uid))
            elif path.startswith("/api/templates/"):
                tid = path.split("/")[-1]
                conn.execute("DELETE FROM templates WHERE id=? AND user_id=?", (tid, uid))
            elif path.startswith("/api/materials/"):
                mid = path.split("/")[-1]
                conn.execute("DELETE FROM materials WHERE id=? AND (user_id=? OR user_id=0)", (mid, uid))
            else:
                return json_resp({"error":"not found"},404)
            conn.commit()
            return json_resp({"ok": True})
        finally:
            conn.close()

    # ---------------- 业务方法 ----------------
    def import_csv(self, conn, uid, text):
        try:
            lines = text.strip().splitlines()
            # 自动跳过非表头行（如"销售跟进情况表"等标题行）
            while lines and not any(k in lines[0] for k in ["公司名称","客户公司","联系人","邮箱","序号"]):
                lines.pop(0)
            if not lines:
                return json_resp({"error": "未找到有效的表头行"}, 400)
            reader = csv.DictReader(io.StringIO("\n".join(lines)))
            fields = reader.fieldnames or []
            # 检测是否为「销售跟进情况表」模板（通过特征列名判断）
            is_template = any("公司名称" in str(f) for f in fields)
            count = 0
            for row in reader:
                if is_template:
                    # 销售跟进情况表模板映射
                    company = (row.get("公司名称（全称）*") or row.get("公司名称（全称）") or row.get("公司名称(全称)") or "").strip()
                    if not company:
                        company = (row.get("公司名称（简称）") or "").strip()
                    if not company:
                        continue
                    contact = (row.get("联系人") or "").strip()
                    phone = (row.get("联系电话") or "").strip()
                    exhibition = (row.get("参展记录*") or row.get("参展记录") or row.get("参展记录*示例：24.5泰国食品展") or "").strip().split("\n")[0]
                    tags = (row.get("客户分配标签属性") or "").strip()
                    remark = (row.get("客户联系情况或跟踪记录*") or row.get("客户联系情况或跟踪记录") or row.get("其他备注（若有）") or "").strip()
                    region = " ".join(filter(None, [row.get("省") or "", row.get("市") or "", row.get("县区") or ""])).strip()
                    source = (row.get("客户来源") or "").strip()
                    email = ""  # 该模板无邮箱列，需后续补充
                else:
                    # 标准格式
                    company = (row.get("客户公司") or row.get("company") or row.get("公司名称") or "").strip()
                    if not company:
                        continue
                    contact = (row.get("联系人") or row.get("contact") or "").strip()
                    phone = (row.get("手机号") or row.get("phone") or row.get("联系电话") or "").strip()
                    exhibition = (row.get("意向展会") or row.get("exhibition") or row.get("参展记录") or "").strip()
                    tags = (row.get("客户标签") or row.get("tags") or row.get("客户分配标签属性") or "").strip()
                    email = (row.get("邮箱") or row.get("email") or "").strip()
                    remark = ""
                    region = ""
                    source = ""
                conn.execute("INSERT INTO customers (user_id,company,contact,email,phone,exhibition,tags,remark,region,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                             (uid, company, contact, email, phone, exhibition, tags, remark, region, source, now_iso()))
                count += 1
            conn.commit()
            return json_resp({"ok": True, "imported": count, "template_mode": is_template})
        except Exception as e:
            return json_resp({"error": str(e)}, 400)

    # ---------- Excel 文件上传解析（openpyxl 可靠解析） ----------
    # 常见表头关键词，用于判断一行是不是真正的表头
    _HEADER_KEYWORDS = {"公司", "名称", "联系", "邮箱", "邮件", "手机", "电话", "展会",
                        "标签", "备注", "客户", "企业", "供应商", "省", "市", "区", "县",
                        "产品", "类型", "序号", "编号", "姓名", "地址", "职位", "行业"}

    @staticmethod
    def _looks_like_header(row):
        """判断一行是否像表头（包含常见表头关键词）"""
        text = " ".join(str(c).strip() for c in row if c)
        return any(kw in text for kw in Handler._HEADER_KEYWORDS)

    @staticmethod
    def parse_excel_file(raw_data, ext):
        """用 openpyxl 解析 Excel/CSV 文件，返回 {rows, headers, preview, detected_columns, error?}"""
        import tempfile, csv as csv_mod
        suffix = "." + ("xlsx" if ext in ("xlsx", "xls") else "csv")
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(raw_data)
            tmp_path = tmp.name
        try:
            if ext == "csv":
                rows = []
                for enc in ["utf-8-sig", "utf-8", "gbk", "gb2312", "latin-1"]:
                    try:
                        with open(tmp_path, "r", encoding=enc) as f:
                            reader = csv_mod.reader(f)
                            for row in reader:
                                rows.append([str(c).strip() for c in row])
                        break
                    except (UnicodeDecodeError, UnicodeError):
                        rows = []
                        continue
                if not rows:
                    return {"error": "CSV 文件为空或编码无法识别"}
                # CSV 也智能找表头：跳过标题行
                header_idx = 0
                for i, r in enumerate(rows):
                    if any(c.strip() for c in r):
                        if Handler._looks_like_header(r):
                            header_idx = i
                            break
                        if i + 1 < len(rows) and Handler._looks_like_header(rows[i + 1]):
                            header_idx = i + 1
                            break
                        header_idx = i
                        break
                headers = [str(c).strip() if c else "" for c in rows[header_idx]]
                data_rows = [[str(c).strip() if c else "" for c in r] for r in rows[header_idx + 1:]]

            elif ext == "xlsx":
                try:
                    import openpyxl
                except ImportError:
                    return {"error": "服务器未安装 openpyxl 库"}
                try:
                    wb = openpyxl.load_workbook(tmp_path, data_only=True)
                except Exception as e:
                    err_low = str(e).lower()
                    if "bad zip" in err_low or "not a zip" in err_low or "invalid" in err_low:
                        return {"error": "文件不是有效的 xlsx 格式"}
                    return {"error": f"Excel 文件读取失败：{str(e)}"}
                ws = wb.active
                raw_rows = list(ws.iter_rows(values_only=True))
                if not raw_rows:
                    return {"error": "Excel 文件为空"}
                # 智能找表头行：跳过标题行（如"销售跟进情况表"）
                header_row_idx = None
                for i, r in enumerate(raw_rows):
                    if not any(c for c in r if c is not None and str(c).strip()):
                        continue
                    if Handler._looks_like_header(r):
                        header_row_idx = i
                        break
                    if i + 1 < len(raw_rows) and Handler._looks_like_header(raw_rows[i + 1]):
                        header_row_idx = i + 1
                        break
                    header_row_idx = i
                    break

                if header_row_idx is None:
                    return {"error": "Excel 文件没有可识别的表头或数据"}

                headers = [str(c).strip() if c else "" for c in raw_rows[header_row_idx]]
                data_rows = []
                for r in raw_rows[header_row_idx + 1:]:
                    row_str = [str(c).strip() if c else "" for c in r]
                    if any(v.strip() for v in row_str):
                        data_rows.append(row_str)
            elif ext == "xls":
                return {"error": ".xls 旧格式不支持，请另存为 .xlsx 或 .csv"}
            else:
                return {"error": f"不支持的文件格式：.{ext}"}

            if not data_rows:
                return {"error": "文件只有表头没有数据行"}

            # 模糊列名匹配
            detected = Handler.fuzzy_match_columns(headers)
            _data_keys = ["company","contact","email","phone","exhibition","tags","remark"]
            preview = []
            for r in data_rows[:10]:
                preview.append({k: (r[v] if isinstance(v,int) and v < len(r) else "") for k in _data_keys for v in [detected.get(k)]})
            return {"rows": data_rows, "headers": headers, "preview": preview,
                    "detected_columns": detected}
        finally:
            os.unlink(tmp_path)

    @staticmethod
    def _clean_header(h):
        """清洗表头：去掉括号内容、标点、空格、星号"""
        import re
        s = h.strip()
        # 去掉中文/英文括号及其中内容
        s = re.sub(r'[（(][^）)]*[）)]', '', s)
        # 去掉末尾标记
        s = s.rstrip('* \t\n\r')
        return s.strip()

    @staticmethod
    def fuzzy_match_columns(headers):
        """
        模糊匹配列名。核心必填字段：公司名、联系人、邮箱。
        可选字段：手机号、意向展会、标签。
        返回 {company: idx, contact: idx, email: idx, phone: idx, ...}
        """
        col_map = {}
        for i, h in enumerate(headers):
            h_raw = str(h).strip() if h else ""
            h_clean = Handler._clean_header(h_raw)
            h_low = h_clean.lower()
            h_raw_low = h_raw.lower()

            # ===== 公司名（核心必填）=====
            if not col_map.get("company") and any(kw in h_clean for kw in [
                "公司名称", "公司名", "企业名称", "单位名称", "客户公司",
                "公司", "企业", "供应商", "厂商", "品牌", "参展商",
                "公司全称", "全称", "客户名称"
            ]):
                col_map["company"] = i
            if not col_map.get("company") and any(kw in h_raw for kw in [
                "公司名称", "公司名", "企业名称", "单位名称", "客户公司",
                "公司", "企业", "供应商", "厂商", "品牌", "参展商",
                "公司全称", "全称"
            ]):
                col_map["company"] = i
            if not col_map.get("company") and any(kw in h_raw_low for kw in [
                "company", "firm", "org", "supplier", "vendor"
            ]):
                col_map["company"] = i

            # ===== 联系人/姓名（核心必填）=====
            if not col_map.get("contact") and any(kw in h_clean for kw in [
                "联系人", "联系姓名", "姓名", "负责人", "客户姓名",
                "联系人姓名", "对接人", "采购负责人", "决策人"
            ]):
                col_map["contact"] = i
            if not col_map.get("contact") and any(kw in h_raw for kw in [
                "联系人", "联系姓名", "姓名", "负责人", "客户姓名",
                "联系人姓名", "对接人", "采购负责人", "决策人"
            ]):
                col_map["contact"] = i
            if not col_map.get("contact") and any(kw in h_raw_low for kw in [
                "contact", "name", "person"
            ]):
                col_map["contact"] = i

            # ===== 邮箱（核心必填）=====
            if not col_map.get("email") and any(kw in h_clean for kw in [
                "邮箱", "电子邮箱", "Email", "E-mail", "邮件",
                "邮箱地址", "E-mail地址", "邮箱号", "邮箱号码"
            ]):
                col_map["email"] = i
            if not col_map.get("email") and any(kw in h_raw for kw in [
                "邮箱", "电子邮箱", "Email", "E-mail", "邮件",
                "邮箱地址", "E-mail地址", "邮箱号", "邮箱号码"
            ]):
                col_map["email"] = i
            if not col_map.get("email") and any(kw in h_raw_low for kw in [
                "email", "mail", "e_mail"
            ]):
                col_map["email"] = i

            # ===== 手机号（可选）=====
            if not col_map.get("phone") and any(kw in h_clean for kw in [
                "联系电话", "手机号", "电话", "手机", "手机号码",
                "联系方式", "电话号码", "Tel"
            ]):
                col_map["phone"] = i
            if not col_map.get("phone") and any(kw in h_raw for kw in [
                "联系电话", "手机号", "电话", "手机", "手机号码",
                "联系方式", "电话号码", "Tel"
            ]):
                col_map["phone"] = i
            if not col_map.get("phone") and any(kw in h_raw_low for kw in [
                "phone", "tel", "mobile"
            ]):
                col_map["phone"] = i

            # ===== 意向展会（可选）=====
            if not col_map.get("exhibition") and any(kw in h_clean for kw in [
                "参展记录", "意向展会", "展会", "参展", "目标展会",
                "感兴趣展会", "参展意向"
            ]):
                col_map["exhibition"] = i
            if not col_map.get("exhibition") and any(kw in h_raw for kw in [
                "参展记录", "意向展会", "展会", "参展", "目标展会",
                "感兴趣展会", "参展意向"
            ]):
                col_map["exhibition"] = i

            # ===== 标签（可选）=====
            if not col_map.get("tags") and any(kw in h_clean for kw in [
                "标签", "分类", "属性", "类别", "行业"
            ]):
                col_map["tags"] = i
            if not col_map.get("tags") and any(kw in h_raw for kw in [
                "标签", "分类", "属性", "类别", "行业"
            ]):
                col_map["tags"] = i

        # 兜底：只有一列时当 company
        if not col_map.get("company") and len(headers) == 1:
            col_map["company"] = 0
        # 兜底：多列但没匹配到公司名，用第一列
        if not col_map.get("company") and len(headers) > 0:
            col_map["company"] = 0
            col_map["_fallback_company"] = True

        # 记录诊断信息
        col_map["_raw_headers"] = [str(h).strip() for h in headers]
        return col_map

    def import_parsed_data(self, conn, uid, rows, headers):
        """根据模糊匹配的列，将已解析的行数据导入数据库"""
        detected = self.fuzzy_match_columns(headers)
        count = 0
        skipped_empty = 0
        skipped_junk = 0  # 无意义公司名（如"序号"、"编号"）
        sample_skipped = []  # 记录前3条被跳过的行(用于诊断)
        # 无意义公司名关键词
        _junk_keywords = ("序号", "编号", "no.", "no", "#", "id", "行号")
        for row in rows:
            def gv(key):
                idx = detected.get(key)
                return (row[idx].strip() if idx is not None and idx < len(row) else "")
            company = gv("company").strip()
            if not company:
                skipped_empty += 1
                if len(sample_skipped) < 3:
                    sample_skipped.append(row[:min(4, len(row))])
                continue
            # 过滤无意义公司名：纯数字、或包含序号/编号等关键词
            company_low = company.lower()
            if company_low in _junk_keywords or any(kw in company_low for kw in _junk_keywords) or company.isdigit():
                skipped_junk += 1
                continue
            conn.execute("INSERT INTO customers (user_id,company,contact,email,phone,exhibition,tags,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                         (uid, company, gv("contact"), gv("email"), gv("phone"),
                          gv("exhibition"), gv("tags"), gv("remark"), now_iso()))
            count += 1
        conn.commit()
        # 返回详细结果，包含诊断信息
        result = {"imported": count}
        if count == 0:
            result["diagnostic"] = {
                "headers": headers,
                "detected_columns": detected,
                "total_rows": len(rows),
                "skipped_empty_company": skipped_empty,
                "skipped_junk_company": skipped_junk,
                "sample_skipped_rows": sample_skipped,
            }
        return result

    def preview_emails(self, conn, uid, u, d):
        """根据模板内容 + 客户来源，渲染个性化邮件预览"""
        subject_tpl = d.get("subject", "")
        body_tpl = d.get("body", "")
        # 客户来源
        customer_ids = d.get("customer_ids") or []
        tag_filter = (d.get("tag_filter") or "").strip()
        csv_text = d.get("csv")
        customers = []
        if customer_ids:
            for cid in customer_ids:
                row = conn.execute("SELECT * FROM customers WHERE id=? AND user_id=?", (cid, uid)).fetchone()
                if row:
                    customers.append(row_to_dict(row))
        if csv_text:
            reader = csv.DictReader(io.StringIO(csv_text))
            for row in reader:
                customers.append({
                    "company": (row.get("客户公司") or row.get("company") or "").strip(),
                    "contact": (row.get("联系人") or row.get("contact") or "").strip(),
                    "email": (row.get("邮箱") or row.get("email") or "").strip(),
                    "phone": (row.get("手机号") or row.get("phone") or "").strip(),
                    "exhibition": (row.get("意向展会") or row.get("exhibition") or "").strip(),
                })
        if tag_filter:
            customers = [c for c in customers if tag_filter in (c.get("tags") or "").split(",")]
        # 去重 by email
        seen = set(); uniq = []
        for c in customers:
            e = (c.get("email") or "").strip().lower()
            if e and e in seen:
                continue
            seen.add(e); uniq.append(c)
        sales_name = load_settings(uid).get("signature") or u.get("display_name") or ""
        rendered = []
        for c in uniq:
            rendered.append({
                "company": c.get("company"),
                "contact": c.get("contact"),
                "email": c.get("email"),
                "subject": personalize(subject_tpl, c, sales_name),
                "body": personalize(body_tpl, c, sales_name),
            })
        return json_resp({"count": len(rendered), "items": rendered})

    def send_emails(self, conn, uid, u, d):
        items = d.get("items") or []
        cc = d.get("cc") or []
        bcc = d.get("bcc") or []
        interval = int(d.get("interval") or 5)
        attachment_ids = d.get("attachment_ids") or []
        settings = load_settings(uid)
        sales_name = settings.get("signature") or u.get("display_name") or ""
        # 附件
        attachments = []
        if attachment_ids:
            for aid in attachment_ids:
                row = conn.execute("SELECT * FROM materials WHERE id=? AND (user_id=? OR user_id=0)", (aid, uid)).fetchone()
                if row:
                    attachments.append({"name": row["name"], "file_path": row["file_path"]})
        exhibition = d.get("exhibition") or ""
        template_name = d.get("template_name") or ""
        results = []
        try:
            for it in items:
                c = {"company": it.get("company"), "contact": it.get("contact"), "email": it.get("email")}
                subject = personalize(it.get("subject",""), c, sales_name)
                body = personalize(it.get("body",""), c, sales_name)
                to = (it.get("email") or "").strip()
                status, error = "failed", "缺少收件邮箱"
                if to:
                    try:
                        status, error = send_one_email(uid, to, subject, body, settings, attachments, cc, bcc)
                    except Exception as e:
                        status, error = "failed", f"发送异常: {str(e)}"
                # 每封邮件立即写日志 + commit，防止超时丢失
                try:
                    conn.execute("INSERT INTO email_logs (user_id,exhibition,template_name,customer_company,contact,email,subject,body,status,error,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                 (uid, exhibition, template_name, it.get("company"), it.get("contact"), to, subject, body, status, error, now_iso()))
                    conn.commit()
                except Exception as log_err:
                    pass
                results.append({"email": to, "status": status})
                if interval and to:
                    threading.Event().wait(interval)
        except Exception as outer_e:
            try: conn.commit()
            except: pass
            return json_resp({"ok": True, "results": results, "demo_mode": bool(settings.get("demo_mode")), "warning": f"发送中断: {str(outer_e)}"})
        return json_resp({"ok": True, "results": results, "demo_mode": bool(settings.get("demo_mode"))})


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    if COS_ENABLED:
        # 容器本地文件系统是临时的；启动时先从 COS 拉取最新数据库与附件
        cos_download_db()
        cos_download_all_uploads()
    init_db()
    if COS_ENABLED:
        # 把初始化后的库（含默认 admin 账号）推送到 COS，确保新部署也有备份
        cos_upload_db()
    port = int(os.environ.get("PORT", 8000))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"✅ 销售邮件发送工作台已启动： http://127.0.0.1:{port}")
    print(f"   数据库： {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()

if __name__ == "__main__":
    main()
