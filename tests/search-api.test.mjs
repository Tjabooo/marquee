import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Discover finds the exact film 9 and treats 2009 as a year filter', { timeout: 15000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-search-api-'));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const requests = [];
  const noisy = [
    { id: 17654, media_type: 'movie', title: 'District 9', release_date: '2009-08-14' },
    { id: 75219, media_type: 'tv', name: '9-1-1', first_air_date: '2018-01-03' },
  ];
  const exact = { id: 12244, title: '9', original_title: '9', release_date: '2009-08-19', overview: 'Nine rag dolls awaken.' };

  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    let body = {};
    if (url.pathname === '/search/multi') body = { results: noisy };
    else if (url.pathname === '/search/movie') {
      const page = Number(url.searchParams.get('page') || 1);
      body = page === 3
        ? { page, total_pages: 3, results: [exact] }
        : { page, total_pages: 3, results: [{ id: 90000 + page, title: 'Nine Lives', release_date: '2009-01-01' }] };
    } else if (url.pathname === '/search/tv') body = { page: 1, total_pages: 1, results: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;

  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)

  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const source = await fs.readFile(path.join(app, 'src', 'server.js'), 'utf8');
  await fs.writeFile(path.join(app, 'src', 'server.js'), source.replace('https://api.themoviedb.org/3', mockBase));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });

  const child = spawn(process.execPath, ['server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local', TMDB_TOKEN: 'test',
    CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', SVT_PLAY: 'off', CAST_APPLETV: 'off',
    SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0',
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
    const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 7000);
    child.stdout.on('data', (c) => { const ready = /Marquee is running: http:\/\/localhost:(\d+)/.exec(String(c)); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });

  const search = async (q) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(q)}`, {
      headers: { 'cf-access-authenticated-user-email': 'owner@test.local' },
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };

  let data = await search('9');
  assert.equal(data.results[0].id, 12244);
  assert.ok(requests.some((r) => r.path === '/search/movie' && r.params.query === '9' && r.params.page === '3'));

  requests.length = 0;
  data = await search('9 (2009)');
  assert.equal(data.results[0].id, 12244);
  assert.ok(requests.some((r) => r.path === '/search/movie' && r.params.query === '9' && r.params.primary_release_year === '2009' && r.params.page === '3'));
  assert.ok(requests.some((r) => r.path === '/search/tv' && r.params.query === '9' && r.params.first_air_date_year === '2009'));
});
