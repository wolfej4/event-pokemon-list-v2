"use strict";
// Makes the admin panel installable and shows new-order notifications
// (Android Chrome can only show them through a service worker). Unlike the storefront's service worker,
// this deliberately does NOT cache /api/admin/* — admin data (quotes,
// pricing, sync status) should always come from the network, never a stale
// cached copy of something behind a login.

const CACHE_NAME = "n3d-admin-shell-v2";
const APP_SHELL = [
  "/admin",
  "/admin/assets/admin.css",
  "/admin/assets/admin.js",
  "/admin/manifest.json",
  "/assets/theme.css"
];

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
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return; // never touch API calls

  const isAppShell = APP_SHELL.includes(url.pathname) || url.pathname === "/admin/index.html";
  if (isAppShell) {
    // network-first so a deploy shows up right away; the cache is only an
    // offline fallback
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
  }
  // everything else (icons, admin-specific images): let the browser's own
  // HTTP cache handle it, no need to duplicate that here
});

// clicking a new-order notification focuses the admin (or opens it) on Orders
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).pathname.startsWith("/admin"));
      if (win) { win.postMessage({ type: "open-orders" }); return win.focus(); }
      return self.clients.openWindow("/admin#orders");
    })
  );
});
