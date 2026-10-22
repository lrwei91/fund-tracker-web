// ================================================================
// 市场行情 — 大盘指数 / 资金流 / 板块
// 暴露到 window.AppMarket;
// 直接 script 引入,无需 import/require
// 依赖:window.AppState, window.AppUtils, window.AppCache
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var dataStatus = window.AppDataStatus || { label: function (_meta, fallback) { return fallback || '实时数据'; } };
    var uiState = window.AppUiState || {
        render: function (_kind, options) { return '<div class="list-empty">' + utils.escapeHtml(options.title) + '</div>'; },
    };
    var KEYS = state.KEYS;
    var SECTOR_BOARD_TYPES = ['industry', 'concept', 'region'];
    var SECTOR_PERIODS = ['today', '5d', '10d'];
    var sectorFilter = restoreSectorFilter();

    function restoreSectorFilter() {
        var stored = cache.readJson(KEYS.SECTOR_TAB_KEY, null) || {};
        return {
            boardType: SECTOR_BOARD_TYPES.indexOf(stored.boardType) >= 0 ? stored.boardType : 'industry',
            period: SECTOR_PERIODS.indexOf(stored.period) >= 0 ? stored.period : 'today',
        };
    }

    function syncSectorFilterUI() {
        document.querySelectorAll('[data-sector-filter]').forEach(function (group) {
            var key = group.getAttribute('data-sector-filter');
            group.querySelectorAll('.sector-tab').forEach(function (tab) {
                tab.classList.toggle('active', tab.getAttribute('data-value') === sectorFilter[key]);
            });
        });
    }

    function setSectorFilter(key, value, refresh) {
        var allowed = key === 'boardType' ? SECTOR_BOARD_TYPES : key === 'period' ? SECTOR_PERIODS : [];
        if (allowed.indexOf(value) < 0 || sectorFilter[key] === value) return;
        sectorFilter[key] = value;
        cache.writeJson(KEYS.SECTOR_TAB_KEY, sectorFilter);
        syncSectorFilterUI();
        if (refresh) loadSectorData(true);
    }

    function initSectorFilters() {
        syncSectorFilterUI();
        document.querySelectorAll('[data-sector-filter]').forEach(function (group) {
            var key = group.getAttribute('data-sector-filter');
            group.querySelectorAll('.sector-tab').forEach(function (tab) {
                tab.addEventListener('click', function (event) {
                    event.stopPropagation();
                    setSectorFilter(key, tab.getAttribute('data-value'), true);
                });
            });
        });
    }

    // ============================================================
    // 大盘指数 prev 快照 helpers (半小时对比箭头基准)
    // 结构:{ market: { _updatedAt, data: { id: priceValue } }, custom: 同上 }
    // ============================================================

    function getIndexPrevPct() {
        try {
            var raw = JSON.parse(window.AppStorage.getItem(KEYS.INDEX_PREV_KEY));
            if (raw && typeof raw === 'object') return raw;
        } catch (e) { /* ignore */ }
        return { market: { _updatedAt: 0, data: {} }, custom: { _updatedAt: 0, data: {} } };
    }

    function readIndexPrevBucket(bucket) {
        var cur = getIndexPrevPct();
        var b = cur[bucket];
        if (!b || typeof b !== 'object') return { _updatedAt: 0, data: {} };
        return {
            _updatedAt: typeof b._updatedAt === 'number' ? b._updatedAt : 0,
            data: b.data && typeof b.data === 'object' ? b.data : {},
        };
    }

    // 仅当距上次落盘 ≥ INDEX_REFRESH_SECONDS 秒时,才把 currentMap 写入 bucket.data 并刷新 _updatedAt
    function persistIndexPrevIfDue(bucket, currentMap, now) {
        var bucketObj = readIndexPrevBucket(bucket);
        var nowMs = typeof now === 'number' ? now : Date.now();
        var due = (nowMs - bucketObj._updatedAt) >= KEYS.INDEX_REFRESH_SECONDS * 1000;
        if (!due) return false;
        var cleanData = {};
        Object.keys(currentMap || {}).forEach(function (k) {
            var v = currentMap[k];
            if (typeof v === 'number' && Number.isFinite(v)) cleanData[k] = v;
        });
        var cur = getIndexPrevPct();
        cur[bucket] = { _updatedAt: nowMs, data: cleanData };
        try { window.AppStorage.setItem(KEYS.INDEX_PREV_KEY, JSON.stringify(cur)); } catch (e) {}
        return true;
    }

    // 单点写入 prev(新增自选指数时立刻给一个 prev,让首渲染箭头 = self-vs-self = '─')
    function setIndexPrevForCode(bucket, code, pct) {
        if (typeof pct !== 'number' || !Number.isFinite(pct)) return;
        var cur = getIndexPrevPct();
        var b = readIndexPrevBucket(bucket);
        b.data[code] = pct;
        // 单点写入不动 _updatedAt,避免污染节流基准
        cur[bucket] = b;
        try { window.AppStorage.setItem(KEYS.INDEX_PREV_KEY, JSON.stringify(cur)); } catch (e) {}
    }

    // 移除自选指数时同步清掉 prev,避免幽灵 prev
    function clearIndexPrevForCode(bucket, code) {
        var cur = getIndexPrevPct();
        var b = readIndexPrevBucket(bucket);
        if (Object.prototype.hasOwnProperty.call(b.data, code)) {
            delete b.data[code];
            cur[bucket] = b;
            try { window.AppStorage.setItem(KEYS.INDEX_PREV_KEY, JSON.stringify(cur)); } catch (e) {}
        }
    }

    // 半小时对比箭头
    function trendArrow(current, prev) {
        if (prev === undefined || prev === null) return '─';
        if (current > prev) return '▲';
        if (current < prev) return '▼';
        return '─';
    }

    // 抽出 { key: priceValue } 快照,trend-arrow 用价格本身做对比基准
    function snapshotIndexPrice(data) {
        var out = {};
        if (!data || typeof data !== 'object') return out;
        Object.keys(data).forEach(function (id) {
            var d = data[id];
            if (d && typeof d.priceValue === 'number' && Number.isFinite(d.priceValue)) {
                out[id] = d.priceValue;
            }
        });
        return out;
    }

    // ============================================================
    // 大盘指数 — UI 更新
    // ============================================================

    function formatSignedPct(value) {
        var number = Number(value);
        if (!Number.isFinite(number)) return '--';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function sparklineGeometry(values, width, height, pad, baseline, fullLength) {
        var scaleValues = values.slice();
        if (Number.isFinite(baseline) && baseline > 0) scaleValues.push(baseline);
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
        var path = values.map(function (value, index) {
            var x = pad + index / Math.max(1, (fullLength || values.length) - 1) * (width - pad * 2);
            var y = yScale(value);
            return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
        }).join(' ');
        return {
            path: path,
            zeroY: Number.isFinite(baseline) && baseline > 0 ? yScale(baseline) : null,
        };
    }

    function buildIndexSparklineValues(data) {
        if (!data || !Array.isArray(data.sparkline)) return [];
        var values = data.sparkline.map(function (point) {
            return typeof point === 'number' ? point : point && Number(point.price);
        }).filter(function (value) { return Number.isFinite(value); });
        return values.length >= 2 ? values.slice(-242) : [];
    }

    function indexSparklineStatus(data) {
        var total = data && Array.isArray(data.sparkline) ? data.sparkline.length : 0;
        var valid = data && Array.isArray(data.sparkline) ? data.sparkline.filter(function (point) {
            var value = typeof point === 'number' ? point : point && Number(point.price);
            return Number.isFinite(value);
        }).length : 0;
        return { available: valid >= 2, total: total, valid: valid, reason: valid >= 2 ? '' : '分时数据暂不足（' + valid + '）' };
    }

    function getIndexSparklineBaseline(data) {
        var explicit = Number(data && data.preClose);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        var current = Number(data && data.priceValue);
        var changePercent = Number(data && data.changePercent);
        var ratio = 1 + changePercent / 100;
        if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(ratio) || ratio <= 0) return null;
        return current / ratio;
    }

    function buildIndexSparklineSvg(data, cls, prev) {
        var values = buildIndexSparklineValues(data, prev);
        if (!values.length) return '';
        var width = 180;
        var height = 44;
        var pad = 2;
        var geometry = sparklineGeometry(values, width, height, pad, getIndexSparklineBaseline(data), 242);
        if (!geometry || !geometry.path) return '';
        var zeroAxis = geometry.zeroY === null ? '' :
            '<line class="index-sparkline-zero" x1="' + pad + '" y1="' + geometry.zeroY.toFixed(2) + '" x2="' + (width - pad) + '" y2="' + geometry.zeroY.toFixed(2) + '"></line>';
        return '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-label="当日走势" role="img" focusable="false">' +
            zeroAxis +
            '<path class="index-sparkline-path" d="' + geometry.path + '"></path>' +
            '</svg>';
    }

    function renderIndexSparkline(container, data, cls, prev) {
        var spark = container.querySelector('.index-sparkline');
        if (!spark) {
            spark = document.createElement('div');
            spark.className = 'index-sparkline';
            container.appendChild(spark);
        }
        var svg = buildIndexSparklineSvg(data, cls, prev);
        if (!svg) {
            var status = indexSparklineStatus(data);
            spark.className = 'index-sparkline is-unavailable';
            spark.textContent = status.reason;
            spark.title = status.reason;
            return;
        }
        spark.title = '';
        spark.className = 'index-sparkline ' + cls;
        spark.innerHTML = svg;
    }

    function updateIndexUI(id, data) {
        if (!data) return;
        var item = document.querySelector('[data-index="' + id + '"]');
        var v = document.getElementById(id + '-value');
        var c = document.getElementById(id + '-change');
        var n = item ? item.querySelector('.index-name') : null;
        if (!v || !c) return;
        v.textContent = data.value;
        c.textContent = formatSignedPct(data.changePercent);
        c.title = data.change || c.textContent;
        if (n && data.name) n.textContent = data.name;
        v.className = 'index-value';
        c.className = 'index-change';
        var cls = data.changePercent > 0 ? 'positive' : data.changePercent < 0 ? 'negative' : 'neutral';
        if (item) item.classList.remove('positive', 'negative', 'neutral');
        if (item) item.classList.add(cls);
        v.classList.add(cls);
        c.classList.add(cls);
        // 半小时对比箭头:跟价格绑定,内部读 prev 价格快照
        var prev = readIndexPrevBucket('market').data[id];
        var arrow = trendArrow(
            typeof data.priceValue === 'number' ? data.priceValue : null,
            typeof prev === 'number' ? prev : null
        );
        var existing = v.querySelector('.trend-arrow');
        if (existing) existing.remove();
        if (arrow) {
            var span = document.createElement('span');
            span.className = 'trend-arrow';
            span.textContent = arrow;
            v.appendChild(span);
        }
        if (item) renderIndexSparkline(item, data, cls, prev);
    }

    function clearIndexUI() {
        document.querySelectorAll('[data-index]').forEach(function (item) {
            var id = item.getAttribute('data-index');
            var value = document.getElementById(id + '-value');
            var change = document.getElementById(id + '-change');
            if (value) { value.textContent = '--'; value.className = 'index-value neutral'; }
            if (change) { change.textContent = '--'; change.title = ''; change.className = 'index-change neutral'; }
            item.classList.remove('positive', 'negative', 'neutral');
            var spark = item.querySelector('.index-sparkline');
            if (spark) spark.innerHTML = '';
        });
    }

    // ============================================================
    // loadIndexData / loadCapitalData / loadSectorData
    // ============================================================

    function requestOptions(force) {
        return {
            force: !!force,
            cacheMode: force ? 'bypass_fresh' : 'normal',
        };
    }

    function setSectionStale(selector, stale) {
        var section = document.querySelector(selector);
        if (section) section.classList.toggle('is-stale', !!stale);
    }

    async function loadIndexData(force) {
        try {
            var res = await window.AppDataClient.fetch('/market-data', { type: 'index' }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data) throw new Error('数据异常');
            state.liveIndexData = result.data;
            setSectionStale('.index-section', !!(result.meta && result.meta.stale));
            cache.writeTimedCache(KEYS.SHORT_CACHE_KEYS.index, result.data);
            Object.keys(result.data).forEach(function (id) { updateIndexUI(id, result.data[id]); });
            // 节流落盘:刷新节奏不变,只决定 prev 落盘的节奏
            persistIndexPrevIfDue('market', snapshotIndexPrice(result.data));
            utils.setLastUpdated(dataStatus.label(result.meta, '行情已更新'));
        } catch (e) {
            if (state.liveIndexData) {
                setSectionStale('.index-section', true);
                utils.setLastUpdated('行情更新失败 · 显示上次结果');
            } else {
                clearIndexUI();
                utils.setLastUpdated('行情获取失败');
            }
        }
    }

    async function loadCapitalData(force) {
        var newData = state.liveCapitalData;
        var updated = false;

        try {
            var res = await window.AppDataClient.fetch('/market-data', { type: 'capital' }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (result.success && result.data && result.data.mainFund && result.data.mainFund.value !== undefined) {
                newData = result.data;
                updated = true;
                cache.writeTimedCache(KEYS.SHORT_CACHE_KEYS.capital, result.data);
            }
        } catch (e) {}

        state.liveCapitalData = newData;
        setSectionStale('.capital-section', !updated && !!newData);
        renderCapitalUI(state.liveCapitalData || {});
    }

    function validBreadthData(value) {
        return value && value.available === true && ['up', 'down', 'flat'].every(function (key) {
            return typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0;
        });
    }

    async function loadMarketBreadthData(force) {
        var newData = state.liveMarketBreadthData;
        var statusText = newData ? '' : '正在同步';
        var updated = false;
        var stale = false;
        if (!newData) renderMarketBreadthUI(null, statusText);

        try {
            var res = await window.AppDataClient.fetch('/market-data', { type: 'breadth' }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (!result.success || !validBreadthData(result.data)) throw new Error('数据异常');
            newData = result.data;
            updated = true;
            stale = !!(result.meta && result.meta.stale);
            statusText = (result.data.sourceLabel || '行情来源') + ' · ' + dataStatus.label(result.meta, '实时');
        } catch (e) {
            statusText = newData ? '接口不可用 · 显示上次结果' : '接口暂不可用';
        }

        state.liveMarketBreadthData = newData;
        setSectionStale('.market-breadth-section', stale || (!updated && !!newData));
        renderMarketBreadthUI(state.liveMarketBreadthData, statusText);
    }

    function validSectorPanoramaData(value) {
        return value && value.available === true && Array.isArray(value.items) && value.items.some(function (item) {
            return item && typeof item.name === 'string' && typeof item.changePct === 'number' && Number.isFinite(item.changePct);
        });
    }

    async function loadSectorPanoramaData(force) {
        var newData = state.liveSectorPanoramaData;
        var statusText = newData ? '' : '正在同步';
        var updated = false;
        var stale = false;

        try {
            var res = await window.AppDataClient.fetch('/market-data', { type: 'sector-panorama' }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (!result.success || !validSectorPanoramaData(result.data)) throw new Error('数据异常');
            newData = result.data;
            updated = true;
            stale = !!(result.meta && result.meta.stale);
            statusText = (result.data.sourceLabel || '行情来源') + ' · ' + dataStatus.label(result.meta, '实时');
        } catch (e) {
            statusText = newData ? '接口不可用 · 显示上次结果' : '接口暂不可用';
        }

        state.liveSectorPanoramaData = newData;
        setSectionStale('.sector-panorama-section', stale || (!updated && !!newData));
        renderSectorPanoramaUI(state.liveSectorPanoramaData, statusText);
    }

    async function loadSectorData(force) {
        var cached = cache.readTimedCache(KEYS.SHORT_CACHE_KEYS.sector, KEYS.SHORT_CACHE_TTL.sector);
        var matches = function (value) {
            return value && value.boardType === sectorFilter.boardType && value.period === sectorFilter.period;
        };
        var newData = matches(state.liveSectorData) ? state.liveSectorData : matches(cached) ? cached : null;
        var statusEl = document.getElementById('sector-flow-status');
        var statusText = '';

        try {
            var res = await window.AppDataClient.fetch('/market-data', {
                type: 'sector',
                boardType: sectorFilter.boardType,
                period: sectorFilter.period,
            }, requestOptions(force));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (result.success && result.data && result.data.inflow) {
                newData = result.data;
                cache.writeTimedCache(KEYS.SHORT_CACHE_KEYS.sector, result.data);
                statusText = dataStatus.label(result.meta, '实时数据');
            }
        } catch (e) {
            statusText = newData ? '接口不可用 · 显示缓存' : '接口暂不可用';
        }

        state.liveSectorData = newData;
        renderSectorUI(state.liveSectorData || {});
        if (statusEl && statusText) statusEl.textContent = statusText;
    }

    // ============================================================
    // 资金流 / 市场涨跌家数 / 行业全景 / 板块 UI 渲染
    // ============================================================

    function renderMarketBreadthUI(breadth, statusText) {
        var valid = validBreadthData(breadth);
        var values = valid ? {
            up: Math.round(breadth.up),
            flat: Math.round(breadth.flat),
            down: Math.round(breadth.down),
        } : { up: null, flat: null, down: null };
        [
            { key: 'up', id: 'market-breadth-up', tone: 'positive' },
            { key: 'flat', id: 'market-breadth-flat', tone: 'neutral' },
            { key: 'down', id: 'market-breadth-down', tone: 'negative' },
        ].forEach(function (item) {
            var el = document.getElementById(item.id);
            if (!el) return;
            el.textContent = values[item.key] === null ? '--' : values[item.key].toLocaleString('zh-CN');
            el.className = 'market-breadth-value ' + (values[item.key] === null ? 'neutral' : item.tone);
        });

        var covered = valid ? values.up + values.flat + values.down : 0;
        var track = document.getElementById('market-breadth-track');
        ['up', 'flat', 'down'].forEach(function (key) {
            var segment = track && track.querySelector('[data-breadth-segment="' + key + '"]');
            if (segment) segment.style.width = covered ? (values[key] / covered * 100).toFixed(2) + '%' : '0%';
        });
        if (track) {
            track.setAttribute('aria-label', covered
                ? '上涨' + values.up + '家，平盘' + values.flat + '家，下跌' + values.down + '家'
                : '市场涨跌比例暂不可用');
        }

        var summary = document.getElementById('market-breadth-summary');
        if (summary) {
            summary.textContent = covered
                ? '有效统计 ' + covered.toLocaleString('zh-CN') + ' 家 · 上涨占比 ' + (values.up / covered * 100).toFixed(1) + '%'
                : '暂无有效统计';
        }
        var status = document.getElementById('market-breadth-status');
        if (status) status.textContent = statusText || (valid ? '实时数据' : '等待行情');
    }

    function renderSectorPanoramaUI(panorama, statusText) {
        var container = document.getElementById('sector-panorama-grid');
        var status = document.getElementById('sector-panorama-status');
        if (status) status.textContent = statusText || (validSectorPanoramaData(panorama) ? '实时数据' : '等待行情');
        if (!container) return;
        var items = panorama && Array.isArray(panorama.items) ? panorama.items : [];
        if (!items.length) {
            container.innerHTML = uiState.render('empty', {
                title: '暂无行业行情',
                detail: '行情恢复后将自动更新。',
            });
            return;
        }
        var rows = items.map(function (item) {
            var change = typeof item.changePct === 'number' && Number.isFinite(item.changePct) ? item.changePct : null;
            var tone = change === null ? 'neutral' : change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';
            var text = change === null ? '--' : (change > 0 ? '+' : '') + change.toFixed(2) + '%';
            return '<div class="sector-panorama-item" role="listitem">' +
                '<span class="sector-panorama-name">' + utils.escapeHtml(item.name || '') + '</span>' +
                '<strong class="sector-panorama-change ' + tone + '">' + utils.escapeHtml(text) + '</strong>' +
                '</div>';
        }).join('');
        container.innerHTML = rows + (items.length % 2 ? '<span class="sector-panorama-spacer" aria-hidden="true"></span>' : '');
    }

    // 6 格子: 资金 4 档 + 沪股通盘中参考 + HKEX 北向官方日成交额
    function renderCapitalUI(cap) {
        var cells = [
            { id: 'main-fund-value', data: cap.mainFund, label: '主力' },
            { id: 'large-value',     data: cap.mainFund && cap.mainFund.breakdown && cap.mainFund.breakdown.large, label: '大单' },
            { id: 'medium-value',    data: cap.mainFund && cap.mainFund.breakdown && cap.mainFund.breakdown.medium, label: '中单' },
            { id: 'small-value',     data: cap.mainFund && cap.mainFund.breakdown && cap.mainFund.breakdown.small, label: '小单' },
            { id: 'north-hgt-value', data: cap.northHgtIntraday, note: cap.northHgtIntraday && cap.northHgtIntraday.time, label: '沪股通盘中' },
            { id: 'north-daily-value', data: cap.northboundDaily, note: cap.northboundDaily && cap.northboundDaily.date, label: '北向成交额' },
        ];
        cells.forEach(function (cell) {
            var el = document.getElementById(cell.id);
            if (!el) return;
            var label = el.parentElement && el.parentElement.querySelector('.capital-label');
            if (label) label.textContent = cell.data && cell.data.label ? cell.data.label : cell.label;
            el.textContent = cell.data && cell.data.value ? cell.data.value : '--';
            el.title = cell.note || (cell.data && cell.data.note) || '';
            el.className = 'capital-value';
            if (cell.data && typeof cell.data.isPositive === 'boolean') {
                el.classList.add(cell.data.isPositive ? 'positive' : 'negative');
            } else {
                el.classList.add('neutral');
            }
        });
    }

    function renderSectorUI(sectors) {
        var inflowEl = document.getElementById('sector-bars-inflow');
        var outflowEl = document.getElementById('sector-bars-outflow');
        if (!inflowEl || !outflowEl) return;

        var inflowList = (sectors.inflow || []).slice(0, 5);
        var outflowList = (sectors.outflow || []).slice(0, 5);
        var boardLabels = { industry: '行业', concept: '概念', region: '地域' };
        var periodLabels = { today: '今日', '5d': '5日', '10d': '10日' };
        var statusEl = document.getElementById('sector-flow-status');
        if (statusEl && sectors.boardType && sectors.period && !statusEl.textContent) {
            statusEl.textContent = boardLabels[sectors.boardType] + ' · ' + periodLabels[sectors.period];
        }
        var maxAbs = 1;
        inflowList.forEach(function (s) { if (s.mainFundYuan > maxAbs) maxAbs = s.mainFundYuan; });
        outflowList.forEach(function (s) { if (Math.abs(s.mainFundYuan) > maxAbs) maxAbs = Math.abs(s.mainFundYuan); });

        function pctOf(s) {
            return (Math.abs(s.mainFundYuan || 0) / maxAbs * 100).toFixed(1);
        }
        function pctClass(v) { return v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral'; }
        function changeStr(c) {
            if (typeof c !== 'number' || !c) return '';
            return (c > 0 ? '+' : '') + c.toFixed(2) + '%';
        }

        function renderBars(items, sign) {
            if (!items.length) return uiState.render('empty', {
                title: '暂无' + (sign > 0 ? '流入' : '流出') + '数据',
                detail: '当前板块类型和周期没有返回有效排名。',
            });
            return items.map(function (s) {
                var w = pctOf(s);
                var cls = pctClass(s.changePct);
                return '<div class="sector-bar-row">' +
                    '<div class="sector-bar-name">' +
                        '<span class="sector-bar-label">' + utils.escapeHtml(s.name) + '</span>' +
                        '<span class="sector-bar-change ' + cls + '">' + utils.escapeHtml(changeStr(s.changePct)) + '</span>' +
                    '</div>' +
                    '<div class="sector-bar-track">' +
                        '<div class="sector-bar-fill ' + (sign > 0 ? 'positive' : 'negative') + '" data-w="' + w + '"></div>' +
                    '</div>' +
                    '<div class="sector-bar-value ' + (sign > 0 ? 'positive' : 'negative') + '">' + utils.escapeHtml(s.value) + '</div>' +
                    '<div class="sector-bar-leader">' + utils.escapeHtml(s.leader || '') + '</div>' +
                '</div>';
            }).join('');
        }

        inflowEl.innerHTML = renderBars(inflowList, 1);
        outflowEl.innerHTML = renderBars(outflowList, -1);
        // 渲染后批量把 data-w 转成实际宽度(避免在 HTML 字符串里写 inline style,
        // 通过 setProperty 写入动态宽度，避免拼接内联样式字符串。
        [inflowEl, outflowEl].forEach(function (container) {
            var fills = container.querySelectorAll('.sector-bar-fill[data-w]');
            fills.forEach(function (fill) {
                fill.style.width = fill.getAttribute('data-w') + '%';
            });
        });
    }

    window.AppMarket = {
        // prev 快照
        getIndexPrevPct: getIndexPrevPct,
        readIndexPrevBucket: readIndexPrevBucket,
        persistIndexPrevIfDue: persistIndexPrevIfDue,
        setIndexPrevForCode: setIndexPrevForCode,
        clearIndexPrevForCode: clearIndexPrevForCode,
        trendArrow: trendArrow,
        snapshotIndexPrice: snapshotIndexPrice,
        buildIndexSparklineSvg: buildIndexSparklineSvg,
        indexSparklineStatus: indexSparklineStatus,
        // 指数 UI / load
        updateIndexUI: updateIndexUI,
        loadIndexData: loadIndexData,
        // 资金 / 市场涨跌家数 / 板块
        loadCapitalData: loadCapitalData,
        loadMarketBreadthData: loadMarketBreadthData,
        loadSectorPanoramaData: loadSectorPanoramaData,
        loadSectorData: loadSectorData,
        initSectorFilters: initSectorFilters,
        setSectorFilter: setSectorFilter,
        renderCapitalUI: renderCapitalUI,
        renderMarketBreadthUI: renderMarketBreadthUI,
        renderSectorPanoramaUI: renderSectorPanoramaUI,
        renderSectorUI: renderSectorUI,
    };
})();
