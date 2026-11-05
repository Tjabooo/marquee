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
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-download-life-'));
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

test('partial packs claim only ready selected episodes, preserve identity/dates, and share an existing torrent', { timeout: 15000 }, async (t) => {
  const { media, state, request, file } = await fixture(t);
  const one = 'pack/Example.Show.S01E01.mp4', two = 'pack/Example.Show.S01E02.mp4', three = 'pack/Example.Show.S01E03.mp4';
  state.files = [
    { name: one, progress: 1, size: 10, priority: 1 },
    { name: two, progress: 0.3, size: 10, priority: 1 },
    { name: three, progress: 1, size: 10, priority: 0 },
  ];
  await file(one); await file(two, 3); await file(three);
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: 'Example.Show.S01.COMPLETE', mediaType: 'tv', tvId: 42 });
  const pending = (await request('/api/downloads')).items[0];
  assert.equal(pending.mediaType, 'tv'); assert.equal(pending.tmdbId, 42); assert.equal(pending.showId, 'tv-42');
  assert.equal(pending.canonicalTitle, 'Example Show'); assert.match(pending.poster, /example\.jpg$/);
  assert.equal(pending.added, 1700000000000); assert.equal(pending.done, false); assert.equal(pending.transferComplete, false);
  assert.equal(pending.episodes.length, 2); assert.equal(pending.episodes[0].available, true); assert.ok(pending.episodes[0].libraryId);
  assert.equal(pending.episodes[1].available, false); assert.equal(pending.episodes[1].libraryId, null);
  assert.ok(!JSON.stringify(pending).includes(media), 'no storage paths are returned');
  const initial = await request('/api/library');
  assert.deepEqual(initial.items.map((v) => v.episode), [1]); assert.deepEqual(initial.server, []);
  const id = Buffer.from(two).toString('base64url');
  await request('/api/library/add', { ids: [id] }, undefined, 409);
  const before = initial.items[0];
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}` }, 'other@test.local');
  assert.equal(state.adds, 1, 'a second requester reuses the active infohash');
  const second = (await request('/api/downloads', undefined, 'other@test.local')).items[0];
  assert.equal(second.mine, true); assert.equal(second.canManage, false);
  assert.deepEqual((await request('/api/library', undefined, 'other@test.local')).items.map((v) => v.episode), [1]);
  await request(`/api/downloads/${HASH}/delete`, {}, undefined, 409);
  assert.equal(state.deletes.length, 0, 'shared bytes are never removed');
  state.files[1].progress = 1; await file(two); state.torrents[0].progress = 1; state.torrents[0].state = 'stoppedUP';
  const done = (await request('/api/downloads')).items[0];
  assert.equal(done.done, true); assert.equal(done.ready, true); assert.equal(done.libraryIds.length, 2);
  const final = await request('/api/library');
  assert.deepEqual(final.items.map((v) => v.episode).sort(), [1, 2]);
  const retained = final.items.find((v) => v.episode === 1);
  assert.equal(retained.addedAt, before.addedAt); assert.equal(retained.expiresAt, before.expiresAt);
  assert.deepEqual((await request('/api/library', undefined, 'other@test.local')).items.map((v) => v.episode).sort(), [1, 2]);
  const ownerView = (await request('/api/downloads?all=1', undefined, 'owner@test.local')).items[0];
  assert.deepEqual(ownerView.libraryIds, [], 'all-downloads view does not expose another viewer’s library membership');
  await request(`/api/downloads/${HASH}/delete`, { files: false });
  assert.equal(state.deletes[0].deleteFiles, 'false');
  assert.equal((await request('/api/library')).items.length, 2);
});

test('rejected adds do not reserve ownership; removed hashes can be downloaded and claimed by a new owner', { timeout: 15000 }, async (t) => {
  const { state, request, file } = await fixture(t);
  state.name = 'Example.2020.mp4'; state.files = [{ name: state.name, progress: 1, size: 10, priority: 1 }];
  state.rejectAdd = true;
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: state.name }, undefined, 400);
  state.rejectAdd = false;
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: state.name }, 'other@test.local');
  state.torrents[0].progress = 1; state.torrents[0].state = 'stoppedUP'; await file(state.name);
  await request('/api/downloads', undefined, 'other@test.local');
  assert.equal((await request('/api/library', undefined, 'other@test.local')).items.length, 1);
  assert.equal((await request('/api/library')).items.length, 0, 'rejected requester never owns a later successful download');
  await request(`/api/downloads/${HASH}/delete`, { files: false }, 'other@test.local');
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: state.name });
  state.torrents[0].progress = 1; state.torrents[0].state = 'stoppedUP';
  const current = (await request('/api/downloads')).items[0];
  assert.equal(current.canManage, true, 'new generation resets the previous owner and claim marker');
  assert.equal((await request('/api/library')).items.length, 1);
});

test('retry is authorized, unknown/missing/checking downloads are truthful, and login is coalesced', { timeout: 15000 }, async (t) => {
  const { state, request, file } = await fixture(t, { authenticated: true });
  state.name = 'Uncategorized.Release'; state.files = [{ name: 'video.mp4', progress: 1, size: 10, priority: 1 }];
  await Promise.all(Array.from({ length: 6 }, () => request('/api/downloads')));
  assert.equal(state.logins, 1);
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: state.name });
  state.torrents[0].progress = 1; state.torrents[0].state = 'missingFiles';
  const missing = (await request('/api/downloads')).items[0];
  assert.equal(missing.mediaType, null); assert.equal(missing.transferComplete, true); assert.equal(missing.done, false); assert.equal(missing.ready, false);
  await request(`/api/downloads/${HASH}/retry`, {}, 'other@test.local', 403);
  const users = await request('/api/admin/users', undefined, 'owner@test.local');
  const member = users.users.find((u) => u.email === 'member@test.local');
  await request(`/api/admin/users/${member.id}`, { canDownload: false }, 'owner@test.local');
  await request(`/api/downloads/${HASH}/retry`, {}, undefined, 403);
  await request(`/api/admin/users/${member.id}`, { canDownload: true }, 'owner@test.local');
  await request(`/api/downloads/${HASH}/retry`, {});
  assert.deepEqual(state.actions, ['recheck', 'start']);
  await file('video.mp4'); state.torrents[0].state = 'checkingUP';
  const checking = (await request('/api/downloads')).items[0];
  assert.equal(checking.done, false); assert.equal(checking.ready, false);
  state.torrents[0].state = 'stoppedUP';
  assert.equal((await request('/api/downloads')).items[0].ready, true);
});

test('a pending deletion prevents a new requester from claiming its files', { timeout: 15000 }, async (t) => {
  const { state, request, file } = await fixture(t);
  state.name = 'Example.2020.mp4'; state.files = [{ name: state.name, progress: 1, size: 10, priority: 1 }];
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: state.name });
  state.torrents[0].progress = 1; state.torrents[0].state = 'stoppedUP'; await file(state.name);
  await request('/api/downloads');
  let release; state.deleteGate = new Promise((r) => { release = r; });
  const deleting = request(`/api/downloads/${HASH}/delete`, {});
  for (let i = 0; i < 100 && !state.deletes.length; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(state.deletes.length, 1);
  try {
    await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}` }, 'other@test.local', 409);
    assert.equal((await request('/api/library', undefined, 'other@test.local')).items.length, 0);
  } finally { release(); await deleting; }
});

