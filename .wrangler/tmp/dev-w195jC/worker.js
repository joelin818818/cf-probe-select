var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/worker.js
var RAW_DOMAINS_URL = "https://raw.githubusercontent.com/joelin818818/cf-probe-select/main/cf_domains.txt";
var COUNTRY_MAP = {
  "United States": "\u7F8E\u56FD",
  "Netherlands": "\u8377\u5170",
  "Germany": "\u5FB7\u56FD",
  "United Kingdom": "\u82F1\u56FD",
  "Japan": "\u65E5\u672C",
  "Singapore": "\u65B0\u52A0\u5761",
  "France": "\u6CD5\u56FD",
  "Canada": "\u52A0\u62FF\u5927",
  "Australia": "\u6FB3\u5927\u5229\u4E9A",
  "Hong Kong": "\u9999\u6E2F",
  "South Korea": "\u97E9\u56FD",
  "India": "\u5370\u5EA6",
  "Brazil": "\u5DF4\u897F",
  "Sweden": "\u745E\u5178",
  "Finland": "\u82AC\u5170",
  "Poland": "\u6CE2\u5170",
  "Ireland": "\u7231\u5C14\u5170",
  "Switzerland": "\u745E\u58EB",
  "Belgium": "\u6BD4\u5229\u65F6",
  "Austria": "\u5965\u5730\u5229",
  "Norway": "\u632A\u5A01",
  "Denmark": "\u4E39\u9EA6",
  "Spain": "\u897F\u73ED\u7259",
  "Italy": "\u610F\u5927\u5229",
  "Russia": "\u4FC4\u7F57\u65AF",
  "China": "\u4E2D\u56FD",
  "Taiwan": "\u53F0\u6E7E",
  "Turkey": "\u571F\u8033\u5176",
  "United Arab Emirates": "\u963F\u8054\u914B",
  "Israel": "\u4EE5\u8272\u5217",
  "Mexico": "\u58A8\u897F\u54E5",
  "South Africa": "\u5357\u975E",
  "Thailand": "\u6CF0\u56FD",
  "Vietnam": "\u8D8A\u5357",
  "Malaysia": "\u9A6C\u6765\u897F\u4E9A",
  "Indonesia": "\u5370\u5C3C",
  "Philippines": "\u83F2\u5F8B\u5BBE"
};
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "/index.html") {
        return new Response(html(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      if (path === "/api/domains") {
        const res = await fetch(RAW_DOMAINS_URL, { cf: { cacheTtl: 60 } });
        if (!res.ok) {
          return json({ error: "\u65E0\u6CD5\u8BFB\u53D6\u57DF\u540D\u5217\u8868", status: res.status }, 502);
        }
        const text = await res.text();
        const domains = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split("#")[0].trim().toLowerCase());
        return json({ count: domains.length, domains });
      }
      if (path === "/api/resolve") {
        const domain = url.searchParams.get("domain");
        if (!domain) {
          return json({ error: "\u7F3A\u5C11 domain \u53C2\u6570" }, 400);
        }
        const ips = await resolveIps(domain);
        return json({ domain, ips });
      }
      if (path === "/api/health") {
        return json({ ok: true, time: (/* @__PURE__ */ new Date()).toISOString() });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};
async function resolveIps(domain) {
  try {
    let answers = await dohResolve(domain, "https://cloudflare-dns.com/dns-query");
    if (!answers.length) {
      answers = await dohResolve(domain, "https://dns.google/resolve");
    }
    answers = answers.slice(0, 3);
    const out = [];
    for (const ans of answers) {
      const ip = ans.data;
      const loc = await fetchIpLocation(ip);
      out.push({ ip, country: loc.country, countryCode: loc.countryCode });
    }
    return out;
  } catch (e) {
    return [];
  }
}
__name(resolveIps, "resolveIps");
async function dohResolve(domain, baseUrl) {
  try {
    const url = baseUrl + "?name=" + encodeURIComponent(domain) + "&type=A" + (baseUrl.includes("google") ? "" : "");
    const res = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      cf: { cacheTtl: 300 }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Answer || []).filter((a) => a.type === 1);
  } catch (e) {
    return [];
  }
}
__name(dohResolve, "dohResolve");
async function fetchIpLocation(ip) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3e3);
    const res = await fetch(`https://ipwho.is/${ip}`, {
      signal: ctrl.signal,
      cf: { cacheTtl: 86400 }
    });
    clearTimeout(t);
    if (!res.ok) return { country: "-", countryCode: "-" };
    const data = await res.json();
    if (!data.success) return { country: "-", countryCode: "-" };
    const en = data.country || "-";
    return {
      country: COUNTRY_MAP[en] || en,
      countryCode: data.country_code || "-"
    };
  } catch (e) {
    return { country: "-", countryCode: "-" };
  }
}
__name(fetchIpLocation, "fetchIpLocation");
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
function html() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CF \u63A2\u6D4B\u4F18\u9009 \xB7 \u5B9E\u65F6\u6D4B\u901F</title>
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
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  .rank { color: var(--muted); width: 40px; }
  .best { color: var(--accent); font-weight: 700; }
</style>
</head>
<body>
<header>
  <h1>CF \u63A2\u6D4B\u4F18\u9009 \xB7 \u5B9E\u65F6\u6D4B\u901F</h1>
  <span class="tag">Cloudflare</span>
  <span class="status" id="src">\u6570\u636E\u6E90\uFF1AGitHub \u81EA\u52A8\u63A2\u6D4B\u7D2F\u79EF</span>
