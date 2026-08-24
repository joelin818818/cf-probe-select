import html
import importlib
import ipaddress
import os
import re
import socket
import subprocess
import sys
from collections import deque
from urllib.parse import unquote, urljoin, urlparse

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
                print(f"[✓] [{package}] 安装成功！")
            except subprocess.CalledProcessError:
                subprocess.check_call([sys.executable, "-m", "pip", "install", package])
        print("[*] 依赖库就绪，立即启动！\n" + "=" * 60)


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

IGNORE_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".css",
    ".js",
    ".woff",
    ".woff2",
    ".ico",
    ".ttf",
    ".map",
)


def load_existing_saved_domains(filepath: str) -> set:
    """载入本地已有域名，防止跨运行重复"""
    saved = set()
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        domain_part = line.split("#")[0].strip().lower()
                        if domain_part:
                            saved.add(domain_part)
        except Exception:
            pass
    return saved


def get_registered_domain(domain: str) -> str:
    """提取根主域名（例如 blog.cloudflare.com -> cloudflare.com）"""
    extracted = tldextract.extract(domain)
    if extracted.suffix:
        return f"{extracted.domain}.{extracted.suffix}"
    return domain


def is_cloudflare_own_domain(domain: str) -> bool:
    """判断是否为 Cloudflare 官方自有资产域名"""
    root = get_registered_domain(domain)
    return root in CF_OWN_ROOT_DOMAINS or "cloudflare" in domain.split(".")


def is_cloudflare_ip(ip_str: str) -> bool:
    """判断 IP 是否属于 Cloudflare 官方 IP 段"""
    try:
        ip_obj = ipaddress.ip_address(ip_str)
        return any(ip_obj in network for network in CF_IP_RANGES)
    except ValueError:
        return False


def is_cloudflare_domain(domain: str) -> bool:
    """检测域名是否走 Cloudflare CDN"""
    try:
        ip = socket.gethostbyname(domain)
        if is_cloudflare_ip(ip):
            return True
    except Exception:
        pass

    for schema in ["https://", "http://"]:
        try:
            url = f"{schema}{domain}"
            resp = requests.head(
                url, headers=HEADERS, timeout=4, allow_redirects=True
            )
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

    # HTML 标签解析
    try:
        soup = BeautifulSoup(clean_text, "html.parser")
        for tag in soup.find_all(["a", "link", "script", "iframe"], href=True):
            href = tag.get("href", "").strip()
            if href and not href.startswith(
                ("javascript:", "mailto:", "tel:", "#")
            ):
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

    # 强力 URL 正则匹配
    url_pattern = re.findall(
        r'(?:https?:)?//([a-zA-Z0-9.-]+\.[a-zA-Z]{2,63})', clean_text
    )
    for host in url_pattern:
        host = host.split("/")[0].split(":")[0].strip().lower()
        domains.add(host)

    valid_domains = set()
    for d in domains:
        d = d.strip(".'\"/ ")
        if not d or d.endswith(IGNORE_EXTENSIONS):
            continue
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", d):
            continue
        if re.match(r"^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,20}$", d):
            valid_domains.add(d.lower())

    return valid_domains


def run_cf_explorer(seed_domain: str, max_limit: int = 50):
    """主探索逻辑"""
    if "://" in seed_domain:
        seed_domain = urlparse(seed_domain).netloc.split(":")[0]
    seed_domain = seed_domain.strip().lower()

    saved_cf_domains = load_existing_saved_domains(OUTPUT_FILE)
    if saved_cf_domains:
        print(f"[*] 已载入 {len(saved_cf_domains)} 个已有域名（自动开启防重复）")

    domain_queue = deque([seed_domain])
    root_seed = get_registered_domain(seed_domain)
    if root_seed != seed_domain:
        domain_queue.append(root_seed)
        domain_queue.append(f"www.{root_seed}")
    else:
        domain_queue.append(f"www.{root_seed}")

    visited_domains = set()
    non_cf_root_domains = set()

    print(f"[*] 起始探索目标: {seed_domain}")
    print(f"[*] 结果保存路径: {os.path.abspath(OUTPUT_FILE)}\n" + "=" * 60)

    new_added_count = 0

    while domain_queue and new_added_count < max_limit:
        current_domain = domain_queue.popleft().strip().lower()

        if current_domain in visited_domains:
            continue
        visited_domains.add(current_domain)

        root_domain = get_registered_domain(current_domain)
        if root_domain in non_cf_root_domains and current_domain != root_domain:
            continue

        print(f"[?] 正在检测: {current_domain:<38}", end="", flush=True)

        # 1. 如果是 Cloudflare 官方资产：仅探索外链，不写入文件
        if is_cloudflare_own_domain(current_domain):
            print(" -> \033[35m[✦ CF官方域名 (探索外链/不入库)]\033[0m")
        # 2. 如果已经存在于历史文件中：跳过写入
        elif current_domain in saved_cf_domains:
            print(" -> \033[33m[⊙ 已在记录中 (跳过)]\033[0m")
        # 3. 普通第三方域名且走 Cloudflare：验证写入
        elif is_cloudflare_domain(current_domain):
            print(" -> \033[32m[✓ 命中 Cloudflare]\033[0m")
            saved_cf_domains.add(current_domain)
            new_added_count += 1
            record_line = (
                f"{current_domain}#CF冷门优选_{len(saved_cf_domains)}\n"
            )
            with open(OUTPUT_FILE, "a", encoding="utf-8") as f:
                f.write(record_line)
        # 4. 不属于 Cloudflare
        else:
            print(" -> \033[31m[✗ 跳过]\033[0m")
            if current_domain == root_domain:
                non_cf_root_domains.add(root_domain)

        # 抓取页面继续向下扩散（包括 CF 官方页面）
        for schema in ["https://", "http://"]:
            try:
                target_url = f"{schema}{current_domain}"
                response = requests.get(target_url, headers=HEADERS, timeout=6)
                if response.text and len(response.text) > 100:
                    new_domains = extract_all_domains_deep(
                        response.text, target_url
                    )
                    added_count = 0
                    for nd in new_domains:
                        nd_root = get_registered_domain(nd)
                        if (
                            nd not in visited_domains
                            and nd_root not in non_cf_root_domains
                        ):
                            domain_queue.append(nd)
                            added_count += 1
                    if added_count > 0:
                        print(
                            f"    └─ \033[36m[+] 从该页面深度嗅探出 {added_count} 个新域名入队\033[0m"
                        )
                    break
            except Exception:
                continue

    print("=" * 60)
    print(
        f"[!] 探索结束！本次新增 {new_added_count} 个第三方优质域名，文件总计 {len(saved_cf_domains)} 个（已自动过滤 CF 官方域名）。"
    )


if __name__ == "__main__":
    try:
        user_input = input(
            "请输入起始探索域名（例如 blog.cloudflare.com / flutter.dev）：\n> "
        ).strip()
        if user_input:
            run_cf_explorer(user_input, max_limit=50)
        else:
            print("输入不能为空！")
    except KeyboardInterrupt:
        print("\n[!] 手动停止，数据已安全保存。")
