'use strict';
// 市场存档层（融合计划第 0 期）：每个交易日收盘后把东财四池（涨停/炸板/跌停/昨日涨停）
// 定稿名单与情绪读数落盘到 DATA_DIR/archive/YYYY-MM-DD.json，攒成自己的历史序列。
// 动机：东财池接口只保留约一个月，过期不可查；不当天抄下来，题材轮动/情绪分位/
// 明日验证对账就没有原料。缺池标注 missing、complete=false，绝不拿空数据充定稿。
// 调度：启动后与每 10 分钟巡检一次——今天满 15:35 后抓今天；近 31 天内缺失或
// 不完整的交易日顺带回补（每轮最多 3 天）。涨跌家数只能取当日，历史回补日为 null。
const fs = require('fs');
const path = require('path');
const { shanghaiNow, todayStr, addDays, isTradingDay } = require('./calendar');

const CAPTURE_AFTER_MINUTES = 15 * 60 + 35; // 15:35，与 vibe 的短线收盘取数时点对齐
const BACKFILL_DAYS = 31;
const PER_TICK_MAX = 3;

class MarketArchive {
  constructor({ dataDir, internals }) {
    this.dir = path.join(dataDir, 'archive');
    this.internals = internals || null;
    this.timer = null;
    this.busy = false;
  }

  _file(date) { return path.join(this.dir, `${date}.json`); }

  // 失败尝试计数（落盘）：历史日期的上游池数据超出保留期后永远取不到，
  // 过去日期失败满 3 次即放弃（gaveUp），避免巡检无限重试；今天的失败不放弃。
  _stateFile() { return path.join(this.dir, 'state.json'); }

