// 前端页面模块：返回完整的 HTML 页面字符串（含内联前端脚本）
// DNS 服务商列表从 worker.js 导入（全仓库唯一来源）
import { DNS_PROVIDER_LIST, materializeDoh } from "./worker.js";

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
// 两阶段测速：先全量粗筛（1 轮），再对延迟最低的 Top N 精测（3 轮）取平均。
const COARSE_ROUNDS = 1;    // 粗筛阶段每个域名的测速轮数
const FINE_ROUNDS = 3;      // 精测阶段每个域名的测速轮数
const ROUND_GAP = 2000;     // 测速轮与轮之间的间隔（毫秒）
let domains = [];
let ipMap = {};             // domain -> [{ip, isCf}]
let stateMap = {};          // domain -> {phase,lat,status,rounds,okRounds,avg}
let orderIndex = {};
let sortMode = "score";
let testing = false;
let stopRequested = false;  // 停止测速标志
let resolvedCount = 0;      // 解析完成计数
let measuredCount = 0;      // 测速完成计数
let filterText = "";        // 域名关键字筛选
let onlyCf = false;         // 仅显示判定为 CF 的域名
let onlyOk = false;         // 仅显示测速可达的域名

const $ = (id) => document.getElementById(id);
const rankMap = { lat: "延迟", ip: "IP", cf: "CF", domain: "域名", status: "状态", score: "综合" };

// 浏览器端本地函数：兼容旧 localStorage 中可能存的 "360" key，自动映射为新 key
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
// 精测数量：粗筛后只对延迟最低的这 N 个域名做多轮精测（默认 50）
function loadFineCount() {
  return Math.max(1, parseInt(localStorage.getItem("cf_fcount") || "50", 10) || 50);
}
function saveFineCount(n) { localStorage.setItem("cf_fcount", String(n)); }

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

// IP -> 是否 CF 的浏览器端缓存
const CF_CACHE = {};

// CF 判定攒批：待判定 IP 攒到 CF_BATCH_SIZE 个再统一发一次（后端单次最多支持 100 个 IP）。
const CF_BATCH_SIZE = 30;
const CF_FLUSH_DELAY = 500;
let cfPending = [];     // 待判定 IP
let cfWaiters = [];     // 等待本批结果的 resolve 回调
let cfFlushing = false; // 是否正在请求中
let cfTimer = null;     // 超时兜底计时器

async function flushCf() {
  if (cfFlushing || !cfPending.length) return;
  cfFlushing = true;
  // 取快照：flush 期间新加入的 IP 归入下一批
  const waiters = cfWaiters.slice();
  const batch = cfPending.slice();
  cfWaiters = [];
  cfPending = [];
  const uniq = [...new Set(batch)];
  try {
    const r = await fetch("/api/cf-check?ips=" + encodeURIComponent(uniq.join(",")), { cache: "no-store" });
    const data = await r.json();
    for (const ip of uniq) CF_CACHE[ip] = !!(data.cf && data.cf[ip]);
  } catch (e) {
    for (const ip of uniq) CF_CACHE[ip] = false;
  }
  cfFlushing = false;
  // 唤醒本批所有等待者
  for (const w of waiters) w();
  // flush 期间又攒了新 IP 则继续处理
  if (cfPending.length) flushCf();
}

// 不足一批时的兜底：延迟一小段时间强制 flush
function scheduleCfFlush() {
  if (cfTimer) return;
  cfTimer = setTimeout(() => {
    cfTimer = null;
    flushCf();
  }, CF_FLUSH_DELAY);
}

async function markCf(ips) {
  if (!ips.length) return [];
  const need = [...new Set(ips)].filter((ip) => !(ip in CF_CACHE));
  // 全部命中缓存则直接返回
  if (!need.length) return ips.map((ip) => ({ ip, isCf: CF_CACHE[ip] }));

  cfPending.push(...need);
  const done = new Promise((resolve) => cfWaiters.push(resolve));
  if (cfPending.length >= CF_BATCH_SIZE) {
    flushCf(); // 不 await，让请求在后台进行，其余解析继续入队
  } else {
    scheduleCfFlush();
  }
  await done;
  return ips.map((ip) => ({ ip, isCf: CF_CACHE[ip] }));
}

