# CF 探测优选（CF-PROBE-SELECT）

自动挖掘走 Cloudflare 的第三方站点，并在网页端实时测速，帮你挑出最快的节点。

## 功能

- **探测**：GitHub Actions 定时顺着网页外链自动发现走 Cloudflare CDN 的域名，累积写入 `cf_domains.txt`。
- **测速**：Cloudflare Worker 提供网页，在你的浏览器侧对每个域名实时测速。
- **优选**：按成功率与延迟动态排序，自行复制并使用最快的节点。

## 测速网页

测速全部在你的浏览器侧完成，真实反映你到各节点的延迟。

![CF 探测优选测速页](assets/screenshot.png)

- 每个域名测 3 轮，轮间间隔约 2 秒，取平均成绩。
- 解析 / 测速并发数可在页面顶部调整（默认 8 / 10，范围 1–32），存于 `localStorage`。
- 延迟列展示 3 轮成绩（数字 = 毫秒，`T` = 超时，`E` = 失败）与平均成绩。
- 表头（域名 / IP / CF 判定 / 延迟 / 状态）均可点击切换排序。
- 测速前统一预检所选 DNS 是否可用，不可用时弹窗提示。
- 每个域名解析前 3 个 A 记录 IP，并用 Cloudflare 官方 IPv4 CIDR 判定是否落在 CF 段（`✓CF` / `✗非CF`）。
- 域名列表由 Worker 从 GitHub raw 实时拉取，「刷新域名」按钮可手动重新拉取。

### DNS 服务商

除「本地」外，所有 DoH 均由浏览器直连发起（服务端不解析 DNS）。

| 选项 | 地址 | 说明 |
|---|---|---|
| 本地（服务端 DNS） | — | Worker 边缘递归解析 |
| 阿里 DoH（国内） | `dns.alidns.com/resolve` | 国内直连可用 |
| DNS.SB DoH（香港） | `doh.dns.sb/dns-query` | 亚洲节点 |
| Cloudflare Gateway DoH | `*.cloudflare-gateway.com/dns-query` | 国内可直连 |
| Google DoH（国际） | `dns.google/resolve` | 需访问境外网络 |
| 自定义 DoH | 自填 | 浏览器直连 |

内网自签 DoH：浏览器无法忽略证书错误，需先在浏览器手动信任该地址（直接打开并点「继续」），或用 Cloudflare Tunnel 暴露为受信 https。

### 域名列表地址

网页从 `RAW_DOMAINS_URL` 指定的地址拉取 `cf_domains.txt`：
- 优先读取 `wrangler.toml` 的 `[vars] RAW_DOMAINS_URL`；
- 未配置时回退代码内默认值；
- fork 后 GitHub Actions 自动把该地址改写为当前仓库地址并提交。

本地预览：`wrangler dev`（仓库根目录运行，根目录已有 `wrangler.toml`）。
部署：`wrangler deploy`，或在 Cloudflare Dashboard 连接本仓库的 Git 自动部署。

## 探测脚本

由 GitHub Actions 定时运行，广度优先爬取外链、累积走 Cloudflare 的域名。

- 探测阶段：单源系统 DNS + CF IP 段硬过滤（不认 Server 头），CF IP 段用二分查找判定。
- 落盘前：6 套 DoH（系统 / 字节 / 360 / 腾讯 / Google / Cloudflare）严格校验，成功解析的源均落在 CF 段才保留。
- 解析结果缓存复用；全局 `requests.Session()` 复用连接；`get_registered_domain()` 用 `lru_cache` 缓存。
- 探测与扩散并发执行（线程池 + 锁保护共享状态）。
- 同一主域名最多保留 3 个子域名。
- 总量上限 400：超出时主域配额从 3 依次收紧到 2、1；仍超限则在 Actions 内按「GitHub 机房 → CF 节点」延迟升序保留最快前 400（不可达沉底）。

`cf_domains.txt` 每行一个纯域名，由脚本自动维护，请勿手动编辑。文件头部含更新时间（北京时间与世界时间 UTC）。

## 文件结构

| 文件 / 目录 | 作用 |
|---|---|
| `cf_probe_select.py` | GitHub Actions 探测脚本 |
| `worker/worker.js` | Cloudflare Worker（托管前端 + 接口） |
| `wrangler.toml` | Worker 部署配置（根目录） |
| `cf_domains.txt` | 探测累积的域名列表 |
| `.github/workflows/` | 定时探测工作流 |
