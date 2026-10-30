// Web 版增强（借鉴 OpenStock 的产品形态）：
// 1) ⌘K 全局搜索  2) 个股详情多标签  3) 技术指标显示偏好持久化  4) 板块热力图视图
(function () {
    'use strict';
    var utils = window.AppUtils || null;
    function esc(s) {
        return utils && utils.escapeHtml ? utils.escapeHtml(String(s == null ? '' : s))
            : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    /* ---------------- 1) ⌘K 全局搜索 ---------------- */
    var cmdk = null, cmdkInput = null, cmdkList = null, cmdkItems = [], cmdkActive = 0, cmdkTimer = null;
    var cmdkComposing = false;
    function buildCmdk() {
        if (cmdk) return;
        cmdk = document.createElement('div');
        cmdk.className = 'cmdk-overlay';
        cmdk.hidden = true;
        cmdk.innerHTML = '<div class="cmdk-box" role="dialog" aria-modal="true" aria-label="全局搜索">'
            + '<input class="cmdk-input" type="text" placeholder="搜索股票代码或名称（Enter 打开详情）" autocomplete="off">'
            + '<div class="cmdk-list" role="listbox"></div>'
            + '<div class="cmdk-hint">↑↓ 选择 · Enter 打开详情 · 点 + 加入当前分组 · Esc 关闭</div>'
            + '</div>';
        document.body.appendChild(cmdk);
        cmdkInput = cmdk.querySelector('.cmdk-input');
        cmdkList = cmdk.querySelector('.cmdk-list');
        cmdk.addEventListener('mousedown', function (e) { if (e.target === cmdk) closeCmdk(); });
        // 中文输入法：组词过程中的 input 事件不触发搜索（拼音逐字母会打出大量无效请求），
        // compositionend 后统一搜一次上屏结果。
        cmdkInput.addEventListener('compositionstart', function () { cmdkComposing = true; });
        cmdkInput.addEventListener('compositionend', function () {
            cmdkComposing = false;
            clearTimeout(cmdkTimer);
            cmdkTimer = setTimeout(runCmdkSearch, 120);
        });
        cmdkInput.addEventListener('input', function () {
            if (cmdkComposing) return;
            clearTimeout(cmdkTimer);
            cmdkTimer = setTimeout(runCmdkSearch, 220);
        });
        cmdkInput.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!cmdkItems.length) return;
                cmdkActive = (cmdkActive + (e.key === 'ArrowDown' ? 1 : -1) + cmdkItems.length) % cmdkItems.length;
                renderCmdk();
            } else if (e.key === 'Enter') {
                if (e.isComposing || e.keyCode === 229) return; // 输入法确认候选词
                var item = cmdkItems[cmdkActive];
                if (item) { openDetail(item.code); closeCmdk(); }
            }
        });
    }
    function openCmdk() {
        buildCmdk();
        cmdk.hidden = false;
        cmdkInput.value = '';
        cmdkItems = []; cmdkActive = 0; cmdkComposing = false;
        renderCmdk();
        setTimeout(function () { cmdkInput.focus(); }, 0);
    }
    function closeCmdk() { if (cmdk) cmdk.hidden = true; }
    function renderCmdk() {
        if (!cmdkItems.length) {
            cmdkList.innerHTML = '<div class="cmdk-empty">输入代码或名称开始搜索</div>';
            return;
        }
        cmdkList.innerHTML = cmdkItems.map(function (item, i) {
            return '<div class="cmdk-item' + (i === cmdkActive ? ' active' : '') + '" data-index="' + i + '" role="option">'
                + '<span class="cmdk-name">' + esc(item.name || item.code) + '</span>'
                + '<span class="cmdk-code">' + esc(item.code) + '</span>'
                + '<button class="cmdk-add" data-add="' + i + '" title="加入当前自选分组">+ 自选</button>'
                + '</div>';
        }).join('');
        Array.prototype.forEach.call(cmdkList.querySelectorAll('.cmdk-item'), function (el) {
            el.addEventListener('mousedown', function (e) {
                if (e.target.closest('.cmdk-add')) return;
                var item = cmdkItems[Number(el.getAttribute('data-index'))];
                if (item) { openDetail(item.code); closeCmdk(); }
            });
        });
        Array.prototype.forEach.call(cmdkList.querySelectorAll('.cmdk-add'), function (btn) {
            btn.addEventListener('mousedown', function (e) {
                e.stopPropagation();
                var item = cmdkItems[Number(btn.getAttribute('data-add'))];
                if (item) addToWatchlist(item.code);
            });
        });
    }
    function runCmdkSearch() {
        var q = cmdkInput.value.trim();
        if (!q) { cmdkItems = []; renderCmdk(); return; }
        if (!window.AppDataClient) return;
        window.AppDataClient.fetchData('/stock-search', { q: q }).then(function (res) {
            if (cmdkInput.value.trim() !== q) return;
            cmdkItems = (res && res.data) || [];
            cmdkActive = 0;
            renderCmdk();
        }).catch(function () { cmdkItems = []; renderCmdk(); });
    }
    function openDetail(code) {
        if (window.AppWorkbench && typeof window.AppWorkbench.openDetail === 'function') {
            window.AppWorkbench.openDetail(code);
        }
    }
    function addToWatchlist(code) {
        var input = document.getElementById('stock-code-input');
        if (input && window.AppWatchlist && typeof window.AppWatchlist.addStockToWatchlist === 'function') {
            input.value = code;
            window.AppWatchlist.addStockToWatchlist();
        }
    }
    document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            if (cmdk && !cmdk.hidden) closeCmdk(); else openCmdk();
        } else if (e.key === 'Escape' && cmdk && !cmdk.hidden) {
            closeCmdk();
        }
    });

    /* ---------------- 2) 个股详情多标签 ---------------- */
    var TABS_KEY = 'ft_detail_tabs';
    var detailTabs = [];
    try { detailTabs = JSON.parse(localStorage.getItem(TABS_KEY) || '[]'); } catch (e) { detailTabs = []; }
    if (!Array.isArray(detailTabs)) detailTabs = [];
    var activeDetailCode = null;
    var tabStrip = null;
    function saveTabs() {
        try { localStorage.setItem(TABS_KEY, JSON.stringify(detailTabs.slice(0, 10))); } catch (e) { /* ignore */ }
    }
    function renderTabs() {
        if (!tabStrip) return;
        if (!detailTabs.length) { tabStrip.hidden = true; tabStrip.innerHTML = ''; return; }
        tabStrip.hidden = false;
        tabStrip.innerHTML = detailTabs.map(function (t) {
            return '<span class="detail-tab' + (t.code === activeDetailCode ? ' active' : '') + '" data-code="' + esc(t.code) + '">'
                + '<button class="detail-tab-main" data-open="' + esc(t.code) + '">' + esc(t.name || t.code) + ' <small>' + esc(t.code) + '</small></button>'
                + '<button class="detail-tab-close" data-close="' + esc(t.code) + '" aria-label="关闭标签">×</button>'
                + '</span>';
        }).join('');
        Array.prototype.forEach.call(tabStrip.querySelectorAll('[data-open]'), function (btn) {
            btn.addEventListener('click', function () { openDetail(btn.getAttribute('data-open')); });
        });
        Array.prototype.forEach.call(tabStrip.querySelectorAll('[data-close]'), function (btn) {
            btn.addEventListener('click', function () {
                var code = btn.getAttribute('data-close');
                detailTabs = detailTabs.filter(function (t) { return t.code !== code; });
                saveTabs();
                if (code === activeDetailCode && window.AppWorkbench && typeof window.AppWorkbench.closeDetail === 'function') {
                    window.AppWorkbench.closeDetail();
                    activeDetailCode = detailTabs.length ? detailTabs[detailTabs.length - 1].code : null;
                }
                renderTabs();
            });
        });
    }
    function noteDetailOpened(code) {
        if (!/^\d{6}$/.test(String(code || ''))) return;
        activeDetailCode = code;
        if (!detailTabs.some(function (t) { return t.code === code; })) {
            detailTabs.push({ code: code, name: '' });
            if (detailTabs.length > 10) detailTabs.shift();
            saveTabs();
            if (window.AppDataClient) {
                window.AppDataClient.fetchData('/stock', { codes: code }).then(function (res) {
                    var q = res && res.data && res.data[code];
                    var tab = detailTabs.find(function (t) { return t.code === code; });
                    if (q && tab && q.name) { tab.name = q.name; saveTabs(); renderTabs(); }
                }).catch(function () {});
            }
        }
        renderTabs();
    }
    function initDetailTabs() {
        var pane = document.querySelector('.watch-list-pane');
        if (!pane || !window.AppWorkbench || typeof window.AppWorkbench.openDetail !== 'function') return;
        tabStrip = document.createElement('div');
        tabStrip.className = 'detail-tabs';
        tabStrip.hidden = true;
        pane.insertBefore(tabStrip, pane.firstChild);
        var original = window.AppWorkbench.openDetail;
        window.AppWorkbench.openDetail = function (code, trigger) {
            noteDetailOpened(code);
            return original.call(window.AppWorkbench, code, trigger);
        };
        renderTabs();
    }

    /* ---------------- 3) 技术指标显示偏好 ---------------- */
    var PREF_KEY = 'ft_indicator_prefs';
    var METRIC_LABELS = ['收盘', 'MA20', 'MA50', 'RSI14', '52周位置', '21日', '获利盘', '平均成本', '支撑', '压力'];
    var hiddenMetrics = new Set();
    try { (JSON.parse(localStorage.getItem(PREF_KEY) || '[]') || []).forEach(function (x) { hiddenMetrics.add(x); }); } catch (e) { /* ignore */ }
    function savePrefs() {
        try { localStorage.setItem(PREF_KEY, JSON.stringify(Array.from(hiddenMetrics))); } catch (e) { /* ignore */ }
    }
    function applyMetricPrefs(root) {
        var scope = root || document;
        Array.prototype.forEach.call(scope.querySelectorAll('.stock-analysis-cell'), function (cell) {
            var label = cell.querySelector('span');
            if (!label) return;
            cell.style.display = hiddenMetrics.has(label.textContent.trim()) ? 'none' : '';
        });
    }
    function buildMetricMenu(head) {
        if (head.querySelector('.metric-pref-btn')) return;
        var wrap = document.createElement('span');
        wrap.className = 'metric-pref';
        wrap.innerHTML = '<button class="metric-pref-btn" type="button" title="选择显示的指标">指标 ⚙</button>'
            + '<span class="metric-pref-pop" hidden>' + METRIC_LABELS.map(function (label) {
                return '<label><input type="checkbox" data-metric="' + esc(label) + '"' + (hiddenMetrics.has(label) ? '' : ' checked') + '> ' + esc(label) + '</label>';
            }).join('') + '</span>';
        var btn = wrap.querySelector('.metric-pref-btn');
        var pop = wrap.querySelector('.metric-pref-pop');
        btn.addEventListener('click', function (e) { e.stopPropagation(); pop.hidden = !pop.hidden; });
        document.addEventListener('click', function () { pop.hidden = true; });
        pop.addEventListener('click', function (e) { e.stopPropagation(); });
        Array.prototype.forEach.call(pop.querySelectorAll('input[data-metric]'), function (input) {
            input.addEventListener('change', function () {
                var label = input.getAttribute('data-metric');
                if (input.checked) hiddenMetrics.delete(label); else hiddenMetrics.add(label);
                savePrefs();
                applyMetricPrefs(document);
            });
        });
        head.appendChild(wrap);
    }
    function initMetricPrefs() {
        var panel = document.getElementById('stock-fund-panel');
        if (!panel) return;
        var observer = new MutationObserver(function () {
            applyMetricPrefs(panel);
            var head = panel.querySelector('.stock-analysis-head');
            if (head) buildMetricMenu(head);
        });
        observer.observe(panel, { childList: true, subtree: true });
        applyMetricPrefs(panel);
    }

    /* ---------------- 4) 行业全景：只显示热力图 ----------------
       与应用自身的全景列表共用同一份数据（直接读 #sector-panorama-grid 的渲染结果），
       不再单独发请求：状态文案、刷新节奏、stale 表现都与列表完全一致。
       列表本身隐藏，只呈现按涨幅排序的热力图；图例放在卡片体内顶部。 */

    function panoItemsFromGrid(grid) {
        var items = [];
        var nodes = grid.querySelectorAll('.sector-panorama-item');
        Array.prototype.forEach.call(nodes, function (node) {
            var nameEl = node.querySelector('.sector-panorama-name');
            var pctEl = node.querySelector('.sector-panorama-change');
            var text = pctEl ? pctEl.textContent.trim() : '';
            var pct = text && text !== '--' ? parseFloat(text.replace('%', '')) : null;
            items.push({ name: nameEl ? nameEl.textContent.trim() : '', pct: isFinite(pct) ? pct : null, text: text || '--' });
        });
        return items;
    }
    function panoTileColor(pct) {
        if (pct == null || !isFinite(pct) || pct === 0) return '';
        var share = Math.round(8 + Math.min(1, Math.abs(pct) / 5) * 30);
        var tone = pct > 0 ? 'var(--red)' : 'var(--green)';
        return 'background:color-mix(in srgb, ' + tone + ' ' + share + '%, var(--color-surface))';
    }
    function buildPanoTiles(grid, box) {
        var items = panoItemsFromGrid(grid);
        if (!items.length) {
            var stateTitle = grid.querySelector('.ui-state-title');
            box.innerHTML = '<div class="heatmap-empty">' + esc(stateTitle ? stateTitle.textContent.trim() : '暂无行业行情') + '</div>';
            return;
        }
        var sorted = items.slice().sort(function (a, b) {
            if (a.pct == null && b.pct == null) return 0;
            if (a.pct == null) return 1;
            if (b.pct == null) return -1;
            return b.pct - a.pct;
        });
        box.innerHTML = sorted.map(function (item) {
            var tone = item.pct == null || item.pct === 0 ? '' : item.pct > 0 ? ' positive' : ' negative';
            return '<div class="heatmap-tile" style="' + panoTileColor(item.pct) + '">'
                + '<span class="heatmap-name">' + esc(item.name) + '</span>'
                + '<strong class="heatmap-pct' + tone + '">' + esc(item.text) + '</strong></div>';
        }).join('');
    }
    function initHeatmap() {
        var section = document.querySelector('.sector-panorama-section');
        var grid = document.getElementById('sector-panorama-grid');
        if (!section || !grid || !grid.parentNode) return;
        var body = grid.parentNode;

        var toolbar = document.createElement('div');
        toolbar.className = 'pano-toolbar';
        toolbar.innerHTML = '<div class="pano-legend"><span>跌</span><i class="pano-legend-bar"></i><span>涨</span><em>按涨幅排序</em></div>';
        body.insertBefore(toolbar, grid);

        var box = document.createElement('div');
        box.id = 'sector-heatmap';
        box.className = 'sector-heatmap';
        body.insertBefore(box, grid.nextSibling);
        grid.style.display = 'none';
        buildPanoTiles(grid, box);

        // 列表数据变化（刷新/stale/空状态）时，热力图跟着同一份数据重建。
        var rebuildQueued = false;
        var observer = new MutationObserver(function () {
            if (rebuildQueued) return;
            rebuildQueued = true;
            setTimeout(function () { rebuildQueued = false; buildPanoTiles(grid, box); }, 0);
        });
        observer.observe(grid, { childList: true });
    }

    ready(function () {
        initDetailTabs();
        initMetricPrefs();
        initHeatmap();
    });
})();
