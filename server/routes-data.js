'use strict';
// routes-data.js —— 行情数据路由层，复刻 src-tauri/src/api/{endpoints,handlers,market,kline,minute,intraday}.rs。
//
// createDataRoutes(gw) -> { handle, internals }
//   gw 为 gateway.js 的 createGateway() 结果（只需用到 gw.request）。
//
// handle(path, query)
//   path 形如 '/stock'（带不带前导斜杠均可），query 为字符串键值对象。
//   返回信封对象（不含 traceId，外层统一补）：
//     成功 { success:true, data, meta, ...个别路由的顶层附加字段 }
//     失败 { success:false, message, error, errorCode, retryable, status?, meta:{degraded:false, stale:false} }
//   失败信封的 message/error 已按 policy.rs::finalize_response 的规则标准化
//   （message 为按错误码改写的标准文案，error === errorCode），与桌面版最终对外形态一致（仅差 traceId）。
//
// internals 约定：
//   - 除 researchSnapshot 外，其余函数成功时返回对应路由的 data，失败时抛 Error
//     （带 .code/.status/.retryable，取自失败信封）。
//   - researchSnapshot(code) 按补充约定返回完整的 /stock-research 信封 {success, data, meta}，不抛错。
//   - stockQuotes(codes) / stockKline(code, days) / stockNews(code, name, limit) /
//     fundFlow(codes, days) / hotRank(source, limit, period) / limitUp(type, limit, dateStr) /
//     dragonTiger() / marketData(type, boardType, period)。
//
// 与 Rust 的已知差异：
//   - K 线/分时无 tdxrs 源（Web 无本地进程），行为等同桌面版未配置 TDXRS_BIN/TDXRS_PYTHON 时。
//   - generatedAt/asOf 等时间戳用 ISO 8601（Z 结尾），Rust 为 RFC3339（+00:00 结尾），语义等价。

const crypto = require('node:crypto');
const symbol = require('./symbol');
const { errorCodeFor } = require('./gateway');

/* ------------------------------------------------------------------ helpers */

function q(query, key) {
  const value = query ? query[key] : undefined;
  return value === undefined || value === null ? '' : String(value);
}

// endpoints.rs::int —— 严格整数解析（与 Rust parse::<i64> 一致：不接受小数/空白），失败用默认，clamp 到 [min,max]。
function intQ(query, key, defaultValue, min, max) {
  const raw = q(query, key);
  let value = defaultValue;
  if (/^[+-]?\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) value = parsed;
  }
  return Math.min(max, Math.max(min, value));
}

// Rust f64 .round()：四舍五入、半值远离零。round(v, d) 同 endpoints.rs::round。
function roundHA(value, digits) {
  const p = 10 ** digits;
  return (Math.sign(value) * Math.round(Math.abs(value) * p)) / p;
}
function round(value, digits) {
  return roundHA(value, digits || 0);
}

// kline.rs::rounded —— 有限数才输出（保留 d 位），否则 null。
function rounded(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return roundHA(value, digits);
}

// endpoints.rs::number —— JSON 数字直读；字符串走严格全串解析。
function numJson(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

// market.rs::num —— 先数字，失败则去 ',' '%' 后解析。
function numStrip(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,%]/g, '');
    if (cleaned.trim() === '') return null;
    const n = Number(cleaned);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

