// Background converter. Creates MP4 copies of containers Apple devices can't play (MKV, AVI, WebM, ...).
// Streams are copied where possible; video is re-encoded (NVENC, falling back to x264) only when required.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const CONVERT_EXT = new Set(['.mkv', '.avi', '.webm', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg']);
const AUDIO_COPY = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);        // Apple devices play these in MP4
// Audio every browser decodes. Chrome and Firefox can't play AC3/E-AC3/DTS, so output files
// get a stereo AAC track first, with the original tracks kept after it.
export const BROWSER_AUDIO = new Set(['aac', 'mp3']);
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']); // image subs (PGS) can't go in MP4
const TMP_TAG = '.marquee-tmp';
// Downloaded MP4s are never modified (they may be seeding). If their audio isn't browser-compatible,
// a fixed copy is written to the cache directory and served to browsers only.
const FIX_EXT = new Set(['.mp4', '.m4v', '.mov']);
const INTERVAL_MS = 2 * 60 * 1000;

const status = {
  enabled: false,
  reason: 'Starting…',
  encoder: null,       // 'nvenc' | 'x264'
  current: null,       // { name, mode, percent, speed, eta }
  queued: 0,
  recentFailures: [],  // [{ name, error }]
  done: 0,
};

let stateFile = null;
let failures = {};     // key -> { error, at }
let audioChecked = {}; // file key -> true once its audio is known to be browser-compatible and in sync
let syncShift = {};    // source key -> manual audio correction in seconds (negative = earlier)
let syncApplied = {};  // source key -> correction baked into the current copy
const CHECK_VERSION = 'v2|'; // bump to re-check files after the audio checks change
const SYNC_TOLERANCE = 0.04; // seconds; below one video frame
let onConvertedHook = null;
let fixDir = null;     // cache directory for audio-fixed copies
let nvencBroken = false;
let running = false;
let currentFile = null;
const queue = [];

export const isTempFile = (name) => name.includes(TMP_TAG);

// ---------- subtitle tracks -> sidecar .srt files ----------
// Subtitles are saved beside the video as "<name>.<lang>.srt" (the format the subtitle menu
// and TVs already use) instead of being embedded: TVs such as Samsung's refuse MP4s with
// dozens of tracks as "unsupported", and releases often carry 30+ subtitle languages.
const ISO3 = {
  eng: 'en', swe: 'sv', dan: 'da', nor: 'no', nob: 'no', nno: 'no', fin: 'fi', ice: 'is', isl: 'is',
  ger: 'de', deu: 'de', dut: 'nl', nld: 'nl', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', pol: 'pl',
  cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', hun: 'hu', rum: 'ro', ron: 'ro', gre: 'el', ell: 'el',
  tur: 'tr', rus: 'ru', ukr: 'uk', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', est: 'et', lav: 'lv',
  lit: 'lt', ara: 'ar', heb: 'he', per: 'fa', fas: 'fa', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id',
  may: 'ms', msa: 'ms', jpn: 'ja', kor: 'ko',
};

function subLanguage(stream) {
  const tag = String(stream.tags?.language || '').toLowerCase();
  const title = String(stream.tags?.title || '');
  if (tag === 'por' || tag === 'pt') return /bra[sz]il|\bbr\b|pt-br/i.test(title) ? 'pt-br' : 'pt-pt';
  if (tag === 'chi' || tag === 'zho' || tag === 'zh') return /tradition|\btw\b|\bhk\b|cantonese/i.test(title) ? 'zh-tw' : 'zh-cn';
  return ISO3[tag] || (/^[a-z]{2}$/.test(tag) ? tag : null);
}

