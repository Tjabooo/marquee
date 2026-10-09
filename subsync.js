// Automatic subtitle timing.
// Downloaded subtitles are often made for a different release of the same film: they start a few
// seconds early or late, or drift because the release runs at another frame rate (23.976 vs 25 fps).
// This lines a subtitle file up against something already in sync with the video, in this order:
//   1. a text subtitle track embedded in the video (or the file it was converted from),
//   2. a subtitle file Marquee extracted from such a track during conversion,
//   3. the film's audio (when people are talking).
// Cue timings become on/off signals, are cross-correlated for each likely frame-rate ratio, and the
// best match is applied only when it is clearly better than the alternatives. The original file is
// kept so the change can be undone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const AUTO = (process.env.SUBSYNC || 'on').toLowerCase() !== 'off';

const BIN = 0.04;            // coarse search resolution, seconds
const FINE = 0.01;           // reference resolution for the final refinement
const MAX_SHIFT = 600;       // largest correction considered, seconds
const MIN_CUES = 40;         // fewer cues than this can't be aligned reliably
const RATIOS = [1, 25 / (24000 / 1001), (24000 / 1001) / 25, 24 / (24000 / 1001), (24000 / 1001) / 24, 25 / 24, 24 / 25];
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

let registryFile = null;
let backupDir = null;
let registry = {};           // srt path -> entry (see stateOf)
let manualShift = () => 0;   // audio correction the viewer applied to a video, seconds
let ffmpegOk = null;

const keyOf = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const save = () => { try { fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2)); } catch { /* best effort */ } };
const stamp = (p) => { try { const s = fs.statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return null; } };

export const autoSyncEnabled = () => AUTO;

export function initSubsync({ dataDir, audioShift } = {}) {
  registryFile = path.join(dataDir, '.marquee-subsync.json');
  backupDir = path.join(dataDir, 'cache', 'subsync');
  if (audioShift) manualShift = audioShift;
  try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { registry = {}; }
  // Jobs interrupted by a restart run again.
  for (const [k, e] of Object.entries(registry)) {
    if (e.state === 'queued' || e.state === 'syncing') { e.state = null; if (e.video) setTimeout(() => queueSync(e.path || k, e.video), 15000); }
  }
}

// Subtitle files extracted from the video itself: already in sync, and usable as references.
export function markTrusted(srt) {
  registry[keyOf(srt)] = { path: srt, trusted: true, stamp: stamp(srt) };
  save();
}

// A downloaded subtitle that OpenSubtitles matched to this exact file.
export function markExact(srt) {
  registry[keyOf(srt)] = { path: srt, state: 'exact', stamp: stamp(srt), at: Date.now() };
  save();
}

function entryFor(srt) {
  const e = registry[keyOf(srt)];
  if (!e) return null;
  // The file was replaced or edited since: the record no longer applies.
  if (e.stamp && e.stamp !== stamp(srt) && e.state !== 'queued' && e.state !== 'syncing') { delete registry[keyOf(srt)]; return null; }
  return e;
}

const backupPath = (srt) => path.join(backupDir, `${crypto.createHash('sha1').update(keyOf(srt)).digest('hex').slice(0, 24)}.srt`);

// { state, offset, ratio, reference, canUndo, canSync, error } for the viewer.
// state: null | queued | syncing | synced | ok | unsure | failed | exact | undone | trusted
export function stateOf(srt) {
  const e = entryFor(srt);
  const busy = e?.state === 'queued' || e?.state === 'syncing';
  return {
    state: e?.trusted ? 'trusted' : e?.state || null,
    offset: e?.offset ?? null,
    ratio: e?.ratio ?? null,
    manual: e?.manual || 0,
    reference: e?.reference ?? null,
    error: e?.error ?? null,
    at: e?.at ?? null,
    canUndo: e?.state === 'synced' && fs.existsSync(backupPath(srt)),
    canSync: !e?.trusted && !busy && ffmpegOk !== false,
  };
}

