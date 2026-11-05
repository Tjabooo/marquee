import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Previews, stepFor, parseShowinfo, ffmpegArgs } from '../src/previews.js';
import { frameAt, frameSize, tipPlacement, warmOrder } from '../public/seek-preview.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

test('long videos keep fewer frames, short ones every keyframe', () => {
  assert.equal(stepFor(90), 1);
  assert.equal(stepFor(7200), 8);
  assert.equal(stepFor(null), 1);
});

test('showinfo lines give the frame time and size', () => {
  assert.deepEqual(parseShowinfo('[Parsed_showinfo_3 @ 0000] n:  12 pts:  60060 pts_time:5.005   duration:1001 fmt:yuv420p sar:1/1 s:240x136 i:P'),
    { time: 5.005, w: 240, h: 136 });
  assert.equal(parseShowinfo('[Parsed_showinfo_3 @ 0000] config in time_base: 1/1000, frame_rate: 60/1'), null);
  assert.equal(parseShowinfo('frame=  10 fps=0.0'), null);
});

test('the filter keeps the frame shape and tiles 5x5', () => {
  const vf = ffmpegArgs('in.mkv', 'out', 4)[ffmpegArgs('in.mkv', 'out', 4).indexOf('-vf') + 1];
  assert.match(vf, /gte\(t-prev_selected_t,4\)/);
  assert.match(vf, /dar/);
  assert.match(vf, /tile=5x5/);
});

test('the hovered time picks the last frame at or before it', () => {
  const times = [0, 2, 4, 6];
  assert.equal(frameAt(times, 0), 0);
  assert.equal(frameAt(times, 3.9), 1);
  assert.equal(frameAt(times, 4), 2);
  assert.equal(frameAt(times, 100), 3);
  assert.equal(frameAt([], 5), -1);
});

test('frames are shown at most 200 x 150, keeping their shape', () => {
  assert.deepEqual(frameSize(240, 136, false), { scale: 200 / 240, width: 200, height: 113 });
  assert.equal(frameSize(240, 426, false).height, 150);
  assert.equal(frameSize(240, 136, true).width, 160);
});

test('the seek tip stays on the bar and its caret points at the hovered spot', () => {
  assert.deepEqual(tipPlacement(500, 1000, 208), { left: 500, caret: 0 });
  assert.deepEqual(tipPlacement(30, 1000, 208), { left: 104, caret: -74 });
  assert.deepEqual(tipPlacement(0, 1000, 208), { left: 104, caret: -94 }); // inside the rounded corner
  assert.deepEqual(tipPlacement(995, 1000, 208), { left: 896, caret: 94 });
  assert.equal(tipPlacement(50, 100, 208).left, 104); // bar narrower than the tip
});

test('a storyboard is made in the background, sheet by sheet', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-previews-'));
  const video = path.join(dir, 'in.mp4');
  // 60 s with a keyframe every second: 60 frames = 3 sheets (25 + 25 + 10).
  const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', video], { windowsHide: true });
  assert.equal(made.status, 0, String(made.stderr));
  const previews = new Previews(path.join(dir, 'cache'));
  const first = await previews.index(video);
  assert.equal(first.done, false);
  let idx = first;
  for (let i = 0; i < 200 && !idx.done; i++) { await new Promise((r) => setTimeout(r, 100)); idx = await previews.index(video); }
  assert.equal(idx.done, true);
  assert.equal(idx.sheets, 3);
  assert.equal(idx.times.length, 60);
  assert.equal(idx.times[0], 0);
  assert.ok(Math.abs(idx.times[59] - 59) < 0.01);
  assert.deepEqual([idx.w, idx.h], [240, 134]);
  for (let n = 0; n < 3; n++) assert.ok(await previews.sheet(video, n));
  assert.equal(await previews.sheet(video, 3), null);
  // A second ask is served from disk.
  const again = new Previews(path.join(dir, 'cache'));
  assert.equal((await again.index(video)).done, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('sheets are fetched nearest the hovered spot first, each once', () => {
  assert.deepEqual(warmOrder(5, 0), [0, 1, 2, 3, 4]);
  assert.deepEqual(warmOrder(6, 4), [4, 5, 3, 2, 1, 0]);
  assert.deepEqual(warmOrder(3, 9), [2, 1, 0]);
  assert.deepEqual(warmOrder(0, 0), []);
});
