// ================================================================
// 全局 state + localStorage 缓存键 + 启动时 IIFE 还原
// 暴露到 window.AppState,所有 render-* 模块通过 window.AppState 访问
// 设计:state 对象在启动时由各 restore* IIFE 填充,modules 后续只读写
// ================================================================

(function () {
    var storage = window.AppStorage || {
        getItem: function (key) { return window.localStorage ? window.localStorage.getItem(key) : null; },
        setItem: function (key, value) { if (window.localStorage) window.localStorage.setItem(key, value); },
        removeItem: function (key) { if (window.localStorage) window.localStorage.removeItem(key); },
    };
    // ---------- 通用 keys ----------
    var SETTINGS_KEY = 'fund_tracker_settings';
    var ACTIVE_TAB_KEY = 'fund_tracker_active_main_tab';
    var NEWS_SOURCE_KEY = 'fund_tracker_news_source';
    var COLLAPSE_STATE_KEY = 'fund_tracker_collapse_state';
    var SECTOR_TAB_KEY = 'fund_tracker_sector_tab';

    // ---------- 短期缓存键(由 AppCache.readTimedCache/writeTimedCache 使用) ----------
    // SHORT_CACHE_KEYS 全字段保留;SHORT_CACHE_TTL 只保留 index/capital/sector 三档,
    // news 和 limitUpSummary 字段原代码已无 readTimedCache 调用方,不再维护 TTL
    var SHORT_CACHE_KEYS = {
        index: 'fund_tracker_index_cache',
        capital: 'fund_tracker_capital_cache',
        sector: 'fund_tracker_sector_cache',
        newsJin10: 'fund_tracker_news_jin10_cache',
        newsEastmoney: 'fund_tracker_news_eastmoney_cache',
        limitUpZt: 'fund_tracker_limit_up_zt_cache',
        limitUpZb: 'fund_tracker_limit_up_zb_cache',
        limitUpDt: 'fund_tracker_limit_up_dt_cache',
        limitUpYzt: 'fund_tracker_limit_up_yzt_cache',
        limitUpSummary: 'fund_tracker_limit_up_summary_cache',
    };
    var SHORT_CACHE_TTL = {
        index: 30 * 1000,
        capital: 5 * 60 * 1000,
        sector: 5 * 60 * 1000,
    };

    // ---------- 资金流 / 自选股 / 告警 / 自选指数 ----------
    var WATCH_QUOTE_CACHE_KEY = 'fund_tracker_watch_quote_cache';
    var WATCH_QUOTE_UPDATE_TIME_KEY = 'fund_tracker_watch_quote_update_time';
    var WATCH_QUOTE_STATUS_KEY = 'fund_tracker_watch_quote_status';
    var ALERT_SETTINGS_KEY = 'fund_tracker_alert_settings';
    var WATCH_ALERT_STATE_KEY = 'fund_tracker_watch_alert_state';
    var CUSTOM_INDICES_KEY = 'fund_tracker_custom_indices';
    var CUSTOM_INDEX_QUOTE_CACHE_KEY = 'fund_tracker_custom_index_quote_cache';
    var CUSTOM_INDEX_UPDATE_TIME_KEY = 'fund_tracker_custom_index_update_time';
    var CUSTOM_INDEX_MAX = 4;
    var WATCHLIST_COST_KEY = 'fund_tracker_watchlist_cost';
    var WATCHLIST_REMARKS_KEY = 'fund_tracker_watchlist_remarks';

    // 大盘/自选指数:每 30 分钟刷新一次的 prev 快照,用来画 trend-arrow
    // 结构: { market: { _updatedAt, data: { id: priceValue } }, custom: 同上 }
    var INDEX_PREV_KEY = 'fund_tracker_index_prev_pct';
    var INDEX_REFRESH_SECONDS = 300;

    // ---------- 自选股多分组 ----------
    var STORAGE_KEY = 'fund_tracker_watchlist';
    var WATCH_TABS_KEY = 'fund_tracker_watchlist_tabs';
    var ACTIVE_WATCH_TAB_KEY = 'fund_tracker_active_watch_tab';
    var PREV_KEY = 'fund_tracker_prev_pct';
    var FIXED_WATCH_TAB_IDS = ['default', 'candidate'];
    var FIXED_WATCH_TAB_NAMES = { default: '持仓股', candidate: '候选股' };

    // ---------- 市场热度 ----------
    var HOT_RANK_SOURCE_KEY = 'fund_tracker_hot_rank_source';
    var HOT_RANK_CACHE_THS_KEY = 'fund_tracker_hot_rank_ths_cache';
    var HOT_RANK_CACHE_EM_KEY = 'fund_tracker_hot_rank_em_cache';
    var HOT_RANK_TAB_HEADERS = { ths: '同花顺热榜', em: '东财人气榜' };

    // ---------- 打板情绪 (涨停 / 炸板 / 跌停 / 昨涨停) ----------
    var LIMIT_UP_TYPES = ['zt', 'zb', 'dt', 'yzt'];
    var LIMIT_UP_TAB_LABELS = { zt: '涨停', zb: '炸板', dt: '跌停', yzt: '昨涨停' };
    var LIMIT_UP_TAB_KEY = 'fund_tracker_limit_up_tab';

    // ---------- 告警 toast ----------
    var ALERT_TOAST_MAX = 5;
    var ALERT_TOAST_TTL_MS = 20000;
    var STATUS_TOAST_TTL_MS = 2500;

    // ---------- 主 tab 路由 ----------
    var VALID_TABS = ['dashboard', 'market', 'research', 'alerts', 'news'];
    var TAB_TITLES = { dashboard: '我的盯盘', market: '市场总览', research: '研究工作台', alerts: '提醒中心', news: '财经资讯' };

    // ---------- 新闻翻页 ----------
    var NEWS_PAGE_SIZE = { jin10: 20, eastmoney: 30, cls: 20 };

    // ---------- 自选股节流 ----------
    var WATCH_REFRESH_THROTTLE_KEY = 'fund_tracker_watch_refresh_throttle';
    var WATCH_REFRESH_THROTTLE_MS = 5 * 60 * 1000;

    // ---------- Schema 版本:watch alert state 含义变更时 bump ----------
    var WATCH_ALERT_SCHEMA_VERSION = 2;

    // ============ State (运行时变量) ============

    // 自动刷新 interval 句柄
    var isAutoRefresh = true;
    var refreshSecondsMain = 5;
    var refreshSecondsSignal = 1800;
    var refreshSecondsNews = 60;

    // 应用外观设置
    var colorMode = 'light';

    // 主 tab
    var currentTab = 'dashboard';

    // 自选股 active tab
    var activeWatchTabId = 'default';

    // 实时数据缓存
    var liveIndexData = null;
    var liveCapitalData = null;
    var liveMarketBreadthData = null;
    var liveSectorPanoramaData = null;
    var liveSectorData = null;

    // 自选股 / 自选指数 (从 localStorage 还原)
    var watchQuoteCache = {};
    var watchQuoteUpdateTime = '';
    var watchQuoteFreshCodes = {};
    var watchMarketWarnings = {};
    var customIndexCodes = [];
    var customIndexCache = {};
    var customIndexFreshCodes = {};
    var customIndexUpdateTime = '';
    var watchlistCost = {};
    var watchlistRemarks = {};

    // 涨跌幅告警
    var alertEnabled = true;
    var alertThreshold = 2;
    var alertOpacity = 0.92;
    var watchAlertState = {};

    // 新闻源 / 列表 state
    var currentNewsSource = 'jin10';
    var newsState = {
        jin10: { items: [], cursor: null, hasMore: true, isLoading: false, error: false, actualSource: 'jin10', degraded: false, stale: false, staleAgeSeconds: 0 },
        eastmoney: { items: [], cursor: null, hasMore: true, isLoading: false, error: false, actualSource: 'eastmoney', degraded: false, stale: false, staleAgeSeconds: 0 },
        cls: { items: [], cursor: null, hasMore: true, isLoading: false, error: false, actualSource: 'cls', degraded: false, stale: false, staleAgeSeconds: 0 },
    };

    // ============ 启动时 IIFE 还原 ============

    // 自选股行情(避免非交易时段刷新后变成"待刷新")
    try {
        var rawCache = storage.getItem(WATCH_QUOTE_CACHE_KEY);
        if (rawCache) watchQuoteCache = JSON.parse(rawCache) || {};
    } catch (e) { watchQuoteCache = {}; }
    try { storage.setItem(WATCH_QUOTE_STATUS_KEY, 'stale'); } catch (e) {}
    try {
        var rawTime = storage.getItem(WATCH_QUOTE_UPDATE_TIME_KEY);
        if (rawTime) watchQuoteUpdateTime = rawTime;
    } catch (e) { /* ignore */ }

    // 自选指数(板块/ETF)
    try {
        var rawCodes = storage.getItem(CUSTOM_INDICES_KEY);
        if (rawCodes) {
            var parsed = JSON.parse(rawCodes);
            if (Array.isArray(parsed)) {
                customIndexCodes = parsed.filter(function (c) { return /^\d{6}$/.test(c); }).slice(0, CUSTOM_INDEX_MAX);
            }
        }
    } catch (e) { /* ignore */ }
    try {
        var rawCustCache = storage.getItem(CUSTOM_INDEX_QUOTE_CACHE_KEY);
        if (rawCustCache) customIndexCache = JSON.parse(rawCustCache) || {};
    } catch (e) { /* ignore */ }
    try {
        var rawCustTime = storage.getItem(CUSTOM_INDEX_UPDATE_TIME_KEY);
        if (rawCustTime) customIndexUpdateTime = rawCustTime;
    } catch (e) { /* ignore */ }

    // 自选股持仓成本/股数
    try {
        var rawCost = storage.getItem(WATCHLIST_COST_KEY);
        if (rawCost) {
            var parsedCost = JSON.parse(rawCost);
            if (parsedCost && typeof parsedCost === 'object') watchlistCost = parsedCost;
        }
    } catch (e) { /* ignore */ }
    try {
        var rawRemarks = storage.getItem(WATCHLIST_REMARKS_KEY);
        if (rawRemarks) {
            var parsedRemarks = JSON.parse(rawRemarks);
            if (parsedRemarks && typeof parsedRemarks === 'object') watchlistRemarks = parsedRemarks;
        }
    } catch (e) { /* ignore */ }

    // 告警设置 + 自选股 alert 状态(带 schema 校验)
    try {
        var saved = JSON.parse(storage.getItem(ALERT_SETTINGS_KEY) || '{}') || {};
        if (typeof saved.enabled === 'boolean') alertEnabled = saved.enabled;
        if (typeof saved.threshold === 'number' && saved.threshold > 0 && saved.threshold <= 50) {
            alertThreshold = saved.threshold;
        }
        if (typeof saved.opacity === 'number' && saved.opacity >= 0.2 && saved.opacity <= 1) alertOpacity = saved.opacity;
    } catch (e) { /* ignore */ }
    try {
        var rawAlertState = JSON.parse(storage.getItem(WATCH_ALERT_STATE_KEY) || '{}') || {};
        if (rawAlertState && rawAlertState.__v !== WATCH_ALERT_SCHEMA_VERSION) {
            watchAlertState = {};
            try { storage.removeItem(WATCH_ALERT_STATE_KEY); } catch (e) {}
        } else {
            watchAlertState = rawAlertState;
        }
    } catch (e) { watchAlertState = {}; }

    // ============ 渐进治理:受控访问层 (向后兼容,现有 state.x = y 直接读写仍可用) ============
    // 设计:保留 window.AppState 作为共享可变单例;新增受控 API 用于结构化更新 + 订阅。
    // - getState():返回同一引用,便于测试与统一入口
    // - setState(patch):浅合并并广播 change / change:<key> 事件(当前无订阅者时零副作用)
    // - subscribe(event, fn):返回取消函数;事件名 'change' 或 'change:<key>'
    // - emit(event, payload):统一事件总线,供模块发领域事件
    var _stateListeners = {};
    function _emitState(event, payload) {
        var ls = _stateListeners[event];
        if (!ls || !ls.length) return;
        // 复制一份,避免回调内增删订阅导致遍历错乱;单个回调异常不影响其余
        ls.slice().forEach(function (fn) {
            try { fn(payload); } catch (e) { /* 订阅回调异常不应中断状态写入 */ }
        });
    }
    function subscribeState(event, fn) {
        if (typeof fn !== 'function') return function () {};
        (_stateListeners[event] = _stateListeners[event] || []).push(fn);
        return function unsubscribe() {
            var arr = _stateListeners[event];
            if (!arr) return;
            var i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
        };
    }
    function getState() {
        return window.AppState;
    }
    function setState(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return window.AppState;
        Object.assign(window.AppState, patch);
        _emitState('change', { patch: patch, state: window.AppState });
        Object.keys(patch).forEach(function (k) {
            _emitState('change:' + k, { key: k, value: patch[k], state: window.AppState });
        });
        return window.AppState;
    }

    function restorePersistentState() {
        // 每次启动固定从金十快讯进入，来源切换只在当前会话生效。
        window.AppState.currentNewsSource = 'jin10';
        try {
            var restoredCodes = JSON.parse(storage.getItem(CUSTOM_INDICES_KEY) || '[]');
            if (Array.isArray(restoredCodes)) {
                window.AppState.customIndexCodes = restoredCodes.filter(function (c) {
                    return /^\d{6}$/.test(c);
                }).slice(0, CUSTOM_INDEX_MAX);
            }
        } catch (_error) {}
        try {
            var restoredCost = JSON.parse(storage.getItem(WATCHLIST_COST_KEY) || '{}');
            if (restoredCost && typeof restoredCost === 'object') window.AppState.watchlistCost = restoredCost;
            var restoredRemarks = JSON.parse(storage.getItem(WATCHLIST_REMARKS_KEY) || '{}');
            if (restoredRemarks && typeof restoredRemarks === 'object') window.AppState.watchlistRemarks = restoredRemarks;
        } catch (_error) {}
        try {
            var restoredAlerts = JSON.parse(storage.getItem(ALERT_SETTINGS_KEY) || '{}');
            if (typeof restoredAlerts.enabled === 'boolean') window.AppState.alertEnabled = restoredAlerts.enabled;
            if (typeof restoredAlerts.threshold === 'number') window.AppState.alertThreshold = restoredAlerts.threshold;
            if (typeof restoredAlerts.opacity === 'number') window.AppState.alertOpacity = restoredAlerts.opacity;
            var restoredAlertState = JSON.parse(storage.getItem(WATCH_ALERT_STATE_KEY) || '{}');
            if (restoredAlertState && restoredAlertState.__v === WATCH_ALERT_SCHEMA_VERSION) {
                window.AppState.watchAlertState = restoredAlertState;
            }
        } catch (_error) {}
    }

    window.AppState = {
        // 缓存键
        KEYS: {
            SETTINGS_KEY: SETTINGS_KEY,
            ACTIVE_TAB_KEY: ACTIVE_TAB_KEY,
            NEWS_SOURCE_KEY: NEWS_SOURCE_KEY,
            COLLAPSE_STATE_KEY: COLLAPSE_STATE_KEY,
            SECTOR_TAB_KEY: SECTOR_TAB_KEY,
            SHORT_CACHE_KEYS: SHORT_CACHE_KEYS,
            SHORT_CACHE_TTL: SHORT_CACHE_TTL,
            WATCH_QUOTE_CACHE_KEY: WATCH_QUOTE_CACHE_KEY,
            WATCH_QUOTE_UPDATE_TIME_KEY: WATCH_QUOTE_UPDATE_TIME_KEY,
            WATCH_QUOTE_STATUS_KEY: WATCH_QUOTE_STATUS_KEY,
            ALERT_SETTINGS_KEY: ALERT_SETTINGS_KEY,
            WATCH_ALERT_STATE_KEY: WATCH_ALERT_STATE_KEY,
            CUSTOM_INDICES_KEY: CUSTOM_INDICES_KEY,
            CUSTOM_INDEX_QUOTE_CACHE_KEY: CUSTOM_INDEX_QUOTE_CACHE_KEY,
            CUSTOM_INDEX_UPDATE_TIME_KEY: CUSTOM_INDEX_UPDATE_TIME_KEY,
            CUSTOM_INDEX_MAX: CUSTOM_INDEX_MAX,
            WATCHLIST_COST_KEY: WATCHLIST_COST_KEY,
            WATCHLIST_REMARKS_KEY: WATCHLIST_REMARKS_KEY,
            INDEX_PREV_KEY: INDEX_PREV_KEY,
            INDEX_REFRESH_SECONDS: INDEX_REFRESH_SECONDS,
            STORAGE_KEY: STORAGE_KEY,
            WATCH_TABS_KEY: WATCH_TABS_KEY,
            ACTIVE_WATCH_TAB_KEY: ACTIVE_WATCH_TAB_KEY,
            PREV_KEY: PREV_KEY,
            FIXED_WATCH_TAB_IDS: FIXED_WATCH_TAB_IDS,
            FIXED_WATCH_TAB_NAMES: FIXED_WATCH_TAB_NAMES,
            HOT_RANK_SOURCE_KEY: HOT_RANK_SOURCE_KEY,
            HOT_RANK_CACHE_THS_KEY: HOT_RANK_CACHE_THS_KEY,
            HOT_RANK_CACHE_EM_KEY: HOT_RANK_CACHE_EM_KEY,
            HOT_RANK_TAB_HEADERS: HOT_RANK_TAB_HEADERS,
            LIMIT_UP_TYPES: LIMIT_UP_TYPES,
            LIMIT_UP_TAB_LABELS: LIMIT_UP_TAB_LABELS,
            LIMIT_UP_TAB_KEY: LIMIT_UP_TAB_KEY,
            ALERT_TOAST_MAX: ALERT_TOAST_MAX,
            ALERT_TOAST_TTL_MS: ALERT_TOAST_TTL_MS,
            STATUS_TOAST_TTL_MS: STATUS_TOAST_TTL_MS,
            VALID_TABS: VALID_TABS,
            TAB_TITLES: TAB_TITLES,
            NEWS_PAGE_SIZE: NEWS_PAGE_SIZE,
            WATCH_REFRESH_THROTTLE_KEY: WATCH_REFRESH_THROTTLE_KEY,
            WATCH_REFRESH_THROTTLE_MS: WATCH_REFRESH_THROTTLE_MS,
            WATCH_ALERT_SCHEMA_VERSION: WATCH_ALERT_SCHEMA_VERSION,
        },
        // state
        isAutoRefresh: isAutoRefresh,
        refreshSecondsMain: refreshSecondsMain,
        refreshSecondsSignal: refreshSecondsSignal,
        refreshSecondsNews: refreshSecondsNews,
        colorMode: colorMode,
        currentTab: currentTab,
        activeWatchTabId: activeWatchTabId,
        liveIndexData: liveIndexData,
        liveCapitalData: liveCapitalData,
        liveMarketBreadthData: liveMarketBreadthData,
        liveSectorPanoramaData: liveSectorPanoramaData,
        liveSectorData: liveSectorData,
        watchQuoteCache: watchQuoteCache,
        watchQuoteUpdateTime: watchQuoteUpdateTime,
        watchQuoteFreshCodes: watchQuoteFreshCodes,
        watchMarketWarnings: watchMarketWarnings,
        customIndexCodes: customIndexCodes,
        customIndexCache: customIndexCache,
        customIndexFreshCodes: customIndexFreshCodes,
        customIndexUpdateTime: customIndexUpdateTime,
        watchlistCost: watchlistCost,
        watchlistRemarks: watchlistRemarks,
        alertEnabled: alertEnabled,
        alertThreshold: alertThreshold,
        alertOpacity: alertOpacity,
        watchAlertState: watchAlertState,
        currentNewsSource: currentNewsSource,
        newsState: newsState,
        // ===== 渐进治理:受控访问层 API =====
        getState: getState,
        setState: setState,
        subscribe: subscribeState,
        emit: _emitState,
        restorePersistentState: restorePersistentState,
    };
})();
