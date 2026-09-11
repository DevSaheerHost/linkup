/* LinkUp service worker - web push (messages + calls) + clicks */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Minimal fetch handler so the app is installable as a PWA.
// Intentionally a pass-through: we do NOT cache, to avoid serving stale HTML.
self.addEventListener('fetch', () => {});

async function appIsOpen() {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return cs.some(c => c.focused || c.visibilityState === 'visible');
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }

    // Incoming call: full notification with Answer / Decline actions
    if (data.type === 'call') {
      if (await appIsOpen()) return;   // app handles ringing in-foreground
      await self.registration.showNotification(data.title || 'Incoming call', {
        body: data.body || '',
        icon: data.icon || '/icon-192.png',
        badge: data.badge || '/icon-192.png',
        tag: data.tag || 'call',
        renotify: true,
        requireInteraction: true,
        vibrate: [400, 250, 400, 250, 400],
        actions: [
          { action: 'answer', title: 'Answer' },
          { action: 'decline', title: 'Decline' }
        ],
        data: { url: data.url || '/', type: 'call' }
      });
      return;
    }

    // Chat message: skip if app is open/visible
    if (data.type === 'message') {
      if (await appIsOpen()) return;
    }

    await self.registration.showNotification(data.title || 'LinkUp', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/icon-192.png',
      tag: data.tag || undefined,
      data: { url: data.url || '/' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'decline') return;   // best effort: caller times out
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
