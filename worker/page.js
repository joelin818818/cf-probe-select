// 前端页面模块：返回完整的 HTML 页面字符串（含内联前端脚本）
import { DNS_PROVIDERS, DNS_PROVIDER_LIST } from "./dns-providers.js";

// 生成 DNS 服务商下拉选项（按数组顺序）
function providerOptions() {
  return DNS_PROVIDER_LIST
    .map((p) => '<option value="' + p.key + '">' + p.label + "</option>")
    .join("");
}

// 前端浏览器脚本（内联，浏览器环境无模块系统）
const FRONTEND_JS = `
const TIMEOUT = 4000;       // 单域名测速超时
const RENDER_EVERY = 5;     // 每完成 5 个刷新一次列表
let domains = [];
let ipMap = {};             // domain -> [{ip, isCf}]
let stateMap = {};          // domain -> {phase,lat,status,rounds,okRounds,avg}
let orderIndex = {};
let sortMode = "score";
let testing = false;
let stopRequested = false;  // 停止测速标志
let resolvedCount = 0;      // 解析完成计数
let measuredCount = 0;      // 测速完成计数

const $ = (id) => document.getElementById(id);
const rankMap = { lat: "延迟", ip: "IP", cf: "CF", domain: "域名", status: "状态", score: "综合" };

const PROVIDER_KEYS = ["local","aliyun","tencent","qihoo360","google","cloudflare","opendns","custom"];
function normalizeProviderKey(k) {
  if (k === "360") return "qihoo360";
  return PROVIDER_KEYS.indexOf(k) >= 0 ? k : "local";
}
function loadProvider() {
  return normalizeProviderKey(localStorage.getItem("cf_provider"));
}
function loadCustomDoh() {
  return localStorage.getItem("cf_custom_doh") || "";
}
function saveProvider(p) { localStorage.setItem("cf_provider", p); }
function saveCustomDoh(u) { localStorage.setItem("cf_custom_doh", u); }
function loadResolveThreads() {
  return Math.max(1, parseInt(localStorage.getItem("cf_rthreads") || "16", 10) || 16);
}
function loadMeasureThreads() {
  return Math.max(1, parseInt(localStorage.getItem("cf_mthreads") || "10", 10) || 10);
}
function saveResolveThreads(n) { localStorage.setItem("cf_rthreads", String(n)); }
function saveMeasureThreads(n) { localStorage.setItem("cf_mthreads", String(n)); }

function setInfo(msg) { $("info").textContent = msg; }

async function loadDomains(attempt = 1) {
  try {
    const r = await fetch("/api/domains", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    domains = data.domains || [];
    ipMap = {}; stateMap = {}; orderIndex = {};
    domains.forEach((d, i) => {
      ipMap[d] = undefined;
      stateMap[d] = { phase: "idle", lat: null, status: null };
      orderIndex[d] = i;
    });
    testing = false;
    if (!testing) $("start").disabled = false;
    const src = "数据源：GitHub 自动探测累积（实时）· 共 " + domains.length + " 个域名" +
      (data.updatedAt ? " · 更新：" + data.updatedAt : "");
    $("src").textContent = src;
    render();
  } catch (e) {
    console.error("loadDomains failed:", e);
    if (attempt <= 2) {
      setInfo("域名列表加载失败，2秒后重试… (" + e.message + ")");
      setTimeout(() => loadDomains(attempt + 1), 2000);
    } else {
      $("src").textContent = "数据源：GitHub 自动探测累积（加载失败，请刷新重试）";
      $("tbody").innerHTML = '<tr><td colspan="6" class="empty">加载失败：' + e.message + "</td></tr>";
      $("start").disabled = false;
    }
  }
}

// 解析单个域名（带缓存），更新解析进度
async function resolveOne(d) {
  const provider = loadProvider();
  const customDoh = loadCustomDoh();
  const res = await fetch("/api/resolve?domain=" + encodeURIComponent(d) +
    "&provider=" + encodeURIComponent(provider) +
    (customDoh ? "&customDoh=" + encodeURIComponent(customDoh) : ""), { cache: "no-store" });
  const data = await res.json();
  const list = (data.ips || []).slice(0, 3).map((ip) => ({ ip, isCf: !!data.cf }));
  ipMap[d] = list.length ? list : [];
  return list;
}

// 测速单个域名（域名 HTTPS 实测 3 轮）
async function measureOne(d) {
  const rounds = [];
  let ok = 0;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    const t0 = performance.now();
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT);
      const r = await fetch("https://" + d, { method: "HEAD", mode: "no-cors", signal: ctrl.signal });
      clearTimeout(to);
      const ms = Math.round(performance.now() - t0);
      rounds.push(ms); ok++;
    } catch (e) {
      rounds.push(e.name === "AbortError" ? "T" : "E");
    }
  }
  const nums = rounds.filter((x) => typeof x === "number");
  const avg = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  return { rounds, okRounds: ok, avg };
}

// 并发池（支持停止：stopRequested 为 true 时中止剩余任务）
async function runPool(tasks, size) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      if (stopRequested) return;
      const idx = i++;
      await tasks[idx]();
    }
  }
  const ws = [];
  for (let k = 0; k < size; k++) ws.push(worker());
  await Promise.all(ws);
}

async function startTest() {
  if (testing) return;
  // 自定义 DoH 未通过测试则拦截
  const provider = loadProvider();
  if (provider === "custom") {
    const customDoh = loadCustomDoh();
    if (!customDoh) { alert("请先填写并测试自定义 DoH 地址"); return; }
    if (localStorage.getItem("cf_custom_ok") !== "1") {
      alert("自定义 DoH 尚未测试通过，请先点击「测试」确认可用");
      return;
    }
  }
  if (!domains.length) await loadDomains();
  testing = true;
  stopRequested = false;
  $("start").disabled = true;
  $("stop").style.display = "";
  resolvedCount = 0; measuredCount = 0;
  for (const d of domains) {
    ipMap[d] = undefined;
    stateMap[d] = { phase: "resolving", lat: null, status: "resolving", rounds: null, okRounds: 0, avg: null };
  }
  render();

  const rThreads = loadResolveThreads();
  const mThreads = loadMeasureThreads();

  // 阶段一：全部解析完成
  setInfo("解析中…");
  const resolveTasks = domains.map((d) => async () => {
    if (stopRequested) return;
    try { await resolveOne(d); } catch (e) { ipMap[d] = []; }
    resolvedCount++;
    stateMap[d].phase = "resolved";
    stateMap[d].status = "resolved";
    if (resolvedCount % RENDER_EVERY === 0 || resolvedCount === domains.length) {
      setInfo("解析 " + resolvedCount + "/" + domains.length + " · 测速 0/" + domains.length);
      render();
    }
  });
  await runPool(resolveTasks, rThreads);
  if (stopRequested) { finishTest("已停止（解析阶段）"); return; }

  // 阶段二：统一测速
  setInfo("测速中…");
  const measureTasks = domains.map((d) => async () => {
    if (stopRequested) return;
    stateMap[d].phase = "measuring";
    stateMap[d].status = "measuring";
    try {
      const r = await measureOne(d);
      stateMap[d].rounds = r.rounds;
      stateMap[d].okRounds = r.okRounds;
      stateMap[d].avg = r.avg;
      stateMap[d].lat = r.avg;
      if (r.okRounds === 0) stateMap[d].status = "err";
      else if (r.avg === null) stateMap[d].status = "timeout";
      else stateMap[d].status = "ok";
    } catch (e) {
      stateMap[d].status = "err";
    }
    stateMap[d].phase = "done";
    measuredCount++;
    if (measuredCount % RENDER_EVERY === 0 || measuredCount === domains.length) {
      setInfo("解析 " + domains.length + "/" + domains.length + " · 测速 " + measuredCount + "/" + domains.length);
      render();
    }
  });
  await runPool(measureTasks, mThreads);

  finishTest("解析 " + domains.length + "/" + domains.length + " · 测速 " + domains.length + "/" + domains.length + " · 完成");
}

function finishTest(infoMsg) {
  testing = false;
  stopRequested = false;
  $("start").disabled = false;
  $("stop").style.display = "none";
  setInfo(infoMsg);
  render();
}

function stopTest() {
  if (!testing) return;
  stopRequested = true;
  setInfo("正在停止…");
}
}

function copyAll() {
  const lines = sortRows().map((d) => d + (stateMap[d].avg != null ? "  # " + stateMap[d].avg + "ms" : ""));
  navigator.clipboard.writeText(lines.join("\\n")).then(() => {
    const old = $("copyAll").textContent;
    $("copyAll").textContent = "已复制";
    setTimeout(() => ($("copyAll").textContent = old), 1200);
  });
}

function ipHtml(domain) {
  const list = ipMap[domain];
  if (!list || !list.length) return '<span class="badge">—</span>';
  return '<span class="ip-list">' + list.map((x) => {
    const cls = x.isCf ? "cf-yes" : "cf-no";
    return '<span class="ip-item"><span class="' + cls + '">' + x.ip + "</span></span>";
  }).join(" · ") + "</span>";
}
function latHtml(d) {
  const s = stateMap[d];
  if (!s || s.phase === "idle" || s.phase === "resolving" || s.phase === "resolved") {
    if (s && (s.phase === "resolving" || s.phase === "resolved")) return '<span class="status">解析完成，待测速</span>';
    return '<span class="badge">—</span>';
  }
  if (s.phase === "measuring") return '<span class="status">测速中…</span>';
  if (!s.rounds) return '<span class="badge">—</span>';
  const roundStr = s.rounds.map((x) => {
    if (x === "T") return '<span class="t">T</span>';
    if (x === "E") return '<span class="e">E</span>';
    return "<b>" + x + "</b>";
  }).join(" / ");
  const avgCls = s.status === "ok" ? "ok" : s.status === "timeout" ? "timeout" : "err";
  const avgStr = s.avg != null ? '<span class="lat ' + avgCls + '">均 ' + s.avg + "ms</span>" : "";
  return '<span class="rounds">' + roundStr + "</span>" + avgStr;
}
function statusHtml(d) {
  const s = stateMap[d];
  if (!s) return '<span class="badge">待处理</span>';
  const map = { resolving: "解析中", resolved: "待测速", measuring: "测速中", ok: "可达", timeout: "超时", err: "失败", idle: "待处理" };
  const cls = s.status === "ok" ? "ok" : s.status === "timeout" ? "timeout" : s.status === "err" ? "err" : "badge";
  return '<span class="' + cls + '">' + (map[s.status] || s.status || "待处理") + "</span>";
}
function cfHtml(d) {
  const list = ipMap[d];
  if (!list || !list.length) return '<span class="cf-unknown">?</span>';
  const all = list.every((x) => x.isCf);
  const any = list.some((x) => x.isCf);
  if (all) return '<span class="cf-yes">✓ CF</span>';
  if (any) return '<span class="cf-no">部分</span>';
  return '<span class="cf-no">✗ 非CF</span>';
}

function sortRows() {
  const arr = domains.slice();
  if (sortMode === "domain") arr.sort((a, b) => a.localeCompare(b));
  else if (sortMode === "ip") arr.sort((a, b) => (ipMap[a] || []).length - (ipMap[b] || []).length);
  else if (sortMode === "cf") arr.sort((a, b) => {
    const va = (ipMap[a] || []).every((x) => x.isCf) ? 1 : 0;
    const vb = (ipMap[b] || []).every((x) => x.isCf) ? 1 : 0;
    return vb - va;
  });
  else if (sortMode === "status") arr.sort((a, b) => (stateMap[a]?.status || "").localeCompare(stateMap[b]?.status || ""));
  else if (sortMode === "lat") {
    arr.sort((a, b) => {
      const sa = stateMap[a], sb = stateMap[b];
      const ha = sa && sa.rounds, hb = sb && sb.rounds;
      if (ha && hb) {
        const fa = sa.okRounds / 3, fb = sb.okRounds / 3;
        if (fb !== fa) return fb - fa;
        const la = sa.avg == null ? Infinity : sa.avg;
        const lb = sb.avg == null ? Infinity : sb.avg;
        return la - lb;
      }
      if (ha) return -1; if (hb) return 1;
      return (orderIndex[a] || 0) - (orderIndex[b] || 0);
    });
  } else { // score
    arr.sort((a, b) => {
      const sa = stateMap[a], sb = stateMap[b];
      const ha = sa && sa.rounds, hb = sb && sb.rounds;
      if (ha && hb) {
        const fa = sa.okRounds / 3, fb = sb.okRounds / 3;
        if (fb !== fa) return fb - fa;
        const la = sa.avg == null ? Infinity : sa.avg;
        const lb = sb.avg == null ? Infinity : sb.avg;
        return la - lb;
      }
      if (ha) return -1; if (hb) return 1;
      return (orderIndex[a] || 0) - (orderIndex[b] || 0);
    });
  }
  return arr;
}

function render() {
  const rows = sortRows();
  const best = rows.find((d) => stateMap[d] && stateMap[d].status === "ok" && stateMap[d].avg != null);
  const tbody = $("tbody");
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无数据</td></tr>'; return; }
  let html = "";
  rows.forEach((d, i) => {
    const cls = [];
    if ((ipMap[d] || []).length && !(ipMap[d] || []).every((x) => x.isCf)) cls.push("warn-row");
    const bestCls = d === best ? "best" : "";
    html += '<tr class="row ' + cls.join(" ") + '" data-d="' + d + '">';
    html += '<td class="rank">' + (bestCls ? "★" : i + 1) + "</td>";
    html += "<td>" + d + "</td>";
    html += "<td>" + ipHtml(d) + "</td>";
    html += "<td>" + cfHtml(d) + "</td>";
    html += "<td>" + latHtml(d) + "</td>";
    html += "<td>" + statusHtml(d) + "</td>";
    html += "</tr>";
  });
  tbody.innerHTML = html;
}

// ---- 控件初始化 ----
function initControls() {
  const p = loadProvider();
  $("provider").value = p;
  const cd = loadCustomDoh();
  $("customDoh").value = cd;
  $("resolveThreads").value = loadResolveThreads();
  $("measureThreads").value = loadMeasureThreads();
  updateCustomUI();
}
function updateCustomUI() {
  const p = $("provider").value;
  const isCustom = p === "custom";
  // 显示/隐藏自定义 DoH 输入区（必须用 inline-flex 覆盖 CSS #customDohWrap { display: none }）
  $("customDohWrap").style.display = isCustom ? "inline-flex" : "none";
  $("customDoh").disabled = !isCustom;
  if (!isCustom) {
    localStorage.removeItem("cf_custom_ok");
  }
  // 自定义未通过测试时，禁用开始测速按钮
  if (isCustom) {
    const url = $("customDoh").value.trim();
    const ok = url && localStorage.getItem("cf_custom_ok") === "1";
    $("start").disabled = !ok;
  } else {
    $("start").disabled = false;
  }
}
async function testCustomDoh() {
  const url = $("customDoh").value.trim();
  if (!/^https:\\/\\//i.test(url)) { alert("自定义 DoH 必须是 https:// 开头的地址，不支持裸 UDP 53"); return; }
  $("testDoh").disabled = true;
  $("testDoh").textContent = "测试中…";
  $("start").disabled = true;
  try {
    const r = await fetch("/api/test-doh?url=" + encodeURIComponent(url), { cache: "no-store" });
    const data = await r.json();
    if (data.ok) {
      localStorage.setItem("cf_custom_ok", "1");
      saveCustomDoh(url);
      $("testDoh").textContent = "测试通过 ✓";
      $("start").disabled = false;
    } else {
      localStorage.removeItem("cf_custom_ok");
      $("testDoh").textContent = "测试失败";
      $("start").disabled = true;
      alert("测试失败：" + (data.msg || "未知错误"));
    }
  } catch (e) {
    localStorage.removeItem("cf_custom_ok");
    $("testDoh").textContent = "测试失败";
    $("start").disabled = true;
    alert("测试异常：" + e.message);
  }
  setTimeout(() => { $("testDoh").textContent = "测试连接"; $("testDoh").disabled = false; }, 1500);
}

$("start").addEventListener("click", startTest);
$("stop").addEventListener("click", stopTest);
$("refresh").addEventListener("click", async () => { await loadDomains(); setInfo("已刷新域名列表"); });
$("copyAll").addEventListener("click", copyAll);
$("provider").addEventListener("change", (e) => { saveProvider(e.target.value); updateCustomUI(); });
$("customDoh").addEventListener("input", (e) => { saveCustomDoh(e.target.value); localStorage.removeItem("cf_custom_ok"); updateCustomUI(); });
$("resolveThreads").addEventListener("change", (e) => { saveResolveThreads(parseInt(e.target.value, 10) || 16); });
$("measureThreads").addEventListener("change", (e) => { saveMeasureThreads(parseInt(e.target.value, 10) || 10); });
$("testDoh").addEventListener("click", testCustomDoh);
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => { sortMode = th.getAttribute("data-sort"); render(); });
});

loadDomains();
initControls();
`;

