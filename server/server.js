'use strict';
// 恭喜发财 Web 版服务：静态前端 + 登录鉴权 + /api/fetch 数据分发 + 配置/AI/事件接口。
// 数据路由（gateway/routes-data）由独立模块提供，缺失时数据接口返回不可用（其余功能可先行验证）。
// 服务器无 IPv6 出口：DNS 结果 IPv4 优先，避免 fetch 选中不可达的 AAAA 地址白白失败。
try { require('dns').setDefaultResultOrder('ipv4first'); } catch { /* ignore */ }
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ConfigStore } = require('./store');
const { Auth } = require('./auth');

const PORT = Number(process.env.PORT || 18765);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = path.join(__dirname, '..', 'web');

const store = new ConfigStore(path.join(DATA_DIR, 'config.json'));
const auth = new Auth(path.join(DATA_DIR, 'auth.json'));

// ---- SSE 事件总线（替代 Tauri 事件）----
const sseClients = new Set();
function emit(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
  for (const res of sseClients) { try { res.write(frame); } catch { /* ignore */ } }
}

// ---- 数据层（子模块就绪后接入）----
let gateway = null;
let dataRoutes = null;
try {
  const { createGateway } = require('./gateway');
  const { createDataRoutes } = require('./routes-data');
  gateway = createGateway({ circuitOpenMs: 60 * 1000 });
  dataRoutes = createDataRoutes(gateway);
} catch (e) {
  console.error('[stock-web] 数据层未就绪：', e.message);
}
async function fetchDataRoute(routePath, query) {
  if (!dataRoutes) return { success: false, message: '数据服务未就绪', errorCode: 'upstream_error', retryable: true };
  return dataRoutes.handle(routePath, query);
}
async function getQuotes(codes) {
  const res = await fetchDataRoute('/stock', { codes: codes.join(',') });
  return res && res.success ? res.data : null;
}
async function getSnapshot(code) {
  return fetchDataRoute('/stock-research', { code });
}

// ---- 本地服务 ----
const { AiService } = require('./ai');
const { PriceAlerts } = require('./alerts');
const { ReportCenter } = require('./reports');
const ai = new AiService({ store, dataDir: DATA_DIR, gateway, getSnapshot });
const alerts = new PriceAlerts({ store, getQuotes, emit });
const reports = new ReportCenter({ store, ai, getSnapshot, getQuotes, emit });

// ---- 响应信封 finalize（对齐 policy.rs）----
const FAILURE_MESSAGES = {
  timeout: '上游响应超时，请稍后重试',
  circuit_open: '数据源熔断中，请稍后重试',
  forbidden: '上游拒绝访问，请稍后重试',
  rate_limited: '上游限流，请稍后重试',
};
function finalize(result) {
  const r = result && typeof result === 'object' ? result : { success: false, message: '服务异常', errorCode: 'upstream_error', retryable: true };
  if (r.traceId == null) r.traceId = crypto.randomUUID();
  if (!r.meta || typeof r.meta !== 'object') r.meta = {};
  if (r.success) {
    r.errorCode = null;
    r.retryable = false;
    if (r.meta.available == null) r.meta.available = true;
    if (r.meta.degraded == null) r.meta.degraded = false;
    if (r.meta.stale == null) r.meta.stale = false;
    if (r.meta.actualSource === undefined) {
      let actual = null;
      const sources = r.meta.sources;
      if (sources && typeof sources === 'object') {
        for (const v of Object.values(sources)) if (v && typeof v === 'object' && v.actual) { actual = v.actual; break; }
      }
      r.meta.actualSource = actual;
    }
  } else {
    const code = r.errorCode || r.error || 'upstream_error';
    r.errorCode = code;
    r.error = code;
    if (!r.message) r.message = FAILURE_MESSAGES[code] || '数据接口不可用';
    if (r.retryable == null) r.retryable = !['invalid_input', 'upstream_4xx'].includes(code);
    r.meta.available = false;
    if (r.meta.degraded == null) r.meta.degraded = false;
    if (r.meta.stale == null) r.meta.stale = false;
  }
  return r;
}

