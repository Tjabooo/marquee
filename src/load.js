// Load: what sharing costs the server. Every video going out (who, what, over the internet or the
// home network, how fast versus what the file needs), every ffmpeg job (clip share copies,
// conversions, previews, subtitle sync, image text), and the machine underneath: CPU, GPU/NVENC,
// network, the drives the media lives on, and what else is busy. Kept as a day of per-minute history
// so a bad evening can be looked at afterwards.
//
// Shown in House → Sharing, and read by Archfleet and other home machines through
// GET /api/house/load (House token, home network only).
//
// Streams themselves cost almost no CPU (Marquee sends files as they are): they cost upload and
// disk reads. CPU and the GPU's encoder go to the jobs.
import fs from 'node:fs';
import os from 'node:os';
import { background } from './priority.js';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const UPLOAD_MBPS = Number(process.env.UPLOAD_MBPS) || null;           // the internet connection's upload
const NVENC_LIMIT = Number(process.env.NVENC_SESSION_LIMIT) || 8;       // GeForce cards: 8 encodes at once
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const TICK_MS = 5000;
const STREAM_IDLE_MS = 30 * 1000;   // browsers buffer ahead then pause: a stream is over after this long quiet
const RATE_WINDOW = 10;             // seconds a "current" rate is averaged over
const HISTORY_MINUTES = 24 * 60;
const RECENT = 30;
const SAVE_MS = 5 * 60 * 1000;
const THREADS = Math.max(1, os.cpus().length);

// ---------- rates ----------
// Bytes per second over the last RATE_WINDOW whole seconds (the current second is still filling).
export class Rate {
  constructor() { this.sec = 0; this.buckets = new Float64Array(RATE_WINDOW + 1); this.total = 0; this.active = 0; }
  roll(now) {
    const s = Math.floor(now / 1000);
    if (s - this.sec > RATE_WINDOW) this.buckets.fill(0);
    else for (let t = this.sec + 1; t <= s; t++) this.buckets[t % this.buckets.length] = 0;
    if (s > this.sec) this.sec = s;
  }
  add(n, now = Date.now()) {
    this.roll(now);
    const i = this.sec % this.buckets.length;
    if (!this.buckets[i]) this.active++; // seconds in which anything was sent
    this.buckets[i] += n;
    this.total += n;
  }
  perSec(now = Date.now()) {
    this.roll(now);
    let sum = 0;
    for (let i = 0; i < this.buckets.length; i++) if (i !== this.sec % this.buckets.length) sum += this.buckets[i];
    return sum / RATE_WINDOW;
  }
}

let file = null;
let nameForIp = () => null;      // ip -> "desktop", "Living room TV", ...
let torrentRate = null;          // async () => { up, down, upLimit } bytes/s, or null without qBittorrent
let conversion = () => null;     // () => { name, percent, speed } of the running conversion
const watched = [];              // [{ label, dir }]: the drives media and clips live on

const out = { internet: new Rate(), lan: new Rate() };
const streams = new Map();       // key -> stream
const visitors = new Map();      // visitor address -> { name, at }: who an address belonged to lately
const VISITOR_MS = 12 * 3600 * 1000;
const jobs = new Map();          // pid -> job
let recent = [];                 // finished streams and jobs, newest first
let history = [];                // one entry per minute
let minute = null;               // the minute being collected
let sys = null;                  // latest machine sample: { at, cpu, net, disks, procs }
let gpu = null;                  // latest nvidia-smi reading
let torrents = null;             // latest qBittorrent reading
let torrentAsking = false;
const SUSTAINED_TICKS = 6;      // 30 s: a buffering burst is not a full line
const upRecent = [];             // internet upload (streams + torrents) at each tick
let marqueeCpu = { at: Date.now(), usage: process.cpuUsage(), pct: null };
let fallbackCpu = null;
const prevProcs = new Map();     // pid -> { cpu seconds, at }

