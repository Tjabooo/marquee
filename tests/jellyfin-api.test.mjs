import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The Jellyfin plugin's whole conversation with Marquee: pair with a code, read the library, stream a
// video and its subtitles through signed URLs, report progress, and lose access when disconnected.
test('a Jellyfin server pairs, syncs, streams signed files and reports progress', { timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-jellyfin-'));
  const media = path.join(app, 'media');
  const put = async (name, data) => { const full = path.join(media, name); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, data); };
  await put('Films/Heat.1995.1080p.mp4', Buffer.from('0123456789abcdef'));
  await put('Films/Heat.1995.1080p.sv.srt', '1\n00:00:01,000 --> 00:00:02,000\nHej\n');
  await put('TV/Example Show/Season 1/Example.Show.S01E02.mp4', Buffer.alloc(32, 7));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  for (const dir of ['src', 'public']) await fs.cp(path.join(root, dir), path.join(app, dir), { recursive: true });
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@jf.test', CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off',
    CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 8000);
    child.stdout.on('data', (c) => { const ready = /Marquee is running: http:\/\/localhost:(\d+)/.exec(String(c)); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });
  const base = `http://127.0.0.1:${port}`;
  // As the plugin: no Cloudflare identity, no cookie. The Host is the public name, as through Cloudflare.
  const plugin = (route, { key, body, method } = {}) => fetch(base + route, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', 'cf-ray': 'test' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = async (r, status = 200) => { const d = await r.json(); assert.equal(r.status, status, JSON.stringify(d)); return d; };
  const owner = (route, body) => fetch(base + route, {
    method: body !== undefined ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': 'owner@jf.test', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  await json(await owner('/api/me'));
  const onServer = (await json(await owner('/api/library'))).server;
  await json(await owner('/api/library/add', { ids: onServer.map((i) => i.id) }));

  // Pairing: the plugin shows a code, the owner enters it in Marquee, the plugin gets a key once.
  const started = await json(await plugin('/c/jf/v1/pair/start', { body: { name: 'Pappa’s Jellyfin' } }));
  assert.match(started.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(await json(await plugin(`/c/jf/v1/pair/poll?id=${started.poll}`)), { state: 'waiting' });
  await json(await owner('/api/jellyfin/approve', { code: 'ZZZZZZ' }), 404);
  const approved = await json(await owner('/api/jellyfin/approve', { code: started.code.toLowerCase() }));
  assert.equal(approved.links.length, 1);
  assert.equal(approved.links[0].name, 'Pappa’s Jellyfin');
  const got = await json(await plugin(`/c/jf/v1/pair/poll?id=${started.poll}`));
  assert.equal(got.state, 'approved');
  assert.match(got.key, /^mqjf_[\w-]{43}$/);
  assert.deepEqual(await json(await plugin(`/c/jf/v1/pair/poll?id=${started.poll}`)), { state: 'expired' }, 'the key is handed over once');
  const key = got.key;

  await json(await plugin('/c/jf/v1/library'), 401);
  await json(await plugin('/c/jf/v1/library', { key: 'mqjf_' + 'x'.repeat(43) }), 401);
  assert.equal((await json(await plugin('/c/jf/v1/me', { key }))).link.name, 'Pappa’s Jellyfin');
  const lib = await json(await plugin('/c/jf/v1/library', { key }));
  assert.equal(lib.films.length, 1);
  const film = lib.films[0];
  assert.equal(film.title, 'Heat'); assert.equal(film.year, 1995); assert.equal(film.key, 'films/heat.1995.1080p');
  assert.deepEqual(film.subtitles.map((s) => s.lang), ['sv']);
  assert.equal(lib.shows.length, 1);
  assert.equal(lib.shows[0].episodes[0].season, 1); assert.equal(lib.shows[0].episodes[0].episode, 2);

  // Signed stream: ranges work; a changed signature, id or link is refused.
  let r = await fetch(base + film.stream, { headers: { range: 'bytes=4-7' } });
  assert.equal(r.status, 206); assert.equal(await r.text(), '4567');
  const [, , , , , linkId, sig, id] = film.stream.split('/');
  const other = lib.shows[0].episodes[0].id;
  for (const bad of [`/c/jf/v1/s/${linkId}/${'A'.repeat(22)}/${id}/x.mp4`, `/c/jf/v1/s/${linkId}/${sig}/${other}/x.mp4`, `/c/jf/v1/s/${'B'.repeat(12)}/${sig}/${id}/x.mp4`]) {
    assert.equal((await fetch(base + bad)).status, 404, bad);
  }
  r = await fetch(base + film.subtitles[0].url);
  assert.equal(r.status, 200); assert.match(await r.text(), /Hej/);

  // Progress lands in Marquee's own Continue watching, and finishing clears it.
  await json(await plugin('/c/jf/v1/progress', { key, body: { key: film.key, position: 600, duration: 6000 } }));
  let progress = (await json(await owner('/api/me/progress'))).progress;
  assert.equal(progress['m:films/heat.1995.1080p'].time, 600);
  assert.equal((await json(await plugin('/c/jf/v1/library', { key }))).films[0].progress.position, 600);
  await json(await plugin('/c/jf/v1/progress', { key, body: { key: film.key, finished: true } }));
  progress = (await json(await owner('/api/me/progress'))).progress;
  assert.equal(progress['m:films/heat.1995.1080p'], undefined);

  // Disconnecting from Marquee kills the key and every signed URL.
  const links = (await json(await owner('/api/jellyfin'))).links;
  await json(await owner(`/api/jellyfin/${links[0].id}/remove`, {}));
  await json(await plugin('/c/jf/v1/library', { key }), 401);
  assert.equal((await fetch(base + film.stream)).status, 404);
});
