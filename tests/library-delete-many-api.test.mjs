import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HASH = 'd'.repeat(40);
async function fixture(t, { authenticated = false, missingMedia = false, inspectCandidates = false } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-delete-many-'));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const state = { torrents: [], files: [], adds: 0, deletes: [], actions: [], logins: 0,
    fileRequests: 0, inventoryRequests: 0, rejectAdd: false, down: false, deleteGate: null, filesFail: false };
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (state.down) { res.writeHead(503); res.end('Unavailable'); return; }
    if (url.pathname === '/api/v2/auth/login') {
      state.logins++; await new Promise((r) => setTimeout(r, 15));
      res.setHeader('Set-Cookie', 'SID=test'); res.end('Ok.'); return;
    }
    if (authenticated && req.headers.cookie !== 'SID=test') { res.writeHead(403); res.end(); return; }
    if (url.pathname === '/api/v2/torrents/info') {
      if (!url.searchParams.has('hashes')) state.inventoryRequests++;
      const hashes = url.searchParams.get('hashes');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(hashes ? state.torrents.filter((v) => hashes.split('|').includes(v.hash)) : state.torrents)); return;
    }
    if (url.pathname === '/api/v2/torrents/files') {
      if (state.filesFail) { res.writeHead(503); res.end(); return; }
      state.fileRequests++; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state.files)); return;
    }
    if (url.pathname === '/api/v2/torrents/add') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (state.rejectAdd) { res.end('Fails.'); return; }
      state.adds++;
      const tags = /name="tags"\r\n\r\n([^\r]+)/.exec(Buffer.concat(chunks).toString())?.[1] || '';
      state.torrents = [{ hash: HASH, name: state.name || 'Example.Show.S01.COMPLETE', progress: 0.5,
        state: 'downloading', save_path: media, content_path: path.join(media, 'pack'),
        tags, size: 20, added_on: 1700000000 }];
      res.end('Ok.'); return;
    }
    if (/\/api\/v2\/torrents\/(delete|recheck|start|stop|pause|resume|filePrio)$/.test(url.pathname)) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const action = path.basename(url.pathname); state.actions.push(action);
      if (action === 'delete') {
        state.deletes.push(Object.fromEntries(body));
        if (state.deleteGate) await state.deleteGate;
        state.torrents = [];
      }
      res.end('Ok.'); return;
    }
    const result = url.pathname === '/tv/42' ? { id: 42, name: 'Example Show', first_air_date: '2020-01-01', poster_path: '/example.jpg', seasons: [] }
      : url.pathname === '/search/tv' ? { results: [{ id: 42, name: 'Example Show' }] }
        : url.pathname.startsWith('/tv/42/season/') ? { episodes: [] } : {};
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  let source = await fs.readFile(path.join(app, 'src', 'server.js'), 'utf8');
  if (inspectCandidates) source = source.replace("  if (p === '/api/library') {", "  if (p === '/api/test-candidates') return sendJson(res, 200, { items: await conversionCandidates() });\n  if (p === '/api/library') {");
  await fs.writeFile(path.join(app, 'src', 'server.js'), source.replace('https://api.themoviedb.org/3', mockBase));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local', TMDB_TOKEN: 'test', QBIT_URL: mockBase,
    CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0',
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
  const request = async (endpoint, body, email = 'member@test.local', status = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: body !== undefined ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const file = async (name, size = 10) => {
    const full = path.join(media, name); await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.alloc(size)); return full;
  };
  await request('/api/me', undefined, 'owner@test.local');
  if (missingMedia) await fs.rm(media, { recursive: true });
  return { app, media, state, request, file };
}

const EPS = ['pack/Example.Show.S01E01.mp4', 'pack/Example.Show.S01E02.mp4', 'pack/Example.Show.S01E03.mp4'];
async function seasonPack(t) {
  const fx = await fixture(t);
  fx.state.files = EPS.map((name) => ({ name, progress: 1, size: 10, priority: 1 }));
  for (const name of EPS) await fx.file(name);
  await fx.request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: 'Example.Show.S01.COMPLETE', mediaType: 'tv', tvId: 42 });
  Object.assign(fx.state.torrents[0], { progress: 1, state: 'stoppedUP' });
  await fx.request('/api/downloads');
  const ids = (await fx.request('/api/library')).items.map((v) => v.id);
  assert.equal(ids.length, 3);
  return { ...fx, ids };
}
const exists = (p) => fs.access(p).then(() => true, () => false);

