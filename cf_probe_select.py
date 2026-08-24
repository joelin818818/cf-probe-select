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

# Cloudflare 官方 IPv4 CIDR 列表（启动时会拉取最新，失败则用此兜底）
CF_IP_RANGES_FALLBACK = [
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


def load_cf_ip_ranges(timeout: int = 10):
    """从 Cloudflare 官网拉取最新 IPv4 CIDR 段，失败则返回兜底列表。"""
    url = "https://www.cloudflare.com/ips-v4"
    try:
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        ranges = []
        for line in resp.text.splitlines():
            line = line.strip()
            if not line or "/" not in line:
                continue
            try:
                ranges.append(ipaddress.ip_network(line, strict=False))
            except ValueError:
                continue
        if ranges:
            print(f"[*] 已拉取 Cloudflare 官方 IPv4 段 {len(ranges)} 条")
            return ranges
    except Exception as e:
        print(f"[!] 拉取 CF IP 段失败，使用兜底列表: {e}")
    return CF_IP_RANGES_FALLBACK


CF_IP_RANGES = load_cf_ip_ranges()

# Cloudflare 官方自有根域名（仅用于探索外链，不写入最终 txt）
# 注：one.one.one.one 经 tldextract 解析后 registered domain 为 one.one
CF_OWN_ROOT_DOMAINS = {
    "cloudflare.com",
    "cloudflare.net",
    "cloudflareinsights.com",
    "cloudflareclient.com",
    "cloudflare-ech.com",
    "cloudflarestatus.com",
    "cloudflareresearch.com",
    "cloudflareaccess.com",
    "imagedelivery.net",
    "one.one",
    "trycloudflare.com",
    "r2.dev",
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
            line_count = 0
            parsed = 0
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line_count += 1
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    domain = line.split("#")[0].strip().lower()
                    if domain:
                        saved.add(domain)
                        root_sub_count[get_registered_domain(domain)] += 1
                        parsed += 1
            print(f"[*] 读取 {filepath}: 共 {line_count} 行, 解析出 {parsed} 个域名")
        except Exception as e:
            print(f"[!] 读取 {filepath} 失败: {e}")
    else:
        print(f"[*] {filepath} 不存在，视为空")
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
        # 只检查 IPv4
        if not isinstance(ip_obj, ipaddress.IPv4Address):
            return False
        return any(ip_obj in network for network in CF_IP_RANGES)
    except ValueError:
        return False


def resolve_ips(domain: str) -> list:
    """解析域名 A 记录，返回前几个 IPv4 地址。"""
    try:
        # socket.getaddrinfo 可返回多个 A 记录
        infos = socket.getaddrinfo(domain, None, socket.AF_INET)
        ips = []
        seen = set()
        for info in infos:
            ip = info[4][0]
            if ip not in seen:
                seen.add(ip)
                ips.append(ip)
        return ips
    except Exception:
        return []


def _build_dns_query(domain: str) -> bytes:
    """构造极简 DNS 查询包（标准 UDP 53，查询 A 记录）。"""
    import struct

    txn_id = 0x1234
    flags = 0x0100
    header = struct.pack(">HHHHHH", txn_id, flags, 1, 0, 0, 0)
    qname = b""
    for part in domain.split("."):
        qname += bytes([len(part)]) + part.encode("ascii")
    qname += b"\x00"
    question = qname + struct.pack(">HH", 1, 1)
    return header + question


def _parse_dns_a_records(resp: bytes) -> list:
    """解析 DNS 响应，提取 A 记录 IPv4。"""
    import struct

    try:
        _, _, qd, an = struct.unpack(">HHHH", resp[:12])
        off = 12
        for _ in range(qd):
            while resp[off] != 0:
                off += resp[off] + 1
            off += 1
            off += 4
        ips = []
        for _ in range(an):
            if resp[off] & 0xC0 == 0xC0:
                off += 2
            else:
                while resp[off] != 0:
                    off += resp[off] + 1
                off += 1
            rtype, _, _, rdlen = struct.unpack(">HHIH", resp[off:off + 10])
            off += 10
            if rtype == 1 and rdlen == 4:
                ips.append(".".join(str(b) for b in resp[off:off + 4]))
            off += rdlen
        return ips
    except Exception:
        return []


def resolve_via_udp_dns(domain: str, server: str, timeout: int = 5) -> list:
    """标准 UDP 53 解析 A 记录。"""
    try:
        query = _build_dns_query(domain)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(query, (server, 53))
            resp, _ = s.recvfrom(4096)
        return _parse_dns_a_records(resp)
    except Exception:
        return []


def resolve_via_doh(domain: str, base_url: str, timeout: int = 5) -> list:
    """DoH（DNS-over-HTTPS）解析 A 记录。"""
    try:
        url = base_url + "?name=" + domain + "&type=A"
        r = requests.get(url, headers={"Accept": "application/dns-json"}, timeout=timeout)
        if not r.ok:
            return []
        data = r.json()
        ips = []
        for a in data.get("Answer", []):
            if a.get("type") == 1:  # A 记录
                ips.append(a["data"])
        return ips
    except Exception:
        return []


# 多地区/多源解析器：系统 DNS + 国内 UDP + 国内/全球 DoH
DNS_RESOLVERS = [
    ("system", "udp", None),
    ("cnnic-1.2.4.8", "udp", "1.2.4.8"),
    ("aliyun-doh", "doh", "https://dns.alidns.com/dns-query"),
    ("tencent-doh", "doh", "https://doh.pub/dns-query"),
    ("google-doh", "doh", "https://dns.google/resolve"),
    ("cloudflare-doh", "doh", "https://cloudflare-dns.com/dns-query"),
]


def resolve_ips_multi(domain: str) -> dict:
    """多源并发解析，返回 {源名: [ip...]}。"""
    def _one(item):
        name, kind, srv = item
        if kind == "udp":
            return (name, resolve_via_udp_dns(domain, srv) if srv else resolve_ips(domain))
        return (name, resolve_via_doh(domain, srv))

    result = {}
    with ThreadPoolExecutor(max_workers=len(DNS_RESOLVERS)) as ex:
        for name, ips in ex.map(_one, DNS_RESOLVERS):
            result[name] = ips
    return result


def is_cloudflare_domain(domain: str) -> bool:
    """检测域名是否走 Cloudflare CDN：先查多个 IP，任一命中 CF 段即保留；否则 HEAD 兜底"""
    # 快速路径：解析所有 A 记录，任一 IP 命中 CF 官方段即认为走 CF
    ips = resolve_ips(domain)
    for ip in ips:
        if is_cloudflare_ip(ip):
            return True

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


def filter_non_cf_domains(saved: set, root_sub_count: defaultdict):
    """落盘前最终过滤（硬标准：所有解析源都必须落在 Cloudflare 段）。

    多地区/多源并发解析（系统 DNS + 1.2.4.8 + 阿里/腾讯/Google/Cloudflare DoH）。
    严格交集判定：只要任一源返回的 IP 里有不在 CF 段的，即删除；
    只有所有源都落在 CF 段才保留。不认 Server 头，与前端展示逻辑一致。
    """
    if not saved:
        return
    domains = sorted(saved)
    print(f"[*] 落盘前 CF IP 校验（多源严格交集，并发）: 共 {len(domains)} 个域名")

    def check(domain):
        sources = resolve_ips_multi(domain)
        non_cf_sources = []
        for name, ips in sources.items():
            if not ips:
                non_cf_sources.append(f"{name}=解析失败")
                continue
            if not any(is_cloudflare_ip(ip) for ip in ips):
                non_cf_sources.append(f"{name}={','.join(ips)}")
        if non_cf_sources:
            return (domain, False, "; ".join(non_cf_sources))
        union = []
        seen = set()
        for ips in sources.values():
            for ip in ips:
                if ip not in seen:
                    seen.add(ip)
                    union.append(ip)
        return (domain, True, ",".join(union))

    removed = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        for domain, ok, detail in pool.map(check, domains):
            if ok:
                print(f"    [✓] {domain:<45} {detail}")
            else:
                removed.append(domain)
                print(f"    [-] {domain:<45} 非 CF: {detail}，移除")

    if removed:
        for d in removed:
            saved.discard(d)
            root = get_registered_domain(d)
            if root_sub_count[root] > 0:
                root_sub_count[root] -= 1
        print(f"[*] 已移除 {len(removed)} 个非 CF 域名，剩余 {len(saved)} 个")
    else:
        print("[*] 落盘前校验通过，未发现非 CF 域名")


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
        """全量写回：先过一遍 CF IP 校验，删除非 CF 域名，再落盘"""
        filter_non_cf_domains(saved, root_sub_count)
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
                    # 已记录的域名不再入库，但仍抓取页面外链以发现新域名（矿源）
                    print(" -> [已在记录中 仅扩散外链]")
                    _expand(current, enqueue, visited, non_cf_roots, priority=is_cf)
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
