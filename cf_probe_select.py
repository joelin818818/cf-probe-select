import bisect
import html
import ipaddress
import os
import random
import re
import socket
import string
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from collections import deque, defaultdict
from functools import lru_cache
from urllib.parse import unquote, urljoin, urlparse

import requests
import tldextract
from bs4 import XMLParsedAsHTMLWarning, BeautifulSoup

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

# ==================== 0. 可调参数配置区（改这里即可，无需翻找代码） ====================
# 下面所有参数集中在此，调整探测行为请直接修改本区域，代码其他位置不再出现魔法数字。

# ---- 输出与种子 ----
OUTPUT_FILE = "cf_domains.txt"          # 探测结果落盘文件名
BOOTSTRAP_SEEDS = ["cloudflare.com"]    # 历史为空时的自举种子

# ---- 数量与配额 ----
SEED_SAMPLE_SIZE = 5                    # 每轮从已有域名中随机抽取的种子数量
MAX_SUBDOMAINS_PER_ROOT = 3             # 同一主域名最多保留的子域数量
MAX_NEW_PER_RUN = 100                   # 单轮最多新增的域名数（达到即提前结束）
TOTAL_CAP = 200                         # 落盘域名总量硬上限
                                        #   超限处理：先把主域配额从 3 收紧到 2、再到 1；
                                        #   若仍超限，则按「GitHub 机房 → CF 节点」延迟升序截断（不可达沉底）

# ---- 时间与批次 ----
PROBE_TIME_LIMIT = 600                  # 单轮探测时长上限（秒）
MAX_NEW_PER_PAGE = 50                   # 单个页面最多提取的外链域名数
BATCH_SIZE = 20                         # 每轮出队处理的域名数

# ---- 并发线程数 ----
WORKERS_PROBE = 10                      # 主探测（检测 + 外链扩散）并发数
WORKERS_VERIFY = 10                     # 落盘前 CF 多源校验并发数
WORKERS_LATENCY = 10                    # Actions 内部延迟测速并发数

# ---- 网络超时（秒） ----
LATENCY_TIMEOUT = 3                     # Actions 内部测速单域名超时
HTTP_TIMEOUT_EXPAND = 6                 # 抓取页面提取外链的超时
DNS_TIMEOUT_UDP = 5                     # UDP DNS 解析超时
DNS_TIMEOUT_DOH = 5                     # DoH 解析超时
CF_RANGES_TIMEOUT = 10                  # 拉取 Cloudflare 官方 IP 段的超时

# ---- Cloudflare Gateway DoH 随机子域 ----
# 每次运行随机生成 10 位「小写字母 + 数字」子域（Gateway 接受任意子域）。
GATEWAY_SUB_LEN = 10

# ---- 黑产域名黑名单（落盘前剔除，但保留为外链扩散跳板）----
MALICIOUS_BLOCKLIST_SOURCES = [
    ("https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/gambling.medium-onlydomains.txt",
     "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/gambling.medium-onlydomains.txt"),
    ("https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/tif.medium-onlydomains.txt",
     "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt"),
    ("https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/fake-onlydomains.txt",
     "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/fake-onlydomains.txt"),
]
MALICIOUS_BLOCKLIST_TIMEOUT = 15

# ---- 自建黑产关键词黑名单（子串/边界匹配，落盘前剔除但保留为外链扩散跳板）----
KEYWORD_BLACKLIST_FILE = "blacklist_keywords.txt"


def random_gateway_sub(n: int = GATEWAY_SUB_LEN) -> str:
    """生成 n 位「小写字母 + 数字」随机串，用作 Cloudflare Gateway DoH 的随机子域。"""
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


# ==================== 1. 核心配置 ====================

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

# 全局 Session，复用 TCP/TLS 连接
HTTP_SESSION = requests.Session()
HTTP_SESSION.headers.update(HEADERS)

# 探测阶段 DNS 解析缓存：domain -> [ips]
DOMAIN_IP_CACHE = {}

# 多线程下 stdout 打印锁，保证每行日志原子输出不交错
PRINT_LOCK = threading.Lock()


def log(msg: str):
    with PRINT_LOCK:
        print(msg, flush=True)


def load_cf_ip_ranges(timeout: int = CF_RANGES_TIMEOUT):
    """从 Cloudflare 官网拉取最新 IPv4 CIDR 段，失败则返回兜底列表。"""
    url = "https://www.cloudflare.com/ips-v4"
    try:
        resp = HTTP_SESSION.get(url, timeout=timeout)
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


