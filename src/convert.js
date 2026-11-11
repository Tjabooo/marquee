// Background converter. Creates MP4 copies of containers Apple devices can't play (MKV, AVI, WebM, ...).
// Streams are copied where possible; video is re-encoded (NVENC, falling back to x264) only when required.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { trackChild } from './load.js';
import { background } from './priority.js';
import { GB, freeBytes, pickEvictions, sameDrive } from './disk-space.js';

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
// HEVC files added within this many days get their H.264 browser copy in the background, right after
// they download, instead of when someone presses Play in a browser without HEVC. 0 turns it off.
const BROWSER_H264_DAYS = Number(process.env.BROWSER_H264_DAYS ?? 14);
// Browser copies are a cache: BROWSER_COPIES_MAX_GB caps their folder (0 = no cap) and MIN_FREE_GB is
// left free on every drive a conversion writes to. Copies watched longest ago are deleted to make room;
// one watched in the last RECENT_USE_MS never is. A job that still doesn't fit waits for a later scan.
const gbSetting = (value, fallback) => { const n = Number(value ?? fallback); return Number.isFinite(n) && n >= 0 ? n * GB : fallback * GB; };
const COPIES_MAX_BYTES = gbSetting(process.env.BROWSER_COPIES_MAX_GB, 150);
const MIN_FREE_BYTES = gbSetting(process.env.MIN_FREE_GB, 20);
const RECENT_USE_MS = 3 * 3600 * 1000;

const status = {
  enabled: false,
  reason: 'Starting…',
  encoder: null,       // 'nvenc' | 'x264'
  active: [],          // [{ lane, name, mode, purpose, percent, speed, eta }], one per running lane
  queued: 0,
  recentFailures: [],  // [{ name, error }]
  done: 0,
  lowSpace: null,      // why conversions are waiting for disk space, or null
};

let stateFile = null;
let failures = {};     // key -> { error, at }
let audioChecked = {}; // file key -> true once its audio is known to be browser-compatible and in sync
let syncShift = {};    // source key -> manual audio correction in seconds (negative = earlier)
let syncApplied = {};  // source key -> correction baked into the current copy
let copyUsed = {};     // cached copy file name -> last time it was streamed (ms)
const CHECK_VERSION = 'v3|'; // bump to re-check files after the audio checks change
const SYNC_TOLERANCE = 0.04; // seconds; below one video frame
let onConvertedHook = null;
let onSidecarHook = null;
let fixDir = null;     // cache directory for audio-fixed copies
// Conversions write their temporary MP4 on a faster scratch drive when it has room (SCRATCH_DIR), then
// copy the finished file next to the original in one sequential write. scratchRoomFn() = free bytes.
let scratchDir = null, scratchRoomFn = null;
const scratchJobs = new Map(); // temporary file on the scratch drive -> bytes promised to it
export function scratchReserved() {
  let n = 0;
  for (const [file, bytes] of scratchJobs) {
    let have = 0;
    try { have = fs.statSync(file).size; } catch { /* not started yet */ }
    n += Math.max(0, bytes - have);
  }
  return n;
}
let audioTrackDir = null;
let audioTrackBusy = false;
const audioTrackJobs = new Map();
let nvencBroken = false;
// Jobs run in two lanes side by side. 'copy' takes stream copies (Apple MP4s, audio fixes, saving an
// original's subtitles): disk-bound, a few minutes. 'encode' takes video re-encodes (H.264 browser
// copies, codecs Apple can't play): bound by the GPU's encoder (or the CPU without NVENC). They use
// different hardware, so a 20-minute H.264 copy no longer holds up the next film's MP4, and a
// downloaded HEVC MP4 gets its audio fix and its H.264 copy at the same time.
const LANES = ['copy', 'encode'];
const active = new Map(); // lane -> { job, slot }
const queue = [];
const activeJobs = () => [...active.values()].map((a) => a.job);
const kindOf = (job) => (job.retire ? 'retire' : job.h264 ? 'h264' : job.fix ? 'fix' : 'mp4');
// A job of this kind for this file is running or waiting.
const hasJob = (file, kind) => [...activeJobs(), ...queue].some((j) => j.file === file && kindOf(j) === kind);
const isActive = (file) => activeJobs().some((j) => j.file === file);

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
  may: 'ms', msa: 'ms', jpn: 'ja', kor: 'ko', geo: 'ka', kat: 'ka', tgl: 'tl', fil: 'tl',
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
// Cache path for a file's H.264 browser copy (for browsers without HEVC), beside its audio-fixed copy.
export function h264Path(file) {
  const fixed = fixPath(file);
  return fixed && fixed.replace(/\.mp4$/, '-h264.mp4');
}
const canFix = (file) => FIX_EXT.has(path.extname(file).toLowerCase()) && !isTempFile(file);

