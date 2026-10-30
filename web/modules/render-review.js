// 收盘复盘：情绪读数 / 连板天梯 / 题材轮动 / AI 五段复盘 / 明日验证。
// 数据全部来自服务端存档层（/market-review），前端只做呈现。
(function () {
    var utils = window.AppUtils;
    var uiState = window.AppUiState || {
        render: function (_kind, options) { return '<div class="news-status">' + utils.escapeHtml(options.title) + '</div>'; },
    };
    var view = { date: null, board: null, loading: false, generating: false, error: false };

    async function fetchReview(action, date) {
        var query = { action: action || 'board' };
        if (date) query.date = date;
        var res = await window.AppDataClient.fetch('/market-review', query, { force: true, cacheMode: 'bypass_fresh' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success) throw new Error(json.message || '复盘数据暂不可用');
        return json.data || {};
    }

    async function refresh(date) {
        if (view.loading) return;
        view.loading = true;
        render();
        try {
            view.board = await fetchReview('board', date || view.date);
            view.date = view.board.date;
            view.error = false;
        } catch (error) {
            console.error('复盘加载失败:', error);
            view.error = true;
        } finally {
            view.loading = false;
            render();
        }
    }

    async function generate() {
        if (view.generating || !view.date) return;
        view.generating = true;
        render();
        try {
            await fetchReview('generate', view.date);
            view.board = await fetchReview('board', view.date);
            view.error = false;
        } catch (error) {
            console.error('复盘生成失败:', error);
            view.error = true;
        } finally {
            view.generating = false;
            render();
        }
    }

    function pctText(p) {
        return typeof p === 'number' ? '分位 ' + p : '';
    }

    function moodLabel(board) {
        var p = board.percentiles || {};
        var parts = [];
        if (typeof p.ztCount === 'number') parts.push(p.ztCount);
        if (typeof p.promoteRate === 'number') parts.push(p.promoteRate);
        if (typeof p.yztMedianPct === 'number') parts.push(p.yztMedianPct);
        if (typeof p.dtCount === 'number') parts.push(100 - p.dtCount);
        if (typeof p.breakRate === 'number') parts.push(100 - p.breakRate);
        if (!parts.length) return null;
        var avg = Math.round(parts.reduce(function (s, n) { return s + n; }, 0) / parts.length);
        var label = avg >= 70 ? '强势' : avg >= 55 ? '偏强' : avg >= 45 ? '中性' : avg >= 30 ? '偏弱' : '弱势';
        return { value: avg, label: label };
    }

    function metricCard(label, value, unit, percentile, days) {
        return '<div class="review-metric"><span>' + utils.escapeHtml(label) + '</span>' +
            '<strong>' + utils.escapeHtml(value) + '<small>' + utils.escapeHtml(unit) + '</small></strong>' +
            '<em>' + utils.escapeHtml(pctText(percentile)) + (typeof percentile === 'number' ? ' · 近' + days + '日' : '') + '</em></div>';
    }

    function conditionText(c) {
        return c.label || (c.metric + ' ' + c.op + ' ' + c.value);
    }

    function render() {
        var root = document.getElementById('review-root');
        if (!root) return;
        if (view.loading && !view.board) {
            root.innerHTML = uiState.render('loading', { title: '正在加载复盘', detail: '存档数据返回后会在这里更新。' });
            return;
        }
        if (view.error && !view.board) {
            root.innerHTML = uiState.render('error', { title: '复盘暂不可用', detail: '服务端存档尚未就绪或网络异常，请稍后重试。', retryScope: 'review' });
            return;
        }
        var board = view.board;
        if (!board) {
            root.innerHTML = uiState.render('empty', { title: '暂无复盘数据', detail: '收盘存档生成后这里会出现情绪复盘。' });
            return;
        }
        var s = board.summary || {};
        var mood = moodLabel(board);
        var html = '<div class="review-board">';

        // 工具条：日期切换 + 战绩
        html += '<div class="review-toolbar"><label>复盘日期 <select id="review-date-select">' +
            board.dates.slice().reverse().map(function (d) {
                return '<option value="' + d + '"' + (d === board.date ? ' selected' : '') + '>' + d + '</option>';
            }).join('') + '</select></label>';
        if (mood) html += '<span class="review-mood">情绪分位 <strong>' + mood.value + '</strong> · ' + mood.label + '</span>';
        var sb = board.scoreboard || {};
        if (sb.settled) html += '<span class="review-score">明日验证战绩：已结算 ' + sb.settled + ' · 全中 ' + sb.full + ' · 部分命中 ' + sb.partial + ' · 未中 ' + sb.missed + '</span>';
        if (!board.complete) html += '<span class="review-warn">该日存档不完整</span>';
        html += '</div>';

        // 情绪读数
        html += '<div class="review-metrics">' +
            metricCard('涨停', s.ztCount, ' 家', board.percentiles.ztCount, board.historyDays) +
            metricCard('跌停', s.dtCount, ' 家', board.percentiles.dtCount, board.historyDays) +
            metricCard('炸板率', s.breakRate, ' %', board.percentiles.breakRate, board.historyDays) +
            metricCard('最高板', s.maxHeight, ' 板', board.percentiles.maxHeight, board.historyDays) +
            metricCard('晋级率', s.promoteRate, ' %', board.percentiles.promoteRate, board.historyDays) +
            metricCard('昨涨停中位', s.yztMedianPct, ' %', board.percentiles.yztMedianPct, board.historyDays) +
            metricCard('昨涨停翻红率', s.yztUpRate, ' %', null, board.historyDays) +
            metricCard('炸板', s.zbCount, ' 家', null, board.historyDays) +
            '</div>';
        if (board.breadth) {
            html += '<p class="review-breadth">全市场 上涨 ' + board.breadth.up + ' · 下跌 ' + board.breadth.down + ' · 平盘 ' + board.breadth.flat + '</p>';
        }
        if (board.sealQuality) {
            var q = board.sealQuality;
            html += '<p class="review-breadth">封板质量：一次封死 ' + q.oneShotRate + '% · 平均炸板 ' + q.avgBreakTimes + ' 次 · 10 点前首封 ' + q.earlySealRate + '%</p>';
        }

        // 连板天梯
        html += '<div class="review-block"><h3>连板天梯</h3>';
        if (board.ladderGaps && board.ladderGaps.length) {
            html += '<p class="review-gap">梯队断层：缺 ' + board.ladderGaps.join('、') + ' 板</p>';
        }
        html += '<div class="review-ladder">';
        (board.ladder || []).forEach(function (row) {
            html += '<div class="review-ladder-row"><span class="review-level">' + row.level + ' 板</span><em>×' + row.count + '</em><div class="review-chips">' +
                row.stocks.map(function (st) {
                    return '<span class="review-chip">' + utils.escapeHtml(st.name) + (st.firstSeal ? ' <small>' + utils.escapeHtml(st.firstSeal.slice(0, 5)) + '</small>' : '') + '</span>';
                }).join('') + '</div></div>';
        });
        html += '</div></div>';

        // 题材轮动（行业口径）
        html += '<div class="review-block"><h3>题材轮动 <small>近 5 日涨停数（行业口径）</small></h3><div class="review-theme-wrap"><table class="review-theme"><thead><tr><th>行业</th>' +
            (board.themeDates || []).map(function (d) { return '<th>' + d.slice(5) + '</th>'; }).join('') +
            '<th>较昨日</th></tr></thead><tbody>';
        (board.themes || []).forEach(function (t) {
            var dates = board.themeDates || [];
            var todayCount = t.counts[dates[dates.length - 1]] || 0;
            var prevCount = dates.length > 1 ? (t.counts[dates[dates.length - 2]] || 0) : 0;
            var delta = todayCount - prevCount;
            html += '<tr><td>' + utils.escapeHtml(t.industry) + '</td>' +
                dates.map(function (d, i) {
                    var c = t.counts[d] || 0;
                    return '<td' + (i === dates.length - 1 ? ' class="is-today"' : '') + '>' + (c || '·') + '</td>';
                }).join('') +
                '<td class="' + (delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '') + '">' + (delta > 0 ? '+' + delta : delta < 0 ? String(delta) : '0') + '</td></tr>';
        });
        html += '</tbody></table></div></div>';

        // AI 复盘
        html += '<div class="review-block"><h3>AI 复盘</h3>';
        var report = board.report;
        if (report) {
            var titles = { emotion: '情绪', capital: '资金', theme: '题材', dragon: '龙虎榜', leader: '龙头' };
            html += '<p class="review-report-meta">' + utils.escapeHtml(String(report.generatedAt || '').slice(0, 16).replace('T', ' ')) +
                (report.model ? ' · ' + utils.escapeHtml(report.model) : '') +
                ' · 数字核对：' + ((report.numbers && report.numbers.verified) || 0) + ' 个已核对' +
                ((report.numbers && report.numbers.unverified && report.numbers.unverified.length)
                    ? '，' + report.numbers.unverified.length + ' 处未核实已标注' : '，无未核实数字') + '</p>';
            Object.keys(titles).forEach(function (key) {
                var text = report.sections && report.sections[key];
                if (!text) return;
                html += '<div class="review-section"><strong>' + titles[key] + '</strong><p>' + utils.escapeHtml(text) + '</p></div>';
            });
            if (report.tomorrow) {
                html += '<div class="review-tomorrow"><strong>明日预判 · ' + utils.escapeHtml(report.tomorrow.stance) + '</strong><ul>' +
                    report.tomorrow.conditions.map(function (c) { return '<li>' + utils.escapeHtml(conditionText(c)) + '</li>'; }).join('') +
                    '</ul><small>次日收盘后按存档自动对账</small></div>';
            }
        } else {
            html += '<p class="review-breadth">该日尚未生成 AI 复盘（交易日 16:05 自动生成）。</p>' +
                '<button type="button" class="review-generate-btn" data-review-generate="1"' + (view.generating ? ' disabled' : '') + '>' +
                (view.generating ? '生成中…' : '生成 AI 复盘') + '</button>';
        }
        html += '</div>';

        // 明日验证结果（昨日条件 → 今日对账）
        var results = board.verifyResultForDate || [];
        var pending = board.verifyForDate || [];
        if (results.length || pending.length) {
            html += '<div class="review-block"><h3>明日验证</h3>';
            results.forEach(function (r) {
                html += '<div class="review-verify"><div><strong>' + utils.escapeHtml(r.fromDate) + ' 预判 · ' + utils.escapeHtml(r.stance) + '</strong>' +
                    (r.verdict ? '<span class="review-outcome">' + utils.escapeHtml(r.verdict.outcome) + '（' + r.verdict.passed + '/' + r.verdict.total + '）</span>' : '<span>待对账</span>') + '</div>';
                if (r.verdict) {
                    html += '<ul>' + r.verdict.results.map(function (x) {
                        return '<li>' + utils.escapeHtml(conditionText(x)) + ' → 实际 ' + (x.actual === null ? '暂无' : x.actual) + ' ' + (x.pass ? '✓' : '✗') + '</li>';
                    }).join('') + '</ul>';
                }
                html += '</div>';
            });
            pending.forEach(function (r) {
                html += '<div class="review-verify"><div><strong>今日预判 · ' + utils.escapeHtml(r.stance) + '</strong><span>目标日 ' + utils.escapeHtml(r.targetDate) + ' 收盘后自动对账' + (r.late ? ' · 事后生成，不计战绩' : '') + '</span></div><ul>' +
                    r.conditions.map(function (c) { return '<li>' + utils.escapeHtml(conditionText(c)) + '</li>'; }).join('') + '</ul></div>';
            });
            html += '</div>';
        }

        html += '</div>';
        root.innerHTML = html;
        bind(root);
    }

    function bind(root) {
        if (root.dataset.reviewBound === 'true') return;
        root.dataset.reviewBound = 'true';
        root.addEventListener('change', function (event) {
            if (event.target.id === 'review-date-select') refresh(event.target.value);
        });
        root.addEventListener('click', function (event) {
            if (event.target.closest('[data-review-generate]')) generate();
        });
    }

    window.AppReview = { refresh: refresh, render: render };
})();
