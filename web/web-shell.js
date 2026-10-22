// Web 版 shell：以 HTTP + SSE + BroadcastChannel 复刻 tauri-shell.js 的 window.shell 接口。
(function () {
    'use strict';

    function httpJson(method, url, body) {
        return fetch(url, {
            method: method,
            headers: body != null ? { 'content-type': 'application/json' } : {},
            body: body != null ? JSON.stringify(body) : undefined,
        }).then(function (res) {
            if (res.status === 401) {
                // 会话失效：回登录页
                if (location.pathname !== '/login.html') location.href = '/';
                throw new Error('未登录');
            }
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error((data && data.message) || ('请求失败 ' + res.status));
                return data;
            });
        });
    }

    // ---- 本地订阅注册表（报告打开等本地事件）----
    var localSubscribers = {};
    function subscribeLocal(event, callback) {
        (localSubscribers[event] = localSubscribers[event] || []).push(callback);
        return function () {
            var list = localSubscribers[event] || [];
            var i = list.indexOf(callback);
            if (i >= 0) list.splice(i, 1);
        };
    }
    function dispatchLocal(event, payload) {
        (localSubscribers[event] || []).slice().forEach(function (cb) {
            try { cb(payload); } catch (e) { /* ignore */ }
        });
    }

    // ---- SSE：服务端事件（价格提醒命中、报告状态等）----
    var sseSubscribers = {};
    var es = null;
    var SSE_EVENTS = ['price-alert-hit', 'price-alert-error', 'research-report-state', 'research-report-notice', 'research-report-open', 'stock-alert'];
    function ensureSse() {
        if (es) return;
        try { es = new EventSource('/api/events'); } catch (e) { return; }
        SSE_EVENTS.forEach(function (event) {
            es.addEventListener(event, function (message) {
                var payload = null;
                try { payload = JSON.parse(message.data); } catch (e) { /* ignore */ }
                (sseSubscribers[event] || []).slice().forEach(function (cb) {
                    try { cb(payload); } catch (e) { /* ignore */ }
                });
                dispatchLocal(event, payload);
            });
        });
    }
    function subscribe(event, callback) {
        ensureSse();
        (sseSubscribers[event] = sseSubscribers[event] || []).push(callback);
        return function () {
            var list = sseSubscribers[event] || [];
            var i = list.indexOf(callback);
            if (i >= 0) list.splice(i, 1);
        };
    }

    // ---- 持仓浮窗（独立小窗口 + BroadcastChannel 同步）----
    var widgetWindow = null;
    var channel = null;
    try { channel = new BroadcastChannel('ft-holding-widget'); } catch (e) { channel = null; }
    if (channel) {
        channel.onmessage = function (message) {
            var data = message.data || {};
            if (data.type === 'visibility') dispatchLocal('holding-widget-visibility', { visible: !!data.visible });
            if (data.type === 'open-detail' && data.code) {
                if (window.AppWorkbench && typeof window.AppWorkbench.openDetail === 'function') {
                    window.AppWorkbench.openDetail(data.code);
                    window.focus();
                }
            }
        };
    }

    window.shell = {
        openHoldingWindow: function () {
            widgetWindow = window.open('/widget.html', 'ft-holding-widget', 'width=370,height=540,resizable=yes');
            if (widgetWindow) widgetWindow.focus();
            return Promise.resolve();
        },
        minimizeHoldingWindow: function () { return Promise.resolve(); },
        maximizeHoldingWindow: function () { return Promise.resolve(); },
        closeHoldingWindow: function () {
            if (widgetWindow && !widgetWindow.closed) widgetWindow.close();
            return Promise.resolve();
        },
        syncHoldingWidget: function (state) {
            try { localStorage.setItem('ft_holding_widget_state', JSON.stringify(state || {})); } catch (e) { /* ignore */ }
            if (channel) { try { channel.postMessage({ type: 'holding-state', state: state || {} }); } catch (e) { /* ignore */ } }
            return Promise.resolve();
        },
        showStockAlert: function (alert) {
            // 网页版：尝试系统通知，随后返回 ok:false 让前端走站内 toast 兜底（保证不漏提醒）
            try {
                if ('Notification' in window && Notification.permission === 'granted' && alert) {
                    var title = (alert.name || alert.code || '自选提醒');
                    var body = '现价 ' + (alert.price != null ? alert.price : '--')
                        + '，涨跌幅 ' + (alert.changePct != null ? Number(alert.changePct).toFixed(2) + '%' : '--');
                    new Notification(title, { body: body, tag: 'stock-alert-' + (alert.code || '') });
                }
            } catch (e) { /* ignore */ }
            dispatchLocal('stock-alert', alert);
            return Promise.resolve({ ok: false, web: true });
        },
        aiSettingsStatus: function () { return httpJson('GET', '/api/ai/status'); },
        aiSettingsSave: function (options, apiKey, clearKey) {
            return httpJson('POST', '/api/ai/save', { options: options, apiKey: apiKey || null, clearKey: !!clearKey });
        },
        onReportState: function (callback) { return subscribe('research-report-state', callback); },
        onReportOpen: function (callback) { return subscribeLocal('research-report-open', callback); },
        onReportNotice: function (callback) { return subscribe('research-report-notice', callback); },
        openReport: function (id) {
            dispatchLocal('research-report-open', { id: id });
            return Promise.resolve();
        },
        onPriceAlertHit: function (callback) { return subscribe('price-alert-hit', callback); },
        onPriceAlertError: function (callback) { return subscribe('price-alert-error', callback); },
        getConfigPath: function () { return Promise.resolve('服务器端 config.json'); },
        openExternalUrl: function (url) { window.open(url, '_blank', 'noopener'); return Promise.resolve(); },
        configStorage: {
            load: function () { return httpJson('GET', '/api/config'); },
            patch: function (changes) { return httpJson('POST', '/api/config/patch', { changes: changes || {} }); },
        },
        onHoldingWidgetRefresh: function (callback) { return subscribeLocal('holding-widget-refresh', callback); },
        onHoldingWidgetState: function (callback) { return subscribeLocal('holding-widget-state', callback); },
        onHoldingWidgetVisibility: function (callback) { return subscribeLocal('holding-widget-visibility', callback); },
        onStockAlert: function (callback) { return subscribeLocal('stock-alert', callback); },
    };

    // 提醒权限：首次交互后申请一次浏览器通知权限
    document.addEventListener('pointerdown', function askOnce() {
        document.removeEventListener('pointerdown', askOnce);
        try {
            if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(function () {});
        } catch (e) { /* ignore */ }
    });
})();