// Returns the best file to stream: the MP4 copy if one exists, and for browsers the audio-fixed copy.
// TVs receive the original so surround audio is preserved.
// hevc: the browser plays HEVC itself, so it gets the HEVC file (full quality), never the H.264 copy.
export function preferConverted(file, { browser = false, hevc = false } = {}) {
  const h264 = (f) => {
    const copy = browser && !hevc && h264Path(f);
    return copy && fs.existsSync(copy) ? copy : null;
  };
  if (needsConversion(file)) {
    const twin = twinPath(file);
    if (!fs.existsSync(twin)) return file;
    return h264(twin) || twin; // the MP4 copy already has browser audio
  }
  if (canFix(file) && (browser || syncShift[failureKey(file)])) { // TVs too when a manual correction exists
    const copy = h264(file);
    if (copy) return copy;
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
  const h264 = h264Path(file);
  if (audioTrackDir) {
    const sources = new Set([audioSourceKey(file), audioSourceKey(preferConverted(file, { browser: true })),
      audioSourceKey(preferConverted(file, { browser: true, hevc: true }))]);
    try {
      for (const name of fs.readdirSync(audioTrackDir)) if ([...sources].some((key) => name.startsWith(`${key}-`))) {
        try { fs.rmSync(path.join(audioTrackDir, name), { force: true }); } catch { /* in use; stale cleanup retries */ }
      }
    } catch { /* no selections cached */ }
  }
  if (fixed) fs.rmSync(fixed, { force: true });
  if (h264) fs.rmSync(h264, { force: true });
}
// A conversion is reading or writing this file (or its MP4 copy).
export const isBusy = (file) => isActive(file) || (needsConversion(file) && isActive(twinPath(file)));

// Audio tracks of a file, default track first. Returns null when ffprobe is unavailable.
export const isAligned = (tracks) => !tracks?.length || Math.abs(tracks[0].offset || 0) <= SYNC_TOLERANCE;
const audioCache = new Map();
export async function probeAudio(file) {
  const key = failureKey(file);
  if (audioCache.has(key)) return audioCache.get(key);
  const info = await probe(file);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const videoStart = Number(video?.start_time) || 0;
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const main = audios.find((a) => a.disposition?.default) || audios[0];
  const out = main ? [main, ...audios.filter((a) => a !== main)].map((a) => ({
    index: a.index, audioIndex: audios.indexOf(a), streamId: a.id || null,
    title: a.tags?.title || (a.tags?.handler_name && a.tags.handler_name !== 'SoundHandler' ? a.tags.handler_name : null), default: Boolean(a.disposition?.default),
    codec: a.codec_name, channels: a.channels || null, language: a.tags?.language || null,
    offset: Math.round(((Number(a.start_time) || 0) - videoStart) * 1000) / 1000, // start relative to video
  })) : [];
  audioCache.set(key, out);
  return out;
}

// Selections refer to the exact browser file: conversion can insert/reorder audio streams.
export function audioSourceKey(file) {
  return crypto.createHash('sha256').update(failureKey(file)).digest('hex').slice(0, 24);
}

export function selectedAudioPath(file, index, source) {
  if (!audioTrackDir || !Number.isSafeInteger(index) || index < 0 || !/^[a-f0-9]{24}$/.test(source)) return null;
  if (audioSourceKey(file) !== source) return null;
  const output = path.join(audioTrackDir, `${source}-${index}.mp4`);
  return fs.existsSync(output) ? output : null;
}

// The same audio in another copy of a video (converting can add, drop or reorder tracks): the same language,
// then the closest codec, channel count, title and position. null when that language isn't there.
export function matchAudioTrack(track, tracks) {
  const lang = (t) => String(t.language || 'und').toLowerCase();
  const score = (t) => (t.codec === track.codec) * 8 + (t.channels === track.channels) * 4
    + ((t.title || '') === (track.title || '')) * 2 + (t.audioIndex === track.audioIndex);
  return (tracks || []).filter((t) => lang(t) === lang(track)).sort((a, b) => score(b) - score(a))[0] || null;
}

// On browsers without audioTracks, keep the picture bit-for-bit and make one selected AAC track.
// Work happens while the existing stream keeps playing. Copies never replace a shared source.
export async function requestAudioTrack(file, index, source, { retry = false } = {}) {
  if (!Number.isSafeInteger(index) || index < 0) throw Object.assign(new Error('Invalid audio track.'), { status: 400 });
  if (source !== audioSourceKey(file)) throw Object.assign(new Error('Audio tracks changed. Open Audio and choose the language again.'), { status: 409 });
  const tracks = await probeAudio(file);
  if (!tracks?.some((track) => track.index === index)) throw Object.assign(new Error('That audio track is not available.'), { status: 400 });
  const existing = selectedAudioPath(file, index, source);
  if (existing) return { ready: true, file: existing };
  if (!audioTrackDir) throw Object.assign(new Error('Audio preparation is not ready yet. Try again.'), { status: 503 });
  const key = `${source}-${index}`;
  let job = audioTrackJobs.get(key);
  if (job?.error && retry) { audioTrackJobs.delete(key); job = null; }
  if (job?.error) throw Object.assign(new Error(job.error), { status: 503 });
  if (job) return { ready: false, state: 'preparing' };
  if (audioTrackBusy) return { ready: false, state: 'queued' };
  audioTrackBusy = true;
  job = {};
  audioTrackJobs.set(key, job);
  const output = path.join(audioTrackDir, `${key}.mp4`);
  const tmp = output.replace(/\.mp4$/, `${TMP_TAG}.mp4`);
  (async () => {
    try {
      const info = await probe(file);
      const video = info.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
      const audio = info.streams?.find((s) => s.codec_type === 'audio' && s.index === index);
      if (!video || !audio || source !== audioSourceKey(file)) throw new Error('Source changed');
      fs.mkdirSync(audioTrackDir, { recursive: true });
      // Remove stale selections lazily. Recently streamed copies are touched by handlePlay.
      for (const name of fs.readdirSync(audioTrackDir)) {
        const old = path.join(audioTrackDir, name);
        try { if (Date.now() - fs.statSync(old).mtimeMs > 7 * 86400000) fs.rmSync(old, { force: true }); } catch { /* in use */ }
      }
      // The viewer waits for this copy, so the index goes in reserved room (see moovReserve) rather
      // than a +faststart pass that rewrites the whole file once more; +faststart if it outgrows it.
      const reserve = moovReserve(info, video, [audio.sample_rate]);
      const copy = (faststart) => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', file,
        '-map', `0:${video.index}`, '-map', `0:${index}`, '-map_chapters', '0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac:a', '2',
        '-filter:a', 'aresample=async=1000:first_pts=0',
        '-metadata:s:a:0', `language=${audio.tags?.language || 'und'}`, '-disposition:a:0', 'default',
        '-avoid_negative_ts', 'disabled', ...(faststart ? ['-movflags', '+faststart'] : ['-moov_size', String(reserve)]),
        '-f', 'mp4', tmp]); // someone is waiting for it: normal priority, not background
      try {
        await copy(!reserve);
      } catch (e) {
        if (!reserve || !/reserved_moov_size is too small/i.test(e.stderr || '')) throw e;
        fs.rmSync(tmp, { force: true });
        await copy(true);
      }
      if (source !== audioSourceKey(file)) throw new Error('Source changed');
      fs.renameSync(tmp, output);
      audioTrackJobs.delete(key);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* later cleanup */ }
      job.error = 'Couldn’t prepare this audio track. Try again.';
      // Do not expose ffmpeg stderr or filesystem paths in the player's error.
    } finally {
      audioTrackBusy = false;
      if (audioTrackJobs.size > 32) audioTrackJobs.delete(audioTrackJobs.keys().next().value);
    }
  })();
  return { ready: false, state: 'preparing' };
}

