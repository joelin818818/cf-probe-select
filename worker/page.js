// 前端页面模块：返回完整的 HTML 页面字符串（含内联前端脚本）
// DNS 服务商列表从 worker.js 导入（全仓库唯一来源，避免多处维护不一致）
import { DNS_PROVIDER_LIST } from "./worker.js";

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
const MAX_IPS = 3;          // 单域名最多展示的解析 IP 数（展示全部解析结果，封顶 3 个）
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

// 浏览器端本地函数：兼容旧 localStorage 中可能存的 "360" key，自动映射为新 key
// （注意：本脚本是浏览器内联脚本，无 import，故在此自包含定义）
function normalizeProviderKey(key) {
  const valid = ["local","aliyun","dnssb","cf_gateway","google","custom"];
  return valid.indexOf(key) >= 0 ? key : "local";
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
  let t;
  try {
    $("src").textContent = "数据源：GitHub 自动探测累积（实时）· 加载中…";
    $("tbody").innerHTML = '<tr><td colspan="6" class="empty">加载中…' + (attempt > 1 ? "（第 " + attempt + " 次重试）" : "") + "</td></tr>";
    const ctrl = new AbortController();
    t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch("/api/domains", { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t); t = null;
    if (!r.ok) throw new Error("HTTP " + r.status);
    let data;
    try {
      data = await r.json();
    } catch (jsonErr) {
      const snippet = (await r.text()).slice(0, 80);
      throw new Error("返回不是 JSON（可能是 Cloudflare 挑战页）：" + snippet);
    }
    if (data.error) throw new Error(data.error);
    domains = data.domains || [];
    ipMap = {}; stateMap = {}; orderIndex = {};
    domains.forEach((d, i) => {
      ipMap[d] = undefined;
      stateMap[d] = { phase: "idle", lat: null, status: null };
      orderIndex[d] = i;
    });
    testing = false;
    $("start").disabled = false;
    const src = "数据源：GitHub 自动探测累积（实时）· 共 " + domains.length + " 个域名" +
      (data.updatedAt ? " · 更新：" + data.updatedAt : "");
    $("src").textContent = src;
    render();
  } catch (e) {
    if (t) { clearTimeout(t); t = null; }
    console.error("loadDomains failed:", e);
    if (attempt <= 2) {
      setInfo("域名列表加载失败，2秒后重试… (" + e.message + ")");
      setTimeout(() => loadDomains(attempt + 1), 2000);
    } else {
      $("src").textContent = "数据源：GitHub 自动探测累积（加载失败，请刷新重试）";
      $("tbody").innerHTML = '<tr><td colspan="6" class="empty">加载失败：' + e.message +
        ' <button id="retryLoad" class="ghost">重试加载</button></td></tr>';
      $("start").disabled = false;
      const btn = $("retryLoad");
      if (btn) btn.addEventListener("click", () => loadDomains(1));
    }
  }
}

// 浏览器端直连 DoH 解析（DNS-JSON 协议）。
// 查 1 次即可；仅当请求失败（网络/CORS/超时）才重试，最多 3 次；
// 成功但返回空结果（DoH 确实无 A 记录）不重试。返回该次全部 A 记录 IP。
async function browserDohResolve(doh, domain, maxAttempts = 3) {
  if (!doh) return [];
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(doh + "?name=" + encodeURIComponent(domain) + "&type=1", {
        headers: { accept: "application/dns-json" },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!r.ok) throw new Error("DoH " + r.status);
      const j = await r.json();
      // 成功拿到响应即返回（空结果也算有效响应，不重试）
      return (j.Answer || [])
        .filter((a) => a.type === 1 && typeof a.data === "string")
        .map((a) => a.data);
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (attempt < maxAttempts) await new Promise((res) => setTimeout(res, 500 * attempt));
    }
  }
  throw lastErr;
}

// IP -> 是否 CF 的浏览器端缓存（去重，减少 /api/cf-check 调用）
const CF_CACHE = {};
async function markCf(ips) {
  if (!ips.length) return [];
  const uniq = [...new Set(ips)];
  const need = uniq.filter((ip) => !(ip in CF_CACHE));
  if (need.length) {
    try {
      const r = await fetch("/api/cf-check?ips=" + encodeURIComponent(need.join(",")), { cache: "no-store" });
      const data = await r.json();
      for (const ip of need) CF_CACHE[ip] = !!(data.cf && data.cf[ip]);
    } catch (e) {
      for (const ip of need) CF_CACHE[ip] = false;
    }
  }
  return ips.map((ip) => ({ ip, isCf: CF_CACHE[ip] }));
}

