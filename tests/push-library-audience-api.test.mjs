import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real server with stand-ins for qBittorrent, TMDB and the push service. Each person's phone is
// an endpoint named after them, so the inbox shows exactly who was notified about what.
test('download notifications only reach people who have the show or film in their library', { timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-push-audience-'));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const torrents = new Map(); // hash -> qBittorrent's view of the torrent
  const incoming = []; // torrents the next add call starts
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for await (const chunk of req) void chunk;
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=test'); res.end('Ok.'); return; }
    if (url.pathname === '/api/v2/torrents/info') {
      const hashes = url.searchParams.get('hashes')?.split('|');
      res.end(JSON.stringify([...torrents.values()].filter((v) => !hashes || hashes.includes(v.hash)))); return;
    }
    if (url.pathname === '/api/v2/torrents/files') {
      const v = torrents.get(url.searchParams.get('hash'));
      res.end(JSON.stringify(v ? [{ name: v.name, progress: v.progress, size: 10, priority: 1 }] : [])); return;
    }
    if (url.pathname === '/api/v2/torrents/add') {
      const v = incoming.shift(); torrents.set(v.hash, v); res.end('Ok.'); return;
    }
    if (url.pathname.startsWith('/api/v2/')) { res.end('Ok.'); return; }
    res.end(JSON.stringify(url.pathname === '/tv/42' ? { id: 42, name: 'Example Show', first_air_date: '2020-01-01', seasons: [] } : {}));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const serverFile = path.join(app, 'src', 'server.js');
  await fs.writeFile(serverFile, (await fs.readFile(serverFile, 'utf8')).replace('https://api.themoviedb.org/3', mockBase)
    .replace('setInterval(libraryRound, 60 * 1000)', 'setInterval(libraryRound, 100)'));
  const inbox = path.join(app, 'pushed.jsonl');
  const stub = path.join(app, 'push-stub.mjs');
  await fs.writeFile(stub, `
    import fs from 'node:fs';
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('https://fcm.googleapis.com/')) return real(url, opts);
      fs.appendFileSync(${JSON.stringify(inbox)}, String(url).split('/').pop() + '\\n');
      return new Response(null, { status: 201 });
    };
  `);
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const child = spawn(process.execPath, ['--import', pathToFileURL(stub).href, 'server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local', TMDB_TOKEN: 'test', QBIT_URL: mockBase,
    CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    mock.closeAllConnections(); await new Promise((r) => mock.close(r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 8000);
    child.stdout.on('data', (c) => { logs += c; if (logs.includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });
  const request = async (route, email, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { 'cf-access-authenticated-user-email': `${email}@test.local`, 'content-type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(data)}`); return data;
  };
  // Who was notified since the last call, once everything sent for one arrival has gone out.
  const pushed = async () => {
    await new Promise((r) => setTimeout(r, 600));
    const lines = (await fs.readFile(inbox, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    await fs.rm(inbox, { force: true });
    return lines.sort();
  };
  // `email` asks for the video; it lands once the finished file is there and downloads are read.
  const download = async (email, name, extra = {}) => {
    const hash = crypto.createHash('sha1').update(name).digest('hex');
    incoming.push({ hash, name, progress: 0.5, state: 'downloading', save_path: media, content_path: path.join(media, name), size: 10, added_on: 1700000000 });
    await request('/api/downloads/add', email, { link: `magnet:?xt=urn:btih:${hash}`, name, ...extra });
    await fs.writeFile(path.join(media, name), Buffer.alloc(10));
    Object.assign(torrents.get(hash), { progress: 1, state: 'stoppedUP' });
    await request('/api/downloads', email);
  };

  await request('/api/me', 'owner');
  await new Promise((r) => setTimeout(r, 500)); // the first scan adopts existing files without notifying
  for (const person of ['holder', 'downloader', 'follower', 'stranger']) {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    await request('/api/push/subscribe', person, { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${person}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } });
  }
  await request('/api/watchlist', 'follower', { type: 'tv', tmdbId: 42, follow: true, auto: false });

  await download('holder', 'Example.Show.S01E01.mp4', { mediaType: 'tv', tvId: 42 });
  assert.deepEqual(await pushed(), ['holder'], 'following a show is not having it in your library');

  await download('downloader', 'Example.Show.S01E02.mp4', { mediaType: 'tv', tvId: 42 });
  assert.deepEqual(await pushed(), ['downloader', 'holder'], 'someone with the show hears about its new episode');

  await download('downloader', 'Other.Film.2020.1080p.mp4');
  assert.deepEqual(await pushed(), ['downloader'], 'a film only notifies the person whose library it landed in');

  const library = await request('/api/library', 'follower');
  assert.deepEqual(library.items, [], 'the follower really has nothing in their library');
});
