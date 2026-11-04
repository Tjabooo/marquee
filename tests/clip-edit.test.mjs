import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const clipsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-clip-edit-'));
process.env.CLIPS_DIR = clipsDir;
const clips = await import('../clips.js');
const info = { duration: 10, keyframes: [0, 2, 4, 6, 8] };

test('kept parts snap their starts back to keyframes and come out in order', () => {
  const parts = clips.planSegments([{ start: 6.5, end: 9 }, { start: 0.4, end: 3 }], info);
  assert.deepEqual(parts.map((p) => [p.from, p.end]), [[0, 3], [6, 9]]);
});

test('a cut shorter than the keyframe spacing is refused instead of silently kept', () => {
  assert.throws(() => clips.planSegments([{ start: 0, end: 3 }, { start: 3.5, end: 9 }], info), /too short to remove/);
  assert.throws(() => clips.planSegments([], info), /Keep between/);
  assert.throws(() => clips.planSegments([{ start: 2, end: 2.1 }], info), /at least 0.3 s/);
  assert.throws(() => clips.planSegments([{ start: 0, end: 11 }], info), /inside the clip/);
  assert.throws(() => clips.planSegments([{ start: 8.2, end: 8.8 }, { start: 9.5, end: 9.8 }], { duration: 10, keyframes: [0, 8.2, 9.5] }), /at least 1 second/);
});

const ffmpeg = process.env.FFMPEG || 'ffmpeg', ffprobe = process.env.FFPROBE || 'ffprobe';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;
test('several kept parts are joined losslessly with every track', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 60000 }, async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-clip-data-'));
  try {
    clips.initClips({ dataDir: data });
    await fs.mkdir(path.join(clipsDir, 'Game'), { recursive: true });
    const src = path.join(clipsDir, 'Game', 'round.mp4');
    const made = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=10',
      '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    assert.equal(made.status, 0, String(made.stderr));
    const [clip] = await clips.listClips().then((r) => r.clips);
    const r = await clips.trim(clip.id, [{ start: 0.5, end: 3.2 }, { start: 5, end: 7.5 }]);
    assert.match(r.title, /\(edit\)$/);
    assert.deepEqual(r.parts.map((p) => [Math.round(p.start * 10) / 10, p.end]), [[0, 3.2], [5, 7.5]]);
    const out = path.join(clipsDir, 'Trimmed Clips', 'Game', `${r.title}.mp4`);
    const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).stdout);
    assert.deepEqual(probe.streams.map((s) => s.codec_type), ['video', 'audio', 'audio']);
    assert.ok(Math.abs(Number(probe.format.duration) - 5.7) < 0.25, `duration ${probe.format.duration}`);
    const left = await fs.readdir(path.join(clipsDir, 'Trimmed Clips', 'Game'));
    assert.deepEqual(left, [`${r.title}.mp4`], 'temporary parts are cleaned up');
    const single = await clips.trim(clip.id, [{ start: 2.5, end: 6 }]);
    assert.match(single.title, /\(trim\)$/); assert.equal(single.start, 2);
  } finally {
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(clipsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('recorder tracks are recognised, with or without names', () => {
  const untitled = clips.trackLayout([{}, {}, {}, {}]);
  assert.deepEqual(untitled.map((t) => [t.label, t.mix, t.mic]), [['Mix', true, false], ['Game', false, false], ['Friends', false, false], ['You', false, true]]);
  assert.deepEqual(clips.trackLayout([{}, {}, {}]).map((t) => t.mix), [false, false, false], 'old 3-track clips have no mix');
  const titled = [{ tags: { title: 'Mix' } }, { tags: { title: 'Game' } }, { tags: { title: 'Friends' } }];
  assert.equal(clips.mixTrack(titled), titled[0]);
  assert.equal(clips.mixTrack([{}, {}, {}]), null);
  assert.throws(() => clips.planTracks(untitled, [0]), /mix can’t be removed/);
  assert.equal(clips.planTracks(untitled, []), null);
  const noMic = clips.planTracks(untitled, [3]);
  assert.equal(noMic.mix, true); assert.deepEqual(noMic.keep.map((t) => t.label), ['Game', 'Friends']);
  assert.equal(clips.planTracks(untitled, [2, 3]).mix, false, 'one track left is its own mix');
});

test('removing the mic track rebuilds the mix and copies the rest', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-clip-tracks-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-clip-data-'));
  process.env.CLIPS_DIR = dir;
  const fresh = await import(`../clips.js?tracks=${Date.now()}`);
  try {
    fresh.initClips({ dataDir: data });
    await fs.mkdir(path.join(dir, 'Game'), { recursive: true });
    const src = path.join(dir, 'Game', 'round.mp4');
    const tone = (f) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=4`];
    const made = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4', ...tone(300), ...tone(400), ...tone(500), ...tone(600),
      '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '4', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    assert.equal(made.status, 0, String(made.stderr));
    const [clip] = (await fresh.listClips()).clips;
    const r = await fresh.trim(clip.id, [{ start: 0, end: 4 }], { removeTracks: [3] });
    assert.match(r.title, /\(edit\)$/); assert.deepEqual(r.removedTracks, ['You']);
    const out = path.join(dir, 'Trimmed Clips', 'Game', `${r.title}.mp4`);
    const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', out]).stdout);
    assert.deepEqual(probe.streams.slice(1).map((s) => s.tags?.handler_name), ['Mix', 'Game', 'Friends']);
    assert.equal(fresh.mixTrack(probe.streams.slice(1)), probe.streams[1], 'Marquee finds the rebuilt mix by name');
    assert.equal(probe.streams[1].disposition.default, 1);
    const srcProbe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', src]).stdout);
    assert.equal(probe.streams[0].nb_frames, srcProbe.streams[0].nb_frames, 'video is copied, frame for frame');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