export function html() {
  const options = providerOptions();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CF 探测优选 · 实时测速</title>
<style>
  :root {
    --bg: #0d1117; --card: #161b22; --fg: #e6edf3; --line: #30363d; --muted: #9aa3b2;
    --accent: #f6821f; --good: #2ecc71; --bad: #e74c3c; --warn: #f1c40f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { padding: 16px 20px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header .tag { font-size: 12px; color: var(--accent); border: 1px solid var(--accent); padding: 2px 8px; border-radius: 999px; }
  .bar { padding: 10px 20px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--line); background: var(--card); }
  .bar label { font-size: 13px; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; }
  #customDohWrap { display: none; }
  .bar input, .bar select { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font-size: 13px; }
  .bar input[type=number] { width: 56px; }
  button { background: var(--accent); color: #fff; border: none; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
  button.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .status { color: var(--muted); font-size: 13px; }
  .wrap { padding: 12px 20px 40px; overflow-x: auto; }
  table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; }
  th:hover { color: var(--fg); }
  tr.row { cursor: pointer; }
  tr.row:hover { background: #1d2230; }
  tbody tr { content-visibility: auto; contain-intrinsic-size: 0 40px; }
  .lat { font-variant-numeric: tabular-nums; font-weight: 600; }
  .ok { color: var(--good); }
  .timeout { color: var(--warn); }
  .err { color: var(--bad); }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .ip-list { display: inline; }
  .ip-item { display: inline; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
  .rounds { display: inline; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 6px; }
  .rounds b { color: var(--good); font-weight: 700; }
  .rounds .t { color: var(--warn); font-weight: 700; }
  .rounds .e { color: var(--bad); font-weight: 700; }
  .lat { display: inline; font-weight: 700; font-variant-numeric: tabular-nums; }
  .lat.ok { color: var(--good); }
  .lat.timeout { color: var(--warn); }
  .lat.err { color: var(--bad); }
  .cf-yes { color: var(--good); font-weight: 700; }
  .cf-no { color: var(--bad); font-weight: 700; }
  .cf-unknown { color: var(--muted); }
  .warn-row { border-left: 3px solid var(--bad); }
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
  <button id="stop" style="display:none">停止</button>
  <button id="refresh" class="ghost">刷新域名</button>
  <button id="copyAll" class="ghost">复制全部</button>
  <label>DNS 服务商
    <select id="provider">${options}</select>
  </label>
  <label id="customDohWrap">自定义 DoH
    <input id="customDoh" type="text" placeholder="https://..." size="28">
    <button id="testDoh" class="ghost">测试连接</button>
  </label>
  <label>解析线程
    <input id="resolveThreads" type="number" min="1" max="32" value="16">
  </label>
  <label>测速线程
    <input id="measureThreads" type="number" min="1" max="32" value="10">
  </label>
  <span class="status" id="info">点击「开始测速」对每个域名测 3 轮（间隔 2 秒）取平均延迟，按综合排序</span>
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

<script>${FRONTEND_JS}</script>
</body>
</html>`;
}
