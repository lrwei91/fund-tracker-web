// Navigation, local portfolio totals and the responsive detail workspace.
(function () {
    var state = window.AppState;
    var detailTrigger = null;
    var selectedCode = null;
    var scrollPosition = 0;
    function finitePositive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null; }
    function calculate(codes, costs, quotes, fresh) {
        var value = 0, pnl = 0, valueCount = 0, pnlCount = 0;
        codes.forEach(function (code) {
            var q = quotes[code] || {}, entry = costs[code] || {};
            var price = fresh[code] ? finitePositive(q.priceValue) : null;
            var shares = finitePositive(entry.shares), cost = finitePositive(entry.cost);
            if (price === null || shares === null || !Number.isFinite(price * shares)) return;
            value += price * shares; valueCount += 1;
            if (cost !== null && Number.isFinite((price - cost) * shares)) { pnl += (price - cost) * shares; pnlCount += 1; }
        });
        return { marketValue: valueCount ? value : null, pnl: pnlCount ? pnl : null, valueCount: valueCount, pnlCount: pnlCount, total: codes.length };
    }
    function renderSummary() {
        var host = document.getElementById('portfolio-summary');
        if (!host || !window.AppWatchlist) return;
        var codes = window.AppWatchlist.getHoldingCodes();
        var totals = calculate(codes, state.watchlistCost || {}, state.watchQuoteCache || {}, state.watchQuoteFreshCodes || {});
        var esc = window.AppUtils.escapeHtml;
        function money(value) { return value === null ? '--' : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
        var alerts = window.AppPriceAlerts ? window.AppPriceAlerts.getCodes().length : 0;
        host.innerHTML = '<div class="portfolio-stat"><span>有效持仓市值 <small>元</small></span><strong>' + money(totals.marketValue) + '</strong><small>' + totals.valueCount + '/' + totals.total + ' 只数量与行情完整</small></div>' +
            '<div class="portfolio-stat"><span>浮动盈亏 <small>元</small></span><strong class="' + (totals.pnl === null ? 'neutral' : totals.pnl > 0 ? 'positive' : totals.pnl < 0 ? 'negative' : 'neutral') + '">' + money(totals.pnl) + '</strong><small>' + totals.pnlCount + '/' + totals.total + ' 只可计算 · 本机统计</small></div>' +
            '<div class="portfolio-stat"><span>数据覆盖</span><strong>' + (totals.total ? Math.round(totals.valueCount / totals.total * 100) + '<small>%</small>' : '--') + '</strong><small>' + esc(totals.total ? '缺项不补零，统计可能不完整' : '添加持仓并设置成本、股数') + '</small></div>' +
            '<button type="button" class="portfolio-stat portfolio-action" data-navigate="alerts"><span>已监控提醒标的</span><strong>' + alerts + '</strong><small>查看条件规则与触发历史 ↗</small></button>';
    }
    function markSelected() {
        document.querySelectorAll('.watchlist-item[data-code]').forEach(function (row) {
            var active = row.dataset.code === selectedCode && !document.getElementById('stock-fund-panel').hidden;
            row.classList.toggle('is-selected', active);
            var trigger = row.querySelector('.watchlist-detail-trigger');
            if (trigger) { trigger.setAttribute('aria-expanded', String(active)); trigger.setAttribute('aria-controls', 'stock-fund-panel'); }
        });
    }
    function restoreDetail() {
        var panel = document.getElementById('stock-fund-panel'), dock = document.getElementById('stock-detail-dock');
        if (panel && dock) dock.appendChild(panel);
        if (panel) { panel.hidden = true; panel.setAttribute('role', 'region'); panel.removeAttribute('aria-modal'); }
        var placeholder = document.getElementById('detail-placeholder');
        if (placeholder) placeholder.hidden = false;
        document.body.classList.remove('has-inline-detail');
        markSelected();
        if (detailTrigger && detailTrigger.isConnected) detailTrigger.focus({ preventScroll: true });
        else if (selectedCode) {
            var target = document.querySelector('.watchlist-item[data-code="' + selectedCode + '"] .watchlist-detail-trigger');
            if (target) target.focus({ preventScroll: true });
        }
        var list = document.getElementById('watchlist-grid');
        if (list) list.scrollTop = scrollPosition;
    }
    function closeDetail() {
        var panel = document.getElementById('stock-fund-panel');
        if (!panel || panel.hidden) return;
        if (window.__watch && window.__watch.invalidateDetail) window.__watch.invalidateDetail();
        if (panel.getAttribute('role') === 'dialog' && window.AppDialog) window.AppDialog.close(panel);
        else restoreDetail();
    }
    function openDetail(code, trigger) {
        closeDetail();
        var panel = document.getElementById('stock-fund-panel'), overlay = document.getElementById('stock-fund-overlay');
        detailTrigger = trigger || document.activeElement; selectedCode = code;
        var list = document.getElementById('watchlist-grid'); scrollPosition = list ? list.scrollTop : 0;
        if (window.innerWidth >= 1100 && state.currentTab === 'dashboard') {
            document.getElementById('stock-detail-dock').appendChild(panel);
            panel.hidden = false; panel.setAttribute('role', 'region'); panel.removeAttribute('aria-modal');
            overlay.hidden = true; document.body.classList.add('has-inline-detail');
            document.getElementById('detail-placeholder').hidden = true;
            document.getElementById('stock-fund-close').focus({ preventScroll: true });
        } else {
            document.body.appendChild(panel); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
            if (window.AppDialog) window.AppDialog.open(panel, overlay, { trigger: detailTrigger, hideOnClose: true, focusTarget: document.getElementById('stock-fund-close'), onClose: restoreDetail });
            else { panel.hidden = false; overlay.hidden = false; }
        }
        markSelected();
    }
    function navigate(tab, updateHash) {
        if (tab === 'signals') tab = 'research';
        if (state.KEYS.VALID_TABS.indexOf(tab) === -1) tab = 'dashboard';
        if (state.currentTab !== tab) closeDetail();
        state.currentTab = tab;
        window.AppStorage.setItem(state.KEYS.ACTIVE_TAB_KEY, tab);
        document.querySelectorAll('.tab-btn').forEach(function (button) {
            var active = button.dataset.tab === tab; button.classList.toggle('active', active);
            if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
        });
        document.querySelectorAll('.tab-panel').forEach(function (panel) { panel.classList.toggle('active', panel.id === 'tab-' + tab); });
        document.getElementById('header-title').textContent = state.KEYS.TAB_TITLES[tab];
        if (updateHash !== false) history.replaceState(null, '', tab === 'dashboard' ? location.pathname + location.search : '#' + tab);
        if (window.AppRefreshCoordinator && window.AppRefreshCoordinator.refreshTab) window.AppRefreshCoordinator.refreshTab(tab);
        if (tab === 'research' && window.AppReports) window.AppReports.refresh();
        if (tab === 'alerts' && window.AppPriceAlerts) window.AppPriceAlerts.refresh();
        renderSummary();
    }
    function init() {
        document.addEventListener('click', function (event) {
            var link = event.target.closest('[data-navigate], .tab-btn[data-tab]');
            if (link) navigate(link.dataset.navigate || link.dataset.tab);
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && document.body.classList.contains('has-inline-detail')) closeDetail();
        });
        window.addEventListener('hashchange', function () { navigate(location.hash.slice(1), false); });
        var wide = window.innerWidth >= 1100;
        window.addEventListener('resize', function () { var next = window.innerWidth >= 1100; if (wide !== next) { closeDetail(); wide = next; } });
        navigate(location.hash.slice(1) || 'dashboard', false);
    }
    window.AppWorkbench = { calculate: calculate, markSelected: markSelected, renderSummary: renderSummary, navigate: navigate, openDetail: openDetail, closeDetail: closeDetail, init: init };
})();
