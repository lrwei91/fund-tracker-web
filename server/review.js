'use strict';
// 复盘层（融合计划第 2 期，借鉴 vibe-astock 的复盘体系）：
// 1) 程序看板：基于存档层（archive/）的四池定稿与情绪读数，算连板天梯（含断层）、
//    封板质量、近 5 日题材（行业口径）轮动、各读数的历史分位；
// 2) AI 五段复盘（情绪/资金/题材/龙虎榜/龙头）：只喂程序资料包，生成后逐数字回查——
//    对不上资料包的数字一律替换为「〔未核实〕」并计数，不让编造数字交付；
// 3) 明日验证：复盘时写下可程序判定的方向条件，次日存档落地后自动对账，累计战绩。
//    09:15 后才写下的条件标 late，不计战绩（照 vibe 的事后不计规则）。
const fs = require('fs');
const path = require('path');
const { shanghaiNow, todayStr, addDays, isTradingDay } = require('./calendar');

const GENERATE_AFTER_MINUTES = 16 * 60 + 5; // 16:05，存档 15:35 落地之后
const METRICS = ['ztCount', 'dtCount', 'breakRate', 'maxHeight', 'promoteRate', 'yztMedianPct'];
const CONDITION_METRICS = new Set(METRICS);

function round(n, d = 1) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}
function nextTradingDay(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 15; i++) {
    d = addDays(d, 1);
    if (isTradingDay(d) === true) return d;
  }
  return null;
}
function percentileOf(values, v) {
  if (!values.length || typeof v !== 'number') return null;
  const below = values.filter((x) => x < v).length;
  const equal = values.filter((x) => x === v).length;
  return round(((below + equal / 2) / values.length) * 100, 0);
}

/* ------------------------------------------------------------ 数字核对 */

// 深度收集资料包里的全部数值（含数字字符串与数字键名），并登记常见舍入变体。
function collectAllowedNumbers(facts) {
  const allowed = [];
  const push = (n) => { if (typeof n === 'number' && Number.isFinite(n)) allowed.push(n); };
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'number') { push(node); return; }
    if (typeof node === 'string') {
      for (const m of node.matchAll(/-?\d+(?:\.\d+)?/g)) push(Number(m[0]));
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (/^-?\d+(?:\.\d+)?$/.test(k)) push(Number(k));
        walk(v);
      }
    }
  };
  walk(facts);
  // 算式重算档：资料包里的大额数值常以「万」为单位（如龙虎榜净买入 46100 万），
  // 正文换算成「亿」（4.61 亿）属正确换算，登记 /100 与 /10000 两种缩放变体供核对。
  const scaled = [];
  for (const a of allowed) {
    if (Math.abs(a) >= 100) { scaled.push(a / 100, a / 10000); }
  }
  return allowed.concat(scaled);
}
function numberVerified(value, allowed) {
  if (value === 2026 || value === 2025) return true; // 年份不核
  // 按量级核对：正文常把「-12.3亿」写成「净流出12.3亿」（符号由措辞承载），故符号不计，
  // 只核数值本身是否出自资料包；舍入容差取 0.051 与 1.2% 的较大者。
  return allowed.some((a) => Math.abs(Math.abs(a) - Math.abs(value)) <= Math.max(0.051, Math.abs(a) * 0.012));
}
// 把文本里核不上的数字替换为〔未核实〕，返回 {text, verified, unverified[]}
function checkNumbersInText(text, allowed) {
  let verified = 0;
  const unverified = [];
  const out = String(text || '').replace(/-?\d+(?:\.\d+)?/g, (token) => {
    const value = Number(token);
    if (numberVerified(value, allowed)) { verified++; return token; }
    unverified.push(token);
    return '〔未核实〕';
  });
  return { text: out, verified, unverified };
}

/* ------------------------------------------------------------ 复盘服务 */

