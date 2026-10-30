'use strict';

// 盘中盯盘增强层（融合计划第 3 期）：
// 1) 昨日梯队：最近存档日的涨停梯队在今日的实时表现（晋级/红盘/平均涨幅）。
// 2) 盘中异动流：对「自选/持仓 + 昨日梯队」的监控集合做 30 秒报价差分，
//    识别急拉/急跌（约 3 分钟涨跌幅 ≥1.5%）、封板、开板；同股同类 5 分钟去重；
//    事件落盘 DATA_DIR/intraday/anomalies-YYYY-MM-DD.json，盘后可回看。
// 3) 六时点情绪快照：09:25/09:35/10:00/11:30/14:00/15:00 把当时情绪读数落盘
//    DATA_DIR/intraday/YYYY-MM-DD.json，供复盘页回看全天情绪路径。
// 口径说明：报价无盘中最高价字段，封板/开板以最新价触及/离开涨停价判定，
// 两次轮询之间一触即开的情形可能漏检；盘中池计数沿用打板接口 100 条口径。

const fs = require('fs');
const path = require('path');
const { isTradingDay } = require('./calendar');

const SLOTS = [
  { key: '0925', minutes: 9 * 60 + 25, label: '09:25' },
  { key: '0935', minutes: 9 * 60 + 35, label: '09:35' },
  { key: '1000', minutes: 10 * 60, label: '10:00' },
  { key: '1130', minutes: 11 * 60 + 30, label: '11:30' },
  { key: '1400', minutes: 14 * 60, label: '14:00' },
  { key: '1500', minutes: 15 * 60, label: '15:00' },
];
const MAX_MONITOR = 240;
const EVENT_DEDUP_MS = 5 * 60 * 1000;
const PRICE_WINDOW_MS = 6 * 60 * 1000;
const SPIKE_REF_MIN_MS = 150 * 1000; // 至少 2.5 分钟前的价作基准
const SPIKE_REF_MAX_MS = 240 * 1000; // 基准价不超过 4 分钟前
const SPIKE_PCT = 1.5;