// Sidecar files to write for a source file; existing ones (e.g. downloaded earlier) are kept.
function plannedSidecars(file, subs) {
  const stem = path.join(path.dirname(file), path.basename(file, path.extname(file)));
  const isForced = (s) => s.disposition?.forced || /forced/i.test(s.tags?.title || '');
  const isSdh = (s) => s.disposition?.hearing_impaired || /\bsdh\b|hearing|\bcc\b/i.test(s.tags?.title || '');
  const used = new Set();
  const out = [];
  // Regular tracks first so they get the plain "<lang>.srt" name; forced-only tracks are skipped.
  const ordered = subs.filter((s) => !isForced(s)).sort((a, b) => isSdh(a) - isSdh(b));
  for (const s of ordered) {
    const lang = subLanguage(s);
    if (!lang) continue;
    let name = `${stem}.${lang}.srt`;
    if (used.has(name)) {
      const sdh = `${stem}.${lang}.sdh.srt`;
      if (isSdh(s) && !used.has(sdh)) name = sdh;
      else {
        let n = 2;
        while (used.has(`${stem}.${lang}.${n}.srt`)) n++;
        name = `${stem}.${lang}.${n}.srt`;
      }
    }
    used.add(name);
    if (fs.existsSync(name)) continue;
    out.push({ index: s.index, target: name, tmp: name.replace(/\.srt$/, `${TMP_TAG}.srt`) });
  }
  return out;
}
export const needsConversion = (file) => CONVERT_EXT.has(path.extname(file).toLowerCase());
export const twinPath = (file) => path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.mp4`);
// Source file an MP4 copy was converted from, if any.
export function originalFor(file) {
  if (needsConversion(file)) return file;
  const stem = path.join(path.dirname(file), path.basename(file, path.extname(file)));
  for (const ext of CONVERT_EXT) {
    for (const e of [ext, ext.toUpperCase()]) if (fs.existsSync(stem + e)) return stem + e;
  }
  return null;
}

// Cache path for a file's audio-fixed copy, keyed by path, size and mtime.
export function fixPath(file) {
  if (!fixDir) return null;
  try {
    const st = fs.statSync(file);
    const id = crypto.createHash('sha1').update(`${path.resolve(file).toLowerCase()}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 24);
    return path.join(fixDir, `${id}.mp4`);
  } catch { return null; }
}
const canFix = (file) => FIX_EXT.has(path.extname(file).toLowerCase()) && !isTempFile(file);

// Returns the best file to stream: the MP4 copy if one exists, and for browsers the audio-fixed copy.
// TVs receive the original so surround audio is preserved.
export function preferConverted(file, { browser = false } = {}) {
  if (needsConversion(file)) {
    const twin = twinPath(file);
    return fs.existsSync(twin) ? twin : file;
  }
  if (canFix(file) && (browser || syncShift[failureKey(file)])) { // TVs too when a manual correction exists
    const fixed = fixPath(file);
    if (fixed && fs.existsSync(fixed)) return fixed;
  }
  return file;
}

// Drops queued work and cached copies for a deleted file.
export function forget(file) {
  const i = queue.findIndex((q) => q.file === file);
  if (i >= 0) queue.splice(i, 1);
  const fixed = fixPath(file);
  if (fixed) fs.rmSync(fixed, { force: true });
}
export const isBusy = (file) => file === currentFile;

// Audio tracks of a file, default track first. Returns null when ffprobe is unavailable.
export const isAligned = (tracks) => !tracks?.length || Math.abs(tracks[0].offset || 0) <= SYNC_TOLERANCE;
const audioCache = new Map();
export async function probeAudio(file) {
  if (!status.enabled) return null;
  const key = failureKey(file);
  if (audioCache.has(key)) return audioCache.get(key);
  const info = await probe(file);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const videoStart = Number(video?.start_time) || 0;
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const main = audios.find((a) => a.disposition?.default) || audios[0];
  const out = main ? [main, ...audios.filter((a) => a !== main)].map((a) => ({
    codec: a.codec_name, channels: a.channels || null, language: a.tags?.language || null,
    offset: Math.round(((Number(a.start_time) || 0) - videoStart) * 1000) / 1000, // start relative to video
  })) : [];
  audioCache.set(key, out);
  return out;
}

// The job that rebuilds a file's browser copy: a redo for converted files, a fix copy for downloaded MP4s.
function browserJob(file) {
  const original = originalFor(file);
  if (original) return { file: original, deleteOriginal: false, redo: fs.existsSync(twinPath(original)) };
  if (canFix(file)) return { file, fix: true };
  return null;
}

function runFirst(job) {
  const failed = failures[failureKey(job.file)];
  if (failed) return { fixable: false, error: failed.error };
  if (job.file !== currentFile) {
    const i = queue.findIndex((q) => q.file === job.file);
    queue.unshift({ ...(i >= 0 ? queue.splice(i, 1)[0] : job), redo: job.redo, fix: job.fix, force: true });
    drain(onConvertedHook);
  }
  return job.file === currentFile
    ? { fixable: true, state: 'converting', percent: status.current?.percent ?? 0 }
    : { fixable: true, state: 'queued', percent: null };
}

// Moves a file whose audio won't play correctly in browsers to the front of the queue.
// Returns { fixable, state: 'converting' | 'queued', percent, error }.
export function requestBrowserAudio(file) {
  if (!status.enabled) return { fixable: false, error: status.reason };
  const job = browserJob(file);
  return job ? runFirst(job) : { fixable: false };
}

