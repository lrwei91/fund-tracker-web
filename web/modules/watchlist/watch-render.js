// ================================================================
// 自选股 — 行情加载 / 列表渲染 / 迷你图 / 增删股 / 涨跌快照持久化
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var utils = W.utils;
    var uiState = window.AppUiState || {
        render: function (_kind, options) { return '<div class="watchlist-empty">' + utils.escapeHtml(options.title) + '</div>'; },
    };
    var KEYS = W.KEYS;

    var watchSparkCache = {};
    var watchSparkPending = {};
    var WATCH_SPARK_TTL_MS = 2 * 60 * 1000;
    var persistedQuoteSnapshot = null;

    async function resolveStockInput(input) {
        var value = input.trim();
        if (/^\d{6}$/.test(value)) return { code: value, name: '' };
        var res = await window.AppDataClient.fetch('/stock-search', { q: value });
        if (!res.ok) throw new Error('搜索失败 ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || json.data.length === 0) throw new Error('未找到股票');
        return json.data[0];
    }

    async function addStockToWatchlist() {
        var input = document.getElementById('stock-code-input');
        var button = document.getElementById('add-stock-btn');
        var rawValue = input.value.trim();
        if (!rawValue) { W.showWatchStatus('请输入股票代码或名称', 'error'); return; }
        button.disabled = true;
        button.textContent = '查询中';
        try {
            var match = await resolveStockInput(rawValue);
            var code = match.code;
            var list = W.getWatchlist();
            if (list.includes(code)) { W.showWatchStatus('已在当前分组中', 'error'); return; }
            list.push(code);
            W.saveActiveWatchlist(list);
            input.value = '';
            state.watchAlertState[code] = {
                openDate: utils.getShanghaiDateKey(),
                openPrice: null,
                addedPrice: null,
                addedAt: null,
                pendingAdd: true,
                lastTriggerPrice: null,
                lastTriggerTime: null,
            };
            if (window.AppAlerts) window.AppAlerts.saveWatchAlertState();
            W.showWatchStatus((match.name || code) + ' 已添加');
            W.renderWatchlist();
            W.loadSingleWatchQuote(code);
        } catch (e) {
            W.showWatchStatus(e.message || '没有找到匹配股票', 'error');
        } finally {
            button.disabled = false;
            button.textContent = '添加';
        }
    }

    function removeStockFromWatchlist(code) {
        var list = W.getWatchlist().filter(function (c) { return c !== code; });
        W.saveActiveWatchlist(list);
        var stillReferenced = W.getAllWatchCodes().includes(code);
        if (!stillReferenced && state.watchQuoteCache[code]) {
            delete state.watchQuoteCache[code];
            W.persistWatchQuoteCache();
        }
        if (!stillReferenced && state.watchMarketWarnings && state.watchMarketWarnings[code]) {
            delete state.watchMarketWarnings[code];
        }
        if (!stillReferenced && watchSparkCache[code]) delete watchSparkCache[code];
        if (!stillReferenced && watchSparkPending[code]) delete watchSparkPending[code];
        if (!stillReferenced && state.watchAlertState[code]) {
            delete state.watchAlertState[code];
            if (window.AppAlerts) window.AppAlerts.saveWatchAlertState();
        }
        if (!stillReferenced && state.watchlistRemarks && state.watchlistRemarks[code]) {
            delete state.watchlistRemarks[code];
            W.saveWatchlistRemarks();
        }
        W.renderWatchlist();
        W.showWatchStatus('已移除');
    }

    function renderWatchlist() {
        if (window.AppWorkbench) window.AppWorkbench.renderSummary();
        var grid = document.getElementById('watchlist-grid');
        var updateTimeEl = document.getElementById('watchlist-update-time');
        var codes = W.getWatchlist();
        var activeTab = W.getActiveWatchTab();
        var showCost = W.isHoldingTab();
        if (codes.length === 0) {
            grid.innerHTML = uiState.render('empty', {
                title: '“' + activeTab.name + '”暂无股票',
                detail: '通过上方输入框添加代码或股票名称。',
            });
            if (updateTimeEl) updateTimeEl.textContent = '';
            return;
        }

        var prevMap = W.getPrevChangePct();
        grid.innerHTML = codes.map(function (code) {
            var data = state.watchQuoteCache[code];
            var fresh = !!state.watchQuoteFreshCodes[code];
            var rawName = data ? data.name : code + '（待刷新）';
            var prev = Object.prototype.hasOwnProperty.call(prevMap, code) ? prevMap[code] : undefined;
            return renderWatchItem(
                code,
                W.getDisplayStockName(code, rawName),
                fresh && data ? data.price : '--',
                fresh && data ? data.changePercent : null,
                fresh && data ? data.volume : '--',
                prev,
                showCost,
                fresh,
            );
        }).join('');
        bindWatchRemove();
        grid.classList.toggle('with-cost', showCost);
        document.querySelector('.watchlist-header-row')?.classList.toggle('with-cost', showCost);
        bindWatchItemClick();
        if (window.AppWorkbench) window.AppWorkbench.markSelected();
        hydrateWatchSparklines(codes.filter(function (code) { return !!state.watchQuoteFreshCodes[code]; }));
        grid.querySelectorAll('.watchlist-fund-fill[data-w]').forEach(function (fill) {
            fill.style.width = fill.getAttribute('data-w') + '%';
        });
        var allFresh = codes.length > 0 && codes.every(function (code) { return !!state.watchQuoteFreshCodes[code]; });
        if (updateTimeEl) updateTimeEl.textContent = allFresh ? (state.watchQuoteUpdateTime || '') : '等待实时行情';
    }

    function persistWatchQuoteCache() {
        try {
            var snapshot = JSON.stringify(state.watchQuoteCache);
            if (snapshot === persistedQuoteSnapshot) return;
            persistedQuoteSnapshot = snapshot;
            window.AppStorage.setItem(KEYS.WATCH_QUOTE_CACHE_KEY, snapshot);
        } catch (e) {}
    }

    function persistWatchQuoteUpdateTime(value) {
        try { window.AppStorage.setItem(KEYS.WATCH_QUOTE_UPDATE_TIME_KEY, value || ''); } catch (e) {}
    }

    function applyWatchQuoteBatch(result, requestedCodes) {
        var codes = W.sanitizeCodes(requestedCodes || W.getAllWatchCodes());
        if (!result || result.success === false || !result.data) {
            var hadDisplayedQuotes = Object.keys(state.watchQuoteFreshCodes || {}).length > 0;
            state.watchQuoteFreshCodes = {};
            try { window.AppStorage.setItem(KEYS.WATCH_QUOTE_STATUS_KEY, 'stale'); } catch (e) {}
            if (hadDisplayedQuotes) {
                var section = document.querySelector('.watchlist-section');
                if (section) section.classList.add('is-stale');
                var updateTime = document.getElementById('watchlist-update-time');
                if (updateTime) updateTime.textContent = '更新失败 · 显示上次行情';
            } else {
                renderWatchlist();
            }
            return false;
        }
        var freshCodes = {};
        codes.forEach(function (code) {
            var data = result.data[code];
            if (data && data.price !== '0.00' && Number.isFinite(Number(data.priceValue))) {
                state.watchQuoteCache[code] = data;
                freshCodes[code] = true;
            }
        });
        state.watchQuoteFreshCodes = freshCodes;
        var activeSection = document.querySelector('.watchlist-section');
        if (activeSection) activeSection.classList.remove('is-stale');
        try {
            window.AppStorage.setItem(
                KEYS.WATCH_QUOTE_STATUS_KEY,
                Object.keys(freshCodes).length === codes.length ? 'fresh' : 'stale',
            );
        } catch (e) {}
        if (result.time) {
            state.watchQuoteUpdateTime = result.time;
            persistWatchQuoteUpdateTime(result.time);
        }
        persistWatchQuoteCache();
        renderWatchlist();
        W.persistCurrentChangePct();
        if (window.AppAlerts && typeof window.AppAlerts.checkAlerts === 'function') {
            window.AppAlerts.checkAlerts(result.data);
        }
        return true;
    }

    function markQuoteUnavailable(watchCodes, customCodes) {
        var hadDisplayedQuotes = Object.keys(state.watchQuoteFreshCodes || {}).length > 0;
        state.watchQuoteFreshCodes = {};
        try { window.AppStorage.setItem(KEYS.WATCH_QUOTE_STATUS_KEY, 'stale'); } catch (e) {}
        if (watchCodes && watchCodes.length) {
            if (hadDisplayedQuotes) {
                var section = document.querySelector('.watchlist-section');
                if (section) section.classList.add('is-stale');
                var updateTime = document.getElementById('watchlist-update-time');
                if (updateTime) updateTime.textContent = '更新失败 · 显示上次行情';
            } else {
                renderWatchlist();
            }
        }
        if (customCodes && customCodes.length) {
            state.customIndexFreshCodes = {};
            if (typeof W.renderCustomIndex === 'function') W.renderCustomIndex();
        }
    }

    async function loadWatchlistData() {
        var updateTimeEl = document.getElementById('watchlist-update-time');
        var codes = W.getAllWatchCodes();
        if (codes.length === 0) {
            renderWatchlist();
            return;
        }
        try {
            var res = await window.AppDataClient.fetch('/stock', { codes: codes.join(',') });
            if (!res.ok) throw new Error('请求失败 ' + res.status);
            var result = await res.json();
            if (!applyWatchQuoteBatch(result, codes)) throw new Error('数据异常');
            if (result.time && updateTimeEl) updateTimeEl.textContent = result.time;
        } catch (e) {
            console.error('自选股失败:', e);
            state.watchQuoteFreshCodes = {};
            try { window.AppStorage.setItem(KEYS.WATCH_QUOTE_STATUS_KEY, 'stale'); } catch (storageError) {}
            W.showWatchStatus('自选股行情加载失败', 'error');
            utils.setLastUpdated('加载失败');
            renderWatchlist();
        }
    }

    async function loadSingleWatchQuote(code) {
        var updateTimeEl = document.getElementById('watchlist-update-time');
        try {
            var res = await window.AppDataClient.fetch('/stock', { codes: code });
            if (!res.ok) throw new Error('请求失败 ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data) throw new Error('数据异常');
            var data = result.data[code];
            if (data && data.price !== '0.00' && Number.isFinite(Number(data.priceValue))) {
                state.watchQuoteCache[code] = data;
                state.watchQuoteFreshCodes[code] = true;
                var holdingCodes = W.getAllWatchCodes();
                var allFresh = holdingCodes.length > 0 && holdingCodes.every(function (item) {
                    return !!state.watchQuoteFreshCodes[item];
                });
                try { window.AppStorage.setItem(KEYS.WATCH_QUOTE_STATUS_KEY, allFresh ? 'fresh' : 'stale'); } catch (e) {}
            } else {
                delete state.watchQuoteFreshCodes[code];
            }
            if (result.time) {
                state.watchQuoteUpdateTime = result.time;
                persistWatchQuoteUpdateTime(result.time);
                if (updateTimeEl) updateTimeEl.textContent = result.time;
            }
            persistWatchQuoteCache();
            renderWatchlist();
            W.persistCurrentChangePct();
            loadWatchMarketWarnings([code], false);
            if (window.AppAlerts && typeof window.AppAlerts.checkAlerts === 'function') {
                window.AppAlerts.checkAlerts(result.data);
            }
        } catch (e) {
            console.error('新增股票行情获取失败：', e);
            delete state.watchQuoteFreshCodes[code];
            try { window.AppStorage.setItem(KEYS.WATCH_QUOTE_STATUS_KEY, 'stale'); } catch (storageError) {}
            W.showWatchStatus('已添加，行情稍后自动刷新', 'error');
            utils.setLastUpdated('加载失败');
            renderWatchlist();
        }
    }

    function renderWatchItem(code, name, price, changePercent, volume, prev, showCost, quoteFresh) {
        var numericChange = Number(changePercent);
        var cls = numericChange > 0 ? 'positive' : numericChange < 0 ? 'negative' : 'neutral';
        var pt = Number.isFinite(numericChange)
            ? (numericChange > 0 ? '+' + numericChange.toFixed(2) : numericChange.toFixed(2)) + '%'
            : '--';
        var arrow = (window.AppMarket && typeof window.AppMarket.trendArrow === 'function')
            ? window.AppMarket.trendArrow(changePercent, prev)
            : '─';
        var data = state.watchQuoteCache[code];
        var fresh = quoteFresh === undefined ? true : !!quoteFresh;
        var priceValue = fresh && data && typeof data.priceValue === 'number' ? data.priceValue : null;
        var displayPrice = utils.formatQuotePrice(priceValue, price, code, data && data.name ? data.name : name);
        var costCell = showCost ? renderCostCell(code, priceValue) : '';
        var spark = renderWatchSparklineCell(code, cls, fresh);
        var warningTags = renderWatchWarningTags(code);
        return '<div class="watchlist-item clickable" data-code="' + utils.escapeHtml(code) + '" data-pct="' + utils.escapeHtml(changePercent) + '">' +
            '<button class="watchlist-detail-trigger" type="button" aria-label="查看 ' + utils.escapeHtml(name) + ' ' + utils.escapeHtml(code) + ' 详情"></button>' +
            '<div class="watchlist-item-main">' +
            '<div class="watchlist-stock-name">' + utils.escapeHtml(name) + '</div>' +
            '<div class="watchlist-stock-code">' + utils.escapeHtml(code) + '</div>' + warningTags + '</div>' +
            spark +
            costCell +
            '<div class="watchlist-stock-price ' + cls + '">' + utils.escapeHtml(displayPrice) + '</div>' +
            '<div class="watchlist-stock-change ' + cls + '">' + utils.escapeHtml(pt) + ' <span class="trend-arrow">' + utils.escapeHtml(arrow) + '</span></div>' +
            '<button class="watchlist-remove-btn" data-code="' + utils.escapeHtml(code) + '" aria-label="删除 ' + utils.escapeHtml(code) + '">✕</button></div>';
    }

    function renderWatchWarningTags(code) {
        var warning = state.watchMarketWarnings && state.watchMarketWarnings[code];
        if (!warning) return '';
        var tags = [];
        if (warning.anomaly === true) {
            tags.push('<span class="watchlist-warning-tag anomaly" title="' + utils.escapeHtml(warning.anomalyRule || '严重异动') + '">严重异动</span>');
        } else if (warning.anomalyWarning === true) {
            var anomalyWarningTitle = warning.anomalyWarningRule || '严重异动预警';
            if (warning.anomalyWarningPredictionType === 0) {
                anomalyWarningTitle += '；当日尚未触发';
            } else if (warning.anomalyWarningPredictionType === 2) {
                anomalyWarningTitle += '；次日预测';
            }
            var triggerPct = Number(warning.anomalyWarningTriggerPct);
            if (Number.isFinite(triggerPct)) {
                anomalyWarningTitle += '；参考触发涨跌幅 ' + (triggerPct > 0 ? '+' : '') + triggerPct.toFixed(2) + '%';
            }
            tags.push('<span class="watchlist-warning-tag anomaly-warning" title="' + utils.escapeHtml(anomalyWarningTitle) + '">严重异动预警</span>');
        }
        if (warning.monitored === true) {
            var monitorTitle = warning.monitorEnd ? '重点监控至 ' + warning.monitorEnd : '重点监控';
            tags.push('<span class="watchlist-warning-tag monitored" title="' + utils.escapeHtml(monitorTitle) + '">重点监控</span>');
        }
        return tags.length ? '<div class="watchlist-stock-tags">' + tags.join('') + '</div>' : '';
    }

    function applyWatchMarketWarnings(result, requestedCodes) {
        if (!result || result.success === false || !result.data || typeof result.data !== 'object') return false;
        if (!state.watchMarketWarnings || typeof state.watchMarketWarnings !== 'object') state.watchMarketWarnings = {};
        W.sanitizeCodes(requestedCodes || W.getAllWatchCodes()).forEach(function (code) {
            var incoming = result.data[code] || {};
            var previous = state.watchMarketWarnings[code] || {};
            state.watchMarketWarnings[code] = {
                anomaly: typeof incoming.anomaly === 'boolean' ? incoming.anomaly : previous.anomaly === true,
                anomalyRule: incoming.anomalyRule || previous.anomalyRule || '',
                anomalyWarning: typeof incoming.anomalyWarning === 'boolean' ? incoming.anomalyWarning : previous.anomalyWarning === true,
                anomalyWarningRule: incoming.anomalyWarningRule || previous.anomalyWarningRule || '',
                anomalyWarningPredictionType: incoming.anomalyWarningPredictionType === 0 || incoming.anomalyWarningPredictionType === 2
                    ? incoming.anomalyWarningPredictionType : previous.anomalyWarningPredictionType,
                anomalyWarningTriggerPct: typeof incoming.anomalyWarningTriggerPct === 'number' && Number.isFinite(incoming.anomalyWarningTriggerPct)
                    ? incoming.anomalyWarningTriggerPct : previous.anomalyWarningTriggerPct,
                monitored: typeof incoming.monitored === 'boolean' ? incoming.monitored : previous.monitored === true,
                monitorEnd: incoming.monitorEnd || previous.monitorEnd || '',
            };
        });
        renderWatchlist();
        return true;
    }

    async function loadWatchMarketWarnings(codes, force) {
        var cleanCodes = W.sanitizeCodes(codes || W.getAllWatchCodes());
        if (!cleanCodes.length || !window.AppDataClient) return false;
        try {
            var result = await window.AppDataClient.fetchData('/market-warnings', {
                codes: cleanCodes.join(','),
            }, {
                force: !!force,
                cacheMode: force ? 'bypass_fresh' : 'normal',
            });
            return applyWatchMarketWarnings(result, cleanCodes);
        } catch (error) {
            console.error('自选股市场异动获取失败：', error);
            return false;
        }
    }

    function renderWatchSparklineCell(code, cls, quoteFresh) {
        if (quoteFresh === false) {
            return '<div class="watchlist-stock-sparkline ' + cls + '" data-watch-spark="' + utils.escapeHtml(code) + '"></div>';
        }
        var cached = watchSparkCache[code];
        var svg = cached && Array.isArray(cached.points)
            ? renderWatchSparkline(cached.points, cls, cached.preClose)
            : '';
        return '<div class="watchlist-stock-sparkline ' + cls + '" data-watch-spark="' + utils.escapeHtml(code) + '">' + svg + '</div>';
    }

    var sparkQueue = [];
    var sparkActive = 0;
    var sparkObserver = null;

    function runNextSparkline() {
        if (sparkActive >= 2 || !sparkQueue.length) return;
        var code = sparkQueue.shift();
        sparkActive += 1;
        W.loadStockMinuteData(code)
            .then(function (data) {
                var points = data && Array.isArray(data.points) ? data.points.filter(function (point) {
                    return point && W.readFiniteNumber(point.price) !== null;
                }) : [];
                watchSparkCache[code] = { ts: Date.now(), points: points, preClose: W.readFiniteNumber(data && data.preClose) };
                updateWatchSparklineDom(code);
            })
            .catch(function () {
                watchSparkCache[code] = { ts: Date.now(), points: [], preClose: null };
            })
            .finally(function () {
                delete watchSparkPending[code];
                sparkActive -= 1;
                runNextSparkline();
            });
        runNextSparkline();
    }

    function queueSparkline(code) {
        var cached = watchSparkCache[code];
        if (cached && Date.now() - cached.ts < WATCH_SPARK_TTL_MS) {
            updateWatchSparklineDom(code);
            return;
        }
        if (watchSparkPending[code] || sparkQueue.indexOf(code) !== -1) return;
        watchSparkPending[code] = true;
        sparkQueue.push(code);
        runNextSparkline();
    }

    function hydrateWatchSparklines(codes) {
        var cleanCodes = W.sanitizeCodes(codes);
        if (!cleanCodes.length) return;
        if (typeof window.IntersectionObserver !== 'function') {
            cleanCodes.forEach(queueSparkline);
            return;
        }
        if (!sparkObserver) {
            sparkObserver = new window.IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    var code = entry.target.getAttribute('data-watch-spark');
                    if (code) queueSparkline(code);
                    sparkObserver.unobserve(entry.target);
                });
            }, { rootMargin: '180px' });
        }
        cleanCodes.forEach(function (code) {
            var cached = watchSparkCache[code];
            if (cached && Date.now() - cached.ts < WATCH_SPARK_TTL_MS) {
                updateWatchSparklineDom(code);
                return;
            }
            var cell = document.querySelector('.watchlist-stock-sparkline[data-watch-spark="' + code + '"]');
            if (cell) sparkObserver.observe(cell);
        });
    }

    function updateWatchSparklineDom(code) {
        var cell = document.querySelector('.watchlist-stock-sparkline[data-watch-spark="' + code + '"]');
        if (!cell) return;
        var item = cell.closest('.watchlist-item');
        var pct = item ? Number(item.getAttribute('data-pct')) : 0;
        var cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
        cell.className = 'watchlist-stock-sparkline ' + cls;
        var cached = watchSparkCache[code] || {};
        cell.innerHTML = renderWatchSparkline(cached.points || [], cls, cached.preClose);
    }

    function renderWatchSparkline(points, cls, preClose) {
        var values = (Array.isArray(points) ? points : []).map(function (point) {
            return W.readFiniteNumber(point.price);
        }).filter(function (value) {
            return value !== null;
        });
        if (values.length < 2) return '';
        var width = 180;
        var height = 44;
        var pad = 2;
        var base = W.readFiniteNumber(preClose);
        var scaleValues = values.slice();
        if (base !== null && base > 0) scaleValues.push(base);
        var min = Math.min.apply(Math, scaleValues);
        var max = Math.max.apply(Math, scaleValues);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
        if (min === max) {
            min -= Math.max(0.01, Math.abs(min) * 0.001);
            max += Math.max(0.01, Math.abs(max) * 0.001);
        }
        var yScale = function (value) {
            return pad + (max - value) / (max - min) * (height - pad * 2);
        };
        var d = values.map(function (value, index) {
            var x = pad + index / Math.max(1, values.length - 1) * (width - pad * 2);
            var y = yScale(value);
            return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
        }).join(' ');
        var zeroAxis = '';
        if (base !== null && base > 0) {
            var zeroY = yScale(base);
            zeroAxis = '<line class="watchlist-stock-sparkline-zero" x1="' + pad + '" y1="' + zeroY.toFixed(2) + '" x2="' + (width - pad) + '" y2="' + zeroY.toFixed(2) + '"></line>';
        }
        return '<svg viewBox="0 0 ' + width + ' ' + height + '" aria-label="当日走势" role="img" focusable="false">' +
            zeroAxis +
            '<path class="watchlist-stock-sparkline-path ' + utils.escapeHtml(cls) + '" d="' + d + '"></path>' +
        '</svg>';
    }

    function renderCostCell(code, priceValue) {
        var entry = state.watchlistCost[code];
        if (!entry || typeof entry.cost !== 'number' || !Number.isFinite(entry.cost)) {
            return '<div class="watchlist-stock-cost">' +
                '<div class="cost-value empty">--</div>' +
                '<div class="cost-pnl">未设成本</div>' +
                '</div>';
        }
        var cost = entry.cost;
        var shares = typeof entry.shares === 'number' && Number.isFinite(entry.shares) ? entry.shares : 0;
        var pnl = null;
        if (priceValue !== null && Number.isFinite(priceValue)) {
            pnl = (priceValue - cost) * shares;
        }
        var pnlCls = pnl === null ? '' : (pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '');
        var pnlText = pnl === null
            ? '--'
            : (pnl > 0 ? '+' : '') + pnl.toFixed(2);
        return '<div class="watchlist-stock-cost">' +
            '<div class="cost-value">' + cost.toFixed(2) + '</div>' +
            '<div class="cost-pnl ' + pnlCls + '">' + pnlText + '</div>' +
            '</div>';
    }

    function saveWatchlistCost() {
        try { window.AppStorage.setItem(KEYS.WATCHLIST_COST_KEY, JSON.stringify(state.watchlistCost)); } catch (e) {}
    }

    function saveWatchlistRemarks() {
        try { window.AppStorage.setItem(KEYS.WATCHLIST_REMARKS_KEY, JSON.stringify(state.watchlistRemarks || {})); } catch (e) {}
    }

    function bindWatchRemove() {
        var grid = document.getElementById('watchlist-grid');
        if (!grid || grid.dataset.removeBound === 'true') return;
        grid.dataset.removeBound = 'true';
        grid.addEventListener('click', function (e) {
            var button = e.target.closest('.watchlist-remove-btn');
            if (!button) return;
            e.stopPropagation();
            removeStockFromWatchlist(button.getAttribute('data-code'));
        });
    }

    function bindWatchItemClick() {
        var grid = document.getElementById('watchlist-grid');
        if (!grid || grid.dataset.clickBound === 'true') return;
        grid.dataset.clickBound = 'true';
        grid.addEventListener('click', function (e) {
            var trigger = e.target.closest('.watchlist-detail-trigger');
            if (!trigger) return;
            var item = trigger.closest('.watchlist-item');
            if (!item) return;
            var code = item.getAttribute('data-code');
            if (code) W.showStockFundFlow(code, trigger);
        });
    }

    function refreshStaleWatchQuotes() {
        var codes = W.getAllWatchCodes();
        if (codes.length === 0) return;
        var stale = codes.filter(function (c) { return !state.watchQuoteFreshCodes[c]; });
        if (stale.length === 0) return;
        var lastPull = 0;
        try { lastPull = parseInt(window.AppStorage.getItem(KEYS.WATCH_REFRESH_THROTTLE_KEY) || '0', 10) || 0; } catch (e) {}
        if (Date.now() - lastPull < KEYS.WATCH_REFRESH_THROTTLE_MS) return;
        window.AppDataClient.fetch('/stock', { codes: stale.join(',') })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (result) {
                if (!result || !result.success || !result.data) return;
                var freshCodes = {};
                Object.keys(result.data).forEach(function (code) {
                    var d = result.data[code];
                    if (d && d.price !== '0.00' && Number.isFinite(Number(d.priceValue))) {
                        state.watchQuoteCache[code] = d;
                        freshCodes[code] = true;
                    }
                });
                state.watchQuoteFreshCodes = freshCodes;
                try { window.AppStorage.setItem(KEYS.WATCH_QUOTE_STATUS_KEY, Object.keys(freshCodes).length === codes.length ? 'fresh' : 'stale'); } catch (e) {}
                if (result.time) {
                    state.watchQuoteUpdateTime = result.time;
                    persistWatchQuoteUpdateTime(result.time);
                }
                persistWatchQuoteCache();
                renderWatchlist();
                try { window.AppStorage.setItem(KEYS.WATCH_REFRESH_THROTTLE_KEY, String(Date.now())); } catch (e) {}
            })
            .catch(function () { /* 非交易时段拉取失败属正常,静默 */ });
    }

    W.resolveStockInput = resolveStockInput;
    W.addStockToWatchlist = addStockToWatchlist;
    W.removeStockFromWatchlist = removeStockFromWatchlist;
    W.renderWatchlist = renderWatchlist;
    W.persistWatchQuoteCache = persistWatchQuoteCache;
    W.persistWatchQuoteUpdateTime = persistWatchQuoteUpdateTime;
    W.loadWatchlistData = loadWatchlistData;
    W.applyWatchQuoteBatch = applyWatchQuoteBatch;
    W.loadWatchMarketWarnings = loadWatchMarketWarnings;
    W.applyWatchMarketWarnings = applyWatchMarketWarnings;
    W.markQuoteUnavailable = markQuoteUnavailable;
    W.loadSingleWatchQuote = loadSingleWatchQuote;
    W.renderWatchItem = renderWatchItem;
    W.renderWatchWarningTags = renderWatchWarningTags;
    W.renderCostCell = renderCostCell;
    W.saveWatchlistCost = saveWatchlistCost;
    W.saveWatchlistRemarks = saveWatchlistRemarks;
    W.bindWatchRemove = bindWatchRemove;
    W.bindWatchItemClick = bindWatchItemClick;
    W.refreshStaleWatchQuotes = refreshStaleWatchQuotes;
})();
