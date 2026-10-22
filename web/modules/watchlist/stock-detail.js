// ================================================================
// 自选股 — 单股详情弹窗:分时 / 技术面 / 筹码 / 持仓成本编辑器 / 数据加载
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var utils = W.utils;
    var uiState = window.AppUiState || {
        render: function (_kind, options) { return '<div class="list-empty">' + utils.escapeHtml(options.title) + '</div>'; },
    };
    var dataStatus = window.AppDataStatus || { label: function (_meta, fallback) { return fallback || ''; } };

    var detailRequest = 0;
    W.invalidateDetail = function () { detailRequest += 1; };

    async function loadStockMinuteData(code) {
        var res = await window.AppDataClient.fetch('/stock-minute', { code: code, count: 240 });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || !Array.isArray(json.data.points)) throw new Error('分时数据异常');
        json.data.meta = json.meta || null;
        return json.data;
    }

    async function loadStockFundFlowData(code) {
        var res = await window.AppDataClient.fetch('/fund-flow-120d', { codes: code, days: 60 });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || !Array.isArray(json.data.items) || !json.data.items.length) {
            throw new Error('资金流数据异常');
        }
        var item = json.data.items[0];
        if (item.available === false) throw new Error(item.fallbackReason || '资金流数据不可用');
        var recent = item.recent || [];
        var last = recent.length ? recent[recent.length - 1] : null;
        var prev = recent.length > 1 ? recent[recent.length - 2] : null;
        var latestFlow = item.summary && item.summary.today ? item.summary.today : (last ? {
            main: last.mainNet,
            large: last.largeNet,
            medium: last.midNet,
            small: last.smallNet,
        } : null);
        return {
            item: item,
            latestFlow: latestFlow,
            last: last,
            prevMain: prev ? prev.mainNet : null,
            lastDate: last ? last.date : (item.latestDate || ''),
            meta: json.meta || null,
        };
    }

    async function loadStockKlineData(code) {
        var res = await window.AppDataClient.fetch('/stock-kline', { code: code, days: 260 });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || !json.data.analysis) throw new Error('技术面数据异常');
        json.data.meta = json.meta || null;
        return json.data;
    }

    async function loadStockNewsData(code, name) {
        var res = await window.AppDataClient.fetch('/stock-news', { code: code, name: name || '', limit: 6 });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || !Array.isArray(json.data.items)) throw new Error('新闻数据异常');
        json.data.meta = json.meta || null;
        return json.data;
    }

    async function showStockFundFlow(code, trigger) {
        var panel = document.getElementById('stock-fund-panel');
        var overlay = document.getElementById('stock-fund-overlay');
        var body = document.getElementById('stock-fund-body');
        var title = document.getElementById('stock-fund-title');
        if (!panel || !overlay || !body || !title) return;
        if (window.AppWorkbench) {
            window.AppWorkbench.openDetail(code, trigger);
        } else if (window.AppDialog) {
            window.AppDialog.open(panel, overlay, {
                trigger: trigger || document.activeElement,
                restoreFocus: function () {
                    return document.querySelector('.watchlist-item[data-code="' + code + '"] .watchlist-detail-trigger');
                },
                hideOnClose: true,
                focusTarget: document.getElementById('stock-fund-close'),
            });
        } else {
            overlay.hidden = false;
            panel.hidden = false;
        }
        var requestId = ++detailRequest;
        var cachedQuote = state.watchQuoteCache[code];
        title.textContent = W.getDisplayStockName(code, cachedQuote && cachedQuote.name) + ' (' + code + ')';
        body.innerHTML = uiState.render('loading', {
            title: '正在加载个股详情',
            detail: '行情、技术面和资金数据返回后会在这里更新。',
        });

        var loaders = [
            function () { return loadStockMinuteData(code); },
            function () { return loadStockFundFlowData(code); },
            function () { return loadStockKlineData(code); },
            function () { return loadStockNewsData(code, cachedQuote && cachedQuote.name); },
        ];
        var results = window.AppRefreshCoordinator && typeof window.AppRefreshCoordinator.runDetail === 'function'
            ? await window.AppRefreshCoordinator.runDetail(loaders.map(function (run) { return { run: run }; }))
            : await Promise.allSettled(loaders.map(function (run) { return run(); }));
        if (requestId !== detailRequest || panel.hidden) return;
        var minuteData = results[0].status === 'fulfilled' ? results[0].value : null;
        var minuteError = results[0].status === 'rejected' ? results[0].reason : null;
        var fundData = results[1].status === 'fulfilled' ? results[1].value : null;
        var fundError = results[1].status === 'rejected' ? results[1].reason : null;
        var klineData = results[2].status === 'fulfilled' ? results[2].value : null;
        var klineError = results[2].status === 'rejected' ? results[2].reason : null;
        var newsData = results[3].status === 'fulfilled' ? results[3].value : null;
        var newsError = results[3].status === 'rejected' ? results[3].reason : null;

        if (fundData && fundData.item) {
            title.textContent = W.getDisplayStockName(code, fundData.item.name || code) + ' (' + code + ')';
        } else if (minuteData && minuteData.name) {
            title.textContent = W.getDisplayStockName(code, minuteData.name || code) + ' (' + code + ')';
        } else if (klineData && klineData.name) {
            title.textContent = W.getDisplayStockName(code, klineData.name || code) + ' (' + code + ')';
        }
        body.innerHTML = renderStockModalBody(code, minuteData, minuteError, fundData, fundError, klineData, klineError, newsData, newsError);
        body.querySelectorAll('.watchlist-fund-fill[data-w]').forEach(function (fill) {
            fill.style.width = fill.getAttribute('data-w') + '%';
        });
        initStockDetailTabs(body);
        if (window.AppResearch) window.AppResearch.mount(body.querySelector('[data-stock-research-host]'), code);
        if (window.AppPriceAlerts) window.AppPriceAlerts.mount(body.querySelector('[data-stock-alert-host]'), code);
    }

    function renderStockModalBody(code, minuteData, minuteError, fundData, fundError, klineData, klineError, newsData, newsError) {
        var researchHtml = window.AppResearch
            ? '<div data-stock-research-host></div>'
            : renderStockCostEditor(code) + renderStockResearchGate(code, minuteData, fundData, klineData, newsData, newsError);
        var minuteHtml = renderStockMinuteSection(minuteData, minuteError) + renderStockAnalysisSection(klineData, klineError) + '<div class="stock-fund-section-title">相关资讯</div>' + renderStockNewsList(newsData, newsError);
        var fundHtml = '';
        if (fundData && fundData.item) {
            fundHtml += W.renderStockFundFlowBody(fundData.item, fundData.latestFlow, fundData.last, fundData.prevMain, {
                includeEditor: false,
                date: fundData.lastDate,
            });
            if (fundData.meta && (fundData.meta.stale || fundData.meta.degraded)) {
                fundHtml = '<div class="stock-analysis-source">' + utils.escapeHtml(dataStatus.label(fundData.meta, '资金流')) + '</div>' + fundHtml;
            }
        } else {
            fundHtml += '<div class="stock-fund-summary">' +
                '<div class="stock-fund-section-title">资金流</div>' +
                '<div class="list-empty">资金流加载失败: ' + utils.escapeHtml(fundError && fundError.message ? fundError.message : '数据异常') + '</div>' +
            '</div>';
        }
        return (W.getHoldingCodes().includes(code) ? '<details class="research-position-editor"><summary>编辑成本、股数与备注</summary>' + renderStockCostEditor(code) + '</details>' : '') + '<div class="stock-detail-tabs" role="tablist" aria-label="标的资料">' +
                '<button class="stock-detail-tab active" data-stock-detail-tab="minute" type="button">行情</button>' +
                '<button class="stock-detail-tab" data-stock-detail-tab="research" type="button">研究</button>' +
                '<button class="stock-detail-tab" data-stock-detail-tab="fund" type="button">资金</button>' +
                '<button class="stock-detail-tab" data-stock-detail-tab="alerts" type="button">价格提醒</button>' +
            '</div>' +
            '<div class="stock-detail-pages">' +
                renderStockDetailPage('research', researchHtml, false) +
                renderStockDetailPage('minute', minuteHtml, true) +
                renderStockDetailPage('fund', fundHtml, false) +
                renderStockDetailPage('alerts', '<div data-stock-alert-host></div>', false) +
            '</div>';
    }

    function renderStockDetailPage(id, html, active) {
        return '<section class="stock-detail-page' + (active ? ' active' : '') + '" data-stock-detail-page="' + utils.escapeHtml(id) + '">' + html + '</section>';
    }

    function initStockDetailTabs(root) {
        if (!root) return;
        var tabs = root.querySelectorAll('[data-stock-detail-tab]');
        function select(target) {
            tabs.forEach(function (item) {
                var active = item.getAttribute('data-stock-detail-tab') === target;
                item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
                item.classList.toggle('active', active);
            });
            root.querySelectorAll('[data-stock-detail-page]').forEach(function (page) {
                page.classList.toggle('active', page.getAttribute('data-stock-detail-page') === target);
            });
        }
        select('minute');
        tabs.forEach(function (tab, index) {
            tab.addEventListener('click', function () { select(tab.getAttribute('data-stock-detail-tab')); });
            tab.addEventListener('keydown', function (event) {
                var direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (direction) { event.preventDefault(); var next = tabs[(index + direction + tabs.length) % tabs.length]; next.click(); next.focus(); }
            });
        });
    }

    function renderStockCostEditor(code) {
        if (!W.getHoldingCodes().includes(code)) return '';
        var entry = state.watchlistCost[code] || {};
        var costVal = typeof entry.cost === 'number' && Number.isFinite(entry.cost) ? entry.cost : '';
        var sharesVal = typeof entry.shares === 'number' && Number.isFinite(entry.shares) ? entry.shares : '';
        var remarkVal = state.watchlistRemarks && state.watchlistRemarks[code] ? state.watchlistRemarks[code] : '';
        return '<form class="stock-cost-editor" data-stock-cost-form data-code="' + utils.escapeHtml(code) + '">' +
            '<div class="stock-fund-section-title">持仓设置</div>' +
            '<label class="stock-cost-field stock-remark-field">' +
                '<span>备注名</span>' +
                '<input type="text" maxlength="16" data-remark-input placeholder="为空显示原始股票名" value="' + utils.escapeHtml(String(remarkVal)) + '">' +
            '</label>' +
            '<div class="stock-cost-editor-row">' +
                '<label class="stock-cost-field">' +
                    '<span>成本价</span>' +
                    '<input type="number" step="0.01" min="0" data-cost-input placeholder="0.00" value="' + utils.escapeHtml(String(costVal)) + '">' +
                '</label>' +
                '<label class="stock-cost-field">' +
                    '<span>股数</span>' +
                    '<input type="number" step="1" min="0" data-shares-input placeholder="0" value="' + utils.escapeHtml(String(sharesVal)) + '">' +
                '</label>' +
            '</div>' +
            '<div class="stock-cost-actions">' +
                '<button type="submit" class="stock-cost-save-btn">保存设置</button>' +
            '</div>' +
        '</form>';
    }

    function saveStockCostFromForm(form) {
        if (!form) return;
        var code = form.getAttribute('data-code');
        var costInput = form.querySelector('[data-cost-input]');
        var sharesInput = form.querySelector('[data-shares-input]');
        var remarkInput = form.querySelector('[data-remark-input]');
        var cost = parseFloat(costInput ? costInput.value : '');
        var shares = parseFloat(sharesInput ? sharesInput.value : '');
        var remark = String(remarkInput ? remarkInput.value : '').trim().slice(0, 16);
        if (Number.isFinite(cost) && cost > 0) {
            state.watchlistCost[code] = {
                cost: cost,
                shares: Number.isFinite(shares) && shares > 0 ? shares : 0,
            };
        } else {
            delete state.watchlistCost[code];
        }
        if (!state.watchlistRemarks || typeof state.watchlistRemarks !== 'object') state.watchlistRemarks = {};
        if (remark) state.watchlistRemarks[code] = remark;
        else delete state.watchlistRemarks[code];
        W.saveWatchlistCost();
        W.saveWatchlistRemarks();
        W.renderWatchlist();
        W.showWatchStatus('持仓设置已保存');
    }

    function clampNumber(value, min, max) {
        var number = W.readFiniteNumber(value);
        if (number === null) return min;
        return Math.max(min, Math.min(max, number));
    }

    function latestMinutePct(data) {
        var points = data && Array.isArray(data.points) ? data.points : [];
        if (!points.length) return null;
        return pointChangePercent(points[points.length - 1], data.preClose);
    }

    function pushResearchReason(list, type, title, detail) {
        list.push({
            type: type === 'positive' || type === 'negative' ? type : 'neutral',
            title: title,
            detail: detail || '',
        });
    }

    function gateLabel(gate) {
        if (gate === 'block') return '回避';
        if (gate === 'watch') return '观察';
        return '可跟踪';
    }

    function gateClass(gate) {
        if (gate === 'block') return 'negative';
        if (gate === 'watch') return 'neutral';
        return 'positive';
    }

    function buildStockResearchGate(code, minuteData, fundData, klineData, newsData) {
        var cachedQuote = state.watchQuoteCache[code] || {};
        var name = cachedQuote.name || (minuteData && minuteData.name) || (klineData && klineData.name) || code;
        var analysis = klineData && klineData.analysis ? klineData.analysis : {};
        var indicators = analysis.indicators || {};
        var newsScore = newsData && newsData.score ? newsData.score : {};
        var positiveHits = Array.isArray(newsScore.positiveHits) ? newsScore.positiveHits : [];
        var riskHits = Array.isArray(newsScore.riskHits) ? newsScore.riskHits : [];
        var currentPct = latestMinutePct(minuteData);
        if (currentPct === null) currentPct = W.readFiniteNumber(cachedQuote.changePercent);
        var technicalScore = W.readFiniteNumber(analysis.score);
        var mainFlow = fundData && fundData.latestFlow ? W.readFiniteNumber(fundData.latestFlow.main) : null;
        var close = W.readFiniteNumber(indicators.close);
        var ma20 = W.readFiniteNumber(indicators.ma20);
        var ma20Distance = close !== null && ma20 !== null && ma20 > 0 ? (close - ma20) / ma20 * 100 : null;
        var riskPoints = 0;
        var boost = 0;
        var reasons = [];

        if (/ST|退/.test(String(name).toUpperCase())) {
            riskPoints += 30;
            pushResearchReason(reasons, 'negative', '特殊风险', '名称含 ST/退，直接降为回避');
        }
        if (currentPct !== null && currentPct >= 8.5) {
            riskPoints += 8;
            pushResearchReason(reasons, 'negative', '短线过热', '当前涨幅 ' + formatPercentValue(currentPct) + '，接近涨停区域');
        } else if (currentPct !== null && currentPct <= -8.5) {
            riskPoints += 6;
            pushResearchReason(reasons, 'negative', '跌幅过大', '当前跌幅 ' + formatPercentValue(currentPct) + '，先等承接确认');
        }
        if (technicalScore !== null) {
            if (technicalScore <= -35) {
                riskPoints += 8;
                pushResearchReason(reasons, 'negative', '技术面弱势', '技术评分 ' + technicalScore);
            } else if (technicalScore <= -15) {
                riskPoints += 4;
                pushResearchReason(reasons, 'negative', '技术面偏弱', '技术评分 ' + technicalScore);
            } else if (technicalScore >= 15) {
                boost += Math.min(10, technicalScore / 5);
                pushResearchReason(reasons, 'positive', '技术面支持', '技术评分 ' + technicalScore + '，趋势结论 ' + (analysis.verdict || '中性'));
            }
        }
        if (ma20Distance !== null) {
            if (ma20Distance > 16) {
                riskPoints += 5;
                pushResearchReason(reasons, 'negative', '偏离均线', '较 MA20 高 ' + formatPercentValue(ma20Distance));
            } else if (ma20Distance < -10) {
                riskPoints += 4;
                pushResearchReason(reasons, 'negative', '跌破趋势', '较 MA20 低 ' + formatPercentValue(Math.abs(ma20Distance)));
            }
        }
        if (mainFlow !== null) {
            if (mainFlow < 0) {
                riskPoints += Math.abs(mainFlow) >= 100000000 ? 6 : 3;
                pushResearchReason(reasons, 'negative', '主力流出', '今日主力净流 ' + utils.formatYuan(mainFlow));
            } else if (mainFlow > 0) {
                boost += Math.min(8, mainFlow / 100000000 * 3);
                pushResearchReason(reasons, 'positive', '主力流入', '今日主力净流 ' + utils.formatYuan(mainFlow));
            }
        }
        if (riskHits.length) {
            riskPoints += Math.min(14, riskHits.length * 4);
            pushResearchReason(reasons, 'negative', '新闻风险', riskHits.slice(0, 4).join(' / '));
        }
        if (positiveHits.length) {
            boost += Math.min(8, positiveHits.length * 2);
            pushResearchReason(reasons, 'positive', '新闻催化', positiveHits.slice(0, 4).join(' / '));
        }

        if (!reasons.length) {
            pushResearchReason(reasons, 'neutral', '信号不足', '等待技术面、资金流或新闻催化进一步确认');
        }

        var rawScore = 50 + boost + (W.readFiniteNumber(newsScore.score) || 0) * 4 - riskPoints * 2;
        var gate = riskPoints >= 14 ? 'block' : (riskPoints >= 7 ? 'watch' : 'pass');
        return {
            gate: gate,
            score: Math.round(clampNumber(rawScore, 0, 100)),
            riskPoints: riskPoints,
            reasons: reasons.slice(0, 6),
            currentPct: currentPct,
            mainFlow: mainFlow,
            technicalScore: technicalScore,
            newsScore: W.readFiniteNumber(newsScore.score),
            upDayRate60: computeUpDayRate60(klineData),
            triggerConditions: buildTriggerConditions(currentPct, mainFlow, analysis, positiveHits),
            invalidConditions: buildInvalidConditions(currentPct, mainFlow, analysis, riskHits),
        };
    }

    function computeUpDayRate60(klineData) {
        var bars = klineData && Array.isArray(klineData.bars) ? klineData.bars : [];
        var valid = bars.filter(function (bar) { return W.readFiniteNumber(bar.pct) !== null; }).slice(-60);
        if (!valid.length) return null;
        var positive = valid.filter(function (bar) { return (W.readFiniteNumber(bar.pct) || 0) > 0; }).length;
        return Math.round(positive / valid.length * 1000) / 10;
    }

    function buildTriggerConditions(currentPct, mainFlow, analysis, positiveHits) {
        var indicators = analysis && analysis.indicators ? analysis.indicators : {};
        var close = W.readFiniteNumber(indicators.close);
        var ma20 = W.readFiniteNumber(indicators.ma20);
        var volumeRatio = W.readFiniteNumber(indicators.volumeRatio);
        var list = [];
        if (close !== null && ma20 !== null) {
            list.push(close >= ma20 ? '维持 MA20 上方' : '先收复 MA20');
        }
        if (mainFlow !== null) {
            list.push(mainFlow > 0 ? '主力净流入延续' : '主力资金转正');
        }
        if (Array.isArray(positiveHits) && positiveHits.length) {
            list.push('催化继续发酵: ' + positiveHits.slice(0, 2).join('/'));
        } else {
            list.push('出现明确新闻催化');
        }
        if (volumeRatio !== null && volumeRatio >= 1.4) list.push('量能维持 1.4x 以上');
        if (currentPct !== null && currentPct > 7) list.push('高位只看回落承接');
        return list.slice(0, 4);
    }

    function buildInvalidConditions(currentPct, mainFlow, analysis, riskHits) {
        var indicators = analysis && analysis.indicators ? analysis.indicators : {};
        var close = W.readFiniteNumber(indicators.close);
        var ma20 = W.readFiniteNumber(indicators.ma20);
        var list = [];
        if (close !== null && ma20 !== null) {
            list.push(close >= ma20 ? '有效跌破 MA20' : 'MA20 下方继续走弱');
        }
        if (mainFlow !== null) {
            list.push(mainFlow > 0 ? '主力大额转流出' : '主力流出扩大');
        } else {
            list.push('资金流无法确认');
        }
        if (Array.isArray(riskHits) && riskHits.length) {
            list.push('风险词未解除: ' + riskHits.slice(0, 2).join('/'));
        } else {
            list.push('新增减持/问询/处罚等风险');
        }
        if (currentPct !== null && currentPct >= 8.5) list.push('涨停附近放量回落');
        return list.slice(0, 4);
    }

    function renderResearchMetric(label, value, cls) {
        return '<div class="stock-research-metric">' +
            '<span>' + utils.escapeHtml(label) + '</span>' +
            '<strong class="' + (cls || 'neutral') + '">' + utils.escapeHtml(value) + '</strong>' +
        '</div>';
    }

    function renderResearchReasonList(reasons) {
        return '<div class="stock-research-reasons">' + reasons.map(function (reason) {
            return '<div class="stock-research-reason ' + reason.type + '">' +
                '<span>' + utils.escapeHtml(reason.title) + '</span>' +
                '<em>' + utils.escapeHtml(reason.detail) + '</em>' +
            '</div>';
        }).join('') + '</div>';
    }

    function renderStockNewsList(newsData, newsError) {
        if (newsError) {
            return '<div class="stock-news-list"><div class="list-empty">新闻加载失败: ' + utils.escapeHtml(newsError.message || '数据异常') + '</div></div>';
        }
        var items = newsData && Array.isArray(newsData.items) ? newsData.items : [];
        if (!items.length) return '<div class="stock-news-list"><div class="list-empty">暂无个股新闻</div></div>';
        var status = newsData.meta && (newsData.meta.stale || newsData.meta.degraded)
            ? '<div class="stock-analysis-source">' + utils.escapeHtml(dataStatus.label(newsData.meta, newsData.sourceLabel || '个股新闻')) + '</div>'
            : '';
        return status + '<ul class="stock-news-list">' + items.slice(0, 5).map(function (item) {
            var meta = [item.source, item.time].filter(Boolean).join(' · ');
            var summary = item.summary ? '<em class="stock-news-summary">' + utils.escapeHtml(item.summary) + '</em>' : '';
            return '<li class="stock-news-item">' +
                '<span class="stock-news-title">' + utils.escapeHtml(item.title || '--') + '</span>' +
                (meta ? '<b class="stock-news-meta">' + utils.escapeHtml(meta) + '</b>' : '') +
                summary +
            '</li>';
        }).join('') + '</ul>';
    }

    function renderStockResearchGate(code, minuteData, fundData, klineData, newsData, newsError) {
        var gate = buildStockResearchGate(code, minuteData, fundData, klineData, newsData);
        var cls = gateClass(gate.gate);
        var metrics = [
            renderResearchMetric('跟踪分', String(gate.score), cls),
            renderResearchMetric('趋势', gate.technicalScore === null ? '--' : String(gate.technicalScore), trendClass(gate.technicalScore)),
            renderResearchMetric('资金', gate.mainFlow === null ? '--' : utils.formatYuan(gate.mainFlow), trendClass(gate.mainFlow)),
            renderResearchMetric('新闻', gate.newsScore === null ? '--' : String(gate.newsScore), trendClass(gate.newsScore)),
            renderResearchMetric('上涨日占比', gate.upDayRate60 === null ? '--' : gate.upDayRate60 + '%', gate.upDayRate60 === null ? 'neutral' : trendClass(gate.upDayRate60 - 50)),
        ].join('');
        return '<div class="stock-research-section ' + cls + '">' +
            '<div class="stock-analysis-head">' +
                '<div>' +
                    '<div class="stock-fund-section-title">研究评分</div>' +
                    '<div class="stock-analysis-source">趋势 · 资金 · 新闻 · 风险 · 近60日上涨日占比</div>' +
                '</div>' +
                '<div class="stock-research-gate ' + cls + '">' +
                    '<span>' + utils.escapeHtml(gateLabel(gate.gate)) + '</span>' +
                    '<strong>风险 ' + utils.escapeHtml(String(gate.riskPoints)) + '</strong>' +
                '</div>' +
            '</div>' +
            '<div class="stock-research-grid">' + metrics + '</div>' +
            renderResearchReasonList(gate.reasons) +
            renderResearchConditionGrid(gate.triggerConditions, gate.invalidConditions) +
            renderStockNewsList(newsData, newsError) +
        '</div>';
    }

    function renderResearchConditionGrid(triggerConditions, invalidConditions) {
        function renderList(title, list, cls) {
            var items = (Array.isArray(list) ? list : []).map(function (item) {
                return '<li>' + utils.escapeHtml(item) + '</li>';
            }).join('');
            return '<div class="stock-research-condition ' + cls + '">' +
                '<span>' + utils.escapeHtml(title) + '</span>' +
                '<ul>' + (items || '<li>等待更多数据确认</li>') + '</ul>' +
            '</div>';
        }
        return '<div class="stock-research-conditions">' +
            renderList('触发条件', triggerConditions, 'positive') +
            renderList('失效条件', invalidConditions, 'negative') +
        '</div>';
    }

    function formatPriceValue(value) {
        var number = W.readFiniteNumber(value);
        return number === null ? '--' : number.toFixed(2);
    }

    function formatPercentValue(value) {
        var number = W.readFiniteNumber(value);
        if (number === null) return '--';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function pointChangePercent(point, preClose) {
        if (point && point.changePercent !== null && point.changePercent !== undefined && point.changePercent !== ''
            && Number.isFinite(Number(point.changePercent))) return Number(point.changePercent);
        var price = point ? W.readFiniteNumber(point.price) : null;
        var base = W.readFiniteNumber(preClose);
        if (price === null || base === null || base <= 0) return null;
        return (price - base) / base * 100;
    }

    function formatPlainPercentValue(value, digits) {
        var number = W.readFiniteNumber(value);
        if (number === null) return '--';
        return number.toFixed(digits === undefined ? 1 : digits) + '%';
    }

    function formatPlainNumberValue(value, digits, suffix) {
        var number = W.readFiniteNumber(value);
        if (number === null) return '--';
        return number.toFixed(digits === undefined ? 2 : digits) + (suffix || '');
    }

    function trendClass(value) {
        var number = W.readFiniteNumber(value);
        return number > 0 ? 'positive' : (number < 0 ? 'negative' : 'neutral');
    }

    function compareClass(value, base) {
        var number = W.readFiniteNumber(value);
        var baseNumber = W.readFiniteNumber(base);
        if (number === null || baseNumber === null) return 'neutral';
        return number >= baseNumber ? 'positive' : 'negative';
    }

    function rangeClass(value, high, low) {
        var number = W.readFiniteNumber(value);
        if (number === null) return 'neutral';
        if (number >= high) return 'positive';
        if (number < low) return 'negative';
        return 'neutral';
    }

    function renderStockMetricCell(label, value, cls) {
        return '<div class="stock-analysis-cell">' +
            '<span>' + utils.escapeHtml(label) + '</span>' +
            '<strong class="' + (cls || 'neutral') + '">' + utils.escapeHtml(value) + '</strong>' +
        '</div>';
    }

    function renderStockAnalysisSection(data, error) {
        if (error) {
            return '<div class="stock-analysis-section">' +
                '<div class="stock-analysis-head">' +
                    '<div class="stock-fund-section-title">技术面</div>' +
                '</div>' +
                '<div class="list-empty">技术面加载失败: ' + utils.escapeHtml(error.message || '数据异常') + '</div>' +
            '</div>';
        }
        var analysis = data && data.analysis ? data.analysis : null;
        if (!analysis) {
            return '<div class="stock-analysis-section">' +
                '<div class="stock-analysis-head">' +
                    '<div class="stock-fund-section-title">技术面</div>' +
                '</div>' +
                '<div class="list-empty">暂无技术面数据</div>' +
            '</div>';
        }
        var indicators = analysis.indicators || {};
        var chips = data.chips || null;
        var score = W.readFiniteNumber(analysis.score);
        var scoreCls = trendClass(score);
        var scoreText = score === null ? '--' : (score > 0 ? '+' : '') + String(score);
        var sourceText = [data.sourceLabel || '', data.latestDate || analysis.latestDate || ''].filter(Boolean).join(' · ');
        if (data.meta && (data.meta.stale || data.meta.degraded)) sourceText = dataStatus.label(data.meta, sourceText || '日 K');
        var metrics = [
            renderStockMetricCell('收盘', formatPriceValue(indicators.close), trendClass(indicators.momentum21)),
            renderStockMetricCell('MA20', formatPriceValue(indicators.ma20), compareClass(indicators.close, indicators.ma20)),
            renderStockMetricCell('MA50', formatPriceValue(indicators.ma50), compareClass(indicators.ma20, indicators.ma50)),
            renderStockMetricCell('RSI14', formatPlainNumberValue(indicators.rsi14, 1), rangeClass(indicators.rsi14, 55, 45)),
            renderStockMetricCell('52周位置', formatPlainPercentValue(indicators.position52w, 1), indicators.position52w === null || indicators.position52w === undefined ? 'neutral' : trendClass(indicators.position52w - 50)),
            renderStockMetricCell('21日', formatPercentValue(indicators.momentum21), trendClass(indicators.momentum21)),
        ].join('');
        var chipMetrics = chips ? [
            renderStockMetricCell('获利盘', formatPlainPercentValue(chips.profitRatio, 1), chips.profitRatio === null || chips.profitRatio === undefined ? 'neutral' : trendClass(chips.profitRatio - 50)),
            renderStockMetricCell('平均成本', formatPriceValue(chips.avgCost), compareClass(indicators.close, chips.avgCost)),
            renderStockMetricCell('支撑', formatPriceValue(chips.support), 'neutral'),
            renderStockMetricCell('压力', formatPriceValue(chips.resistance), 'neutral'),
        ].join('') : '';

        return '<div class="stock-analysis-section ' + scoreCls + '">' +
            '<div class="stock-analysis-head">' +
                '<div>' +
                    '<div class="stock-fund-section-title">技术面</div>' +
                    '<div class="stock-analysis-source">' + utils.escapeHtml(sourceText || '日 K') + '</div>' +
                '</div>' +
                '<div class="stock-analysis-score ' + scoreCls + '">' +
                    '<span>' + utils.escapeHtml(scoreText) + '</span>' +
                    '<strong>' + utils.escapeHtml(analysis.verdict || '中性') + '</strong>' +
                '</div>' +
            '</div>' +
            '<div class="stock-analysis-grid">' + metrics + '</div>' +
            renderStockSignalList(analysis.signals) +
            (chipMetrics ? '<div class="stock-analysis-grid stock-chip-metrics">' + chipMetrics + '</div>' : '') +
            renderStockChipBlock(chips) +
        '</div>';
    }

    function renderStockSignalList(signals) {
        if (!Array.isArray(signals) || !signals.length) return '';
        return '<div class="stock-signal-list">' + signals.map(function (signal) {
            var type = signal.type === 'positive' || signal.type === 'negative' ? signal.type : 'neutral';
            var weight = W.readFiniteNumber(signal.weight);
            var weightText = weight === null ? '' : (weight > 0 ? '+' : '') + String(weight);
            return '<div class="stock-signal-row ' + type + '">' +
                '<span>' + utils.escapeHtml(signal.title || '--') + '</span>' +
                '<em>' + utils.escapeHtml(signal.detail || '') + '</em>' +
                '<b>' + utils.escapeHtml(weightText) + '</b>' +
            '</div>';
        }).join('') + '</div>';
    }

    function renderStockChipBlock(chips) {
        var levels = chips && Array.isArray(chips.levels) ? chips.levels : [];
        if (!levels.length) return '';
        var first = levels[0];
        var last = levels[levels.length - 1];
        var bars = levels.map(function (level) {
            var height = W.readFiniteNumber(level.height);
            height = height === null ? 0 : Math.max(4, Math.min(100, height));
            var cls = level.inProfit ? 'positive' : 'negative';
            return '<span class="stock-chip-bar ' + cls + '" style="height:' + height.toFixed(1) + '%">' +
                '<title>' + utils.escapeHtml(formatPriceValue(level.price) + ' · ' + formatPlainPercentValue(level.weightPct, 2)) + '</title>' +
            '</span>';
        }).join('');
        var concentration = chips.concentration90
            ? '90%筹码 ' + formatPriceValue(chips.concentration90.low) + '-' + formatPriceValue(chips.concentration90.high)
            : '';
        var windowLabel = chips.windowDays ? '近' + chips.windowDays + '日' : '';
        return '<div class="stock-chip-block">' +
            '<div class="stock-chip-title">' +
                '<div class="stock-chip-heading"><span>筹码估算</span>' +
                    (windowLabel ? '<small>' + utils.escapeHtml(windowLabel) + '</small>' : '') +
                '</div>' +
                '<em>' + utils.escapeHtml(concentration) + '</em>' +
            '</div>' +
            '<div class="stock-chip-chart" aria-label="筹码分布估算">' + bars + '</div>' +
            '<div class="stock-chip-axis">' +
                '<span>' + utils.escapeHtml(formatPriceValue(first.price)) + '</span>' +
                '<span>' + utils.escapeHtml(formatPriceValue(last.price)) + '</span>' +
            '</div>' +
        '</div>';
    }

    function renderStockMinuteSection(data, error) {
        if (error) {
            return '<div class="stock-minute-card">' +
                '<div class="stock-minute-top">' +
                    '<div class="stock-fund-section-title">分时</div>' +
                '</div>' +
                '<div class="list-empty">分时加载失败: ' + utils.escapeHtml(error.message || '数据异常') + '</div>' +
            '</div>';
        }
        var points = data && Array.isArray(data.points) ? data.points.filter(function (point) {
            return point && W.readFiniteNumber(point.price) !== null && point.time;
        }) : [];
        if (!points.length) {
            return '<div class="stock-minute-card">' +
                '<div class="stock-minute-top">' +
                    '<div class="stock-fund-section-title">分时</div>' +
                '</div>' +
                '<div class="list-empty">暂无分时数据</div>' +
            '</div>';
        }
        var latest = points[points.length - 1];
        var first = points[0];
        var middle = points[Math.floor((points.length - 1) / 2)] || first;
        var stats = getMinuteChartStats(points, data.preClose);
        var pct = pointChangePercent(latest, data.preClose);
        var cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
        var extremesHtml = stats.high && stats.low
            ? '<div class="stock-minute-extremes">' +
                '<span>高 ' + utils.escapeHtml(stats.high.time) + ' ' + utils.escapeHtml(formatPercentValue(stats.high.pct)) + '</span>' +
                '<span>低 ' + utils.escapeHtml(stats.low.time) + ' ' + utils.escapeHtml(formatPercentValue(stats.low.pct)) + '</span>' +
            '</div>'
            : '';
        var minuteStatus = data.meta && (data.meta.stale || data.meta.degraded)
            ? '<div class="stock-analysis-source">' + utils.escapeHtml(dataStatus.label(data.meta, data.sourceLabel || '分时')) + '</div>'
            : '';
        return '<div class="stock-minute-card ' + cls + '">' +
            '<div class="stock-minute-top">' +
                '<div class="stock-fund-section-title">分时</div>' +
            '</div>' + minuteStatus +
            '<div class="stock-minute-summary">' +
                '<div class="stock-minute-price ' + cls + '">' + utils.escapeHtml(formatPriceValue(latest.price)) + '</div>' +
                '<div class="stock-minute-pct ' + cls + '">' + utils.escapeHtml(formatPercentValue(pct)) + '</div>' +
                '<div class="stock-minute-meta">均价 ' + utils.escapeHtml(formatPriceValue(latest.avgPrice)) + ' · ' + utils.escapeHtml(latest.time) + '</div>' +
            '</div>' +
            '<div class="stock-minute-chart">' + renderStockMinuteChart(points, data.preClose, stats) + '</div>' +
            '<div class="stock-minute-axis">' +
                '<span>' + utils.escapeHtml(first.time) + '</span>' +
                '<span>' + utils.escapeHtml(middle.time) + '</span>' +
                '<span>' + utils.escapeHtml(latest.time) + '</span>' +
            '</div>' +
            extremesHtml +
        '</div>';
    }

    function getMinuteChartStats(points, preClose) {
        var base = W.readFiniteNumber(preClose);
        var chartPoints = points.map(function (point) {
            var price = W.readFiniteNumber(point.price);
            var avgPrice = W.readFiniteNumber(point.avgPrice);
            return {
                time: point.time,
                price: price,
                avgPrice: avgPrice,
                pct: pointChangePercent(point, base),
                avgPct: base !== null && base > 0 && avgPrice !== null ? (avgPrice - base) / base * 100 : null,
            };
        }).filter(function (point) { return point.price !== null && point.time; });
        var pctValues = [];
        var high = null;
        var low = null;
        chartPoints.forEach(function (point) {
            if (point.pct !== null && Number.isFinite(point.pct)) {
                pctValues.push(point.pct);
                if (!high || point.pct > high.pct) high = point;
                if (!low || point.pct < low.pct) low = point;
            }
            if (point.avgPct !== null && Number.isFinite(point.avgPct)) pctValues.push(point.avgPct);
        });
        var maxAbsPct = pctValues.length
            ? Math.max.apply(Math, pctValues.map(function (value) { return Math.abs(value); }))
            : null;
        if (maxAbsPct !== null && Number.isFinite(maxAbsPct)) {
            maxAbsPct = Math.max(0.5, Math.ceil(maxAbsPct * 10) / 10);
        }
        return {
            base: base,
            points: chartPoints,
            high: high,
            low: low,
            maxAbsPct: maxAbsPct,
        };
    }

    function renderStockMinuteChart(points, preClose, stats) {
        var width = 360;
        var height = 128;
        var padX = 8;
        var padY = 10;
        var padRight = 50;
        var valid = stats && Array.isArray(stats.points) ? stats.points : getMinuteChartStats(points, preClose).points;
        var values = [];
        valid.forEach(function (point) {
            values.push(point.price);
            if (point.avgPrice !== null) values.push(point.avgPrice);
        });
        var base = stats && stats.base !== null && stats.base !== undefined ? stats.base : W.readFiniteNumber(preClose);
        if (base !== null && base > 0) values.push(base);
        var min = Math.min.apply(Math, values);
        var max = Math.max.apply(Math, values);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
        if (min === max) {
            min -= Math.max(0.01, min * 0.002);
            max += Math.max(0.01, max * 0.002);
        }
        var yScale = function (value) {
            return padY + (max - value) / (max - min) * (height - padY * 2);
        };
        var maxAbsPct = stats && typeof stats.maxAbsPct === 'number' ? stats.maxAbsPct : null;
        if (base !== null && base > 0 && maxAbsPct !== null) {
            yScale = function (value) {
                var pct = (value - base) / base * 100;
                return padY + (maxAbsPct - pct) / (maxAbsPct * 2) * (height - padY * 2);
            };
        }
        var xScale = function (index) {
            return padX + (valid.length <= 1 ? 0 : index / (valid.length - 1) * (width - padX - padRight));
        };
        var pricePath = valid.map(function (point, index) {
            return (index === 0 ? 'M' : 'L') + xScale(index).toFixed(2) + ' ' + yScale(point.price).toFixed(2);
        }).join(' ');
        var avgPath = valid.map(function (point, index) {
            var value = point.avgPrice === null ? point.price : point.avgPrice;
            return (index === 0 ? 'M' : 'L') + xScale(index).toFixed(2) + ' ' + yScale(value).toFixed(2);
        }).join(' ');
        var baselineY = base !== null && base > 0 ? yScale(base) : (height / 2);
        var scaleLabels = base !== null && base > 0 && maxAbsPct !== null
            ? '<text class="stock-minute-scale-label positive" x="' + (width - 4) + '" y="' + (padY + 3) + '">' + utils.escapeHtml(formatPercentValue(maxAbsPct)) + '</text>' +
                '<text class="stock-minute-scale-label zero" x="' + (width - 4) + '" y="' + (baselineY + 3).toFixed(2) + '">0.00%</text>' +
                '<text class="stock-minute-scale-label negative" x="' + (width - 4) + '" y="' + (height - padY + 3) + '">' + utils.escapeHtml(formatPercentValue(-maxAbsPct)) + '</text>'
            : '';
        var baseline = base !== null && base > 0
            ? '<line class="stock-minute-baseline" x1="' + padX + '" y1="' + baselineY.toFixed(2) + '" x2="' + (width - padRight) + '" y2="' + baselineY.toFixed(2) + '"></line>'
            : '';
        var hitPoints = valid.map(function (point, index) {
            var pctText = formatPercentValue(point.pct);
            return '<circle class="stock-minute-hit-point" cx="' + xScale(index).toFixed(2) + '" cy="' + yScale(point.price).toFixed(2) + '" r="5" fill="transparent" pointer-events="all">' +
                '<title>' + utils.escapeHtml(point.time + ' 价格 ' + formatPriceValue(point.price) + ' 涨幅 ' + pctText) + '</title>' +
            '</circle>';
        }).join('');
        var latest = valid[valid.length - 1];
        var latestX = xScale(valid.length - 1);
        var latestY = yScale(latest.price);
        var latestLabel = '<circle class="stock-minute-current-dot" cx="' + latestX.toFixed(2) + '" cy="' + latestY.toFixed(2) + '" r="2.8"></circle>';
        return '<svg class="stock-minute-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="分时价格走势">' +
            '<line class="stock-minute-grid-line" x1="' + padX + '" y1="' + padY + '" x2="' + (width - padRight) + '" y2="' + padY + '"></line>' +
            '<line class="stock-minute-grid-line" x1="' + padX + '" y1="' + (height - padY) + '" x2="' + (width - padRight) + '" y2="' + (height - padY) + '"></line>' +
            baseline +
            scaleLabels +
            '<path class="stock-minute-avg-line" vector-effect="non-scaling-stroke" d="' + avgPath + '"></path>' +
            '<path class="stock-minute-price-line" vector-effect="non-scaling-stroke" d="' + pricePath + '"></path>' +
            latestLabel +
            hitPoints +
        '</svg>';
    }

    W.showStockFundFlow = showStockFundFlow;
    W.renderStockCostEditor = renderStockCostEditor;
    W.saveStockCostFromForm = saveStockCostFromForm;
    W.loadStockMinuteData = loadStockMinuteData;
    W.loadStockFundFlowData = loadStockFundFlowData;
    W.loadStockKlineData = loadStockKlineData;
    W.loadStockNewsData = loadStockNewsData;
    W.renderStockMinuteChart = renderStockMinuteChart;
})();
