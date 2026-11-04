import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.UPLOAD_MBPS = '100';
const load = await import('../load.js');

const req = (headers = {}, ip = '192.168.50.26') => ({ headers, socket: { remoteAddress: `::ffff:${ip}` } });
const later = (ms, fn) => { const real = Date.now; Date.now = () => real() + ms; try { return fn(); } finally { Date.now = real; } };

test('a rate is bytes per second over the last ten whole seconds', () => {
  const r = new load.Rate();
  const t0 = 1_000_000_000_000;
  for (let s = 0; s < 10; s++) r.add(1000, t0 + s * 1000);
  assert.equal(r.perSec(t0 + 10_000), 1000);
  assert.equal(r.perSec(t0 + 30_000), 0, 'a quiet stream drops to zero');
  assert.equal(r.total, 10_000);
});

test('jobs are named after what they make', () => {
  const share = load.describeJob('C:/ffmpeg/bin/ffmpeg.exe', ['-i', 'D:/Clips/cs2/ace.mp4', '-c:v', 'libx264', '-crf', '10', 'out.mp4'], 'clips');
  assert.deepEqual(share, { kind: 'Clip share copy', label: 'ace.mp4', encoder: 'x264' });
  assert.equal(load.describeJob('ffmpeg', ['-ss', '1', '-i', 'a.mp4', '-frames:v', '1', 't.jpg'], 'clips').kind, 'Clip thumbnail');
  assert.equal(load.describeJob('ffmpeg', ['-i', 'a.mp4', '-c:v', 'copy', 'b.mp4'], 'clips').kind, 'Clip edit');
  const conv = load.describeJob('ffmpeg', ['-i', 'E:/Media/Dune.mkv', '-c:v', 'h264_nvenc', 'Dune.mp4'], 'convert');
  assert.deepEqual(conv, { kind: 'Conversion', label: 'Dune.mkv', encoder: 'NVENC' });
  assert.equal(load.describeJob('ffprobe.exe', ['-i', 'x'], 'convert'), null, 'quick probes are left out');
  assert.equal(load.describeJob('powershell.exe', ['3 images'], 'ocr').label, '3 images');
});

test('streams are grouped per viewer and file, split by route, and remembered once they stop', () => {
  load._reset();
  const away = load.trackStream(req({ 'cf-ray': 'x', 'cf-connecting-ip': '81.2.3.4' }, '127.0.0.1'), { file: 'E:/Media/House/S02E06.mkv', size: 1e9, label: 'House S02 E06', who: 'Anna' });
  away.add(4 * 2 ** 20); away.done();
  const again = load.trackStream(req({ 'cf-ray': 'y', 'cf-connecting-ip': '81.2.3.4' }, '127.0.0.1'), { file: 'E:/Media/House/S02E06.mkv', size: 1e9, label: 'House S02 E06', who: 'Anna' });
  again.add(2 ** 20); // a seek: a new range request, the same stream
  const tv = load.trackStream(req({}, '192.168.50.40'), { file: 'E:/Media/Dune.mp4', size: 1e9, label: 'Dune (2021)', tv: 'Living room' });
  tv.add(1000);
  const r = load.loadReport();
  assert.equal(r.streams.length, 2);
  const a = r.streams.find((s) => s.who === 'Anna');
  assert.equal(a.where, 'internet');
  assert.equal(a.sent, 5 * 2 ** 20);
  assert.equal(r.streams.find((s) => s.who === 'Living room').where, 'tv');
  const next = later(1500, () => load.loadReport()); // the second still filling isn't counted yet
  assert.ok(next.internet.streams > 0 && next.lan.streams > 0);

  again.done(); tv.done();
  later(60_000, () => load._tick());
  const after = load.loadReport();
  assert.equal(after.streams.length, 0);
  assert.deepEqual(after.recent.map((x) => x.label), ['House S02 E06'], 'tiny streams are not kept as history');
});