export function initLoad({ dataDir, mediaDir, clipsDir, ipName, torrentsUp, conversionStatus, sample = process.platform === 'win32' && process.env.LOAD_SAMPLER !== 'off' } = {}) {
  file = dataDir ? path.join(dataDir, '.marquee-load.json') : null;
  if (ipName) nameForIp = ipName;
  if (torrentsUp) torrentRate = torrentsUp;
  if (conversionStatus) conversion = conversionStatus;
  watched.length = 0;
  for (const [label, dir] of [['Media', mediaDir], ['Clips', clipsDir]]) {
    const drive = dir && /^([a-z]):/i.exec(path.resolve(dir))?.[1];
    if (drive) watched.push({ label, drive: drive.toUpperCase() });
  }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const since = Date.now() - HISTORY_MINUTES * 60000;
    history = (saved.history || []).filter((m) => m.t >= since);
    recent = (saved.recent || []).slice(0, RECENT);
  } catch { /* first run */ }
  // a moment after start-up: keeps boot quick, and short-lived servers (tests) never start them
  if (sample) setTimeout(() => { startSampler(); startGpu(); }, 20000).unref();
  setInterval(tick, TICK_MS).unref();
  setInterval(save, SAVE_MS).unref();
  process.on('exit', () => { save(); stopChildren(); });
}

function save() {
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify({ history, recent })); } catch { /* kept in memory */ }
}

// ---------- streams ----------
const clean = (ip) => String(ip || '').replace(/^::ffff:/i, '').replace(/%.*$/, '').trim();
function deviceOf(ua = '') {
  const os_ = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : null;
  return [os_, browser].filter(Boolean).join(' · ') || (ua ? ua.split(/[\s/]/)[0].slice(0, 30) : null);
}

// Called for requests that carry a signed-in person, so their video requests (which may not) get a name.
export function noteVisitor(ip, name) {
  ip = clean(ip);
  if (!ip || !name) return;
  visitors.set(ip, { name, at: Date.now() });
  if (visitors.size > 500) for (const [k, v] of visitors) if (Date.now() - v.at > VISITOR_MS) visitors.delete(k);
}
const visitorName = (ip) => { const v = visitors.get(ip); return v && Date.now() - v.at < VISITOR_MS ? v.name : null; };

// Call for every file response. `who` is the person (Cloudflare Access), `tv` the TV's name when a
// cast is being served, `fromHome` a promise of whether the visitor is at home. Returns { add, done }.
export function trackStream(req, { file: f, size, label, who = null, tv = null, fromHome = null }) {
  const viaCloudflare = Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
  const ip = clean(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress);
  const where = viaCloudflare ? 'internet' : tv ? 'tv' : 'lan';
  const key = `${where}|${who || ''}|${ip}|${f}`;
  let s = streams.get(key);
  if (!s) {
    s = {
      key, where, file: f, size, label: label || path.basename(f),
      who: tv || who || visitorName(ip) || (where === 'internet' ? 'Someone (not signed in)' : nameForIp(ip) || ip),
      device: tv ? null : deviceOf(String(req.headers['user-agent'] || '')),
      fromHome: null, started: Date.now(), last: Date.now(), open: 0, rate: new Rate(), needs: null, peak: 0,
    };
    streams.set(key, s);
    Promise.resolve(fromHome).then((v) => { s.fromHome = v ?? null; }, () => {});
    bitrateOf(f, size).then((b) => { s.needs = b; }, () => {});
  }
  s.open++;
  const route = where === 'internet' ? out.internet : out.lan;
  let closed = false;
  return {
    add(n) { const now = Date.now(); s.rate.add(n, now); route.add(n, now); s.last = now; },
    done() { if (!closed) { closed = true; s.open--; s.last = Date.now(); } },
  };
}

// What a file needs to play without stopping: its average bitrate (bytes/s), from ffprobe once.
const bitrates = new Map();
function bitrateOf(f, size) {
  if (!bitrates.has(f)) {
    if (bitrates.size > 200) bitrates.clear();
    bitrates.set(f, new Promise((resolve) => {
      execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,bit_rate', '-of', 'json', f], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const fmt = JSON.parse(stdout).format || {};
          const bits = Number(fmt.bit_rate) || (Number(fmt.duration) > 0 && size ? (size * 8) / Number(fmt.duration) : 0);
          resolve(bits ? bits / 8 : null);
        } catch { resolve(null); }
      });
    }));
  }
  return bitrates.get(f);
}