// Video every Apple device plays: 8-bit H.264, or HEVC labelled "hvc1". Downloads often carry HEVC
// labelled "hev1" (fine in Chrome and Edge, refused by Safari), 10-bit H.264 or AV1. Those get a
// browser copy: HEVC is just relabelled (fast, no quality loss); the others are re-encoded to H.264.
const videoCache = new Map();
export async function probeVideo(file) {
  if (!status.enabled) return null;
  const key = failureKey(file);
  if (videoCache.has(key)) return videoCache.get(key);
  const info = await probe(file);
  const v = (info.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const out = v ? { codec: v.codec_name, tag: v.codec_tag_string || null, tenBit: /10|12/.test(v.pix_fmt || '') } : null;
  videoCache.set(key, out);
  return out;
}
// Stats for nerds: everything worth showing about a file's streams, from one ffprobe (cached per
// file version). describeProbe is pure, so tests can feed it ffprobe JSON.
const detailCache = new Map();
export async function probeDetails(file) {
  const key = failureKey(file);
  if (detailCache.has(key)) return detailCache.get(key);
  const out = describeProbe(JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-show_chapters', file])));
  if (detailCache.size >= 200) detailCache.clear();
  detailCache.set(key, out);
  return out;
}
const numberOr = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const frameRate = (r) => { const [n, d] = String(r || '').split('/').map(Number); return n > 0 && d > 0 ? Math.round((n / d) * 1000) / 1000 : null; };
const ratio = (r) => { const [n, d] = String(r || '').split('/').map(Number); return n > 0 && d > 0 ? n / d : null; };
// Matroska keeps per-stream statistics in tags (BPS, NUMBER_OF_FRAMES), sometimes with a language suffix.
const statTag = (s, name) => {
  const tags = s.tags || {};
  const k = Object.keys(tags).find((t) => t.toUpperCase() === name || t.toUpperCase().startsWith(`${name}-`));
  return k ? numberOr(tags[k]) : null;
};
const bitDepthOf = (s) => numberOr(s.bits_per_raw_sample) || Number((String(s.pix_fmt || '').match(/p(9|10|12|14|16)(?:le|be)?$/) || [])[1]) || (s.pix_fmt ? 8 : null);
function hdrOf(v) {
  const side = v.side_data_list || [];
  const dv = side.find((d) => /dovi|dolby vision/i.test(d.side_data_type || ''));
  const transfer = v.color_transfer;
  const base = transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : 'SDR';
  if (dv) return `Dolby Vision${dv.dv_profile != null ? ` ${dv.dv_profile}${dv.dv_bl_signal_compatibility_id ? `.${String(dv.dv_bl_signal_compatibility_id).padStart(2, '0')}` : ''}` : ''}${base !== 'SDR' ? ` (${base} base)` : ''}`;
  return base;
}
export function describeProbe(info) {
  const f = info.format || {};
  const streams = info.streams || [];
  const flags = (s) => ({ default: Boolean(s.disposition?.default), forced: Boolean(s.disposition?.forced) });
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  let video = null;
  if (v) {
    const side = v.side_data_list || [];
    const mastering = side.find((d) => /mastering display/i.test(d.side_data_type || ''));
    const light = side.find((d) => /content light level/i.test(d.side_data_type || ''));
    const rotation = side.find((d) => d.rotation != null)?.rotation ?? numberOr(v.tags?.rotate);
    video = {
      index: v.index, codec: v.codec_name, codecLong: v.codec_long_name || null, profile: v.profile || null,
      level: numberOr(v.level), tag: v.codec_tag_string && !/^\[0\]/.test(v.codec_tag_string) ? v.codec_tag_string : null,
      width: v.width || null, height: v.height || null, sar: v.sample_aspect_ratio && v.sample_aspect_ratio !== '1:1' && v.sample_aspect_ratio !== '0:1' ? v.sample_aspect_ratio : null,
      dar: v.display_aspect_ratio && v.display_aspect_ratio !== '0:1' ? v.display_aspect_ratio : null,
      pixFmt: v.pix_fmt || null, bitDepth: bitDepthOf(v), chroma: v.chroma_location && v.chroma_location !== 'unspecified' ? v.chroma_location : null,
      fps: frameRate(v.avg_frame_rate) || frameRate(v.r_frame_rate), fieldOrder: v.field_order && v.field_order !== 'unknown' ? v.field_order : null,
      bitrate: numberOr(v.bit_rate) || statTag(v, 'BPS'), frames: numberOr(v.nb_frames) || statTag(v, 'NUMBER_OF_FRAMES'),
      range: v.color_range || null, space: v.color_space || null, transfer: v.color_transfer || null, primaries: v.color_primaries || null,
      hdr: hdrOf(v), refs: numberOr(v.refs), bFrames: numberOr(v.has_b_frames), rotation: rotation || null,
      mastering: mastering ? { maxLum: ratio(mastering.max_luminance), minLum: ratio(mastering.min_luminance) } : null,
      light: light ? { maxCll: numberOr(light.max_content), maxFall: numberOr(light.max_average) } : null,
    };
  }
  const audio = streams.filter((s) => s.codec_type === 'audio').map((a) => ({
    index: a.index, codec: a.codec_name, codecLong: a.codec_long_name || null, profile: a.profile || null,
    channels: a.channels || null, layout: a.channel_layout || null, sampleRate: numberOr(a.sample_rate), sampleFmt: a.sample_fmt || null,
    bitDepth: numberOr(a.bits_per_raw_sample) || null, bitrate: numberOr(a.bit_rate) || statTag(a, 'BPS'),
    language: a.tags?.language || null, title: a.tags?.title || null, ...flags(a),
  }));
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({
    index: s.index, codec: s.codec_name, language: s.tags?.language || null, title: s.tags?.title || null, ...flags(s),
    hearingImpaired: Boolean(s.disposition?.hearing_impaired),
  }));
  return {
    container: f.format_long_name || f.format_name || null, format: f.format_name || null,
    size: numberOr(f.size), duration: numberOr(f.duration), bitrate: numberOr(f.bit_rate), start: numberOr(f.start_time),
    title: f.tags?.title || null, encoder: f.tags?.encoder || f.tags?.ENCODER || null, brand: f.tags?.major_brand || null,
    chapters: (info.chapters || []).length, video, audio, subtitles,
    attachments: streams.filter((s) => s.codec_type === 'attachment' || s.disposition?.attached_pic).length,
  };
}
// hevc: whether the browser asking can decode HEVC at all (Firefox usually can't).
export const videoBrowserSafe = (v, { hevc = true } = {}) => !v || (v.codec === 'h264' && !v.tenBit) || (hevc && v.codec === 'hevc' && v.tag === 'hvc1');
// The original whose MP4 copy is being made right now (library items can't play until it's done).
export const convertingFile = () => activeJobs().find((j) => kindOf(j) === 'mp4')?.file || null;
export const VIDEO_NAMES = { hevc: 'HEVC (H.265)', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4' };

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
  const kind = kindOf(job);
  const running = [...active.values()].find((a) => a.job.file === job.file && kindOf(a.job) === kind);
  if (running) return { fixable: true, state: 'converting', percent: running.slot.percent ?? 0 };
  const i = queue.findIndex((q) => q.file === job.file && kindOf(q) === kind);
  const queued = i >= 0 ? queue.splice(i, 1)[0] : null;
  // A queued deletion of the original is dropped; the next scan queues it again once the copy is redone.
  if (kind === 'mp4') {
    const r = queue.findIndex((q) => q.file === job.file && q.retire);
    if (r >= 0) queue.splice(r, 1);
  }
  queue.unshift({ ...(queued || job), redo: job.redo, fix: job.fix, h264: job.h264, force: true });
  drain(onConvertedHook);
  const started = [...active.values()].find((a) => a.job.file === job.file && kindOf(a.job) === kind);
  return started
    ? { fixable: true, state: 'converting', percent: started.slot.percent ?? 0 }
    : { fixable: true, state: 'queued', percent: null };
}

// Moves a file whose audio won't play correctly in browsers to the front of the queue.
// Returns { fixable, state: 'converting' | 'queued', percent, error }.
// HEVC plays in Safari and in Chrome/Edge on most PCs, but not in Firefox. For a browser that can't
// play it, an H.264 browser copy is made of the file that's actually streamed (the MP4 copy, or the
// downloaded MP4). TVs keep getting the original.
export function requestBrowserVideo(file) {
  if (!status.enabled) return { fixable: false, error: status.reason };
  const target = needsConversion(file) ? twinPath(file) : file;
  if (!canFix(target) || !fs.existsSync(target)) return { fixable: false };
  return runFirst({ file: target, fix: true, h264: true });
}

// Queues an H.264 browser copy at the BACK of the queue (nothing jumps ahead). Used to get the next
// episodes of a show ready while one is being watched in a browser without HEVC, so pressing Play on
// the next one starts right away instead of waiting for its copy. Returns true when one was queued.
export function queueBrowserVideo(file) {
  if (!status.enabled) return false;
  const target = needsConversion(file) ? twinPath(file) : file;
  if (!canFix(target) || !fs.existsSync(target)) return false; // not converted yet: that comes first
  const copy = h264Path(target);
  if (!copy || fs.existsSync(copy) || failures[failureKey(target)]) return false;
  if (hasJob(target, 'h264')) return false;
  queue.push({ file: target, fix: true, h264: true, prepare: true }); // someone is watching: may make room
  drain(onConvertedHook);
  return true;
}

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
  const result = runFirst(job);
  // A downloaded MP4's H.264 copy carries the old timing: rebuild it too, after the audio fix.
  const copy = job.fix && h264Path(job.file);
  if (copy && fs.existsSync(copy) && !hasJob(job.file, 'h264')) { queue.push({ file: job.file, fix: true, h264: true, force: true }); drain(); }
  return result;
}

