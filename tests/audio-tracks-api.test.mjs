import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('selected audio links bind source and stream and retain signed range playback', { timeout: 20000 }, async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg unavailable'); return; }
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-audio-api-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const media = path.join(app, 'media'); await fs.mkdir(media);
  const name = 'Example.Show.S01E01.mp4', file = path.join(media, name);
  await run(process.env.FFMPEG || 'ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=2:d=4',
    '-f','lavfi','-i','sine=frequency=440:duration=4','-f','lavfi','-i','sine=frequency=880:duration=4',
    '-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-c:a','aac',
    '-metadata:s:a:0','language=eng','-metadata:s:a:1','language=kor','-y',file]);
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  for (const entry of await fs.readdir(root)) if (entry.endsWith('.js') || entry === 'package.json') await fs.copyFile(path.join(root, entry), path.join(app, entry));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MEDIA_DIR: media, ADMIN_EMAILS: 'owner@test.local',
    CONVERT: 'off', SUBSYNC: 'off', TORRENTS: 'off', CAST_APPLETV: 'off', SERVER_IP: '127.0.0.1', PREPARE_NEXT_EPISODES: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + logs)), 7000);
    child.stdout.on('data', (c) => { const ready = /Marquee is running: http:\/\/localhost:(\d+)/.exec(String(c)); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (url, status = 200) => {
    const response = await fetch(base + url, { headers: { 'cf-access-authenticated-user-email': 'owner@test.local' } });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const id = Buffer.from(name).toString('base64url');
  const audio = await request(`/api/media/lib/${id}/audio`);
  assert.deepEqual(audio.tracks.map((t) => t.language), ['eng', 'kor']);
  assert.equal(audio.defaultAudio, 1);
  const query = `/api/play-link?kind=lib&id=${id}&audio=2&audioSource=${audio.audioSource}`;
  await request(query.replace('audio=2','audio=99'),400);
  await request(query.replace(audio.audioSource,'bad'),409);
  let response = await fetch(base + query), link = await response.json();
  assert.equal(response.status, 202);
  const deadline = Date.now()+10000;
  do { await new Promise((r)=>setTimeout(r,30)); response=await fetch(base+query); link=await response.json(); }
  while (response.status===202 && Date.now()<deadline);
  assert.equal(response.status,200,JSON.stringify(link));
  assert.equal(link.ready,true); assert.equal(link.track,2); assert.equal(link.audioSource,audio.audioSource);
  const stream = await fetch(base+link.url,{headers:{Range:'bytes=0-31'}});
  assert.equal(stream.status,206); assert.equal((await stream.arrayBuffer()).byteLength,32);
  const tampered = await fetch(base+link.url.replace('browser-a2-','browser-a1-'));
  assert.equal(tampered.status,403); await tampered.body.cancel();
  await fs.appendFile(file,Buffer.alloc(16));
  const expired = await fetch(base+link.url); assert.equal(expired.status,410); await expired.body.cancel();
});
