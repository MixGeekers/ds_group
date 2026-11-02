import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { modelCatalog } from './model-catalog.js';

const root = createRoot(document.getElementById('root'));
const dictionaries = new Map(), listeners = new Set();
let snapshot = { active: 'zh' };
const ctx = {
  effect: fn => fn(),
  remote: { session: { async modelCatalog() { return new URLSearchParams(location.search).has('catalog-fail') ? { ok: false, error: { message: 'Synthetic catalog unavailable' } } : { ok: true, value: modelCatalog }; } } },
  locale: {
    register(namespace, language, values) { dictionaries.set(`${namespace}:${language}`, values); return () => dictionaries.delete(`${namespace}:${language}`); },
    bind: namespace => (key, values = {}) => {
      let result = dictionaries.get(`${namespace}:${snapshot.active}`)?.[key];
      if (result === undefined) throw new Error(`Missing translation: ${snapshot.active}:${key}`);
      for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value));
      return result;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => snapshot,
  },
  slots: {
    inject: (_slot, fn) => fn(),
    register(options, component) { if (options.name === 'main') root.render(React.createElement(component)); return () => {}; },
  },
};
document.getElementById('locale').onclick = () => { snapshot = { active: snapshot.active === 'zh' ? 'en' : 'zh' }; for (const fn of listeners) fn(); };
document.getElementById('theme').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; };
window.__ModuleLoader__ = { load(module) { module.factory(name => { if (name !== 'react') throw new Error(`Unexpected dependency: ${name}`); return React; }).apply(ctx); } };
await import('../../client.js');
