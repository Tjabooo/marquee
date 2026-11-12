#!/usr/bin/env node
// Playback stress test for Lilin: plays a few streams the way players do (range requests, a
// small buffer) while background work runs, and reports whether any stream would have stalled.
//
//   node tools/playback-stress/stress.mjs <config.json> [--label before] [--seconds 180] [--out dir]
//
// See README.md next to this file for the config format. Everything machine-specific (server URL,
// files, folders) lives in the config; nothing here assumes a host, drive or path.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ---------- child roles (run in their own process so they never delay the players' clocks) ----------
const role = process.argv[2];
if (role === '--role-writer') await writerRole(JSON.parse(process.argv[3]));
else if (role === '--role-convert') await convertRole(JSON.parse(process.argv[3]));
else await main();

// Writes like a BitTorrent client without preallocation: a sparse file, 16 KiB blocks into a few
// pieces at a time, pieces in random order, through the OS cache, capped at rateMBps.
async function writerRole({ file, sizeGB, rateMBps, pieceKiB = 4096, inFlight = 16, seconds, seed = 1 }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.rm(file, { force: true });
  fs.closeSync(fs.openSync(file, 'w'));
  if (process.platform === 'win32') await new Promise((r) => execFile('fsutil', ['sparse', 'setflag', file], () => r()));
  const size = Math.floor(sizeGB * 2 ** 30);
  const piece = pieceKiB * 1024, block = 16384, perPiece = piece / block;
  const pieces = Math.floor(size / piece);
  let s = seed; const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const order = [...Array(pieces).keys()];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const fd = fs.openSync(file, 'r+');
  const buf = crypto.randomBytes(block);
  const active = [];
  let next = 0, written = 0;
  const start = Date.now(), end = start + seconds * 1000;
  const report = setInterval(() => process.stdout.write(JSON.stringify({ written, at: Date.now() - start }) + '\n'), 1000);
  while (Date.now() < end && (next < pieces || active.length)) {
    while (active.length < inFlight && next < pieces) active.push({ p: order[next++], b: 0 });
    // token bucket: never ahead of rateMBps
    const allowed = ((Date.now() - start) / 1000) * rateMBps * 2 ** 20;
    if (written >= allowed) { await sleep(5); continue; }
    const i = Math.floor(rand() * active.length);
    const a = active[i];
    fs.writeSync(fd, buf, 0, block, a.p * piece + a.b * block);
    written += block;
    if (++a.b >= perPiece) active.splice(i, 1);
  }
  clearInterval(report);
  fs.closeSync(fd);
  process.stdout.write(JSON.stringify({ written, at: Date.now() - start, done: true }) + '\n');
  await fsp.rm(file, { force: true }).catch(() => {});
}

// Repackages an MKV the way Lilin's converter does (copy video, stereo AAC + E-AC-3 surround, moov
// reserved at the front), again and again until time is up. Optional `apply` = a module path whose
// default export(child) applies a scheduling policy to the ffmpeg process (the one under test).
async function convertRole({ input, outDir, seconds, ffmpeg = 'ffmpeg', apply = null }) {
  await fsp.mkdir(outDir, { recursive: true });
  const policy = apply ? (await import(new URL(`file:///${path.resolve(apply).replace(/\\/g, '/')}`).href)).default : null;
  const end = Date.now() + seconds * 1000;
  let n = 0, outBytes = 0;
  while (Date.now() < end) {
    const out = path.join(outDir, `convert-${n % 2}.mp4`);
    const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0', '-map', '0:a:0',
      '-c:v', 'copy', '-c:a:0', 'aac', '-b:a:0', '192k', '-ac:a:0', '2', '-filter:a:0', 'aresample=async=1000:first_pts=0',
      '-c:a:1', 'eac3', '-b:a:1', '640k', '-disposition:a:0', 'default', '-disposition:a:1', '0',
      '-avoid_negative_ts', 'disabled', '-moov_size', '12000000', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', out];
    const child = spawn(ffmpeg, args, { windowsHide: true });
    if (policy) await policy(child); else { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* */ } }
    let last = 0;
    child.stdout.on('data', (d) => { const m = /total_size=(\d+)/.exec(String(d)); if (m) { last = Number(m[1]); process.stdout.write(JSON.stringify({ n, bytes: outBytes + last }) + '\n'); } });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), Math.max(0, end - Date.now()));
    await new Promise((r) => child.on('close', r));
    clearTimeout(timer);
    outBytes += last; n++;
  }
  process.stdout.write(JSON.stringify({ n, bytes: outBytes, done: true }) + '\n');
  for (const f of ['convert-0.mp4', 'convert-1.mp4']) await fsp.rm(path.join(outDir, f), { force: true }).catch(() => {});
}