// 取浏览器直连 DoH 地址（local 返回 null，由服务端解析）
function getDohUrl(provider, customDoh) {
  if (provider === "local") return null;
  if (provider === "custom") return (customDoh || "").trim();
  return (DOh_URLS[provider]) || null;
}

// 解析单个域名（带缓存），更新解析进度
async function resolveOne(d) {
  const provider = loadProvider();
  const customDoh = loadCustomDoh();

  // local：由服务端 Worker 自己解析（服务端视角）
  if (provider === "local") {
    const res = await fetch("/api/resolve?domain=" + encodeURIComponent(d) + "&provider=local", { cache: "no-store" });
    const data = await res.json();
    const list = (data.ips || []).slice(0, MAX_IPS).map((ip) => ({ ip, isCf: !!data.cf }));
    ipMap[d] = list.length ? list : [];
    return list;
  }

  // 其余所有 DoH（含自定义/内网自签）由浏览器客户端直接发起
  const doh = getDohUrl(provider, customDoh);
  let ips = [];
  try {
    ips = await browserDohResolve(doh, d);
  } catch (e) {
    ips = [];
  }
  // CF 判定交服务端（仅持有 CF 网段），浏览器不解析 DNS 判定
  const list = await markCf(ips.slice(0, MAX_IPS));
  ipMap[d] = list;
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

// 开始测速前的统一预检：对所有 DNS 服务商（含公开 DoH 与自定义）做一次连通性校验，
// 不可用时中止并提示，避免静默产出空 IP。local 由服务端解析，无需浏览器预检。
async function preflightCheck() {
  const provider = loadProvider();
  const customDoh = loadCustomDoh().trim();
  if (provider === "local") return true;

  let doh = getDohUrl(provider, customDoh);
  if (provider === "custom") {
    if (!customDoh) { alert("请先填写自定义 DoH 地址"); return false; }
    if (customDoh.indexOf("https://") !== 0) { alert("自定义 DoH 必须是 https:// 开头（不支持裸 UDP 53；https 页面下也不支持 http 内网明文，请用自签 https）"); return false; }
  }
  if (!doh) { alert("未知 DNS 服务商"); return false; }

  try {
    const ips = await browserDohResolve(doh, "cloudflare.com");
    if (!ips.length) {
      alert("该 DoH 无法解析出 IP（可能地址不正确、网络被拦截，或浏览器 CORS 限制）：\\n" + doh + "\\n请更换其他 DNS 服务商或检查网络");
      return false;
    }
    return true;
  } catch (e) {
    let extra = "";
    if (provider === "custom") {
      extra = "\\n（内网自签证书请先在浏览器手动信任该地址：直接打开 " + doh + " 并点「继续」）";
    } else {
      extra = "\\n提示：该公开 DoH 可能不返回 CORS 头（浏览器直连会被拦截）或当前网络不可达。可尝试「阿里 DoH（国内）」「本地」或自定义 DoH；国际 DoH 需可访问境外网络。";
    }
    alert("该 DoH 连接失败（可能网络被拦截或浏览器 CORS 限制）：\\n" + doh + "\\n错误：" + e.message + extra);
    return false;
  }
}

async function startTest() {
  if (testing) return;
  // 开始前统一预检所选 DoH 是否可用（所有服务商，含公开与自定义）
  if (!(await preflightCheck())) return;
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
    // 解析无 IP 时标记为失败，而不是显示"解析完成，待测速"
    stateMap[d].status = (ipMap[d] && ipMap[d].length) ? "resolved" : "err";
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
    // 无 IP 的域名直接跳过测速，避免无意义请求并显示"解析失败"
    if (!ipMap[d] || !ipMap[d].length) {
      stateMap[d].phase = "done";
      stateMap[d].status = "err";
      measuredCount++;
      if (measuredCount % RENDER_EVERY === 0 || measuredCount === domains.length) {
        setInfo("解析 " + resolvedCount + "/" + domains.length + " · 测速 " + measuredCount + "/" + domains.length);
        render();
      }
      return;
    }
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
  if (!s || s.phase === "idle" || s.phase === "resolving" || (s.phase === "resolved" && s.status === "resolved")) {
    if (s && s.phase === "resolving") return '<span class="status">解析中…</span>';
    if (s && s.phase === "resolved") return '<span class="status">解析完成，待测速</span>';
    return '<span class="badge">—</span>';
  }
  if (s.status === "err") return '<span class="status err">解析失败</span>';
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
  else if (sortMode === "status") arr.sort((a, b) => ((stateMap[a] && stateMap[a].status) || "").localeCompare((stateMap[b] && stateMap[b].status) || ""));
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

// 转义用于 HTML 属性值/文本的内容，防止域名中含 " < > & 破坏结构
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    html += '<tr class="row ' + cls.join(" ") + '" data-d="' + esc(d) + '">';
    html += '<td class="rank">' + (bestCls ? "★" : i + 1) + "</td>";
    html += '<td><a class="domain-link" href="https://' + esc(d) + '" target="_blank" rel="noopener noreferrer">' + esc(d) + "</a></td>";
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
  $("customDoh").placeholder = "https://你的 DoH 地址（公开或内网自签）";
  // 开始测速前的 DoH 可用性校验已统一在 preflightCheck 中完成，此处无需再控制 start 按钮
}
// 预检已统一在 startTest -> preflightCheck 中完成，自定义不再单独测试按钮（见 preflightCheck）

$("start").addEventListener("click", startTest);
$("stop").addEventListener("click", stopTest);
$("refresh").addEventListener("click", async () => { await loadDomains(); setInfo("已刷新域名列表"); });
$("copyAll").addEventListener("click", copyAll);
$("provider").addEventListener("change", (e) => { saveProvider(e.target.value); updateCustomUI(); });
$("customDoh").addEventListener("input", (e) => { saveCustomDoh(e.target.value); updateCustomUI(); });
$("resolveThreads").addEventListener("change", (e) => { saveResolveThreads(parseInt(e.target.value, 10) || 16); });
$("measureThreads").addEventListener("change", (e) => { saveMeasureThreads(parseInt(e.target.value, 10) || 10); });
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => { sortMode = th.getAttribute("data-sort"); render(); });
});

