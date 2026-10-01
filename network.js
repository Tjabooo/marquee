// Works out whether a request comes from the server's own home network.
// Direct connections are judged by their address (LAN = home). Requests through
// Cloudflare Tunnel arrive from cloudflared on the LAN, so the visitor's real address
// (CF-Connecting-IP) is compared with the home network's public address instead.
import net from 'node:net';

const CACHE_MS = 10 * 60 * 1000;
let publicIps = { v4: null, v6: null, at: 0 };
let refreshing = null;

const clean = (ip) => String(ip || '').replace(/^::ffff:/i, '').replace(/%.*$/, '').trim();

// Expands an IPv6 address to 8 groups and returns the first 4 (the /64 network).
function prefix64(ip) {
  let [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}

function isPrivate(ip) {
  ip = clean(ip);
  if (net.isIPv4(ip)) {
    // 100.64.0.0/10 (Tailscale, carrier-grade NAT) is deliberately not treated as home.
    return /^(10\.|127\.|192\.168\.|169\.254\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  }
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  return false;
}

let lastLookupError = null;

// Asks a "what's my IP" service; the response is either Cloudflare's trace format or a bare IP.
async function lookup(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const text = await r.text();
  const ip = (/^ip=(.+)$/m.exec(text)?.[1] ?? text).trim();
  return net.isIP(ip) ? ip : null;
}

// Tries each service until one answers; the hostnames only resolve to one IP version.
async function firstIp(urls) {
  for (const url of urls) {
    try {
      const ip = await lookup(url);
      if (ip) return ip;
    } catch (e) {
      lastLookupError = `${url}: ${e.cause?.code || e.message}`;
    }
  }
  return null;
}

// The home network's public IPv4 and IPv6 addresses, as Cloudflare sees them.
async function homeAddresses() {
  if (Date.now() - publicIps.at < CACHE_MS) return publicIps;
  refreshing ??= (async () => {
    const [v4, v6] = await Promise.all([
      firstIp(['https://ipv4.icanhazip.com', 'https://1.1.1.1/cdn-cgi/trace', 'https://api.ipify.org']),
      firstIp(['https://ipv6.icanhazip.com', 'https://[2606:4700:4700::1111]/cdn-cgi/trace', 'https://api6.ipify.org']),
    ]);
    // Keep the previous answer if a lookup fails (e.g. the internet briefly dropped).
    const next = { v4: v4 ?? publicIps.v4, v6: v6 ?? publicIps.v6 };
    // Nothing known yet: try again in 30 seconds instead of waiting the full cache time.
    publicIps = { ...next, at: next.v4 || next.v6 ? Date.now() : Date.now() - CACHE_MS + 30_000 };
    refreshing = null;
    return publicIps;
  })();
  return refreshing;
}

// true = same network as the server, false = somewhere else, null = couldn't tell.
export async function isHomeRequest(req) {
  const socket = clean(req.socket.remoteAddress);
  const viaCloudflare = req.headers['cf-connecting-ip'] && isPrivate(socket);
  if (!viaCloudflare) return isPrivate(socket);

  const visitor = clean(req.headers['cf-connecting-ip']);
  const home = await homeAddresses();
  if (!home.v4 && !home.v6) return null; // lookups failed: can't tell
  // If the home network has no address of the visitor's type (e.g. a phone on mobile data
  // using IPv6 while home is IPv4-only), the visitor can't be at home.
  if (net.isIPv4(visitor)) return Boolean(home.v4) && visitor === home.v4;
  if (net.isIPv6(visitor)) return Boolean(home.v6) && prefix64(visitor) === prefix64(home.v6);
  return null;
}

// What the server sees for this request; served at /api/network for troubleshooting.
export async function describeRequest(req) {
  const home = await homeAddresses();
  return {
    atHome: await isHomeRequest(req),
    socket: clean(req.socket.remoteAddress),
    visitor: req.headers['cf-connecting-ip'] ? clean(req.headers['cf-connecting-ip']) : null,
    homeIPv4: home.v4,
    homeIPv6: home.v6,
    lookupError: home.v4 || home.v6 ? null : lastLookupError,
  };
}