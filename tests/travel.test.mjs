import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  TravelStore, QUALITIES, estimateBytes, travelName, lang3, pickAudio, videoFilter, travelArgs, progressSeconds, isHdr, MAX_PER_PERSON,
} from '../src/travel.js';
import { travelTitle, sizeWords, stateWords, travelSummary, travelOrder } from '../public/travel.js';
import { topicFor } from '../src/live.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-travel-'));
const hasFfmpeg = (() => { try { execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('size estimates follow the bitrates', () => {
  const hour = estimateBytes(3600, 'small', 1);
  assert.ok(hour > 440e6 && hour < 470e6, `small hour ${hour}`);
  assert.ok(estimateBytes(3600, 'standard', 1) > 1.0e9);
  assert.ok(estimateBytes(3600, 'small', 2) > hour, 'extra audio counted');
  assert.equal(estimateBytes(3600, 'small', 9), estimateBytes(3600, 'small', 3), 'at most three audio tracks');
  assert.equal(estimateBytes(null, 'small'), null);
  assert.equal(estimateBytes(60, 'huge'), null);
});

test('file names are safe for phones and Windows', () => {
  assert.equal(travelName('Severance S01 E03', 'small'), 'Severance S01 E03 (480p).mp4');
  assert.equal(travelName('What: "If"?/<x>', 'standard'), 'What If x (720p).mp4');
  assert.equal(travelName('', 'small'), 'Video (480p).mp4');
});

test('language tags become ISO 639-2', () => {
  assert.equal(lang3('en'), 'eng');
  assert.equal(lang3('sv'), 'swe');
  assert.equal(lang3('pt-br'), 'por');
  assert.equal(lang3('eng'), 'eng');
  assert.equal(lang3('xx-yy'), 'und');
});

test('audio: default first, other languages, no commentary, at most three', () => {
  const a = (index, language, extra = {}) => ({ index, codec_type: 'audio', tags: { language, ...(extra.title ? { title: extra.title } : {}) }, disposition: { default: extra.def ? 1 : 0 } });
  const picked = pickAudio([{ index: 0, codec_type: 'video' }, a(1, 'eng'), a(2, 'jpn', { def: true }), a(3, 'eng', { title: 'Director commentary' }),
    a(4, 'eng'), a(5, 'swe'), a(6, 'ger')]);
  assert.deepEqual(picked.map((s) => s.index), [2, 1, 5]);
  assert.deepEqual(pickAudio([{ index: 0, codec_type: 'video' }]), []);
});

test('video filter never upscales and tone-maps HDR', () => {
  const sdr = videoFilter({ color_transfer: 'bt709' }, 'small');
  assert.match(sdr, /min\(480,ih\)/);
  assert.match(sdr, /format=yuv420p$/);
  assert.doesNotMatch(sdr, /tonemap/);
  const hdr = videoFilter({ color_transfer: 'smpte2084' }, 'standard');
  assert.ok(isHdr({ color_transfer: 'arib-std-b67' }));
  assert.match(hdr, /min\(720,ih\)/);
  assert.match(hdr, /zscale=tin=smpte2084.*tonemap=hable/);
  assert.ok(hdr.indexOf('scale=') < hdr.indexOf('zscale'), 'scaled before tone mapping');
  assert.doesNotMatch(videoFilter({ color_transfer: 'smpte2084' }, 'small', { tonemap: false }), /tonemap/);
  assert.match(videoFilter({ color_transfer: 'arib-std-b67' }, 'small'), /tin=arib-std-b67/);
});

test('ffmpeg arguments: H.264 + AAC + mov_text, index at the front', () => {
  const info = { streams: [{ index: 0, codec_type: 'video', color_transfer: 'bt709' }, { index: 1, codec_type: 'audio', tags: { language: 'eng' } },
    { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' }] };
  const args = travelArgs({ input: 'in.mkv', output: 'out.mp4', info, quality: 'small', encoder: 'nvenc', hwaccel: true,
    subs: [{ path: 'a.srt', lang: 'en' }, { path: 'b.srt', lang: 'sv' }], title: 'T' });
  const s = args.join(' ');
  assert.match(s, /-hwaccel auto -i in\.mkv -i a\.srt -i b\.srt/);
  assert.match(s, /-map 0:0 -map 0:1 -map 1:0 -map 2:0/);
  assert.doesNotMatch(s, /-map 0:2/, 'image subtitles stay out');
  assert.match(s, /h264_nvenc .*-b:v 900k -maxrate 1500k/);
  assert.match(s, /-c:a:0 aac -b:a:0 96k -ac:a:0 2/);
  assert.match(s, /-c:s:0 mov_text -metadata:s:s:0 language=eng/);
  assert.match(s, /-metadata:s:s:1 language=swe/);
  assert.match(s, /-movflags \+faststart/);
  assert.equal(args.at(-1), 'out.mp4');
  const x = travelArgs({ input: 'in.mkv', output: 'o.mp4', info, quality: 'standard' }).join(' ');
  assert.match(x, /libx264 .*-crf 23 -maxrate 3500k/);
  assert.doesNotMatch(x, /hwaccel/);
  assert.throws(() => travelArgs({ input: 'a', output: 'b', info: { streams: [] }, quality: 'small' }), /No video/);
});

test('progress lines', () => {
  assert.equal(progressSeconds('frame=1\nout_time_us=1500000\nout_time_ms=2500000\n'), 2.5);
  assert.equal(progressSeconds('frame=1\n'), null);
});

test('the page words', () => {
  const f = (b) => `${Math.round(b / 1e6)} MB`;
  assert.equal(travelTitle({ title: 'Dune', year: 2021 }), 'Dune (2021)');
  assert.equal(travelTitle({ title: 'Severance', season: 1, episode: 3 }), 'Severance S01 E03');
  assert.equal(travelTitle({ filmTitle: 'Alien', title: 'alien.1979' }), 'Alien');
  assert.equal(sizeWords({ state: 'ready', size: 5e8 }, f), '500 MB');
  assert.equal(sizeWords({ state: 'none', estimate: 4e8 }, f), 'About 400 MB');
  assert.equal(stateWords({ state: 'making', percent: 42 }), 'Making it… 42%');
  assert.equal(stateWords({ state: 'failed', error: 'Disk full' }), 'Couldn’t make it: Disk full');
  assert.equal(travelSummary([{ state: 'ready' }, { state: 'making' }, { state: 'queued' }]), '3 for your phone · 1 ready · 2 being made');
  assert.equal(travelSummary([]), '');
  assert.deepEqual(travelOrder([{ state: 'queued', requestedAt: 3 }, { state: 'ready', requestedAt: 1 }, { state: 'ready', requestedAt: 2 }])
    .map((i) => i.requestedAt), [2, 1, 3]);
});

test('POSTs to /api/travel tell your other pages', () => {
  assert.deepEqual(topicFor('/api/travel'), { topic: 'travel', audience: 'user' });
  assert.deepEqual(topicFor('/api/travel/remove'), { topic: 'travel', audience: 'user' });
  assert.equal(topicFor('/api/travel/file/abc'), null);
});

test('lists, sharing, limits and clean-up', () => {
  const dir = tmp();
  const src = path.join(dir, 'a.mkv');
  fs.writeFileSync(src, 'x');
  let now = Date.now();
  const store = new TravelStore({ dataDir: dir, dir: path.join(dir, 'travel'), resolve: async () => ({ source: src, subs: [] }), now: () => now });
  store.drain = async () => {}; // no encoding here
  return (async () => {
    await assert.rejects(store.request(1, [{ kind: 'lib', id: 'a', title: 'A' }], 'huge'), /Small or Standard/);
    const [row] = await store.request(1, [{ kind: 'lib', id: 'a', title: 'A' }], 'small');
    await store.request(2, [{ kind: 'lib', id: 'a', title: 'A' }], 'small');
    assert.equal(row.copy_key, TravelStore.keyFor(src, 'small'));
    assert.equal(store.queue.length, 1, 'two people, one copy');
    assert.deepEqual(store.usersOf(row.copy_key).sort(), [1, 2]);
    assert.equal(store.copyState(row.copy_key).state, 'queued');
    // A finished copy: ready for both, downloads only through a list that has it.
    fs.writeFileSync(store.filePath(row.copy_key), 'mp4');
    store.jobs.clear(); store.queue = [];
    assert.equal(store.copyState(row.copy_key).state, 'ready');
    assert.ok(store.rowByKey(2, row.copy_key));
    assert.equal(store.rowByKey(3, row.copy_key), null);
    // One person removing it keeps the file for the other.
    store.remove(1, 'lib', 'a', 'small');
    assert.ok(fs.existsSync(store.filePath(row.copy_key)));
    store.remove(2, 'lib', 'a', 'small');
    // The file is removed in the background: give a busy machine up to 2 s, not a fixed 50 ms.
    for (let i = 0; i < 200 && fs.existsSync(store.filePath(row.copy_key)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(!fs.existsSync(store.filePath(row.copy_key)), 'nobody wants it: deleted');
    // Old requests expire.
    await store.request(1, [{ kind: 'lib', id: 'a', title: 'A' }], 'standard');
    now += 8 * 24 * 3600 * 1000;
    store.sweep();
    assert.equal(store.rowsFor(1).length, 0);
    assert.equal(store.queue.length, 0, 'its queued job went too');
    // Per-person cap.
    const many = Array.from({ length: MAX_PER_PERSON + 1 }, (_, i) => ({ kind: 'lib', id: `x${i}`, title: `X${i}` }));
    await assert.rejects(store.request(1, many, 'small'), /phone copies at a time/);
  })();
});

test('room is made from copies everyone already downloaded', async () => {
  const dir = tmp();
  const files = ['a', 'b'].map((n) => { const f = path.join(dir, `${n}.mkv`); fs.writeFileSync(f, n); return f; });
  const store = new TravelStore({ dataDir: dir, dir: path.join(dir, 'travel'), maxBytes: 1500,
    resolve: async (kind, id) => ({ source: files[id === 'a' ? 0 : 1], subs: [] }) });
  store.drain = async () => {};
  const [a] = await store.request(1, [{ kind: 'lib', id: 'a', title: 'A' }], 'small');
  const [b] = await store.request(1, [{ kind: 'lib', id: 'b', title: 'B' }], 'small');
  fs.writeFileSync(store.filePath(a.copy_key), Buffer.alloc(1000));
  fs.writeFileSync(store.filePath(b.copy_key), Buffer.alloc(400));
  assert.equal(store.makeRoom(400), false, 'nothing downloaded yet: no room');
  store.markDownloaded(1, a.copy_key);
  assert.equal(store.makeRoom(400), true);
  assert.ok(!fs.existsSync(store.filePath(a.copy_key)));
  assert.ok(fs.existsSync(store.filePath(b.copy_key)));
});

test('makes a real copy: 480p H.264, AAC, subtitles, HDR tone-mapped', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'clip.mkv');
  // 3 s of 1080p "HDR" (PQ-tagged 10-bit) video with stereo audio.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020',
    '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-c:a', 'aac', '-shortest', src]);
  const srt = '1\n00:00:00,500 --> 00:00:02,000\nHej då\n';
  const ready = [];
  const store = new TravelStore({ dataDir: dir, dir: path.join(dir, 'travel'),
    resolve: async () => ({ source: src, subs: [{ lang: 'sv', read: async () => srt }, { lang: 'en', read: async () => { throw new Error('gone'); } }] }),
    onReady: (users) => ready.push(users) });
  const [row] = await store.request(7, [{ kind: 'lib', id: 'c', title: 'Clip' }], 'small');
  for (let i = 0; i < 600 && store.copyState(row.copy_key).state !== 'ready' && store.copyState(row.copy_key).state !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(store.copyState(row.copy_key).state, 'ready', store.copyState(row.copy_key).error);
  assert.deepEqual(ready, [[7]]);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', store.filePath(row.copy_key)]));
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.height, 480);
  assert.equal(v.width, 854);
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.equal(info.streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
  const sub = info.streams.find((s) => s.codec_type === 'subtitle');
  assert.equal(sub.codec_name, 'mov_text');
  assert.equal(sub.tags.language, 'swe');
  assert.ok(!fs.readdirSync(path.join(dir, 'travel')).some((f) => f.includes('.part.')), 'temp files cleaned');
  const options = await store.options('lib', 'c');
  assert.equal(options.qualities.find((q) => q.quality === 'small').state, 'ready');
  assert.ok(options.qualities.find((q) => q.quality === 'standard').estimate > 0);
  assert.ok(Object.keys(QUALITIES).length === 2);
});
