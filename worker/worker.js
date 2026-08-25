/**
 * cf-probe-select 测速前端 Worker（原生 ES Module，无需构建）
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
import { resolveIps, getCfRanges, isIpInCf } from "./resolve.js";

// cf_domains.txt 在 GitHub 仓库的位置（main 分支）
// 直接走 GitHub 官方 raw 域名，避免第三方代理（dl.lbcn.top 等）失效导致读取不到列表
const RAW_DOMAINS_URL =
  "https://raw.githubusercontent.com/joelin818818/cf-probe-select/main/cf_domains.txt";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/health") {
      return json({ ok: true });
    }

    if (path === "/api/domains") {
      // 加时间戳绕过 raw.githubusercontent.com CDN 缓存，确保实时
      const nocacheUrl = RAW_DOMAINS_URL + "?t=" + Date.now();
      let res;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        res = await fetch(nocacheUrl, { cf: { cacheTtl: 0 }, signal: ctrl.signal });
        clearTimeout(t);
      } catch (e) {
        return json({ error: "读取域名列表超时，请重试", detail: String(e.message || e) }, 504);
      }
      if (!res.ok) {
        return json({ error: "无法读取域名列表", status: res.status }, 502);
      }
      const text = await res.text();
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      // 解析头部更新时间（如：# 更新时间：北京时间 2026-08-25 12:14:05 / 世界时间(UTC) 2026-08-25 04:14:05）
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
      return json(
        { count: domains.length, domains, updatedAt },
        200,
        { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }
      );
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
