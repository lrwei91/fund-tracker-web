// ================================================================
// 市场行情 — App 入口
// 职责:
//   1. DOM init / wiring (tabs / collapsible / sector tabs / settings / data actions)
//   2. 设置 + 事件绑定 (auto refresh / opacity / threshold / 添加按钮)
//   3. 自动刷新 (交易时段窗口触发各模块 load 函数)
//   4. 主入口 (DOMContentLoaded)
// 渲染 / load 逻辑在 modules/render-*.js,工具在 modules/utils.js,
// state 在 modules/state.js,缓存 helpers 在 modules/cache.js
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var KEYS = state.KEYS;

    // ============================================================
    // Settings 持久化
    // ============================================================

    function normalizeOptionValue(value, allowedValues, fallback) {
        var stringValue = String(value);
        return allowedValues.includes(stringValue) ? stringValue : String(fallback);
    }

    function normalizePercentValue(value, fallback) {
        var numberValue = Number(value);
        if (!Number.isFinite(numberValue)) numberValue = Number(fallback);
        if (!Number.isFinite(numberValue)) numberValue = 100;
        return Math.max(0, Math.min(100, Math.round(numberValue)));
    }

    function getSettingsControls() {
        return {
            colorMode: document.getElementById('color-mode-select'),
            autoRefresh: document.getElementById('auto-refresh-toggle'),
            mainInterval: document.getElementById('refresh-interval-main'),
            signalInterval: document.getElementById('refresh-interval-signal'),
            newsInterval: document.getElementById('refresh-interval-news'),
            alertEnabled: document.getElementById('alert-enabled-toggle'),
            alertThreshold: document.getElementById('alert-threshold-input'),
            alertOpacity: document.getElementById('alert-opacity-input'),
            alertOpacityValue: document.getElementById('alert-opacity-value'),
        };
    }

    function readSettings() {
        try {
            return JSON.parse(window.AppStorage.getItem(KEYS.SETTINGS_KEY) || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function loadSettings() {
        var saved = readSettings();
        state.colorMode = window.AppTheme
            ? window.AppTheme.normalizeMode(saved.colorMode)
            : normalizeOptionValue(saved.colorMode, ['light', 'dark', 'system'], 'light');
        if (window.AppTheme) window.AppTheme.setMode(state.colorMode);
        state.isAutoRefresh = typeof saved.autoRefresh === 'boolean' ? saved.autoRefresh : state.isAutoRefresh;
        state.refreshSecondsMain = parseInt(normalizeOptionValue(saved.mainInterval, ['5', '10', '30', '60'], state.refreshSecondsMain), 10);
        state.refreshSecondsSignal = parseInt(normalizeOptionValue(saved.signalInterval, ['900', '1800', '3600', '7200'], state.refreshSecondsSignal), 10);
        state.refreshSecondsNews = parseInt(normalizeOptionValue(saved.newsInterval, ['60', '600', '1800'], state.refreshSecondsNews), 10);
    }

    function saveSettings() {
        try {
            window.AppStorage.setItem(KEYS.SETTINGS_KEY, JSON.stringify({
                colorMode: state.colorMode,
                autoRefresh: state.isAutoRefresh,
                mainInterval: state.refreshSecondsMain,
                signalInterval: state.refreshSecondsSignal,
                newsInterval: state.refreshSecondsNews,
            }));
        } catch (e) {}
    }

    function syncSettingsControls() {
        var controls = getSettingsControls();
        if (controls.colorMode) controls.colorMode.value = state.colorMode;
        if (controls.autoRefresh) controls.autoRefresh.checked = state.isAutoRefresh;
        if (controls.mainInterval) controls.mainInterval.value = String(state.refreshSecondsMain);
        if (controls.signalInterval) controls.signalInterval.value = String(state.refreshSecondsSignal);
        if (controls.newsInterval) controls.newsInterval.value = String(state.refreshSecondsNews);
        if (controls.alertEnabled) controls.alertEnabled.checked = state.alertEnabled;
        if (controls.alertThreshold) controls.alertThreshold.value = String(state.alertThreshold);
        if (controls.alertOpacity) controls.alertOpacity.value = String(Math.round(state.alertOpacity * 100));
        if (controls.alertOpacityValue) controls.alertOpacityValue.textContent = Math.round(state.alertOpacity * 100) + '%';
    }

    // ============================================================
    // 主 tab 路由 + 切换
    // ============================================================

    function initTabs() {
        if (window.AppWorkbench) window.AppWorkbench.init();
    }

    // ============================================================
    // 折叠面板
    // ============================================================

    function initCollapsible() {
        document.querySelectorAll('.card[data-collapsible="true"]').forEach(function (card) {
            var header = card.querySelector('.card-header');
            var body = card.querySelector('.card-body');
            if (!header || !body) return;
            var collState = cache.readJson(KEYS.COLLAPSE_STATE_KEY, {});
            var key = getCollapsibleKey(card);
            var collapsed = typeof collState[key] === 'boolean'
                ? collState[key]
                : card.getAttribute('data-collapsed') === 'true';
            if (!header.hasAttribute('role')) header.setAttribute('role', 'button');
            if (!header.hasAttribute('tabindex')) header.tabIndex = 0;
            if (!body.id) body.id = key + '-body';
            header.setAttribute('aria-controls', body.id);

            function setCollapsed(next) {
                card.setAttribute('data-collapsed', next ? 'true' : 'false');
                header.setAttribute('aria-expanded', next ? 'false' : 'true');
                body.style.display = next ? 'none' : '';
                saveCollapsibleState(card, next);
            }
            setCollapsed(collapsed);

            header.addEventListener('click', function (event) {
                if (event.target.closest('button, input, select, textarea, a')) return;
                var isCollapsed = card.getAttribute('data-collapsed') === 'true';
                setCollapsed(!isCollapsed);
            });
            header.addEventListener('keydown', function (event) {
                if (event.target !== header || (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar')) return;
                event.preventDefault();
                setCollapsed(card.getAttribute('data-collapsed') !== 'true');
            });
        });
    }

    function getCollapsibleKey(card) {
        return card.className.split(/\s+/).filter(function (name) {
            return name !== 'card' && name.indexOf('-section') > -1;
        })[0] || card.querySelector('h2').textContent.trim();
    }

    function saveCollapsibleState(card, collapsed) {
        var collState = cache.readJson(KEYS.COLLAPSE_STATE_KEY, {});
        collState[getCollapsibleKey(card)] = collapsed;
        cache.writeJson(KEYS.COLLAPSE_STATE_KEY, collState);
    }

    // ============================================================
    // 板块 tab
    // ============================================================

    function initSectorTabs() {
        if (window.AppMarket && typeof window.AppMarket.initSectorFilters === 'function') {
            window.AppMarket.initSectorFilters();
        }
    }

    function initSignalWorkspace() {
        var tabs = Array.from(document.querySelectorAll('[data-signal-view]'));
        var panels = document.querySelectorAll('[data-signal-panel]');
        function select(view) {
            tabs.forEach(function (tab) {
                var active = tab.dataset.signalView === view;
                tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
            });
            panels.forEach(function (panel) { var active = panel.dataset.signalPanel === view; panel.hidden = !active; panel.classList.toggle('active', active); });
        }
        tabs.forEach(function (tab, index) {
            tab.addEventListener('click', function () { select(tab.dataset.signalView); });
            tab.addEventListener('keydown', function (event) {
                var direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (direction) { event.preventDefault(); var next = tabs[(index + direction + tabs.length) % tabs.length]; next.click(); next.focus(); }
            });
        });
        select('rotation');
    }

    function initSettingsViews() {
        var tabs = document.querySelectorAll('[data-settings-view]');
        var panels = document.querySelectorAll('[data-settings-panel]');
        if (!tabs.length || !panels.length) return;

        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var view = tab.getAttribute('data-settings-view');
                tabs.forEach(function (item) {
                    var active = item === tab;
                    item.classList.toggle('active', active);
                    item.setAttribute('aria-selected', active ? 'true' : 'false');
                    item.tabIndex = active ? 0 : -1;
                });
                panels.forEach(function (panel) {
                    var active = panel.getAttribute('data-settings-panel') === view;
                    panel.classList.toggle('active', active);
                    panel.hidden = !active;
                });
            });
        });
    }

    // ============================================================
    // 设置面板 + 数据操作
    // ============================================================

    function initSettings() {
        var overlay = document.getElementById('settings-overlay');
        var panel = document.getElementById('settings-panel');
        var openBtn = document.getElementById('settings-btn');
        var closeBtn = document.getElementById('settings-close');

        function openSettings() {
            openBtn.setAttribute('aria-expanded', 'true');
            if (window.AppDialog) {
                window.AppDialog.open(panel, overlay, {
                    trigger: openBtn,
                    openClass: 'open',
                    hideOnClose: true,
                    focusTarget: closeBtn,
                    onClose: function () { openBtn.setAttribute('aria-expanded', 'false'); },
                });
            } else {
                overlay.hidden = false;
                panel.hidden = false;
                overlay.classList.add('open');
                panel.classList.add('open');
                closeBtn.focus();
            }
        }

        function closeSettings() {
            if (window.AppDialog) window.AppDialog.close(panel);
            else {
                overlay.classList.remove('open');
                panel.classList.remove('open');
                overlay.hidden = true;
                panel.hidden = true;
                openBtn.setAttribute('aria-expanded', 'false');
                openBtn.focus();
            }
        }

        openBtn.setAttribute('aria-expanded', 'false');
        openBtn.addEventListener('click', openSettings);
        closeBtn.addEventListener('click', closeSettings);
        overlay.addEventListener('click', closeSettings);
    }

    function initDataActions() {
        var exportBtn = document.getElementById('export-watchlist-btn');
        var importBtn = document.getElementById('import-watchlist-btn');
        var fileInput = document.getElementById('import-watchlist-file');

        if (exportBtn) exportBtn.addEventListener('click', function () {
            if (window.AppWatchlist) window.AppWatchlist.exportWatchlistData();
        });
        if (importBtn && fileInput) importBtn.addEventListener('click', function () { fileInput.click(); });
        if (fileInput) fileInput.addEventListener('change', function (e) {
            if (window.AppWatchlist) window.AppWatchlist.importWatchlistData(e);
        });
    }

    function initStorageStatus() {
        var headerStatus = document.getElementById('storage-status');
        var panelStatus = document.getElementById('settings-storage-status');
        var retryButton = document.getElementById('retry-storage-btn');

        function sync(detail) {
            detail = detail || (window.AppStorage && typeof window.AppStorage.getStatus === 'function'
                ? window.AppStorage.getStatus() : { state: 'idle' });
            var state = detail.state || 'idle';
            var labels = {
                idle: '配置状态未知',
                saving: '正在保存配置',
                unsaved: '配置未保存',
                saved: '配置已保存',
                error: '保存失败 · 点击重试',
            };
            var label = labels[state] || labels.idle;
            [headerStatus, panelStatus].forEach(function (element) {
                if (!element) return;
                element.textContent = label;
                element.dataset.state = state;
                if (state === 'error') element.title = detail.error || '配置保存失败';
            });
            if (retryButton) retryButton.hidden = state !== 'error' && state !== 'unsaved';
        }
        document.addEventListener('fund-tracker-storage-status', function (event) { sync(event.detail); });
        if (headerStatus) headerStatus.addEventListener('click', function () {
            if (window.AppStorage && typeof window.AppStorage.flush === 'function') {
                window.AppStorage.flush().catch(function () {});
            }
        });
        if (retryButton) retryButton.addEventListener('click', function () {
            if (!window.AppStorage || typeof window.AppStorage.flush !== 'function') return;
            retryButton.disabled = true;
            window.AppStorage.flush().catch(function () {}).finally(function () { retryButton.disabled = false; });
        });
        sync();
    }

    function initAboutActions() {
        var githubButtons = document.querySelectorAll('.settings-about-actions [data-external-url]');
        var status = document.getElementById('about-external-status');
        if (!githubButtons.length) return;

        githubButtons.forEach(function (githubBtn) {
            githubBtn.addEventListener('click', async function () {
                if (githubBtn.disabled) return;
                var url = githubBtn.getAttribute('data-external-url');
                if (!url || !window.shell || typeof window.shell.openExternalUrl !== 'function') {
                    if (status) status.textContent = '当前环境无法打开外部链接';
                    return;
                }

                githubBtn.disabled = true;
                if (status) status.textContent = '';
                try {
                    var result = await window.shell.openExternalUrl(url);
                    if (!result || !result.ok) throw new Error('open failed');
                } catch (e) {
                    if (status) status.textContent = 'GitHub 链接打开失败';
                } finally {
                    githubBtn.disabled = false;
                }
            });
        });
    }

    // ============================================================
    // 事件绑定 (settings 控件 + add 按钮 + 编辑按钮 + 刷新按钮)
    // ============================================================

    function bindEvents() {
        var colorModeSelect = document.getElementById('color-mode-select');
        if (colorModeSelect) {
            colorModeSelect.addEventListener('change', function (e) {
                state.colorMode = window.AppTheme
                    ? window.AppTheme.normalizeMode(e.target.value)
                    : normalizeOptionValue(e.target.value, ['light', 'dark', 'system'], 'light');
                e.target.value = state.colorMode;
                if (window.AppTheme) window.AppTheme.setMode(state.colorMode);
                saveSettings();
            });
        }

        var autoRefreshToggle = document.getElementById('auto-refresh-toggle');
        if (autoRefreshToggle) autoRefreshToggle.addEventListener('change', function (e) {
            state.isAutoRefresh = e.target.checked;
            saveSettings();
            if (state.isAutoRefresh) { startAllAutoRefresh(); } else { stopAllAutoRefresh(); }
        });

        var refreshIntervalMain = document.getElementById('refresh-interval-main');
        if (refreshIntervalMain) refreshIntervalMain.addEventListener('change', function (e) {
            state.refreshSecondsMain = parseInt(e.target.value, 10);
            saveSettings();
            if (state.isAutoRefresh) { startMainAutoRefresh(); }
        });

        var refreshIntervalSignal = document.getElementById('refresh-interval-signal');
        if (refreshIntervalSignal) refreshIntervalSignal.addEventListener('change', function (e) {
            state.refreshSecondsSignal = parseInt(e.target.value, 10);
            saveSettings();
            if (state.isAutoRefresh) { startSignalAutoRefresh(); }
        });

        var refreshIntervalNews = document.getElementById('refresh-interval-news');
        if (refreshIntervalNews) refreshIntervalNews.addEventListener('change', function (e) {
            state.refreshSecondsNews = parseInt(e.target.value, 10);
            saveSettings();
            if (state.isAutoRefresh) { startNewsAutoRefresh(); }
        });

        var alertEnabledToggle = document.getElementById('alert-enabled-toggle');
        if (alertEnabledToggle) alertEnabledToggle.addEventListener('change', function (e) {
            state.alertEnabled = !!e.target.checked;
            if (window.AppAlerts) window.AppAlerts.saveAlertSettings();
        });

        var alertOpacityInput = document.getElementById('alert-opacity-input');
        var alertOpacityValue = document.getElementById('alert-opacity-value');
        if (alertOpacityInput) {
            alertOpacityInput.addEventListener('input', function (e) {
                state.alertOpacity = Math.max(0.2, Math.min(1, Number(e.target.value) / 100));
                if (alertOpacityValue) alertOpacityValue.textContent = Math.round(state.alertOpacity * 100) + '%';
            });
            alertOpacityInput.addEventListener('change', function () {
                if (window.AppAlerts) window.AppAlerts.saveAlertSettings();
            });
        }

        var bindAlertPreview = function (id, direction) {
            var button = document.getElementById(id);
            if (!button) return;
            button.addEventListener('click', function () {
                if (window.AppAlerts && typeof window.AppAlerts.previewAlert === 'function') {
                    window.AppAlerts.previewAlert(direction);
                }
            });
        };
        bindAlertPreview('preview-bull-alert', 'rising');
        bindAlertPreview('preview-bear-alert', 'falling');

        var thresholdInput = document.getElementById('alert-threshold-input');
        if (thresholdInput) {
            thresholdInput.addEventListener('change', commitThreshold);
        }
        function commitThreshold() {
            var v = parseFloat(thresholdInput.value);
            if (!isFinite(v) || v <= 0) v = 2;
            if (v > 50) v = 50;
            state.alertThreshold = v;
            thresholdInput.value = String(v);
            if (window.AppAlerts) window.AppAlerts.saveAlertSettings();
        }

        var addStockBtn = document.getElementById('add-stock-btn');
        if (addStockBtn) addStockBtn.addEventListener('click', function () {
            if (window.AppWatchlist) window.AppWatchlist.addStockToWatchlist();
        });
        var addWatchTabBtn = document.getElementById('add-watch-tab-btn');
        if (addWatchTabBtn) addWatchTabBtn.addEventListener('click', function () {
            if (window.AppWatchlist) window.AppWatchlist.addWatchTab();
        });
        var stockCodeInput = document.getElementById('stock-code-input');
        if (stockCodeInput) stockCodeInput.addEventListener('keydown', function (e) {
            // 输入法组词期间的 Enter（含 keyCode 229 兼容旧浏览器）是确认候选词，不是提交。
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && window.AppWatchlist) {
                window.AppWatchlist.addStockToWatchlist();
            }
        });
        var refreshBtn = document.getElementById('refresh-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', function () {
            manualRefreshAll();
        });
        var sectorRotationRunBtn = document.getElementById('sector-rotation-run-btn');
        if (sectorRotationRunBtn) {
            sectorRotationRunBtn.addEventListener('click', function () {
                if (window.AppSignals && typeof window.AppSignals.runSectorRotation === 'function') {
                    window.AppSignals.runSectorRotation();
                }
            });
        }


    }

    // ============================================================
    // 自动刷新
    // ============================================================

    function initAutoRefresh() {
        if (state.isAutoRefresh) startAllAutoRefresh();
    }

    function startAllAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.start();
    }

    function stopAllAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.stop();
    }

    function startMainAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.reschedule();
    }

    function startSignalAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.reschedule();
    }

    function startNewsAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.reschedule();
    }

    // ============================================================
    // 加载入口:按市场阶段分支
    // ============================================================

    // 只恢复用户界面结构和信息类缓存；实时行情必须等待 Rust gateway 返回新数据。
    function renderRealtimeFromCache() {
        var anyRendered = false;

        // 自选股名称可以从本地恢复，但价格和涨跌必须等本次 live 请求成功后才显示。
        if (window.AppWatchlist) {
            var codes = window.AppWatchlist.getAllWatchCodes();
            if (codes.length > 0) {
                state.watchQuoteFreshCodes = {};
                window.AppWatchlist.renderWatchlist();
                anyRendered = true;
            }
            if (state.customIndexCodes.length > 0) {
                state.customIndexFreshCodes = {};
                anyRendered = true;
            }
            window.AppWatchlist.renderCustomIndex();
        }

        if (!anyRendered) {
            utils.setLastUpdated('非交易时段 · 暂无缓存');
        }
    }

    // 手动刷新:无视交易时段,重新拉一遍所有数据
    function manualRefreshAll(label, options) {
        options = Object.assign({}, options || {}, { force: true });
        if (utils && typeof utils.setLastUpdated === 'function') utils.setLastUpdated(label || '手动刷新');
        return window.AppRefreshCoordinator
            ? window.AppRefreshCoordinator.refreshAll(options)
            : Promise.resolve();
    }

    function initUiStateRetries() {
        if (!window.AppUiState) return;
        window.AppUiState.bindRetries(document, function (scope, button) {
            var coordinator = window.AppRefreshCoordinator;
            if (!coordinator || !button || button.disabled) return;
            var refresh = {
                all: coordinator.refreshAll,
                main: coordinator.refreshMain,
                news: coordinator.refreshNews,
                signals: coordinator.refreshSignals,
            }[scope];
            if (typeof refresh !== 'function') return;
            var originalText = button.textContent;
            button.disabled = true;
            button.textContent = '加载中';
            Promise.resolve(refresh.call(coordinator, { force: true })).finally(function () {
                if (!button.isConnected) return;
                button.disabled = false;
                button.textContent = originalText;
            });
        });
    }

    // ============================================================
    // DOMContentLoaded — 启动入口
    // ============================================================

    function bootstrapApp() {
        loadSettings();
        initTabs();
        initCollapsible();
        initSectorTabs();
        initSignalWorkspace();
        initSettingsViews();
        if (window.AppResearch) window.AppResearch.init();
        if (window.AppPriceAlerts) window.AppPriceAlerts.init();
        if (window.AppReports) window.AppReports.init();
        if (window.AppSignals) window.AppSignals.initHotRankTabs();
        if (window.AppWatchlist) window.AppWatchlist.initWatchlistTabs();
        if (window.AppNews) {
            window.AppNews.initNewsSourceTabs();
            window.AppNews.initNewsScroll();
        }
        initSettings();
        syncSettingsControls();
        initDataActions();
        initStorageStatus();
        initAboutActions();
        bindEvents();
        initUiStateRetries();
        if (window.AppWatchlist) window.AppWatchlist.initStockFundFlowModal();
        if (window.AppSignals) window.AppSignals.initLimitUpTabs();
        initAutoRefresh();
        if (window.AppWatchlist) window.AppWatchlist.renderCustomIndex();
        // 页面初始化:先渲染本地缓存,再复用手动刷新入口请求一次最新数据。
        renderRealtimeFromCache();
        manualRefreshAll('启动刷新');
    }

    document.addEventListener('DOMContentLoaded', function () {
        var hydrate = window.AppStorage && typeof window.AppStorage.hydrate === 'function'
            ? window.AppStorage.hydrate()
            : Promise.resolve();
        hydrate.then(function () {
            if (window.AppState && typeof window.AppState.restorePersistentState === 'function') {
                window.AppState.restorePersistentState();
            }
            bootstrapApp();
        });
    });
})();
