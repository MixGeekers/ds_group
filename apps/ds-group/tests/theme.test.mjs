import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/theme.js', import.meta.url), 'utf8');

function loadTheme(values = {}, storageDisabled = false) {
  const stored = new Map(Object.entries(values));
  const media = new EventTarget();
  media.matches = false;
  const window = new EventTarget();
  window.matchMedia = () => media;
  const meta = { content: '' };
  const document = {
    documentElement: { dataset: {} },
    querySelector: () => meta,
  };
  const localStorage = {
    getItem(key) {
      if (storageDisabled) throw new Error('Storage disabled');
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      if (storageDisabled) throw new Error('Storage disabled');
      stored.set(key, value);
    },
  };
  vm.runInNewContext(source, { window, document, localStorage, CustomEvent });
  return { window, media, meta, stored, root: document.documentElement, theme: window.DSGroupTheme };
}

test('existing theme preferences load with the default accent and saved colors restore', () => {
  const legacy = loadTheme({ 'ds-group.theme': 'dark' });
  assert.equal(legacy.theme.getPreference(), 'dark');
  assert.equal(legacy.theme.getColor(), 'indigo');
  assert.equal(legacy.root.dataset.theme, 'dark');
  const restored = loadTheme({ 'ds-group.theme': 'light', 'ds-group.theme-color': 'teal' });
  assert.equal(restored.root.dataset.accent, 'teal');
  assert.equal(restored.meta.content, '#ffffff');
  const invalid = loadTheme({ 'ds-group.theme': 'invalid', 'ds-group.theme-color': 'invalid' });
  assert.equal(invalid.theme.getPreference(), 'system');
  assert.equal(invalid.theme.getColor(), 'indigo');
});

test('color updates persist and emit the current appearance without changing system preference', () => {
  const fixture = loadTheme();
  const changes = [];
  fixture.window.addEventListener('ds-group:theme', event => changes.push(event.detail));
  fixture.theme.setColor('rose');
  assert.equal(fixture.stored.get('ds-group.theme-color'), 'rose');
  assert.equal(fixture.theme.getPreference(), 'system');
  fixture.media.matches = true;
  fixture.media.dispatchEvent(new Event('change'));
  assert.equal(fixture.root.dataset.theme, 'dark');
  assert.equal(fixture.root.dataset.accent, 'rose');
  assert.deepEqual(changes.map(change => [change.theme, change.color]), [['light', 'rose'], ['dark', 'rose']]);
  assert.throws(() => fixture.theme.setColor('invalid'), /Unknown theme color/);
  assert.equal(fixture.theme.getColor(), 'rose');
});

test('cross-window preference changes, removed values and cleared storage update the current theme', () => {
  const fixture = loadTheme();
  const update = (key, newValue) => {
    const event = new Event('storage');
    Object.assign(event, { key, newValue });
    fixture.window.dispatchEvent(event);
  };
  update('ds-group.theme-color', 'blue');
  update('ds-group.theme', 'dark');
  assert.equal(fixture.theme.getColor(), 'blue');
  assert.equal(fixture.root.dataset.theme, 'dark');
  update('other-key', 'teal');
  assert.equal(fixture.theme.getColor(), 'blue');
  update('ds-group.theme-color', null);
  assert.equal(fixture.theme.getColor(), 'indigo');
  update('ds-group.theme-color', 'amber');
  update(null, null);
  assert.equal(fixture.theme.getPreference(), 'system');
  assert.equal(fixture.theme.getColor(), 'indigo');
});

test('disabled storage still allows theme and color changes in the current window', () => {
  const fixture = loadTheme({}, true);
  fixture.theme.setPreference('dark');
  fixture.theme.setColor('amber');
  assert.equal(fixture.root.dataset.theme, 'dark');
  assert.equal(fixture.root.dataset.accent, 'amber');
});
