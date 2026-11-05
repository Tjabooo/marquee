import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
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
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@push.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['--import', pathToFileURL(stub).href, 'server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  await new Promise((resolve, reject) => {
    let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
    child.stdout.on('data', (c) => { logs += c; if (logs.includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
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

    const off = await request('/api/push/unsubscribe', { endpoint: sub(phone, 'phone').endpoint });
    assert.deepEqual(off.devices, []);
  } finally {
    child.kill();
    await exited;
    await fs.rm(app, { recursive: true, force: true }).catch(() => {});
  }
});
