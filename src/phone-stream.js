// Lighter quality for phones: a live HLS stream of a big video at 1080p or 720p. The original file is
// never touched or copied. ffmpeg turns the part being watched into 4-second H.264 + stereo AAC pieces
// in a temporary folder, a few minutes ahead of the player at most, and they are deleted again soon.
//
// The playlist lists every piece of the whole video up front (a normal VOD playlist), so the player knows
// the duration and seeks natively. Piece n always covers [n*4, n*4+4) s: ffmpeg starts at a piece's start
// (-ss) with keyframes forced every 4 s and its timestamps shifted back onto the video's own timeline
// (-output_ts_offset), so pieces made by different runs fit together. A seek outside what is being made
// restarts ffmpeg at the wanted piece (about a second on a 4K HEVC film).
//
// Measured on the server (i5-14600KF, GTX 1650, CPU decode + NVENC): a 2160p HEVC film at ~10x realtime.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isHdr, capabilities } from './travel.js';
import { trackChild } from './load.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
export const SEGMENT = 4; // seconds per piece
const AHEAD = 75;          // pieces (5 min) made ahead of the player before ffmpeg is stopped
const BEHIND = 30;         // pieces (2 min) kept behind the player for short rewinds
const JUMP = 6;            // a request this far past what ffmpeg is making restarts it there
const STOP_IDLE_MS = 90_000;       // nobody asked for a piece: stop ffmpeg (a paused player)
const DROP_IDLE_MS = 20 * 60_000;  // ...and forget the session and its pieces
const WAIT_MS = 45_000;
const MAX_RUNNING = Math.max(1, Number(process.env.PHONE_STREAMS_MAX) || 3);

// kbps. Phones: 1080p is plenty sharp; 720p is the data saver.
export const QUALITIES = {
  1080: { height: 1080, cq: 23, video: 6000, max: 10000, audio: 160 },
  720: { height: 720, cq: 25, video: 2500, max: 4000, audio: 128 },
};
export const validQuality = (q) => Object.hasOwn(QUALITIES, String(q));

// What counts as "too heavy for a phone": above 1080p, or a bitrate that stutters on mobile data.
export const HEAVY_HEIGHT = 1100;
export const HEAVY_BITS = 25_000_000;
export const isHeavy = (info) => Boolean(info && ((info.height || 0) > HEAVY_HEIGHT || (info.bitrate || 0) > HEAVY_BITS));

// The playlist for a video of `duration` seconds: every piece listed, so the player can seek anywhere.
// A tail under 0.4 s joins the last piece (ffmpeg may not make a piece that short).
export const pieceCount = (duration) => Math.max(1, Math.ceil(duration / SEGMENT - 0.1));
export function playlist(duration) {
  const count = pieceCount(duration);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT + 1}`, '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (let n = 0; n < count; n++) {
    const len = n === count - 1 ? duration - n * SEGMENT : SEGMENT;
    lines.push(`#EXTINF:${Math.max(0.001, len).toFixed(3)},`, segmentName(n));
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
export const segmentName = (n) => `s${String(n).padStart(5, '0')}.ts`;
export const segmentIndex = (name) => { const m = /^s(\d{5})\.ts$/.exec(name); return m ? Number(m[1]) : null; };

// Never upscale, square pixels, even sizes; HDR tone-mapped to SDR (phones get BT.709 H.264).
export function videoFilter(video, height, { tonemap = true } = {}) {
  const scale = `scale='trunc(min(${height},ih)*dar/2+0.5)*2':'trunc(min(${height},ih)/2)*2':flags=bicubic,setsar=1`;
  if (!tonemap || !isHdr(video)) return `${scale},format=yuv420p`;
  const tin = video.color_transfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
  return `${scale},zscale=tin=${tin}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,`
    + 'zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
}

