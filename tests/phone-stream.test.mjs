import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { playlist, pieceCount, segmentName, segmentIndex, streamArgs, isHeavy, pickAudio, videoFilter, PhoneStreams, SEGMENT } from '../src/phone-stream.js';

test('playlist lists every piece of the video with the right lengths', () => {
  const text = playlist(10.5);
  assert.match(text, /^#EXTM3U\n/);
  assert.match(text, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(text, /#EXT-X-ENDLIST\n$/);
  assert.deepEqual([...text.matchAll(/#EXTINF:([\d.]+),\n(s\d{5}\.ts)/g)].map((m) => [m[1], m[2]]),
    [['4.000', 's00000.ts'], ['4.000', 's00001.ts'], ['2.500', 's00002.ts']]);
  // A tiny tail joins the last piece instead of becoming a piece ffmpeg may never make.
  assert.equal(pieceCount(8.2), 2);
  assert.equal(pieceCount(8.5), 3);
  assert.equal(pieceCount(0.5), 1);
});

test('piece names round-trip and reject anything else', () => {
  assert.equal(segmentName(12), 's00012.ts');
  assert.equal(segmentIndex('s00012.ts'), 12);
  assert.equal(segmentIndex('../s00012.ts'), null);
  assert.equal(segmentIndex('index.m3u8'), null);
});

test('heavy = above 1080p or a very high bitrate', () => {
  assert.equal(isHeavy({ height: 2160, bitrate: 15e6 }), true);
  assert.equal(isHeavy({ height: 1080, bitrate: 40e6 }), true);
  assert.equal(isHeavy({ height: 1080, bitrate: 8e6 }), false);
  assert.equal(isHeavy(null), false);
});

test('audio: the chosen stream, else the default, else the first', () => {
  const audios = [{ index: 1 }, { index: 2, disposition: { default: 1 } }, { index: 3 }];
  assert.equal(pickAudio(audios, 3).index, 3);
  assert.equal(pickAudio(audios, 9).index, 2);
  assert.equal(pickAudio(audios).index, 2);
  assert.equal(pickAudio([]), null);
});

test('ffmpeg args start at a piece, keep its timeline and force keyframes on piece edges', () => {
  const video = { index: 0, height: 2160, color_transfer: 'smpte2084' };
  const args = streamArgs({ input: 'in.mkv', dir: 'D', video, audio: { index: 2 }, quality: '1080', start: 25 });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('-ss'), '100');
  assert.equal(at('-output_ts_offset'), '100');
  assert.equal(at('-start_number'), '25');
  assert.equal(at('-hls_time'), String(SEGMENT));
  assert.equal(at('-force_key_frames'), `expr:gte(t,n_forced*${SEGMENT})`);
  assert.equal(at('-c:v'), 'h264_nvenc');
  assert.equal(at('-forced-idr'), '1');
  assert.ok(args.includes('0:2'));
  assert.match(at('-vf'), /tonemap=hable/);
  assert.equal(at('-hwaccel'), 'cuda', 'HDR through NVENC decodes on the GPU');
  assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i'));
  assert.ok(!streamArgs({ input: 'in.mkv', dir: 'D', video, audio: null, quality: '1080', encoder: 'x264' }).includes('-hwaccel'), 'not without the GPU');
  assert.ok(!streamArgs({ input: 'in.mkv', dir: 'D', video: { index: 0, height: 2160 }, audio: null, quality: '1080' }).includes('-hwaccel'), 'not for SDR');
  assert.equal(at('-hls_segment_filename'), path.join('D', 's%05d.ts'));
  // From the start: no seek; x264 when asked; SDR keeps its colours.
  const plain = streamArgs({ input: 'in.mkv', dir: 'D', video: { index: 0 }, audio: null, quality: '720', start: 0, encoder: 'x264' });
  assert.ok(!plain.includes('-ss'));
  assert.equal(plain[plain.indexOf('-c:v') + 1], 'libx264');
  assert.ok(!plain.includes('-c:a'));
  assert.equal(videoFilter({}, 720), "scale='trunc(min(720,ih)*dar/2+0.5)*2':'trunc(min(720,ih)/2)*2':flags=bicubic,setsar=1,format=yuv420p");
});

// A stand-in for ffmpeg: writes one piece every 20 ms from -start_number on, until killed.
function fakeFfmpeg(log) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1;
    let n = Number(args[args.indexOf('-start_number') + 1]);
    const pattern = args[args.indexOf('-hls_segment_filename') + 1];
    log.push(n);
    const timer = setInterval(() => {
      if (n >= 30) { clearInterval(timer); child.emit('close', 0); return; }
      fs.writeFileSync(pattern.replace('%05d', String(n).padStart(5, '0')), 'ts');
      n++;
    }, 20);
    child.kill = () => { clearInterval(timer); setImmediate(() => child.emit('close', null)); };
    return child;
  };
}

test('pieces are made on demand; a seek restarts ffmpeg there; nearby requests wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const starts = [];
  const streams = new PhoneStreams({ dir: path.join(dir, 'phone'), spawnFn: fakeFfmpeg(starts), caps: { nvenc: true, x264: true, zscale: true } });
  // The session is built by hand: open() needs ffprobe.
  const session = {
    key: 'k', file: 'film.mkv', quality: '1080', label: '', audio: null, dir: path.join(dir, 'phone', 'k'),
    info: { duration: 120, video: { index: 0 }, audios: [] }, proc: null, start: 0, next: 0, last: Date.now(), want: 0, error: null,
  };
  fs.mkdirSync(session.dir, { recursive: true });
  streams.sessions.set('k', session);
  try {
    assert.equal(path.basename(await streams.segment(session, 0)), 's00000.ts');
    assert.equal(path.basename(await streams.segment(session, 2)), 's00002.ts');
    assert.deepEqual(starts, [0]); // piece 2 came from the same run
    assert.equal(path.basename(await streams.segment(session, 20)), 's00020.ts');
    assert.deepEqual(starts, [0, 20]); // far ahead: restarted there
    await assert.rejects(streams.segment(session, 30), { status: 404 }); // 120 s = pieces 0-29
  } finally {
    streams.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
