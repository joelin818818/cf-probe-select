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
    $("tbody").innerHTML = '<tr><td colspan="7" class="empty">加载中…' + (attempt > 1 ? "（第 " + attempt + " 次重试）" : "") + "</td></tr>";
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
      stateMap[d] = { phase: "idle", lat: null, status: null, errSource: null };
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
      $("tbody").innerHTML = '<tr><td colspan="7" class="empty">加载失败：' + e.message +
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
    ipMap[d] = list;
    if (!list.length) stateMap[d].errSource = "resolve";
    else if (!list.every((x) => x.isCf)) stateMap[d].errSource = "noncf";
    return list;
  }

  // 其余所有 DoH（含自定义/内网自签）由浏览器客户端直接发起
  const doh = getDohUrl(provider, customDoh);
  let ips = [];
  try {
    ips = await browserDohResolve(doh, d);
  } catch (e) {
    ips = [];
    stateMap[d].errSource = "resolve";
  }
  // CF 判定交服务端（仅持有 CF 网段），浏览器不解析 DNS 判定
  const list = await markCf(ips.slice(0, MAX_IPS));
  ipMap[d] = list;
  if (!list.length && !stateMap[d].errSource) stateMap[d].errSource = "resolve";
  else if (list.length && !list.every((x) => x.isCf)) stateMap[d].errSource = "noncf";
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
    extra = "\\n提示：该公开 DoH 可能不返回 CORS 头（浏览器直连会被拦截）或当前网络不可达。可尝试「阿里 DoH」「本地」或自定义 DoH；部分公开 DoH（如 Google）需网络可直连其服务地址。";
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
    stateMap[d] = { phase: "resolving", lat: null, status: "resolving", rounds: null, okRounds: 0, avg: null, errSource: null };
  }
  render();

  const rThreads = loadResolveThreads();
  const mThreads = loadMeasureThreads();

  // 阶段一：全部解析完成
  setInfo("解析中…");
  const resolveTasks = domains.map((d) => async () => {
    if (stopRequested) return;
    try { await resolveOne(d); } catch (e) { ipMap[d] = []; stateMap[d].errSource = "resolve"; }
    resolvedCount++;
    stateMap[d].phase = "resolved";
    // 解析无 IP 或非 CF 时标记为失败（后续跳过测速），否则显示"解析完成，待测速"
    stateMap[d].status = stateMap[d].errSource ? "err" : "resolved";
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
    // 无 IP 或判定为非 CF 的域名直接跳过测速
    if (!ipMap[d] || !ipMap[d].length || stateMap[d].errSource === "noncf") {
      stateMap[d].phase = "done";
      if (!stateMap[d].errSource) stateMap[d].errSource = "resolve";
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
      if (stateMap[d].status === "err" && !stateMap[d].errSource) stateMap[d].errSource = "measure";
    } catch (e) {
      stateMap[d].status = "err";
      if (!stateMap[d].errSource) stateMap[d].errSource = "measure";
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
      if (stateMap[d].status === "err" && !stateMap[d].errSource) stateMap[d].errSource = "measure";
    } catch (e) {
      stateMap[d].status = "err";
      if (!stateMap[d].errSource) stateMap[d].errSource = "measure";
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

// ===== IP 归属地查询（浏览器端直连第三方 API，避免服务端出站触发限额）=====
// 仅查每个域名的「第一个 IP」即可满足归属地展示需求。
// 主用 ipwho.is，备用 freeipapi.com；同 IP 仅查一次（GEO_CACHE 去重）。
const GEO_CACHE = {}; // ip -> { code, name }

// ISO 3166-1 alpha-2 → 中文名（全量）
const COUNTRY_CN = {
  "AD":"安道尔","AE":"阿联酋","AF":"阿富汗","AG":"安提瓜和巴布达","AI":"安圭拉","AL":"阿尔巴尼亚","AM":"亚美尼亚","AO":"安哥拉","AQ":"南极洲","AR":"阿根廷","AS":"美属萨摩亚","AT":"奥地利","AU":"澳大利亚","AW":"阿鲁巴","AX":"奥兰群岛","AZ":"阿塞拜疆",
  "BA":"波斯尼亚和黑塞哥维那","BB":"巴巴多斯","BD":"孟加拉国","BE":"比利时","BF":"布基纳法索","BG":"保加利亚","BH":"巴林","BI":"布隆迪","BJ":"贝宁","BL":"圣巴泰勒米","BM":"百慕大","BN":"文莱","BO":"玻利维亚","BQ":"荷兰加勒比区","BR":"巴西","BS":"巴哈马","BT":"不丹","BV":"布韦岛","BW":"博茨瓦纳","BY":"白俄罗斯","BZ":"伯利兹",
  "CA":"加拿大","CC":"科科斯（基林）群岛","CD":"刚果（金）","CF":"中非共和国","CG":"刚果（布）","CH":"瑞士","CI":"科特迪瓦","CK":"库克群岛","CL":"智利","CM":"喀麦隆","CN":"中国","CO":"哥伦比亚","CR":"哥斯达黎加","CU":"古巴","CV":"佛得角","CW":"库拉索","CX":"圣诞岛","CY":"塞浦路斯","CZ":"捷克",
  "DE":"德国","DJ":"吉布提","DK":"丹麦","DM":"多米尼克","DO":"多米尼加","DZ":"阿尔及利亚",
  "EC":"厄瓜多尔","EE":"爱沙尼亚","EG":"埃及","EH":"西撒哈拉","ER":"厄立特里亚","ES":"西班牙","ET":"埃塞俄比亚","EU":"欧盟",
  "FI":"芬兰","FJ":"斐济","FK":"福克兰群岛（马尔维纳斯）","FM":"密克罗尼西亚","FO":"法罗群岛","FR":"法国",
  "GA":"加蓬","GB":"英国","GD":"格林纳达","GE":"格鲁吉亚","GF":"法属圭亚那","GG":"根西岛","GH":"加纳","GI":"直布罗陀","GL":"格陵兰","GM":"冈比亚","GN":"几内亚","GP":"瓜德罗普","GQ":"赤道几内亚","GR":"希腊","GS":"南乔治亚和南桑威奇群岛","GT":"危地马拉","GU":"关岛","GW":"几内亚比绍","GY":"圭亚那",
  "HK":"中国香港","HM":"赫德岛和麦克唐纳群岛","HN":"洪都拉斯","HR":"克罗地亚","HT":"海地","HU":"匈牙利",
  "ID":"印度尼西亚","IE":"爱尔兰","IL":"以色列","IM":"马恩岛","IN":"印度","IO":"英属印度洋领地","IQ":"伊拉克","IR":"伊朗","IS":"冰岛","IT":"意大利",
  "JE":"泽西岛","JM":"牙买加","JO":"约旦","JP":"日本",
  "KE":"肯尼亚","KG":"吉尔吉斯斯坦","KH":"柬埔寨","KI":"基里巴斯","KM":"科摩罗","KN":"圣基茨和尼维斯","KP":"朝鲜","KR":"韩国","KW":"科威特","KY":"开曼群岛","KZ":"哈萨克斯坦",
  "LA":"老挝","LB":"黎巴嫩","LC":"圣卢西亚","LI":"列支敦士登","LK":"斯里兰卡","LR":"利比里亚","LS":"莱索托","LT":"立陶宛","LU":"卢森堡","LV":"拉脱维亚","LY":"利比亚",
  "MA":"摩洛哥","MC":"摩纳哥","MD":"摩尔多瓦","ME":"黑山","MF":"圣马丁（法属）","MG":"马达加斯加","MH":"马绍尔群岛","MK":"北马其顿","ML":"马里","MM":"缅甸","MN":"蒙古","MO":"中国澳门","MP":"北马里亚纳群岛","MQ":"马提尼克","MR":"毛里塔尼亚","MS":"蒙特塞拉特","MT":"马耳他","MU":"毛里求斯","MV":"马尔代夫","MW":"马拉维","MX":"墨西哥","MY":"马来西亚","MZ":"莫桑比克",
  "NA":"纳米比亚","NC":"新喀里多尼亚","NE":"尼日尔","NF":"诺福克岛","NG":"尼日利亚","NI":"尼加拉瓜","NL":"荷兰","NO":"挪威","NP":"尼泊尔","NR":"瑙鲁","NU":"纽埃","NZ":"新西兰",
  "OM":"阿曼",
  "PA":"巴拿马","PE":"秘鲁","PF":"法属波利尼西亚","PG":"巴布亚新几内亚","PH":"菲律宾","PK":"巴基斯坦","PL":"波兰","PM":"圣皮埃尔和密克隆","PN":"皮特凯恩群岛","PR":"波多黎各","PS":"巴勒斯坦","PT":"葡萄牙","PW":"帕劳","PY":"巴拉圭",
  "QA":"卡塔尔",
  "RE":"留尼汪","RO":"罗马尼亚","RS":"塞尔维亚","RU":"俄罗斯","RW":"卢旺达",
  "SA":"沙特阿拉伯","SB":"所罗门群岛","SC":"塞舌尔","SD":"苏丹","SE":"瑞典","SG":"新加坡","SH":"圣赫勒拿","SI":"斯洛文尼亚","SJ":"斯瓦尔巴和扬马延","SK":"斯洛伐克","SL":"塞拉利昂","SM":"圣马力诺","SN":"塞内加尔","SO":"索马里","SR":"苏里南","SS":"南苏丹","ST":"圣多美和普林西比","SV":"萨尔瓦多","SX":"圣马丁（荷属）","SY":"叙利亚","SZ":"斯威士兰",
  "TA":"特里斯坦-达库尼亚","TC":"特克斯和凯科斯群岛","TD":"乍得","TF":"法属南方领地","TG":"多哥","TH":"泰国","TJ":"塔吉克斯坦","TK":"托克劳","TL":"东帝汶","TM":"土库曼斯坦","TN":"突尼斯","TO":"汤加","TR":"土耳其","TT":"特立尼达和多巴哥","TV":"图瓦卢","TW":"中国台湾",
  "TZ":"坦桑尼亚",
  "UA":"乌克兰","UG":"乌干达","UM":"美国本土外小岛屿","US":"美国","UY":"乌拉圭","UZ":"乌兹别克斯坦",
  "VA":"梵蒂冈","VC":"圣文森特和格林纳丁斯","VE":"委内瑞拉","VG":"英属维尔京群岛","VI":"美属维尔京群岛","VN":"越南","VU":"瓦努阿图",
  "WF":"瓦利斯和富图纳","WS":"萨摩亚",
  "XK":"科索沃",
  "YE":"也门","YT":"马约特",
  "ZA":"南非","ZM":"赞比亚","ZW":"津巴布韦"
};

// 归属地 API 并发信号量（按源单独限制，降低单源被限流概率）
const GEO_SEM = { ipwho: 4, freeipapi: 3, ipapi: 3 };
const GEO_WAITERS = { ipwho: [], freeipapi: [], ipapi: [] };
function geoAcquire(source) {
  const sem = GEO_SEM[source];
  if (sem > 0) { GEO_SEM[source]--; return Promise.resolve(); }
  return new Promise((resolve) => GEO_WAITERS[source].push(resolve));
}
function geoRelease(source) {
  if (GEO_WAITERS[source].length) { const r = GEO_WAITERS[source].shift(); r(); }
  else GEO_SEM[source]++;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchWithTimeout(url, opts = {}, timeout = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}
async function fetchJson(url, opts = {}, timeout = 8000) {
  const r = await fetchWithTimeout(url, opts, timeout);
  if (!r.ok) {
    const err = new Error("HTTP " + r.status);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function lookupCountry(ip) {
  if (ip in GEO_CACHE) return GEO_CACHE[ip];

  const markFail = () => {
    const res = { code: "", name: "" };
    GEO_CACHE[ip] = res;
    return res;
  };

  // 主：ipwho.is
  await geoAcquire("ipwho");
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const d = await fetchJson("https://ipwho.is/" + encodeURIComponent(ip), { cache: "no-store" }, 8000);
        if (d && d.success !== false && (d.country_code || d.country)) {
          const res = { code: d.country_code || "", name: d.country || "" };
          GEO_CACHE[ip] = res;
          return res;
        }
        break;
      } catch (e) {
        if (e.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
        break;
      }
    }
  } finally { geoRelease("ipwho"); }

  // 备 1：freeipapi.com
  await geoAcquire("freeipapi");
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const d = await fetchJson("https://free.freeipapi.com/api/json/" + encodeURIComponent(ip), { cache: "no-store" }, 8000);
        if (d && d.status !== "fail" && (d.countryCode || d.countryName)) {
          const res = { code: d.countryCode || "", name: d.countryName || "" };
          GEO_CACHE[ip] = res;
          return res;
        }
        break;
      } catch (e) {
        if (e.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
        break;
      }
    }
  } finally { geoRelease("freeipapi"); }

  // 备 2：ipapi.co（HTTPS，CORS 友好）
  await geoAcquire("ipapi");
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const d = await fetchJson("https://ipapi.co/" + encodeURIComponent(ip) + "/json/", { cache: "no-store" }, 8000);
        if (d && d.error !== true && (d.country_code || d.country_name)) {
          const res = { code: d.country_code || "", name: d.country_name || "" };
          GEO_CACHE[ip] = res;
          return res;
        }
        break;
      } catch (e) {
        if (e.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
        break;
      }
    }
  } finally { geoRelease("ipapi"); }

  return markFail();
}