// Manual audio sync correction in seconds (negative moves audio earlier), rebuilt immediately.
export function setSync(file, shift) {
  if (!status.enabled) return { fixable: false, error: status.reason };
  const job = browserJob(file);
  if (!job) return { fixable: false, error: 'This file type can’t be corrected.' };
  syncShift[failureKey(job.file)] = Math.round(shift * 1000) / 1000;
  saveFailures();
  return runFirst(job);
}

// { shift, applied, state } for the file a library entry was made from.
export function syncState(file) {
  const job = browserJob(file);
  if (!job) return { shift: 0, applied: 0, state: null };
  const key = failureKey(job.file);
  return { shift: syncShift[key] || 0, applied: syncApplied[key] || 0, state: jobState(job.file) };
}

export const jobState = (file) => (file === currentFile ? 'converting' : queue.some((q) => q.file === file) ? 'queued' : null);

export function converterStatus() { return { ...status, queued: queue.length }; }

function run(cmd, args, { onStdout, priorityLow = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    if (priorityLow) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed */ }
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; onStdout?.(d.toString()); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(lastLine(err) || `exit code ${code}`))));
  });
}
// Picks the meaningful error line from ffmpeg's stderr (the last line is usually generic).
const lastLine = (s) => {
  const lines = s.trim().split(/\r?\n/).filter((l) => l && !/^Conversion failed/i.test(l));
  return lines.reverse().find((l) => /error|invalid|cannot|could not|not supported|no such|denied/i.test(l)) || lines[0] || '';
};

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(out);
}

