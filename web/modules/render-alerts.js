// ================================================================
// 涨跌幅告警 + 通用 status toast
// 暴露到 window.AppAlerts;
// 直接 script 引入,无需 import/require
// 依赖:window.AppState, window.AppUtils, window.AppCache
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var KEYS = state.KEYS;

    // ============================================================
    // 设置 / 持久化
    // ============================================================

    function saveAlertSettings() {
        try {
            window.AppStorage.setItem(KEYS.ALERT_SETTINGS_KEY, JSON.stringify({
                enabled: state.alertEnabled,
                threshold: state.alertThreshold,
                opacity: state.alertOpacity,
                bullSoundEnabled: state.bullSoundEnabled,
                bearSoundEnabled: state.bearSoundEnabled,
            }));
        } catch (e) {}
    }

    function saveWatchAlertState() {
        try {
            var payload = Object.assign({ __v: KEYS.WATCH_ALERT_SCHEMA_VERSION }, state.watchAlertState);
            window.AppStorage.setItem(KEYS.WATCH_ALERT_STATE_KEY, JSON.stringify(payload));
        } catch (e) {}
    }

    // ============================================================
    // 告警 toast (涨跌方向)
    // ============================================================

    function formatAlertPrice(value) {
        return typeof value === 'number' && value > 0 ? value.toFixed(2) : '--';
    }

    function formatAlertPct(value, withSign) {
        if (typeof value !== 'number') return '--';
        var prefix = withSign && value > 0 ? '+' : '';
        return prefix + value.toFixed(2) + '%';
    }

    function appendAlertMetric(container, label, value, className) {
        var item = document.createElement('span');
        item.className = 'alert-toast-metric' + (className ? ' ' + className : '');

        var labelSpan = document.createElement('span');
        labelSpan.className = 'alert-toast-metric-label';
        labelSpan.textContent = label;

        var valueSpan = document.createElement('span');
        valueSpan.className = 'alert-toast-metric-value';
        valueSpan.textContent = value;

        item.appendChild(labelSpan);
        item.appendChild(valueSpan);
        container.appendChild(item);
    }

    function renderAlertToast(alert) {
        var container = document.getElementById('alert-toast-container');
        if (!container) return;
        if (!alert || typeof alert.price !== 'number') return;
        if (typeof utils.isMarketOpenWindow === 'function' && !utils.isMarketOpenWindow()) return;

        // 限制最大条数,超过则移除最早
        while (container.children.length >= KEYS.ALERT_TOAST_MAX) {
            var first = container.firstChild;
            if (!first) break;
            removeAlertToast(first, true);
        }

        var directionLabel = alert.changePct >= 0 ? '▲ 涨' : '▼ 跌';
        var dirClass = alert.changePct >= 0 ? 'alert-up' : 'alert-down';
        var pctClass = alert.changePct >= 0 ? 'positive' : 'negative';
        var pctText = formatAlertPct(alert.changePct, true);
        var thresholdText = '±' + formatAlertPct(alert.threshold, false);
        var timeText = new Date(alert.time).toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });

        var toast = document.createElement('div');
        toast.className = 'alert-toast ' + dirClass;
        toast.setAttribute('data-code', alert.code);

        var main = document.createElement('div');
        main.className = 'alert-toast-main';

        var title = document.createElement('div');
        title.className = 'alert-toast-title';
        var dirSpan = document.createElement('span');
        dirSpan.className = 'alert-toast-direction';
        dirSpan.textContent = directionLabel;
        var nameSpan = document.createElement('span');
        nameSpan.className = 'alert-toast-name';
        nameSpan.textContent = alert.name;
        var codeSpan = document.createElement('span');
        codeSpan.className = 'alert-toast-code';
        codeSpan.textContent = alert.code;
        title.appendChild(dirSpan);
        title.appendChild(nameSpan);
        title.appendChild(codeSpan);

        var detail = document.createElement('div');
        detail.className = 'alert-toast-detail';
        var baseLabel = alert.baseLabel || (alert.baseIsTrigger ? '触发价' : '基准');
        appendAlertMetric(detail, '当前', formatAlertPrice(alert.price), 'alert-toast-price');
        appendAlertMetric(detail, '开盘', formatAlertPrice(alert.openPrice));
        appendAlertMetric(detail, '涨跌', pctText, 'alert-toast-pct ' + pctClass);
        appendAlertMetric(detail, '阈值', thresholdText);
        appendAlertMetric(detail, baseLabel, formatAlertPrice(alert.basePrice));

        var timeDiv = document.createElement('div');
        timeDiv.className = 'alert-toast-time';
        timeDiv.textContent = '触发时间 ' + timeText;

        main.appendChild(title);
        main.appendChild(detail);
        main.appendChild(timeDiv);

        var closeBtn = document.createElement('button');
        closeBtn.className = 'alert-toast-close';
        closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', function () { removeAlertToast(toast); });

        toast.appendChild(main);
        toast.appendChild(closeBtn);

        var timerId = setTimeout(function () { removeAlertToast(toast); }, KEYS.ALERT_TOAST_TTL_MS);
        toast.__alertTimer = timerId;

        container.appendChild(toast);
    }

    function pushAlertToast(alert) {
        if (window.shell && typeof window.shell.showStockAlert === 'function') {
            var desktopAlert = Object.assign({}, alert, {
                opacity: state.alertOpacity,
                soundEnabled: alert.changePct >= 0 ? state.bullSoundEnabled : state.bearSoundEnabled,
            });
            window.shell.showStockAlert(desktopAlert).then(function (result) {
                if (!result || result.ok !== true) renderAlertToast(alert);
            }).catch(function () { renderAlertToast(alert); });
            return;
        }
        renderAlertToast(alert);
    }

    function previewAlert(direction) {
        var rising = direction !== 'falling';
        var basePrice = 10;
        var changePct = rising ? state.alertThreshold : -state.alertThreshold;
        pushAlertToast({
            code: 'DEMO',
            name: '提醒测试',
            price: basePrice * (1 + changePct / 100),
            openPrice: basePrice,
            marketChangePct: changePct,
            changePct: changePct,
            basePrice: basePrice,
            baseLabel: '基准价',
            threshold: state.alertThreshold,
            time: new Date().toISOString(),
        });
    }

    function removeAlertToast(toast, immediate) {
        if (!toast || !toast.parentNode) return;
        if (toast.__alertTimer) {
            clearTimeout(toast.__alertTimer);
            toast.__alertTimer = null;
        }
        if (immediate) {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
            return;
        }
        toast.classList.add('removing');
        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 200);
    }

    // ============================================================
    // 通用 status toast (复用 alert-toast 容器,带 200ms 淡出)
    // ============================================================

    function showStatusToast(message, type) {
        var container = document.getElementById('alert-toast-container');
        if (!container) return;
        if (!message) return;

        while (container.children.length >= KEYS.ALERT_TOAST_MAX) {
            var first = container.firstChild;
            if (!first) break;
            removeAlertToast(first, true);
        }

        var variant = type === 'error' ? 'alert-down' : 'alert-info';
        var timeText = new Date().toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });

        var toast = document.createElement('div');
        toast.className = 'alert-toast ' + variant;

        var main = document.createElement('div');
        main.className = 'alert-toast-main';

        var title = document.createElement('div');
        title.className = 'alert-toast-title';
        var textSpan = document.createElement('span');
        textSpan.className = 'alert-toast-name';
        textSpan.textContent = message;
        title.appendChild(textSpan);

        var timeDiv = document.createElement('div');
        timeDiv.className = 'alert-toast-time';
        timeDiv.textContent = timeText;

        main.appendChild(title);
        main.appendChild(timeDiv);

        var closeBtn = document.createElement('button');
        closeBtn.className = 'alert-toast-close';
        closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', function () { removeAlertToast(toast); });

        toast.appendChild(main);
        toast.appendChild(closeBtn);

        var timerId = setTimeout(function () { removeAlertToast(toast); }, KEYS.STATUS_TOAST_TTL_MS);
        toast.__alertTimer = timerId;

        container.appendChild(toast);
    }

    // ============================================================
    // checkAlerts
    // quotes 形如 { [code]: { name, priceValue, openPrice, ... } }
    // 基准价优先级:lastTriggerPrice(触发后) > addedPrice(盘中新加) > openPrice(今开)
    // 跨模块依赖:window.AppWatchlist.getWatchTabs / isFixedWatchTab
    // ============================================================

    function checkAlerts(quotes) {
        if (!state.alertEnabled) return;
        if (typeof utils.isMarketOpenWindow === 'function' && !utils.isMarketOpenWindow()) return;
        if (!quotes || typeof quotes !== 'object') return;
        var watchlistMod = window.AppWatchlist;
        if (!watchlistMod || typeof watchlistMod.getWatchTabs !== 'function') return;

        var todayKey = utils.getShanghaiDateKey();
        var triggered = [];
        var stateChanged = false;

        // 只监控持仓股(default);候选股和其他自建分组一律不告警
        var watchTabs = watchlistMod.getWatchTabs();
        var monitoredCodeSet = {};
        var holdingTab = watchTabs.find(function (tab) { return tab && tab.id === 'default'; });
        if (holdingTab && Array.isArray(holdingTab.codes)) {
            holdingTab.codes.forEach(function (c) { monitoredCodeSet[c] = true; });
        }

        Object.keys(quotes).forEach(function (code) {
            if (!monitoredCodeSet[code]) return;
            var d = quotes[code];
            if (!d) return;
            var price = typeof d.priceValue === 'number' ? d.priceValue : null;
            if (price === null || price <= 0) return;

            var openPrice = (typeof d.openPrice === 'number' && d.openPrice > 0) ? d.openPrice : null;

            var stateEntry = state.watchAlertState[code];
            if (!stateEntry) {
                state.watchAlertState[code] = {
                    openDate: todayKey,
                    openPrice: openPrice,
                    lastTriggerPrice: null,
                    lastTriggerTime: null,
                };
                stateChanged = true;
                return;
            }

            if (stateEntry.openDate !== todayKey) {
                stateEntry.openDate = todayKey;
                stateEntry.openPrice = openPrice;
                stateEntry.addedPrice = null;
                stateEntry.addedAt = null;
                stateEntry.pendingAdd = false;
                stateEntry.lastTriggerPrice = null;
                stateEntry.lastTriggerTime = null;
                stateChanged = true;
            } else if (stateEntry.pendingAdd === true) {
                stateEntry.addedPrice = price;
                stateEntry.addedAt = Date.now();
                stateEntry.pendingAdd = false;
                stateChanged = true;
            } else if (stateEntry.openPrice == null && stateEntry.addedPrice == null && openPrice != null) {
                stateEntry.openPrice = openPrice;
                stateChanged = true;
            }

            var base = stateEntry.lastTriggerPrice || stateEntry.addedPrice || stateEntry.openPrice;
            if (!base || base <= 0) return;
            var changePct = (price - base) / base * 100;
            if (Math.abs(changePct) >= state.alertThreshold) {
                var baseLabel = stateEntry.lastTriggerPrice ? '触发价'
                              : (stateEntry.addedPrice ? '添加价' : '开盘价');
                stateEntry.lastTriggerPrice = price;
                stateEntry.lastTriggerTime = new Date().toISOString();
                stateChanged = true;
                triggered.push({
                    code: code,
                    name: d.name || code,
                    price: price,
                    openPrice: stateEntry.openPrice,
                    marketChangePct: typeof d.changePercent === 'number' ? d.changePercent : null,
                    changePct: changePct,
                    basePrice: base,
                    baseLabel: baseLabel,
                    threshold: state.alertThreshold,
                    time: stateEntry.lastTriggerTime,
                });
            }
        });

        if (stateChanged) saveWatchAlertState();
        triggered.forEach(pushAlertToast);
    }

    window.AppAlerts = {
        saveAlertSettings: saveAlertSettings,
        saveWatchAlertState: saveWatchAlertState,
        pushAlertToast: pushAlertToast,
        removeAlertToast: removeAlertToast,
        showStatusToast: showStatusToast,
        previewAlert: previewAlert,
        checkAlerts: checkAlerts,
    };
})();
