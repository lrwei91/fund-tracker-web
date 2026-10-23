// ================================================================
// 市场信号 — 机会雷达 / 市场热度 / 打板情绪 (涨停 / 炸板 / 跌停 / 昨涨停)
// 暴露到 window.AppSignals;
// 直接 script 引入,无需 import/require
// 依赖:window.AppState, window.AppUtils, window.AppCache
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var uiState = window.AppUiState || {
        render: function (_kind, options) { return '<div class="list-empty">' + utils.escapeHtml(options.title) + '</div>'; },
    };
    var dataStatus = window.AppDataStatus || { label: function (_meta, fallback) { return fallback || ''; } };
    var KEYS = state.KEYS;

    function toFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        var number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function formatSignedPercent(value) {
        var number = toFiniteNumber(value);
        if (number === null) return '--';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function trendClass(value) {
        var number = toFiniteNumber(value);
        return number > 0 ? 'positive' : number < 0 ? 'negative' : 'neutral';
    }

    function scoreClass(value) {
        var number = toFiniteNumber(value);
        if (number === null) return 'neutral';
        return number >= 70 ? 'positive' : (number < 45 ? 'negative' : 'neutral');
    }

    function shouldBypassDailySignalCache(force) {
        return !!force || (utils.isAfterCloseForDailyUpdate && utils.isAfterCloseForDailyUpdate());
    }

    function requestOptions(force) {
        return {
            force: !!force,
            cacheMode: force ? 'bypass_fresh' : 'normal',
        };
    }

    // ============================================================
    // 轮动板块（仅由页面按钮手动触发，展示上一交易日）
    // ============================================================

    var sectorRotationRequest = null;
    var sectorRotationResult = null;

    function setSectorRotationStatus(text, kind) {
        var status = document.getElementById('sector-rotation-status');
        if (!status) return;
        status.textContent = text || '';
        status.setAttribute('data-state', kind || 'idle');
    }

    function setSectorRotationButtonLoading(loading) {
        var button = document.getElementById('sector-rotation-run-btn');
        if (!button) return;
        button.disabled = !!loading;
        if (loading) button.setAttribute('aria-busy', 'true');
        else button.removeAttribute('aria-busy');
    }

    function normalizeSectorRotation(data) {
        if (!data || data.status !== 'ready' || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.snapshotDate || ''))) {
            throw new Error('轮动板块日期无效');
        }
        var sectors = (Array.isArray(data.sectors) ? data.sectors : []).map(function (item) {
            return {
                rank: toFiniteNumber(item && item.rank),
                sectorName: String(item && item.sectorName || '').trim().slice(0, 40),
                stocksCount: toFiniteNumber(item && item.stocksCount),
                heatValue: toFiniteNumber(item && item.heatValue),
                driveEvent: String(item && item.driveEvent || '').trim().slice(0, 500),
                rotationDays: toFiniteNumber(item && item.rotationDays),
                rotationTimes: toFiniteNumber(item && item.rotationTimes),
                rotationProb: String(item && item.rotationProb || '').trim().slice(0, 20),
                emotionalCycle: String(item && item.emotionalCycle || '').trim().slice(0, 40),
                recognitionBenchmark: String(item && item.recognitionBenchmark || '').trim().slice(0, 300),
                trendAnalysis: String(item && item.trendAnalysis || '').trim().slice(0, 1200),
                tradingStrategy: String(item && item.tradingStrategy || '').trim().slice(0, 1200),
            };
        }).filter(function (item) { return item.sectorName && item.rank !== null; });
        sectors.sort(function (left, right) { return left.rank - right.rank; });
        return { snapshotDate: data.snapshotDate, sectors: sectors };
    }

    function renderSectorRotation(data) {
        var container = document.getElementById('sector-rotation-results');
        if (!container) return;
        if (!data.sectors.length) {
            container.innerHTML = uiState.render('empty', {
                title: '上一交易日暂无轮动板块',
                detail: '数据源已更新，但没有返回板块记录。',
            });
            return;
        }
        container.innerHTML = '<div class="sector-rotation-list">' + data.sectors.map(function (item) {
            var metrics = [
                ['热度', item.heatValue === null ? '--' : item.heatValue],
                ['个股', item.stocksCount === null ? '--' : item.stocksCount + '只'],
                ['轮动', item.rotationDays === null && item.rotationTimes === null ? '--' :
                    [item.rotationDays === null ? '' : item.rotationDays + '天',
                        item.rotationTimes === null ? '' : item.rotationTimes + '次'].filter(Boolean).join(' / ')],
                ['概率', item.rotationProb || '--'],
            ];
            return '<details class="sector-rotation-card"' + (item.rank === 1 ? ' open' : '') + '>' +
                '<summary><span class="sector-rotation-rank">' + utils.escapeHtml(String(item.rank)) + '</span>' +
                '<div class="sector-rotation-title"><strong>' + utils.escapeHtml(item.sectorName) + '</strong>' +
                '<span>' + utils.escapeHtml(item.emotionalCycle || '周期未标注') + '</span></div>' +
                '<div class="sector-rotation-metrics">' + metrics.map(function (metric) {
                    return '<span><small>' + utils.escapeHtml(metric[0]) + '</small><b>' + utils.escapeHtml(String(metric[1])) + '</b></span>';
                }).join('') + '</div><span class="sector-rotation-toggle" aria-hidden="true">⌄</span></summary>' +
                '<div class="sector-rotation-detail">' +
                    '<div><small>驱动事件</small><p>' + utils.escapeHtml(item.driveEvent || '暂无') + '</p></div>' +
                    '<div><small>辨识度标杆</small><p>' + utils.escapeHtml(item.recognitionBenchmark || '暂无') + '</p></div>' +
                    '<div><small>趋势观察</small><p>' + utils.escapeHtml(item.trendAnalysis || '暂无') + '</p></div>' +
                    '<div><small>参考策略</small><p>' + utils.escapeHtml(item.tradingStrategy || '暂无') + '</p></div>' +
                '</div></details>';
        }).join('') + '</div>';
    }

    function runSectorRotation() {
        if (sectorRotationRequest) return sectorRotationRequest;
        var container = document.getElementById('sector-rotation-results');
        var timeEl = document.getElementById('sector-rotation-update-time');
        setSectorRotationButtonLoading(true);
        setSectorRotationStatus(sectorRotationResult ? '正在刷新，当前结果保留至请求完成。' : '正在获取上一交易日轮动板块…', 'loading');
        if (!sectorRotationResult && container) container.innerHTML = uiState.render('loading', {
            title: '正在获取轮动板块',
            detail: '只有本次手动操作会发起请求。',
        });
        var request = window.AppDataClient.fetchData('/sector-rotation', {}, {
            force: true,
            cacheMode: 'bypass_fresh',
        }).then(function (result) {
            var normalized = normalizeSectorRotation(result.data);
            sectorRotationResult = normalized;
            renderSectorRotation(normalized);
            if (timeEl) timeEl.textContent = '数据日期：' + normalized.snapshotDate;
            var stale = !!(result.meta && result.meta.stale);
            setSectorRotationStatus('数据源：' + (result.data.sourceLabel || 'DeepQ 题材记忆库') +
                (stale ? ' · 缓存数据' : '') + ' · 仅手动更新', stale ? 'degraded' : 'ready');
            return normalized;
        }).catch(function (error) {
            console.error('轮动板块获取失败：', error);
            if (sectorRotationResult) {
                setSectorRotationStatus('刷新失败，保留当前结果。', 'error');
            } else {
                if (timeEl) timeEl.textContent = '';
                setSectorRotationStatus('轮动板块获取失败，请稍后手动重试。', 'error');
                if (container) container.innerHTML = uiState.render('error', {
                    title: '轮动板块暂不可用',
                    detail: '本次没有获取到上一交易日数据。',
                });
            }
            return null;
        });
        sectorRotationRequest = request.finally(function () {
            sectorRotationRequest = null;
            setSectorRotationButtonLoading(false);
        });
        return sectorRotationRequest;
    }

    // ============================================================
    // 盘中筛选（仅由页面按钮手动触发）
    // ============================================================

    var intradayScreeningRequest = null;
    var intradayScreeningResult = null;

    function intradayText(node) {
        return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    function parseIntradayStockMeta(value) {
        var parts = String(value || '').split(/\s*·\s*/);
        return {
            code: (parts.shift() || '').trim(),
            industry: parts.join(' · ').trim(),
        };
    }

    function parseIntradayScreeningModule(moduleHtml) {
        if (typeof DOMParser !== 'function' || !String(moduleHtml || '').trim()) {
            throw new Error('盘中筛选模块为空');
        }
        var doc = new DOMParser().parseFromString(String(moduleHtml), 'text/html');
        var boardNodes = Array.from(doc.querySelectorAll('.report-rec__board'));
        if (!boardNodes.length) throw new Error('盘中筛选模块结构异常');

        var boards = boardNodes.map(function (boardNode) {
            var title = intradayText(boardNode.querySelector('.report-rec__board-title'));
            if (!title) throw new Error('盘中筛选缺少板块标题');

            var table = boardNode.querySelector('.report-rec__table');
            if (!table) {
                if (boardNode.querySelector('.report-empty')) return { title: title, items: [] };
                throw new Error('盘中筛选缺少候选表格');
            }

            var rows = Array.from(table.querySelectorAll('tbody > tr'));
            var items = [];
            for (var i = 0; i < rows.length; i += 2) {
                var row = rows[i];
                var reasonRow = rows[i + 1];
                if (row.classList.contains('report-rec__reason')
                    || !reasonRow || !reasonRow.classList.contains('report-rec__reason')) {
                    throw new Error('盘中筛选候选行结构异常');
                }
                var cells = Array.from(row.children);
                if (cells.length < 7) throw new Error('盘中筛选候选字段不完整');

                var name = intradayText(cells[1].querySelector('.report-stock-name'));
                var stockMeta = parseIntradayStockMeta(intradayText(cells[1].querySelector('.report-stock-meta')));
                if (!name || !stockMeta.code) throw new Error('盘中筛选候选股票身份缺失');

                items.push({
                    rank: intradayText(cells[0]),
                    name: name,
                    code: stockMeta.code,
                    industry: stockMeta.industry,
                    score: intradayText(cells[2]),
                    pct: intradayText(cells[3]),
                    turnover: intradayText(cells[4]),
                    volumeRatio: intradayText(cells[5]),
                    marketCap: intradayText(cells[6]),
                    chips: Array.from(reasonRow.querySelectorAll('.report-chip')).map(intradayText).filter(Boolean),
                    reasons: Array.from(reasonRow.querySelectorAll('ol > li')).map(intradayText).filter(Boolean),
                });
            }
            return { title: title, items: items };
        });

        return {
            snapshotText: intradayText(doc.querySelector('.report-rec__time')),
            boards: boards,
            itemCount: boards.reduce(function (total, board) { return total + board.items.length; }, 0),
        };
    }

    function renderIntradayScreeningItem(item) {
        var stockMeta = [item.code, item.industry].filter(Boolean).join(' · ');
        var chips = item.chips.map(function (chip) {
            return '<span class="intraday-screening-chip chip">' + utils.escapeHtml(chip) + '</span>';
        }).join('');
        var reasons = item.reasons.map(function (reason) {
            return '<li>' + utils.escapeHtml(reason) + '</li>';
        }).join('');
        return '<div class="intraday-screening-card">' +
            '<span class="intraday-screening-rank">' + utils.escapeHtml(item.rank || '--') + '</span>' +
            '<div class="intraday-screening-stock">' +
                '<span class="intraday-screening-name">' + utils.escapeHtml(item.name) + '</span>' +
                '<span class="intraday-screening-code">' + utils.escapeHtml(stockMeta) + '</span>' +
            '</div>' +
            '<span class="intraday-screening-score">' + utils.escapeHtml(item.score || '--') + '</span>' +
            '<div class="intraday-screening-metrics">' +
                '<span class="intraday-screening-metric" data-label="涨幅">' + utils.escapeHtml(item.pct || '--') + '</span>' +
                '<span class="intraday-screening-metric" data-label="换手">' + utils.escapeHtml(item.turnover || '--') + '</span>' +
                '<span class="intraday-screening-metric" data-label="量比">' + utils.escapeHtml(item.volumeRatio || '--') + '</span>' +
                '<span class="intraday-screening-metric" data-label="市值">' + utils.escapeHtml(item.marketCap || '--') + '</span>' +
            '</div>' +
            (chips ? '<div class="intraday-screening-chips">' + chips + '</div>' : '') +
            (reasons ? '<ol class="intraday-screening-reason">' + reasons + '</ol>' : '') +
        '</div>';
    }

    function renderIntradayScreeningResult(parsed) {
        var container = document.getElementById('intraday-screening-results');
        if (!container) return;
        if (!parsed.itemCount) {
            container.innerHTML = uiState.render('empty', {
                title: '今日暂无入选股票',
                detail: '盘中筛选已更新，当前没有候选股票。',
            });
            return;
        }
        container.innerHTML = parsed.boards.map(function (board) {
            return '<section class="intraday-screening-board">' +
                '<div class="intraday-screening-board-header"><strong>' + utils.escapeHtml(board.title) +
                    '</strong><span>' + utils.escapeHtml(String(board.items.length)) + '只</span></div>' +
                '<div class="intraday-screening-table">' +
                    '<div class="intraday-screening-table-head" aria-hidden="true">' +
                        '<span>#</span><span>名称 / 代码 / 行业</span><span>评分</span><span>涨幅</span>' +
                        '<span>换手</span><span>量比</span><span>市值</span>' +
                    '</div>' +
                    board.items.map(renderIntradayScreeningItem).join('') +
                '</div>' +
            '</section>';
        }).join('');
    }

    function setIntradayScreeningStatus(text, kind) {
        var status = document.getElementById('intraday-screening-status');
        if (!status) return;
        status.textContent = text || '';
        status.setAttribute('data-state', kind || 'idle');
    }

    function setIntradayScreeningButtonLoading(loading) {
        var button = document.getElementById('intraday-screening-run-btn');
        if (!button) return;
        button.disabled = !!loading;
        if (loading) button.setAttribute('aria-busy', 'true');
        else button.removeAttribute('aria-busy');
    }

    function clearIntradayScreeningResult() {
        var container = document.getElementById('intraday-screening-results');
        var timeEl = document.getElementById('intraday-screening-update-time');
        intradayScreeningResult = null;
        if (container) {
            container.innerHTML = '';
            container.removeAttribute('data-snapshot-date');
        }
        if (timeEl) timeEl.textContent = '';
    }

    function hasCurrentIntradayScreeningResult(todayKey) {
        return !!(intradayScreeningResult && intradayScreeningResult.snapshotDate === todayKey);
    }

    function clearIntradayScreeningResultAcrossDay(todayKey) {
        var container = document.getElementById('intraday-screening-results');
        var renderedDate = container && container.getAttribute('data-snapshot-date');
        if ((intradayScreeningResult && intradayScreeningResult.snapshotDate !== todayKey)
            || (renderedDate && renderedDate !== todayKey)) {
            clearIntradayScreeningResult();
            setIntradayScreeningStatus('已进入新的交易日，请手动获取今日推荐。', 'not-ready');
            if (container) container.innerHTML = uiState.render('empty', {
                title: '上一交易日结果已清除',
                detail: '盘中筛选不会自动请求，请手动获取今日推荐。',
            });
            return true;
        }
        return false;
    }

    function reconcileIntradayScreeningDate() {
        return clearIntradayScreeningResultAcrossDay(utils.getShanghaiDateKey());
    }

    function renderIntradayScreeningNotReady(data, todayKey) {
        clearIntradayScreeningResult();
        var container = document.getElementById('intraday-screening-results');
        var timeEl = document.getElementById('intraday-screening-update-time');
        var latest = data.latestPublishedAt || [data.snapshotDate, data.snapshotTime].filter(Boolean).join(' ');
        if (timeEl) timeEl.textContent = latest ? '最近快照：' + latest : '今日尚无快照';
        setIntradayScreeningStatus('数据源：' + (data.sourceLabel || data.source || '公开报告') +
            ' · ' + (data.snapshotDate && data.snapshotDate !== todayKey ? '最新快照非今日' : '今日筛选尚未就绪'), 'not-ready');
        if (container) container.innerHTML = uiState.render('empty', {
            title: '今日盘中筛选尚未就绪',
            detail: '不展示过期候选股票，请稍后手动再试。',
        });
    }

    function renderIntradayScreeningReady(data, meta, parsed) {
        var container = document.getElementById('intraday-screening-results');
        var timeEl = document.getElementById('intraday-screening-update-time');
        var snapshot = data.snapshotAt || [data.snapshotDate, data.snapshotTime].filter(Boolean).join(' ')
            || parsed.snapshotText.replace(/^筛选快照：\s*/, '');
        renderIntradayScreeningResult(parsed);
        if (container) container.setAttribute('data-snapshot-date', data.snapshotDate);
        if (timeEl) timeEl.textContent = '筛选快照：' + (snapshot || data.snapshotDate);
        var degraded = !!(meta && meta.degraded);
        setIntradayScreeningStatus('数据源：' + (data.sourceLabel || data.source || '公开报告') +
            (degraded ? ' · 已使用降级来源' : '') + ' · 仅手动更新', degraded ? 'degraded' : 'ready');
        intradayScreeningResult = {
            snapshotDate: data.snapshotDate,
            snapshot: snapshot,
            sourceLabel: data.sourceLabel || data.source || '公开报告',
            parsed: parsed,
        };
    }

    function renderIntradayScreeningError(todayKey) {
        var container = document.getElementById('intraday-screening-results');
        if (hasCurrentIntradayScreeningResult(todayKey)) {
            setIntradayScreeningStatus('刷新失败，保留当前同日结果 · 数据源：' +
                intradayScreeningResult.sourceLabel, 'error');
            return;
        }
        clearIntradayScreeningResult();
        setIntradayScreeningStatus('盘中筛选获取失败，请稍后手动重试。', 'error');
        if (container) container.innerHTML = uiState.render('error', {
            title: '盘中筛选暂不可用',
            detail: '未获取到可验证的当日结果。',
        });
    }

    function loadIntradayScreeningData(_force) {
        if (intradayScreeningRequest) return intradayScreeningRequest;
        var todayKey = utils.getShanghaiDateKey();
        clearIntradayScreeningResultAcrossDay(todayKey);
        setIntradayScreeningButtonLoading(true);
        if (hasCurrentIntradayScreeningResult(todayKey)) {
            setIntradayScreeningStatus('正在刷新，当前同日结果保留至请求完成。', 'loading');
        } else {
            var container = document.getElementById('intraday-screening-results');
            var timeEl = document.getElementById('intraday-screening-update-time');
            if (timeEl) timeEl.textContent = '';
            setIntradayScreeningStatus('正在获取今日盘中筛选…', 'loading');
            if (container) container.innerHTML = uiState.render('loading', {
                title: '正在获取盘中筛选',
                detail: '只有本次手动操作会发起请求。',
            });
        }

        var request = (async function () {
            try {
                var response = await window.AppDataClient.fetch('/intraday-screening', {}, {
                    force: true,
                    cacheMode: 'bypass_fresh',
                });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                var json = await response.json();
                if (!json.success || !json.data) throw new Error(json.message || '盘中筛选返回异常');
                var data = json.data;
                var currentDateKey = utils.getShanghaiDateKey();
                clearIntradayScreeningResultAcrossDay(currentDateKey);
                if (data.status === 'not_ready' || data.snapshotDate !== currentDateKey) {
                    renderIntradayScreeningNotReady(data, currentDateKey);
                    return data;
                }
                if (data.status !== 'ready') throw new Error('未知的盘中筛选状态');
                var parsed = parseIntradayScreeningModule(data.moduleHtml);
                renderIntradayScreeningReady(data, json.meta || null, parsed);
                return data;
            } catch (error) {
                console.error('盘中筛选获取失败：', error);
                var errorDateKey = utils.getShanghaiDateKey();
                clearIntradayScreeningResultAcrossDay(errorDateKey);
                renderIntradayScreeningError(errorDateKey);
                return null;
            }
        })();
        intradayScreeningRequest = request.finally(function () {
            if (intradayScreeningRequest) {
                intradayScreeningRequest = null;
                setIntradayScreeningButtonLoading(false);
            }
        });
        return intradayScreeningRequest;
    }

    function runIntradayScreening(force) {
        return loadIntradayScreeningData(force);
    }

    // ============================================================
    // 机会雷达
    // ============================================================

    var OPPORTUNITY_RADAR_CACHE_KEY = 'fund_tracker_opportunity_radar_cache';
    var OPPORTUNITY_RADAR_TTL_MS = 5 * 60 * 1000;

    async function loadOpportunityRadarData(force) {
        var container = document.getElementById('opportunity-radar-list');
        var timeEl = document.getElementById('opportunity-radar-update-time');
        if (!container) return;

        var cached = cache.readJson(OPPORTUNITY_RADAR_CACHE_KEY, null);
        var todayKey = utils.getShanghaiDateKey();
        if (!force && cached && cached.date === todayKey && cached.data
            && Date.now() - (cached.updatedAt || 0) < OPPORTUNITY_RADAR_TTL_MS) {
            renderOpportunityRadar(cached.data, false);
            return;
        }
        if (!cached || !cached.data || !Array.isArray(cached.data.items)) {
            container.innerHTML = uiState.render('loading', {
                title: '正在扫描机会',
                detail: '候选信号返回后会在这里更新。',
            });
        }

        try {
            var res = await window.AppDataClient.fetch('/opportunity-radar', { limit: 8 }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var json = await res.json();
            if (!json.success || !json.data || !Array.isArray(json.data.items)) throw new Error('数据异常');
            json.data.meta = json.meta || null;
            cache.writeJson(OPPORTUNITY_RADAR_CACHE_KEY, {
                date: todayKey,
                data: json.data,
                updatedAt: Date.now(),
            });
            renderOpportunityRadar(json.data, true);
            if (timeEl) {
                var prefix = dataStatus.label(json.meta, json.meta && json.meta.degraded ? '部分数据源不可用' : '更新');
                timeEl.textContent = prefix + ' · ' + utils.formatShanghaiTime(json.data.generatedAt || new Date().toISOString());
            }
        } catch (e) {
            console.error('机会雷达获取失败：', e);
            if (cached && cached.data && Array.isArray(cached.data.items)) {
                renderOpportunityRadar(cached.data, false);
                if (timeEl) timeEl.textContent = '缓存';
                return;
            }
            renderOpportunityRadarError();
        }
    }

    function renderOpportunityRadar(data, fresh) {
        var container = document.getElementById('opportunity-radar-list');
        var timeEl = document.getElementById('opportunity-radar-update-time');
        if (!container) return;
        var items = data && Array.isArray(data.items) ? data.items : [];
        if (timeEl && fresh) {
            var prefix = dataStatus.label(data.meta, data.meta && data.meta.degraded ? '部分数据源不可用' : '更新');
            timeEl.textContent = prefix + ' · ' + utils.formatShanghaiTime(data.generatedAt || new Date().toISOString());
        } else if (timeEl && !fresh) {
            timeEl.textContent = '缓存数据';
        }
        if (!items.length) {
            container.innerHTML = uiState.render('empty', {
                title: '暂无候选信号',
                detail: '当前筛选条件下没有满足要求的机会。',
            });
            return;
        }
        container.innerHTML = items.map(renderOpportunityRadarItem).join('');
        container.querySelectorAll('[data-radar-code]').forEach(function (row) {
            row.addEventListener('click', function () {
                var code = row.getAttribute('data-radar-code');
                if (code && window.AppWatchlist && typeof window.AppWatchlist.showStockFundFlow === 'function') {
                    window.AppWatchlist.showStockFundFlow(code);
                }
            });
        });
    }

    function renderOpportunityRadarItem(item) {
        var pct = formatSignedPercent(item.pct);
        var pctCls = trendClass(item.pct);
        var risk = item.risk || {};
        var warnings = item.marketWarnings || {};
        var riskStatus = risk.status || 'watch';
        var components = item.components || {};
        var availableComponentCount = Object.keys(components).filter(function (key) {
            return toFiniteNumber(components[key]) !== null;
        }).length;
        var visibleScore = availableComponentCount >= 3 ? item.score : null;
        var scoreCls = scoreClass(visibleScore);
        var tags = [item.topic].concat(item.newsHits || []).filter(Boolean)
            .map(function (tag) { return '<span>' + utils.escapeHtml(tag) + '</span>'; }).join('');
        var signals = (Array.isArray(item.signals) ? item.signals : [])
            .map(function (signal) { return utils.escapeHtml(signal.label || '信号'); }).join(' · ');
        var coverageText = '数据覆盖 ' + utils.escapeHtml(item.coverage == null ? '--' : item.coverage + '%');
        if (Array.isArray(item.missingSources) && item.missingSources.length) {
            var missingLabels = { topic: '题材', momentum: '动量', fund: '资金', technical: '技术', news: '新闻' };
            coverageText += ' · 缺 ' + utils.escapeHtml(item.missingSources.map(function (key) { return missingLabels[key] || key; }).join('/'));
        }
        var warningItems = [];
        if (warnings.monitored) {
            warningItems.push('重点监控' + (warnings.monitorEnd ? '至 ' + warnings.monitorEnd : ''));
        }
        if (warnings.anomaly) {
            warningItems.push('严重异动' + (warnings.anomalyRule ? '：' + warnings.anomalyRule : ''));
        }
        var warningHtml = warningItems.length
            ? '<div class="opportunity-radar-warnings">' + warningItems.map(function (warning) {
                return '<span>' + utils.escapeHtml(warning) + '</span>';
            }).join('') + '</div>'
            : '';
        return '<div class="opportunity-radar-item" data-radar-code="' + utils.escapeHtml(item.code || '') + '">' +
            '<div class="opportunity-radar-head">' +
                '<div class="opportunity-radar-stock">' +
                    '<span class="opportunity-radar-name">' + utils.escapeHtml(item.name || item.code || '--') + '</span>' +
                    '<span class="opportunity-radar-code">' + utils.escapeHtml(item.code || '') + '</span>' +
                '</div>' +
                '<div class="opportunity-radar-score ' + scoreCls + '">' +
                    '<strong>' + utils.escapeHtml(visibleScore == null ? '--' : String(visibleScore)) + '</strong>' +
                    '<span>初筛分</span>' +
                '</div>' +
                '<div class="opportunity-radar-pct ' + pctCls + '">' + utils.escapeHtml(pct) + '</div>' +
                '<div class="opportunity-radar-risk ' + utils.escapeHtml(riskStatus) + '">' + utils.escapeHtml(risk.label || '--') + '</div>' +
            '</div>' +
            warningHtml +
            '<div class="opportunity-radar-tags">' + (tags || '<span>题材待确认</span>') + '</div>' +
            '<div class="opportunity-radar-components">' +
                renderRadarMetric('题材', components.topic) +
                renderRadarMetric('动量', components.momentum) +
                renderRadarMetric('资金', components.fund) +
                renderRadarMetric('技术', components.technical) +
                renderRadarMetric('新闻', components.news) +
            '</div>' +
            '<div class="opportunity-radar-foot">' +
                '<span>' + utils.escapeHtml(signals || '等待更多信号确认') + '</span>' +
                '<span>近60日上涨日占比 ' + utils.escapeHtml(item.upDayRate60 == null ? '--' : item.upDayRate60 + '%') + '</span>' +
                '<span>' + coverageText + '</span>' +
            '</div>' +
        '</div>';
    }

    function renderRadarMetric(label, value) {
        var cls = scoreClass(value);
        return '<div class="opportunity-radar-metric">' +
            '<span>' + utils.escapeHtml(label) + '</span>' +
            '<strong class="' + cls + '">' + utils.escapeHtml(value == null ? '--' : String(value)) + '</strong>' +
        '</div>';
    }

    function renderOpportunityRadarError() {
        var container = document.getElementById('opportunity-radar-list');
        if (container) container.innerHTML = uiState.render('error', {
            title: '机会雷达暂不可用',
            detail: '请稍后重试，缓存内容不会被覆盖。',
            retryScope: 'signals',
        });
    }

    // ============================================================
    // 市场热度 (同花顺热榜 + 东财人气榜)
    // ============================================================

    function getActiveHotRankSource() {
        try { return window.AppStorage.getItem(KEYS.HOT_RANK_SOURCE_KEY) || 'ths'; } catch (e) { return 'ths'; }
    }
    function hotRankCacheKey(source) {
        return source === 'em' ? KEYS.HOT_RANK_CACHE_EM_KEY : KEYS.HOT_RANK_CACHE_THS_KEY;
    }

    async function loadHotRankData(source, force) {
        source = source || 'ths';
        var todayKey = utils.getShanghaiDateKey();
        var cacheKey = hotRankCacheKey(source);
        var cached = cache.readDailyDataCache(cacheKey);
        if (!force && cached && cached.date === todayKey && cached.data && Array.isArray(cached.data.items)) {
            renderHotRank(cached.data.items, source, false);
            return;
        }
        // 首次加载（无当日缓存）先给 loading 占位，避免列表空白无反馈。
        var hasTodayCache = !!(cached && cached.date === todayKey && cached.data && Array.isArray(cached.data.items));
        if (!hasTodayCache) {
            var loadingList = document.getElementById(source === 'em' ? 'hot-rank-list-em' : 'hot-rank-list-ths');
            if (loadingList) loadingList.innerHTML = '<li class="ui-state-host">' + uiState.render('loading', {
                title: '正在加载热榜',
                detail: '人气榜单返回后自动更新。',
            }) + '</li>';
        }
        try {
            var res = await window.AppDataClient.fetch('/hot-rank', { source: source, limit: 30 }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data || !Array.isArray(result.data.items)) throw new Error('数据异常');
            cache.writeDailyDataCache(cacheKey, todayKey, { source: source, items: result.data.items });
            renderHotRank(result.data.items, source, true, result.meta || null);
        } catch (e) {
            console.error('市场热度获取失败：', e);
            if (cached && cached.date === todayKey && cached.data && Array.isArray(cached.data.items)) {
                renderHotRank(cached.data.items, source, false);
                return;
            }
            renderHotRankError(source);
        }
    }

    function renderHotRank(items, source, fresh, meta) {
        var listId = source === 'em' ? 'hot-rank-list-em' : 'hot-rank-list-ths';
        var listEl = document.getElementById(listId);
        var timeEl = document.getElementById('hot-rank-update-time');
        if (!listEl) return;
        if (!items.length) {
            listEl.innerHTML = '<li class="ui-state-host">' + uiState.render('empty', {
                title: '暂无热榜数据',
                detail: '当前来源没有返回有效排名。',
            }) + '</li>';
            return;
        }
        if (timeEl && fresh) {
            timeEl.textContent = dataStatus.label(meta, '更新 ') + utils.formatShanghaiTime(new Date().toISOString());
        } else if (timeEl && !fresh) {
            timeEl.textContent = '缓存数据';
        }
        listEl.innerHTML = items.map(function (it) {
            it = it || {};
            var pctStr = formatSignedPercent(it.pct);
            var pctCls = trendClass(it.pct);
            var rankChg = toFiniteNumber(it.rankChg);
            var chgArrow = rankChg > 0 ? '↑' + rankChg : rankChg < 0 ? '↓' + Math.abs(rankChg) : '-';
            var chgCls = trendClass(rankChg);
            if (source === 'ths') {
                var concepts = (Array.isArray(it.concepts) ? it.concepts : [])
                    .map(function (c) { return '<span class="hot-rank-concept">' + utils.escapeHtml(c) + '</span>'; }).join('');
                var tag = it.tag ? '<span class="hot-rank-tag">' + utils.escapeHtml(it.tag) + '</span>' : '';
                return '<li class="hot-rank-item">' +
                    '<span class="hot-rank-rank">' + utils.escapeHtml(it.rank || '--') + '</span>' +
                    '<span class="hot-rank-stock"><span class="hot-rank-name">' + utils.escapeHtml(it.name || it.code || '--') + '</span><span class="hot-rank-code">' + utils.escapeHtml(it.code || '') + '</span></span>' +
                    '<span class="hot-rank-pct ' + pctCls + '">' + pctStr + '</span>' +
                    '<span class="hot-rank-heat">人气 ' + utils.escapeHtml(it.heat || '--') + '</span>' +
                    '<span class="hot-rank-chg ' + chgCls + '">' + chgArrow + '</span>' +
                    '<span class="hot-rank-concepts">' + concepts + tag + '</span>' +
                '</li>';
            } else {
                var price = toFiniteNumber(it.price);
                var priceStr = price === null ? '--' : price.toFixed(2);
                return '<li class="hot-rank-item">' +
                    '<span class="hot-rank-rank">' + utils.escapeHtml(it.rank || '--') + '</span>' +
                    '<span class="hot-rank-stock"><span class="hot-rank-name">' + utils.escapeHtml(it.name || it.code || '--') + '</span><span class="hot-rank-code">' + utils.escapeHtml(it.code || '') + '</span></span>' +
                    '<span class="hot-rank-price">' + priceStr + '</span>' +
                    '<span class="hot-rank-pct ' + pctCls + '">' + pctStr + '</span>' +
                    '<span class="hot-rank-chg ' + chgCls + '">' + chgArrow + '</span>' +
                '</li>';
            }
        }).join('');
    }

    function renderHotRankError(source) {
        var listId = source === 'em' ? 'hot-rank-list-em' : 'hot-rank-list-ths';
        var listEl = document.getElementById(listId);
        if (listEl) listEl.innerHTML = '<li class="ui-state-host">' + uiState.render('error', {
            title: '市场热度暂不可用',
            detail: '请稍后重新加载当前榜单。',
            retryScope: 'signals',
        }) + '</li>';
    }

    function initHotRankTabs() {
        var saved = getActiveHotRankSource();
        activateHotRankTab(saved);
        var tabs = document.querySelectorAll('.hot-rank-tab');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var source = tab.getAttribute('data-source');
                activateHotRankTab(source);
                try { window.AppStorage.setItem(KEYS.HOT_RANK_SOURCE_KEY, source); } catch (e) {}
                loadHotRankData(source);
            });
        });
        // 启动时不主动拉,等 dashboard tab 切到或 loadAllData 触发
    }

    function activateHotRankTab(source) {
        var tab = document.querySelector('.hot-rank-tab[data-source="' + source + '"]');
        if (!tab) return;
        var parent = tab.parentElement;
        parent.querySelectorAll('.hot-rank-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var cardBody = tab.closest('.card-body');
        if (cardBody) {
            cardBody.querySelectorAll('.hot-rank-panel').forEach(function (p) { p.classList.remove('active'); });
            var panel = cardBody.querySelector('#hot-rank-panel-' + source);
            if (panel) panel.classList.add('active');
        }
    }

    // ============================================================
    // 打板情绪 (涨停 / 炸板 / 跌停 / 昨涨停)
    // ============================================================

    function getActiveLimitUpType() {
        try {
            var t = window.AppStorage.getItem(KEYS.LIMIT_UP_TAB_KEY);
            return KEYS.LIMIT_UP_TYPES.indexOf(t) >= 0 ? t : 'zt';
        } catch (e) { return 'zt'; }
    }
    function setActiveLimitUpType(t) {
        try { window.AppStorage.setItem(KEYS.LIMIT_UP_TAB_KEY, t); } catch (e) {}
    }

    function updateLimitUpColumnLabels(type) {
        var stat = document.getElementById('limit-up-col-stat');
        var extra = document.getElementById('limit-up-col-extra');
        var labels = {
            zt: ['连板', '封单'],
            zb: ['开板', '振幅'],
            dt: ['连续', '封单'],
            yzt: ['昨日连板', '涨速'],
        };
        var pair = labels[type] || labels.zt;
        if (stat) stat.textContent = pair[0];
        if (extra) extra.textContent = pair[1];
    }

    async function loadLimitUpData(force) {
        var list = document.getElementById('limit-up-list');
        var summary = document.getElementById('limit-up-summary');
        if (!list || !summary) return;
        var activeType = getActiveLimitUpType();

        function fmtPct(p) {
            if (typeof p !== 'number' || !p) return '--';
            return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
        }
        function cls(p) { return p > 0 ? 'positive' : p < 0 ? 'negative' : 'neutral'; }

        function renderRow(type, item) {
            var pct = item.pct || 0;
            var pctC = cls(pct);
            var nameCode = '<div class="limit-up-name-cell">' +
                '<span class="limit-up-name">' + utils.escapeHtml(item.name || item.code) + '</span>' +
                '<span class="limit-up-code">' + utils.escapeHtml(item.code) + '</span>' +
                '</div>';
            if (type === 'zt') {
                return '<div class="limit-up-row">' +
                    nameCode +
                    '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                    '<span class="limit-up-stat">' + utils.escapeHtml(item.ztStat || (item.limitDays + '板')) + '</span>' +
                    '<span class="limit-up-seal">' + utils.escapeHtml(utils.formatYuan(item.sealFund)) + '</span>' +
                    '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
                '</div>';
            }
            if (type === 'zb') {
                return '<div class="limit-up-row">' +
                    nameCode +
                    '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                    '<span class="limit-up-stat">' + utils.escapeHtml(item.ztStat || (item.breakTimes + '次开板')) + '</span>' +
                    '<span class="limit-up-seal">振幅' + (item.amplitude || 0).toFixed(2) + '%</span>' +
                    '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
                '</div>';
            }
            if (type === 'dt') {
                return '<div class="limit-up-row">' +
                    nameCode +
                    '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                    '<span class="limit-up-stat">连续' + (item.dtDays || 0) + '板</span>' +
                    '<span class="limit-up-seal">封单' + utils.escapeHtml(utils.formatYuan(item.sealFund)) + '</span>' +
                    '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
                '</div>';
            }
            // yzt
            return '<div class="limit-up-row">' +
                nameCode +
                '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                '<span class="limit-up-stat">' + utils.escapeHtml(item.ztStat || (item.yLimitDays + '板')) + '</span>' +
                '<span class="limit-up-seal">涨速' + (item.speed || 0).toFixed(2) + '%</span>' +
                '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
            '</div>';
        }

        function renderItems(type, data) {
            if (!data || !Array.isArray(data.items) || data.items.length === 0) {
                list.innerHTML = uiState.render('empty', {
                    title: '暂无' + KEYS.LIMIT_UP_TAB_LABELS[type] + '数据',
                    detail: '当前交易日没有返回可显示的股票。',
                });
                return;
            }
            list.innerHTML = data.items.map(function (it) { return renderRow(type, it); }).join('');
        }

        function renderError(type) {
            list.innerHTML = uiState.render('error', {
                title: KEYS.LIMIT_UP_TAB_LABELS[type] + '数据暂不可用',
                detail: '请稍后重试，缓存可用时仍会优先显示缓存。',
                retryScope: 'signals',
            });
        }

        function renderSummary(s) {
            if (!s) { summary.innerHTML = ''; return; }
            // 顶部: 涨停 N | 炸板 N (炸板率 X%) | 跌停 N | 昨涨停晋级率 X% | 最高 N 板 | 连板梯队
            var ladder = s.ladder || {};
            var ladderStr = Object.keys(ladder).sort(function (a, b) { return a - b; })
                .map(function (k) { return k + '板' + ladder[k]; }).join(' / ') || '--';
            summary.innerHTML =
                '<div class="limit-up-stat-card">' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">涨停</span><span class="limit-up-stat-val positive">' + s.ztCount + '</span></div>' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">炸板</span><span class="limit-up-stat-val">' + s.zbCount + '<span class="limit-up-stat-sub"> ' + s.breakRate + '%</span></span></div>' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">跌停</span><span class="limit-up-stat-val negative">' + s.dtCount + '</span></div>' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">最高</span><span class="limit-up-stat-val">' + s.maxHeight + '板</span></div>' +
                '</div>' +
                '<div class="limit-up-stat-ladder">连板梯队: ' + utils.escapeHtml(ladderStr) +
                ' · 昨涨停晋级率 ' + s.promoteRate + '%</div>';
        }

        // 1) summary 永远先拉 (顶部卡片) — 日级持久
        var todayKey = utils.getShanghaiDateKey();
        var bypassCache = shouldBypassDailySignalCache(force);
        var sumKey = KEYS.SHORT_CACHE_KEYS.limitUpSummary;
        var sumCached = cache.readDailyDataCache(sumKey);
        if (!bypassCache && sumCached && sumCached.date === todayKey && sumCached.data) {
            renderSummary(sumCached.data);
        } else {
            try {
                var sumRes = await window.AppDataClient.fetch('/limit-up', { type: 'summary' }, requestOptions(force));
                var sumJson = await sumRes.json();
                if (sumJson.success) {
                    cache.writeDailyDataCache(sumKey, todayKey, sumJson.data);
                    renderSummary(sumJson.data);
                } else if (sumCached && sumCached.data) {
                    renderSummary(sumCached.data);
                }
            } catch (e) {
                console.error('打板情绪 summary 获取失败：', e);
                if (sumCached && sumCached.data) renderSummary(sumCached.data);
            }
        }

        // 2) 当前 active type 拉详情 — 日级持久
        var typeCacheKey = ({
            zt:  KEYS.SHORT_CACHE_KEYS.limitUpZt,
            zb:  KEYS.SHORT_CACHE_KEYS.limitUpZb,
            dt:  KEYS.SHORT_CACHE_KEYS.limitUpDt,
            yzt: KEYS.SHORT_CACHE_KEYS.limitUpYzt,
        })[activeType];
        var typeCached = cache.readDailyDataCache(typeCacheKey);
        if (!bypassCache && typeCached && typeCached.date === todayKey && typeCached.data) {
            renderItems(activeType, typeCached.data);
        } else {
            list.innerHTML = uiState.render('loading', {
                title: '正在加载' + KEYS.LIMIT_UP_TAB_LABELS[activeType] + '数据',
                detail: '最新列表返回后会在这里更新。',
            });
            try {
                var r = await window.AppDataClient.fetch('/limit-up', { type: activeType, limit: 100 }, requestOptions(force));
                var j = await r.json();
                if (j.success) {
                    cache.writeDailyDataCache(typeCacheKey, todayKey, j.data);
                    renderItems(activeType, j.data);
                } else if (typeCached && typeCached.date === todayKey && typeCached.data) {
                    renderItems(activeType, typeCached.data);
                } else {
                    renderError(activeType);
                }
            } catch (e) {
                console.error('打板情绪' + activeType + '获取失败:', e);
                if (typeCached && typeCached.date === todayKey && typeCached.data) {
                    renderItems(activeType, typeCached.data);
                } else {
                    renderError(activeType);
                }
            }
        }
        activateLimitUpTab(activeType);
    }

    function activateLimitUpTab(type) {
        var tab = document.querySelector('.limit-up-tab[data-type="' + type + '"]');
        if (!tab) return;
        updateLimitUpColumnLabels(type);
        var parent = tab.parentElement;
        parent.querySelectorAll('.limit-up-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var body = tab.closest('.card-body');
        if (body) {
            body.querySelectorAll('.limit-up-panel').forEach(function (p) { p.classList.remove('active'); });
            var panel = body.querySelector('#limit-up-panel-' + type);
            if (panel) panel.classList.add('active');
        }
    }

    function initLimitUpTabs() {
        var saved = getActiveLimitUpType();
        activateLimitUpTab(saved);
        var tabs = document.querySelectorAll('.limit-up-tab');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var t = tab.getAttribute('data-type');
                if (!t || KEYS.LIMIT_UP_TYPES.indexOf(t) < 0) return;
                setActiveLimitUpType(t);
                // 切换 tab 时按需加载 (cache 命中直接渲染,否则 fetch)
                loadLimitUpData();
            });
        });
    }

    window.AppSignals = {
        // sector rotation (manual only)
        normalizeSectorRotation: normalizeSectorRotation,
        runSectorRotation: runSectorRotation,
        // intraday screening (manual only)
        runIntradayScreening: runIntradayScreening,
        reconcileIntradayScreeningDate: reconcileIntradayScreeningDate,
        // opportunity radar
        loadOpportunityRadarData: loadOpportunityRadarData,
        renderOpportunityRadar: renderOpportunityRadar,
        renderOpportunityRadarError: renderOpportunityRadarError,
        // market heat
        getActiveHotRankSource: getActiveHotRankSource,
        hotRankCacheKey: hotRankCacheKey,
        loadHotRankData: loadHotRankData,
        renderHotRank: renderHotRank,
        renderHotRankError: renderHotRankError,
        initHotRankTabs: initHotRankTabs,
        activateHotRankTab: activateHotRankTab,
        // limit up
        getActiveLimitUpType: getActiveLimitUpType,
        setActiveLimitUpType: setActiveLimitUpType,
        loadLimitUpData: loadLimitUpData,
        activateLimitUpTab: activateLimitUpTab,
        initLimitUpTabs: initLimitUpTabs,
    };
})();
