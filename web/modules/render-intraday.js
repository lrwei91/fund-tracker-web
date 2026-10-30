// 盘中盯盘增强：昨日梯队（昨日涨停梯队今日实时表现）+ 盘中异动流。
// 数据来自服务端 /intraday；面板可见时每 30 秒刷新，隐藏时不请求。
(function () {
    var utils = window.AppUtils;
    var ladderView = { data: null, loading: false, error: false, loadedAt: 0 };
    var anomalyView = { data: null, loading: false, error: false, loadedAt: 0 };

    async function fetchIntraday(action) {
        var res = await window.AppDataClient.fetch('/intraday', { action: action }, { force: true, cacheMode: 'bypass_fresh' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success) throw new Error(json.message || '盘中数据暂不可用');
        return json.data || {};
    }

    function pctText(pct) {
        if (pct === null || pct === undefined || !isFinite(pct)) return '—';
        return (pct > 0 ? '+' : '') + Number(pct).toFixed(2) + '%';
    }
    function pctClass(pct) {
        if (pct === null || pct === undefined || !isFinite(pct) || pct === 0) return '';
        return pct > 0 ? ' is-up' : ' is-down';
    }
    function statusClass(status) {
        if (status === '涨停') return ' is-limit';
        if (status === '跌停') return ' is-dlimit';
        if (status === '红盘') return ' is-up';
        if (status === '绿盘') return ' is-down';
        return '';
    }

    function renderLadder() {
        var root = document.getElementById('ladder-watch-root');
        if (!root) return;
        var d = ladderView.data;
        if (!d) {
            if (!ladderView.loading) {
                root.innerHTML = '<p class="intraday-note">' + (ladderView.error ? '梯队数据暂不可用，稍后自动重试。' : '暂无数据。') + '</p>';
            }
            return;
        }
        var s = d.summary || {};
        var html = '<p class="intraday-note">基准日 ' + utils.escapeHtml(d.baseDate || '') + ' 的涨停梯队（' + d.total + ' 只，已取行情 ' + d.quoted + ' 只）' +
            ' · 今日再涨停 ' + (s.limitUp ?? 0) + ' 只 · 红盘率 ' + (s.upRate ?? '—') + '% · 平均 ' + pctText(s.avgPct) + ' · 跌停 ' + (s.downLimit ?? 0) + ' 只</p>';
        (d.groups || []).forEach(function (g) {
            html += '<div class="intraday-group"><div class="intraday-group-head"><strong>' + g.level + ' 板</strong><span>' + g.count + ' 只 · 再涨停 ' + g.limitUp + ' · 红盘率 ' + (g.upRate ?? '—') + '% · 平均 ' + pctText(g.avgPct) + '</span></div>';
            html += '<div class="intraday-rows">';
            (g.stocks || []).forEach(function (r) {
                html += '<div class="intraday-row"><span class="intraday-name">' + utils.escapeHtml(r.name || '') + ' <small>' + utils.escapeHtml(r.code || '') + '</small></span>' +
                    '<span class="intraday-ind">' + utils.escapeHtml(r.industry || '') + '</span>' +
                    '<span class="intraday-price">' + (r.price !== null && r.price !== undefined ? Number(r.price).toFixed(2) : '—') + '</span>' +
                    '<span class="intraday-pct' + pctClass(r.pct) + '">' + pctText(r.pct) + '</span>' +
                    '<span class="intraday-status' + statusClass(r.status) + '">' + utils.escapeHtml(r.status || '') + '</span></div>';
            });
            html += '</div></div>';
        });
        root.innerHTML = html;
    }

    function renderAnomalies() {
        var root = document.getElementById('anomaly-root');
        if (!root) return;
        var d = anomalyView.data;
        if (!d) {
            if (!anomalyView.loading) {
                root.innerHTML = '<p class="intraday-note">' + (anomalyView.error ? '异动数据暂不可用，稍后自动重试。' : '暂无数据。') + '</p>';
            }
            return;
        }
        var events = d.events || [];
        var html = '<p class="intraday-note">监控 ' + (d.monitorCount ?? '—') + ' 只（自选/持仓 + 昨日梯队），30 秒差分：急拉/急跌（约 3 分钟 ±1.5%）、封板、开板；同股同类 5 分钟内不重复。非交易时段显示当日已记录事件。</p>';
        if (!events.length) {
            html += '<p class="intraday-note">暂无异动记录。</p>';
        } else {
            html += '<div class="intraday-rows">';
            events.forEach(function (ev) {
                var cls = ev.type === '急拉' || ev.type === '封板' ? ' is-up' : (ev.type === '急跌' || ev.type === '开板' ? ' is-down' : '');
                html += '<div class="intraday-row"><span class="intraday-time">' + utils.escapeHtml(ev.time || '') + '</span>' +
                    '<span class="intraday-name">' + utils.escapeHtml(ev.name || '') + ' <small>' + utils.escapeHtml(ev.code || '') + '</small></span>' +
                    '<span class="intraday-type' + cls + '">' + utils.escapeHtml(ev.type || '') + '</span>' +
                    '<span class="intraday-detail">' + utils.escapeHtml(ev.detail || '') + '</span>' +
                    '<span class="intraday-pct' + pctClass(ev.pct) + '">' + pctText(ev.pct) + '</span></div>';
            });
            html += '</div>';
        }
        root.innerHTML = html;
    }

    async function refreshLadder() {
        if (ladderView.loading) return;
        ladderView.loading = true;
        try {
            ladderView.data = await fetchIntraday('ladder');
            ladderView.error = false;
            ladderView.loadedAt = Date.now();
        } catch (error) {
            console.error('昨日梯队加载失败:', error);
            ladderView.error = true;
        } finally {
            ladderView.loading = false;
            renderLadder();
        }
    }

    async function refreshAnomalies() {
        if (anomalyView.loading) return;
        anomalyView.loading = true;
        try {
            anomalyView.data = await fetchIntraday('anomalies');
            anomalyView.error = false;
            anomalyView.loadedAt = Date.now();
        } catch (error) {
            console.error('盘中异动加载失败:', error);
            anomalyView.error = true;
        } finally {
            anomalyView.loading = false;
            renderAnomalies();
        }
    }

    function panelVisible(name) {
        var panel = document.querySelector('[data-signal-panel="' + name + '"]');
        return !!panel && !panel.hidden;
    }

    // 面板被切到时立即加载；可见期间每 5 秒检查、数据超过 25 秒就刷新。
    setInterval(function () {
        if (panelVisible('ladder') && Date.now() - ladderView.loadedAt > 25000) refreshLadder();
        if (panelVisible('anomaly') && Date.now() - anomalyView.loadedAt > 25000) refreshAnomalies();
    }, 5000);

    window.AppIntraday = { refreshLadder: refreshLadder, refreshAnomalies: refreshAnomalies };
})();
