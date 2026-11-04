import { componentMessages } from './locales/components.js';

export const LANGUAGE_STORAGE_KEY = 'ds-group.language';
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en']);
const preferences = new Set(['system', ...SUPPORTED_LOCALES]);
const baseMessages = {
  'zh-CN': {
    'common.unknownTime': '时间未记录',
    'settings.appearanceLanguage': '外观与语言',
    'settings.theme': '主题',
    'settings.language': '界面语言',
    'settings.system': '跟随系统',
    'settings.dark': '深色',
    'settings.light': '明亮',
  },
  en: {
    'common.unknownTime': 'Time unavailable',
    'settings.appearanceLanguage': 'Appearance and language',
    'settings.theme': 'Theme',
    'settings.language': 'Interface language',
    'settings.system': 'Use system setting',
    'settings.dark': 'Dark',
    'settings.light': 'Light',
  },
};

export const messages = Object.freeze(Object.fromEntries(SUPPORTED_LOCALES.map(locale => [
  locale, Object.freeze({ ...baseMessages[locale], ...componentMessages[locale] }),
])));

export function resolveLocale(preference, browserLanguages = []) {
  if (SUPPORTED_LOCALES.includes(preference)) return preference;
  for (const language of browserLanguages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}

function browserLanguages() {
  if (typeof window === 'undefined') return ['zh-CN'];
  return navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
}

let preference = 'system';
try {
  const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
  if (preferences.has(stored)) preference = stored;
} catch { /* Locale selection remains available when browser storage is disabled. */ }
let locale = resolveLocale(preference, browserLanguages());
const listeners = new Set();

export function getLocale() { return locale; }
export function getLocalePreference() { return preference; }

export function translateMessage(key, parameters = {}, language = locale) {
  const template = messages[language]?.[key] ?? messages.en[key] ?? messages['zh-CN'][key] ?? key;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name) => {
    return Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder;
  });
}

export const t = translateMessage;

export function translateDom(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const attributes = [
    ['data-i18n', null], ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'],
  ];
  for (const [source, target] of attributes) {
    const elements = [...root.querySelectorAll(`[${source}]`)];
    if (root.matches?.(`[${source}]`)) elements.unshift(root);
    for (const element of elements) {
      let parameters = {};
      try { parameters = JSON.parse(element.dataset.i18nParams || '{}'); } catch {}
      const text = t(element.getAttribute(source), parameters);
      if (target) element.setAttribute(target, text);
      else element.textContent = text;
    }
  }
}

function applyLocale() {
  locale = resolveLocale(preference, browserLanguages());
  if (globalThis.document?.documentElement) document.documentElement.lang = locale;
  translateDom();
  const state = { locale, preference };
  for (const listener of listeners) listener(state);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ds-group:locale', { detail: state }));
}

export function setLocalePreference(value) {
  if (!preferences.has(value)) throw new TypeError('Unknown language preference');
  preference = value;
  try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, value); } catch {}
  applyLocale();
}

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatNumber(value, options) {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatFileSize(value) {
  const bytes = Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
  return `${formatNumber(amount, { maximumFractionDigits: 1 })} ${units[index]}`;
}

export function formatDateTime(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, options).format(date) : t('common.unknownTime');
}

export function formatTime(value) {
  return formatDateTime(value, { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(value) {
  return formatDateTime(value, { year: 'numeric', month: 'long', day: 'numeric' });
}

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => { if (preference === 'system') applyLocale(); });
  window.addEventListener('storage', event => {
    if (event.key !== LANGUAGE_STORAGE_KEY) return;
    preference = preferences.has(event.newValue) ? event.newValue : 'system';
    applyLocale();
  });
}
applyLocale();
