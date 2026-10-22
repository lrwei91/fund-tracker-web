// ================================================================
// localStorage 缓存 helpers
// 暴露到 window.AppCache;直接 script 引入,无需 import/require
// 包含:readJson / writeJson / readTimedCache / writeTimedCache /
//      readDailyDataCache / writeDailyDataCache
// 内部:cleanupLegacyCaches() 首次缓存读时自动执行一次
// ================================================================

(function () {
    // v1 旧 cache key, 升级后已无 read 路径, 这里集中清理
    // 注意: cleanupLegacyCaches() 由 readJson / readDailyDataCache 懒调用一次
    //       (modules 之间约定, 不依赖 app.js 在 init 时显式触发)
    var LEGACY_CACHE_KEYS = [
        'fund_tracker_multiday_flow_cache',  // 旧多日资金流缓存,已无 read 路径
        'fund_tracker_fund_flow_cache',      // 旧个股资金流缓存,已无 read 路径
        // 注: 'fund_tracker_prev_pct' 不要放这里 — 它是自选股个股 prev 涨跌的存储
        //      (watch-state.js 的 getPrevChangePct / watch-render.js 的 persistCurrentChangePct 还在用,
        //       见 modules/state.js PREV_KEY);大盘/自选指数的 prev 早就独立到 'fund_tracker_index_prev_pct'
    ];
    var _legacyCleaned = false;
    function cleanupLegacyCaches() {
        if (_legacyCleaned) return;
        _legacyCleaned = true;
        LEGACY_CACHE_KEYS.forEach(function (key) {
            try { window.AppStorage.removeItem(key); } catch (e) {}
        });
    }

    function readJson(key, fallback) {
        cleanupLegacyCaches();
        try {
            var raw = window.AppStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try { window.AppStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }

    // 带 TTL 的缓存: 读时如果超过 ttlMs 返回 null
    // 被 loadIndexData / loadCapitalData / loadSectorData 使用
    function readTimedCache(key, ttlMs) {
        var cached = readJson(key, null);
        if (!cached || !cached.data || !cached.updatedAt) return null;
        if (Date.now() - cached.updatedAt > ttlMs) return null;
        return cached.data;
    }

    function writeTimedCache(key, data) {
        writeJson(key, { data: data, updatedAt: Date.now() });
    }

    // 日级持久缓存: 同一日期内复用,跨日失效
    // 返回 { date, data, updatedAt } 或 null
    function readDailyDataCache(key) {
        cleanupLegacyCaches();
        try {
            return JSON.parse(window.AppStorage.getItem(key) || 'null');
        } catch (e) {
            return null;
        }
    }

    function writeDailyDataCache(key, date, data) {
        try {
            window.AppStorage.setItem(key, JSON.stringify({
                date: date,
                data: data,
                updatedAt: new Date().toISOString(),
            }));
        } catch (e) {
            // Ignore storage failures; the live data has already rendered.
        }
    }

    window.AppCache = {
        readJson: readJson,
        writeJson: writeJson,
        readTimedCache: readTimedCache,
        writeTimedCache: writeTimedCache,
        readDailyDataCache: readDailyDataCache,
        writeDailyDataCache: writeDailyDataCache,
    };
})();
