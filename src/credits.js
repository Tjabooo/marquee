// When an episode's closing credits start. Two sources, both conservative: an explicit ending chapter
// label, or the closing-credits music an episode shares with another episode of the same season.
// Anything uncertain gives null, and the player then waits for the real end of the file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { trackChild } from './load.js';

const FFPROBE = process.env.FFPROBE || 'ffprobe';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

export function creditsStart(info) {
  const duration = Number(info?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(info?.chapters)) return null;
  const matches = info.chapters.filter((chapter) => {
    const title = String(chapter.tags?.title || '').trim().replace(/[_–—-]+/g, ' ').replace(/\s+/g, ' ');
    // Anchored labels avoid opening credits, post-credits scenes and titles mentioning credits.
    return /^(?:(?:end|ending|closing)\s+credits?|credits?(?:\s+(?:end|ending|closing))?|outro|ending|ed)(?:\s*\(\d+\))?$/i.test(title);
  }).map((chapter) => Number(chapter.start_time))
    // A label in the first half is likely an opening or malformed metadata.
    .filter((at) => Number.isFinite(at) && at > duration / 2 && at < duration);
  return matches.length ? Math.min(...matches) : null;
}

function probe(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-show_chapters', '-show_entries',
      'format=duration:chapter=start_time:chapter_tags=title', '-of', 'json', file],
    { timeout: 6000, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try {
        const info = JSON.parse(stdout);
        const duration = Number(info?.format?.duration);
        resolve({ duration: Number.isFinite(duration) && duration > 0 ? duration : null, chapter: creditsStart(info) });
      } catch { resolve(null); }
    });
  });
}

// ---- audio fingerprints ----
// Philips-style (Haitsma & Kalker): 33 log-spaced bands between 300 and 2000 Hz, one 32-bit code per
// 46 ms frame from the sign of the energy difference between neighbouring bands and frames. The same
// music gives (nearly) the same codes in every episode, even from a different encode.
export const RATE = 5512;
const N = 2048; // 0.37 s analysis frame
export const HOP = 256; // 46 ms between codes
const SECONDS = (frames) => (frames * HOP) / RATE;
const FRAMES = (seconds) => Math.round((seconds * RATE) / HOP);
const QUIET_RMS = 100; // about -50 dBFS: silence carries no evidence either way

const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const bitrev = new Uint32Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  bitrev[i] = r;
}
const cosT = Float64Array.from({ length: N / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / N));
const sinT = Float64Array.from({ length: N / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / N));
const bandEdges = Array.from({ length: 34 }, (_, i) => Math.round((300 * (2000 / 300) ** (i / 33) * N) / RATE));

