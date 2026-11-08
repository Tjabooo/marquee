// Download to phone: small "travel" copies of videos for watching offline (a flight, a cabin).
//
// A travel copy is a plain H.264 + stereo AAC MP4 at 480p (Small) or 720p (Standard), with the subtitles
// saved beside the video built in as tracks, and the index at the front, so it plays in the phone's own
// Files / Photos / Downloads app, VLC or any browser without Marquee. HDR is tone-mapped to SDR (phones
// show HDR files washed out when they can't play them as HDR). Copies are made on request, one at a
// time below normal priority, NVENC when the GPU has it, else x264, and kept in cache/travel/ until
// nobody has asked for them in TRAVEL_KEEP_DAYS. TRAVEL_MAX_GB caps the folder: the oldest copies that
// were already downloaded make room first.
//
// Each person has their own list (table travel in .marquee.db): what they asked for, in which size,
// and when they last downloaded it. Copies are shared: two people asking for the same episode in the
// same size get one file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { trackChild } from './load.js';
import { background } from './priority.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const VERSION = 1; // bump when the encode changes, so old copies are remade
const DAY = 24 * 3600 * 1000;
export const MAX_PER_PERSON = 60;
const MAX_AUDIO = 3;
const MAX_SUBS = 8;

// kbps. maxrate keeps busy scenes from blowing up the size; the estimate assumes the average.
export const QUALITIES = {
  small: { label: 'Small', height: 480, video: 900, max: 1500, audio: 96, note: 'For a phone screen' },
  standard: { label: 'Standard', height: 720, video: 2200, max: 3500, audio: 128, note: 'Sharp on a tablet or laptop' },
};
export const validQuality = (q) => Object.hasOwn(QUALITIES, String(q));

// Bytes for `duration` seconds; extra audio tracks are counted (subtitles are a few hundred KB).
export function estimateBytes(duration, quality, audioTracks = 1) {
  const q = QUALITIES[quality];
  if (!q || !(duration > 0)) return null;
  const kbps = q.video + q.audio * Math.max(1, Math.min(MAX_AUDIO, audioTracks));
  return Math.round((kbps * 1000 / 8) * duration * 1.02); // +2% container
}

// ISO 639-1 → 639-2 for the MP4 language tags (players show "English", not "Track 2").
const ISO2TO3 = {
  en: 'eng', sv: 'swe', da: 'dan', no: 'nor', nb: 'nor', nn: 'nor', fi: 'fin', is: 'isl', de: 'ger', nl: 'dut', fr: 'fre',
  es: 'spa', it: 'ita', pl: 'pol', cs: 'cze', sk: 'slo', hu: 'hun', ro: 'rum', el: 'gre', tr: 'tur', ru: 'rus', uk: 'ukr',
  bg: 'bul', hr: 'hrv', sr: 'srp', sl: 'slv', et: 'est', lv: 'lav', lt: 'lit', ar: 'ara', he: 'heb', fa: 'per', hi: 'hin',
  th: 'tha', vi: 'vie', id: 'ind', ms: 'may', ja: 'jpn', ko: 'kor', pt: 'por', 'pt-br': 'por', 'pt-pt': 'por', zh: 'chi',
  'zh-cn': 'chi', 'zh-tw': 'chi', ka: 'geo', tl: 'tgl',
};
export const lang3 = (code) => ISO2TO3[String(code || '').toLowerCase()] || (/^[a-z]{3}$/.test(String(code)) ? String(code) : 'und');

