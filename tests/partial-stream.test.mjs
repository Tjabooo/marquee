import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileLayout, readableBytes, fileProgress, startBytes, readyToStart, packPriorities, parsePartialId, PartialStreams, roomGate, ROOM_LEAD, ROOM_STOP } from '../src/partial-stream.js';
import { BufferNotice, RebufferHold, pastDownloaded, progressLine, fmtEta } from '../public/player-partial.js';
import { PhoneStreams } from '../src/phone-stream.js';

const PIECE = 1024;

test('a file is placed in its pieces, padding files included', () => {
  const files = [{ index: 0, size: 2500, piece_range: [0, 2] }, { index: 1, size: 5000, piece_range: [2, 7] }];
  assert.deepEqual(fileLayout(files, 1, PIECE), { offset: 2500, size: 5000, first: 2, last: 7 });
  // A hidden padding file pushed the second file onto the next piece boundary.
  const padded = [{ index: 0, size: 2500, piece_range: [0, 2] }, { index: 1, size: 5000, piece_range: [3, 7] }];
  assert.equal(fileLayout(padded, 1, PIECE).offset, 3072);
  assert.equal(fileLayout(files, 9, PIECE), null);
});

test('only finished pieces in a row count as readable', () => {
  const layout = { offset: 2500, size: 5000, first: 2, last: 7 };
  const states = [0, 0, 2, 2, 0, 2, 2, 2];
  assert.equal(readableBytes(layout, PIECE, states, 0), 2 * PIECE * 2 - 2500); // pieces 2-3, from 2500
  assert.equal(readableBytes(layout, PIECE, states, 1548), 48, 'to the end of piece 3');
  assert.equal(readableBytes(layout, PIECE, states, 1596), 0, 'piece 4 is missing');
  assert.equal(readableBytes(layout, PIECE, states, 2620), 5000 - 2620, 'stops at the end of the file, not the piece');
  assert.equal(readableBytes(layout, PIECE, null, 0), 0);
  assert.equal(readableBytes(layout, PIECE, [0, 0, 1, 1, 1, 1, 1, 1], 0), 0, 'state 1 is still downloading');
  assert.equal(fileProgress(layout, states), 5 / 6);
});

test('ids and the start amount', () => {
  assert.deepEqual(parsePartialId(`${'A'.repeat(40)}-3`), { hash: 'a'.repeat(40), index: 3 });
  assert.equal(parsePartialId('../etc-1'), null);
  assert.equal(parsePartialId(`${'a'.repeat(40)}`), null);
  assert.equal(startBytes(1000, 8e6), 1000, 'a small file needs all of itself');
  assert.equal(startBytes(1e10, 80e6), 200e6, '20 s of a 80 Mbit/s file');
  assert.equal(startBytes(1e10, 1e6), 8 * 1024 * 1024);
});

function rig(t, { size = 8192, state = 'downloading', seq = false, firstLast = false, files = null } = {}) {
  const calls = [];
  let states = new Array(Math.ceil(size / PIECE)).fill(0);
  const torrent = { hash: 'a'.repeat(40), state, seq_dl: seq, f_l_piece_prio: firstLast, force_start: false, dlspeed: 1000, save_path: '/x' };
  const list = files || [{ index: 0, name: 'Film.mkv', size, priority: 1, piece_range: [0, states.length - 1] }];
  const qbit = async (endpoint) => {
    if (endpoint.includes('/torrents/info')) return torrent.gone ? [] : [{ ...torrent }];
    if (endpoint.includes('/torrents/files')) return list;
    if (endpoint.includes('/torrents/properties')) return { piece_size: PIECE };
    if (endpoint.includes('/torrents/pieceStates')) return states;
    throw new Error(`unexpected ${endpoint}`);
  };
  const post = async (endpoint, body) => {
    calls.push([endpoint.split('/').pop(), Object.fromEntries(body)]);
    if (endpoint.endsWith('toggleSequentialDownload')) torrent.seq_dl = !torrent.seq_dl;
    if (endpoint.endsWith('toggleFirstLastPiecePrio')) torrent.f_l_piece_prio = !torrent.f_l_piece_prio;
    if (endpoint.endsWith('setForceStart')) torrent.force_start = body.get('value') === 'true';
  };
  return { calls, torrent, setStates: (s) => { states = s; }, states: () => states, make: async (file, extra = {}) => {
    const streams = new PartialStreams({ qbit, post, filePath: () => file, isVideo: () => true, start: async (hash) => { calls.push(['start', hash]); torrent.state = 'downloading'; },
      probe: async () => ({ duration: 100, bitrate: 1000, height: 1080 }), log: {}, ...extra });
    t.after(() => streams.close());
    return streams;
  } };
}

