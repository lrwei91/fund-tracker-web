// ================================================================
// 自选股 — 标签页模型 / CRUD / 持久化 / 涨跌快照
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var KEYS = W.KEYS;

    function isFixedWatchTab(tabId) {
        return KEYS.FIXED_WATCH_TAB_IDS.indexOf(tabId) !== -1;
    }

    function getLegacyWatchlist() {
        try {
            var data = window.AppStorage.getItem(KEYS.STORAGE_KEY);
            var parsed = data ? JSON.parse(data) : [];
            return W.sanitizeCodes(parsed);
        } catch (e) { return []; }
    }

    function defaultWatchTabs() {
        return [
            { id: 'default', name: '持仓股', codes: getLegacyWatchlist() },
            { id: 'candidate', name: '候选股', codes: [] },
        ];
    }

    function normalizeWatchTabName(name, index) {
        if (!name || name === '自选') return index === 0 ? '持仓股' : '分组' + (index + 1);
        return name;
    }

    function getWatchTabs() {
        try {
            var data = window.AppStorage.getItem(KEYS.WATCH_TABS_KEY);
            var parsed = data ? JSON.parse(data) : null;
            if (!Array.isArray(parsed) || parsed.length === 0) return defaultWatchTabs();

            var fixedBuckets = KEYS.FIXED_WATCH_TAB_IDS.map(function () { return null; });
            var userTabs = [];
            parsed.forEach(function (tab) {
                var idx = KEYS.FIXED_WATCH_TAB_IDS.indexOf(tab.id);
                if (idx !== -1) fixedBuckets[idx] = tab;
                else userTabs.push(tab);
            });
            var needsUpgrade = false;
            KEYS.FIXED_WATCH_TAB_IDS.forEach(function (id, idx) {
                if (!fixedBuckets[idx]) {
                    fixedBuckets[idx] = { id: id, name: KEYS.FIXED_WATCH_TAB_NAMES[id], codes: [] };
                    needsUpgrade = true;
                }
            });
            var merged = fixedBuckets.concat(userTabs);
            if (needsUpgrade) W.saveWatchTabs(merged);

            return merged.map(function (tab, index) {
                return {
                    id: tab.id || 'tab-' + index,
                    name: normalizeWatchTabName(tab.name, index),
                    codes: W.sanitizeCodes(tab.codes),
                };
            });
        } catch (e) {
            return defaultWatchTabs();
        }
    }

    function saveWatchTabs(tabs) {
        var cleanTabs = tabs.map(function (tab, index) {
            return {
                id: tab.id || 'tab-' + index,
                name: normalizeWatchTabName(tab.name, index),
                codes: W.sanitizeCodes(tab.codes),
            };
        });
        try {
            window.AppStorage.setItem(KEYS.WATCH_TABS_KEY, JSON.stringify(cleanTabs));
            window.AppStorage.setItem(KEYS.STORAGE_KEY, JSON.stringify(cleanTabs[0] ? cleanTabs[0].codes : []));
        } catch (e) {
            console.error('保存失败', e);
        }
    }

    function getCodesFromTabs(tabs) {
        var codeMap = {};
        tabs.forEach(function (tab) {
            W.sanitizeCodes(tab.codes).forEach(function (code) {
                codeMap[code] = true;
            });
        });
        return codeMap;
    }

    function getPrevChangePct() {
        try { return JSON.parse(window.AppStorage.getItem(KEYS.PREV_KEY)) || {}; } catch (e) { return {}; }
    }
    function savePrevChangePct(map) {
        try { window.AppStorage.setItem(KEYS.PREV_KEY, JSON.stringify(map)); } catch (e) {}
    }
    function persistCurrentChangePct() {
        var map = {};
        Object.keys(state.watchQuoteCache).forEach(function (code) {
            var d = state.watchQuoteCache[code];
            if (state.watchQuoteFreshCodes[code] && d && typeof d.changePercent === 'number') map[code] = d.changePercent;
        });
        savePrevChangePct(map);
    }

    function getActiveWatchTab() {
        var tabs = getWatchTabs();
        var savedId = window.AppStorage.getItem(KEYS.ACTIVE_WATCH_TAB_KEY);
        var tab = tabs.find(function (item) { return item.id === (state.activeWatchTabId || savedId); }) ||
            tabs.find(function (item) { return item.id === savedId; }) ||
            tabs[0];
        state.activeWatchTabId = tab.id;
        return tab;
    }

    function getWatchlist() {
        return getActiveWatchTab().codes;
    }

    function saveActiveWatchlist(codes) {
        var tabs = getWatchTabs();
        var tab = tabs.find(function (item) { return item.id === state.activeWatchTabId; }) || tabs[0];
        tab.codes = W.sanitizeCodes(codes);
        saveWatchTabs(tabs);
    }

    function getHoldingCodes() {
        var tabs = getWatchTabs();
        var holding = tabs.find(function (tab) { return tab.id === 'default'; });
        return W.sanitizeCodes(holding ? (holding.codes || []) : []);
    }

    function isHoldingTab() {
        return state.activeWatchTabId === 'default';
    }

    function getAllWatchCodes() {
        return W.sanitizeCodes(getWatchTabs().flatMap(function (tab) { return tab.codes || []; }));
    }

    W.isFixedWatchTab = isFixedWatchTab;
    W.normalizeWatchTabName = normalizeWatchTabName;
    W.getWatchTabs = getWatchTabs;
    W.saveWatchTabs = saveWatchTabs;
    W.getActiveWatchTab = getActiveWatchTab;
    W.getWatchlist = getWatchlist;
    W.saveActiveWatchlist = saveActiveWatchlist;
    W.getCodesFromTabs = getCodesFromTabs;
    W.getPrevChangePct = getPrevChangePct;
    W.savePrevChangePct = savePrevChangePct;
    W.persistCurrentChangePct = persistCurrentChangePct;
    W.getHoldingCodes = getHoldingCodes;
    W.isHoldingTab = isHoldingTab;
    W.getAllWatchCodes = getAllWatchCodes;
})();
