// ================================================================
// 市场信号 — 机会雷达 / 市场热度（同花顺+东财合并榜）
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
    // 市场热度（同花顺热榜 + 东财人气榜合并榜）
    // 合并口径：每榜按名次折算分数 score = (N - rank + 1) / N * 100（N 为该榜条数）；
    // 两榜都有数据时各占 50%；只在一榜上榜的股票，另一榜记 0 分；
    // 某个数据源整体无数据时，权重自动归一（有数据的源占 100%）。
    // 合并后按综合分排序取前 30，并保留双榜原始名次供核对。
    // ============================================================

    var HOT_RANK_LIMIT = 30;

    function hotRankCacheKey(source) {
        return source === 'em' ? KEYS.HOT_RANK_CACHE_EM_KEY : KEYS.HOT_RANK_CACHE_THS_KEY;
    }
    // 兼容旧调用：合并榜没有“当前源”的概念，固定返回 combined。
    function getActiveHotRankSource() { return 'combined'; }

    function rankScore(items, rank) {
        var n = items.length;
        if (!n || !rank || rank < 1 || rank > n) return 0;
        return ((n - rank + 1) / n) * 100;
    }

    function mergeHotRankItems(thsItems, emItems) {
        var ths = Array.isArray(thsItems) ? thsItems : [];
        var em = Array.isArray(emItems) ? emItems : [];
        var hasThs = ths.length > 0;
        var hasEm = em.length > 0;
        var wThs = hasThs && hasEm ? 0.5 : hasThs ? 1 : 0;
        var wEm = hasThs && hasEm ? 0.5 : hasEm ? 1 : 0;
        var byKey = {};
        function keyOf(it, idx) { return String((it && (it.code || it.name)) || ('#' + idx)); }
        function addSource(items, source) {
            items.forEach(function (it, idx) {
                if (!it) return;
                var key = keyOf(it, idx);
                var rank = toFiniteNumber(it.rank) || (idx + 1);
                if (!byKey[key]) {
                    byKey[key] = {
                        code: it.code || '', name: it.name || it.code || '--',
                        pct: null, price: null, heat: null, concepts: [], tag: '',
                        thsRank: null, emRank: null, thsScore: 0, emScore: 0,
                    };
                }
                var row = byKey[key];
                if (it.name && (row.name === '--' || row.name === row.code)) row.name = it.name;
                if (row.pct === null && toFiniteNumber(it.pct) !== null) row.pct = it.pct;
                if (source === 'ths') {
                    row.thsRank = rank;
                    row.thsScore = rankScore(items, rank);
                    if (it.heat !== undefined && it.heat !== null && it.heat !== '') row.heat = it.heat;
                    if (Array.isArray(it.concepts)) row.concepts = it.concepts;
                    if (it.tag) row.tag = it.tag;
                } else {
                    row.emRank = rank;
                    row.emScore = rankScore(items, rank);
                    if (row.price === null && toFiniteNumber(it.price) !== null) row.price = it.price;
                }
            });
        }
        addSource(ths, 'ths');
        addSource(em, 'em');
        var merged = Object.keys(byKey).map(function (key) {
            var row = byKey[key];
            row.score = Math.round((wThs * row.thsScore + wEm * row.emScore) * 10) / 10;
            return row;
        });
        merged.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            var ra = (a.thsRank || 999) + (a.emRank || 999);
            var rb = (b.thsRank || 999) + (b.emRank || 999);
            return ra - rb;
        });
        var top = merged.slice(0, HOT_RANK_LIMIT);
        top.forEach(function (row, idx) { row.rank = idx + 1; });
        return { items: top, hasThs: hasThs, hasEm: hasEm, totalMerged: merged.length };
    }

    async function fetchHotRankSource(source, force) {
        var todayKey = utils.getShanghaiDateKey();
        var cacheKey = hotRankCacheKey(source);
        var cached = cache.readDailyDataCache(cacheKey);
        var hasTodayCache = !!(cached && cached.date === todayKey && cached.data && Array.isArray(cached.data.items));
        if (!force && hasTodayCache) return { items: cached.data.items, fresh: false };
        try {
            var res = await window.AppDataClient.fetch('/hot-rank', { source: source, limit: HOT_RANK_LIMIT }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data || !Array.isArray(result.data.items)) throw new Error('数据异常');
            cache.writeDailyDataCache(cacheKey, todayKey, { source: source, items: result.data.items });
            return { items: result.data.items, fresh: true, meta: result.meta || null };
        } catch (e) {
            console.error('市场热度（' + source + '）获取失败：', e);
            if (hasTodayCache) return { items: cached.data.items, fresh: false };
            return { items: [], fresh: false, failed: true };
        }
    }

    async function loadHotRankData(a, b) {
        // 兼容旧签名 loadHotRankData(source, force)：source 已无意义，布尔参数即 force。
        var force = typeof a === 'boolean' ? a : !!b;
        var listEl = document.getElementById('hot-rank-list');
        if (!listEl) return;
        var hadContent = !!listEl.querySelector('.hot-rank-item');
        if (!hadContent) {
            listEl.innerHTML = '<li class="ui-state-host">' + uiState.render('loading', {
                title: '正在加载热榜', detail: '双榜合并后会在这里更新。',
            }) + '</li>';
        }
        var both = await Promise.all([fetchHotRankSource('ths', force), fetchHotRankSource('em', force)]);
        var merged = mergeHotRankItems(both[0].items, both[1].items);
        if (!merged.items.length) { renderHotRankError(); return; }
        renderHotRank(merged, both[0].fresh || both[1].fresh, both[0].meta || both[1].meta);
    }

    function renderHotRank(merged, fresh, meta) {
        var listEl = document.getElementById('hot-rank-list');
        var timeEl = document.getElementById('hot-rank-update-time');
        if (!listEl || !merged) return;
        var items = merged.items || [];
        if (!items.length) { renderHotRankError(); return; }
        if (timeEl) {
            var note;
            if (!merged.hasThs) note = '东财人气榜单源计算（同花顺暂无数据）';
            else if (!merged.hasEm) note = '同花顺热榜单源计算（东财暂无数据）';
            else note = '双源合并 · 各 50%';
            timeEl.textContent = note + ' · ' + (fresh ? dataStatus.label(meta, '更新 ') + utils.formatShanghaiTime(new Date().toISOString()) : '缓存数据');
        }
        listEl.innerHTML = items.map(function (it) {
            var pctStr = formatSignedPercent(it.pct);
            var pctCls = trendClass(it.pct);
            var ranks = '同花顺 ' + (it.thsRank ? '#' + it.thsRank : '—') + ' · 东财 ' + (it.emRank ? '#' + it.emRank : '—');
            var tag = it.tag ? '<span class="hot-rank-tag">' + utils.escapeHtml(it.tag) + '</span>' : '';
            return '<li class="hot-rank-item">' +
                '<span class="hot-rank-rank">' + utils.escapeHtml(it.rank || '--') + '</span>' +
                '<span class="hot-rank-stock"><span class="hot-rank-name">' + utils.escapeHtml(it.name || it.code || '--') + '</span><span class="hot-rank-code">' + utils.escapeHtml(it.code || '') + '</span></span>' +
                '<span class="hot-rank-pct ' + pctCls + '">' + pctStr + '</span>' +
                '<span class="hot-rank-score">' + (typeof it.score === 'number' ? it.score.toFixed(1) : '--') + '</span>' +
                '<span class="hot-rank-sources">' + utils.escapeHtml(ranks) + tag + '</span>' +
            '</li>';
        }).join('');
    }

    function renderHotRankError() {
        var listEl = document.getElementById('hot-rank-list');
        if (listEl) listEl.innerHTML = '<li class="ui-state-host">' + uiState.render('error', {
            title: '市场热度暂不可用',
            detail: '同花顺与东财两个榜单都暂无数据，请稍后重新加载。',
            retryScope: 'signals',
        }) + '</li>';
    }

    // 双榜合并后不再有源切换 Tab，保留空实现兼容 app.js 启动调用。
    function initHotRankTabs() {}
    function activateHotRankTab() {}

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
        mergeHotRankItems: mergeHotRankItems,
        renderHotRank: renderHotRank,
        renderHotRankError: renderHotRankError,
        initHotRankTabs: initHotRankTabs,
        activateHotRankTab: activateHotRankTab,
    };
})();