test('download outages preserve trusted owned videos and root-folder failures return an explicit error', { timeout: 15000 }, async (t) => {
  const { state, request, file } = await fixture(t);
  await file('Owned.2020.mp4'); await file('Unowned.2020.mp4');
  const initial = await request('/api/library');
  const owned = initial.server.find((v) => v.file === 'Owned.2020.mp4');
  await request('/api/library/add', { ids: [owned.id] });
  state.down = true;
  await request('/api/downloads', undefined, undefined, 502);
  const offline = await request('/api/library');
  assert.deepEqual(offline.items.map((v) => v.id), [owned.id]);
  assert.deepEqual(offline.server, [], 'unowned files stay unavailable until completion can be checked');
  const unavailable = await fixture(t, { missingMedia: true });
  await unavailable.request('/api/library', undefined, undefined, 503);
});

test('conversion waits for a trustworthy torrent inventory and never processes deselected or partial bytes', { timeout: 15000 }, async (t) => {
  const { media, state, request, file } = await fixture(t, { inspectCandidates: true });
  state.name = 'Example.Show.S01E01.mp4';
  const full = await file(state.name); const old = new Date(Date.now() - 600000); await fs.utimes(full, old, old);
  state.down = true;
  // null = inventory unavailable: the converter skips the whole scan, including cache cleanup.
  assert.equal((await request('/api/test-candidates')).items, null);
  state.down = false;
  state.torrents = [{ hash: HASH, name: state.name, progress: 0.5, state: 'downloading', save_path: media, content_path: full }];
  state.files = [{ name: state.name, progress: 0.5, size: 10, priority: 1 }];
  assert.deepEqual((await request('/api/test-candidates')).items, []);
  state.filesFail = true;
  assert.equal((await request('/api/test-candidates')).items, null);
  state.filesFail = false; state.files[0].progress = 1; state.files[0].priority = 0;
  state.torrents[0].progress = 1; state.torrents[0].state = 'stoppedUP';
  assert.deepEqual((await request('/api/test-candidates')).items, []);
  state.files[0].priority = 1;
  const verified = (await request('/api/test-candidates')).items;
  assert.equal(verified.length, 1); assert.equal(verified[0].deleteOriginal, false);
});

test('completed non-video downloads report complete without pretending to be playable', { timeout: 15000 }, async (t) => {
  const { state, request, file } = await fixture(t);
  state.name = 'Uncategorized.Archive'; state.files = [{ name: 'archive.zip', progress: 1, size: 10, priority: 1 }];
  await file('archive.zip');
  await request('/api/downloads/add', { link: `magnet:?xt=urn:btih:${HASH}`, name: state.name });
  state.torrents[0].progress = 1; state.torrents[0].state = 'stoppedUP';
  const result = (await request('/api/downloads')).items[0];
  assert.equal(result.mediaType, null); assert.equal(result.done, true); assert.equal(result.ready, false); assert.equal(result.hasVideo, false);
});
