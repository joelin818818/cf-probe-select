# 测速前端 Worker

将 `cf_domains.txt` 的探测结果，通过 Cloudflare Worker 提供网页，让用户**在浏览器侧实时测速**并动态排序，自行选择最快节点。

## 架构

```
GitHub Actions 探测 -> cf_domains.txt (仓库累积)
                              │
              Worker /api/domains 代理读取 raw.githubusercontent.com
                              │
              浏览器网页：对每个域名 HEAD 测速 + 实时排序 + 点击复制
```

- 测速在**用户浏览器**完成，真实反映用户到各 CF 节点的延迟
- Worker 仅做静态网页托管 + 域名列表代理，无需密钥、无状态

## 本地开发

```bash
npm install -g wrangler
# 从仓库根目录运行（wrangler.toml 位于根目录）
wrangler dev        # 默认 http://localhost:8787
```

## 部署

### 方式一：命令行（推荐）

```bash
wrangler deploy
```

### 方式二：Cloudflare Dashboard（Git 自动部署）

1. 在 Cloudflare Dashboard 进入 **Workers & Pages** → **创建**
2. 选择 **连接到 Git** → 授权你的 GitHub 账号 → 选择 `joelin818818/cf-probe-select`
3. 框架预设保持默认，部署命令留空；Wrangler 会自动读取根目录的 `wrangler.toml`
4. 点击 **保存并部署**

之后每次推送到 `main` 分支，Cloudflare 都会自动重新部署。

部署后访问分配的 `*.workers.dev` 域名即可。可在 `wrangler.toml` 中绑定自定义域名。

## 路由

| 路径           | 说明                                  |
| -------------- | ------------------------------------- |
| `/`            | 测速网页                              |
| `/api/domains` | 返回 `{count, domains}`，来自仓库 txt |
| `/api/health`  | 健康检查                              |

## 说明

- 单域名超时 8 秒（`TIMEOUT` 常量，在 `worker.js` 前端脚本内）。
- 使用 `no-cors` + `HEAD` 计时，跨域站点虽拿不到响应体但可计时延迟。
- 域名列表每次请求缓存 60 秒，避免频繁打 GitHub。
