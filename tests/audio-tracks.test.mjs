import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('audio selection uses actual served stream IDs and copies video without replacing the source', { timeout: 20000 }, async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-audio-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.mp4');
  await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=2:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=kor', '-metadata:s:a:1', 'handler_name=Korean original',
    '-disposition:a:0', '0', '-disposition:a:1', 'default', '-movflags', '+faststart', '-y', file]);
  const saved = process.env.CONVERT;
  process.env.CONVERT = 'off';
  const convert = await import('../convert.js?audio-test');
  await convert.startConverter({ dataDir: dir });
  if (saved === undefined) delete process.env.CONVERT; else process.env.CONVERT = saved;
  const before = await fs.readFile(file);
  const tracks = await convert.probeAudio(file);
  assert.deepEqual(tracks.map((s) => [s.index, s.audioIndex, s.language, s.default]), [[2, 1, 'kor', true], [1, 0, 'eng', false]]);
  assert.equal(tracks[0].title, 'Korean original');
  const source = convert.audioSourceKey(file);
  await assert.rejects(convert.requestAudioTrack(file, 1, 'bad'), { status: 409 });
  await assert.rejects(convert.requestAudioTrack(file, 99, source), { status: 400 });
  assert.equal((await convert.requestAudioTrack(file, 1, source)).ready, false);
  let result;
  const deadline = Date.now() + 10000;
  do {
    await new Promise((r) => setTimeout(r, 30));
    result = await convert.requestAudioTrack(file, 1, source);
  } while (!result.ready && Date.now() < deadline);
  assert.equal(result.ready, true);
  const selected = JSON.parse((await run(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.file])).stdout);
  const audio = selected.streams.filter((s) => s.codec_type === 'audio');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].tags.language, 'eng');
  assert.equal(audio[0].codec_name, 'aac');
  const hashVideo = async (input) => (await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])).stdout;
  assert.equal(await hashVideo(file), await hashVideo(result.file), 'video packets are copied without a quality change');
  assert.deepEqual(await fs.readFile(file), before, 'selected copies never modify the original or another viewer’s default');
  assert.equal((await convert.requestAudioTrack(file, 1, source)).file, result.file, 'reuse the cached selection');
  await fs.appendFile(file, Buffer.alloc(16));
  assert.equal(convert.selectedAudioPath(file, 1, source), null);
  await assert.rejects(convert.requestAudioTrack(file, 1, source), { status: 409 });
});