// How fast a stream arrives while it's being sent. Players fetch in bursts as fast as the line allows,
// then pause once they've buffered ahead, so this is the line's speed for that viewer; pauses and
// buffering don't lower it. Below what the file needs (with a little margin) = that viewer will buffer.
const ACTIVE_ENOUGH = 20; // seconds of sending before judging
const sendingSpeed = (s) => (s.rate.active ? s.rate.total / s.rate.active : 0);
const isBehind = (s) => Boolean(s.needs) && s.rate.active >= ACTIVE_ENOUGH && sendingSpeed(s) < s.needs * 1.1;

function streamView(s, now) {
  const secs = Math.max(10, (now - s.started) / 1000); // the opening burst would make a short average meaningless
  return {
    speed: Math.round(sendingSpeed(s)), behind: isBehind(s),
    who: s.who, device: s.device, where: s.where, fromHome: s.fromHome, label: s.label,
    since: s.started, rate: Math.round(s.rate.perSec(now)), avg: Math.round(s.rate.total / secs),
    needs: s.needs == null ? null : Math.round(s.needs), sent: s.rate.total,
    // nothing sent for a while but the player still connected: it has buffered ahead (or is paused)
    waiting: now - s.last > 3000,
  };
}

// Is anyone watching right now? (A stream counts until it has been quiet for STREAM_IDLE_MS.)
export const watching = () => streams.size > 0;

// ---------- jobs (ffmpeg and friends) ----------
const base = (p) => (p ? path.basename(String(p)) : null);
// What a job is, from its command line. `area` is the module that started it.
export function describeJob(cmd, args, area) {
  const exe = base(cmd).replace(/\.exe$/i, '').toLowerCase();
  if (exe === 'ffprobe') return null; // quick reads, not worth showing
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const input = base(at('-i'));
  const output = base(args[args.length - 1]);
  const codec = at('-c:v') || at('-vcodec');
  const encoder = codec === 'libx264' ? 'x264' : /nvenc/.test(codec || '') ? 'NVENC' : codec === 'copy' ? 'copy' : codec;
  const thumb = args.includes('-frames:v');
  const kinds = {
    clips: thumb ? 'Clip thumbnail' : encoder === 'x264' || encoder === 'NVENC' ? 'Clip share copy' : 'Clip edit',
    convert: thumb ? 'Thumbnail' : args.includes('-vn') || /\.(m4a|aac|srt)$/i.test(output || '') ? 'Audio / subtitle track' : 'Conversion',
    'note-share': thumb ? 'Note preview image' : 'Note preview video',
    travel: 'Phone copy',
    phone: 'Phone-quality stream',
    subsync: exe === 'ffmpeg' ? 'Subtitle sync (audio)' : 'Subtitle sync',
    ocr: 'Image text (OCR)',
    previews: 'Timeline previews',
  };
  return {
    kind: kinds[area] || (exe === 'ffmpeg' ? 'ffmpeg' : exe),
    label: input || output || exe,
    encoder: thumb ? null : encoder || null,
  };
}

// Call right after spawning. Unknown or quick commands (ffprobe) are left out.
export function trackChild(child, cmd, args, area) {
  if (!child?.pid) return;
  const d = describeJob(cmd, args || [], area);
  if (!d) return;
  const job = { pid: child.pid, ...d, started: Date.now(), cpuSecs: 0, cpu: null, peak: 0, mem: null };
  jobs.set(child.pid, job);
  child.once('close', (code) => {
    jobs.delete(child.pid);
    const secs = (Date.now() - job.started) / 1000;
    if (secs < 2) return; // a thumbnail: gone before anyone could see it
    remember({ type: 'job', kind: job.kind, label: job.label, encoder: job.encoder, start: job.started, end: Date.now(),
      ok: code === 0, cpu: job.cpuSecs ? Math.round((100 * job.cpuSecs) / (secs * THREADS)) : null, peak: job.peak || null });
  });
}

function jobView(j, now, conv) {
  const v = { kind: j.kind, label: j.label, encoder: j.encoder, since: j.started, cpu: j.cpu, mem: j.mem, pid: j.pid };
  if (j.kind === 'Conversion' && conv?.percent != null) Object.assign(v, { percent: Math.round(conv.percent), speed: conv.speed ?? null });
  return v;
}

