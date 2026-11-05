(() => {
  const storageKey = 'ds-group.theme';
  const colorStorageKey = 'ds-group.theme-color';
  const preferences = new Set(['system', 'dark', 'light']);
  const colors = new Set(['indigo', 'blue', 'teal', 'rose', 'amber']);
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  let color = 'indigo';
  try {
    const stored = localStorage.getItem(storageKey);
    if (preferences.has(stored)) preference = stored;
    const storedColor = localStorage.getItem(colorStorageKey);
    if (colors.has(storedColor)) color = storedColor;
  } catch { /* System appearance remains available when storage is disabled. */ }

  function resolvedTheme() {
    return preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
  }

  function apply() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.dataset.accent = color;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#313338' : '#ffffff';
    window.dispatchEvent(new CustomEvent('ds-group:theme', { detail: { preference, theme, color } }));
  }

  function setPreference(value) {
    if (!preferences.has(value)) throw new Error('Unknown theme preference');
    preference = value;
    try { localStorage.setItem(storageKey, value); }
    catch { /* The selected appearance still applies to the current window. */ }
    apply();
  }

  function setColor(value) {
    if (!colors.has(value)) throw new Error('Unknown theme color');
    color = value;
    try { localStorage.setItem(colorStorageKey, value); }
    catch { /* The selected color still applies to the current window. */ }
    apply();
  }

  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === storageKey) {
      preference = preferences.has(event.newValue) ? event.newValue : 'system';
    } else if (event.key === colorStorageKey) {
      color = colors.has(event.newValue) ? event.newValue : 'indigo';
    } else if (event.key === null) {
      preference = 'system';
      color = 'indigo';
    } else return;
    apply();
  });
  window.DSGroupTheme = Object.freeze({
    getPreference: () => preference,
    getResolvedTheme: resolvedTheme,
    setPreference,
    getColor: () => color,
    setColor,
  });
  apply();
})();
