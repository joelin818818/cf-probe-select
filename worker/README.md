# 测速前端 Worker

将探测得到的域名通过 Cloudflare Worker 提供网页，在你浏览器侧实时测速并排序，自行选择最快节点。

- 测速在浏览器完成，真实反映你到各节点的延迟
- Worker 仅托管网页并代理读取域名列表，无需密钥

本地预览：`wrangler dev`（从仓库根目录运行，根目录已有 `wrangler.toml`）。
部署：`wrangler deploy`，或在 Cloudflare Dashboard 连接本仓库的 Git 自动部署。
