/**
 * cf-probe-select 测速前端 Worker（原生 JS，无需构建）
 *
 * 路由：
 *   GET /                -> 返回 index.html 网页
 *   GET /api/domains     -> 代理读取 GitHub 仓库最新的 cf_domains.txt
 *   GET /api/health      -> 健康检查
 *
 * 测速逻辑放在浏览器端：网页对每个域名发起请求并计时，
 * 真实反映「用户 -> 各 CF 节点」的延迟，用户自行选择最快节点。
 */

// cf_domains.txt 在 GitHub 仓库的位置（main 分支）
const RAW_DOMAINS_URL =
  "https://raw.githubusercontent.com/joelin818818/cf-probe-select/main/cf_domains.txt";

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

      if (path === "/api/health") {
        return json({ ok: true, time: new Date().toISOString() });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};

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
  .wrap { padding: 12px 24px 40px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; }
  th:hover { color: var(--fg); }
  tr.row { cursor: pointer; }
  tr.row:hover { background: #1d2230; }
  .lat { font-variant-numeric: tabular-nums; font-weight: 600; }
  .ok { color: var(--good); }
  .timeout { color: var(--warn); }
  .err { color: var(--bad); }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  .rank { color: var(--muted); width: 40px; }
  .best { color: var(--accent); font-weight: 700; }
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
        <th data-sort="lat">延迟 (ms)</th>
        <th data-sort="status">状态</th>
      </tr>
    </thead>
    <tbody id="tbody">
      <tr><td colspan="4" class="empty">加载中…</td></tr>
    </tbody>
  </table>
</div>

<script>
const TIMEOUT = 8000; // 单域名测速超时
let domains = [];
let results = []; // {domain, lat, status}
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
}

function render() {
  if (!results.length && !testing) {
    if (!domains.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无域名数据</td></tr>';
      return;
    }
    tbody.innerHTML = domains
      .map((d, i) => \`<tr class="row" data-d="\${d}"><td class="rank">\${i + 1}</td>
        <td>\${d}</td><td class="lat">—</td><td><span class="badge">未测</span></td></tr>\`)
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
      return \`<tr class="row \${best}" data-d="\${r.domain}"><td class="rank">\${i + 1}</td>
        <td>\${r.domain}</td><td class="\${cls}">\${txt}</td><td>\${st}</td></tr>\`;
    })
    .join("");
}

let sortMode = "lat";
function sortFn(a, b) {
  if (sortMode === "domain") return a.domain.localeCompare(b.domain);
  if (sortMode === "status") return a.status.localeCompare(b.status);
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
