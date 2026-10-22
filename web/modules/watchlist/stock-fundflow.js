// ================================================================
// 自选股 — 资金流弹窗:主体渲染 / 关闭 / 初始化
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var utils = W.utils;

    // 净值正负着色(用于数值文本)
    function cls(v) {
        return v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';
    }

    function fundHistoryHtml(recent) {
        var rows = (Array.isArray(recent) ? recent : []).slice(-10).reverse();
        if (!rows.length) return '<div class="list-empty">暂无近10日资金明细</div>';
        return '<div class="stock-fund-history-head" aria-hidden="true"><span>日期</span><span>方向</span><span>主力净额</span></div>' +
            '<ul class="stock-fund-history">' + rows.map(function (row) {
                row = row || {};
                var value = Number(row.mainNet);
                if (!Number.isFinite(value)) value = 0;
                var direction = value > 0 ? '净流入' : value < 0 ? '净流出' : '持平';
                return '<li class="stock-fund-history-row">' +
                    '<time datetime="' + utils.escapeHtml(row.date || '') + '">' + utils.escapeHtml(row.date || '--') + '</time>' +
                    '<span class="stock-fund-history-direction ' + cls(value) + '">' + direction + '</span>' +
                    '<strong class="stock-fund-history-value ' + cls(value) + '">' + utils.escapeHtml(utils.formatYuan(value)) + '</strong>' +
                '</li>';
            }).join('') + '</ul>';
    }

    function renderStockFundFlowBody(item, latestFlow, last, prevMain, options) {
        var includeEditor = !(options && options.includeEditor === false);
        if (!latestFlow || !last) return (includeEditor ? W.renderStockCostEditor(item.code) : '') + '<div class="list-empty">暂无资金流数据</div>';

        // 注: 不显示涨跌幅 — 弹窗用的是 daykline 接口最近交易日的 pct,与列表实时报价对不上

        var items = [
            { key: 'main',   label: '主力' },
            { key: 'large',  label: '大单' },
            { key: 'medium', label: '中单' },
            { key: 'small',  label: '小单' },
        ];
        var max = 1;
        items.forEach(function (it) {
            var a = Math.abs(latestFlow[it.key] || 0);
            if (a > max) max = a;
        });
        var mainNet = latestFlow.main || 0;
        var prevMainText = prevMain === null || prevMain === undefined
            ? ''
            : ' (昨 ' + utils.formatYuan(prevMain) + ')';
        var flowDateText = options && options.date ? ' · ' + options.date : '';
        var summary = item.summary || {};
        var rows = items.map(function (it) {
            var v = latestFlow[it.key] || 0;
            var w = (Math.abs(v) / max * 100).toFixed(1);
            var valueClass = cls(v);
            return '<div class="watchlist-fund-row">' +
                '<span class="watchlist-fund-label">' + it.label + '</span>' +
                '<span class="watchlist-fund-track"><span class="watchlist-fund-fill ' + valueClass + '" data-w="' + w + '"></span></span>' +
                '<span class="watchlist-fund-value ' + valueClass + '">' + utils.escapeHtml(utils.formatYuan(v)) + '</span>' +
            '</div>';
        }).join('');
        var summaryRows = [
            { label: '5日', value: summary.main_5d || 0 },
            { label: '20日', value: summary.main_20d || 0 },
            { label: '60日', value: summary.main_60d || 0 },
        ].map(function (row) {
            var valueClass = cls(row.value);
            return '<div class="stock-fund-summary-item">' +
                '<span class="stock-fund-summary-label">' + row.label + '</span>' +
                '<span class="stock-fund-summary-value ' + valueClass + '">' +
                    utils.escapeHtml(utils.formatYuan(row.value)) +
                '</span>' +
            '</div>';
        }).join('');
        var recentHistory = fundHistoryHtml(item.recent || []);

        return (includeEditor ? W.renderStockCostEditor(item.code) : '') +
            '<div class="stock-fund-header">' +
            '<div class="stock-fund-main">' +
                '<span class="stock-fund-main-label">主力合计' + utils.escapeHtml(flowDateText) + '</span>' +
                '<strong class="stock-fund-main-value ' + cls(mainNet) + '">' + utils.escapeHtml(utils.formatYuan(mainNet)) + '</strong>' +
                (prevMainText ? '<span class="stock-fund-main-previous">' + utils.escapeHtml(prevMainText) + '</span>' : '') +
            '</div>' +
            '</div>' +
            '<div class="watchlist-fund-flow">' + rows + '</div>' +
            '<div class="stock-fund-summary">' +
                '<div class="stock-fund-section-title">主力净流入</div>' +
                '<div class="stock-fund-summary-grid">' + summaryRows + '</div>' +
                '<div class="stock-fund-history-block">' +
                    '<div class="stock-fund-history-title">近10日明细</div>' +
                    recentHistory +
                '</div>' +
            '</div>';
    }

    function closeStockFundFlow() {
        if (window.AppWorkbench) { window.AppWorkbench.closeDetail(); return; }
        if (W.invalidateDetail) W.invalidateDetail();
        var panel = document.getElementById('stock-fund-panel');
        var overlay = document.getElementById('stock-fund-overlay');
        if (panel && window.AppDialog) {
            window.AppDialog.close(panel);
            return;
        }
        if (panel) panel.hidden = true;
        if (overlay) overlay.hidden = true;
    }

    function initStockFundFlowModal() {
        var closeBtn = document.getElementById('stock-fund-close');
        var overlay = document.getElementById('stock-fund-overlay');
        if (closeBtn) closeBtn.addEventListener('click', closeStockFundFlow);
        if (overlay) overlay.addEventListener('click', closeStockFundFlow);
        var panel = document.getElementById('stock-fund-panel');
        if (panel) {
            panel.addEventListener('submit', function (e) {
                var form = e.target.closest('[data-stock-cost-form]');
                if (!form) return;
                e.preventDefault();
                W.saveStockCostFromForm(form);
            });
        }
    }

    W.renderStockFundFlowBody = renderStockFundFlowBody;
    W.closeStockFundFlow = closeStockFundFlow;
    W.initStockFundFlowModal = initStockFundFlowModal;
})();