// ---- endpoint stale 缓存（policy.rs 策略表）----
const STALE_FOR = {
  '/opportunity-radar': 600,
  '/stock-fundamentals': 3600,
  '/stock-search': 1800, '/hot-rank': 1800, '/limit-up': 1800, '/cls-news': 1800,
  '/global-news': 1800, '/news': 1800, '/stock-news': 1800, '/stock-risk': 1800,
  '/dragon-tiger': 1800, '/fund-flow-120d': 1800, '/stock-kline': 1800,
  '/market-warnings': 1800, '/sector-rotation': 1800,
};
const endpointCache = new Map();
function stableQueryKey(routePath, query) {
  const entries = Object.entries(query || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return `${routePath}|${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
}
async function dispatchData(routePath, query) {
  // market-data 仅 breadth / sector-panorama 允许 stale 回放（指数等实时类不回放）。
  let staleFor = STALE_FOR[routePath] || 0;
  if (routePath === '/market-data') {
    staleFor = (query && (query.type === 'breadth' || query.type === 'sector-panorama')) ? 1800 : 0;
  }
  const key = staleFor > 0 ? stableQueryKey(routePath, query) : null;
  let result;
  if (routePath === '/price-alerts') result = alerts.handle(query);
  else if (routePath === '/stock-ai-research') result = await ai.handle(query);
  else if (routePath === '/research-reports') result = reports.handle(query);
  else result = await fetchDataRoute(routePath, query);
  result = finalize(result);
  if (key) {
    if (result.success) {
      endpointCache.set(key, { at: Date.now(), response: JSON.parse(JSON.stringify(result)) });
      if (endpointCache.size > 128) endpointCache.delete(endpointCache.keys().next().value);
    } else {
      const cached = endpointCache.get(key);
      if (cached && (Date.now() - cached.at) / 1000 <= staleFor) {
        const stale = JSON.parse(JSON.stringify(cached.response));
        stale.traceId = crypto.randomUUID();
        stale.meta.stale = true;
        stale.meta.staleAgeSeconds = Math.floor((Date.now() - cached.at) / 1000);
        stale.meta.updatedAt = new Date(cached.at).toISOString();
        if (!stale.meta.fallbackReason) stale.meta.fallbackReason = 'endpoint-cache-stale';
        stale.meta.degraded = true;
        return stale;
      }
    }
  }
  return result;
}

// ---- HTTP 基础 ----
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) { return auth.check(parseCookies(req).ft_session); }
function sessionCookie(req, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `ft_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`;
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  if ((rel === '/index.html') && !isAuthed(req)) rel = '/login.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/health') { sendJson(res, 200, { ok: true, dataReady: !!dataRoutes }); return; }

    if (p === '/api/auth/status') {
      sendJson(res, 200, { setup: auth.isSetup(), authed: isAuthed(req) });
      return;
    }
    if (p === '/api/auth/setup' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const token = auth.setup(String(body.password || ''));
        res.setHeader('set-cookie', sessionCookie(req, token));
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 400, { ok: false, message: e.message }); }
      return;
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const token = auth.login(String(body.password || ''));
        res.setHeader('set-cookie', sessionCookie(req, token));
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 401, { ok: false, message: e.message }); }
      return;
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      auth.logout(parseCookies(req).ft_session);
      res.setHeader('set-cookie', 'ft_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p.startsWith('/api/')) {
      if (!auth.isSetup()) { sendJson(res, 401, { success: false, message: '尚未设置访问密码', errorCode: 'unauthorized', retryable: false }); return; }
      if (!isAuthed(req)) { sendJson(res, 401, { success: false, message: '未登录', errorCode: 'unauthorized', retryable: false }); return; }
      if (p === '/api/fetch' && req.method === 'POST') {
        const body = await readJson(req);
        const routePath = String(body.path || '');
        const query = {};
        for (const [k, v] of Object.entries(body.query || {})) query[k] = String(v ?? '');
        const result = await dispatchData(routePath, query);
        sendJson(res, 200, result);
        return;
      }
      if (p === '/api/config' && req.method === 'GET') { sendJson(res, 200, store.load()); return; }
      if (p === '/api/config/patch' && req.method === 'POST') {
        const body = await readJson(req);
        try { sendJson(res, 200, store.patch(body.changes || {})); }
        catch (e) { sendJson(res, 400, { success: false, message: e.message }); }
        return;
      }
      if (p === '/api/ai/status' && req.method === 'GET') { sendJson(res, 200, ai.status()); return; }
      if (p === '/api/ai/save' && req.method === 'POST') {
        const body = await readJson(req);
        try { sendJson(res, 200, ai.save(body.options || {}, body.apiKey ?? null, !!body.clearKey)); }
        catch (e) { sendJson(res, 400, { success: false, message: e.message }); }
        return;
      }
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }
      sendJson(res, 404, { success: false, message: '接口不存在', errorCode: 'invalid_input', retryable: false });
      return;
    }
    serveStatic(req, res, p);
  } catch (e) {
    try { sendJson(res, 500, { success: false, message: e.message || '服务异常', errorCode: 'upstream_error', retryable: true }); } catch { /* ignore */ }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[stock-web] listening on http://${HOST}:${PORT} data=${DATA_DIR} dataRoutes=${!!dataRoutes}`);
  alerts.start();
  reports.start();
});

// ---- push2 依赖接口预热 ----
// 涨跌家数 / 板块全景只走 push2.eastmoney.com，该 host 对云服务器 IP 偶发限流（TLS 重置）。
// 交易时段每 90 秒预热一次，使 endpointCache 常有可用数据：上游抖动时前端拿到的是
// 略旧数据（meta.stale）而不是「接口暂不可用」。
function shanghaiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
async function warmPush2Endpoints() {
  if (!dataRoutes) return;
  const now = shanghaiNow();
  const day = now.getUTCDay(); // 0=周日 6=周六（已按 +8 平移）
  if (day === 0 || day === 6) return;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minutes < 510 || minutes > 945) return; // 08:30–15:45
  try { await dispatchData('/market-data', { type: 'breadth' }); } catch { /* ignore */ }
  try { await dispatchData('/market-data', { type: 'sector-panorama' }); } catch { /* ignore */ }
}
setInterval(() => { warmPush2Endpoints().catch(() => {}); }, 90 * 1000);
