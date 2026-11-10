// Marquee as an OpenID Connect sign-in provider, so Cloudflare Access (or any OIDC client) can use
// Marquee's own accounts instead of its one-time email codes.
//
// With Access set to this provider only ("instant auth"), a visitor without an Access cookie goes
// Marquee → Cloudflare → /c/oidc/authorize. Someone with a Marquee session cookie is sent straight
// back with a code, so they never see a login page; anyone else gets Marquee's sign-in form.
// Cloudflare then swaps the code for an ID token (/c/oidc/token) and checks its signature against
// /c/oidc/jwks. Everything lives under /c/, which Access already lets through.
//
// .env: OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (any long random strings, also entered in Cloudflare)
// and OIDC_REDIRECT_URIS (comma-separated; for Access: https://<team>.cloudflareaccess.com/cdn-cgi/access/callback).
// The signing key is made on first use and kept in .marquee-oidc-key.pem in the data folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeNext, signInPage, clientAddress } from './auth.js';

const CODE_MS = 60_000;
const TOKEN_S = 300;
const PREFIX = '/c/oidc';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const sameSecret = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a).length > 0;
};

export function oidcSettings() {
  const redirectUris = String(process.env.OIDC_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { clientId: String(process.env.OIDC_CLIENT_ID || '').trim(), clientSecret: String(process.env.OIDC_CLIENT_SECRET || '').trim(), redirectUris };
}

export function createOidc({
  dataDir, auth, publicUrl = process.env.PUBLIC_URL || '', settings = oidcSettings(),
  nameFor = () => '', onSignIn = () => {}, now = () => Date.now(),
} = {}) {
  const { clientId, clientSecret, redirectUris } = settings;
  const base = String(publicUrl).replace(/\/+$/, '');
  const configured = Boolean(clientId && clientSecret.length >= 16 && redirectUris.length && /^https?:\/\//.test(base));
  const issuer = `${base}${PREFIX}`;
  const codes = new Map();   // code -> { email, redirectUri, nonce, challenge, expires }
  const tokens = new Map();  // access token -> { email, expires }

  let key = null;
  function signingKey() {
    if (key) return key;
    const file = path.join(dataDir, '.marquee-oidc-key.pem');
    let pem = null;
    try { pem = fs.readFileSync(file, 'utf8'); } catch { /* first run */ }
    if (!pem) {
      pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
      fs.writeFileSync(file, pem, { mode: 0o600 });
    }
    const privateKey = crypto.createPrivateKey(pem);
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
    const kid = crypto.createHash('sha256').update(`${jwk.n}.${jwk.e}`).digest('base64url').slice(0, 16);
    key = { privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
    return key;
  }

  function idToken(email, nonce, authTime) {
    const { privateKey, jwk } = signingKey();
    const iat = Math.floor(now() / 1000);
    const claims = { iss: issuer, sub: email, aud: clientId, iat, exp: iat + TOKEN_S, auth_time: authTime, email, email_verified: true };
    const name = nameFor(email);
    if (name) claims.name = name;
    if (nonce) claims.nonce = nonce;
    const head = `${b64url({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })}.${b64url(claims)}`;
    return `${head}.${crypto.sign('sha256', Buffer.from(head), privateKey).toString('base64url')}`;
  }

  const prune = () => {
    const t = now();
    for (const m of [codes, tokens]) for (const [k, v] of m) if (v.expires <= t) m.delete(k);
  };

  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...extra });
    res.end(JSON.stringify(body));
    return true;
  };
  const html = (res, status, body) => {
    // Unlike the rest of /c/, sign-in pages must never sit in someone else's frame (clickjacking).
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" });
    res.end(body);
    return true;
  };
  const problem = (res, text) => html(res, 400, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Marquee</title><body style="font:16px system-ui;background:#0d0d10;color:#ecebf0;display:grid;place-items:center;min-height:90vh"><p>${text}</p></body>`);

  async function readForm(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 8192) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(c); }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
  }

  // The authorize request, checked. Returns { error } (shown, never redirected: the redirect itself
  // may be the attack) or the parsed request.
  function authorizeRequest(params) {
    const q = (k) => String(params.get(k) || '');
    if (q('client_id') !== clientId) return { error: 'Unknown app.' };
    const redirectUri = q('redirect_uri');
    if (!redirectUris.includes(redirectUri)) return { error: 'That sign-in return address isn’t allowed.' };
    const back = (extra) => { const u = new URL(redirectUri); for (const [k, v] of Object.entries({ ...extra, state: q('state') || undefined })) if (v !== undefined) u.searchParams.set(k, v); return u.toString(); };
    if (q('response_type') !== 'code') return { redirect: back({ error: 'unsupported_response_type' }) };
    if (!q('scope').split(/\s+/).includes('openid')) return { redirect: back({ error: 'invalid_scope' }) };
    const challenge = q('code_challenge');
    if (challenge && (q('code_challenge_method') || 'plain') !== 'S256') return { redirect: back({ error: 'invalid_request', error_description: 'Only S256 PKCE.' }) };
    return { redirectUri, back, nonce: q('nonce').slice(0, 200), challenge };
  }

  function issueCode(res, request, email) {
    prune();
    const code = crypto.randomBytes(32).toString('base64url');
    codes.set(code, { email, redirectUri: request.redirectUri, nonce: request.nonce, challenge: request.challenge, authTime: Math.floor(now() / 1000), expires: now() + CODE_MS });
    res.writeHead(302, { Location: request.back({ code }), 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  function clientAuth(req, body) {
    let id = body.client_id; let secret = body.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (basic) {
      const raw = Buffer.from(basic[1], 'base64').toString();
      const i = raw.indexOf(':');
      id = decodeURIComponent(raw.slice(0, i)); secret = decodeURIComponent(raw.slice(i + 1));
    }
    return id === clientId && sameSecret(secret || '', clientSecret);
  }

  // Returns true when it handled the request.
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== PREFIX && !p.startsWith(`${PREFIX}/`)) return false;
    if (!configured) return json(res, 404, { error: 'not_configured' });

    if (p === `${PREFIX}/.well-known/openid-configuration`) {
      return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'],
        claims_supported: ['sub', 'email', 'email_verified', 'name'],
      }, { 'Cache-Control': 'public, max-age=3600' });
    }
    if (p === `${PREFIX}/jwks`) return json(res, 200, { keys: [signingKey().jwk] }, { 'Cache-Control': 'public, max-age=3600' });

    if (p === `${PREFIX}/authorize` && (req.method === 'GET' || req.method === 'HEAD')) {
      const request = authorizeRequest(url.searchParams);
      if (request.error) return problem(res, request.error);
      if (request.redirect) { res.writeHead(302, { Location: request.redirect }); res.end(); return true; }
      // Only Marquee's own session counts here: under /c/ nobody carries a Cloudflare identity.
      if (req.auth?.via === 'session' && req.auth.email) return issueCode(res, request, req.auth.email);
      return html(res, 200, signInPage({ next: `${p}${url.search}`, hasLogins: true, remote: false, action: `${PREFIX}/login` }));
    }

    if (p === `${PREFIX}/login` && req.method === 'POST') {
      const body = await readForm(req);
      const next = safeNext(body.next);
      const target = new URL(next, 'http://x');
      if (target.pathname !== `${PREFIX}/authorize`) return problem(res, 'Open Marquee again to sign in.');
      const request = authorizeRequest(target.searchParams);
      if (request.error) return problem(res, request.error);
      try {
        if (!body.email || !body.password) throw Object.assign(new Error('Enter your email and password.'), { status: 400 });
        const { email, setCookie } = await auth.signIn(req, body.email, body.password);
        onSignIn(req, email);
        res.setHeader('Set-Cookie', setCookie);
        if (request.redirect) { res.writeHead(302, { Location: request.redirect }); res.end(); return true; }
        return issueCode(res, request, email);
      } catch (err) {
        if (!err.status) throw err;
        return html(res, err.status === 429 ? 429 : 200, signInPage({ next, error: err.message, hasLogins: true, action: `${PREFIX}/login` }));
      }
    }

    if (p === `${PREFIX}/token` && req.method === 'POST') {
      const body = await readForm(req);
      if (!clientAuth(req, body)) return json(res, 401, { error: 'invalid_client' }, { 'WWW-Authenticate': 'Basic realm="marquee"' });
      if (body.grant_type !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
      prune();
      const grant = codes.get(String(body.code || ''));
      codes.delete(String(body.code || '')); // single use, even when the rest is wrong
      if (!grant || grant.expires <= now() || grant.redirectUri !== body.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
      if (grant.challenge) {
        const got = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
        if (got !== grant.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE check failed.' });
      }
      if (!auth.hasPassword(grant.email)) return json(res, 400, { error: 'invalid_grant' }); // account removed meanwhile
      const accessToken = crypto.randomBytes(32).toString('base64url');
      tokens.set(accessToken, { email: grant.email, expires: now() + TOKEN_S * 1000 });
      console.log(`[oidc] signed in ${grant.email} from ${clientAddress(req)}`);
      return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_S, id_token: idToken(grant.email, grant.nonce, grant.authTime) });
    }

    if (p === `${PREFIX}/userinfo`) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
      prune();
      const t = bearer && tokens.get(bearer);
      if (!t) return json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      const name = nameFor(t.email);
      return json(res, 200, { sub: t.email, email: t.email, email_verified: true, ...(name && { name }) });
    }
    return json(res, 404, { error: 'not_found' });
  }

  return { configured, issuer, handle };
}
