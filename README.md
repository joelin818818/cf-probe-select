# cf-probe-select

CF 探测优选 —— 一个轻量级命令行工具，从任意种子站点出发，顺着网页外链自动挖掘使用 Cloudflare 的第三方站点，再对每个站点进行响应速度测试，按耗时推优排序，产出一份「CF 冷门优选榜」。

## 功能

- 🔍 **探测**：广度优先爬取，自动识别走 Cloudflare CDN 的域名
- ⚡ **测速**：批量检测站点响应速度（规划中）
- 🏆 **优选**：响应快的优先排列，生成优选清单（规划中）

## 快速开始

```bash
# 安装依赖
pip install requests beautifulsoup4 tldextract

# 运行探测
python cf_probe_select.py
# 按提示输入起始域名，例如 blog.cloudflare.com
```

## 项目结构

```
cf-probe-select/
├── cf_probe_select.py   # 阶段一：CF 站点发现与入库
├── probe_speed.py       # 阶段二（规划）：响应速度测试
├── select_rank.py       # 阶段三（规划）：按速度推优排序
└── README.md
```

## 路线图

1. ✅ 阶段一：发现使用 Cloudflare 的第三方站点，写入 `cf_domains.txt`
2. 🚧 阶段二：对清单内站点做响应速度测试
3. 🚧 阶段三：按响应耗时升序排序，生成 `cf_domains_ranked.txt` 优选榜

## 许可证

MIT
