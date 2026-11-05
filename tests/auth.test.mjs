import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createAuth, createLimiter, hashPassword, verifyPassword, hostAllowed, isPrivateAddress, isRemote, safeNext, signInPage, COOKIE,
} from '../src/auth.js';
import { userCommand } from '../src/setup/users.js';

const fakeReq = ({ ip = '192.168.1.20', headers = {}, method = 'GET' } = {}) => ({ method, headers: { host: '192.168.1.5:8080', ...headers }, socket: { remoteAddress: ip } });
const fakeRes = () => { const h = {}; return { h, setHeader: (k, v) => { h[k.toLowerCase()] = v; } }; };
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'marquee-auth-'));

test('home, Tailscale and loopback addresses are private; the internet is not', () => {
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.50.67', '100.64.0.1', '100.127.1.1', 'fd7a:115c::1', 'fe80::1', '::ffff:192.168.1.2'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', '', 'nonsense']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(isRemote(fakeReq({ ip: '127.0.0.1', headers: { 'cf-ray': 'x' } })), true, 'through Cloudflare');
  assert.equal(isRemote(fakeReq({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } })), true, 'a local proxy forwarding an internet visitor');
  assert.equal(isRemote(fakeReq({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '192.168.1.9' } })), false);
  assert.equal(isRemote(fakeReq({ ip: '81.2.3.4' })), true, 'a forwarded router port');
});

test('only own and home-network host names are answered (DNS rebinding)', () => {
  for (const h of ['192.168.1.5:8080', 'localhost:8080', '[::1]:8080', 'geofront:8080', 'nas.local', 'box.lan', 'tv.home.arpa', 'pc.tail1234.ts.net', 'media.example.com'])
    assert.equal(hostAllowed(h, ['media.example.com']), true, h);
  for (const h of ['evil.example.net', 'rebind.attacker.io:8080', '', 'a b', 'media.example.com.evil.io'])
    assert.equal(hostAllowed(h, ['media.example.com']), false, h);
  assert.equal(hostAllowed('x.example.org', ['*.example.org']), true);
});

test('passwords are salted scrypt hashes and verify only with the right password', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse batterY', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('repeated misses slow an account down and lock out a noisy address', () => {
  let t = 1_000_000;
  const l = createLimiter({ now: () => t });
  for (let i = 0; i < 4; i++) l.fail('a@x.se', '1.1.1.1');
  assert.equal(l.wait('a@x.se', '1.1.1.1'), 0);
  l.fail('a@x.se', '1.1.1.1');
  assert.equal(l.wait('a@x.se', '1.1.1.1'), 30_000);
  t += 30_000;
  assert.equal(l.wait('a@x.se', '1.1.1.1'), 0);
  l.fail('a@x.se', '1.1.1.1');
  assert.equal(l.wait('a@x.se', '1.1.1.1'), 60_000);
  l.success('a@x.se');
  assert.equal(l.wait('a@x.se', '1.1.1.1'), 0);
  for (let i = 0; i < 30; i++) l.fail(`u${i}@x.se`, '2.2.2.2');
  assert.ok(l.wait('new@x.se', '2.2.2.2') > 0, 'address locked out');
  assert.equal(l.wait('new@x.se', '3.3.3.3'), 0);
});

