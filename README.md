# cf-probe-select

CF 探测优选 —— 自动挖掘使用 Cloudflare 的第三方站点，并在网页端实时测速，帮你挑出最快的节点。

- 🔍 **探测**：顺着网页外链自动发现走 Cloudflare CDN 的域名，由 GitHub Actions 定时累积。
- ⚡ **测速**：通过 Cloudflare Worker 提供的网页，在你的浏览器侧对每个域名实时测速。
- 🏆 **优选**：按响应延迟动态排序，自行复制并使用最快的节点。

## 测速网页

将探测得到的域名通过 Cloudflare Worker 提供网页，在你浏览器侧实时测速并排序，自行选择最快节点。

- 测速在浏览器侧完成，真实反映你到各节点的延迟
- 网页同时展示每个域名的前 3 个 IP 及其归属地（如美国、荷兰等）
- Worker 仅托管网页并代理读取域名列表，无需密钥

本地预览：`wrangler dev`（从仓库根目录运行，根目录已有 `wrangler.toml`）。
部署：`wrangler deploy`，或在 Cloudflare Dashboard 连接本仓库的 Git 自动部署。
