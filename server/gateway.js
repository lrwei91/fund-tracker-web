'use strict';
// gateway.js —— 上游 HTTP 网关，复刻 src-tauri/src/api/http.rs 的 Gateway/RequestSpec 语义。
//
// createGateway() -> { request(spec) }
//   spec = {
//     url,                       // 必填
//     method?,                   // 默认：有 body 时 POST，否则 GET
//     body?,                     // 字符串；给出即为请求体
//     headers?,                  // 对象，覆盖默认 UA/Referer（键名大小写不敏感）
//     em?,                       // 东财模式：默认缓存 TTL 改为 10s（显式 cacheTtl 优先）
//     cacheTtl?,                 // 秒，默认 5（em 时 10）；0 = 不写缓存（仍可读已有缓存，与 Rust 一致）
//     timeout?,                  // 秒，默认 10（每次尝试单独计时）
//     independentCircuit?,       // true 时不参与东财共享熔断（仍占信号量、仍受东财间隔与重试约束）
//     responseType?,             // 'json'（默认） | 'text' | 'gbk'
//     allowHost?,                // 显式放行的 host（可含回环/自定义端口）；此类请求不跟随重定向
//   }
//   成功返回 { status: 200, data }（data 按 responseType 解析：json 已解析、text 字符串、gbk 已解码）。
//   失败抛 Error，带 .code（规格错误码）、.retryable、.status（有上游 HTTP 状态时为数字，否则 null）、
//   .message（HTTP 错误固定为 "HTTP {status}"，与 Rust ApiError::with_status 一致）。
//
// 已实现策略（规格 §21）：host 白名单 28 个；provider 信号量 东财1/腾讯4/DeepQ2/其他3；
// 东财同 host 请求起点间隔 ≥1000+随机0–300ms；东财无 body 请求重试共 3 次（仅 429/5xx/网络错，
// 退避 300ms×2^n+随机0–100ms）；东财按 host 熔断（403 直接记 3 次，失败 ≥3 熔断 300s，半开单探测）；
// raw 缓存 key=method:url:body、上限 256 条/8MiB；在途请求合并；响应体上限 4MiB；固定 UA + 默认 Referer。
// 与 Rust 的已知差异：重定向跟随用 fetch 默认策略，未逐跳复检白名单（allowHost 请求不跟随，与凭据 client 一致）。

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const DEFAULT_REFERER = 'https://finance.eastmoney.com/';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RAW_CACHE_ENTRIES = 256;
const MAX_RAW_CACHE_BYTES = 8 * 1024 * 1024;

const ALLOWED_UPSTREAM_HOSTS = new Set([
  'sq.deepq.tech',
  'hq.sinajs.cn',
  'web.ifzq.gtimg.cn',
  'qt.gtimg.cn',
  'push2.eastmoney.com',
  'vip.stock.finance.sina.com.cn',
  'data.hexin.cn',
  'www.hkex.com.hk',
  'push2his.eastmoney.com',
  'searchapi.eastmoney.com',
  'dq.10jqka.com.cn',
  'emappdata.eastmoney.com',
  'push2ex.eastmoney.com',
  'www.cls.cn',
  'np-weblist.eastmoney.com',
  'flash-api.jin10.com',
  'search-api-web.eastmoney.com',
  'so.eastmoney.com',
  'datacenter-web.eastmoney.com',
  'www.szse.cn',
  'disc.static.szse.cn',
  'np-anotice-stock.eastmoney.com',
  'pdf.dfcfw.com',
  'query.sse.com.cn',
  'mobappconfig.securities.eastmoney.com',
  'dycalchis.eastmoney.com',
  'portfolio.lrwei91.cn',
]);

// policy.rs::error_code 的等价实现：返回 [code, retryable]。
function errorCodeFor(message, status) {
  let parsed = status != null ? status : null;
  if (parsed === null && typeof message === 'string' && message.startsWith('HTTP ')) {
    const token = message.slice(5).split(/\s+/)[0];
    const n = Number.parseInt(token, 10);
    if (Number.isInteger(n)) parsed = n;
  }
  if (parsed !== null) {
    if (parsed === 403) return ['forbidden', true];
    if (parsed === 429) return ['rate_limited', true];
    if (parsed >= 500 && parsed <= 599) return ['upstream_5xx', true];
    if (parsed >= 400 && parsed <= 499) return ['upstream_4xx', false];
    return ['upstream_error', true];
  }
  const msg = String(message || '');
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || msg.includes('超时')) return ['timeout', true];
  if (msg.includes('熔断') || lower.includes('circuit')) return ['circuit_open', true];
  if (msg.includes('为空') || lower.includes('empty')) return ['empty_data', true];
  if (
    lower.includes('json') ||
    lower.includes('eof') ||
    lower.includes('expected value') ||
    lower.includes('at line') ||
    msg.includes('解析') ||
    msg.includes('乱码')
  ) {
    return ['parse_error', true];
  }
  if (msg.includes('缺少') || msg.includes('无效') || msg.includes('非法')) {
    return ['invalid_input', false];
  }
  return ['upstream_error', true];
}

class GatewayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GatewayError';
    this.status = status != null ? status : null;
    const [code, retryable] = errorCodeFor(this.message, this.status);
    this.code = code;
    this.retryable = retryable;
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function normalizeHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

// http.rs::validate_upstream_url 的等价实现，返回小写 host，失败抛 GatewayError。
function validateUpstreamUrl(raw, allowHost) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GatewayError('上游地址无效');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.username || parsed.password || parsed.hash) {
    throw new GatewayError('上游地址包含凭据或片段');
  }
  const allowed = allowHost ? String(allowHost).toLowerCase() : null;
  const hostBare = normalizeHost(host);
  if (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    isLoopbackHost(host) &&
    allowed !== null &&
    (allowed === host || allowed === hostBare)
  ) {
    return host;
  }
  if (parsed.protocol !== 'https:' || parsed.port) {
    throw new GatewayError('上游地址未通过 HTTPS 与端口策略');
  }
  const isIp =
    /^(\d{1,3}\.){3}\d{1,3}$/.test(hostBare) || hostBare.includes(':');
  if (isIp || !(ALLOWED_UPSTREAM_HOSTS.has(host) || allowed === host || allowed === hostBare)) {
    throw new GatewayError('上游地址未登记');
  }
  return host;
}

function providerOf(host, spec) {
  if (spec.em || host.endsWith('eastmoney.com')) return 'eastmoney';
  if (host.endsWith('gtimg.cn') || host.endsWith('qq.com')) return 'tencent';
  if (host === 'sq.deepq.tech') return 'deepq';
  return 'default';
}