test('a job shows while it runs, with its CPU, and is remembered with its average', () => {
  load._reset();
  const child = Object.assign(new EventEmitter(), { pid: 4242 });
  load.trackChild(child, 'ffmpeg', ['-i', 'ace.mp4', '-c:v', 'libx264', 'share.mp4'], 'clips');
  assert.equal(load.loadReport().jobs[0].kind, 'Clip share copy');
  const t = Date.now();
  load.parseSample({ c: [], p: ['4242|ffmpeg|10'] }, t);
  load._setSample(load.parseSample({ c: [], p: ['4242|ffmpeg|30'] }, t + 5000));
  load._tick();
  const job = load.loadReport().jobs[0];
  assert.ok(job.cpu > 0, 'CPU share comes from the process sampler');
  later(10_000, () => child.emit('close', 0));
  const rec = load.loadReport().recent[0];
  assert.equal(rec.type, 'job');
  assert.equal(rec.ok, true);
  assert.equal(load.loadReport().jobs.length, 0);
});

test('Windows counters and nvidia-smi lines are read', () => {
  const s = load.parseSample({
    c: [
      { p: '\\\\HOME\\network interface(realtek gbe)\\bytes sent/sec', i: 'realtek gbe', v: 1000 },
      { p: '\\\\HOME\\network interface(realtek gbe)\\bytes received/sec', i: 'realtek gbe', v: 50 },
      { p: '\\\\HOME\\network interface(isatap.x)\\bytes sent/sec', i: 'isatap.x', v: 999 },
      { p: '\\\\HOME\\physicaldisk(2 e:)\\disk read bytes/sec', i: '2 e:', v: 5e6 },
      { p: '\\\\HOME\\physicaldisk(2 e:)\\% idle time', i: '2 e:', v: 70 },
      { p: '\\\\HOME\\physicaldisk(_total)\\% idle time', i: '_total', v: 10 },
      { p: '\\\\HOME\\processor information(_total)\\% processor utility', i: '_total', v: 123 },
    ],
    p: [], link: 1e9,
  });
  assert.deepEqual(s.net, { up: 1000, down: 50 });
  assert.deepEqual(s.disks, { E: { read: 5e6, write: 0, busy: 30 } });
  assert.equal(s.cpu, 100, 'turbo readings are capped at 100 %');
  const g = load.parseGpu('NVIDIA GeForce GTX 1650, 12, 34, 5, 2, 59.5, 48, 518, 4096');
  assert.equal(g.enc, 34);
  assert.equal(g.sessions, 2);
  assert.equal(load.parseGpu('NVIDIA GeForce GTX 1650, [N/A], 0, 0, 0, 0, 29, 518, 4096').busy, null);
});

test('a video request without a login is named after the person last signed in from that address', () => {
  load._reset();
  load.noteVisitor('81.2.3.4', 'Anna');
  load.trackStream(req({ 'cf-ray': 'x', 'cf-connecting-ip': '81.2.3.4' }, '127.0.0.1'), { file: 'a.mp4', size: 1 }).done();
  load.trackStream(req({ 'cf-ray': 'x', 'cf-connecting-ip': '9.9.9.9' }, '127.0.0.1'), { file: 'a.mp4', size: 1 }).done();
  assert.deepEqual(load.loadReport().streams.map((s) => s.who).sort(), ['Anna', 'Someone (not signed in)']);
});

test('a nearly full upload is called out', () => {
  load._reset();
  const s = load.trackStream(req({ 'cf-ray': 'x', 'cf-connecting-ip': '81.2.3.4' }, '127.0.0.1'), { file: 'x.mkv', size: 1, who: 'Anna' });
  for (let i = 10; i >= 1; i--) later(-i * 1000, () => s.add(12e6)); // 96 Mbit/s for ten seconds
  const r = load.loadReport();
  assert.equal(r.limits.uploadMbps, 100);
  assert.match(r.warnings.join('\n'), /upload is nearly full/);
});