// endpoints.rs::string —— 字符串直读；其它 JSON 值转 JSON 文本；缺失为 ""。
function str(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// endpoints.rs::field —— 取键，缺失为 null（对应 Value::Null）。
function field(value, key) {
  if (value && typeof value === 'object' && value[key] !== undefined) return value[key];
  return null;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// urlencoding::encode 等价（encodeURIComponent 之外再编码 !'()*）。
function urlEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function nowIso() {
  return new Date().toISOString();
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
function shanghaiDate(baseMs) {
  return new Date((baseMs != null ? baseMs : Date.now()) + SHANGHAI_OFFSET_MS);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtYmd(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}
function fmtYmdDash(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function today() {
  return fmtYmd(shanghaiDate());
}
function todayIso() {
  return fmtYmdDash(shanghaiDate());
}
function shanghaiTodayDate() {
  const d = shanghaiDate();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function shanghaiClock() {
  const d = shanghaiDate();
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/* ------------------------------------------------------- envelope (policy.rs) */

const STANDARD_MESSAGES = {
  timeout: '上游响应超时，请稍后重试',
  rate_limited: '上游请求繁忙，请稍后重试',
  circuit_open: '上游暂时不可用，正在等待恢复',
  invalid_input: '请求参数无效',
  empty_data: '上游暂未返回可用数据',
  parse_error: '上游数据格式暂不可用',
};

function ok(data) {
  return { success: true, data, meta: { degraded: false, stale: false } };
}

function okExtra(data, extra) {
  const out = ok(data);
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) out[key] = value;
  }
  return out;
}

// policy::failure + finalize_response 的合成：先按 (error||message, status) 分类，再改写标准文案。
function fail(message, error, status) {
  const classification = error && String(error).trim() !== '' ? String(error) : message;
  const [code, retryable] = errorCodeFor(classification, status != null ? status : null);
  const out = {
    success: false,
    message: STANDARD_MESSAGES[code] || '上游服务暂不可用',
    error: code,
    errorCode: code,
    retryable,
    meta: { degraded: false, stale: false },
  };
  if (status !== null && status !== undefined) out.status = status;
  return out;
}

function failApi(message, error) {
  const out = fail(message, error && error.message ? error.message : String(error), error ? error.status : null);
  if (out.meta && typeof out.meta === 'object') {
    out.meta.sourceError = {
      status: error ? error.status : null,
      code: error && error.code ? error.code : errorCodeFor(error ? error.message : '', error ? error.status : null)[0],
    };
  }
  return out;
}

/* ---------------------------------------------------------------- 数据路由 */

function createDataRoutes(gw) {
  async function gwJson(spec) {
    const result = await gw.request({ ...spec, responseType: 'json' });
    return result.data;
  }
  async function gwText(spec) {
    const result = await gw.request({ ...spec, responseType: 'text' });
    return result.data;
  }
  async function gwGbk(spec) {
    const result = await gw.request({ ...spec, responseType: 'gbk' });
    return result.data;
  }

  /* ---------------------------------------------------------- /stock 腾讯行情 */

  async function stockEnv(query) {
    const requested = q(query, 'codes')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => symbol.validCode(c));
    if (requested.length === 0) return fail('缺少股票代码', '');
    const rejected = requested.filter((code) => symbol.isLegacyBeijing(code));
    const codes = requested.filter((code) => !symbol.isLegacyBeijing(code));
    if (codes.length === 0) {
      return fail(
        '北交所旧代码已迁移',
        '无效的北交所旧代码：43/83/87 号段可能返回迁移日前的僵尸行情，请改用 920xxx 新代码',
      );
    }
    const symbols = codes.map((code) => symbol.tencentSymbol(code)).join(',');
    let text;
    try {
      text = await gwGbk({ url: `https://qt.gtimg.cn/q=${symbols}`, cacheTtl: 5 });
    } catch (error) {
      return failApi('真实股票行情接口不可用', error);
    }
    const data = {};
    const times = [];
    const expected = new Set(codes);
    for (const rawLine of text.split(';')) {
      const line = rawLine.trim();
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const keyPart = line.slice(2, eq);
      const code = keyPart.length >= 2 ? keyPart.slice(2) : undefined;
      const first = line.indexOf('"');
      const last = line.lastIndexOf('"');
      if (first < 0 || last <= first || code === undefined) continue;
      const payload = line.slice(first + 1, last);
      const parts = payload.split('~');
      if (!expected.has(code) || parts.length < 33) continue;
      const priceRaw = strictNum(parts[3]);
      const price = priceRaw !== null && Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;
      if (price === null) continue;
      const pctRaw = strictNum(parts[32]);
      const pct = pctRaw !== null && Number.isFinite(pctRaw) ? pctRaw : null;
      const change = strictNum(parts[31]);
      let open = null;
      const openRaw = parts.length > 5 ? strictNum(parts[5]) : null;
      if (openRaw !== null && openRaw > 0) open = openRaw;
      if (open === null && pct !== null) {
        const prev = price / (1 + pct / 100);
        if (Number.isFinite(prev) && prev > 0) open = round(prev, 2);
      }
      const raw = parts.length > 30 ? parts[30] : '';
      let display = '';
      if (raw && raw.length >= 14) {
        const seg = raw.slice(8, 14);
        if (seg.length === 6) display = `${seg.slice(0, 2)}:${seg.slice(2, 4)}:${seg.slice(4, 6)}`;
      }
      if (raw && raw.length === 14) times.push(raw);
      const quoteNumber = (index) => {
        if (index >= parts.length) return null;
        const n = strictNum(parts[index]);
        return n !== null && Number.isFinite(n) ? n : null;
      };
      // Tencent field 37 is turnover in ten-thousand yuan, 49 is volume ratio.
      const turnoverRaw = quoteNumber(37);
      const turnover = turnoverRaw !== null && turnoverRaw >= 0 ? turnoverRaw * 10000 : null;
      const volumeRatioRaw = quoteNumber(49);
      const volumeRatio = volumeRatioRaw !== null && volumeRatioRaw >= 0 ? volumeRatioRaw : null;
      const marketCapRaw = quoteNumber(45);
      data[code] = {
        code,
        name: parts.length > 1 && parts[1] !== '' ? parts[1] : code,
        price: price !== null ? price.toFixed(2) : '--',
        priceValue: price,
        change,
        changePercent: pct,
        volume: parts[36] !== undefined ? parts[36] : parts[6] !== undefined ? parts[6] : '--',
        turnover,
        volumeRatio,
        pe: quoteNumber(39),
        pb: quoteNumber(46),
        marketCap: marketCapRaw !== null ? marketCapRaw * 100000000 : null,
        openPrice: open,
        quoteTime: display,
        quoteTimeRaw: raw || '',
      };
    }
    times.sort();
    const requestTime = shanghaiClock();
    let latest = null;
    if (times.length > 0) {
      const rawLatest = times[times.length - 1];
      const seg = rawLatest.slice(8, 14);
      if (seg.length === 6) latest = `${seg.slice(0, 2)}:${seg.slice(2, 4)}:${seg.slice(4, 6)}`;
    }
    if (Object.keys(data).length === 0) {
      return fail('真实股票行情接口不可用', '行情数据为空或字段无效');
    }
    const received = Object.keys(data).sort();
    const missing = codes.filter((code) => !(code in data));
    const degraded = missing.length > 0 || rejected.length > 0;
    return okExtra(data, {
      time: latest !== null ? latest : requestTime,
      timeSource: latest !== null ? 'quote' : 'request',
      meta: {
        degraded,
        stale: false,
        expectedCodes: requested,
        receivedCodes: received,
        missingCodes: missing,
        rejectedCodes: rejected.map((code) => ({
          code,
          reason: '北交所旧代码已迁移，请使用 920xxx 新代码',
        })),
        sources: { quotes: { actual: 'tencent', actualLabel: '腾讯行情' } },
      },
    });
  }

  // Rust str::parse::<f64> 等价：整串严格解析，空串/杂质返回 null（"NaN"/"inf" 与 Rust 一致可解析）。
  function strictNum(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return value;
    const s = String(value);
    if (s.trim() === '') return null;
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }

  /* ------------------------------------------------------------- /stock-search */

  async function stockSearchEnv(query) {
    const term = q(query, 'q').trim();
    if (!term) return fail('缺少搜索关键词', '');
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${urlEncode(term)}&type=14&token=44c9d251add88e27b65ed86506f6e5da&count=8`;
    let v;
    try {
      v = await gwJson({ url, em: true });
    } catch (error) {
      return failApi('真实股票搜索接口不可用', error);
    }
    const rows =
      v && v.QuotationCodeTable && Array.isArray(v.QuotationCodeTable.Data)
        ? v.QuotationCodeTable.Data
        : [];
    const items = [];
    for (const row of rows) {
      const c = row && typeof row.Code === 'string' ? row.Code : null;
      const n = row && typeof row.Name === 'string' ? row.Name : null;
      const t = row && typeof row.SecurityTypeName === 'string' ? row.SecurityTypeName : null;
      if (c !== null && n !== null && t !== null && symbol.validCode(c) && t.includes('A')) {
        items.push({ code: c, name: n });
      }
    }
    return ok(items);
  }

  /* ---------------------------------------------------------------- /hot-rank */

  async function hotRankEnv(query) {
    const source = q(query, 'source') === '' ? 'ths' : q(query, 'source');
    if (source === 'ths') {
      const period = q(query, 'period') === '' ? 'hour' : q(query, 'period');
      const url = `https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=${period}&list_type=normal`;
      let v;
      try {
        v = await gwJson({ url });
      } catch (error) {
        return failApi('真实市场热度接口不可用', error);
      }
      const list =
        v && v.data && Array.isArray(v.data.stock_list) ? v.data.stock_list : [];
      const items = list.slice(0, 30).map((x) => {
        const rate = numJson(field(x, 'rate'));
        return {
          rank: field(x, 'order'),
          code: field(x, 'code'),
          name: field(x, 'name'),
          heat: Math.floor((rate === null ? 0 : rate) / 10000),
          pct: numJson(field(x, 'rise_and_fall')) ?? 0,
          rankChg: field(x, 'hot_rank_chg'),
          concepts:
            x && x.tag && Array.isArray(x.tag.concept_tag) ? x.tag.concept_tag : [],
          tag: x && x.tag && x.tag.popularity_tag !== undefined ? x.tag.popularity_tag : '',
        };
      });
      return ok({ source, period, items });
    }
    if (source !== 'em') return fail('未知 source（支持 ths / em）', '');
    const limit = intQ(query, 'limit', 20, 1, 30);
    const body = JSON.stringify({
      appId: 'appId01',
      globalId: '786e4c21-70dc-435a-93bb-38',
      marketType: '',
      pageNo: 1,
      pageSize: limit,
    });
    let main;
    try {
      main = await gwJson({
        url: 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList',
        em: true,
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (error) {
      return failApi('真实市场热度接口不可用', error);
    }
    const rows = main && Array.isArray(main.data) ? main.data : [];
    if (rows.length === 0) return ok({ source: 'em', items: [] });
    const secids = rows
      .map((x) => (x && typeof x.sc === 'string' ? x.sc : null))
      .filter((sc) => sc !== null)
      .map((sc) => sc.slice(2))
      .filter((code) => code !== '' && !symbol.isLegacyBeijing(code))
      .map((code) => symbol.eastmoneySecid(code))
      .filter((secid) => secid !== null)
      .join(',');
    if (secids === '') {
      return okExtra(
        { source: 'em', items: [] },
        { meta: { degraded: true, stale: false, emptyReason: '热榜未返回可用证券代码' } },
      );
    }
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?ut=f057cbcbce2a86e2866ab8877db1d059&fltt=2&invt=2&fields=f14%2Cf3%2Cf12%2Cf2&secids=${urlEncode(secids)}`;
    let lookup;
    try {
      lookup = await gwJson({ url, em: true });
    } catch (error) {
      return failApi('真实市场热度接口不可用', error);
    }
    const names = new Map();
    const diff = lookup && lookup.data ? lookup.data.diff : undefined;
    if (diff !== undefined && diff !== null) {
      const rowsDiff = Array.isArray(diff) ? diff : typeof diff === 'object' ? Object.values(diff) : [];
      for (const x of rowsDiff) {
        if (x && typeof x.f12 === 'string') names.set(x.f12, x);
      }
    }
    const items = rows.slice(0, limit).map((it) => {
      const sc = it && typeof it.sc === 'string' ? it.sc : '';
      const code = sc.length >= 2 ? sc.slice(2) : '';
      const info = names.get(code);
      return {
        rank: field(it, 'rk'),
        code,
        name: info && info.f14 !== undefined ? info.f14 : '',
        price: info ? numJson(field(info, 'f2')) : null,
        pct: info ? numJson(field(info, 'f3')) : null,
        rankChg: field(it, 'hisRc'),
      };
    });
    return ok({ source: 'em', items });
  }

  /* ---------------------------------------------------------------- /limit-up */

  function ztTime(v) {
    let raw;
    if (typeof v === 'number' && Number.isInteger(v)) raw = String(v);
    else if (typeof v === 'string') raw = v;
    else raw = '';
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    const s = digits.padStart(6, '0');
    return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
  }

  async function pool(kind, date, limit) {
    const mapping = {
      zt: ['getTopicZTPool', 'fbt:asc'],
      zb: ['getTopicZBPool', 'fbt:asc'],
      dt: ['getTopicDTPool', 'fund:asc'],
      yzt: ['getYesterdayZTPool', 'zs:desc'],
    };
    const entry = mapping[kind];
    if (!entry) {
      const error = new Error('未知池类型');
      error.code = 'upstream_error';
      error.status = null;
      throw error;
    }
    const [endpoint, sort] = entry;
    const url = `https://push2ex.eastmoney.com/${endpoint}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=${limit}&sort=${urlEncode(sort)}&date=${date}`;
    const v = await gwJson({ url, em: true, timeout: 12 });
    return v && v.data && Array.isArray(v.data.pool) ? v.data.pool : [];
  }

  function mapPool(kind, p) {
    const z = field(p, 'zttj');
    const days = field(z, 'days');
    const ct = field(z, 'ct');
    const common = {
      code: field(p, 'c'),
      name: field(p, 'n'),
      market: field(p, 'm'),
      price: (numJson(field(p, 'p')) ?? 0) / 1000,
      pct: round(numJson(field(p, 'zdp')) ?? 0, 2),
      turnover: round(numJson(field(p, 'hs')) ?? 0, 2),
      industry: field(p, 'hybk'),
      ztStat: days !== null && ct !== null ? `${str(days)}天${str(ct)}板` : '',
    };
    let extra;
    if (kind === 'zt') {
      extra = {
        amount: field(p, 'amount'),
        floatCap: field(p, 'ltsz'),
        limitDays: field(p, 'lbc'),
        firstSeal: ztTime(field(p, 'fbt')),
        lastSeal: ztTime(field(p, 'lbt')),
        sealFund: field(p, 'fund'),
        breakTimes: field(p, 'zbc'),
      };
    } else if (kind === 'zb') {
      extra = {
        limitPrice: (numJson(field(p, 'ztp')) ?? 0) / 1000,
        firstSeal: ztTime(field(p, 'fbt')),
        breakTimes: field(p, 'zbc'),
        amplitude: round(numJson(field(p, 'zf')) ?? 0, 2),
        speed: round(numJson(field(p, 'zs')) ?? 0, 2),
      };
    } else if (kind === 'dt') {
      extra = {
        sealFund: field(p, 'fund'),
        lastSeal: ztTime(field(p, 'lbt')),
        boardAmount: field(p, 'fba'),
        dtDays: field(p, 'days'),
        openTimes: field(p, 'oc'),
      };
    } else {
      extra = {
        amplitude: round(numJson(field(p, 'zf')) ?? 0, 2),
        speed: round(numJson(field(p, 'zs')) ?? 0, 2),
        yFirstSeal: ztTime(field(p, 'yfbt')),
        yLimitDays: field(p, 'ylbc'),
      };
    }
    return { ...common, ...extra };
  }

  async function limitUpEnv(query) {
    const kind = q(query, 'type') === '' ? 'zt' : q(query, 'type');
    let date = q(query, 'date').replace(/-/g, '');
    if (!date) date = today();
    if (!['zt', 'zb', 'dt', 'yzt', 'summary'].includes(kind)) {
      return fail('未知 type（支持 zt/zb/dt/yzt/summary）', '');
    }
    if (kind === 'summary') {
      const results = await Promise.allSettled([
        pool('zt', date, 100),
        pool('zb', date, 100),
        pool('dt', date, 100),
        pool('yzt', date, 100),
      ]);
      if (results.some((r) => r.status === 'rejected')) {
        return fail('真实打板接口不可用', '池数据请求失败');
      }
      const [zt, zb, dt, yzt] = results.map((r) => r.value);
      const ladderMap = new Map();
      for (const p of zt) {
        const n = field(p, 'lbc');
        const count = typeof n === 'number' && Number.isInteger(n) ? n : null;
        if (count !== null && count > 0) ladderMap.set(count, (ladderMap.get(count) || 0) + 1);
      }
      const ladder = {};
      for (const key of [...ladderMap.keys()].sort((a, b) => a - b)) {
        ladder[String(key)] = ladderMap.get(key);
      }
      const promote = yzt.filter((p) => (numJson(field(p, 'zdp')) ?? 0) >= 9.8).length;
      return ok({
        date,
        ztCount: zt.length,
        zbCount: zb.length,
        dtCount: dt.length,
        yztCount: yzt.length,
        breakRate:
          zt.length + zb.length > 0 ? round((zb.length / (zt.length + zb.length)) * 100, 1) : 0,
        maxHeight: zt.reduce((max, p) => {
          const n = field(p, 'lbc');
          return typeof n === 'number' && Number.isInteger(n) ? Math.max(max, n) : max;
        }, 0),
        promoteRate: yzt.length === 0 ? 0 : round((promote / yzt.length) * 100, 1),
        ladder,
      });
    }
    const limit = intQ(query, 'limit', 30, 1, 100);
    let raw;
    try {
      raw = await pool(kind, date, limit);
    } catch (error) {
      return failApi('真实打板接口不可用', error);
    }
    const items = raw.map((p) => mapPool(kind, p));
    return ok({ type: kind, date, count: items.length, items });
  }

  /* --------------------------------------------------------------- 新闻源封装 */

  function parseStatus(message) {
    if (typeof message === 'string' && message.startsWith('HTTP ')) {
      const n = Number.parseInt(message.slice(5).split(/\s+/)[0], 10);
      if (Number.isInteger(n)) return n;
    }
    return null;
  }

  function sourceMeta(key, actual, label, degraded, reason, requested) {
    const meta = {
      asOf: nowIso(),
      degraded,
      stale: false,
      sources: {
        [key]: {
          actual,
          actualLabel: label,
          attempts: degraded
            ? [
                {
                  source: requested,
                  label: requested,
                  status: parseStatus(reason) !== null ? parseStatus(reason) : 'failed',
                  reason,
                },
                { source: actual, label, status: 200, reason: '备用源成功' },
              ]
            : [],
          degraded,
          fallbackReason: reason,
          requested,
        },
      },
    };
    return meta;
  }

  function clsTime(ts) {
    if (!ts) return '';
    const d = shanghaiDate(ts * 1000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  }

  function clsSign(request) {
    const sha1 = crypto.createHash('sha1').update(request, 'utf8').digest('hex');
    return crypto.createHash('md5').update(sha1, 'utf8').digest('hex');
  }

  function scalarText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  }

  // 财联社快讯：成功返回归一化行数组；失败抛错。行形状与 Rust load_cls 输出一致（含 timestamp）。
  async function loadCls(limit, cursor) {
    const request = `appName=CailianpressWeb&last_time=${cursor}&os=web&refresh_type=1&rn=${limit}&sv=7.7.5`;
    const url = `https://www.cls.cn/v1/roll/get_roll_list?${request}&sign=${clsSign(request)}`;
    const v = await gwJson({ url, headers: { referer: 'https://www.cls.cn/' }, cacheTtl: 30 });
    const errno = v && typeof v === 'object' ? v.errno : undefined;
    const errnoNum = typeof errno === 'number' && Number.isInteger(errno) ? errno : null;
    if (errnoNum !== null && errnoNum !== 0) {
      const error = new Error(str(v.msg));
      error.status = null;
      throw error;
    }
    const rows = v && v.data && Array.isArray(v.data.roll_data) ? v.data.roll_data : [];
    const out = [];
    for (const raw of rows) {
      const pickStr = (keys) => {
        for (const key of keys) {
          if (typeof raw[key] === 'string') return raw[key];
        }
        return undefined;
      };
      const content = (pickStr(['content', 'brief', 'title']) ?? '').trim();
      const title = (pickStr(['title', 'brief']) ?? content).trim();
      if (title === '' && content === '') continue;
      const tsRaw = raw.ctime;
      const ts = typeof tsRaw === 'number' && Number.isInteger(tsRaw) ? tsRaw : 0;
      let id;
      if ('id' in raw || 'telegraph_id' in raw) {
        const value = 'id' in raw ? raw.id : raw.telegraph_id;
        const text = typeof value === 'string' ? JSON.stringify(value) : scalarText(value) ?? JSON.stringify(value);
        id = text.replace(/^"+|"+$/g, '');
      } else {
        id = crypto
          .createHash('sha1')
          .update(`${ts}:${title}:${content}`, 'utf8')
          .digest('hex')
          .slice(0, 16);
      }
      const urlCandidate = 'shareurl' in raw ? raw.shareurl : raw.url;
      out.push({
        id,
        timestamp: ts,
        time: clsTime(ts),
        title,
        summary: content,
        url: typeof urlCandidate === 'string' ? urlCandidate : 'https://www.cls.cn/telegraph',
      });
    }
    return out;
  }

  // 东财快讯：行含 cursor 供翻页。
  async function loadEmNews(limit, cursor) {
    const url = `https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=${urlEncode(cursor)}&pageSize=${limit}&req_trace=${crypto.randomUUID()}`;
    const v = await gwJson({
      url,
      em: true,
      headers: { referer: 'https://kuaixun.eastmoney.com/' },
      cacheTtl: 30,
    });
    const rows = v && v.data && Array.isArray(v.data.fastNewsList) ? v.data.fastNewsList : [];
    const out = [];
    for (const raw of rows) {
      const title = str(raw.title);
      const summary = str(raw.summary);
      if (title === '' && summary === '') continue;
      // id/cursor/time/url 保留上游原始 JSON 值（与 Rust .cloned().unwrap_or(默认) 一致）。
      const pick = (keys, fallback) => {
        for (const key of keys) {
          if (key in raw) return raw[key];
        }
        return fallback;
      };
      out.push({
        id: pick(['seq', 'id', 'code', 'realSort', 'url'], ''),
        cursor: pick(['realSort', 'sortEnd'], ''),
        title,
        summary,
        time: pick(['showTime', 'createTime'], ''),
        url: pick(['url'], 'https://kuaixun.eastmoney.com/'),
      });
    }
    return out;
  }

  async function clsNewsEnv(query) {
    const limit = intQ(query, 'limit', 20, 1, 40);
    const cursor = q(query, 'cursor').trim();
    let degraded = false;
    let reason = '';
    let items = null;
    let actual = 'cls';
    try {
      const rows = await loadCls(limit, cursor);
      if (rows.length > 0) {
        items = rows;
      } else if (cursor !== '') {
        return fail('财联社快讯接口不可用', '数据为空');
      } else {
        degraded = true;
        reason = '财联社数据为空';
      }
    } catch (error) {
      if (cursor !== '') return failApi('财联社快讯接口不可用', error);
      degraded = true;
      reason = error.message;
      try {
        const rows = await loadEmNews(limit, '');
        if (rows.length > 0) {
          items = rows;
          actual = 'eastmoney';
        } else {
          return fail('财联社快讯接口不可用', '数据为空');
        }
      } catch (error2) {
        return fail('财联社快讯接口不可用', `${reason}; ${error2.message}`);
      }
    }
    if (items === null) {
      // 主源返回空且无游标：降级东财，失败/为空都按主源 reason 失败（与 Rust 一致）。
      try {
        const rows = await loadEmNews(limit, '');
        if (rows.length > 0) {
          items = rows;
          actual = 'eastmoney';
        }
      } catch {
        // 保持 items 为 null，下方统一失败
      }
      if (items === null) return fail('财联社快讯接口不可用', reason);
    }
    const sliced = items.slice(0, limit);
    let nextCursor = null;
    if (actual === 'cls') {
      const last = sliced.length > 0 ? sliced[sliced.length - 1] : null;
      if (last && typeof last.timestamp === 'number' && last.timestamp > 0) {
        nextCursor = String(last.timestamp);
      }
    }
    const label = actual === 'cls' ? '财联社' : '东方财富';
    return okExtra(
      {
        data: sliced,
        nextCursor,
        hasMore: nextCursor !== null && sliced.length >= limit,
        source: actual,
        sourceLabel: label,
      },
      { meta: sourceMeta('news', actual, label, degraded, reason, 'cls') },
    );
  }

  async function globalNewsEnv(query) {
    const limit = intQ(query, 'limit', 20, 1, 40);
    const cursor = q(query, 'cursor').trim();
    let degraded = false;
    let reason = '';
    let items = null;
    let actual = 'eastmoney';
    try {
      const rows = await loadEmNews(limit, cursor);
      if (rows.length > 0) {
        items = rows;
      } else if (cursor !== '') {
        return fail('真实东财资讯接口不可用', '数据为空');
      } else {
        degraded = true;
        reason = '东方财富数据为空';
      }
    } catch (error) {
      if (cursor !== '') return failApi('真实东财资讯接口不可用', error);
      degraded = true;
      reason = error.message;
    }
    if (items === null) {
      // 无游标时降级财联社，失败/为空都按主源 reason 失败（与 Rust 一致）。
      try {
        const rows = await loadCls(limit, '');
        if (rows.length > 0) {
          items = rows;
          actual = 'cls';
        }
      } catch {
        // 保持 items 为 null，下方统一失败
      }
      if (items === null) return fail('真实东财资讯接口不可用', reason);
    }
    const sliced = items.slice(0, limit);
    let next = null;
    if (actual === 'eastmoney') {
      const last = sliced.length > 0 ? sliced[sliced.length - 1] : null;
      if (last && typeof last.cursor === 'string' && last.cursor !== '') next = last.cursor;
    }
    const label = actual === 'cls' ? '财联社' : '东方财富';
    return okExtra(
      {
        data: sliced,
        nextCursor: sliced.length >= limit ? next : null,
        hasMore: next !== null && sliced.length >= limit,
        source: actual,
        sourceLabel: label,
      },
      { meta: sourceMeta('news', actual, label, degraded, reason, 'eastmoney') },
    );
  }

  // 金十快讯（/news）
  function stripHtml(input) {
    if (!input) return '';
    let s = String(input)
      .replace(/<br\s*\/?>|<\/p\s*>/gi, ' ');
    s = s.replace(/<[^>]*>/g, '');
    s = s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return s.split(/\s+/).filter(Boolean).join(' ');
  }

  async function jin10Env(query) {
    const limit = intQ(query, 'limit', 20, 1, 40);
    let cursorValue = null;
    const rawCursor = q(query, 'cursor');
    if (rawCursor !== '') {
      try {
        cursorValue = JSON.parse(rawCursor);
      } catch {
        cursorValue = null;
      }
    }
    const hasCursor = cursorValue !== null && typeof cursorValue === 'object';
    let url = 'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1';
    if (hasCursor) {
      if (typeof cursorValue.maxTime === 'string') {
        url += `&max_time=${urlEncode(cursorValue.maxTime)}`;
      }
      if (typeof cursorValue.lastId === 'string') {
        url += `&last_id=${urlEncode(cursorValue.lastId)}`;
      }
    }
    const headers = {
      'x-app-id': 'bVBF4FyRTn5NJF5n',
      'x-version': '1.0.0',
      referer: 'https://www.jin10.com/',
      origin: 'https://www.jin10.com/',
    };
    let rows = [];
    let reason = '';
    try {
      const result = await gw.request({ url, headers, responseType: 'json' });
      const v = result.data;
      if (v && typeof v === 'object' && v.status === 200) {
        const list = Array.isArray(v.data) ? v.data : [];
        for (const raw of list) {
          const id = str(raw && typeof raw === 'object' ? raw.id : undefined);
          if (id === '') continue;
          const d = raw && typeof raw === 'object' ? raw.data : null;
          const content = stripHtml(
            d && typeof d.content === 'string'
              ? d.content
              : d && typeof d.title === 'string'
                ? d.title
                : '',
          );
          if (content === '') continue;
          if (d && d.lock === true) continue;
          if (
            content.includes('VIP专享') ||
            content.includes('解锁直达') ||
            content.includes('升级')
          ) {
            continue;
          }
          rows.push({
            id,
            time: raw.time !== undefined ? raw.time : null,
            data: { content },
            url:
              d && typeof d === 'object' && 'link' in d
                ? d.link
                : 'https://www.jin10.com/flash',
          });
        }
      } else {
        const status = v && typeof v === 'object' ? v.status : null;
        reason = `金十返回异常 ${status !== null && status !== undefined ? String(status) : 'null'}`;
      }
    } catch (error) {
      reason = error.message;
    }
    rows = rows.slice(0, limit);
    let actual = 'jin10';
    let degraded = false;
    if (rows.length === 0) {
      if (hasCursor) return fail('真实金十快讯接口不可用', reason);
      try {
        const clsRows = await loadCls(limit, '');
        if (clsRows.length > 0) {
          rows = clsRows.slice(0, limit).map((row) => ({
            id: row.id,
            time: row.time,
            data: { content: row.summary === '' ? row.title : row.summary },
            url: row.url,
          }));
          actual = 'cls';
          degraded = true;
        } else {
          return fail('真实金十快讯接口不可用', reason);
        }
      } catch {
        return fail('真实金十快讯接口不可用', reason);
      }
    }
    const label = actual === 'jin10' ? '金十' : '财联社';
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    // serde_json Map 按键名排序输出，与 Rust .to_string() 一致（lastId 在前）。
    const nextCursor = last
      ? JSON.stringify({ lastId: last.id, maxTime: last.time })
      : null;
    return okExtra(
      {
        data: rows,
        nextCursor,
        hasMore: nextCursor !== null && rows.length > 0,
        source: actual,
        sourceLabel: label,
      },
      { meta: sourceMeta('news', actual, label, degraded, reason, 'jin10') },
    );
  }

  /* --------------------------------------------------------------- /stock-news */

  async function stockNewsEnv(query) {
    const code = q(query, 'code').trim();
    if (!symbol.validCode(code)) return fail('缺少股票代码', '');
    const name = Array.from(q(query, 'name').trim()).slice(0, 24).join('');
    const limit = intQ(query, 'limit', 6, 1, 10);
    const keyword = name !== '' ? name : code;
    const param = urlEncode(
      JSON.stringify({
        uid: '',
        keyword,
        type: ['cmsArticleWebOld'],
        client: 'web',
        clientType: 'web',
        clientVersion: 'curr',
        param: {
          cmsArticleWebOld: {
            searchScope: 'default',
            sort: 'default',
            pageIndex: 1,
            pageSize: limit,
            preTag: '<em>',
            postTag: '</em>',
          },
        },
      }),
    );
    const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery_fund_tracker_stock_news&param=${param}&_=${Date.now()}`;
    let text;
    try {
      text = await gwText({
        url,
        em: true,
        headers: { referer: `https://so.eastmoney.com/news/s?keyword=${urlEncode(keyword)}` },
        cacheTtl: 300,
      });
    } catch (error) {
      return failApi('个股新闻接口不可用', error);
    }
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    if (start < 0 || end <= start) return fail('个股新闻接口不可用', '东财新闻返回格式异常');
    let v;
    try {
      v = JSON.parse(text.slice(start + 1, end));
    } catch (error) {
      return fail('个股新闻接口不可用', error.message);
    }
    const rows =
      v && v.result && Array.isArray(v.result.cmsArticleWebOld)
        ? v.result.cmsArticleWebOld
        : [];
    const items = [];
    for (const row of rows.slice(0, limit)) {
      const title = stripHtml(typeof row.title === 'string' ? row.title : '');
      if (title === '') continue;
      // Rust: x.get("content").or_else(|| x.get("summary")) —— 键存在性语义，null 不回退。
      const summaryRaw = 'content' in row ? row.content : row.summary;
      const summary = stripHtml(typeof summaryRaw === 'string' ? summaryRaw : '');
      const articleCode = str(field(row, 'code'));
      items.push({
        title,
        summary,
        time: field(row, 'date'),
        source: field(row, 'mediaName'),
        url: articleCode !== '' ? `https://finance.eastmoney.com/a/${articleCode}.html` : '',
      });
    }
    if (items.length === 0) return fail('个股新闻接口不可用', '个股新闻为空');
    const positiveWords = [
      '订单', '增长', '预增', '扭亏', '回购', '合作', '中标', '突破', '量产', '扩产',
      '涨价', '政策', '获批', '创新高', '机构调研', '出海', '投产', '回升',
    ];
    const riskWords = [
      '减持', '亏损', '处罚', '问询', '立案', '下滑', '诉讼', '终止', '风险', '解禁',
      '质押', '退市', '暴雷', '商誉',
    ];
    const corpus = items.map((item) => `${item.title} ${item.summary}`).join(' ');
    const positiveHits = positiveWords.filter((word) => corpus.includes(word));
    const riskHits = riskWords.filter((word) => corpus.includes(word));
    const score = round(positiveHits.length * 0.8 - riskHits.length * 1.1, 1);
    return ok({
      code,
      name,
      source: 'eastmoney',
      sourceLabel: '东方财富新闻',
      count: items.length,
      items,
      score: { score, positiveHits, riskHits },
    });
  }

  /* ---------------------------------------------------------------- /stock-risk */

  function date90() {
    const d = shanghaiTodayDate();
    d.setUTCDate(d.getUTCDate() + 90);
    return fmtYmdDash(d);
  }

  async function stockRiskEnv(query) {
    const code = q(query, 'code').trim();
    if (!symbol.validCode(code)) return fail('缺少股票代码', '');
    const limit = intQ(query, 'limit', 8, 1, 20);

    const announceP = (async () => {
      if (code.startsWith('0') || code.startsWith('3')) {
        const body = JSON.stringify({
          channelCode: ['listedNotice_disc'],
          pageSize: limit,
          pageNum: 1,
          stock: [code],
        });
        try {
          const v = await gwJson({
            url: 'https://www.szse.cn/api/disc/announcement/annList',
            headers: {
              'content-type': 'application/json',
              referer: 'https://www.szse.cn/disclosure/listed/notice/index.html',
            },
            body,
            cacheTtl: 1800,
          });
          const rows = v && Array.isArray(v.data) ? v.data : [];
          const items = [];
          for (const row of rows) {
            const title = str(row ? row.title : undefined);
            if (title === '') continue;
            const attach = row && typeof row.attachPath === 'string' ? row.attachPath : null;
            items.push({
              title,
              time: str(row ? row.publishTime : undefined).slice(0, 10),
              pdf: attach !== null ? `https://disc.static.szse.cn/download${attach}` : '',
            });
          }
          if (items.length > 0) return [items, 'szse', false, ''];
        } catch {
          // fall through to eastmoney below
        }
      }
      const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${code}&f_node=0&s_node=0`;
      const v = await gwJson({ url, em: true, cacheTtl: 1800 });
      const rows = v && v.data && Array.isArray(v.data.list) ? v.data.list : [];
      const items = [];
      for (const row of rows) {
        const title = str(row ? row.title : undefined);
        if (title === '') continue;
        const artCode = row && typeof row.art_code === 'string' ? row.art_code : null;
        items.push({
          title,
          time: str(row ? row.notice_date : undefined).slice(0, 10),
          pdf: artCode !== null ? `https://pdf.dfcfw.com/pdf/H2_${artCode}_1.pdf` : '',
        });
      }
      // Rust 元组：第三元素 = 代码以 0/3 开头（深市降级标记），第四元素恒为空串。
      return [items, 'eastmoney', code.startsWith('0') || code.startsWith('3'), ''];
    })();

    const lockP = (async () => {
      const filter = `(SECURITY_CODE="${code}")(FREE_DATE<='${date90()}')`;
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LIFT_STAGE&columns=ALL&filter=${urlEncode(filter)}&pageSize=60&pageNumber=1&sortColumns=FREE_DATE&sortTypes=-1`;
      const v = await gwJson({ url, em: true, cacheTtl: 1800 });
      const rows =
        v && v.result && Array.isArray(v.result.data) ? v.result.data : [];
      const historyRaw = [];
      const upcoming = [];
      for (const row of rows) {
        const date = str(row ? row.FREE_DATE : undefined).slice(0, 10);
        if (date === '') continue;
        let ratio = numJson(field(row, 'FREE_RATIO'));
        if (ratio !== null && Math.abs(ratio) <= 1) ratio = ratio * 100;
        const item = {
          date,
          type: field(row, 'FREE_SHARES_TYPE'),
          shares: numJson(field(row, 'FREE_SHARES')),
          ableShares: numJson(field(row, 'ABLE_FREE_SHARES')),
          ratioPct: ratio,
        };
        if (date < todayIso()) historyRaw.push(item);
        else upcoming.push(item);
      }
      const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
      const byDateAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      const history = historyRaw.sort(byDateDesc).slice(0, 10);
      upcoming.sort(byDateAsc);
      return { history, upcoming };
    })();

    const [announceResult, lockResult] = await Promise.allSettled([announceP, lockP]);
    const announceOk = announceResult.status === 'fulfilled';
    const lockOk = lockResult.status === 'fulfilled';
    const announcements = announceOk
      ? { available: true, items: announceResult.value[0], source: announceResult.value[1] }
      : {
          available: false,
          items: [],
          source: null,
          error: announceResult.reason ? announceResult.reason.message : '公告读取失败',
        };
    const lockup = lockOk
      ? { available: true, history: lockResult.value.history, upcoming: lockResult.value.upcoming }
      : {
          available: false,
          history: [],
          upcoming: [],
          error: lockResult.reason ? lockResult.reason.message : '解禁读取失败',
        };
    const announceMeta = announceOk
      ? {
          actual: announceResult.value[1],
          actualLabel: announceResult.value[1] === 'szse' ? '深圳证券交易所' : '东方财富',
          degraded: announceResult.value[2],
          fallbackReason: announceResult.value[3],
          attempts: announceResult.value[2]
            ? [
                { source: 'szse', status: 'empty' },
                { source: 'eastmoney', status: 200 },
              ]
            : [],
        }
      : {
          actual: null,
          error: announceResult.reason ? announceResult.reason.message : '',
          attempts: [
            {
              source: 'eastmoney',
              status: announceResult.reason ? announceResult.reason.status : null,
              reason: announceResult.reason ? announceResult.reason.message : '',
            },
          ],
        };
    const lockupMeta = lockOk
      ? {
          actual: 'eastmoney',
          actualLabel: '东方财富',
          attempts: [{ source: 'eastmoney', status: 200 }],
        }
      : {
          actual: null,
          error: lockResult.reason ? lockResult.reason.message : '',
          attempts: [
            {
              source: 'eastmoney',
              status: lockResult.reason ? lockResult.reason.status : null,
              reason: lockResult.reason ? lockResult.reason.message : '',
            },
          ],
        };
    return okExtra(
      { code, announcements, lockup },
      {
        meta: {
          asOf: nowIso(),
          degraded: !announceOk || !lockOk || (announceOk && announceResult.value[2]),
          stale: false,
          sources: { announcements: announceMeta, lockup: lockupMeta },
        },
      },
    );
  }

  /* -------------------------------------------------------------- /dragon-tiger */

  async function loadDzse(date) {
    const url = `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1842_xxpl&TABKEY=tab1&txtStart=${date}&txtEnd=${date}&random=0.9`;
    const v = await gwJson({
      url,
      headers: { referer: 'https://www.szse.cn/disclosure/supervision/dealinfo/index.html' },
      cacheTtl: 1800,
    });
    const first = Array.isArray(v) ? v[0] : undefined;
    const rows = first && Array.isArray(first.data) ? first.data : [];
    const out = [];
    for (const row of rows) {
      const code = str(row ? row.zqdm : undefined);
      if (!symbol.validCode(code)) continue;
      out.push({
        code,
        name: field(row, 'zqjc'),
        reason:
          row && 'plyy' in row ? row.plyy : '深交所公开交易信息',
        netBuyWan: null,
      });
    }
    return out;
  }

  async function loadSse(date) {
    const url = `https://query.sse.com.cn/infodisplay/showTradePublicFile.do?jsonCallBack=cb&isPagination=false&dateTx=${date}`;
    const text = await gwText({
      url,
      headers: { referer: 'https://www.sse.com.cn/disclosure/diclosure/public/' },
      cacheTtl: 1800,
    });
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    if (start < 0 || end <= start) return [];
    const v = JSON.parse(text.slice(start + 1, end));
    const rows = v && Array.isArray(v.fileContents) ? v.fileContents : [];
    const seen = new Set();
    const out = [];
    const pattern = /证券代码：\s*(\d{6}).*证券简称：\s*([^\s]+)/;
    for (const line of rows) {
      if (typeof line !== 'string') continue;
      const m = pattern.exec(line);
      if (!m) continue;
      const code = m[1];
      if (seen.has(code)) continue;
      seen.add(code);
      out.push({ code, name: m[2].trim(), reason: '上交所公开交易信息', netBuyWan: null });
    }
    return out;
  }

  async function dragonTigerEnv() {
    const url =
      'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=40&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILS&columns=ALL';
    let reason = '';
    try {
      const v = await gwJson({ url, em: true, cacheTtl: 1800 });
      const rows = v && v.result && Array.isArray(v.result.data) ? v.result.data : [];
      const stocks = [];
      for (const row of rows) {
        const codeText = str(row ? row.SECURITY_CODE : undefined);
        if (!symbol.validCode(codeText)) continue;
        const net = numJson(field(row, 'BILLBOARD_NET_AMT'));
        stocks.push({
          code: codeText,
          name: field(row, 'SECURITY_NAME_ABBR'),
          reason:
            row && 'EXPLANATION' in row
              ? row.EXPLANATION
              : row && 'EXPLAIN' in row
                ? row.EXPLAIN
                : '',
          netBuyWan: net !== null ? net / 10000 : null,
        });
      }
      if (stocks.length > 0) {
        const firstDate =
          rows.length > 0 ? str(rows[0] ? rows[0].TRADE_DATE : undefined).slice(0, 10) : '';
        return okExtra(
          { date: firstDate, stocks },
          { meta: sourceMeta('dragonTiger', 'eastmoney', '东方财富', false, '', 'eastmoney') },
        );
      }
      reason = '东方财富: 数据为空';
    } catch (error) {
      reason = error.message;
    }
    const base = shanghaiTodayDate();
    for (let offset = 0; offset < 7; offset += 1) {
      const d = new Date(base.getTime());
      d.setUTCDate(d.getUTCDate() - offset);
      const date = fmtYmdDash(d);
      const dzse = await loadDzse(date).catch(() => []);
      const sse = await loadSse(date).catch(() => []);
      const stocks = [...dzse, ...sse];
      if (stocks.length > 0) {
        return okExtra(
          { date, stocks },
          {
            meta: sourceMeta(
              'dragonTiger',
              'official-exchange',
              '沪深交易所',
              true,
              reason,
              'eastmoney',
            ),
          },
        );
      }
    }
    return fail('真实龙虎榜接口不可用', reason);
  }

  /* ------------------------------------------------------------- /fund-flow-120d */

  function flowRow(raw) {
    const parts = raw.split(',');
    if (parts.length === 0 || parts[0] === '') return null;
    return {
      date: parts[0],
      mainNet: numJson(parts[1]),
      smallNet: numJson(parts[2]),
      midNet: numJson(parts[3]),
      largeNet: numJson(parts[4]),
      superNet: numJson(parts[5]),
      pct: numJson(parts[6]),
    };
  }

  function sumFlow(rows, days) {
    const values = [];
    for (const row of rows.slice(-days)) {
      if (row.mainNet !== null && row.mainNet !== undefined) values.push(row.mainNet);
    }
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0);
  }

  async function flowNames(codes) {
    const usable = codes.filter((code) => !symbol.isLegacyBeijing(code));
    if (usable.length === 0) return new Map();
    const joined = usable.map((code) => symbol.tencentSymbol(code)).join(',');
    const text = await gwGbk({ url: `https://qt.gtimg.cn/q=${joined}` });
    const names = new Map();
    for (const rawLine of text.split(';')) {
      const line = rawLine.trim();
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const keyPart = line.slice(2, eq);
      const code = keyPart.length >= 2 ? keyPart.slice(2) : undefined;
      const first = line.indexOf('"');
      const last = line.lastIndexOf('"');
      if (first < 0 || last <= first || code === undefined) continue;
      const parts = line.slice(first + 1, last).split('~');
      if (parts.length > 1 && !names.has(code)) names.set(code, parts[1]);
    }
    return names;
  }

  async function fundFlowEnv(query) {
    const codes = q(query, 'codes')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => symbol.validCode(c))
      .slice(0, 10);
    if (codes.length === 0) return fail('缺少股票代码', '');
    const days = intQ(query, 'days', 60, 5, 120);
    const names = await flowNames(codes).catch(() => new Map());
    const items = [];
    const sourcesSeen = new Set();
    for (const code of codes) {
      // Rust: names.get(code).cloned().unwrap_or_default() —— 缺失时为空串，不是代码本身。
      const name = names.has(code) ? names.get(code) : '';
      if (symbol.isLegacyBeijing(code)) {
        items.push({
          available: false,
          code,
          name,
          source: null,
          sourceLabel: '',
          fallbackReason: '北交所旧代码已迁移，请使用 920xxx 新代码',
          recent: [],
          summary: { main_5d: null, main_20d: null, main_60d: null, today: null },
          latestDate: null,
        });
        continue;
      }
      let fallback = '';
      let rows = [];
      let source = 'eastmoney';
      let sourceLabel = '东方财富';
      try {
        const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${symbol.eastmoneySecid(code)}&klt=101&lmt=${days}&fields1=f1%2Cf2%2Cf3%2Cf7&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57`;
        const v = await gwJson({
          url,
          em: true,
          headers: { referer: 'https://quote.eastmoney.com/' },
          cacheTtl: 600,
        });
        const klines =
          v && v.data && Array.isArray(v.data.klines) ? v.data.klines : [];
        rows = klines
          .filter((line) => typeof line === 'string')
          .map(flowRow)
          .filter((row) => row !== null);
      } catch (error) {
        fallback = `东方财富: ${error.message}`;
        rows = [];
      }
      if (rows.length === 0) {
        source = 'sina';
        sourceLabel = '新浪财经';
        try {
          const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=${days}&sort=opendate&asc=0&daima=${symbol.tencentSymbol(code)}`;
          const text = await gwText({
            url,
            headers: { referer: 'https://finance.sina.com.cn/' },
            cacheTtl: 600,
          });
          const start = text.indexOf('[');
          const end = text.lastIndexOf(']');
          const parsed =
            start >= 0 && end >= start ? JSON.parse(text.slice(start, end + 1)) : [];
          const rawRows = Array.isArray(parsed) ? parsed : [];
          rows = rawRows.map((line) => {
            const changeratio = numStrip(field(line, 'changeratio'));
            return {
              date: field(line, 'opendate'),
              mainNet: numStrip(field(line, 'netamount')),
              smallNet: null,
              midNet: null,
              largeNet: null,
              superNet: null,
              pct: changeratio !== null ? changeratio * 100 : null,
            };
          });
          rows.sort((a, b) => {
            const x = String(a.date);
            const y = String(b.date);
            return x < y ? -1 : x > y ? 1 : 0;
          });
        } catch {
          rows = [];
        }
      }
      if (rows.length === 0) {
        items.push({
          available: false,
          code,
          name,
          source: null,
          sourceLabel: '',
          fallbackReason: fallback !== '' ? fallback : '资金流不可用',
          recent: [],
          summary: { main_5d: null, main_20d: null, main_60d: null, today: null },
          latestDate: null,
        });
        continue;
      }
      const last = rows[rows.length - 1];
      items.push({
        available: true,
        code,
        name,
        source,
        sourceLabel,
        fallbackReason: fallback,
        recent: rows.slice(-10),
        summary: {
          main_5d: sumFlow(rows, 5),
          main_20d: sumFlow(rows, 20),
          main_60d: sumFlow(rows, 60),
          today: {
            main: last.mainNet !== undefined ? last.mainNet : null,
            large: last.largeNet !== undefined ? last.largeNet : null,
            medium: last.midNet !== undefined ? last.midNet : null,
            small: last.smallNet !== undefined ? last.smallNet : null,
          },
        },
        latestDate: last.date !== undefined ? last.date : null,
      });
      sourcesSeen.add(source);
      if (codes.length > 1) await sleepMs(200);
    }
    const degraded =
      items.some((item) => !item.available) ||
      items.some((item) => item.source !== 'eastmoney');
    const actual =
      sourcesSeen.size === 1 ? [...sourcesSeen][0] : sourcesSeen.size === 0 ? null : 'mixed';
    return okExtra(
      { days, count: items.length, items },
      {
        meta: {
          asOf: nowIso(),
          degraded,
          stale: false,
          sources: {
            fundFlow: {
              actual,
              unavailable: items.filter((item) => !item.available).map((item) => item.code),
            },
          },
        },
      },
    );
  }

  /* -------------------------------------------------------------- /market-data */

  function formatYi(value) {
    return `${value > 0 ? '+' : ''}${(value / 1e8).toFixed(2)}亿`;
  }
  function formatPct(value) {
    if (value === null || value === undefined) return '--';
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  }

  async function marketIndexEnv() {
    let text;
    try {
      text = await gwGbk({
        url: 'https://qt.gtimg.cn/q=s_sh000001,s_sz399001,s_sz399006,s_sh000688',
      });
    } catch (error) {
      return fail('真实行情接口不可用', error.message, error.status);
    }
    const defs = [
      ['shangzhi', 's_sh000001', 'sh000001', '上证指数'],
      ['shengzheng', 's_sz399001', 'sz399001', '深证成指'],
      ['chuangye', 's_sz399006', 'sz399006', '创业板指'],
      ['zhuanke50', 's_sh000688', 'sh000688', '科创50'],
    ];
    const asOf = nowIso();
    const items = {};
    for (const [key, quoteCode, minuteCode, fallbackName] of defs) {
      let found = null;
      for (const part of text.split(';')) {
        if (!part.includes(quoteCode)) continue;
        const first = part.indexOf('"');
        const last = part.lastIndexOf('"');
        if (first < 0 || last <= first) continue;
        const fields = part.slice(first + 1, last).split('~');
        const price = strictNum(fields[3]);
        const changeAmount = strictNum(fields[4]);
        const changePercent = strictNum(fields[5]);
        found = {
          name: fields[1] !== undefined && fields[1] !== '' ? fields[1] : fallbackName,
          price,
          changeAmount,
          changePercent,
        };
        break;
      }
      if (found === null) {
        return fail('真实行情接口不可用', `指数无数据 ${quoteCode}`);
      }
      let date = '';
      let spark = [];
      try {
        const v = await gwJson({
          url: `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${minuteCode}`,
          headers: { referer: 'https://gu.qq.com/' },
          cacheTtl: 60,
        });
        const inner = v && v.data ? v.data[minuteCode] : undefined;
        const block = inner && inner.data ? inner.data : undefined;
        if (block) {
          const rawDate = typeof block.date === 'string' ? block.date : '';
          if (/^\d{8}$/.test(rawDate)) {
            date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
          }
          const rows = Array.isArray(block.data) ? block.data : [];
          spark = rows
            .map((line) => (typeof line === 'string' ? numStrip(line.split(' ')[1]) : null))
            .filter((n) => n !== null);
        }
      } catch {
        date = '';
        spark = [];
      }
      items[key] = {
        name: found.name,
        value: found.price !== null ? found.price.toFixed(2) : '--',
        priceValue: found.price,
        change: `${found.changeAmount !== null && found.changeAmount > 0 ? '+' : ''}${found.changeAmount !== null ? found.changeAmount.toFixed(2) : '--'} / ${formatPct(found.changePercent)}`,
        changePercent: found.changePercent !== null ? found.changePercent : 0,
        sparkline: spark,
        sparklineDate: date,
        asOf,
      };
    }
    return okExtra(items, { meta: { degraded: false, stale: false } });
  }

  async function marketBreadthEnv() {
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.000002%2C0.399107%2C0.899050&fields=f12%2Cf14%2Cf104%2Cf105%2Cf106';
    let v;
    try {
      v = await gwJson({
        url,
        em: true,
        headers: { referer: 'https://quote.eastmoney.com/' },
        cacheTtl: 30,
        timeout: 15,
      });
    } catch (error) {
      return fail('市场涨跌家数暂不可用', error.message, error.status);
    }
    const diff =
      v && v.data && v.data.diff !== undefined && v.data.diff !== null ? v.data.diff : null;
    const rows = diff === null ? [] : Array.isArray(diff) ? diff : Object.values(diff);
    const defs = [
      ['000002', '上证A股'],
      ['399107', '深证A股'],
      ['899050', '北交所'],
    ];
    const markets = [];
    try {
      for (const [code, fallbackName] of defs) {
        const row = rows.find((r) => r && typeof r.f12 === 'string' && r.f12 === code);
        if (!row) continue;
        const count = (raw) => {
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
            throw new Error(`市场涨跌家数字段无效 ${code}`);
          }
          return raw;
        };
        const up = count(row.f104);
        const down = count(row.f105);
        const flat = count(row.f106);
        markets.push({
          code,
          name: typeof row.f14 === 'string' && row.f14 !== '' ? row.f14 : fallbackName,
          up,
          down,
          flat,
          covered: up + down + flat,
        });
      }
    } catch (error) {
      return fail('市场涨跌家数暂不可用', error.message);
    }
    if (markets.length === 0) {
      return fail('市场涨跌家数暂不可用', '东财未返回三大市场涨跌家数');
    }
    const sum = (key) => markets.reduce((total, m) => total + m[key], 0);
    return okExtra(
      {
        available: true,
        up: sum('up'),
        down: sum('down'),
        flat: sum('flat'),
        covered: sum('covered'),
        markets,
        source: 'eastmoney',
        sourceLabel: '东方财富',
      },
      {
        meta: {
          asOf: nowIso(),
          degraded: false,
          stale: false,
          sources: {
            marketBreadth: { actual: 'eastmoney', actualLabel: '东方财富', status: 'live' },
          },
        },
      },
    );
  }

  async function marketSectorPanoramaEnv() {
    const targets = [
      ['BK1128', 'CPO'], ['BK0459', '电子元件'], ['BK1036', '半导体'], ['BK1137', '存储芯片'],
      ['BK0922', '数据中心'], ['BK0579', '云计算'], ['BK1111', 'AIGC'], ['BK0963', '商业航天'],
      ['BK1408', '机器人'], ['BK0802', '无人驾驶'], ['BK0457', '电网设备'], ['BK0577', '核电'],
      ['BK0428', '电力'], ['BK1031', '光伏'], ['BK1303', '锂电池'], ['BK1204', '军工'],
      ['BK0464', '石油石化'], ['BK0843', '天然气'], ['BK0478', '有色金属'], ['BK1617', '黄金'],
      ['BK0475', '银行'], ['BK0474', '保险'], ['BK1216', '生物医药'], ['BK1711', '消费'],
      ['BK1037', '消费电子'],
    ];
    const secids = targets.map(([code]) => `90.${code}`).join('%2C');
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids}&fields=f12%2Cf14%2Cf3`;
    let v;
    try {
      v = await gwJson({
        url,
        em: true,
        headers: { referer: 'https://quote.eastmoney.com/' },
        cacheTtl: 30,
        timeout: 15,
      });
    } catch (error) {
      return fail('行业全景暂不可用', error.message, error.status);
    }
    const diff =
      v && v.data && v.data.diff !== undefined && v.data.diff !== null ? v.data.diff : null;
    if (diff === null) return fail('行业全景暂不可用', '东财未返回行业全景');
    const rows = Array.isArray(diff) ? diff : Object.values(diff);
    const byCode = new Map();
    for (const row of rows) {
      if (row && typeof row.f12 === 'string' && !byCode.has(row.f12)) byCode.set(row.f12, row);
    }
    const items = [];
    let available = 0;
    for (const [code, name] of targets) {
      const row = byCode.get(code);
      let changePct = null;
      if (row) {
        const parsed = numStrip(row.f3);
        if (parsed !== null && Number.isFinite(parsed)) {
          changePct = parsed;
          available += 1;
        }
      }
      items.push({
        code,
        name,
        sourceName: row && typeof row.f14 === 'string' ? row.f14 : '',
        changePct,
      });
    }
    if (available === 0) return fail('行业全景暂不可用', '东财未返回有效行业涨跌幅');
    return okExtra(
      { available: true, availableCount: available, total: targets.length, items },
      {
        meta: {
          asOf: nowIso(),
          degraded: false,
          stale: false,
          sources: {
            sectorPanorama: { actual: 'eastmoney', actualLabel: '东方财富', status: 'live' },
          },
        },
      },
    );
  }

  async function capitalMainEm() {
    const url =
      'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fs=m%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23%2Cm%3A0%2Bt%3A81%2Bs%3A2048&fields=f12%2Cf14%2Cf62%2Cf66%2Cf72%2Cf78%2Cf84';
    const v = await gwJson({ url, em: true, timeout: 15 });
    const diff = v && v.data ? v.data.diff : undefined;
    if (diff === undefined || diff === null) {
      throw new Error('东财全市场资金流为空');
    }
    const rows = Array.isArray(diff) ? diff : Object.values(diff);
    if (rows.length === 0) throw new Error('东财全市场资金流为空');
    const sum = (key) =>
      rows.reduce((total, row) => total + (numStrip(row ? row[key] : null) ?? 0), 0);
    const main = sum('f62');
    const bucket = (label, value) => ({
      available: true,
      label,
      value: formatYi(value),
      isPositive: value >= 0,
    });
    return {
      available: true,
      source: 'eastmoney',
      sourceLabel: '东方财富',
      label: '主力',
      value: formatYi(main),
      isPositive: main >= 0,
      note: '东方财富全市场主力净流入',
      degraded: false,
      breakdown: {
        superLarge: bucket('超大单', sum('f66')),
        large: bucket('大单', sum('f72')),
        medium: bucket('中单', sum('f78')),
        small: bucket('小单', sum('f84')),
      },
    };
  }

  async function capitalMainSina(primaryError) {
    const url =
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj?page=1&num=7000&sort=symbol&asc=1&bankuai=hs_a&shichang=';
    const v = await gwJson({
      url,
      headers: { referer: 'https://finance.sina.com.cn/' },
      cacheTtl: 60,
      timeout: 20,
    });
    if (!Array.isArray(v) || v.length < 100) {
      throw new Error('新浪全市场资金流为空');
    }
    const sum = (key) =>
      v.reduce((total, row) => total + (numStrip(row ? row[key] : null) ?? 0), 0);
    const r0Net = sum('r0_net');
    const r0In = sum('r0_in');
    const r0Out = sum('r0_out');
    const r3Net = sum('r3_net');
    if (![r0Net, r0In, r0Out, r3Net].every(Number.isFinite)) {
      throw new Error('新浪全市场资金流字段无效');
    }
    return {
      available: true,
      source: 'sina',
      sourceLabel: '新浪财经',
      label: '主力',
      value: formatYi(r0Net),
      isPositive: r0Net >= 0,
      note: '新浪口径：主力为单笔成交额不低于 100 万元',
      degraded: true,
      breakdown: {
        superLarge: { available: false, label: '特大单', value: '--', isPositive: null },
        large: { available: true, label: '主力流入', value: formatYi(r0In), isPositive: r0In >= 0 },
        medium: { available: true, label: '主力流出', value: formatYi(-r0Out), isPositive: -r0Out >= 0 },
        small: { available: true, label: '散户', value: formatYi(r3Net), isPositive: r3Net >= 0 },
      },
      fallbackReason: `东方财富: ${primaryError}`,
    };
  }

  async function capitalNorthIntraday() {
    try {
      const v = await gwJson({
        url: 'https://data.hexin.cn/market/hsgtApi/method/dayChart/',
        headers: { referer: 'https://data.hexin.cn/' },
      });
      const times = v && Array.isArray(v.time) ? v.time : [];
      const values = v && Array.isArray(v.hgt) ? v.hgt : [];
      let latest = null;
      const len = Math.min(times.length, values.length);
      for (let i = 0; i < len; i += 1) {
        const n = numStrip(values[i]);
        if (n !== null) latest = [times[i], n];
      }
      if (latest === null) return { available: false, value: '--', isPositive: null, time: '' };
      return {
        available: true,
        value: `${latest[1] > 0 ? '+' : ''}${latest[1].toFixed(2)}亿`,
        isPositive: latest[1] >= 0,
        time: latest[0] !== undefined ? latest[0] : null,
      };
    } catch {
      return { available: false, value: '--', isPositive: null, time: '' };
    }
  }

  async function capitalHkex() {
    const base = Date.now();
    for (let offset = 0; offset < 7; offset += 1) {
      const key = fmtYmd(shanghaiDate(base - offset * 86400000));
      try {
        const text = await gwText({
          url: `https://www.hkex.com.hk/chi/csm/DailyStat/data_tab_daily_${key}c.js`,
          headers: { referer: 'https://www.hkex.com.hk/' },
          cacheTtl: 1800,
        });
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start < 0 || end < start) continue;
        const rows = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(rows)) continue;
        const north = rows.filter(
          (row) => row && typeof row.market === 'string' && row.market.includes('Northbound'),
        );
        let total = 0;
        let any = false;
        for (const row of north) {
          const cell =
            row.content && row.content[0] && row.content[0].table &&
            row.content[0].table.tr && row.content[0].table.tr[0] &&
            row.content[0].table.tr[0].td && row.content[0].table.tr[0].td[0]
              ? row.content[0].table.tr[0].td[0][0]
              : undefined;
          const n = numStrip(cell);
          if (n !== null) {
            total += n;
            any = true;
          }
        }
        if (any && total > 0) {
          return {
            available: true,
            value: `${(total / 100).toFixed(2)}亿`,
            isPositive: null,
            date: north.length > 0 && north[0].date !== undefined ? north[0].date : null,
          };
        }
      } catch {
        // try previous day
      }
    }
    return { available: false, value: '--', isPositive: null, date: '' };
  }

  async function marketCapitalEnv() {
    const mainP = (async () => {
      try {
        return await capitalMainEm();
      } catch (primaryError) {
        try {
          return await capitalMainSina(primaryError.message);
        } catch (secondError) {
          const empty = (label) => ({ label, value: '--', isPositive: null });
          return {
            available: false,
            source: null,
            sourceLabel: '',
            label: '主力',
            value: '--',
            isPositive: null,
            note: `东方财富: ${primaryError.message}; 新浪财经: ${secondError.message}`,
            degraded: false,
            breakdown: {
              superLarge: empty('超大单'),
              large: empty('大单'),
              medium: empty('中单'),
              small: empty('小单'),
            },
          };
        }
      }
    })();
    const [mainFund, northHgtIntraday, northboundDaily] = await Promise.all([
      mainP,
      capitalNorthIntraday(),
      capitalHkex(),
    ]);
    const statusOf = (part) => {
      if (part.available !== true) return 'unavailable';
      return part.degraded === true ? 'fallback' : 'live';
    };
    return okExtra(
      { mainFund, northHgtIntraday, northboundDaily },
      {
        meta: {
          asOf: nowIso(),
          degraded:
            mainFund.available !== true ||
            mainFund.degraded === true ||
            northHgtIntraday.available !== true ||
            northboundDaily.available !== true,
          stale: false,
          sources: {
            marketFund: {
              actual: mainFund.source !== undefined ? mainFund.source : null,
              actualLabel: mainFund.sourceLabel !== undefined ? mainFund.sourceLabel : '',
              status: statusOf(mainFund),
              fallbackReason:
                mainFund.fallbackReason !== undefined ? mainFund.fallbackReason : null,
            },
            northHgtIntraday: { actual: 'hexin', status: statusOf(northHgtIntraday) },
            northboundDaily: { actual: 'hkex', status: statusOf(northboundDaily) },
          },
        },
      },
    );
  }

  function boardSpec(boardType) {
    if (boardType === '' || boardType === 'industry') return ['m:90+t:2', '9', 'industry'];
    if (boardType === 'concept') return ['m:90+t:3', '1', 'concept'];
    if (boardType === 'region') return ['m:90+t:1', '8', 'region'];
    throw new Error('无效的板块类型');
  }

  function periodSpec(period) {
    if (period === '' || period === 'today') return ['f62', 'f184', 'f3', 'f204', 'today'];
    if (period === '5d') return ['f164', 'f165', 'f109', 'f257', '5d'];
    if (period === '10d') return ['f174', 'f175', 'f160', null, '10d'];
    throw new Error('无效的板块资金周期');
  }

  async function sectorSideEm(fs, mainField, mainPctField, changeField, leaderField, inflowSide) {
    const fieldsSet = ['f12', 'f14', changeField, mainField, mainPctField];
    if (leaderField !== null) fieldsSet.push(leaderField);
    const fields = [...new Set(fieldsSet)].sort().join('%2C');
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po=${inflowSide ? 1 : 0}&np=1&fltt=2&invt=2&fid=${mainField}&fs=${urlEncode(fs)}&fields=${fields}`;
    const v = await gwJson({
      url,
      em: true,
      headers: { referer: 'https://quote.eastmoney.com/center/boardlist.html' },
      timeout: 15,
    });
    const diff = v && v.data ? v.data.diff : undefined;
    if (diff === undefined || diff === null) throw new Error('东方财富板块资金为空');
    const rows = Array.isArray(diff) ? diff : Object.values(diff);
    const out = [];
    for (const row of rows) {
      const name = row && typeof row.f14 === 'string' ? row.f14 : null;
      const main = row ? numStrip(row[mainField]) : null;
      if (name === null || main === null) continue;
      if (inflowSide ? main <= 0 : main >= 0) continue;
      out.push({
        name,
        code: row.f12 !== undefined ? row.f12 : '',
        value: formatYi(main),
        mainFundYuan: main,
        mainFundPct: numStrip(row[mainPctField]),
        changePct: numStrip(row[changeField]) ?? 0,
        leader:
          leaderField !== null && typeof row[leaderField] === 'string' ? row[leaderField] : '',
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  async function sectorEm(boardType, period) {
    const [fs, , board] = boardSpec(boardType);
    const [mainField, mainPctField, changeField, leaderField, per] = periodSpec(period);
    const [inflow, outflow] = await Promise.all([
      sectorSideEm(fs, mainField, mainPctField, changeField, leaderField, true),
      sectorSideEm(fs, mainField, mainPctField, changeField, leaderField, false),
    ]);
    return { boardType: board, period: per, inflow, outflow };
  }

  async function sectorSideSina(fenlei, periodKey, inflowSide) {
    const multi = periodKey !== 'today';
    const suffix = periodKey === '5d' ? '_5' : periodKey === '10d' ? '_10' : '';
    const endpoint = multi ? 'ssl_bkzjlxt' : 'ssl_bkzj_bk';
    const asc = multi ? (inflowSide ? 0 : 1) : inflowSide ? 0 : 1;
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.${endpoint}?page=1&num=20&sort=netamount${suffix}&asc=${asc}&fenlei=${fenlei}`;
    const v = await gwJson({
      url,
      headers: { referer: 'https://finance.sina.com.cn/' },
      cacheTtl: 60,
      timeout: 15,
    });
    if (!Array.isArray(v) || v.length === 0) throw new Error('新浪板块资金为空');
    const netKey = `netamount${suffix}`;
    const ratioKey = `ratioamount${suffix}`;
    const changeKey = `avg_changeratio${suffix}`;
    const out = [];
    for (const row of v) {
      const name = row && typeof row.name === 'string' ? row.name : null;
      const main = row ? numStrip(row[netKey]) : null;
      if (name === null || main === null) continue;
      if (inflowSide ? main <= 0 : main >= 0) continue;
      const ratio = numStrip(row[ratioKey]);
      const change = numStrip(row[changeKey]);
      out.push({
        name,
        code: row.category !== undefined ? row.category : '',
        value: formatYi(main),
        mainFundYuan: main,
        mainFundPct: ratio !== null ? ratio * 100 : null,
        changePct: change !== null ? change * 100 : 0,
        leader: !multi && typeof row.ts_name === 'string' ? row.ts_name : '',
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  async function sectorSina(boardType, period) {
    const [, fenlei, board] = boardSpec(boardType);
    const [, , , , per] = periodSpec(period);
    const [inflow, outflow] = await Promise.all([
      sectorSideSina(fenlei, per, true),
      sectorSideSina(fenlei, per, false),
    ]);
    return { boardType: board, period: per, inflow, outflow };
  }

  async function sectorEnv(boardType, period, message) {
    try {
      const data = await sectorEm(boardType, period);
      return okExtra(data, {
        meta: {
          degraded: false,
          stale: false,
          sources: { sector: { actual: 'eastmoney', actualLabel: '东方财富' } },
        },
      });
    } catch (primaryError) {
      try {
        const data = await sectorSina(boardType, period);
        const fallbackReason = `东方财富: ${primaryError.message}`;
        return okExtra(data, {
          meta: {
            degraded: true,
            stale: false,
            fallbackReason,
            sources: {
              sector: {
                actual: 'sina',
                actualLabel: '新浪财经',
                requested: 'eastmoney',
                degraded: true,
                fallbackReason,
                attempts: [
                  { source: 'eastmoney', status: 'failed', reason: primaryError.message },
                  { source: 'sina', status: 200, reason: '备用源成功' },
                ],
              },
            },
          },
        });
      } catch (secondError) {
        const status =
          secondError.status !== null && secondError.status !== undefined
            ? secondError.status
            : primaryError.status;
        return fail(message, `东方财富: ${primaryError.message}; 新浪财经: ${secondError.message}`, status);
      }
    }
  }

  async function marketDataEnv(query) {
    const kind = q(query, 'type');
    if (kind === 'index') return marketIndexEnv();
    if (kind === 'breadth') return marketBreadthEnv();
    if (kind === 'sector-panorama') return marketSectorPanoramaEnv();
    if (kind === 'capital') return marketCapitalEnv();
    if (kind === 'sector') {
      return sectorEnv(q(query, 'boardType'), q(query, 'period'), '真实行情接口不可用');
    }
    if (kind === 'multiday-flow') {
      const period = q(query, 'period') === '' ? '5d' : q(query, 'period');
      return sectorEnv(q(query, 'boardType'), period, '市场资金流接口不可用');
    }
    return fail('未知 market-data 类型', 'market-data type invalid');
  }

  /* -------------------------------------------------------------- /stock-kline */

  function klineNum(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/,/g, '');
      if (cleaned.trim() === '') return null;
      const n = Number(cleaned);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }

  function completeBars(bars) {
    const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return sorted.map((bar, index) => {
      let pct = null;
      if (index > 0) {
        const prev = sorted[index - 1].close;
        if (prev > 0) pct = ((bar.close - prev) / prev) * 100;
      }
      return { ...bar, pct };
    });
  }

  async function loadKlineTencent(code, days) {
    const s = symbol.tencentSymbol(code);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${s},day,,,${days},qfq`;
    const v = await gwJson({ url, headers: { referer: 'https://gu.qq.com/' } });
    const inner = v && v.data ? v.data[s] : undefined;
    const rows =
      inner && Array.isArray(inner.qfqday)
        ? inner.qfqday
        : inner && Array.isArray(inner.day)
          ? inner.day
          : [];
    const bars = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const open = klineNum(row[1]);
      const close = klineNum(row[2]);
      const high = klineNum(row[3]);
      const low = klineNum(row[4]);
      if (open === null || close === null || high === null || low === null) continue;
      bars.push({
        date: typeof row[0] === 'string' ? row[0] : String(row[0]),
        open,
        close,
        high,
        low,
        volume: klineNum(row[5]) ?? 0,
        amount: klineNum(row[6]) ?? 0,
        pct: null,
      });
    }
    const qt = inner && inner.qt ? inner.qt[s] : undefined;
    const name =
      Array.isArray(qt) && typeof qt[1] === 'string' ? qt[1] : '';
    return { name, bars: completeBars(bars) };
  }

  async function loadKlineEastmoney(code, days) {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${symbol.eastmoneySecid(code)}&klt=101&fqt=1&lmt=${days}&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61`;
    const v = await gwJson({
      url,
      em: true,
      headers: { referer: 'https://quote.eastmoney.com/' },
      timeout: 12,
    });
    const rows = v && v.data && Array.isArray(v.data.klines) ? v.data.klines : [];
    const bars = [];
    for (const line of rows) {
      if (typeof line !== 'string') continue;
      const parts = line.split(',');
      if (parts.length < 6) continue;
      const open = strictNum(parts[1]);
      const close = strictNum(parts[2]);
      const high = strictNum(parts[3]);
      const low = strictNum(parts[4]);
      if (open === null || close === null || high === null || low === null) continue;
      bars.push({
        date: parts[0],
        open,
        close,
        high,
        low,
        volume: strictNum(parts[5]) ?? 0,
        amount: strictNum(parts[6]) ?? 0,
        pct: strictNum(parts[8]),
      });
    }
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      name: v && v.data && typeof v.data.name === 'string' ? v.data.name : '',
      bars,
    };
  }

  function sma(values, window) {
    if (values.length < window) return null;
    const slice = values.slice(values.length - window);
    return slice.reduce((a, b) => a + b, 0) / window;
  }

  function emaSeries(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = null;
    for (const value of values) {
      prev = prev === null ? value : value * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function rsi14(closes) {
    if (closes.length <= 14) return null;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= 14; i += 1) {
      const d = closes[i] - closes[i - 1];
      gain += Math.max(d, 0);
      loss += Math.max(-d, 0);
    }
    gain /= 14;
    loss /= 14;
    for (let i = 15; i < closes.length; i += 1) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * 13 + Math.max(d, 0)) / 14;
      loss = (loss * 13 + Math.max(-d, 0)) / 14;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  function analyzeBars(bars) {
    if (bars.length === 0) return null;
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);
    const ma200 = sma(closes, 200);
    const rsi = rsi14(closes);
    const ema12 = emaSeries(closes, 12);
    const ema26 = emaSeries(closes, 26);
    const difSeries = closes.map((_, i) => ema12[i] - ema26[i]);
    const deaSeries = emaSeries(difSeries, 9);
    const dif = difSeries[difSeries.length - 1];
    const dea = deaSeries[deaSeries.length - 1];
    const recent = bars.slice(-250);
    const high = Math.max(...recent.map((b) => b.high));
    const low = Math.min(...recent.map((b) => b.low));
    const position = high > low ? ((close - low) / (high - low)) * 100 : null;
    let momentum = null;
    if (closes.length >= 22) {
      const base = closes[closes.length - 22];
      if (base > 0) momentum = ((close - base) / base) * 100;
    }
    let volumeRatio = null;
    if (bars.length >= 20) {
      const avg =
        bars.slice(-20).reduce((total, b) => total + b.volume, 0) / 20;
      if (avg > 0) volumeRatio = bars[bars.length - 1].volume / avg;
    }
    const latest = bars[bars.length - 1];
    const signals = [];
    let score = 0;
    const add = (title, detail, weight) => {
      signals.push({
        title,
        detail,
        weight,
        type: weight > 0 ? 'positive' : weight < 0 ? 'negative' : 'neutral',
      });
      score += weight;
    };
    if (ma20 !== null) {
      if (close >= ma20) add('站上 MA20', `收盘 高于 20 日均线 ${ma20.toFixed(2)}`, 8);
      else add('跌破 MA20', `收盘 低于 20 日均线 ${ma20.toFixed(2)}`, -8);
    }
    if (ma20 !== null && ma50 !== null) {
      if (ma20 >= ma50) add('中期均线偏强', `MA20 高于 MA50`, 10);
      else add('中期均线偏弱', `MA20 低于 MA50`, -10);
    }
    if (ma50 !== null && ma200 !== null) {
      if (ma50 >= ma200) add('长期趋势向上', 'MA50 高于 MA200', 12);
      else add('长期趋势承压', 'MA50 低于 MA200', -12);
    }
    if (rsi !== null) {
      const detail = `RSI14 ${rsi.toFixed(1)}`;
      if (rsi >= 70) add('RSI 过热', detail, -6);
      else if (rsi >= 55) add('RSI 动能偏强', detail, 8);
      else if (rsi <= 30) add('RSI 超卖', detail, 6);
      else if (rsi < 45) add('RSI 动能偏弱', detail, -6);
    }
    if (dif !== undefined && dea !== undefined) {
      const detail = `DIF ${dif.toFixed(3)} / DEA ${dea.toFixed(3)}`;
      if (dif >= dea) {
        add('MACD 金叉区', detail, 8);
        score += 4;
      } else {
        add('MACD 死叉区', detail, -8);
        score -= 4;
      }
    }
    if (momentum !== null) {
      if (momentum >= 5) add('近 21 日走强', `${momentum.toFixed(2)}%`, 8);
      else if (momentum <= -5) add('近 21 日走弱', `${momentum.toFixed(2)}%`, -8);
    }
    if (position !== null) {
      const detail = `52 周位置 ${position.toFixed(1)}%`;
      if (position >= 65) add('接近区间高位', detail, 6);
      else if (position <= 35) add('处于区间低位', detail, -6);
    }
    if (volumeRatio !== null && volumeRatio >= 1.5 && latest.pct !== null) {
      const detail = `量比约 ${volumeRatio.toFixed(2)}x`;
      if (latest.pct >= 0) add('放量上涨', detail, 5);
      else add('放量下跌', detail, -5);
    }
    signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    const topSignals = signals.slice(0, 6);
    const finalScore = Math.min(100, Math.max(-100, roundHA(score, 0)));
    const verdict =
      finalScore >= 35
        ? '强势'
        : finalScore >= 15
          ? '偏多'
          : finalScore > -15
            ? '中性'
            : finalScore > -35
              ? '偏弱'
              : '弱势';
    return {
      latestDate: latest.date,
      score: finalScore,
      verdict,
      signals: topSignals,
      indicators: {
        close: rounded(close, 2),
        ma20: rounded(ma20, 2),
        ma50: rounded(ma50, 2),
        ma200: rounded(ma200, 2),
        rsi14: rounded(rsi, 1),
        macdDif: rounded(dif, 3),
        macdDea: rounded(dea, 3),
        position52w: rounded(position, 1),
        momentum21: rounded(momentum, 2),
        volumeRatio: rounded(volumeRatio, 2),
      },
    };
  }

  function estimateChips(bars) {
    const newestFirst = [...bars].reverse();
    const valid = newestFirst.filter((bar) => bar.volume > 0).slice(0, 180);
    if (valid.length < 20) return null;
    let low = Infinity;
    let high = -Infinity;
    for (const bar of valid) {
      low = Math.min(low, bar.low);
      high = Math.max(high, bar.high);
    }
    if (!(high > low)) return null;
    const bins = 48;
    const step = (high - low) / bins;
    const weights = new Array(bins).fill(0);
    valid
      .slice()
      .reverse()
      .forEach((bar, age) => {
        const weight = bar.volume * Math.pow(0.5, age / 60);
        const start = Math.min(
          bins - 1,
          Math.max(0, Math.floor((bar.low - low) / step)),
        );
        const end = Math.min(
          bins - 1,
          Math.max(0, Math.floor((bar.high - low) / step)),
        );
        const count = end - start + 1;
        const each = weight / count;
        for (let i = start; i <= end; i += 1) weights[i] += each;
      });
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return null;
    const close = bars[bars.length - 1].close;
    const levels = weights.map((weight, i) => ({
      price: low + step * (i + 0.5),
      weight,
    }));
    const avgCost = levels.reduce((total2, level) => total2 + level.price * level.weight, 0) / total;
    const profitWeight = levels
      .filter((level) => level.price <= close)
      .reduce((total2, level) => total2 + level.weight, 0);
    const maxWeight = Math.max(...weights);
    const maxLast = (candidates) => {
      let best = null;
      for (const level of candidates) {
        if (best === null || level.weight >= best.weight) best = level;
      }
      return best;
    };
    const support = maxLast(levels.filter((level) => level.price < close));
    const resistance = maxLast(levels.filter((level) => level.price > close));
    return {
      windowDays: valid.length,
      avgCost: rounded(avgCost, 2),
      profitRatio: rounded((profitWeight / total) * 100, 1),
      support: support ? rounded(support.price, 2) : null,
      resistance: resistance ? rounded(resistance.price, 2) : null,
      concentration90: null,
      levels: levels.map((level) => ({
        price: rounded(level.price, 2),
        weightPct: rounded((level.weight / total) * 100, 2),
        height: rounded(maxWeight > 0 ? (level.weight / maxWeight) * 100 : 0, 1),
        inProfit: level.price <= close,
      })),
      note: '按近 180 个交易日成交量在日内价格区间均匀分布估算',
    };
  }

  async function stockKlineEnv(query) {
    const code = q(query, 'code');
    const days = intQ(query, 'days', 260, 60, 520);
    if (!symbol.validCode(code)) return fail('缺少股票代码', '');
    if (symbol.isLegacyBeijing(code)) {
      return fail(
        '北交所旧代码已迁移',
        '无效的北交所旧代码：43/83/87 号段不再用于实时分析，请使用 920xxx 新代码',
      );
    }
    const attempts = [];
    let reason = '';
    let chosen = null;
    try {
      const tencent = await loadKlineTencent(code, days);
      if (tencent.bars.length >= 60) {
        attempts.push({ source: 'tencent', status: 200 });
        chosen = { ...tencent, source: 'tencent', sourceLabel: '腾讯复权日K' };
      } else {
        attempts.push({ source: 'tencent', status: 'empty', count: tencent.bars.length });
        reason = `腾讯: 数据不足(${tencent.bars.length}条)`;
      }
    } catch (error) {
      attempts.push({ source: 'tencent', status: error.status != null ? error.status : null, reason: error.message });
      reason = `腾讯: ${error.message}`;
    }
    if (chosen === null) {
      try {
        const em = await loadKlineEastmoney(code, days);
        if (em.bars.length > 0) {
          attempts.push({ source: 'eastmoney', status: 200 });
          chosen = { ...em, source: 'eastmoney', sourceLabel: '东方财富日K' };
        } else {
          attempts.push({ source: 'eastmoney', status: 'empty' });
        }
      } catch (error) {
        attempts.push({ source: 'eastmoney', status: error.status != null ? error.status : null, reason: error.message });
        reason = `东方财富: ${error.message}`;
      }
    }
    if (chosen === null) return fail('暂无日 K 数据', reason);
    const analysis = analyzeBars(chosen.bars);
    const chips = estimateChips(chosen.bars);
    const recent = chosen.bars.slice(-60).map((bar) => ({
      date: bar.date,
      close: round(bar.close, 2),
      pct: bar.pct !== null && bar.pct !== undefined ? round(bar.pct, 2) : null,
      volume: bar.volume,
    }));
    return okExtra(
      {
        code,
        name: chosen.name,
        days,
        source: chosen.source,
        sourceLabel: chosen.sourceLabel,
        fallbackReason: reason,
        latestDate: analysis ? analysis.latestDate : null,
        count: chosen.bars.length,
        analysis,
        chips,
        bars: recent,
      },
      {
        meta: {
          asOf: nowIso(),
          degraded: reason !== '',
          stale: false,
          sources: {
            kline: {
              actual: chosen.source,
              actualLabel: chosen.sourceLabel,
              fallbackReason: reason,
              attempts,
            },
          },
        },
      },
    );
  }

  /* ------------------------------------------------------------- /stock-minute */

  function normMinuteTime(value) {
    if (typeof value !== 'string') return '';
    if (value.includes(':')) {
      const idx = value.indexOf(':');
      if (idx < 2) return '';
      return value.slice(idx - 2, idx + 3);
    }
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4) return '';
    const tail = digits.slice(-4);
    return `${tail.slice(0, 2)}:${tail.slice(2, 4)}`;
  }

  async function loadMinuteTencent(code) {
    const s = symbol.tencentSymbol(code);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${s}`;
    const v = await gwJson({ url, headers: { referer: 'https://gu.qq.com/' } });
    const inner = v && v.data ? v.data[s] : undefined;
    const block = inner && inner.data ? inner.data : undefined;
    const qt = inner && inner.qt ? inner.qt[s] : undefined;
    // preClose 保留原值（不过滤 >0）；changePercent 才要求昨收 > 0（与 minute.rs 一致）。
    const preClose = Array.isArray(qt) ? numStrip(qt[4]) : null;
    const rows = block && Array.isArray(block.data) ? block.data : [];
    const points = [];
    for (const line of rows) {
      if (typeof line !== 'string') continue;
      const parts = line.split(/\s+/).filter((p) => p !== '');
      if (parts.length < 3) continue;
      const price = strictNum(parts[1]);
      if (price === null) continue;
      points.push({
        time: normMinuteTime(parts[0]),
        price,
        avgPrice: price,
        volume: strictNum(parts[2]),
        amount: parts.length > 3 ? strictNum(parts[3]) : null,
        changePercent:
          preClose !== null && preClose > 0 ? ((price - preClose) / preClose) * 100 : null,
      });
    }
    const name =
      Array.isArray(qt) && typeof qt[1] === 'string' ? qt[1] : '';
    const rawDate = block && typeof block.date === 'string' ? block.date : '';
    const tradeDate = /^\d{8}$/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      : rawDate;
    return {
      source: 'tencent',
      sourceLabel: '腾讯分时',
      command: '',
      name,
      tradeDate,
      preClose,
      points,
    };
  }

  async function loadMinuteEastmoney(code) {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${symbol.eastmoneySecid(code)}&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6%2Cf7%2Cf8%2Cf9%2Cf10%2Cf11&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58&iscr=0&iscca=0&ndays=1`;
    const v = await gwJson({
      url,
      em: true,
      headers: { referer: 'https://quote.eastmoney.com/' },
    });
    const data = v && v.data ? v.data : {};
    const preClose = numStrip(field(data, 'preClose'));
    const rows = Array.isArray(data.trends) ? data.trends : [];
    const points = [];
    for (const line of rows) {
      if (typeof line !== 'string') continue;
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const price = strictNum(parts[2]);
      if (price === null) continue;
      const avg = strictNum(parts[7]);
      points.push({
        date: parts[0].slice(0, 10),
        time: normMinuteTime(parts[0]),
        open: strictNum(parts[1]),
        price,
        high: strictNum(parts[3]),
        low: strictNum(parts[4]),
        volume: strictNum(parts[5]),
        amount: strictNum(parts[6]),
        avgPrice: avg !== null ? avg : price,
        changePercent:
          preClose !== null && preClose > 0 ? ((price - preClose) / preClose) * 100 : null,
      });
    }
    points.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const last = points.length > 0 ? points[points.length - 1] : null;
    return {
      source: 'eastmoney',
      sourceLabel: '东方财富',
      command: '',
      name: typeof data.name === 'string' ? data.name : '',
      tradeDate: last && last.date ? last.date : '',
      latestTime: last ? last.time : '',
      preClose,
      points,
    };
  }

  async function stockMinuteEnv(query) {
    const code = q(query, 'code');
    const count = intQ(query, 'count', 240, 1, 240);
    const sourceParam = q(query, 'source') === '' ? 'auto' : q(query, 'source');
    if (!['auto', 'tdxrs', 'tencent', 'eastmoney'].includes(sourceParam)) {
      return fail('未知分时数据源', 'minute source invalid');
    }
    if (!symbol.validCode(code)) return fail('缺少股票代码', '');
    if (symbol.isLegacyBeijing(code)) {
      return fail(
        '北交所旧代码已迁移',
        '无效的北交所旧代码：43/83/87 号段不再用于实时分析，请使用 920xxx 新代码',
      );
    }
    const attempts = [];
    let fallback = '';
    let chosen = null;
    const finish = (loaded) => {
      const trimmed =
        loaded.points.length > count
          ? { ...loaded, points: loaded.points.slice(loaded.points.length - count) }
          : loaded;
      return trimmed;
    };
    if (sourceParam === 'tdxrs') {
      const error = new Error('tdxrs 未配置');
      error.status = null;
      return failApi('分时数据接口不可用', error);
    }
    if (sourceParam === 'tencent' || sourceParam === 'eastmoney') {
      const loader = sourceParam === 'tencent' ? loadMinuteTencent : loadMinuteEastmoney;
      try {
        const loaded = await loader(code);
        if (loaded.points.length === 0) {
          const error = new Error(
            sourceParam === 'tencent' ? '腾讯分时数据为空' : '东方财富分时数据为空',
          );
          error.status = null;
          throw error;
        }
        chosen = finish(loaded);
      } catch (error) {
        return failApi('分时数据接口不可用', error);
      }
    } else {
      try {
        const loaded = await loadMinuteTencent(code);
        if (loaded.points.length === 0) {
          const error = new Error('腾讯分时数据为空');
          error.status = null;
          throw error;
        }
        attempts.push({ source: 'tencent', status: 200 });
        chosen = finish(loaded);
      } catch (error) {
        attempts.push({
          source: 'tencent',
          status: error.status != null ? error.status : null,
          reason: error.message,
        });
        fallback = `腾讯: ${error.message}`;
      }
      if (chosen === null) {
        try {
          const loaded = await loadMinuteEastmoney(code);
          if (loaded.points.length === 0) {
            const error = new Error('东方财富分时数据为空');
            error.status = null;
            throw error;
          }
          attempts.push({ source: 'eastmoney', status: 200 });
          chosen = finish(loaded);
        } catch (error) {
          attempts.push({
            source: 'eastmoney',
            status: error.status != null ? error.status : null,
            reason: error.message,
          });
          fallback = fallback !== '' ? `${fallback}; 东财: ${error.message}` : `东财: ${error.message}`;
        }
      }
      if (chosen === null) return fail('分时数据接口不可用', fallback);
    }
    const points = chosen.points;
    const lastPoint = points.length > 0 ? points[points.length - 1] : null;
    const data = {
      ...chosen,
      points,
      code,
      market: symbol.eastmoneyMarket(code),
      count: points.length,
      latestTime:
        chosen.latestTime !== undefined && chosen.latestTime !== ''
          ? chosen.latestTime
          : lastPoint
            ? lastPoint.time
            : '',
      fallbackReason: fallback,
    };
    return okExtra(data, {
      time: shanghaiClock(),
      meta: {
        degraded: fallback !== '',
        stale: false,
        sources: {
          minute: {
            actual: chosen.source,
            actualLabel: chosen.sourceLabel,
            fallbackReason: fallback,
            attempts,
          },
        },
      },
    });
  }

  /* ----------------------------------------------------------- /market-warnings */

  const ANOMALY_RULES = {
    1: '主板10日内4次同向异常波动',
    2: '创业板10日内3次同向异常波动',
    3: '科创板10日内3次同向异常波动',
    4: '10日累计正偏离达到100%',
    5: '10日累计负偏离达到50%',
    6: '30日累计正偏离达到200%',
    7: '30日累计负偏离达到70%',
    8: '北交所10日内3次同向异常波动',
    40: '科创板10日累计正偏离达到150%',
    50: '科创板10日累计负偏离达到60%',
    60: '科创板30日累计正偏离达到300%',
    70: '科创板30日累计负偏离达到75%',
  };

  async function loadStockMonitor() {
    const v = await gwJson({
      url: 'https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json',
      em: true,
      independentCircuit: true,
      headers: { referer: 'https://vipmoney.eastmoney.com/' },
      cacheTtl: 1800,
    });
    if (!Array.isArray(v)) {
      const error = new Error('重点监控响应不是数组');
      error.status = null;
      throw error;
    }
    const todayStr = todayIso();
    const out = new Map();
    for (const row of v) {
      const code = row && typeof row.STKCODE === 'string' ? row.STKCODE : null;
      if (code === null || !symbol.validCode(code)) continue;
      const start = typeof row.VALIDATESTARTDATE === 'string' ? row.VALIDATESTARTDATE : '';
      const end = typeof row.VALIDATEENDDATE === 'string' ? row.VALIDATEENDDATE : '';
      if (!(start <= todayStr && todayStr <= end)) continue;
      const marketRaw = typeof row.MARKET === 'string' ? row.MARKET.toUpperCase() : '';
      const market =
        marketRaw === '1' ? 'SH' : marketRaw === '0' ? 'SZ' : marketRaw === 'B' ? 'BJ' : `?${marketRaw}`;
      out.set(code, {
        code,
        name: typeof row.STKNAME === 'string' ? row.STKNAME : '',
        market,
        start,
        end,
        link: typeof row.LINK_URL === 'string' ? row.LINK_URL : '',
      });
    }
    return out;
  }

  async function loadPriceAnomaly() {
    const v = await gwJson({
      url: 'https://dycalchis.eastmoney.com/price-anomaly/list?team=h5&product=EastMoney&client=WAP&version=9001&name=WAP&user=123&pageSize=200&pageNo=1',
      em: true,
      independentCircuit: true,
      headers: { referer: 'https://vipmoney.eastmoney.com/' },
      cacheTtl: 300,
    });
    const result = v && typeof v === 'object' ? v.result : undefined;
    if (result !== 0) {
      const error = new Error(
        `东财异动接口拒绝: result=${result === undefined ? 'null' : String(result)} msg=${v && typeof v.msg === 'string' ? v.msg : ''}`,
      );
      error.status = null;
      throw error;
    }
    const rows = v && Array.isArray(v.data) ? v.data : [];
    const items = [];
    for (const row of rows) {
      const rawCode = row ? row.c : undefined;
      const codeText =
        typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' ? String(rawCode) : '';
      if (!symbol.validCode(codeText)) continue;
      const boardFloat = numJson(field(row, 's'));
      const board = boardFloat !== null ? Math.trunc(boardFloat) : 0;
      const baseFloat = numJson(field(row, 'e'));
      const baseRule = baseFloat !== null ? Math.trunc(baseFloat) : 0;
      const predFloat = numJson(field(row, 'o'));
      const predictionType = predFloat !== null ? Math.trunc(predFloat) : 0;
      const ruleCode = board === 6 && baseRule >= 4 && baseRule <= 7 ? baseRule * 10 : baseRule;
      const ex = symbol.exchange(codeText);
      const market = ex === 'Beijing' || board === 8 ? 'BJ' : numJson(field(row, 'm')) === 1 ? 'SH' : 'SZ';
      items.push({
        code: codeText,
        name: field(row, 'n'),
        market,
        changePct: numJson(field(row, 'a')),
        triggerChangePct: numJson(field(row, 't')),
        deviation: numJson(field(row, 'x')),
        days: numJson(field(row, 'd')),
        board,
        ruleCode,
        rule: ANOMALY_RULES[ruleCode] || `未知异动规则 ${ruleCode}`,
        predictionType,
        isToday: predictionType !== 2,
        isTriggered: predictionType === 1,
      });
    }
    return {
      date: v && v.date !== undefined ? v.date : '',
      pages: v && v.pages !== undefined ? v.pages : 0,
      items,
    };
  }

  async function marketWarningsEnv(query) {
    const seen = new Set();
    const codes = [];
    for (const part of q(query, 'codes').split(',')) {
      const code = part.trim();
      if (symbol.validCode(code) && !seen.has(code)) {
        seen.add(code);
        codes.push(code);
      }
    }
    const limited = codes.slice(0, 100);
    if (limited.length === 0) return fail('缺少股票代码', '');
    const [monitorResult, anomalyResult] = await Promise.allSettled([
      loadStockMonitor(),
      loadPriceAnomaly(),
    ]);
    if (monitorResult.status === 'rejected' && anomalyResult.status === 'rejected') {
      return fail(
        '市场异动数据不可用',
        `重点监控: ${monitorResult.reason.message}; 严重异动: ${anomalyResult.reason.message}`,
      );
    }
    const monitor = monitorResult.status === 'fulfilled' ? monitorResult.value : null;
    const anomaly = anomalyResult.status === 'fulfilled' ? anomalyResult.value : null;
    const data = {};
    for (const code of limited) {
      const monitored = monitor !== null ? (monitor.get(code) ?? null) : null;
      const triggered =
        anomaly !== null
          ? anomaly.items.find((item) => item.code === code && item.isTriggered) || null
          : null;
      let warning = null;
      if (anomaly !== null && triggered === null) {
        const candidates = anomaly.items.filter(
          (item) => item.code === code && (item.predictionType === 0 || item.predictionType === 2),
        );
        warning =
          candidates.find((item) => item.predictionType === 0) || candidates[0] || null;
      }
      data[code] = {
        code,
        monitored: monitored !== null,
        monitorEnd: monitored !== null ? monitored.end : '',
        anomaly: anomaly !== null ? (triggered !== null ? triggered : null) : null,
        anomalyRule: triggered !== null ? triggered.rule : '',
        anomalyWarning: warning,
        anomalyWarningRule: warning !== null ? warning.rule : '',
        anomalyWarningPredictionType: warning !== null ? warning.predictionType : null,
        anomalyWarningTriggerPct: warning !== null ? warning.triggerChangePct : null,
      };
    }
    return okExtra(data, {
      meta: {
        degraded: monitor === null || anomaly === null,
        stale: false,
        sources: {
          stockMonitor: {
            status: monitor !== null ? 'live' : 'failed',
            actual: 'eastmoney',
            actualLabel: '东方财富重点监控',
          },
          priceAnomaly: {
            status: anomaly !== null ? 'live' : 'failed',
            actual: 'eastmoney',
            actualLabel: '东方财富严重异动',
          },
        },
      },
    });
  }

  /* ----------------------------------------------------------- /sector-rotation */

  function validDateString(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  async function sectorRotationEnv() {
    let v;
    try {
      v = await gwJson({
        url: 'https://sq.deepq.tech/ticai/api/concept-rotation/sector-rotation',
        cacheTtl: 300,
        independentCircuit: true,
      });
    } catch (error) {
      return fail('轮动板块数据不可用', error.message, error.status);
    }
    const rows = v && Array.isArray(v.data) ? v.data : [];
    const todayStr = todayIso();
    let best = null;
    for (const item of rows) {
      const rawDate = item && typeof item.date === 'string' ? item.date.trim() : '';
      const date = rawDate.replace(/\//g, '-');
      if (!validDateString(date)) continue;
      if (date >= todayStr) continue;
      if (best === null || date >= best.date) best = { date, item };
    }
    if (best === null) {
      return fail('上一交易日轮动板块尚未发布', '没有早于今日的有效数据');
    }
    return okExtra(
      {
        status: 'ready',
        snapshotDate: best.date,
        sectors:
          best.item && Array.isArray(best.item.sectors) ? best.item.sectors : [],
        source: 'deepq-ticai',
        sourceLabel: 'DeepQ 题材记忆库',
        sourceUpdatedAt: v && v.updateTime !== undefined ? v.updateTime : null,
      },
      {
        meta: {
          degraded: false,
          stale: false,
          sources: { rotation: { actual: 'deepq-ticai', actualLabel: 'DeepQ 题材记忆库' } },
        },
      },
    );
  }

  /* --------------------------------------------------------- /intraday-screening */

  const REPORT_SOURCE = {
    source: 'portfolio',
    sourceLabel: '公开报告',
  };

  function findTagEnd(html, start) {
    let quote = null;
    for (let i = start; i < html.length; i += 1) {
      const ch = html[i];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        return i;
      }
    }
    return -1;
  }

  function isTagBoundary(html, index) {
    if (index >= html.length) return true;
    const ch = html[index];
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '>' || ch === '/';
  }

  function matchingTagEnd(html, name, contentStart) {
    const lower = html.toLowerCase();
    const openNeedle = `<${name}`;
    const closeNeedle = `</${name}`;
    let depth = 1;
    let cursor = contentStart;
    while (cursor < html.length) {
      const nextOpen = lower.indexOf(openNeedle, cursor);
      const nextClose = lower.indexOf(closeNeedle, cursor);
      if (nextClose < 0) return -1;
      if (nextOpen >= 0 && nextOpen < nextClose && isTagBoundary(html, nextOpen + openNeedle.length)) {
        depth += 1;
        cursor = nextOpen + openNeedle.length;
        continue;
      }
      if (isTagBoundary(html, nextClose + closeNeedle.length)) {
        depth -= 1;
        if (depth === 0) {
          const end = findTagEnd(html, nextClose);
          return end < 0 ? -1 : end + 1;
        }
      }
      cursor = nextClose + closeNeedle.length;
    }
    return -1;
  }

  function extractOpeningDivStart(html, position, requiredClasses) {
    const lower = html.toLowerCase();
    let cursor = position;
    while (cursor > 0) {
      const start = lower.lastIndexOf('<div', cursor - 1);
      if (start < 0) return -1;
      const end = findTagEnd(html, start);
      if (end < 0) return -1;
      const tag = html.slice(start, end + 1);
      const classMatch = /class\s*=\s*"([^"]*)"|class\s*=\s*'([^']*)'/.exec(tag);
      if (classMatch) {
        const value = classMatch[1] !== undefined ? classMatch[1] : classMatch[2];
        const classes = value.split(/\s+/).filter(Boolean);
        if (requiredClasses.every((name) => classes.includes(name))) return start;
      }
      cursor = start;
    }
    return -1;
  }

  function openingTagContentEnd(html, position) {
    const end = findTagEnd(html, position);
    return end < 0 ? -1 : end + 1;
  }

  function intradayExtract(html) {
    const lower = html.toLowerCase();
    const marker = /id\s*=\s*"intraday-title"|id\s*=\s*'intraday-title'/.exec(lower);
    if (!marker) throw new Error('未找到盘中筛选标题');
    const titlePos = marker.index;
    const sectionStart = lower.lastIndexOf('<section', titlePos);
    if (sectionStart < 0) throw new Error('未找到盘中筛选区块');
    const sectionContentStart = openingTagContentEnd(html, sectionStart);
    if (sectionContentStart < 0) throw new Error('盘中筛选区块标签未闭合');
    const sectionEnd = matchingTagEnd(html, 'section', sectionContentStart);
    if (sectionEnd < 0) throw new Error('盘中筛选区块未闭合');
    const section = html.slice(sectionStart, sectionEnd);
    const sectionLower = section.toLowerCase();
    const timeOffset = sectionLower.indexOf('report-rec__time');
    if (timeOffset < 0) throw new Error('盘中筛选区块缺少快照时间');
    const timePattern = /筛选快照\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/;
    const timeMatch = timePattern.exec(section);
    if (!timeMatch) throw new Error('盘中筛选快照时间无效');
    const date = timeMatch[1];
    const time = timeMatch[2];
    if (!validDateString(date)) throw new Error('盘中筛选快照时间无效');
    const [hh, mm] = time.split(':').map((x) => Number(x));
    if (!(hh <= 23 && mm <= 59)) throw new Error('盘中筛选快照时间无效');
    const at = `${date} ${time}`;
    const timePos = sectionStart + timeOffset;
    const moduleStart = extractOpeningDivStart(html, timePos, ['report-card', 'report-rec']);
    if (moduleStart < 0 || moduleStart < sectionStart || moduleStart >= sectionEnd) {
      throw new Error('盘中筛选模块定位失败');
    }
    const moduleContentStart = openingTagContentEnd(html, moduleStart);
    if (moduleContentStart < 0) throw new Error('盘中筛选模块标签未闭合');
    const moduleEnd = matchingTagEnd(html, 'div', moduleContentStart);
    if (moduleEnd < 0 || moduleEnd > sectionEnd) throw new Error('盘中筛选模块未闭合');
    const moduleHtml = html.slice(moduleStart, moduleEnd);
    if (!moduleHtml.toLowerCase().includes('report-rec__board')) {
      throw new Error('盘中筛选模块缺少板块榜');
    }
    const lowered = moduleHtml.toLowerCase();
    const forbidden = [
      '<script', '<iframe', '<object', '<embed', '<form', '<base', '<style', '<link',
      '<meta', '<img', '<video', '<audio', '<svg', '<math', '<a ', '<a>',
      'javascript:', 'srcdoc=',
    ];
    if (forbidden.some((needle) => lowered.includes(needle)) || /\son[a-z0-9_-]+\s*=/i.test(moduleHtml)) {
      throw new Error('盘中筛选模块包含不安全内容');
    }
    return { date, time, at, moduleHtml };
  }

  async function intradayScreeningEnv() {
    let html;
    try {
      html = await gwText({ url: 'https://portfolio.lrwei91.cn/', timeout: 15, cacheTtl: 5 });
    } catch (error) {
      const reason =
        error.status !== null && error.status !== undefined
          ? `HTTP ${error.status}: ${error.message}`
          : error.message;
      const out = fail('盘中筛选快照不可用', `公开报告: ${reason}`);
      out.meta = {
        asOf: nowIso(),
        degraded: true,
        stale: false,
        sources: {
          intradayScreening: {
            actual: 'none',
            actualLabel: '不可用',
            requested: REPORT_SOURCE.source,
            requestedLabel: REPORT_SOURCE.sourceLabel,
            status: 'error',
            degraded: true,
            attempts: [
              {
                source: REPORT_SOURCE.source,
                sourceLabel: REPORT_SOURCE.sourceLabel,
                status: 'network_error',
                reason,
              },
            ],
          },
        },
      };
      return out;
    }
    let snapshot;
    try {
      snapshot = intradayExtract(html);
    } catch (error) {
      const out = fail('盘中筛选快照不可用', `公开报告: ${error.message}`);
      out.meta = {
        asOf: nowIso(),
        degraded: true,
        stale: false,
        sources: {
          intradayScreening: {
            actual: 'none',
            actualLabel: '不可用',
            requested: REPORT_SOURCE.source,
            requestedLabel: REPORT_SOURCE.sourceLabel,
            status: 'error',
            degraded: true,
            attempts: [
              {
                source: REPORT_SOURCE.source,
                sourceLabel: REPORT_SOURCE.sourceLabel,
                status: 'structure_error',
                reason: error.message,
              },
            ],
          },
        },
      };
      return out;
    }
    const todayStr = todayIso();
    const ready = snapshot.date === todayStr;
    const attempts = [
      {
        source: REPORT_SOURCE.source,
        sourceLabel: REPORT_SOURCE.sourceLabel,
        status: ready ? 'ready' : 'not_ready',
        snapshotAt: snapshot.at,
      },
    ];
    if (ready) {
      return okExtra(
        {
          status: 'ready',
          snapshotDate: snapshot.date,
          snapshotTime: snapshot.time,
          snapshotAt: snapshot.at,
          source: REPORT_SOURCE.source,
          sourceLabel: REPORT_SOURCE.sourceLabel,
          moduleHtml: snapshot.moduleHtml,
        },
        {
          meta: {
            asOf: nowIso(),
            degraded: false,
            stale: false,
            sources: {
              intradayScreening: {
                actual: REPORT_SOURCE.source,
                actualLabel: REPORT_SOURCE.sourceLabel,
                requested: REPORT_SOURCE.source,
                requestedLabel: REPORT_SOURCE.sourceLabel,
                status: 'ready',
                degraded: false,
                attempts,
              },
            },
          },
        },
      );
    }
    return okExtra(
      {
        status: 'not_ready',
        snapshotDate: snapshot.date,
        snapshotTime: snapshot.time,
        latestPublishedAt: snapshot.at,
        source: REPORT_SOURCE.source,
        sourceLabel: REPORT_SOURCE.sourceLabel,
        moduleHtml: '',
      },
      {
        meta: {
          asOf: nowIso(),
          degraded: true,
          stale: false,
          sources: {
            intradayScreening: {
              actual: REPORT_SOURCE.source,
              actualLabel: REPORT_SOURCE.sourceLabel,
              requested: REPORT_SOURCE.source,
              requestedLabel: REPORT_SOURCE.sourceLabel,
              status: 'not_ready',
              degraded: true,
              fallbackReason: '尚未发布上海当天盘中筛选快照',
              attempts,
            },
          },
        },
      },
    );
  }

  /* -------------------------------------------------------- /stock-fundamentals */

  function researchNum(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      if (value.trim() === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function validIsoDate(s) {
    return validDateString(s);
  }

  async function stockFundamentalsEnv(query) {
    const code = q(query, 'code');
    if (!symbol.companyStock(code)) {
      return fail('该标的未启用公司财报研究', '场内 ETF 等标的仅提供行情、技术与本地持仓统计');
    }
    if (!symbol.validCode(code) || symbol.isLegacyBeijing(code)) {
      return fail('股票代码无效', '请使用当前六位股票代码');
    }
    const filter = `(SECURITY_CODE="${code}")`;
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=SECURITY_CODE,REPORT_DATE,NOTICE_DATE,TOTALOPERATEREVE,PARENTNETPROFIT,TOTALOPERATEREVETZ,PARENTNETPROFITTZ,ROEJQ,XSMLL,ZCFZL,MGJYXJJE,EPSJB&filter=${urlEncode(filter)}&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=6&pageNumber=1`;
    let v;
    try {
      v = await gwJson({ url, em: true, cacheTtl: 3600 });
    } catch (error) {
      return fail('财务指标不可用', '财务数据源请求失败', error.status);
    }
    const rows = v && v.result && Array.isArray(v.result.data) ? v.result.data : [];
    const todayStr = todayIso();
    const periods = [];
    for (const row of rows) {
      const noticeRaw = row && typeof row.NOTICE_DATE === 'string' ? row.NOTICE_DATE : '';
      const disclosedAt = noticeRaw.slice(0, 10);
      if (!validIsoDate(disclosedAt) || disclosedAt > todayStr) continue;
      const reportRaw = row && typeof row.REPORT_DATE === 'string' ? row.REPORT_DATE : '';
      periods.push({
        reportDate: reportRaw.slice(0, 10),
        disclosedAt,
        revenue: researchNum(row.TOTALOPERATEREVE),
        netProfit: researchNum(row.PARENTNETPROFIT),
        revenueGrowth: researchNum(row.TOTALOPERATEREVETZ),
        profitGrowth: researchNum(row.PARENTNETPROFITTZ),
        roe: researchNum(row.ROEJQ),
        grossMargin: researchNum(row.XSMLL),
        debtRatio: researchNum(row.ZCFZL),
        cashPerShare: researchNum(row.MGJYXJJE),
        eps: researchNum(row.EPSJB),
      });
    }
    periods.sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : 0));
    if (periods.length === 0) {
      return fail('财务指标不可用', '没有已披露的有效财务记录');
    }
    return {
      success: true,
      data: {
        available: true,
        source: 'eastmoney',
        sourceLabel: '东方财富财务指标',
        periods,
      },
      meta: { stale: false, degraded: false },
    };
  }

  /* ------------------------------------------------------------- /stock-research */

  function validQuoteTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
    const y = Number(value.slice(0, 4));
    const mo = Number(value.slice(4, 6));
    const d = Number(value.slice(6, 8));
    const hh = Number(value.slice(8, 10));
    const mi = Number(value.slice(10, 12));
    const ss = Number(value.slice(12, 14));
    if (!validDateString(`${y}-${pad2(mo)}-${pad2(d)}`)) return false;
    return hh <= 23 && mi <= 59 && ss <= 59;
  }

  function clampNum(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  async function stockResearchEnv(query) {
    const code = q(query, 'code');
    if (!symbol.companyStock(code)) {
      return fail('该标的未启用公司财报研究', '场内 ETF 等标的仅提供行情、技术与本地持仓统计');
    }
    if (!symbol.validCode(code) || symbol.isLegacyBeijing(code)) {
      return fail('股票代码无效', '请使用当前六位股票代码');
    }
    const [quote, technical, fund, news, risk, financial] = await Promise.all([
      stockEnv({ codes: code }),
      stockKlineEnv({ code }),
      fundFlowEnv({ codes: code }),
      stockNewsEnv({ code }),
      stockRiskEnv({ code }),
      stockFundamentalsEnv({ code }),
    ]);
    const sources = { quote, technical, fund, news, risk, financial };
    const quoteData =
      quote.success === true && quote.data && typeof quote.data === 'object'
        ? quote.data[code] || null
        : null;
    const technicalData =
      technical.success === true ? technical.data.analysis || null : null;
    const financialData = financial.success === true ? financial.data : null;
    let latestFlow = null;
    if (fund.success === true && fund.data && Array.isArray(fund.data.items)) {
      const item = fund.data.items.find((entry) => entry && entry.code === code);
      if (item && Array.isArray(item.recent) && item.recent.length > 0) {
        latestFlow = item.recent[item.recent.length - 1];
      }
    }
    const available = {
      quote:
        quote.success === true &&
        !(quote.meta && quote.meta.stale === true) &&
        quoteData !== null &&
        typeof quoteData.priceValue === 'number' &&
        quoteData.priceValue > 0 &&
        validQuoteTimestamp(quoteData.quoteTimeRaw),
      technical:
        technical.success === true &&
        !(technical.meta && technical.meta.stale === true) &&
        technicalData !== null &&
        technicalData.score !== null &&
        technicalData.score !== undefined &&
        technical.success === true &&
        Array.isArray(technical.data.bars) &&
        technical.data.bars.length > 0,
      fund:
        fund.success === true &&
        !(fund.meta && fund.meta.stale === true) &&
        latestFlow !== null &&
        latestFlow.mainNet !== null &&
        latestFlow.mainNet !== undefined,
      news:
        news.success === true &&
        !(news.meta && news.meta.stale === true) &&
        news.data &&
        Array.isArray(news.data.items) &&
        news.data.items.length > 0,
      risk:
        risk.success === true &&
        !(risk.meta && risk.meta.stale === true) &&
        risk.data &&
        ((risk.data.announcements && risk.data.announcements.available === true) ||
          (risk.data.lockup && risk.data.lockup.available === true)),
      financial:
        financial.success === true &&
        !(financial.meta && financial.meta.stale === true) &&
        financialData !== null &&
        financialData.available === true &&
        Array.isArray(financialData.periods) &&
        financialData.periods.length > 0,
    };
    const factors = [];
    if (available.technical && technicalData) {
      factors.push({
        label: '技术趋势',
        score: clampNum(50 + technicalData.score / 2, 0, 100),
        evidence: 'technical',
      });
    }
    if (available.fund && latestFlow) {
      factors.push({
        label: '资金方向',
        score: latestFlow.mainNet > 0 ? 65 : latestFlow.mainNet < 0 ? 35 : 50,
        evidence: 'fund',
      });
    }
    if (available.news && news.data && news.data.score) {
      factors.push({
        label: '新闻关键词',
        score: clampNum(50 + news.data.score.score * 5, 0, 100),
        evidence: 'news',
      });
    }
    if (available.financial && financialData) {
      const growth =
        financialData.periods[0] && financialData.periods[0].profitGrowth !== null
          ? financialData.periods[0].profitGrowth
          : 0;
      factors.push({
        label: '盈利变化',
        score: clampNum(50 + clampNum(growth, -50, 50), 0, 100),
        evidence: 'financial',
      });
    }
    const missing = ['quote', 'technical', 'fund', 'news', 'risk', 'financial'].filter(
      (key) => !available[key],
    );
    const name = quoteData !== null && quoteData.name ? quoteData.name : code;
    const upper = String(name).toUpperCase();
    const specialRisk = upper.includes('ST') || String(name).includes('退');
    let score = null;
    if (factors.length >= 3 && available.quote) {
      const mean = factors.reduce((total, f) => total + f.score, 0) / factors.length;
      score = clampNum(roundHA(mean - (specialRisk ? 30 : 0), 0), 0, 100);
    }
    const coverage = Math.floor(((6 - missing.length) * 100) / 6);
    const data = {
      code,
      name,
      generatedAt: nowIso(),
      quote: available.quote ? quoteData : null,
      technical: available.technical ? technicalData : null,
      financial: available.financial ? financialData : null,
      fund: available.fund ? latestFlow : null,
      news: available.news ? news.data : null,
      risk: available.risk ? risk.data : null,
      quant: {
        score,
        factors,
        coverage,
        missingSources: missing,
        specialRisk,
        method: '研究规则 v1 · 技术、资金、新闻关键词、盈利变化等权；非上涨概率',
      },
      evidence: sources,
    };
    return {
      success: true,
      data,
      meta: { stale: false, degraded: missing.length > 0 },
    };
  }

  /* ---------------------------------------------------------- /opportunity-radar */

  function clampScore(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function fmtSigned(value, digits) {
    return value.toFixed(digits);
  }

  async function opportunityRadarEnv(query) {
    const limit = intQ(query, 'limit', 8, 1, 20);
    const [ths, em, zt, yzt, zb, dt, dragon, sector, monitorResult, anomalyResult] =
      await Promise.all([
        hotRankEnv({ source: 'ths', limit: '24' }),
        hotRankEnv({ source: 'em', limit: '18' }),
        limitUpEnv({ type: 'zt', limit: '40' }),
        limitUpEnv({ type: 'yzt', limit: '30' }),
        limitUpEnv({ type: 'zb', limit: '24' }),
        limitUpEnv({ type: 'dt', limit: '20' }),
        dragonTigerEnv({}),
        marketDataEnv({ type: 'sector' }),
        loadStockMonitor().then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
        loadPriceAnomaly().then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
      ]);
    const candidates = new Map();
    const candidateFor = (code, name) => {
      let candidate = candidates.get(code);
      if (!candidate) {
        candidate = {
          code,
          name: name || '',
          pct: null,
          price: null,
          tags: [],
          signals: [],
          sourceScore: 0,
          sourceTypes: [],
          industry: '',
          limitType: '',
          dragon: null,
          dragonReason: '',
          limitDown: false,
          monitored: false,
          monitorEnd: '',
          anomalyRule: '',
        };
        candidates.set(code, candidate);
      }
      if ((candidate.name === '' || candidate.name === candidate.code) && name) {
        candidate.name = name;
      }
      return candidate;
    };
    const addTag = (candidate, raw) => {
      if (typeof raw !== 'string') return;
      const tag = raw.trim();
      if (tag !== '' && !candidate.tags.includes(tag)) candidate.tags.push(tag);
    };
    const addSource = (candidate, kind, points, label, detail) => {
      if (!candidate.sourceTypes.includes(kind)) candidate.sourceTypes.push(kind);
      candidate.sourceScore += points;
      candidate.signals.push({ label, points, detail });
    };
    const absorbHot = (envelope, label) => {
      if (!envelope || envelope.success !== true || !envelope.data) return;
      const items = Array.isArray(envelope.data.items) ? envelope.data.items : [];
      for (const item of items.slice(0, 24)) {
        const code = item && typeof item.code === 'string' ? item.code : '';
        if (!symbol.validCode(code)) continue;
        const candidate = candidateFor(code, typeof item.name === 'string' ? item.name : '');
        if (candidate.pct === null && typeof item.pct === 'number') candidate.pct = item.pct;
        if (candidate.price === null && typeof item.price === 'number') candidate.price = item.price;
        const concepts = Array.isArray(item.concepts) ? item.concepts.slice(0, 3) : [];
        for (const concept of concepts) addTag(candidate, concept);
        if (typeof item.tag === 'string') addTag(candidate, item.tag);
        const rank = typeof item.rank === 'number' ? item.rank : 30;
        addSource(candidate, 'hot', clampScore(22 - rank * 0.65, 5, 21), label, `热度排名 ${fmtSigned(rank, 0)}`);
      }
    };
    absorbHot(ths, '同花顺热榜');
    absorbHot(em, '东财人气榜');
    const absorbLimit = (envelope, kind, points, label) => {
      if (!envelope || envelope.success !== true || !envelope.data) return;
      const items = Array.isArray(envelope.data.items) ? envelope.data.items : [];
      for (const item of items.slice(0, 40)) {
        const code = item && typeof item.code === 'string' ? item.code : '';
        if (!symbol.validCode(code)) continue;
        const candidate = candidateFor(code, typeof item.name === 'string' ? item.name : '');
        candidate.limitType = kind;
        if (kind === 'dt') candidate.limitDown = true;
        if (candidate.pct === null && typeof item.pct === 'number') candidate.pct = item.pct;
        if (candidate.price === null && typeof item.price === 'number') candidate.price = item.price;
        if (candidate.industry === '' && typeof item.industry === 'string' && item.industry !== '') {
          candidate.industry = item.industry;
        }
        addTag(candidate, candidate.industry);
        let detail;
        if (kind === 'zt') detail = typeof item.ztStat === 'string' ? item.ztStat : '';
        else if (kind === 'zb') detail = `${item.breakTimes !== undefined && item.breakTimes !== null ? String(item.breakTimes) : ''}次开板`;
        else detail = `${typeof item.pct === 'number' ? item.pct.toFixed(2) : ''}%`;
        addSource(candidate, 'limit', points, label, detail);
      }
    };
    absorbLimit(zt, 'zt', 4, '涨停池');
    absorbLimit(yzt, 'yzt', 8, '昨涨停');
    absorbLimit(zb, 'zb', 5, '炸板池');
    absorbLimit(dt, 'dt', -24, '跌停池');
    if (dragon && dragon.success === true && dragon.data) {
      const stocks = Array.isArray(dragon.data.stocks) ? dragon.data.stocks : [];
      for (const item of stocks.slice(0, 24)) {
        const code = item && typeof item.code === 'string' ? item.code : '';
        if (!symbol.validCode(code)) continue;
        const candidate = candidateFor(code, typeof item.name === 'string' ? item.name : '');
        candidate.dragon = typeof item.netBuyWan === 'number' ? item.netBuyWan : null;
        candidate.dragonReason = typeof item.reason === 'string' ? item.reason : '';
        const net = candidate.dragon;
        const points = net !== null ? clampScore(net / 2500, -10, 13) : 0;
        const detail =
          net === null ? '交易所公开信息' : net >= 0 ? `净买入 ${fmtSigned(net, 0)}万` : `净卖出 ${fmtSigned(Math.abs(net), 0)}万`;
        addSource(candidate, 'dragon', points, '龙虎榜', detail);
      }
    }
    if (sector && sector.success === true && sector.data) {
      const inflow = Array.isArray(sector.data.inflow) ? sector.data.inflow : [];
      const outflow = Array.isArray(sector.data.outflow) ? sector.data.outflow : [];
      for (const candidate of candidates.values()) {
        const text = `${candidate.industry} ${candidate.tags.join(' ')}`;
        const findBoard = (rows) =>
          rows.find(
            (row) =>
              row &&
              typeof row.name === 'string' &&
              row.name !== '' &&
              (text.includes(row.name) || row.leader === candidate.name),
          );
        const inHit = findBoard(inflow);
        const outHit = inHit ? undefined : findBoard(outflow);
        const hit = inHit || outHit;
        if (hit) {
          addTag(candidate, hit.name);
          if (!candidate.sourceTypes.includes('sector')) candidate.sourceTypes.push('sector');
          const points = inHit ? 8 : -6;
          candidate.sourceScore += points;
          candidate.signals.push({
            label: '板块资金',
            points,
            detail: `${hit.name} ${typeof hit.value === 'string' ? hit.value : ''}`,
          });
        }
      }
    }
    if (monitorResult.ok) {
      for (const candidate of candidates.values()) {
        const entry = monitorResult.value.get(candidate.code);
        if (entry) {
          candidate.monitored = true;
          candidate.monitorEnd = entry.end;
          candidate.signals.push({
            label: '重点监控',
            points: -18,
            detail: `监控至 ${entry.end}`,
          });
        }
      }
    }
    if (anomalyResult.ok) {
      for (const candidate of candidates.values()) {
        const triggered = anomalyResult.value.items.find(
          (item) => item.code === candidate.code && item.isTriggered,
        );
        if (triggered) {
          candidate.anomalyRule = triggered.rule;
          candidate.signals.push({ label: '严重异动', points: -12, detail: triggered.rule });
        }
      }
    }
    const eligibleScore = (candidate) => {
      let value = candidate.sourceScore;
      if (candidate.sourceTypes.some((kind) => kind !== 'limit')) value += 8;
      if (candidate.limitType === 'zt' || (candidate.pct !== null && candidate.pct >= 9.2)) {
        value -= 28;
      }
      if (candidate.limitDown) value -= 40;
      return value;
    };
    let pool = [...candidates.values()].filter(
      (candidate) => candidate.sourceScore > -25 && !candidate.limitDown,
    );
    pool.sort((a, b) => eligibleScore(b) - eligibleScore(a));
    const bucketOf = (candidate) => {
      const nonLimit = candidate.sourceTypes.some((kind) => kind !== 'limit');
      const board =
        candidate.limitType === 'zt' || (candidate.pct !== null && candidate.pct >= 9.2);
      if (nonLimit && !board) return 0;
      if (!nonLimit && !board) return 1;
      if (nonLimit && board) return 2;
      return 3;
    };
    pool.sort((a, b) => bucketOf(a) - bucketOf(b));
    pool = pool.slice(0, limit);
    if (pool.length > 0) {
      const codesJoined = pool.map((candidate) => candidate.code).join(',');
      const [quotes, flows] = await Promise.all([
        stockEnv({ codes: codesJoined }).catch(() => null),
        fundFlowEnv({ codes: codesJoined, days: '60' }).catch(() => null),
      ]);
      if (quotes && quotes.success === true && quotes.data) {
        for (const candidate of pool) {
          const quote = quotes.data[candidate.code];
          if (quote) {
            if (typeof quote.name === 'string' && quote.name !== '') candidate.name = quote.name;
            if (typeof quote.changePercent === 'number') candidate.pct = quote.changePercent;
            if (typeof quote.priceValue === 'number') candidate.price = quote.priceValue;
          }
        }
      }
      var flowByCode = new Map();
      if (flows && flows.success === true && flows.data && Array.isArray(flows.data.items)) {
        for (const item of flows.data.items) {
          if (item && typeof item.code === 'string') flowByCode.set(item.code, item);
        }
      }
    } else {
      var flowByCode = new Map();
    }
    const scored = await Promise.all(
      pool.map(async (candidate) => {
        const [kline, news] = await Promise.all([
          stockKlineEnv({ code: candidate.code }),
          stockNewsEnv({ code: candidate.code, limit: '4' }),
        ]);
        const analysis =
          kline && kline.success === true && kline.data ? kline.data.analysis : null;
        const tech = analysis && typeof analysis.score === 'number' ? analysis.score : null;
        const momentum =
          analysis && analysis.indicators && typeof analysis.indicators.momentum21 === 'number'
            ? analysis.indicators.momentum21
            : null;
        const volume =
          analysis && analysis.indicators && typeof analysis.indicators.volumeRatio === 'number'
            ? analysis.indicators.volumeRatio
            : null;
        const newsScoreValue =
          news && news.success === true && news.data && news.data.score
            ? news.data.score.score
            : null;
        const positiveHits =
          news && news.success === true && news.data && news.data.score
            ? news.data.score.positiveHits
            : [];
        const riskHits =
          news && news.success === true && news.data && news.data.score
            ? news.data.score.riskHits
            : [];
        const fundItem = flowByCode.get(candidate.code);
        const todayMain =
          fundItem && fundItem.summary && fundItem.summary.today
            ? fundItem.summary.today.main
            : null;
        const five = fundItem && fundItem.summary ? fundItem.summary.main_5d : null;
        const twenty = fundItem && fundItem.summary ? fundItem.summary.main_20d : null;
        const fundAvailable =
          fundItem !== undefined &&
          fundItem.available !== false &&
          (todayMain !== null || five !== null || twenty !== null);
        const topic = roundHA(
          clampScore(48 + candidate.sourceScore + (candidate.tags.length > 0 ? 4 : 0), 0, 100),
          0,
        );
        const momentumScore =
          candidate.pct !== null
            ? roundHA(
                clampScore(
                  50 +
                    candidate.pct * 3.2 +
                    (momentum !== null ? momentum : 0) * 0.75 +
                    (volume !== null && volume > 1.4 ? 6 : 0),
                  0,
                  100,
                ),
                0,
              )
            : null;
        const fundScore = fundAvailable
          ? roundHA(
              clampScore(
                50 +
                  ((todayMain !== null ? todayMain : 0) / 1e8) * 11 +
                  ((five !== null ? five : 0) / 3e8) * 8 +
                  ((candidate.dragon !== null ? candidate.dragon : 0) / 10000) * 3,
                0,
                100,
              ),
              0,
            )
          : null;
        const technicalScore =
          tech !== null ? roundHA(clampScore(50 + tech * 0.5, 0, 100), 0) : null;
        const newsScore = roundHA(
          clampScore(50 + (newsScoreValue !== null ? newsScoreValue : 0) * 9, 0, 100),
          0,
        );
        const risks = [];
        const upperName = candidate.name.toUpperCase();
        if (upperName.includes('ST') || candidate.name.includes('退')) {
          risks.push({ points: 30, label: '特殊风险' });
        }
        if (candidate.limitDown) risks.push({ points: 22, label: '跌停池' });
        if (candidate.limitType === 'zt') risks.push({ points: 18, label: '已涨停' });
        else if (candidate.pct !== null && candidate.pct >= 9.2) {
          risks.push({ points: 12, label: '涨幅过热' });
        }
        if (candidate.pct !== null && candidate.pct <= -7) {
          risks.push({ points: 7, label: '跌幅过大' });
        }
        if (tech !== null && tech <= -35) risks.push({ points: 8, label: '技术弱势' });
        if ((todayMain !== null ? todayMain : 0) <= -1e8) {
          risks.push({ points: 6, label: '主力流出' });
        }
        if (candidate.monitored) risks.push({ points: 18, label: '重点监控' });
        if (candidate.anomalyRule !== '') risks.push({ points: 12, label: '严重异动' });
        if (riskHits.length > 0) {
          risks.push({ points: Math.min(riskHits.length * 4, 14), label: '新闻风险' });
        }
        const riskPoints = risks.reduce((total, risk) => total + risk.points, 0);
        const riskStatus = riskPoints >= 16 ? 'block' : riskPoints >= 7 ? 'watch' : 'pass';
        const riskLabel = riskPoints >= 16 ? '回避' : riskPoints >= 7 ? '观察' : '可跟踪';
        const components = {
          topic,
          momentum: momentumScore,
          fund: fundScore,
          technical: technicalScore,
          news: newsScore,
        };
        const weights = { topic: 0.22, momentum: 0.2, fund: 0.2, technical: 0.2, news: 0.12 };
        const availableComponents = Object.entries(components).filter(
          ([, value]) => value !== null,
        );
        let score = null;
        if (availableComponents.length >= 3) {
          const weighted =
            availableComponents.reduce(
              (total, [key, value]) => total + value * weights[key],
              0,
            ) / availableComponents.reduce((total, [key]) => total + weights[key], 0);
          score = roundHA(
            clampScore(weighted - Math.max(riskPoints - 8, 0) * 0.8, 0, 100),
            0,
          );
        }
        const coverage = Math.round((availableComponents.length / 5) * 100);
        const missingSources = ['topic', 'momentum', 'fund', 'technical', 'news'].filter(
          (key) => components[key] === null,
        );
        let topicText = candidate.tags.slice(0, 3).join(' / ');
        if (topicText === '' && candidate.dragonReason !== '') topicText = candidate.dragonReason;
        if (topicText === '') topicText = '--';
        const signals = [...candidate.signals]
          .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
          .slice(0, 5);
        let upDayRate60 = null;
        if (kline && kline.success === true && kline.data && Array.isArray(kline.data.bars)) {
          const pcts = kline.data.bars
            .map((bar) => bar.pct)
            .filter((value) => typeof value === 'number');
          if (pcts.length > 0) {
            upDayRate60 = round((pcts.filter((value) => value > 0).length / pcts.length) * 100, 1);
          }
        }
        return {
          code: candidate.code,
          name: candidate.name,
          price: candidate.price,
          pct: candidate.pct !== null ? round(candidate.pct, 2) : null,
          score,
          coverage,
          missingSources,
          topic: topicText,
          components,
          risk: {
            status: riskStatus,
            label: riskLabel,
            points: riskPoints,
            reasons: risks.slice(0, 4).map((risk) => risk.label),
          },
          marketWarnings: {
            monitored: candidate.monitored,
            monitorEnd: candidate.monitorEnd,
            anomaly: candidate.anomalyRule !== '',
            anomalyRule: candidate.anomalyRule,
          },
          signals,
          upDayRate60,
          newsHits: positiveHits,
          newsRisks: riskHits,
          latestDate:
            kline && kline.success === true && kline.data && kline.data.latestDate
              ? kline.data.latestDate
              : '',
        };
      }),
    );
    scored.sort((a, b) => (b.score !== null ? b.score : -1) - (a.score !== null ? a.score : -1));
    const sourceStatus = {
      hotRank: (ths && ths.success === true) || (em && em.success === true),
      limitUp:
        (zt && zt.success === true) || (yzt && yzt.success === true) || (zb && zb.success === true),
      dragonTiger: dragon && dragon.success === true,
      sector: sector && sector.success === true,
      stockMonitor: monitorResult.ok,
      priceAnomaly: anomalyResult.ok,
    };
    const statusEntry = (envelopeOrOk) => ({
      status: envelopeOrOk ? 'live' : 'failed',
    });
    return okExtra(
      { generatedAt: nowIso(), sourceStatus, items: scored },
      {
        meta: {
          generatedAt: nowIso(),
          stale: false,
          degraded: Object.values(sourceStatus).some((value) => value !== true),
          sources: {
            hotRankThs: statusEntry(ths && ths.success === true),
            hotRankEm: statusEntry(em && em.success === true),
            limitUpZt: statusEntry(zt && zt.success === true),
            limitUpYzt: statusEntry(yzt && yzt.success === true),
            limitUpZb: statusEntry(zb && zb.success === true),
            limitUpDt: statusEntry(dt && dt.success === true),
            dragonTiger: statusEntry(dragon && dragon.success === true),
            sector: statusEntry(sector && sector.success === true),
            stockMonitor: statusEntry(monitorResult.ok),
            priceAnomaly: statusEntry(anomalyResult.ok),
          },
        },
      },
    );
  }

  /* ------------------------------------------------------------------- handle */

  async function route(path, query) {
    switch (path) {
      case 'stock':
        return stockEnv(query);
      case 'stock-search':
        return stockSearchEnv(query);
      case 'hot-rank':
        return hotRankEnv(query);
      case 'limit-up':
        return limitUpEnv(query);
      case 'news':
        return jin10Env(query);
      case 'cls-news':
        return clsNewsEnv(query);
      case 'global-news':
        return globalNewsEnv(query);
      case 'stock-news':
        return stockNewsEnv(query);
      case 'stock-risk':
        return stockRiskEnv(query);
      case 'dragon-tiger':
        return dragonTigerEnv(query);
      case 'fund-flow-120d':
        return fundFlowEnv(query);
      case 'market-data':
        return marketDataEnv(query);
      case 'stock-kline':
        return stockKlineEnv(query);
      case 'stock-minute':
        return stockMinuteEnv(query);
      case 'sector-rotation':
        return sectorRotationEnv(query);
      case 'market-warnings':
        return marketWarningsEnv(query);
      case 'intraday-screening':
        return intradayScreeningEnv(query);
      case 'opportunity-radar':
        return opportunityRadarEnv(query);
      case 'stock-fundamentals':
        return stockFundamentalsEnv(query);
      case 'stock-research':
        return stockResearchEnv(query);
      default:
        return fail('API not found', 'unknown route');
    }
  }

  async function handle(path, query) {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    try {
      return await route(cleanPath, query || {});
    } catch (error) {
      return failApi('上游服务暂不可用', error);
    }
  }

  /* --------------------------------------------------------------- internals */

  function envelopeError(envelope) {
    const error = new Error(envelope.message || '请求失败');
    error.code = envelope.errorCode || envelope.error || 'upstream_error';
    error.retryable = envelope.retryable;
    error.status = envelope.status !== undefined ? envelope.status : null;
    return error;
  }

  async function unwrap(promise) {
    const envelope = await promise;
    if (envelope && envelope.success === true) return envelope.data;
    throw envelopeError(envelope || {});
  }

  const internals = {
    stockQuotes: (codes) =>
      unwrap(stockEnv({ codes: Array.isArray(codes) ? codes.join(',') : '' })),
    // 补充约定：返回完整信封 {success, data, meta}，不抛错。
    researchSnapshot: (code) => stockResearchEnv({ code: String(code || '') }),
    stockKline: (code, days) =>
      unwrap(
        stockKlineEnv({
          code: String(code || ''),
          ...(days !== undefined && days !== null ? { days: String(days) } : {}),
        }),
      ),
    stockNews: (code, name, limit) =>
      unwrap(
        stockNewsEnv({
          code: String(code || ''),
          ...(name ? { name: String(name) } : {}),
          ...(limit !== undefined && limit !== null ? { limit: String(limit) } : {}),
        }),
      ),
    fundFlow: (codes, days) =>
      unwrap(
        fundFlowEnv({
          codes: Array.isArray(codes) ? codes.join(',') : '',
          ...(days !== undefined && days !== null ? { days: String(days) } : {}),
        }),
      ),
    hotRank: (source, limit, period) =>
      unwrap(
        hotRankEnv({
          ...(source ? { source: String(source) } : {}),
          ...(limit !== undefined && limit !== null ? { limit: String(limit) } : {}),
          ...(period ? { period: String(period) } : {}),
        }),
      ),
    limitUp: (type, limit, dateStr) =>
      unwrap(
        limitUpEnv({
          ...(type ? { type: String(type) } : {}),
          ...(limit !== undefined && limit !== null ? { limit: String(limit) } : {}),
          ...(dateStr ? { date: String(dateStr) } : {}),
        }),
      ),
    dragonTiger: () => unwrap(dragonTigerEnv({})),
    marketData: (type, boardType, period) =>
      unwrap(
        marketDataEnv({
          type: String(type || ''),
          ...(boardType ? { boardType: String(boardType) } : {}),
          ...(period ? { period: String(period) } : {}),
        }),
      ),
  };

  return { handle, internals };
}

module.exports = { createDataRoutes };
