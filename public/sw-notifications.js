// Custom service worker extension for IV — notification UX.
// Imported by Workbox-generated SW via vite.config.ts → workbox.importScripts.
// Stays minimal: we only need notification click routing + action handling.

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification && event.notification.data) || {};
  let targetUrl = data.url || '/';

  // Handle action buttons (currently only "open"/"dismiss" are wired).
  if (event.action === 'dismiss') return;
  if (event.action === 'open' && data.actionUrl) {
    targetUrl = data.actionUrl;
  }

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    // Prefer focusing an already-open window and navigating it.
    for (const client of clientList) {
      try {
        const clientUrl = new URL(client.url);
        const sameOrigin = clientUrl.origin === self.location.origin;
        if (sameOrigin && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try { await client.navigate(targetUrl); } catch { /* cross-origin / restricted */ }
          } else {
            client.postMessage({ type: 'iv:navigate', url: targetUrl });
          }
          return;
        }
      } catch { /* malformed URL, ignore */ }
    }

    // No client open → open a new one.
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// Allow the page to ask the SW to display a notification, so we get
// reliable delivery on Android / locked screens (vs. `new Notification`).
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'iv:show-notification') return;

  const { title, options } = msg;
  if (!title) return;

  event.waitUntil(self.registration.showNotification(title, options || {}));
});

// ── Background Sync ────────────────────────────────────────────────────────
// Generic retry hook for tasks the page enqueues while offline. Pages can
// register a sync tag like `iv:retry-uploads` after a failed POST; the
// browser (Android Chrome) will fire `sync` once connectivity is restored.
// The actual queue lives in IndexedDB and is consumed by client code on
// the next page load — here we just notify clients that a sync ran.
self.addEventListener('sync', (event) => {
  if (event.tag && event.tag.startsWith('iv:')) {
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'iv:sync', tag: event.tag });
      }
    })());
  }
});

// ── Web Push (VAPID) ───────────────────────────────────────────────────────
// Server payload contract (matches netlify/functions/push-send.ts):
//   { title: string, body?: string, url?: string, tag?: string,
//     kind?: string, requireInteraction?: boolean, vibrate?: number[] }
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { /* not JSON */ }

  const title = payload.title || 'Instituto de Vencedores';
  const body  = payload.body  || '';
  const url   = payload.url   || '/';
  const tag   = payload.tag   || `iv:push:${Date.now()}`;
  const kind  = payload.kind  || 'push';

  const vibrate = Array.isArray(payload.vibrate) && payload.vibrate.length
    ? payload.vibrate
    : (kind === 'lesson-started'
        ? [200, 100, 200, 100, 400]
        : kind === 'lesson-reminder'
          ? [200, 100, 200]
          : [120]);

  const options = {
    body,
    tag,
    icon: '/logo-192.png',
    badge: '/logo-192.png',
    renotify: kind === 'lesson-reminder' || kind === 'lesson-started',
    requireInteraction: !!payload.requireInteraction || kind === 'lesson-started',
    silent: false,
    vibrate,
    data: { url, actionUrl: url, kind, id: tag },
    actions: url ? [
      { action: 'open',    title: kind === 'lesson-started' ? 'Entrar' : 'Abrir' },
      { action: 'dismiss', title: 'Dispensar' },
    ] : undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// PushManager.subscriptionchange — re-subscribe and let the page persist it.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'iv:push-resubscribe' });
    }
  })());
});
