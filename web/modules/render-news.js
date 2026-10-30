// 资讯页：只保留产业链资讯（金十/财联社/东财快讯源已移除）。
// 子 Tab = 产业链 12 个赛道 + 全部赛道总览；选中单个赛道时只渲染该赛道。
(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var uiState = window.AppUiState || {
        render: function (_kind, options) { return '<div class="news-status">' + utils.escapeHtml(options.title) + '</div>'; },
    };

    var ALL_SECTOR = 'all';
    // 总览模式下每个赛道最多展示的条目数（单赛道模式展示全部，服务端上限 12 条）
    var OVERVIEW_ITEMS_PER_SECTOR = 6;

    function currentSector() {
        var key = state.currentIndustrySector || ALL_SECTOR;
        return key;
    }

    function emptyIndustryState() {
        return { board: null, isLoading: false, error: false, actionBusy: '' };
    }

    function resetNewsState(_source) {
        state.newsState.industry = emptyIndustryState();
    }

    function industryState() {
        if (!state.newsState.industry) resetNewsState('industry');
        return state.newsState.industry;
    }

    /* ---------------------------------------------------------- 赛道 Tab */

    function syncSectorTabs(board) {
        var selected = currentSector();
        var counts = {};
        var total = 0;
        if (board && Array.isArray(board.sectors)) {
            board.sectors.forEach(function (sector) {
                var n = Array.isArray(sector.items) ? sector.items.length : 0;
                counts[sector.key] = n;
                total += n;
            });
            counts[ALL_SECTOR] = total;
            // 选中的赛道若已不在看板里，回落到全部
            if (selected !== ALL_SECTOR && !Object.prototype.hasOwnProperty.call(counts, selected)) {
                state.currentIndustrySector = ALL_SECTOR;
                selected = ALL_SECTOR;
            }
        }
        document.querySelectorAll('.industry-sector-tab').forEach(function (tab) {
            var key = tab.getAttribute('data-sector');
            tab.classList.toggle('active', key === selected);
            tab.setAttribute('aria-selected', key === selected ? 'true' : 'false');
            var badge = tab.querySelector('.industry-tab-count');
            if (board && Object.prototype.hasOwnProperty.call(counts, key)) {
                if (!badge) {
                    badge = document.createElement('em');
                    badge.className = 'industry-tab-count';
                    tab.appendChild(badge);
                }
                badge.textContent = String(counts[key]);
            } else if (badge) {
                badge.remove();
            }
        });
    }

    function selectSector(key) {
        if (!key) return;
        state.currentIndustrySector = key;
        syncSectorTabs(industryState().board);
        renderNewsList();
    }

    function initNewsSourceTabs() {
        state.currentNewsSource = 'industry';
        if (!state.currentIndustrySector) state.currentIndustrySector = ALL_SECTOR;
        document.querySelectorAll('.industry-sector-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                selectSector(tab.getAttribute('data-sector'));
                var current = industryState();
                if (!current.board && !current.isLoading) loadIndustryBoard();
            });
        });
        syncSectorTabs(industryState().board);
    }

    // 快讯的无限滚动已随快讯源一并移除，保留空实现兼容 app.js 的启动调用。
    function initNewsScroll() {}
    function maybeLoadMoreNews() {}

    /* ---------------------------------------------------------- 数据加载 */

    async function fetchIndustry(action) {
        var res = await window.AppDataClient.fetch('/industry-news', { action: action || 'board' }, { force: true, cacheMode: 'bypass_fresh' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success) throw new Error(json.message || '产业链资讯暂不可用');
        return json.data || {};
    }

    async function loadIndustryBoard() {
        var current = industryState();
        if (current.isLoading) return;
        current.isLoading = true;
        renderNewsList();
        try {
            current.board = await fetchIndustry('board');
            current.error = false;
        } catch (error) {
            console.error('产业链资讯获取失败:', error);
            current.error = true;
        } finally {
            current.isLoading = false;
            renderNewsList();
        }
    }

    async function runIndustryAction(action) {
        var current = industryState();
        if (current.actionBusy || current.isLoading) return;
        current.actionBusy = action;
        renderNewsList();
        try {
            await fetchIndustry(action);
            current.board = await fetchIndustry('board');
            current.error = false;
        } catch (error) {
            console.error('产业链资讯操作失败:', error);
            current.error = true;
        } finally {
            current.actionBusy = '';
            renderNewsList();
        }
    }

    // 兼容旧调用名：加载/刷新都指向产业链看板。
    async function loadMoreNews() { return loadIndustryBoard(); }
    async function refreshNewsData(_force) { return loadIndustryBoard(); }

    /* ---------------------------------------------------------- 渲染 */

    function formatIndustryTime(value, withDate) {
        if (!value) return '暂无';
        var date = new Date(value);
        if (isNaN(date.getTime())) return String(value);
        var options = { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false };
        if (withDate) { options.month = '2-digit'; options.day = '2-digit'; }
        return date.toLocaleString('zh-CN', options);
    }

    function industryLinkLabel(link, linkMap) {
        var found = linkMap[link];
        if (!found) return '原文';
        return found.source + '原文';
    }

    function renderSectorItems(sector, limit) {
        var items = Array.isArray(sector.items) ? sector.items : [];
        if (limit) items = items.slice(0, limit);
        if (!items.length) return '<div class="industry-no-points">近 7 天暂无可显示资讯</div>';
        var html = '<div class="industry-items">';
        items.forEach(function (item) {
            var displayTitle = item.titleZh || item.title;
            html += '<article class="industry-news-item"><div><span>' + utils.escapeHtml(item.source || '') + '</span><time>' + utils.escapeHtml(formatIndustryTime(item.ts, true)) + '</time></div>' +
                '<a href="' + utils.escapeHtml(item.link) + '" target="_blank" rel="noopener noreferrer">' + utils.escapeHtml(displayTitle) + '</a>' +
                (item.titleZh && item.titleZh !== item.title ? '<p class="industry-original">' + utils.escapeHtml(item.title) + '</p>' : '') +
                (item.summary ? '<p class="industry-summary">' + utils.escapeHtml(item.summary) + '</p>' : '') + '</article>';
        });
        return html + '</div>';
    }

    function renderSectorPoints(sector, linkMap) {
        if (!sector.points || !sector.points.length) return '<div class="industry-no-points">暂无今日要点</div>';
        var html = '<div class="industry-points"><strong>今日要点</strong><ul>';
        sector.points.forEach(function (point) {
            html += '<li><p>' + utils.escapeHtml(point.text) + '</p><div>' +
                (point.links || []).map(function (link) {
                    return '<a href="' + utils.escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">' + utils.escapeHtml(industryLinkLabel(link, linkMap)) + '</a>';
                }).join('') + '</div></li>';
        });
        return html + '</ul></div>';
    }

    function renderSector(sector, linkMap, options) {
        var total = Array.isArray(sector.items) ? sector.items.length : 0;
        var shown = options.truncate ? Math.min(total, OVERVIEW_ITEMS_PER_SECTOR) : total;
        var html = '<section class="industry-sector" style="--industry-accent:' + utils.escapeHtml(sector.accent || '#888') + '">' +
            '<header><span></span><h3>' + utils.escapeHtml(sector.name) + '</h3><em>' + total + ' 条</em>' +
            (options.truncate && total > 0
                ? '<button type="button" class="industry-sector-more" data-industry-sector-link="' + utils.escapeHtml(sector.key) + '">只看此赛道</button>'
                : '') +
            '</header>';
        html += renderSectorPoints(sector, linkMap);
        html += renderSectorItems(sector, options.truncate ? OVERVIEW_ITEMS_PER_SECTOR : 0);
        if (options.truncate && total > shown) {
            html += '<button type="button" class="industry-sector-more industry-sector-more--foot" data-industry-sector-link="' + utils.escapeHtml(sector.key) + '">还有 ' + (total - shown) + ' 条，去此赛道看全部</button>';
        }
        return html + '</section>';
    }

    function renderIndustryBoard(container, current) {
        syncSectorTabs(current.board);
        if (current.isLoading && !current.board) {
            container.innerHTML = uiState.render('loading', {
                title: '正在加载产业链资讯',
                detail: '全球产业信号返回后会在这里更新。',
            });
            return;
        }
        if (current.error && !current.board) {
            container.innerHTML = uiState.render('error', {
                title: '产业链资讯暂不可用',
                detail: '请检查网络或稍后重试。',
                retryScope: 'news',
            });
            return;
        }
        var board = current.board;
        if (!board || !Array.isArray(board.sectors)) {
            container.innerHTML = uiState.render('empty', {
                title: '暂无产业链资讯',
                detail: '服务端尚未完成第一次抓取。',
            });
            return;
        }
        var status = Array.isArray(board.sourceStatus) ? board.sourceStatus : [];
        var okSources = status.filter(function (s) { return s.ok; }).length;
        var totalItems = board.sectors.reduce(function (sum, s) { return sum + (Array.isArray(s.items) ? s.items.length : 0); }, 0);
        var linkMap = {};
        board.sectors.forEach(function (sector) {
            (sector.items || []).forEach(function (item) { linkMap[item.link] = item; });
        });
        var selected = currentSector();
        var single = selected !== ALL_SECTOR;
        var visible = single
            ? board.sectors.filter(function (s) { return s.key === selected; })
            : board.sectors;
        var visibleItems = visible.reduce(function (sum, s) { return sum + (Array.isArray(s.items) ? s.items.length : 0); }, 0);
        var busy = current.actionBusy;
        var html = '<div class="industry-board">' +
            '<div class="industry-board-meta"><div><strong>' + (single && visible.length ? utils.escapeHtml(visible[0].name) : '全球产业链信号') + '</strong><span>抓取 ' + utils.escapeHtml(formatIndustryTime(board.fetchedAt, true)) +
            ' · 要点 ' + utils.escapeHtml(formatIndustryTime(board.digestAt, true)) +
            (board.digestModel ? ' · ' + utils.escapeHtml(board.digestModel) : '') +
            ' · 信息源 ' + okSources + '/' + status.length + ' 可用 · ' + (single ? '本赛道 ' + visibleItems + ' 条（全部 ' + totalItems + ' 条）' : '共 ' + totalItems + ' 条') + '</span></div>' +
            '<div class="industry-actions"><button type="button" data-industry-action="refresh"' + (busy ? ' disabled' : '') + '>' + (busy === 'refresh' ? '抓取中…' : '抓取最新') +
            '</button><button type="button" data-industry-action="digest"' + (busy ? ' disabled' : '') + '>' + (busy === 'digest' ? '提炼中…' : '重新提炼') + '</button></div></div>';
        if (current.error) html += '<div class="news-source-warning">最近一次操作失败，当前展示上次结果。</div>';
        if (current.isLoading) html += '<div class="news-source-warning">正在更新产业链资讯…</div>';
        html += '<div class="industry-sectors' + (single ? ' industry-sectors--single' : '') + '">';
        visible.forEach(function (sector) {
            html += renderSector(sector, linkMap, { truncate: !single });
        });
        html += '</div></div>';
        container.innerHTML = html;
        bindNewsContainer(container);
    }

    function renderNewsList() {
        var container = document.getElementById('news-list');
        if (!container) return;
        renderIndustryBoard(container, industryState());
    }

    // 容器级事件委托：看板会随刷新频繁重建，逐条绑监听既浪费又会泄漏。
    function bindNewsContainer(container) {
        if (container.dataset.newsBound === 'true') return;
        container.dataset.newsBound = 'true';
        container.addEventListener('click', function (event) {
            var industryAction = event.target.closest('[data-industry-action]');
            if (industryAction) { runIndustryAction(industryAction.getAttribute('data-industry-action')); return; }
            var sectorLink = event.target.closest('[data-industry-sector-link]');
            if (sectorLink) { selectSector(sectorLink.getAttribute('data-industry-sector-link')); }
        });
    }

    window.AppNews = {
        initNewsSourceTabs: initNewsSourceTabs,
        initNewsScroll: initNewsScroll,
        loadMoreNews: loadMoreNews,
        maybeLoadMoreNews: maybeLoadMoreNews,
        refreshNewsData: refreshNewsData,
        renderNewsList: renderNewsList,
        resetNewsState: resetNewsState,
        selectIndustrySector: selectSector,
    };
})();
