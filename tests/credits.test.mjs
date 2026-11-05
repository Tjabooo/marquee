import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { creditsStart, creditsFor, introFor, introChapter, agreeIntro, initCredits, fingerprint, matchEndings, matchOpenings, RATE, HOP } from '../src/credits.js';

const info = (title, start = '1900') => ({ format: { duration: '2100' }, chapters: [{ start_time: start, tags: { title } }] });

test('only explicit ending chapter labels provide credits timing', () => {
  for (const name of ['Credits', 'End Credits', 'Closing credits', 'Ending', 'Outro', 'ED']) {
    assert.equal(creditsStart(info(name)), 1900, name);
  }
  for (const name of ['Opening Credits', 'Post Credits', 'Post-Credits Scene', 'Chapter 12', 'A story about credits', 'Ending the war', '']) {
    assert.equal(creditsStart(info(name)), null, name);
  }
  for (const at of ['NaN', '-10', '0', '500', '2100', '2500']) assert.equal(creditsStart(info('Credits', at)), null);
  assert.equal(creditsStart({ chapters: info('Credits').chapters }), null);
  assert.equal(creditsStart({ format: { duration: 2100 }, chapters: {} }), null);
  const multi = info('Credits');
  multi.chapters.push({ start_time: '2000', tags: { title: 'End credits' } });
  assert.equal(creditsStart(multi), 1900);
});

test('chapter probe reads actual media, caches by file identity and degrades gracefully', async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); await run(process.env.FFPROBE || 'ffprobe', ['-version']); }
  catch { t.skip('FFmpeg tools unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-credits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'sample.mp4'), meta = path.join(dir, 'chapters.txt');
  await fs.writeFile(meta, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=12000\ntitle=Episode\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=12000\nEND=20000\ntitle=End Credits\n');
  await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1:d=20',
    '-i', meta, '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'libx264', '-y', video]);
  assert.deepEqual(await Promise.all([creditsFor(video), creditsFor(video)]), [12, 12]);
  assert.equal(await creditsFor(video), 12);
  await fs.writeFile(video, 'not a video');
  assert.equal(await creditsFor(video), null, 'replaced file must not reuse the old credits marker');
  assert.equal(await creditsFor(path.join(dir, 'missing.mp4')), null);
});

// Synthetic episodes: a scene of random tones and noise, then the same closing music.
function synth(seed) {
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  const scene = (sec) => { const out = new Float64Array(Math.round(sec * RATE)); let f = 300, next = 0;
    for (let i = 0; i < out.length; i++) {
      if (i >= next) { f = 200 + Math.abs(rnd()) * 1600; next = i + RATE * (0.3 + Math.abs(rnd())); }
      out[i] = 0.25 * Math.sin(2 * Math.PI * f * i / RATE) + 0.15 * rnd();
    } return out; };
  const music = (sec) => { const out = new Float64Array(Math.round(sec * RATE));
    for (let i = 0; i < out.length; i++) { const t = i / RATE, n = Math.floor(t * 3);
      const f1 = 220 * 2 ** (((n * 7) % 12) / 12), f2 = 330 * 2 ** (((n * 5) % 9) / 12);
      out[i] = 0.3 * Math.sin(2 * Math.PI * f1 * t) + 0.2 * Math.sin(2 * Math.PI * f2 * t) + 0.1 * Math.sin(6 * Math.PI * f1 * t);
    } return out; };
  const pcm = (...parts) => { const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
    for (const p of parts) for (let i = 0; i < p.length; i++) out[o++] = Math.max(-32768, Math.min(32767, Math.round(p[i] * 20000 + rnd() * 300)));
    return out; };
  return { scene, music, pcm };
}

test('the shared closing music is found to the frame, and unrelated endings match nothing', async () => {
  const one = synth(7), two = synth(99), three = synth(5);
  const a = await fingerprint(one.pcm(one.scene(250), one.music(70)));
  const b = await fingerprint(two.pcm(two.scene(203.37), two.music(70)));
  const m = matchEndings(a, b);
  assert.ok(Math.abs((m.a * HOP) / RATE - 250) < 0.1, `credits in A at ${(m.a * HOP) / RATE}`);
  assert.ok(Math.abs((m.b * HOP) / RATE - 203.37) < 0.1, `credits in B at ${(m.b * HOP) / RATE}`);
  assert.equal(matchEndings(a, await fingerprint(three.pcm(three.scene(320)))), null);
  // A shared 10 s sting (a logo) is too short to be credits.
  const c = await fingerprint(three.pcm(three.scene(300), three.music(10)));
  assert.equal(matchEndings(a, c), null);
});

test('creditsFor compares real encoded episodes, prefers chapters and caches on disk', async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-credits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  initCredits({ dataDir: dir });
  const encode = async (name, samples) => {
    const raw = path.join(dir, `${name}.raw`), out = path.join(dir, `${name}.m4a`);
    await fs.writeFile(raw, Buffer.from(samples.buffer));
    // Different bitrates and sample rates: the same music from two different encodes.
    await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', raw,
      '-ar', name === 'e1' ? '48000' : '44100', '-c:a', 'aac', '-b:a', name === 'e1' ? '128k' : '96k', '-y', out]);
    return out;
  };
  const one = synth(7), two = synth(99), three = synth(5);
  const e1 = await encode('e1', one.pcm(one.scene(250), one.music(70)));
  const e2 = await encode('e2', two.pcm(two.scene(310), two.music(70)));
  const e3 = await encode('e3', three.pcm(three.scene(330)));
  const at = await creditsFor(e1, [e2]);
  assert.ok(at >= 250 && at < 251.5, `E1 credits at ${at}`);
  const at2 = await creditsFor(e2, [e1]);
  assert.ok(at2 >= 310 && at2 < 311.5, `E2 credits at ${at2}`);
  assert.equal(await creditsFor(e3, [e1]), null, 'no shared music: wait for the end');
  assert.equal(await creditsFor(e1, [e3, e2]), at, 'one sibling without the same credits does not hide the other');
  assert.equal(await creditsFor(e1, []), null);
  await new Promise((r) => setTimeout(r, 1300));
  const saved = JSON.parse(await fs.readFile(path.join(dir, '.marquee-credits.json'), 'utf8'));
  assert.ok(Object.values(saved.files[e1].vs).includes(at));
  initCredits({ dataDir: dir });
  assert.equal(await creditsFor(e1, [e2]), at, 'the comparison survives a restart');
});