// Restores the subtitle file as it was before the timing fix.
export function undoSync(srt) {
  const e = entryFor(srt);
  const backup = backupPath(srt);
  if (e?.state !== 'synced' || !fs.existsSync(backup)) throw Object.assign(new Error('There’s no timing fix to undo.'), { status: 409 });
  fs.copyFileSync(backup, srt);
  registry[keyOf(srt)] = { path: srt, state: 'undone', stamp: stamp(srt), at: Date.now() };
  save();
  return stateOf(srt);
}

// Moves every line by `seconds` (the manual timing buttons). The file as it was before any change is
// kept, so "Undo timing fix" always goes back to the original.
export function nudge(srt, seconds) {
  const e = entryFor(srt);
  if (e?.state === 'queued' || e?.state === 'syncing') throw Object.assign(new Error('The timing is being checked right now. Try again in a moment.'), { status: 409 });
  const backup = backupPath(srt);
  const changed = e?.state === 'synced' && fs.existsSync(backup);
  // Always recomputed from the original, so lines pushed before 0:00 come back when moved later again.
  const original = decode(fs.readFileSync(changed ? backup : srt));
  if (!changed) { fs.mkdirSync(backupDir, { recursive: true }); fs.writeFileSync(backup, original, 'utf8'); }
  const auto = changed && e.offset != null ? e : null; // an automatic fix stays applied underneath
  const manual = round((changed ? e.manual || 0 : 0) + seconds);
  if (!auto && Math.abs(manual) < 0.001) { // back to the original
    fs.copyFileSync(backup, srt);
    forget(srt);
    return stateOf(srt);
  }
  const tmp = `${srt}.subsync-tmp`;
  fs.writeFileSync(tmp, retime(original, auto ? auto.ratio : 1, (auto ? auto.offset : 0) + manual), 'utf8');
  fs.renameSync(tmp, srt);
  registry[keyOf(srt)] = {
    ...(auto || { offset: null, ratio: null, reference: null }),
    path: srt, state: 'synced', manual, stamp: stamp(srt), at: Date.now(),
  };
  save();
  return stateOf(srt);
}

// Drops records and backups for deleted subtitle files.
export function forget(srt) {
  if (!registry[keyOf(srt)]) return;
  delete registry[keyOf(srt)];
  fs.rmSync(backupPath(srt), { force: true });
  save();
}

// ---------- queue ----------
const queue = [];
let running = false;

// Aligns `srt` to `video` in the background. Returns the state right away.
export function queueSync(srt, video) {
  const k = keyOf(srt);
  const e = registry[k];
  if (e?.trusted) return stateOf(srt);
  if (e?.state === 'queued' || e?.state === 'syncing') return stateOf(srt);
  // Re-checking a file that was already fixed starts again from the original.
  const fromBackup = e?.state === 'synced' && fs.existsSync(backupPath(srt));
  registry[k] = { path: srt, video, state: 'queued', at: Date.now() };
  queue.push({ srt, video, fromBackup, prior: fromBackup ? { offset: e.offset, ratio: e.ratio, reference: e.reference } : null });
  save();
  drain();
  return stateOf(srt);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const { srt, video, fromBackup, prior } = queue.shift();
      const k = keyOf(srt);
      registry[k] = { ...registry[k], state: 'syncing' };
      try {
        const result = await syncFile(srt, video, fromBackup, prior);
        registry[k] = { path: srt, ...result, stamp: stamp(srt), at: Date.now() };
        const what = result.state === 'synced' ? `shifted ${fmt(result.offset)}${result.ratio !== 1 ? `, rate ×${result.ratio.toFixed(4)}` : ''}`
          : result.state === 'ok' ? 'already in sync' : 'no confident match, left unchanged';
        console.log(`[subsync] ${path.basename(srt)}: ${what} (reference: ${result.reference || 'none'})`);
      } catch (err) {
        registry[k] = { path: srt, video, state: 'failed', error: err.message, stamp: stamp(srt), at: Date.now() };
        console.warn(`[subsync] ${path.basename(srt)}: ${err.message}`);
      }
      save();
    }
  } finally {
    running = false;
  }
}
const fmt = (s) => `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(2)} s`;

