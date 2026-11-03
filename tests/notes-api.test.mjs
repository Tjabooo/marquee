import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NotesStore } from '../notes.js';

test('notes API denies non-admins and shares messages safely between admins', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-notes-api-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  const fileId = 'a'.repeat(64), privateFile = 'Private attachment fixture';
  const files = new NotesStore(app); await fs.mkdir(files.fileDir, { recursive: true });
  await fs.writeFile(path.join(files.fileDir, `${fileId}.bin`), privateFile);
  files.registerFile(fileId, { name: 'private.txt', mime: 'text/plain', size: privateFile.length }); files.close();
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@notes.test,admin@notes.test', CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
      child.stdout.on('data', (c) => { if (String(c).includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
    });
    const request = async (endpoint, body, email = 'owner@notes.test', expected = 200) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/admin/notes${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(email ? { 'cf-access-authenticated-user-email': email } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result));
      assert.match(response.headers.get('cache-control'), /no-store/); return result;
    };
    for (const email of ['member@notes.test', '']) {
      await request('', undefined, email, 403);
      await request('', { text: 'not allowed' }, email, 403);
      await request('/import', { messages: [] }, email, 403);
      await request('/1', undefined, email, 403);
      await request(`/files/${fileId}`, undefined, email, 403);
    }
    const { note } = await request('', { text: 'Private needle <script>alert(1)</script>' }, undefined, 201);
    assert.equal((await request('?q=needle', undefined, 'admin@notes.test')).notes[0].id, note.id);
    assert.equal((await request('?q=needle', undefined, 'admin@notes.test')).notes[0].authorName, 'owner');
    const changed = (await request(`/${note.id}`, { text: 'Updated shared note', version: note.version }, 'admin@notes.test')).note;
    assert.equal(changed.createdAt, note.createdAt);
    await request(`/${note.id}`, { text: 'stale overwrite', version: note.version }, undefined, 409);
    assert.equal((await request('?q=needle')).total, 0);
    const trashed = (await request(`/${note.id}/trash`, { version: changed.version })).note;
    assert.equal((await request('')).total, 0);
    await request(`/${note.id}/restore`, { version: trashed.version });
    assert.equal((await request('')).total, 1);
    const data = { messages: [{ id: '900000000000000001', text: 'Old note', createdAt: '2018-01-02T03:04:05.678Z' }] };
    assert.equal((await request('/import', data)).added, 1);
    assert.equal((await request('/import', data)).skipped, 1);
    assert.equal((await request('?q=old')).notes[0].createdAt, Date.parse(data.messages[0].createdAt));
    assert.ok(!logs.includes('Private needle'), 'Private note contents never enter the server log');
    await request('', null, undefined, 400);
    const download = await fetch(`http://127.0.0.1:${port}/api/admin/notes/files/${fileId}`, { headers: { 'cf-access-authenticated-user-email': 'owner@notes.test' } });
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.equal(await download.text(), privateFile);
  } finally {
    child.kill(); await new Promise((r) => child.once('exit', r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
