/**
 * PDF Presenter — service worker.
 *
 * Makes the app installable and keeps its shell available offline:
 *  - pages, scripts and styles are fetched from the network first (so a new
 *    deployment applies at once), falling back to the cache when offline;
 *  - fonts, images and PDF.js data are served from the cache and refreshed in
 *    the background (stale-while-revalidate);
 *  - API calls, uploads and WebSockets are never cached.
 *
 * Licensed under the Apache License, Version 2.0.
 */

const VERSION = "v3";
const CACHE = `pdf-presenter-${VERSION}`;

const PRECACHE = [
  "/",
  "/index.html",
  "/remote.html",
  "/viewer.html",
  "/access.html",
  "/css/style.css",
  "/css/fonts.css",
  "/js/presenter.js",
  "/js/remote.js",
  "/js/viewer.js",
  "/js/access.js",
  "/js/lib/common.js",
  "/js/lib/i18n.js",
  "/js/lib/strings.js",
  "/js/lib/pdf-renderer.js",
  "/js/lib/annotations.js",
  "/js/lib/effects.js",
  "/js/lib/poll-view.js",
  "/js/lib/library.js",
  "/js/lib/notes-store.js",
  "/js/lib/dhikr.js",
  "/vendor/pdf.min.js",
  "/vendor/pdf.worker.min.js",
  "/vendor/qrious.min.js",
  "/favicon/site.webmanifest",
  "/favicon/android-chrome-192x192.png",
];

const NEVER_CACHE = [/^\/api\//, /^\/uploads\//, /^\/socket\.io\//, /^\/health/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.some((re) => re.test(url.pathname))) return;

  const networkFirst =
    request.mode === "navigate" || /\.(js|css|html|webmanifest)$/.test(url.pathname) || url.pathname === "/";
  if (networkFirst && !url.pathname.startsWith("/vendor/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok) caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(url.pathname);
          if (cached) return cached;
          if (request.mode === "navigate") return caches.match("/index.html");
          return Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