function fft(re, im) {
  for (let i = 0; i < N; i++) {
    const j = bitrev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half, c = cosT[k * step], s = sinT[k * step];
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// samples: Int16Array of mono audio at RATE. Yields to the event loop now and then so a long ending
// never stalls the streams the server is sending meanwhile.
export async function fingerprint(samples) {
  const count = samples.length >= N ? Math.floor((samples.length - N) / HOP) + 1 : 0;
  const codes = new Uint32Array(count), quiet = new Uint8Array(count);
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = null;
  for (let f = 0; f < count; f++) {
    if (f % 512 === 511) await yieldNow();
    let power = 0;
    for (let i = 0, o = f * HOP; i < N; i++) { const v = samples[o + i]; power += v * v; re[i] = v * hann[i]; im[i] = 0; }
    quiet[f] = Math.sqrt(power / N) < QUIET_RMS ? 1 : 0;
    fft(re, im);
    const next = new Float64Array(33);
    for (let m = 0; m < 33; m++) {
      let e = 0;
      for (let k = bandEdges[m]; k < bandEdges[m + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      next[m] = e;
    }
    if (prev) {
      let code = 0;
      for (let m = 0; m < 32; m++) if (next[m] - next[m + 1] - (prev[m] - prev[m + 1]) > 0) code |= 1 << m;
      codes[f] = code >>> 0;
    } else quiet[f] = 1; // the first frame has no predecessor: no code
    prev = next;
  }
  return { codes, quiet };
}

const popcount = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const MIN_MATCH = FRAMES(20); // shorter shared stretches are logos and stings, not credits
const MIN_SOUND = FRAMES(15); // of which this much must be actual sound, not shared silence
const SMOOTH = FRAMES(1); // judge one second at a time
const GAP = FRAMES(2); // a brief dropout doesn't split the credits in two
const MATCH_BITS = 10; // average differing bits per code below this = same audio (unrelated ≈ 16)

// The longest stretch of the same audio in a and b, as frame indexes { a, b, frames }, or null.
export function matchEndings(a, b) {
  const index = new Map();
  for (let j = 0; j < b.codes.length; j++) {
    if (b.quiet[j]) continue;
    const list = index.get(b.codes[j]);
    if (!list) index.set(b.codes[j], [j]); else if (list.length <= 8) list.push(j);
  }
  const votes = new Map();
  for (let i = 0; i < a.codes.length; i++) {
    if (a.quiet[i]) continue;
    const list = index.get(a.codes[i]);
    if (!list || list.length > 8) continue; // a code this common says nothing about alignment
    for (const j of list) votes.set(j - i, (votes.get(j - i) || 0) + 1);
  }
  const near = (d) => (votes.get(d - 1) || 0) + (votes.get(d) || 0) + (votes.get(d + 1) || 0);
  const offsets = [];
  for (const d of [...votes.keys()].sort((x, y) => near(y) - near(x))) {
    if (offsets.length >= 4 || near(d) < 6) break;
    if (!offsets.some((o) => Math.abs(o - d) <= 2)) offsets.push(d);
  }
  let best = null;
  for (const centre of offsets) {
    for (const d of [centre - 1, centre, centre + 1]) {
      const run = longestRun(a, b, d);
      if (run && (!best || run.sound > best.sound)) best = run;
    }
  }
  return best && { a: best.start, b: best.start + best.d, frames: best.frames };
}

function longestRun(a, b, d) {
  const from = Math.max(0, -d), to = Math.min(a.codes.length, b.codes.length - d);
  if (to - from < MIN_MATCH) return null;
  const len = to - from;
  // Per frame: differing bits, or -1 when both are silent (no evidence). One-sided silence is a mismatch.
  const bits = new Int8Array(len);
  for (let k = 0; k < len; k++) {
    const i = from + k, j = i + d;
    bits[k] = a.quiet[i] && b.quiet[j] ? -1 : a.quiet[i] || b.quiet[j] ? 16 : popcount(a.codes[i] ^ b.codes[j]);
  }
  // state: 1 matched, 0 different, -1 neutral (mostly silence)
  const state = new Int8Array(len), half = SMOOTH >> 1;
  let sum = 0, n = 0;
  const add = (k, sign) => { if (k >= 0 && k < len && bits[k] >= 0) { sum += sign * bits[k]; n += sign; } };
  for (let k = -half; k < half; k++) add(k, 1);
  for (let k = 0; k < len; k++) {
    add(k + half, 1); add(k - half - 1, -1);
    state[k] = n < SMOOTH / 4 ? -1 : sum / n < MATCH_BITS ? 1 : 0;
  }
  let best = null, start = -1, sound = 0, lastMatch = -1;
  const close = () => {
    if (start < 0) return;
    const frames = lastMatch - start + 1;
    if (frames >= MIN_MATCH && sound >= MIN_SOUND && (!best || sound > best.sound)) best = { start: from + start, frames, sound, d };
    start = -1; sound = 0;
  };
  for (let k = 0; k < len; k++) {
    if (state[k] === 1) {
      if (start < 0) start = k;
      sound++; lastMatch = k;
    } else if (state[k] === 0 && start >= 0 && k - lastMatch > GAP) close();
  }
  close();
  return best;
}

// ---- decoding ----
const WINDOW = 360; // seconds of each ending to compare
let busy = Promise.resolve(); // one decode at a time: it reads hundreds of MB from the media drive

function decodeEnding(file, start, seconds) {
  const task = busy.then(() => new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin', '-ss', start.toFixed(3), '-i', file, '-t', seconds.toFixed(3),
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'];
    let child;
    try { child = spawn(FFMPEG, args, { windowsHide: true }); } catch { resolve(null); return; }
    trackChild(child, FFMPEG, args, 'credits');
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed */ }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (d) => { chunks.push(d); size += d.length; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || size < N * 2) { resolve(null); return; }
      const buf = Buffer.concat(chunks, size - (size % 2));
      const samples = new Int16Array(buf.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);
      resolve(samples);
    });
  }));
  busy = task.catch(() => {});
  return task;
}