  _loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._stateFile(), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.attempts && typeof parsed.attempts === 'object') return parsed;
    } catch { /* 无状态文件按空处理 */ }
    return { attempts: {} };
  }

  _saveState(state) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this._stateFile();
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch { /* 状态写失败不影响存档主流程 */ }
  }

  _readDay(date) {
    try {
      const raw = fs.readFileSync(this._file(date), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  }

  _writeDay(record) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this._file(record.date);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  }

  listDates() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  }

  // 抓取并落盘某一天。zt 池是必需项：失败则整次放弃（不落盘），等下一轮重试；
  // 其余池失败记 missing 并照常落盘（complete=false），后续巡检会再补。
  async captureDay(date, { withBreadth = false } = {}) {
    if (!this.internals || typeof this.internals.archivePools !== 'function') {
      throw new Error('数据层未就绪，无法存档');
    }
    const { pools, summary, missing } = await this.internals.archivePools(date);
    let breadth = null;
    if (withBreadth) {
      try {
        const b = await this.internals.marketData('breadth');
        if (b && typeof b === 'object') {
          breadth = {
            up: b.up, down: b.down, flat: b.flat, covered: b.covered,
            markets: b.markets, indexBreadth: b.indexBreadth,
          };
        }
      } catch { breadth = null; }
    }
    const record = {
      version: 1,
      date,
      capturedAt: new Date().toISOString(),
      source: 'eastmoney-pools',
      complete: missing.length === 0,
      missing,
      pools,
      summary,
      breadth,
    };
    this._writeDay(record);
    return record;
  }

  // 本轮需要抓的日期（升序）：近 BACKFILL_DAYS 天内的交易日，缺失或不完整者；
  // 今天必须收盘定稿后（>=15:35）才抓。
  dueDates(now = shanghaiNow(), today = todayStr()) {
    const state = this._loadState();
    const due = [];
    for (let back = BACKFILL_DAYS; back >= 0; back--) {
      const date = addDays(today, -back);
      if (isTradingDay(date) !== true) continue;
      if (date === today && now.minutes < CAPTURE_AFTER_MINUTES) continue;
      const attempt = state.attempts[date];
      if (attempt && attempt.gaveUp) continue;
      const existing = this._readDay(date);
      if (!existing || existing.complete !== true) due.push(date);
    }
    return due;
  }

  async _tick() {
    if (this.busy || !this.internals) return;
    this.busy = true;
    try {
      const today = todayStr();
      // 新日期优先：可回补窗口内的真实数据先落地，超保留期的老日期随后慢慢试。
      const due = this.dueDates(shanghaiNow(), today).slice(-PER_TICK_MAX).reverse();
      for (const date of due) {
        try {
          const rec = await this.captureDay(date, { withBreadth: date === today });
          const state = this._loadState();
          if (state.attempts[date]) { delete state.attempts[date]; this._saveState(state); }
          console.log(`[archive] ${date} 已存档 complete=${rec.complete} zt=${rec.summary.ztCount} zb=${rec.summary.zbCount} dt=${rec.summary.dtCount}${rec.missing.length ? ` missing=${rec.missing.join(',')}` : ''}`);
        } catch (e) {
          const state = this._loadState();
          const attempt = state.attempts[date] || { count: 0, gaveUp: false };
          attempt.count += 1;
          attempt.lastError = e.message;
          if (date < today && attempt.count >= 3) attempt.gaveUp = true;
          state.attempts[date] = attempt;
          this._saveState(state);
          console.warn(`[archive] ${date} 存档失败（第 ${attempt.count} 次${attempt.gaveUp ? '，已放弃' : ''}）：${e.message}`);
        }
      }
    } finally { this.busy = false; }
  }

  start() {
    if (!this.internals) { console.warn('[archive] 数据层未就绪，存档调度未启动'); return; }
    const boot = setTimeout(() => { this._tick().catch(() => {}); }, 20000);
    boot.unref?.();
    this.timer = setInterval(() => { this._tick().catch(() => {}); }, 10 * 60 * 1000);
    this.timer.unref?.();
  }

  /* ------------------------------------------------------------ /market-archive */

  async handle(query) {
    const action = String((query && query.action) || 'list');
    if (action === 'list') {
      const days = Math.min(Math.max(Number(query.days) || 30, 1), 120);
      const dates = this.listDates().slice(-days).reverse();
      const items = dates.map((date) => {
        const rec = this._readDay(date);
        return rec
          ? { date, complete: rec.complete === true, missing: rec.missing || [], capturedAt: rec.capturedAt, summary: rec.summary || null }
          : { date, complete: false, missing: [], capturedAt: null, summary: null };
      });
      return { success: true, data: { count: items.length, items } };
    }
    if (action === 'day') {
      const date = String(query.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { success: false, message: '日期格式应为 YYYY-MM-DD', errorCode: 'invalid_input', retryable: false };
      }
      const rec = this._readDay(date);
      if (!rec) {
        return { success: false, message: '该日期暂无存档', errorCode: 'empty_data', retryable: false };
      }
      return { success: true, data: rec };
    }
    if (action === 'capture') {
      const date = String(query.date || todayStr());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isTradingDay(date) !== true) {
        return { success: false, message: '仅可存档交易日，日期格式 YYYY-MM-DD', errorCode: 'invalid_input', retryable: false };
      }
      if (this.busy) {
        return { success: false, message: '存档任务执行中，请稍后重试', errorCode: 'upstream_error', retryable: true };
      }
      this.busy = true;
      try {
        const rec = await this.captureDay(date, { withBreadth: date === todayStr() });
        return { success: true, data: { date, complete: rec.complete, missing: rec.missing, summary: rec.summary } };
      } catch (e) {
        return { success: false, message: `存档失败：${e.message}`, errorCode: 'upstream_error', retryable: true };
      } finally { this.busy = false; }
    }
    return { success: false, message: '未知 action（支持 list/day/capture）', errorCode: 'invalid_input', retryable: false };
  }
}

module.exports = { MarketArchive, CAPTURE_AFTER_MINUTES, BACKFILL_DAYS };
