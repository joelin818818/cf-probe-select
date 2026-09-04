/**
 * cf-probe-select 测速前端 Worker（原生 ES Module，无需构建）
 *
 * 本文件合并了原 worker.js（路由入口）、resolve.js（解析与 Cloudflare 网段判定）、
 * dns-providers.js（DNS 服务商映射）。page.js 仅负责生成 HTML，DNS 列表从此处导出，
 * 全仓库只定义一处，避免多处维护不一致。
 *
 * 路由：
 *   GET /                        -> 返回 index.html 网页（page.js）
 *   GET /api/domains             -> 代理读取 GitHub 仓库最新的 cf_domains.txt（含更新时间）
 *   GET /api/resolve?domain=...  -> 仅 "local" 服务端解析域名 A 记录（服务端视角）
 *   GET /api/cf-check?ips=...    -> 判定 IP 是否落在 Cloudflare 网段（不解析 DNS）
 *   GET /api/health              -> 健康检查
 *
 * 测速逻辑放在浏览器端：网页对每个域名发起请求并计时，
 * 真实反映「用户 -> 各 CF 节点」的延迟，用户自行选择最快节点。
 */

import { html } from "./page.js";

// 部署版本号（格式 YYMMDDHHmm，如 2608252305），按北京时间（UTC+8）动态生成，
// 每次请求自动计算，无需手动维护。
function bjVersion() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return p2(d.getUTCFullYear() % 100) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
    p2(d.getUTCHours()) + p2(d.getUTCMinutes());
}

// ====================================================================
// DNS 服务商映射表（全仓库唯一来源，page.js 从此处导入）
// ====================================================================
// 架构约定（2026-08-25 用户确认）：
// - 除 "local" 外，所有 DoH 解析都【由浏览器客户端直接发起】（含自定义/内网自签）。
//   原因：Cloudflare Worker 的 fetch 只能访问公网且必须受信 CA 证书，无法连内网 / 自签
//   DoH；而浏览器可手动信任自签证书、可访问同局域网地址。
// - "local" 由 Worker 自己发起解析（服务端视角），代表「服务端 -> 域名」的解析结果。
// - 公开 DoH（aliyun/dnssb/google/adguard/quad9）的 doh 字段供浏览器侧直接使用。
// - "custom" = 用户填写的 DoH 地址，浏览器直连；支持公开 https DoH，也支持内网自签
//   https DoH（自签证书需先在浏览器手动信任该地址）。无需区分"公开/内网自签"两个选项，
//   二者代码路径完全一致，仅证书信任方式不同。

// 用数组固定下拉顺序（对象在含数字键 "360" 时枚举顺序会乱）
export const DNS_PROVIDER_LIST = [
  { key: "local", label: "本地（服务端 DNS）", doh: "", note: "服务端运行环境默认递归解析" },
  // 仅保留浏览器直连可用（服务端返回 CORS 头）的公开 DoH。
  // 验证结论（2026-08-26）：腾讯/360 等国内 DoH 不返回 Access-Control-Allow-Origin 头，
  // 浏览器直连必被 CORS 拦截，已移除；Cloudflare 1.1.1.1 / OpenDNS 在国内不可达，已移除。
  // 阿里经实测返回 CORS:*，可用。
  { key: "aliyun", label: "阿里 DoH（国内）", doh: "https://dns.alidns.com/resolve" },
  { key: "dnssb", label: "DNS.SB DoH（香港）", doh: "https://doh.dns.sb/dns-query" },
  // Gateway DoH 接受任意子域，故模板用随机 {sub} 子域（每次渲染页面时生成）。
  { key: "cf_gateway", label: "Cloudflare Gateway DoH（随机子域）", doh: "https://{sub}.cloudflare-gateway.com/dns-query", randomSubdomain: true },
  { key: "google", label: "Google DoH（国际）", doh: "https://dns.google/resolve" },
  { key: "custom", label: "自定义 DoH（浏览器直连）", doh: "", custom: true },
];

export const DNS_PROVIDERS = Object.fromEntries(
  DNS_PROVIDER_LIST.map((p) => [p.key, p])
);

export function normalizeProviderKey(key) {
  return DNS_PROVIDERS[key] ? key : "local";
}

