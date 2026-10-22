// Shared source/cache status labels. Keep this small so native render modules
// can expose the backend contract without introducing a state framework.
(function () {
    function readMeta(response) {
        return response && response.meta && typeof response.meta === 'object'
            ? response.meta
            : { degraded: false, stale: false };
    }

    function label(meta, freshLabel) {
        meta = readMeta({ meta: meta });
        if (meta.stale) {
            var age = Number(meta.staleAgeSeconds);
            var ageText = Number.isFinite(age) && age > 0 ? ' · ' + Math.max(1, Math.round(age / 60)) + '分钟前' : '';
            return '缓存数据' + ageText;
        }
        if (meta.degraded) return '备用来源 · ' + (freshLabel || '数据可用');
        return freshLabel || '实时数据';
    }

    function sourceLabel(meta, fallback) {
        var sources = meta && meta.sources;
        if (!sources || typeof sources !== 'object') return fallback || '';
        var first = Object.keys(sources).map(function (key) { return sources[key]; })[0];
        return first && (first.actualLabel || first.actual) || fallback || '';
    }

    window.AppDataStatus = {
        label: label,
        readMeta: readMeta,
        sourceLabel: sourceLabel,
    };
})();