// { shift, applied, state } for the file a library entry was made from.
export function syncState(file) {
  const job = browserJob(file);
  if (!job) return { shift: 0, applied: 0, state: null };
  const key = failureKey(job.file);
  return { shift: syncShift[key] || 0, applied: syncApplied[key] || 0, state: jobState(job.file) };
}

export const jobState = (file) => (isActive(file) ? 'converting' : queue.some((q) => q.file === file && !q.retire) ? 'queued' : null);

// `current` (the first running job) is kept for older callers; `active` lists every running lane.
// Running and waiting jobs with their files, so the server can show each person only their own videos
// (the status itself carries no paths, it goes to every browser).
const failureFiles = new Map(); // error + name -> file, for recentFailures
export function jobFiles() {
  return {
    active: [...active.values()].map(({ job, slot }) => ({ file: job.file, kind: kindOf(job), slot: { ...slot } })),
    queued: queue.map((j) => ({ file: j.file, kind: kindOf(j) })),
    failures: status.recentFailures.map((f) => ({ ...f, file: failureFiles.get(f.error + f.name) || null })),
  };
}

export function converterStatus() {
  const running = status.active.map((s) => ({ ...s }));
  return { ...status, active: running, current: running[0] || null, queued: queue.length };
}

// ffmpeg processes stop with the server, so none keeps writing a half-finished copy after a restart.
// (The copy is written under a temporary name and only renamed once complete, so an interrupted
// conversion never leaves a broken MP4; it simply starts again from the beginning.)
const children = new Set();
function stopChildren() { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } }
process.on('exit', stopChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  try { process.on(sig, () => { stopChildren(); process.exit(0); }); } catch { /* signal not available here */ }
}

function run(cmd, args, { onStdout, priorityLow = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    children.add(child);
    trackChild(child, cmd, args, 'convert');
    child.on('close', () => children.delete(child));
    if (priorityLow) background(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; onStdout?.(d.toString()); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(Object.assign(new Error(lastLine(err) || `exit code ${code}`), { stderr: err }))));
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

// Room reserved at the start of the MP4 for its index (moov), so ffmpeg writes the index there when
// it finishes instead of rewriting the whole file afterwards: +faststart reads and writes every byte
// a second time, a quarter of a conversion's time on the media HDD. A House episode's index is about
// 15 bytes per packet; 32 plus 1 MB leaves plenty of room (the unused rest is a few MB of padding).
// A file that still outgrows it is converted again with +faststart. null when the length is unknown.
function moovReserve(info, video, audioRates) {
  const duration = Number(info.format?.duration) || Number(video.duration);
  if (!(duration > 0)) return null;
  const [n, d] = String(video.avg_frame_rate || video.r_frame_rate || '').split('/').map(Number);
  const fps = n > 0 && d > 0 ? Math.min(n / d, 240) : 60;
  const audioPackets = audioRates.reduce((sum, rate) => sum + (Number(rate) || 48000) / 1024, 0);
  return Math.ceil(duration * (fps + audioPackets) * 32 + 1024 * 1024);
}

// safeAudio: re-encode E-AC-3 instead of copying it. Some E-AC-3 tracks (notably Dolby Atmos,
// which carries a dependent substream) can't be written into MP4 by ffmpeg and make the
// muxer fail at the very end with "Error writing trailer: Invalid data found".
// faststart: index written with a second pass instead of in reserved room (see moovReserve).
// aacSurround: surround tracks that can't be copied become AAC instead of E-AC-3.
function plan(input, output, info, encoder, shift = 0, safeAudio = false, sidecars = [], forceH264 = false,
  { faststart = false, aacSurround = false } = {}) {
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
  } else if (video.codec_name === 'hevc' && !forceH264) {
    args.push('-c:v', 'copy', '-tag:v', 'hvc1'); // hvc1 tag required by Apple players
  } else {
    reencode = true;
    args.push(...(encoder === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high');
  }

  let out = 0;
  let surroundEac3 = false;
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
    else if (!aacSurround && (a.channels || 2) > 2 && a.channels <= 6) {
      // Surround that Apple devices can't play (DTS, TrueHD, FLAC, ...) becomes E-AC-3 640k: ~14x
      // faster to encode than 5.1 AAC 384k, which held up the whole conversion, and measured closer
      // to the DTS source on every channel with the full frequency range kept. (7.1 stays AAC:
      // ffmpeg's E-AC-3 encoder stops at 5.1.)
      surroundEac3 = true;
      args.push(`-c:a:${i}`, 'eac3', `-b:a:${i}`, '640k');
    } else args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, (a.channels || 2) > 2 ? '384k' : '192k');
  });
  // Only the first audio track is marked default.
  for (let i = 0; i < out; i++) args.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');

  const outRates = [...(main ? [main.sample_rate] : []), ...audios.filter((a) => a !== main || keepMain).map((a) => a.sample_rate)];
  const reserve = faststart ? null : moovReserve(info, video, outRates);
  args.push('-avoid_negative_ts', 'disabled', ...(reserve ? ['-moov_size', String(reserve)] : ['-movflags', '+faststart']),
    '-progress', 'pipe:1', '-nostats', '-f', 'mp4', output);
  for (const sc of sidecars) args.push('-map', `0:${sc.index}`, '-c:s', 'srt', '-f', 'srt', sc.tmp);
  return { args, reencode, surroundEac3, duration: Number(info.format?.duration) || Number(video.duration) || null };
}