</header>

<div class="bar">
  <button id="start">\u5F00\u59CB\u6D4B\u901F</button>
  <button id="sort" class="ghost">\u6309\u5EF6\u8FDF\u6392\u5E8F</button>
  <button id="copyAll" class="ghost">\u590D\u5236\u5168\u90E8\uFF08\u6309\u5EF6\u8FDF\uFF09</button>
  <span class="status" id="info">\u70B9\u51FB\u300C\u5F00\u59CB\u6D4B\u901F\u300D\u5BF9\u6240\u6709\u57DF\u540D\u8FDB\u884C\u6D4F\u89C8\u5668\u4FA7\u5B9E\u65F6\u6D4B\u901F</span>
</div>

<div class="wrap">
  <table>
    <thead>
      <tr>
        <th class="rank">#</th>
        <th data-sort="domain">\u57DF\u540D</th>
        <th data-sort="ip">IP \u5F52\u5C5E\u5730\uFF08\u524D 3\uFF09</th>
        <th data-sort="lat">\u5EF6\u8FDF (ms)</th>
        <th data-sort="status">\u72B6\u6001</th>
      </tr>
    </thead>
    <tbody id="tbody">
      <tr><td colspan="5" class="empty">\u52A0\u8F7D\u4E2D\u2026</td></tr>
    </tbody>
  </table>
</div>

<script>
const TIMEOUT = 8000; // \u5355\u57DF\u540D\u6D4B\u901F\u8D85\u65F6
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
    "\u6570\u636E\u6E90\uFF1AGitHub \u81EA\u52A8\u63A2\u6D4B\u7D2F\u79EF \xB7 \u5171 " + domains.length + " \u4E2A\u57DF\u540D";
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
  if (!list) return '<span class="badge">\u89E3\u6790\u4E2D</span>';
  if (!list.length) return '<span class="badge">\u2014</span>';
  return '<div class="ip-list">' + list.map(x =>
    \`<div class="ip-item"><span>\${x.ip}</span><span class="cc">\${x.country}</span></div>\`
  ).join("") + '</div>';
}

function render() {
  if (!results.length && !testing) {
    if (!domains.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">\u6682\u65E0\u57DF\u540D\u6570\u636E</td></tr>';
      return;
    }
    tbody.innerHTML = domains
      .map((d, i) => \`<tr class="row" data-d="\${d}"><td class="rank">\${i + 1}</td>
        <td>\${d}</td><td>\${ipHtml(d)}</td><td class="lat">\u2014</td><td><span class="badge">\u672A\u6D4B</span></td></tr>\`)
      .join("");
    return;
  }
  const sorted = [...results].sort((a, b) => sortFn(a, b));
  tbody.innerHTML = sorted
    .map((r, i) => {
      let cls = "lat", txt = "\u2014", st = "";
      if (r.status === "ok") { cls += " ok"; txt = r.lat + ""; st = '<span class="badge ok">\u53EF\u8FBE</span>'; }
      else if (r.status === "timeout") { cls += " timeout"; txt = "> " + TIMEOUT; st = '<span class="badge">\u8D85\u65F6</span>'; }
      else { cls += " err"; txt = "\u2715"; st = '<span class="badge">\u5931\u8D25</span>'; }
      const best = i === 0 && r.status === "ok" ? "best" : "";
      return \`<tr class="row \${best}" data-d="\${r.domain}"><td class="rank">\${i + 1}</td>
        <td>\${r.domain}</td><td>\${ipHtml(r.domain)}</td><td class="\${cls}">\${txt}</td><td>\${st}</td></tr>\`;
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
  // \u5EF6\u8FDF\u5347\u5E8F\uFF1Aok \u4F18\u5148\uFF0C\u5176\u6B21 timeout\uFF0C\u6700\u540E err\uFF1B\u540C\u72B6\u6001\u6309\u6570\u503C
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
  info.textContent = "\u6D4B\u901F\u4E2D\u2026 0 / " + domains.length;
  // \u5E76\u53D1 8 \u4E2A\uFF0C\u9010\u6279\u6D4B\u901F
  const CONC = 8;
  for (let i = 0; i < domains.length; i += CONC) {
    const batch = domains.slice(i, i + CONC);
    const batchRes = await Promise.all(batch.map(measure));
    results.push(...batchRes);
    done += batchRes.length;
    info.textContent = "\u6D4B\u901F\u4E2D\u2026 " + done + " / " + domains.length;
    render();
  }
  testing = false;
  document.getElementById("start").disabled = false;
  info.textContent = "\u5B8C\u6210 \xB7 \u5171 " + results.length + " \u4E2A \xB7 \u6700\u5FEB " +
    (results.find(r => r.status === "ok")?.domain || "\u65E0");
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
  info.textContent = "\u5DF2\u590D\u5236 " + sorted.length + " \u4E2A\u57DF\u540D\u5230\u526A\u8D34\u677F";
});
document.querySelectorAll("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    sortMode = th.dataset.sort; render();
  });
});

loadDomains();
<\/script>
</body>
</html>`;
}
__name(html, "html");

// C:/Users/szjm/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/szjm/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-P3HVVp/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// C:/Users/szjm/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-P3HVVp/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
