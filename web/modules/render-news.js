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
        industry: { label: '产业链资讯', path: '/industry-news' },
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
        return { items: [], cursor: null, hasMore: true, isLoading: false, error: false, actualSource: source, degraded: false, stale: false, staleAgeSeconds: 0, board: null, actionBusy: '' };
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
                var current = state.newsState[state.currentNewsSource];
                if (state.currentNewsSource === 'industry' ? !current.board : !current.items.length) loadMoreNews();
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
        if (state.currentTab !== 'news' || state.currentNewsSource === 'industry') return;
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
        // 只有手动强刷才绕过服务端缓存；自动刷新（60s）走正常缓存即可，
        // 服务端对快讯源已有短 TTL，没必要每次轮询都打上游。
        var bypassFresh = !!force;
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

    async function fetchIndustry(action) {
        var res = await window.AppDataClient.fetch('/industry-news', { action: action || 'board' }, { force: true, cacheMode: 'bypass_fresh' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success) throw new Error(json.message || '产业链资讯暂不可用');
        return json.data || {};
    }

    async function loadIndustryBoard() {
        var current = state.newsState.industry;
        if (!current || current.isLoading) return;
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
        var current = state.newsState.industry;
        if (!current || current.actionBusy || current.isLoading) return;
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

    async function loadMoreNews() {
        var source = state.currentNewsSource;
        if (source === 'industry') return loadIndustryBoard();
        var current = state.newsState[source];
        var container = document.getElementById('news-list');
        if (!current || current.isLoading || (current.items.length && !current.hasMore)) return;
        current.isLoading = true;
        var appendMode = current.items.length > 0;
        if (!appendMode) renderNewsList();
        else if (container) setNewsFooter(container, current);
        try {
            var page = await requestPage(source, current.cursor, false);
            var oldCount = current.items.length;
            current.items = mergeUnique(current.items, page.rows);
            current.cursor = page.cursor;
            current.hasMore = page.hasMore;
            current.actualSource = page.actualSource;
            current.degraded = page.degraded;
            current.stale = page.stale;
            current.staleAgeSeconds = page.staleAgeSeconds;
            current.error = false;
            if (appendMode && container) {
                // 追加模式：只把新增条目插到尾部状态行之前，
                // 已有条目的展开态和滚动位置都不受影响。
                var appended = current.items.slice(oldCount);
                var footer = container.querySelector('[data-news-footer]');
                var html = appended.map(renderNewsItem).join('');
                if (footer) footer.insertAdjacentHTML('beforebegin', html);
                else if (html) container.insertAdjacentHTML('beforeend', html);
            }
        } catch (error) {
            console.error(SOURCES[source].label + '获取失败:', error);
            current.error = true;
        } finally {
            current.isLoading = false;
            if (appendMode && container && !current.error) setNewsFooter(container, current);
            else renderNewsList();
        }
    }

    async function refreshNewsData(force) {
        var source = state.currentNewsSource;
        if (source === 'industry') return loadIndustryBoard();
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

    // 展开态注册表：以条目 key 记忆，刷新/重渲染后可恢复（此前只存在 DOM class 上，
    // 60s 自动刷新一把全量重建就全部折叠了）。
    var expandedNewsKeys = {};
    function pruneExpandedKeys(items) {
        var alive = {};
        items.forEach(function (item) {
            var key = itemKey(item);
            if (key && expandedNewsKeys[key]) alive[key] = true;
        });
        expandedNewsKeys = alive;
    }

    function newsFooterHtml(current) {
        if (current.isLoading) return '<div class="news-status news-loading">刷新中...</div>';
        if (current.error) return uiState.render('error', {
            title: '刷新失败，正在显示已有快讯',
            detail: '旧内容已保留，可重新加载最新数据。',
            retryScope: 'news',
        });
        if (current.hasMore) return '<button type="button" class="news-status news-loadmore" data-news-load-more="1">加载更多</button>';
        return '<div class="news-status news-loadend">已经到底了</div>';
    }

    function setNewsFooter(container, current) {
        var footer = container.querySelector('[data-news-footer]');
        if (footer) footer.innerHTML = newsFooterHtml(current);
        else container.insertAdjacentHTML('beforeend', '<div class="news-footer" data-news-footer="1">' + newsFooterHtml(current) + '</div>');
    }

    function renderNewsList() {
        var container = document.getElementById('news-list');
        if (!container) return;
        var current = state.newsState[state.currentNewsSource];
        if (!current) return;
        if (state.currentNewsSource === 'industry') {
            renderIndustryBoard(container, current);
            return;
        }
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
        pruneExpandedKeys(current.items);
        var sourceWarning = '';
        if (current.stale || current.degraded) {
            var statusLabel = current.stale
                ? dataStatus.label({ stale: true, staleAgeSeconds: current.staleAgeSeconds })
                : '备用来源 · ' + actualSourceLabel(current.actualSource);
            sourceWarning = '<div class="news-source-warning">' + utils.escapeHtml(statusLabel) + '</div>';
        }
        container.innerHTML = sourceWarning + current.items.map(renderNewsItem).join('')
            + '<div class="news-footer" data-news-footer="1">' + newsFooterHtml(current) + '</div>';
        bindNewsContainer(container);
        observeLoadSentinel();
    }

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

    function renderIndustryBoard(container, current) {
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
        var busy = current.actionBusy;
        var html = '<div class="industry-board">' +
            '<div class="industry-board-meta"><div><strong>全球产业链信号</strong><span>抓取 ' + utils.escapeHtml(formatIndustryTime(board.fetchedAt, true)) +
            ' · 要点 ' + utils.escapeHtml(formatIndustryTime(board.digestAt, true)) +
            (board.digestModel ? ' · ' + utils.escapeHtml(board.digestModel) : '') +
            ' · 信息源 ' + okSources + '/' + status.length + ' 可用 · 展示 ' + totalItems + ' 条</span></div>' +
            '<div class="industry-actions"><button type="button" data-industry-action="refresh"' + (busy ? ' disabled' : '') + '>' + (busy === 'refresh' ? '抓取中…' : '抓取最新') +
            '</button><button type="button" data-industry-action="digest"' + (busy ? ' disabled' : '') + '>' + (busy === 'digest' ? '提炼中…' : '重新提炼') + '</button></div></div>';
        if (current.error) html += '<div class="news-source-warning">最近一次操作失败，当前展示上次结果。</div>';
        html += '<div class="industry-sectors">';
        board.sectors.forEach(function (sector) {
            html += '<section class="industry-sector" style="--industry-accent:' + utils.escapeHtml(sector.accent || '#888') + '">' +
                '<header><span></span><h3>' + utils.escapeHtml(sector.name) + '</h3><em>' + (sector.items ? sector.items.length : 0) + ' 条</em></header>';
            if (sector.points && sector.points.length) {
                html += '<div class="industry-points"><strong>今日要点</strong><ul>';
                sector.points.forEach(function (point) {
                    html += '<li><p>' + utils.escapeHtml(point.text) + '</p><div>' +
                        (point.links || []).map(function (link) {
                            return '<a href="' + utils.escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">' + utils.escapeHtml(industryLinkLabel(link, linkMap)) + '</a>';
                        }).join('') + '</div></li>';
                });
                html += '</ul></div>';
            } else {
                html += '<div class="industry-no-points">暂无今日要点</div>';
            }
            if (sector.items && sector.items.length) {
                html += '<div class="industry-items">';
                sector.items.forEach(function (item) {
                    var displayTitle = item.titleZh || item.title;
                    html += '<article class="industry-news-item"><div><span>' + utils.escapeHtml(item.source || '') + '</span><time>' + utils.escapeHtml(formatIndustryTime(item.ts, true)) + '</time></div>' +
                        '<a href="' + utils.escapeHtml(item.link) + '" target="_blank" rel="noopener noreferrer">' + utils.escapeHtml(displayTitle) + '</a>' +
                        (item.titleZh && item.titleZh !== item.title ? '<p class="industry-original">' + utils.escapeHtml(item.title) + '</p>' : '') +
                        (item.summary ? '<p class="industry-summary">' + utils.escapeHtml(item.summary) + '</p>' : '') + '</article>';
                });
                html += '</div>';
            } else {
                html += '<div class="industry-no-points">近 7 天暂无可显示资讯</div>';
            }
            html += '</section>';
        });
        html += '</div></div>';
        container.innerHTML = html;
        bindNewsContainer(container);
    }

    function renderNewsItem(item) {
        if (!item.title && !item.summary) return '';
        var expanded = !!expandedNewsKeys[itemKey(item)];
        return '<article class="news-item' + (expanded ? ' expanded' : '') + '" tabindex="0" data-news-key="' + utils.escapeHtml(itemKey(item)) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
            '<div class="news-header"><span class="news-time">' + utils.escapeHtml(formatNewsTime(item.time)) + '</span></div>' +
            (item.title ? '<div class="news-title">' + utils.escapeHtml(item.title) + '</div>' : '') +
            (item.summary ? '<div class="news-summary">' + utils.escapeHtml(item.summary) + '</div>' : '') +
            '<span class="news-expand-hint" aria-hidden="true">' + (expanded ? '收起' : '展开') + '</span>' +
            '</article>';
    }

    function toggleNewsItem(itemEl) {
        var key = itemEl.getAttribute('data-news-key');
        if (!key) return;
        var expanded = !expandedNewsKeys[key];
        if (expanded) expandedNewsKeys[key] = true;
        else delete expandedNewsKeys[key];
        itemEl.classList.toggle('expanded', expanded);
        itemEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        var hint = itemEl.querySelector('.news-expand-hint');
        if (hint) hint.textContent = expanded ? '收起' : '展开';
    }

    // 容器级事件委托：列表内条目可能随刷新频繁重建，逐条绑监听既浪费又会泄漏。
    function bindNewsContainer(container) {
        if (container.dataset.newsBound === 'true') return;
        container.dataset.newsBound = 'true';
        container.addEventListener('click', function (event) {
            var industryAction = event.target.closest('[data-industry-action]');
            if (industryAction) { runIndustryAction(industryAction.getAttribute('data-industry-action')); return; }
            if (event.target.closest('[data-news-load-more]')) { loadMoreNews(); return; }
            var item = event.target.closest('.news-item');
            if (item) toggleNewsItem(item);
        });
        container.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            var item = event.target.closest && event.target.closest('.news-item');
            if (!item || event.target !== item) return;
            event.preventDefault();
            toggleNewsItem(item);
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
