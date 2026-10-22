// ================================================================
// 自选股 — 导入 / 导出 + 各类 normalize
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var KEYS = W.KEYS;

    function normalizeImportedWatchTabs(rawTabs) {
        if (!Array.isArray(rawTabs) || rawTabs.length === 0) throw new Error('文件中没有自选股分组');
        if (rawTabs.every(function (item) { return /^\d{6}$/.test(String(item || '').trim()); })) {
            return [
                { id: 'default', name: '持仓股', codes: W.sanitizeCodes(rawTabs) },
                { id: 'candidate', name: '候选股', codes: [] },
            ];
        }
        return rawTabs.map(function (tab, index) {
            tab = tab && typeof tab === 'object' ? tab : {};
            var id = tab.id || (index === 0 ? 'default' : 'tab-import-' + index + '-' + Date.now().toString(36));
            return {
                id: String(id).slice(0, 48),
                name: W.normalizeWatchTabName(String(tab.name || ''), index).slice(0, 12),
                codes: W.sanitizeCodes(tab.codes || tab.stocks || tab.items),
            };
        });
    }

    function readNumberFromFields(entry, fields) {
        for (var i = 0; i < fields.length; i++) {
            var value = Number(entry[fields[i]]);
            if (Number.isFinite(value)) return value;
        }
        return NaN;
    }

    function normalizeImportedCostEntry(entry) {
        if (typeof entry === 'number' || typeof entry === 'string') {
            return { cost: Number(entry), shares: 0 };
        }
        if (!entry || typeof entry !== 'object') return null;
        return {
            cost: readNumberFromFields(entry, ['cost', 'costPrice', 'avgCost', 'averageCost', 'buyPrice', 'price']),
            shares: readNumberFromFields(entry, ['shares', 'quantity', 'qty', 'amount', 'count']),
        };
    }

    function normalizeImportedWatchlistCost(rawCost, tabs) {
        var clean = {};
        var codeMap = W.getCodesFromTabs(tabs);
        if (!rawCost || typeof rawCost !== 'object') return clean;
        var entries = Array.isArray(rawCost)
            ? rawCost.map(function (entry) {
                return {
                    code: entry && typeof entry === 'object' ? String(entry.code || entry.id || '').trim() : '',
                    value: entry,
                };
            })
            : Object.keys(rawCost).map(function (code) {
                return { code: String(code).trim(), value: rawCost[code] };
            });
        entries.forEach(function (item) {
            var code = item.code;
            var normalized = normalizeImportedCostEntry(item.value);
            if (!/^\d{6}$/.test(code) || !codeMap[code] || !normalized) return;
            var cost = normalized.cost;
            var shares = normalized.shares;
            if (!Number.isFinite(cost) || cost <= 0) return;
            clean[code] = {
                cost: cost,
                shares: Number.isFinite(shares) && shares > 0 ? shares : 0,
            };
        });
        return clean;
    }

    function normalizeImportedWatchlistRemarks(rawRemarks, tabs) {
        var clean = {};
        var codeMap = W.getCodesFromTabs(tabs);
        if (!rawRemarks || typeof rawRemarks !== 'object') return clean;
        var entries = Array.isArray(rawRemarks)
            ? rawRemarks.map(function (entry) {
                return {
                    code: entry && typeof entry === 'object' ? String(entry.code || entry.id || '').trim() : '',
                    value: entry && typeof entry === 'object' ? (entry.remark || entry.alias || entry.name || entry.displayName) : '',
                };
            })
            : Object.keys(rawRemarks).map(function (code) {
                return { code: String(code).trim(), value: rawRemarks[code] };
            });
        entries.forEach(function (item) {
            var code = item.code;
            var value = String(item.value || '').trim().slice(0, 16);
            if (!/^\d{6}$/.test(code) || !codeMap[code] || !value) return;
            clean[code] = value;
        });
        return clean;
    }

    function collectWatchlistCostFromTabs(rawTabs) {
        var costMap = {};
        if (!Array.isArray(rawTabs)) return costMap;
        rawTabs.forEach(function (tab) {
            var items = tab && typeof tab === 'object' ? (tab.codes || tab.stocks || tab.items) : null;
            if (!Array.isArray(items)) return;
            items.forEach(function (item) {
                if (!item || typeof item !== 'object') return;
                var code = String(item.code || item.id || '').trim();
                if (/^\d{6}$/.test(code)) costMap[code] = item;
            });
        });
        return costMap;
    }

    function normalizeImportedCustomIndexCodes(rawCodes) {
        return W.sanitizeCodes(rawCodes).slice(0, KEYS.CUSTOM_INDEX_MAX);
    }

    function getRawWatchTabsFromJson(json) {
        if (Array.isArray(json)) return json;
        return json.watchTabs || json.tabs || json.watchlistTabs || json.watchlist || json.groups;
    }

    function getRawCustomIndexCodesFromJson(json) {
        if (W.hasOwn(json, 'customIndexCodes')) return json.customIndexCodes;
        if (W.hasOwn(json, 'customIndices')) return json.customIndices;
        if (W.hasOwn(json, 'customIndex')) return json.customIndex;
        if (W.hasOwn(json, 'indices')) return json.indices;
        return null;
    }

    function getImportedActiveWatchTabId(rawId, tabs) {
        if (typeof rawId === 'string' && tabs.some(function (tab) { return tab.id === rawId; })) return rawId;
        return tabs[0].id;
    }

    function mergeWatchTabs(current, incoming) {
        var result = current.map(function (tab) {
            return { id: tab.id, name: tab.name, codes: W.sanitizeCodes(tab.codes) };
        });
        incoming.forEach(function (tab) {
            var existing = result.find(function (item) { return item.id === tab.id; });
            if (!existing) {
                result.push({ id: tab.id, name: tab.name, codes: W.sanitizeCodes(tab.codes) });
                return;
            }
            existing.codes = W.sanitizeCodes(existing.codes.concat(tab.codes));
            if (!existing.name) existing.name = tab.name;
        });
        return result;
    }

    function mergeObject(existing, incoming) {
        var result = Object.assign({}, incoming || {});
        Object.keys(existing || {}).forEach(function (key) { result[key] = existing[key]; });
        return result;
    }

    function codeSet(tabs) {
        var result = {};
        tabs.forEach(function (tab) { W.sanitizeCodes(tab.codes).forEach(function (code) { result[code] = true; }); });
        return result;
    }

    function countPreview(currentTabs, incomingTabs, replace) {
        var current = codeSet(currentTabs);
        var incoming = codeSet(incomingTabs);
        var currentGroups = {};
        var incomingGroups = {};
        currentTabs.forEach(function (tab) { W.sanitizeCodes(tab.codes).forEach(function (code) {
            (currentGroups[code] || (currentGroups[code] = {}))[tab.id] = true;
        }); });
        incomingTabs.forEach(function (tab) { W.sanitizeCodes(tab.codes).forEach(function (code) {
            (incomingGroups[code] || (incomingGroups[code] = {}))[tab.id] = true;
        }); });
        var counts = { added: 0, retained: 0, conflicts: 0, removed: 0 };
        Object.keys(incoming).forEach(function (code) {
            if (current[code]) {
                var sameGroup = Object.keys(incomingGroups[code]).some(function (id) { return currentGroups[code] && currentGroups[code][id]; });
                if (sameGroup) counts.retained += 1;
                else counts.conflicts += 1;
            }
            else counts.added += 1;
        });
        if (replace) Object.keys(current).forEach(function (code) { if (!incoming[code]) counts.removed += 1; });
        return counts;
    }

    function chooseImportMode(summary, trigger) {
        if (window.AppDialog && typeof window.AppDialog.choose === 'function') {
            return window.AppDialog.choose({
                title: '导入自选数据',
                body: summary,
                trigger: trigger,
                actions: [
                    { value: 'merge', label: '合并导入' },
                    { value: 'replace', label: '替换导入' },
                    { value: 'cancel', label: '取消', secondary: true },
                ],
            });
        }
        return Promise.resolve(window.confirm(summary + '\n\n确定合并导入？') ? 'merge' : 'cancel');
    }

    function getExportPayload() {
        var tabs = W.getWatchTabs();
        var activeWatchTabId = getImportedActiveWatchTabId(state.activeWatchTabId, tabs);
        return {
            version: 3,
            exportedAt: new Date().toISOString(),
            watchTabs: tabs,
            activeWatchTabId: activeWatchTabId,
            watchlistCost: normalizeImportedWatchlistCost(state.watchlistCost, tabs),
            watchlistRemarks: normalizeImportedWatchlistRemarks(state.watchlistRemarks, tabs),
            customIndexCodes: normalizeImportedCustomIndexCodes(state.customIndexCodes),
        };
    }

    function exportWatchlistData() {
        var payload = JSON.stringify(getExportPayload(), null, 2);
        var blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        var date = new Date().toISOString().slice(0, 10);
        link.href = url;
        link.download = 'fund-tracker-watchlist-' + date + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        W.showDataStatus('已导出自选数据');
    }

    function importWatchlistData(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            try {
                var json = JSON.parse(String(reader.result || ''));
                if (!json || typeof json !== 'object') throw new Error('导入文件格式错误');
                var rawTabs = getRawWatchTabsFromJson(json);
                if (rawTabs !== undefined && !Array.isArray(rawTabs)) throw new Error('自选股分组格式错误');
                var hasTabs = Array.isArray(rawTabs);
                var importedTabs = hasTabs ? normalizeImportedWatchTabs(rawTabs) : [];
                var currentTabs = W.getWatchTabs();
                var rawCost = json.watchlistCost || json.holdingCosts || json.costs || json.costMap || json.positions || json.holdings || collectWatchlistCostFromTabs(rawTabs);
                var hasCost = W.hasOwn(json, 'watchlistCost') || W.hasOwn(json, 'holdingCosts') || W.hasOwn(json, 'costs') || Object.keys(collectWatchlistCostFromTabs(rawTabs)).length > 0;
                var rawRemarks = json.watchlistRemarks || json.holdingRemarks || json.remarks || json.aliases || json.aliasMap;
                var hasRemarks = W.hasOwn(json, 'watchlistRemarks') || W.hasOwn(json, 'holdingRemarks') || W.hasOwn(json, 'remarks') || W.hasOwn(json, 'aliases') || W.hasOwn(json, 'aliasMap');
                var rawCustomIndexCodes = getRawCustomIndexCodesFromJson(json);
                var hasCustomIndices = rawCustomIndexCodes !== null;
                if (!hasTabs && !hasCost && !hasRemarks && !hasCustomIndices) {
                    throw new Error('文件未包含可导入的自选股、持仓或自选指数数据');
                }
                var replace = false;
                var preview = countPreview(currentTabs, importedTabs, false);
                var replacePreview = countPreview(currentTabs, importedTabs, true);
                var summary = '新增 ' + preview.added + ' 项，保留 ' + preview.retained + ' 项，冲突 ' + preview.conflicts + ' 项';
                if (hasTabs) summary += '\n替换模式将移除 ' + replacePreview.removed + ' 项';
                if (hasTabs) summary += '\n文件包含 ' + importedTabs.length + ' 个分组';
                if (hasCustomIndices) summary += '\n自选指数：' + normalizeImportedCustomIndexCodes(rawCustomIndexCodes).length + ' 个';
                chooseImportMode(summary, document.activeElement).then(function (mode) {
                    if (mode === 'cancel') return;
                    replace = mode === 'replace';
                    var tabs = hasTabs ? (replace ? importedTabs : mergeWatchTabs(currentTabs, importedTabs)) : currentTabs;
                    var watchlistCost = hasCost
                        ? normalizeImportedWatchlistCost(rawCost, tabs)
                        : (replace ? {} : Object.assign({}, state.watchlistCost || {}));
                    if (!replace && hasCost) watchlistCost = mergeObject(state.watchlistCost || {}, watchlistCost);
                    var watchlistRemarks = hasRemarks
                        ? normalizeImportedWatchlistRemarks(rawRemarks, tabs)
                        : (replace ? {} : Object.assign({}, state.watchlistRemarks || {}));
                    if (!replace && hasRemarks) watchlistRemarks = mergeObject(state.watchlistRemarks || {}, watchlistRemarks);
                    var activeWatchTabId = hasTabs
                        ? getImportedActiveWatchTabId(json.activeWatchTabId, tabs)
                        : state.activeWatchTabId;
                    var customIndexCodes = hasCustomIndices
                        ? normalizeImportedCustomIndexCodes(rawCustomIndexCodes)
                        : state.customIndexCodes;
                    if (hasCustomIndices && !replace) customIndexCodes = W.sanitizeCodes((state.customIndexCodes || []).concat(customIndexCodes)).slice(0, KEYS.CUSTOM_INDEX_MAX);
                    var changes = {};
                    changes[KEYS.WATCH_TABS_KEY] = JSON.stringify(tabs);
                    changes[KEYS.STORAGE_KEY] = JSON.stringify(tabs[0] ? tabs[0].codes : []);
                    changes[KEYS.ACTIVE_WATCH_TAB_KEY] = activeWatchTabId;
                    if (hasCost || replace) changes[KEYS.WATCHLIST_COST_KEY] = JSON.stringify(watchlistCost);
                    if (hasRemarks || replace) changes[KEYS.WATCHLIST_REMARKS_KEY] = JSON.stringify(watchlistRemarks);
                    if (hasCustomIndices) changes[KEYS.CUSTOM_INDICES_KEY] = JSON.stringify(customIndexCodes);
                    changes[KEYS.WATCH_ALERT_STATE_KEY] = JSON.stringify({ __v: KEYS.WATCH_ALERT_SCHEMA_VERSION });
                    var commit = window.AppStorage && typeof window.AppStorage.commit === 'function'
                        ? window.AppStorage.commit(changes)
                        : Promise.resolve().then(function () { Object.keys(changes).forEach(function (key) { window.AppStorage.setItem(key, changes[key]); }); });
                    return commit.then(function () {
                        if (hasTabs) {
                            state.activeWatchTabId = activeWatchTabId;
                        }
                        if (hasCost || replace) state.watchlistCost = watchlistCost;
                        if (hasRemarks || replace) state.watchlistRemarks = watchlistRemarks;
                        if (hasCustomIndices) {
                            state.customIndexCodes = customIndexCodes;
                            state.customIndexCache = {};
                            state.customIndexUpdateTime = '';
                        }
                        state.watchQuoteCache = {};
                        state.watchQuoteUpdateTime = '';
                        state.watchAlertState = {};
                        W.persistWatchQuoteCache();
                        W.persistWatchQuoteUpdateTime('');
                        W.renderWatchTabs();
                        W.renderWatchlist();
                        W.renderCustomIndex();
                        W.loadWatchlistData();
                        if (hasCustomIndices) W.loadCustomIndexData();
                        W.showDataStatus('已' + (replace ? '替换' : '合并') + '导入 ' + tabs.length + ' 个分组' +
                            (hasCustomIndices ? '、' + customIndexCodes.length + ' 个自选指数' : ''));
                    });
                }).catch(function (err) {
                    W.showDataStatus(err && err.message ? err.message : '导入保存失败，原数据未修改', 'error');
                });
            } catch (err) {
                W.showDataStatus(err.message || '导入失败', 'error');
            } finally {
                e.target.value = '';
            }
        };
        reader.onerror = function () {
            W.showDataStatus('读取文件失败', 'error');
            e.target.value = '';
        };
        reader.readAsText(file);
    }

    W.normalizeImportedWatchTabs = normalizeImportedWatchTabs;
    W.exportWatchlistData = exportWatchlistData;
    W.importWatchlistData = importWatchlistData;
})();
