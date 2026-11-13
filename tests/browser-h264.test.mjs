import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

// A new HEVC download gets its H.264 browser copy in the background, without anyone pressing Play,
// so a browser without HEVC (Firefox) can start it right away.
test('a freshly downloaded HEVC file gets an H.264 browser copy before anyone plays it', { timeout: 90000 }, async (t) => {
  const run = promisify(execFile);
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  try { await run(ffmpeg, ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-h264-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Film.2026.2160p.WEB-DL.mp4');
  try {
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=4:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx265', '-x265-params', 'log-level=error',
      '-tag:v', 'hvc1', '-c:a', 'aac', '-y', file]);
  } catch { t.skip('FFmpeg without libx265'); return; }

  process.env.MIN_FREE_GB = '0'; // the test machine's free space isn't what this test is about
  const convert = await import('../src/convert.js?browser-h264-test');
  await convert.startConverter({ dataDir: dir, listCandidates: async () => [{ file, deleteOriginal: false }] });
  // hvc1 HEVC counts as playable for Safari/Chrome, so the old audio/video check never made a copy.
  assert.equal(convert.videoBrowserSafe(await convert.probeVideo(file)), true);

  const copy = convert.h264Path(file);
  assert.notEqual(copy, convert.fixPath(file), 'the H.264 copy never replaces the audio-fixed copy');
  const deadline = Date.now() + 60000;
  while (!existsSync(copy) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.ok(existsSync(copy), 'the browser copy was made by the background scan');
  const v = await convert.probeVideo(copy);
  assert.equal(v.codec, 'h264');
  assert.equal(v.tenBit, false);
  assert.equal(convert.preferConverted(file, { browser: true }), copy);
  assert.equal(convert.preferConverted(file, { browser: true, hevc: true }), file, 'browsers that play HEVC keep the original');
  assert.equal(convert.preferConverted(file), file, 'TVs keep the original');
  assert.equal((await fs.stat(file)).size > 0, true);
});


test('an unavailable candidate inventory preserves existing browser copies', { timeout: 20000 }, async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg unavailable'); return; }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-cache-outage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cache = path.join(dir, 'cache', 'audio');
  await fs.mkdir(cache, { recursive: true });
  const existing = path.join(cache, '0123456789abcdef01234567.mp4');
  await fs.writeFile(existing, 'valid browser copy');
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  await fs.utimes(existing, old, old);

  const convert = await import('../src/convert.js?cache-outage-test');
  await convert.startConverter({ dataDir: dir, listCandidates: async () => null });

  // Initial scan runs after five seconds. If null were treated as [], cleanFixDir() would remove this
  // cached copy because it is older than one hour.
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(existsSync(existing), true, 'temporary inventory failure must not delete browser cache files');
});

// More recent HEVC files than BROWSER_COPIES_MAX_GB holds made the cache evict a copy, the next scan queue
// that file again, and so on: the same episodes were re-encoded several times a day. A copy deleted to make
// room stays gone until someone plays the file in a browser that needs it.
test('the background scan does not remake a browser copy that was deleted to make room', { timeout: 60000 }, async (t) => {
  const run = promisify(execFile);
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  try { await run(ffmpeg, ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-evicted-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Show.S01E01.1080p.x265.mp4');
  try {
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=128x128:r=4:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx265', '-x265-params', 'log-level=error',
      '-tag:v', 'hvc1', '-c:a', 'aac', '-y', file]);
  } catch { t.skip('FFmpeg without libx265'); return; }
  process.env.MIN_FREE_GB = '0';

  // Learn the copy's cache name, then record it as evicted the way makeRoom does.
  const probe = await import('../src/convert.js?evicted-name');
  await probe.startConverter({ dataDir: dir, listCandidates: async () => null });
  const copy = probe.h264Path(file);
  await fs.writeFile(path.join(dir, '.lilin-convert.json'),
    JSON.stringify({ failures: {}, copyEvicted: { [path.basename(copy)]: Date.now() } }));

  const convert = await import('../src/convert.js?evicted-test');
  await convert.startConverter({ dataDir: dir, listCandidates: async () => [{ file, deleteOriginal: false }] });
  await new Promise((r) => setTimeout(r, 8000)); // the first scan runs after five seconds
  assert.equal(existsSync(copy), false, 'an evicted copy is not re-encoded in the background');
  assert.equal(convert.jobState(file), null);
});
