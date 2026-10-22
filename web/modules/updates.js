(function () {
    var state = null;
    var busy = false;
    var initialized = false;
    function element(id) { return document.getElementById(id); }
    function render(next) {
        state = next;
        var status = element('app-update-status');
        if (!status || !state) return;
        element('app-current-version').textContent = state.currentVersion || '--';
        element('app-automatic-updates').checked = state.automatic !== false;
        var phase = state.phase;
        var messages = {
            idle: '尚未检查更新', checking: '正在检查更新…', latest: '已是最新版本',
            development: '开发模式不检查或安装更新', available: '发现新版本 ' + state.version,
            downloading: '正在下载更新…', downloaded: '更新已下载并通过签名校验，可重启安装',
            installing: '正在安装更新…', error: state.error || '更新失败，请重试',
        };
        status.textContent = state.error || messages[phase] || '尚未检查更新';
        element('app-update-notes').textContent = state.notes || '';
        var check = element('app-check-update');
        check.disabled = busy || ['checking', 'downloading', 'installing'].includes(phase);
        var download = element('app-download-update');
        download.hidden = !(state.version && ['available', 'error'].includes(phase));
        download.disabled = busy || !state.canInstall;
        element('app-install-update').hidden = phase !== 'downloaded';
        element('app-install-update').disabled = busy;
        var progress = element('app-update-progress');
        progress.hidden = phase !== 'downloading';
        if (state.total > 0) progress.value = Math.min(100, Math.round(100 * state.received / state.total));
        else progress.removeAttribute('value');
        element('app-update-mode').textContent = state.enabled === false ? '开发模式下更新功能不启用。' :
            (state.canInstall ? '启动 30 秒后自动检查，之后每 24 小时检查。下载和重启安装均由你确认。' : '当前运行方式不支持自动安装。Windows 便携版请先改用安装版。');
        var notice = element('app-update-notice');
        if (notice) {
            notice.hidden = !['available', 'downloaded'].includes(phase);
            notice.textContent = phase === 'downloaded' ? '更新已下载，查看安装' : '发现新版本 ' + state.version;
        }
    }
    async function run(method) {
        if (busy) return;
        busy = true;
        if (state) render(state);
        try { render(await window.shell[method]()); }
        catch (error) { render(Object.assign({}, state, { error: String(error.message || error) })); }
        finally { busy = false; if (state) render(state); }
    }
    function openAbout() {
        var panel = element('settings-panel');
        if (panel.hidden) element('settings-btn').click();
        document.querySelector('[data-settings-view="about"]').click();
    }
    function closeInstallDialog() {
        window.AppDialog.close(element('app-update-install-dialog'));
    }
    async function install() {
        if (busy || !state || state.phase !== 'downloaded') return;
        busy = true;
        element('app-update-install-confirm').disabled = true;
        var error = element('app-update-install-error');
        error.textContent = '';
        try {
            if (window.AppStorage) {
                await window.AppStorage.flush();
                if (window.AppStorage.getStatus().pending > 0) throw new Error('配置仍有未保存改动，请保存后重试。');
            }
            await window.shell.updateInstall();
        } catch (failure) {
            error.textContent = String(failure.message || failure);
        } finally {
            busy = false;
            element('app-update-install-confirm').disabled = false;
        }
    }
    async function init() {
        if (initialized || !element('app-update-status')) return;
        initialized = true;
        if (!window.shell || !window.shell.updateStatus) {
            element('app-update-status').textContent = '网页版由服务器统一更新，刷新页面即是最新版';
            element('app-check-update').disabled = true;
            element('app-automatic-updates').disabled = true;
            return;
        }
        element('app-check-update').addEventListener('click', function () { void run('updateCheck'); });
        element('app-download-update').addEventListener('click', function () { void run('updateDownload'); });
        element('app-install-update').addEventListener('click', function () {
            element('app-update-install-error').textContent = '';
            window.AppDialog.open(element('app-update-install-dialog'), element('app-update-install-overlay'), { hideOnClose: true });
        });
        element('app-update-install-cancel').addEventListener('click', closeInstallDialog);
        element('app-update-install-confirm').addEventListener('click', function () { void install(); });
        element('app-update-notice').addEventListener('click', openAbout);
        element('app-automatic-updates').addEventListener('change', async function () {
            var input = this;
            input.disabled = true;
            try { render(await window.shell.updatePreferences(input.checked)); }
            catch (error) {
                if (state) input.checked = state.automatic;
                element('app-update-status').textContent = String(error.message || error);
            } finally { input.disabled = false; }
        });
        if (window.shell.onUpdateState) window.shell.onUpdateState(render);
        await run('updateStatus');
    }
    window.AppUpdates = { init: init };
})();
