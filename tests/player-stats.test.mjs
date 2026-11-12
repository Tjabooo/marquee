import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { videoCodecString, audioCodecString, describeVideo, describeAudio, formatBitrate, formatBytes, formatDuration } from '../public/player-stats.js';
import { describeProbe } from '../src/convert.js';

test('codec strings follow RFC 6381 for the common browser codecs', () => {
  assert.equal(videoCodecString({ codec: 'h264', profile: 'High', level: 41 }), 'avc1.640029');
  assert.equal(videoCodecString({ codec: 'h264', profile: 'Constrained Baseline', level: 30 }), 'avc1.42e01e');
  assert.equal(videoCodecString({ codec: 'hevc', profile: 'Main 10', level: 153, tag: 'hvc1' }), 'hvc1.2.4.L153.B0');
  assert.equal(videoCodecString({ codec: 'hevc', profile: 'Main', level: 120, tag: 'hev1' }), 'hev1.1.6.L120.B0');
  assert.equal(videoCodecString({ codec: 'av1', profile: 'Main', level: 8, bitDepth: 10 }), 'av01.0.08M.10');
  assert.equal(videoCodecString({ codec: 'vp9', profile: 'Profile 2', level: 31, bitDepth: 10 }), 'vp09.02.31.10');
  assert.equal(videoCodecString({ codec: 'prores' }), null);
  assert.equal(audioCodecString({ codec: 'aac', profile: 'LC' }), 'mp4a.40.2');
  assert.equal(audioCodecString({ codec: 'aac', profile: 'HE-AACv2' }), 'mp4a.40.29');
  assert.equal(audioCodecString({ codec: 'eac3' }), 'ec-3');
});

test('ffprobe JSON becomes a compact description with HDR, Matroska stats tags and every stream', () => {
  const info = describeProbe({
    format: { format_name: 'matroska,webm', format_long_name: 'Matroska / WebM', size: '4000000000', duration: '2700.5', bit_rate: '11850000', tags: { ENCODER: 'libebml' } },
    chapters: [{}, {}, {}],
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', level: 153, width: 3840, height: 2160, pix_fmt: 'yuv420p10le',
        avg_frame_rate: '24000/1001', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc', color_range: 'tv',
        tags: { 'BPS-eng': '10000000', 'NUMBER_OF_FRAMES-eng': '64764' },
        side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 8, dv_bl_signal_compatibility_id: 1 },
          { side_data_type: 'Mastering display metadata', max_luminance: '10000000/10000', min_luminance: '50/10000' },
          { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 }] },
      { index: 1, codec_type: 'audio', codec_name: 'eac3', channels: 6, channel_layout: '5.1(side)', sample_rate: '48000', bit_rate: '640000', tags: { language: 'eng' }, disposition: { default: 1 } },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'swe', title: 'SDH' }, disposition: { hearing_impaired: 1 } },
      { index: 3, codec_type: 'attachment', codec_name: 'ttf' },
    ],
  });
  assert.equal(info.video.hdr, 'Dolby Vision 8.01 (HDR10 base)');
  assert.equal(info.video.bitrate, 10000000);
  assert.equal(info.video.frames, 64764);
  assert.equal(info.video.bitDepth, 10);
  assert.equal(info.video.fps, 23.976);
  assert.deepEqual(info.video.light, { maxCll: 1000, maxFall: 400 });
  assert.equal(info.chapters, 3);
  assert.equal(info.attachments, 1);
  assert.equal(info.audio[0].default, true);
  assert.equal(info.subtitles[0].hearingImpaired, true);
  const v = describeVideo(info.video);
  assert.equal(v.codec, 'HEVC Main 10@L5.1');
  assert.match(v.colour, /primaries BT\.2020 · transfer PQ \(ST 2084\) · matrix BT\.2020 NCL · limited range/);
  assert.match(v.hdr, /MaxCLL 1000 · MaxFALL 400/);
  assert.equal(describeAudio(info.audio[0]), 'E-AC-3 · 5.1 (side) · 48 kHz · 640 kbps · eng · default');
});

test('formatting helpers', () => {
  assert.equal(formatBitrate(11870000), '11.9 Mbps');
  assert.equal(formatBitrate(640000), '640 kbps');
  assert.equal(formatBytes(4000000000), '4.00 GB');
  assert.equal(formatDuration(2700.5), '45:00.500');
  assert.equal(formatDuration(3723.25), '1:02:03.250');
});

test('probeDetails reads a real file through ffprobe', { timeout: 20000 }, async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg unavailable'); return; }
  const { probeDetails } = await import('../src/convert.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-stats-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.mp4');
  await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', file]);
  const info = await probeDetails(file);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.video.width, 64);
  assert.equal(info.video.fps, 25);
  assert.equal(info.audio[0].codec, 'aac');
  assert.match(videoCodecString(info.video), /^avc1\.[0-9a-f]{6}$/);
});