const REVIEW_PROMPT = '你是 A 股短线复盘编辑。仅基于输入资料包写复盘，不联网、不编造：资料包里没有的数字、个股、事件一律不许出现；某段资料缺失时该段只写「暂无数据」四个字加一句说明缺什么。输出只用 JSON：{"sections":{"emotion":"情绪段","capital":"资金段","theme":"题材段","dragon":"龙虎榜段","leader":"龙头段"},"tomorrow":{"stance":"偏强|中性|偏弱","conditions":[{"metric":"指标键","op":">=或<=","value":数值,"label":"中文说明"}]}}。每段 2-4 句中文，只陈述事实与结构，不给买卖建议。tomorrow.conditions 给 2-3 条对下一交易日的可判定条件，metric 只能取 ztCount、maxHeight、promoteRate、breakRate、yztMedianPct、dtCount，value 必须来自资料包当日数值附近的合理阈值，label 用中文复述该条件。';

class MarketReview {
  constructor({ dataDir, ai, internals, archive }) {
    this.dir = path.join(dataDir, 'review');
    this.ai = ai || null;
    this.internals = internals || null;
    this.archive = archive || null;
    this.generating = false;
    this.timer = null;
  }

  _file(name) { return path.join(this.dir, name); }

  _readJson(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  }

  _writeJson(file, obj) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  _reportFile(date) { return this._file(`${date}.json`); }
  report(date) { return this._readJson(this._reportFile(date)); }

  _verifyStore() {
    return this._readJson(this._file('verify.json')) || { records: [] };
  }

  /* ---------------------------------------------------------- 程序看板 */