// ffmpeg arguments for pieces `start`… of one stream.
export function streamArgs({ input, dir, video, audio, quality, start = 0, encoder = 'nvenc', tonemap = true }) {
  const q = QUALITIES[quality];
  const at = start * SEGMENT;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  // Tone mapping is the slow part of a 4K HDR stream: decoding on the GPU leaves it more of the CPU (13 % faster on
  // the server, same picture). A GPU that can't do it ends in the x264 fallback below, without this.
  if (encoder === 'nvenc' && tonemap && isHdr(video)) args.push('-hwaccel', 'cuda');
  if (at > 0) args.push('-ss', String(at));
  args.push('-i', input, '-map', `0:${video.index}`);
  if (audio) args.push('-map', `0:${audio.index}`);
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-vf', videoFilter(video, q.height, { tonemap }));
  args.push(...(encoder === 'nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(q.cq), '-b:v', `${q.video}k`, '-forced-idr', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.cq)]),
  '-maxrate', `${q.max}k`, '-bufsize', `${q.max * 2}k`, '-profile:v', 'high',
  '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT})`);
  if (isHdr(video) && tonemap) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  if (audio) args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', `${q.audio}k`);
  args.push('-f', 'hls', '-hls_time', String(SEGMENT), '-hls_list_size', '0', '-hls_flags', 'temp_file',
    '-hls_segment_type', 'mpegts', '-start_number', String(start), '-output_ts_offset', String(at),
    '-hls_segment_filename', path.join(dir, 's%05d.ts'), path.join(dir, 'ffmpeg.m3u8'));
  return args;
}

const probeCache = new Map();
function runProbe(input, { size, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return reject(new Error('Couldn’t read this video.'));
        try {
          const info = JSON.parse(stdout);
          const streams = info.streams || [];
          const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
          const audios = streams.filter((s) => s.codec_type === 'audio');
          const duration = Number(info.format?.duration) || Number(video?.duration) || 0;
          const bitrate = Number(info.format?.bit_rate) || (duration > 0 ? (size * 8) / duration : 0);
          if (!video || !(duration > 0)) return reject(new Error('Couldn’t read this video.'));
          resolve({ duration, height: Number(video.height) || 0, width: Number(video.width) || 0, bitrate, video, audios });
        } catch { reject(new Error('Couldn’t read this video.')); }
      });
  });
}
// The same for something ffmpeg reads over HTTP (partial-stream.js), where reads may wait for the download.
export const probeInput = runProbe;
// { duration, height, bitrate, video, audios } for a file (cached per file version).
export function probe(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return Promise.reject(Object.assign(new Error('That file is no longer on the server.'), { status: 404 })); }
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (!probeCache.has(key)) {
    if (probeCache.size > 200) probeCache.clear();
    const p = runProbe(file, { size: stat.size });
    p.catch(() => probeCache.delete(key));
    probeCache.set(key, p);
  }
  return probeCache.get(key);
}

// The audio stream to carry: the chosen stream index, else the default track, else the first.
export function pickAudio(audios, index = null) {
  if (index != null) { const chosen = audios.find((a) => a.index === index); if (chosen) return chosen; }
  return audios.find((a) => a.disposition?.default) || audios[0] || null;
}

export class PhoneStreams {
  constructor({ dir, ffmpeg = FFMPEG, spawnFn = spawn, caps = null } = {}) {
    this.dir = dir;
    this.ffmpeg = ffmpeg;
    this.spawnFn = spawnFn;
    this.sessions = new Map();
    this.caps = caps; // { nvenc, x264, zscale }; probed on first use
    this.nvencBroken = false;
    fs.rmSync(dir, { recursive: true, force: true }); // pieces from before a restart are useless
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref?.();
  }

  async capabilities() {
    if (!this.caps) this.caps = await capabilities();
    return this.caps;
  }

  // One session per play link (its signature). Same link = same session, also across pieces.
  // `info` = already probed (a file still downloading is read over HTTP, see partial-stream.js).
  async open(key, { file, quality, audioIndex = null, label = '', info: known = null }) {
    let s = this.sessions.get(key);
    if (s) { s.last = Date.now(); return s; }
    if (!validQuality(quality)) throw Object.assign(new Error('Unknown quality.'), { status: 400 });
    const info = known || await probe(file);
    s = this.sessions.get(key); // opened meanwhile
    if (s) return s;
    const safe = key.replace(/[^\w-]/g, '').slice(0, 40);
    s = {
      key, file, quality: String(quality), label, info, audio: pickAudio(info.audios, audioIndex),
      dir: path.join(this.dir, safe), proc: null, start: 0, next: 0, last: Date.now(), want: 0, error: null,
    };
    fs.mkdirSync(s.dir, { recursive: true });
    this.sessions.set(key, s);
    return s;
  }

  playlist(s) { return playlist(s.info.duration); }

  count(s) { return pieceCount(s.info.duration); }