def _build_cf_ip_index(networks):
    """把 CF CIDR 合并成有序不重叠区间列表，用于二分查找。返回 [(start_int, end_int)]"""
    merged = []
    for net in sorted(networks, key=lambda n: n.network_address):
        start = int(net.network_address)
        end = int(net.broadcast_address)
        if merged and start <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


CF_IP_INDEX = _build_cf_ip_index(CF_IP_RANGES)

# Cloudflare 官方自有根域名（仅用于探索外链，不写入最终 txt）
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

# 巨型科技站黑名单（主域名）—— 走 CF 但非"冷门优选"目标，仅作矿源
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

IGNORE_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js",
    ".woff", ".woff2", ".ico", ".ttf", ".map",
)


def load_existing_domains(filepath: str):
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


@lru_cache(maxsize=None)
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


MALICIOUS_EXACT = set()

def load_blocklists():
    global MALICIOUS_EXACT
    MALICIOUS_EXACT = set()
    ok_sources = 0
    for jsd, gh in MALICIOUS_BLOCKLIST_SOURCES:
        text = None
        for url in (jsd, gh):
            try:
                r = HTTP_SESSION.get(url, timeout=MALICIOUS_BLOCKLIST_TIMEOUT)
                if r.status_code == 200 and r.text.strip():
                    text = r.text
                    break
            except Exception:
                continue
        if not text:
            print(f"[!] 黑名单源拉取失败（已跳过）: {jsd}")
            continue
        ok_sources += 1
        for line in text.splitlines():
            d = line.strip().lower()
            if not d or d.startswith("#"):
                continue
            if d.startswith("*."):
                d = d[2:]
            MALICIOUS_EXACT.add(d)
    print(f"[*] 黑名单已加载：{ok_sources}/{len(MALICIOUS_BLOCKLIST_SOURCES)} 个源成功，共 {len(MALICIOUS_EXACT)} 条")

def is_malicious(domain: str) -> bool:
    d = domain.lower()
    for base in MALICIOUS_EXACT:
        if d == base or d.endswith("." + base):
            return True
    return False


KEYWORD_SUBSTR = set()
KEYWORD_BOUNDED_RE = None

def load_keyword_blacklist():
    global KEYWORD_SUBSTR, KEYWORD_BOUNDED_RE
    KEYWORD_SUBSTR = set()
    bounded = []
    mode = "substr"
    bounded_mode = "standalone"
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), KEYWORD_BLACKLIST_FILE)
    if not os.path.exists(path):
        print(f"[!] 关键词黑名单文件不存在，跳过: {path}")
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip().lower()
            if not line or line.startswith("#"):
                continue
            if line.startswith("====="):
                if "±数字" in line:
                    bounded_mode = "combo"
                elif "连号" in line or "数字" in line:
                    bounded_mode = "number"
                else:
                    bounded_mode = "standalone"
                mode = "bounded"
                continue
            if mode == "substr":
                KEYWORD_SUBSTR.add(line)
            else:
                esc = re.escape(line)
                if bounded_mode == "combo":
                    bounded.append(r"(?:^|[\.\-])(" + esc + r"\d+|\d+" + esc + r")(?:[\.\-]|$)")
                else:
                    bounded.append(r"(?:^|[\.\-])(" + esc + r")(?:[\.\-]|$)")
    if bounded:
        KEYWORD_BOUNDED_RE = re.compile("|".join(bounded), re.IGNORECASE)
    print(f"[*] 关键词黑名单已加载：独占黑词 {len(KEYWORD_SUBSTR)} 条，边界词已编译")

def is_blackhat_keyword(domain: str) -> bool:
    d = domain.lower()
    for kw in KEYWORD_SUBSTR:
        if kw in d:
            return True
    if KEYWORD_BOUNDED_RE and KEYWORD_BOUNDED_RE.search(d):
        return True
    return False


def is_cloudflare_ip(ip_str: str) -> bool:
    """判断 IP 是否落在 Cloudflare 官方 IPv4 CIDR 内（只认 IP 段硬过滤，二分查找 O(log n)）"""
    try:
        ip_obj = ipaddress.ip_address(ip_str)
        if not isinstance(ip_obj, ipaddress.IPv4Address):
            return False
        ip_int = int(ip_obj)
    except ValueError:
        return False
    idx = bisect.bisect_right(CF_IP_INDEX, (ip_int, 2 ** 64)) - 1
    if idx < 0:
        return False
    start, end = CF_IP_INDEX[idx]
    return start <= ip_int <= end


def resolve_ips(domain: str) -> list:
    try:
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


