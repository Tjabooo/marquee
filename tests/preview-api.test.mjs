// The preview switch (src/preview.js, PREVIEW_DIR) and the title page endpoints, against a running server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { previewDir, previewProblem, staticFile, previewRoute, staticRoots } from '../src/preview.js';

test('preview helpers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-preview-unit-'));
  assert.equal(previewDir(''), '');
  assert.equal(previewDir('relative/public'), '');
  assert.match(previewProblem('relative/public'), /absolute/);
  assert.equal(previewDir(path.join(dir, 'missing')), '');
  assert.equal(previewDir(dir), path.resolve(dir));
  assert.equal(previewProblem(dir), '');
  assert.equal(staticFile(dir, '/'), path.join(dir, 'index.html'));
  assert.equal(staticFile(dir, '/a/b.css'), path.join(dir, 'a', 'b.css'));
  assert.equal(staticFile(dir, '/../secret'), null);
  assert.equal(staticFile(dir, '/%2e%2e/secret'), null);
  assert.equal(staticFile(dir, '/..%2f..%2fetc%2fpasswd'), null);
  // No preview folder: /preview is just another unknown path, and the cookie changes nothing.
  assert.equal(previewRoute({ headers: {} }, {}, '/preview', ''), false);
  assert.deepEqual(staticRoots({ headers: { cookie: 'lilin_preview=1' } }, '/pub', ''), ['/pub']);
  assert.deepEqual(staticRoots({ headers: { cookie: 'a=b; lilin_preview=1' } }, '/pub', '/pre'), ['/pre', '/pub']);
  assert.deepEqual(staticRoots({ headers: { cookie: 'lilin_preview=10' } }, '/pub', '/pre'), ['/pub']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('PREVIEW_DIR serves a second web app to browsers that opt in, and title pages get their extras', { timeout: 20000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-preview-api-'));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const pre = path.join(app, 'preview-public'); await fs.mkdir(pre);
  await fs.writeFile(path.join(pre, 'index.html'), '<!doctype html><title>Preview build</title>');
  await fs.writeFile(path.join(pre, 'pages.css'), 'body{color:red}');
  await fs.writeFile(path.join(pre, 'only-in-preview.css'), 'a{}');
  await fs.writeFile(path.join(app, 'outside.txt'), 'secret');

  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = {};
    if (url.pathname === '/movie/42') body = {
      id: 42, title: 'Answer', runtime: 128, tagline: 'Think.', original_language: 'sv', genres: [{ id: 18, name: 'Drama' }],
      images: { logos: [
        { file_path: '/sv.png', iso_639_1: 'sv', aspect_ratio: 3, vote_average: 9 },
        { file_path: '/en.png', iso_639_1: 'en', aspect_ratio: 2.5, vote_average: 1 },
        { file_path: '/en.jpg', iso_639_1: 'en', aspect_ratio: 2.5, vote_average: 10 },
      ] },
      credits: { cast: [{ id: 7, name: 'Ada', character: 'Herself', profile_path: '/ada.jpg' }, { id: 8, name: 'Bo', character: '' }] },
      recommendations: { results: [{ id: 43, title: 'Question', poster_path: '/q.jpg', release_date: '2020-01-01' }, { id: 44, title: 'No poster' }] },
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }, { iso_3166_1: 'SE', release_dates: [{ certification: '' }, { certification: '11' }] }] },
    };
    else if (url.pathname === '/t/p/w300/still.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return; }
    else if (url.pathname === '/tv/5/season/2') body = { episodes: [{ episode_number: 1, name: 'Pilot', overview: 'It starts.', runtime: 44, air_date: '2001-01-01', still_path: '/s.jpg' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;

  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)

  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name.endsWith('.json')) await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const source = await fs.readFile(path.join(app, 'src', 'server.js'), 'utf8');
  await fs.writeFile(path.join(app, 'src', 'server.js'), source.replace('https://api.themoviedb.org/3', mockBase).replace("const TMDB_IMAGE_ORIGIN = 'https://image.tmdb.org';", `const TMDB_IMAGE_ORIGIN = '${mockBase}';`));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });

  const child = spawn(process.execPath, ['server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local', TMDB_TOKEN: 'test', HOME_NETWORK_ACCESS: 'signin',
    CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', SVT_PLAY: 'off', CAST_APPLETV: 'off',
    SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0', PREVIEW_DIR: pre,
  }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    child.kill();
    await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 9000);
    child.stdout.on('data', (c) => { const ready = /Lilin is running: http:\/\/localhost:(\d+)/.exec(String(c)); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });

  const base = `http://127.0.0.1:${port}`;
  const owner = { 'cf-access-authenticated-user-email': 'owner@test.local' };
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
  const withCookie = { ...owner, cookie: 'lilin_preview=1' };

  // Off by default: the live web app.
  let r = await get('/', owner);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Lilin<\/title>/);

  // Signed out, /preview goes through sign-in first (no extra access).
  r = await get('/preview');
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/signin\?next=%2Fpreview/);

  r = await get('/preview', owner);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  assert.match(r.headers.get('set-cookie'), /^lilin_preview=1; Path=\/; Max-Age=2592000; SameSite=Lax; HttpOnly$/);

  r = await get('/', withCookie);
  assert.equal(await r.text(), '<!doctype html><title>Preview build</title>');
  assert.equal(r.headers.get('vary'), 'Cookie');
  // Files the preview doesn't have come from public/.
  r = await get('/style.css', withCookie);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), await fs.readFile(path.join(app, 'public', 'style.css'), 'utf8'));
  r = await get('/pages.css', withCookie);
  assert.equal(await r.text(), 'body{color:red}');
  // A file only the preview has: the preview's for preview browsers, nothing for everyone else.
  r = await get('/only-in-preview.css', withCookie);
  assert.equal(await r.text(), 'a{}');
  r = await get('/only-in-preview.css', owner);
  assert.equal(r.status, 404);
  // The same path guard as public/.
  r = await get('/..%2foutside.txt', withCookie);
  assert.equal(r.status, 400);

  // Same API and permissions; the preview build id is its own, and the client is told it's the preview.
  const live = await (await get('/api/status', owner)).json();
  const prev = await (await get('/api/status', withCookie)).json();
  assert.equal(live.preview, undefined);
  assert.equal(prev.preview, true);
  assert.notEqual(prev.whatsNew.build, live.whatsNew.build);
  assert.equal(prev.me.email, live.me.email);
  r = await get('/api/status', { cookie: 'lilin_preview=1' });
  assert.equal(r.status, 401);

  // Server-drawn pages get the preview's pages.css, only with the cookie.
  r = await get('/signin', { cookie: 'lilin_preview=1' });
  assert.match(await r.text(), /<link rel="stylesheet" href="\/pages.css"><\/head>/);
  r = await get('/signin');
  assert.doesNotMatch(await r.text(), /href="\/pages\.css"/);

  r = await get('/preview/off', withCookie);
  assert.equal(r.status, 303);
  assert.match(r.headers.get('set-cookie'), /^lilin_preview=; Path=\/; Max-Age=0;/);

  // Title page extras: the English PNG logo, faces, the Swedish age rating first, posters only.
  const page = (await (await get('/api/title/movie/42/page', owner)).json()).page;
  assert.deepEqual(page.logo, { url: 'https://image.tmdb.org/t/p/w500/en.png', aspect: 2.5 });
  assert.equal(page.runtime, 128);
  assert.equal(page.tagline, 'Think.');
  assert.deepEqual(page.genres, ['Drama']);
  assert.equal(page.certification, '11');
  assert.deepEqual(page.cast[0], { id: 7, name: 'Ada', character: 'Herself', photo: 'https://image.tmdb.org/t/p/w185/ada.jpg' });
  assert.equal(page.cast[1].photo, null);
  assert.deepEqual(page.similar.map((x) => [x.id, x.type]), [[43, 'movie']]);
  const season = await (await get('/api/tv/5/season/2', owner)).json();
  // Small TMDB pictures come through the server (same origin, so the page can read their colours); nothing else does.
  r = await get('/api/art?path=%2Ft%2Fp%2Fw300%2Fstill.jpg', owner);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  for (const bad of ['/t/p/original/still.jpg', '/t/p/w300/../../etc/passwd', 'https://evil.example/x.jpg', '/t/p/w300/still.gif']) {
    r = await get(`/api/art?path=${encodeURIComponent(bad)}`, owner);
    assert.equal(r.status, 400, bad);
  }
  r = await get('/api/art?path=%2Ft%2Fp%2Fw300%2Fstill.jpg');
  assert.equal(r.status, 401);
  assert.match(logs, /Preview: {3}.*preview-public/);
  assert.deepEqual(season.episodes, [{ number: 1, name: 'Pilot', overview: 'It starts.', runtime: 44, airDate: '2001-01-01', still: 'https://image.tmdb.org/t/p/w300/s.jpg' }]);
});
