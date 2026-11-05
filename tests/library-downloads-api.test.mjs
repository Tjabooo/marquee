import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('download polling adds complete episodes to their owner library before the maintenance round', { timeout: 15000 }, async (t) => {
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-library-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  let complete = false, fileReady = false, removed = false, added = false;
  const hash = 'c'.repeat(40), name = 'Example.Show.S01E01.mp4';
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=test'); res.end('Ok.'); return; }
    if (url.pathname === '/api/v2/torrents/add') { added = true; req.resume(); res.end('Ok.'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v2/torrents/info') {
      res.end(JSON.stringify(removed || !added ? [] : [{ hash, name, tags: '', progress: complete ? 1 : 0.5,
        state: complete ? 'stoppedUP' : 'downloading', save_path: media, content_path: path.join(media, name), size: 1000 }]));
      return;
    }
    if (url.pathname === '/api/v2/torrents/files') {
      res.end(JSON.stringify([{ name, priority: 1, progress: fileReady ? 1 : 0.5 }])); return;
    }
    res.end('[]');
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  for (const entry of await fs.readdir(root)) if (entry.endsWith('.js') || entry === 'package.json') await fs.copyFile(path.join(root, entry), path.join(app, entry));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local', QBIT_URL: `http://127.0.0.1:${mock.address().port}`,
    QBIT_USER: 'test', CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    mock.closeAllConnections(); await new Promise((r) => mock.close(r));
    await fs.rm(app, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + logs)), 7000);
    child.stdout.on('data', (c) => { if (String(c).includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  const request = async (endpoint, body, email = 'member@test.local', expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: body ? 'POST' : 'GET',
      headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  };
  await request('/api/me', undefined, 'owner@test.local');
  assert.equal((await request('/api/library')).items.length, 0, 'prime the empty 30-second scan cache');
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${hash}`, name });
  await request('/api/downloads');
  await fs.writeFile(path.join(media, name), 'sample media');
  complete = true;
  await Promise.all([request('/api/downloads'), request('/api/downloads')]);
  assert.equal((await request('/api/library')).items.length, 0, 'unready video must not be claimed');
  fileReady = true;
  await Promise.all([request('/api/downloads'), request('/api/downloads')]);
  const library = await request('/api/library');
  assert.equal(library.items.length, 1, 'ownership and scan cache update immediately, without 60-second worker');
  assert.equal(library.items[0].episode, 1);
  assert.equal((await request('/api/library', undefined, 'owner@test.local')).items.length, 0, 'episode belongs to the downloader');
  removed = true;
  assert.equal((await request('/api/downloads')).items.length, 0);
  assert.equal((await request('/api/library')).items.length, 1, 'finished torrent removal preserves library ownership');
  assert.equal((await request(`/api/media/lib/${library.items[0].id}/credits`)).creditsAt, null, 'unknown chapter timing degrades gracefully');
  const outside = Buffer.from('../outside.mp4').toString('base64url');
  await request(`/api/media/lib/${outside}/credits`, undefined, undefined, 400);
});
