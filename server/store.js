'use strict';
// 配置存储：复刻桌面版 config.rs 语义（config.json v2）。
// 落盘 {version:2, storageEncoding:'utf8-json', updatedAt, data:{}, private:{}}
// data 白名单 21 键；JSON 型键落盘为解析后的 JSON 值，快照中回成 JSON 文本字符串。
const fs = require('fs');
const path = require('path');

const KEYS = [
  'fund_tracker_settings', 'fund_tracker_active_main_tab', 'fund_tracker_news_source',
  'fund_tracker_collapse_state', 'fund_tracker_sector_tab', 'fund_tracker_alert_settings',
  'fund_tracker_watch_alert_state', 'fund_tracker_custom_indices', 'fund_tracker_watchlist_cost',
  'fund_tracker_watchlist_remarks', 'fund_tracker_watchlist', 'fund_tracker_watchlist_tabs',
  'fund_tracker_active_watch_tab', 'fund_tracker_hot_rank_source', 'fund_tracker_limit_up_tab',
  'fund_tracker_ai_settings', 'fund_tracker_price_alerts',
  'fund_tracker_research_history', 'fund_tracker_report_center',
];
const JSON_KEYS = new Set([
  'fund_tracker_settings', 'fund_tracker_collapse_state', 'fund_tracker_alert_settings',
  'fund_tracker_watch_alert_state', 'fund_tracker_custom_indices', 'fund_tracker_watchlist_cost',
  'fund_tracker_watchlist_remarks', 'fund_tracker_watchlist', 'fund_tracker_watchlist_tabs',
  'fund_tracker_ai_settings', 'fund_tracker_price_alerts', 'fund_tracker_research_history',
  'fund_tracker_report_center',
]);
const NATIVE_OWNED = new Set(['fund_tracker_report_center']);
const CORRUPT_MSG = '配置文件损坏，未覆盖原文件；请修复配置文件后重试';

function emptyDoc() {
  return { version: 2, storageEncoding: 'utf8-json', updatedAt: null, data: {}, private: {} };
}
function normalize(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return doc;
  const data = (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) ? raw.data
    : (raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values)) ? raw.values : {};
  doc.data = data;
  doc.private = (raw.private && typeof raw.private === 'object' && !Array.isArray(raw.private)) ? raw.private : {};
  doc.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  return doc;
}

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.doc = emptyDoc();
    this.loadError = null;
    this._load();
  }
  _load() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return; // 首启，正常
      this.loadError = `配置读取失败：${e.message}`;
      return;
    }
    try {
      const raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('根节点不是对象');
      this.doc = normalize(raw);
    } catch (e) {
      this.loadError = `配置文件损坏：${e.message}`;
      this.doc = emptyDoc();
    }
  }
  _persist(doc) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
  _snapshot(doc) {
    const data = {};
    for (const key of Object.keys(doc.data)) {
      if (!KEYS.includes(key)) continue; // 白名单外键落盘保留、快照隐藏
      const v = doc.data[key];
      if (JSON_KEYS.has(key)) data[key] = typeof v === 'string' ? v : JSON.stringify(v);
      else data[key] = v;
    }
    const snap = { version: 2, storageEncoding: doc.storageEncoding || 'utf8-json', updatedAt: doc.updatedAt ?? null, data };
    if (this.loadError) snap.configError = { message: this.loadError };
    return snap;
  }
  load() { return this._snapshot(this.doc); }
  // patch(changes)：changes 键=数据键名；值：JSON 型传 JSON 文本字符串、字符串型传字符串、null=删除
  patch(changes) {
    if (this.loadError) throw new Error(CORRUPT_MSG);
    const candidate = JSON.parse(JSON.stringify(this.doc));
    for (const [key, raw] of Object.entries(changes || {})) {
      if (!KEYS.includes(key)) continue;
      if (NATIVE_OWNED.has(key)) continue;
      if (raw === null || raw === undefined) { delete candidate.data[key]; continue; }
      if (JSON_KEYS.has(key)) {
        if (typeof raw === 'string') {
          try { candidate.data[key] = JSON.parse(raw); } catch { candidate.data[key] = raw; }
        } else candidate.data[key] = raw;
      } else {
        candidate.data[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
      }
    }
    candidate.version = 2;
    candidate.storageEncoding = 'utf8-json';
    candidate.updatedAt = new Date().toISOString();
    this._persist(candidate);
    this.doc = candidate;
    return this._snapshot(this.doc);
  }
  // 原生侧单键事务（仅 JSON 型键）：update(oldValue) -> newValue
  updateData(key, update) {
    if (this.loadError) throw new Error(CORRUPT_MSG);
    if (!JSON_KEYS.has(key)) throw new Error('配置不可写，未覆盖原文件');
    const candidate = JSON.parse(JSON.stringify(this.doc));
    const old = candidate.data[key] === undefined ? null : candidate.data[key];
    const next = update(old);
    candidate.data[key] = next;
    candidate.updatedAt = new Date().toISOString();
    this._persist(candidate);
    this.doc = candidate;
    return next;
  }
  // 读落盘形态（原生语义）：JSON 型键返回解析后的值
  dataValue(key) {
    const v = this.doc.data[key];
    if (v === undefined) return null;
    if (JSON_KEYS.has(key) && typeof v === 'string') {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }
}
module.exports = { ConfigStore, KEYS, JSON_KEYS, NATIVE_OWNED };