// 取浏览器直连 DoH 地址（local 返回 null，由服务端解析）
function getDohUrl(provider, customDoh) {
  if (provider === "local") return null;
  if (provider === "custom") return (customDoh || "").trim();
  return (DOh_URLS[provider]) || null;
}

// 生成 n 位「小写字母 + 数字」随机串（用于 Cloudflare Gateway 随机子域）
function randomSub(n) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// 轮换 Gateway 随机子域：预检失败时换一个 endpoint 重试，并把新地址写回 DOh_URLS，
// 保证后续解析与预检用的是同一个串。无模板（未配置 Gateway）时返回 null。
function rotateGatewayUrl() {
  if (!GATEWAY_DOH_TEMPLATE) return null;
  const url = GATEWAY_DOH_TEMPLATE.replace("{sub}", randomSub(10));
  DOh_URLS.cf_gateway = url;
  return url;
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

// 测速单个域名（域名 HTTPS 实测，rounds 控制轮数）
//   rounds=COARSE_ROUNDS(1) 用于粗筛：全量快速过一遍，得到初步排名
//   rounds=FINE_ROUNDS(3)   用于精测：仅对粗筛 Top N，多轮取平均更稳
async function measureOne(d, rounds = FINE_ROUNDS) {
  const list = [];
  let ok = 0;
  for (let i = 0; i < rounds; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, ROUND_GAP));
    const t0 = performance.now();
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT);
      const r = await fetch("https://" + d, { method: "HEAD", mode: "no-cors", signal: ctrl.signal });
      clearTimeout(to);
      const ms = Math.round(performance.now() - t0);
      list.push(ms); ok++;
    } catch (e) {
      list.push(e.name === "AbortError" ? "T" : "E");
    }
  }
  const nums = list.filter((x) => typeof x === "number");
  const avg = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  return { rounds: list, okRounds: ok, avg, total: rounds };
}