// "Title S01E02 · Small.mp4" without characters phones or Windows refuse in file names.
export function travelName(title, quality) {
  const clean = String(title || 'Video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Video';
  const height = QUALITIES[quality]?.height;
  return height ? `${clean} (${height}p).mp4` : `${clean}.mp4`;
}

export const isHdr = (v) => /smpte2084|arib-std-b67/.test(String(v?.color_transfer || ''));

// Audio worth carrying: the default track first, then other languages (no commentaries), at most 3.
export function pickAudio(streams) {
  const audios = (streams || []).filter((s) => s.codec_type === 'audio');
  const main = audios.find((a) => a.disposition?.default) || audios[0];
  if (!main) return [];
  const out = [main];
  const langs = new Set([main.tags?.language || 'und']);
  for (const a of audios) {
    if (out.length >= MAX_AUDIO) break;
    const l = a.tags?.language || 'und';
    if (a === main || langs.has(l) || /comment/i.test(a.tags?.title || '') || a.disposition?.comment) continue;
    langs.add(l);
    out.push(a);
  }
  return out;
}

// The video filter: never upscale, square pixels, even sizes; HDR tone-mapped to SDR BT.709 when the
// ffmpeg build has zscale (scaled first, so tone mapping works on the small frame).
export function videoFilter(video, quality, { tonemap = true } = {}) {
  const H = QUALITIES[quality].height;
  const scale = `scale='trunc(min(${H},ih)*dar/2+0.5)*2':'trunc(min(${H},ih)/2)*2':flags=bicubic,setsar=1`;
  if (!tonemap || !isHdr(video)) return `${scale},format=yuv420p`;
  const tin = video.color_transfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
  return `${scale},zscale=tin=${tin}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,`
    + 'zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
}

// ffmpeg arguments for one travel copy. subs: [{ path, lang }] (SRT files beside the video).
export function travelArgs({ input, output, info, quality, encoder = 'x264', tonemap = true, hwaccel = false, subs = [], title = '' }) {
  const q = QUALITIES[quality];
  const streams = info?.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('No video stream found.');
  const audios = pickAudio(streams);
  const keptSubs = subs.slice(0, MAX_SUBS);
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (hwaccel) args.push('-hwaccel', 'auto');
  args.push('-i', input);
  for (const s of keptSubs) args.push('-i', s.path);
  args.push('-map', `0:${video.index}`);
  for (const a of audios) args.push('-map', `0:${a.index}`);
  keptSubs.forEach((_, i) => args.push('-map', `${i + 1}:0`));
  args.push('-map_metadata', '-1', '-map_chapters', '0', '-vf', videoFilter(video, quality, { tonemap }));
  args.push(...(encoder === 'nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-b:v', `${q.video}k`, '-maxrate', `${q.max}k`,
      '-bufsize', `${q.max * 2}k`, '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32']
    : ['-c:v', 'libx264', '-preset', 'faster', '-crf', quality === 'small' ? '25' : '23', '-maxrate', `${q.max}k`, '-bufsize', `${q.max * 2}k`]),
  '-profile:v', 'high', '-g', '240', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  audios.forEach((a, i) => {
    args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, `${q.audio}k`, `-ac:a:${i}`, '2', `-metadata:s:a:${i}`, `language=${a.tags?.language || 'und'}`,
      `-disposition:a:${i}`, i === 0 ? 'default' : '0');
  });
  keptSubs.forEach((s, i) => args.push(`-c:s:${i}`, 'mov_text', `-metadata:s:s:${i}`, `language=${lang3(s.lang)}`, `-disposition:s:${i}`, '0'));
  if (title) args.push('-metadata', `title=${title}`);
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', output);
  return args;
}

// out_time_us / out_time_ms (both microseconds in ffmpeg) from -progress output.
export function progressSeconds(chunk) {
  let secs = null;
  for (const m of String(chunk).matchAll(/out_time_(?:us|ms)=(\d+)/g)) secs = Number(m[1]) / 1e6;
  return secs;
}

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return reject(new Error('Couldn’t read this video.'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Couldn’t read this video.')); }
      });
  });
}

export function capabilities() {
  const list = (flag) => new Promise((resolve) => execFile(FFMPEG, ['-hide_banner', flag], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    (error, stdout) => resolve(error ? '' : String(stdout))));
  return Promise.all([list('-encoders'), list('-filters')]).then(([enc, filt]) => ({
    ffmpeg: Boolean(enc), nvenc: /\bh264_nvenc\b/.test(enc), x264: /\blibx264\b/.test(enc), zscale: /\bzscale\b/.test(filt) && /\btonemap\b/.test(filt),
  }));
}

const lastError = (s) => {
  const lines = String(s).trim().split(/\r?\n/).filter((l) => l && !/^Conversion failed/i.test(l));
  return lines.reverse().find((l) => /error|invalid|cannot|could not|not supported|no such|denied|failed/i.test(l)) || lines[0] || 'ffmpeg failed';
};

