// Shared color-mode controller. It runs before CSS so every Tauri window
// receives a stable light/dark theme on its first rendered frame.
(function (root, factory) {
    var api = factory(root);
    root.AppTheme = api;
    api.start();
})(window, function (root) {
    var SETTINGS_KEY = 'fund_tracker_settings';
    var VALID_MODES = ['light', 'dark', 'system'];
    var media = root && typeof root.matchMedia === 'function'
        ? root.matchMedia('(prefers-color-scheme: dark)')
        : null;
    var currentMode = 'light';
    var cleanup = null;

    function normalizeMode(value) {
        var normalized = String(value || '').toLowerCase();
        return VALID_MODES.includes(normalized) ? normalized : 'light';
    }

    function resolveMode(mode, prefersDark) {
        var normalized = normalizeMode(mode);
        if (normalized !== 'system') return normalized;
        return prefersDark ? 'dark' : 'light';
    }

    function parseSettings(raw) {
        try {
            var value = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (_error) {
            return {};
        }
    }

    function readMode(storage) {
        if (!storage || typeof storage.getItem !== 'function') return 'light';
        return normalizeMode(parseSettings(storage.getItem(SETTINGS_KEY)).colorMode);
    }

    function syncNativeWindowTheme(resolved, windowObject) {
        var tauriWindow = windowObject
            && windowObject.__TAURI__
            && windowObject.__TAURI__.window;
        if (!tauriWindow || typeof tauriWindow.getCurrentWindow !== 'function') return;

        try {
            var result = tauriWindow.getCurrentWindow().setTheme(resolved);
            if (result && typeof result.catch === 'function') result.catch(function () {});
        } catch (_error) {
            // Browser previews and tests do not expose the native window API.
        }
    }

    function apply(mode, options) {
        options = options || {};
        currentMode = normalizeMode(mode);
        var prefersDark = typeof options.prefersDark === 'boolean'
            ? options.prefersDark
            : !!(media && media.matches);
        var resolved = resolveMode(currentMode, prefersDark);
        var document = options.document || (root && root.document);
        if (document && document.documentElement) {
            document.documentElement.dataset.colorMode = currentMode;
            document.documentElement.dataset.theme = resolved;
            document.documentElement.style.colorScheme = resolved;
            if (document.defaultView && typeof document.defaultView.CustomEvent === 'function') {
                document.dispatchEvent(new document.defaultView.CustomEvent('fund-tracker-theme-change', {
                    detail: { mode: currentMode, resolved: resolved },
                }));
            }
        }
        syncNativeWindowTheme(resolved, options.window || root);
        return { mode: currentMode, resolved: resolved };
    }

    function syncFromSettings(settings) {
        return apply(parseSettings(settings).colorMode);
    }

    function start(options) {
        options = options || {};
        if (cleanup) cleanup();
        var storage = options.storage || (root && root.localStorage);
        var windowObject = options.window || root;
        var mediaObject = options.media || media;
        currentMode = readMode(storage);
        apply(currentMode, {
            document: options.document || (root && root.document),
            prefersDark: !!(mediaObject && mediaObject.matches),
        });

        function handleMedia(event) {
            if (currentMode === 'system') apply(currentMode, { prefersDark: !!event.matches });
        }

        function handleStorage(event) {
            if (!event || event.key !== SETTINGS_KEY) return;
            currentMode = normalizeMode(parseSettings(event.newValue).colorMode);
            apply(currentMode);
        }

        if (mediaObject) {
            if (typeof mediaObject.addEventListener === 'function') mediaObject.addEventListener('change', handleMedia);
            else if (typeof mediaObject.addListener === 'function') mediaObject.addListener(handleMedia);
        }
        if (windowObject && typeof windowObject.addEventListener === 'function') {
            windowObject.addEventListener('storage', handleStorage);
        }

        cleanup = function () {
            if (mediaObject) {
                if (typeof mediaObject.removeEventListener === 'function') mediaObject.removeEventListener('change', handleMedia);
                else if (typeof mediaObject.removeListener === 'function') mediaObject.removeListener(handleMedia);
            }
            if (windowObject && typeof windowObject.removeEventListener === 'function') {
                windowObject.removeEventListener('storage', handleStorage);
            }
            cleanup = null;
        };
        return cleanup;
    }

    return {
        SETTINGS_KEY: SETTINGS_KEY,
        VALID_MODES: VALID_MODES.slice(),
        apply: apply,
        getMode: function () { return currentMode; },
        normalizeMode: normalizeMode,
        parseSettings: parseSettings,
        readMode: readMode,
        resolveMode: resolveMode,
        setMode: apply,
        start: start,
        syncFromSettings: syncFromSettings,
    };
});