// ---------- the job ----------
async function syncFile(srt, video, fromBackup = false, prior = null) {
  const backup = backupPath(srt);
  const text = decode(await fs.promises.readFile(fromBackup ? backup : srt));
  const cues = parseCues(text);
  if (cues.length < MIN_CUES) return { state: 'unsure', reference: null, error: 'Too few lines to check the timing.' };
  const lang = (/\.([a-z]{2,3}(?:-[a-z]{2})?)\.(?:[\w-]+\.)?srt$/i.exec(srt)?.[1] || '').toLowerCase();

  const attempts = [];
  // 1-2. Subtitle references.
  for (const ref of await subtitleReferences(srt, video, lang)) {
    const refCues = await ref.load().catch(() => null);
    if (!refCues || refCues.length < MIN_CUES) continue;
    const result = align(cues, cueTrack(refCues), { kind: 'subtitles' });
    attempts.push({ ...result, reference: ref.label });
    if (result.confident) break;
  }
  // 3. Audio.
  if (!attempts.some((a) => a.confident)) {
    const voice = await voiceTrack(video);
    if (voice) {
      const result = align(cues, voice, { kind: 'audio' });
      attempts.push({ ...result, reference: 'audio' });
    }
  }
  const best = attempts.find((a) => a.confident);
  if (!best) {
    if (fromBackup) return { state: 'synced', ...prior }; // keep the earlier fix
    return { state: 'unsure', reference: attempts.map((a) => a.reference).join(', ') || null };
  }

  const tolerance = best.kind === 'audio' ? 0.25 : 0.12;
  if (best.ratio === 1 && Math.abs(best.offset) < tolerance) {
    if (fromBackup) await fs.promises.copyFile(backup, srt); // the earlier fix wasn't needed after all
    return { state: 'ok', offset: 0, ratio: 1, reference: best.reference };
  }

  fs.mkdirSync(backupDir, { recursive: true });
  if (!fromBackup) await fs.promises.writeFile(backup, text, 'utf8');
  const tmp = `${srt}.subsync-tmp`;
  await fs.promises.writeFile(tmp, retime(text, best.ratio, best.offset), 'utf8');
  await fs.promises.rename(tmp, srt);
  return { state: 'synced', offset: round(best.offset), ratio: best.ratio, reference: best.reference, confidence: round(best.z) };
}
const round = (n) => Math.round(n * 1000) / 1000;

// ---------- SRT ----------
function decode(buf) {
  let s = buf.toString('utf8');
  if (s.includes('�')) s = new TextDecoder('windows-1252').decode(buf);
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const secs = (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;

export function parseCues(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('-->')) continue;
    const [a, b] = line.split('-->');
    const ma = TIME.exec(a);
    const mb = TIME.exec(b);
    if (!ma || !mb) continue;
    const start = secs(ma);
    const end = secs(mb);
    if (end > start && end - start < 30) out.push({ start, end });
  }
  return out.sort((x, y) => x.start - y.start);
}

const stampOf = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// Rewrites every timestamp as t × ratio + offset, leaving everything else untouched.
export function retime(text, ratio, offset) {
  return text.replace(/^(\s*)(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(.*)$/gm,
    (_, lead, a, arrow, b, rest) => `${lead}${stampOf(secs(TIME.exec(a)) * ratio + offset)}${arrow}${stampOf(secs(TIME.exec(b)) * ratio + offset)}${rest}`);
}

// ---------- references ----------
function run(cmd, args, { maxBytes = 64 * 1024 * 1024, timeoutMs = 10 * 60 * 1000, onData } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ }
    const chunks = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => {
      if (onData) return onData(d);
      size += d.length;
      if (size > maxBytes) child.kill(); else chunks.push(d);
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); ffmpegOk = false; reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { ffmpegOk = true; resolve(Buffer.concat(chunks)); } else reject(new Error(err.trim().split('\n').pop() || `${path.basename(cmd)} exited with ${code}`));
    });
  });
}