export class TravelStore {
  // resolve(kind, id) → { source, subs: [{ lang, read() → SRT text }] } for the file to copy; throws if it's gone.
  constructor({ dataDir, dir, resolve, keepDays = 7, maxBytes = 50 * 1024 ** 3, onChange = () => {}, onReady = () => {}, now = () => Date.now() }) {
    this.dir = dir;
    this.resolve = resolve;
    this.keepDays = keepDays;
    this.maxBytes = maxBytes;
    this.onChange = onChange;  // (userIds) a copy started, moved on or finished
    this.onReady = onReady;    // (userIds, row) a copy can be downloaded
    this.now = now;
    this.jobs = new Map();     // copy key -> { state: 'queued'|'making', percent, error }
    this.failed = new Map();   // copy key -> error (until asked again)
    this.queue = [];
    this.running = false;
    this.caps = null;
    this.child = null;
    this.db = new DatabaseSync(path.join(dataDir, '.marquee.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS travel (
        user_id INTEGER NOT NULL, kind TEXT NOT NULL, media_id TEXT NOT NULL, quality TEXT NOT NULL,
        title TEXT NOT NULL, copy_key TEXT NOT NULL, duration REAL, audio INTEGER NOT NULL DEFAULT 1,
        requested_at INTEGER NOT NULL, downloaded_at INTEGER,
        PRIMARY KEY (user_id, kind, media_id, quality));`);
    fs.mkdirSync(dir, { recursive: true });
    this.cleanTemps();
  }

  filePath(key) { return path.join(this.dir, `${key}.mp4`); }

  // One key per source version and size: a replaced file (new download, new MP4 copy) gets a new copy.
  static keyFor(source, quality) {
    const st = fs.statSync(source);
    return crypto.createHash('sha1').update(`${VERSION}|${source}|${st.size}|${Math.round(st.mtimeMs)}|${quality}`).digest('hex').slice(0, 24);
  }

  ready(key) {
    try { const st = fs.statSync(this.filePath(key)); return st.size > 0 ? st.size : 0; } catch { return 0; }
  }

  // ready | making | queued | failed | none, with percent and size.
  copyState(key) {
    const size = this.ready(key);
    if (size) return { state: 'ready', size };
    const job = this.jobs.get(key);
    if (job) return { state: job.state, percent: job.percent ?? null };
    if (this.failed.has(key)) return { state: 'failed', error: this.failed.get(key) };
    return { state: 'none' };
  }

  rowsFor(userId) {
    return this.db.prepare('SELECT * FROM travel WHERE user_id = ? ORDER BY requested_at DESC').all(userId);
  }

  row(userId, kind, id, quality) {
    return this.db.prepare('SELECT * FROM travel WHERE user_id = ? AND kind = ? AND media_id = ? AND quality = ?').get(userId, kind, id, quality) || null;
  }

  // What the Download to phone sheet shows for one video.
  async options(kind, id) {
    const { source } = await this.resolve(kind, id);
    let info = null;
    try { info = await probe(source); } catch { /* sizes unknown */ }
    const duration = Number(info?.format?.duration) || null;
    const audio = pickAudio(info?.streams).length || 1;
    const qualities = Object.entries(QUALITIES).map(([quality, q]) => {
      const key = TravelStore.keyFor(source, quality);
      return { quality, label: q.label, height: q.height, note: q.note, estimate: estimateBytes(duration, quality, audio), key, ...this.copyState(key) };
    });
    return { duration, qualities };
  }

  // Ask for a copy (or several, a season). Each item: { kind, id, title }. Returns the rows made.
  async request(userId, items, quality) {
    if (!validQuality(quality)) throw Object.assign(new Error('Choose Small or Standard.'), { status: 400 });
    const have = this.db.prepare('SELECT COUNT(*) AS n FROM travel WHERE user_id = ?').get(userId).n;
    const fresh = items.filter((it) => !this.row(userId, it.kind, it.id, quality)).length;
    if (have + fresh > MAX_PER_PERSON) {
      throw Object.assign(new Error(`You can keep ${MAX_PER_PERSON} phone copies at a time. Remove some you’ve finished with first.`), { status: 409 });
    }
    const out = [];
    for (const it of items) {
      const { source } = await this.resolve(it.kind, it.id);
      const key = TravelStore.keyFor(source, quality);
      const title = String(it.title || path.basename(source, path.extname(source))).replace(/\s+/g, ' ').trim().slice(0, 160);
      this.db.prepare(`INSERT INTO travel (user_id, kind, media_id, quality, title, copy_key, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, kind, media_id, quality) DO UPDATE SET title = excluded.title, copy_key = excluded.copy_key, requested_at = excluded.requested_at`)
        .run(userId, it.kind, it.id, quality, title, key, this.now());
      this.failed.delete(key); // asking again retries
      if (!this.ready(key)) this.enqueue({ key, kind: it.kind, id: it.id, quality, title });
      out.push(this.row(userId, it.kind, it.id, quality));
    }
    this.drain();
    return out;
  }

  remove(userId, kind, id, quality) {
    this.db.prepare('DELETE FROM travel WHERE user_id = ? AND kind = ? AND media_id = ? AND quality = ?').run(userId, kind, id, quality);
    this.sweep();
  }

  markDownloaded(userId, key) {
    this.db.prepare('UPDATE travel SET downloaded_at = ? WHERE user_id = ? AND copy_key = ?').run(this.now(), userId, key);
  }

  // The person's row for a copy key (downloads are only for copies you asked for).
  rowByKey(userId, key) {
    return this.db.prepare('SELECT * FROM travel WHERE user_id = ? AND copy_key = ?').get(userId, key) || null;
  }

  usersOf(key) {
    return this.db.prepare('SELECT DISTINCT user_id FROM travel WHERE copy_key = ?').all(key).map((r) => r.user_id);
  }

  enqueue(job) {
    if (this.jobs.has(job.key)) return;
    this.jobs.set(job.key, { state: 'queued', percent: null });
    this.queue.push(job);
  }

  // Requests nobody has touched in keepDays go, then copies nobody's list points at.
  sweep() {
    const cutoff = this.now() - this.keepDays * DAY;
    this.db.prepare('DELETE FROM travel WHERE MAX(requested_at, COALESCE(downloaded_at, 0)) < ?').run(cutoff);
    const wanted = new Set(this.db.prepare('SELECT DISTINCT copy_key FROM travel').all().map((r) => r.copy_key));
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const f of files) {
      const m = f.match(/^([a-f0-9]{24})\.mp4$/);
      if (m && !wanted.has(m[1]) && !this.jobs.has(m[1])) fs.rm(path.join(this.dir, f), { force: true }, () => {});
    }
    // A request removed while its copy waits in the queue: drop the job too.
    this.queue = this.queue.filter((j) => wanted.has(j.key) || (this.jobs.delete(j.key), false));
  }

  // Frees space for `need` bytes under maxBytes: copies everyone already downloaded, oldest first.
  makeRoom(need) {
    const sizes = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      const m = f.match(/^([a-f0-9]{24})\.mp4$/);
      if (m) { try { sizes.set(m[1], fs.statSync(path.join(this.dir, f)).size); } catch { /* gone */ } }
    }
    let used = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (used + need <= this.maxBytes) return true;
    const done = this.db.prepare(`SELECT copy_key, MIN(COALESCE(downloaded_at, 0)) AS got, MAX(requested_at) AS asked
      FROM travel GROUP BY copy_key HAVING got > 0 ORDER BY asked`).all();
    for (const r of done) {
      if (!sizes.has(r.copy_key)) continue;
      fs.rmSync(this.filePath(r.copy_key), { force: true });
      used -= sizes.get(r.copy_key);
      if (used + need <= this.maxBytes) return true;
    }
    return used + need <= this.maxBytes;
  }

  cleanTemps() {
    try { for (const f of fs.readdirSync(this.dir)) if (/\.part\.(mp4|srt)$/.test(f)) fs.rmSync(path.join(this.dir, f), { force: true }); } catch { /* none */ }
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      this.caps ||= await capabilities();
      while (this.queue.length) {
        const job = this.queue.shift();
        const users = this.usersOf(job.key);
        if (!users.length) { this.jobs.delete(job.key); continue; }
        try {
          await this.make(job, users);
          this.jobs.delete(job.key);
          const rows = this.db.prepare('SELECT * FROM travel WHERE copy_key = ?').all(job.key);
          this.onChange(users);
          if (rows.length) this.onReady(rows.map((r) => r.user_id), rows[0]);
        } catch (e) {
          this.jobs.delete(job.key);
          this.failed.set(job.key, e.message || String(e));
          console.warn(`[travel] ${job.title}: ${e.message || e}`);
          this.onChange(users);
        }
      }
    } finally { this.running = false; }
  }

  async make(job, users) {
    const state = this.jobs.get(job.key);
    state.state = 'making';
    state.percent = 0;
    this.onChange(users);
    const { source, subs: found = [] } = await this.resolve(job.kind, job.id);
    const info = await probe(source);
    // Subtitles are rewritten as UTF-8 (saved files come in all sorts of encodings).
    const subs = [];
    for (const s of found.slice(0, MAX_SUBS)) {
      try {
        const file = path.join(this.dir, `${job.key}.${s.lang}.part.srt`);
        await fsp.writeFile(file, await s.read());
        subs.push({ path: file, lang: s.lang });
      } catch { /* left out */ }
    }
    const duration = Number(info.format?.duration) || null;
    const audio = pickAudio(info.streams).length || 1;
    this.db.prepare('UPDATE travel SET duration = ?, audio = ? WHERE copy_key = ?').run(duration, audio, job.key);
    const estimate = estimateBytes(duration, job.quality, audio) || 0;
    if (!this.makeRoom(Math.round(estimate * 1.3))) {
      throw new Error(`Phone copies are full (${Math.round(this.maxBytes / 1024 ** 3)} GB). Remove some, or the server’s owner can raise TRAVEL_MAX_GB.`);
    }
    if (!this.caps.ffmpeg) throw new Error('ffmpeg isn’t installed on the server.');
    const tmp = path.join(this.dir, `${job.key}.part.mp4`);
    const out = this.filePath(job.key);
    // Fastest first; a GPU or decoder hiccup falls back to plain software.
    const attempts = [];
    if (this.caps.nvenc) attempts.push({ encoder: 'nvenc', hwaccel: true }, { encoder: 'nvenc', hwaccel: false });
    attempts.push({ encoder: this.caps.x264 || !this.caps.nvenc ? 'x264' : 'nvenc', hwaccel: false });
    let last = null;
    try {
      for (const a of attempts) {
        const args = travelArgs({ input: source, output: tmp, info, quality: job.quality, subs, title: job.title, tonemap: this.caps.zscale, ...a });
        try {
          await this.run(args, duration, (pct) => {
            if (pct - (state.percent || 0) >= 2 || pct >= 100) { state.percent = pct; this.onChange(users); }
          });
          await fsp.rename(tmp, out);
          return;
        } catch (e) {
          last = e;
          await fsp.rm(tmp, { force: true }).catch(() => {});
        }
      }
    } finally {
      for (const sub of subs) fsp.rm(sub.path, { force: true }).catch(() => {});
    }
    throw last;
  }

  run(args, duration, onPercent) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(FFMPEG, args, { windowsHide: true }); } catch (e) { return reject(e); }
      this.child = child;
      trackChild(child, FFMPEG, args, 'travel');
      background(child);
      let err = '';
      child.stdout.on('data', (d) => {
        const secs = progressSeconds(d);
        if (secs != null && duration) onPercent(Math.min(99, Math.round((secs / duration) * 100)));
      });
      child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      child.on('error', reject);
      child.on('close', (code) => {
        this.child = null;
        if (code === 0) { onPercent(100); resolve(); } else reject(new Error(lastError(err)));
      });
    });
  }

  stop() { try { this.child?.kill(); } catch { /* gone */ } }

  // Startup: copies that were waiting when the server stopped are queued again.
  resume() {
    this.sweep();
    for (const r of this.db.prepare('SELECT * FROM travel ORDER BY requested_at').all()) {
      if (!this.ready(r.copy_key)) this.enqueue({ key: r.copy_key, kind: r.kind, id: r.media_id, quality: r.quality, title: r.title });
    }
    this.drain();
  }
}
