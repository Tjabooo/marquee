import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const clipsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-clip-cam-'));
process.env.CLIPS_DIR = clipsDir;
const clips = await import('../src/clips.js');

const cam = { width: 1920, height: 1080, duration: 10, offset: 0 };
test('the camera box becomes even pixel sizes inside the picture', () => {
  assert.deepEqual(clips.planOverlay({ x: 0.75, y: 0.05, w: 0.25 }, { width: 2560, height: 1440 }, cam), { x: 1920, y: 72, w: 640, h: 360 });
  // pushed back inside when it hangs over the edge
  assert.deepEqual(clips.planOverlay({ x: 0.9, y: 0.9, w: 0.3 }, { width: 2560, height: 1440 }, cam), { x: 1792, y: 1008, w: 768, h: 432 });
  // a tall camera never gets taller than the picture
  const tall = clips.planOverlay({ x: 0, y: 0, w: 1 }, { width: 1920, height: 1080 }, { ...cam, width: 1080, height: 1920 });
  assert.equal(tall.h, 1080); assert.equal(tall.w, 608);
  assert.equal(clips.planOverlay(null, { width: 10, height: 10 }, cam), null);
  assert.throws(() => clips.planOverlay({ x: 0, y: 0, w: 0.3 }, { width: 2560, height: 1440 }, null), /no camera/);
  assert.throws(() => clips.planOverlay({ x: 0, y: 0, w: 0.01 }, { width: 2560, height: 1440 }, cam), /inside the picture/);
  assert.throws(() => clips.planOverlay({ x: 'a', y: 0, w: 0.3 }, { width: 2560, height: 1440 }, cam), /inside the picture/);
});

test('each kept part gets the stretch of camera that was recording then', () => {
  // the camera started 2 s into the clip and ran for 5 s (clip 2..7)
  const c = { ...cam, offset: 2, duration: 5 };
  const spans = clips.camTimeline([{ from: 0, end: 3 }, { from: 5, end: 9 }], c);
  // part 1 (copy 0..3): camera 0..1, shown from copy time 2; part 2 (copy 3..7): camera 3..5 at copy 3
  assert.deepEqual(spans.map((s) => [s.ss, s.t, s.at]), [[0, 1, 2], [3, 2, 3]]);
  assert.deepEqual(clips.camTimeline([{ from: 8, end: 9 }], c), [], 'no camera after it stopped');
  // a camera that started before the clip
  assert.deepEqual(clips.camTimeline([{ start: 1, end: 2 }], { ...cam, offset: -3 }).map((s) => [s.ss, s.t, s.at]), [[4, 1, 0]]);
});

const ffmpeg = process.env.FFMPEG || 'ffmpeg', ffprobe = process.env.FFPROBE || 'ffprobe';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;
const pixel = (file, t, x, y) => [...spawnSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
  '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout];

test('the camera is listed with its clip, burned in where it was placed, and deleted with it', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 120000 }, async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-clip-cam-data-'));
  try {
    clips.initClips({ dataDir: data });
    await fs.mkdir(path.join(clipsDir, 'Kept', 'Game'), { recursive: true });
    const src = path.join(clipsDir, 'Kept', 'Game', 'round.mp4');
    let made = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    assert.equal(made.status, 0, String(made.stderr));
    // a red camera that recorded clip seconds 2..4
    made = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=160x90:rate=30:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'comment=lilin_cam_offset=2.000', path.join(clipsDir, 'Kept', 'Game', 'round.cam.mp4')]);
    assert.equal(made.status, 0, String(made.stderr));

    const list = (await clips.listClips()).clips;
    assert.equal(list.length, 1, 'the camera isn’t a clip of its own');
    assert.equal(list[0].cam, true);
    const info = await clips.trimInfo(list[0].id);
    assert.deepEqual([info.cam.offset, info.cam.width, info.cam.height, info.width, info.height], [2, 160, 90, 320, 180]);

    // bottom-right quarter of the picture
    const r = await clips.trim(list[0].id, [{ start: 0, end: 6 }], { overlay: { x: 0.5, y: 0.5, w: 0.5 } });
    assert.equal(r.camera, true);
    assert.match(r.title, /\(edit\)$/);
    const out = path.join(clipsDir, 'Trimmed Clips', 'Game', `${r.title}.mp4`);
    const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', out]).stdout);
    assert.deepEqual(probe.streams.map((s) => s.codec_type), ['video', 'audio']);
    const [red, , blue] = pixel(out, 3, 240, 135);
    assert.ok(red > 180 && blue < 80, `camera shows at 3 s: ${red},${blue}`);
    assert.ok(pixel(out, 1, 240, 135)[0] < 40, 'no camera before it started');
    assert.ok(pixel(out, 5, 240, 135)[0] < 40, 'no camera after it stopped');
    assert.ok(pixel(out, 3, 40, 40)[0] < 40, 'nothing outside the box');

    // saving again while the first edit renders: the older render stops, the newer one gets its own file
    const first = clips.startTrim(list[0].id, [{ start: 0, end: 6 }], { overlay: { x: 0.5, y: 0.5, w: 0.5 } });
    const second = clips.startTrim(list[0].id, [{ start: 1, end: 6 }], { overlay: { x: 0, y: 0, w: 0.5 } });
    assert.ok((await clips.listClips()).clips.find((x) => x.id === list[0].id).editing, 'the clip shows its edit in progress');
    for (let i = 0; i < 600 && [first, second].some((j) => clips.renderState(j.job).state === 'working'); i++) await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(clips.renderState(first.job).state, 'failed');
    assert.match(clips.renderState(first.job).error, /newer edit/);
    assert.equal(clips.renderState(second.job).state, 'done', clips.renderState(second.job).error);
    const trimmed = await fs.readdir(path.join(clipsDir, 'Trimmed Clips', 'Game'));
    assert.deepEqual(trimmed.filter((n) => !n.startsWith('.')).sort(), [`${r.title}.mp4`, `${clips.renderState(second.job).title}.mp4`].sort());
    assert.notEqual(clips.renderState(second.job).title, r.title);
    assert.match(clips.renderState(second.job).title, /\(edit\) 2$/, 'the replaced edit left its name free');
    assert.equal(clips.renderState(second.job).progress, 1);
    assert.equal((await clips.listClips()).clips.find((x) => x.id === list[0].id).editing, null);

    await assert.rejects(clips.checkTrim(list[0].id, [{ start: 0, end: 6 }], { overlay: { x: 0, y: 0, w: 0.001 } }), /inside the picture/);

    await clips.deleteClip(list[0].id);
    const left = await fs.readdir(path.join(clipsDir, 'Kept', 'Game'));
    assert.deepEqual(left, [], 'the camera went to Deleted with its clip');
    assert.equal((await fs.readdir(path.join(clipsDir, '.deleted'))).filter((n) => n.endsWith('.cam.mp4')).length, 1);
  } finally {
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(clipsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