test('the loopback server holds a read until those pieces are verified, and never serves the holes', { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-partial-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Film.mkv');
  const real = Buffer.alloc(8192, 0xab);
  const onDisk = Buffer.alloc(8192); // holes read as zeros
  real.copy(onDisk, 0, 0, 2048);
  await fs.writeFile(file, onDisk);
  const r = rig(t);
  r.setStates([2, 2, 0, 0, 0, 0, 0, 0]);
  const streams = await r.make(file);
  const { entry } = await streams.open(`${'a'.repeat(40)}-0`);
  const url = await streams.inputUrl(entry);

  // A range inside the finished part.
  const head = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), 'bytes 0-1023/8192');
  assert.ok((await head.bytes()).every((b) => b === 0xab));

  // Reading the whole file stops at the holes...
  const whole = await fetch(url);
  assert.equal(whole.headers.get('content-length'), '8192');
  const reader = whole.body.getReader();
  const got = [];
  let total = 0;
  while (total < 2048) { const { value } = await reader.read(); got.push(value); total += value.length; }
  assert.equal(total, 2048);
  const pending = reader.read();
  const early = await Promise.race([pending.then(() => 'data'), new Promise((resolve) => setTimeout(() => resolve('held'), 1500))]);
  assert.equal(early, 'held', 'bytes of an unfinished piece must not be sent');
  // ...and carries on when they arrive.
  await fs.writeFile(file, real);
  r.setStates(new Array(8).fill(2));
  const { value } = await pending;
  got.push(value);
  total += value.length;
  while (total < 8192) { const next = await reader.read(); if (next.done) break; got.push(next.value); total += next.value.length; }
  assert.equal(total, 8192);
  assert.ok(Buffer.concat(got).every((b) => b === 0xab), 'no zeros from the holes');

  // Wrong token: nothing.
  assert.equal((await fetch(url.replace(streams.token, 'x'.repeat(48)))).status, 404);
  // Out of range.
  assert.equal((await fetch(url, { headers: { Range: 'bytes=9000-' } })).status, 416);
});

test('a reader that leaves while the loopback server waits for room ends the read and closes the file', { timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-partial-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Film.mkv');
  await fs.writeFile(file, Buffer.alloc(8192, 0xab));
  const r = rig(t);
  r.setStates(new Array(8).fill(2));
  const streams = await r.make(file);
  const { entry } = await streams.open(`${'a'.repeat(40)}-0`);
  // Count file handles the server opens and closes.
  const nodeFs = (await import('node:fs')).default;
  const realOpen = nodeFs.promises.open;
  let opened = 0, closed = 0;
  nodeFs.promises.open = async (...args) => {
    const fh = await realOpen(...args); opened++;
    const close = fh.close.bind(fh); fh.close = () => { closed++; return close(); };
    return fh;
  };
  t.after(() => { nodeFs.promises.open = realOpen; });
  // ffmpeg hangs up while a chunk is being written: the socket is gone, so neither 'drain' nor
  // 'close' will ever come again.
  const { EventEmitter } = await import('node:events');
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead() {}, end() {}, destroy() { this.destroyed = true; },
    write() { this.destroyed = true; this.emit('close'); return false; },
  });
  const req = { url: `/${streams.token}/${entry.id}/video.mkv`, headers: { range: 'bytes=0-8191' }, method: 'GET' };
  const outcome = await Promise.race([
    streams.serve(req, res).then(() => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('parked'), 3000)),
  ]);
  assert.equal(outcome, 'finished', 'the read must not wait for a response that already closed');
  assert.equal(opened, 1);
  assert.equal(closed, 1, 'the file handle is closed, not left to the garbage collector');
});