function remember(entry) {
  recent.unshift(entry);
  recent.length = Math.min(recent.length, RECENT);
}

// ---------- the machine (Windows: performance counters and nvidia-smi, both long-running) ----------
const children = new Set();
function stopChildren() { for (const c of children) { try { c.kill(); } catch { /* gone */ } } }

const SAMPLER = `
$ErrorActionPreference = 'SilentlyContinue'
$counters = '\\Network Interface(*)\\Bytes Sent/sec', '\\Network Interface(*)\\Bytes Received/sec',
  '\\PhysicalDisk(*)\\Disk Read Bytes/sec', '\\PhysicalDisk(*)\\Disk Write Bytes/sec', '\\PhysicalDisk(*)\\% Idle Time',
  '\\Processor Information(_Total)\\% Processor Utility'
$link = (Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Measure-Object -Property Speed -Maximum).Maximum
while ($true) {
  $c = @((Get-Counter -Counter $counters -SampleInterval ${TICK_MS / 1000} -MaxSamples 1).CounterSamples | ForEach-Object { @{ p = $_.Path; i = $_.InstanceName; v = $_.CookedValue } })
  $p = @(Get-Process | Where-Object { $_.CPU -gt 0 } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.Id, $_.ProcessName, $_.CPU, $_.WorkingSet64 })
  [Console]::Out.WriteLine((@{ c = $c; p = $p; link = $link } | ConvertTo-Json -Compress -Depth 3))
}`;

function keepRunning(name, start) {
  let backoff = 10000;
  const run = () => {
    let child;
    try { child = start(); } catch { return void setTimeout(run, (backoff = Math.min(backoff * 2, 600000))).unref(); }
    children.add(child);
    background(child);
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { name(line); backoff = 10000; } catch { /* a bad line */ } }
      }
      if (buf.length > 1e6) buf = '';
    });
    child.stderr.resume();
    child.on('error', () => {});
    child.on('close', () => { children.delete(child); setTimeout(run, backoff).unref(); backoff = Math.min(backoff * 2, 600000); });
  };
  run();
}

function startSampler() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(SAMPLER, 'utf16le').toString('base64');
  keepRunning((line) => { sys = parseSample(JSON.parse(line), Date.now()); }, () => spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true }));
}

function startGpu() {
  const query = 'name,utilization.gpu,utilization.encoder,utilization.decoder,encoder.stats.sessionCount,encoder.stats.averageFps,temperature.gpu,memory.used,memory.total';
  const exe = process.env.NVIDIA_SMI || 'nvidia-smi';
  keepRunning((line) => { gpu = parseGpu(line, Date.now()); }, () => {
    const c = spawn(exe, [`--query-gpu=${query}`, '--format=csv,noheader,nounits', '-l', String(TICK_MS / 1000)], { windowsHide: true });
    c.on('error', () => { gpu = null; });
    return c;
  });
}

export function parseGpu(line, at = Date.now()) {
  const f = line.split(',').map((s) => s.trim());
  if (f.length < 9) return null;
  const n = (s) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  return { at, name: f[0], busy: n(f[1]), enc: n(f[2]), dec: n(f[3]), sessions: n(f[4]), fps: n(f[5]), temp: n(f[6]), memUsed: n(f[7]) * 2 ** 20, memTotal: n(f[8]) * 2 ** 20 };
}

