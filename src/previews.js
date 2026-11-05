// Timeline previews: the small frames the player shows above the seek bar while you hover it.
// One background ffmpeg pass per video decodes only keyframes (-skip_frame nokey, so even a 4K
// film is a minute or two, a clip a few seconds), keeps one at least every `step` seconds and tiles
// them into 5x5 JPEG sheets in cache/previews/<key>/. The player reads index.json (frame times and
// how many sheets exist) and the sheets as they appear, so a long film fills in while it plays.
// One pass runs at a time, below normal priority, newest request first.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { trackChild } from './load.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const VERSION = 1;
export const COLS = 5;
export const ROWS = 5;
const PER_SHEET = COLS * ROWS;
const WIDTH = 240; // frame width in the sheet; the player shows it at up to 200 CSS px
const MAX_FRAMES = 900; // a 2 h film gets a frame every 8 s at most
const KEEP_DAYS = 30;
const RETRY_FAILED_MS = 24 * 3600 * 1000;
const MAX_QUEUE = 20;

// Seconds between kept frames: every keyframe for short videos, fewer for long ones.
export const stepFor = (duration) => Math.max(1, Math.round(((Number(duration) || 0) / MAX_FRAMES) * 10) / 10);

// "... showinfo ... n:  12 pts: 123 pts_time:5.005 ... s:240x136 ..." → { time, w, h }
export function parseShowinfo(line) {
  if (!/showinfo/.test(line) || !/\bn:\s*\d+/.test(line)) return null;
  const t = line.match(/pts_time:\s*(-?[\d.]+)/);
  if (!t) return null;
  const s = line.match(/\bs:\s*(\d+)x(\d+)/);
  return { time: Math.max(0, Number(t[1])), w: s ? Number(s[1]) : null, h: s ? Number(s[2]) : null };
}

export function ffmpegArgs(file, outDir, step) {
  const select = `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${step})'`;
  return ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-y',
    '-skip_frame', 'nokey', '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `${select},scale=${WIDTH}:'max(2,trunc(${WIDTH}/dar/2)*2)':flags=bilinear,setsar=1,showinfo,tile=${COLS}x${ROWS},format=yuvj420p`,
    '-fps_mode', 'vfr', '-q:v', '5', '-start_number', '0', path.join(outDir, '%d.jpg')];
}

function probeDuration(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 10000, windowsHide: true }, (error, stdout) => {
        const d = Number(String(stdout || '').trim());
        resolve(!error && Number.isFinite(d) && d > 0 ? d : null);
      });
  });
}

export class Previews {
  constructor(dir) {
    this.dir = dir;
    this.jobs = new Map(); // key -> { key, file, out, state, times, w, h, step, sheets }
    this.queue = []; // keys waiting, newest first
    this.running = null;
    this.touched = new Set();
    this.cleanup().catch(() => {});
    setInterval(() => this.cleanup().catch(() => {}), 24 * 3600 * 1000).unref();
  }

  async keyFor(file) {
    const st = await fsp.stat(file);
    return crypto.createHash('sha1').update(`${VERSION}|${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 24);
  }

  // What the player needs: frame times, sheet layout and how many sheets are ready. Starts the
  // pass if this video has none yet.
  async index(file) {
    const key = await this.keyFor(file);
    const out = path.join(this.dir, key);
    const job = this.jobs.get(key);
    if (job) {
      if (job.state === 'queued') this.bump(key);
      return this.view(job);
    }
    try {
      const saved = JSON.parse(await fsp.readFile(path.join(out, 'index.json'), 'utf8'));
      if (saved.v === VERSION && (saved.done || (saved.failed && Date.now() - saved.at < RETRY_FAILED_MS))) {
        if (!this.touched.has(key)) { this.touched.add(key); fsp.utimes(path.join(out, 'index.json'), new Date(), new Date()).catch(() => {}); }
        return { key, ...saved };
      }
    } catch { /* not made yet */ }
    const fresh = { key, file, out, state: 'queued', times: [], w: null, h: null, step: null, sheets: 0 };
    this.jobs.set(key, fresh);
    this.bump(key);
    this.next();
    return this.view(fresh);
  }

  view(job) {
    return { key: job.key, v: VERSION, done: false, state: job.state, cols: COLS, rows: ROWS, w: job.w, h: job.h,
      step: job.step, sheets: job.sheets, times: job.times.slice(0, job.sheets * PER_SHEET) };
  }

  bump(key) {
    this.queue = [key, ...this.queue.filter((k) => k !== key)];
    for (const k of this.queue.splice(MAX_QUEUE)) this.jobs.delete(k);
  }

  // Path of sheet n of a video, or null while it isn't written yet.
  async sheet(file, n) {
    if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
    const key = await this.keyFor(file);
    const job = this.jobs.get(key);
    if (job && n >= job.sheets) return null;
    const p = path.join(this.dir, key, `${n}.jpg`);
    return fs.existsSync(p) ? p : null;
  }

  async next() {
    if (this.running || !this.queue.length) return;
    const key = this.queue.shift();
    const job = this.jobs.get(key);
    if (!job) { this.next(); return; }
    this.running = job;
    job.state = 'working';
    try { await this.make(job); } catch (err) { console.error(`timeline previews: ${path.basename(job.file)}: ${err.message}`); }
    this.jobs.delete(key);
    this.running = null;
    this.next();
  }

  async make(job) {
    await fsp.rm(job.out, { recursive: true, force: true });
    await fsp.mkdir(job.out, { recursive: true });
    const duration = await probeDuration(job.file);
    job.step = stepFor(duration);
    const args = ffmpegArgs(job.file, job.out, job.step);
    const ok = await new Promise((resolve) => {
      const child = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      trackChild(child, FFMPEG, args, 'previews');
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* keep default */ }
      let rest = '';
      let tail = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) {
          const f = parseShowinfo(line);
          if (!f) { if (line.trim()) tail = line.trim(); continue; }
          job.times.push(Math.round(f.time * 1000) / 1000);
          if (f.w && !job.w) { job.w = f.w; job.h = f.h; }
          // A sheet is surely on disk once the one after it is full too.
          job.sheets = Math.max(job.sheets, Math.floor(job.times.length / PER_SHEET) - 1);
        }
      });
      child.on('error', (err) => { tail = err.message; resolve(false); });
      child.on('close', (code) => { if (code !== 0) console.error(`timeline previews: ffmpeg ${code}: ${tail}`); resolve(code === 0); });
    });
    const sheets = Math.ceil(job.times.length / PER_SHEET);
    const done = ok && job.times.length > 0 && job.w && fs.existsSync(path.join(job.out, `${sheets - 1}.jpg`));
    const saved = done
      ? { v: VERSION, done: true, cols: COLS, rows: ROWS, w: job.w, h: job.h, step: job.step, sheets, times: job.times }
      : { v: VERSION, done: false, failed: true, at: Date.now() };
    if (!done) await fsp.rm(job.out, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(job.out, { recursive: true });
    await fsp.writeFile(path.join(job.out, 'index.json'), JSON.stringify(saved));
  }

  // Storyboards nobody opened for KEEP_DAYS go, and so do half-made ones from an earlier run.
  async cleanup() {
    let names;
    try { names = await fsp.readdir(this.dir); } catch { return; }
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of names) {
      if (!/^[a-f0-9]{24}$/.test(name) || this.jobs.has(name)) continue;
      const dir = path.join(this.dir, name);
      let st = null;
      try { st = await fsp.stat(path.join(dir, 'index.json')); } catch { /* half-made */ }
      if (!st || st.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