test('playing turns on in-order downloading and restores it when nobody watches any more', async (t) => {
  const r = rig(t, { firstLast: true });
  const streams = await r.make('/nowhere.mkv');
  const id = `${'a'.repeat(40)}-0`;
  await streams.open(id);
  await streams.open(id);
  assert.deepEqual(r.calls.map(([name]) => name), ['toggleSequentialDownload'], 'first/last was already on; nothing twice');
  assert.deepEqual([...streams.activeHashes()], ['a'.repeat(40)]);
  await streams.sweep(Date.now());
  assert.equal(streams.entries.size, 1, 'still watching');
  await streams.sweep(Date.now() + 4 * 60_000);
  assert.equal(streams.entries.size, 0);
  assert.equal(r.torrent.seq_dl, false, 'back to how it was');
  assert.equal(r.torrent.f_l_piece_prio, true, 'left as it was');
});

test('a stopped download starts, a queued one is forced, and pack episodes go first', async (t) => {
  const stopped = rig(t, { state: 'stoppedDL' });
  await (await stopped.make('/x.mkv')).open(`${'a'.repeat(40)}-0`);
  assert.ok(stopped.calls.some(([name]) => name === 'start'));

  const queued = rig(t, { state: 'queuedDL' });
  const q = await queued.make('/x.mkv');
  await q.open(`${'a'.repeat(40)}-0`);
  assert.equal(queued.torrent.force_start, true);
  await q.sweep(Date.now() + 4 * 60_000);
  assert.equal(queued.torrent.force_start, false, 'force start is undone again');

  // A pack: the file stays in line when nothing much comes before it, so nothing changes...
  const inLine = rig(t, { files: [
    { index: 0, name: 'E01.mkv', size: 4096, priority: 1, progress: 1, piece_range: [0, 3] },
    { index: 1, name: 'E02.mkv', size: 4096, priority: 1, progress: 0, piece_range: [4, 7] }] });
  const l = await inLine.make('/x.mkv');
  await l.open(`${'a'.repeat(40)}-1`);
  assert.equal(inLine.calls.filter(([name]) => name === 'filePrio').length, 0);

  // ...and top priority comes off it (and any later episode), because that would scramble the order. It goes back after.
  const topped = rig(t, { files: [
    { index: 0, name: 'E01.mkv', size: 4096, priority: 1, progress: 1, piece_range: [0, 3] },
    { index: 1, name: 'E02.mkv', size: 4096, priority: 7, progress: 0.1, piece_range: [4, 7] },
    { index: 2, name: 'E03.mkv', size: 4096, priority: 7, progress: 0, piece_range: [8, 11] }] });
  const o = await topped.make('/x.mkv');
  await o.open(`${'a'.repeat(40)}-1`);
  const prios = () => topped.calls.filter(([name]) => name === 'filePrio').map(([, b]) => [b.id, b.priority]);
  assert.deepEqual(prios(), [['1', '1'], ['2', '1']]);
  await o.sweep(Date.now() + 4 * 60_000);
  assert.deepEqual(prios().slice(2), [['1', '7'], ['2', '7']]);

  // Skipping far ahead: sequential would fetch the missing episodes first, so top priority is the better choice.
  const big = 2e9;
  const ahead = rig(t, { files: [
    { index: 0, name: 'E01.mkv', size: big, priority: 1, progress: 0, piece_range: [0, 3] },
    { index: 1, name: 'E02.mkv', size: 4096, priority: 1, progress: 0, piece_range: [4, 7] }] });
  const p = await ahead.make('/x.mkv');
  await p.open(`${'a'.repeat(40)}-1`);
  assert.deepEqual(ahead.calls.find(([name]) => name === 'filePrio')[1], { hash: 'a'.repeat(40), id: '1', priority: '7' });
  await p.sweep(Date.now() + 4 * 60_000);
  assert.deepEqual(ahead.calls.filter(([name]) => name === 'filePrio').at(-1)[1], { hash: 'a'.repeat(40), id: '1', priority: '1' });
});