def resolve_via_udp_dns(domain: str, server: str, timeout: int = DNS_TIMEOUT_UDP) -> list:
    try:
        query = _build_dns_query(domain)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(query, (server, 53))
            resp, _ = s.recvfrom(4096)
        return _parse_dns_a_records(resp)
    except Exception:
        return []


def resolve_via_doh(domain: str, base_url: str, timeout: int = DNS_TIMEOUT_DOH) -> list:
    try:
        url = base_url + "?name=" + domain + "&type=1"
        r = HTTP_SESSION.get(url, headers={"Accept": "application/dns-json"}, timeout=timeout)
        if not r.ok:
            return []
        data = r.json()
        ips = []
        for a in data.get("Answer", []):
            if a.get("type") == 1:
                ips.append(a["data"])
        return ips
    except Exception:
        return []


# ==================== 修改点 1 ====================
# 多源解析器：系统 DNS + 国内 DoH（腾讯/阿里）+ 全球 DoH（DNS.SB/Cloudflare Gateway/Google）
# cf-gateway-doh 的子域每次运行随机生成（见 random_gateway_sub）。
DNS_RESOLVERS = [
    ("system", "udp", None),
    ("tencent-doh", "doh", "https://doh.pub/dns-query"),
    ("aliyun-doh", "doh", "https://dns.alidns.com/resolve"),
    ("dnssb-doh", "doh", "https://doh.dns.sb/dns-query"),
    ("cf-gateway-doh", "doh", "https://" + random_gateway_sub() + ".cloudflare-gateway.com/dns-query"),
    ("google-doh", "doh", "https://dns.google/resolve"),
]


def resolve_ips_multi(domain: str) -> dict:
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
    """探测阶段快速判定：只认 IP 段硬过滤（单源系统 DNS），不判断 Server 头；缓存解析结果。"""
    ips = resolve_ips(domain)
    DOMAIN_IP_CACHE[domain] = ips
    for ip in ips:
        if is_cloudflare_ip(ip):
            return True
    return False


def filter_non_cf_domains(saved: set, root_sub_count: defaultdict):
    if not saved:
        return
    domains = sorted(saved)
    print(f"[*] 落盘前 CF IP 校验（多源严格交集，并发）: 共 {len(domains)} 个域名")

    # ==================== 修改点 2 ====================
    def check(domain):
        # 探测阶段缓存的 IP 已含非 CF 则直接剔除（命中缓存，跳过校验）
        cached = DOMAIN_IP_CACHE.get(domain, [])
        if cached and not all(is_cloudflare_ip(ip) for ip in cached):
            return (domain, False, f"缓存IP含非CF: {','.join(cached)}")

        sources = resolve_ips_multi(domain)
        non_cf_sources = []
        successful_nodes = 0  # 记录成功解析的节点数量

        for name, ips in sources.items():
            if not ips:
                # 忽略解析失败（超时/丢包）的节点，不作为否决条件
                continue
            
            successful_nodes += 1
            
            # 只要解析成功的节点，其返回的 IP 必须有命中 CF 段的
            if not any(is_cloudflare_ip(ip) for ip in ips):
                non_cf_sources.append(f"{name}={','.join(ips)}")

        # 如果所有节点都解析失败，说明域名失效或网络严重阻断
        if successful_nodes == 0:
            return (domain, False, "所有 DNS 节点均解析失败")

        # 如果有任何一个成功的节点解析出了非 CF 的 IP，则剔除
        if non_cf_sources:
            return (domain, False, "; ".join(non_cf_sources))

        # 正常通过校验：至少有一个节点解析成功，且成功节点都命中了 CF 段
        union = []
        seen = set()
        for ips in sources.values():
            for ip in ips:
                if ip not in seen:
                    seen.add(ip)
                    union.append(ip)
        return (domain, True, ",".join(union))

    removed = []
    with ThreadPoolExecutor(max_workers=WORKERS_VERIFY) as pool:
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


def _trim_by_root_quota(saved: set, root_sub_count: defaultdict, quota: int) -> int:
    """将每主域名下的子域数量收紧到 quota（按字母序保留前 quota 个）。原地修改 saved 与 root_sub_count，返回新数量。"""
    groups = defaultdict(list)
    for d in saved:
        groups[get_registered_domain(d)].append(d)
    new_saved = set()
    for root, subs in groups.items():
        for d in sorted(subs)[:quota]:
            new_saved.add(d)
    saved.clear()
    saved.update(new_saved)
    root_sub_count.clear()
    for d in new_saved:
        root_sub_count[get_registered_domain(d)] += 1
    return len(new_saved)


