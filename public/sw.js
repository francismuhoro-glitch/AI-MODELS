/* ARIA OS — service worker: offline shell, background notifications */
'use strict';
const VERSION = 'aria-v3';
/* NOTE: '/' and '/index.html' are deliberately NOT precached. Behind ARIA_PASSWORD the server
   answers a navigation with the unlock page, and caching that as the app shell used to pin the
   unlock screen forever — the auth deadlock. Navigations are network-first (see fetch below). */
const SHELL = [
  '/css/app.css', '/js/app.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png',
  '/audio/morning.mp3', '/audio/priority.mp3'
];

self.addEventListener('install', (e) => {
  // Individually cached so one missing asset can't fail the whole install.
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
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

  /* Navigations: ALWAYS network-first — never answer a page load from cache while online.
     Auth state (locked vs unlocked) lives on the server, so a cached HTML shell would happily
     re-serve the unlock screen to an already-authenticated user, or vice versa. Only fall back
     to the cached shell when genuinely offline, and never cache a locked response. */
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok && fresh.headers.get('X-ARIA-Locked') !== '1') {
          const c = await caches.open(VERSION);
          c.put('/index.html', fresh.clone());
        }
        return fresh;
      } catch (_) {
        return (await caches.match('/index.html')) || (await caches.match(req, { ignoreSearch: true })) ||
          new Response('<!DOCTYPE html><meta charset="utf-8"><title>ARIA OS — offline</title><body style="font-family:system-ui;background:#0a0e14;color:#e8eef7;display:grid;place-items:center;height:100vh;margin:0">offline — reconnect to reach ARIA OS</body>',
            { status: 503, headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

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
