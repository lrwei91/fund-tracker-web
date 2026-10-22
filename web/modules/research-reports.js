// Native report center: opening, refreshing and reading never call a model.
(function () {
    var host, currentId = null, detailVersion = 0, loading = null;
    var labels = { queued: '排队中', collecting: '收集资料', analyzing: '生成中', completed: '已完成', partial: '部分覆盖', failed: '失败', missed: '已错过', interrupted: '已中断', cancelled: '已取消' };
    var lastData = null, notified = new Set();
    var active = ['queued', 'collecting', 'analyzing'];
    function esc(value) { return window.AppUtils.escapeHtml(value == null ? '' : String(value)); }
    function title(slot) { return slot === 'premarket' ? '盘前报告' : '盘后报告'; }
    function time(value) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '--'; }
    async function request(query) { var result = await window.AppDataClient.fetchData('/research-reports', query || {}); return result.data; }
    function status(text) { var node = host && host.querySelector('[data-report-status]'); if (node) node.textContent = text || ''; }
    function list(data) {
        lastData = data;
        host.querySelector('[name="premarket"]').checked = !!data.settings.premarket;
        host.querySelector('[name="afterClose"]').checked = !!data.settings.afterClose;
        host.querySelector('[data-calendar-status]').textContent = data.calendarKnown
            ? '交易日历：2025–2026 · 北京时间' : '交易日历待更新：自动报告暂停';
        var items = data.items || [];
        host.querySelector('[data-report-list]').innerHTML = items.length ? items.map(function (row) {
            var busy = active.indexOf(row.status) !== -1;
            return '<div class="report-row"><div><strong>' + esc(row.tradeDate) + ' · ' + title(row.slot) + '</strong> <span class="report-tag">' + esc(labels[row.status] || row.status) + (row.read ? '' : ' · 未读') + '</span><small>' + esc(row.message) + ' · ' + (row.automatic ? '自动任务' : '手动任务') + '</small></div><div class="report-actions"><button type="button" class="report-button" data-report-open="' + esc(row.id) + '">' + (busy ? '查看进度' : '查看记录') + '</button>' +
                (['queued', 'collecting'].indexOf(row.status) !== -1 ? '<button type="button" class="report-button" data-report-cancel="' + esc(row.id) + '">取消</button>' : !busy ? '<button type="button" class="report-button" data-report-retry="' + esc(row.id) + '">重新生成</button>' : '') + '</div></div>';
        }).join('') : '<p class="report-note">暂无报告。配置 AI 服务后，可手动生成或启用交易日自动任务。</p>';
    }
    function renderDocument(row) {
        var facts = row.facts || {}, portfolio = facts.portfolio || {}, report = row.report;
        function money(value) { return typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '--'; }
        function textList(items) { return '<ul>' + (items || []).map(function (item) { return '<li>' + esc(typeof item === 'string' ? item : item.text) + (item.source ? ' <small>[' + esc(({ quote: '行情', technical: '技术', fund: '资金', news: '新闻', risk: '公告风险', financial: '财务' })[item.source] || item.source) + ']</small>' : '') + '</li>'; }).join('') + '</ul>'; }
        var html = '<div class="report-heading"><h3>' + esc(row.tradeDate) + ' · ' + title(row.slot) + '</h3><button class="report-button" type="button" data-report-close>收起报告</button></div><p class="report-note">' + esc(labels[row.status] || row.status) + ' · ' + esc(time(row.finishedAt || row.createdAt)) + (row.model ? ' · ' + esc(row.model) : '') + '</p><p class="report-note">' + esc(row.message) + '</p>';
        if (facts.portfolio) {
            html += '<div class="report-facts"><span>有效持仓市值 ¥' + money(portfolio.marketValue) + ' (' + portfolio.valueCount + '/' + portfolio.holdingCount + '只)</span><span>浮动盈亏 ¥' + money(portfolio.unrealizedPnl) + ' (' + portfolio.pnlCount + '/' + portfolio.holdingCount + '只)</span></div><p class="report-note">以上数字由本机计算，未被模型改写。行情对应 ' + esc(facts.expectedQuoteDate) + ' 收盘，非当前实时数据。</p>';
        }
        if (report) {
            html += '<p>' + esc(report.summary) + '</p><h4>组合风险</h4>' + textList(report.portfolioRisks) + '<h4>组合观察条件</h4>' + textList(report.watchConditions);
            html += (report.stocks || []).map(function (stock) {
                var quote = (facts.snapshots || []).find(function (s) { return s.code === stock.code; });
                return '<section class="report-position"><h4>' + esc(quote && quote.name || stock.code) + ' · ' + esc(stock.code) + ' · AI 评估分 ' + esc(stock.score == null ? '待复核' : stock.score) + '</h4><p class="report-note">量化研究分 ' + esc(quote && quote.quant ? quote.quant.score : '--') + ' · 数据覆盖 ' + esc(quote && quote.quant ? quote.quant.coverage + '%' : '--') + '</p><p>' + esc(stock.summary) + '</p><h4>支持依据</h4>' + textList(stock.bull) + '<h4>反对依据</h4>' + textList(stock.bear) + '<h4>观察条件</h4>' + textList(stock.watchConditions) + '<h4>失效条件</h4>' + textList(stock.invalidConditions) + '<button class="report-button" type="button" data-report-stock="' + esc(stock.code) + '">打开标的详情</button></section>';
            }).join('');
            html += '<h4>研究限制</h4>' + textList(report.limitations) + '<p class="report-note">AI 评估分不是上涨概率。模型解释仍需核对原始资料。</p>';
        }
        if ((facts.excluded || []).length) html += '<h4>未深研与遗漏标的</h4>' + textList(facts.excluded.map(function (item) { return item.code + '：' + item.reason; }));
        return html;
    }
    async function show(id, markRead) {
        currentId = id; var version = ++detailVersion;
        var target = host.querySelector('[data-report-document]'); target.hidden = false;
        target.setAttribute('aria-busy', 'true');
        try {
            var row = await request({ op: 'get', id: id });
            if (version !== detailVersion || currentId !== id) return;
            target.innerHTML = renderDocument(row);
            if (markRead !== false) {
                target.tabIndex = -1; target.focus({ preventScroll: true });
                if (target.scrollIntoView) target.scrollIntoView({ block: 'start', behavior: 'auto' });
                await request({ op: 'read', id: id }); await refresh();
            }
        } catch (error) { if (version === detailVersion) target.textContent = error.message || '报告读取失败'; }
        finally { if (version === detailVersion) target.removeAttribute('aria-busy'); }
    }
    async function refresh(force) {
        if (!host) return;
        if (loading) return force ? loading.then(function () { return refresh(); }) : loading;
        loading = request().then(list).catch(function (error) { status(error.message || '报告列表不可用'); }).finally(function () { loading = null; });
        return loading;
    }
    function init() {
        host = document.getElementById('report-center'); if (!host) return;
        host.innerHTML = '<div class="report-heading"><h2>盘前 / 盘后持仓报告</h2><button class="report-button" type="button" data-report-refresh>刷新记录</button></div><p class="report-note">默认研究持仓市值前 5 只股票；其余标的及资料缺项会列明。每份报告一次模型请求。启用后允许发送成本、股数、权重与公开资料，备注不发送。</p><div class="report-schedules">' +
            '<div class="report-schedule"><label><input name="premarket" type="checkbox">交易日 09:00 · 盘前报告</label><p class="report-note">上一交易日收盘资料 · 09:25 前可补跑</p><button type="button" class="report-button" data-report-run="premarket">手动生成盘前报告</button></div>' +
            '<div class="report-schedule"><label><input name="afterClose" type="checkbox">交易日 15:30 · 盘后报告</label><p class="report-note">当日收盘资料 · 16:30 前可补跑</p><button type="button" class="report-button" data-report-run="afterClose">手动生成盘后报告</button></div></div>' +
            '<p class="report-note">仅在应用运行时执行；隐藏窗口仍有效，退出或休眠时停止。自动任务每天最多两次模型请求，失败不自动重试；手动生成和重新生成会使用模型额度。</p><p class="report-note" data-calendar-status></p><p class="report-status" data-report-status role="status"></p><div class="report-list" data-report-list></div><article class="report-document" data-report-document aria-live="polite" hidden></article>';
        host.addEventListener('change', async function (event) {
            if (!event.target.matches('.report-schedule input')) return;
            var inputs = Array.from(host.querySelectorAll('.report-schedule input'));
            inputs.forEach(function (input) { input.disabled = true; });
            try { await request({ op: 'settings', settings: JSON.stringify({ premarket: inputs[0].checked, afterClose: inputs[1].checked }) }); status('自动任务设置已保存'); }
            catch (error) { status(error.message || '设置保存失败'); }
            finally { await refresh(); inputs.forEach(function (input) { input.disabled = false; }); }
        });
        host.addEventListener('click', async function (event) {
            var button = event.target.closest('button'); if (!button) return;
            if (button.hasAttribute('data-report-open')) { await show(button.dataset.reportOpen); return; }
            if (button.hasAttribute('data-report-close')) { currentId = null; detailVersion++; host.querySelector('[data-report-document]').hidden = true; return; }
            if (button.hasAttribute('data-report-stock')) { window.AppWatchlist.showStockFundFlow(button.dataset.reportStock, button); return; }
            if (button.hasAttribute('data-report-refresh')) { await refresh(); return; }
            var query;
            if (button.dataset.reportRun) query = { op: 'run', slot: button.dataset.reportRun };
            if (button.dataset.reportRetry) query = { op: 'retry', id: button.dataset.reportRetry };
            if (button.dataset.reportCancel) query = { op: 'cancel', id: button.dataset.reportCancel };
            if (!query) return;
            button.disabled = true;
            try { if ((query.op === 'run' || query.op === 'retry') && window.AppStorage && window.AppStorage.flush) await window.AppStorage.flush(); var result = await request(query); status(query.op === 'cancel' ? '任务已取消' : '任务已进入研究队列'); await refresh(); if (result.id) await show(result.id); }
            catch (error) { status(error.message || '报告操作失败'); }
            finally { button.disabled = false; }
        });
        if (window.shell && window.shell.onReportState) window.shell.onReportState(async function (event) {
            if (event.error) status(event.error);
            await refresh(true); if (currentId && currentId === event.id) await show(currentId, false);
            var item = lastData && lastData.items.find(function (row) { return row.id === event.id; });
            if (item && ['completed', 'partial'].indexOf(item.status) !== -1 && !notified.has(event.id) && window.AppAlerts) {
                notified.add(event.id); window.AppAlerts.showStatusToast('研究报告已保存，请查看研究页');
            }
        });
        if (window.shell && window.shell.onReportOpen) window.shell.onReportOpen(function (event) { window.AppWorkbench.navigate('research'); show(event.id); });
        refresh();
    }
    window.AppReports = { init: init, refresh: refresh, show: show, renderDocument: renderDocument };
})();
