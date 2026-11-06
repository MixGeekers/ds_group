window.__ModuleLoader__.load({
  id: 'dscord',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { Button, Input, IconPluginPinwheelOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const panelId = 'dscord';
    const localeNamespace = 'dscord.connection';
    const statusKeys = { offline: 'statusOffline', connecting: 'statusConnecting', online: 'statusOnline', error: 'statusError' };
    const zh = {
      nativeBots: '本机原生 Bot', nativeHelp: '让 Main Bot 创建并配置伙伴，再把已有 Bot 加入服务器。它们仍可在 DS Bot 中正常使用。',
      nativeEmpty: '请在原生 DS Bot 中让 Main Bot 创建伙伴，然后刷新。', attach: '加入服务器', bind: '绑定已有 Bot',
      chooseNative: '选择本机 Bot', nativeBound: '已绑定', nativeLifecycle: '断开只关闭 DSCord 连接。本地 Bot、记忆和后台任务继续由 DSH 运行。',
      serverPolicyDenied: '此服务器未允许所选模型，请选择获准模型或联系管理员。',
      serverOutputLimit: '模型输出上限超过服务器额度，请检查节点与服务器的配置。',
      model: '模型', noModel: '请先在 DSH 中配置模型', saveModel: '保存选择',
      savedModel: '模型选择已保存。', activeModel: '当前运行', nextModel: '已选模型',
      modelPending: '点击重连应用新模型。重连会停止当前任务。',
      modelUnavailable: '此模型在 DSH 中不可用，请到 DSH 模型设置检查。',
      missingCredential: '请在 DSH 的模型设置中配置此模型的凭据。',
      invalidEffort: '请检查 DSH 中的模型思考强度设置。', invalidOutput: '节点输出 tokens 必须为正整数。',
      providerInvalid: '请检查 DSH 中的模型配置。',
      title: 'DSCord', pageLabel: 'DSCord 连接', loginTitle: '登录服务器', serverUrl: '服务器地址',
      username: '账号', password: '密码', login: '登录', loggingIn: '正在登录…',
      disconnect: '断开', disconnecting: '正在断开…', disconnectBot: '断开 {name}',
      connect: '上线', connecting: '正在连接…', connectBot: '上线 {name}',
      reconnect: '重连', reconnecting: '正在重连…', reconnectBot: '重新连接 {name}',
      statusOffline: '已断开', statusConnecting: '正在连接', statusOnline: '已上线', statusError: '连接失败',
      openWeb: '打开网页', refresh: '刷新', readStatus: '正在读取连接状态…',
      runtimeUnavailable: 'Bot 运行环境暂不可用', account: '当前账号',
      logout: '退出登录', loggingOut: '正在退出…', myBots: '我的 Bot',
      emptyBots: '尚未连接 Bot，请从本机团队中选择。', configDirectory: '本机配置目录',
      requestHttp: 'DSH 请求失败（HTTP {status}）', requestFailed: '操作失败，请重试',
      invalidStatus: 'DSH 返回的连接状态不完整', requestTimeout: '请求超时，请刷新连接状态',
      connectionUnavailable: '无法连接 DSH，请检查宿主是否正在运行',
    };
    const en = {
      nativeBots: 'Local native Bots', nativeHelp: 'Ask your Main Bot to create and configure teammates, then add existing Bots to this server. Keep using them in DS Bot.',
      nativeEmpty: 'Ask the Main Bot in DS Bot to create teammates, then refresh.', attach: 'Add to server', bind: 'Bind existing Bot',
      chooseNative: 'Choose a local Bot', nativeBound: 'Linked', nativeLifecycle: 'Disconnecting closes the DSCord connection. DSH keeps the local Bot, memory and background tasks running.',
      serverPolicyDenied: 'This server does not allow the selected model. Choose an allowed model or contact its administrator.',
      serverOutputLimit: 'The model output limit exceeds this server’s budget. Check the node and server configuration.',
      model: 'Model', noModel: 'Configure a model in DSH first', saveModel: 'Save selection',
      savedModel: 'Model selection saved.', activeModel: 'Running model', nextModel: 'Selected model',
      modelPending: 'Reconnect to apply the new model. Reconnecting stops the current task.',
      modelUnavailable: 'This model is unavailable in DSH. Check DSH model settings.',
      missingCredential: 'Configure this model’s credentials in DSH model settings.',
      invalidEffort: 'Check the thinking level in DSH model settings.', invalidOutput: 'Node output tokens must be a positive integer.',
      providerInvalid: 'Check the model configuration in DSH.',
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
  --dc-background: var(--dsw-alias-bg-layer-1, #ffffff);
  --dc-panel: var(--dsw-alias-settings-card-fill, #f7f8fa);
  --dc-field: var(--dsw-alias-bg-layer-1, #ffffff);
  --dc-text: var(--dsw-alias-label-primary, #202124);
  --dc-muted: var(--dsw-alias-label-secondary, #69707a);
  --dc-line: var(--dsw-alias-settings-card-stroke, #e5e7eb);
  --dc-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dc-danger: var(--dsw-alias-state-error-primary, #b42335);
  --dc-success: var(--dsw-alias-state-success-primary, #16794d);
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
  --dc-background: var(--dsw-alias-bg-layer-1, #1c1c1e);
  --dc-panel: var(--dsw-alias-settings-card-fill, #242426);
  --dc-field: var(--dsw-alias-bg-layer-1, #1c1c1e);
  --dc-text: var(--dsw-alias-label-primary, #f2f3f5);
  --dc-muted: var(--dsw-alias-label-secondary, #b5bac1);
  --dc-line: var(--dsw-alias-settings-card-stroke, #39393d);
  --dc-danger: var(--dsw-alias-state-error-primary, #ff8e99);
  --dc-success: var(--dsw-alias-state-success-primary, #65d7a0);
  color-scheme: dark;
}
.dscord-connect *, .dscord-connect *::before, .dscord-connect *::after { box-sizing: border-box; }
.dscord-connect .dc-content { width: min(100%, 880px); margin: 0 auto; padding: 28px; }
.dscord-connect .dc-header, .dscord-connect .dc-toolbar, .dscord-connect .dc-actions { display: flex; align-items: center; gap: 10px; }
.dscord-connect .dc-header { justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; }
.dscord-connect h1 { margin: 0; font-size: 22px; font-weight: 650; }
.dscord-connect h2 { margin: 0 0 16px; font-size: 17px; font-weight: 600; }
.dscord-connect p { margin: 0; }
.dscord-connect .dc-panel { padding: 22px; border: 1px solid var(--dc-line); border-radius: var(--dsw-radius-lg, 12px); background: var(--dc-panel); margin-bottom: 20px; }
.dscord-connect .dc-login { max-width: 460px; margin: 0 auto; }
.dscord-connect .dc-field { display: grid; gap: 7px; margin-bottom: 18px; font-weight: 600; }
.dscord-connect select { width: 100%; min-height: 42px; border: 1px solid var(--dc-line); border-radius: var(--dsw-radius-md, 8px); padding: 10px 12px; background: var(--dc-field); color: var(--dc-text); font: inherit; font-weight: 400; }
.dscord-connect input::placeholder { color: var(--dc-muted); opacity: 1; }
.dscord-connect .dc-link { min-height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 7px 13px; border: 1px solid var(--dc-line); border-radius: 5px; background: var(--dc-panel); color: var(--dc-text); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; white-space: nowrap; }
.dscord-connect .dc-link:hover { background: var(--dc-field); }
.dscord-connect .dc-login .dc-primary { width: 100%; min-height: 42px; }
.dscord-connect :is(select, summary, a):focus-visible { outline: 2px solid var(--dc-accent); outline-offset: 3px; }
.dscord-connect .dc-muted { color: var(--dc-muted); }
.dscord-connect .dc-error { color: var(--dc-danger); overflow-wrap: anywhere; }
.dscord-connect .dc-notice { padding: 12px 16px; border: 1px solid var(--dc-line); border-radius: 6px; margin-bottom: 18px; background: var(--dc-panel); }
.dscord-connect .dc-account { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dscord-connect .dc-account > div { min-width: 0; flex: 1; }
.dscord-connect .dc-account > button { flex-shrink: 0; }
.dscord-connect .dc-account-name { font-weight: 600; margin-bottom: 4px; overflow-wrap: anywhere; }
.dscord-connect .dc-server, .dscord-connect .dc-directory { overflow-wrap: anywhere; color: var(--dc-muted); }
.dscord-connect .dc-bots { list-style: none; margin: 0; padding: 0; }
.dscord-connect .dc-bot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 18px; padding: 17px 0; border-top: 1px solid var(--dc-line); }
.dscord-connect .dc-bot:first-child { border-top: 0; padding-top: 0; }
.dscord-connect .dc-bot:last-child { padding-bottom: 0; }
.dscord-connect .dc-bot-identity { display: flex; gap: 12px; align-items: center; min-width: 0; }
.dscord-connect .dc-avatar { display: flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 13px; background: var(--dc-field); color: var(--dc-accent); font-size: 18px; font-weight: 600; flex: 0 0 auto; }
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
.dscord-connect .dc-model-settings { flex-basis: 100%; width: 100%; }
.dscord-connect .dc-model-form { display: flex; align-items: flex-end; gap: 12px; }
.dscord-connect .dc-model-form .dc-field { flex: 1; margin: 0; min-width: 0; }
.dscord-connect .dc-model-form select { max-width: 100%; text-overflow: ellipsis; }
.dscord-connect .dc-model-form button { min-height: 42px; }
.dscord-connect .dc-model-info { margin-top: 7px; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .dscord-connect .dc-model-form { flex-wrap: wrap; }
  .dscord-connect .dc-model-form .dc-field { flex-basis: 100%; }
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
          if (!result.ok) {
            const modelErrors = { MODEL_POLICY_DENIED: 'serverPolicyDenied', MODEL_OUTPUT_LIMIT: 'serverOutputLimit', MISSING_CREDENTIAL: 'missingCredential', INVALID_REASONING_EFFORT: 'invalidEffort',
              INVALID_OUTPUT_LIMIT: 'invalidOutput', INVALID_MODEL: 'modelUnavailable', MODEL_UNAVAILABLE: 'modelUnavailable',
              MODEL_PROVIDER_UNAVAILABLE: 'modelUnavailable', MODEL_PROFILE_INVALID: 'providerInvalid' };
            const key = modelErrors[result.error?.code];
            throw key ? clientError(key) : result.error?.message ? new Error(result.error.message) : clientError('requestFailed');
          }
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
        publish({ busy: { action, botId: payload.botId }, notice: null, error: null, errorTranslation: null });
        try {
          if (action === 'reconnect') {
            const value = await request('disconnect', payload, controller);
            publish({ value });
            action = 'connect';
          }
          const value = await request(action, payload, controller);
          publish({ value, error: null, errorTranslation: null, notice: action === 'save-model' ? 'savedModel' : null });
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
        saveModel: (botId, selection) => mutate('save-model', { botId, selection }),
        attach: (nativeBotId, botId) => mutate('attach', { nativeBotId, ...(botId ? { botId } : {}) }),
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
      h('label', { className: 'dc-field' }, t('serverUrl'), h(Input, {
        name: 'serverUrl', type: 'url', required: true, defaultValue: state.value?.serverUrl || '',
        placeholder: 'https://chat.example.com', autoComplete: 'url', disabled: Boolean(state.busy),
      })),
      h('label', { className: 'dc-field' }, t('username'), h(Input, {
        name: 'user', type: 'text', required: true, autoComplete: 'username', autoCapitalize: 'none',
        spellCheck: false, disabled: Boolean(state.busy),
      })),
      h('label', { className: 'dc-field' }, t('password'), h(Input, {
        name: 'password', type: 'password', required: true, autoComplete: 'off', disabled: Boolean(state.busy),
      })),
      h(Button, { variant: 'primary', type: 'submit', className: 'dc-primary', disabled: Boolean(state.busy) }, t(state.busy?.action === 'login' ? 'loggingIn' : 'login')));
    }

    function ModelForm({ bot, connection, state, t }) {
      const catalog = state.value.models;
      const models = (catalog?.providers || []).flatMap(provider => provider.models);
      const saved = bot.modelSelection || catalog?.defaultSelection;
      const [reference, setReference] = React.useState(saved?.model || '');
      const selected = models.find(model => model.model === reference);
      const pending = !state.value?.nativeMode && bot.activeModel && bot.modelSelection && bot.activeModel.model !== bot.modelSelection.model;
      return h('div', { className: 'dc-model-settings' },
        h('form', { className: 'dc-model-form', onSubmit(event) {
          event.preventDefault();
          void connection.saveModel(bot.id, { model: reference });
        } },
          h('label', { className: 'dc-field' }, t('model'), h('select', { name: 'model', 'aria-label': t('model'), required: true, value: reference,
            disabled: Boolean(state.busy), onChange: event => setReference(event.target.value) },
            !reference && h('option', { value: '' }, t('noModel')),
            reference && !selected && h('option', { value: reference, disabled: true }, `${reference} · ${t('modelUnavailable')}`),
            ...(catalog?.providers || []).filter(provider => provider.models.length).map(provider => h('optgroup', { key: provider.id, label: provider.name },
              ...provider.models.map(model => h('option', { key: model.model, value: model.model }, model.name)))))),
          h(Button, { variant: 'primary', className: 'dc-primary', type: 'submit', disabled: Boolean(state.busy) || !selected || reference === bot.modelSelection?.model }, t('saveModel'))),
        pending && h('p', { className: 'dc-model-info', role: 'status' }, t('modelPending')));
    }

    function BotRow({ bot, connection, state, t }) {
      const [nativeId, setNativeId] = React.useState('');
      const needsBinding = state.value?.nativeMode && !bot.nativeBotId;
      const busy = state.busy?.botId === bot.id;
      const status = bot.status || 'offline';
      const connected = bot.connected || status === 'online' || status === 'connecting';
      const disabled = Boolean(state.busy);
      const runtimeAvailable = state.value?.runtime?.available !== false;
      const name = bot.name || bot.id;
      const catalog = state.value?.models;
      const desiredModel = bot.modelSelection?.model || catalog?.defaultSelection?.model;
      const modelAvailable = catalog?.available !== true || catalog.providers.some(provider => provider.models.some(model => model.model === desiredModel));
      return h('li', { className: 'dc-bot' },
        h('div', { className: 'dc-bot-identity' },
          h('span', { className: 'dc-avatar', 'aria-hidden': true }, Array.from(name)[0]),
          h('div', { className: 'dc-bot-copy' },
            h('p', { className: 'dc-bot-name' }, name),
            h('p', { className: 'dc-bot-id' }, bot.localpart || bot.id),
            h('p', { className: 'dc-status', 'data-status': status }, statusKeys[status] ? t(statusKeys[status]) : status),
            bot.activeModel && h('p', { className: 'dc-muted dc-model-info' }, `${t('activeModel')} · ${bot.activeModel.model}`),
            (bot.modelSelection || state.value?.models?.defaultSelection) && h('p', { className: 'dc-muted dc-model-info' }, `${t('nextModel')} · ${(bot.modelSelection || state.value.models.defaultSelection).model}`),
            !modelAvailable && h('p', { className: 'dc-error dc-bot-error' }, t('modelUnavailable')),
            bot.lastError && h('p', { className: 'dc-error dc-bot-error' }, bot.lastError))),
        needsBinding ? h('form', { className: 'dc-model-form', onSubmit(event) {
          event.preventDefault(); void connection.attach(nativeId, bot.id);
        } }, h('label', { className: 'dc-field' }, t('bind'), h('select', { value: nativeId, onChange: event => setNativeId(event.target.value), disabled },
          h('option', { value: '' }, t('chooseNative')),
          ...(state.value.nativeBots || []).filter(local => !state.value.bots.some(bot => bot.nativeBotId === local.id))
            .map(local => h('option', { key: local.id, value: local.id }, local.name)))),
          h(Button, { type: 'submit', variant: 'primary', disabled: disabled || !nativeId }, t('bind')))
        : h('div', { className: 'dc-actions' },
          connected
            ? h(Button, { variant: 'outline', type: 'button', disabled, onClick: () => void connection.disconnect(bot.id), 'aria-label': t('disconnectBot', { name }) }, t(busy && state.busy.action === 'disconnect' ? 'disconnecting' : 'disconnect'))
            : h(Button, { variant: 'primary', type: 'button', className: 'dc-primary', disabled: disabled || !runtimeAvailable || !modelAvailable, onClick: () => void connection.connect(bot.id), 'aria-label': t('connectBot', { name }) }, t(busy ? 'connecting' : 'connect')),
          (connected || status === 'error') && h(Button, { variant: 'outline', type: 'button', disabled: disabled || !runtimeAvailable || !modelAvailable, onClick: () => void connection.reconnect(bot.id), 'aria-label': t('reconnectBot', { name }) }, t(busy && state.busy.action === 'reconnect' ? 'reconnecting' : 'reconnect'))),
        !needsBinding && state.value?.models?.available && h(ModelForm, { key: JSON.stringify(bot.modelSelection), bot, connection, state, t }));
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
              h(Button, { variant: 'outline', type: 'button', disabled: state.loading || Boolean(state.busy), onClick: () => void connection.refresh() }, t('refresh')))),
          state.notice && h('p', { role: 'status', className: 'dc-notice' }, t(state.notice)),
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
              h(Button, { variant: 'outline', type: 'button', disabled: Boolean(state.busy), onClick: () => void connection.logout() }, t(state.busy?.action === 'logout' ? 'loggingOut' : 'logout'))),
            value.nativeMode && h('section', { className: 'dc-panel', 'aria-label': t('nativeBots') },
              h('h2', null, t('nativeBots')), h('p', { className: 'dc-muted' }, t('nativeHelp')),
              h('ul', { className: 'dc-bots' }, (value.nativeBots || []).map(bot => {
                const bound = value.bots.some(link => link.nativeBotId === bot.id);
                return h('li', { key: bot.id, className: 'dc-bot' },
                  h('div', null, h('strong', null, bot.name), bot.main && h('span', null, ' · Main Bot'),
                    h('p', { className: 'dc-muted' }, `${bot.role || ''} · ${bot.model || t('noModel')}`)),
                  h(Button, { variant: 'outline', disabled: Boolean(state.busy) || bound || !bot.model,
                    onClick: () => void connection.attach(bot.id) }, t(bound ? 'nativeBound' : 'attach')));
              })),
              !value.nativeBots?.length && h('p', { className: 'dc-muted' }, t('nativeEmpty')),
              h('p', { className: 'dc-muted' }, t('nativeLifecycle'))),
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
      // The packaged client supplies the unchanged native DS-Bot factory. An
      // independently installed DS-Bot keeps ownership of its own normal UI.
      if (typeof dscordNativeFactory === 'function') {
        let mounted = false;
        const unsubscribe = connection.subscribe(() => {
          if (!mounted && connection.getSnapshot().value?.nativeBundled) {
            mounted = true;
            ctx.plugin(dscordNativeFactory(require));
          }
        });
        ctx.effect(() => unsubscribe, 'dscord: native Bot interface');
      }
      ctx.effect(() => () => connection.dispose(), 'dscord: connection page');
      const inject = () => ({ connection });
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId, locale: localeNamespace, inject }, ConnectionPage));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panelId, label: () => t('title'), locale: localeNamespace, order: 20,
      }, SidebarIcon));
      // DS-Bot owns its sidebar in Bot mode. Use its registered return action
      // to switch modes, keeping both the native team UI and DSH panels intact.
      function NativeShortcutButton({ face }) {
        const mode = React.useSyncExternalStore(face.hooks.surface.subscribe, () => face.hooks.surface.getSnapshot().mode);
        if (mode !== 'bot') return null;
        return createPortal(h('div', { style: { position: 'fixed', left: 56, bottom: 16, zIndex: 50, pointerEvents: 'auto' } },
          h(Button, { variant: 'outline', type: 'button', onClick: () => {
            face.actions.setSurface('agent'); ctx.layout.selectPanel(panelId);
          } }, t('title'))), document.body);
      }
      function NativeShortcut() {
        const entry = React.useSyncExternalStore(
          listener => ctx.slots.subscribe('sidebar.footer.action', listener),
          () => ctx.slots.entries('sidebar.footer.action').find(item => item.options?.id === 'bot-return'));
        const face = entry?.inject?.();
        return face?.actions?.setSurface && face?.hooks?.surface ? h(NativeShortcutButton, { face }) : null;
      }
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: panelId, order: 65, locale: localeNamespace,
      }, NativeShortcut));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: 'dscord', locale: localeNamespace, inject,
      }, ConnectionPage));
    }

    return { inject: ['slots', 'locale', 'layout'], apply };
  },
});
