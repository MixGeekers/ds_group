import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../dsh-connect/client.js', import.meta.url), 'utf8');
const loggedOut = {
  serverUrl: '', user: null, bots: [], runtime: { available: true, message: null },
};
const loggedIn = {
  serverUrl: 'https://chat.example.test', user: { id: '@alice:test', name: 'Alice' },
  bots: [{ id: 'finance', name: '财务', localpart: 'finance', status: 'offline', lastError: null }],
  runtime: { available: true, message: null }, dataDirectory: '/synthetic/profile/dscord',
};

function harness(oracle = () => loggedOut, language = 'zh') {
  const requests = [];
  const entries = [];
  const disposers = [];
  const intervals = new Set();
  const timeouts = [];
  const dictionaries = new Map();
  let localeSnapshot = { active: language, revision: 0 };
  const localeListeners = new Set();
  const locale = {
    register(namespace, translations) {
      dictionaries.set(namespace, translations);
      return () => dictionaries.delete(namespace);
    },
    bind(namespace) {
      return (key, params = {}) => {
        const translations = dictionaries.get(namespace);
        const template = translations?.[localeSnapshot.active]?.[key] ?? translations?.en[key] ?? key;
        return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
      };
    },
    getSnapshot: () => localeSnapshot,
    subscribe(listener) { localeListeners.add(listener); return () => localeListeners.delete(listener); },
    setLocale(active) {
      localeSnapshot = { active, revision: localeSnapshot.revision + 1 };
      for (const listener of localeListeners) listener();
    },
  };
  let descriptor;
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { descriptor = value; } } },
    document: { visibilityState: 'visible' },
    URL, AbortController, clearTimeout,
    setTimeout(callback, milliseconds) { timeouts.push(milliseconds); return setTimeout(callback, milliseconds); },
    setInterval(callback) { intervals.add(callback); return callback; },
    clearInterval(callback) { intervals.delete(callback); },
    async fetch(url, options) {
      const payload = JSON.parse(options.body);
      requests.push({ url, ...options, payload });
      const result = await oracle(payload, options.signal);
      if (result instanceof Response) return result;
      return { ok: true, json: async () => ({ ok: true, value: result }) };
    },
  });
  const plugin = descriptor.factory(name => {
    if (name === 'react') return react;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconPluginPinwheelOutlineRegular: () => null };
    throw new Error(`Unexpected dependency ${name}`);
  });
  plugin.apply({
    locale,
    effect(setup) { disposers.push(setup()); },
    slots: {
      inject(_name, register) { return register(); },
      register(options, component) {
        const originalInject = options.inject;
        entries.push({
          options: { ...options, inject: () => ({ ...originalInject?.(), t: locale.bind(options.locale) }) },
          component,
        });
        return () => {};
      },
    },
  });
  const main = entries.find(entry => entry.options.name === 'main');
  return {
    descriptor, plugin, requests, entries, intervals, timeouts, main, locale, dictionaries,
    connection: main.options.inject().connection,
    dispose: () => disposers.forEach(dispose => dispose()),
  };
}

function render(element) {
  if (!element || typeof element !== 'object') return element;
  if (typeof element.type === 'function') return render(element.type(element.props));
  return { ...element, children: element.children.map(render) };
}

function find(element, predicate) {
  if (!element || typeof element !== 'object') return undefined;
  if (predicate(element)) return element;
  return element.children.map(child => find(child, predicate)).find(Boolean);
}

test('DSH client registers the package page, sidebar icon and installed-package configuration', t => {
  const fixture = harness();
  t.after(fixture.dispose);
  assert.equal(fixture.descriptor.id, 'dscord');
  assert.deepEqual(Array.from(fixture.plugin.inject), ['slots', 'locale']);
  assert.deepEqual(fixture.entries.map(entry => [entry.options.name, entry.options.key || entry.options.id]), [
    ['main', 'dscord'], ['sidebar.panellist', 'dscord'], ['plugins.bundle.config', 'dscord'],
  ]);
  assert.equal(fixture.entries[2].options.inject().connection, fixture.connection);
  assert.ok(fixture.entries.every(entry => entry.options.locale === 'dscord.connection'));
  assert.equal(fixture.requests.length, 0);
});