  board(date) {
    if (!this.archive) return null;
    const dates = this.archive.listDates();
    if (dates.length === 0) return null;
    const target = date && dates.includes(date) ? date : dates[dates.length - 1];
    const rec = this.archive.getDay(target);
    if (!rec) return null;
    const history = dates.map((d) => {
      const r = this.archive.getDay(d);
      return r ? { date: d, ...r.summary } : null;
    }).filter(Boolean);
    const percentiles = {};
    for (const m of METRICS) {
      percentiles[m] = percentileOf(history.map((h) => h[m]).filter((n) => typeof n === 'number'), rec.summary[m]);
    }
    // 连板天梯：按板位分组（高→低），标出 1..最高板之间缺失的断层板位。
    const byLevel = new Map();
    for (const s of rec.pools.zt || []) {
      const lv = s.limitDays;
      if (typeof lv !== 'number' || lv < 1) continue;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv).push({
        code: s.code, name: s.name, industry: s.industry,
        firstSeal: s.firstSeal, sealFundYi: typeof s.sealFund === 'number' ? round(s.sealFund / 1e8, 2) : null,
        breakTimes: s.breakTimes,
      });
    }
    const ladder = [...byLevel.keys()].sort((a, b) => b - a).map((lv) => ({
      level: lv, count: byLevel.get(lv).length, stocks: byLevel.get(lv),
    }));
    const gaps = [];
    for (let lv = 1; lv <= (rec.summary.maxHeight || 0); lv++) if (!byLevel.has(lv)) gaps.push(lv);
    // 封板质量：一次封死率、平均炸板次数、早盘（10:00 前）首封占比。
    const zt = rec.pools.zt || [];
    const sealQuality = zt.length ? {
      oneShotRate: round((zt.filter((s) => (s.breakTimes || 0) === 0).length / zt.length) * 100, 1),
      avgBreakTimes: round(zt.reduce((sum, s) => sum + (s.breakTimes || 0), 0) / zt.length, 2),
      earlySealRate: round((zt.filter((s) => s.firstSeal && s.firstSeal < '10:00:00').length / zt.length) * 100, 1),
    } : null;
    // 题材轮动：近 5 个存档日、按涨停池行业聚合。
    const last5 = dates.slice(-5);
    const themeMap = new Map();
    for (const d of last5) {
      const r = this.archive.getDay(d);
      if (!r) continue;
      const counts = new Map();
      for (const s of r.pools.zt || []) {
        const ind = s.industry || '其他';
        counts.set(ind, (counts.get(ind) || 0) + 1);
      }
      for (const [ind, c] of counts) {
        if (!themeMap.has(ind)) themeMap.set(ind, { industry: ind, counts: {}, total: 0 });
        const row = themeMap.get(ind);
        row.counts[d] = c;
        row.total += c;
      }
    }
    const themes = [...themeMap.values()]
      .map((row) => ({ ...row, today: row.counts[target] || 0 }))
      .sort((a, b) => (b.today - a.today) || (b.total - a.total))
      .slice(0, 10);
    const topSeal = [...zt]
      .filter((s) => typeof s.sealFund === 'number')
      .sort((a, b) => b.sealFund - a.sealFund)
      .slice(0, 5)
      .map((s) => ({ code: s.code, name: s.name, industry: s.industry, limitDays: s.limitDays, sealFundYi: round(s.sealFund / 1e8, 2) }));
    const verify = this._verifyStore();
    return {
      date: target,
      dates,
      complete: rec.complete === true,
      summary: rec.summary,
      breadth: rec.breadth || null,
      percentiles,
      historyDays: history.length,
      history: history.slice(-15),
      ladder,
      ladderGaps: gaps,
      sealQuality,
      themeDates: last5,
      themes,
      topSeal,
      report: this.report(target),
      verifyForDate: verify.records.filter((r) => r.fromDate === target),
      verifyResultForDate: verify.records.filter((r) => r.targetDate === target),
      scoreboard: scoreboardOf(verify.records),
    };
  }

  /* ---------------------------------------------------------- AI 复盘 */

  async _facts(date) {
    const board = this.board(date);
    if (!board) throw new Error('该日期暂无存档');
    const facts = {
      date,
      sentiment: board.summary,
      percentiles: board.percentiles,
      historyDays: board.historyDays,
      ladder: board.ladder.map((l) => ({
        level: l.level, count: l.count,
        stocks: l.stocks.slice(0, 6).map((s) => ({ name: s.name, industry: s.industry, firstSeal: s.firstSeal, sealFundYi: s.sealFundYi })),
      })),
      ladderGaps: board.ladderGaps,
      sealQuality: board.sealQuality,
      breadth: board.breadth ? { up: board.breadth.up, down: board.breadth.down, flat: board.breadth.flat } : null,
      themes: board.themes.map((t) => ({ industry: t.industry, today: t.today, last5Total: t.total, counts: t.counts })),
      topSeal: board.topSeal,
      dragonTiger: null,
      capital: null,
    };
    if (this.internals) {
      try {
        const dt = await this.internals.dragonTiger();
        if (dt && Array.isArray(dt.stocks) && dt.stocks.length) {
          const sorted = [...dt.stocks].filter((s) => typeof s.netBuyWan === 'number').sort((a, b) => b.netBuyWan - a.netBuyWan);
          facts.dragonTiger = {
            date: dt.date,
            topNetBuy: sorted.slice(0, 5).map((s) => ({ name: s.name, netBuyWan: s.netBuyWan, reason: s.reason })),
            topNetSell: sorted.slice(-3).reverse().map((s) => ({ name: s.name, netBuyWan: s.netBuyWan, reason: s.reason })),
          };
        }
      } catch { facts.dragonTiger = null; }
      try {
        const cap = await this.internals.marketData('capital');
        if (cap && cap.mainFund) {
          facts.capital = {
            mainFund: { label: cap.mainFund.label, value: cap.mainFund.value, available: cap.mainFund.available === true },
            breakdown: cap.mainFund.breakdown || null,
          };
        }
      } catch { facts.capital = null; }
    }
    return { board, facts };
  }

  async generate(date, { automatic = false } = {}) {
    if (!this.ai) throw new Error('AI 服务未接入');
    if (this.generating) throw new Error('复盘生成进行中');
    const { facts } = await this._facts(date);
    this.generating = true;
    let release = null;
    try {
      release = automatic ? this.ai.tryAutomatic() : await this.ai.acquireManual();
      if (!release) return null;
      const { raw, model } = await this.ai.modelRequest(REVIEW_PROMPT, facts, 4000);
      let text = String(raw || '').trim();
      if (text.startsWith('```')) text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      const obj = JSON.parse(text);
      const sectionsIn = obj?.sections || {};
      const allowed = collectAllowedNumbers(facts);
      const sections = {};
      let verified = 0;
      let unverifiedAll = [];
      for (const key of ['emotion', 'capital', 'theme', 'dragon', 'leader']) {
        const rawSection = typeof sectionsIn[key] === 'string' ? sectionsIn[key].trim().slice(0, 900) : '';
        if (!rawSection) { sections[key] = ''; continue; }
        const checked = checkNumbersInText(rawSection, allowed);
        sections[key] = checked.text;
        verified += checked.verified;
        unverifiedAll = unverifiedAll.concat(checked.unverified.map((t) => `${key}:${t}`));
      }
      if (!sections.emotion && !sections.theme) throw new Error('模型未返回有效复盘段落');
      // 明日验证条件：只收白名单指标、合法比较符与有限数值。
      const tomorrowIn = obj?.tomorrow || {};
      const conditions = [];
      if (Array.isArray(tomorrowIn.conditions)) {
        for (const c of tomorrowIn.conditions.slice(0, 3)) {
          if (!c || !CONDITION_METRICS.has(c.metric)) continue;
          if (c.op !== '>=' && c.op !== '<=') continue;
          const value = Number(c.value);
          if (!Number.isFinite(value)) continue;
          conditions.push({
            metric: c.metric, op: c.op, value,
            label: typeof c.label === 'string' ? c.label.slice(0, 80) : '',
          });
        }
      }
      const stance = ['偏强', '中性', '偏弱'].includes(tomorrowIn.stance) ? tomorrowIn.stance : '中性';
      const report = {
        date,
        generatedAt: new Date().toISOString(),
        model,
        sections,
        numbers: { verified, unverified: unverifiedAll },
        tomorrow: conditions.length ? { stance, conditions } : null,
      };
      // 明日验证以首次登记为准：重新生成复盘不得改动已登记的预判（防事后挑条件）。
      // 若该日已有验证记录，报告里的 tomorrow 直接回填登记版，保持页面与战绩口径一致。
      const existing = this._verifyStore().records.find((r) => r.fromDate === date);
      if (existing) {
        report.tomorrow = { stance: existing.stance, conditions: existing.conditions };
      }
      this._writeJson(this._reportFile(date), report);
      if (report.tomorrow && !existing) this._registerVerify(date, report);
      return report;
    } finally {
      if (release) release();
      this.generating = false;
    }
  }

  /* ---------------------------------------------------------- 明日验证 */

  _registerVerify(fromDate, report) {
    const targetDate = nextTradingDay(fromDate);
    if (!targetDate) return;
    const store = this._verifyStore();
    if (store.records.some((r) => r.fromDate === fromDate)) return;
    // 09:15 规则：目标日 09:15（上海）之后才生成的条件算事后，不计战绩。
    const lateAfter = Date.parse(`${targetDate}T01:15:00.000Z`); // 09:15 CST = 01:15 UTC
    const late = Date.now() > lateAfter;
    store.records.push({
      fromDate,
      targetDate,
      createdAt: new Date().toISOString(),
      stance: report.tomorrow.stance,
      conditions: report.tomorrow.conditions,
      late,
      verdict: null,
    });
    this._writeJson(this._file('verify.json'), store);
  }

  settle() {
    if (!this.archive) return 0;
    const store = this._verifyStore();
    let changed = 0;
    for (const record of store.records) {
      if (record.verdict) continue;
      const rec = this.archive.getDay(record.targetDate);
      if (!rec || rec.complete !== true) continue;
      const results = record.conditions.map((c) => {
        const actual = rec.summary[c.metric];
        const pass = typeof actual === 'number' ? (c.op === '>=' ? actual >= c.value : actual <= c.value) : false;
        return { ...c, actual: typeof actual === 'number' ? actual : null, pass };
      });
      const passed = results.filter((r) => r.pass).length;
      record.verdict = {
        checkedAt: new Date().toISOString(),
        results,
        passed,
        total: results.length,
        outcome: passed === results.length ? '全中' : passed === 0 ? '未中' : '部分命中',
      };
      changed++;
    }
    if (changed) this._writeJson(this._file('verify.json'), store);
    return changed;
  }

  /* ---------------------------------------------------------- 调度 */

  async _tick() {
    try { this.settle(); } catch { /* 对账失败下轮再试 */ }
    if (!this.ai || !this.archive || this.generating) return;
    const today = todayStr();
    if (isTradingDay(today) !== true) return;
    if (shanghaiNow().minutes < GENERATE_AFTER_MINUTES) return;
    const rec = this.archive.getDay(today);
    if (!rec || rec.complete !== true) return;
    if (this.report(today)) return;
    const state = this._readJson(this._file('auto-state.json')) || {};
    const attempts = state.date === today ? Number(state.attempts) || 0 : 0;
    const lastAt = state.date === today ? Date.parse(state.lastAt || 0) : 0;
    if (attempts >= 3 || Date.now() - lastAt < 30 * 60 * 1000) return;
    this._writeJson(this._file('auto-state.json'), { date: today, attempts: attempts + 1, lastAt: new Date().toISOString() });
    try {
      const report = await this.generate(today, { automatic: true });
      if (report) console.log(`[review] ${today} AI 复盘已生成 unverified=${report.numbers.unverified.length}`);
    } catch (e) {
      console.warn('[review] 自动复盘失败：', e.message);
    }
  }

  start() {
    const boot = setTimeout(() => { this._tick().catch(() => {}); }, 45000);
    boot.unref?.();
    this.timer = setInterval(() => { this._tick().catch(() => {}); }, 10 * 60 * 1000);
    this.timer.unref?.();
  }

  /* ---------------------------------------------------------- /market-review */

  async handle(query) {
    const action = String((query && query.action) || 'board');
    const date = String((query && query.date) || '') || null;
    if (action === 'board') {
      const board = this.board(date);
      if (!board) return { success: false, message: '暂无存档数据', errorCode: 'empty_data', retryable: false };
      return { success: true, data: board };
    }
    if (action === 'generate') {
      const target = date || (this.board(null)?.date ?? null);
      if (!target) return { success: false, message: '暂无存档数据', errorCode: 'empty_data', retryable: false };
      try {
        const report = await this.generate(target, { automatic: false });
        return { success: true, data: { date: target, report } };
      } catch (e) {
        return { success: false, message: `复盘生成失败：${e.message}`, errorCode: 'upstream_error', retryable: true };
      }
    }
    if (action === 'verify') {
      this.settle();
      const store = this._verifyStore();
      return { success: true, data: { records: store.records, scoreboard: scoreboardOf(store.records) } };
    }
    return { success: false, message: '未知 action（支持 board/generate/verify）', errorCode: 'invalid_input', retryable: false };
  }
}

function scoreboardOf(records) {
  const settled = records.filter((r) => r.verdict && !r.late);
  const full = settled.filter((r) => r.verdict.outcome === '全中').length;
  const partial = settled.filter((r) => r.verdict.outcome === '部分命中').length;
  const missed = settled.filter((r) => r.verdict.outcome === '未中').length;
  const pending = records.filter((r) => !r.verdict).length;
  return { settled: settled.length, full, partial, missed, pending };
}

module.exports = { MarketReview, collectAllowedNumbers, checkNumbersInText, percentileOf, nextTradingDay };
