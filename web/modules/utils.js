// ================================================================
// 公共工具 — escapeHtml / 时间格式化 / 元单位换算 / apiUrl
// 暴露到 window.AppUtils;直接 script 引入,无需 import/require
// ================================================================

(function () {
    var API_BASE = '/api';

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isEtf(code, name) {
        var normalizedName = String(name || '').toUpperCase();
        if (normalizedName.indexOf('ETF') !== -1) return true;
        return /^(159|510|511|512|513|515|516|517|518|560|561|562|563|588)\d{3}$/.test(String(code || '').trim());
    }

    function formatQuotePrice(value, fallback, code, name) {
        var source = value;
        if (source === null || source === undefined || source === '') source = fallback;
        if (source === null || source === undefined || source === '') return '--';
        var number = Number(source);
        if (!Number.isFinite(number)) return String(source);
        return number.toFixed(isEtf(code, name) ? 3 : 2);
    }

    // 元 → 亿/万 文本。yuan 可为正负/0;0 / null / undefined 一律返回 '0'
    // 与 app.js 原 3 处内联 fmtYuan/fmtYi 行为完全等价
    function formatYuan(yuan) {
        if (!yuan) return '0';
        var abs = Math.abs(yuan);
        var sign = yuan > 0 ? '+' : yuan < 0 ? '-' : '';
        if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿';
        if (abs >= 1e4) return sign + (abs / 1e4).toFixed(0) + '万';
        return sign + abs.toFixed(0);
    }

    function apiUrl(path, params) {
        var query = new URLSearchParams(params || {});
        query.set('_t', Date.now().toString());
        return API_BASE + path + '?' + query.toString();
    }

    function formatShanghaiTime(timestamp) {
        if (!timestamp) return '';
        var date = new Date(timestamp);
        if (isNaN(date.getTime())) return '';
        return date.toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function getShanghaiNow() {
        var parts = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(new Date()).reduce(function (acc, part) {
            acc[part.type] = part.value;
            return acc;
        }, {});
        var weekday = parts.weekday || '';
        var hour = parseInt(parts.hour || '0', 10);
        var minute = parseInt(parts.minute || '0', 10);
        return { weekday: weekday, minutes: hour * 60 + minute };
    }

    function getShanghaiDateKey() {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());
    }

    // 头部 "已更新 · HH:mm:ss" 状态条
    function setLastUpdated(label, time) {
        var el = document.getElementById('last-updated');
        if (!el) return;
        var display = time || new Date().toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        el.textContent = (label || '已更新') + ' · ' + display;
    }

    // 空态 HTML,escapeHtml 由本模块提供
    function renderEmpty(message) {
        return '<div class="empty-state">' + escapeHtml(message) + '</div>';
    }

    // 周一-周五判定(简中 weekday 字符串)
    function isTradingWeekday(weekday) {
        return ['周一', '周二', '周三', '周四', '周五'].includes(weekday);
    }

    // 交易时段:9:15-11:30 / 13:00-15:05
    function isIntradayRefreshWindow() {
        var now = getShanghaiNow();
        if (!isTradingWeekday(now.weekday)) return false;
        return (now.minutes >= 9 * 60 + 15 && now.minutes <= 11 * 60 + 30) ||
            (now.minutes >= 13 * 60 && now.minutes <= 15 * 60 + 5);
    }

    // 开盘连续交易时段:9:30-11:30 / 13:00-15:00
    function isMarketOpenWindow() {
        var now = getShanghaiNow();
        if (!isTradingWeekday(now.weekday)) return false;
        return (now.minutes >= 9 * 60 + 30 && now.minutes <= 11 * 60 + 30) ||
            (now.minutes >= 13 * 60 && now.minutes <= 15 * 60);
    }

    // 收盘后日级窗口:16:00-21:00
    function isAfterCloseDailyWindow() {
        var now = getShanghaiNow();
        if (!isTradingWeekday(now.weekday)) return false;
        return now.minutes >= 16 * 60 && now.minutes <= 21 * 60;
    }

    // 收盘后日级门禁:16:00 后即可更新日级数据
    function isAfterCloseForDailyUpdate() {
        var now = getShanghaiNow();
        if (!isTradingWeekday(now.weekday)) return false;
        return now.minutes >= 16 * 60;
    }

    window.AppUtils = {
        escapeHtml: escapeHtml,
        formatYuan: formatYuan,
        isEtf: isEtf,
        formatQuotePrice: formatQuotePrice,
        apiUrl: apiUrl,
        formatShanghaiTime: formatShanghaiTime,
        getShanghaiNow: getShanghaiNow,
        getShanghaiDateKey: getShanghaiDateKey,
        setLastUpdated: setLastUpdated,
        renderEmpty: renderEmpty,
        isTradingWeekday: isTradingWeekday,
        isIntradayRefreshWindow: isIntradayRefreshWindow,
        isMarketOpenWindow: isMarketOpenWindow,
        isAfterCloseDailyWindow: isAfterCloseDailyWindow,
        isAfterCloseForDailyUpdate: isAfterCloseForDailyUpdate,
    };
})();
