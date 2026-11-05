// The content filter end to end: adult downloads are refused before qBittorrent sees them, and ones
// whose files only show it once metadata arrives are removed with their files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HASH = 'e'.repeat(40);
async function fixture(t, env = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-content-filter-'));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const state = { torrents: [], files: [], adds: 0, deletes: [] };
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = async () => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString(); };
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=test'); res.end('Ok.'); return; }
    if (url.pathname === '/api/v2/torrents/info') {
      const hashes = url.searchParams.get('hashes');
      res.end(JSON.stringify(hashes ? state.torrents.filter((v) => hashes.split('|').includes(v.hash)) : state.torrents)); return;
    }
    if (url.pathname === '/api/v2/torrents/files') { res.end(JSON.stringify(state.files)); return; }
    if (url.pathname === '/api/v2/torrents/add') {
      const tags = /name="tags"\r\n\r\n([^\r]+)/.exec(await body())?.[1] || '';
      state.adds++;
      state.torrents = [{ hash: HASH, name: HASH, progress: 0, state: 'metaDL', save_path: media,
        content_path: path.join(media, 'pack'), tags, size: 0, added_on: Math.floor(Date.now() / 1000) }];
      res.end('Ok.'); return;
    }
    if (url.pathname === '/api/v2/torrents/delete') {
      state.deletes.push(Object.fromEntries(new URLSearchParams(await body()))); state.torrents = [];
      res.end('Ok.'); return;
    }
    if (/\/api\/v2\/torrents\//.test(url.pathname)) { await body(); res.end('Ok.'); return; }
    res.end(JSON.stringify(url.pathname === '/movie/7' ? { id: 7, title: 'Adult Title', adult: true, release_date: '2020-01-01' } : {}));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const source = await fs.readFile(path.join(app, 'src', 'server.js'), 'utf8');
  await fs.writeFile(path.join(app, 'src', 'server.js'), source.replace('https://api.themoviedb.org/3', mockBase));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local', TMDB_TOKEN: 'test', QBIT_URL: mockBase,
    CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0', ...env,
  }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    mock.closeAllConnections(); await new Promise((r) => mock.close(r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 7000);
    child.stdout.on('data', (c) => { if (String(c).includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });
  const request = async (endpoint, body, email = 'member@test.local', status = 200, type = 'application/json') => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: body !== undefined ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': email, 'content-type': type },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  await request('/api/me', undefined, 'owner@test.local');
  return { state, request, logs: () => logs };
}
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); }
};

test('adult names, .torrent files and TMDB titles are refused before qBittorrent', { timeout: 20000 }, async (t) => {
  const { state, request, logs } = await fixture(t);
  const res = await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}&dn=Vixen.24.01.05.Jane.Doe.XXX.1080p` }, undefined, 403);
  assert.match(res.error, /adult content/);
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: 'Brazzers House 3' }, undefined, 403);
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, movieId: 7, name: 'Clean' }, undefined, 403);
  const b = (s) => `${Buffer.byteLength(s)}:${s}`;
  const file = Buffer.from(`d4:infod5:filesld6:lengthi1e4:pathl${b('Scene.XXX.1080p.mp4')}eee4:name${b('Pack')}12:piece lengthi1e6:pieces0:ee`);
  await request('/api/downloads/add', file, undefined, 403, 'application/x-bittorrent');
  await request('/api/downloads/smart', { type: 'movie', tmdbId: 7 }, undefined, 403);
  assert.equal(state.adds, 0, 'nothing reached qBittorrent');
  assert.match(logs(), /\[content-filter\] blocked member@test\.local/);
  const feed = await request('/api/activity', undefined, 'owner@test.local');
  assert.ok(JSON.stringify(feed).includes('"blocked"'), 'the owner sees blocked attempts in the activity feed');
});

test('a download whose files turn out to be adult is removed with its files', { timeout: 20000 }, async (t) => {
  const { state, request } = await fixture(t);
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: 'Totally.Normal.Film.2020' });
  assert.equal(state.adds, 1);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(state.deletes.length, 0, 'no metadata yet: nothing removed');
  state.files = [{ name: 'pack/Brazzers.Scene.1080p.mp4', size: 10, progress: 0, priority: 1 }];
  await until(() => state.deletes.length === 1);
  assert.equal(state.deletes[0].hashes, HASH);
  assert.equal(state.deletes[0].deleteFiles, 'true');
});

test('CONTENT_FILTER=members leaves the owner alone but still filters members', { timeout: 20000 }, async (t) => {
  const { state, request } = await fixture(t, { CONTENT_FILTER: 'members' });
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: 'Brazzers House 3' }, undefined, 403);
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: 'Brazzers House 3' }, 'owner@test.local');
  state.files = [{ name: 'pack/Brazzers.Scene.mp4', size: 10, progress: 0, priority: 1 }];
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(state.adds, 1);
  assert.equal(state.deletes.length, 0, 'the owner’s own download is kept');
});
