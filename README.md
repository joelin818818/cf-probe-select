# cf-probe-select

CF 探测优选 —— 自动挖掘使用 Cloudflare 的第三方站点，并在网页端实时测速，帮你挑出最快的节点。

- 探测：顺着网页外链自动发现走 Cloudflare CDN 的域名，由 GitHub Actions 定时累积。
- 测速：通过 Cloudflare Worker 提供的网页，在你的浏览器侧对每个域名实时测速。
- 优选：按测速成功率与延迟动态排序，自行复制并使用最快的节点。

## 测速网页（Cloudflare Worker）

将探测得到的域名通过 Cloudflare Worker 提供网页，在你浏览器侧实时测速并排序，自行选择最快节点。

测速机制：
- 测速在浏览器侧完成，真实反映你到各节点的延迟。
- 每个域名测 3 轮，轮间间隔 2 秒（避免瞬时拥塞），取平均成绩；同时并发上限为 10 个域名。
- 延迟列展示 3 轮成绩（数字 = 毫秒，T = 超时，E = 失败）与平均成绩。
- 默认排序按「成功率（成功轮数 / 3）降序 → 平均延迟升序」；未出结果 / 测速中的域名沉底按原始序号排列。
- 表头（域名 / IP / CF 判定 / 延迟 / 状态）均可点击切换排序。
- 域名列表由 Worker 从 GitHub 实时拉取（`?t=` 时间戳 + `no-store` 响应头绕过缓存），「刷新域名」按钮可手动重新拉取。

IP 展示：
- 每个域名解析前 3 个 A 记录 IP，并用 Cloudflare 官方 IPv4 CIDR 判定是否落在 CF 段（✓CF / ✗非CF）。
- IP 列仅展示 IP 与 CF 判定，不再展示国家归属地。

本地预览：`wrangler dev`（从仓库根目录运行，根目录已有 `wrangler.toml`）。
部署：`wrangler deploy`，或在 Cloudflare Dashboard 连接本仓库的 Git 自动部署（Worker 自动拉取最新代码）。

## 探测脚本（cf_probe_select.py）

由 GitHub Actions 定时运行，广度优先爬取外链、累积走 Cloudflare 的域名并写入 `cf_domains.txt`。

关键规则：
- 多源 DNS 校验：用系统 DNS、字节 / 360 / 腾讯 / Google / Cloudflare 共 6 套 DoH 解析源做落盘前校验，解析失败的源忽略，仅当成功解析的源均落在 CF 段才保留（宽松版，抗单点抖动）。
- 落盘前用 Cloudflare 官方最新 IPv4 CIDR 硬过滤，剔除非 CF 域名。
- 同一主域名最多保留 3 个子域名。
- 总量控制（≤ 400）：落盘前若超出 400 个域名，主域配额依次从 3 动态收紧到 2、再到 1；若配额收到 1 仍超限（即不同主域 > 400），在 Actions 内部对所有域名做延迟测速（GitHub 机房 → CF 节点），按延迟升序仅保留最快前 400 个，不可达域名沉底。
- 注意：Actions 内部测速反映的是 GitHub 机房侧延迟，并非用户本地延迟，仅作为精简候选集的参考。

`cf_domains.txt` 每行一个纯域名，由脚本自动维护，请勿手动编辑。文件头部含更新时间（北京时间与世界时间 UTC）。

## 文件结构

- `cf_probe_select.py`：GitHub Actions 探测脚本。
- `worker/worker.js`：Cloudflare Worker（单一文件，托管前端 + 接口）。
- `wrangler.toml`：Worker 部署配置（位于仓库根目录）。
- `cf_domains.txt`：探测累积的域名列表。
- `.github/workflows/`：定时探测工作流。
