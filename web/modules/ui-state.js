// Consistent loading, empty and error states for data surfaces.
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AppUiState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function render(kind, options) {
        options = options || {};
        var normalized = ['loading', 'empty', 'error'].includes(kind) ? kind : 'empty';
        var defaults = {
            loading: { title: '正在加载', detail: '数据返回后会在这里更新。' },
            empty: { title: '暂无数据', detail: '当前条件下没有可显示的内容。' },
            error: { title: '数据暂不可用', detail: '请稍后重试，已有内容不会被清空。' },
        }[normalized];
        var title = escapeHtml(options.title || defaults.title);
        var detail = escapeHtml(options.detail || defaults.detail);
        var role = normalized === 'error' ? 'alert' : 'status';
        var retry = normalized === 'error' && options.retryScope
            ? '<button type="button" class="ui-state-retry" data-ui-retry="' +
                escapeHtml(options.retryScope) + '">重新加载</button>'
            : '';
        var skeleton = normalized === 'loading'
            ? '<div class="ui-state-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'
            : '';
        return '<div class="ui-state ui-state--' + normalized + '" data-ui-state="' + normalized + '" role="' + role + '">' +
            '<strong class="ui-state-title">' + title + '</strong>' +
            '<span class="ui-state-detail">' + detail + '</span>' + skeleton + retry + '</div>';
    }

    function bindRetries(container, callback) {
        if (!container || typeof container.addEventListener !== 'function') return function () {};
        function handleClick(event) {
            var button = event.target && event.target.closest ? event.target.closest('[data-ui-retry]') : null;
            if (!button || !container.contains(button)) return;
            if (typeof callback === 'function') callback(button.getAttribute('data-ui-retry'), button);
        }
        container.addEventListener('click', handleClick);
        return function () { container.removeEventListener('click', handleClick); };
    }

    return { bindRetries: bindRetries, escapeHtml: escapeHtml, render: render };
});
