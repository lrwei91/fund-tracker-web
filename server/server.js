'use strict';
// 恭喜发财 Web 版服务：静态前端 + 登录鉴权 + /api/fetch 数据分发 + 配置/AI/事件接口。
// 数据路由（gateway/routes-data）由独立模块提供，缺失时数据接口返回不可用（其余功能可先行验证）。
// 服务器无 IPv6 出口：DNS 结果 IPv4 优先，避免 fetch 选中不可达的 AAAA 地址白白失败。
try { require('dns').setDefaultResultOrder('ipv4first'); } catch { /* ignore */ }
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { UserStores } = require('./store');
const { Auth } = require('./auth');

const PORT = Number(process.env.PORT || 18765);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = path.join(__dirname, '..', 'web');

const auth = new Auth(path.join(DATA_DIR, 'auth.json'));
const stores = new UserStores(DATA_DIR, () => auth.usernames());
const storeFor = (username) => stores.get(username);

// ---- SSE 事件总线（替代 Tauri 事件）----
const sseClients = new Map(); // res -> username
function emit(username, event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
  for (const [res, user] of sseClients) {
    if (user !== username) continue;
    try {
      // 慢客户端写缓冲超限则断开，防止事件帧在内存里无限堆积。
      if (res.writableLength > 4 * 1024 * 1024) { res.destroy(); sseClients.delete(res); continue; }
      res.write(frame);
    } catch { sseClients.delete(res); }
  }
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
const { MarketArchive } = require('./archive');
const { IndustryNews } = require('./industry-news');
const { MarketReview } = require('./review');
const { IntradayService } = require('./intraday');
const ai = new AiService({ getStore: storeFor, systemUsername: 'lrwei91', dataDir: DATA_DIR, gateway, getSnapshot });
const alerts = new PriceAlerts({ stores, getQuotes, emit });
const reports = new ReportCenter({ stores, ai, getSnapshot, getQuotes, emit });
const archive = new MarketArchive({ dataDir: DATA_DIR, internals: dataRoutes ? dataRoutes.internals : null });
const industryNews = new IndustryNews({ dataDir: DATA_DIR, ai });
const intraday = new IntradayService({ dataDir: DATA_DIR, stores, internals: dataRoutes ? dataRoutes.internals : null, archive, getQuotes });
const marketReview = new MarketReview({ dataDir: DATA_DIR, ai, internals: dataRoutes ? dataRoutes.internals : null, archive, getSnapshots: (d) => intraday.snapshots(d) });

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

// ---- endpoint 缓存（policy.rs 策略表 + 新增成功 TTL）----
const STALE_FOR = {
  '/opportunity-radar': 600,
  '/stock-fundamentals': 3600,
  '/stock-search': 1800, '/hot-rank': 1800, '/limit-up': 1800, '/cls-news': 1800,
  '/global-news': 1800, '/news': 1800, '/stock-news': 1800, '/stock-risk': 1800,
  '/dragon-tiger': 1800, '/fund-flow-120d': 1800, '/stock-kline': 1800,
  '/market-warnings': 1800, '/sector-rotation': 1800,
};
// 成功结果短 TTL 直接回放：机会雷达全链路要打 20+ 个上游请求（东财单槽串行），
// 秒级重复访问（多标签页 / 前端多模块同时拉）直接命中缓存。
const FRESH_TTL = {
  '/opportunity-radar': 90,
};
const endpointCache = new Map();
function stableQueryKey(routePath, query) {
  const entries = Object.entries(query || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return `${routePath}|${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
}
// 缓存/响应统一用序列化后的字符串体：每请求只 stringify 一次（原来成功路径
// clone→parse→再 stringify，radar 级响应可达数百 KB）。
function rebindTraceId(body) {
  return body.replace(/"traceId":"[^"]*"/, `"traceId":"${crypto.randomUUID()}"`);
}
async function dispatchData(routePath, query, username) {
  // market-data 仅 breadth / sector-panorama 允许 stale 回放（指数等实时类不回放）。
  let staleFor = STALE_FOR[routePath] || 0;
  if (routePath === '/market-data') {
    staleFor = (query && (query.type === 'breadth' || query.type === 'sector-panorama')) ? 1800 : 0;
  }
  const freshTtl = FRESH_TTL[routePath] || 0;
  const key = staleFor > 0 || freshTtl > 0 ? stableQueryKey(routePath, query) : null;
  if (key) {
    const cached = endpointCache.get(key);
    if (cached && cached.body && cached.success && freshTtl > 0 && (Date.now() - cached.at) / 1000 <= freshTtl) {
      return rebindTraceId(cached.body);
    }
  }
  let result;
  if (routePath === '/price-alerts') result = alerts.handle(query, username);
  else if (routePath === '/stock-ai-research') result = await ai.handle(query, username);
  else if (routePath === '/research-reports') result = await reports.handle(query, username);
  else if (routePath === '/market-archive') result = await archive.handle(query);
  else if (routePath === '/industry-news') result = await industryNews.handle(query);
  else if (routePath === '/market-review') result = await marketReview.handle(query);
  else if (routePath === '/intraday') result = await intraday.handle(query, username);
  else result = await fetchDataRoute(routePath, query);
  result = finalize(result);
  if (key) {
    if (result.success) {
      if (endpointCache.size > 128) endpointCache.delete(endpointCache.keys().next().value);
      endpointCache.set(key, { at: Date.now(), success: true, body: JSON.stringify(result) });
    } else {
      const cached = endpointCache.get(key);
      if (cached && cached.body && cached.success && staleFor > 0 && (Date.now() - cached.at) / 1000 <= staleFor) {
        // 失败回放旧成功数据（罕见路径，允许一次 parse 改写 meta）。
        const stale = JSON.parse(cached.body);
        stale.traceId = crypto.randomUUID();
        stale.meta.stale = true;
        stale.meta.staleAgeSeconds = Math.floor((Date.now() - cached.at) / 1000);
        stale.meta.updatedAt = new Date(cached.at).toISOString();
        if (!stale.meta.fallbackReason) stale.meta.fallbackReason = 'endpoint-cache-stale';
        stale.meta.degraded = true;
        return JSON.stringify(stale);
      }
    }
  }
  return JSON.stringify(result);
}

// ---- HTTP 基础 ----
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      let value = part.slice(i + 1).trim();
      try { value = decodeURIComponent(value); } catch { /* 畸形编码按原样保留 */ }
      out[part.slice(0, i).trim()] = value;
    }
  }
  return out;
}
function sessionUser(req) { return auth.sessionUser(parseCookies(req).ft_session); }
function isAuthed(req) { return sessionUser(req) !== null; }
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
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const IMMUTABLE_EXT = new Set(['.png', '.jpg', '.svg', '.ico', '.woff2', '.woff', '.mp3', '.wav']);
// 静态缓存策略（都是 hash 无关的本机文件，用 mtime+size 做 ETag）：
//   文本类（html/js/css）：no-cache + ETag → 未变时 304 空体，刷新页面不再重复下载 680KB 资源；
//   图片字体：max-age=86400，一天内强缓存。
// 文本响应 >1KB 时按 Accept-Encoding 做 br/gzip 压缩，styles.css 等传输体积约降 70-80%。
function serveStatic(req, res, urlPath) {
  let rel = urlPath;
  try { rel = decodeURIComponent(urlPath); } catch { /* 畸形 % 序列按原样处理 */ }
  if (rel === '/' || rel === '') rel = '/index.html';
  if ((rel === '/index.html') && !isAuthed(req)) rel = '/login.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const ext = path.extname(file);
    const cacheControl = IMMUTABLE_EXT.has(ext) ? 'public, max-age=86400' : 'no-cache';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': cacheControl }); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
      const type = MIME[ext] || 'application/octet-stream';
      const headers = { 'content-type': type, etag, 'cache-control': cacheControl };
      const accept = String(req.headers['accept-encoding'] || '');
      const compressible = /^(text\/|application\/(json|javascript))/.test(type) || ext === '.svg';
      const useBr = compressible && data.length > 1024 && accept.includes('br');
      const useGzip = compressible && data.length > 1024 && !useBr && accept.includes('gzip');
      if (!useBr && !useGzip) {
        headers['content-length'] = data.length;
        res.writeHead(200, headers);
        res.end(data);
        return;
      }
      const finish = (compErr, out) => {
        if (compErr) {
          headers['content-length'] = data.length;
          res.writeHead(200, headers);
          res.end(data);
          return;
        }
        headers['content-encoding'] = useBr ? 'br' : 'gzip';
        headers['content-length'] = out.length;
        res.writeHead(200, headers);
        res.end(out);
      };
      if (useBr) zlib.brotliCompress(data, { level: 5 }, finish);
      else zlib.gzip(data, { level: 6 }, finish);
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/health') { sendJson(res, 200, { ok: true, dataReady: !!dataRoutes }); return; }

    if (p === '/api/auth/status') {
      const username = sessionUser(req);
      sendJson(res, 200, { setup: auth.isSetup(), authed: username !== null, username });
      return;
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const token = auth.login(String(body.username || ''));
        res.setHeader('set-cookie', sessionCookie(req, token));
        sendJson(res, 200, { ok: true, username: String(body.username || '').trim() });
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
      if (!auth.isSetup()) { sendJson(res, 401, { success: false, message: '系统尚未开通任何用户', errorCode: 'unauthorized', retryable: false }); return; }
      const username = sessionUser(req);
      if (!username) { sendJson(res, 401, { success: false, message: '未登录', errorCode: 'unauthorized', retryable: false }); return; }
      if (p === '/api/fetch' && req.method === 'POST') {
        let body;
        try { body = await readJson(req); }
        catch (e) { sendJson(res, 400, { success: false, message: '请求体不是有效 JSON', errorCode: 'invalid_input', retryable: false }); return; }
        const routePath = String(body.path || '');
        const query = {};
        for (const [k, v] of Object.entries(body.query || {})) query[k] = String(v ?? '');
        // dispatchData 已返回序列化好的 JSON 字符串，直接落响应，避免二次 stringify。
        const bodyStr = await dispatchData(routePath, query, username);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(bodyStr);
        return;
      }
      if (p === '/api/config' && req.method === 'GET') { sendJson(res, 200, storeFor(username).load()); return; }
      if (p === '/api/config/patch' && req.method === 'POST') {
        const body = await readJson(req);
        try { sendJson(res, 200, storeFor(username).patch(body.changes || {})); }
        catch (e) { sendJson(res, 400, { success: false, message: e.message }); }
        return;
      }
      if (p === '/api/ai/status' && req.method === 'GET') { sendJson(res, 200, ai.status(username)); return; }
      if (p === '/api/ai/save' && req.method === 'POST') {
        const body = await readJson(req);
        try { sendJson(res, 200, ai.save(username, body.options || {}, body.apiKey ?? null, !!body.clearKey)); }
        catch (e) { sendJson(res, 400, { success: false, message: e.message }); }
        return;
      }
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        sseClients.set(res, username);
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
  archive.start();
  industryNews.start();
  marketReview.start();
  intraday.start();
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