// 生成 n 位「小写字母 + 数字」随机串，用作 Cloudflare Gateway DoH 的随机子域。
// 每次渲染页面 / 每次服务端解析各生成一次，整页共用以保证预检与解析结果一致。
export function randomGatewaySub(n = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 把 DoH 模板里的 {sub} 替换为随机子域（仅 randomSubdomain 的服务商需要）
export function materializeDoh(p) {
  if (!p || !p.doh) return "";
  return p.randomSubdomain ? p.doh.replace("{sub}", randomGatewaySub()) : p.doh;
}

// 仅用于 "local"（服务端解析）：返回服务端使用的 DoH 列表。
// 其他 provider 均由浏览器客户端直连，不再经过本函数（见 page.js 的浏览器解析分支）。
function resolveDohList(provider, customDoh) {
  if (provider === "local") {
    // 服务端 Worker 自行发起（边缘节点的递归解析器，代表服务端视角）
    return ["https://1.1.1.1/dns-query"];
  }
  const list = [];
  if (provider === "custom") {
    if (customDoh && /^https:\/\//i.test(customDoh.trim())) list.push(customDoh.trim());
  } else if (provider && DNS_PROVIDERS[provider] && DNS_PROVIDERS[provider].doh) {
    // Gateway 等带 {sub} 模板的服务商在此实例化为随机子域
    list.push(materializeDoh(DNS_PROVIDERS[provider]));
  }
  return list; // 非空表示浏览器直连模式（前端不调用此函数解析）
}

// ====================================================================
// Cloudflare IP 段（缓存 + 硬编码兜底）
// ====================================================================
const CF_RANGES_FALLBACK = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
let CF_RANGES = CF_RANGES_FALLBACK.slice();
let CF_LOAD_TS = 0;
const CF_TTL = 6 * 60 * 60 * 1000;

async function getCfRanges() {
  const now = Date.now();
  if (CF_RANGES && now - CF_LOAD_TS < CF_TTL) return CF_RANGES;
  try {
    const r = await fetch("https://www.cloudflare.com/ips-v4", { cf: { cacheTtl: 3600 } });
    if (r.ok) {
      const t = await r.text();
      const ranges = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (ranges.length) {
        CF_RANGES = ranges;
        CF_LOAD_TS = now;
      }
    }
  } catch (e) {
    // 拉取失败时继续使用内存中的段（初始为硬编码兜底），避免误判
  }
  return CF_RANGES;
}

// 判断某 IPv4 是否落在 CF 网段（支持 a.b.c.d/n）
function ipToLong(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function isIpInCf(ip, ranges) {
  if (!ranges || !ranges.length) return false; // 段未加载时保守判为非 CF（当前有硬编码兜底，不会空）
  const long = ipToLong(ip);
  for (const cidr of ranges) {
    const [net, bits] = cidr.split("/");
    const mask = bits ? (0xffffffff << (32 - Number(bits))) >>> 0 : 0xffffffff;
    if ((ipToLong(net) & mask) === (long & mask)) return true;
  }
  return false;
}

function getAFromAnswer(ans, wantV6) {
  const type = wantV6 ? 28 : 1;
  const out = [];
  for (const a of ans || []) {
    if (a.type === type && typeof a.data === "string") out.push(a.data);
  }
  return out;
}

async function dohFetch(doh, domain, wantV6) {
  const url = doh + "?name=" + encodeURIComponent(domain) + "&type=" + (wantV6 ? 28 : 1);
  const r = await fetch(url, {
    headers: { accept: "application/dns-json" },
    cf: { cacheTtl: 60 },
  });
  if (!r.ok) throw new Error("DoH " + r.status);
  const j = await r.json();
  return getAFromAnswer(j.Answer, wantV6);
}

// 解析域名 A 记录（支持多 DoH 兜底），返回 { ips, doh, cf }
async function dohResolve(domain, provider, customDoh) {
  const list = resolveDohList(provider, customDoh);
  let lastErr = null;
  for (const doh of list) {
    for (const v6 of [false, true]) {
      try {
        const ips = await dohFetch(doh, domain, v6);
        if (ips && ips.length) {
          const ranges = await getCfRanges();
          const cf = ips.every((ip) => isIpInCf(ip, ranges));
          return { ips, doh, cf };
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }
  return { ips: [], doh: list[0] || "", cf: false, error: String(lastErr || "no answer") };
}

// 解析出前 3 个 IP + CF 判定（供前端 IP 列展示）
async function resolveIps(domain, provider, customDoh) {
  const r = await dohResolve(domain, provider, customDoh);
  return { ips: r.ips.slice(0, 3), doh: r.doh, cf: r.cf, error: r.error || null };
}

// 测试某 DoH 是否可用（自定义地址确认前调用）
async function testDoh(doh) {
  if (!/^https:\/\//i.test(doh)) return { ok: false, msg: "仅支持 https:// 开头的 DoH 地址" };
  try {
    const r = await dohResolve("cloudflare.com", "custom", doh);
    if (r.ips && r.ips.length) return { ok: true, ips: r.ips };
    return { ok: false, msg: "解析无结果" };
  } catch (e) {
    return { ok: false, msg: String(e.message || e) };
  }
}

// ====================================================================
// cf_domains.txt 在 GitHub 仓库的位置（main 分支）。
// 部署时优先用 wrangler.toml 的 [vars] RAW_DOMAINS_URL（由 probe.yml 自动写入当前仓库地址）；
// 未配置则回退以下默认值。
// ====================================================================
const DEFAULT_RAW_DOMAINS_URL = "https://raw.githubusercontent.com/joelin818818/cf-probe-select/main/cf_domains.txt";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

// 域名列表缓存 TTL（毫秒）。
const DOMAINS_CACHE_TTL = 120 * 1000;

// 读取域名列表（带 120 秒缓存，用 Cache API 实现跨请求命中；不可用时降级为每次回源）。
async function fetchDomainsCached(rawUrl) {
  const cacheKey = "https://domains.cache.local/" + encodeURIComponent(rawUrl);
  let cache = null;
  try {
    cache = await caches.open("cf-probe-domains");
    const hit = await cache.match(cacheKey);
    if (hit) {
      const data = await hit.json();
      if (data && Date.now() - (data.__cachedAt || 0) < DOMAINS_CACHE_TTL) {
        return { data, cached: true };
      }
    }
  } catch (e) {
    cache = null; // Cache API 不可用则降级为不缓存
  }

  // 回源：加时间戳绕过 raw.githubusercontent.com 的 CDN 缓存
  const nocacheUrl = rawUrl + "?t=" + Date.now();
  let res;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    res = await fetch(nocacheUrl, { cf: { cacheTtl: 0 }, signal: ctrl.signal });
    clearTimeout(t);
  } catch (e) {
    const err = new Error("读取域名列表超时，请重试");
    err.status = 504;
    throw err;
  }
  if (!res.ok) {
    const err = new Error("无法读取域名列表");
    err.status = 502;
    throw err;
  }

  const text = await res.text();
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // 解析头部更新时间（如：# 更新时间：北京时间 2026-08-25 12:14:05 / 世界时间(UTC) ...）
  let updatedAt = "";
  for (const l of lines) {
    if (l.startsWith("# 更新时间：")) {
      updatedAt = l.slice("# 更新时间：".length).trim();
      break;
    }
  }
  const domains = lines
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("#")[0].trim().toLowerCase());
  const data = { domains, updatedAt, __cachedAt: Date.now() };

  if (cache) {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json; charset=utf-8" },
        })
      );
    } catch (e) {
      // 写缓存失败不影响本次响应
    }
  }
  return { data, cached: false };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 版本号优先用 GitHub Actions 写入的 worker 文件提交时间（稳定），
    // 仅在未配置 env.WORKER_VERSION 时回落到部署时刻（兜底）。
    const version = (env && env.WORKER_VERSION) || bjVersion();

    if (path === "/" || path === "/index.html") {
      return new Response(html(version), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "cdn-cache-control": "no-store",
          "surrogate-control": "no-store",
          "pragma": "no-cache",
          "expires": "0",
        },
      });
    }

    if (path === "/api/health") {
      return json({ ok: true, version: version });
    }

    if (path === "/api/domains") {
      // 优先用 wrangler.toml 的 [vars] RAW_DOMAINS_URL（fork 后可自动改成自己的仓库），
      // 未配置时回退到默认值（上游仓库）。
      const RAW_DOMAINS_URL = (env && env.RAW_DOMAINS_URL) || DEFAULT_RAW_DOMAINS_URL;
      try {
        const { data, cached } = await fetchDomainsCached(RAW_DOMAINS_URL);
        return json(
          { count: data.domains.length, domains: data.domains, updatedAt: data.updatedAt, cached },
          200,
          { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }
        );
      } catch (e) {
        return json({ error: String(e.message || e) }, e.status || 502);
      }
    }

    if (path === "/api/resolve") {
      const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();
      const provider = (url.searchParams.get("provider") || "local").trim();
      const customDoh = (url.searchParams.get("customDoh") || "").trim();
      if (!domain) return json({ error: "缺少 domain 参数" }, 400);
      try {
        // 仅 "local" 走服务端解析（服务端视角）；其余 DoH 由浏览器客户端直连
        const r = await resolveIps(domain, provider, customDoh);
        return json(r, 200, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ ips: [], cf: false, error: String(e.message || e) }, 502);
      }
    }

    if (path === "/api/cf-check") {
      // 浏览器直连 DoH 解析出 IP 后，将 IP 交服务端判定是否落在 Cloudflare 网段。
      // 服务端仅持有 CF 网段，不做任何 DNS 解析。
      const ipParam = (url.searchParams.get("ips") || "").trim();
      const ips = ipParam ? ipParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100) : [];
      try {
        const ranges = await getCfRanges();
        const cf = {};
        for (const ip of ips) cf[ip] = isIpInCf(ip, ranges);
        return json({ cf }, 200, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ error: String(e.message || e) }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
