// ================================================================
// 自选股模块 — 共享注册表与公共 helper
// 所有 watchlist/* 子模块通过 window.__watch 共享函数与状态,
// 跨文件调用统一走 W.fn(运行时解析,依赖加载顺序,与原单文件闭包等价)。
// 加载顺序需保证在本文件之前:state.js / utils.js / cache.js
// ================================================================

(function () {
    var W = window.__watch || (window.__watch = {});
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var KEYS = state ? state.KEYS : {};

    W.state = state;
    W.utils = utils;
    W.cache = cache;
    W.KEYS = KEYS;

    function hasOwn(obj, key) {
        return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function sanitizeCodes(codes) {
        return Array.isArray(codes)
            ? codes.map(function (item) {
                if (item && typeof item === 'object') return item.code || item.id || '';
                return item;
            }).map(function (code) {
                return String(code || '').trim();
            }).filter(function (code, index, arr) { return /^\d{6}$/.test(code) && arr.indexOf(code) === index; })
            : [];
    }

    // 纯数值解析,null/''/undefined/NaN -> null(被 stock-detail 的 format* 广泛复用)
    function readFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        var number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function showDataStatus(message, type) {
        if (window.AppAlerts) window.AppAlerts.showStatusToast(message, type);
    }

    function showWatchStatus(msg, type) {
        if (window.AppAlerts) window.AppAlerts.showStatusToast(msg, type);
    }

    function showCustomIndexStatus(msg, type) {
        if (window.AppAlerts) window.AppAlerts.showStatusToast(msg, type);
    }

    function getDisplayStockName(code, fallbackName) {
        var remark = state && state.watchlistRemarks && state.watchlistRemarks[code];
        var cleanRemark = String(remark || '').trim();
        return cleanRemark || fallbackName || code;
    }

    W.hasOwn = hasOwn;
    W.sanitizeCodes = sanitizeCodes;
    W.readFiniteNumber = readFiniteNumber;
    W.showDataStatus = showDataStatus;
    W.showWatchStatus = showWatchStatus;
    W.showCustomIndexStatus = showCustomIndexStatus;
    W.getDisplayStockName = getDisplayStockName;
})();
