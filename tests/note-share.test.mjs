import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NotesStore } from '../src/notes.js';
import { previewOf, PREVIEW_BOT } from '../src/note-share.js';

test('preview text uses the first line as title and the rest as description', () => {
  const p = previewOf({ text: 'Buy milk\nand eggs\n\nsoon', attachments: [] });
  assert.equal(p.title, 'Buy milk'); assert.equal(p.desc, 'and eggs\nsoon'); assert.deepEqual(p.images, []);
  const img = previewOf({ text: '', attachments: [{ fileId: 'b'.repeat(64), mime: 'image/png' }] });
  assert.equal(img.title, 'Note with 1 attachment'); assert.equal(img.images[0].mime, 'image/png'); assert.equal(img.video, null);
  assert.ok(PREVIEW_BOT.test('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'));
  assert.ok(!PREVIEW_BOT.test('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'));
});

test('shared notes give bots a preview and send people to the protected app', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-note-share-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const store = new NotesStore(app); await fs.mkdir(store.fileDir, { recursive: true });
  const fileId = 'c'.repeat(64), png = Buffer.from('89504e470d0a1a0a', 'hex');
  await fs.writeFile(path.join(store.fileDir, `${fileId}.bin`), png);
  store.registerFile(fileId, { name: 'pic.png', mime: 'image/png', size: png.length }); store.close();
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@notes.test', CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  let base = ''; // set once the server reports its port
  const owner = { 'cf-access-authenticated-user-email': 'owner@notes.test', 'content-type': 'application/json' };
  const post = (p, body = {}, headers = owner) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  const discord = { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
      child.stdout.on('data', (c) => { const ready = /Lilin is running: http:\/\/localhost:(\d+)/.exec(String(c)); if (ready) { port = Number(ready[1]); base = `http://127.0.0.1:${port}`; clearTimeout(timer); resolve(); } });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
    });
    const { note } = await (await post('/api/admin/notes', { text: 'Secret plan\nmeet at <8>', attachments: [{ fileId }] })).json();
    assert.equal(note.shareToken, null);
    assert.equal((await post(`/api/admin/notes/${note.id}/share`, {}, { 'cf-access-authenticated-user-email': 'guest@notes.test' })).status, 403);
    const shared = await (await post(`/api/admin/notes/${note.id}/share`)).json();
    assert.match(shared.url, /\/c\/n\/[A-Za-z0-9_-]{16}$/);
    assert.equal(shared.note.version, note.version, 'sharing is not an edit');
    const again = await (await post(`/api/admin/notes/${note.id}/share`)).json();
    assert.equal(again.url, shared.url, 'sharing twice keeps the link');
    const link = new URL(shared.url).pathname;

    const human = await fetch(base + link, { redirect: 'manual' });
    assert.equal(human.status, 302); assert.equal(human.headers.get('location'), `/?note=${note.id}`);
    assert.doesNotMatch(await human.text(), /Secret/);

    const bot = await fetch(base + link, { headers: discord });
    const html = await bot.text();
    assert.equal(bot.status, 200);
    assert.match(html, /property="og:title" content="Secret plan"/);
    assert.match(html, /meet at &lt;8&gt;/);
    assert.match(html, new RegExp(`og:image" content="[^"]+${link}/image/0"`));
    assert.doesNotMatch(html, /og:video/);
    const image = await fetch(`${base}${link}/image/0`);
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

    await post(`/api/admin/notes/${note.id}/trash`, { version: note.version });
    assert.equal((await fetch(base + link, { headers: discord })).status, 404, 'trashed notes stop being public');
    const restored = await (await post(`/api/admin/notes/${note.id}/restore`, { version: note.version + 1 })).json();
    assert.equal((await fetch(base + link, { headers: discord })).status, 200);
    const stopped = await (await post(`/api/admin/notes/${note.id}/unshare`)).json();
    assert.equal(stopped.note.shareToken, null); assert.equal(stopped.note.version, restored.note.version);
    assert.equal((await fetch(base + link, { headers: discord })).status, 404);
    assert.equal((await fetch(`${base}${link}/image/0`)).status, 404);
  } finally {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
test('a shared video gets a Discord-friendly MP4 and thumbnail anyone can load', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-note-video-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const store = new NotesStore(app); await fs.mkdir(store.fileDir, { recursive: true });
  // a .mov in a codec Discord can't play (MPEG-4 Part 2), standing in for a phone video
  const fileId = 'd'.repeat(64), mov = path.join(store.fileDir, `${fileId}.bin`);
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-f', 'mov', mov]);
  assert.equal(made.status, 0, String(made.stderr));
  store.registerFile(fileId, { name: 'IMG_0001.mov', mime: 'video/quicktime', size: (await fs.stat(mov)).size }); store.close();
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@notes.test', CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  let base = ''; // set once the server reports its port
  const owner = { 'cf-access-authenticated-user-email': 'owner@notes.test', 'content-type': 'application/json' };
  const post = (p, body = {}) => fetch(base + p, { method: 'POST', headers: owner, body: JSON.stringify(body) }).then((r) => r.json());
  const discord = { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
      child.stdout.on('data', (c) => { const ready = /Lilin is running: http:\/\/localhost:(\d+)/.exec(String(c)); if (ready) { port = Number(ready[1]); base = `http://127.0.0.1:${port}`; clearTimeout(timer); resolve(); } });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
    });
    const { note } = await post('/api/admin/notes', { text: '', attachments: [{ fileId }] });
    const shared = await post(`/api/admin/notes/${note.id}/share`);
    assert.equal(shared.note.shareMedia.ready, false, 'the copy is made after sharing');
    let state = shared.note;
    for (let i = 0; i < 100 && !state.shareMedia.ready && !state.shareMedia.error; i++) {
      await new Promise((r) => setTimeout(r, 200));
      state = (await (await fetch(`${base}/api/admin/notes/${note.id}`, { headers: owner })).json()).note;
    }
    assert.equal(state.shareMedia.error, null); assert.equal(state.shareMedia.ready, true);
    const link = new URL(shared.url).pathname;
    const html = await (await fetch(base + link, { headers: discord })).text();
    assert.match(html, new RegExp(`og:video" content="[^"]+${link}/video.mp4"`));
    assert.match(html, new RegExp(`og:image" content="[^"]+${link}/thumb.jpg"`));
    assert.match(html, /og:video:width" content="320"/);
    const video = await fetch(`${base}${link}/video.mp4`, { headers: { range: 'bytes=0-' } });
    assert.ok([200, 206].includes(video.status)); assert.equal(video.headers.get('content-type'), 'video/mp4');
    const copy = path.join(app, 'cache', 'notes-share', `${fileId}.mp4`);
    const codecs = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', copy]).stdout).trim().split(/\s+/);
    assert.deepEqual(codecs, ['h264', 'aac']);
    const thumb = await fetch(`${base}${link}/thumb.jpg`);
    assert.equal(thumb.status, 200); assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    await post(`/api/admin/notes/${note.id}/unshare`);
    assert.equal((await fetch(`${base}${link}/video.mp4`)).status, 404);
    assert.deepEqual(await fs.readdir(path.join(app, 'cache', 'notes-share')), [], 'copies are removed when the link goes');
  } finally {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
