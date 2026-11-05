window.__ModuleLoader__.load({
  id: 'dscord',
  factory(require) {
    const React = require('react');
    const { IconPluginPinwheelOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const panelId = 'dscord';
    const localeNamespace = 'dscord.connection';
    const statusKeys = { offline: 'statusOffline', connecting: 'statusConnecting', online: 'statusOnline', error: 'statusError' };
    const zh = {
      title: 'DSCord', pageLabel: 'DSCord 连接', loginTitle: '登录服务器', serverUrl: '服务器地址',
      username: '账号', password: '密码', login: '登录', loggingIn: '正在登录…',
      disconnect: '断开', disconnecting: '正在断开…', disconnectBot: '断开 {name}',
      connect: '上线', connecting: '正在连接…', connectBot: '上线 {name}',
      reconnect: '重连', reconnecting: '正在重连…', reconnectBot: '重新连接 {name}',
      statusOffline: '已断开', statusConnecting: '正在连接', statusOnline: '已上线', statusError: '连接失败',
      openWeb: '打开网页', refresh: '刷新', readStatus: '正在读取连接状态…',
      runtimeUnavailable: 'Bot 运行环境暂不可用', account: '当前账号',
      logout: '退出登录', loggingOut: '正在退出…', myBots: '我的 Bot',
      emptyBots: '暂无 Bot，请在服务器网页中创建。', configDirectory: '本机配置目录',
      requestHttp: 'DSH 请求失败（HTTP {status}）', requestFailed: '操作失败，请重试',
      invalidStatus: 'DSH 返回的连接状态不完整', requestTimeout: '请求超时，请刷新连接状态',
      connectionUnavailable: '无法连接 DSH，请检查宿主是否正在运行',
    };
    const en = {
      title: 'DSCord', pageLabel: 'DSCord connection', loginTitle: 'Sign in to server', serverUrl: 'Server URL',
      username: 'Username', password: 'Password', login: 'Sign in', loggingIn: 'Signing in…',
      disconnect: 'Disconnect', disconnecting: 'Disconnecting…', disconnectBot: 'Disconnect {name}',
      connect: 'Connect', connecting: 'Connecting…', connectBot: 'Connect {name}',
      reconnect: 'Reconnect', reconnecting: 'Reconnecting…', reconnectBot: 'Reconnect {name}',
      statusOffline: 'Disconnected', statusConnecting: 'Connecting', statusOnline: 'Online', statusError: 'Connection failed',
      openWeb: 'Open website', refresh: 'Refresh', readStatus: 'Loading connection status…',
      runtimeUnavailable: 'The Bot runtime is currently unavailable', account: 'Current account',
      logout: 'Sign out', loggingOut: 'Signing out…', myBots: 'My Bots',
      emptyBots: 'No Bots yet. Create one on the server website.', configDirectory: 'Local configuration directory',
      requestHttp: 'DSH request failed (HTTP {status})', requestFailed: 'The operation failed. Please try again.',
      invalidStatus: 'DSH returned incomplete connection status', requestTimeout: 'The request timed out. Refresh the connection status.',
      connectionUnavailable: 'Cannot reach DSH. Check that the host is running.',
    };

    const styles = `
.dscord-connect {
  --dc-background: #f2f3f5;
  --dc-panel: #ffffff;
  --dc-field: #e9eaed;
  --dc-text: #232428;
  --dc-muted: #5c5e66;
  --dc-line: #dcdde1;
  --dc-accent: #5865f2;
  --dc-danger: #b42335;
  --dc-success: #16794d;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--dc-background);
  color: var(--dc-text);
  font: 14px/1.5 var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
body[data-ds-dark-theme] .dscord-connect {
  --dc-background: #313338;
  --dc-panel: #2b2d31;
  --dc-field: #1e1f22;
  --dc-text: #f2f3f5;
  --dc-muted: #b5bac1;
  --dc-line: #45474e;
  --dc-danger: #ff8e99;
  --dc-success: #65d7a0;
  color-scheme: dark;
}
.dscord-connect *, .dscord-connect *::before, .dscord-connect *::after { box-sizing: border-box; }
.dscord-connect .dc-content { width: min(100%, 880px); margin: 0 auto; padding: 28px; }
.dscord-connect .dc-header, .dscord-connect .dc-toolbar, .dscord-connect .dc-actions { display: flex; align-items: center; gap: 10px; }
.dscord-connect .dc-header { justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; }
.dscord-connect h1 { margin: 0; font-size: 22px; font-weight: 650; }
.dscord-connect h2 { margin: 0 0 16px; font-size: 17px; font-weight: 600; }
.dscord-connect p { margin: 0; }
.dscord-connect .dc-panel { padding: 22px; border: 1px solid var(--dc-line); border-radius: 10px; background: var(--dc-panel); margin-bottom: 20px; }
.dscord-connect .dc-login { max-width: 460px; margin: 0 auto; }
.dscord-connect .dc-field { display: grid; gap: 7px; margin-bottom: 18px; font-weight: 600; }
.dscord-connect input { width: 100%; min-height: 42px; border: 1px solid transparent; border-radius: 5px; padding: 10px 12px; background: var(--dc-field); color: var(--dc-text); font: inherit; font-weight: 400; }
.dscord-connect input::placeholder { color: var(--dc-muted); opacity: 1; }
.dscord-connect button, .dscord-connect .dc-link { min-height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 7px 13px; border: 1px solid var(--dc-line); border-radius: 5px; background: var(--dc-panel); color: var(--dc-text); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; white-space: nowrap; }
.dscord-connect button:hover:enabled, .dscord-connect .dc-link:hover { background: var(--dc-field); }
.dscord-connect button:disabled { cursor: default; opacity: .55; }
.dscord-connect .dc-primary { background: var(--dc-accent); color: #fff; border-color: var(--dc-accent); }
.dscord-connect .dc-primary:hover:enabled { background: #4752c4; }
.dscord-connect .dc-login .dc-primary { width: 100%; min-height: 42px; }
.dscord-connect :is(button, input, a):focus-visible { outline: 2px solid var(--dc-accent); outline-offset: 3px; }
.dscord-connect .dc-muted { color: var(--dc-muted); }
.dscord-connect .dc-error { color: var(--dc-danger); overflow-wrap: anywhere; }
.dscord-connect .dc-notice { padding: 12px 16px; border: 1px solid var(--dc-line); border-radius: 6px; margin-bottom: 18px; background: var(--dc-panel); }
.dscord-connect .dc-account { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dscord-connect .dc-account > div { min-width: 0; flex: 1; }
.dscord-connect .dc-account > button { flex-shrink: 0; }
.dscord-connect .dc-account-name { font-weight: 600; margin-bottom: 4px; overflow-wrap: anywhere; }
.dscord-connect .dc-server, .dscord-connect .dc-directory { overflow-wrap: anywhere; color: var(--dc-muted); }
.dscord-connect .dc-bots { list-style: none; margin: 0; padding: 0; }
.dscord-connect .dc-bot { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 17px 0; border-top: 1px solid var(--dc-line); }
.dscord-connect .dc-bot:first-child { border-top: 0; padding-top: 0; }
.dscord-connect .dc-bot:last-child { padding-bottom: 0; }
.dscord-connect .dc-bot-identity { display: flex; gap: 12px; align-items: center; min-width: 0; }
.dscord-connect .dc-avatar { display: flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 13px; background: var(--dc-accent); color: #fff; font-size: 18px; font-weight: 600; flex: 0 0 auto; }
.dscord-connect .dc-bot-copy { min-width: 0; }
.dscord-connect .dc-bot-name { font-weight: 600; overflow-wrap: anywhere; }
.dscord-connect .dc-bot-id { color: var(--dc-muted); font-size: 12px; overflow-wrap: anywhere; }
.dscord-connect .dc-status { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--dc-muted); font-size: 13px; }
.dscord-connect .dc-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.dscord-connect .dc-status[data-status="online"] { color: var(--dc-success); }
.dscord-connect .dc-status[data-status="error"] { color: var(--dc-danger); }
.dscord-connect .dc-status[data-status="connecting"] { color: var(--dc-accent); }
.dscord-connect .dc-bot-error { font-size: 13px; margin-top: 6px; }
.dscord-connect .dc-directory { font-size: 12px; }
.dscord-connect .dc-directory summary { cursor: pointer; width: fit-content; }
.dscord-connect .dc-directory code { display: block; margin-top: 6px; user-select: text; }
@media (max-width: 640px) {
  .dscord-connect .dc-content { padding: 18px 14px; }
  .dscord-connect .dc-panel { padding: 16px; }
  .dscord-connect .dc-header { gap: 12px; margin-bottom: 18px; }
  .dscord-connect .dc-account { flex-direction: column; align-items: flex-start; gap: 12px; }
  .dscord-connect .dc-account > div { width: 100%; }
  .dscord-connect .dc-bot { align-items: flex-start; flex-direction: column; gap: 12px; }
  .dscord-connect .dc-actions { flex-wrap: wrap; padding-left: 54px; }
  .dscord-connect .dc-toolbar { flex-wrap: wrap; }
}
`;

    function createConnectionModel(t) {
      let snapshot = { value: null, busy: null, error: null, errorTranslation: null, loading: true };
      const listeners = new Set();
      let disposed = false;
      let pollTimer;
      let readController;
      let actionController;
      let revision = 0;
      let errorSource = null;
      let initialStatus = true;

      function clientError(key, params) {
        return Object.assign(new Error(t(key, params)), { translation: { key, params } });
      }

      function publish(update) {
        if (disposed) return;
        snapshot = { ...snapshot, ...update };
        for (const listener of listeners) listener();
      }

      async function request(action, payload, controller) {
        const timeoutMs = ['status', 'login'].includes(action) ? 30_000 : 300_000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch('api/dscord', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...payload }),
            signal: controller.signal,
          });
          if (!response.ok) throw Object.assign(clientError('requestHttp', { status: response.status }), { httpStatus: response.status });
          const result = await response.json();
          if (!result.ok) throw result.error?.message ? new Error(result.error.message) : clientError('requestFailed');
          if (!result.value || !Array.isArray(result.value.bots)) throw clientError('invalidStatus');
          return result.value;
        } catch (error) {
          if (error.name === 'AbortError') throw clientError('requestTimeout');
          if (error instanceof TypeError) throw clientError('connectionUnavailable');
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      }

      async function readStatus(controller) {
        const attempts = initialStatus ? 3 : 1;
        initialStatus = false;
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            return await request('status', {}, controller);
          } catch (error) {
            if (error.httpStatus !== 404 || attempt + 1 === attempts || controller.signal.aborted) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
            controller.signal.throwIfAborted();
          }
        }
      }

      async function refresh({ clearError = true } = {}) {
        if (disposed || snapshot.busy || readController) return;
        const current = revision;
        const controller = new AbortController();
        readController = controller;
        try {
          const value = await readStatus(controller);
          if (current === revision) {
            const error = !clearError && errorSource === 'action' ? snapshot.error : null;
            if (!error) errorSource = null;
            publish({ value, loading: false, error, errorTranslation: error ? snapshot.errorTranslation : null });
          }
        } catch (error) {
          if (current === revision) {
            errorSource = 'status';
            publish({ loading: false, error: error.message, errorTranslation: error.translation || null });
          }
        } finally {
          if (readController === controller) readController = undefined;
        }
      }

      async function mutate(action, payload = {}) {
        if (disposed || snapshot.busy) return;
        revision += 1;
        readController?.abort();
        readController = undefined;
        const controller = new AbortController();
        actionController = controller;
        errorSource = null;
        publish({ busy: { action, botId: payload.botId }, error: null, errorTranslation: null });
        try {
          if (action === 'reconnect') {
            const value = await request('disconnect', payload, controller);
            publish({ value });
            action = 'connect';
          }
          const value = await request(action, payload, controller);
          publish({ value, error: null, errorTranslation: null });
        } catch (error) {
          errorSource = 'action';
          publish({ error: error.message, errorTranslation: error.translation || null });
        } finally {
          actionController = undefined;
          publish({ busy: null, loading: false });
        }
      }

      function subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) {
          void refresh({ clearError: false });
          pollTimer = setInterval(() => {
            if (document.visibilityState !== 'hidden') void refresh({ clearError: false });
          }, 5000);
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            clearInterval(pollTimer);
            pollTimer = undefined;
          }
        };
      }

      return {
        getSnapshot: () => snapshot,
        subscribe,
        refresh,
        login: (serverUrl, user, password) => mutate('login', { serverUrl, user, password }),
        logout: () => mutate('logout'),
        connect: botId => mutate('connect', { botId }),
        disconnect: botId => mutate('disconnect', { botId }),
        reconnect: botId => mutate('reconnect', { botId }),
        dispose() {
          disposed = true;
          revision += 1;
          clearInterval(pollTimer);
          readController?.abort();
          actionController?.abort();
          listeners.clear();
        },
      };
    }

    function webUrl(serverUrl) {
      try {
        const url = new URL(serverUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        return url.href;
      } catch {
        return null;
      }
    }

    function LoginForm({ connection, state, t }) {
      return h('form', {
        className: 'dc-panel dc-login',
        'aria-label': t('loginTitle'),
        onSubmit(event) {
          event.preventDefault();
          const fields = event.currentTarget.elements;
          const passwordInput = fields.namedItem('password');
          const password = passwordInput.value;
          passwordInput.value = '';
          void connection.login(fields.namedItem('serverUrl').value.trim(), fields.namedItem('user').value.trim(), password);
        },
      },
      h('h2', null, t('loginTitle')),
      h('label', { className: 'dc-field' }, t('serverUrl'), h('input', {
        name: 'serverUrl', type: 'url', required: true, defaultValue: state.value?.serverUrl || '',
        placeholder: 'https://chat.example.com', autoComplete: 'url', disabled: Boolean(state.busy),
      })),
      h('label', { className: 'dc-field' }, t('username'), h('input', {
        name: 'user', type: 'text', required: true, autoComplete: 'username', autoCapitalize: 'none',
        spellCheck: false, disabled: Boolean(state.busy),
      })),
      h('label', { className: 'dc-field' }, t('password'), h('input', {
        name: 'password', type: 'password', required: true, autoComplete: 'off', disabled: Boolean(state.busy),
      })),
      h('button', { type: 'submit', className: 'dc-primary', disabled: Boolean(state.busy) }, t(state.busy?.action === 'login' ? 'loggingIn' : 'login')));
    }

    function BotRow({ bot, connection, state, t }) {
      const busy = state.busy?.botId === bot.id;
      const status = bot.status || 'offline';
      const connected = bot.connected || status === 'online' || status === 'connecting';
      const disabled = Boolean(state.busy);
      const runtimeAvailable = state.value?.runtime?.available !== false;
      const name = bot.name || bot.id;
      return h('li', { className: 'dc-bot' },
        h('div', { className: 'dc-bot-identity' },
          h('span', { className: 'dc-avatar', 'aria-hidden': true }, Array.from(name)[0]),
          h('div', { className: 'dc-bot-copy' },
            h('p', { className: 'dc-bot-name' }, name),
            h('p', { className: 'dc-bot-id' }, bot.localpart || bot.id),
            h('p', { className: 'dc-status', 'data-status': status }, statusKeys[status] ? t(statusKeys[status]) : status),
            bot.lastError && h('p', { className: 'dc-error dc-bot-error' }, bot.lastError))),
        h('div', { className: 'dc-actions' },
          connected
            ? h('button', { type: 'button', disabled, onClick: () => void connection.disconnect(bot.id), 'aria-label': t('disconnectBot', { name }) }, t(busy && state.busy.action === 'disconnect' ? 'disconnecting' : 'disconnect'))
            : h('button', { type: 'button', className: 'dc-primary', disabled: disabled || !runtimeAvailable, onClick: () => void connection.connect(bot.id), 'aria-label': t('connectBot', { name }) }, t(busy ? 'connecting' : 'connect')),
          (connected || status === 'error') && h('button', { type: 'button', disabled: disabled || !runtimeAvailable, onClick: () => void connection.reconnect(bot.id), 'aria-label': t('reconnectBot', { name }) }, t(busy && state.busy.action === 'reconnect' ? 'reconnecting' : 'reconnect'))));
    }

    function ConnectionPage({ connection, t }) {
      const state = React.useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
      const value = state.value;
      const href = webUrl(value?.serverUrl);
      const runtimeError = value?.runtime?.available === false;
      const errorMessage = state.errorTranslation ? t(state.errorTranslation.key, state.errorTranslation.params) : state.error;
      return h('section', { className: 'dscord-connect', 'aria-label': t('pageLabel'), 'aria-busy': state.loading || Boolean(state.busy) },
        h('style', null, styles),
        h('div', { className: 'dc-content' },
          h('header', { className: 'dc-header' },
            h('h1', null, t('title')),
            h('div', { className: 'dc-toolbar' },
              href && h('a', { className: 'dc-link', href, target: '_blank', rel: 'noopener noreferrer' }, t('openWeb')),
              h('button', { type: 'button', disabled: state.loading || Boolean(state.busy), onClick: () => void connection.refresh() }, t('refresh')))),
          errorMessage && h('p', { role: 'alert', className: 'dc-notice dc-error' }, errorMessage),
          value?.lastError && value.lastError !== errorMessage && h('p', { role: 'alert', className: 'dc-notice dc-error' }, value.lastError),
          state.loading && h('p', { role: 'status', className: 'dc-muted' }, t('readStatus')),
          runtimeError && h('p', { role: 'status', className: 'dc-notice dc-error' }, value.runtime.message || t('runtimeUnavailable')),
          !state.loading && !value?.user && h(LoginForm, { key: value?.serverUrl || 'login', connection, state, t }),
          value?.user && h(React.Fragment, null,
            h('section', { className: 'dc-panel dc-account', 'aria-label': t('account') },
              h('div', null,
                h('p', { className: 'dc-account-name' }, value.user.name || value.user.id),
                h('p', { className: 'dc-server' }, value.serverUrl)),
              h('button', { type: 'button', disabled: Boolean(state.busy), onClick: () => void connection.logout() }, t(state.busy?.action === 'logout' ? 'loggingOut' : 'logout'))),
            h('section', { className: 'dc-panel', 'aria-label': t('myBots') },
              h('h2', null, t('myBots')),
              value.bots.length === 0
                ? h('p', { className: 'dc-muted' }, t('emptyBots'))
                : h('ul', { className: 'dc-bots' }, value.bots.map(bot => h(BotRow, { key: bot.id, bot, connection, state, t }))))),
          value?.dataDirectory && h('details', { className: 'dc-directory' },
            h('summary', null, t('configDirectory')),
            h('code', null, value.dataDirectory))));
    }

    function SidebarIcon({ size }) {
      return h(IconPluginPinwheelOutlineRegular, { size });
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(localeNamespace, { zh, en }), 'dscord: dictionaries');
      const t = ctx.locale.bind(localeNamespace);
      const connection = createConnectionModel(t);
      ctx.effect(() => () => connection.dispose(), 'dscord: connection page');
      const inject = () => ({ connection });
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId, locale: localeNamespace, inject }, ConnectionPage));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panelId, label: () => t('title'), locale: localeNamespace, order: 20,
      }, SidebarIcon));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: 'dscord', locale: localeNamespace, inject,
      }, ConnectionPage));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
