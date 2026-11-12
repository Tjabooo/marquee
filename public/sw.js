// Lilin's service worker: shows notifications (push.js on the server) and opens Lilin when one
// is tapped. It caches nothing and doesn't touch page loads, so updates still arrive right away.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  const url = typeof data.url === 'string' && /^\/(?!\/)/.test(data.url) ? data.url : '/';
  event.waitUntil(self.registration.showNotification(data.title || 'Lilin', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url, kind: data.kind || '' },
  }));
});

// Tapping a notification: bring an open Lilin to the front and let it open the link itself (no
// reload, so a playing video keeps playing until you choose); otherwise open a new window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (page) {
      await page.focus().catch(() => {});
      page.postMessage({ type: 'lilin:open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// The browser renewed this device's subscription: tell the server, so notifications keep arriving.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    let sub = event.newSubscription;
    if (!sub) {
      const { publicKey } = await (await fetch('/api/push', { credentials: 'same-origin' })).json();
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    }
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), replaces: old?.endpoint || '' }) });
  })().catch(() => {}));
});
