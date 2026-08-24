import html
import importlib
import ipaddress
import os
import random
import re
import socket
import subprocess
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from collections import deque, defaultdict
from urllib.parse import unquote, urljoin, urlparse

from bs4 import XMLParsedAsHTMLWarning

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

# ==================== 1. 自动检测并安装依赖库 ====================
REQUIRED_PACKAGES = {
    "requests": "requests",
    "bs4": "beautifulsoup4",
    "tldextract": "tldextract",
}


def ensure_dependencies():
    need_install = []
    for mod_name, pip_name in REQUIRED_PACKAGES.items():
        try:
            importlib.import_module(mod_name)
        except ImportError:
            need_install.append(pip_name)

    if need_install:
        print(f"[*] 检测到缺少依赖库: {', '.join(need_install)}，正在自动安装...")
        for package in need_install:
            try:
                cmd = [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    package,
                    "-i",
                    "https://pypi.tuna.tsinghua.edu.cn/simple",
                ]
                subprocess.check_call(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                print(f"[+] [{package}] 安装成功")
            except subprocess.CalledProcessError:
                subprocess.check_call([sys.executable, "-m", "pip", "install", package])
        print("[*] 依赖库就绪\n" + "=" * 60)


ensure_dependencies()

import requests  # noqa: E402
import tldextract  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

# ==================== 2. 核心配置 ====================

# Cloudflare 官方 IPv4 CIDR 列表
CF_IP_RANGES = [
    ipaddress.ip_network("173.245.48.0/20"),
    ipaddress.ip_network("103.21.244.0/22"),
    ipaddress.ip_network("103.22.200.0/22"),
    ipaddress.ip_network("103.31.4.0/22"),
    ipaddress.ip_network("141.101.64.0/18"),
    ipaddress.ip_network("108.162.192.0/18"),
    ipaddress.ip_network("190.93.240.0/20"),
    ipaddress.ip_network("188.114.96.0/20"),
    ipaddress.ip_network("197.234.240.0/22"),
    ipaddress.ip_network("198.41.128.0/17"),
    ipaddress.ip_network("162.158.0.0/15"),
    ipaddress.ip_network("104.16.0.0/13"),
    ipaddress.ip_network("104.24.0.0/14"),
    ipaddress.ip_network("172.64.0.0/13"),
    ipaddress.ip_network("131.0.72.0/22"),
]

# Cloudflare 官方自有根域名（仅用于探索外链，不写入最终 txt）
CF_OWN_ROOT_DOMAINS = {
    "cloudflare.com",
    "cloudflare.net",
    "cloudflareinsights.com",
    "cloudflareclient.com",
    "cloudflare-ech.com",
    "cloudflarestatus.com",
    "cloudflareresearch.com",
    "workers.dev",
    "pages.dev",
    "cf-ipfs.com",
}

# 巨型科技站黑名单（主域名）—— 走 CF 但非"冷门优选"目标，仅作矿源：不入库但允许扩散其外链
# 注意：CF 官方域名（cloudflare.com 等）不在此列，它们不入库但仍作为扩散矿源
BIG_TECH_ROOTS = {
    "google.com", "googleapis.com", "gstatic.com", "youtube.com", "gmail.com",
    "googleblog.com", "googleusercontent.com",
    "facebook.com", "fbcdn.net", "instagram.com", "whatsapp.com", "meta.com",
    "messenger.com",
    "microsoft.com", "windows.com", "windows.net", "azure.com", "azureedge.net",
    "live.com", "bing.com", "office.com", "msn.com", "skype.com", "github.com",
    "githubassets.com", "githubstatus.com", "githubusercontent.com", "github.io",
    "github.blog", "gitlab.com", "linkedin.com", "apple.com", "icloud.com",
    "amazon.com", "amazonaws.com", "cloudfront.net", "awsstatic.com", "twitch.tv",
    "twitter.com", "x.com", "t.co", "wordpress.com", "w.org", "wordpress.org",
    "wikipedia.org", "wikimedia.org", "mozilla.org", "mozilla.com", "firefox.com",
    "schema.org", "w3.org", "yahoo.com", "baidu.com", "qq.com",
    "tencent.com", "taobao.com", "aliyun.com", "alibabacloud.com", "jd.com",
    "bilibili.com", "weibo.com", "sina.com", "sohu.com", "netflix.com",
    "openai.com", "anthropic.com", "huggingface.co", "reddit.com", "pinterest.com",
    "tiktok.com", "bytefcdn.com", "shopify.com", "salesforce.com", "oracle.com",
    "ibm.com", "adobe.com", "akamai.com", "akamaized.net", "fastly.net",
    "cloudfront.cn",
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-Ch-Ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

OUTPUT_FILE = "cf_domains.txt"

# 自举种子：仅在历史文件为空时使用（cloudflare.com 外链极多，是天然域名矿）
BOOTSTRAP_SEEDS = ["cloudflare.com"]

# 每次运行随机抽取的历史域名数量作为本轮种子
SEED_SAMPLE_SIZE = 5

# 同一主域名最多保留的子域名数量
MAX_SUBDOMAINS_PER_ROOT = 3

# 单次运行最多新增的域名数（防止 2 分钟内无限扩散）
MAX_NEW_PER_RUN = 200

# 探测阶段时长上限（秒）—— 由程序自身计时优雅停止，而非外部 timeout 强杀
PROBE_TIME_LIMIT = 30

# 单页嗅探入队上限，防止巨型页把队列撑爆
MAX_NEW_PER_PAGE = 50

IGNORE_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js",
    ".woff", ".woff2", ".ico", ".ttf", ".map",
)


def load_existing_domains(filepath: str):
    """载入本地已有域名（纯域名），并统计每个主域名的子域数量。

    返回 (saved_set, root_sub_count)
    """
    saved = set()
    root_sub_count = defaultdict(int)
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    domain = line.split("#")[0].strip().lower()
                    if domain:
                        saved.add(domain)
                        root_sub_count[get_registered_domain(domain)] += 1
        except Exception:
            pass
    return saved, root_sub_count


def get_registered_domain(domain: str) -> str:
    extracted = tldextract.extract(domain)
    if extracted.suffix:
        return f"{extracted.domain}.{extracted.suffix}"
    return domain


def is_cloudflare_own_domain(domain: str) -> bool:
    root = get_registered_domain(domain)
    return root in CF_OWN_ROOT_DOMAINS or "cloudflare" in domain.split(".")


def is_big_tech(domain: str) -> bool:
    root = get_registered_domain(domain)
    return root in BIG_TECH_ROOTS


def is_cloudflare_ip(ip_str: str) -> bool:
    try:
        ip_obj = ipaddress.ip_address(ip_str)
        return any(ip_obj in network for network in CF_IP_RANGES)
    except ValueError:
        return False


def is_cloudflare_domain(domain: str) -> bool:
    """检测域名是否走 Cloudflare CDN（DNS/IP 段快速路径优先，HEAD 兜底）"""
    # 快速路径：DNS 解析后看 IP 是否落在 Cloudflare 官方段（通常几十 ms）
    try:
        ip = socket.gethostbyname(domain)
        if is_cloudflare_ip(ip):
            return True
    except Exception:
        pass

    # 兜底：发 HEAD 看 Server 头（仅在 DNS 路径未命中时走，短超时）
    for schema in ("https://", "http://"):
        try:
            url = f"{schema}{domain}"
            resp = requests.head(url, headers=HEADERS, timeout=3, allow_redirects=True)
            if "cloudflare" in resp.headers.get("Server", "").lower():
                return True
        except requests.RequestException:
            continue
    return False


def extract_all_domains_deep(raw_content: str, base_url: str) -> set:
    """深度全文本嗅探提取域名"""
    domains = set()

    clean_text = html.unescape(raw_content)
    clean_text = unquote(clean_text)
    clean_text = clean_text.replace(r"\/", "/")

    try:
        soup = BeautifulSoup(clean_text, "html.parser")
        for tag in soup.find_all(["a", "link", "script", "iframe"], href=True):
            href = tag.get("href", "").strip()
            if href and not href.startswith(("javascript:", "mailto:", "tel:", "#")):
                full_url = urljoin(base_url, href)
                host = urlparse(full_url).netloc.split(":")[0].strip().lower()
                if host:
                    domains.add(host)
        for tag in soup.find_all(["script", "img", "iframe"], src=True):
            src = tag.get("src", "").strip()
            if src:
                full_url = urljoin(base_url, src)
                host = urlparse(full_url).netloc.split(":")[0].strip().lower()
                if host:
                    domains.add(host)
    except Exception:
        pass

    url_pattern = re.findall(
        r'(?:https?:)?//([a-zA-Z0-9.-]+\.[a-zA-Z]{2,63})', clean_text
    )
    for host in url_pattern:
        host = host.split("/")[0].split(":")[0].strip().lower()
        domains.add(host)

    valid = set()
    for d in domains:
        d = d.strip(".'\"/ ")
        if not d or d.endswith(IGNORE_EXTENSIONS):
            continue
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", d):
            continue
        if re.match(r"^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,20}$", d):
            valid.add(d.lower())
    return valid


def pick_seeds(saved: set) -> list:
    """选择本轮种子：有历史则随机抽，否则用自举种子"""
    if saved:
        sample = random.sample(sorted(saved), min(SEED_SAMPLE_SIZE, len(saved)))
        print(f"[*] 从已有 {len(saved)} 个域名中随机抽 {len(sample)} 个作为本轮种子")
        return sample
    print(f"[*] 历史为空，使用自举种子: {BOOTSTRAP_SEEDS}")
    return list(BOOTSTRAP_SEEDS)


def run_cf_explorer():
    saved, root_sub_count = load_existing_domains(OUTPUT_FILE)
    print(f"[*] 已载入 {len(saved)} 个已有域名")

    start_time = time.time()

    def _flush_all():
        """全量写回：覆盖模式，保证探测阶段结束时数据落盘"""
        try:
            with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                f.write("# CF 探测优选结果（每行一个纯域名，由 GitHub Actions 自动累积）\n")
                f.write("# 由脚本自动更新，请勿手动编辑\n")
                for d in sorted(saved):
                    f.write(d + "\n")
            print(f"[*] 已全量写回 {len(saved)} 个域名 -> {OUTPUT_FILE}")
        except Exception as e:
            print(f"[!] 写回失败: {e}")

    seeds = pick_seeds(saved)

    # 双队列：cf_q 优先级高（命中 CF 的第三方 / CF 官方），normal_q 兜底
    cf_q = deque()
    normal_q = deque()

    def enqueue(domain: str, priority: bool = False):
        domain = domain.strip().lower()
        if "://" in domain:
            domain = urlparse(domain).netloc.split(":")[0]
        if priority:
            cf_q.appendleft(domain)
        else:
            normal_q.append(domain)

    for s in seeds:
        enqueue(s)

    visited = set()
    non_cf_roots = set()
    new_added = 0

    print(f"[*] 结果保存路径: {os.path.abspath(OUTPUT_FILE)}\n" + "=" * 60)

    def next_batch(n: int):
        """从双队列取出最多 n 个未访问域名（CF 优先）"""
        batch = []
        while len(batch) < n and (cf_q or normal_q):
            if cf_q:
                d = cf_q.popleft()
            else:
                d = normal_q.popleft()
            d = d.strip().lower()
            if d in visited:
                continue
            visited.add(d)
            batch.append(d)
        return batch

    with ThreadPoolExecutor(max_workers=10) as pool:
        while (cf_q or normal_q) and new_added < MAX_NEW_PER_RUN:
            # 程序自身计时优雅停止：到时间则结束探测循环，进入收尾
            if time.time() - start_time >= PROBE_TIME_LIMIT:
                print(f"\n[*] 已达探测时长上限 {PROBE_TIME_LIMIT}s，停止探测，进入收尾...")
                break

            batch = next_batch(20)
            if not batch:
                break

            # 并发检测整批域名是否走 Cloudflare
            results = pool.map(is_cloudflare_domain, batch)

            for current, is_cf in zip(batch, results):
                root = get_registered_domain(current)
                if root in non_cf_roots and current != root:
                    continue

                print(f"[?] 检测: {current:<40}", end="", flush=True)

                # 巨型科技站黑名单：不入库，但允许抓取其页面外链作为矿源继续扩散
                if is_big_tech(current):
                    print(" -> [巨型站 不入库但扩散外链]")
                    _expand(current, enqueue, visited, non_cf_roots, priority=False)
                    continue

                if is_cloudflare_own_domain(current):
                    print(" -> [CF官方域名 探索外链]")
                    _expand(current, enqueue, visited, non_cf_roots, priority=True)
                elif current in saved:
                    print(" -> [已在记录中 跳过]")
                elif is_cf:
                    if root_sub_count.get(root, 0) >= MAX_SUBDOMAINS_PER_ROOT:
                        print(f" -> [主域 {root} 已达上限 {MAX_SUBDOMAINS_PER_ROOT} 跳过]")
                    else:
                        print(" -> [命中 Cloudflare 第三方]")
                        saved.add(current)
                        root_sub_count[root] += 1
                        new_added += 1
                        # 命中 CF 的第三方域名优先继续扩散，挖掘其同生态外链
                        _expand(current, enqueue, visited, non_cf_roots, priority=True)
                else:
                    print(" -> [非 Cloudflare 跳过]")
                    if current == root:
                        non_cf_roots.add(root)
                    # 非 CF 域名不抓页面扩散，避免队列被巨型站淹没

    _flush_all()
    print("=" * 60)
    print(
        f"[!] 本轮结束：新增 {new_added} 个域名，文件总计 {len(saved)} 个"
        f"（已过滤 CF 官方/巨型站，主域≤{MAX_SUBDOMAINS_PER_ROOT}）"
    )


def _expand(current, enqueue, visited, non_cf_roots, priority: bool = False):
    """抓取当前页面，嗅探外链入队（单页上限 MAX_NEW_PER_PAGE）"""
    for schema in ("https://", "http://"):
        try:
            target_url = f"{schema}{current}"
            response = requests.get(target_url, headers=HEADERS, timeout=6)
            if response.text and len(response.text) > 100:
                new_domains = extract_all_domains_deep(response.text, target_url)
                added = 0
                for nd in new_domains:
                    if added >= MAX_NEW_PER_PAGE:
                        break
                    nd_root = get_registered_domain(nd)
                    if nd not in visited and nd_root not in non_cf_roots:
                        enqueue(nd, priority=priority)
                        added += 1
                if added:
                    print(f"    └─ [+] 嗅探出 {added} 个新域名入队")
                break
        except Exception:
            continue


if __name__ == "__main__":
    try:
        run_cf_explorer()
    except KeyboardInterrupt:
        print("\n[!] 手动停止，数据已安全保存。")
