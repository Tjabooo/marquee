import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { creditsStart, creditsFor } from '../credits.js';

const info = (title, start = '1900') => ({ format: { duration: '2100' }, chapters: [{ start_time: start, tags: { title } }] });

test('only explicit ending chapter labels provide credits timing', () => {
  for (const name of ['Credits', 'End Credits', 'Closing credits', 'Ending', 'Outro', 'ED']) {
    assert.equal(creditsStart(info(name)), 1900, name);
  }
  for (const name of ['Opening Credits', 'Post Credits', 'Post-Credits Scene', 'Chapter 12', 'A story about credits', 'Ending the war', '']) {
    assert.equal(creditsStart(info(name)), null, name);
  }
  for (const at of ['NaN', '-10', '0', '500', '2100', '2500']) assert.equal(creditsStart(info('Credits', at)), null);
  assert.equal(creditsStart({ chapters: info('Credits').chapters }), null);
  assert.equal(creditsStart({ format: { duration: 2100 }, chapters: {} }), null);
  const multi = info('Credits');
  multi.chapters.push({ start_time: '2000', tags: { title: 'End credits' } });
  assert.equal(creditsStart(multi), 1900);
});

test('chapter probe reads actual media, caches by file identity and degrades gracefully', async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg tools unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-credits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'sample.mp4'), meta = path.join(dir, 'chapters.txt');
  await fs.writeFile(meta, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=12000\ntitle=Episode\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=12000\nEND=20000\ntitle=End Credits\n');
  await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1:d=20',
    '-i', meta, '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'libx264', '-y', video]);
  assert.deepEqual(await Promise.all([creditsFor(video), creditsFor(video)]), [12, 12]);
  assert.equal(await creditsFor(video), 12);
  await fs.writeFile(video, 'not a video');
  assert.equal(await creditsFor(video), null, 'replaced file must not reuse the old credits marker');
  assert.equal(await creditsFor(path.join(dir, 'missing.mp4')), null);
});
