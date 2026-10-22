'use strict';
// 价格提醒：规则 CRUD + 30 秒监控引擎（API-SPEC 第五章 §1）。
// 交易时段仅按星期+时段判定，靠行情 120 秒新鲜度挡节假日过期行情（与桌面版一致）。
const crypto = require('crypto');
const { shanghaiNow, todayStr, weekdayMon1 } = require('./calendar');

const KEY = 'fund_tracker_price_alerts';
const FIELDS = ['price', 'changePct', 'turnover', 'volumeRatio'];
const OPS = ['>=', '<=', '>', '<', 'crossAbove', 'crossBelow'];
const FIELD_LABEL = { price: '价格', changePct: '涨跌幅(%)', turnover: '成交额(元)', volumeRatio: '量比' };
const OP_LABEL = { crossAbove: '上穿', crossBelow: '下破' };

function validCode(code) { return typeof code === 'string' && /^\d{6}$/.test(code); }
function isUuid(s) { return typeof s === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s); }
function emptyDoc() { return { rules: [], history: [], lastCheckedAt: null, status: '' }; }

function validateRule(input) {
  if (!input || typeof input !== 'object') throw new Error('提醒规则格式无效');
  const rule = {
    id: typeof input.id === 'string' ? input.id : '',
    code: String(input.code || ''),
    name: String(input.name || '').slice(0, 60),
    enabled: input.enabled !== false,
    logic: input.logic === 'or' ? 'or' : 'and',
    conditions: [],
    cooldownMinutes: input.cooldownMinutes == null ? 30 : Number(input.cooldownMinutes),
    maxPerDay: input.maxPerDay == null ? 3 : Number(input.maxPerDay),
    once: !!input.once,
    edgeOnly: input.edgeOnly !== false,
    expiresAt: input.expiresAt ?? null,
    lastMatched: null, lastValues: [], lastTriggerAt: null, countDate: '', countToday: 0,
  };
  if (rule.id && !isUuid(rule.id)) throw new Error('提醒规则 ID 无效');
  if (!validCode(rule.code)) throw new Error('股票代码须为当前六位股票代码');
  if (input.logic != null && !['and', 'or'].includes(input.logic)) throw new Error('条件组合方式无效');
  if (!Array.isArray(input.conditions) || input.conditions.length < 1 || input.conditions.length > 6) throw new Error('提醒条件须为 1–6 条');
  for (const c of input.conditions) {
    if (!FIELDS.includes(c?.field)) throw new Error('提醒指标无效');
    if (!OPS.includes(c?.op)) throw new Error('提醒比较符无效');
    const value = Number(c?.value);
    if (!Number.isFinite(value)) throw new Error('提醒阈值无效');
    if (c.field !== 'changePct' && value <= 0) throw new Error('提醒阈值必须大于 0');
    rule.conditions.push({ field: c.field, op: c.op, value });
  }
  if (!Number.isInteger(rule.cooldownMinutes) || rule.cooldownMinutes < 0 || rule.cooldownMinutes > 1440) throw new Error('冷却时间须为 0–1440 分钟');
  if (!Number.isInteger(rule.maxPerDay) || rule.maxPerDay < 1 || rule.maxPerDay > 100) throw new Error('每日上限须为 1–100 次');
  if (rule.expiresAt != null) {
    if (typeof rule.expiresAt !== 'string' || Number.isNaN(Date.parse(rule.expiresAt))) throw new Error('到期时间必须包含时区');
  }
  return rule;
}
function ruleActive(rule, nowMs) {
  if (!rule.enabled) return false;
  if (rule.expiresAt) {
    const exp = Date.parse(rule.expiresAt);
    if (!Number.isNaN(exp) && nowMs >= exp) return false;
  }
  return true;
}
function tradingWindow() {
  const now = shanghaiNow();
  if (weekdayMon1(now.date) > 5) return false;
  return (now.minutes >= 570 && now.minutes <= 690) || (now.minutes >= 780 && now.minutes <= 900);
}
function metricOf(quote, field) {
  const raw = field === 'price' ? quote.priceValue : field === 'changePct' ? quote.changePercent : quote[field];
  const v = typeof raw === 'number' ? raw : null;
  return v != null && Number.isFinite(v) ? v : null;
}
function matched(value, previous, op, threshold) {
  switch (op) {
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '>': return value > threshold;
    case '<': return value < threshold;
    case 'crossAbove': return previous != null && previous < threshold && value >= threshold;
    case 'crossBelow': return previous != null && previous > threshold && value <= threshold;
    default: return false;
  }
}
function freshQuote(quote, nowMs) {
  const raw = String(quote?.quoteTimeRaw || '');
  if (!/^\d{14}$/.test(raw)) return false;
  const ts = Date.UTC(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8), +raw.slice(8, 10), +raw.slice(10, 12), +raw.slice(12, 14)) - 8 * 3600 * 1000;
  const age = (nowMs - ts) / 1000;
  return age >= 0 && age <= 120 && Number(quote.priceValue) > 0;
}