test('the DSH locale namespace covers both languages and switches page labels without recreating state', async t => {
  const fixture = harness(() => loggedOut, 'en');
  t.after(fixture.dispose);
  await fixture.connection.refresh();
  const dictionaries = fixture.dictionaries.get('dscord.connection');
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort());
  const connection = fixture.connection;
  for (const [language, labels] of [
    ['en', { page: 'DSCord connection', login: 'Sign in to server', submit: 'Sign in', password: 'Password' }],
    ['zh', { page: 'DSCord 连接', login: '登录服务器', submit: '登录', password: '密码' }],
  ]) {
    fixture.locale.setLocale(language);
    for (const entry of fixture.entries.filter(item => item.options.name !== 'sidebar.panellist')) {
      const tree = render(entry.component(entry.options.inject()));
      assert.equal(tree.props['aria-label'], labels.page);
      assert.ok(find(tree, element => element.type === 'form' && element.props['aria-label'] === labels.login));
      assert.ok(find(tree, element => element.type === 'button' && element.props.type === 'submit' && element.children.includes(labels.submit)));
      assert.ok(find(tree, element => element.type === 'label' && element.children.includes(labels.password)));
    }
    assert.equal(fixture.entries[1].options.label(), 'DSCord');
    assert.equal(fixture.main.options.inject().connection, connection);
  }
  assert.equal(fixture.requests.length, 1);
});

test('Bot actions, status and account controls follow the host locale', async t => {
  const fixture = harness(() => ({ ...loggedIn, bots: [{ ...loggedIn.bots[0], name: 'Finance', status: 'online' }] }), 'en');
  t.after(fixture.dispose);
  await fixture.connection.refresh();
  for (const [language, labels] of [
    ['en', { bots: 'My Bots', status: 'Online', disconnect: 'Disconnect Finance', reconnect: 'Reconnect Finance', logout: 'Sign out', web: 'Open website' }],
    ['zh', { bots: '我的 Bot', status: '已上线', disconnect: '断开 Finance', reconnect: '重新连接 Finance', logout: '退出登录', web: '打开网页' }],
  ]) {
    fixture.locale.setLocale(language);
    const tree = render(fixture.main.component(fixture.main.options.inject()));
    assert.ok(find(tree, element => element.props['aria-label'] === labels.bots));
    assert.ok(find(tree, element => element.props['data-status'] === 'online' && element.children.includes(labels.status)));
    assert.ok(find(tree, element => element.props['aria-label'] === labels.disconnect));
    assert.ok(find(tree, element => element.props['aria-label'] === labels.reconnect));
    assert.ok(find(tree, element => element.type === 'button' && element.children.includes(labels.logout)));
    assert.ok(find(tree, element => element.type === 'a' && element.children.includes(labels.web)));
  }
});

test('a displayed client error changes language with DSH without repeating the failed request', async t => {
  const fixture = harness(() => ({}), 'en');
  t.after(fixture.dispose);
  await fixture.connection.refresh();
  for (const [language, text] of [['en', 'DSH returned incomplete connection status'], ['zh', 'DSH 返回的连接状态不完整']]) {
    fixture.locale.setLocale(language);
    const tree = render(fixture.main.component(fixture.main.options.inject()));
    assert.ok(find(tree, element => element.props.role === 'alert' && element.children.includes(text)));
  }
  assert.equal(fixture.requests.length, 1);
});

test('only the first status read retries a not-yet-registered route, with three attempts at most', async t => {
  let attempts = 0;
  const starting = harness(() => ++attempts < 3 ? new Response(null, { status: 404 }) : loggedOut);
  t.after(starting.dispose);
  await starting.connection.refresh();
  assert.equal(attempts, 3);
  assert.equal(starting.connection.getSnapshot().error, null);
  assert.equal(starting.connection.getSnapshot().value.user, null);

  const unavailable = harness(() => new Response(null, { status: 404 }));
  t.after(unavailable.dispose);
  await unavailable.connection.refresh();
  assert.equal(unavailable.requests.length, 3);
  assert.match(unavailable.connection.getSnapshot().error, /HTTP 404/);
  await unavailable.connection.refresh();
  assert.equal(unavailable.requests.length, 4);
  await unavailable.connection.login('https://chat.example.test', 'alice', 'synthetic-password');
  assert.equal(unavailable.requests.length, 5);
  assert.equal(unavailable.requests[4].payload.action, 'login');
  assert.match(unavailable.connection.getSnapshot().error, /HTTP 404/);
});

test('client sends explicit authenticated actions and reconnects in order', async t => {
  const fixture = harness(payload => payload.action === 'logout' ? loggedOut : loggedIn);
  t.after(fixture.dispose);
  await fixture.connection.login('https://chat.example.test', 'alice', 'synthetic-password');
  assert.equal(fixture.requests[0].url, 'api/dscord');
  assert.equal(fixture.requests[0].credentials, 'same-origin');
  assert.deepEqual(fixture.requests[0].payload, {
    action: 'login', serverUrl: 'https://chat.example.test', user: 'alice', password: 'synthetic-password',
  });
  assert.equal(JSON.stringify(fixture.connection.getSnapshot()).includes('synthetic-password'), false);
  await fixture.connection.connect('finance');
  await fixture.connection.disconnect('finance');
  await fixture.connection.reconnect('finance');
  await fixture.connection.logout();
  assert.deepEqual(fixture.requests.map(request => request.payload.action), ['login', 'connect', 'disconnect', 'disconnect', 'connect', 'logout']);
  assert.deepEqual(fixture.timeouts, [30_000, 300_000, 300_000, 300_000, 300_000, 300_000]);
  assert.equal(fixture.connection.getSnapshot().value.user, null);
});