// ---------- the test ----------
async function main() {
  const args = process.argv.slice(2);
  const cfgPath = args.find((a) => !a.startsWith('--'));
  if (!cfgPath) { console.error('usage: stress.mjs <config.json> [--label name] [--seconds n] [--out dir] [--no-load] [--only a,b]'); process.exit(2); }
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const cfg = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
  const label = opt('label', 'run');
  const seconds = Number(opt('seconds', cfg.seconds || 180));
  const outDir = path.resolve(opt('out', cfg.out || path.join(HERE, 'results')));
  const noLoad = args.includes('--no-load');
  const only = opt('only', null)?.split(',');
  const want = (k) => !noLoad && (!only || only.includes(k));
  await fsp.mkdir(outDir, { recursive: true });
  const base = cfg.lilin.replace(/\/$/, '');
  const headers = cfg.email ? { 'cf-access-authenticated-user-email': cfg.email } : {};
  const api = async (p, init = {}) => { const r = await fetch(base + p, { ...init, headers: { ...headers, ...init.headers } }); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };
  const idOf = (rel) => Buffer.from(rel).toString('base64url');

  // Start cold: empty the OS file cache so every run reads from disk (Windows, needs admin).
  if (cfg.purgeStandby && process.platform === 'win32') {
    await new Promise((r) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'purge-standby.ps1')], { windowsHide: true }, (e, o, er) => { console.error(e ? `standby purge failed: ${er || e.message}` : String(o).trim()); r(); }));
  }
  // Reset the real Lilin jobs so they run again (storyboard, browser copy).
  const prep = {};
  if (want('storyboard') && cfg.load?.storyboard) {
    const id = idOf(cfg.load.storyboard);
    const idx = await api(`/api/media/lib/${id}/preview`);
    if (idx.done && cfg.cacheDir) await fsp.rm(path.join(cfg.cacheDir, 'previews', idx.key), { recursive: true, force: true });
    prep.storyboard = id;
  }
  if (want('browsercopy') && cfg.load?.browserCopy) {
    const full = path.join(cfg.mediaDir, cfg.load.browserCopy);
    const st = await fsp.stat(full);
    const key = crypto.createHash('sha1').update(`${path.resolve(full).toLowerCase()}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 24);
    if (cfg.cacheDir) await fsp.rm(path.join(cfg.cacheDir, 'audio', `${key}.mp4`), { force: true });
    prep.browserCopy = idOf(cfg.load.browserCopy);
  }

  // Counters (Windows) and GPU, sampled every second.
  const samples = { counters: null, gpu: [] };
  const procs = [];
  let typeperfOut = null;
  if (process.platform === 'win32' && cfg.counters !== false) {
    typeperfOut = path.join(outDir, `${label}-counters.csv`);
    await fsp.rm(typeperfOut, { force: true });
  }
  const startCounters = () => {
    if (!typeperfOut) return;
    const list = ['\\PhysicalDisk(*)\\Avg. Disk sec/Read', '\\PhysicalDisk(*)\\Avg. Disk sec/Write', '\\PhysicalDisk(*)\\Current Disk Queue Length',
      '\\PhysicalDisk(*)\\% Idle Time', '\\PhysicalDisk(*)\\Disk Read Bytes/sec', '\\PhysicalDisk(*)\\Disk Write Bytes/sec',
      '\\Processor Information(_Total)\\% Processor Utility', '\\Process(*)\\% Processor Time', '\\Process(*)\\IO Read Bytes/sec', '\\Process(*)\\IO Write Bytes/sec',
      '\\Memory\\Modified Page List Bytes', '\\Network Interface(*)\\Bytes Sent/sec'];
    const cf = path.join(outDir, `${label}-counters.txt`);
    fs.writeFileSync(cf, list.join('\r\n'));
    procs.push(spawn('typeperf', ['-cf', cf, '-si', '1', '-sc', String(seconds), '-f', 'CSV', '-o', typeperfOut, '-y'], { windowsHide: true, stdio: 'ignore' }));
    const g = spawn(cfg.nvidiaSmi || 'nvidia-smi', ['--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder', '--format=csv,noheader,nounits', '-l', '1'], { windowsHide: true });
    g.on('error', () => {});
    g.stdout?.on('data', (d) => { for (const l of String(d).trim().split(/\r?\n/)) { const [u, e, dd] = l.split(',').map(Number); if (Number.isFinite(u)) samples.gpu.push({ u, e, d: dd }); } });
    procs.push(g);
  };

  // Background load.
  const loads = {};
  const childJson = (name, argv) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], { windowsHide: true });
    loads[name] = { last: null };
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { loads[name].last = JSON.parse(l); } catch { /* */ } } });
    c.stderr.on('data', (d) => { loads[name].err = String(d).slice(-500); });
    procs.push(c);
    return c;
  };
  const tStart = Date.now();
  if (want('writer') && cfg.load?.writer) childJson('writer', ['--role-writer', JSON.stringify({ ...cfg.load.writer, seconds })]);
  if (want('convert') && cfg.load?.convert) childJson('convert', ['--role-convert', JSON.stringify({ ...cfg.load.convert, seconds, apply: cfg.load.convert.apply ? path.resolve(path.dirname(cfgPath), cfg.load.convert.apply) : null })]);
  const jobTimes = {};
  if (prep.storyboard) {
    const t0 = Date.now();
    jobTimes.storyboard = { started: 0 };
    (async () => { await api(`/api/media/lib/${prep.storyboard}/preview`).catch(() => {}); for (;;) { await sleep(2000); const idx = await api(`/api/media/lib/${prep.storyboard}/preview`).catch(() => null); if (idx) jobTimes.storyboard.sheets = idx.sheets; if (idx?.done) { jobTimes.storyboard.seconds = (Date.now() - t0) / 1000; break; } if (Date.now() - tStart > seconds * 1000) break; } })();
  }
  if (prep.browserCopy) {
    const t0 = Date.now();
    jobTimes.browserCopy = {};
    (async () => { for (;;) { const a = await api(`/api/media/lib/${prep.browserCopy}/audio`).catch(() => null); if (a) { jobTimes.browserCopy.percent = a.percent; jobTimes.browserCopy.startPercent ??= a.percent; } if (a && a.videoSafe === true) { jobTimes.browserCopy.seconds = (Date.now() - t0) / 1000; break; } if (Date.now() - tStart > seconds * 1000) break; await sleep(2000); } })();
  }
  let scans = 0;
  if (want('scan') && cfg.load?.libraryScanSeconds) {
    (async () => { while (Date.now() - tStart < seconds * 1000) { await api('/api/library').catch(() => {}); scans++; await sleep(cfg.load.libraryScanSeconds * 1000); } })();
  }
  // Safety: real viewers come first. If anyone else's stream falls behind, stop the load at once.
  // Real viewers = anyone over the internet, plus whoever was already streaming before the test.
  const before = new Set(((await api('/api/house/load').catch(() => null))?.streams || []).map((x) => `${x.who}|${x.label}`));
  let aborted = null;
  const guard = setInterval(async () => {
    const l = await api('/api/house/load').catch(() => null);
    const hurt = (l?.streams || []).find((x) => x.behind && (x.where === 'internet' || before.has(`${x.who}|${x.label}`)));
    if (hurt && !aborted) { aborted = `${hurt.who}: ${hurt.label}`; console.error(`a real viewer fell behind (${aborted}); stopping the load`); for (const p of procs) { try { p.kill(); } catch { /* */ } } }
  }, 5000);
  await sleep((cfg.warmupSeconds ?? 3) * 1000);
  startCounters();

  // Players.
  const results = await Promise.all((cfg.streams || []).map((s, i) => play(s, i)));
  async function play(s, i) {
    const id = s.id || idOf(s.file);
    const url = `${base}/api/stream/lib/${id}/x${s.browser ? '?browser' : ''}`;
    const head = await fetch(url, { method: 'HEAD', headers });
    const size = Number(head.headers.get('content-length'));
    const bitrate = s.mbps ? s.mbps * 1e6 / 8 : await probeBitrate(s, cfg) || 3e6;
    const chunk = (s.chunkMB || 4) * 2 ** 20;
    const target = s.bufferSeconds || 10, startup = s.startupSeconds || 2;
    let rnd = (i + 1) * 7919; const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 2 ** 32);
    let pos = Math.floor(size * (s.startAt ?? rand() * 0.8));
    const t0 = now(), end = t0 + (seconds - 3) * 1000;
    let buffer = 0, playing = false, last = t0, stalls = 0, stallMs = 0, stallFrom = t0, minBuffer = Infinity, filled = false, playingMs = 0, startupMs = null;
    const chunks = [], ttfbs = [], seeks = [];
    let seekFrom = null, nextSeek = s.seekEverySeconds ? t0 + s.seekEverySeconds * 1000 : Infinity;
    const tick = () => {
      const t = now(), dt = (t - last) / 1000; last = t;
      if (!playing) return;
      playingMs += Math.min(dt, buffer) * 1000;
      if (buffer - dt <= 0) { playing = false; stalls++; stallFrom = t - (dt - buffer) * 1000; buffer = 0; } else buffer -= dt;
      if (buffer >= target) filled = true;
      if (filled) minBuffer = Math.min(minBuffer, buffer);
    };
    while (now() < end) {
      if (now() >= nextSeek) { pos = Math.floor(size * rand() * 0.9); buffer = 0; playing = false; filled = false; seekFrom = now(); nextSeek = now() + s.seekEverySeconds * 1000; }
      tick();
      if (buffer >= target) { await sleep(Math.min(250, (buffer - target) * 1000 + 20)); continue; }
      const from = pos, to = Math.min(size - 1, pos + chunk - 1);
      const tReq = now();
      let ttfb = null, got = 0;
      try {
        const r = await fetch(url, { headers: { ...headers, Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(Math.round(Math.max(1000, end + 2000 - now()))) });
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ttfb == null) ttfb = now() - tReq;
          got += value.length;
          // credit the buffer as data arrives (players start decoding before a request finishes)
          tick(); buffer += value.length / bitrate; if (buffer >= target) filled = true;
        }
      } catch (e) { chunks.push({ ms: now() - tReq, err: e.message }); await sleep(200); continue; }
      const ms = now() - tReq;
      chunks.push({ ms, bytes: got, at: (tReq - t0) / 1000 });
      if (ttfb != null) ttfbs.push(ttfb);
      pos = to + 1 >= size ? 0 : to + 1;
      tick();
      if (!playing && buffer >= startup) {
        playing = true;
        if (startupMs == null) startupMs = now() - t0;
        if (seekFrom != null) { seeks.push(now() - seekFrom); seekFrom = null; }
        else if (stalls) stallMs += now() - stallFrom;
      }
    }
    if (!playing && stalls && seekFrom == null) stallMs += now() - stallFrom;
    const ok = chunks.filter((c) => !c.err);
    const msPerMB = ok.map((c) => c.ms / (c.bytes / 2 ** 20));
    const realtime = ok.map((c) => (c.bytes / bitrate) / (c.ms / 1000)); // seconds of video per second of waiting
    return {
      name: s.name || `stream${i}`, mbps: r1(bitrate * 8 / 1e6), requests: ok.length, errors: chunks.length - ok.length,
      chunkMs: { p50: r1(pct(ok.map((c) => c.ms), 50)), p95: r1(pct(ok.map((c) => c.ms), 95)), p99: r1(pct(ok.map((c) => c.ms), 99)), max: r1(Math.max(0, ...ok.map((c) => c.ms))) },
      ttfbMs: { p50: r1(pct(ttfbs, 50)), p95: r1(pct(ttfbs, 95)), max: r1(Math.max(0, ...ttfbs)) },
      msPerMB: { p50: r1(pct(msPerMB, 50)), p95: r1(pct(msPerMB, 95)) },
      realtimeWorst: r1(Math.min(...realtime)), realtimeP5: r1(pct(realtime, 5)),
      startupMs: r1(startupMs), playingPct: r1((100 * playingMs) / Math.max(1, now() - t0 - (startupMs ?? 0))), waitingSeconds: r1((now() - t0 - playingMs) / 1000),
      stalls, stallSeconds: r1(stallMs / 1000), minBufferSeconds: r1(minBuffer === Infinity ? null : minBuffer),
      seekToPlayMs: seeks.length ? { p50: r1(pct(seeks, 50)), max: r1(Math.max(...seeks)), n: seeks.length } : null,
    };
  }

  clearInterval(guard);
  for (const p of procs) { try { p.kill(); } catch { /* */ } }
  await sleep(1500);
  const summary = { aborted, label, at: new Date().toISOString(), seconds, streams: results, jobs: { ...jobTimes, libraryScans: scans } };
  for (const [k, v] of Object.entries(loads)) summary.jobs[k] = v.last && { ...v.last, MBps: v.last.written != null ? r1(v.last.written / 2 ** 20 / (v.last.at / 1000)) : v.last.bytes != null ? r1(v.last.bytes / 2 ** 20 / seconds) : null, err: v.err };
  if (samples.gpu.length) summary.gpu = { util: r1(avg(samples.gpu.map((g) => g.u))), enc: r1(avg(samples.gpu.map((g) => g.e))), dec: r1(avg(samples.gpu.map((g) => g.d))) };
  if (typeperfOut && fs.existsSync(typeperfOut)) summary.counters = summarizeCounters(await fsp.readFile(typeperfOut, 'utf8'), cfg.processes);
  const out = path.join(outDir, `${label}.json`);
  await fsp.writeFile(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 1));
  console.error(`saved ${out}`);
  process.exit(0);
}

function probeBitrate(s, cfg) {
  if (!s.file || !cfg.mediaDir) return Promise.resolve(null);
  return new Promise((resolve) => execFile(cfg.ffprobe || 'ffprobe', ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', path.join(cfg.mediaDir, s.file)], { windowsHide: true }, (e, out) => resolve(e ? null : Number(String(out).trim()) / 8 || null)));
}

// typeperf CSV -> per disk latency/queue/idle, CPU, and the busiest processes.
function summarizeCounters(csv, interesting = ['ffmpeg', 'node', 'qbittorrent', 'MsMpEng', 'SearchIndexer', 'System']) {
  const rows = csv.trim().split(/\r?\n/).map((l) => l.slice(1, -1).split('","'));
  const header = rows.shift();
  const data = rows.filter((r) => r.length === header.length);
  const col = (i) => data.map((r) => Number(r[i])).filter(Number.isFinite);
  const out = { disks: {}, cpu: null, processes: {}, dirtyMB: null };
  header.forEach((h, i) => {
    let m;
    if ((m = /PhysicalDisk\((\d+ [^)]*)\)\\(.+)$/.exec(h))) {
      const d = (out.disks[m[1]] ||= {});
      const v = col(i);
      const k = { 'Avg. Disk sec/Read': 'readMs', 'Avg. Disk sec/Write': 'writeMs', 'Current Disk Queue Length': 'queue', '% Idle Time': 'idle', 'Disk Read Bytes/sec': 'readMBps', 'Disk Write Bytes/sec': 'writeMBps' }[m[2]];
      if (!k) return;
      if (k.endsWith('Ms')) d[k] = { avg: r1(avg(v) * 1000), p95: r1(pct(v, 95) * 1000), max: r1(Math.max(...v) * 1000) };
      else if (k.endsWith('MBps')) d[k] = r1(avg(v) / 2 ** 20);
      else if (k === 'idle') d[k] = r1(Math.min(100, avg(v)));
      else d[k] = { avg: r1(avg(v)), max: Math.max(...v) };
    } else if (/Processor Utility/.test(h)) out.cpu = { avg: r1(avg(col(i))), p95: r1(pct(col(i), 95)) };
    else if ((m = /Process\(([^)]+)\)\\(.+)$/.exec(h))) {
      const name = m[1];
      if (!interesting.some((n) => name.toLowerCase().startsWith(n.toLowerCase()))) return;
      const p = (out.processes[name] ||= {});
      const k = { '% Processor Time': 'cpuPct', 'IO Read Bytes/sec': 'readMBps', 'IO Write Bytes/sec': 'writeMBps' }[m[2]];
      if (k) p[k] = r1(k === 'cpuPct' ? avg(col(i)) / os.cpus().length : avg(col(i)) / 2 ** 20);
    } else if (/Modified Page List/.test(h)) out.dirtyMB = { avg: r1(avg(col(i)) / 2 ** 20), max: r1(Math.max(...col(i)) / 2 ** 20) };
  });
  delete out.disks._Total;
  for (const k of Object.keys(out.disks)) if (/_Total/.test(k)) delete out.disks[k];
  return out;
}
