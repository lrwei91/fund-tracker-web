// Research UI consumes native snapshots; model calls are always explicit.
(function () {
    var utils = window.AppUtils;
    var labels = {
        quote: '行情',
        technical: '技术',
        fund: '资金',
        news: '新闻',
        risk: '公告风险',
        financial: '财务',
    };
    var reports = {};
    var snapshots = {};
    var cancelled = false;
    var batchRunning = false;
    function esc(value) {
        return utils.escapeHtml(value == null ? '' : String(value));
    }
    function number(value, suffix) {
        return typeof value === 'number' && Number.isFinite(value)
            ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + (suffix || '')
            : '--';
    }
    function metric(label, value) {
        return (
            '<div class="research-metric"><span>' +
            esc(label) +
            '</span><strong>' +
            esc(value) +
            '</strong></div>'
        );
    }
    function dateTime(value) {
        var date = new Date(value);
        return Number.isFinite(date.getTime())
            ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
            : '--';
    }
    function sourceNames(values) {
        return (values || [])
            .map(function (key) {
                return labels[key] || key;
            })
            .join('、');
    }
    function renderSnapshot(data) {
        var quant = data.quant || {};
        var factors = (quant.factors || [])
            .map(function (factor) {
                return metric(factor.label, number(factor.score));
            })
            .join('');
        var quote = data.quote || {};
        var quoteTime =
            quote.quoteTimeRaw && /^\d{14}$/.test(quote.quoteTimeRaw)
                ? quote.quoteTimeRaw.slice(0, 4) +
                  '-' +
                  quote.quoteTimeRaw.slice(4, 6) +
                  '-' +
                  quote.quoteTimeRaw.slice(6, 8) +
                  ' ' +
                  (quote.quoteTime || '')
                : '--';
        return (
            '<div class="research-summary"><div class="research-metrics">' +
            metric('量化研究分', number(quant.score)) +
            metric('数据覆盖', number(quant.coverage, '%')) +
            metric('行情时间', quoteTime) +
            '</div><div class="research-metrics">' +
            metric('市盈率', number(quote.pe)) +
            metric('市净率', number(quote.pb)) +
            metric(
                '总市值',
                typeof quote.marketCap === 'number' ? utils.formatYuan(quote.marketCap) : '--',
            ) +
            '</div>' +
            '<p class="research-note">' +
            esc(quant.method) +
            '</p>' +
            (quant.specialRisk
                ? '<p class="negative">名称含特殊风险标识，请优先核查公告。</p>'
                : '') +
            (quant.missingSources && quant.missingSources.length
                ? '<p class="research-note">缺少：' +
                  esc(sourceNames(quant.missingSources)) +
                  (quant.score == null
                      ? '。有效行情与至少三个评分维度可用后才生成评分。'
                      : '。已跳过这些资料，评分仅使用可用维度。') +
                  '</p>'
                : '') +
            '<div class="research-metrics">' +
            factors +
            '</div></div>'
        );
    }
    function renderFinancials(data) {
        if (!data || !data.available)
            return '<p class="list-empty">财务指标暂不可用，未参与研究评分。</p>';
        var rows = (data.periods || [])
            .map(function (row) {
                return (
                    '<tr><td>' +
                    esc(row.reportDate) +
                    '<small>披露 ' +
                    esc(row.disclosedAt) +
                    '</small></td><td>' +
                    esc(typeof row.revenue === 'number' ? utils.formatYuan(row.revenue) : '--') +
                    '</td><td>' +
                    esc(
                        typeof row.netProfit === 'number' ? utils.formatYuan(row.netProfit) : '--',
                    ) +
                    '</td><td>' +
                    esc(number(row.profitGrowth, '%')) +
                    '</td><td>' +
                    esc(number(row.roe, '%')) +
                    '</td><td>' +
                    esc(number(row.cashPerShare)) +
                    '</td></tr>'
                );
            })
            .join('');
        return (
            '<p class="research-note">' +
            esc(data.sourceLabel) +
            ' · 各期为累计口径，按已披露报告展示。</p><div class="research-table-wrap"><table class="research-table"><thead><tr><th>报告期</th><th>营业收入</th><th>归母净利</th><th>净利同比</th><th>ROE</th><th>每股经营现金流</th></tr></thead><tbody>' +
            rows +
            '</tbody></table></div>'
        );
    }
    function renderReport(result) {
        var report = result.report || {};
        var rating =
            {
                positive: '偏积极',
                neutral: '中性',
                negative: '偏谨慎',
                review: '资料不足 / 待复核',
            }[report.rating] || '待复核';
        function findings(group, title) {
            return (
                '<section><strong>' +
                title +
                '</strong><ul>' +
                (report[group] || [])
                    .map(function (finding) {
                        return (
                            '<li>' +
                            esc(finding.text) +
                            '<small>依据：' +
                            esc(labels[finding.source] || finding.source) +
                            '</small></li>'
                        );
                    })
                    .join('') +
                '</ul></section>'
            );
        }
        function conditions(field, title) {
            return (
                '<section><strong>' +
                title +
                '</strong><ul>' +
                (report[field] || [])
                    .map(function (text) {
                        return '<li>' + esc(text) + '</li>';
                    })
                    .join('') +
                '</ul></section>'
            );
        }
        return (
            '<div class="research-report"><div class="research-metrics">' +
            metric('AI 研究评级', rating) +
            metric('AI 评估分', number(report.score)) +
            metric('量化分', number(result.quant && result.quant.score)) +
            '</div>' +
            '<p>' +
            esc(report.summary) +
            '</p><div class="research-evidence-grid">' +
            findings('bull', '支持理由') +
            findings('bear', '反对理由') +
            conditions('watchConditions', '观察条件') +
            conditions('invalidConditions', '失效条件') +
            '</div>' +
            '<p class="research-note">' +
            esc(result.model) +
            ' · ' +
            esc(dateTime(result.generatedAt)) +
            (result.fromCache ? ' · 复用相同数据的研究' : '') +
            ' · AI 评估分不代表上涨概率。研究行情时点：' +
            esc(result.quoteTime || '--') +
            '；资料缺项：' +
            esc(sourceNames(result.quant && result.quant.missingSources) || '无') +
            '。</p></div>'
        );
    }
    function renderShell(code) {
        return (
            '<div class="research-workspace" data-research-code="' +
            esc(code) +
            '"><div data-research-snapshot role="status">正在整理研究资料…</div><div class="research-toolbar"><button type="button" data-research-run>生成 AI 深度研究</button><button type="button" data-research-settings>配置 AI 服务</button></div><p class="research-note">点击生成时，将发送这只股票的行情、指标、财务和公开新闻；不发送持仓成本、数量或备注。</p><div data-research-report aria-live="polite">尚未生成 AI 研究。</div><details class="research-financials" open><summary>财务与盈利质量</summary><div data-research-financial>正在加载已披露财报…</div></details><details><summary>历史研究</summary><div data-research-history>正在加载历史…</div></details></div>'
        );
    }
    function openSettings() {
        var detail = document.getElementById('stock-fund-panel');
        if (detail && !detail.hidden && window.AppDialog) window.AppDialog.close(detail);
        var open = document.getElementById('settings-btn');
        if (open) open.click();
        var tab = document.querySelector('[data-settings-view="ai"]');
        if (tab) tab.click();
    }
    function request(code) {
        return window.AppDataClient.fetchData('/stock-ai-research', { code: code, mode: 'ai' });
    }
    async function mount(root, code) {
        if (!root) return;
        if (utils.isEtf && utils.isEtf(code)) {
            root.innerHTML = '<p class="research-note">场内 ETF 可查看行情、技术和本地持仓统计，本轮未启用公司财报或 AI 深度研究。</p>';
            return;
        }
        root.innerHTML = renderShell(code);
        var workspace = root.firstElementChild;
        var snapshotHost = workspace.querySelector('[data-research-snapshot]');
        var reportHost = workspace.querySelector('[data-research-report]');
        if (reports[code]) reportHost.innerHTML = renderReport(reports[code]);
        workspace.querySelector('[data-research-settings]').addEventListener('click', openSettings);
        workspace
            .querySelector('[data-research-run]')
            .addEventListener('click', async function (event) {
                var button = event.currentTarget;
                button.disabled = true;
                reportHost.textContent = '正在研究技术、资金、财务和事件证据…';
                try {
                    var result = await request(code);
                    reports[code] = result.data;
                    reportHost.innerHTML = renderReport(result.data);
                    await loadHistory(workspace, code);
                } catch (error) {
                    reportHost.textContent = error.message || 'AI 研究失败，请重试';
                } finally {
                    button.disabled = false;
                }
            });
        loadHistory(workspace, code);
        try {
            var load = function () {
                return window.AppDataClient.fetchData('/stock-research', { code: code });
            };
            var coordinator = window.AppRefreshCoordinator;
            var result;
            if (coordinator && coordinator.runDetail) {
                var items = await coordinator.runDetail([{ run: load }]);
                if (items[0].status === 'rejected') throw items[0].reason;
                result = items[0].value;
            } else {
                result = await load();
            }
            snapshots[code] = result.data;
            snapshotHost.innerHTML = renderSnapshot(result.data);
            workspace.querySelector('[data-research-financial]').innerHTML = renderFinancials(
                result.data.financial,
            );
        } catch (error) {
            snapshotHost.textContent = error.message || '研究资料不可用';
            workspace.querySelector('[data-research-financial]').textContent = '财务资料未加载';
        }
    }
    async function loadHistory(workspace, code) {
        var host = workspace.querySelector('[data-research-history]');
        try {
            var result = await window.AppDataClient.fetchData('/stock-ai-research', {
                code: code,
                mode: 'history',
            });
            var rows = result.data.items || [];
            host.innerHTML = rows.length
                ? rows
                      .map(function (row, index) {
                          return (
                              '<button type="button" data-history-index="' +
                              index +
                              '">' +
                              esc(dateTime(row.generatedAt)) +
                              ' · ' +
                              esc(row.model) +
                              ' · ' +
                              esc(number(row.report && row.report.score)) +
                              '</button>'
                          );
                      })
                      .join('')
                : '<p class="research-note">暂无历史研究。</p>';
            host.querySelectorAll('[data-history-index]').forEach(function (button) {
                button.addEventListener('click', function () {
                    workspace.querySelector('[data-research-report]').innerHTML = renderReport(
                        rows[Number(button.dataset.historyIndex)],
                    );
                });
            });
        } catch (error) {
            host.textContent = '历史研究暂不可用';
        }
    }
    function candidateCodes() {
        var scope = document.getElementById('research-pool');
        var list =
            scope && scope.value === 'watchlist' && window.AppWatchlist
                ? window.AppWatchlist.getAllWatchCodes()
                : Array.from(document.querySelectorAll('[data-radar-code]')).map(function (row) {
                      return row.dataset.radarCode;
                  });
        return Array.from(new Set(list)).filter(function (code) {
            return /^\d{6}$/.test(code);
        });
    }
    function renderBatch(rows) {
        var host = document.getElementById('research-candidates');
        if (!host) return;
        rows.sort(function (a, b) {
            var x = a.result && a.result.report.score;
            var y = b.result && b.result.report.score;
            return (typeof y === 'number' ? y : -1) - (typeof x === 'number' ? x : -1);
        });
        host.innerHTML = rows
            .map(function (row) {
                return (
                    '<button type="button" class="research-candidate" data-research-open="' +
                    esc(row.code) +
                    '"><span><strong>' +
                    esc(row.result ? row.result.name : row.code) +
                    '</strong><small>' +
                    esc(row.code) +
                    '</small></span><span>量化 ' +
                    esc(number(row.result && row.result.quant.score)) +
                    '</span><span>AI ' +
                    esc(number(row.result && row.result.report.score)) +
                    '</span><em>' +
                    esc(row.error || (row.result && row.result.report.summary)) +
                    '</em></button>'
                );
            })
            .join('');
        host.querySelectorAll('[data-research-open]').forEach(function (button) {
            button.addEventListener('click', function () {
                if (window.AppWatchlist)
                    window.AppWatchlist.showStockFundFlow(button.dataset.researchOpen, button);
            });
        });
    }
    async function runBatch() {
        if (batchRunning) return;
        var status = document.getElementById('research-batch-status');
        var start = document.getElementById('research-batch-run');
        var stop = document.getElementById('research-batch-stop');
        var maximum = Number(document.getElementById('research-batch-count').value) || 3;
        var codes = candidateCodes().slice(0, Math.min(10, maximum));
        if (!codes.length) {
            status.textContent = '当前候选池为空，请先添加自选或刷新初筛结果。';
            return;
        }
        if (window.shell && window.shell.aiSettingsStatus) {
            try {
                if (!(await window.shell.aiSettingsStatus()).configured) {
                    status.textContent = '请先配置 AI 服务与密钥。';
                    openSettings();
                    return;
                }
            } catch (error) {
                status.textContent =
                    (typeof error === 'string' ? error : error && error.message) ||
                    '读取 AI 服务配置失败';
                return;
            }
        }
        batchRunning = true;
        cancelled = false;
        start.disabled = true;
        stop.disabled = false;
        stop.hidden = false;
        var rows = [];
        try {
            for (var i = 0; i < codes.length && !cancelled; i++) {
                status.textContent = '正在研究 ' + (i + 1) + '/' + codes.length + ' · ' + codes[i];
                try {
                    var result = await request(codes[i]);
                    reports[codes[i]] = result.data;
                    rows.push({ code: codes[i], result: result.data });
                } catch (error) {
                    rows.push({ code: codes[i], error: error.message || '研究失败' });
                }
                renderBatch(rows);
            }
            status.textContent =
                (cancelled ? '已停止后续研究' : '研究完成') +
                ' · ' +
                rows.length +
                '/' +
                codes.length +
                '，按 AI 评估分排序。';
        } finally {
            batchRunning = false;
            start.disabled = false;
            stop.hidden = true;
        }
    }
    async function initSettings() {
        var form = document.getElementById('ai-settings-form');
        if (!form) return;
        var status = document.getElementById('ai-settings-status');
        var base = document.getElementById('ai-base-url');
        var model = document.getElementById('ai-model');
        var key = document.getElementById('ai-api-key');
        async function refresh() {
            if (!window.shell || !window.shell.aiSettingsStatus) {
                status.textContent = '请在桌面应用内配置 AI 服务。';
                return;
            }
            try {
                var value = await window.shell.aiSettingsStatus();
                base.value = value.settings ? value.settings.baseUrl : '';
                model.value = value.settings ? value.settings.model : '';
                status.textContent = value.configured
                    ? '服务已配置，密钥保存在系统凭据库。'
                    : '尚未配置完整的 AI 服务。';
            } catch (error) {
                status.textContent =
                    (typeof error === 'string' ? error : error && error.message) ||
                    '读取 AI 服务配置失败';
            }
        }
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var button = form.querySelector('[type="submit"]');
            button.disabled = true;
            var apiKey = key.value;
            key.value = '';
            try {
                await window.shell.aiSettingsSave(
                    { baseUrl: base.value.trim(), model: model.value.trim() },
                    apiKey,
                    false,
                );
                await refresh();
            } catch (error) {
                status.textContent =
                    (typeof error === 'string' ? error : error && error.message) || '保存失败';
            } finally {
                apiKey = '';
                button.disabled = false;
            }
        });
        document.getElementById('ai-clear-key').addEventListener('click', async function () {
            try {
                await window.shell.aiSettingsSave(
                    { baseUrl: base.value.trim(), model: model.value.trim() },
                    null,
                    true,
                );
                await refresh();
            } catch (error) {
                status.textContent =
                    (typeof error === 'string' ? error : error && error.message) || '删除密钥失败';
            }
        });
        await refresh();
    }
    function init() {
        initSettings();
        var run = document.getElementById('research-batch-run');
        if (run) run.addEventListener('click', runBatch);
        var stop = document.getElementById('research-batch-stop');
        if (stop)
            stop.addEventListener('click', function () {
                cancelled = true;
                stop.disabled = true;
                document.getElementById('research-batch-status').textContent =
                    '当前研究完成后停止后续请求。';
            });
    }
    window.AppResearch = {
        mount: mount,
        init: init,
        renderReport: renderReport,
        renderSnapshot: renderSnapshot,
        renderFinancials: renderFinancials,
    };
})();
