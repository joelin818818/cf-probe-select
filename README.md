# cf-probe-select

CF 探测优选 —— 一个轻量级命令行工具，从任意种子站点出发，顺着网页外链自动挖掘使用 Cloudflare 的第三方站点，再对每个站点进行响应速度测试，按耗时推优排序，产出一份「CF 冷门优选榜」。

## 功能

- 🔍 **探测**：广度优先爬取，自动识别走 Cloudflare CDN 的域名
- ⚡ **测速**：批量检测站点响应速度（规划中）
- 🏆 **优选**：响应快的优先排列，生成优选清单（规划中）

## 当前阶段：自动探测

通过 GitHub Actions 每天自动运行一轮探测，结果累积写入仓库根目录的 `cf_domains.txt`。

### 工作原理

1. **自举滚动种子**：若 `cf_domains.txt` 已有数据，则每轮随机抽取若干个历史域名作为本轮起点；若文件为空，则使用内置自举种子 `cloudflare.com`（其页面外链极多，是天然域名矿），随后靠历史数据自我繁衍。
2. **探测**：广度优先爬取外链，识别走 Cloudflare 的第三方域名。
3. **聚合控制**：同一主域名（registered domain）最多保留 3 个子域名，防止单域刷屏。
4. **限时**：每次运行由外层 `timeout 120` 限制为 2 分钟，超时自动终止；脚本边探测边落盘，中断不丢数据。
5. **回推**：Actions 将更新后的 `cf_domains.txt` 自动提交回仓库。

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
├── cf_probe_select.py           # 阶段一：CF 站点发现与入库（GitHub Actions 运行）
├── probe_speed.py               # 阶段二（规划）：服务端/批量测速参考实现
├── select_rank.py               # 阶段三（规划）：按速度推优排序参考实现
├── worker/                      # Cloudflare Worker 测速前端（浏览器侧实时测速）
│   ├── worker.js                # Worker 主程序 + 内嵌网页
│   └── README.md                # Worker 使用说明
├── wrangler.toml                # Worker 部署配置（放在根目录以便 Dashboard 自动识别）
├── cf_domains.txt               # 探测结果（自动累积，供 Worker 读取）
└── README.md
```

## ⚠️ 安全与敏感信息（公开仓库必读）

**本仓库是公开的，严禁提交任何敏感信息**（API Key、Token、密码、私钥、个人数据等）。

本项目的自动探测阶段**不依赖任何密钥**，可安全运行。若你将来要扩展功能（例如调用 AI 生成描述、使用第三方测速 API），请通过 **GitHub Actions Secrets** 注入，切勿硬编码到代码或提交到仓库。

### 如何在 GitHub 设置变量 / 密钥

1. 打开仓库页面 → **Settings**（设置）
2. 左侧菜单 → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**（新建仓库密钥）：
   - **Name**：变量名，例如 `MY_API_KEY`
   - **Secret**：变量值（密钥内容）
4. 在代码中只通过环境变量读取，**绝不打印或写入文件**：

   ```python
   import os
   api_key = os.environ.get("MY_API_KEY")  # 安全：仅运行时读取
   ```

5. 在 `.github/workflows/*.yml` 中引用（无需明文）：

   ```yaml
   env:
     MY_API_KEY: ${{ secrets.MY_API_KEY }}
   ```

> 原则：**代码里只出现 `os.environ.get("XXX")`，仓库里只出现 `${{ secrets.XXX }}`，真实的密钥只存在于 GitHub 设置页。**

## 路线图

1. ✅ 阶段一：发现使用 Cloudflare 的第三方站点，写入 `cf_domains.txt`（支持 Actions 自动探测）
2. 🚧 阶段二：测速与优选 —— 已搭建 `worker/` Cloudflare Worker 前端，在**浏览器侧**对每个域名实时测速并动态排序，用户自行选择最快节点（详见 `worker/README.md`）。`probe_speed.py` / `select_rank.py` 保留为批量/服务端参考实现。
3. 🚧 阶段三：按响应耗时升序排序，生成优选榜（前端已支持按延迟实时排序）

## 许可证

MIT