// ---- per-file facts, cached on disk ----
// files[path] = { key, duration, chapter, vs: { siblingKey: creditsStart | null } }
let stateFile = null;
let state = { files: {} };
let saveTimer = null;
const LIMIT = 3000;

export function initCredits({ dataDir } = {}) {
  stateFile = dataDir ? path.join(dataDir, '.marquee-credits.json') : null;
  state = { files: {} };
  if (!stateFile) return;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (saved && typeof saved.files === 'object') state = { files: saved.files };
  } catch { /* first run */ }
}

function save() {
  if (!stateFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const names = Object.keys(state.files);
    if (names.length > LIMIT) {
      names.sort((x, y) => (state.files[x].at || 0) - (state.files[y].at || 0));
      for (const name of names.slice(0, names.length - LIMIT)) delete state.files[name];
    }
    const tmp = `${stateFile}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, stateFile); } catch { /* next save */ }
  }, 1000);
  saveTimer.unref?.();
}

const probing = new Map();
async function facts(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const key = `${stat.size}|${Math.round(stat.mtimeMs)}`;
  const hit = state.files[file];
  if (hit?.key === key && hit.probed) { hit.at = Date.now(); return hit; }
  if (probing.has(file)) return probing.get(file);
  const task = probe(file).then((info) => {
    if (!info) return { key, duration: null, chapter: null, vs: {} }; // not cached: retried next time
    const entry = { key, duration: info.duration, chapter: info.chapter, vs: {}, probed: true, at: Date.now() };
    state.files[file] = entry;
    save();
    return entry;
  }).finally(() => probing.delete(file));
  probing.set(file, task);
  return task;
}

// Fingerprints of recently compared endings, so neighbouring episodes reuse each other's.
const prints = new Map();
async function endingPrint(file, entry) {
  const id = `${file}|${entry.key}`;
  if (prints.has(id)) { const p = prints.get(id); prints.delete(id); prints.set(id, p); return p; }
  const start = Math.max(entry.duration / 2, entry.duration - WINDOW);
  const task = decodeEnding(file, start, entry.duration - start)
    .then(async (samples) => (samples ? { start, ...(await fingerprint(samples)) } : null));
  prints.set(id, task);
  while (prints.size > 6) prints.delete(prints.keys().next().value);
  const value = await task;
  if (!value) prints.delete(id);
  return value;
}

const comparing = new Map();
async function compare(fileA, a, fileB, b) {
  const pair = [fileA, fileB].sort().join('\n');
  if (comparing.has(pair)) return comparing.get(pair);
  const task = (async () => {
    const pa = await endingPrint(fileA, a);
    const pb = pa && await endingPrint(fileB, b);
    if (!pa || !pb) return false; // couldn't decode: try again another time
    const m = matchEndings(pa, pb);
    // Rounded up: the countdown may start a moment late, never early.
    const at = (p, frame, entry) => {
      const t = Math.ceil((p.start + SECONDS(frame) + 0.5) * 10) / 10;
      return t > entry.duration / 2 && t < entry.duration - 1 ? t : null;
    };
    a.vs[b.key + '|' + fileB] = m ? at(pa, m.a, a) : null;
    b.vs[a.key + '|' + fileA] = m ? at(pb, m.b, b) : null;
    save();
    return true;
  })().finally(() => comparing.delete(pair));
  comparing.set(pair, task);
  return task;
}

// file: the episode. siblings: other episodes of the same season, nearest first (at most two are used).
export async function creditsFor(file, siblings = []) {
  const entry = await facts(file);
  if (!entry) return null;
  if (entry.chapter != null || !entry.duration || entry.duration < 300) return entry.chapter ?? null;
  const found = [];
  for (const other of siblings.slice(0, 2)) {
    if (path.resolve(other) === path.resolve(file)) continue;
    const peer = await facts(other);
    if (!peer?.duration || peer.duration < 300) continue;
    const id = peer.key + '|' + other;
    if (!(id in entry.vs)) await compare(file, entry, other, peer);
    if (entry.vs[id] != null) found.push(entry.vs[id]);
  }
  // Two siblings that disagree: the later start is the safe one.
  return found.length ? Math.max(...found) : null;
}
