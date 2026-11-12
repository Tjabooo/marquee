import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createAuth } from '../src/auth.js';
import { createOidc } from '../src/oidc.js';

const REDIRECT = 'https://team.cloudflareaccess.com/cdn-cgi/access/callback';
const SECRET = 'a-long-client-secret-for-tests';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lilin-oidc-'));

// A request that can be read as a stream (form posts) and carries cookies/headers like a real one.
function req({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const r = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(r, { method, url, headers: { host: 'lilin.example.com', 'cf-ray': 'x', 'cf-connecting-ip': '81.1.2.3', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  return r;
}
function res() {
  const out = { status: 0, headers: {}, body: '' };
  return Object.assign(out, {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    writeHead(s, h = {}) { out.status = s; for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v; },
    end(b) { out.body = b ? String(b) : ''; },
  });
}
const cookieOf = (setCookie) => String(setCookie).split(';')[0];

async function setup() {
  const dataDir = await tmp();
  const auth = createAuth({ dataDir, publicUrl: 'https://lilin.example.com' });
  await auth.store.setPassword('friend@example.com', 'popcorn and films');
  const oidc = createOidc({
    dataDir, auth, publicUrl: 'https://lilin.example.com',
    settings: { clientId: 'cloudflare', clientSecret: SECRET, redirectUris: [REDIRECT] }, nameFor: () => 'Friend',
  });
  const call = async (opts) => {
    const r = req(opts);
    auth.identify(r);
    const out = res();
    const handled = await oidc.handle(r, out, new URL(r.url, 'http://x'));
    return { handled, ...out };
  };
  return { auth, oidc, call, dataDir };
}

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const authorizeUrl = (extra = {}) => `/c/oidc/authorize?${new URLSearchParams({
  client_id: 'cloudflare', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email profile', state: 'st4te', nonce: 'n0nce',
  code_challenge: challenge, code_challenge_method: 'S256', ...extra })}`;
const basic = `Basic ${Buffer.from(`cloudflare:${SECRET}`).toString('base64')}`;

test('a Lilin session goes straight through: code, token, signed ID token', async () => {
  const { auth, call } = await setup();
  const { setCookie } = await auth.signIn(req(), 'friend@example.com', 'popcorn and films');
  const a = await call({ url: authorizeUrl(), headers: { cookie: cookieOf(setCookie) } });
  assert.equal(a.status, 302);
  const back = new URL(a.headers.location);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st4te');
  const code = back.searchParams.get('code');
  assert.ok(code);

  const form = (o) => new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, ...o }).toString();
  const bad = await call({ method: 'POST', url: '/c/oidc/token', headers: { authorization: `Basic ${Buffer.from('cloudflare:wrong').toString('base64')}` }, body: form() });
  assert.equal(bad.status, 401);

  // the failed client auth above didn't spend the code; a right one does, once
  const t = await call({ method: 'POST', url: '/c/oidc/token', headers: { authorization: basic }, body: form() });
  assert.equal(t.status, 200, t.body);
  const tok = JSON.parse(t.body);
  const [h, p, sig] = tok.id_token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.email, 'friend@example.com');
  assert.equal(claims.aud, 'cloudflare');
  assert.equal(claims.iss, 'https://lilin.example.com/c/oidc');
  assert.equal(claims.nonce, 'n0nce');
  assert.equal(claims.name, 'Friend');

  const jwks = JSON.parse((await call({ url: '/c/oidc/jwks' })).body);
  const kid = JSON.parse(Buffer.from(h, 'base64url')).kid;
  const jwk = jwks.keys.find((k) => k.kid === kid);
  assert.ok(jwk, 'signing key published');
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url')), true);

  const info = await call({ url: '/c/oidc/userinfo', headers: { authorization: `Bearer ${tok.access_token}` } });
  assert.equal(JSON.parse(info.body).email, 'friend@example.com');

  const again = await call({ method: 'POST', url: '/c/oidc/token', headers: { authorization: basic }, body: form() });
  assert.equal(JSON.parse(again.body).error, 'invalid_grant', 'codes are single use');
});

test('PKCE and redirect address are enforced; unknown return addresses are never redirected to', async () => {
  const { auth, call } = await setup();
  const { setCookie } = await auth.signIn(req(), 'friend@example.com', 'popcorn and films');
  const evil = await call({ url: authorizeUrl({ redirect_uri: 'https://evil.example/cb' }), headers: { cookie: cookieOf(setCookie) } });
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.location, undefined);
  const a = await call({ url: authorizeUrl(), headers: { cookie: cookieOf(setCookie) } });
  const code = new URL(a.headers.location).searchParams.get('code');
  const t = await call({ method: 'POST', url: '/c/oidc/token', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'wrong', client_id: 'cloudflare', client_secret: SECRET }).toString() });
  assert.equal(JSON.parse(t.body).error, 'invalid_grant');
});