// 把一次测速结果写回 stateMap（粗筛与精测共用同一套判定）
function applyMeasure(d, r) {
  const s = stateMap[d];
  s.rounds = r.rounds;
  s.okRounds = r.okRounds;
  s.totalRounds = r.total;   // 本次实际轮数，排序算成功率时按它归一化
  s.avg = r.avg;
  s.lat = r.avg;
  if (r.okRounds === 0) s.status = "err";
  else if (r.avg === null) s.status = "timeout";
  else s.status = "ok";
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

// 开始测速前的统一预检：对所有 DNS 服务商（含公开 DoH 与自定义）做一次连通性校验。
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

  // 随机子域类服务商（Cloudflare Gateway）：当前子域不可用时自动换一个重试一次。
  const canRotate = !!GATEWAY_DOH_TEMPLATE && doh.indexOf(".cloudflare-gateway.com") >= 0;
  const maxAttempt = canRotate ? 2 : 1;

  let lastDoh = doh;
  let lastErr = null;
  let noIps = false;

  for (let attempt = 1; attempt <= maxAttempt; attempt++) {
    // 第二次尝试时换成新的随机子域
    if (attempt > 1) lastDoh = rotateGatewayUrl() || lastDoh;
    try {
      const ips = await browserDohResolve(lastDoh, "cloudflare.com");
      if (ips.length) return true;
      noIps = true;
    } catch (e) {
      lastErr = e;
    }
  }

  if (noIps) {
    alert("该 DoH 无法解析出 IP（可能地址不正确、网络被拦截，或浏览器 CORS 限制）：\\n" + lastDoh +
      "\\n请更换其他 DNS 服务商或检查网络" + (canRotate ? "（已自动换过一次随机子域仍失败）" : ""));
    return false;
  }

  let extra = "";
  if (provider === "custom") {
    extra = "\\n（内网自签证书请先在浏览器手动信任该地址：直接打开 " + lastDoh + " 并点「继续」）";
  } else {
    extra = "\\n提示：该公开 DoH 可能不返回 CORS 头（浏览器直连会被拦截）或当前网络不可达。可尝试「阿里 DoH（国内）」「本地」或自定义 DoH；国际 DoH 需可访问境外网络。";
  }
  alert("该 DoH 连接失败（可能网络被拦截或浏览器 CORS 限制）：\\n" + lastDoh +
    "\\n错误：" + (lastErr ? lastErr.message : "未知") + extra +
    (canRotate ? "（已自动换过一次随机子域仍失败）" : ""));
  return false;
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
  // 兜底：强制 flush 尾部不足一批的待判定 IP
  await flushCf();
  if (stopRequested) { finishTest("已停止（解析阶段）"); return; }

  // 阶段二（粗筛）：全量每个域名测 1 轮，快速得到完整排序，用户一两分钟就能看到全貌
  setInfo("粗筛中…");
  measuredCount = 0;
  const coarseTasks = domains.map((d) => async () => {
    if (stopRequested) return;
    // 无 IP 的域名直接跳过测速
    if (!ipMap[d] || !ipMap[d].length) {
      stateMap[d].phase = "done";
      stateMap[d].status = "err";
      measuredCount++;
      if (measuredCount % RENDER_EVERY === 0 || measuredCount === domains.length) {
        setInfo("粗筛 " + measuredCount + "/" + domains.length);
        render();
      }
      return;
    }
    stateMap[d].phase = "measuring";
    stateMap[d].status = "measuring";
    stateMap[d].stage = "coarse";
    try {
      applyMeasure(d, await measureOne(d, COARSE_ROUNDS));
    } catch (e) {
      stateMap[d].status = "err";
    }
    stateMap[d].phase = "done";
    measuredCount++;
    if (measuredCount % RENDER_EVERY === 0 || measuredCount === domains.length) {
      setInfo("粗筛 " + measuredCount + "/" + domains.length);
      render();
    }
  });
  await runPool(coarseTasks, mThreads);
  if (stopRequested) { finishTest("已停止（粗筛阶段）"); return; }

  // 阶段三（精测）：只对粗筛里「可达且延迟最低」的 Top N 做 3 轮精测。
  // 精测耗时是粗筛的数倍，只对头部候选做，兼顾精度与总耗时。
  const fineCount = loadFineCount();
  const candidates = domains
    .filter((d) => stateMap[d] && stateMap[d].status === "ok" && stateMap[d].avg != null)
    .sort((a, b) => stateMap[a].avg - stateMap[b].avg)
    .slice(0, fineCount);

  if (!candidates.length) {
    finishTest("粗筛 " + domains.length + "/" + domains.length + " · 无可达域名，跳过精测");
    return;
  }

  setInfo("精测中…");
  let fineDone = 0;
  const fineTasks = candidates.map((d) => async () => {
    if (stopRequested) return;
    stateMap[d].phase = "measuring";
    stateMap[d].status = "measuring";
    stateMap[d].stage = "fine";
    try {
      applyMeasure(d, await measureOne(d, FINE_ROUNDS));
    } catch (e) {
      stateMap[d].status = "err";
    }
    stateMap[d].phase = "done";
    fineDone++;
    if (fineDone % RENDER_EVERY === 0 || fineDone === candidates.length) {
      setInfo("粗筛 " + domains.length + "/" + domains.length + " · 精测 " + fineDone + "/" + candidates.length);
      render();
    }
  });
  await runPool(fineTasks, mThreads);

  finishTest(
    "粗筛 " + domains.length + "/" + domains.length +
    " · 精测 " + fineDone + "/" + candidates.length + " · 完成"
  );
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
  // 复制「当前可见」的行（已应用筛选），做到所见即所得
  const lines = sortRows().filter(passFilter).map((d) => d + (stateMap[d].avg != null ? "  # " + stateMap[d].avg + "ms" : ""));
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
  // 阶段提示用 title，鼠标悬停可见，不额外占用行高
  const stageTitle = s.stage === "coarse" ? "粗筛 1 轮" : s.stage === "fine" ? "精测 " + FINE_ROUNDS + " 轮" : "";
  return '<span class="rounds" title="' + stageTitle + '">' + roundStr + "</span>" + avgStr;
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

// 测速阶段权重：精测（多轮、数据更可信）优先于粗筛（单轮）。
// 若只比成功率，粗筛「1 轮偶然成功」= 1.0 会盖过精测「3 轮中 2 轮成功」≈ 0.67，
// 但后者样本更多、结论更可靠，所以先按阶段分组，再比成功率与延迟。
function stageRank(s) {
  if (!s) return 2;
  if (s.stage === "fine") return 0;
  if (s.stage === "coarse") return 1;
  return 2;
}

// 两个「已有测速结果」的域名之间的比较（lat / score 两种排序共用）
function compareMeasured(sa, sb) {
  const ra = stageRank(sa), rb = stageRank(sb);
  if (ra !== rb) return ra - rb;
  // 成功率按各自实际轮数归一化，兼容粗筛 1 轮与精测 3 轮
  const fa = sa.okRounds / (sa.totalRounds || 3);
  const fb = sb.okRounds / (sb.totalRounds || 3);
  if (fb !== fa) return fb - fa;
  const la = sa.avg == null ? Infinity : sa.avg;
  const lb = sb.avg == null ? Infinity : sb.avg;
  return la - lb;
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
  else { // lat / score：两者口径一致，均按「阶段 → 成功率 → 平均延迟」排序
    arr.sort((a, b) => {
      const sa = stateMap[a], sb = stateMap[b];
      const ha = sa && sa.rounds, hb = sb && sb.rounds;
      if (ha && hb) return compareMeasured(sa, sb);
      if (ha) return -1;
      if (hb) return 1;
      return (orderIndex[a] || 0) - (orderIndex[b] || 0);
    });
  }
  return arr;
}

// 转义用于 HTML 属性值/文本的内容
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 筛选判定：域名是否通过当前的搜索/开关条件。
function passFilter(d) {
  if (filterText) {
    const kw = filterText.trim().toLowerCase();
    if (kw && d.indexOf(kw) < 0) return false;
  }
  if (onlyCf) {
    const list = ipMap[d];
    // 「仅 CF 节点」= 该域名解析出的所有 IP 都命中 Cloudflare 网段（对应 ✓CF）
    if (!list || !list.length || !list.every((x) => x.isCf)) return false;
  }
  if (onlyOk) {
    const s = stateMap[d];
    if (!s || s.status !== "ok") return false;
  }
  return true;
}

function updateFilterInfo(shown, total) {
  const el = $("filterInfo");
  if (!el) return;
  el.textContent = shown === total ? "" : "筛选出 " + shown + " / " + total + " 个";
}

function updateStats() {
  let remainingResolve = 0, remainingMeasure = 0, ok = 0, err = 0;
  for (const d of domains) {
    const s = stateMap[d];
    if (!s) { remainingResolve++; continue; }
    if (s.phase === "idle" || s.phase === "resolving") {
      remainingResolve++;
    }
    if (s.phase === "resolved" || s.phase === "measuring") {
      remainingMeasure++;
    }
    if (s.status === "ok") ok++;
    else if (s.status === "err" || s.status === "timeout") err++;
  }
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("stat-total", domains.length);
  set("stat-resolving", remainingResolve);
  set("stat-measuring", remainingMeasure);
  set("stat-ok", ok);
  set("stat-err", err);
}

function render() {
  const all = sortRows();                       // 全量排序结果（排名与最优基于此）
  const rows = all.filter(passFilter);          // 筛选后仅影响表格显示
  const best = all.find((d) => stateMap[d] && stateMap[d].status === "ok" && stateMap[d].avg != null);
  // 全局排名映射：即使筛选后也显示真实名次，而不是筛选结果的相对序号
  const rankOf = {};
  all.forEach((d, idx) => { rankOf[d] = idx + 1; });
  const tbody = $("tbody");
  updateFilterInfo(rows.length, all.length);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">' +
      (all.length ? "没有符合筛选条件的域名" : "暂无数据") + "</td></tr>";
    updateStats();
    return;
  }
  let html = "";
  rows.forEach((d) => {
    const cls = [];
    if ((ipMap[d] || []).length && !(ipMap[d] || []).every((x) => x.isCf)) cls.push("warn-row");
    const bestCls = d === best ? "best" : "";
    html += '<tr class="row ' + cls.join(" ") + '" data-d="' + esc(d) + '">';
    html += '<td class="rank">' + (bestCls ? "★" : rankOf[d]) + "</td>";
    html += '<td><a class="domain-link" href="https://' + esc(d) + '" target="_blank" rel="noopener noreferrer">' + esc(d) + "</a></td>";
    html += "<td>" + ipHtml(d) + "</td>";
    html += "<td>" + cfHtml(d) + "</td>";
    html += "<td>" + latHtml(d) + "</td>";
    html += "<td>" + statusHtml(d) + "</td>";
    html += "</tr>";
  });
  tbody.innerHTML = html;
  updateStats();
}

