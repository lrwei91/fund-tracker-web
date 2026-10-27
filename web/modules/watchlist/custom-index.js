// ================================================================
// 自选股 — 自选指数(板块/ETF,最多 4 个):CRUD / 渲染 / 刷新
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var utils = W.utils;
    var KEYS = W.KEYS;
    var persistedCustomIndexSnapshot = null;

    function saveCustomIndices() {
        try { window.AppStorage.setItem(KEYS.CUSTOM_INDICES_KEY, JSON.stringify(state.customIndexCodes)); } catch (e) {}
    }

    function todayLocalStr() {
        var d = new Date();
        var m = d.getMonth() + 1;
        var day = d.getDate();
        return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    }

    // 自选指数分时：与大盘指数同款（走 /stock-minute，腾讯 -> 东财兜底）。
    // 失败静默：分时拿不到时卡片保持原样，不挤掉行情。
    function loadCustomIndexMinutes(codes) {
        var targets = (codes || []).filter(function (code) { return !!state.customIndexFreshCodes[code]; });
        if (!targets.length || !window.AppDataClient) return;
        Promise.all(targets.map(function (code) {
            return window.AppDataClient.fetch('/stock-minute', { code: code })
                .then(function (res) { return res.ok ? res.json() : null; })
                .then(function (result) {
                    if (!result || !result.success || !result.data || !Array.isArray(result.data.points)) return;
                    var prices = result.data.points.map(function (p) { return p.price; })
                        .filter(function (n) { return typeof n === 'number' && Number.isFinite(n); });
                    if (!prices.length) return;
                    var cached = state.customIndexCache[code] || {};
                    cached.sparkline = prices;
                    cached.sparklineDate = result.data.tradeDate || todayLocalStr();
                    state.customIndexCache[code] = cached;
                })
                .catch(function () {});
        })).then(function () {
            persistCustomIndexCache();
            renderCustomIndex();
        });
    }

    // 报价刷新会整体替换缓存对象，分时字段要先留着，否则分时一刷新就丢。
    function preserveSparkline(code, data) {
        var prev = state.customIndexCache[code];
        if (prev && prev.sparkline) {
            data.sparkline = prev.sparkline;
            data.sparklineDate = prev.sparklineDate;
        }
    }

    function persistCustomIndexCache() {
        try {
            var snapshot = JSON.stringify(state.customIndexCache);
            if (snapshot === persistedCustomIndexSnapshot) return;
            persistedCustomIndexSnapshot = snapshot;
            window.AppStorage.setItem(KEYS.CUSTOM_INDEX_QUOTE_CACHE_KEY, snapshot);
        } catch (e) {}
    }

    function persistCustomIndexUpdateTime(value) {
        try { window.AppStorage.setItem(KEYS.CUSTOM_INDEX_UPDATE_TIME_KEY, value || ''); } catch (e) {}
    }

    function applyCustomIndexQuoteBatch(result, requestedCodes) {
        var codes = W.sanitizeCodes(requestedCodes || state.customIndexCodes);
        if (!result || result.success === false || !result.data) {
            state.customIndexFreshCodes = {};
            renderCustomIndex();
            return false;
        }
        var freshCodes = {};
        codes.forEach(function (code) {
            var data = result.data[code];
            if (data && data.price !== '0.00' && Number.isFinite(Number(data.priceValue))) {
                preserveSparkline(code, data);
                state.customIndexCache[code] = data;
                freshCodes[code] = true;
            }
        });
        state.customIndexFreshCodes = freshCodes;
        if (result.time) {
            state.customIndexUpdateTime = result.time;
            persistCustomIndexUpdateTime(result.time);
        }
        persistCustomIndexCache();
        if (window.AppMarket && typeof window.AppMarket.persistIndexPrevIfDue === 'function'
            && typeof window.AppMarket.snapshotIndexPrice === 'function') {
            var snapshot = {};
            codes.forEach(function (code) {
                if (result.data[code]) snapshot[code] = result.data[code];
            });
            window.AppMarket.persistIndexPrevIfDue('custom', window.AppMarket.snapshotIndexPrice(snapshot));
        }
        renderCustomIndex();
        loadCustomIndexMinutes(codes);
        return true;
    }

    function renderCustomIndex() {
        var grid = document.getElementById('custom-index-grid');
        var updateTimeEl = document.getElementById('custom-index-update-time');
        if (!grid) return;

        var items = state.customIndexCodes.map(function (code) {
            var d = state.customIndexCache[code];
            var fresh = !!state.customIndexFreshCodes[code];
            var name = d && d.name ? d.name : code + '（待刷新）';
            var price = fresh && d && d.price != null ? d.price : '--';
            var pct = fresh && d && typeof d.changePercent === 'number' ? d.changePercent : null;
            var change = fresh && d && typeof d.change === 'number' ? d.change : null;
            return renderCustomIndexItem(code, name, price, pct, change, fresh);
        });

        // 满 4 个不显示加号;未满追加 1 个加号格子
        if (state.customIndexCodes.length < KEYS.CUSTOM_INDEX_MAX) {
            items.push(
                '<button type="button" class="custom-index-add" data-custom-index-add="1">' +
                '<span class="add-icon">+</span>' +
                '<span class="add-hint">添加指数</span>' +
                '</button>'
            );
        }

        grid.innerHTML = items.join('');
        bindCustomIndexRemove();
        bindCustomIndexAdd();
        bindCustomIndexAddForm();
        var allFresh = state.customIndexCodes.length > 0 && state.customIndexCodes.every(function (code) {
            return !!state.customIndexFreshCodes[code];
        });
        if (updateTimeEl) updateTimeEl.textContent = allFresh ? (state.customIndexUpdateTime || '') : '等待实时行情';
    }

    function renderCustomIndexItem(code, name, price, changePercent, change, quoteFresh) {
        var fresh = quoteFresh === undefined ? true : !!quoteFresh;
        var cls = changePercent > 0 ? 'positive' : changePercent < 0 ? 'negative' : 'neutral';
        var changeStr = '--';
        if (typeof change === 'number' && Number.isFinite(change)) {
            changeStr = (change > 0 ? '+' : '') + change.toFixed(2);
        }
        var pctStr = (typeof changePercent === 'number' && Number.isFinite(changePercent))
            ? (changePercent > 0 ? '+' : '') + changePercent.toFixed(2) + '%'
            : '--';
        // 半小时对比箭头:跟大盘指数一致,挂在价格后面,从 custom bucket 取 prev 价格
        var cached = state.customIndexCache[code];
        var priceValue = fresh && cached && typeof cached.priceValue === 'number' ? cached.priceValue : null;
        var displayPrice = utils.formatQuotePrice(priceValue, price, code, name);
        var marketMod = window.AppMarket;
        var prevBucket = (marketMod && typeof marketMod.readIndexPrevBucket === 'function')
            ? marketMod.readIndexPrevBucket('custom').data
            : {};
        var prev = prevBucket[code];
        var arrow = (marketMod && typeof marketMod.trendArrow === 'function')
            ? marketMod.trendArrow(priceValue, typeof prev === 'number' ? prev : null)
            : '─';
        var arrowHtml = arrow ? ' <span class="trend-arrow">' + utils.escapeHtml(arrow) + '</span>' : '';
        var changeTitle = changeStr + ' / ' + pctStr;
        // 分时只认当日数据：隔夜缓存的分时线不画，等新分时拉到再显示；
        // 当日分时拉到了但不足 2 点时，与大盘指数一样显示不足文案。
        var sparkContent = '';
        var sparkCls = cls;
        if (fresh && cached && marketMod) {
            var sparkData = (cached.sparklineDate === todayLocalStr()) ? cached : {};
            if (typeof marketMod.buildIndexSparklineSvg === 'function') {
                sparkContent = marketMod.buildIndexSparklineSvg(sparkData, cls, typeof prev === 'number' ? prev : null);
            }
            if (!sparkContent && Array.isArray(cached.sparkline) && cached.sparklineDate === todayLocalStr()
                && typeof marketMod.indexSparklineStatus === 'function') {
                var sparkStatus = marketMod.indexSparklineStatus(cached);
                if (sparkStatus.reason) {
                    sparkContent = utils.escapeHtml(sparkStatus.reason);
                    sparkCls = 'is-unavailable';
                }
            }
        }
        return '<div class="index-item custom-index-data" data-code="' + utils.escapeHtml(code) + '">' +
            '<div class="index-name">' + utils.escapeHtml(name) + '</div>' +
            '<div class="index-value ' + cls + '">' + utils.escapeHtml(displayPrice) + arrowHtml + '</div>' +
            '<div class="index-change ' + cls + '" title="' + utils.escapeHtml(changeTitle) + '">' + utils.escapeHtml(pctStr) + '</div>' +
            '<div class="index-sparkline ' + sparkCls + '">' + sparkContent + '</div>' +
            '<button type="button" class="custom-index-remove" data-remove-custom-index="' + utils.escapeHtml(code) + '" aria-label="删除 ' + utils.escapeHtml(code) + '">✕</button>' +
            '</div>';
    }

    function bindCustomIndexRemove() {
        document.querySelectorAll('[data-remove-custom-index]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var code = this.getAttribute('data-remove-custom-index');
                removeCustomIndex(code);
            });
        });
    }

    function bindCustomIndexAdd() {
        document.querySelectorAll('[data-custom-index-add]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                openCustomIndexAddForm();
            });
        });
    }

    function openCustomIndexAddForm() {
        bindCustomIndexAddForm();
        var form = document.getElementById('custom-index-add-form');
        var input = document.getElementById('custom-index-input');
        if (!form || !input) {
            showCustomIndexStatus('添加表单不可用', 'error');
            return;
        }
        form.hidden = false;
        input.value = '';
        input.focus();
    }

    function closeCustomIndexAddForm() {
        var form = document.getElementById('custom-index-add-form');
        var input = document.getElementById('custom-index-input');
        if (!form) return;
        form.hidden = true;
        form.dataset.submitting = 'false';
        if (input) input.value = '';
    }

    function bindCustomIndexAddForm() {
        var form = document.getElementById('custom-index-add-form');
        var input = document.getElementById('custom-index-input');
        var cancel = document.getElementById('custom-index-add-cancel');
        if (!form || !input || form.dataset.bound === 'true') return;
        form.dataset.bound = 'true';
        form.dataset.submitting = 'false';
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            if (form.dataset.submitting === 'true') return;
            var value = input.value.trim();
            if (!value) {
                input.focus();
                return;
            }
            form.dataset.submitting = 'true';
            var submit = form.querySelector('button[type="submit"]');
            if (submit) submit.disabled = true;
            addCustomIndexByInput(value).then(function (added) {
                if (added) closeCustomIndexAddForm();
            }).finally(function () {
                form.dataset.submitting = 'false';
                if (submit) submit.disabled = false;
            });
        });
        if (cancel) cancel.addEventListener('click', closeCustomIndexAddForm);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeCustomIndexAddForm();
        });
    }

    async function addCustomIndexByInput(rawValue) {
        showCustomIndexStatus('查询中…');
        try {
            var match = await W.resolveStockInput(rawValue);
            var code = match.code;
            if (state.customIndexCodes.includes(code)) {
                showCustomIndexStatus('已在自选指数中', 'error');
                return false;
            }
            if (state.customIndexCodes.length >= KEYS.CUSTOM_INDEX_MAX) {
                showCustomIndexStatus('自选指数最多 ' + KEYS.CUSTOM_INDEX_MAX + ' 个,请先删除', 'error');
                return false;
            }
            state.customIndexCodes.push(code);
            saveCustomIndices();
            renderCustomIndex();
            showCustomIndexStatus((match.name || code) + ' 已添加');
            loadSingleCustomIndex(code);
            return true;
        } catch (e) {
            showCustomIndexStatus(e.message || '未找到匹配指数', 'error');
            return false;
        }
    }

    function removeCustomIndex(code) {
        state.customIndexCodes = state.customIndexCodes.filter(function (c) { return c !== code; });
        delete state.customIndexCache[code];
        if (window.AppMarket && typeof window.AppMarket.clearIndexPrevForCode === 'function') {
            window.AppMarket.clearIndexPrevForCode('custom', code);
        }
        saveCustomIndices();
        persistCustomIndexCache();
        renderCustomIndex();
        showCustomIndexStatus('已删除');
    }

    function showCustomIndexStatus(msg, type) {
        if (window.AppAlerts) window.AppAlerts.showStatusToast(msg, type);
    }

    async function loadCustomIndexData() {
        if (state.customIndexCodes.length === 0) {
            renderCustomIndex();
            return;
        }
        try {
            var res = await window.AppDataClient.fetch('/stock', { codes: state.customIndexCodes.join(',') });
            if (!res.ok) throw new Error('请求失败 ' + res.status);
            var result = await res.json();
            if (!applyCustomIndexQuoteBatch(result, state.customIndexCodes)) throw new Error('数据异常');
        } catch (e) {
            state.customIndexFreshCodes = {};
            renderCustomIndex();
        }
    }

    async function loadSingleCustomIndex(code) {
        try {
            var res = await window.AppDataClient.fetch('/stock', { codes: code });
            if (!res.ok) return;
            var result = await res.json();
            if (!result.success || !result.data) return;
            var d = result.data[code];
            if (d && d.price !== '0.00' && Number.isFinite(Number(d.priceValue))) {
                preserveSparkline(code, d);
                state.customIndexCache[code] = d;
                state.customIndexFreshCodes[code] = true;
            } else {
                delete state.customIndexFreshCodes[code];
            }
            if (result.time) {
                state.customIndexUpdateTime = result.time;
                persistCustomIndexUpdateTime(result.time);
            }
            persistCustomIndexCache();
            // 新增指数首屏拉一次时,直接给这个 code 写入 prev(等于自身,首渲染箭头为 '─')
            if (d && typeof d.priceValue === 'number'
                && window.AppMarket && typeof window.AppMarket.setIndexPrevForCode === 'function') {
                window.AppMarket.setIndexPrevForCode('custom', code, d.priceValue);
            }
            renderCustomIndex();
            loadCustomIndexMinutes([code]);
        } catch (e) { /* ignore */ }
    }

    // 自选指数版:复用同一个 5 分钟节流键
    function refreshStaleCustomIndex() {
        if (state.customIndexCodes.length === 0) return;
        var stale = state.customIndexCodes.filter(function (c) { return !state.customIndexFreshCodes[c]; });
        if (stale.length === 0) return;

        var lastPull = 0;
        try { lastPull = parseInt(window.AppStorage.getItem(KEYS.WATCH_REFRESH_THROTTLE_KEY) || '0', 10) || 0; } catch (e) {}
        if (Date.now() - lastPull < KEYS.WATCH_REFRESH_THROTTLE_MS) return;

        window.AppDataClient.fetch('/stock', { codes: state.customIndexCodes.join(',') })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (result) {
                if (!result || !result.success || !result.data) return;
                var freshCodes = {};
                Object.keys(result.data).forEach(function (code) {
                    var d = result.data[code];
                    if (d && d.price !== '0.00' && Number.isFinite(Number(d.priceValue))) {
                        preserveSparkline(code, d);
                        state.customIndexCache[code] = d;
                        freshCodes[code] = true;
                    }
                });
                state.customIndexFreshCodes = freshCodes;
                if (result.time) {
                    state.customIndexUpdateTime = result.time;
                    persistCustomIndexUpdateTime(result.time);
                }
                persistCustomIndexCache();
                renderCustomIndex();
                loadCustomIndexMinutes(Object.keys(freshCodes));
            })
            .catch(function () { /* ignore */ });
    }

    W.saveCustomIndices = saveCustomIndices;
    W.persistCustomIndexCache = persistCustomIndexCache;
    W.persistCustomIndexUpdateTime = persistCustomIndexUpdateTime;
    W.renderCustomIndex = renderCustomIndex;
    W.renderCustomIndexItem = renderCustomIndexItem;
    W.bindCustomIndexRemove = bindCustomIndexRemove;
    W.bindCustomIndexAdd = bindCustomIndexAdd;
    W.bindCustomIndexAddForm = bindCustomIndexAddForm;
    W.openCustomIndexAddForm = openCustomIndexAddForm;
    W.closeCustomIndexAddForm = closeCustomIndexAddForm;
    W.addCustomIndexByInput = addCustomIndexByInput;
    W.removeCustomIndex = removeCustomIndex;
    W.showCustomIndexStatus = showCustomIndexStatus;
    W.loadCustomIndexData = loadCustomIndexData;
    W.applyCustomIndexQuoteBatch = applyCustomIndexQuoteBatch;
    W.loadSingleCustomIndex = loadSingleCustomIndex;
    W.refreshStaleCustomIndex = refreshStaleCustomIndex;
    W.loadCustomIndexMinutes = loadCustomIndexMinutes;
})();
