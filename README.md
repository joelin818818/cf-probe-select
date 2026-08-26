# CF 探测优选（CF-PROBE-SELECT）

> 自动挖掘走 Cloudflare 的第三方站点，并在网页端实时测速，帮你挑出最快的节点。

---

## 一、它能做什么

| 阶段 | 做什么 | 谁来跑 |
|---|---|---|
| **探测** | 顺着网页外链自动发现走 Cloudflare CDN 的域名，持续累积 | GitHub Actions 定时运行 `cf_probe_select.py` |
| **测速** | 通过 Cloudflare Worker 提供的网页，在你的浏览器侧对每个域名实时测速 | 你在浏览器里点「开始测速」 |
| **优选** | 按成功率与延迟动态排序，自行复制并使用最快的节点 | 你 |

最终产物是 `cf_domains.txt`（每行一个纯域名），由探测脚本维护；测速网页实时读取它，并展示每个域名的解析 IP、CF 判定与延迟。

---

## 二、测速网页（Cloudflare Worker）

网页由 Cloudflare Worker 托管，测速全部在**你的浏览器侧**完成，真实反映你到各节点的延迟。

### 测速机制
- 每个域名测 **3 轮**，轮间间隔约 2 秒（避免瞬时拥塞），取平均成绩。
- 并发上限可在页面顶部调整（默认解析 8 / 测速 10，范围 1–32），存于 `localStorage`。
- 延迟列展示 3 轮成绩（数字 = 毫秒，`T` = 超时，`E` = 失败）与平均成绩。
- 默认排序：`成功率（成功轮数 / 3）降序 → 平均延迟升序`；未出结果 / 测速中的域名沉底按原始序号排列。
- 表头（域名 / IP / CF 判定 / 延迟 / 状态）均可点击切换排序。
- 测速前统一预检所选 DNS 是否可用，不可用时弹窗提示，避免静默空 IP。

### IP 与 CF 判定
- 每个域名解析前 3 个 A 记录 IP，并用 Cloudflare 官方 IPv4 CIDR 判定是否落在 CF 段（`✓CF` / `✗非CF`）。
- IP 列仅展示 IP 与 CF 判定，不展示国家归属地。
- `/api/resolve` 与前端均带 5 分钟解析缓存，减少重复请求。

### DNS 服务商（解析域名用）
除「本地」外，所有公开 / 自定义 DoH 均由**浏览器直连**发起（服务端不解析 DNS）。

| 选项 | 地址 | 说明 |
|---|---|---|
| 本地（服务端 DNS） | — | Worker 边缘递归解析，始终可用 |
| 阿里 DoH（国内） | `dns.alidns.com/resolve` | 返回 CORS 头，国内直连可用 |
| DNS.SB DoH（香港） | `doh.dns.sb/dns-query` | 返回 CORS 头，亚洲节点 |
| Cloudflare Gateway DoH | `*.cloudflare-gateway.com/dns-query` | 返回 CORS 头，国内可直连 |
| Google DoH（国际） | `dns.google/resolve` | 需可访问境外网络 |
| 自定义 DoH | 自填 | 浏览器直连 |

> **关于内网自签证书**：前端 `fetch` 无法忽略证书错误（浏览器安全底线）。内网自签 DoH 需先在浏览器手动信任一次（直接打开该地址点「继续」）；或改用 Cloudflare Tunnel 暴露成受信 https，彻底免手动信任。

### 域名列表来源（fork 友好）
网页从 GitHub raw 实时拉取 `cf_domains.txt`。地址由环境变量 `RAW_DOMAINS_URL` 控制：

- 部署时优先读取 `wrangler.toml` 的 `[vars] RAW_DOMAINS_URL`。
- 未配置则回退到代码内默认值（初始为上游仓库 `joelin818818/cf-probe-select`）。
- **fork 后无需手动改**：GitHub Actions 在每次探测后会自动把该地址改写成**当前仓库**，随 `cf_domains.txt` 一起提交（仅当与当前仓库不一致时才改写，一致则跳过）。

### 本地预览与部署
- 本地预览：`wrangler dev`（仓库根目录运行，根目录已有 `wrangler.toml`）。
- 部署：`wrangler deploy`，或在 Cloudflare Dashboard 连接本仓库的 Git 自动部署（Worker 自动拉取最新代码，无需额外操作）。

---

## 三、探测脚本（cf_probe_select.py）

由 GitHub Actions 定时运行，广度优先爬取外链、累积走 Cloudflare 的域名并写入 `cf_domains.txt`。

### 关键规则
- **探测阶段快速判定**：只认 IP 段硬过滤（单源系统 DNS），不判断 Server 头；CF IP 段用预合并区间 + 二分查找判定（O(log n)）。
- **多源 DNS 校验**：落盘前用系统 DNS、字节 / 360 / 腾讯 / Google / Cloudflare 共 6 套 DoH 解析源做严格校验；解析失败的源忽略，仅当成功解析的源均落在 CF 段才保留（宽松版，抗单点抖动）。
- **解析缓存复用**：探测阶段解析结果缓存，落盘前复用；缓存 IP 含非 CF 段直接剔除，避免重复多源解析。
- **连接复用**：全局 `requests.Session()` 复用 TCP/TLS 连接；`get_registered_domain()` 用 `lru_cache` 缓存。
- **并发执行**：检测 + 扩散打包为单个任务在线程池运行，加锁保护共享状态，提高 CPU/IO 利用率。
- **总量控制（≤ 400）**：落盘前若超出 400 个域名，主域配额依次从 3 动态收紧到 2、再到 1；若配额收到 1 仍超限（不同主域 > 400），在 Actions 内部对所有域名做延迟测速（GitHub 机房 → CF 节点），按延迟升序仅保留最快前 400 个，不可达域名沉底。
  - 注意：Actions 内部测速反映的是 **GitHub 机房侧**延迟，并非用户本地延迟，仅作为精简候选集的参考。
- 同一主域名最多保留 3 个子域名。
- 落盘前用 Cloudflare 官方最新 IPv4 CIDR 硬过滤，剔除非 CF 域名。

`cf_domains.txt` 每行一个纯域名，由脚本自动维护，请勿手动编辑。文件头部含更新时间（北京时间与世界时间 UTC）。

---

## 四、文件结构

| 文件 / 目录 | 作用 |
|---|---|
| `cf_probe_select.py` | GitHub Actions 探测脚本 |
| `worker/worker.js` | Cloudflare Worker（单一文件，托管前端 + 接口） |
| `wrangler.toml` | Worker 部署配置（仓库根目录） |
| `cf_domains.txt` | 探测累积的域名列表 |
| `.github/workflows/` | 定时探测工作流 |

---

## 五、常见问题

**Q：为什么某些公开 DoH 连不通？**
A：浏览器直连公开 DoH 时，服务端必须返回 CORS 头（`Access-Control-Allow-Origin`），否则 fetch 必然被拦截。腾讯 / 360 等国内 DoH 不返回该头，故已移出列表；1.1.1.1 / OpenDNS 在国内网络不可达也已移除。当前列表只保留实测支持 CORS 且可达的项（阿里、DNS.SB、Cloudflare Gateway），国际项（Google）需可访问境外网络。

**Q：fork 后网页还读的是原仓库的域名列表吗？**
A：不会。Actions 每次探测后自动把 `RAW_DOMAINS_URL` 改写成你的仓库地址并推送，Worker 随即使用正确地址。

**Q：内网自签 DoH 能否前端自动跳过证书校验？**
A：不能（浏览器安全限制）。请手动信任一次，或用 Cloudflare Tunnel 暴露为受信 https。