// 全局错误兜底：任何未捕获异常都写到表格里，方便用户截图反馈
window.addEventListener("error", (e) => {
  console.error(e);
  const stack = e.error && e.error.stack ? e.error.stack : "";
  const details = [
    "msg=" + (e.message || e.error || "未知"),
    "file=" + (e.filename || ""),
    "line=" + (e.lineno || ""),
    "col=" + (e.colno || ""),
    stack ? "stack=" + stack.slice(0, 300) : "",
  ].filter(Boolean).join(" / ");
  const msg = "JS 运行时错误：" + details;
  setInfo(msg);
  if ($("tbody")) $("tbody").innerHTML = '<tr><td colspan="6" class="empty err">' + msg + "</td></tr>";
});
window.addEventListener("unhandledrejection", (e) => {
  console.error(e);
  const reason = e.reason;
  const stack = reason && reason.stack ? reason.stack : "";
  const details = [
    "msg=" + (reason && reason.message ? reason.message : String(reason)),
    stack ? "stack=" + stack.slice(0, 300) : "",
  ].filter(Boolean).join(" / ");
  const msg = "未处理的 Promise 错误：" + details;
  setInfo(msg);
  if ($("tbody")) $("tbody").innerHTML = '<tr><td colspan="6" class="empty err">' + msg + "</td></tr>";
});

loadDomains();
initControls();
`;

export function html(version) {
  const options = providerOptions();
  // 公开 DoH 地址映射（供浏览器客户端直连使用；custom 用用户填写的地址）
  const dohUrls = {};
  DNS_PROVIDER_LIST.forEach((p) => {
    if (p.doh) dohUrls[p.key] = p.doh;
  });
  const frontendJs = "/* FRONTEND_VERSION=" + (version || "") + " */\nconst DOh_URLS = " + JSON.stringify(dohUrls) + ";\n" + FRONTEND_JS;
  return `<!doctype html>
<!-- DEPLOY_VERSION=${version || ""} -->
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="deploy-version" content="${version || ""}">
<title>CF 探测优选 v${version || ""}</title>
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
  a.domain-link { color: var(--fg); text-decoration: none; }
  a.domain-link:hover { color: var(--accent); text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>CF 探测优选 v${version || ""}</h1>
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
    <input id="customDoh" type="text" placeholder="https://你的 DoH 地址（公开或内网自签）" size="28">
  </label>
  <label>解析线程
    <input id="resolveThreads" type="number" min="1" max="32" value="16">
  </label>
  <label>测速线程
    <input id="measureThreads" type="number" min="1" max="32" value="10">
  </label>
  <span class="status" id="info">DNS 解析除「本地」走服务端外，均由你的浏览器直连 DoH；测速对每个域名发 HTTPS 请求测 3 轮（间隔 2 秒）取平均，按综合排序</span>
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

<script>${frontendJs}</script>
</body>
</html>`;
}
