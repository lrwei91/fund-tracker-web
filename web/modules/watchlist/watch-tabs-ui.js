// ================================================================
// 自选股 — 标签栏 UI:渲染 / 切换 / 滚动拖拽 / 增删
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var utils = W.utils;
    var KEYS = W.KEYS;

    function initWatchlistTabs() {
        var savedId = window.AppStorage.getItem(KEYS.ACTIVE_WATCH_TAB_KEY);
        state.activeWatchTabId = savedId || 'default';
        W.renderWatchTabs();
        W.initWatchTabScroller();
    }

    function renderWatchTabs() {
        var container = document.getElementById('watchlist-tabs');
        if (!container) return;
        var tabs = W.getWatchTabs();
        if (!tabs.some(function (tab) { return tab.id === state.activeWatchTabId; })) state.activeWatchTabId = tabs[0].id;
        container.innerHTML = tabs.map(function (tab) {
            var isActive = tab.id === state.activeWatchTabId;
            var removable = !W.isFixedWatchTab(tab.id);
            return '<button class="watchlist-tab' + (isActive ? ' active' : '') + '" data-watch-tab="' + utils.escapeHtml(tab.id) + '" type="button">' +
                '<span>' + utils.escapeHtml(tab.name) + '</span>' +
                (removable ? '<span class="watchlist-tab-remove" data-remove-watch-tab="' + utils.escapeHtml(tab.id) + '" aria-label="删除分组">×</span>' : '') +
                '</button>';
        }).join('');
        container.querySelectorAll('.watchlist-tab').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                if (container.dataset.suppressClick === 'true') {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                var removeBtn = e.target.closest('.watchlist-tab-remove');
                if (removeBtn) {
                    e.stopPropagation();
                    W.removeWatchTab(removeBtn.getAttribute('data-remove-watch-tab'));
                    return;
                }
                W.switchWatchTab(btn.getAttribute('data-watch-tab'));
            });
        });
    }

    function switchWatchTab(tabId) {
        if (!tabId || tabId === state.activeWatchTabId) return;
        state.activeWatchTabId = tabId;
        window.AppStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, tabId);
        W.renderWatchTabs();
        W.renderWatchlist();
    }

    function initWatchTabScroller() {
        var container = document.getElementById('watchlist-tabs');
        if (!container || container.dataset.dragBound === 'true') return;
        container.dataset.dragBound = 'true';
        var isDown = false;
        var startX = 0;
        var startScrollLeft = 0;
        var startTabId = '';
        var didDrag = false;

        container.addEventListener('pointerdown', function (e) {
            if (e.target.closest('.watchlist-tab-remove')) return;
            var tab = e.target.closest('.watchlist-tab');
            isDown = true;
            startX = e.clientX;
            startScrollLeft = container.scrollLeft;
            startTabId = tab ? tab.getAttribute('data-watch-tab') : '';
            didDrag = false;
            container.classList.add('dragging');
            container.setPointerCapture(e.pointerId);
        });

        container.addEventListener('pointermove', function (e) {
            if (!isDown) return;
            var delta = e.clientX - startX;
            if (Math.abs(delta) > 6) {
                didDrag = true;
                e.preventDefault();
            }
            container.scrollLeft = startScrollLeft - delta;
        });

        function endDrag(e) {
            if (!isDown) return;
            isDown = false;
            container.classList.remove('dragging');
            try { container.releasePointerCapture(e.pointerId); } catch (err) {}
            if (didDrag) {
                container.dataset.suppressClick = 'true';
                setTimeout(function () { container.dataset.suppressClick = ''; }, 0);
                return;
            }
            W.switchWatchTab(startTabId);
        }

        container.addEventListener('pointerup', endDrag);
        container.addEventListener('pointercancel', endDrag);
    }

    function addWatchTab() {
        var tabs = W.getWatchTabs();
        var name = window.prompt('新分组名称', '分组' + (tabs.length + 1));
        if (!name) return;
        var cleanName = name.trim().slice(0, 12);
        if (!cleanName) return;
        var id = 'tab-' + Date.now().toString(36);
        tabs.push({ id: id, name: cleanName, codes: [] });
        state.activeWatchTabId = id;
        window.AppStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, id);
        W.saveWatchTabs(tabs);
        W.renderWatchTabs();
        W.renderWatchlist();
    }

    function removeWatchTab(tabId) {
        if (W.isFixedWatchTab(tabId)) return;
        var tabs = W.getWatchTabs();
        var userTabsCount = tabs.filter(function (t) { return !W.isFixedWatchTab(t.id); }).length;
        if (userTabsCount <= 1) {
            W.showWatchStatus('至少保留一个自建分组', 'error');
            return;
        }
        var target = tabs.find(function (tab) { return tab.id === tabId; });
        if (!target) return;
        if (!window.confirm('删除分组“' + target.name + '”？分组内股票也会移除。')) return;
        var nextTabs = tabs.filter(function (tab) { return tab.id !== tabId; });
        if (state.activeWatchTabId === tabId) {
            state.activeWatchTabId = nextTabs[0].id;
            window.AppStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, state.activeWatchTabId);
        }
        W.saveWatchTabs(nextTabs);
        W.renderWatchTabs();
        W.renderWatchlist();
        W.showWatchStatus('分组已删除');
    }

    W.initWatchlistTabs = initWatchlistTabs;
    W.renderWatchTabs = renderWatchTabs;
    W.switchWatchTab = switchWatchTab;
    W.initWatchTabScroller = initWatchTabScroller;
    W.addWatchTab = addWatchTab;
    W.removeWatchTab = removeWatchTab;
})();
