import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const movies = [
  { id: 1283515, title: 'Verity', release_date: '2026-09-30', poster_path: '/a.jpg', overview: 'A novelist.' },
  { id: 1812260, title: 'Verity', release_date: '2026-10-31', poster_path: '/b.jpg', overview: 'A wish.' },
];

test('film identification API requires owner access and changes only the selected file', { timeout: 15000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-api-'));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v2/auth/login') { res.writeHead(200, { 'Set-Cookie': 'SID=test' }); res.end('Ok.'); return; }
    if (url.pathname === '/api/v2/torrents/add') { req.resume(); res.end('Ok.'); return; }
    if (url.pathname === '/api/v2/torrents/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ hash: 'a'.repeat(40), name: 'Verity.2026.1080p', progress: 0, size: 1000, tags: '' }]));
      return;
    }
    const result = url.pathname === '/search/movie' ? { results: movies } : movies.find((m) => url.pathname === `/movie/${m.id}`);
    res.writeHead(result ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result || {}));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  // Replace the external service only inside the disposable test copy.
  const source = await fs.readFile(path.join(app, 'server.js'), 'utf8');
  await fs.writeFile(path.join(app, 'server.js'), source.replace('https://api.themoviedb.org/3', mockBase));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  for (const release of ['1080p', '720p']) await fs.writeFile(path.join(media, `Verity.2026.${release}.mp4`), Buffer.alloc(1024));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local', TMDB_TOKEN: 'test', QBIT_URL: mockBase, QBIT_USER: 'test', CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off',
    CAST_APPLETV: 'off', SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 7000);
      child.stdout.on('data', (c) => { if (String(c).includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
    });
    const request = async (endpoint, body, email = 'owner@test.local', expectedStatus = 200) => {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' },
        method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
      const data = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(data)); return data;
    };
    const initial = await request('/api/library');
    assert.equal(initial.server.length, 2);
    assert.ok(initial.server.every((f) => f.movieAmbiguous && !f.tmdbId));
    const [one, two] = initial.server;
    const choices = await request(`/api/library/identify?id=${one.id}`); assert.equal(choices.results.length, 2);
    await request('/api/library/identify', { id: one.id, tmdbId: movies[1].id }, 'member@test.local', 403);
    await request('/api/library/identify', { id: one.id, tmdbId: 'invalid' }, undefined, 400);
    await request('/api/library/identify', { id: one.id, tmdbId: movies[1].id });
    await request('/api/library/add', { ids: [one.id, two.id] });
    const identified = await request('/api/library');
    assert.equal(identified.items.find((f) => f.id === one.id).tmdbId, movies[1].id);
    assert.equal(identified.items.find((f) => f.id === two.id).movieAmbiguous, true);
    const before = identified.items.find((f) => f.id === one.id).expiresAt;
    const extended = await request('/api/library/extend', { ids: [one.id] });
    assert.equal(extended.entries[0].expiresAt, before + 7 * 86400000);
    assert.equal((await request('/api/library', undefined, 'member@test.local')).items.length, 0);
    await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, name: 'Verity.2026.1080p', movieId: movies[0].id });
    const downloads = await request('/api/downloads');
    assert.equal(downloads.items[0].tmdbId, movies[0].id, 'Download carries the selected catalogue identity');
  } finally {
    child.kill();
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
  }
});