async function convert(job, slot) {
  const { file } = job;
  const name = path.basename(file);
  const output = job.h264 ? h264Path(file) : job.fix ? fixPath(file) : twinPath(file);
  if (!output) throw new Error('No place to save the fixed copy.');
  if (job.fix) fs.mkdirSync(path.dirname(output), { recursive: true });
  const localTmp = job.fix
    ? output.replace(/\.mp4$/, `${TMP_TAG}.mp4`)
    : path.join(path.dirname(file), `${path.basename(file, path.extname(file))}${TMP_TAG}.mp4`);
  let tmp = localTmp;
  if (scratchDir && !job.fix) {
    try {
      const need = Math.ceil(fs.statSync(file).size * 1.1) + 256 * 1024 ** 2;
      if ((await scratchRoomFn()) >= need) {
        fs.mkdirSync(scratchDir, { recursive: true });
        const id = crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 10);
        tmp = path.join(scratchDir, `${path.basename(file, path.extname(file))}-${id}${TMP_TAG}.mp4`);
        scratchJobs.set(tmp, need);
      }
    } catch { tmp = localTmp; }
  }
  const releaseScratch = () => { scratchJobs.delete(tmp); };
  try {
    fs.rmSync(tmp, { force: true });
  } catch (e) {
    // Still open: an ffmpeg left running by a previous server process. Try again on a later scan.
    if (/EBUSY|EPERM|EACCES/.test(e.code || '')) { e.retryLater = true; e.message = 'an earlier conversion is still finishing'; }
    releaseScratch();
    throw e;
  }

  let info;
  try { info = await probe(file); } catch (e) { releaseScratch(); throw e; }
  const key = failureKey(file);
  const shift = syncShift[key] || 0;
  let safeAudio = false;
  const sidecars = plannedSidecars(file, (info.streams || []).filter((st) => st.codec_type === 'subtitle' && TEXT_SUBS.has(st.codec_name)));
  const dropSidecarTemps = () => sidecars.forEach((sc) => fs.rmSync(sc.tmp, { force: true }));
  const fallbacks = { faststart: false, aacSurround: false };
  let lastPlan = null;
  const attempt = async (encoder) => {
    const p = lastPlan = plan(file, tmp, info, encoder, shift, safeAudio, sidecars, Boolean(job.h264), fallbacks);
    const started = Date.now();
    Object.assign(slot, { name, mode: p.reencode ? 'Re-encoding' : job.fix ? 'Making a browser copy' : 'Repackaging', purpose: job.h264 ? 'browser-h264' : job.fix ? 'browser-audio' : 'apple', percent: 0, speed: null, eta: null });
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
            slot.percent = Math.round(percent * 10) / 10;
            slot.eta = percent > 1 ? Math.round((elapsed / percent) * (100 - percent)) : null;
          } else if (k === 'speed') {
            slot.speed = v.trim();
          }
        }
      },
    });
    return p;
  };

  let encoder = nvencBroken ? 'x264' : 'nvenc';
  const needsEncode = plan(file, tmp, info, encoder, 0, false, [], Boolean(job.h264)).reencode;
  try {
    // Each fallback is tried at most once, so this always ends.
    for (;;) {
      try {
        await attempt(encoder);
        break;
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        dropSidecarTemps();
        if (!fallbacks.faststart && /reserved_moov_size is too small/i.test(e.stderr || '')) {
          // Checked first: it also ends in "Error writing trailer", which isn't an audio or GPU problem.
          console.warn(`[convert] ${name}: the reserved MP4 index room was too small; converting again with +faststart.`);
          fallbacks.faststart = true;
        } else if (encoder === 'nvenc' && needsEncode) {
          // NVENC unavailable: fall back to x264 for this and all later jobs.
          console.warn(`[convert] GPU encoding failed (${e.message}); using the CPU instead.`);
          nvencBroken = true;
          encoder = 'x264';
          status.encoder = 'x264';
        } else if (!safeAudio && /trailer|invalid data/i.test(e.message)
          && (info.streams || []).some((st) => st.codec_type === 'audio' && st.codec_name === 'eac3')) {
          console.warn(`[convert] ${name}: E-AC-3 audio couldn't be copied (${e.message}); re-encoding it instead.`);
          safeAudio = true;
        } else if (!fallbacks.aacSurround && lastPlan?.surroundEac3) {
          console.warn(`[convert] ${name}: E-AC-3 surround encoding failed (${e.message}); using AAC instead.`);
          fallbacks.aacSurround = true;
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    releaseScratch();
    dropSidecarTemps();
    throw e;
  }
  for (const sc of sidecars) {
    try {
      if (fs.existsSync(sc.target) || !fs.statSync(sc.tmp).size) fs.rmSync(sc.tmp, { force: true });
      else { fs.renameSync(sc.tmp, sc.target); onSidecarHook?.(sc.target); }
    } catch { fs.rmSync(sc.tmp, { force: true }); }
  }
  try {
    if (tmp !== localTmp) {
      // Made on the scratch drive: one sequential copy next to the original, then the usual rename.
      try {
        await fs.promises.copyFile(tmp, localTmp);
      } finally { fs.rmSync(tmp, { force: true }); releaseScratch(); }
      tmp = localTmp;
    }
    fs.renameSync(tmp, output); // overwrites the previous copy on redo
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    // Previous copy is in use; retry on the next scan instead of recording a failure.
    if ((job.redo || job.force) && /EBUSY|EPERM|EACCES/.test(e.code || '')) { e.retryLater = true; }
    throw e;
  }
  audioCache.clear();
  videoCache.clear();
  delete failures[key]; // an earlier failure no longer applies
  syncApplied[key] = shift;
  saveFailures();
  if (job.deleteOriginal && !job.fix) await retireOriginal(file, slot);
}

// ---------- deleting originals ----------
// With CONVERT_DELETE_ORIGINAL=on, a library original (never one qBittorrent still lists) is deleted
// once its MP4 copy is complete, also when the copy was made earlier while the download was still in
// qBittorrent. Picture and audio are already in the MP4, but image subtitles (PGS from Blu-rays, VobSub
// from DVDs) can't go in MP4, and forced or untagged text tracks get no .srt. So every subtitle track,
// plus the fonts styled ASS subtitles use, is first copied unchanged into "<name>.subtitles.mks" beside
// it (mpv, VLC and Plex load it as an external subtitle file). The original is kept if anything fails.
export const subtitleArchivePath = (file) => path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.subtitles.mks`);
const retireSkipped = new Map(); // file key -> reason; checked again only after a restart or a change to the file

async function retireOriginal(file, slot = {}) {
  const name = path.basename(file);
  const keep = (reason) => {
    retireSkipped.set(failureKey(file), reason);
    console.warn(`[convert] keeping ${name}: ${reason}`);
    return false;
  };
  let info, copy;
  try { [info, copy] = await Promise.all([probe(file), probe(twinPath(file))]); }
  catch (e) { return keep(`it or its MP4 copy couldn't be read (${e.message})`); }
  const hasVideo = (i) => (i.streams || []).some((st) => st.codec_type === 'video' && !st.disposition?.attached_pic);
  if (hasVideo(info) && !hasVideo(copy)) return keep('the MP4 copy has no video');
  const length = (i) => Number(i.format?.duration) || 0;
  if (length(info) > 0 && Math.abs(length(copy) - length(info)) > Math.max(2, length(info) * 0.005)) {
    return keep(`the MP4 copy is ${Math.round(length(copy))} s long, the original ${Math.round(length(info))} s`);
  }
  const subs = (info.streams || []).filter((st) => st.codec_type === 'subtitle');
  const archive = subtitleArchivePath(file);
  if (subs.length && !fs.existsSync(archive)) {
    const tmp = archive.replace(/\.mks$/, `${TMP_TAG}.mks`);
    Object.assign(slot, { name, mode: 'Saving subtitles', purpose: 'subtitles', percent: 0, speed: null, eta: null });
    const save = async (fonts) => {
      fs.rmSync(tmp, { force: true });
      await run(FFMPEG, ['-v', 'error', '-y', '-i', file, '-map', '0:s', ...(fonts ? ['-map', '0:t?'] : []),
        '-c', 'copy', '-f', 'matroska', tmp], { priorityLow: true });
      const saved = (await probe(tmp)).streams?.filter((st) => st.codec_type === 'subtitle').length || 0;
      if (saved !== subs.length) throw new Error(`only ${saved} of ${subs.length} subtitle tracks were copied`);
    };
    try {
      try { await save(true); }
      catch { await save(false); } // an attachment ffmpeg can't copy; the subtitles matter, the fonts less
      fs.renameSync(tmp, archive);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      return keep(`its subtitles couldn't be saved (${e.message})`);
    }
  }
  removeOriginal(file);
  return true;
}

// Deletes an original after its MP4 copy is made. Windows refuses while something has the file open
// (playback, antivirus, Explorer previews), so a locked file is retried on later scans instead of
// counting as a failed conversion.
let pendingDeletes = [];
function removeOriginal(file) {
  try {
    fs.rmSync(file, { force: true });
    pendingDeletes = pendingDeletes.filter((f) => f !== file);
  } catch (e) {
    if (!/EBUSY|EPERM|EACCES/.test(e.code || '')) { console.warn(`[convert] couldn’t delete ${path.basename(file)}: ${e.message}`); return; }
    if (!pendingDeletes.includes(file)) {
      pendingDeletes.push(file);
      console.warn(`[convert] ${path.basename(file)} is in use; it will be deleted once it's free.`);
    }
  }
  saveFailures();
}
// Temporary files left by a conversion that was interrupted (server restarted, PC turned off).
function cleanTemps(candidates) {
  const dirs = new Set(candidates.map((c) => path.dirname(c.file)));
  if (fixDir) dirs.add(fixDir);
  if (scratchDir) dirs.add(scratchDir);
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!isTempFile(e)) continue;
      const full = path.join(dir, e);
      if (scratchJobs.has(full)) continue;
      const running = activeJobs().some(({ file }) => { // conversions running now
        const stem = path.join(path.dirname(file), path.basename(file, path.extname(file)));
        return full.startsWith(`${stem}.`)
          || [fixPath(file), h264Path(file)].some((o) => o && full === o.replace(/\.mp4$/, `${TMP_TAG}.mp4`));
      });
      if (running) continue;
      try {
        if (Date.now() - fs.statSync(full).mtimeMs < 10 * 60 * 1000) continue; // possibly being written right now
        fs.rmSync(full, { force: true });
        console.log(`[convert] removed leftover ${e}`);
      } catch { /* still open; next time */ }
    }
  }
}