test('deleting a whole season removes its download from qBittorrent in one go', { timeout: 15000 }, async (t) => {
  const { media, state, request, ids } = await seasonPack(t);
  const info = await request('/api/library/delete-many-info', { ids });
  assert.equal(info.videos, 3); assert.equal(info.shared, 0); assert.equal(info.downloads, 1); assert.equal(info.size, 30);
  assert.equal(info.canDeleteForEveryone, false);
  const r = await request('/api/library/delete-many', { ids });
  assert.equal(r.deleted, 3); assert.equal(r.failed, 0);
  assert.equal(state.deletes.length, 1, 'one torrent delete'); assert.equal(state.deletes[0].deleteFiles, 'true');
  assert.ok(!state.actions.includes('filePrio'));
  assert.deepEqual((await request('/api/library')).items, []);
  assert.ok(await exists(path.join(media, EPS[0])), 'qBittorrent (mocked) owns the file removal');
});

test('deleting part of a pack deselects just those files and keeps the torrent', { timeout: 15000 }, async (t) => {
  const { media, state, request, ids } = await seasonPack(t);
  const lib = (await request('/api/library')).items;
  const pick = lib.filter((v) => v.episode !== 3).map((v) => v.id);
  const info = await request('/api/library/delete-many-info', { ids: pick });
  assert.equal(info.downloads, 0); assert.equal(info.size, 20);
  const r = await request('/api/library/delete-many', { ids: pick });
  assert.equal(r.deleted, 2);
  assert.equal(state.deletes.length, 0);
  assert.equal(state.actions.filter((a) => a === 'filePrio').length, 2);
  assert.equal(await exists(path.join(media, EPS[0])), false); assert.equal(await exists(path.join(media, EPS[2])), true);
  assert.deepEqual((await request('/api/library')).items.map((v) => v.episode), [3]);
  assert.ok(ids.length === 3);
});

test('shared episodes only leave your library; the owner can delete them for everyone', { timeout: 15000 }, async (t) => {
  const { media, state, request, ids } = await seasonPack(t);
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}` }, 'other@test.local');
  await request('/api/downloads', undefined, 'other@test.local');
  assert.equal((await request('/api/library', undefined, 'other@test.local')).items.length, 3);
  const info = await request('/api/library/delete-many-info', { ids });
  assert.equal(info.shared, 3); assert.equal(info.downloads, 0); assert.equal(info.size, 0);
  const r = await request('/api/library/delete-many', { ids });
  assert.equal(r.removed, 3); assert.equal(r.deleted, 0);
  assert.equal(state.deletes.length, 0); assert.ok(await exists(path.join(media, EPS[0])));
  assert.deepEqual((await request('/api/library')).items, []);
  await request('/api/library/delete-many', { ids }, undefined, 403);
  const ownerInfo = await request('/api/library/delete-many-info', { ids }, 'owner@test.local');
  assert.equal(ownerInfo.canDeleteForEveryone, true); assert.equal(ownerInfo.sizeForEveryone, 30);
  const all = await request('/api/library/delete-many', { ids, everyone: true }, 'owner@test.local');
  assert.equal(all.deleted, 3); assert.equal(state.deletes.length, 1);
  assert.deepEqual((await request('/api/library', undefined, 'other@test.local')).items, []);
});

test('bulk delete validates its input', { timeout: 15000 }, async (t) => {
  const { request } = await fixture(t);
  await request('/api/library/delete-many', { ids: [] }, undefined, 400);
  await request('/api/library/delete-many', {}, undefined, 400);
  await request('/api/library/delete-many-info', { ids: [Buffer.from('../outside.mp4').toString('base64url')] }, undefined, 400);
});
