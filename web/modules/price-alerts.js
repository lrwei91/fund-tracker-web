(function () {
    var esc = window.AppUtils.escapeHtml;
    var data = { rules: [], history: [] };
    var fieldLabels = {
        price: '价格（元）',
        changePct: '涨跌幅（%）',
        turnover: '成交额（元）',
        volumeRatio: '量比',
    };
    function message(host, text) {
        var node = host.querySelector('[data-alert-status]');
        if (node) node.textContent = text;
    }
    function conditionRow(condition) {
        condition = condition || { field: 'price', op: '>=', value: '' };
        function options(values, selected) {
            return Object.keys(values)
                .map(function (key) {
                    return (
                        '<option value="' +
                        esc(key) +
                        '"' +
                        (key === selected ? ' selected' : '') +
                        '>' +
                        esc(values[key]) +
                        '</option>'
                    );
                })
                .join('');
        }
        return (
            '<div class="price-condition"><select aria-label="条件指标" data-condition-field>' +
            options(fieldLabels, condition.field) +
            '</select><select aria-label="比较方式" data-condition-op>' +
            options(
                {
                    '>=': '达到 / 高于',
                    '<=': '达到 / 低于',
                    '>': '高于',
                    '<': '低于',
                    crossAbove: '上穿',
                    crossBelow: '下破',
                },
                condition.op,
            ) +
            '</select><input type="number" step="any" required aria-label="条件阈值" data-condition-value value="' +
            esc(condition.value) +
            '"><button type="button" data-condition-remove aria-label="删除条件">×</button></div>'
        );
    }
    function renderEditor(code, rule) {
        rule = rule || {};
        return (
            '<form class="price-rule-form" data-rule-id="' +
            esc(rule.id || '') +
            '"><div class="research-form-grid"><label>股票代码<input name="code" pattern="[0-9]{6}" maxlength="6" required value="' +
            esc(rule.code || code || '') +
            '"></label><label>提醒名称<input name="name" maxlength="60" required value="' +
            esc(rule.name || '') +
            '" placeholder="例如：回到观察价"></label></div><div data-rule-conditions>' +
            (rule.conditions || [{}]).map(conditionRow).join('') +
            '</div><div class="research-toolbar"><button type="button" data-condition-add>增加条件</button><label>条件组合<select name="logic"><option value="and"' +
            (rule.logic !== 'or' ? ' selected' : '') +
            '>全部满足 AND</option><option value="or"' +
            (rule.logic === 'or' ? ' selected' : '') +
            '>任一满足 OR</option></select></label></div><div class="research-form-grid"><label>冷却（分钟）<input name="cooldownMinutes" type="number" min="0" max="1440" required value="' +
            (rule.cooldownMinutes == null ? 30 : rule.cooldownMinutes) +
            '"></label><label>每日最多次数<input name="maxPerDay" type="number" min="1" max="100" required value="' +
            (rule.maxPerDay || 3) +
            '"></label><label>到期时间<input name="expiresAt" type="datetime-local" value="' +
            esc(rule.expiresAt ? localDateTime(rule.expiresAt) : '') +
            '"></label></div><div class="research-toolbar"><label><input name="once" type="checkbox"' +
            (rule.once ? ' checked' : '') +
            '>仅提醒一次</label><label><input name="edgeOnly" type="checkbox"' +
            (rule.edgeOnly !== false ? ' checked' : '') +
            '>离开条件后再触发</label><button type="submit">保存提醒</button></div></form>'
        );
    }
    function localDateTime(value) {
        var date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        var shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return shifted.toISOString().slice(0, 16);
    }
    function describe(rule) {
        return (rule.conditions || [])
            .map(function (c) {
                return (
                    (fieldLabels[c.field] || c.field) +
                    ' ' +
                    ({ crossAbove: '上穿', crossBelow: '下破' }[c.op] || c.op) +
                    ' ' +
                    c.value
                );
            })
            .join(rule.logic === 'or' ? ' 或 ' : ' 且 ');
    }
    function renderList(code) {
        var rules = data.rules.filter(function (r) {
            return !code || r.code === code;
        });
        if (!rules.length) return '<p class="research-note">暂无提醒规则。</p>';
        return rules
            .map(function (rule) {
                return (
                    '<div class="price-rule"><div><strong>' +
                    esc(rule.name) +
                    '</strong><small>' +
                    esc(rule.code) +
                    ' · ' +
                    (rule.expiresAt && new Date(rule.expiresAt).getTime() <= Date.now()
                        ? '已到期'
                        : rule.enabled
                          ? '已启用'
                          : '已暂停') +
                    (rule.expiresAt
                        ? ' · 到期 ' + esc(new Date(rule.expiresAt).toLocaleString('zh-CN'))
                        : '') +
                    '</small><p>' +
                    esc(describe(rule)) +
                    '</p></div><div class="research-toolbar"><button type="button" data-alert-edit="' +
                    esc(rule.id) +
                    '">编辑</button><button type="button" data-alert-toggle="' +
                    esc(rule.id) +
                    '">' +
                    (rule.enabled ? '暂停' : '启用') +
                    '</button><button type="button" data-alert-delete="' +
                    esc(rule.id) +
                    '">删除</button></div></div>'
                );
            })
            .join('');
    }
    function renderHistory(code) {
        var rows = data.history.filter(function (r) {
            return !code || r.code === code;
        });
        return rows.length
            ? rows
                  .slice(0, 20)
                  .map(function (hit) {
                      return (
                          '<div class="price-alert-history"><strong>' +
                          esc(hit.ruleName) +
                          ' · ' +
                          esc(hit.code) +
                          '</strong><span>' +
                          esc(hit.detail) +
                          ' · 现价 ' +
                          esc(hit.price) +
                          '</span><small>' +
                          esc(new Date(hit.time).toLocaleString('zh-CN')) +
                          '</small></div>'
                      );
                  })
                  .join('')
            : '<p class="research-note">暂无触发记录。</p>';
    }
    async function load() {
        var result = await window.AppDataClient.fetchData('/price-alerts', {});
        data = result.data;
        if (window.AppWorkbench) window.AppWorkbench.renderSummary();
        return data;
    }
    async function mount(host, code) {
        if (!host) return;
        host.dataset.alertCode = code || '';
        host.innerHTML =
            '<div class="research-toolbar"><button type="button" data-alert-new>新建提醒</button><button type="button" data-alert-refresh>刷新记录</button></div><p class="research-note">应用运行时每 30 秒监控，窗口隐藏后仍有效；退出或休眠时停止。过期或缺失行情不会触发。</p><p data-alert-status role="status"></p><div data-alert-editor></div><div data-alert-rules></div><details><summary>触发记录</summary><div data-alert-history></div></details>';
        host.querySelector('[data-alert-new]').addEventListener('click', function () {
            edit(host, code);
        });
        host.querySelector('[data-alert-refresh]').addEventListener('click', function () {
            refresh(host, code);
        });
        host.addEventListener('click', async function (event) {
            var button = event.target.closest(
                '[data-alert-toggle], [data-alert-delete], [data-alert-edit]',
            );
            if (!button) return;
            var id =
                button.dataset.alertToggle ||
                button.dataset.alertDelete ||
                button.dataset.alertEdit;
            if (button.dataset.alertEdit) {
                edit(
                    host,
                    code,
                    data.rules.find(function (rule) {
                        return rule.id === id;
                    }),
                );
                return;
            }
            button.disabled = true;
            try {
                await window.AppDataClient.fetchData('/price-alerts', {
                    op: button.dataset.alertDelete ? 'delete' : 'toggle',
                    id: id,
                });
                await refresh(host, code);
            } catch (error) {
                message(host, error.message);
                button.disabled = false;
            }
        });
        await refresh(host, code);
    }
    async function refresh(host, code) {
        try {
            await load();
            var states = {
                monitoring: '监控运行中',
                data_unavailable: '部分行情或条件指标不可用，相关规则未触发',
                idle: '暂无有效的启用规则',
                waiting: '等待交易时段与最新行情',
            };
            document.querySelectorAll('[data-alert-code]').forEach(function (view) {
                view.querySelector('[data-alert-rules]').innerHTML = renderList(
                    view.dataset.alertCode,
                );
                view.querySelector('[data-alert-history]').innerHTML = renderHistory(
                    view.dataset.alertCode,
                );
                message(
                    view,
                    (states[data.status] || '监控等待交易时段与最新行情') +
                        (data.lastCheckedAt
                            ? ' · 上次检查 ' +
                              new Date(data.lastCheckedAt).toLocaleTimeString('zh-CN')
                            : ''),
                );
            });
        } catch (error) {
            message(host, error.message || '提醒列表不可用');
        }
    }
    function edit(host, code, rule) {
        var editor = host.querySelector('[data-alert-editor]');
        editor.innerHTML = renderEditor(code, rule);
        var form = editor.querySelector('form');
        form.querySelector('[data-condition-add]').addEventListener('click', function () {
            if (form.querySelectorAll('.price-condition').length < 6)
                form.querySelector('[data-rule-conditions]').insertAdjacentHTML(
                    'beforeend',
                    conditionRow(),
                );
        });
        form.addEventListener('click', function (event) {
            var remove = event.target.closest('[data-condition-remove]');
            if (remove && form.querySelectorAll('.price-condition').length > 1)
                remove.parentElement.remove();
        });
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var fields = new FormData(form);
            var expiry = fields.get('expiresAt');
            var value = {
                id: form.dataset.ruleId,
                code: fields.get('code'),
                name: fields.get('name'),
                logic: fields.get('logic'),
                enabled: rule ? rule.enabled : true,
                cooldownMinutes: Number(fields.get('cooldownMinutes')),
                maxPerDay: Number(fields.get('maxPerDay')),
                once: fields.get('once') === 'on',
                edgeOnly: fields.get('edgeOnly') === 'on',
                expiresAt: expiry ? new Date(expiry).toISOString() : null,
                conditions: Array.from(form.querySelectorAll('.price-condition')).map(
                    function (row) {
                        return {
                            field: row.querySelector('[data-condition-field]').value,
                            op: row.querySelector('[data-condition-op]').value,
                            value: Number(row.querySelector('[data-condition-value]').value),
                        };
                    },
                ),
            };
            var button = form.querySelector('[type="submit"]');
            button.disabled = true;
            try {
                await window.AppDataClient.fetchData('/price-alerts', {
                    op: 'save',
                    rule: JSON.stringify(value),
                });
                editor.innerHTML = '';
                await refresh(host, code);
            } catch (error) {
                message(host, error.message || '提醒保存失败');
                button.disabled = false;
            }
        });
        form.querySelector('input').focus();
    }
    function init() {
        mount(document.getElementById('price-alert-workspace'));
        if (window.shell && window.shell.onPriceAlertHit)
            window.shell.onPriceAlertHit(function () {
                var host = document.querySelector('[data-alert-code]');
                if (host) refresh(host);
            });
        if (window.shell && window.shell.onPriceAlertError)
            window.shell.onPriceAlertError(function (error) {
                if (window.AppAlerts) window.AppAlerts.showStatusToast(error.message, 'error');
            });
    }
    window.AppPriceAlerts = {
        init: init,
        refresh: function () { return refresh(document.getElementById('price-alert-workspace')); },
        mount: mount,
        renderEditor: renderEditor,
        describe: describe,
        getCodes: function () {
            return data.rules
                .filter(function (r) {
                    return (
                        r.enabled && (!r.expiresAt || new Date(r.expiresAt).getTime() > Date.now())
                    );
                })
                .map(function (r) {
                    return r.code;
                });
        },
    };
})();