// One sampler line -> { cpu, net: { up, down }, disks: { E: { read, write, busy } }, procs: [{ pid, name, cpu, mem }] }
export function parseSample(d, at = Date.now()) {
  const counters = Array.isArray(d.c) ? d.c : d.c ? [d.c] : [];
  const net = { up: 0, down: 0 };
  const disks = {};
  let cpu = null;
  for (const s of counters) {
    const p = String(s.p || '').toLowerCase();
    const inst = String(s.i || '').toLowerCase();
    const v = Number(s.v) || 0;
    if (p.includes('\\network interface(')) {
      if (/isatap|teredo|loopback|pseudo|wan miniport/.test(inst)) continue;
      if (p.endsWith('bytes sent/sec')) net.up += v; else if (p.endsWith('bytes received/sec')) net.down += v;
    } else if (p.includes('\\physicaldisk(')) {
      if (inst === '_total') continue;
      for (const [, letter] of inst.matchAll(/([a-z]):/g)) {
        const dk = disks[letter.toUpperCase()] ??= { read: 0, write: 0, busy: 0 };
        if (p.endsWith('disk read bytes/sec')) dk.read = v;
        else if (p.endsWith('disk write bytes/sec')) dk.write = v;
        else if (p.endsWith('% idle time')) dk.busy = Math.max(0, Math.min(100, Math.round(100 - v)));
      }
    } else if (p.includes('processor utility')) cpu = Math.max(0, Math.min(100, Math.round(v)));
  }
  const lines = Array.isArray(d.p) ? d.p : d.p ? [d.p] : [];
  const procs = [];
  const seen = new Set();
  for (const l of lines) {
    const [pid, name, secs, mem] = String(l).split('|');
    const id = Number(pid);
    const total = Number(String(secs).replace(',', '.'));
    if (!id || !Number.isFinite(total)) continue;
    seen.add(id);
    const prev = prevProcs.get(id);
    prevProcs.set(id, { cpu: total, at });
    if (!prev || at <= prev.at) continue;
    const pct = (100 * (total - prev.cpu)) / (((at - prev.at) / 1000) * THREADS);
    procs.push({ pid: id, name, cpu: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)), mem: Number(mem) || null, total });
  }
  for (const id of prevProcs.keys()) if (!seen.has(id)) prevProcs.delete(id);
  return { at, cpu, net, link: Number(d.link) || null, disks, procs };
}

// Without the Windows sampler (another OS, or switched off): CPU from os.cpus().
function cpuFallback() {
  const t = os.cpus().reduce((a, c) => { a.idle += c.times.idle; a.total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq; return a; }, { idle: 0, total: 0 });
  const prev = fallbackCpu;
  fallbackCpu = t;
  if (!prev || t.total <= prev.total) return null;
  return Math.round(100 * (1 - (t.idle - prev.idle) / (t.total - prev.total)));
}

// ---------- every 5 s: per-process CPU for jobs, finished streams, history ----------
function tick() {
  const now = Date.now();
  const u = process.cpuUsage();
  const dt = (now - marqueeCpu.at) / 1000;
  if (dt > 0) marqueeCpu = { at: now, usage: u, pct: Math.round((((u.user - marqueeCpu.usage.user) + (u.system - marqueeCpu.usage.system)) / 1e6 / (dt * THREADS)) * 1000) / 10 };
  const fresh = sys && now - sys.at < 3 * TICK_MS ? sys : null;
  if (fresh) {
    for (const p of fresh.procs) {
      const j = jobs.get(p.pid);
      if (j) { j.cpu = p.cpu; j.peak = Math.max(j.peak, p.cpu); j.cpuSecs = p.total; j.mem = p.mem; }
    }
  }
  const cpu = fresh?.cpu ?? cpuFallback();

  for (const [key, s] of streams) {
    s.peak = Math.max(s.peak, s.rate.perSec(now));
    if (s.open <= 0 && now - s.last > STREAM_IDLE_MS) {
      streams.delete(key);
      const secs = Math.max(1, (s.last - s.started) / 1000);
      if (s.rate.total > 4 * 2 ** 20 || secs > 20) {
        remember({ type: 'stream', who: s.who, where: s.where, label: s.label, start: s.started, end: s.last,
          sent: s.rate.total, avg: Math.round(s.rate.total / secs), peak: Math.round(s.peak), needs: s.needs == null ? null : Math.round(s.needs) });
      }
    }
  }

  if (torrentRate && !torrentAsking) {
    torrentAsking = true;
    torrentRate().then((t) => { torrents = t ? { ...t, at: Date.now() } : null; }, () => { torrents = null; })
      .finally(() => { torrentAsking = false; });
  }
  const tor = torrents && now - torrents.at < 3 * TICK_MS ? torrents : null;

  const g = gpu && now - gpu.at < 3 * TICK_MS ? gpu : null;
  const mediaDisk = watched.length && fresh ? fresh.disks[watched[0].drive] : null;
  upRecent.push(out.internet.perSec(now) + (tor?.up || 0));
  if (upRecent.length > SUSTAINED_TICKS) upRecent.shift();
  const sample = {
    cpu, inet: out.internet.perSec(now), lan: out.lan.perSec(now), tor: tor?.up ?? null,
    nic: fresh?.net.up ?? null, gpu: g?.busy ?? null, enc: g?.enc ?? null, disk: mediaDisk?.busy ?? null,
    streams: [...streams.values()].filter((s) => s.open > 0 || now - s.last < STREAM_IDLE_MS).length, jobs: jobs.size,
  };
  const t = Math.floor(now / 60000) * 60000;
  if (minute && minute.t !== t) flushMinute();
  if (!minute) minute = { t, n: 0, sums: {}, max: {} };
  minute.n++;
  for (const [k, v] of Object.entries(sample)) {
    if (v == null) continue;
    minute.sums[k] = (minute.sums[k] || 0) + v;
    minute.max[k] = Math.max(minute.max[k] ?? 0, v);
  }
}