const CST_OFFSET_MS = 8 * 3600 * 1000;
function cstNow() { return new Date(Date.now() + CST_OFFSET_MS); }
function dateStr(d) { return d.toISOString().slice(0, 10); }
function todayCst() { return dateStr(cstNow()); }
function minutesCst() { const d = cstNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function validCode(c) { return typeof c === 'string' && /^\d{6}$/.test(c); }

function limitPctFor(code, name) {
  if (typeof name === 'string' && /ST/i.test(name)) return 5;
  if (/^(688|300|301)/.test(code)) return 20;
  if (/^(43|83|87|92)/.test(code)) return 30;
  return 10;
}

function isTradingSession(date) {
  if (!(date instanceof Date)) return false;
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const m = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (m >= 565 && m <= 705) || (m >= 775 && m <= 905);
}

class IntradayService {
  constructor({ dataDir, stores, internals, archive, getQuotes }) {
    this.dataDir = dataDir;
    // 多用户：监控集合 = 全体用户自选/持仓的并集 + 昨日梯队；
    // 异动流按请求用户的自选/持仓过滤下发，梯队部分公共可见。
    this.stores = stores;
    this.internals = internals;
    this.archive = archive;
    this.getQuotes = getQuotes;
    this.timer = null;
    this.polling = false;
    this.monitorDay = null;
    this.monitorCodesCache = [];
    this.priceWindow = new Map(); // code -> [{t, price}]
    this.atLimit = new Set();
    this.lastEventAt = new Map(); // code|type -> ts
    this.events = []; // today only
    this.eventsDay = null;
    this.nameCache = new Map();
  }

  _dir() { return path.join(this.dataDir, 'intraday'); }
  _ensureDir() { fs.mkdirSync(this._dir(), { recursive: true }); }
  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  _writeJson(file, value) {
    this._ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      this._poll().catch(() => {});
      this._snapshotTick().catch(() => {});
    };
    setTimeout(tick, 30000);
    this.timer = setInterval(tick, 30000);
    if (this.timer.unref) this.timer.unref();
  }

  /* ---------- 监控集合 ---------- */

  _watchCodesFor(store) {
    if (!store || typeof store.dataValue !== 'function') return [];
    let codes = null;
    const tabs = store.dataValue('fund_tracker_watchlist_tabs');
    if (Array.isArray(tabs)) {
      const def = tabs.find((t) => t && t.id === 'default');
      if (def && Array.isArray(def.codes)) codes = def.codes;
      if (!codes) {
        const all = [];
        for (const t of tabs) if (t && Array.isArray(t.codes)) all.push(...t.codes);
        if (all.length) codes = all;
      }
    }
    if (!codes) {
      const wl = store.dataValue('fund_tracker_watchlist');
      if (Array.isArray(wl)) codes = wl;
    }
    const seen = new Set();
    return (codes || []).filter((c) => validCode(c) && !seen.has(c) && seen.add(c));
  }

  _watchCodes() {
    const seen = new Set();
    const all = [];
    for (const { store } of this.stores.all()) {
      for (const c of this._watchCodesFor(store)) {
        if (!seen.has(c)) { seen.add(c); all.push(c); }
      }
    }
    return all;
  }

  _userCodes(username) {
    if (!username) return [];
    try { return this._watchCodesFor(this.stores.get(username)); } catch { return []; }
  }

  _ladderCodes() {
    if (!this.archive) return [];
    const dates = this.archive.listDates();
    if (!dates.length) return [];
    const rec = this.archive.getDay(dates[dates.length - 1]);
    const zt = (rec && rec.pools && rec.pools.zt) || [];
    const seen = new Set();
    return zt.map((s) => s.code).filter((c) => validCode(c) && !seen.has(c) && seen.add(c));
  }

  _monitorCodes() {
    const today = todayCst();
    if (this.monitorDay === today && this.monitorCodesCache.length) return this.monitorCodesCache;
    const seen = new Set();
    const merged = [];
    for (const c of [...this._watchCodes(), ...this._ladderCodes()]) {
      if (!seen.has(c) && merged.length < MAX_MONITOR) { seen.add(c); merged.push(c); }
    }
    this.monitorDay = today;
    this.monitorCodesCache = merged;
    return merged;
  }

  async _quotesFor(codes) {
    const out = {};
    for (let i = 0; i < codes.length; i += 100) {
      try {
        const part = await this.getQuotes(codes.slice(i, i + 100));
        if (part) Object.assign(out, part);
      } catch { /* 单批失败不拖垮整体 */ }
    }
    return out;
  }

  /* ---------- 昨日梯队 ---------- */

  async ladderBoard() {
    const dates = this.archive ? this.archive.listDates() : [];
    if (!dates.length) return { ok: false, error: '暂无存档数据' };
    let baseDate = dates[dates.length - 1];
    // 当日 15:35 前若今日已存档（异常情况）梯队仍看上一交易日
    if (baseDate === todayCst() && minutesCst() < 935 && dates.length > 1) baseDate = dates[dates.length - 2];
    const rec = this.archive.getDay(baseDate);
    const zt = (rec && rec.pools && rec.pools.zt) || [];
    if (!zt.length) return { ok: false, error: `${baseDate} 无涨停池存档`, baseDate };
    const quotes = await this._quotesFor(zt.map((s) => s.code));
    const byLevel = new Map();
    let quoted = 0;
    for (const s of zt) {
      const q = quotes[s.code];
      const level = Number.isInteger(s.limitDays) && s.limitDays > 0 ? s.limitDays : 1;
      const row = {
        code: s.code, name: s.name, industry: s.industry || '',
        price: null, pct: null, status: '无行情',
      };
      if (q && Number(q.priceValue) > 0) {
        quoted++;
        row.price = q.priceValue;
        row.pct = typeof q.changePercent === 'number' ? q.changePercent : null;
        const lp = limitPctFor(s.code, q.name || s.name);
        if (row.pct !== null && row.pct >= lp - 0.35) row.status = '涨停';
        else if (row.pct !== null && row.pct <= -(lp - 0.35)) row.status = '跌停';
        else if (row.pct !== null && row.pct > 0) row.status = '红盘';
        else if (row.pct !== null && row.pct < 0) row.status = '绿盘';
        else row.status = '平盘';
      }
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level).push(row);
    }
    const groups = [...byLevel.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([level, stocks]) => {
        const withPct = stocks.filter((r) => r.pct !== null);
        return {
          level,
          count: stocks.length,
          limitUp: stocks.filter((r) => r.status === '涨停').length,
          upRate: withPct.length ? round((withPct.filter((r) => r.pct > 0).length / withPct.length) * 100, 1) : null,
          avgPct: withPct.length ? round(withPct.reduce((a, r) => a + r.pct, 0) / withPct.length, 2) : null,
          stocks: stocks.sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999)),
        };
      });
    const all = groups.flatMap((g) => g.stocks).filter((r) => r.pct !== null);
    return {
      baseDate,
      quoted,
      total: zt.length,
      summary: {
        limitUp: all.filter((r) => r.status === '涨停').length,
        upRate: all.length ? round((all.filter((r) => r.pct > 0).length / all.length) * 100, 1) : null,
        avgPct: all.length ? round(all.reduce((a, r) => a + r.pct, 0) / all.length, 2) : null,
        downLimit: all.filter((r) => r.status === '跌停').length,
      },
      groups,
    };
  }

  /* ---------- 盘中异动流 ---------- */

  _eventsFile(date) { return path.join(this._dir(), `anomalies-${date}.json`); }

  _loadEvents(date) {
    if (this.eventsDay === date) return this.events;
    const stored = this._readJson(this._eventsFile(date), null);
    this.events = stored && Array.isArray(stored.events) ? stored.events : [];
    this.eventsDay = date;
    return this.events;
  }

  anomalies(date, username) {
    const target = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayCst();
    let events = target === todayCst()
      ? this._loadEvents(target)
      : (this._readJson(this._eventsFile(target), { events: [] }).events || []);
    // 按用户过滤：只下发该用户自选/持仓与公共梯队的异动
    const visible = new Set([...this._userCodes(username), ...this._ladderCodes()]);
    events = events.filter((e) => visible.has(e.code));
    return {
      date: target,
      monitorCount: target === todayCst() ? visible.size : null,
      events: events.slice(0, 100),
    };
  }

  _pushEvent(date, ev) {
    const key = `${ev.code}|${ev.type}`;
    const last = this.lastEventAt.get(key) || 0;
    if (ev.t - last < EVENT_DEDUP_MS) return false;
    this.lastEventAt.set(key, ev.t);
    const events = this._loadEvents(date);
    events.unshift(ev);
    if (events.length > 200) events.length = 200;
    this._writeJson(this._eventsFile(date), { date, updatedAt: new Date(ev.t).toISOString(), events });
    return true;
  }

  async _poll() {
    if (this.polling) return;
    const now = cstNow();
    if (!isTradingSession(now)) return;
    const codes = this._monitorCodes();
    if (!codes.length) return;
    this.polling = true;
    try {
      const quotes = await this._quotesFor(codes);
      const t = Date.now();
      const today = todayCst();
      const timeText = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
      for (const code of codes) {
        const q = quotes[code];
        if (!q || !(Number(q.priceValue) > 0)) continue;
        const price = Number(q.priceValue);
        const name = q.name || this.nameCache.get(code) || code;
        if (q.name) this.nameCache.set(code, q.name);
        let win = this.priceWindow.get(code);
        if (!win) { win = []; this.priceWindow.set(code, win); }
        win.push({ t, price });
        while (win.length && t - win[0].t > PRICE_WINDOW_MS) win.shift();

        // 封板 / 开板（以最新价相对涨停价判定）
        const pct = typeof q.changePercent === 'number' ? q.changePercent : null;
        const prevClose = typeof q.change === 'number' && Number.isFinite(q.change)
          ? price - q.change
          : (pct !== null && pct > -100 ? price / (1 + pct / 100) : null);
        if (prevClose && prevClose > 0) {
          const lp = limitPctFor(code, name);
          const limitPrice = Math.round(prevClose * (1 + lp / 100) * 100) / 100;
          const atLimit = price >= limitPrice * 0.998 && pct !== null && pct > 0;
          const was = this.atLimit.has(code);
          if (atLimit && !was) {
            this.atLimit.add(code);
            this._pushEvent(today, { t, time: timeText, code, name, type: '封板', detail: `触及涨停价 ${limitPrice.toFixed(2)}`, pct });
          } else if (!atLimit && was && price <= limitPrice * 0.99) {
            this.atLimit.delete(code);
            this._pushEvent(today, { t, time: timeText, code, name, type: '开板', detail: `涨停打开，现价 ${price.toFixed(2)}`, pct });
          } else if (!atLimit && was) {
            this.atLimit.delete(code);
          }
        }

        // 急拉 / 急跌（约 3 分钟窗口）
        let ref = null;
        for (const s of win) {
          const age = t - s.t;
          if (age >= SPIKE_REF_MIN_MS && age <= SPIKE_REF_MAX_MS) { ref = s; break; }
        }
        if (ref && ref.price > 0) {
          const delta = ((price / ref.price) - 1) * 100;
          const windowMin = round((t - ref.t) / 60000, 1);
          if (delta >= SPIKE_PCT) {
            this._pushEvent(today, { t, time: timeText, code, name, type: '急拉', detail: `${windowMin} 分钟 +${round(delta, 2)}%`, pct });
          } else if (delta <= -SPIKE_PCT) {
            this._pushEvent(today, { t, time: timeText, code, name, type: '急跌', detail: `${windowMin} 分钟 ${round(delta, 2)}%`, pct });
          }
        }
      }
      // 长期不活跃的窗口清理（收盘后自然失效，这里防内存增长）
      if (this.priceWindow.size > MAX_MONITOR * 2) {
        for (const [code, win] of this.priceWindow) {
          if (!win.length || t - win[win.length - 1].t > PRICE_WINDOW_MS) this.priceWindow.delete(code);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /* ---------- 六时点情绪快照 ---------- */

  _snapFile(date) { return path.join(this._dir(), `${date}.json`); }

  snapshots(date) {
    const target = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayCst();
    const stored = this._readJson(this._snapFile(target), null);
    const slots = stored && stored.slots ? stored.slots : {};
    return {
      date: target,
      slots: SLOTS.map((s) => ({ key: s.key, label: s.label, ...(slots[s.key] || { missing: true }) })),
    };
  }

  async _snapshotTick() {
    if (!this.internals) return;
    const today = todayCst();
    if (isTradingDay(today) !== true) return;
    const m = minutesCst();
    const due = SLOTS.find((s) => m >= s.minutes && m < s.minutes + 3);
    if (!due) return;
    const stored = this._readJson(this._snapFile(today), { date: today, slots: {} });
    if (stored.slots && stored.slots[due.key]) return;
    let summary = null;
    try {
      // internals.limitUp 返回已拆封的 data（失败抛错）
      const d = await this.internals.limitUp('summary');
      if (d && typeof d.ztCount === 'number') {
        summary = {
          ztCount: d.ztCount, zbCount: d.zbCount, dtCount: d.dtCount,
          breakRate: d.breakRate, maxHeight: d.maxHeight, promoteRate: d.promoteRate,
        };
      }
    } catch { /* 池接口失败则本时点跳过，下个 tick 窗口内重试 */ }
    if (!summary) return;
    let breadth = null;
    try {
      const b = await this.internals.marketData('breadth');
      if (b && typeof b.up === 'number') breadth = { up: b.up, down: b.down, flat: b.flat };
    } catch { /* breadth 是 best-effort */ }
    stored.date = today;
    stored.slots = stored.slots || {};
    stored.slots[due.key] = { capturedAt: new Date().toISOString(), summary, breadth };
    this._writeJson(this._snapFile(today), stored);
  }

  /* ---------- 路由 ---------- */

  async handle(query, username) {
    const action = query && typeof query.action === 'string' ? query.action : 'ladder';
    if (action === 'anomalies') return { success: true, data: this.anomalies(query.date, username) };
    if (action === 'snapshots') return { success: true, data: this.snapshots(query.date) };
    const board = await this.ladderBoard();
    if (board.ok === false) return { success: false, error: board.error, data: board };
    return { success: true, data: board };
  }
}

module.exports = { IntradayService, SLOT_DEFS: SLOTS, _internals: { limitPctFor, isTradingSession } };
