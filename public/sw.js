/* ARIA OS — service worker: offline shell, background notifications */
'use strict';
const VERSION = 'aria-v1';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/js/app.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png',
  '/audio/morning.mp3', '/audio/priority.mp3'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // API: network-first, fall back to last cached copy (offline access to your brief)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) { const c = await caches.open(VERSION); c.put(req, fresh.clone()); }
        return fresh;
      } catch (_) {
        const cached = await caches.match(req);
        return cached || new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Static: cache-first, refresh in background
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    const fetchAndCache = fetch(req).then(async (res) => {
      if (res.ok) { const c = await caches.open(VERSION); c.put(req, res.clone()); }
      return res;
    }).catch(() => cached || Response.error());
    return cached || fetchAndCache;
  })());
});

/* ---- Morning-brief push notifications ---- */
self.addEventListener('push', (e) => {
  let data = { title: '☀️ ARIA OS', body: 'Your morning brief is ready.', url: '/#/briefs' };
  try { data = { ...data, ...(e.data ? e.data.json() : {}) }; } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: 'aria-brief', renotify: false, data: { url: data.url },
    vibrate: [80, 40, 80], silent: false
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
