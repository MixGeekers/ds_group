import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

// This host only supplies native-client contracts. It never imports production
// Host code, Lab code, credentials, models, or a live DSH profile.
const root = createRoot(document.getElementById('root'));
const navRoot = createRoot(document.getElementById('test-nav'));
const dictionaries = new Map(), listeners = new Set(), slots = new Map(), disposers = [];
let localeSnapshot = { active: 'zh' }, loaded = false;
function renderNav() {
  navRoot.render(React.createElement(React.Fragment, null, ...[...slots.values()].filter(item => item.options.name === 'sidebar.panellist').map(({ options, component }) => React.createElement('button', { type: 'button', key: options.id }, React.createElement(component), typeof options.label === 'function' ? options.label() : options.label))));
}
function unload() {
  if (!loaded) return;
  loaded = false;
  for (const dispose of disposers.splice(0).reverse()) dispose?.();
  root.render(null);
  navRoot.render(null);
}
const ctx = {
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
  locale: {
    register(namespace, language, values) { const key = `${namespace}:${language}`; dictionaries.set(key, values); return () => dictionaries.delete(key); },
    bind: namespace => (key, values = {}) => {
      let result = dictionaries.get(`${namespace}:${localeSnapshot.active}`)?.[key];
      if (typeof result !== 'string') throw new Error(`Missing translation: ${localeSnapshot.active}:${key}`);
      for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value));
      return result;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => localeSnapshot,
    getLocale: () => localeSnapshot,
  },
  slots: {
    inject: (_slot, fn) => fn(),
    register(options, component) {
      const key = `${options.name}:${options.id || options.key}`;
      if (slots.has(key)) throw new Error(`Duplicate slot: ${key}`);
      slots.set(key, { options, component });
      if (options.name === 'main') root.render(React.createElement(component));
      else renderNav();
      return () => { slots.delete(key); if (options.name === 'main') root.render(null); else renderNav(); };
    },
  },
};
document.getElementById('locale').onclick = () => {
  localeSnapshot = { active: localeSnapshot.active === 'zh' ? 'en' : 'zh' };
  document.documentElement.lang = localeSnapshot.active;
  for (const fn of listeners) fn();
  renderNav();
};
document.getElementById('theme').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; };
document.getElementById('unmount').onclick = unload;
window.__SHIYU_UI_HARNESS__ = {
  unload,
  inspect: () => ({ loaded, registrations: slots.size, localeListeners: listeners.size, dictionaries: dictionaries.size }),
  setVisibility(visible) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
    document.dispatchEvent(new Event('visibilitychange'));
  },
};
window.__ModuleLoader__ = {
  load(module) {
    if (module.id !== '@shiyu/runtime') throw new Error(`Unexpected module: ${module.id}`);
    loaded = true;
    module.factory(name => { if (name !== 'react') throw new Error(`Unexpected dependency: ${name}`); return React; }).apply(ctx);
  },
};
await import('../../client/index.js');