function createGateway(options) {
  // 熔断时长可调：服务器部署默认由 server.js 传入更短的恢复时间（云 IP 被上游限流时恢复更快）。
  const CIRCUIT_OPEN_MS = (options && options.circuitOpenMs) || 300 * 1000;
  const semaphores = {
    eastmoney: new Semaphore(1),
    tencent: new Semaphore(4),
    deepq: new Semaphore(2),
    default: new Semaphore(3),
  };
  // host -> { failures, until(ms epoch|null), lastStarted(ms epoch|null), halfOpenProbe }
  const circuits = new Map();
  // key -> { fetchedAt, expiresAt, bytes(Buffer) }
  const rawCache = new Map();
  // key -> Promise<Buffer>
  const inflight = new Map();

  function circuitState(host) {
    let state = circuits.get(host);
    if (!state) {
      state = { failures: 0, until: null, lastStarted: null, halfOpenProbe: false };
      circuits.set(host, state);
    }
    return state;
  }

  function readCache(key) {
    const entry = rawCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      rawCache.delete(key);
      return null;
    }
    return entry.bytes;
  }

  function writeCache(key, bytes, ttlSeconds) {
    rawCache.set(key, {
      fetchedAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1000,
      bytes,
    });
    pruneCache();
  }

  function pruneCache() {
    const now = Date.now();
    for (const [key, entry] of rawCache) {
      if (entry.expiresAt <= now) rawCache.delete(key);
    }
    let total = 0;
    for (const entry of rawCache.values()) total += entry.bytes.length;
    while (rawCache.size > MAX_RAW_CACHE_ENTRIES || total > MAX_RAW_CACHE_BYTES) {
      let oldestKey = null;
      let oldestAt = Infinity;
      let oldestSize = 0;
      for (const [key, entry] of rawCache) {
        if (entry.fetchedAt < oldestAt) {
          oldestAt = entry.fetchedAt;
          oldestKey = key;
          oldestSize = entry.bytes.length;
        }
      }
      if (oldestKey === null) break;
      rawCache.delete(oldestKey);
      total -= oldestSize;
    }
  }

  async function fetchOnce(spec) {
    const headers = {
      'user-agent': BROWSER_USER_AGENT,
      referer: DEFAULT_REFERER,
    };
    if (spec.headers) {
      for (const [name, value] of Object.entries(spec.headers)) {
        headers[String(name).toLowerCase()] = String(value);
      }
    }
    const init = {
      method: spec.method,
      headers,
      redirect: spec.allowHost ? 'manual' : 'follow',
      signal: AbortSignal.timeout((spec.timeout != null ? spec.timeout : 10) * 1000),
    };
    if (spec.body != null) init.body = spec.body;
    const response = await fetch(spec.url, init);
    const status = response.status;
    if (status < 200 || status >= 300) {
      try {
        if (response.body) await response.body.cancel();
      } catch {
        /* ignore */
      }
      return { status, bytes: null };
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      try {
        if (response.body) await response.body.cancel();
      } catch {
        /* ignore */
      }
      return { status, bytes: Buffer.alloc(0), tooBig: true };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) {
      return { status, bytes: buffer, tooBig: true };
    }
    return { status, bytes: buffer };
  }

  function wrapTransportError(error) {
    if (error instanceof GatewayError) return error;
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new GatewayError('请求超时（timeout）');
    }
    const cause = error && error.cause && error.cause.message ? error.cause.message : null;
    const message = cause || (error && error.message) || '网络请求失败';
    return new GatewayError(message);
  }

  async function perform(spec, key) {
    const host = validateUpstreamUrl(spec.url, spec.allowHost);
    const provider = providerOf(host, spec);
    const semaphore = semaphores[provider];
    const ttl = spec.cacheTtl != null ? spec.cacheTtl : spec.em ? 10 : 5;
    await semaphore.acquire();
    try {
      const sharedCircuit = provider === 'eastmoney' && !spec.independentCircuit;
      let circuit = null;
      if (provider === 'eastmoney') {
        circuit = circuitState(host);
        const now = Date.now();
        if (sharedCircuit && circuit.until !== null && circuit.until > now) {
          throw new GatewayError('eastmoney 数据源熔断中');
        }
        if (sharedCircuit && circuit.until !== null) {
          if (circuit.halfOpenProbe) {
            throw new GatewayError('eastmoney 数据源半开探测中');
          }
          circuit.halfOpenProbe = true;
        }
        if (circuit.lastStarted !== null) {
          const target = 1000 + Math.floor(Math.random() * 301);
          const wait = target - (Date.now() - circuit.lastStarted);
          if (wait > 0) await sleep(wait);
        }
        circuit.lastStarted = Date.now();
      }
      const attempts = provider === 'eastmoney' && spec.body == null ? 3 : 1;
      let last = new GatewayError('请求失败');
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const result = await fetchOnce(spec);
          if (result.status >= 200 && result.status < 300) {
            if (result.tooBig) {
              last = new GatewayError('响应体超过大小限制');
              break;
            }
            if (sharedCircuit && circuit) {
              circuit.failures = 0;
              circuit.until = null;
              circuit.halfOpenProbe = false;
            }
            if (ttl > 0) writeCache(key, result.bytes, ttl);
            return result.bytes;
          }
          last = new GatewayError(`HTTP ${result.status}`, result.status);
          if (result.status !== 429 && result.status < 500) break;
        } catch (error) {
          last = wrapTransportError(error);
        }
        if (attempt + 1 < attempts) {
          await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 100));
        }
      }
      if (sharedCircuit && circuit) {
        circuit.halfOpenProbe = false;
        if (last.status === 403) {
          circuit.failures = 3;
        } else if (last.status === null || last.status === 429 || last.status >= 500) {
          circuit.failures += 1;
        } else {
          circuit.failures = 0;
        }
        if (circuit.failures >= 3) {
          circuit.until = Date.now() + CIRCUIT_OPEN_MS;
        }
      }
      throw last;
    } finally {
      semaphore.release();
    }
  }

  async function bytes(spec, key) {
    const cached = readCache(key);
    if (cached !== null) return cached;
    let work = inflight.get(key);
    if (!work) {
      work = perform(spec, key);
      inflight.set(key, work);
      const cleanup = () => {
        if (inflight.get(key) === work) inflight.delete(key);
      };
      work.then(cleanup, cleanup);
    }
    return work;
  }

  async function request(spec) {
    if (!spec || typeof spec.url !== 'string') {
      throw new GatewayError('上游地址无效');
    }
    const method = String(
      spec.method || (spec.body != null ? 'POST' : 'GET'),
    ).toUpperCase();
    const normalized = { ...spec, method };
    const key = `${method}:${spec.url}:${spec.body != null ? spec.body : ''}`;
    const buffer = await bytes(normalized, key);
    const responseType = spec.responseType || 'json';
    if (responseType === 'gbk') {
      return { status: 200, data: new TextDecoder('gbk').decode(buffer) };
    }
    if (responseType === 'text') {
      try {
        return { status: 200, data: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
      } catch (error) {
        throw new GatewayError(error.message);
      }
    }
    try {
      return { status: 200, data: JSON.parse(new TextDecoder('utf-8').decode(buffer)) };
    } catch (error) {
      const wrapped = new GatewayError(error.message);
      wrapped.code = 'parse_error';
      wrapped.retryable = true;
      throw wrapped;
    }
  }

  return { request };
}

module.exports = { createGateway, GatewayError, errorCodeFor };
