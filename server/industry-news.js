'use strict';
// 产业链资讯（融合计划第 1 期）：移植 investment-news（MIT）的 106 源 / 12 赛道源库，
// 服务端抓 RSS/Atom → 合规过滤 → 落盘；每日开盘前用本站已配置的 AI 生成各赛道
// 「今日要点」+ 英文标题翻译，要点链接经程序核对（必须来自抓到的原文，防编造溯源）。
// 前端经 /industry-news 读取看板数据。源库可达性按 2026-10-30 广州服务器实测标注。
const fs = require('fs');
const path = require('path');
const { shanghaiNow, todayStr, isTradingDay } = require('./calendar');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'industry-sources.json'), 'utf8'));
const INDUSTRIES = CONFIG.industries || [];
const SOURCES = (CONFIG.sources || []).filter((s) => s && s.url && s.hint);
const REDLINE = (CONFIG.redline_keywords || []).map((s) => String(s).toLowerCase());
const PER_SOURCE = Number(CONFIG.fetch?.per_source) || 6;
const RECENT_DAYS = Number(CONFIG.fetch?.recent_days) || 7;
const DIGEST_AT_MINUTES = 8 * 60 + 20; // 交易日 08:20 自动抓取+提炼

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
}
// 先剥真实标签、再解实体：&lt;news&gt; 这类被转义的文字要在剥标签之后才解码，否则会被误当标签删掉。
function stripTags(s) {
  const noCdata = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(noCdata.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function atomLink(block) {
  const links = [...block.matchAll(/<link[^>]*>/gi)].map((m) => m[0]);
  let fallback = '';
  for (const tag of links) {
    const href = tag.match(/href="([^"]+)"/i)?.[1];
    if (!href) continue;
    if (!fallback) fallback = href;
    if (/rel="alternate"/i.test(tag) || !/rel=/i.test(tag)) return decodeEntities(href);
  }
  return decodeEntities(fallback);
}
// 解析 RSS <item> / Atom <entry>，返回 [{title, link, ts, summary}]
function parseFeed(xml) {
  const text = String(xml || '');
  const blocks = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  const entryRe = /<entry[\s>][\s\S]*?<\/entry>/gi;
  let m;
  while ((m = itemRe.exec(text)) !== null) blocks.push({ block: m[0], atom: false });
  if (blocks.length === 0) while ((m = entryRe.exec(text)) !== null) blocks.push({ block: m[0], atom: true });
  const items = [];
  for (const { block, atom } of blocks) {
    const title = stripTags(tagText(block, 'title'));
    const link = atom ? atomLink(block) : decodeEntities(tagText(block, 'link')).trim();
    if (!title || !/^https?:\/\//.test(link)) continue;
    const rawDate = tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'dc:date');
    const parsed = rawDate ? Date.parse(rawDate) : NaN;
    const summary = stripTags(tagText(block, 'description') || tagText(block, 'summary')).slice(0, 300);
    items.push({ title, link, ts: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(), summary });
  }
  return items;
}
function isRedlined(title) {
  const t = String(title || '').toLowerCase();
  return REDLINE.some((kw) => kw && t.includes(kw));
}

const DIGEST_PROMPT = '你是产业链资讯编辑。仅基于输入的新闻标题清单（按赛道分组，含来源名与链接），为每个赛道提炼 3-5 条中文「今日要点」：跨源聚合去重、突出核心公司与关键数据、一条要点讲一件事、不编造清单里没有的事实。再把 translateLinks 里列出的英文标题翻译为中文（已是中文的原样返回），不要翻译清单之外的链接。只返回 JSON，结构严格为：{"sectors":{"赛道key":{"points":[{"text":"要点中文（<=80字）","links":["原文链接"]}]}},"translations":{"原文链接":"中文标题"}}。points 的 links 只能填输入清单里出现过的链接，且必须属于该赛道；没有足够新闻的赛道 points 给空数组。';

class IndustryNews {
  constructor({ dataDir, ai }) {
    this.dir = path.join(dataDir, 'industry-news');
    this.ai = ai || null;
    this.fetching = false;
    this.digesting = false;
    this.timer = null;
    this.itemsCache = null;
    this.digestCache = null;
  }

  _file(name) { return path.join(this.dir, name); }

  _readJson(name) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file(name), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  }

  _writeJson(name, obj) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this._file(name);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  items() {
    if (!this.itemsCache) this.itemsCache = this._readJson('items.json');
    return this.itemsCache;
  }

  digest() {
    if (!this.digestCache) this.digestCache = this._readJson('digest.json');
    return this.digestCache;
  }

  /* ------------------------------------------------------------------ 抓取 */

  async _fetchSource(source) {
    const res = await fetch(source.url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseFeed(xml);
  }

  async refreshItems() {
    if (this.fetching) throw new Error('抓取进行中');
    this.fetching = true;
    try {
      const enabled = SOURCES.filter((s) => s.enabled !== false);
      const cutoff = Date.now() - RECENT_DAYS * 24 * 3600 * 1000;
      const status = [];
      const collected = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < enabled.length) {
          const source = enabled[cursor++];
          try {
            const raw = await this._fetchSource(source);
            const fresh = raw
              .filter((it) => (it.ts ? Date.parse(it.ts) >= cutoff : true))
              .filter((it) => !isRedlined(it.title))
              .slice(0, PER_SOURCE);
            for (const it of fresh) collected.push({ sector: source.hint, source: source.name, ...it });
            status.push({ name: source.name, sector: source.hint, ok: true, count: fresh.length });
          } catch (e) {
            status.push({ name: source.name, sector: source.hint, ok: false, error: String(e.message || e).slice(0, 80) });
          }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      const seen = new Set();
      const items = [];
      for (const it of collected) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        items.push(it);
      }
      items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
      const record = { fetchedAt: new Date().toISOString(), items, sourceStatus: status };
      this._writeJson('items.json', record);
      this.itemsCache = record;
      const failed = status.filter((s) => !s.ok);
      return { count: items.length, sourcesOk: status.length - failed.length, sourcesFailed: failed.length, failed: failed.map((f) => f.name) };
    } finally { this.fetching = false; }
  }

  /* ------------------------------------------------------------------ 提炼 */

  // 用 items 生成 digest；aiCaller 由外部注入以便测试：async (prompt, facts) => rawText
  async buildDigest(aiCaller) {
    const data = this.items();
    if (!data || !Array.isArray(data.items) || data.items.length === 0) throw new Error('暂无资讯数据，先抓取');
    const bySector = new Map();
    for (const it of data.items) {
      if (!bySector.has(it.sector)) bySector.set(it.sector, []);
      const list = bySector.get(it.sector);
      if (list.length < 18) list.push({ title: it.title, source: it.source, link: it.link });
    }
    // 翻译只覆盖看板实际展示的前 12 条/赛道，控制单次调用的输出规模。
    const translateLinks = {};
    for (const [key, list] of bySector) translateLinks[key] = list.slice(0, 12).map((i) => i.link);
    const facts = { sectors: Object.fromEntries(bySector), translateLinks };
    const raw = await aiCaller(DIGEST_PROMPT, facts);
    let obj;
    let text = String(raw || '').trim();
    if (text.startsWith('```')) text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    try { obj = JSON.parse(text); } catch { throw new Error('模型未返回有效 JSON'); }
    // 核对：要点链接必须在对应赛道的输入链接集合内，否则整条丢弃；翻译同理。
    const digest = { generatedAt: new Date().toISOString(), sectors: {}, translations: {} };
    const sectorLinks = new Map([...bySector].map(([k, list]) => [k, new Set(list.map((i) => i.link))]));
    const allLinks = new Set(data.items.map((i) => i.link));
    for (const ind of INDUSTRIES) {
      const sec = obj?.sectors?.[ind.key];
      const points = [];
      if (sec && Array.isArray(sec.points)) {
        for (const p of sec.points.slice(0, 5)) {
          const t = typeof p?.text === 'string' ? p.text.trim() : '';
          const links = Array.isArray(p?.links) ? p.links.filter((l) => sectorLinks.get(ind.key)?.has(l)) : [];
          if (t && t.length <= 200 && links.length > 0) points.push({ text: t, links: [...new Set(links)] });
        }
      }
      digest.sectors[ind.key] = { points };
    }
    if (obj?.translations && typeof obj.translations === 'object') {
      for (const [link, zh] of Object.entries(obj.translations)) {
        if (allLinks.has(link) && typeof zh === 'string' && zh.trim() && zh.length <= 120) {
          digest.translations[link] = zh.trim();
        }
      }
    }
    this._writeJson('digest.json', digest);
    this.digestCache = digest;
    return digest;
  }

  async generateDigest({ automatic = false } = {}) {
    if (!this.ai) throw new Error('AI 服务未接入');
    if (this.digesting) throw new Error('提炼进行中');
    this.digesting = true;
    let release = null;
    try {
      release = automatic ? this.ai.tryAutomatic() : await this.ai.acquireManual();
      if (!release) return null; // 自动模式下模型忙：跳过，下轮再试
      const caller = async (prompt, facts) => {
        const { raw, model } = await this.ai.modelRequest(prompt, facts, 10000);
        this._lastModel = model;
        return raw;
      };
      const digest = await this.buildDigest(caller);
      digest.model = this._lastModel || null;
      this._writeJson('digest.json', digest);
      this.digestCache = digest;
      return digest;
    } finally {
      if (release) release();
      this.digesting = false;
    }
  }

  /* ------------------------------------------------------------------ 调度 */

  async _autoRun() {
    try { await this.refreshItems(); } catch (e) { console.warn('[industry-news] 自动抓取失败：', e.message); }
    try {
      const digest = await this.generateDigest({ automatic: true });
      if (digest) console.log(`[industry-news] 今日要点已生成 ${digest.generatedAt}`);
    } catch (e) {
      console.warn('[industry-news] 自动提炼跳过：', e.message);
    }
  }

  async _tick() {
    const today = todayStr();
    if (isTradingDay(today) !== true) return;
    const now = shanghaiNow();
    if (now.minutes < DIGEST_AT_MINUTES) return;
    const digest = this.digest();
    if (digest && String(digest.generatedAt || '').slice(0, 10) === today) return;
    if (this.fetching || this.digesting) return;
    await this._autoRun();
  }

  start() {
    // 启动后：落盘资讯超过 6 小时则补抓一次（只抓取，不提炼，省 AI 额度）。
    const boot = setTimeout(() => {
      const data = this.items();
      const stale = !data || Date.now() - Date.parse(data.fetchedAt || 0) > 6 * 3600 * 1000;
      if (stale && !this.fetching) this.refreshItems().catch((e) => console.warn('[industry-news] 启动补抓失败：', e.message));
    }, 60000);
    boot.unref?.();
    this.timer = setInterval(() => { this._tick().catch(() => {}); }, 5 * 60 * 1000);
    this.timer.unref?.();
  }

  /* ------------------------------------------------------------- /industry-news */

  board() {
    const data = this.items();
    const digest = this.digest();
    const items = data?.items || [];
    const bySector = new Map();
    for (const it of items) {
      if (!bySector.has(it.sector)) bySector.set(it.sector, []);
      bySector.get(it.sector).push(it);
    }
    const translations = digest?.translations || {};
    return {
      fetchedAt: data?.fetchedAt || null,
      digestAt: digest?.generatedAt || null,
      digestModel: digest?.model || null,
      sectors: INDUSTRIES.map((ind) => ({
        key: ind.key,
        name: ind.name,
        accent: ind.accent,
        points: digest?.sectors?.[ind.key]?.points || [],
        items: (bySector.get(ind.key) || []).slice(0, 12).map((it) => ({
          title: it.title,
          titleZh: translations[it.link] || null,
          source: it.source,
          link: it.link,
          ts: it.ts,
          summary: it.summary,
        })),
      })),
      sourceStatus: data?.sourceStatus || [],
    };
  }

  async handle(query) {
    const action = String((query && query.action) || 'board');
    if (action === 'board') return { success: true, data: this.board() };
    if (action === 'refresh') {
      try {
        const r = await this.refreshItems();
        return { success: true, data: r };
      } catch (e) {
        return { success: false, message: `抓取失败：${e.message}`, errorCode: 'upstream_error', retryable: true };
      }
    }
    if (action === 'digest') {
      try {
        const digest = await this.generateDigest({ automatic: false });
        return { success: true, data: { generatedAt: digest?.generatedAt || null } };
      } catch (e) {
        return { success: false, message: `提炼失败：${e.message}`, errorCode: 'upstream_error', retryable: true };
      }
    }
    return { success: false, message: '未知 action（支持 board/refresh/digest）', errorCode: 'invalid_input', retryable: false };
  }
}

module.exports = { IndustryNews, parseFeed, isRedlined, INDUSTRIES };
