const CACHE_NAME = 'ds-group-shell-v3';
const SHELL_PATHS = [
  '/',
  '/index.html',
  '/styles.css',
  '/tokens.css',
  '/theme.js',
  '/i18n.js',
  '/locales/components.js',
  '/app.js',
  '/pwa.js',
  '/mention-editor.js',
  '/mention-tokens.js',
  '/attachments.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];
const SHELL_PATH_SET = new Set(SHELL_PATHS);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_PATHS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('ds-group-shell-') && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function shellResponse(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    const cacheControl = response.headers.get('Cache-Control') ?? '';
    if (response.ok && response.type !== 'opaque' && !/\bno-store\b/i.test(cacheControl)) {
      await cache.put(cacheKey, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    if (request.mode === 'navigate' && cacheKey === '/index.html') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !SHELL_PATH_SET.has(url.pathname)) return;
  const cacheKey = ['/', '/index.html'].includes(url.pathname) ? '/index.html' : url.pathname;
  event.respondWith(shellResponse(request, cacheKey));
});

function notificationTarget(data = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const target = new URL('/', self.location.origin);
  try {
    const supplied = new URL(typeof data.url === 'string' ? data.url : '/', self.location.origin);
    if (supplied.origin === target.origin && ['/', '/index.html'].includes(supplied.pathname)) {
      for (const key of ['roomId', 'eventId']) {
        const value = supplied.searchParams.get(key);
        if (value) target.searchParams.set(key, value);
      }
    }
  } catch {
    // A malformed target still opens the application's default route.
  }
  for (const key of ['roomId', 'eventId']) {
    if (typeof data[key] === 'string' && data[key]) target.searchParams.set(key, data[key]);
  }
  return {
    url: target.href,
    roomId: target.searchParams.get('roomId'),
    eventId: target.searchParams.get('eventId'),
  };
}

self.addEventListener('push', event => {
  let payload = {};
  if (event.data) {
    try { payload = event.data.json(); }
    catch { payload = { body: event.data.text() }; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  const data = notificationTarget(payload.data && typeof payload.data === 'object' ? payload.data : {});
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.slice(0, 120) : 'DSCord';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 1000) : '收到一条新消息';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    data,
    ...(data.eventId ? { tag: `ds-group-${data.eventId}` } : {}),
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = notificationTarget(event.notification.data);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appWindows = windows.filter(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && ['/', '/index.html'].includes(url.pathname);
    });
    const client = appWindows.find(window => new URL(window.url).searchParams.get('roomId') === target.roomId)
      ?? appWindows.find(window => window.focused)
      ?? appWindows[0];
    if (client) {
      try {
        await client.focus();
        client.postMessage({ type: 'ds-group:open-room', ...target });
        return;
      } catch {
        // A closing window may disappear between enumeration and focus.
      }
    }
    await self.clients.openWindow(target.url);
  })());
});
