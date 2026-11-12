import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

async function ffmpegReady(t) {
  try { await run(FFMPEG, ['-version']); await run(FFPROBE, ['-version']); return true; }
  catch { t.skip('FFmpeg unavailable'); return false; }
}

// An MKV with three subtitle tracks the MP4 copy and its .srt sidecars wouldn't all keep
// (a forced track and an untagged one get no .srt), and an MP4 copy made earlier.
async function makePair(dir, { copySeconds = 6 } = {}) {
  const srt = path.join(dir, 'a.srt');
  await fs.writeFile(srt, '1\n00:00:00,500 --> 00:00:02,000\nHello\n');
  const mkv = path.join(dir, 'Show.S01E01.mkv');
  await run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=4:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-i', srt, '-i', srt, '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s', '-map', '4:s',
    '-c:v', 'libx264', '-g', '4', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=eng', '-disposition:s:1', 'forced',
    '-y', mkv]);
  const mp4 = path.join(dir, 'Show.S01E01.mp4');
  await run(FFMPEG, ['-v', 'error', '-i', mkv, '-t', String(copySeconds), '-map', '0:v', '-map', '0:a', '-c', 'copy', '-y', mp4]);
  return { mkv, mp4 };
}

const waitFor = async (check, ms) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  return check();
};

test('an original converted while qBittorrent had it is deleted later, with every subtitle track kept', { timeout: 60000 }, async (t) => {
  if (!(await ffmpegReady(t))) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-retire-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let mkv, mp4;
  try { ({ mkv, mp4 } = await makePair(dir)); } catch { t.skip('FFmpeg without libx264'); return; }

  const convert = await import('../src/convert.js?delete-original-test');
  await convert.startConverter({ dataDir: dir, listCandidates: async () => [{ file: mkv, deleteOriginal: true }] });

  assert.ok(await waitFor(() => !existsSync(mkv), 30000), 'the original was deleted by the background scan');
  assert.ok(existsSync(mp4), 'the MP4 copy stays');
  const archive = convert.subtitleArchivePath(mkv);
  assert.equal(archive, path.join(dir, 'Show.S01E01.subtitles.mks'));
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', archive]);
  const subs = JSON.parse(stdout).streams.filter((s) => s.codec_type === 'subtitle');
  assert.equal(subs.length, 3, 'all three subtitle tracks, including the forced and untagged ones');
  assert.equal(subs[1].disposition.forced, 1);
});

test('an original is kept when its MP4 copy is shorter, or when qBittorrent still owns it', { timeout: 60000 }, async (t) => {
  if (!(await ffmpegReady(t))) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-retire-keep-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const short = path.join(dir, 'short');
  const owned = path.join(dir, 'owned');
  await fs.mkdir(short);
  await fs.mkdir(owned);
  let a, b;
  try { a = await makePair(short, { copySeconds: 2 }); b = await makePair(owned); } catch { t.skip('FFmpeg without libx264'); return; }
  // A copy within 2 s (or 0.5%) of the original passes; 2 s of 6 s does not.
  const convert = await import('../src/convert.js?delete-original-keep-test');
  await convert.startConverter({ dataDir: dir, listCandidates: async () => [
    { file: a.mkv, deleteOriginal: true },
    { file: b.mkv, deleteOriginal: false },
  ] });
  await new Promise((r) => setTimeout(r, 12000)); // first scan after 5 s, plus the checks
  assert.ok(existsSync(a.mkv), 'a truncated copy never costs the original');
  assert.ok(!existsSync(convert.subtitleArchivePath(a.mkv)));
  assert.ok(existsSync(b.mkv), 'files qBittorrent lists are never deleted');
});