// 渲染某域名的归属地（仅第一个 IP）
function geoHtml(d) {
  const list = ipMap[d];
  if (!list || !list.length) return '<span class="badge">—</span>';
  const ip = list[0].ip;
  const cached = GEO_CACHE[ip];
  if (cached) {
    if (cached.code) {
      const cn = COUNTRY_CN[cached.code] || "";
      const label = cn || cached.code;
      const title = (cn ? cn + " " : "") + cached.code + (cached.name && cached.name !== cn ? " · " + cached.name : "");
      return '<span class="geo" title="' + esc(title) + '">' + esc(label) + "</span>";
    }
    return '<span class="geo geo-unknown">?</span>';
  }
  return '<span class="geo geo-loading" data-ip="' + esc(ip) + '">…</span>';
}

// 第一个 IP 的归属地排序键
function geoKey(d) {
  const list = ipMap[d] || [];
  if (list.length && GEO_CACHE[list[0].ip] && GEO_CACHE[list[0].ip].code) return GEO_CACHE[list[0].ip].code;
  return "";
}

// 扫描当前表格里尚未查询的归属地，异步补查并就地更新（不触发整表重渲染）
async function refreshGeo() {
  const spans = Array.from(document.querySelectorAll("#tbody .geo-loading"));
  const todo = [];
  const seen = new Set();
  for (const sp of spans) {
    const ip = sp.getAttribute("data-ip");
    if (!ip || ip in GEO_CACHE || seen.has(ip)) continue;
    seen.add(ip);
    todo.push(ip);
  }
  if (!todo.length) return;
  await Promise.all(todo.map(async (ip) => {
    try {
      const res = await lookupCountry(ip);
      const sel = '#tbody .geo-loading[data-ip="' + (window.CSS && CSS.escape ? CSS.escape(ip) : ip) + '"]';
      document.querySelectorAll(sel).forEach((s) => {
        s.classList.remove("geo-loading");
        if (res.code) {
          const cn = COUNTRY_CN[res.code] || "";
          s.textContent = cn || res.code;
          s.title = (cn ? cn + " " : "") + res.code + (res.name && res.name !== cn ? " · " + res.name : "");
        } else {
          s.textContent = "?";
          s.classList.add("geo-unknown");
        }
      });
    } catch (e) {
      const sel = '#tbody .geo-loading[data-ip="' + (window.CSS && CSS.escape ? CSS.escape(ip) : ip) + '"]';
      document.querySelectorAll(sel).forEach((s) => {
        s.classList.remove("geo-loading");
        s.textContent = "?";
        s.classList.add("geo-unknown");
      });
    }
  }));
}
function latHtml(d) {
  const s = stateMap[d];
  if (!s || s.phase === "idle" || s.phase === "resolving" || (s.phase === "resolved" && s.status === "resolved")) {
    if (s && s.phase === "resolving") return '<span class="status">解析中…</span>';
    if (s && s.phase === "resolved") return '<span class="status">解析完成，待测速</span>';
    return '<span class="badge">—</span>';
  }
  if (s.status === "err") {
    if (s.errSource === "noncf") return '<span class="status err">非CF，跳过测速</span>';
    if (s.errSource === "resolve") return '<span class="status err">解析失败</span>';
    if (s.errSource === "measure") return '<span class="status err">测速失败</span>';
    return '<span class="status err">失败</span>';
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
  else if (sortMode === "geo") arr.sort((a, b) => geoKey(a).localeCompare(geoKey(b)));
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
    tbody.innerHTML = '<tr><td colspan="7" class="empty">' +
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
    html += "<td>" + geoHtml(d) + "</td>";
    html += "<td>" + cfHtml(d) + "</td>";
    html += "<td>" + latHtml(d) + "</td>";
    html += "<td>" + statusHtml(d) + "</td>";
    html += "</tr>";
  });
  tbody.innerHTML = html;
  updateStats();
  refreshGeo().catch(() => {}); // 异步补查归属地，不阻塞渲染
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
  if ($("tbody")) $("tbody").innerHTML = '<tr><td colspan="7" class="empty err">' + msg + "</td></tr>";
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
  if ($("tbody")) $("tbody").innerHTML = '<tr><td colspan="7" class="empty err">' + msg + "</td></tr>";
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
  .geo { font-weight: 600; font-variant-numeric: tabular-nums; }
  .geo-loading { color: #94a3b8; font-weight: 400; }
  .geo-unknown { color: #94a3b8; }
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
        <th data-sort="geo">国家</th>
        <th data-sort="cf">CF IP</th>
        <th data-sort="lat">延迟 (ms)</th>
        <th data-sort="status">状态</th>
      </tr>
    </thead>
    <tbody id="tbody">
      <tr><td colspan="7" class="empty">加载中…</td></tr>
    </tbody>
  </table>
</div>

<script>${frontendJs}</script>
</body>
</html>`;
}