// safeAudio: re-encode E-AC-3 instead of copying it. Some E-AC-3 tracks (notably Dolby Atmos,
// which carries a dependent substream) can't be written into MP4 by ffmpeg and make the
// muxer fail at the very end with "Error writing trailer: Invalid data found".
function plan(input, output, info, encoder, shift = 0, safeAudio = false, sidecars = []) {
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('No video stream found.');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name));
  const main = audios.find((a) => a.disposition?.default) || audios[0];

  // The first audio track is always a stereo AAC version of the default track with its timing baked in:
  // start offsets are padded or trimmed, gaps filled with silence and any manual correction applied.
  // This keeps playback in sync on players that ignore MP4 edit lists or play samples back to back.
  // The original track is kept after it unless it's already stereo AAC.
  const keepMain = main && (main.codec_name !== 'aac' || (main.channels || 2) > 2);

  // If audio starts before the video, shift everything so the video starts at zero.
  const starts = streams.map((s) => Number(s.start_time)).filter(Number.isFinite);
  const videoLead = starts.length ? (Number(video.start_time) || 0) - Math.min(...starts) : 0;

  const args = ['-hide_banner', '-nostdin', '-y'];
  if (main && videoLead > SYNC_TOLERANCE) args.push('-itsoffset', (-videoLead).toFixed(3));
  args.push('-i', input, '-map', `0:${video.index}`);
  if (main) args.push('-map', `0:${main.index}`);
  for (const a of audios) if (a !== main || keepMain) args.push('-map', `0:${a.index}`);

  let reencode = false;
  const tenBit = /10|12/.test(video.pix_fmt || '');
  if (video.codec_name === 'h264' && !tenBit) {
    args.push('-c:v', 'copy');
  } else if (video.codec_name === 'hevc') {
    args.push('-c:v', 'copy', '-tag:v', 'hvc1'); // hvc1 tag required by Apple players
  } else {
    reencode = true;
    args.push(...(encoder === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high');
  }

  let out = 0;
  if (main) {
    const move = shift ? `asetpts=PTS${shift > 0 ? '+' : '-'}${Math.abs(shift)}/TB,` : '';
    args.push('-c:a:0', 'aac', '-b:a:0', '192k', '-ac:a:0', '2',
      '-filter:a:0', `${move}aresample=async=1000:first_pts=0`,
      '-metadata:s:a:0', `language=${main.tags?.language || 'und'}`, '-metadata:s:a:0', 'title=Stereo');
    out = 1;
  }
  audios.forEach((a) => {
    if (a === main && !keepMain) return;
    const i = out++;
    if (safeAudio && a.codec_name === 'eac3') {
      // Plain Dolby Digital Plus keeps the surround channels; only the Atmos height data is lost.
      args.push(`-c:a:${i}`, 'eac3', `-b:a:${i}`, (a.channels || 2) > 2 ? '640k' : '224k');
    } else if (AUDIO_COPY.has(a.codec_name)) args.push(`-c:a:${i}`, 'copy');
    else args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, (a.channels || 2) > 2 ? '384k' : '192k');
  });
  // Only the first audio track is marked default.
  for (let i = 0; i < out; i++) args.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');

  args.push('-avoid_negative_ts', 'disabled', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', output);
  for (const sc of sidecars) args.push('-map', `0:${sc.index}`, '-c:s', 'srt', '-f', 'srt', sc.tmp);
  return { args, reencode, duration: Number(info.format?.duration) || Number(video.duration) || null };
}

async function convert(job) {
  const { file } = job;
  const name = path.basename(file);
  const output = job.fix ? fixPath(file) : twinPath(file);
  if (!output) throw new Error('No place to save the fixed copy.');
  if (job.fix) fs.mkdirSync(path.dirname(output), { recursive: true });
  const tmp = job.fix
    ? output.replace(/\.mp4$/, `${TMP_TAG}.mp4`)
    : path.join(path.dirname(file), `${path.basename(file, path.extname(file))}${TMP_TAG}.mp4`);
  fs.rmSync(tmp, { force: true });

  const info = await probe(file);
  const key = failureKey(file);
  const shift = syncShift[key] || 0;
  let safeAudio = false;
  const sidecars = plannedSidecars(file, (info.streams || []).filter((st) => st.codec_type === 'subtitle' && TEXT_SUBS.has(st.codec_name)));
  const dropSidecarTemps = () => sidecars.forEach((sc) => fs.rmSync(sc.tmp, { force: true }));
  const attempt = async (encoder) => {
    const p = plan(file, tmp, info, encoder, shift, safeAudio, sidecars);
    const started = Date.now();
    status.current = { name, mode: p.reencode ? 'Re-encoding' : job.fix ? 'Fixing audio' : 'Repackaging', percent: 0, speed: null, eta: null };
    let buf = '';
    await run(FFMPEG, p.args, {
      priorityLow: true,
      onStdout: (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const [k, v] = line.split('=');
          if (k === 'out_time_us' && p.duration) {
            const done = Number(v) / 1e6;
            const percent = Math.min(99.9, (done / p.duration) * 100);
            const elapsed = (Date.now() - started) / 1000;
            status.current.percent = Math.round(percent * 10) / 10;
            status.current.eta = percent > 1 ? Math.round((elapsed / percent) * (100 - percent)) : null;
          } else if (k === 'speed') {
            status.current.speed = v.trim();
          }
        }
      },
    });
    return p;
  };

  let encoder = nvencBroken ? 'x264' : 'nvenc';
  const needsEncode = plan(file, tmp, info, encoder).reencode;
  try {
    try {
      await attempt(encoder);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      // NVENC unavailable: fall back to x264 for this and all later jobs.
      if (encoder === 'nvenc' && needsEncode) {
        console.warn(`[convert] GPU encoding failed (${e.message}); using the CPU instead.`);
        nvencBroken = true;
        encoder = 'x264';
        status.encoder = 'x264';
        await attempt(encoder);
      } else if (/trailer|invalid data/i.test(e.message)
        && (info.streams || []).some((st) => st.codec_type === 'audio' && st.codec_name === 'eac3')) {
        console.warn(`[convert] ${name}: E-AC-3 audio couldn't be copied (${e.message}); re-encoding it instead.`);
        safeAudio = true;
        await attempt(encoder);
      } else {
        throw e;
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    dropSidecarTemps();
    throw e;
  }
  for (const sc of sidecars) {
    try {
      if (fs.existsSync(sc.target) || !fs.statSync(sc.tmp).size) fs.rmSync(sc.tmp, { force: true });
      else fs.renameSync(sc.tmp, sc.target);
    } catch { fs.rmSync(sc.tmp, { force: true }); }
  }
  try {
    fs.renameSync(tmp, output); // overwrites the previous copy on redo
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    // Previous copy is in use; retry on the next scan instead of recording a failure.
    if (job.redo && /EBUSY|EPERM|EACCES/.test(e.code || '')) { e.retryLater = true; }
    throw e;
  }
  audioCache.clear();
  delete failures[key]; // an earlier failure no longer applies
  syncApplied[key] = shift;
  saveFailures();
  if (job.deleteOriginal && !job.fix) fs.rmSync(file, { force: true });
}

const failureKey = (file) => {
  try { const s = fs.statSync(file); return `${file}|${s.size}|${Math.floor(s.mtimeMs)}`; } catch { return file; }
};

function saveFailures() {
  try { fs.writeFileSync(stateFile, JSON.stringify({ failures, audioChecked, syncShift, syncApplied }, null, 2)); } catch { /* best effort */ }
}

// Removes cached copies whose source file no longer exists or has changed.
function cleanFixDir(keep) {
  let entries = [];
  try { entries = fs.readdirSync(fixDir); } catch { return; }
  for (const e of entries) {
    if (keep.has(e)) continue;
    const full = path.join(fixDir, e);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs < 60 * 60 * 1000) continue; // skip recent files
      fs.rmSync(full, { force: true });
    } catch { /* gone already */ }
  }
}
// True if the default audio track isn't browser-compatible or doesn't start with the video.
// Cached per file version.
async function audioNeedsFix(file) {
  const key = CHECK_VERSION + failureKey(file);
  if (audioChecked[key]) return false;
  let audio;
  try { audio = await probeAudio(file); } catch { return false; }
  if (!audio?.length || (BROWSER_AUDIO.has(audio[0].codec) && isAligned(audio))) {
    audioChecked[key] = true;
    saveFailures();
    return false;
  }
  return true;
}