function flushMinute() {
  const m = minute;
  minute = null;
  if (!m?.n) return;
  const avg = (k) => (m.sums[k] == null ? null : Math.round(m.sums[k] / m.n));
  const max = (k) => (m.max[k] == null ? null : Math.round(m.max[k]));
  history.push({
    t: m.t, cpu: avg('cpu'), cpuMax: max('cpu'),
    inet: avg('inet'), inetMax: max('inet'), tor: avg('tor'), lan: avg('lan'), nic: avg('nic'), nicMax: max('nic'),
    gpu: avg('gpu'), enc: max('enc'), disk: max('disk'), streams: max('streams'), jobs: max('jobs'),
  });
  const since = Date.now() - HISTORY_MINUTES * 60000;
  while (history.length && history[0].t < since) history.shift();
}

// History for the chart: the last hour by minute, or the last day in 5-minute steps.
export function historyFor(hours = 1) {
  const since = Date.now() - hours * 3600000;
  const list = history.filter((m) => m.t >= since);
  if (hours <= 1) return list;
  const step = 5 * 60000;
  const out_ = [];
  for (const m of list) {
    const t = Math.floor(m.t / step) * step;
    let b = out_[out_.length - 1];
    if (!b || b.t !== t) out_.push(b = { t, n: 0, cpu: 0, cpuMax: 0, inet: 0, inetMax: 0, tor: 0, nicMax: 0, streams: 0, jobs: 0 });
    b.n++;
    b.cpu += m.cpu || 0; b.inet += m.inet || 0; b.tor += m.tor || 0;
    b.cpuMax = Math.max(b.cpuMax, m.cpuMax || 0); b.inetMax = Math.max(b.inetMax, m.inetMax || 0);
    b.nicMax = Math.max(b.nicMax, m.nicMax || 0); b.streams = Math.max(b.streams, m.streams || 0); b.jobs = Math.max(b.jobs, m.jobs || 0);
  }
  return out_.map(({ n, ...b }) => ({ ...b, cpu: Math.round(b.cpu / n), inet: Math.round(b.inet / n), tor: Math.round(b.tor / n) }));
}

// ---------- the snapshot ----------
const mbit = (bytesPerSec) => (bytesPerSec * 8) / 1e6;