function retryDeletes() {
  for (const file of [...pendingDeletes]) {
    if (!fs.existsSync(file) || !fs.existsSync(twinPath(file))) pendingDeletes = pendingDeletes.filter((f) => f !== file);
    else if (!isActive(file)) removeOriginal(file);
  }
}

const failureKey = (file) => {
  try { const s = fs.statSync(file); return `${file}|${s.size}|${Math.floor(s.mtimeMs)}`; } catch { return file; }
};

function saveFailures() {
  try { fs.writeFileSync(stateFile, JSON.stringify({ failures, audioChecked, syncShift, syncApplied, pendingDeletes, copyUsed }, null, 2)); } catch { /* best effort */ }
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
// Records that a cached copy was streamed, so making room deletes copies nobody watches first.
// Saved at most every ten minutes per copy (a film streams as hundreds of range requests).
export function noteServed(file) {
  if (!fixDir || !file || !samePathCI(path.dirname(file), fixDir)) return;
  const name = path.basename(file);
  const now = Date.now();
  if (now - (copyUsed[name] || 0) < 10 * 60 * 1000) return;
  copyUsed[name] = now;
  saveFailures();
}

function cachedCopies() {
  let names = [];
  try { names = fs.readdirSync(fixDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.mp4') || isTempFile(name)) continue;
    try {
      const st = fs.statSync(path.join(fixDir, name));
      if (st.isFile()) out.push({ name, size: st.size, used: Math.max(copyUsed[name] || 0, st.mtimeMs) });
    } catch { /* deleted meanwhile */ }
  }
  return out;
}

// Rough size of a job's output: an H.264 re-encode of HEVC can be about twice the source.
function outputEstimate(job) {
  try { return fs.statSync(job.file).size * (job.h264 ? 2 : 1.1); } catch { return 0; }
}

// Deletes the least recently watched cached copies until `job`'s output fits (job null: until the folder
// is under its cap; background browser copies only check, see mayEvict). Throws { lowSpace } when it still doesn't fit; the job is tried again on a later scan.
async function makeRoom(job) {
  if (!fixDir) return;
  const output = job && (job.h264 ? h264Path(job.file) : job.fix ? fixPath(job.file) : twinPath(job.file));
  const outDir = output ? path.dirname(output) : fixDir;
  if (job?.fix) fs.mkdirSync(outDir, { recursive: true });
  const busy = new Set(activeJobs().flatMap((j) => [fixPath(j.file), h264Path(j.file)]).filter(Boolean).map((f) => path.basename(f)));
  // Background browser copies never push others out: the next scan would queue the evicted ones again.
  // They still have to COUNT toward the cap, though. Otherwise a background H.264 job can pretend the
  // cache is empty, push it over the limit, and make the next scan delete a different copy that then
  // gets queued for re-encoding. Busy copies also count, but cannot be removed.
  const mayEvict = !job || !job.fix || job.force || job.prepare;
  const copies = cachedCopies().map((c) => ({ ...c, evictable: mayEvict && !busy.has(c.name) }));
  const free = job ? await freeBytes(outDir) : null;
  const { names, fits } = pickEvictions(copies, {
    need: job ? outputEstimate(job) : 0,
    inFolder: Boolean(job?.fix),
    maxBytes: COPIES_MAX_BYTES,
    free,
    minFree: MIN_FREE_BYTES,
    sameDrive: !job || job.fix || sameDrive(fixDir, outDir),
    keepSince: Date.now() - RECENT_USE_MS,
  });
  for (const name of names) {
    try {
      fs.rmSync(path.join(fixDir, name), { force: true });
      delete copyUsed[name];
      console.log(`[convert] removed browser copy ${name} to make room`);
    } catch { /* in use; next time */ }
  }
  if (names.length) { videoCache.clear(); audioCache.clear(); saveFailures(); }
  if (!job || fits) { if (job) status.lowSpace = null; return; }
  const why = free != null && free - outputEstimate(job) < MIN_FREE_BYTES
    ? `${outDir} is nearly full (${(free / GB).toFixed(1)} GB free, MIN_FREE_GB=${MIN_FREE_BYTES / GB})`
    : `browser copies are at their cap (BROWSER_COPIES_MAX_GB=${COPIES_MAX_BYTES / GB})`;
  if (status.lowSpace !== why) console.warn(`[convert] waiting for disk space: ${why}`);
  status.lowSpace = why;
  throw Object.assign(new Error(`Not enough disk space: ${why}.`), { lowSpace: true });
}

// True if the default audio track isn't browser-compatible or doesn't start with the video,
// or the video itself won't play in Safari (see videoBrowserSafe). Cached per file version.
async function audioNeedsFix(file) {
  const key = CHECK_VERSION + failureKey(file);
  if (audioChecked[key]) return false;
  let audio;
  let video;
  try { [audio, video] = await Promise.all([probeAudio(file), probeVideo(file)]); } catch { return false; }
  const audioOk = !audio?.length || (BROWSER_AUDIO.has(audio[0].codec) && isAligned(audio));
  if (audioOk && videoBrowserSafe(video)) {
    audioChecked[key] = true;
    saveFailures();
    return false;
  }
  return true;
}

// The H.264 browser-copy job for a streamed MP4 (a converted copy or a downloaded MP4) if it's HEVC,
// was added recently (`added` is the library file the user downloaded) and has no H.264 copy yet.
// Firefox can't play HEVC, so without this its first Play starts a long re-encode.
async function browserH264Job(target, added) {
  if (!(BROWSER_H264_DAYS > 0) || !canFix(target)) return null;
  if (hasJob(target, 'h264') || failures[failureKey(target)]) return null;
  const copy = h264Path(target);
  if (!copy || fs.existsSync(copy)) return null;
  try {
    const st = fs.statSync(added);
    if (Date.now() - Math.max(st.birthtimeMs || 0, st.mtimeMs) > BROWSER_H264_DAYS * 864e5) return null;
  } catch { return null; }
  const v = await probeVideo(target).catch(() => null);
  if (v?.codec !== 'hevc') return null;
  return { file: target, fix: true, h264: true };
}

// Before H.264 copies had their own file they replaced the audio-fixed copy, so browsers that play
// HEVC got the re-encode too. Such a copy moves to its own place; the audio fix is made again.
async function moveOldH264Copy(file) {
  const fixed = fixPath(file);
  const copy = h264Path(file);
  if (!fixed || !copy || isActive(file) || fs.existsSync(copy) || !fs.existsSync(fixed)) return;
  const [src, old] = await Promise.all([probeVideo(file).catch(() => null), probeVideo(fixed).catch(() => null)]);
  if (src?.codec !== 'hevc' || old?.codec !== 'h264') return;
  try { fs.renameSync(fixed, copy); videoCache.clear(); audioCache.clear(); console.log(`[convert] ${path.basename(file)}: H.264 browser copy moved to its own file.`); }
  catch { /* in use; next scan */ }
}

// Which lane a job runs in: video re-encodes go to 'encode', everything else to 'copy'.
async function laneOf(job) {
  if (job.retire) return 'copy';
  if (job.h264) return 'encode';
  const v = await probeVideo(job.file).catch(() => null);
  return !v || (v.codec === 'h264' && !v.tenBit) || v.codec === 'hevc' ? 'copy' : 'encode';
}

// Files a job reads and writes (or deletes); two jobs may run together unless one writes what the other uses.
function touches(job) {
  if (job.retire) return { reads: [job.file, twinPath(job.file)], writes: [job.file, subtitleArchivePath(job.file)] };
  if (job.h264) return { reads: [job.file], writes: [h264Path(job.file)] };
  if (job.fix) return { reads: [job.file], writes: [fixPath(job.file)] };
  return { reads: [job.file], writes: [twinPath(job.file), ...(job.deleteOriginal ? [job.file, subtitleArchivePath(job.file)] : [])] };
}
const samePathCI = (a, b) => Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function clashes(job) {
  const mine = touches(job);
  return activeJobs().some((other) => {
    const theirs = touches(other);
    const hit = (writes, used) => writes.some((w) => used.some((u) => samePathCI(w, u)));
    return hit(mine.writes, [...theirs.reads, ...theirs.writes]) || hit(theirs.writes, mine.reads);
  });
}

// True when a queued job no longer needs doing.
function stale(job) {
  if (!fs.existsSync(job.file)) return true;
  if (job.retire) return !fs.existsSync(twinPath(job.file));
  if (job.force) return false;
  if (job.h264) return fs.existsSync(h264Path(job.file) || '');
  if (job.fix) return fs.existsSync(fixPath(job.file) || '');
  return !job.redo && fs.existsSync(twinPath(job.file));
}

// Starts the next job for every idle lane (queue order, skipping jobs that would clash with a running one).
let scheduling = false, scheduleAgain = false;
async function drain() {
  if (scheduling) { scheduleAgain = true; return; }
  scheduling = true;
  try {
    do {
      scheduleAgain = false;
      for (const job of [...queue]) if (!job.lane) job.lane = await laneOf(job);
      for (const lane of LANES) {
        if (active.has(lane)) continue;
        for (let i = 0; i < queue.length; i++) {
          const job = queue[i];
          if (stale(job)) { queue.splice(i--, 1); continue; }
          if (job.lane !== lane || clashes(job)) continue;
          queue.splice(i, 1);
          runJob(lane, job);
          break;
        }
      }
    } while (scheduleAgain);
  } finally { scheduling = false; }
}

async function runJob(lane, job) {
  const slot = { lane, name: path.basename(job.file), mode: 'Starting', purpose: null, percent: 0, speed: null, eta: null };
  active.set(lane, { job, slot });
  status.active.push(slot);
  try {
    if (job.retire) {
      try { await retireOriginal(job.file, slot); }
      catch (e) { console.warn(`[convert] couldn’t delete ${path.basename(job.file)}: ${e.message}`); }
      return;
    }
    await makeRoom(job);
    await convert(job, slot);
    status.done += 1;
    console.log(`[convert] done: ${path.basename(job.file)}${job.h264 ? ' (H.264 browser copy)' : job.fix ? ' (browser copy)' : ''}`);
    onConvertedHook?.();
    if (!job.fix) convertSoon(); // a new MP4 copy may still need its H.264 browser copy (browserH264Job)
  } catch (e) {
    if (e.lowSpace) return; // logged once by makeRoom; the next scan queues it again
    if (e.retryLater) { console.warn(`[convert] ${path.basename(job.file)}: ${e.message?.includes('earlier') ? e.message : 'copy is in use'}, will retry.`); return; }
    const msg = e.message || String(e);
    console.warn(`[convert] failed: ${path.basename(job.file)}: ${msg}`);
    failures[failureKey(job.file)] = { error: msg, at: Date.now() };
    saveFailures();
    failureFiles.set(msg + path.basename(job.file), job.file);
    status.recentFailures = [{ name: path.basename(job.file), error: msg }, ...status.recentFailures].slice(0, 5);
  } finally {
    active.delete(lane);
    status.active = status.active.filter((x) => x !== slot);
    drain();
  }
}

// Look for new files soon instead of at the next two-minute round (a downloaded episode just finished).
let scanNow = null, scanSoonTimer = null;
export function convertSoon() {
  if (!scanNow || scanSoonTimer) return;
  scanSoonTimer = setTimeout(() => { scanSoonTimer = null; scanNow(); }, 3000);
}

// listCandidates(): Promise<[{ file, deleteOriginal }] | null>
// null means the inventory is temporarily unavailable; skip the whole scan, including destructive cache cleanup.
export async function startConverter({ dataDir, cacheDir = path.join(dataDir, 'cache'), listCandidates, onConverted, onSidecar, scratchDir: scratch = null, scratchRoom = null }) {
  onSidecarHook = onSidecar || null;
  scratchDir = scratch && scratchRoom ? path.resolve(scratch) : null;
  scratchRoomFn = scratchRoom;
  const audioRoot = process.env.AUDIO_FIX_DIR ? path.resolve(process.env.AUDIO_FIX_DIR) : path.join(cacheDir, 'audio');
  audioTrackDir = path.join(audioRoot, 'tracks');
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
  fixDir = audioRoot;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (saved.failures) {
      failures = saved.failures;
      audioChecked = Object.fromEntries(Object.entries(saved.audioChecked || {}).filter(([k]) => k.startsWith(CHECK_VERSION)));
      syncShift = saved.syncShift || {};
      syncApplied = saved.syncApplied || {};
      pendingDeletes = saved.pendingDeletes || [];
      copyUsed = saved.copyUsed || {};
      // Earlier versions recorded a locked original as a failed conversion although its copy was made.
      for (const [key, f] of Object.entries(failures)) {
        const file = key.split('|')[0];
        if (!/EBUSY|resource busy|locked/i.test(f.error || '') || !fs.existsSync(twinPath(file))) continue;
        delete failures[key];
        if (fs.existsSync(file) && !pendingDeletes.includes(file)) pendingDeletes.push(file);
      }
    } else failures = saved;
  } catch { failures = {}; }
  onConvertedHook = onConverted;
  status.enabled = true;
  status.reason = null;

  const tick = async () => {
    retryDeletes();
    try {
      const candidates = await listCandidates();
      if (candidates == null) return; // unknown inventory: preserve cached browser copies and retry next scan
      cleanTemps(candidates);
      for (const c of candidates) {
        if (!needsConversion(c.file) || isTempFile(c.file)) continue;
        if (failures[failureKey(c.file)]) continue; // failed before; retried only if the file changes
        if (isActive(c.file) || queue.some((q) => q.file === c.file)) continue;
        if (fs.existsSync(twinPath(c.file))) {
          if (await audioNeedsFix(twinPath(c.file))) queue.push({ ...c, deleteOriginal: false, redo: true });
          // A copy made while qBittorrent still had the download: delete the original now that it's gone.
          else if (c.deleteOriginal && !pendingDeletes.includes(c.file) && !retireSkipped.has(failureKey(c.file))) {
            queue.push({ file: c.file, retire: true });
          }
          continue;
        }
        queue.push(c);
      }
      // Downloaded MP4s with browser-incompatible audio.
      const keep = new Set();
      for (const c of candidates) { // H.264 browser copies of MP4 copies
        const twin = needsConversion(c.file) && twinPath(c.file);
        const fixed = twin && fixPath(twin);
        if (!fixed) continue;
        keep.add(path.basename(fixed)).add(path.basename(h264Path(twin)));
        if (!fs.existsSync(twin)) continue;
        await moveOldH264Copy(twin); // a twin's fix copy was only ever its H.264 copy
        const job = await browserH264Job(twin, c.file);
        if (job) queue.push(job);
      }
      for (const c of candidates) {
        if (!canFix(c.file) || originalFor(c.file)) continue;
        const fixed = fixPath(c.file);
        if (!fixed) continue;
        keep.add(path.basename(fixed)).add(path.basename(h264Path(c.file)));
        await moveOldH264Copy(c.file);
        const h264 = await browserH264Job(c.file, c.file); // runs beside the audio fix below (another lane)
        if (h264) queue.push(h264);
        if (fs.existsSync(fixed) || failures[failureKey(c.file)]) continue;
        if (hasJob(c.file, 'fix')) continue;
        if (await audioNeedsFix(c.file)) queue.push({ file: c.file, fix: true });
      }
      cleanFixDir(keep);
      await makeRoom(null).catch(() => {}); // a lowered BROWSER_COPIES_MAX_GB takes effect without new copies
      drain(onConverted);
    } catch (e) {
      console.warn(`[convert] scan failed: ${e.message}`);
    }
  };
  scanNow = tick;
  setTimeout(tick, 5000);
  setInterval(tick, INTERVAL_MS).unref(); // the HTTP server keeps the process alive, not this
}