test('guard refuses foreign hosts and cross-site writes, and sets security headers', async () => {
  const auth = createAuth({ dataDir: await tmp(), publicUrl: 'https://media.example.com' });
  const res = fakeRes();
  auth.guard(fakeReq(), res);
  assert.equal(res.h['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.h['x-content-type-options'], 'nosniff');
  assert.throws(() => auth.guard(fakeReq({ headers: { host: 'evil.example.net' } }), fakeRes()), { status: 421 });
  auth.guard(fakeReq({ ip: '127.0.0.1', headers: { host: 'localhost:8080', 'cf-ray': 'abc' } }), fakeRes()); // Cloudflare's own routing
  const post = (headers) => auth.guard(fakeReq({ method: 'POST', headers }), fakeRes());
  assert.throws(() => post({ origin: 'https://evil.example.net' }), { status: 403 });
  assert.throws(() => post({ origin: 'null' }), { status: 403 });
  assert.throws(() => post({ 'sec-fetch-site': 'cross-site' }), { status: 403 });
  post({ origin: 'http://192.168.1.5:8080' });
  post({ origin: 'https://media.example.com' });
  post({}); // curl, the House agent
  auth.store.close();
});

test('sessions identify people; the shared account is for the home network only', async () => {
  const dir = await tmp();
  const auth = createAuth({ dataDir: dir });
  await auth.store.setPassword('ana@example.com', 'a long password here');
  assert.deepEqual(auth.identify(fakeReq()).via, 'home');
  assert.equal(auth.identify(fakeReq({ ip: '8.8.8.8' })).via, null);
  assert.equal(auth.identify(fakeReq({ ip: '127.0.0.1', headers: { 'cf-ray': 'x' } })).via, null);
  await assert.rejects(auth.signIn(fakeReq({ ip: '8.8.8.8' }), 'ana@example.com', 'wrong password!!'), { status: 401 });
  await assert.rejects(auth.signIn(fakeReq({ ip: '8.8.8.8' }), 'nobody@example.com', 'whatever123'), { status: 401 });
  const { setCookie } = await auth.signIn(fakeReq({ ip: '8.8.8.8', headers: { 'x-forwarded-proto': 'https' } }), 'Ana@Example.com', 'a long password here');
  assert.match(setCookie, new RegExp(`^${COOKIE}=[\\w-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$`));
  const cookie = setCookie.split(';')[0];
  const req = fakeReq({ ip: '8.8.8.8', headers: { cookie } });
  assert.equal(auth.identify(req).via, 'session');
  assert.equal(req.headers['cf-access-authenticated-user-email'], 'ana@example.com');
  // the database holds a hash of the token, never the token
  const stored = auth.store.db.prepare('SELECT id FROM sessions').all().map((r) => r.id);
  assert.equal(stored.length, 1); assert.ok(!cookie.includes(stored[0]));
  // a verified proxy identity wins over a session
  assert.equal(auth.identify(fakeReq({ headers: { cookie, 'cf-access-authenticated-user-email': 'bo@example.com' } })).email, 'bo@example.com');
  // a new password ends every session
  await auth.store.setPassword('ana@example.com', 'another long password');
  assert.equal(auth.identify(fakeReq({ ip: '8.8.8.8', headers: { cookie } })).via, null);
  auth.store.close();

  const strict = createAuth({ dataDir: dir, homeNetworkAccess: 'signin' });
  assert.equal(strict.identify(fakeReq()).via, null, 'signin mode: no shared account at home either');
  strict.store.close();
});

test('the sign-in page escapes what it echoes and only redirects within Marquee', () => {
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '/ok\r\nSet-Cookie: x=1']) assert.equal(safeNext(bad), '/');
  assert.equal(safeNext('/#library'), '/#library');
  const html = signInPage({ next: '/"><script>x</script>', error: '<b>' });
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('&lt;b&gt;'));
});

test('server: sign-in gate, form login, CSRF and host checks end to end', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-auth-api-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json' || name === 'whats-new.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  assert.equal(await userCommand({ action: 'add', email: 'owner@auth.test', dataDir: app, log: () => {}, read: async () => 'velvet curtain 123' }), 0);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@auth.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  try {
    await new Promise((resolve, reject) => {
      let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 10000);
      child.stdout.on('data', (c) => { logs += c; if (logs.includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (c) => { logs += c; });
    });
    const base = `http://127.0.0.1:${port}`;
    const outside = { 'x-forwarded-for': '203.0.113.9' }; // through a local proxy, from the internet
    const go = (route, opts = {}) => fetch(base + route, { redirect: 'manual', ...opts });

    assert.equal((await go('/api/me')).status, 200, 'home network: shared account');
    let r = await go('/api/me', { headers: outside });
    assert.equal(r.status, 401); assert.equal((await r.json()).signin, true);
    r = await go('/', { headers: outside });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/signin?next=%2F');
    assert.equal((await go('/signin', { headers: outside })).status, 200);
    assert.equal((await go('/style.css', { headers: outside })).status, 200, 'static assets stay public');
    assert.equal((await go('/api/health', { headers: outside })).status, 200);
    const rebound = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/me', headers: { host: 'rebind.attacker.example' } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(rebound, 421, 'DNS rebinding');
    assert.equal((await go('/api/me', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);

    const form = (password) => go('/api/auth/login', { method: 'POST', headers: { ...outside, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'owner@auth.test', password, next: '/#library' }) });
    r = await form('wrong password 1');
    assert.equal(r.status, 303); assert.match(r.headers.get('location'), /^\/signin\?error=wrong/);
    r = await form('velvet curtain 123');
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/#library');
    const cookie = r.headers.get('set-cookie').split(';')[0];
    r = await go('/api/me', { headers: { ...outside, cookie } });
    assert.equal(r.status, 200);
    const me = (await r.json()).me;
    assert.equal(me.email, 'owner@auth.test'); assert.equal(me.isOwner, true); assert.equal(me.via, 'session');

    r = await go('/api/auth/password', { method: 'POST', headers: { ...outside, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ current: 'nope nope nope', next: 'brand new password 1' }) });
    assert.equal(r.status, 403);
    r = await go('/api/auth/logout', { method: 'POST', headers: { ...outside, cookie } });
    assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await go('/api/me', { headers: { ...outside, cookie } })).status, 401, 'signed out for good');
  } finally {
    child.kill();
    await exited;
    await fs.rm(app, { recursive: true, force: true });
  }
});
