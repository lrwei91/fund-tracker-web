// Web 版 shell：以 HTTP + SSE 复刻桌面版 tauri-shell.js 的 window.shell 接口。
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
    var sseOnline = null;
    var sseRetryDelay = 5000;
    var sseRetryTimer = null;
    var SSE_EVENTS = ['price-alert-hit', 'price-alert-error', 'research-report-state', 'research-report-notice', 'research-report-open', 'stock-alert'];
    // 连接状态提示：断线时在顶栏给出「重连中」，避免提醒事件静默丢失而无感知。
    function setSseStatus(online) {
        if (sseOnline === online) return;
        sseOnline = online;
        var el = document.getElementById('sse-status');
        if (!el) {
            var host = document.querySelector('.header-right');
            if (!host) return;
            el = document.createElement('span');
            el.id = 'sse-status';
            el.className = 'sse-status';
            host.insertBefore(el, host.firstChild);
        }
        if (online) {
            el.textContent = '';
            el.removeAttribute('title');
        } else {
            el.textContent = '实时连接中断 · 重连中';
            el.title = '服务端事件连接断开，提醒推送将延迟到恢复后';
        }
        el.classList.toggle('offline', online === false);
    }
    function scheduleSseRetry() {
        if (sseRetryTimer) return;
        sseRetryTimer = setTimeout(function () {
            sseRetryTimer = null;
            ensureSse();
        }, sseRetryDelay);
        sseRetryDelay = Math.min(30000, sseRetryDelay * 2);
    }
    function ensureSse() {
        if (es) return;
        try { es = new EventSource('/api/events'); } catch (e) { scheduleSseRetry(); return; }
        es.onopen = function () {
            sseRetryDelay = 5000;
            setSseStatus(true);
        };
        es.onerror = function () {
            setSseStatus(false);
            // readyState=CLOSED 表示浏览器原生重连已放弃（常见于会话失效或服务重启）：
            // 探一次登录态，已登录则退避重建连接，未登录回登录页。
            if (es && es.readyState === 2) {
                es.close();
                es = null;
                fetch('/api/auth/status').then(function (res) { return res.json(); }).then(function (status) {
                    if (!status || !status.authed) {
                        if (location.pathname !== '/login.html') location.href = '/';
                        return;
                    }
                    scheduleSseRetry();
                }).catch(function () { scheduleSseRetry(); });
                return;
            }
            // readyState=CONNECTING：浏览器自动重连，等 onopen 恢复提示即可。
        };
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

    window.shell = {
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
        onStockAlert: function (callback) { return subscribeLocal('stock-alert', callback); },
    };

    // 当前用户标识 + 切换用户（退出登录）：挂在顶栏右侧
    function initUserChip() {
        var host = document.querySelector('.header-right');
        if (!host || document.getElementById('user-chip')) return;
        fetch('/api/auth/status').then(function (res) { return res.json(); }).then(function (status) {
            if (!status || !status.authed || !status.username) return;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'user-chip';
            btn.className = 'header-btn user-chip';
            btn.textContent = status.username;
            btn.title = '当前用户 ' + status.username + '，点击退出并切换用户';
            btn.addEventListener('click', function () {
                btn.disabled = true;
                fetch('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; })
                    .catch(function () { location.href = '/'; });
            });
            host.insertBefore(btn, host.firstChild);
        }).catch(function () { /* ignore */ });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUserChip);
    else initUserChip();

    // 提醒权限：首次交互后申请一次浏览器通知权限
    document.addEventListener('pointerdown', function askOnce() {
        document.removeEventListener('pointerdown', askOnce);
        try {
            if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(function () {});
        } catch (e) { /* ignore */ }
    });
})();