test('an older status response cannot replace a completed login', async t => {
  let resolveStatus;
  const fixture = harness(payload => payload.action === 'status'
    ? new Promise(resolve => { resolveStatus = resolve; }) : loggedIn);
  t.after(fixture.dispose);
  const staleRead = fixture.connection.refresh();
  await fixture.connection.login('https://chat.example.test', 'alice', 'synthetic-password');
  resolveStatus(loggedOut);
  await staleRead;
  assert.equal(fixture.connection.getSnapshot().value.user.id, '@alice:test');
  assert.equal(fixture.connection.getSnapshot().error, null);
});

test('a failed reconnect preserves the successful disconnect result', async t => {
  const fixture = harness(payload => {
    if (payload.action === 'connect') throw new Error('模拟连接失败');
    return loggedIn;
  });
  t.after(fixture.dispose);
  await fixture.connection.reconnect('finance');
  assert.deepEqual(fixture.requests.map(request => request.payload.action), ['disconnect', 'connect']);
  assert.equal(fixture.connection.getSnapshot().value.bots[0].status, 'offline');
  assert.equal(fixture.connection.getSnapshot().error, '模拟连接失败');
  assert.equal(fixture.connection.getSnapshot().busy, null);
});

test('background status refresh preserves an action error until an explicit refresh', async t => {
  const fixture = harness(payload => {
    if (payload.action === 'login') throw new Error('账号或密码错误');
    return loggedOut;
  });
  t.after(fixture.dispose);
  await fixture.connection.login('https://chat.example.test', 'alice', 'synthetic-password');
  await fixture.connection.refresh({ clearError: false });
  assert.equal(fixture.connection.getSnapshot().error, '账号或密码错误');
  await fixture.connection.refresh();
  assert.equal(fixture.connection.getSnapshot().error, null);
});

test('the login form clears its password before dispatching the login request', async t => {
  const fixture = harness();
  t.after(fixture.dispose);
  await fixture.connection.refresh();
  const tree = render(fixture.main.component(fixture.main.options.inject()));
  const form = find(tree, element => element.type === 'form');
  const inputs = {
    serverUrl: { value: ' https://chat.example.test ' },
    user: { value: ' alice ' }, password: { value: 'synthetic-password' },
  };
  let sent;
  fixture.connection.login = (...args) => {
    assert.equal(inputs.password.value, '');
    sent = args;
  };
  form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: name => inputs[name] } } });
  assert.deepEqual(sent, ['https://chat.example.test', 'alice', 'synthetic-password']);
  assert.equal(find(tree, element => element.type === 'input' && element.props.name === 'password').props.autoComplete, 'off');
});

test('page exposes only safe server links and disables unavailable bot execution', async t => {
  const fixture = harness(() => ({ ...loggedIn, serverUrl: 'javascript:alert(1)', lastError: '登录已失效', runtime: { available: false, message: 'DS-Bot 未就绪' } }));
  t.after(fixture.dispose);
  await fixture.connection.refresh();
  const tree = render(fixture.main.component(fixture.main.options.inject()));
  assert.equal(find(tree, element => element.type === 'a'), undefined);
  assert.equal(find(tree, element => element.props['aria-label'] === '上线 财务').props.disabled, true);
  assert.ok(find(tree, element => element.props.role === 'alert' && element.children.includes('登录已失效')));
  assert.ok(find(tree, element => element.type === 'code' && element.children.includes('/synthetic/profile/dscord')));
});

test('shared page subscriptions own one polling timer and plugin disposal stops pending work', async () => {
  let abortSignal;
  const fixture = harness((_payload, signal) => {
    abortSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const unsubscribe = fixture.connection.subscribe(() => {});
  const unsubscribeOther = fixture.connection.subscribe(() => {});
  assert.equal(fixture.intervals.size, 1);
  assert.equal(fixture.requests.length, 1);
  unsubscribe();
  assert.equal(fixture.intervals.size, 1);
  unsubscribeOther();
  assert.equal(fixture.intervals.size, 0);
  fixture.dispose();
  assert.equal(abortSignal.aborted, true);
  await fixture.connection.refresh();
  assert.equal(fixture.requests.length, 1);
});
