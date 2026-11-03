import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('clip renames persist without moving files or breaking public links; recommendation API honors quality', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-clip-api-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  // Only the external torrent service is replaced, in this isolated copy.
  await fs.writeFile(path.join(app, 'torrents.js'), `
    export const torrentsEnabled = () => true;
    export const searchTorrents = async () => ({ results: ['720p','1080p','1440p'].map((quality) => ({
      name: 'The.Matrix.1999.' + quality + '.BluRay', quality, seeders: quality === '720p' ? 500 : 40,
      size: 2 * 1024 ** 3, tags: [], cam: false, source: 'tpb'
    })) });
  `);
  const rel = 'Kept/Counter-Strike 2/Replay_2026-11-03.mp4', token = 'testsharetoken12';
  const id = crypto.createHash('sha1').update(rel.toLowerCase()).digest('base64url').slice(0, 16);
  const original = path.join(app, 'clips', rel), content = 'unchanged clip fixture';
  await fs.mkdir(path.dirname(original), { recursive: true }); await fs.writeFile(original, content);
  const stat = await fs.stat(original);
  await fs.mkdir(path.join(app, 'cache/clips/share'), { recursive: true });
  await fs.writeFile(path.join(app, `cache/clips/share/${id}.mp4`), content);
  await fs.writeFile(path.join(app, '.marquee-shares.json'), JSON.stringify({ [token]: { rel, at: Date.now() } }));
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@clips.test', CLIPS_DIR: path.join(app, 'clips'),
    CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', FFPROBE: path.join(app, 'no-probe'), SERVER_IP: '127.0.0.1' };
  let child, exited;
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    exited = new Promise((r) => child.once('exit', r));
    await new Promise((resolve, reject) => {
      let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
      child.stdout.on('data', (c) => { logs += c; if (logs.includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (c) => { logs += c; });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
    });
  };
  const request = async (route, body, email = 'owner@clips.test', status = 200) => {
    const response = await fetch(base + route, { headers: { ...(email ? { 'cf-access-authenticated-user-email': email } : {}), 'content-type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  try {
    await start();
    const initial = (await request('/api/clips')).clips[0]; assert.equal(initial.id, id);
    for (const email of ['member@clips.test', '']) await request(`/api/clips/${id}/rename`, { title: 'Denied' }, email, 403);
    for (const title of ['', ' ', 'a'.repeat(121), 'two\nlines', 123]) await request(`/api/clips/${id}/rename`, { title }, undefined, 400);
    await request(`/api/clips/${id}/rename`, null, undefined, 400);
    const title = 'Clutch <ace & win> / Nuke';
    const renamed = await request(`/api/clips/${id}/rename`, { title: `  ${title}  `, previousTitle: initial.title });
    assert.equal(renamed.title, title); assert.equal(renamed.id, id);
    await request(`/api/clips/${id}/rename`, { title: 'Stale overwrite', previousTitle: initial.title }, undefined, 409);
    const listed = (await request('/api/clips')).clips[0];
    assert.equal(listed.title, title); assert.equal(listed.share.token, token); assert.equal(listed.share.ready, true);
    assert.equal(await fs.readFile(original, 'utf8'), content); assert.equal((await fs.stat(original)).mtimeMs, stat.mtimeMs);
    assert.equal(await (await fetch(`${base}/c/${token}/video.mp4`)).text(), content);
    const page = await (await fetch(`${base}/c/${token}`)).text();
    assert.ok(page.includes('Clutch &lt;ace &amp; win&gt; / Nuke')); assert.ok(!page.includes('<ace & win>'));
    child.kill(); await exited; await start();
    assert.equal((await request('/api/clips')).clips[0].title, title, 'Rename survives a real server restart');

    const rec = '/api/torrents/recommend?title=The+Matrix&year=1999&type=movie';
    assert.equal((await request(rec)).pick.quality, '1080p');
    assert.equal((await request(rec + '&quality=720p')).pick.quality, '720p');
    assert.equal((await request(rec + '&quality=1080p')).pick.quality, '1080p');
    assert.equal((await request(rec + '&quality=1440p')).pick.quality, '1440p');
    assert.equal((await request('/api/me', { quality: '1440p' })).me.settings.quality, '1440p');
    assert.equal((await request('/api/me')).me.settings.quality, '1440p');
    assert.equal((await request(rec)).pick.quality, '1440p', 'Stored quality is used by Auto ranking');
    assert.equal((await request(rec + '&quality=2160p')).pick, null);
    await request(rec + '&quality=garbage', undefined, undefined, 400);
  } finally {
    if (child?.exitCode === null) child.kill(); if (exited) await exited;
    await fs.rm(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
