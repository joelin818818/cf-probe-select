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

// 注：归属地（国家）功能已取消，仅保留 IP 解析与 CF 段判定。

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
        // 加时间戳绕过 raw.githubusercontent.com CDN 缓存，确保实时
        const nocacheUrl = RAW_DOMAINS_URL + "?t=" + Date.now();
        const res = await fetch(nocacheUrl, { cf: { cacheTtl: 0 } });
        if (!res.ok) {
          return json({ error: "无法读取域名列表", status: res.status }, 502);
        }
        const text = await res.text();
        const domains = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.split("#")[0].trim().toLowerCase());
        return json(
          { count: domains.length, domains },
          200,
          { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }
        );
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
    // 1) Worker 侧 5 分钟缓存命中则直接返回
    const lower = domain.toLowerCase();
    const now = Date.now();
    const cached = RESOLVE_CACHE[lower];
    if (cached && now - cached.ts < RESOLVE_CACHE_TTL) {
      return cached.ips;
    }

    let answers = await dohResolve(domain);
    answers = answers.slice(0, 3);

    // 懒加载 CF 官方 IP 段，用于判定解析出的 IP 是否属于 Cloudflare
    const cfRanges = await getCfRanges();

    const out = [];
    for (const ans of answers) {
      const ip = ans.data;
      out.push({
        ip,
        isCf: cfRanges ? isIpInRanges(ip, cfRanges) : null, // null = 未能判定
      });
    }
    RESOLVE_CACHE[lower] = { ips: out, ts: now };
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

