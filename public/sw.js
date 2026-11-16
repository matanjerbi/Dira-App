// Dira service worker: app-shell cache (network-first) + web push.
const CACHE = 'dira-v4';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'dira-auth').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});

// Pushes arrive without payload; fetch the pending texts with the stored member token.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let items = [];
    try {
      const c = await caches.open('dira-auth');
      const r = await c.match('/__token');
      const t = r && (await r.text());
      if (t) {
        const res = await fetch('/api/notifications/pending?t=' + encodeURIComponent(t), { cache: 'no-store' });
        if (res.ok) items = (await res.json()).items || [];
      }
    } catch (err) { /* fall through to generic */ }
    if (!items.length) items = [{ id: 'generic', title: 'Dira', body: 'יש עדכון בדירה', url: '/' }];
    for (const n of items.slice(0, 3)) {
      await self.registration.showNotification(n.title || 'Dira', {
        body: n.body, icon: '/icon-192.png', badge: '/icon-192.png', tag: n.id, lang: 'he', dir: 'rtl', data: { url: n.url || '/' },
      });
    }
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('navigate' in c) { return c.navigate(url).then((w) => (w || c).focus()); } }
    return self.clients.openWindow(url);
  }));
});
