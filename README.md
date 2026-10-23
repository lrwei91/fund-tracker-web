<div align="center">

# 恭喜发财 · Web 版

自托管的 A 股盯盘台：行情、板块、资讯、AI 研究报告与价格提醒收在一个浏览器页面里，服务端 7×24 常驻，关掉页面提醒照常触发。

桌面版（Tauri + Rust）的 Web 移植 —— 前端复用原 `app/` 界面，后端用零依赖 Node.js 复刻 Rust gateway 与全部本地服务。

![last commit](https://img.shields.io/github/last-commit/lrwei91/fund-tracker-web)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-blue)
![license](https://img.shields.io/badge/license-unstated-lightgrey)

<!-- 界面截图位：放入 docs/images/screenshot.png 后取消下面一行注释 -->
<!-- ![主界面](docs/images/screenshot.png) -->

<sub>仓库名 <code>fund-tracker-web</code> · 应用名沿用桌面版的「恭喜发财」</sub>

最近更新：2026-10-23

</div>

> **定位**：单人自用。内置单密码鉴权、无多租户、无注册流程，配置与凭据落在本机 `DATA_DIR`。

[功能](#功能) · [架构](#架构) · [快速开始](#快速开始) · [配置](#配置) · [部署](#部署) · [接口](#接口) · [与桌面版的差异](#与桌面版的差异) · [已知问题](#已知问题) · [FAQ](#faq) · [许可证](#许可证)

## 功能

| 分区 | 能力 |
|------|------|
| 盯盘 | 持仓与自选分组（含成本、备注）、个股详情多标签、自定义指数、持仓浮窗 |
| 市场 | 指数行情、资金流（今日/5日/10日 × 行业/概念/地域）、板块轮动、市场热度、打板情绪、行业全景融合视图（列表 ↔ 热力图共用一次取数） |
| 研究 | 机会雷达、盘中筛选、个股快照与基本面、AI 单股研究报告、报告中心（盘前 / 盘后 / 周度复盘） |
| 提醒 | 价格提醒规则 CRUD、30 秒巡检、交易时段 + 120 秒行情新鲜度校验、边沿触发 + 冷却 + 每日上限 |
| 资讯 | 财联社快讯、个股新闻、全球资讯、新闻源可切换 |
| 交互 | ⌘K 全局搜索、明暗主题、SSE 实时事件推送、浏览器通知 + 站内 toast 双通道提醒 |

## 架构

```
fund-tracker-web/
├── web/                    前端静态资源，无构建步骤、无 CDN 依赖
│   ├── index.html          主界面（盯盘 / 市场 / 研究 / 提醒 / 资讯）
│   ├── login.html          登录与首次设置密码
│   ├── widget.html         持仓浮窗（独立小窗口）
│   ├── web-shell.js        浏览器版 window.shell：配置、AI 设置、SSE、浮窗同步
│   ├── app.js              主应用装配
│   ├── theme.js            明暗主题
│   ├── config-schema.js    配置键契约
│   ├── styles.css / workbench.css / enhance.css
│   └── modules/            数据客户端、渲染、状态、工作台、watchlist 子模块
├── server/                 Node 服务，零第三方依赖
│   ├── server.js           HTTP 入口：静态服务、鉴权、/api/fetch 分发、SSE、预热
│   ├── gateway.js          上游网关：单并发 + 请求间隔 + 熔断 + 超时 + 错误码归一
│   ├── routes-data.js      20 条行情数据路由（复刻 Rust handlers 与降级链）
│   ├── symbol.js           代码规范化与市场判定
│   ├── store.js            config.json v2 存储（21 键白名单、原子写、损坏保护）
│   ├── auth.js             scrypt 密码哈希、30 天会话、登录失败锁定
│   ├── ai.js               模型调用与单股研究报告（OpenAI 兼容）
│   ├── alerts.js           价格提醒引擎（30 秒巡检）
│   ├── reports.js          报告中心（盘前 / 盘后 / 周度）
│   ├── calendar.js         2025–2026 上交所休市表
│   └── test-routes.js      路由自测（对照响应夹具）
├── test/routes.json        23 条路由的成功响应夹具
├── deploy/                 deploy.sh + systemd 单元
└── API-SPEC.md             后端复刻规格：上游 URL、降级链、错误码、存储语义
```

一次页面请求的链路：

```
浏览器 ──POST /api/fetch {path, query}──▶ server.js
                                          ├─ /price-alerts      → alerts.js
                                          ├─ /stock-ai-research → ai.js
                                          ├─ /research-reports  → reports.js
                                          └─ 其余               → routes-data.js
                                                                    └─ gateway.js ──▶ 上游行情接口
                                         ◀── 统一信封 {success, data, meta, traceId, errorCode}
```

## 快速开始

环境要求：**Node.js ≥ 18**（依赖全局 `fetch` 与 `AbortSignal.timeout`；线上实测 Node 24.x，开发机 Node 22.x）。无需 `npm install`，仓库不含 `package.json`。

```bash
git clone https://github.com/lrwei91/fund-tracker-web.git
cd fund-tracker-web
mkdir -p /tmp/stock-web-data
PORT=18765 DATA_DIR=/tmp/stock-web-data node server/server.js
```

另开一个终端确认服务就绪：

```bash
curl -s http://127.0.0.1:18765/health
# {"ok":true,"dataReady":true}
```

浏览器打开 <http://127.0.0.1:18765>，首次访问会引导你设置访问密码。

数据路由自测（对照 `test/routes.json` 夹具校验各路由返回的顶层字段）：

```bash
cd server && node test-routes.js
```

## 配置

仅三个环境变量，全部有默认值：

| 变量 | 含义 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `18765` |
| `HOST` | 监听地址 | `127.0.0.1`（不要直接对公网开放，前置反向代理或隧道） |
| `DATA_DIR` | 配置文件目录 | `server/data`（已在 `.gitignore` 中忽略） |

`DATA_DIR` 下的文件：

| 文件 | 内容 | 说明 |
|------|------|------|
| `config.json` | `{version:2, storageEncoding, updatedAt, data, private}` | 白名单 21 键，JSON 型键落盘为解析后的值、快照回成字符串；原子写，损坏时拒绝覆盖原文件 |
| `auth.json` | 访问密码的 scrypt 哈希与盐 | 删除该文件即可重设密码 |
| `ai-secret.json` | AI 服务的 API Key | 写入时 0600 权限，不下发前端 |

## 部署

`deploy/deploy.sh` 做三件事：打包 `server/ web/` → `scp` 到目标机 → 解包到 `/opt/stock-web` 并安装 `stock-web.service`。

```bash
bash deploy/deploy.sh
```

脚本里的 `SRC`（打包源目录）、`SSH`（跳板封装）与目标 IP 写的是作者本机的路径和机器，直接跑之前需按自己的环境改这三处。

systemd 单元（`deploy/stock-web.service`）以 `Restart=always` 常驻，工作目录 `/opt/stock-web/server`，`DATA_DIR=/opt/stock-web/data`。

对外访问走 Cloudflare 隧道：在服务器 `/etc/atlas-mcp/cloudflared.yml` 增加 `stock.lrwei91.online -> http://127.0.0.1:18765` 后重启 `atlas-mcp-tunnel.service`。线上实例即 <https://stock.lrwei91.online>（需访问密码）。

## 接口

业务接口都在 `/api/` 前缀下，除 `/api/auth/*` 外均需登录态（`ft_session` Cookie）；`/health` 是无鉴权探活接口。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查，返回 `dataReady` 表示数据层是否装配成功 |
| GET | `/api/auth/status` | 是否已设密码、当前是否已登录 |
| POST | `/api/auth/setup` | 首次设置访问密码 |
| POST | `/api/auth/login` | 登录，发放 30 天会话 |
| POST | `/api/auth/logout` | 登出并清除 Cookie |
| POST | `/api/fetch` | 统一数据入口，请求体 `{path, query}`，响应为统一信封 |
| GET | `/api/config` | 配置快照 |
| POST | `/api/config/patch` | 配置增量写入（白名单外键忽略） |
| GET | `/api/ai/status` | AI 设置状态（不含 Key） |
| POST | `/api/ai/save` | 保存 AI 设置与 Key，支持 `clearKey` |
| GET | `/api/events` | SSE 事件流：`price-alert-hit`、`research-report-state`、`research-report-notice` |

`/api/fetch` 的 23 条路由：

| 分组 | 路由 |
|------|------|
| 行情与个股 | `/stock` `/stock-search` `/stock-kline` `/stock-minute` `/stock-fundamentals` `/stock-research` `/stock-risk` |
| 市场全景 | `/market-data` `/sector-rotation` `/market-warnings` `/intraday-screening` `/opportunity-radar` |
| 资金与情绪 | `/fund-flow-120d` `/dragon-tiger` `/limit-up` `/hot-rank` |
| 资讯 | `/news` `/cls-news` `/global-news` `/stock-news` |
| 服务类（server.js 内建） | `/price-alerts` `/stock-ai-research` `/research-reports` |

请求参数、上游地址、降级链与错误码定义见 [`API-SPEC.md`](API-SPEC.md)。

统一信封：成功 `{success:true, data, meta, traceId, errorCode:null, retryable:false}`；失败 `{success:false, message, error, errorCode, retryable, meta}`。错误码全集 `forbidden` / `rate_limited` / `upstream_5xx` / `upstream_4xx` / `timeout` / `circuit_open` / `empty_data` / `parse_error` / `invalid_input` / `upstream_error`。

## 与桌面版的差异

| 能力 | 桌面版 | Web 版 |
|------|--------|--------|
| 持仓浮窗 | Tauri 独立窗口，可置顶常驻 | 浏览器小窗口 + `BroadcastChannel` 同步，无法置顶到系统层 |
| 提醒呈现 | 原生系统通知 | 浏览器 Notification + 站内 toast + 提示音（页面打开时；服务端引擎保证页面关闭时照常触发，回页面可见记录） |
| AI Key | 存系统钥匙串 | 存服务端 `ai-secret.json`（0600），不下发前端 |
| 访问控制 | 无（本机应用） | 网站自设密码 + 30 天会话，与桌面版无关 |
| K 线 / 分时 | 可选 tdxrs 本地源 | 无本地进程，等同桌面版未配置 `TDXRS_BIN` / `TDXRS_PYTHON` 时的行为 |
| 时间戳格式 | RFC3339（`+00:00`） | ISO 8601（`Z`），语义等价 |
| 网关熔断 | 默认 300s | 60s（`createGateway({circuitOpenMs})`），为云 IP 限流做更快的自愈 |
| 交易日历 | 覆盖 2025–2026 | 同左：2027 年起自动报告停跑，需补休市表 |

## 已知问题

**`push2.eastmoney.com` 对云服务器 IP 偶发 TLS 层限流。** 受影响的是只走该 host 的三个接口：涨跌家数（`market-data?type=breadth`）、板块全景（`market-data?type=sector-panorama`）、东财热榜（`hot-rank?source=em`）。2026-10-22 凌晨实测：01:35 正常，01:58 起连接重置，同 IP 的 `push2his` / `push2ex` 不受影响。

已上线的缓解措施：

1. 网关熔断时长 300s → 60s，缩短占用窗口；
2. `breadth` / `sector-panorama` 接入 endpoint stale 回放（1800s），上游抖动时返回 `meta.stale=true` 的旧数据而非报错；
3. 交易时段（工作日 08:30–15:45）每 90 秒预热这两个接口填充缓存；
4. DNS 结果 IPv4 优先（服务器无 IPv6 出口）。

限流解除后自动恢复。期间这两个区块可能显示略旧数据或暂时不可用，其余功能（行情、K 线、资金流、资讯、研究、提醒、报告）不受影响。

**交易日历只到 2026 年。** 2027 年起自动报告任务会停跑（价格提醒不依赖日历），需在 `server/calendar.js` 补新一年休市表。

## FAQ

**忘了访问密码怎么办？**
删除 `DATA_DIR/auth.json` 后重启服务，下次访问会重新引导设置密码。`config.json` 不受影响。

**为什么某些板块提示数据略旧或不可用？**
东财 `push2` 对云 IP 限流，见「已知问题」。`meta.stale` 为 `true` 时数据可用但非最新，`meta.staleAgeSeconds` 给出落后秒数。

**能不能多人共用、加注册？**
不能。设计上就是单密码单用户，没有账号体系与数据隔离。

**没有 `package.json`，怎么装依赖？**
后端只用 Node 内置模块（`node:http` / `node:crypto` / `node:fs` / `node:path`）和全局 `fetch`，前端是原生 ES 模块，没有构建步骤，克隆即可运行。

**可以直接把 18765 端口暴露到公网吗？**
不建议。默认只监听 `127.0.0.1`，对外请走反向代理或隧道，并保持访问密码开启。

## 许可证

仓库当前**未包含 `LICENSE` 文件**。未声明许可证时默认保留所有权利（All rights reserved），他人不获得复制、修改或再分发授权。

个人项目，欢迎开 issue 讨论；如需引用或再分发，请先联系作者。
