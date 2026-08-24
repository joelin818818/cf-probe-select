# cf-probe-select

CF 探测优选 —— 一个轻量级命令行工具，从任意种子站点出发，顺着网页外链自动挖掘使用 Cloudflare 的第三方站点，再对每个站点进行响应速度测试，按耗时推优排序，产出一份「CF 冷门优选榜」。

## 功能

- 🔍 **探测**：广度优先爬取，自动识别走 Cloudflare CDN 的域名（GitHub Actions 自动累积）
- ⚡ **测速**：Cloudflare Worker 网页前端，在**用户浏览器侧**对每个域名实时测速
- 🏆 **优选**：按响应延迟动态排序，用户自行选择最快节点

## 当前阶段：探测 + 测速前端

- **探测**：通过 GitHub Actions 自动运行，结果累积写入仓库根目录的 `cf_domains.txt`。
- **测速前端**：`worker/` 目录下的 Cloudflare Worker，读取 `cf_domains.txt` 并在网页里实时测速排序（详见 `worker/README.md`）。

### 探测工作原理

1. **自举滚动种子**：若 `cf_domains.txt` 已有数据，则每轮随机抽取若干个历史域名作为本轮起点；若文件为空，则使用内置自举种子 `cloudflare.com`（其页面外链极多，是天然域名矿），随后靠历史数据自我繁衍。
2. **探测**：广度优先爬取外链，识别走 Cloudflare 的第三方域名。
3. **聚合控制**：同一主域名（registered domain）最多保留 3 个子域名，防止单域刷屏。
4. **巨型站处理**：`BIG_TECH_ROOTS` 里的巨型科技站仅作矿源——**不入库**但**允许抓取其页面外链**继续扩散，避免冷门源太少。CF 官方资产（`CF_OWN_ROOT_DOMAINS`）同样不入库但参与扩散。
5. **优雅限时**：每次运行由脚本自身 `PROBE_TIME_LIMIT`（默认 30 秒，位于 `cf_probe_select.py` 顶部配置区）计时停止，进入收尾写盘；不使用外部 `timeout` 强杀进程，中断不丢数据。
6. **回推**：Actions 将更新后的 `cf_domains.txt` 自动提交回仓库。

### 输出格式

`cf_domains.txt` 每行一个纯域名（不含描述、不含序号）：

```
cdn.jsdelivr.net
esm.sh
www.npmjs.com
```

## 本地运行

```bash
pip install requests beautifulsoup4 tldextract
python cf_probe_select.py
```

## 项目结构

```
cf-probe-select/
├── .github/workflows/probe.yml  # GitHub Actions：定时探测 + 回推
├── cf_probe_select.py           # 探测脚本：CF 站点发现与入库
├── worker/                      # Cloudflare Worker 测速前端（浏览器侧实时测速）
│   ├── worker.js                # Worker 主程序 + 内嵌网页
│   └── README.md                # Worker 使用说明
├── wrangler.toml                # Worker 部署配置（根目录，Dashboard 自动识别）
├── cf_domains.txt               # 探测结果（自动累积，供 Worker 读取）
└── README.md
```

## 路线图

1. ✅ 阶段一：发现使用 Cloudflare 的第三方站点，写入 `cf_domains.txt`（GitHub Actions 自动探测）
2. ✅ 阶段二：测速与优选 —— `worker/` Cloudflare Worker 前端，在**浏览器侧**对每个域名实时测速并动态排序，用户自行选择最快节点（详见 `worker/README.md`）
3. 🚧 阶段三：可选增强 —— 服务端批量预测速、连续多次取均值提升排序稳定性等

## 许可证

MIT
