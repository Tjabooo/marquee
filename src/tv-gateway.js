// The TV apps' way in from anywhere: /c/tv/<path> is <path>, for the few paths a TV app uses.
//
// Behind Cloudflare Access (docs/remote-access.md) only /c/... answers without the Access login, which a
// TV can't do. So an app built with https://<your Marquee>/c/tv as its address (tv/android) sends
// everything here, and Marquee checks it like this instead:
//   * the TV app's own files, the sign-in code (tv.js pairing) and the app's update are open;
//   * the API calls the TV app makes need the TV's own session (X-Marquee-Session, from pairing), which
//     the normal sign-in check enforces; anything else is "Not found";
//   * cookies are dropped, so a browser's Marquee session never works through here.
// /play/... links are signed for one video, and already public.
export const TV_GATEWAY = '/c/tv';

const OPEN = [
  /^\/tv\/[\w.-]+\.(js|css)$/,
  /^\/fonts\/[\w.-]+\.woff2$/,
  /^\/api\/(health|status)$/,
  /^\/api\/tv\/pair\/(start|poll)$/,
  /^\/android(\/|\.apk|\.json)?$/,
  /^\/play\//,
];
// What public/tv/tv.js asks for (tests/tv-gateway.test.mjs checks every call in it is here).
const SIGNED_IN = [
  /^\/api\/library$/,
  /^\/api\/me\/progress$/,
  /^\/api\/downloads$/,
  /^\/api\/downloads\/smart(\/[\w-]+)?$/,
  /^\/api\/discover\/(genres|home|list)$/,
  /^\/api\/docs\/home$/,
  /^\/api\/svt\/(add|title)$/,
  /^\/api\/search$/,
  /^\/api\/title\/(movie|tv)\/\d+\/(page|cast)$/,
  /^\/api\/tv\/[^/]+\/seasons$/,
  /^\/api\/play-link$/,
  /^\/api\/media\/lib\/[^/]+\/(intro|credits)$/,
  /^\/api\/subs\/(fetch|langs)$/,
  /^\/api\/subs\/file\//,
];

// The path behind /c/tv, or null when the request isn't for the gateway.
export function innerPath(pathname) {
  if (!pathname.startsWith(TV_GATEWAY + '/')) return null;
  const inner = pathname.slice(TV_GATEWAY.length);
  return inner.includes('/../') || inner.includes('/./') ? null : inner;
}

export const gatewayAllows = (inner) => OPEN.some((r) => r.test(inner)) || SIGNED_IN.some((r) => r.test(inner));

// A few sign-in codes per address: the codes are shared by everyone, so one visitor can't push the rest out.
export function createPairLimit({ max = 12, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const seen = new Map(); // address -> { count, first }
  return function allow(address) {
    const t = now();
    for (const [a, s] of seen) if (t - s.first > windowMs) seen.delete(a);
    const s = seen.get(address) || { count: 0, first: t };
    s.count += 1;
    seen.set(address, s);
    return s.count <= max;
  };
}