test('ready only after the probe and enough of the start; a file that can never be read says so', async (t) => {
  const r = rig(t);
  let release;
  const streams = await r.make('/x.mkv', { probe: () => new Promise((resolve) => { release = resolve; }) });
  const id = `${'a'.repeat(40)}-0`;
  assert.equal((await streams.open(id)).ready, false);
  release({ duration: 100, bitrate: 1000, height: 1080 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await streams.open(id)).ready, false, 'the start of the file is not here yet');
  r.setStates(new Array(8).fill(2));
  streams.entries.get(id).statesAt = 0;
  const { ready, entry } = await streams.open(id);
  assert.equal(ready, true);
  const status = streams.status(entry);
  assert.equal(status.done, true);
  assert.equal(status.inOrder, 1);

  const bad = rig(t);
  const broken = await bad.make('/x.mkv', { probe: async () => { throw new Error('Couldn’t read this video.'); } });
  await broken.open(id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await broken.open(id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(broken.open(id), /Couldn’t read/);
});

test('a torrent removed while waiting ends the wait', async (t) => {
  const r = rig(t);
  const streams = await r.make('/x.mkv');
  const { entry } = await streams.open(`${'a'.repeat(40)}-0`);
  r.torrent.gone = true;
  await assert.rejects(streams.waitReadable(entry, 0), /no longer exists/);
});

test('a finished download leaving qBittorrent does not stop the person watching it', async (t) => {
  const r = rig(t);
  r.setStates(new Array(8).fill(2));
  const streams = await r.make('/x.mkv');
  const id = `${'a'.repeat(40)}-0`;
  await streams.open(id);
  await new Promise((resolve) => setTimeout(resolve, 5)); // the probe finishes
  r.torrent.gone = true;
  streams.entries.get(id).statesAt = 0;
  const { entry, ready } = await streams.open(id);
  assert.equal(entry.gone, true);
  assert.equal(ready, true);
  assert.equal(streams.finished(id), true);
  assert.equal(streams.status(entry).done, true);
  assert.equal(await streams.waitReadable(entry, 0), 8192);
});

test('a patient piece wait outlasts the idle limits and ends when the player leaves', { timeout: 8000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-partial-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { EventEmitter } = await import('node:events');
  const spawnFn = () => { const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child; };
  const phone = new PhoneStreams({ dir: path.join(dir, 'phone'), spawnFn, caps: { nvenc: false, x264: true, zscale: false } });
  t.after(() => phone.close());
  const info = { duration: 100, height: 1080, bitrate: 1e6, video: { index: 0 }, audios: [] };
  const s = await phone.open('k', { file: 'http://127.0.0.1:1/x', quality: 1080, info });
  assert.equal(s.file, 'http://127.0.0.1:1/x');
  const stop = new AbortController();
  const waiting = phone.segment(s, 0, { patient: true, signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = s.last;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(s.last > before, 'still counted as watching');
  stop.abort();
  await assert.rejects(waiting, (e) => e.status === 499);
});

test('the buffering popup waits longer at the start and stays away after Keep watching', () => {
  const n = new BufferNotice({ delay: 2500, startDelay: 8000, snooze: 1000 });
  assert.equal(n.wait(), 8000);
  n.playing();
  assert.equal(n.wait(), 2500);
  assert.equal(n.allowed(100), true);
  n.dismiss(100);
  assert.equal(n.allowed(500), false);
  assert.equal(n.allowed(1100), true);
});

test('the popup says how far the download is', () => {
  assert.equal(pastDownloaded(600, { duration: 1000, inOrder: 0.5 }), true);
  assert.equal(pastDownloaded(400, { duration: 1000, inOrder: 0.5 }), false);
  assert.equal(pastDownloaded(400, null), false);
  assert.equal(fmtEta(null), null);
  assert.equal(fmtEta(30), '1 min');
  assert.equal(progressLine({ progress: 0.9, eta: 30 }), '90% downloaded · less than a minute left');
  assert.equal(fmtEta(720), '12 min');
  assert.equal(fmtEta(3900), '1 h 5 min');
  assert.equal(progressLine({ progress: 0.43, eta: 720 }), '43% downloaded · about 12 min left');
  assert.equal(progressLine({ progress: 0.43, eta: null }), '43% downloaded · waiting for sources');
  assert.equal(progressLine({ progress: 0.43, paused: true, eta: 5 }), '43% downloaded · paused');
});

// The server probes the download with ffprobe; without it every open fails fast with 422 (macOS and
// Windows CI runners have no ffmpeg), so this end-to-end test needs it, like the other ffmpeg tests.
const { spawnSync: spawnSyncFf } = await import('node:child_process');
const hasFfmpeg = spawnSyncFf(process.env.FFMPEG || 'ffmpeg', ['-version']).status === 0 && spawnSyncFf(process.env.FFPROBE || 'ffprobe', ['-version']).status === 0;
test('downloads list Play now and only the people it belongs to can open it', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 30000 }, async (t) => {
  const { default: http } = await import('node:http');
  const { default: net } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-partial-api-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const hash = 'd'.repeat(40), name = 'Example.Film.2024.mkv', posts = [];
  let added = false;
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=test'); res.end('Ok.'); return; }
    if (url.pathname === '/api/v2/torrents/add') { added = true; req.resume(); res.end('Ok.'); return; }
    if (req.method === 'POST') { posts.push(url.pathname.split('/').pop()); req.resume(); res.end('Ok.'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v2/torrents/info') { res.end(JSON.stringify(added ? [{ hash, name, tags: '', progress: 0.1, state: 'downloading', save_path: media, content_path: path.join(media, name), size: 4096, seq_dl: false, f_l_piece_prio: false }] : [])); return; }
    if (url.pathname === '/api/v2/torrents/files') { res.end(JSON.stringify([{ index: 0, name, size: 4096, priority: 1, progress: 0.1, piece_range: [0, 3] }])); return; }
    if (url.pathname === '/api/v2/torrents/properties') { res.end(JSON.stringify({ piece_size: 1024 })); return; }
    if (url.pathname === '/api/v2/torrents/pieceStates') { res.end(JSON.stringify([0, 0, 0, 0])); return; }
    res.end('[]');
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
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
    child.kill(); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    mock.closeAllConnections(); await new Promise((r) => mock.close(r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 10000);
    child.stdout.on('data', (c) => { const ready = /Lilin is running: http:\/\/localhost:(\d+)/.exec(String(c)); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  const call = (endpoint, email, body) => fetch(`http://127.0.0.1:${port}${endpoint}`, { method: body ? 'POST' : 'GET',
    headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  await call('/api/me', 'owner@test.local');
  assert.equal((await call('/api/downloads/add', 'member@test.local', { link: `magnet:?xt=urn:btih:${hash}`, name })).status, 200);
  const [d] = (await (await call('/api/downloads', 'member@test.local')).json()).items;
  assert.equal(d.canPlayNow, true);
  assert.equal(d.files[0].index, 0);
  const id = `${hash}-0`;
  assert.equal((await call(`/api/part/open?id=${id}`, 'stranger@test.local')).status, 403, 'someone else\u2019s download');
  assert.equal(posts.includes('toggleSequentialDownload'), false, 'a refused request changes nothing');
  assert.equal((await call('/api/part/open?id=../../etc-0', 'member@test.local')).status, 400);
  const opened = await call(`/api/part/open?id=${id}`, 'member@test.local');
  assert.equal(opened.status, 202, 'nothing has arrived yet');
  assert.equal((await opened.json()).ready, false);
  assert.ok(posts.includes('toggleSequentialDownload') && posts.includes('toggleFirstLastPiecePrio'));
  // The file itself can't be fetched while it downloads, signed or not.
  assert.equal((await call(`/api/play-link?kind=part&id=${id}&variant=browser`, 'member@test.local')).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/play/part/${id}/phone1080/9999999999/${'x'.repeat(32)}/index.m3u8`)).status, 403);

  // Watch Together on it: only those who may watch the download can host; the room lets a guest in.
  const host = 'host-client-0123456789', guest = 'guest-client-0123456789';
  assert.equal((await call('/api/watch', 'stranger@test.local', { id, clientId: guest })).status, 403);
  const made = await call('/api/watch', 'member@test.local', { id, clientId: host });
  assert.equal(made.status, 200);
  const room = await made.json();
  assert.equal(room.media.kind, 'part'); assert.equal(room.media.id, id); assert.equal(room.media.mediaKey != null, true);
  const base = `/api/watch/${room.token}`;
  assert.equal((await call(`${base}/join`, 'stranger@test.local', { clientId: guest })).status, 200);
  const link = await call(`${base}/play-link?clientId=${guest}`, 'stranger@test.local');
  assert.equal(link.status, 200);
  assert.equal((await link.json()).ready, false, 'the guest waits for the start like anyone');
  const status = await (await call(`${base}/part-status?clientId=${guest}`, 'stranger@test.local')).json();
  assert.equal(status.done, false); assert.equal(status.libraryId, null);
  assert.equal((await call(`${base}/switch`, 'stranger@test.local', { clientId: guest })).status, 403, 'only the host switches');
  assert.equal((await call(`${base}/switch`, 'member@test.local', { clientId: host })).status, 409, 'nothing to switch to yet');
  await new Promise((r) => setTimeout(r, 2500)); // the room check runs every 2 s
  const beat = await (await call(`${base}/heartbeat`, 'member@test.local', { clientId: host, ready: true })).json();
  assert.equal(beat.download?.holding, true, 'held until the download is far enough ahead');
});

test('pack priorities: skipped files stay skipped, finished ones are left alone', () => {
  const files = [
    { index: 0, size: 5e9, priority: 0, progress: 0 },
    { index: 1, size: 5e9, priority: 7, progress: 1 },
    { index: 2, size: 5e9, priority: 1, progress: 0 }];
  assert.deepEqual(packPriorities(files, 2), [], 'nothing wanted is missing before it');
  assert.deepEqual(packPriorities([{ size: 1e8, priority: 1, progress: 0 }, { size: 5e9, priority: 1, progress: 0 }], 1), [], 'a small extra before it is quick');
  assert.deepEqual(packPriorities(files, 9), []);
});

test('start lead: the full goal right away, otherwise the minimum after a grace period', () => {
  const size = 1e10, bitrate = 16e6; // 2 MB/s: minimum 40 MB, goal 90 MB
  assert.equal(startBytes(size, bitrate), 40e6);
  assert.equal(startBytes(size, bitrate, 45), 90e6);
  assert.equal(readyToStart(90e6, size, bitrate, null, 1000), true, 'goal reached');
  assert.equal(readyToStart(50e6, size, bitrate, null, 1000), false);
  assert.equal(readyToStart(50e6, size, bitrate, 1000, 1000 + 19_000), false, 'still within the grace period');
  assert.equal(readyToStart(50e6, size, bitrate, 1000, 1000 + 20_000), true, 'stops waiting for the goal');
  assert.equal(readyToStart(1000, 1000, bitrate, null, 1000), true, 'a tiny file is all there');
});

test('rebuffer hold: waits for a useful buffer, longer when stalls repeat, and never for ever', () => {
  const h = new RebufferHold({ goals: [8, 16, 32], floor: 4, maxHoldMs: 30_000, memoryMs: 90_000 });
  assert.equal(h.holding, false);
  h.begin(1000);
  assert.equal(h.holding, true);
  assert.equal(h.goal, 8);
  assert.equal(h.ready(4, Infinity, 2000), false);
  assert.equal(h.ready(8, Infinity, 2000), true);
  h.end(3000);
  h.begin(4000);
  assert.equal(h.goal, 16, 'soon after the last stall: wait for more');
  assert.equal(h.ready(10, 100, 5000), false);
  assert.equal(h.ready(10, 10, 5000), true, 'the rest of the video is all buffered');
  assert.equal(h.ready(3, Infinity, 4000 + 31_000), false, 'too little to be worth moving');
  assert.equal(h.ready(4, Infinity, 4000 + 31_000), true, 'gives up on the goal after a while');
  h.end(5000);
  h.begin(6000); h.end(7000); h.begin(8000); h.end(9000); h.begin(10_000);
  assert.equal(h.goal, 32, 'tops out');
  h.end(11_000);
  h.begin(11_000 + 90_001);
  assert.equal(h.goal, 8, 'a good stretch starts over');
});

test('a Watch Together room on a download waits for a lead it can keep', () => {
  const film = { duration: 6000, done: false };
  // Keeps up (twice real time): plays once 30 s are there, stops only when nearly out.
  assert.deepEqual(roomGate({ ...film, position: 0, edge: 10, rate: 2, holding: true }), { holding: true, wait: 20 / 1.7 });
  assert.equal(roomGate({ ...film, position: 0, edge: ROOM_LEAD, rate: 2, holding: true }).holding, false);
  assert.equal(roomGate({ ...film, position: 100, edge: 100 + ROOM_STOP + 1, rate: 2, holding: false }).holding, false);
  assert.equal(roomGate({ ...film, position: 100, edge: 100 + ROOM_STOP - 1, rate: 2, holding: false }).holding, true);
  // Half real time: waits until the rest arrives before playback gets there, or 5 minutes are buffered.
  const slow = roomGate({ ...film, position: 0, edge: 60, rate: 0.5, holding: true });
  assert.equal(slow.holding, true);
  assert.ok(Math.abs(slow.wait - (300 - 60) / 0.425) < 1e-6, 'the 5-minute lead comes sooner than a full finish here');
  assert.equal(roomGate({ ...film, position: 0, edge: 300, rate: 0.5, holding: true }).holding, false);
  // Near the end of the download: no long lead needed.
  const short = roomGate({ ...film, position: 5900, edge: 5960, rate: 0.9, holding: true });
  assert.equal(short.holding, false);
  // No speed (paused, no peers): it can't say when.
  assert.deepEqual(roomGate({ ...film, position: 0, edge: 5, rate: 0, holding: true }), { holding: true, wait: null });
  // Finished, or all there: never holds.
  assert.equal(roomGate({ ...film, done: true, position: 0, edge: 0, rate: 0, holding: true }).holding, false);
  assert.equal(roomGate({ ...film, position: 0, edge: 6000, rate: 0, holding: true }).holding, false);
  // A seek past the download waits for it to get there plus the lead.
  const ahead = roomGate({ ...film, position: 1000, edge: 400, rate: 2, holding: false });
  assert.equal(ahead.holding, true); assert.ok(Math.abs(ahead.wait - 630 / 1.7) < 1e-6);
});

test('a crawling download gives no start estimate rather than days', () => {
  assert.deepEqual(roomGate({ duration: 6000, done: false, position: 0, edge: 5, rate: 0.0001, holding: true }), { holding: true, wait: null });
});
