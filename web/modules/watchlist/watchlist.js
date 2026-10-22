// ================================================================
// 自选股 — 模块门面
// 把 watchlist/* 各子模块挂到 window.__watch(W) 上的函数,
// 以与原 render-watchlist.js 完全一致的公开 API 暴露为 window.AppWatchlist。
// 子模块内部引用全部走 W.*(运行时解析),此处仅做「透传」,不引入新闭包。
// 加载顺序需保证:本文件之前已加载 _shared.js 与全部子模块。
// ================================================================

(function () {
    var W = window.__watch;

    // 透传引用:子模块函数本身已绑定各自模块闭包(引用 W/state/utils),
    // 直接赋值即可保持原 render-watchlist.js 的调用语义。
    window.AppWatchlist = {
        // tabs
        isFixedWatchTab: W.isFixedWatchTab,
        getWatchTabs: W.getWatchTabs,
        saveWatchTabs: W.saveWatchTabs,
        getActiveWatchTab: W.getActiveWatchTab,
        getWatchlist: W.getWatchlist,
        saveActiveWatchlist: W.saveActiveWatchlist,
        initWatchlistTabs: W.initWatchlistTabs,
        renderWatchTabs: W.renderWatchTabs,
        switchWatchTab: W.switchWatchTab,
        initWatchTabScroller: W.initWatchTabScroller,
        addWatchTab: W.addWatchTab,
        removeWatchTab: W.removeWatchTab,
        // import / export
        exportWatchlistData: W.exportWatchlistData,
        importWatchlistData: W.importWatchlistData,
        // add/remove
        resolveStockInput: W.resolveStockInput,
        addStockToWatchlist: W.addStockToWatchlist,
        removeStockFromWatchlist: W.removeStockFromWatchlist,
        getAllWatchCodes: W.getAllWatchCodes,
        getHoldingCodes: W.getHoldingCodes,
        isHoldingTab: W.isHoldingTab,
        // load + render
        loadWatchlistData: W.loadWatchlistData,
        applyWatchQuoteBatch: W.applyWatchQuoteBatch,
        loadWatchMarketWarnings: W.loadWatchMarketWarnings,
        applyWatchMarketWarnings: W.applyWatchMarketWarnings,
        applyCustomIndexQuoteBatch: W.applyCustomIndexQuoteBatch,
        markQuoteUnavailable: W.markQuoteUnavailable,
        loadSingleWatchQuote: W.loadSingleWatchQuote,
        renderWatchlist: W.renderWatchlist,
        renderWatchItem: W.renderWatchItem,
        renderWatchWarningTags: W.renderWatchWarningTags,
        renderCostCell: W.renderCostCell,
        saveWatchlistCost: W.saveWatchlistCost,
        getDisplayStockName: W.getDisplayStockName,
        saveWatchlistRemarks: W.saveWatchlistRemarks,
        persistWatchQuoteCache: W.persistWatchQuoteCache,
        persistWatchQuoteUpdateTime: W.persistWatchQuoteUpdateTime,
        persistCurrentChangePct: W.persistCurrentChangePct,
        getPrevChangePct: W.getPrevChangePct,
        bindWatchRemove: W.bindWatchRemove,
        bindWatchItemClick: W.bindWatchItemClick,
        // modal
        showStockFundFlow: W.showStockFundFlow,
        renderStockCostEditor: W.renderStockCostEditor,
        saveStockCostFromForm: W.saveStockCostFromForm,
        renderStockFundFlowBody: W.renderStockFundFlowBody,
        closeStockFundFlow: W.closeStockFundFlow,
        initStockFundFlowModal: W.initStockFundFlowModal,
        // custom index
        renderCustomIndex: W.renderCustomIndex,
        renderCustomIndexItem: W.renderCustomIndexItem,
        bindCustomIndexRemove: W.bindCustomIndexRemove,
        bindCustomIndexAdd: W.bindCustomIndexAdd,
        bindCustomIndexAddForm: W.bindCustomIndexAddForm,
        openCustomIndexAddForm: W.openCustomIndexAddForm,
        closeCustomIndexAddForm: W.closeCustomIndexAddForm,
        addCustomIndexByInput: W.addCustomIndexByInput,
        removeCustomIndex: W.removeCustomIndex,
        loadCustomIndexData: W.loadCustomIndexData,
        loadSingleCustomIndex: W.loadSingleCustomIndex,
        saveCustomIndices: W.saveCustomIndices,
        persistCustomIndexCache: W.persistCustomIndexCache,
        persistCustomIndexUpdateTime: W.persistCustomIndexUpdateTime,
        // non-trading stale refresh
        refreshStaleWatchQuotes: W.refreshStaleWatchQuotes,
        refreshStaleCustomIndex: W.refreshStaleCustomIndex,
        // status helpers
        showWatchStatus: W.showWatchStatus,
        showCustomIndexStatus: W.showCustomIndexStatus,
        showDataStatus: W.showDataStatus,
    };
})();
