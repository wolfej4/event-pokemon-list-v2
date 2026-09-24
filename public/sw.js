"use strict";
// Keeps the storefront usable at events with unreliable wifi: the app shell
// (HTML/CSS/JS) is cached on install, the catalog API responses are cached
// as they're fetched (network-first, falling back to cache when offline),
// and design images are cached opportunistically the first time they load.

const CACHE_NAME = "n3d-catalog-v2";
const APP_SHELL = [
  "/",
  "/assets/theme.css",
  "/assets/store.css",
  "/assets/store.js",
  "/manifest.json",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
  "/assets/apple-touch-icon.png",
  "/favicon.ico",
  "/assets/favicon.png"
];
const API_PATHS = ["/api/public/designs", "/api/public/settings"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POSTs (quote submissions etc.)

  const url = new URL(req.url);
  const isApi = url.origin === self.location.origin && API_PATHS.some((p) => url.pathname === p);
  const isAppShell = url.origin === self.location.origin &&
    (APP_SHELL.includes(url.pathname) || url.pathname === "/index.html");

  if (isApi) {
    // network-first: keep the catalog fresh when online, fall back to the
    // last successful response when offline
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  if (isAppShell) {
    // cache-first for the app shell so it launches with zero network
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
    return;
  }

  // everything else (design thumbnails from the CDN, etc.): cache
  // opportunistically the first time it's seen so repeat views work offline
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
