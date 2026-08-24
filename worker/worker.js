/**
 * cf-probe-select 测速前端 Worker（原生 JS，无需构建）
 *
 * 路由：
 *   GET /                        -> 返回 index.html 网页
 *   GET /api/domains             -> 代理读取 GitHub 仓库最新的 cf_domains.txt
 *   GET /api/resolve?domain=...  -> 解析域名 A 记录并返回前 3 个 IP 的归属地
 *   GET /api/health              -> 健康检查
 *
 * 测速逻辑放在浏览器端：网页对每个域名发起请求并计时，
 * 真实反映「用户 -> 各 CF 节点」的延迟，用户自行选择最快节点。
 */

// cf_domains.txt 在 GitHub 仓库的位置（main 分支）
const RAW_DOMAINS_URL =
  "https://raw.githubusercontent.com/joelin818818/cf-probe-select/main/cf_domains.txt";

// 国家英文名 -> 中文名（ipwho.is 返回英文，做常用映射）
const COUNTRY_MAP = {
  "United States": "美国",
  "Netherlands": "荷兰",
  "Germany": "德国",
  "United Kingdom": "英国",
  "Japan": "日本",
  "Singapore": "新加坡",
  "France": "法国",
  "Canada": "加拿大",
  "Australia": "澳大利亚",
  "Hong Kong": "香港",
  "South Korea": "韩国",
  "India": "印度",
  "Brazil": "巴西",
  "Sweden": "瑞典",
  "Finland": "芬兰",
  "Poland": "波兰",
  "Ireland": "爱尔兰",
  "Switzerland": "瑞士",
  "Belgium": "比利时",
  "Austria": "奥地利",
  "Norway": "挪威",
  "Denmark": "丹麦",
  "Spain": "西班牙",
  "Italy": "意大利",
  "Russia": "俄罗斯",
  "China": "中国",
  "Taiwan": "台湾",
  "Turkey": "土耳其",
  "United Arab Emirates": "阿联酋",
  "Israel": "以色列",
  "Mexico": "墨西哥",
  "South Africa": "南非",
  "Thailand": "泰国",
  "Vietnam": "越南",
  "Malaysia": "马来西亚",
  "Indonesia": "印尼",
  "Philippines": "菲律宾",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/" || path === "/index.html") {
        return new Response(html(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (path === "/api/domains") {
        const res = await fetch(RAW_DOMAINS_URL, { cf: { cacheTtl: 60 } });
        if (!res.ok) {
          return json({ error: "无法读取域名列表", status: res.status }, 502);
        }
        const text = await res.text();
        const domains = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.split("#")[0].trim().toLowerCase());
        return json({ count: domains.length, domains });
      }

      if (path === "/api/resolve") {
        const domain = url.searchParams.get("domain");
        if (!domain) {
          return json({ error: "缺少 domain 参数" }, 400);
        }
        const ips = await resolveIps(domain);
        return json({ domain, ips });
      }

      if (path === "/api/cf-ranges") {
        const ranges = await getCfRanges();
        return json({ count: ranges.length });
      }

      if (path === "/api/health") {
        return json({ ok: true, time: new Date().toISOString() });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};

async function resolveIps(domain) {
  try {
    let answers = await dohResolve(domain);
    answers = answers.slice(0, 3);

    // 懒加载 CF 官方 IP 段，用于判定解析出的 IP 是否属于 Cloudflare
    const cfRanges = await getCfRanges();

    const out = [];
    for (const ans of answers) {
      const ip = ans.data;
      const loc = await fetchIpLocation(ip);
      out.push({
        ip,
        country: loc.country,
        countryCode: loc.countryCode,
        isCf: cfRanges ? isIpInRanges(ip, cfRanges) : null, // null = 未能判定
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// 国内可达的 DoH 解析（阿里 / 腾讯），优先阿里，失败回退腾讯
async function dohResolve(domain) {
  const providers = [
    "https://dns.alidns.com/dns-query",
    "https://doh.pub/dns-query",
  ];
  for (const baseUrl of providers) {
    try {
      const url =
        baseUrl + "?name=" + encodeURIComponent(domain) + "&type=A";
      const res = await fetch(url, {
        headers: { Accept: "application/dns-json" },
        cf: { cacheTtl: 300 },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const answers = (data.Answer || []).filter((a) => a.type === 1);
      if (answers.length) return answers;
    } catch (e) {
      continue;
    }
  }
  return [];
}

// ---------- Cloudflare IP 段判定 ----------

let CF_RANGES_CACHE = null;
let CF_RANGES_TS = 0;
const CF_RANGES_TTL = 24 * 3600 * 1000;

async function getCfRanges() {
  const now = Date.now();
  if (CF_RANGES_CACHE && now - CF_RANGES_TS < CF_RANGES_TTL) {
    return CF_RANGES_CACHE;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("https://www.cloudflare.com/ips-v4", {
      signal: ctrl.signal,
      cf: { cacheTtl: 86400 },
    });
    clearTimeout(t);
    if (!res.ok) return CF_RANGES_CACHE || null;
    const text = await res.text();
    const ranges = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l.includes("/"));
    CF_RANGES_CACHE = ranges;
    CF_RANGES_TS = now;
    return ranges;
  } catch (e) {
    return CF_RANGES_CACHE || null;
  }
}

function ipToNum(ip) {
  let n = 0;
  for (const p of ip.split(".")) {
    n = n * 256 + (parseInt(p, 10) || 0);
  }
  return n;
}

function isIpInRanges(ip, ranges) {
  const num = ipToNum(ip);
  for (const cidr of ranges) {
    const [base, bits] = cidr.split("/");
    const mask = bits ? parseInt(bits, 10) : 32;
    const baseNum = ipToNum(base);
    const shift = 32 - mask;
    if ((num >> shift) === (baseNum >> shift)) return true;
  }
  return false;
}

async function fetchIpLocation(ip) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`https://ipwho.is/${ip}`, {
      signal: ctrl.signal,
      cf: { cacheTtl: 86400 },
    });
    clearTimeout(t);
    if (!res.ok) return { country: "-", countryCode: "-" };
    const data = await res.json();
    if (!data.success) return { country: "-", countryCode: "-" };
    const en = data.country || "-";
    return {
      country: COUNTRY_MAP[en] || en,
      countryCode: data.country_code || "-",
    };
  } catch (e) {
    return { country: "-", countryCode: "-" };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CF 探测优选 · 实时测速</title>
<style>
  :root {
    --bg: #0f1117;
    --card: #171a21;
    --line: #262b36;
    --fg: #e8eaed;
    --muted: #9aa3b2;
    --accent: #f6821f; /* Cloudflare orange */
    --good: #2ecc71;
    --bad: #e74c3c;
    --warn: #f1c40f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  header {
    padding: 20px 24px; border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  header h1 { font-size: 18px; margin: 0; }
  header .tag {
    font-size: 12px; color: var(--accent); border: 1px solid var(--accent);
    padding: 2px 8px; border-radius: 999px;
  }
  .bar {
    padding: 12px 24px; display: flex; gap: 10px; align-items: center;
    flex-wrap: wrap; border-bottom: 1px solid var(--line); background: var(--card);
  }
  button {
    background: var(--accent); color: #fff; border: none; padding: 8px 14px;
    border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;
  }
  button.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .status { color: var(--muted); font-size: 13px; }
  .wrap { padding: 12px 24px 40px; overflow-x: auto; }
  table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; }
  th:hover { color: var(--fg); }
  tr.row { cursor: pointer; }
  tr.row:hover { background: #1d2230; }
  .lat { font-variant-numeric: tabular-nums; font-weight: 600; }
  .ok { color: var(--good); }
  .timeout { color: var(--warn); }
  .err { color: var(--bad); }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .ip-list { display: flex; flex-direction: column; gap: 4px; }
  .ip-item { display: inline-flex; align-items: center; gap: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
  .cc { font-size: 10px; color: var(--accent); border: 1px solid var(--accent); padding: 0 5px; border-radius: 4px; white-space: nowrap; }
  .cf-yes { color: var(--good); font-weight: 700; }
  .cf-no { color: var(--bad); font-weight: 700; }
  .cf-unknown { color: var(--muted); }
  .cross { color: var(--bad); font-weight: 700; }
  .warn-row { border-left: 3px solid var(--bad); }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  .rank { color: var(--muted); width: 40px; }
  .best { color: var(--accent); font-weight: 700; }
  .flag-warn { font-size: 10px; color: var(--bad); border: 1px solid var(--bad); padding: 0 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>CF 探测优选 · 实时测速</h1>
  <span class="tag">Cloudflare</span>
  <span class="status" id="src">数据源：GitHub 自动探测累积</span>
</header>

<div class="bar">
  <button id="start">开始测速</button>
  <button id="sort" class="ghost">按延迟排序</button>
  <button id="copyAll" class="ghost">复制全部（按延迟）</button>
  <span class="status" id="info">点击「开始测速」对所有域名进行浏览器侧实时测速</span>
</div>

<div class="wrap">
  <table>
    <thead>
      <tr>
        <th class="rank">#</th>
        <th data-sort="domain">域名</th>
        <th data-sort="ip">IP 归属地（前 3）</th>
        <th data-sort="cf">CF IP</th>
        <th data-sort="lat">延迟 (ms)</th>
        <th data-sort="status">状态</th>
      </tr>
    </thead>
    <tbody id="tbody">
      <tr><td colspan="6" class="empty">加载中…</td></tr>
    </tbody>
  </table>
</div>

<script>
const TIMEOUT = 8000; // 单域名测速超时
let domains = [];
let results = []; // {domain, lat, status}
let ipMap = {};   // domain -> [{ip, country, countryCode}]
let testing = false;

const tbody = document.getElementById("tbody");
const info = document.getElementById("info");

async function loadDomains() {
  const r = await fetch("/api/domains");
  const data = await r.json();
  domains = data.domains || [];
  document.getElementById("src").textContent =
    "数据源：GitHub 自动探测累积 · 共 " + domains.length + " 个域名";
  render();
  resolveAllIps();
}

async function resolveAllIps() {
  const CONC = 5;
  for (let i = 0; i < domains.length; i += CONC) {
    const batch = domains.slice(i, i + CONC);
    await Promise.all(batch.map(async (d) => {
      try {
        const r = await fetch("/api/resolve?domain=" + encodeURIComponent(d));
        const data = await r.json();
        ipMap[d] = data.ips || [];
      } catch (e) {
        ipMap[d] = [];
      }
      render();
    }));
  }
}

function ipHtml(domain) {
  const list = ipMap[domain];
  if (!list) return '<span class="badge">解析中</span>';
  if (!list.length) return '<span class="badge">—</span>';
  return '<div class="ip-list">' + list.map(x =>
    \`<div class="ip-item"><span>\${x.ip}</span><span class="cc">\${x.country}</span></div>\`
  ).join("") + '</div>';
}

// 该域名是否任一 IP 不在 CF 段（isCf === false 即判定为非 CF，疑似伪 CF）
function isSuspicious(domain) {
  const list = ipMap[domain];
  if (!list || !list.length) return false;
  return list.some((x) => x.isCf === false);
}

// CF 判定单元格：全部 CF -> ✓；任一非 CF -> ✗（交叉）；未判定 -> -
function cfHtml(domain) {
  const list = ipMap[domain];
  if (!list) return '<span class="cf-unknown">解析中</span>';
  if (!list.length) return '<span class="cf-unknown">—</span>';
  const allCf = list.every((x) => x.isCf === true);
  const anyNonCf = list.some((x) => x.isCf === false);
  if (allCf) return '<span class="cf-yes">✓ CF</span>';
  if (anyNonCf) return '<span class="cf-no cross">✗ 非CF</span>';
  return '<span class="cf-unknown">?</span>';
}

function render() {
  if (!results.length && !testing) {
    if (!domains.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无域名数据</td></tr>';
      return;
    }
    tbody.innerHTML = domains
      .map((d, i) => \`<tr class="row \${isSuspicious(d) ? "warn-row" : ""}" data-d="\${d}"><td class="rank">\${i + 1}</td>
        <td>\${d}\${isSuspicious(d) ? ' <span class="flag-warn">疑似伪CF</span>' : ""}</td>
        <td>\${ipHtml(d)}</td><td>\${cfHtml(d)}</td><td class="lat">—</td><td><span class="badge">未测</span></td></tr>\`)
      .join("");
    return;
  }
  const sorted = [...results].sort((a, b) => sortFn(a, b));
  tbody.innerHTML = sorted
    .map((r, i) => {
      let cls = "lat", txt = "—", st = "";
      if (r.status === "ok") { cls += " ok"; txt = r.lat + ""; st = '<span class="badge ok">可达</span>'; }
      else if (r.status === "timeout") { cls += " timeout"; txt = "> " + TIMEOUT; st = '<span class="badge">超时</span>'; }
      else { cls += " err"; txt = "✕"; st = '<span class="badge">失败</span>'; }
      const best = i === 0 && r.status === "ok" ? "best" : "";
      const warn = isSuspicious(r.domain) ? "warn-row" : "";
      return \`<tr class="row \${best} \${warn}" data-d="\${r.domain}"><td class="rank">\${i + 1}</td>
        <td>\${r.domain}\${isSuspicious(r.domain) ? ' <span class="flag-warn">疑似伪CF</span>' : ""}</td>
        <td>\${ipHtml(r.domain)}</td><td>\${cfHtml(r.domain)}</td><td class="\${cls}">\${txt}</td><td>\${st}</td></tr>\`;
    })
    .join("");
}

let sortMode = "lat";
function sortFn(a, b) {
  if (sortMode === "domain") return a.domain.localeCompare(b.domain);
  if (sortMode === "status") return a.status.localeCompare(b.status);
  if (sortMode === "ip") {
    const ca = ipMap[a.domain]?.[0]?.country || "zzz";
    const cb = ipMap[b.domain]?.[0]?.country || "zzz";
    return ca.localeCompare(cb);
  }
  if (sortMode === "cf") {
    // CF 优先：全 CF -> 0，疑似非 CF -> 1，未判定 -> 2
    const rank = (d) => (isSuspicious(d) ? 1 : (ipMap[d]?.every(x => x.isCf === true) ? 0 : 2));
    return rank(a.domain) - rank(b.domain);
  }
  // 延迟升序：ok 优先，其次 timeout，最后 err；同状态按数值
  const rank = (s) => (s === "ok" ? 0 : s === "timeout" ? 1 : 2);
  if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
  if (a.status === "ok" && b.status === "ok") return a.lat - b.lat;
  return 0;
}

async function measure(domain) {
  const t0 = performance.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    await fetch("https://" + domain, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { domain, lat: Math.round(performance.now() - t0), status: "ok" };
  } catch (e) {
    if (e.name === "AbortError") {
      return { domain, lat: TIMEOUT, status: "timeout" };
    }
    return { domain, lat: null, status: "err" };
  }
}

async function startTest() {
  if (testing || !domains.length) return;
  testing = true;
  document.getElementById("start").disabled = true;
  results = [];
  let done = 0;
  info.textContent = "测速中… 0 / " + domains.length;
  // 并发 8 个，逐批测速
  const CONC = 8;
  for (let i = 0; i < domains.length; i += CONC) {
    const batch = domains.slice(i, i + CONC);
    const batchRes = await Promise.all(batch.map(measure));
    results.push(...batchRes);
    done += batchRes.length;
    info.textContent = "测速中… " + done + " / " + domains.length;
    render();
  }
  testing = false;
  document.getElementById("start").disabled = false;
  info.textContent = "完成 · 共 " + results.length + " 个 · 最快 " +
    (results.find(r => r.status === "ok")?.domain || "无");
  sortMode = "lat";
  render();
}

function copyText(t) {
  navigator.clipboard?.writeText(t);
}

tbody.addEventListener("click", (e) => {
  const tr = e.target.closest("tr.row");
  if (tr) copyText(tr.dataset.d);
});

document.getElementById("start").addEventListener("click", startTest);
document.getElementById("sort").addEventListener("click", () => {
  sortMode = "lat"; render();
});
document.getElementById("copyAll").addEventListener("click", () => {
  const sorted = [...(results.length ? results : domains.map(d => ({domain:d})))]
    .sort((a,b)=>sortFn(a,b));
  copyText(sorted.map(r=>r.domain).join("\\n"));
  info.textContent = "已复制 " + sorted.length + " 个域名到剪贴板";
});
document.querySelectorAll("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    sortMode = th.dataset.sort; render();
  });
});

loadDomains();
</script>
</body>
</html>`;
}