export function loadReport({ hours = 1 } = {}) {
  const now = Date.now();
  const fresh = sys && now - sys.at < 3 * TICK_MS ? sys : null;
  const g = gpu && now - gpu.at < 3 * TICK_MS ? gpu : null;
  const tor = torrents && now - torrents.at < 3 * TICK_MS ? torrents : null;
  const conv = conversion();
  const live = [...streams.values()].filter((s) => s.open > 0 || now - s.last < STREAM_IDLE_MS)
    .map((s) => streamView(s, now)).sort((a, b) => b.rate - a.rate || a.since - b.since);
  const jobList = [...jobs.values()].map((j) => jobView(j, now, conv)).sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || a.since - b.since);
  const cpu = fresh?.cpu ?? history[history.length - 1]?.cpu ?? null;
  const internet = { streams: Math.round(out.internet.perSec(now)), torrents: tor ? Math.round(tor.up) : null, torrentLimit: tor?.upLimit || null };
  const lan = { streams: Math.round(out.lan.perSec(now)) };
  const disks = Object.entries(fresh?.disks || {}).map(([drive, d]) => ({
    drive, label: watched.find((w) => w.drive === drive)?.label || null, read: Math.round(d.read), write: Math.round(d.write), busy: d.busy,
  })).sort((a, b) => a.drive.localeCompare(b.drive));
  const jobPids = new Set(jobs.keys());
  const top = (fresh?.procs || []).filter((p) => !/^idle$/i.test(p.name) && p.cpu >= 0.5).sort((a, b) => b.cpu - a.cpu).slice(0, 6)
    .map((p) => ({ name: p.pid === process.pid ? 'Marquee' : p.name, pid: p.pid, cpu: p.cpu, mem: p.mem, job: jobPids.has(p.pid) }));

  const warnings = [];
  const upHeld = upRecent.length >= SUSTAINED_TICKS ? Math.min(...upRecent) : 0;
  if (UPLOAD_MBPS && mbit(upHeld) > 0.85 * UPLOAD_MBPS) {
    warnings.push(`Internet upload has been nearly full for 30 s (over ${Math.round(mbit(upHeld))} of ${UPLOAD_MBPS} Mbit/s): people watching away from home may buffer.`);
  }
  for (const s of live.filter((x) => x.behind)) {
    warnings.push(`${s.label} (${s.who}) isn’t getting enough: it arrives at ${Math.round(mbit(s.speed))} Mbit/s but the file needs ${Math.round(mbit(s.needs))}, so it will buffer.`);
  }
  if (tor && UPLOAD_MBPS && mbit(tor.up) > 0.5 * UPLOAD_MBPS && live.some((s) => s.where === 'internet')) {
    warnings.push(`qBittorrent is using ${Math.round(mbit(tor.up))} Mbit/s of upload while someone streams over the internet.`);
  }
  if (cpu != null && cpu >= 90) warnings.push(`CPU is at ${cpu} %: clip share copies and conversions slow down (plain streaming barely uses CPU).`);
  if (g?.sessions != null && g.sessions >= NVENC_LIMIT) warnings.push(`The GPU is running ${g.sessions} encodes, its limit: new NVENC encodes fail and fall back to the CPU.`);
  for (const w of watched) {
    const d = fresh?.disks[w.drive];
    if (d && d.busy >= 90) warnings.push(`The ${w.label.toLowerCase()} drive (${w.drive}:) is ${d.busy} % busy: streams from it may stutter.`);
  }
  const linkMbps = fresh?.link ? fresh.link / 1e6 : null;
  if (fresh && linkMbps && mbit(fresh.net.up) > 0.85 * linkMbps) warnings.push(`The server's network link is nearly full (${Math.round(mbit(fresh.net.up))} of ${Math.round(linkMbps)} Mbit/s).`);

  return {
    at: now,
    sampled: Boolean(fresh),
    limits: { uploadMbps: UPLOAD_MBPS, linkMbps, nvencSessions: NVENC_LIMIT, threads: THREADS },
    cpu, marqueeCpu: marqueeCpu.pct,
    mem: { total: os.totalmem(), avail: os.freemem() },
    gpu: g && { name: g.name, busy: g.busy, enc: g.enc, dec: g.dec, sessions: g.sessions, fps: g.fps, temp: g.temp, memUsed: g.memUsed, memTotal: g.memTotal },
    net: fresh ? { up: Math.round(fresh.net.up), down: Math.round(fresh.net.down) } : null,
    internet, lan, disks, streams: live, jobs: jobList, top, recent: recent.slice(0, 15), warnings,
    history: historyFor(hours),
  };
}

// For tests.
export function _reset() { upRecent.length = 0; visitors.clear(); streams.clear(); jobs.clear(); recent = []; history = []; minute = null; sys = null; gpu = null; torrents = null; out.internet = new Rate(); out.lan = new Rate(); }
export const _tick = () => tick();
export const _flush = () => flushMinute();
export const _setSample = (s) => { sys = s; };
export const _setNeeds = (bytesPerSec) => { for (const s of streams.values()) s.needs = bytesPerSec; };