test('without a session the sign-in form is shown, and signing in there returns a code', async () => {
  const { call } = await setup();
  const page = await call({ url: authorizeUrl() });
  assert.equal(page.status, 200);
  assert.match(page.body, /action="\/c\/oidc\/login"/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  const next = authorizeUrl();
  const wrong = await call({ method: 'POST', url: '/c/oidc/login', body: new URLSearchParams({ email: 'friend@example.com', password: 'nope nope nope', next }).toString() });
  assert.equal(wrong.status, 200);
  assert.match(wrong.body, /don’t match/);
  const ok = await call({ method: 'POST', url: '/c/oidc/login', body: new URLSearchParams({ email: 'friend@example.com', password: 'popcorn and films', next }).toString() });
  assert.equal(ok.status, 302);
  assert.ok(new URL(ok.headers.location).searchParams.get('code'));
  assert.match(ok.headers['set-cookie'], /^lilin_session=/);
  const elsewhere = await call({ method: 'POST', url: '/c/oidc/login', body: new URLSearchParams({ email: 'friend@example.com', password: 'popcorn and films', next: '/api/me' }).toString() });
  assert.equal(elsewhere.status, 400, 'the form only continues an authorize request');
});

test('people signed in through Cloudflare pick their first password once, for themselves only', async () => {
  const { auth } = await setup();
  const viaCf = req({ headers: { 'cf-access-authenticated-user-email': 'old@example.com' } });
  auth.identify(viaCf);
  assert.equal(viaCf.auth.via, 'proxy');
  assert.equal(auth.hasPassword('old@example.com'), false);
  await assert.rejects(auth.setFirstPassword(viaCf, 'short'), /at least 10/);
  const { setCookie } = await auth.setFirstPassword(viaCf, 'a fine new password');
  assert.match(setCookie, /^lilin_session=/);
  assert.equal(auth.hasPassword('old@example.com'), true);
  await assert.rejects(auth.setFirstPassword(viaCf, 'another password!!'), (e) => e.status === 409);
  const viaSession = req({ headers: { cookie: cookieOf(setCookie) } });
  auth.identify(viaSession);
  await assert.rejects(auth.setFirstPassword(viaSession, 'another password!!'), (e) => e.status === 400);
  // and through Cloudflare they can now change it like anyone else
  const changed = await auth.changePassword(viaCf, 'a fine new password', 'a better new password');
  assert.match(changed.setCookie, /^lilin_session=/);
});

test('invite page: new email joins with a password and is signed straight in; taken emails need a password link', async (t) => {
  const list = new Set(['old@example.com']);
  const cf = http.createServer(async (rq, rs) => {
    let body = ''; for await (const c of rq) body += c;
    if (rq.method === 'PATCH') { const b = JSON.parse(body); for (const i of b.append || []) list.add(i.value); }
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ success: true, result: rq.method === 'GET' ? [...list].map((value) => ({ value })) : {} }));
  });
  await new Promise((r) => cf.listen(0, '127.0.0.1', r));
  t.after(() => cf.close());
  Object.assign(process.env, { CF_API_BASE: `http://127.0.0.1:${cf.address().port}`, CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ACCESS_LIST_ID: 'l' });
  const invites = await import(`../src/invites.js?${Date.now()}`);
  const { auth, dataDir } = await setup();
  invites.initInvites({ dataDir });
  const post = async (token, fields) => {
    const r = req({ method: 'POST', url: `/c/i/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    const out = res();
    await invites.handlePublic(r, out, new URL(r.url, 'http://x'), { auth });
    return out;
  };
  const tokenOf = (inv) => inv.url.split('/').pop();
  const fake = req();

  const open = tokenOf(invites.createInvite(fake, 'Pal'));
  let r = await post(open, { email: 'old@example.com', password: 'twelve chars!', again: 'twelve chars!' });
  assert.match(r.body, /already has access/, 'an open invite cannot claim someone already on the list');
  r = await post(open, { email: 'friend@example.com', password: 'twelve chars!', again: 'twelve chars!' });
  assert.match(r.body, /already has a Lilin account/);
  r = await post(open, { email: 'new@example.com', password: 'twelve chars!', again: 'twelve charz!' });
  assert.match(r.body, /aren’t the same/);
  r = await post(open, { email: 'new@example.com', password: 'twelve chars!', again: 'twelve chars!' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  assert.match(r.headers['set-cookie'], /^lilin_session=/);
  assert.ok(list.has('new@example.com'));
  assert.equal(auth.hasPassword('new@example.com'), true);
  r = await post(open, { email: 'other@example.com', password: 'twelve chars!', again: 'twelve chars!' });
  assert.match(r.body, /already been used/);

  const link = tokenOf(invites.createInvite(fake, 'Password for Old', 'old@example.com'));
  r = await post(link, { email: 'someone@else.com', password: 'my own password', again: 'my own password' });
  assert.equal(r.status, 303, 'a password link sets the password of the email it was made for');
  assert.equal(auth.hasPassword('old@example.com'), true);
  assert.equal(auth.hasPassword('someone@else.com'), false);
  assert.ok(!list.has('someone@else.com'));
});