// Worker 侧解析缓存：同一域名 5 分钟内重复解析直接返回，减少 DoH 请求
let RESOLVE_CACHE = {};
const RESOLVE_CACHE_TTL = 5 * 60 * 1000;

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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
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
  .ip-lat { font-size: 11px; color: var(--good); margin-left: 2px; font-variant-numeric: tabular-nums; }
  .rounds { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .rounds b { color: var(--good); font-weight: 700; }
  .rounds .t { color: var(--warn); font-weight: 700; }
  .rounds .e { color: var(--bad); font-weight: 700; }
  .td-lat .lat { font-weight: 700; font-variant-numeric: tabular-nums; }
  .td-lat .lat.ok { color: var(--good); }
  .td-lat .lat.timeout { color: var(--warn); }
  .td-lat .lat.err { color: var(--bad); }
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
  <button id="refresh" class="ghost">刷新域名</button>
  <button id="copyAll" class="ghost">复制全部</button>
  <span class="status" id="info">点击「开始测速」对每个域名测 3 轮（间隔 2 秒）取平均延迟，按成功率排序</span>
</div>

<div class="wrap">
  <table>
    <thead>
      <tr>
        <th class="rank">#</th>
        <th data-sort="domain">域名</th>
        <th data-sort="ip">IP（前 3）</th>
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
const TIMEOUT = 8000;       // 单域名测速超时
const RENDER_EVERY = 10;    // 每完成 10 个域名刷新一次列表（动态更新 + 重排）
let domains = [];
let ipMap = {};             // domain -> [{ip, isCf}]
let stateMap = {};          // domain -> { phase, lat, status, rounds, okRounds, avg }
let testing = false;
let orderIndex = {};        // domain -> 原始序号，用于稳定排序兜底
let resolveCache = {};      // 前端解析缓存：domain -> {ips, ts}
const RESOLVE_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

const tbody = document.getElementById("tbody");
const info = document.getElementById("info");

async function resolveDomain(d) {
  const lower = d.toLowerCase();
  const now = Date.now();
  const cached = resolveCache[lower];
  if (cached && now - cached.ts < RESOLVE_CACHE_TTL) return cached.ips;
  try {
    const r = await fetch("/api/resolve?domain=" + encodeURIComponent(d));
    const data = await r.json();
    const ips = data.ips || [];
    resolveCache[lower] = { ips, ts: now };
    return ips;
  } catch (e) {
    resolveCache[lower] = { ips: [], ts: now };
    return [];
  }
}

async function loadDomains() {
  const r = await fetch("/api/domains", { cache: "no-store" });
  const data = await r.json();
  domains = data.domains || [];
  // 重置上一轮结果，确保刷新后是全新数据
  ipMap = {};
  stateMap = {};
  orderIndex = {};
  domains.forEach((d, i) => {
    ipMap[d] = undefined;      // 未解析
    stateMap[d] = { phase: "idle", lat: null, status: null };
    orderIndex[d] = i;
  });
  testing = false;
  document.getElementById("start").disabled = false;
  document.getElementById("src").textContent =
    "数据源：GitHub 自动探测累积（实时）· 共 " + domains.length + " 个域名";
  render();
}

function ipHtml(domain) {
  const list = ipMap[domain];
  if (!list) return '<span class="badge">—</span>';
  if (!list.length) return '<span class="badge">—</span>';
  return '<div class="ip-list">' + list.map(x => {
    const lat = (x.lat !== undefined && x.lat !== null)
      ? \`<span class="ip-lat">\${x.lat}ms</span>\` : "";
    return \`<div class="ip-item"><span>\${x.ip}</span>\${lat}</div>\`;
  }).join("") + '</div>';
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
  if (!list) return '<span class="cf-unknown">—</span>';
  if (!list.length) return '<span class="cf-unknown">—</span>';
  const allCf = list.every((x) => x.isCf === true);
  const anyNonCf = list.some((x) => x.isCf === false);
  if (allCf) return '<span class="cf-yes">✓ CF</span>';
  if (anyNonCf) return '<span class="cf-no cross">✗ 非CF</span>';
  return '<span class="cf-unknown">?</span>';
}

// 延迟列：展示 3 轮成绩（数字=ms，T=超时，E=失败）+ 平均成绩
function latHtml(st) {
  if (st.phase === "resolving") return '<span class="badge">解析中</span>';
  if (st.phase === "resolved") return '<span class="badge">待测</span>';
  if (st.phase === "measuring") return '<span class="badge">测速中</span>';
  if (!st.rounds) return '<span class="badge">—</span>';
  var cell = function(r) {
    if (typeof r === "number") return "<b>" + r + "</b>";
    if (r === "timeout") return '<span class="t">T</span>';
    return '<span class="e">E</span>';
  };
  var avgTxt = st.status === "ok" ? st.lat + "ms" : st.status === "timeout" ? ">8s" : "✕";
  var avgCls = st.status === "ok" ? "ok" : st.status === "timeout" ? "timeout" : "err";
  return '<div class="rounds">' + st.rounds.map(cell).join(" / ") + '</div>' +
         '<div class="lat ' + avgCls + '">均 ' + avgTxt + '</div>';
}

function render() {
  if (!domains.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无域名数据</td></tr>';
    return;
  }
  // 始终基于 domains，按当前 stateMap 实时排序（测速过程中自动重排）
  const sorted = [...domains].sort(sortFn);
  tbody.innerHTML = sorted
    .map(function(d, i) {
      var st = stateMap[d] || { phase: "idle", lat: null, status: null, rounds: null, okRounds: 0, avg: null };
      var badge = "";
      if (st.phase === "resolving") badge = '<span class="badge">解析中</span>';
      else if (st.phase === "resolved") badge = '<span class="badge">待测</span>';
      else if (st.phase === "measuring") badge = '<span class="badge">测速中</span>';
      else if (st.status === "ok") badge = '<span class="badge ok">可达</span>';
      else if (st.status === "timeout") badge = '<span class="badge">超时</span>';
      else if (st.status === "err") badge = '<span class="badge">失败</span>';
      else badge = '<span class="badge">待测</span>';
      var best = (i === 0 && st.status === "ok") ? "best" : "";
      var warn = isSuspicious(d) ? "warn-row" : "";
      var flag = isSuspicious(d) ? ' <span class="flag-warn">疑似伪CF</span>' : "";
      return '<tr class="row ' + best + ' ' + warn + '" data-d="' + d + '"><td class="rank">' + (i + 1) + '</td>' +
        '<td>' + d + flag + '</td>' +
        '<td>' + ipHtml(d) + '</td><td>' + cfHtml(d) + '</td><td class="td-lat">' + latHtml(st) + '</td><td>' + badge + '</td></tr>';
    })
    .join("");
}

let sortMode = "score"; // 默认按成功率排序
function sortFn(a, b) {
  const sa = stateMap[a] || {}, sb = stateMap[b] || {};
  if (sortMode === "domain") return a.localeCompare(b);
  if (sortMode === "status") return (sa.status || "").localeCompare(sb.status || "");
  if (sortMode === "ip") {
    const ca = (ipMap[a] && ipMap[a][0]) ? ipMap[a][0].ip : "zzz";
    const cb = (ipMap[b] && ipMap[b][0]) ? ipMap[b][0].ip : "zzz";
    return ca.localeCompare(cb);
  }
  if (sortMode === "cf") {
    // CF 优先：全 CF -> 0，疑似非 CF -> 1，未判定 -> 2
    const rank = (d) => (isSuspicious(d) ? 1 : (ipMap[d] && ipMap[d].length && ipMap[d].every(x => x.isCf === true)) ? 0 : 2);
    return rank(a) - rank(b);
  }
  if (sortMode === "lat") {
    const la = sa.status ? (sa.status === "ok" ? sa.lat : sa.status === "timeout" ? TIMEOUT : Infinity) : Infinity;
    const lb = sb.status ? (sb.status === "ok" ? sb.lat : sb.status === "timeout" ? TIMEOUT : Infinity) : Infinity;
    if (la !== lb) return la - lb;
    return orderIndex[a] - orderIndex[b];
  }
  // 默认 score：有结果优先（成功率降序 -> 平均延迟升序）；无结果/测速中按原始序号垫底
  const aHas = Array.isArray(sa.rounds), bHas = Array.isArray(sb.rounds);
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (!aHas) return orderIndex[a] - orderIndex[b];
  if (sb.okRounds !== sa.okRounds) return sb.okRounds - sa.okRounds;
  const va = sa.avg != null ? sa.avg : (sa.status === "timeout" ? TIMEOUT : Infinity);
  const vb = sb.avg != null ? sb.avg : (sb.status === "timeout" ? TIMEOUT : Infinity);
  if (va !== vb) return va - vb;
  return orderIndex[a] - orderIndex[b];
}

// 对目标（此处为域名）发起 HTTPS HEAD 请求并计时，返回延迟(ms) / "timeout" / "err"
async function measureOne(target) {
  const t0 = performance.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    await fetch("https://" + target, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return performance.now() - t0;
  } catch (e) {
    if (e.name === "AbortError") return "timeout";
    return "err";
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// 域名测速：用 https://域名 实测（证书合法，浏览器允许）
// 每域名测 3 轮，轮间间隔 ≥2 秒，记录每轮成绩与平均成绩
async function measure(domain) {
  stateMap[domain].phase = "measuring";
  const list = ipMap[domain] || [];
  if (!list || !list.length) {
    stateMap[domain] = { phase: "done", lat: null, status: "err", rounds: null, okRounds: 0, avg: null };
    return;
  }
  const ROUNDS = 3;
  const ROUND_GAP = 2000; // 轮间间隔 ≥2 秒，避免瞬时拥塞影响结果
  const rounds = [];
  let okRounds = 0, hadTimeout = false, hadErr = false, okSum = 0;
  for (let i = 0; i < ROUNDS; i++) {
    if (i > 0) await sleep(ROUND_GAP);
    const r = await measureOne(domain); // 改用域名实测，而非裸 IP（避免证书/Mixed Content 阻止）
    rounds.push(r);
    if (typeof r === "number") { okRounds++; okSum += r; }
    else if (r === "timeout") hadTimeout = true;
    else hadErr = true;
  }
  const avg = okRounds > 0 ? Math.round(okSum / okRounds) : null;
  let status, lat;
  if (okRounds > 0) { status = "ok"; lat = avg; }
  else if (hadTimeout) { status = "timeout"; lat = TIMEOUT; }
  else { status = "err"; lat = null; }
  stateMap[domain] = { phase: "done", lat: lat, status: status, rounds: rounds, okRounds: okRounds, avg: avg };
}

async function startTest() {
  if (testing || !domains.length) return;
  testing = true;
  sortMode = "lat"; // 测速过程始终按延迟实时重排
  document.getElementById("start").disabled = true;
  // 重置状态
  domains.forEach((d) => {
    stateMap[d] = { phase: "idle", lat: null, status: null, rounds: null, okRounds: 0, avg: null };
  });

  // 单域名任务：先解析 IP（带前端缓存），解析完立即测速（解析与测速重叠）
  async function resolveAndMeasure(d) {
    stateMap[d].phase = "resolving";
    ipMap[d] = await resolveDomain(d);
    stateMap[d].phase = "resolved";
    await measure(d); // 内部会把 phase 置为 measuring -> done
  }

  let done = 0;
  let lastRender = 0;
  info.textContent = "解析并测速中… 0 / " + domains.length;
  // 并发池限制 10：同时最多 10 个域名在测速，避免过多并发影响测速结果
  const tasks = domains.map((d) => async () => {
    await resolveAndMeasure(d);
    done++;
    info.textContent = "解析并测速中… " + done + " / " + domains.length;
    // 每完成 RENDER_EVERY 个就动态刷新列表（含实时重排），最后一批必刷
    if (done >= lastRender + RENDER_EVERY || done === domains.length) {
      render();
      lastRender = done;
    }
  });
  await runPool(tasks, 10);
  testing = false;
  document.getElementById("start").disabled = false;
  sortMode = "score";
  render();
  const fastest = [...domains]
    .map((d) => stateMap[d])
    .filter((s) => s && s.status === "ok")
    .sort((a, b) => a.lat - b.lat)[0];
  info.textContent = "完成 · 共 " + domains.length + " 个 · 最快 " +
    (fastest ? "见列表顶部" : "无");
}

// 并发池：同时最多 limit 个任务在执行
async function runPool(tasks, limit) {
  let idx = 0;
  const workers = [];
  for (let i = 0; i < limit; i++) {
    workers.push((async () => {
      while (idx < tasks.length) {
        const cur = idx++;
        await tasks[cur]();
      }
    })());
  }
  await Promise.all(workers);
}

function copyText(t) {
  navigator.clipboard?.writeText(t);
}

tbody.addEventListener("click", (e) => {
  const tr = e.target.closest("tr.row");
  if (tr) copyText(tr.dataset.d);
});

document.getElementById("start").addEventListener("click", async () => {
  // 测速前先重新拉取最新域名列表（实时）
  await loadDomains();
  startTest();
});
document.getElementById("refresh").addEventListener("click", () => {
  if (testing) return;
  loadDomains();
});
document.getElementById("copyAll").addEventListener("click", () => {
  const sorted = [...domains].sort((a, b) => sortFn(a, b));
  copyText(sorted.join("\\n"));
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
