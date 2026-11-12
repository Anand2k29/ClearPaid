// ClearPaid service worker. Lets the app open offline and install to the home screen.
// Live data is never cached: invoices, proofs, reminders, sign-in and webhooks always go to the network.
const VERSION = "clearpaid-v4";
// The mobile app and what it needs to open offline. The desktop website is network-first like every page.
const SHELL = [
  "./mobile/index.html",
  "./mobile/manifest.webmanifest",
  "./shared/app.css",
  "./shared/mobile.css",
  "./shared/app.js",
  "./shared/fonts.css",
  "./shared/fonts/fraunces-latin-opsz-normal.woff2",
  "./shared/fonts/fraunces-latin-opsz-italic.woff2",
  "./shared/fonts/hanken-grotesk-latin-wght-normal.woff2",
  "./shared/fonts/noto-sans-devanagari-devanagari-400-normal.woff2",
  "./calc.js",
  "./lib/parse-invoice.js",
  "./lib/ledger.js",
  "./lib/i18n.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];
const LIVE_PATHS = ["/api/", "/auth/", "/proof/", "/webhooks/"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache writes
  const url = new URL(req.url);

  // Live data: always the network, never the cache.
  if (LIVE_PATHS.some(p => url.pathname.includes(p))) return;

  // The app's own files: network first, so updates arrive, with the cache as the offline fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match("./mobile/index.html")))
    );
    return;
  }

  // Shared libraries from public CDNs: serve from cache, refresh in the background.
  event.respondWith(
    caches.open(VERSION).then(cache =>
      cache.match(req).then(hit => {
        const network = fetch(req).then(res => {
          cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || network;
      })
    )
  );
});
