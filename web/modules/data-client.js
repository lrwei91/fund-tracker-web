// Renderer-side request coalescer. Each caller gets its own response-like view.
(function () {
    var inflight = {};

    function AppDataError(message, details) {
        Error.call(this, message);
        this.name = 'AppDataError';
        this.message = message || '数据接口不可用';
        details = details || {};
        this.route = details.route || '';
        this.code = details.code || 'upstream_error';
        this.retryable = details.retryable !== false;
        this.status = details.status == null ? null : details.status;
        this.payload = details.payload || null;
        if (Error.captureStackTrace) Error.captureStackTrace(this, AppDataError);
    }
    AppDataError.prototype = Object.create(Error.prototype);
    AppDataError.prototype.constructor = AppDataError;

    function normalizeParams(params) {
        var entries = Object.entries(params || {}).map(function (entry) {
            var key = entry[0];
            var value = String(entry[1] == null ? '' : entry[1]).trim();
            if (key === 'codes') {
                value = value.split(',').map(function (code) { return code.trim(); })
                    .filter(Boolean).sort().filter(function (code, index, list) { return index === 0 || list[index - 1] !== code; })
                    .join(',');
            }
            return [key, value];
        });
        return Object.fromEntries(entries);
    }

    function stableKey(path, params, cacheMode) {
        var query = new URLSearchParams(normalizeParams(params));
        var key = path + '?' + Array.from(query.entries()).sort(function (a, b) {
            return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
        }).map(function (entry) { return entry[0] + '=' + entry[1]; }).join('&');
        // 缓存模式参与去重键：手动强刷（bypass_fresh）不复用在途的普通请求，
        // 否则「点了刷新」拿到的仍是刷新前的数据。上游侧由 gateway 在途合并兜底。
        return cacheMode ? key + '#' + cacheMode : key;
    }

    function normalizeFailure(path, data) {
        var details = data && typeof data === 'object' ? data : {};
        var code = details.errorCode || (details.meta && details.meta.errorCode) || 'upstream_error';
        var message = details.message || details.error || '数据接口不可用';
        return new AppDataError(message, {
            route: path,
            code: code,
            retryable: details.retryable,
            status: details.status,
            payload: data,
        });
    }

    var FETCH_TIMEOUT_MS = 30000;
    function fetchData(path, params, options) {
        var cacheMode = options && options.cacheMode ? String(options.cacheMode) : '';
        var key = stableKey(path, params, cacheMode);
        if (inflight[key]) return inflight[key];
        var work = Promise.resolve().then(function () {
            var payload = {
                path: path,
                query: normalizeParams(params),
            };
            if (options && options.cacheMode) payload.options = {
                cacheMode: options.cacheMode,
                cycleId: options.cycleId,
            };
            // 超时兜底：网络半开/代理挂起时 fetch 可能永不 settle。不清理的话
            // inflight 里的死 promise 会让同查询永久复用失败，轮询整体假死。
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            var timer = controller ? setTimeout(function () {
                controller.abort();
            }, FETCH_TIMEOUT_MS) : null;
            return fetch('/api/fetch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller ? controller.signal : undefined,
            }).then(function (res) {
                if (res.status === 401) {
                    if (location.pathname !== '/login.html') location.href = '/';
                    throw new AppDataError('登录已失效，请重新登录', { route: path, code: 'unauthorized', retryable: false });
                }
                return res.json();
            }).finally(function () {
                if (timer) clearTimeout(timer);
            });
        }).then(function (data) {
            if (!data || data.success === false) throw normalizeFailure(path, data);
            return data;
        }).catch(function (error) {
            if (error instanceof AppDataError) throw error;
            var aborted = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || '')));
            throw new AppDataError(aborted ? '请求超时，请稍后重试' : (error && error.message ? error.message : '数据接口不可用'), {
                route: path,
                code: aborted ? 'timeout' : 'bridge_error',
                payload: error,
            });
        });
        inflight[key] = work;
        return work.finally(function () {
            if (inflight[key] === work) delete inflight[key];
        });
    }

    function fetchResponse(path, params, options) {
        return fetchData(path, params, options).then(function (data) {
            return { ok: true, status: 200, json: function () { return Promise.resolve(data); } };
        });
    }

    window.AppDataClient = {
        AppDataError: AppDataError,
        fetch: fetchResponse,
        fetchData: fetchData,
        key: stableKey,
        normalizeFailure: normalizeFailure,
    };
})();
