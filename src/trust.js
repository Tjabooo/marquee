// Which proxy headers Marquee believes. Accounts come from Cloudflare Access: the email in
// Cf-Access-Authenticated-User-Email is the account, and Cf-Connecting-IP / Cf-Ray tell a visit
// over the internet from one at home. Any client can send those headers, so before a request is
// handled, sanitize() removes them unless they are trustworthy:
//
//   * The connection comes from a trusted proxy (TRUSTED_PROXIES; default: this machine only,
//     which is where cloudflared or a local reverse proxy connects from), or
//   * CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set and the request carries a valid Access JWT
//     (Cf-Access-Jwt-Assertion, signed by the team's Access keys). The email then comes from the
//     verified token, wherever the connection came from. Recommended when cloudflared runs on
//     another machine or container.
//
// A request whose identity headers are removed is an ordinary visit from the home network: it gets
// the shared "Home network" account, never someone's own account or the owner's rights.
import crypto from 'node:crypto';
import net from 'node:net';

const IDENTITY = 'cf-access-authenticated-user-email';
const JWT = 'cf-access-jwt-assertion';
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-ipcity', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip'];

const clean = (ip) => String(ip || '').replace(/^::ffff:/i, '').replace(/%.*$/, '').trim();

// "127.0.0.1", "10.0.0.0/8", "fd00::/8" -> matcher. Unparseable entries are reported and ignored.
export function parseProxies(list) {
  const rules = [];
  const invalid = [];
  for (const raw of String(list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bitsText] = raw.split('/');
    const ip = clean(addr);
    const family = net.isIP(ip);
    const max = family === 4 ? 32 : 128;
    const bits = bitsText === undefined ? max : Number(bitsText);
    if (!family || !Number.isInteger(bits) || bits < 0 || bits > max) { invalid.push(raw); continue; }
    rules.push({ family, bits, bytes: toBytes(ip, family) });
  }
  return { rules, invalid };
}

function toBytes(ip, family) {
  if (family === 4) return Uint8Array.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { const n = parseInt(g || '0', 16); out[i * 2] = n >> 8; out[i * 2 + 1] = n & 255; });
  return out;
}

export function matches(rules, address) {
  const ip = clean(address);
  const family = net.isIP(ip);
  if (!family) return false;
  const bytes = toBytes(ip, family);
  return rules.some((r) => {
    if (r.family !== family) return false;
    for (let bit = 0; bit < r.bits; bit++) {
      const mask = 0x80 >> (bit % 8);
      if ((bytes[bit >> 3] & mask) !== (r.bytes[bit >> 3] & mask)) return false;
    }
    return true;
  });
}

// ---------- Cloudflare Access JWT ----------
const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function createAccessVerifier({ teamDomain, audience, fetchImpl = fetch, now = () => Date.now() }) {
  const team = String(teamDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = String(audience || '').trim();
  if (!team || !aud) return null;
  const issuer = `https://${team}`;
  let keys = new Map();
  let fetchedAt = 0;
  let pending = null;

  async function loadKeys(force = false) {
    // Access rotates its signing keys every few weeks; refresh hourly, or at once for an unknown key
    // (at most once a minute, so forged tokens can't make Marquee hammer the certs endpoint).
    if (!force && now() - fetchedAt < 3600_000 && keys.size) return keys;
    if (force && now() - fetchedAt < 60_000) return keys;
    pending ??= (async () => {
      try {
        const r = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        const next = new Map();
        for (const jwk of body.keys || []) {
          try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip odd keys */ }
        }
        if (next.size) keys = next;
      } catch (e) {
        console.warn(`Cloudflare Access: couldn't load signing keys from ${issuer} (${e.message})`);
      } finally {
        fetchedAt = now();
        pending = null;
      }
      return keys;
    })();
    return pending;
  }

  // Resolves to the verified email, or null.
  return async function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    let header, payload;
    try { header = JSON.parse(b64url(parts[0])); payload = JSON.parse(b64url(parts[1])); } catch { return null; }
    if (header.alg !== 'RS256' || !header.kid) return null;
    let key = (await loadKeys()).get(header.kid);
    if (!key) key = (await loadKeys(true)).get(header.kid);
    if (!key) return null;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]));
    if (!ok) return null;
    const seconds = now() / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud) || payload.iss !== issuer) return null;
    if (typeof payload.exp !== 'number' || payload.exp < seconds - 30) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > seconds + 30) return null;
    const email = String(payload.email || '').trim().toLowerCase();
    return email || null;
  };
}

// ---------- request sanitizing ----------
export function createTrust({
  trustedProxies = process.env.TRUSTED_PROXIES ?? '127.0.0.1,::1',
  teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN,
  audience = process.env.CF_ACCESS_AUD,
  fetchImpl,
} = {}) {
  const { rules, invalid } = parseProxies(trustedProxies);
  if (invalid.length) console.warn(`TRUSTED_PROXIES: ignoring ${invalid.join(', ')} (not an IP address or CIDR range)`);
  const verify = createAccessVerifier({ teamDomain, audience, ...(fetchImpl ? { fetchImpl } : {}) });

  async function sanitize(req) {
    const fromProxy = matches(rules, req.socket?.remoteAddress);
    if (!fromProxy) for (const h of PROXY_HEADERS) delete req.headers[h];
    if (verify) {
      const token = req.headers[JWT] || cookie(req.headers.cookie, 'CF_Authorization');
      const email = token ? await verify(token) : null;
      if (email) req.headers[IDENTITY] = email;
      else delete req.headers[IDENTITY];
    } else if (!fromProxy) {
      delete req.headers[IDENTITY];
    }
    return req;
  }
  return { sanitize, mode: verify ? 'access-jwt' : 'trusted-proxy', proxies: rules.length };
}

function cookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
