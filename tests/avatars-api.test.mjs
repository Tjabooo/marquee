import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The real server: upload, serve, replace and remove profile pictures over HTTP.
test('profile pictures over HTTP: set, serve with a versioned URL, owner sets others, remove', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-avatar-api-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@pics.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  await new Promise((resolve, reject) => {
    let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
    child.stdout.on('data', (c) => { logs += c; const ready = /Lilin is running: http:\/\/localhost:(\d+)/.exec(logs); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (c) => { logs += c; });
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });
  const call = (route, { email = 'member@pics.test', body, type } = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', body,
    headers: { 'cf-access-authenticated-user-email': email, ...(type ? { 'content-type': type } : {}) } });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 7)]);
  try {
    let r = await call('/api/me/avatar', { body: webp, type: 'image/webp' });
    assert.equal(r.status, 200);
    const { me } = await r.json();
    assert.match(me.avatar, /^\/api\/avatar\/\d+\?v=/);

    r = await call(me.avatar, { email: 'someone@pics.test' });
    assert.equal(r.status, 200, 'everyone signed in sees pictures');
    assert.equal(r.headers.get('content-type'), 'image/webp');
    assert.match(r.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), webp);

    r = await call('/api/me/avatar', { body: Buffer.from('<svg onload="alert(1)"/>'), type: 'image/svg+xml' });
    assert.equal(r.status, 415, 'only real JPEG, PNG and WebP pictures');

    r = await call(`/api/admin/users/${me.id}/avatar`, { body: webp, type: 'image/webp' });
    assert.equal(r.status, 403, 'only the owner changes someone else’s picture');
    r = await call(`/api/admin/users/${me.id}/avatar`, { email: 'owner@pics.test', body: Buffer.alloc(0) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).avatar, null);
    assert.equal((await call(me.avatar)).status, 404);
  } finally {
    child.kill();
    await exited;
    await fs.rm(app, { recursive: true, force: true }).catch(() => {});
  }
});