def _trim_by_latency(saved: set, root_sub_count: defaultdict, cap: int) -> int:
    """当域名数超出 cap 且主域配额已收到 1 仍超限时，在 GitHub Actions 内部对每个域名做延迟测速，
    按延迟升序仅保留前 cap 个（不可达域名沉底）。原地修改 saved 与 root_sub_count，返回新数量。"""
    domains = sorted(saved)
    print(f"[*] 启动 Actions 内部延迟测速（GitHub 机房→CF 节点），共 {len(domains)} 个域名，仅保留最快前 {cap} 个...")

    def _one(d):
        try:
            t0 = time.time()
            HTTP_SESSION.head("https://" + d, timeout=LATENCY_TIMEOUT, allow_redirects=True)
            return d, time.time() - t0
        except Exception:
            return d, None

    lats = {}
    with ThreadPoolExecutor(max_workers=WORKERS_LATENCY) as pool:
        for d, lt in pool.map(_one, domains):
            lats[d] = lt if lt is not None else float("inf")
    ordered = sorted(domains, key=lambda d: (lats[d], d))
    keep = set(ordered[:cap])
    saved.clear()
    saved.update(keep)
    root_sub_count.clear()
    for d in keep:
        root_sub_count[get_registered_domain(d)] += 1
    print(f"[*] 延迟测速完成，保留 {len(keep)} 个（已按延迟排序），移除 {len(domains) - len(keep)} 个较慢/不可达域名")
    return len(keep)


def extract_all_domains_deep(raw_content: str, base_url: str) -> set:
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
    if saved:
        sample = random.sample(sorted(saved), min(SEED_SAMPLE_SIZE, len(saved)))
        print(f"[*] 从已有 {len(saved)} 个域名中随机抽 {len(sample)} 个作为本轮种子")
        return sample
    print(f"[*] 历史为空，使用自举种子: {BOOTSTRAP_SEEDS}")
    return list(BOOTSTRAP_SEEDS)