async function drain(onConverted) {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    if (!fs.existsSync(job.file)) continue;
    if (!job.force && (job.fix ? fs.existsSync(fixPath(job.file) || '') : (!job.redo && fs.existsSync(twinPath(job.file))))) continue;
    currentFile = job.file;
    try {
      await convert(job);
      status.done += 1;
      console.log(`[convert] done: ${path.basename(job.file)}`);
      onConverted?.();
    } catch (e) {
      if (e.retryLater) { console.warn(`[convert] ${path.basename(job.file)}: copy is in use, will retry.`); continue; }
      const msg = e.message || String(e);
      console.warn(`[convert] failed: ${path.basename(job.file)}: ${msg}`);
      failures[failureKey(job.file)] = { error: msg, at: Date.now() };
      saveFailures();
      status.recentFailures = [{ name: path.basename(job.file), error: msg }, ...status.recentFailures].slice(0, 5);
    } finally {
      status.current = null;
      currentFile = null;
    }
  }
  running = false;
}

// listCandidates(): Promise<[{ file, deleteOriginal }]>
export async function startConverter({ dataDir, listCandidates, onConverted }) {
  if ((process.env.CONVERT || 'on').toLowerCase() === 'off') {
    status.reason = 'Turned off (CONVERT=off in .env).';
    return;
  }
  try {
    await run(FFPROBE, ['-version']);
    const encoders = await run(FFMPEG, ['-hide_banner', '-encoders']);
    status.encoder = encoders.includes('h264_nvenc') ? 'nvenc' : 'x264';
    nvencBroken = status.encoder !== 'nvenc';
  } catch {
    status.reason = 'Needs ffmpeg. Install it with: winget install Gyan.FFmpeg — then restart.';
    return;
  }
  stateFile = path.join(dataDir, '.marquee-convert.json');
  fixDir = process.env.AUDIO_FIX_DIR ? path.resolve(process.env.AUDIO_FIX_DIR) : path.join(dataDir, 'cache', 'audio');
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (saved.failures) {
      failures = saved.failures;
      audioChecked = Object.fromEntries(Object.entries(saved.audioChecked || {}).filter(([k]) => k.startsWith(CHECK_VERSION)));
      syncShift = saved.syncShift || {};
      syncApplied = saved.syncApplied || {};
    } else failures = saved;
  } catch { failures = {}; }
  onConvertedHook = onConverted;
  status.enabled = true;
  status.reason = null;

  const tick = async () => {
    try {
      const candidates = await listCandidates();
      for (const c of candidates) {
        if (!needsConversion(c.file) || isTempFile(c.file)) continue;
        if (failures[failureKey(c.file)]) continue; // failed before; retried only if the file changes
        if (c.file === currentFile || queue.some((q) => q.file === c.file)) continue;
        if (fs.existsSync(twinPath(c.file))) {
          if (await audioNeedsFix(twinPath(c.file))) queue.push({ ...c, deleteOriginal: false, redo: true });
          continue;
        }
        queue.push(c);
      }
      // Downloaded MP4s with browser-incompatible audio.
      const keep = new Set();
      for (const c of candidates) {
        if (!canFix(c.file) || originalFor(c.file)) continue;
        const fixed = fixPath(c.file);
        if (!fixed) continue;
        keep.add(path.basename(fixed));
        if (fs.existsSync(fixed) || failures[failureKey(c.file)]) continue;
        if (c.file === currentFile || queue.some((q) => q.file === c.file)) continue;
        if (await audioNeedsFix(c.file)) queue.push({ file: c.file, fix: true });
      }
      cleanFixDir(keep);
      drain(onConverted);
    } catch (e) {
      console.warn(`[convert] scan failed: ${e.message}`);
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, INTERVAL_MS);
}