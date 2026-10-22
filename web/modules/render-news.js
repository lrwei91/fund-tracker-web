// 财经新闻：金十 / 财联社 / 东方财富。分页与刷新最新分离。
(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var uiState = window.AppUiState || {
        render: function (_kind, options) { return '<div class="news-status">' + utils.escapeHtml(options.title) + '</div>'; },
    };
    var dataStatus = window.AppDataStatus || { label: function (_meta, fallback) { return fallback || ''; } };
    var KEYS = state.KEYS;
    var SOURCES = {
        jin10: { label: '金十快讯', path: '/news' },
        cls: { label: '财联社', path: '/cls-news' },
        eastmoney: { label: '东财资讯', path: '/global-news' },
    };

    function stripHtmlTags(html) {
        if (!html) return '';
        try {
            var doc = new DOMParser().parseFromString(String(html), 'text/html');
            return doc.body ? (doc.body.textContent || '') : '';
        } catch (e) {
            return String(html).replace(/<[^>]*>/g, '');
        }
    }

    function formatNewsTime(timeStr) {
        if (!timeStr) return '';
        var parts = String(timeStr).split(' ');
        if (parts.length < 2) return String(timeStr);
        return parts[0] === utils.getShanghaiDateKey()
            ? parts[1].substring(0, 5)
            : parts[0].substring(5) + ' ' + parts[1].substring(0, 5);
    }

    function emptyNewsState(source) {
        return { items: [], cursor: null, hasMore: true, isLoading: false, error: false, actualSource: source, degraded: false, stale: false, staleAgeSeconds: 0 };
    }

    function initNewsSourceTabs() {
        if (!Object.prototype.hasOwnProperty.call(SOURCES, state.currentNewsSource)) state.currentNewsSource = 'jin10';
        document.querySelectorAll('.news-source-tab').forEach(function (tab) {
            tab.classList.toggle('active', tab.getAttribute('data-source') === state.currentNewsSource);
            tab.addEventListener('click', function () {
                tab.parentElement.querySelectorAll('.news-source-tab').forEach(function (item) { item.classList.remove('active'); });
                tab.classList.add('active');
                state.currentNewsSource = tab.getAttribute('data-source');
                if (!state.newsState[state.currentNewsSource]) resetNewsState(state.currentNewsSource);
                renderNewsList();
                if (!state.newsState[state.currentNewsSource].items.length) loadMoreNews();
            });
        });
    }

    function resetNewsState(source) {
        state.newsState[source] = emptyNewsState(source);
    }

    var newsLoadObserver = null;
    function initNewsScroll() {
        if (newsLoadObserver || typeof window.IntersectionObserver !== 'function') return;
        var root = document.getElementById('main-content');
        newsLoadObserver = new window.IntersectionObserver(function (entries) {
            if (entries.some(function (entry) { return entry.isIntersecting; })) maybeLoadMoreNews();
        }, { root: root || null, rootMargin: '320px 0px' });
        observeLoadSentinel();
    }

    function observeLoadSentinel() {
        if (!newsLoadObserver) return;
        newsLoadObserver.disconnect();
        var sentinel = document.querySelector('[data-news-load-more]');
        if (sentinel) newsLoadObserver.observe(sentinel);
    }

    function maybeLoadMoreNews() {
        if (state.currentTab !== 'news') return;
        var current = state.newsState[state.currentNewsSource];
        if (!current || current.isLoading || !current.hasMore) return;
        loadMoreNews();
    }

    function normalizeRow(source, item) {
        if (source === 'jin10') {
            return {
                id: String(item.id || ''),
                title: '',
                summary: stripHtmlTags(item.data && item.data.content),
                time: item.time || '',
                url: item.url || '',
            };
        }
        return {
            id: String(item.id || item.url || ''),
            title: item.title || '',
            summary: item.summary || '',
            time: item.time || '',
            url: item.url || '',
        };
    }

    function itemKey(item) {
        return item.id || [item.time, item.title, item.summary].join('|');
    }

    function mergeUnique(first, second) {
        var seen = {};
        return first.concat(second).filter(function (item) {
            var key = itemKey(item);
            if (!key || seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    async function requestPage(source, cursor, force) {
        var config = SOURCES[source];
        var query = { limit: String(KEYS.NEWS_PAGE_SIZE[source]) };
        if (cursor) query.cursor = cursor;
        var bypassFresh = !!force || !cursor;
        var res = await window.AppDataClient.fetch(config.path, query, {
            force: bypassFresh,
            cacheMode: bypassFresh ? 'bypass_fresh' : 'normal',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success) throw new Error(json.message || '数据异常');
        var payload = json.data || {};
        return {
            actualSource: payload.source || source,
            degraded: !!(json.meta && json.meta.degraded),
            stale: !!(json.meta && json.meta.stale),
            staleAgeSeconds: Number(json.meta && json.meta.staleAgeSeconds) || 0,
            meta: json.meta || null,
            rows: (Array.isArray(payload.data) ? payload.data : []).map(function (item) { return normalizeRow(source, item); }),
            cursor: payload.nextCursor || null,
            hasMore: !!payload.hasMore && !!payload.nextCursor,
        };
    }

    async function loadMoreNews() {
        var source = state.currentNewsSource;
        var current = state.newsState[source];
        if (!current || current.isLoading || (current.items.length && !current.hasMore)) return;
        current.isLoading = true;
        renderNewsList();
        try {
            var page = await requestPage(source, current.cursor, false);
            current.items = mergeUnique(current.items, page.rows);
            current.cursor = page.cursor;
            current.hasMore = page.hasMore;
            current.actualSource = page.actualSource;
            current.degraded = page.degraded;
            current.stale = page.stale;
            current.staleAgeSeconds = page.staleAgeSeconds;
            current.error = false;
        } catch (error) {
            console.error(SOURCES[source].label + '获取失败:', error);
            current.error = true;
        } finally {
            current.isLoading = false;
            renderNewsList();
        }
    }

    async function refreshNewsData(force) {
        var source = state.currentNewsSource;
        var current = state.newsState[source];
        if (!current || current.isLoading) return;
        if (!current.items.length) return loadMoreNews();
        current.isLoading = true;
        try {
            var page = await requestPage(source, null, !!force);
            current.items = mergeUnique(page.rows, current.items);
            current.actualSource = page.actualSource;
            current.degraded = page.degraded;
            current.stale = page.stale;
            current.staleAgeSeconds = page.staleAgeSeconds;
            current.error = false;
        } catch (error) {
            console.error(SOURCES[source].label + '刷新失败:', error);
            current.error = true;
        } finally {
            current.isLoading = false;
            renderNewsList();
        }
    }

    function actualSourceLabel(source) {
        return SOURCES[source] ? SOURCES[source].label : source;
    }

    function renderNewsList() {
        var container = document.getElementById('news-list');
        if (!container) return;
        var current = state.newsState[state.currentNewsSource];
        if (!current) return;
        if (current.isLoading && !current.items.length) {
            container.innerHTML = uiState.render('loading', {
                title: '正在加载快讯',
                detail: '最新消息返回后会在这里更新。',
            });
            return;
        }
        if (current.error && !current.items.length) {
            container.innerHTML = uiState.render('error', {
                title: SOURCES[state.currentNewsSource].label + '暂不可用',
                detail: '请检查网络或稍后重试。',
                retryScope: 'news',
            });
            return;
        }
        if (!current.items.length) {
            container.innerHTML = uiState.render('empty', {
                title: '暂无' + SOURCES[state.currentNewsSource].label,
                detail: '当前来源没有返回可显示的快讯。',
            });
            return;
        }
        var sourceWarning = '';
        if (current.stale || current.degraded) {
            var statusLabel = current.stale
                ? dataStatus.label({ stale: true, staleAgeSeconds: current.staleAgeSeconds })
                : '备用来源 · ' + actualSourceLabel(current.actualSource);
            sourceWarning = '<div class="news-source-warning">' + utils.escapeHtml(statusLabel) + '</div>';
        }
        var html = sourceWarning + current.items.map(renderNewsItem).join('');
        if (current.isLoading) html += '<div class="news-status news-loading">刷新中...</div>';
        else if (current.error) html += uiState.render('error', {
            title: '刷新失败，正在显示已有快讯',
            detail: '旧内容已保留，可重新加载最新数据。',
            retryScope: 'news',
        });
        else if (current.hasMore) html += '<button type="button" class="news-status news-loadmore" data-news-load-more="1">加载更多</button>';
        else html += '<div class="news-status news-loadend">已经到底了</div>';
        container.innerHTML = html;
        bindNewsItems(container);
        var loadMoreButton = container.querySelector('[data-news-load-more]');
        if (loadMoreButton) loadMoreButton.addEventListener('click', loadMoreNews);
        observeLoadSentinel();
    }

    function renderNewsItem(item) {
        if (!item.title && !item.summary) return '';
        return '<article class="news-item" tabindex="0" aria-expanded="false">' +
            '<div class="news-header"><span class="news-time">' + utils.escapeHtml(formatNewsTime(item.time)) + '</span></div>' +
            (item.title ? '<div class="news-title">' + utils.escapeHtml(item.title) + '</div>' : '') +
            (item.summary ? '<div class="news-summary">' + utils.escapeHtml(item.summary) + '</div>' : '') +
            '<span class="news-expand-hint" aria-hidden="true">展开</span>' +
            '</article>';
    }

    function bindNewsItems(container) {
        container.querySelectorAll('.news-item').forEach(function (item) {
            function toggleItem() {
                var expanded = item.classList.toggle('expanded');
                item.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                var hint = item.querySelector('.news-expand-hint');
                if (hint) hint.textContent = expanded ? '收起' : '展开';
            }
            item.addEventListener('click', toggleItem);
            item.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggleItem();
            });
        });
    }

    window.AppNews = {
        initNewsSourceTabs: initNewsSourceTabs,
        initNewsScroll: initNewsScroll,
        loadMoreNews: loadMoreNews,
        mergeUnique: mergeUnique,
        maybeLoadMoreNews: maybeLoadMoreNews,
        refreshNewsData: refreshNewsData,
        renderNewsItem: renderNewsItem,
        renderNewsList: renderNewsList,
        resetNewsState: resetNewsState,
    };
})();