def run_cf_explorer():
    saved, root_sub_count = load_existing_domains(OUTPUT_FILE)
    load_blocklists()
    load_keyword_blacklist()
    if MALICIOUS_EXACT or KEYWORD_SUBSTR or KEYWORD_BOUNDED_RE:
        before = len(saved)
        dropped = [d for d in saved if is_malicious(d) or is_blackhat_keyword(d)]
        for d in dropped:
            saved.discard(d)
            root = get_registered_domain(d)
            if root_sub_count.get(root, 0) > 0:
                root_sub_count[root] -= 1
        if dropped:
            print(f"[*] 存量黑名单剔除：移除 {len(dropped)} 个黑产域名（{before} -> {len(saved)}）")
    print(f"[*] 已载入 {len(saved)} 个已有域名")

    start_time = time.time()

    def _flush_all():
        filter_non_cf_domains(saved, root_sub_count)
        # ==================== 数量控制：总量 ≤ TOTAL_CAP ====================
        if len(saved) > TOTAL_CAP:
            print(f"[*] 域名总数 {len(saved)} 超出上限 {TOTAL_CAP}，动态收紧主域名配额")
            for quota in (2, 1):
                n = _trim_by_root_quota(saved, root_sub_count, quota)
                print(f"    [配额] 每主域保留 {quota} 个 -> 剩余 {n} 个")
                if n <= TOTAL_CAP:
                    break
            # 配额已收到 1 仍超限（即不同主域 > 400），启动 Actions 内部延迟测速截断到前 400
            if len(saved) > TOTAL_CAP:
                _trim_by_latency(saved, root_sub_count, TOTAL_CAP)
        try:
            # 北京时间 = UTC+8
            bj = time.localtime(time.time() + 8 * 3600)
            bj_str = time.strftime("%Y-%m-%d %H:%M:%S", bj)
            utc_str = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
            with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                f.write("# CF 探测优选结果（每行一个纯域名，由 GitHub Actions 自动累积，脚本自动更新请勿手动编辑）\n")
                f.write(f"# 更新时间：北京时间 {bj_str} / 世界时间(UTC) {utc_str}\n")
                for d in sorted(saved):
                    # 落盘规范化：剥离可能的协议头/路径/端口，只保留纯域名
                    d = d.strip().lower()
                    if "://" in d:
                        d = d.split("://", 1)[1].split("/")[0].split(":")[0]
                    if d:
                        f.write(d + "\n")
            print(f"[*] 已全量写回 {len(saved)} 个域名 -> {OUTPUT_FILE}")
        except Exception as e:
            print(f"[!] 写回失败: {e}")

    seeds = pick_seeds(saved)

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

    visited = set()      # 已进入队列的域名（_expand 入队去重用）
    processed = set()    # 已出队处理过的域名（next_batch 去重用，与 visited 区分）
    non_cf_roots = set()
    new_added = 0
    state_lock = threading.Lock()  # 保护 saved/root_sub_count/non_cf_roots/new_added/visited/processed

    for s in seeds:
        with state_lock:
            visited.add(s)
        enqueue(s)

    print(f"[*] 结果保存路径: {os.path.abspath(OUTPUT_FILE)}\n" + "=" * 60)

    def next_batch(n: int):
        batch = []
        while len(batch) < n and (cf_q or normal_q):
            if cf_q:
                d = cf_q.popleft()
            else:
                d = normal_q.popleft()
            d = d.strip().lower()
            with state_lock:
                # 用 processed 判断"是否已处理"，不要用 visited，否则 _expand 入队时
                # 已 mark 的域名会被误判为已处理而永远跳过（这是之前"嗅探后无动作"的根因）
                if d in processed:
                    continue
                processed.add(d)
            batch.append(d)
        return batch

    def process_one(current):
        nonlocal new_added
        is_cf = is_cloudflare_domain(current)
        root = get_registered_domain(current)

        if is_big_tech(current):
            tag, prio = "巨型站 不入库但扩散外链", False
        elif is_malicious(current):
            tag, prio = "黑产域名 仅扩散外链", False
        elif is_blackhat_keyword(current):
            tag, prio = "黑产关键词 仅扩散外链", False
        elif is_cloudflare_own_domain(current):
            tag, prio = "CF官方域名 探索外链", True
        elif current in saved:
            tag, prio = "已在记录中 仅扩散外链", is_cf
        elif is_cf:
            with state_lock:
                if root_sub_count.get(root, 0) >= MAX_SUBDOMAINS_PER_ROOT:
                    log(f"[?] 检测: {current:<40} -> [主域 {root} 已达上限 {MAX_SUBDOMAINS_PER_ROOT} 跳过]")
                    return
                saved.add(current)
                root_sub_count[root] += 1
                new_added += 1
            tag, prio = "命中 Cloudflare 第三方", True
        else:
            tag, prio = "非 Cloudflare 仅扩散外链", False

        added = _expand(current, enqueue, visited, non_cf_roots, priority=prio, lock=state_lock)
        log(f"[?] 检测: {current:<40} -> [{tag}]" + (f" | 扩散 {added}" if added else ""))

    with ThreadPoolExecutor(max_workers=WORKERS_PROBE) as pool:
        while (cf_q or normal_q) and new_added < MAX_NEW_PER_RUN:
            if time.time() - start_time >= PROBE_TIME_LIMIT:
                log(f"\n[*] 已达探测时长上限 {PROBE_TIME_LIMIT}s，停止探测，进入收尾...")
                break

            batch = next_batch(BATCH_SIZE)
            if not batch:
                break

            # 检测+扩散并发执行，充分利用等待时间
            list(pool.map(process_one, batch))

    _flush_all()
    print("=" * 60)
    print(
        f"[!] 本轮结束：新增 {new_added} 个域名，文件总计 {len(saved)} 个"
        f"（已过滤 CF 官方/巨型站，主域≤{MAX_SUBDOMAINS_PER_ROOT}）"
    )


def _expand(current, enqueue, visited, non_cf_roots, priority: bool = False, lock=None):
    for schema in ("https://", "http://"):
        try:
            target_url = f"{schema}{current}"
            response = HTTP_SESSION.get(target_url, timeout=HTTP_TIMEOUT_EXPAND)
            if response.text and len(response.text) > 100:
                new_domains = extract_all_domains_deep(response.text, target_url)
                added = 0
                for nd in new_domains:
                    if added >= MAX_NEW_PER_PAGE:
                        break
                    nd_root = get_registered_domain(nd)
                    check = False
                    if lock:
                        with lock:
                            if nd not in visited:
                                visited.add(nd)
                                check = True
                    else:
                        if nd not in visited:
                            visited.add(nd)
                            check = True
                    if check:
                        enqueue(nd, priority=priority)
                        added += 1
                return added
        except Exception:
            continue
    return 0


if __name__ == "__main__":
    try:
        run_cf_explorer()
    except KeyboardInterrupt:
        print("\n[!] 手动停止，数据已安全保存。")
