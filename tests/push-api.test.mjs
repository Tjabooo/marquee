import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decrypt } from '../src/push.js';

// The real server with a stand-in push service: every POST to fcm.googleapis.com is written to a
// file instead of leaving the machine, so the test can decrypt what a phone would have received.
test('devices turn notifications on and off, get a test, and only room members can invite', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-push-api-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const inbox = path.join(app, 'pushed.jsonl');
  const stub = path.join(app, 'push-stub.mjs');
  await fs.writeFile(stub, `
    import fs from 'node:fs';
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('https://fcm.googleapis.com/')) return real(url, opts);
      fs.appendFileSync(${JSON.stringify(inbox)}, JSON.stringify({ url: String(url), headers: opts.headers, body: Buffer.from(opts.body).toString('base64') }) + '\\n');
      return new Response(null, { status: String(url).endsWith('/gone') ? 410 : 201 });
    };
  `);
  const HOUSE = 'h0use-t0ken-for-the-agent-test-0123456789';
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), HOUSE_TOKEN: HOUSE, ADMIN_EMAILS: 'owner@push.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['--import', pathToFileURL(stub).href, 'server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  await new Promise((resolve, reject) => {
    let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
    child.stdout.on('data', (c) => { logs += c; const ready = /Marquee is running: http:\/\/localhost:(\d+)/.exec(logs); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (c) => { logs += c; });
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });
  const request = async (route, body, email = 'member@push.test', status = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`); return data;
  };
  const browser = () => {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    return { p256dh: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  };
  const sub = (keys, name) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  try {
    for (const file of ['/sw.js', '/manifest.webmanifest', '/icon-192.png', '/notifications.js']) {
      const r = await fetch(`http://127.0.0.1:${port}${file}`);
      assert.equal(r.status, 200, file);
      if (file === '/manifest.webmanifest') assert.equal(r.headers.get('content-type'), 'application/manifest+json');
    }
    const { publicKey, devices } = await request('/api/push');
    assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
    assert.deepEqual(devices, []);
    await request('/api/push/test', {}, undefined, 400); // nothing to send to yet

    const phone = browser();
    await request('/api/push/subscribe', { subscription: { ...sub(phone, 'x'), endpoint: 'https://192.168.1.1/push' } }, undefined, 400);
    const on = await request('/api/push/subscribe', { subscription: sub(phone, 'phone'), label: 'Chrome on Android' });
    assert.deepEqual(on.devices.map((d) => d.label), ['Chrome on Android']);
    assert.equal((await request('/api/push', undefined, 'owner@push.test')).devices.length, 0, 'devices are per person');

    const sent = await request('/api/push/test', {});
    assert.equal(sent.sent, 1);
    const [msg] = (await fs.readFile(inbox, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(msg.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(JSON.parse(decrypt(Buffer.from(msg.body, 'base64'), phone)).kind, 'test');
    await request('/api/push/test', {}, undefined, 429); // one test every few seconds

    // Each kind can be switched off in the person's settings.
    const me = (await request('/api/me', { pushWatch: false, pushEpisode: 0 })).me;
    assert.equal(me.settings.pushWatch, false); assert.equal(me.settings.pushEpisode, false); assert.equal(me.settings.pushDownload, true);

    // Inviting needs a live room you're in.
    await request(`/api/watch/${'a'.repeat(24)}/invite`, { clientId: 'c'.repeat(20), userIds: [1] }, undefined, 410);
    await request(`/api/watch/${'a'.repeat(24)}/invitees?clientId=${'c'.repeat(20)}`, undefined, undefined, 410);

    // Agents on the home network can ask the owner for attention: House token, owner's devices only, rate-limited.
    const agent = async (body, token, status) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/agent/notify`, { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(token ? { 'x-marquee-token': token } : {}) } });
      const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
    };
    await agent({ title: 'Hi' }, undefined, 403);
    await agent({ title: 'Hi' }, 'x'.repeat(HOUSE.length), 403);
    await agent({ body: 'no title' }, HOUSE, 400);
    assert.equal((await agent({ title: 'Hi' }, HOUSE, 200)).sent, 0, 'the owner has no device yet');
    const ownerPhone = browser();
    await request('/api/push/subscribe', { subscription: sub(ownerPhone, 'owner-phone') }, 'owner@push.test');
    const before = (await fs.readFile(inbox, 'utf8')).trim().split('\n').length;
    assert.equal((await agent({ title: 'Claude needs you', body: 'Pick a name', url: '//evil.example/' }, HOUSE, 200)).sent, 1);
    const lines = (await fs.readFile(inbox, 'utf8')).trim().split('\n');
    assert.equal(lines.length, before + 1, 'only the owner gets it');
    const got = JSON.parse(decrypt(Buffer.from(JSON.parse(lines.at(-1)).body, 'base64'), ownerPhone));
    assert.equal(got.kind, 'agent'); assert.equal(got.title, 'Claude needs you'); assert.equal(got.body, 'Pick a name'); assert.equal(got.url, '/');
    await agent({ title: 'Again' }, HOUSE, 429); // one every 20 s
    assert.equal((await request('/api/me', { pushAgent: false }, 'owner@push.test')).me.settings.pushAgent, false);

    const off = await request('/api/push/unsubscribe', { endpoint: sub(phone, 'phone').endpoint });
    assert.deepEqual(off.devices, []);
  } finally {
    child.kill();
    await exited;
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }
});
