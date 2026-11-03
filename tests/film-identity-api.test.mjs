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
  let lastTorrentForm = '', torrentAdded = false;
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v2/auth/login') { res.writeHead(200, { 'Set-Cookie': 'SID=test' }); res.end('Ok.'); return; }
    if (url.pathname === '/api/v2/torrents/add') {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => { lastTorrentForm = Buffer.concat(chunks).toString(); torrentAdded = true; res.end('Ok.'); }); return;
    }
    if (url.pathname === '/api/v2/torrents/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(torrentAdded ? [{ hash: 'a'.repeat(40), name: 'Verity.2026.1080p', progress: 0, size: 1000, tags: '' }] : []));
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
    assert.match(lastTorrentForm, /name="savepath"/);
    assert.ok(lastTorrentForm.includes(path.join(media, 'Movies')), 'film download requests the Movies folder');
    const downloads = await request('/api/downloads');
    assert.equal(downloads.items[0].tmdbId, movies[0].id, 'Download carries the selected catalogue identity');

    // Two separately authenticated viewers on real HTTP/SSE connections, with no browser or media
    // mutation. The guest can stream this room's title without exposing their private library.
    const hostClient = 'host-viewer-123456', guestClient = 'guest-viewer-123456';
    const room = await request('/api/watch', { id: one.id, clientId: hostClient, position: 30 });
    const base = `/api/watch/${room.token}`;
    await request(`${base}/play-link?clientId=${guestClient}`, undefined, 'member@test.local', 403);
    await request(`${base}/join`, { clientId: guestClient }, 'member@test.local');
    const streams = [];
    const events = async (client, email) => {
      const response = await fetch(`http://127.0.0.1:${port}${base}/events?clientId=${client}`, { headers: { 'cf-access-authenticated-user-email': email } });
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      assert.match(response.headers.get('cache-control'), /no-transform/);
      const reader = response.body.getReader(); streams.push(reader);
      let buffer = '';
      return async (revision) => {
        while (true) {
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (!line.startsWith('data: ')) continue;
            const state = JSON.parse(line.slice(6));
            if (state.revision >= revision) return state;
          }
          const next = await reader.read(); assert.equal(next.done, false); buffer += new TextDecoder().decode(next.value);
        }
      };
    };
    try {
      const hostEvents = await events(hostClient, 'owner@test.local');
      const guestEvents = await events(guestClient, 'member@test.local');
      await request(`${base}/heartbeat`, { clientId: hostClient, ready: true, rtt: 50 });
      await request(`${base}/heartbeat`, { clientId: guestClient, ready: true, rtt: 80 }, 'member@test.local');
      const playing = await request(`${base}/control`, { clientId: hostClient, action: 'play', position: 30 });
      assert.equal(playing.playing, true); assert.ok(playing.at > playing.serverNow);
      assert.equal((await hostEvents(playing.revision)).position, 30);
      assert.equal((await guestEvents(playing.revision)).position, 30);
      await request(`${base}/control`, { clientId: guestClient, action: 'seek', position: 99 }, 'member@test.local', 403);
      const buffering = await request(`${base}/heartbeat`, { clientId: guestClient, ready: true, buffering: true }, 'member@test.local');
      assert.equal(buffering.playing, false); assert.equal((await hostEvents(buffering.revision)).playing, false);
      const link = await request(`${base}/play-link?clientId=${guestClient}`, undefined, 'member@test.local');
      assert.ok(link.url.startsWith('/play/lib/'));
      const byte = await fetch(`http://127.0.0.1:${port}${link.url}`, { headers: { Range: 'bytes=0-0' } });
      assert.equal(byte.status, 206); await byte.arrayBuffer();
      assert.equal((await request('/api/library', undefined, 'member@test.local')).items.length, 0);
      await request('/api/me', { name: 'Dad' });
      assert.equal((await request(`${base}/preview`)).host, 'Dad', 'Profile names update an open room immediately');
      const activity = await request('/api/activity');
      assert.equal(activity.people.find((p) => p.user === 'owner@test.local').name, 'Dad');
      assert.ok(activity.events.filter((e) => e.user === 'owner@test.local').every((e) => e.name === 'Dad'), 'Past activity uses the current display name');
      await request(`${base}/leave`, { clientId: hostClient });
      const remaining = await request(`${base}/heartbeat`, { clientId: guestClient, ready: true }, 'member@test.local');
      assert.equal(remaining.host, guestClient); assert.equal(remaining.intentPlaying, false);
      await request(`${base}/leave`, { clientId: guestClient }, 'member@test.local');
    } finally { await Promise.all(streams.map((s) => s.cancel().catch(() => {}))); }
  } finally {
    child.kill();
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
  }
});