class PriceAlerts {
  constructor({ store, getQuotes, emit }) {
    this.store = store;
    this.getQuotes = getQuotes; // async (codes[]) => data map | null
    this.emit = emit || (() => {});
    this.timer = null;
  }
  doc() {
    const v = this.store.dataValue(KEY);
    if (v == null) return emptyDoc();
    if (typeof v !== 'object' || !Array.isArray(v.rules) || !Array.isArray(v.history)) throw new Error('提醒数据格式无效，原数据已保留');
    return { rules: v.rules, history: v.history, lastCheckedAt: v.lastCheckedAt ?? null, status: v.status || '' };
  }
  _save(doc) { this.store.updateData(KEY, () => doc); }
  _listView(doc) {
    const nowMs = Date.now();
    const hasActive = doc.rules.some((r) => { try { validateRule(r); return ruleActive(r, nowMs); } catch { return false; } });
    const view = JSON.parse(JSON.stringify(doc));
    if (!hasActive) view.status = 'idle';
    else if (!tradingWindow()) view.status = 'waiting';
    else view.status = doc.status || 'monitoring';
    return view;
  }
  handle(query) {
    const op = String(query.op || 'list');
    try {
      if (op === 'list') {
        return { success: true, data: this._listView(this.doc()), meta: { stale: false, degraded: false } };
      }
      const doc = this.doc();
      if (op === 'save') {
        const raw = String(query.rule || '');
        if (raw.length >= 8000) return { success: false, message: '提醒规则过大', errorCode: 'invalid_input', retryable: false };
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return { success: false, message: '提醒规则格式无效', errorCode: 'invalid_input', retryable: false }; }
        const rule = validateRule(parsed);
        const idx = rule.id ? doc.rules.findIndex((r) => r.id === rule.id) : -1;
        if (idx >= 0) {
          const old = doc.rules[idx];
          rule.lastTriggerAt = old.lastTriggerAt ?? null;
          rule.countDate = old.countDate || '';
          rule.countToday = old.countToday || 0;
          doc.rules[idx] = rule;
        } else {
          if (doc.rules.length >= 100) return { success: false, message: '最多保存 100 条提醒规则', errorCode: 'invalid_input', retryable: false };
          if (!rule.id) rule.id = crypto.randomUUID();
          doc.rules.push(rule);
        }
        this._save(doc);
        return { success: true, data: this._listView(doc), meta: { stale: false, degraded: false } };
      }
      if (op === 'toggle' || op === 'delete') {
        const id = String(query.id || '');
        const idx = doc.rules.findIndex((r) => r.id === id);
        if (idx < 0) return { success: false, message: '提醒规则不存在', errorCode: 'invalid_input', retryable: false };
        if (op === 'delete') doc.rules.splice(idx, 1);
        else { doc.rules[idx].enabled = !doc.rules[idx].enabled; doc.rules[idx].lastMatched = null; doc.rules[idx].lastValues = []; }
        this._save(doc);
        return { success: true, data: this._listView(doc), meta: { stale: false, degraded: false } };
      }
      return { success: false, message: '未知提醒操作', errorCode: 'invalid_input', retryable: false };
    } catch (e) {
      return { success: false, message: e.message || '提醒操作失败', errorCode: 'invalid_input', retryable: false };
    }
  }
  start() {
    if (this.timer) return;
    const tick = async () => {
      try { await this._tick(); } catch { /* 下一轮重试 */ }
    };
    this.timer = setInterval(tick, 30000);
    this.timer.unref?.();
  }
  async _tick() {
    let doc;
    try { doc = this.doc(); } catch { return; }
    const nowMs = Date.now();
    const candidates = [];
    for (const rule of doc.rules) {
      try { validateRule(rule); if (ruleActive(rule, nowMs)) candidates.push(rule.code); } catch { /* 跳过坏规则 */ }
    }
    if (!candidates.length || !tradingWindow()) return;
    const codes = [...new Set(candidates)];
    let quotes = null;
    try { quotes = await this.getQuotes(codes); } catch { quotes = null; }
    const now = new Date();
    const today = todayStr();
    const hits = [];
    let dataUnavailable = false;
    let touched = false;
    for (const rule of doc.rules) {
      let valid = true;
      try { validateRule(rule); } catch { valid = false; }
      if (!valid || !ruleActive(rule, nowMs)) continue;
      const quote = quotes?.[rule.code];
      if (!quotes || !quote || !freshQuote(quote, nowMs)) { dataUnavailable = true; continue; }
      const values = rule.conditions.map((c) => metricOf(quote, c.field));
      if (values.some((v) => v == null)) { dataUnavailable = true; continue; }
      const prevMatched = rule.lastMatched === true;
      const checks = rule.conditions.map((c, i) => matched(values[i], Array.isArray(rule.lastValues) ? rule.lastValues[i] ?? null : null, c.op, c.value));
      const hit = rule.logic === 'or' ? checks.some(Boolean) : checks.every(Boolean);
      rule.lastMatched = hit;
      rule.lastValues = values;
      touched = true;
      if (rule.countDate !== today) { rule.countDate = today; rule.countToday = 0; }
      if (!hit) continue;
      if (rule.edgeOnly && prevMatched) continue;
      if (rule.lastTriggerAt && nowMs - Date.parse(rule.lastTriggerAt) < rule.cooldownMinutes * 60 * 1000) continue;
      if (rule.countToday >= rule.maxPerDay) continue;
      rule.lastTriggerAt = now.toISOString();
      rule.countToday += 1;
      if (rule.once) rule.enabled = false;
      const detail = rule.conditions
        .map((c, i) => (checks[i] ? `${FIELD_LABEL[c.field] || c.field} ${OP_LABEL[c.op] || c.op} ${c.value}` : null))
        .filter(Boolean).join('；');
      hits.push({
        id: crypto.randomUUID(), ruleId: rule.id, ruleName: rule.name, code: rule.code,
        name: quote.name, time: now.toISOString(), price: quote.priceValue,
        changePct: quote.changePercent, quoteTime: quote.quoteTimeRaw, detail,
      });
    }
    doc.lastCheckedAt = now.toISOString();
    doc.status = dataUnavailable ? 'data_unavailable' : 'monitoring';
    for (const h of hits) { doc.history.unshift(h); }
    doc.history = doc.history.slice(0, 100);
    try {
      this._save(doc);
    } catch {
      if (hits.length) this.emit('price-alert-error', { message: '提醒状态无法保存，未发送告警' });
      return;
    }
    for (const h of hits) this.emit('price-alert-hit', h);
    void touched;
  }
}
module.exports = { PriceAlerts };
