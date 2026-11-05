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
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { trackChild } from './load.js';
import { background } from './priority.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const AUTO = (process.env.SUBSYNC || 'on').toLowerCase() !== 'off';

const BIN = 0.04;            // coarse search resolution, seconds
const FINE = 0.01;           // reference resolution for the final refinement
const MAX_SHIFT = 600;       // largest correction considered, seconds
const MIN_CUES = 40;         // fewer cues than this can't be aligned reliably
const RATIOS = [1, 25 / (24000 / 1001), (24000 / 1001) / 25, 24 / (24000 / 1001), (24000 / 1001) / 24, 25 / 24, 24 / 25];
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const ENGINE_VERSION = 3; // Parts for differently cut releases, a learned speech detector, hash matches checked too.

let registryFile = null;
let backupDir = null;
let registry = {};           // srt path -> entry (see stateOf)
let manualShift = () => 0;   // audio correction the viewer applied to a video, seconds
let ffmpegOk = null;

const keyOf = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const save = () => { try { fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2)); } catch { /* best effort */ } };
const stamp = (p) => { try { const s = fs.statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return null; } };

export const autoSyncEnabled = () => AUTO;

// Existing downloads deserve the improved timing check too, without overriding a manual choice.
export function ensureSync(srt, video) {
  const e = entryFor(srt);
  if (AUTO && !e?.trusted && e?.state !== 'undone' && !e?.manual && e?.version !== ENGINE_VERSION) return queueSync(srt, video);
  return stateOf(srt);
}

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
    parts: e?.sections?.length || 1,
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
  const parts = auto?.sections?.map((x) => ({ from: x.from, offset: x.offset + manual })) || null;
  fs.writeFileSync(tmp, retime(original, auto ? auto.ratio : 1, (auto ? auto.offset : 0) + manual, parts), 'utf8');
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
  queue.push({ srt, video, fromBackup, prior: fromBackup ? { offset: e.offset, ratio: e.ratio, sections: e.sections || null, reference: e.reference, manual: e.manual || 0 } : null });
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
        registry[k] = { path: srt, ...result, version: ENGINE_VERSION, stamp: stamp(srt), at: Date.now() };
        const what = result.state === 'synced' ? `shifted ${fmt(result.offset)}${result.ratio !== 1 ? `, rate ×${result.ratio.toFixed(4)}` : ''}`
          : result.state === 'ok' ? 'already in sync' : 'no confident match, left unchanged';
        console.log(`[subsync] ${path.basename(srt)}: ${what} (reference: ${result.reference || 'none'})`);
      } catch (err) {
        registry[k] = { path: srt, video, state: 'failed', version: ENGINE_VERSION, error: err.message, stamp: stamp(srt), at: Date.now() };
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
  // 1-3. Subtitle references.
  for (const ref of await subtitleReferences(srt, video, lang)) {
    const refCues = await ref.load().catch(() => null);
    if (!refCues || refCues.length < MIN_CUES) continue;
    const result = solve(cues, cueTrack(refCues), { kind: 'subtitles' });
    attempts.push({ ...result, reference: ref.label });
    if (result.confident) break;
  }
  // 4. Audio.
  if (!attempts.some((a) => a.confident)) {
    const voice = await voiceTrack(video);
    if (voice) {
      const result = solve(cues, voice, { kind: 'audio' });
      attempts.push({ ...result, reference: 'audio' });
    }
  }
  const best = attempts.find((a) => a.confident);
  if (!best) {
    if (fromBackup) return { state: 'synced', ...prior }; // keep the earlier fix
    return { state: 'unsure', reference: attempts.map((a) => a.reference).join(', ') || null };
  }

  const tolerance = best.kind === 'audio' ? 0.25 : 0.12;
  if (best.ratio === 1 && best.sections.length === 1 && Math.abs(best.offset) < tolerance) {
    if (fromBackup) await fs.promises.copyFile(backup, srt); // the earlier fix wasn't needed after all
    return { state: 'ok', offset: 0, ratio: 1, reference: best.reference };
  }

  fs.mkdirSync(backupDir, { recursive: true });
  if (!fromBackup) await fs.promises.writeFile(backup, text, 'utf8');
  const tmp = `${srt}.subsync-tmp`;
  const sections = best.sections.length > 1 ? best.sections.map((x) => ({ from: round(x.from), offset: round(x.offset) })) : null;
  await fs.promises.writeFile(tmp, retime(text, best.ratio, best.offset, sections), 'utf8');
  await fs.promises.rename(tmp, srt);
  return { state: 'synced', offset: round(best.offset), ratio: best.ratio, sections, reference: best.reference, confidence: round(best.z) };
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

// Rewrites every timestamp as t × ratio + offset, leaving everything else untouched. With `sections`
// ([{ from, offset }] in original subtitle time), each line moves by the shift of the part it starts in.
export function retime(text, ratio, offset, sections = null) {
  return text.replace(/^(\s*)(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(.*)$/gm, (_, lead, a, arrow, b, rest) => {
    const start = secs(TIME.exec(a));
    const o = sections?.length ? shiftAt(sections, start) : offset;
    return `${lead}${stampOf(start * ratio + o)}${arrow}${stampOf(secs(TIME.exec(b)) * ratio + o)}${rest}`;
  });
}

// ---------- references ----------
function run(cmd, args, { maxBytes = 64 * 1024 * 1024, timeoutMs = 10 * 60 * 1000, onData } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    background(child);
    trackChild(child, cmd, args, 'subsync');
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
    const subs = (info?.streams || []).filter((s) => s.codec_type === 'subtitle' && (TEXT_SUBS.has(s.codec_name) || BITMAP_SUBS.has(s.codec_name))
      && !s.disposition?.forced && !/forced/i.test(s.tags?.title || ''));
    // Same language first, then English, then the rest; full subtitles before SDH.
    const rank = (s) => (sameLang(s.tags?.language, lang) ? 0 : sameLang(s.tags?.language, 'en') ? 1 : 2) * 2
      + (s.disposition?.hearing_impaired || /sdh|hearing/i.test(s.tags?.title || '') ? 1 : 0);
    for (const s of subs.sort((a, b) => rank(a) - rank(b)).slice(0, 2)) {
      refs.push({
        label: `embedded ${s.tags?.language || ''}${BITMAP_SUBS.has(s.codec_name) ? ' bitmap' : ''} track`.replace(/\s+/g, ' '),
        load: async () => {
          if (TEXT_SUBS.has(s.codec_name)) return parseCues(decode(await run(FFMPEG, ['-v', 'error', '-i', file, '-map', `0:${s.index}`, '-f', 'srt', 'pipe:1'])));
          // PGS/DVD captions are pictures, but their display/clear times are still exact references.
          // Read just those times: no OCR, additional subtitle download or video re-encode is needed.
          const data = JSON.parse((await run(FFPROBE, ['-v', 'error', '-select_streams', String(s.index), '-show_frames',
            '-show_entries', 'subtitle=pts_time,start_display_time,end_display_time,num_rects', '-of', 'json', file],
          { maxBytes: 8 * 1024 * 1024, timeoutMs: 120000 })).toString());
          const picture = info.streams.find((v) => v.codec_type === 'video' && !v.disposition?.attached_pic);
          return bitmapCues(data.frames || [], Number(picture?.start_time) || 0);
        },
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
  // 3. Subtitles that came with the release (Subs/<video name>/*.srt, or Subs/*.srt next to a single film).
  for (const file of releaseSubtitles(video, entries).slice(0, 3)) {
    if (keyOf(file) === keyOf(srt)) continue;
    refs.push({ label: 'release subtitles', load: async () => parseCues(decode(await fs.promises.readFile(file))) });
  }
  return refs;
}

function releaseSubtitles(video, siblings) {
  const dir = path.dirname(video);
  const stem = path.basename(video, path.extname(video)).toLowerCase();
  const subs = siblings.find((e) => e.toLowerCase() === 'subs');
  if (!subs) return [];
  const list = (d) => { try { return fs.readdirSync(d).filter((e) => /\.srt$/i.test(e) && !/forced/i.test(e)).map((e) => path.join(d, e)); } catch { return []; } };
  let own = null;
  try { own = fs.readdirSync(path.join(dir, subs)).find((e) => e.toLowerCase() === stem); } catch { /* not a folder */ }
  let files = own ? list(path.join(dir, subs, own)) : [];
  if (!files.length) {
    const loose = list(path.join(dir, subs));
    const videos = siblings.filter((e) => VIDEO_FILE.test(e)).length;
    files = loose.filter((f) => path.basename(f).toLowerCase().startsWith(stem) || videos === 1);
  }
  // English first, then the longest (full subtitles rather than signs-only tracks).
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  return files.sort((a, b) => /eng/i.test(path.basename(b)) - /eng/i.test(path.basename(a)) || size(b) - size(a));
}
const VIDEO_FILE = /\.(mp4|m4v|mkv|mov|webm|avi)$/i;

// Bitmap decoders often report an indefinite end (UINT32_MAX); the next clear/display ends it.
export function bitmapCues(frames, videoStart = 0) {
  const cues = [];
  let pending = null;
  for (const frame of frames) {
    const pts = Number(frame.pts_time);
    if (!Number.isFinite(pts)) continue;
    const start = pts + (Number(frame.start_display_time) || 0) / 1000 - videoStart;
    if (pending) {
      const end = Math.min(start, pending.end);
      if (end > Math.max(0, pending.start) && end - pending.start < 60) cues.push({ start: Math.max(0, pending.start), end });
      pending = null;
    }
    if (Number(frame.num_rects) > 0) {
      const duration = Number(frame.end_display_time);
      pending = { start, end: Number.isFinite(duration) && duration < 3600000 ? pts + duration / 1000 - videoStart : Infinity };
    }
  }
  if (pending && Number.isFinite(pending.end) && pending.end > Math.max(0, pending.start) && pending.end - pending.start < 60) cues.push({ start: Math.max(0, pending.start), end: pending.end });
  return cues;
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

// ---------- speech detection ----------
// Speech-likeness per 10 ms from the main audio track. Every 10 ms, 32 ms of 8 kHz audio is measured:
// loudness inside the voice band (300–3400 Hz) and outside it, how noise-like the voice band is, and how
// strongly the sound repeats at a voice pitch (80–400 Hz). Around each moment these become 18 features,
// such as local loudness and how much it flickers at syllable rate (speech rises and falls 3–8 times a
// second, music and noise much less), and pitch strength and how fast it changes. Each feature is
// standardised within the film, so loud and quiet mixes count the same, and the weights were fitted
// (logistic regression) to when subtitles are on screen in English and Japanese films and series.
const VOICE_WEIGHTS = [0.041, 0.2061, -0.1156, 0.1071, 0.1554, 0.3547, -0.2293, -0.0965, 0.1096, -0.0631, 0.2118, 0.2982,
  0.3047, 0.3715, 0.2236, 0.4112, 0.0998, -0.1165];
const VOICE_BIAS = 0.2734;
const RATE = 8000;
const WIN = 256;             // 32 ms
const HOP = RATE * FINE;     // 10 ms

// Centred moving average over ±w samples (shorter at the edges).
function smooth(x, w) {
  const n = x.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - w); const b = Math.min(n, i + w + 1); out[i] = (pre[b] - pre[a]) / (b - a); }
  return out;
}
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
// log10, scaled so the film's 10th–90th percentile spans 0–1.
function level(x) {
  const out = Float64Array.from(x, (v) => Math.log10(v + 1e-9));
  const sorted = Float64Array.from(out).sort();
  const lo = percentile(sorted, 0.1);
  const span = Math.max(1e-3, percentile(sorted, 0.9) - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / span;
  return out;
}
const map2 = (a, b, f) => Float64Array.from(a, (v, i) => f(v, b[i]));
const rms = (a, b, w) => smooth(map2(a, b, (x, y) => (x - y) ** 2), w).map(Math.sqrt);

// Per-frame measurements → speech-likeness per 10 ms.
export function speechScore({ es, el, eh, flat, harm }) {
  const le = level(es);
  const ll = level(el);
  const lh = level(eh);
  const ratio = Float64Array.from(es, (v, i) => Math.log10(v + 1e-9) - Math.log10(v + el[i] + eh[i] + 1e-9));
  const s5 = smooth(le, 5);
  const s12 = smooth(le, 12);
  const mod = rms(s5, smooth(le, 25), 50);
  const h10 = smooth(harm, 10);
  const le15 = smooth(le, 15);
  const step = Float64Array.from(le, (v, i) => (i ? Math.abs(v - le[i - 1]) : 0));
  const features = [
    le, le15, map2(le, smooth(le, 150), (a, b) => a - b), smooth(ratio, 10), ll, lh, smooth(flat, 10), h10, smooth(harm, 30), mod,
    smooth(step, 10), map2(le15, h10, (a, b) => a * b), rms(smooth(le, 3), s12, 30), rms(s12, smooth(le, 60), 80),
    rms(smooth(harm, 3), smooth(harm, 15), 40), smooth(mod, 50), map2(mod, h10, (a, b) => a * b), map2(le15, smooth(ll, 15), (a, b) => a - b),
  ];
  const n = le.length;
  const logit = new Float64Array(n).fill(VOICE_BIAS);
  features.forEach((f, j) => {
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) { s += f[i]; s2 += f[i] * f[i]; }
    const mean = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean)) + 1e-6;
    const w = VOICE_WEIGHTS[j] / sd;
    for (let i = 0; i < n; i++) logit[i] += (f[i] - mean) * w;
  });
  // Probability, less its average over the surrounding ±1.5 s: the moments speech starts and stops
  // are what pins the timing down, so slow swings between talky and quiet scenes are taken out.
  const p = Float64Array.from(logit, (x) => 1 / (1 + Math.exp(-x)));
  const around = smooth(p, 150);
  return Float32Array.from(p, (v, i) => v - around[i]);
}

// Streams 8 kHz mono PCM into per-frame measurements.
function frameMeter() {
  const ring = new Float32Array(WIN);
  const hann = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const power = new Float64Array(WIN / 2 + 1);
  const out = { es: [], el: [], eh: [], flat: [], harm: [] };
  let pos = 0;
  let since = 0;
  const measure = () => {
    for (let i = 0; i < WIN; i++) { re[i] = ring[(pos + i) % WIN] * hann[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k <= WIN / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    let es = 0;
    let el = 0;
    let eh = 0;
    let logs = 0;
    for (let k = 1; k < 10; k++) el += power[k];                                     // below 300 Hz
    for (let k = 10; k <= 108; k++) { es += power[k]; logs += Math.log(power[k] + 1e-12); } // voice band
    for (let k = 109; k <= WIN / 2; k++) eh += power[k];                              // above 3400 Hz
    // Autocorrelation of the voice band (inverse transform of its power), strongest at 80–400 Hz pitch.
    for (let k = 0; k < WIN; k++) { const b = k <= WIN / 2 ? k : WIN - k; re[k] = b >= 3 && b <= 108 ? power[b] : 0; im[k] = 0; }
    fft(re, im, true);
    let pitch = 0;
    for (let l = 20; l <= 100; l++) if (re[l] > pitch) pitch = re[l];
    out.es.push(es); out.el.push(el); out.eh.push(eh);
    out.flat.push(Math.exp(logs / 99) / (es / 99 + 1e-12));
    out.harm.push(re[0] > 0 ? pitch / re[0] : 0);
  };
  return {
    push(sample) {
      ring[pos] = sample;
      pos = (pos + 1) % WIN;
      if (++since === HOP) { since = 0; measure(); }
    },
    // Frame i ends at sample (i + 1)·HOP; its centre is half a window earlier.
    done() {
      const lead = Math.round((WIN / 2 - HOP) / HOP);
      const pad = (a) => Float64Array.from([...new Array(lead).fill(a[0] ?? 0), ...a]);
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, pad(v)]));
    },
  };
}

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
  // Dialogue sits in the centre channel of surround mixes.
  const center = /5\.1|7\.1/.test(main.channel_layout || '') ? 'pan=mono|c0=FC,' : '';
  const meter = frameMeter();
  let carry = null;
  await run(FFMPEG, ['-v', 'error', '-i', video, '-map', `0:${main.index}`, '-vn', '-sn', '-dn',
    '-af', `${center}aresample=${RATE}`, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {
    timeoutMs: 20 * 60 * 1000,
    onData: (d) => {
      if (carry) { d = Buffer.concat([carry, d]); carry = null; }
      const usable = d.length & ~1;
      for (let i = 0; i < usable; i += 2) meter.push(d.readInt16LE(i) / 32768);
      if (usable < d.length) carry = d.subarray(usable);
    },
  });
  const measured = meter.done();
  if (measured.es.length < 6000) return null; // under a minute of audio
  const voice = speechScore(measured);
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

// Peak of the cross-correlation of a cue mask with the coarse reference, and how far it stands
// above every other alignment in range (z: in standard deviations; distinct: against the runner-up
// more than 3 s away).
function correlation(mask, r, lagMax = Math.round(MAX_SHIFT / BIN)) {
  const len = Math.ceil((mask[mask.length - 1].end + 1) / BIN);
  const a = new Float64Array(len);
  for (const c of mask) fillRange(a, c.start / BIN, c.end / BIN, 1);
  let mean = 0;
  for (let i = 0; i < len; i++) mean += a[i];
  mean /= len;
  let norm = 0;
  for (let i = 0; i < len; i++) { a[i] -= mean; norm += a[i] * a[i]; }
  const corr = crossCorrelate(a, r, lagMax);
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
  return {
    offset: (best + corr.first) * BIN, score: peak / Math.sqrt(norm),
    z: (peak - m) / sd, distinct: (peak - m) / Math.max(1e-12, second - m),
  };
}

const zFloor = (kind) => (kind === 'audio' ? 8 : 10);

// Best single { ratio, offset } mapping subtitle time t to t × ratio + offset, and whether it's trustworthy.
export function align(cues, ref, { kind = 'subtitles', ratios = RATIOS } = {}) {
  const r = coarse(ref);
  const results = ratios.map((ratio) => ({ ratio, ...correlation(cueMask(cues, ratio, 0, kind), r) }));
  // A frame-rate change has to be clearly better than none.
  results.sort((x, y) => y.score - x.score);
  const plain = results.find((x) => x.ratio === 1);
  let pick = results[0];
  if (pick.ratio !== 1 && pick.score < plain.score * 1.15) pick = plain;
  const offset = refine(cues, ref, pick.ratio, pick.offset, kind);
  const confident = pick.z >= zFloor(kind) && pick.distinct >= 1.2;
  return { kind, ratio: pick.ratio, offset, z: pick.z, distinct: pick.distinct, confident, sections: [{ from: 0, offset }], ranked: results };
}

// ---------- sections ----------
// A subtitle made for another cut of the same film (an extra or missing scene, a recap, a longer
// intro, ad breaks, a different studio logo) is right in parts, and each part needs its own shift.
// Every line picks a shift from a grid around the overall match; consecutive lines keep the same one
// unless changing it gains more than SPLIT_COST well-placed lines' worth of overlap. The best choice
// for all lines together is found exactly by dynamic programming (a Viterbi path). Lines also stay in
// their original order. Each part must then stand out on its own, or it is merged into a neighbour.
const STEP = 0.1;            // grid, seconds
const RANGE = 300;           // shifts considered around the overall match, ± seconds
const SPLIT_COST = 10;       // gain a split must bring, in typical well-placed lines
const MIN_LINES = 8;         // shortest part
const PART_Z = 4;              // how clearly a part's own shift must stand out

function integral(ref) {
  const v = ref.values;
  const pre = new Float64Array(v.length + 1);
  for (let i = 0; i < v.length; i++) pre[i + 1] = pre[i] + v[i];
  return (t) => {
    const x = t / ref.step;
    if (x <= 0) return 0;
    if (x >= v.length) return pre[v.length];
    const i = Math.floor(x);
    return pre[i] + (pre[i + 1] - pre[i]) * (x - i);
  };
}

// Splits `cues` (already scaled by `ratio`) into parts with their own shift.
// Returns { value, parts: [{ first, last, offset }] } over cue indices.
export function sectionPath(mask, at, center, { stepCost } = {}) {
  const N = mask.length;
  const K = Math.round((2 * RANGE) / STEP) + 1;
  const lo = center - RANGE;
  const score = (i, k) => at(mask[i].end + lo + k * STEP) - at(mask[i].start + lo + k * STEP);
  // Typical gain of a well-placed line.
  const kc = Math.round(RANGE / STEP);
  const gains = [];
  for (let i = 0; i < N; i++) { const g = score(i, kc); if (g > 0) gains.push(g); }
  gains.sort((a, b) => a - b);
  const typical = gains.length ? gains[gains.length >> 1] : 1;
  const P = (stepCost ?? SPLIT_COST) * typical;

  let prev = new Float64Array(K);
  let cur = new Float64Array(K);
  const back = new Int16Array(N * K);
  const pm = new Float64Array(K);
  const pa = new Int32Array(K);
  for (let k = 0; k < K; k++) prev[k] = score(0, k);
  for (let i = 1; i < N; i++) {
    let m = -Infinity;
    let a = 0;
    for (let k = 0; k < K; k++) { if (prev[k] > m) { m = prev[k]; a = k; } pm[k] = m; pa[k] = a; }
    // A later part may start earlier by at most the gap to the previous line (order is kept).
    const g = Math.max(0, Math.floor((mask[i].start - mask[i - 1].start) / STEP));
    const row = i * K;
    for (let k = 0; k < K; k++) {
      const j = Math.min(K - 1, k + g);
      const stay = prev[k];
      const jump = pm[j] - P;
      if (stay >= jump) { cur[k] = stay + score(i, k); back[row + k] = k; } else { cur[k] = jump + score(i, k); back[row + k] = pa[j]; }
    }
    [prev, cur] = [cur, prev];
  }
  let k = 0;
  for (let j = 1; j < K; j++) if (prev[j] > prev[k]) k = j;
  const path = new Int32Array(N);
  for (let i = N - 1; i >= 0; i--) { path[i] = k; if (i) k = back[i * K + k]; }

  let parts = [];
  for (let i = 0; i < N; i++) {
    if (!parts.length || parts[parts.length - 1].k !== path[i]) parts.push({ first: i, last: i, k: path[i] });
    else parts[parts.length - 1].last = i;
  }
  const total = (p, kk) => { let s = 0; for (let i = p.first; i <= p.last; i++) s += score(i, kk); return s; };
  // How clearly a part's shift stands out among all shifts in range.
  const standout = (p) => {
    const curve = new Float64Array(K);
    for (let kk = 0; kk < K; kk++) curve[kk] = total(p, kk);
    let s = 0;
    let s2 = 0;
    for (const x of curve) { s += x; s2 += x * x; }
    const mean = s / K;
    const sd = Math.sqrt(Math.max(1e-12, s2 / K - mean * mean));
    return (curve[p.k] - mean) / sd;
  };
  // Merge the weakest part into the neighbour that suits its lines best, until every part holds up.
  for (;;) {
    if (parts.length < 2) break;
    let weakest = -1;
    let worst = Infinity;
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      const lines = p.last - p.first + 1;
      const z = lines < MIN_LINES ? -Infinity : standout(p);
      if (z < PART_Z && z < worst) { worst = z; weakest = j; }
    }
    if (weakest < 0) break;
    const p = parts[weakest];
    const left = parts[weakest - 1];
    const right = parts[weakest + 1];
    const into = !right || (left && total(p, left.k) >= total(p, right.k)) ? left : right;
    if (into === left) left.last = p.last; else right.first = p.first;
    parts.splice(weakest, 1);
    // Neighbours that now share a shift become one part.
    parts = parts.reduce((out, q) => {
      const tail = out[out.length - 1];
      if (tail && tail.k === q.k) tail.last = q.last; else out.push(q);
      return out;
    }, []);
  }
  // What the result is worth: overlap of every line, less the cost of each split.
  const value = parts.reduce((sum, p) => sum + total(p, p.k), 0) - P * (parts.length - 1);
  return { value, parts: parts.map((p) => ({ first: p.first, last: p.last, offset: lo + p.k * STEP })) };
}

// Shift of the part a line starting at subtitle time t belongs to.
export function shiftAt(sections, t) {
  let o = sections[0].offset;
  for (const s of sections) if (t >= s.from - 1e-6) o = s.offset; else break;
  return o;
}

// Full alignment: overall match, then parts, then 5 ms refinement of each part.
// Returns { kind, ratio, offset (largest part), sections: [{ from, offset }], z, distinct, confident }.
export function solve(cues, ref, { kind = 'subtitles' } = {}) {
  const base = align(cues, ref, { kind });
  const at = integral(ref);
  const r = coarse(ref);
  const tryRatio = (ratio, center) => {
    const mask = cueMask(cues, ratio, 0, kind);
    const { parts, value } = sectionPath(mask, at, center);
    const sections = parts.map((p) => {
      const sub = cues.slice(p.first, p.last + 1);
      return { from: cues[p.first].start, offset: refine(sub, ref, ratio, p.offset, kind), lines: p.last - p.first + 1 };
    });
    // The whole result, judged like a single shift: the re-timed lines against every other alignment.
    const placed = mask.map((c, i) => { const o = shiftAt(sections, cues[i].start); return { start: c.start + o, end: c.end + o }; });
    const check = correlation(placed, r);
    const main = sections.reduce((a, b) => (b.lines > a.lines ? b : a));
    return {
      kind, ratio, offset: main.offset, sections: sections.map(({ from, offset }) => ({ from, offset })),
      z: check.z, distinct: check.distinct, score: check.score, value,
      confident: Math.abs(check.offset) < 0.5 && check.z >= zFloor(kind) && check.distinct >= 1.2,
    };
  };
  // The likeliest frame rates are each tried with parts; a slow drift must not pass for a staircase of splits.
  const tried = new Set();
  const options = [];
  for (const c of [{ ratio: base.ratio, offset: base.offset }, ...base.ranked.slice(0, 3), base.ranked.find((x) => x.ratio === 1)]) {
    if (tried.has(c.ratio)) continue;
    tried.add(c.ratio);
    options.push(tryRatio(c.ratio, c.offset));
  }
  // Frame rates compete on the same measure: overlap of every line, less the cost of each split.
  const best = options.filter((o) => o.confident).sort((a, b) => b.value - a.value)[0];
  if (best) return best;
  return { ...base, confident: false };
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
