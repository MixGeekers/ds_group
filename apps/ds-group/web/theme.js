(() => {
  const storageKey = 'ds-group.theme';
  const preferences = new Set(['system', 'dark', 'light']);
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const stored = localStorage.getItem(storageKey);
    if (preferences.has(stored)) preference = stored;
  } catch { /* System appearance remains available when storage is disabled. */ }

  function resolvedTheme() {
    return preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
  }

  function apply() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) color.content = theme === 'dark' ? '#313338' : '#ffffff';
    window.dispatchEvent(new CustomEvent('ds-group:theme', { detail: { preference, theme } }));
  }

  function setPreference(value) {
    if (!preferences.has(value)) throw new Error('Unknown theme preference');
    preference = value;
    try { localStorage.setItem(storageKey, value); }
    catch { /* The selected appearance still applies to the current window. */ }
    apply();
  }

  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    preference = preferences.has(event.newValue) ? event.newValue : 'system';
    apply();
  });
  window.DSGroupTheme = Object.freeze({
    getPreference: () => preference,
    getResolvedTheme: resolvedTheme,
    setPreference,
  });
  apply();
})();
