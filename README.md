# cf-probe-select

CF 探测优选 —— 自动挖掘使用 Cloudflare 的第三方站点，并在网页端实时测速，帮你挑出最快的节点。

- 🔍 **探测**：顺着网页外链自动发现走 Cloudflare CDN 的域名，由 GitHub Actions 定时累积。
- ⚡ **测速**：通过 Cloudflare Worker 提供的网页，在你的浏览器侧对每个域名实时测速。
- 🏆 **优选**：按响应延迟动态排序，自行复制并使用最快的节点。

测速网页部署说明见 `worker/README.md`。
