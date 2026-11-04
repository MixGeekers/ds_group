import test from 'node:test';
import assert from 'node:assert/strict';
import {
  messages, resolveLocale, translateMessage, getLocale, getLocalePreference,
  setLocalePreference, onLocaleChange, formatFileSize, formatNumber, formatDateTime,
} from '../web/i18n.js';

test('Chinese and English catalogs have matching keys and interpolation fields', () => {
  const chineseKeys = Object.keys(messages['zh-CN']).sort();
  assert.deepEqual(Object.keys(messages.en).sort(), chineseKeys);
  for (const key of chineseKeys) {
    const fields = value => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(fields(messages.en[key]), fields(messages['zh-CN'][key]), key);
  }
});

test('system language resolves supported browser locales and falls back predictably', () => {
  assert.equal(resolveLocale('system', ['fr-FR', 'zh-TW']), 'zh-CN');
  assert.equal(resolveLocale('system', ['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('system', ['fr-FR']), 'en');
  assert.equal(translateMessage('files.uploadProgress', { name: '费用.csv' }, 'en'), 'Upload progress for 费用.csv');
  assert.equal(translateMessage('settings.theme', {}, 'unknown'), 'Theme');
  assert.equal(translateMessage('missing.key', {}, 'en'), 'missing.key');
});

test('locale preference updates subscribers and formatting without mutating user values', () => {
  const previous = getLocalePreference();
  const changes = [];
  const unsubscribe = onLocaleChange(state => changes.push(state));
  try {
    setLocalePreference('en');
    assert.equal(getLocale(), 'en');
    assert.equal(formatFileSize(1536), '1.5 KB');
    assert.equal(formatNumber(1234.5), '1,234.5');
    assert.equal(formatDateTime(Date.UTC(2026, 10, 4), { timeZone: 'UTC', dateStyle: 'medium' }), 'Nov 4, 2026');
    setLocalePreference('zh-CN');
    assert.match(formatDateTime(Date.UTC(2026, 10, 4), { timeZone: 'UTC', dateStyle: 'medium' }), /2026.*11.*4/);
    assert.equal(formatFileSize(0), '0 B');
    assert.deepEqual(changes.map(change => change.locale), ['en', 'zh-CN']);
    assert.throws(() => setLocalePreference('unsupported'), /Unknown language/);
  } finally { unsubscribe(); setLocalePreference(previous); }
});