test('opening chapters give the intro; other labels and odd lengths do not', () => {
  const at = (title, start, end) => introChapter({ format: { duration: '2400' }, chapters: [
    { start_time: '0', end_time: String(start), tags: { title: 'Prologue' } },
    { start_time: String(start), end_time: String(end), tags: { title } }] });
  for (const name of ['Intro', 'Opening', 'OP', 'Opening Credits', 'Opening titles', 'Title sequence', 'Main titles', 'Theme song', 'OP 2']) {
    assert.deepEqual(at(name, 95, 185), { start: 95, end: 185 }, name);
  }
  for (const name of ['Credits', 'Ending', 'Episode', 'Introduction to chemistry', '']) assert.equal(at(name, 95, 185), null, name);
  assert.equal(at('Intro', 95, 100), null, 'a 5 s card is not an intro');
  assert.equal(at('Intro', 95, 400), null, 'five minutes is not an intro');
  assert.equal(at('Intro', 1200, 1290), null, 'not in the first third');
});

test('siblings that disagree about the intro only skip what they agree on', () => {
  assert.equal(agreeIntro([]), null);
  assert.deepEqual(agreeIntro([{ start: 30, end: 90 }]), { start: 30, end: 90 });
  assert.deepEqual(agreeIntro([{ start: 30, end: 90 }, { start: 31, end: 88 }]), { start: 31, end: 88 });
  assert.equal(agreeIntro([{ start: 30, end: 90 }, { start: 200, end: 260 }]), null);
});

test('the shared theme song is found after a cold open of any length', async () => {
  const one = synth(7), two = synth(99), three = synth(5);
  const a = await fingerprint(one.pcm(one.scene(37.5), one.music(55), one.scene(200)));
  const b = await fingerprint(two.pcm(two.scene(4.2), two.music(55), two.scene(230)));
  const m = matchOpenings(a, b);
  const s = (f) => (f * HOP) / RATE;
  assert.ok(Math.abs(s(m.a) - 37.5) < 0.6 && Math.abs(s(m.b) - 4.2) < 0.6, `starts ${s(m.a)} ${s(m.b)}`);
  assert.ok(Math.abs(s(m.frames) - 55) < 1.2, `length ${s(m.frames)}`);
  assert.equal(matchOpenings(a, await fingerprint(three.pcm(three.scene(300)))), null);
});

test('introFor compares real encoded openings and caches them', async (t) => {
  const run = promisify(execFile);
  try { await run(process.env.FFMPEG || 'ffmpeg', ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-intro-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  initCredits({ dataDir: dir });
  const encode = async (name, samples) => {
    const raw = path.join(dir, `${name}.raw`), out = path.join(dir, `${name}.m4a`);
    await fs.writeFile(raw, Buffer.from(samples.buffer));
    await run(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', raw,
      '-ar', name === 'e1' ? '48000' : '44100', '-c:a', 'aac', '-b:a', name === 'e1' ? '128k' : '96k', '-y', out]);
    return out;
  };
  const one = synth(7), two = synth(99), three = synth(5);
  const e1 = await encode('e1', one.pcm(one.scene(62), one.music(48), one.scene(240)));
  const e2 = await encode('e2', two.pcm(two.music(48), two.scene(300)));
  const e3 = await encode('e3', three.pcm(three.scene(330)));
  const i1 = await introFor(e1, [e2]);
  assert.ok(i1 && i1.start >= 62 && i1.start < 63 && i1.end <= 110 && i1.end > 108.5, `E1 intro ${JSON.stringify(i1)}`);
  const i2 = await introFor(e2, [e1]);
  assert.ok(i2 && i2.start < 1 && i2.end <= 48 && i2.end > 46.5, `E2 intro ${JSON.stringify(i2)}`);
  assert.equal(await introFor(e3, [e1]), null);
  assert.deepEqual(await introFor(e1, [e3, e2]), i1, 'one sibling without the theme does not hide the other');
  await new Promise((r) => setTimeout(r, 1300));
  initCredits({ dataDir: dir });
  assert.deepEqual(await introFor(e1, [e2]), i1, 'the comparison survives a restart');
});
