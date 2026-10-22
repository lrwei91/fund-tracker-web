# 恭喜发财 · Web 版

桌面版（fund-tracker-desktop，Tauri+Rust）的 Web 移植：前端复用原 app/ 界面，后端用 Node.js 复刻 Rust gateway 与本地服务，部署在广州服务器，经 Cloudflare 隧道以 https://stock.lrwei91.online 提供服务。

## 架构

- `web/`：前端（源自桌面版 app/）。改动点：
  - `modules/data-client.js`：数据通道由 Tauri invoke 改为 `POST /api/fetch {path, query}`，在途合并/错误归一语义不变。
  - `web-shell.js`（替代 tauri-shell.js）：以 HTTP/SSE/BroadcastChannel 实现 `window.shell`：配置读写、AI 设置、SSE 事件（price-alert-hit、research-report-state/notice）、持仓浮窗（独立小窗口 widget.html + BroadcastChannel 同步）、showStockAlert 走浏览器 Notification + 站内 toast 兜底。不提供 update* 方法（设置页显示桌面专属）。
  - `login.html`：未登录时由服务端顶替 index.html 返回；首次访问自设密码。
  - `widget.html`：持仓浮窗页。
  - `modules/web-enhance.js` + `enhance.css`（借鉴 OpenStock）：⌘K 全局搜索、多标签个股详情（包装 AppWorkbench.openDetail）、技术指标显示偏好（localStorage 持久化）、行业全景融合视图（2026-10-22 改版：热力图不再单独取数，直接读全景列表的渲染结果重组瓷砖，与列表共用数据/状态/刷新；切换控件在卡片体顶部工具条，含涨跌图例，热力图按涨幅排序，视图选择持久化）。
- `server/`：零依赖 Node 服务（`server.js` 入口，监听 127.0.0.1:18765）。
  - `gateway.js` + `routes-data.js`：行情网关（东财单并发+间隔+熔断、TTL 缓存、在途合并）与 17 条数据路由，规格见 `API-SPEC.md`。
  - `store.js`：config.json v2 存储，语义与桌面 config.rs 对齐（白名单 21 键、JSON 型键快照为字符串、原子写、损坏保护）。
  - `auth.js`：密码 scrypt 哈希（auth.json）、会话 30 天、登录失败锁定。
  - `ai.js`：AI 设置与凭据（Key 只存服务端 ai-secret.json，600 权限）、模型调用（OpenAI 兼容、手动优先信号量、15 分钟缓存）、单股报告校验。
  - `alerts.js`：价格提醒 CRUD + 30 秒监控引擎（交易时段+120 秒新鲜度、边沿/冷却/每日上限）。
  - `reports.js`：报告中心（盘前 09:00–09:25 / 盘后 15:30–16:30 自动、错过记 missed、每日自动上限 2 次）+ 周度复盘（slot=weekly，周五 16:40–18:00）。
  - `calendar.js`：硬编码 2025/2026 上交所休市表，未知年份不授权自动任务。
  - 数据目录（DATA_DIR）：config.json / auth.json / ai-secret.json。

## 本地运行

```bash
cd server && PORT=18765 DATA_DIR=/tmp/stock-test node server.js
curl http://127.0.0.1:18765/health
```

## 部署

`bash deploy/deploy.sh`（打包 → scp → systemd stock-web.service）；隧道 ingress 在服务器 `/etc/atlas-mcp/cloudflared.yml` 增加 `stock.lrwei91.online -> http://127.0.0.1:18765` 后重启 `atlas-mcp-tunnel.service`。systemd 单元的持久副本在 `deploy/stock-web.service`（WantedBy=default.target）。

## 已知问题：push2.eastmoney.com 对云 IP 限流

涨跌家数（breadth）、板块全景（sector-panorama）、东财热榜（hot-rank source=em）只走 push2.eastmoney.com。该 host 对广州服务器 IP 偶发 TLS 层限流（连接重置），2026-10-22 凌晨实测：01:35 正常、01:58 起被限流（push2his/push2ex 同 IP 正常）。缓解已上线：①网关熔断时长 300s→60s（createGateway({circuitOpenMs})，桌面规格默认不变）；②breadth/sector-panorama 接入 endpoint stale 回放（1800s）；③交易时段（工作日 08:30–15:45）每 90 秒预热这两个接口填充缓存；④DNS ipv4first（服务器无 IPv6 出口）。限流解除后自动恢复，期间这两个区块可能显示略旧数据或暂时不可用，其余功能（行情/K线/资金流/新闻/研究/提醒/报告）不受影响。

## 与桌面版的差异

- 持仓浮窗 → 独立浏览器小窗口（不能置顶常驻系统层）；提醒弹窗 → 浏览器通知 + 站内 toast + 提示音（页面打开时）；服务器引擎保证页面关掉时提醒/报告照常运行，命中记录回页面后可见。
- AI Key 存服务端，不再用系统钥匙串；访问密码为网站自设，与桌面版无关。
- 交易日历只覆盖 2025–2026 年，2027 年起自动报告/提醒的报告类任务停跑（价格提醒不受日历影响），需补新一年休市表。
