// Notifications on this device: the service worker (sw.js), the browser's push subscription and the
// server's list of devices (/api/push). app.js draws Settings → Notifications from what's here.

// What this browser can do. 'ios-install' = iPhone/iPad Safari outside a Home Screen app, where
// Apple only allows notifications once Marquee is added to the Home Screen.
export function pushSupport(env = globalThis) {
  const nav = env.navigator || {};
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || Boolean(env.matchMedia?.('(display-mode: standalone)')?.matches);
  if (!env.isSecureContext) return 'insecure';
  if (ios && !standalone && !('PushManager' in env)) return 'ios-install';
  if (!('serviceWorker' in nav) || !('PushManager' in env) || !('Notification' in env)) return 'unsupported';
  if (env.Notification.permission === 'denied') return 'denied';
  return 'ok';
}

// A name for this device in the list ("Firefox on Linux", "iPhone"), from the user agent.
export function deviceLabel(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) return 'iPad';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// applicationServerKey wants bytes; the server sends base64url.
export function keyBytes(b64) {
  const s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

// Same key? A subscription made for an older server key has to be replaced.
export function sameKey(subscription, publicKey) {
  const have = subscription?.options?.applicationServerKey;
  if (!have) return true; // browsers that don't say: assume it's ours
  const a = new Uint8Array(have), b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

let registration = null;
// Registers sw.js (once). Harmless where push isn't available: nothing else uses the worker.
export async function registerWorker(env = globalThis) {
  if (registration || !env.isSecureContext || !('serviceWorker' in (env.navigator || {}))) return registration;
  try { registration = await env.navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { registration = null; }
  return registration;
}

export async function currentSubscription(env = globalThis) {
  const reg = await registerWorker(env);
  return reg?.pushManager ? reg.pushManager.getSubscription().catch(() => null) : null;
}

// Asks for permission (must run from a tap) and subscribes. Resolves to the subscription, or throws
// with a message to show.
export async function subscribe(publicKey, env = globalThis) {
  const permission = await env.Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied'
    ? 'Notifications are blocked for Marquee. Allow them in the browser’s site settings, then try again.'
    : 'Notifications weren’t allowed.');
  const reg = await registerWorker(env);
  if (!reg) throw new Error('This browser couldn’t start notifications.');
  await env.navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
}
