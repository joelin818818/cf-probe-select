// Worker 侧域名解析与 Cloudflare IP 判定模块
import { resolveDohList } from "./dns-providers.js";

// ---- Cloudflare IP 段（缓存）----
let CF_RANGES = null;
let CF_LOAD_TS = 0;
const CF_TTL = 6 * 60 * 60 * 1000;

async function getCfRanges() {
  const now = Date.now();
  if (CF_RANGES && now - CF_LOAD_TS < CF_TTL) return CF_RANGES;
  let ranges = [];
  try {
    const r = await fetch("https://www.cloudflare.com/ips-v4", { cf: { cacheTtl: 3600 } });
    if (r.ok) {
      const t = await r.text();
      ranges = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      CF_RANGES = ranges;
      CF_LOAD_TS = now;
    }
  } catch (e) {
    ranges = CF_RANGES || [];
  }
  return ranges;
}

// 判断某 IPv4 是否落在 CF 网段（支持 a.b.c.d/n）
function ipToLong(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function isIpInCf(ip, ranges) {
  if (!ranges || !ranges.length) return true; // 段未加载时放行，避免误杀
  const long = ipToLong(ip);
  for (const cidr of ranges) {
    const [net, bits] = cidr.split("/");
    const mask = bits ? (0xffffffff << (32 - Number(bits))) >>> 0 : 0xffffffff;
    if ((ipToLong(net) & mask) === (long & mask)) return true;
  }
  return false;
}

function extractIp(ans) {
  const out = [];
  for (const a of ans || []) {
    if (a.type === 1 && typeof a.data === "string") out.push(a.data);
    else if (a.type === 28 && typeof a.data === "string") out.push(a.data); // AAAA
  }
  return out;
}

function getAFromAnswer(ans, wantV6) {
  for (const a of ans || []) {
    if (a.type === 1 && !wantV6) return a.data;
    if (a.type === 28 && wantV6) return a.data;
  }
  return null;
}

async function dohFetch(doh, domain, wantV6) {
  const url = doh + "?name=" + encodeURIComponent(domain) + "&type=" + (wantV6 ? 28 : 1);
  const r = await fetch(url, {
    headers: { accept: "application/dns-json" },
    cf: { cacheTtl: 60 },
  });
  if (!r.ok) throw new Error("DoH " + r.status);
  const j = await r.json();
  const ip = getAFromAnswer(j.Answer, wantV6);
  return ip ? [ip] : [];
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

export { getCfRanges, isIpInCf, dohResolve, resolveIps, testDoh };
