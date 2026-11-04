import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NotesStore } from '../notes.js';
import { previewOf, PREVIEW_BOT } from '../note-share.js';

test('preview text uses the first line as title and the rest as description', () => {
  const p = previewOf({ text: 'Buy milk\nand eggs\n\nsoon', attachments: [] });
  assert.equal(p.title, 'Buy milk'); assert.equal(p.desc, 'and eggs\nsoon'); assert.equal(p.image, null);
  const img = previewOf({ text: '', attachments: [{ fileId: 'b'.repeat(64), mime: 'image/png' }] });
  assert.equal(img.title, 'Note with 1 attachment'); assert.equal(img.image.mime, 'image/png');
  assert.ok(PREVIEW_BOT.test('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'));
  assert.ok(!PREVIEW_BOT.test('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'));
});

test('shared notes give bots a preview and send people to the protected app', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-note-share-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  const store = new NotesStore(app); await fs.mkdir(store.fileDir, { recursive: true });
  const fileId = 'c'.repeat(64), png = Buffer.from('89504e470d0a1a0a', 'hex');
  await fs.writeFile(path.join(store.fileDir, `${fileId}.bin`), png);
  store.registerFile(fileId, { name: 'pic.png', mime: 'image/png', size: png.length }); store.close();
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@notes.test', CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  const base = `http://127.0.0.1:${port}`;
  const owner = { 'cf-access-authenticated-user-email': 'owner@notes.test', 'content-type': 'application/json' };
  const post = (p, body = {}, headers = owner) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  const discord = { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
      child.stdout.on('data', (c) => { if (String(c).includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
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
    assert.match(html, new RegExp(`og:image" content="[^"]+${link}/image"`));
    const image = await fetch(`${base}${link}/image`);
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

    await post(`/api/admin/notes/${note.id}/trash`, { version: note.version });
    assert.equal((await fetch(base + link, { headers: discord })).status, 404, 'trashed notes stop being public');
    const restored = await (await post(`/api/admin/notes/${note.id}/restore`, { version: note.version + 1 })).json();
    assert.equal((await fetch(base + link, { headers: discord })).status, 200);
    const stopped = await (await post(`/api/admin/notes/${note.id}/unshare`)).json();
    assert.equal(stopped.note.shareToken, null); assert.equal(stopped.note.version, restored.note.version);
    assert.equal((await fetch(base + link, { headers: discord })).status, 404);
    assert.equal((await fetch(`${base}${link}/image`)).status, 404);
  } finally {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
