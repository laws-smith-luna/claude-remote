const CACHE_NAME = "claude-remote-v25";
const STATIC_ASSETS = [
  "/claude-remote/",
  "/claude-remote/css/style.css",
  "/claude-remote/js/app.js",
  "/claude-remote/js/ws.js",
  "/claude-remote/js/machines.js",
  "/claude-remote/js/multi-ws.js",
  "/claude-remote/js/offline-store.js",
  "/claude-remote/js/chat.js",
  "/claude-remote/js/sessions-ui.js",
  "/claude-remote/js/permission.js",
  "/claude-remote/js/markdown.js",
  "/claude-remote/manifest.json",
  "/claude-remote/favicon.ico",
  "/claude-remote/icons/icon-192.png",
  "/claude-remote/icons/icon-512.png",
];

// Install: cache static assets
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// Message: respond to version queries
self.addEventListener("message", (e) => {
  if (e.data?.type === "get_version") {
    e.ports[0]?.postMessage({ cacheName: CACHE_NAME });
  }
});

// Fetch: stale-while-revalidate for static assets (instant load, background update)
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Skip API and WebSocket requests
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      // Background revalidate
      const networkFetch = fetch(e.request)
        .then((response) => {
          if (response.ok && e.request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(() => cached); // network failed, cached already served

      // Return cached immediately, or wait for network if no cache
      return cached || networkFetch;
    })
  );
});