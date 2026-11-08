// Who may use Marquee, and which requests it accepts at all. Three layers, run on every request
// after trust.sanitize() has removed proxy headers nobody vouches for:
//
// 1. guard(): refuses requests a web page could send without the visitor meaning to.
//    * Host check (DNS rebinding): a site the visitor opens can point its own domain at the
//      server's LAN address and then talk to Marquee "same-origin". Marquee only answers to IP
//      addresses, localhost, single-label and home-network names (geofront, *.local, *.lan,
//      *.home.arpa, *.internal, *.ts.net), PUBLIC_URL and ALLOWED_HOSTS.
//    * Origin check (CSRF): a POST must come from Marquee's own pages. Browsers always send Origin
//      (or Sec-Fetch-Site) on cross-site requests, so one from another site is refused; tools
//      without a browser (curl, the House and Screen Time agents) send neither and are unaffected.
//    * Security headers on every response (no framing, no MIME sniffing, no referrers to other sites).
//
// 2. identify(): who is asking. In order:
//    * a verified proxy identity (Cloudflare Access or a trusted reverse proxy; see trust.js),
//    * Marquee's own sign-in: a session cookie from /signin (passwords made with
//      `node setup.js user add`), stored hashed in .marquee.db,
//    * the shared "Home network" account, only for visitors directly on the home network
//      (private, loopback or Tailscale addresses) and only while HOME_NETWORK_ACCESS=shared.
//    A visitor from the internet never gets the shared account, so a port forwarded on the router
//    by mistake shows a sign-in page instead of the library.
//
// 3. gate(): anything but the public paths needs one of those identities.
import { currentLanguage, tr, translate } from './i18n.js';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const COOKIE = 'marquee_session';
export const TV_HEADER = 'x-marquee-tv';
export const SESSION_HEADER = 'x-marquee-session';
const IDENTITY = 'cf-access-authenticated-user-email';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const MIN_PASSWORD = 10;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ---------- addresses ----------
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/i, '').replace(/%.*$/, '').replace(/^\[|\]$/g, '').trim();

// Loopback, RFC 1918, CGNAT (Tailscale), link-local, IPv6 ULA/link-local: "at home".
export function isPrivateAddress(address) {
  const ip = cleanIp(address);
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return false;
}

// The visitor's own address: the forwarded one when a trusted proxy sent the request (sanitize()
// strips forwarding headers from anyone else), else the connection's.
export function clientAddress(req) {
  const h = req.headers;
  const forwarded = h['cf-connecting-ip'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',').pop();
  return cleanIp(forwarded || req.socket?.remoteAddress);
}

// Through Cloudflare, or from an address outside the home network.
export const isRemote = (req) => Boolean(req.headers['cf-ray']) || !isPrivateAddress(clientAddress(req));

// ---------- hosts and origins ----------
const HOME_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.ts.net'];

export function parseHosts(list) {
  return String(list || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((s) => s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''));
}

const hostOnly = (value) => {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']'));
  return v.replace(/:\d+$/, '');
};

export function hostAllowed(hostHeader, allowed = []) {
  const host = hostOnly(hostHeader).replace(/\.$/, '');
  if (!host) return false;
  if (net.isIP(host) || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!host.includes('.')) return /^[a-z0-9-]+$/.test(host);
  if (HOME_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return allowed.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) : host === a));
}

// ---------- passwords ----------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash || '', 'base64url');
  if (want.length !== 64) return false;
  const got = await scrypt(String(password), Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, want);
}

function scrypt(password, salt, opts = {}) {
  const o = { ...SCRYPT, ...opts };
  return new Promise((resolve, reject) => crypto.scrypt(password.normalize('NFC'), salt, 64, o, (err, key) => (err ? reject(err) : resolve(key))));
}

export function passwordProblem(password, email = '') {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > 256) return 'That password is too long (256 characters at most).';
  if (email && p.toLowerCase().includes(String(email).split('@')[0].toLowerCase()) && String(email).split('@')[0].length >= 4) return 'Don’t use your email name in the password.';
  return null;
}

const normalEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalEmail(e)) && normalEmail(e).length <= 254;
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ---------- the store (.marquee.db) ----------
export function openAuthStore(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, '.marquee.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS logins (
      email TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES logins(email) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      address TEXT,
      agent TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email);
    -- TVs signed in from a phone (tv.js). Not tied to a password: people who sign in through
    -- Cloudflare Access or a proxy have none, and their TVs need a session all the same.
    CREATE TABLE IF NOT EXISTS tv_sessions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      address TEXT,
      agent TEXT
    );
    CREATE INDEX IF NOT EXISTS tv_sessions_email ON tv_sessions(email);
  `);
  const dropTvs = (e) => db.prepare('DELETE FROM tv_sessions WHERE email = ?').run(e).changes;
  return {
    db,
    login: (email) => db.prepare('SELECT * FROM logins WHERE email = ?').get(normalEmail(email)) || null,
    async setPassword(email, password) {
      const e = normalEmail(email);
      if (!validEmail(e)) throw httpError(400, 'That doesn’t look like an email address.');
      const problem = passwordProblem(password, e);
      if (problem) throw httpError(400, problem);
      const hash = await hashPassword(password);
      const now = Date.now();
      db.prepare(`INSERT INTO logins (email, password, created_at, changed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET password = excluded.password, changed_at = excluded.changed_at`).run(e, hash, now, now);
      db.prepare('DELETE FROM sessions WHERE email = ?').run(e); // a new password signs everyone out
      dropTvs(e);
    },
    remove(email) {
      const e = normalEmail(email);
      db.prepare('DELETE FROM sessions WHERE email = ?').run(e);
      dropTvs(e);
      return db.prepare('DELETE FROM logins WHERE email = ?').run(e).changes > 0;
    },
    list: () => db.prepare(`SELECT l.email, l.created_at AS createdAt, l.changed_at AS changedAt,
      (SELECT COUNT(*) FROM sessions s WHERE s.email = l.email AND s.expires_at > ?) AS sessions,
      (SELECT MAX(last_seen) FROM sessions s WHERE s.email = l.email) AS lastSeen FROM logins l ORDER BY l.email`).all(Date.now()),
    revokeSessions: (email) => db.prepare('DELETE FROM sessions WHERE email = ?').run(normalEmail(email)).changes + dropTvs(normalEmail(email)),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM logins').get().n,
    close: () => db.close(),
  };
}

// ---------- failed sign-ins ----------
// Per account: after 5 misses, each further try waits 30 s, doubling up to 15 min. Per address:
// 30 misses in 15 minutes locks that address out for 15 minutes.
export function createLimiter({ now = () => Date.now() } = {}) {
  const accounts = new Map();
  const addresses = new Map();
  const prune = () => {
    if (accounts.size + addresses.size < 5000) return;
    const t = now();
    for (const m of [accounts, addresses]) for (const [k, v] of m) if (t - v.last > 3600_000) m.delete(k);
  };
  return {
    // Milliseconds to wait before another try, or 0.
    wait(email, address) {
      const t = now();
      const a = accounts.get(email);
      const ip = addresses.get(address);
      let ms = 0;
      if (a && a.fails >= 5) ms = Math.max(ms, a.last + Math.min(30_000 * 2 ** (a.fails - 5), 900_000) - t);
      if (ip && ip.fails >= 30 && t - ip.first < 900_000) ms = Math.max(ms, ip.first + 900_000 - t);
      return Math.max(0, ms);
    },
    fail(email, address) {
      const t = now();
      prune();
      const a = accounts.get(email) || { fails: 0, last: 0 };
      accounts.set(email, { fails: a.fails + 1, last: t });
      let ip = addresses.get(address);
      if (!ip || t - ip.first > 900_000) ip = { fails: 0, first: t, last: t };
      addresses.set(address, { ...ip, fails: ip.fails + 1, last: t });
    },
    success(email) { accounts.delete(email); },
  };
}

// ---------- the request side ----------
export function createAuth({
  dataDir,
  homeNetworkAccess = process.env.HOME_NETWORK_ACCESS || 'shared',
  sessionDays = Number(process.env.SESSION_DAYS) || 30,
  publicUrl = process.env.PUBLIC_URL || '',
  allowedHosts = process.env.ALLOWED_HOSTS || '',
  now = () => Date.now(),
} = {}) {
  const store = openAuthStore(dataDir);
  const limiter = createLimiter({ now });
  const mode = String(homeNetworkAccess).toLowerCase() === 'signin' ? 'signin' : 'shared';
  const days = Math.min(Math.max(sessionDays, 1), 365);
  const hosts = parseHosts(allowedHosts);
  let publicHost = '';
  try { if (publicUrl) { publicHost = new URL(publicUrl).hostname.toLowerCase(); hosts.push(publicHost); } } catch { /* config-check reports it */ }
  // Spent on unknown emails so a miss takes as long as a wrong password (no account probing by timing).
  const decoy = hashPassword(crypto.randomBytes(16).toString('hex'));

  // Public share links (/c/) stay embeddable: their clip cards offer an embedded player.
  function setSecurityHeaders(res, embeddable) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!embeddable) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', `${embeddable ? '' : "frame-ancestors 'self'; "}base-uri 'self'; object-src 'none'`);
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }

  // Throws for requests Marquee won't handle at all.
  function guard(req, res) {
    setSecurityHeaders(res, /^\/c(\/|$)/.test(String(req.url || '')));
    const throughCloudflare = Boolean(req.headers['cf-ray']); // Cloudflare only routes your own hostnames
    if (!throughCloudflare && !hostAllowed(req.headers.host, hosts)) {
      throw httpError(421, `Marquee doesn’t answer to “${hostOnly(req.headers.host)}”. Add it to ALLOWED_HOSTS in .env if it’s yours.`);
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    // The TV app (tv/tizen) runs from the TV's own files, so its Origin is "null" or file://. It marks its
    // requests with X-Marquee-TV: a web page can't send a custom header to another site without a CORS
    // preflight, and Marquee approves none, so no other site can make a browser send one here.
    if (req.headers[TV_HEADER]) return;
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    // Pages with Referrer-Policy: no-referrer make browsers send `Origin: null` even for their own forms;
    // Sec-Fetch-Site still tells the truth there (and pages can't set it).
    if (origin === 'null' && fetchSite === 'same-origin') return;
    if (origin !== undefined) {
      let host = '';
      try { host = origin === 'null' ? '' : new URL(origin).host.toLowerCase(); } catch { /* refused below */ }
      const own = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map((s) => String(s).split(',')[0].trim().toLowerCase());
      const ok = host && (own.includes(host) || (publicHost && hostOnly(host) === publicHost) || hosts.includes(hostOnly(host)));
      if (!ok) throw httpError(403, 'This request came from another website, so Marquee refused it.');
    } else if (fetchSite === 'cross-site') {
      throw httpError(403, 'This request came from another website, so Marquee refused it.');
    }
  }

  // The session cookie, or the X-Marquee-Session header the TV app sends (it has no cookie jar for Marquee).
  function sessionCookie(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    const header = req.headers[SESSION_HEADER];
    return header && /^[A-Za-z0-9_-]{20,100}$/.test(String(header)) ? String(header) : null;
  }

  // A session for a person without a password prompt: a TV that person approved from their phone.
  function createSession(req, email, agent) {
    const e = normalEmail(email);
    if (!validEmail(e)) throw httpError(400, 'Only people with an email address can sign in a TV.');
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    store.db.prepare('INSERT INTO tv_sessions (id, email, created_at, expires_at, last_seen, address, agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tokenHash(token), e, t, t + days * 86400_000, t, clientAddress(req), String(agent || '').slice(0, 200));
    store.db.prepare('DELETE FROM tv_sessions WHERE expires_at <= ?').run(t);
    return token;
  }

  function sessionFor(token) {
    if (!token || token.length > 100) return null;
    const id = tokenHash(token);
    for (const table of ['sessions', 'tv_sessions']) {
      const row = store.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!row) continue;
      const t = now();
      if (row.expires_at <= t) { store.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id); return null; }
      if (t - row.last_seen > 3600_000) {
        // Sliding expiry, capped at a year from sign-in.
        const expires = Math.min(t + days * 86400_000, row.created_at + 365 * 86400_000);
        store.db.prepare(`UPDATE ${table} SET last_seen = ?, expires_at = ? WHERE id = ?`).run(t, expires, row.id);
      }
      return row;
    }
    return null;
  }

  // Sets req.auth = { via: 'proxy' | 'session' | 'home' | null, remote, email }.
  function identify(req) {
    const remote = isRemote(req);
    const proxied = normalEmail(req.headers[IDENTITY]);
    if (proxied) return (req.auth = { via: 'proxy', remote, email: proxied });
    const session = sessionFor(sessionCookie(req));
    if (session) {
      req.headers[IDENTITY] = session.email; // the rest of Marquee reads identity from here
      return (req.auth = { via: 'session', remote, email: session.email, session: session.id });
    }
    if (!remote && mode === 'shared') return (req.auth = { via: 'home', remote, email: null });
    return (req.auth = { via: null, remote, email: null });
  }

  const secure = (req) => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '') || Boolean(req.socket?.encrypted);
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

  async function signIn(req, email, password) {
    const e = normalEmail(email);
    const address = clientAddress(req);
    const wait = limiter.wait(e, address);
    if (wait) throw httpError(429, `Too many tries. Wait ${Math.ceil(wait / 60_000)} min and try again.`, { retryAfter: Math.ceil(wait / 1000) });
    const login = validEmail(e) ? store.login(e) : null;
    const ok = login ? await verifyPassword(password, login.password) : (await verifyPassword(password, await decoy), false);
    if (!ok) { limiter.fail(e, address); throw httpError(401, 'That email and password don’t match.'); }
    limiter.success(e);
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    store.db.prepare('INSERT INTO sessions (id, email, created_at, expires_at, last_seen, address, agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tokenHash(token), e, t, t + days * 86400_000, t, address, String(req.headers['user-agent'] || '').slice(0, 200));
    store.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
    return { email: e, setCookie: cookie(req, token, days * 86400) };
  }

  function signOut(req) {
    const token = sessionCookie(req);
    if (token) for (const table of ['sessions', 'tv_sessions']) store.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(tokenHash(token));
    return cookie(req, '', 0);
  }

  async function changePassword(req, current, next) {
    if (req.auth?.via !== 'session') throw httpError(400, 'Your password is managed where you sign in (Cloudflare or your proxy).');
    const login = store.login(req.auth.email);
    if (!login || !(await verifyPassword(current, login.password))) {
      limiter.fail(req.auth.email, clientAddress(req));
      throw httpError(403, 'Your current password isn’t right.');
    }
    await store.setPassword(req.auth.email, next); // signs out every session
    return signIn(req, req.auth.email, next);
  }

  return {
    mode,
    store,
    guard,
    identify,
    signIn,
    signOut,
    createSession,
    changePassword,
    hasLogins: () => store.count() > 0,
  };
}

// ---------- the sign-in page ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function safeNext(next) {
  const n = String(next || '/');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') && !/[\r\n]/.test(n) ? n : '/';
}

export function signInPage({ next = '/', error = '', hasLogins = true, remote = false } = {}) {
  const message = error ? `<p class="err" role="alert">${esc(translate(error))}</p>` : '';
  const help = hasLogins
    ? tr('Ask the server’s owner if you don’t have a password.')
    : tr('No one can sign in yet. On the server, run <code>node setup.js user add you@example.com</code> to create an account.');
  const langLink = (code, name) => (currentLanguage() === code ? `<b>${name}</b>` : `<a href="/signin?lang=${code}&amp;next=${encodeURIComponent(safeNext(next))}">${name}</a>`);
  return `<!doctype html><html lang="${currentLanguage()}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${tr('Sign in · Marquee')}</title><style>
:root{color-scheme:dark;--bg:#0d0d10;--card:#17171c;--line:#2a2a33;--text:#ecebf0;--dim:#9a99a6;--accent:#f0a83a}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{margin:0 0 4px;font-size:22px;letter-spacing:.02em}p{margin:0 0 18px;color:var(--dim);font-size:14px}
label{display:block;font-size:13px;color:var(--dim);margin:14px 0 6px}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#0f0f13;color:var(--text);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#1a1205;font:600 15px system-ui,sans-serif;cursor:pointer}
.err{color:#ff8a80;background:#2a1414;border-radius:8px;padding:10px 12px;margin:0 0 6px}code{font-size:12px;color:var(--text)}
.foot{margin:18px 0 0;font-size:12px}</style></head><body><main>
<h1>Marquee</h1><p>${remote ? tr('You’re connecting from outside the home network. ') : ''}${tr('Sign in to carry on.')}</p>${message}
<form method="post" action="/api/auth/login">
<input type="hidden" name="next" value="${esc(safeNext(next))}">
<label for="email">${tr('Email')}</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">${tr('Password')}</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">${tr('Sign in')}</button></form>
<p class="foot">${help}</p><p class="foot">${langLink('en', 'English')} · ${langLink('sv', 'Svenska')}</p></main></body></html>`;
}
