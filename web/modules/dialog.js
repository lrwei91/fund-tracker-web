// Shared modal behavior: Escape, focus trap, background inert and focus return.
(function () {
    var activeDialogs = new Set();
    var records = new WeakMap();

    function appShell() {
        return document.getElementById('app-shell') || document.querySelector('.app-shell');
    }

    function focusable(panel) {
        return Array.from(panel.querySelectorAll([
            'a[href]', 'button:not([disabled])', 'input:not([disabled])',
            'select:not([disabled])', 'textarea:not([disabled])', 'summary',
            '[tabindex]:not([tabindex="-1"])',
        ].join(','))).filter(function (element) {
            if (element.getAttribute('aria-hidden') === 'true') return false;
            for (var parent = element; parent; parent = parent.parentElement) {
                if (parent.hidden || getComputedStyle(parent).display === 'none') return false;
                if (parent.tagName === 'DETAILS' && !parent.open && !(element.tagName === 'SUMMARY' && element.parentElement === parent)) return false;
                if (parent === panel) break;
            }
            return true;
        });
    }

    function syncBackground() {
        var shell = appShell();
        var blocked = activeDialogs.size > 0;
        if (shell) shell.inert = blocked;
        document.body.classList.toggle('dialog-open', blocked);
    }

    function close(panel) {
        var record = records.get(panel);
        if (!record) return;
        panel.removeEventListener('keydown', record.onKeyDown);
        if (record.openClass) {
            panel.classList.remove(record.openClass);
            if (record.overlay) record.overlay.classList.remove(record.openClass);
        }
        if (record.hideOnClose) {
            panel.hidden = true;
            if (record.overlay) record.overlay.hidden = true;
        }
        activeDialogs.delete(panel);
        records.delete(panel);
        syncBackground();
        var returnTarget = record.trigger;
        if ((!returnTarget || !returnTarget.isConnected) && typeof record.restoreFocus === 'function') {
            returnTarget = record.restoreFocus();
        }
        if (returnTarget && returnTarget.isConnected && typeof returnTarget.focus === 'function') {
            returnTarget.focus();
        }
        if (typeof record.onClose === 'function') record.onClose();
    }

    function open(panel, overlay, options) {
        if (!panel) return;
        options = options || {};
        if (records.has(panel)) return;
        var record = {
            hideOnClose: !!options.hideOnClose,
            onClose: options.onClose,
            openClass: options.openClass || '',
            overlay: overlay || null,
            restoreFocus: options.restoreFocus,
            trigger: options.trigger || document.activeElement,
        };
        record.onKeyDown = function (event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                close(panel);
                return;
            }
            if (event.key !== 'Tab') return;
            var items = focusable(panel);
            if (!items.length) {
                event.preventDefault();
                panel.focus();
                return;
            }
            var first = items[0];
            var last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        records.set(panel, record);
        activeDialogs.add(panel);
        if (record.hideOnClose) {
            panel.hidden = false;
            if (record.overlay) record.overlay.hidden = false;
        }
        if (record.openClass) {
            panel.classList.add(record.openClass);
            if (record.overlay) record.overlay.classList.add(record.openClass);
        }
        panel.addEventListener('keydown', record.onKeyDown);
        syncBackground();
        var target = options.focusTarget || focusable(panel)[0] || panel;
        if (!target.hasAttribute('tabindex') && target === panel) target.tabIndex = -1;
        target.focus();
    }

    function choose(options) {
        options = options || {};
        var overlay = document.createElement('div');
        var panel = document.createElement('section');
        overlay.className = 'app-choice-overlay';
        panel.className = 'app-choice-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        var titleId = 'app-choice-title-' + Date.now().toString(36);
        panel.setAttribute('aria-labelledby', titleId);
        panel.tabIndex = -1;
        panel.innerHTML = '<div class="app-choice-header"><h3 id="' + titleId + '">' + (options.title || '请选择操作') + '</h3></div>' +
            '<div class="app-choice-body">' + (options.body || '') + '</div>' +
            '<div class="app-choice-actions"></div>';
        var actions = panel.querySelector('.app-choice-actions');
        var settled = false;
        var resolve;
        function finish(value) {
            if (settled) return;
            settled = true;
            resolve(value);
            window.setTimeout(function () { overlay.remove(); panel.remove(); }, 0);
        }
        (options.actions || [{ value: 'cancel', label: '取消', secondary: true }]).forEach(function (item) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'data-action-btn' + (item.secondary ? ' secondary' : '');
            button.textContent = item.label;
            button.addEventListener('click', function () {
                finish(item.value);
                close(panel);
            });
            actions.appendChild(button);
        });
        document.body.appendChild(overlay);
        document.body.appendChild(panel);
        var promise = new Promise(function (done) { resolve = done; });
        open(panel, overlay, {
            trigger: options.trigger || document.activeElement,
            openClass: 'open',
            hideOnClose: true,
            focusTarget: actions.querySelector('button'),
            onClose: function () {
                finish('cancel');
                if (options.onClose) options.onClose();
            },
        });
        overlay.addEventListener('click', function () {
            finish('cancel');
            close(panel);
        });
        return promise;
    }

    window.AppDialog = { choose: choose, close: close, open: open };
})();
