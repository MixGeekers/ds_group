const CACHE_NAME = "ds-group-shell-v3";
const SHELL_PATHS = [
  "/",
  "/index.html",
  "/client-config.json",
  "/styles.css",
  "/tokens.css",
  "/theme.js",
  "/i18n.js",
  "/locales/components.js",
  "/app.js",
  "/pwa.js",
  "/mention-editor.js",
  "/mention-tokens.js",
  "/attachments.js",
  "/manifest.webmanifest",
  "/icons/favicon.ico",
  "/icons/favicon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
const SHELL_PATH_SET = new Set(SHELL_PATHS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL_PATHS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) => name.startsWith("ds-group-shell-") && name !== CACHE_NAME,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function shellResponse(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    const cacheControl = response.headers.get("Cache-Control") ?? "";
    if (
      response.ok &&
      response.type !== "opaque" &&
      !/\bno-store\b/i.test(cacheControl)
    ) {
      await cache.put(cacheKey, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    if (request.mode === "navigate" && cacheKey === "/index.html") {
      const shell = await cache.match("/index.html");
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("Authorization")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !SHELL_PATH_SET.has(url.pathname))
    return;
  const cacheKey = ["/", "/index.html"].includes(url.pathname)
    ? "/index.html"
    : url.pathname;
  event.respondWith(shellResponse(request, cacheKey));
});

// This store contains a notification recipient binding only; no token or message bytes.
function ownerStore(mode, work) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ds-group-notification-owner", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("owner");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("owner", mode);
      let result;
      try {
        result = work(tx.objectStore("owner"));
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      tx.oncomplete = () => {
        const value = result?.result ?? null;
        db.close();
        resolve(value);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
function validOwner(value) {
  if (
    !value ||
    typeof value.userId !== "string" ||
    !/^@[^\s:]+:[^\s]+$/.test(value.userId) ||
    typeof value.homeCoreUrl !== "string" ||
    (value.authorityId !== null && typeof value.authorityId !== "string")
  )
    return null;
  try {
    const url = new URL(value.homeCoreUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.origin !== value.homeCoreUrl
    )
      return null;
    return {
      userId: value.userId,
      homeCoreUrl: value.homeCoreUrl,
      authorityId: value.authorityId,
    };
  } catch {
    return null;
  }
}
const sameOwner = (left, right) =>
  Boolean(
    left &&
      right &&
      left.userId === right.userId &&
      left.homeCoreUrl === right.homeCoreUrl &&
      left.authorityId === right.authorityId,
  );
self.addEventListener("message", (event) => {
  if (event.data?.type !== "ds-group:set-owner" || !event.source?.url) return;
  const source = new URL(event.source.url);
  if (source.origin !== self.location.origin) return;
  const owner = event.data.owner === null ? null : validOwner(event.data.owner);
  if (event.data.owner !== null && !owner) return;
  event.waitUntil(
    ownerStore("readwrite", (store) => store.put(owner, "current")),
  );
});

function notificationTarget(data = {}, allowNavigation = false) {
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const target = new URL("/", self.location.origin);
  if (allowNavigation) {
    try {
      const supplied = new URL(
        typeof data.url === "string" ? data.url : "/",
        self.location.origin,
      );
      if (
        supplied.origin === target.origin &&
        ["/", "/index.html"].includes(supplied.pathname)
      ) {
        for (const key of ["roomId", "eventId", "server"]) {
          const value = supplied.searchParams.get(key);
          if (value) target.searchParams.set(key, value);
        }
      }
    } catch {
      /* Malformed notification targets open the app home. */
    }
    for (const key of [
      "roomId",
      "eventId",
      "server",
      "userId",
      "homeCoreUrl",
      "authorityId",
    ]) {
      if (typeof data[key] === "string" && data[key])
        target.searchParams.set(key, data[key]);
    }
  }
  return {
    url: target.href,
    roomId: target.searchParams.get("roomId"),
    eventId: target.searchParams.get("eventId"),
    userId: allowNavigation ? data.userId : null,
    homeCoreUrl: allowNavigation ? data.homeCoreUrl : null,
    authorityId: allowNavigation ? (data.authorityId ?? null) : null,
  };
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    /* Unbound payloads contain no trusted navigation. */
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    payload = {};
  event.waitUntil(
    (async () => {
      const owner = await ownerStore("readonly", (store) =>
        store.get("current"),
      ).catch(() => null);
      if (!owner) return;
      const recipient = validOwner(payload.data);
      if (recipient && !sameOwner(owner, recipient)) return;
      const bound = Boolean(recipient);
      const data = notificationTarget(payload.data, bound);
      const title =
        bound && typeof payload.title === "string" && payload.title.trim()
          ? payload.title.slice(0, 120)
          : "DSCord";
      const body =
        bound && typeof payload.body === "string"
          ? payload.body.slice(0, 1000)
          : "DSCord";
      await self.registration.showNotification(title, {
        body,
        icon: "/icons/icon-192.png",
        data,
        ...(data.eventId
          ? { tag: `ds-group-${data.userId}-${data.eventId}` }
          : {}),
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const owner = await ownerStore("readonly", (store) =>
        store.get("current"),
      ).catch(() => null);
      const target = notificationTarget(
        event.notification.data,
        sameOwner(owner, validOwner(event.notification.data)),
      );
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const appWindows = windows.filter((client) => {
        const url = new URL(client.url);
        return (
          url.origin === self.location.origin &&
          ["/", "/index.html"].includes(url.pathname)
        );
      });
      const client =
        appWindows.find((window) => window.focused) ?? appWindows[0];
      if (client) {
        try {
          await client.focus();
          client.postMessage({ type: "ds-group:open-room", ...target });
          return;
        } catch {
          /* A closing window can disappear after enumeration. */
        }
      }
      await self.clients.openWindow(target.url);
    })(),
  );
});