// ---- 控件初始化 ----
function initControls() {
  const p = loadProvider();
  $("provider").value = p;
  const cd = loadCustomDoh();
  $("customDoh").value = cd;
  $("resolveThreads").value = loadResolveThreads();
  $("measureThreads").value = loadMeasureThreads();
  $("fineCount").value = loadFineCount();
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
$("fineCount").addEventListener("change", (e) => { saveFineCount(parseInt(e.target.value, 10) || 50); });
$("search").addEventListener("input", (e) => { filterText = e.target.value; render(); });
$("onlyCf").addEventListener("change", (e) => { onlyCf = e.target.checked; render(); });
$("onlyOk").addEventListener("change", (e) => { onlyOk = e.target.checked; render(); });
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
    if (!p.doh) return;
    // 带 {sub} 模板的服务商（Cloudflare Gateway）在每次渲染页面时实例化为随机子域，
    // 整页共用一个串，保证预检与解析结果一致。
    dohUrls[p.key] = materializeDoh(p);
  });
  // Gateway 的 DoH 模板（含 {sub} 占位符）一并注入前端，便于预检失败时就地换随机子域重试
  const gatewayTpl = (DNS_PROVIDER_LIST.find((p) => p.randomSubdomain) || {}).doh || "";
  const frontendJs =
    "/* FRONTEND_VERSION=" + (version || "") + " */\n" +
    "const GATEWAY_DOH_TEMPLATE = " + JSON.stringify(gatewayTpl) + ";\n" +
    "const DOh_URLS = " + JSON.stringify(dohUrls) + ";\n" +
    FRONTEND_JS;
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
    --bg: #eef1f0;
    --surface: #ffffff;
    --surface-2: #f5f7f6;
    --fg: #4d5e6e;
    --fg-muted: #7a8a9c;
    --line: #e3e8ef;
    --line-strong: #cdd8e2;
    --accent: #2f9e8f;
    --accent-hover: #3aae9e;
    --good: #4d9b7c;
    --bad: #c75b55;
    --warn: #c99a3c;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.5; }
  header {
    padding: 16px 24px;
    background: linear-gradient(135deg, #c9e8e2 0%, #eef1f0 100%);
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  header h1 { font-size: 18px; margin: 0; font-weight: 700; }
  header .tag { font-size: 12px; color: var(--surface); background: var(--accent); padding: 3px 10px; border-radius: 999px; font-weight: 600; }
  .bar {
    margin: 16px 24px 0;
    padding: 12px 16px;
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(89,107,128,0.06);
  }
  .bar label { font-size: 13px; color: var(--fg-muted); display: inline-flex; align-items: center; gap: 6px; }
  #customDohWrap { display: none; }
  .bar input, .bar select, .filters input[type=text] {
    background: var(--surface-2);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 13px;
    outline: none;
  }
  .bar input:focus, .bar select:focus, .filters input[type=text]:focus { border-color: var(--line-strong); box-shadow: 0 0 0 2px rgba(188,207,228,0.35); }
  .filters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin: 12px 24px 0; }
  .switch { font-size: 13px; color: var(--fg-muted); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
  .switch input { cursor: pointer; accent-color: var(--accent); width: 15px; height: 15px; }
  .switch:hover { color: var(--fg); }
  .bar input[type=number] { width: 60px; }
  button {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 8px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    transition: background 0.15s ease, transform 0.1s ease;
  }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  button.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); }
  button.ghost:hover { background: rgba(188,207,228,0.25); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 16px 24px 0; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; box-shadow: 0 2px 8px rgba(47,158,143,0.06); }
  .stat-num { font-size: 26px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat-num.ok { color: var(--good); }
  .stat-num.err { color: var(--bad); }
  .stat-label { font-size: 12px; color: var(--fg-muted); margin-top: 2px; }
  .status { color: var(--fg-muted); font-size: 13px; }
  .wrap { padding: 16px 24px 40px; overflow-x: auto; }
  table {
    width: 100%;
    min-width: 720px;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 14px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(89,107,128,0.06);
  }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--fg-muted); font-weight: 600; cursor: pointer; user-select: none; }
  th:hover { color: var(--fg); }
  tr.row { cursor: pointer; }
  tr.row:hover { background: rgba(188,207,228,0.22); }
  tbody tr { content-visibility: auto; contain-intrinsic-size: 0 44px; }
  .lat { font-variant-numeric: tabular-nums; font-weight: 600; }
  .ok { color: var(--good); }
  .timeout { color: var(--warn); }
  .err { color: var(--bad); }
  .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--fg-muted);
    background: rgba(188,207,228,0.15);
    white-space: nowrap;
  }
  .ip-list { display: inline; }
  .ip-item { display: inline; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
  .rounds { display: inline; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; margin-right: 6px; }
  .rounds b { color: var(--good); font-weight: 700; }
  .rounds .t { color: var(--warn); font-weight: 700; }
  .rounds .e { color: var(--bad); font-weight: 700; }
  .lat { display: inline; font-weight: 700; font-variant-numeric: tabular-nums; }
  .lat.ok { color: var(--good); }
  .lat.timeout { color: var(--warn); }
  .lat.err { color: var(--bad); }
  .cf-yes { color: var(--good); font-weight: 700; }
  .cf-no { color: var(--bad); font-weight: 700; }
  .cf-unknown { color: var(--fg-muted); }
  .warn-row { border-left: 3px solid var(--bad); }
  .empty { color: var(--fg-muted); padding: 40px; text-align: center; }
  .rank { color: var(--fg-muted); width: 40px; }
  .best { color: var(--accent); font-weight: 700; }
  a.domain-link { color: var(--fg); text-decoration: none; font-weight: 500; }
  a.domain-link:hover { color: var(--accent-hover); text-decoration: underline; }
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
  <button id="copyAll" class="ghost">复制当前</button>
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
  <label title="粗筛后只对延迟最低的前 N 个域名做 3 轮精测">精测数量
    <input id="fineCount" type="number" min="1" max="400" value="50">
  </label>
  <span class="status" id="info">DNS 解析除「本地」走服务端外，均由你的浏览器直连 DoH；测速分两阶段：先全量粗筛 1 轮快速排序，再对延迟最低的「精测数量」个域名测 3 轮（间隔 2 秒）取平均</span>
</div>

<div class="stats" id="stats">
  <div class="stat"><div class="stat-num" id="stat-total">0</div><div class="stat-label">总域名</div></div>
  <div class="stat"><div class="stat-num" id="stat-resolving">0</div><div class="stat-label">剩余解析</div></div>
  <div class="stat"><div class="stat-num" id="stat-measuring">0</div><div class="stat-label">剩余测速</div></div>
  <div class="stat"><div class="stat-num ok" id="stat-ok">0</div><div class="stat-label">可达</div></div>
  <div class="stat"><div class="stat-num err" id="stat-err">0</div><div class="stat-label">失败</div></div>
</div>

<div class="filters">
  <input id="search" type="text" placeholder="搜索域名关键字…" size="24">
  <label class="switch"><input id="onlyCf" type="checkbox"> 仅 CF 节点</label>
  <label class="switch"><input id="onlyOk" type="checkbox"> 仅可达</label>
  <span class="status" id="filterInfo"></span>
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