async function probe(file) {
  try { return JSON.parse((await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', file])).toString()); } catch { return null; }
}

const ISO3 = { eng: 'en', swe: 'sv', dan: 'da', nor: 'no', nob: 'no', fin: 'fi', ger: 'de', deu: 'de', dut: 'nl', nld: 'nl', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', pol: 'pl', ara: 'ar', tur: 'tr', por: 'pt' };
const sameLang = (iso, lang) => {
  const code = ISO3[String(iso || '').toLowerCase()] || String(iso || '').toLowerCase();
  return Boolean(lang) && (code === lang || lang.startsWith(`${code}-`));
};

// Candidate references, best first: embedded text tracks, then extracted sidecars.
async function subtitleReferences(srt, video, lang) {
  const refs = [];
  const files = [video];
  const original = originalOf(video);
  if (original && original !== video) files.push(original);
  for (const file of files) {
    const info = await probe(file);
    const subs = (info?.streams || []).filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name)
      && !s.disposition?.forced && !/forced/i.test(s.tags?.title || ''));
    // Same language first, then English, then the rest; full subtitles before SDH.
    const rank = (s) => (sameLang(s.tags?.language, lang) ? 0 : sameLang(s.tags?.language, 'en') ? 1 : 2) * 2
      + (s.disposition?.hearing_impaired || /sdh|hearing/i.test(s.tags?.title || '') ? 1 : 0);
    for (const s of subs.sort((a, b) => rank(a) - rank(b)).slice(0, 2)) {
      refs.push({
        label: `embedded ${s.tags?.language || ''} track`.replace(/\s+/g, ' '),
        load: async () => parseCues(decode(await run(FFMPEG, ['-v', 'error', '-i', file, '-map', `0:${s.index}`, '-f', 'srt', 'pipe:1']))),
      });
    }
  }
  const stem = path.basename(video, path.extname(video)).toLowerCase();
  let entries = [];
  try { entries = fs.readdirSync(path.dirname(video)); } catch { /* folder gone */ }
  for (const e of entries) {
    const full = path.join(path.dirname(video), e);
    const l = e.toLowerCase();
    if (!l.startsWith(`${stem}.`) || !l.endsWith('.srt') || keyOf(full) === keyOf(srt)) continue;
    if (!entryFor(full)?.trusted) continue;
    refs.push({ label: `extracted ${e.slice(stem.length + 1, -4)} subtitles`, load: async () => parseCues(decode(await fs.promises.readFile(full))) });
  }
  return refs;
}

// The MKV/AVI an MP4 copy was made from, when it's still there.
function originalOf(file) {
  const stem = path.join(path.dirname(file), path.basename(file, path.extname(file)));
  for (const ext of ['.mkv', '.avi', '.MKV', '.AVI', '.webm']) if (stem + ext !== file && fs.existsSync(stem + ext)) return stem + ext;
  return null;
}

// Reference track (10 ms resolution) from cues: 1 while a line is on screen.
function cueTrack(cues) {
  const len = Math.ceil((cues[cues.length - 1].end + 1) / FINE);
  const v = new Float32Array(len);
  for (const c of cues) fillRange(v, c.start / FINE, c.end / FINE, 1);
  return { step: FINE, values: zeroMean(v) };
}

// Speech-likeness per 10 ms from the main audio track: loudness in the voice band,
// compared with the surrounding few seconds so steady music and noise count less.
async function voiceTrack(video) {
  const info = await probe(video);
  const streams = info?.streams || [];
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const main = audios.find((a) => a.disposition?.default) || audios[0];
  if (!main) return null;
  const vid = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  // PCM sample 0 is the audio track's first sample; on screen that's its start relative to the picture.
  const lead = (Number(main.start_time) || 0) - (Number(vid?.start_time) || 0);
  const shift = lead + (Number(manualShift(video)) || 0);
  const center = /5\.1|7\.1/.test(main.channel_layout || '') ? 'pan=mono|c0=FC,' : '';
  const RATE = 8000;
  const FRAME = RATE * FINE; // samples per 10 ms
  const energies = [];
  let acc = 0;
  let n = 0;
  let carry = null;
  await run(FFMPEG, ['-v', 'error', '-i', video, '-map', `0:${main.index}`, '-vn', '-sn', '-dn',
    '-af', `${center}highpass=f=250,lowpass=f=3500`, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {
    timeoutMs: 20 * 60 * 1000,
    onData: (d) => {
      if (carry) { d = Buffer.concat([carry, d]); carry = null; }
      const usable = d.length & ~1;
      for (let i = 0; i < usable; i += 2) {
        const s = d.readInt16LE(i) / 32768;
        acc += s * s;
        if (++n === FRAME) { energies.push(acc / FRAME); acc = 0; n = 0; }
      }
      if (usable < d.length) carry = d.subarray(usable);
    },
  });
  if (energies.length < 6000) return null; // under a minute of audio
  const loud = Float32Array.from(energies, (e) => Math.log10(e + 1e-7));
  const sorted = Float32Array.from(loud).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const spread = Math.max(0.5, sorted[Math.floor(sorted.length * 0.9)] - floor);
  // Moving average over ±1.5 s with prefix sums.
  const W = Math.round(1.5 / FINE);
  const pre = new Float64Array(loud.length + 1);
  for (let i = 0; i < loud.length; i++) pre[i + 1] = pre[i] + loud[i];
  const voice = new Float32Array(loud.length);
  for (let i = 0; i < loud.length; i++) {
    const a = Math.max(0, i - W);
    const b = Math.min(loud.length, i + W + 1);
    const local = (pre[b] - pre[a]) / (b - a);
    const absolute = (loud[i] - floor) / spread;     // above the quietest parts of the film
    const relative = (loud[i] - local) / spread;     // louder than its surroundings
    voice[i] = Math.max(0, Math.min(1.5, absolute)) * 0.5 + Math.max(-1, Math.min(1, relative)) * 0.5;
  }
  // Apply the start offset by moving samples so the track is in on-screen time.
  const move = Math.round(shift / FINE);
  let values = voice;
  if (move > 0) { values = new Float32Array(voice.length + move); values.set(voice, move); } else if (move < 0) values = voice.subarray(-move);
  return { step: FINE, values: zeroMean(values) };
}

// ---------- alignment ----------
function fillRange(v, a, b, value) {
  const i0 = Math.max(0, Math.floor(a));
  const i1 = Math.min(v.length - 1, Math.floor(b));
  for (let i = i0; i <= i1; i++) {
    const cover = Math.min(b, i + 1) - Math.max(a, i);
    if (cover > 0) v[i] += value * cover;
  }
}

function zeroMean(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i];
  const mean = sum / v.length;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - mean;
  return out;
}

// Downsamples a reference track to the coarse bin size.
function coarse(ref) {
  const k = Math.round(BIN / ref.step);
  const out = new Float64Array(Math.ceil(ref.values.length / k));
  for (let i = 0; i < ref.values.length; i++) out[(i / k) | 0] += ref.values[i];
  return out;
}

// Subtitle cue mask. For audio, the part where a line usually lingers after speech ends is trimmed.
function cueMask(cues, ratio, offset, kind) {
  return cues.map((c) => {
    const dur = c.end - c.start;
    const end = kind === 'audio' ? c.end - Math.min(0.4, dur * 0.25) : c.end;
    return { start: c.start * ratio + offset, end: end * ratio + offset };
  });
}

// Best { ratio, offset } mapping subtitle time t to t × ratio + offset, and whether it's trustworthy.
export function align(cues, ref, { kind = 'subtitles' } = {}) {
  const r = coarse(ref);
  const results = [];
  const lagMax = Math.round(MAX_SHIFT / BIN);
  for (const ratio of RATIOS) {
    const mask = cueMask(cues, ratio, 0, kind);
    const len = Math.ceil((mask[mask.length - 1].end + 1) / BIN);
    const a = new Float64Array(len);
    for (const c of mask) fillRange(a, c.start / BIN, c.end / BIN, 1);
    let mean = 0;
    for (let i = 0; i < len; i++) mean += a[i];
    mean /= len;
    let norm = 0;
    for (let i = 0; i < len; i++) { a[i] -= mean; norm += a[i] * a[i]; }
    const corr = crossCorrelate(a, r, lagMax);
    // Peak, and how far it stands above every other alignment in range.
    let best = 0;
    for (let i = 1; i < corr.values.length; i++) if (corr.values[i] > corr.values[best]) best = i;
    let s = 0;
    let s2 = 0;
    for (const x of corr.values) { s += x; s2 += x * x; }
    const m = s / corr.values.length;
    const sd = Math.sqrt(Math.max(1e-12, s2 / corr.values.length - m * m));
    const away = Math.round(3 / BIN);
    let second = -Infinity;
    for (let i = 0; i < corr.values.length; i++) if (Math.abs(i - best) > away && corr.values[i] > second) second = corr.values[i];
    const peak = corr.values[best];
    results.push({
      ratio, offset: (best + corr.first) * BIN, score: peak / Math.sqrt(norm),
      z: (peak - m) / sd, distinct: (peak - m) / Math.max(1e-12, second - m),
    });
  }
  // A frame-rate change has to be clearly better than none.
  results.sort((x, y) => y.score - x.score);
  const plain = results.find((x) => x.ratio === 1);
  let pick = results[0];
  if (pick.ratio !== 1 && pick.score < plain.score * 1.15) pick = plain;
  const offset = refine(cues, ref, pick.ratio, pick.offset, kind);
  const zMin = kind === 'audio' ? 8 : 10;
  const confident = pick.z >= zMin && pick.distinct >= 1.2;
  return { kind, ratio: pick.ratio, offset, z: pick.z, distinct: pick.distinct, confident };
}

// 10 ms refinement around the coarse result, scoring the overlap directly.
// Ties (a plateau) resolve to the middle of the plateau.
function refine(cues, ref, ratio, around, kind) {
  const v = ref.values;
  const pre = new Float64Array(v.length + 1);
  for (let i = 0; i < v.length; i++) pre[i + 1] = pre[i] + v[i];
  const at = (t) => {
    const x = t / ref.step;
    if (x <= 0) return 0;
    if (x >= v.length) return pre[v.length];
    const i = Math.floor(x);
    return pre[i] + (pre[i + 1] - pre[i]) * (x - i);
  };
  const mask = cueMask(cues, ratio, 0, kind);
  const scoreAt = (o) => { let s = 0; for (const c of mask) s += at(c.end + o) - at(c.start + o); return s; };
  const steps = [];
  for (let o = around - 0.2; o <= around + 0.2 + 1e-9; o += 0.005) steps.push({ o, s: scoreAt(o) });
  const top = Math.max(...steps.map((x) => x.s));
  const span = Math.max(...steps.map((x) => Math.abs(x.s))) || 1;
  const near = steps.filter((x) => x.s >= top - span * 0.002);
  return (near[0].o + near[near.length - 1].o) / 2;
}

// c[k] = Σ a[t]·r[t+k] for |k| ≤ lagMax, via FFT.
function crossCorrelate(a, r, lagMax) {
  let n = 1;
  while (n < a.length + r.length) n <<= 1;
  const ar = new Float64Array(n); const ai = new Float64Array(n);
  const rr = new Float64Array(n); const ri = new Float64Array(n);
  ar.set(a); rr.set(r);
  fft(ar, ai, false);
  fft(rr, ri, false);
  for (let i = 0; i < n; i++) { // conj(A)·R
    const re = ar[i] * rr[i] + ai[i] * ri[i];
    const im = ar[i] * ri[i] - ai[i] * rr[i];
    ar[i] = re; ai[i] = im;
  }
  fft(ar, ai, true);
  const lo = -Math.min(lagMax, a.length - 1);
  const hi = Math.min(lagMax, r.length - 1);
  const values = new Float64Array(hi - lo + 1);
  for (let k = lo; k <= hi; k++) values[k - lo] = ar[(k + n) % n] / n;
  return { first: lo, values };
}

const twiddles = new Map();
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  let tw = twiddles.get(n);
  if (!tw) {
    tw = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let i = 0; i < n / 2; i++) { tw.cos[i] = Math.cos((2 * Math.PI * i) / n); tw.sin[i] = Math.sin((2 * Math.PI * i) / n); }
    twiddles.clear();
    twiddles.set(n, tw);
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = tw.cos[k * stride];
        const wi = sign * tw.sin[k * stride];
        const i = start + k;
        const j = i + half;
        const tr = re[j] * wr - im[j] * wi;
        const ti = re[j] * wi + im[j] * wr;
        re[j] = re[i] - tr; im[j] = im[i] - ti;
        re[i] += tr; im[i] += ti;
      }
    }
  }
}