  // The path of finished piece n, made now if needed. `patient`: for a file still downloading, the piece
  // arrives when the download reaches it, so wait for as long as the player is still asking (`signal`).
  async segment(s, n, { patient = false, signal = null } = {}) {
    if (!Number.isSafeInteger(n) || n < 0 || n >= this.count(s)) throw Object.assign(new Error('No such piece.'), { status: 404 });
    s.last = Date.now();
    s.want = n;
    const file = path.join(s.dir, segmentName(n));
    const done = () => fs.existsSync(file);
    if (done()) { this.keepAhead(s, n); return file; }
    // ffmpeg is making it (or about to): wait. Anything else: start ffmpeg right there.
    const coming = s.proc && n >= s.start && n <= s.next + JUMP;
    if (!coming) await this.restart(s, n);
    const until = Date.now() + WAIT_MS;
    let restarts = 0;
    while (!done()) {
      if (signal?.aborted) throw Object.assign(new Error('The player stopped asking for this piece.'), { status: 499 });
      if (patient) s.last = Date.now(); // waiting for the download is not an idle player
      if (s.error && !s.proc) throw Object.assign(new Error(s.error), { status: 503 });
      if (!patient && Date.now() > until) throw Object.assign(new Error('The phone-quality stream is taking too long.'), { status: 504 });
      // A seek elsewhere replaced this run, or it ended without this piece: start again for it (twice at most).
      if (!s.proc || n < s.start) {
        if (++restarts > 2) throw Object.assign(new Error('The server couldn’t make this part of the video.'), { status: 503 });
        await this.restart(s, n);
      }
      await new Promise((r) => setTimeout(r, 100));
      this.advance(s);
    }
    this.keepAhead(s, n);
    return file;
  }

  // After a request: if ffmpeg was stopped for being far enough ahead, start it again before the
  // player catches up with the last piece.
  keepAhead(s, n) {
    if (s.proc || s.error) return;
    let edge = n;
    while (edge < this.count(s) && fs.existsSync(path.join(s.dir, segmentName(edge)))) edge++;
    if (edge < this.count(s) && edge - n < AHEAD / 2) this.restart(s, edge).catch(() => {});
  }

  advance(s) {
    while (s.next < this.count(s) && fs.existsSync(path.join(s.dir, segmentName(s.next)))) s.next++;
  }

  stop(s) {
    if (!s.proc) return;
    const p = s.proc;
    s.proc = null;
    try { p.kill(); } catch { /* already gone */ }
  }

  async restart(s, n) {
    this.stop(s);
    // Too many at once (the GPU has a few encoder sessions): stop the one nobody asked for longest.
    const running = [...this.sessions.values()].filter((x) => x.proc);
    if (running.length >= MAX_RUNNING) this.stop(running.sort((a, b) => a.last - b.last)[0]);
    const caps = await this.capabilities();
    const encoder = caps.nvenc && !this.nvencBroken ? 'nvenc' : 'x264';
    const args = streamArgs({ input: s.file, dir: s.dir, video: s.info.video, audio: s.audio, quality: s.quality, start: n, encoder, tonemap: caps.zscale });
    let child;
    try { child = this.spawnFn(this.ffmpeg, args, { windowsHide: true }); } catch (e) { s.error = e.message; return; }
    s.proc = child;
    s.start = n;
    s.next = n;
    s.error = null;
    trackChild(child, this.ffmpeg, args, 'phone');
    let err = '';
    child.stderr?.on('data', (d) => { err = (err + d).slice(-2000); });
    const watch = setInterval(() => {
      if (s.proc !== child) return clearInterval(watch);
      this.advance(s);
      if (s.next - s.want > AHEAD) this.stop(s); // far enough ahead: rest until the player catches up
    }, 250);
    watch.unref?.();
    child.on('error', (e) => { if (s.proc === child) { s.proc = null; s.error = e.message; } clearInterval(watch); });
    child.on('close', (code) => {
      clearInterval(watch);
      if (s.proc !== child) return; // stopped on purpose
      s.proc = null;
      this.advance(s);
      if (code === 0) return;
      // NVENC or NVDEC missing or out of sessions: the rest goes through x264.
      if (encoder === 'nvenc' && s.next === n && /nvenc|cuda|cuvid|hwaccel|Device creation|OpenEncodeSession|No capable devices/i.test(err) && caps.x264) {
        this.nvencBroken = true;
        this.restart(s, n).catch(() => {});
        return;
      }
      if (s.next === n) s.error = 'The server couldn’t make a phone-quality version of this video.';
    });
  }

  // Stop idle runs, drop forgotten sessions, delete pieces far from the player.
  sweep(now = Date.now()) {
    for (const s of this.sessions.values()) {
      const idle = now - s.last;
      if (idle > DROP_IDLE_MS) {
        this.stop(s);
        this.sessions.delete(s.key);
        fs.rm(s.dir, { recursive: true, force: true }, () => {});
        continue;
      }
      if (idle > STOP_IDLE_MS) this.stop(s);
      let names = [];
      try { names = fs.readdirSync(s.dir); } catch { continue; }
      for (const name of names) {
        const n = segmentIndex(name);
        if (n != null && (n < s.want - BEHIND || n > s.want + AHEAD * 2)) fs.rm(path.join(s.dir, name), { force: true }, () => {});
      }
    }
  }

  // For House → Sharing / stats: what is running.
  status() {
    return [...this.sessions.values()].map((s) => ({ label: s.label, quality: s.quality, running: Boolean(s.proc), at: s.want * SEGMENT }));
  }

  close() {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) this.stop(s);
  }
}
