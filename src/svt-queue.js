// Saves SVT Play videos into the media folder, so they join the library like any download and play
// everywhere the library does (browser, phone, TV, Apple TV, Jellyfin). ffmpeg copies the streams as
// they are, no re-encoding: H.264 and AAC in an MP4, with Swedish subtitles as "<name>.sv.srt" beside it.
//
// A video is written to "<name>.mp4.<run>.part" (which the library ignores) and renamed when ffmpeg finished
// and the length is right. The queue survives a restart: what was interrupted starts over. Each run has its own
// part file because a hard stop on Windows can leave the old ffmpeg writing for a while, and two writers
// in one file would corrupt it. Leftovers go when the next run starts and ends.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { svtVideo, svtStreams, svtSubtitles, svtHashOf as svtHash } from './svtplay.js';

const MAX_RUNNING = 2;
// Well above real time, but it can't flood the line while someone is watching something else.
const READ_RATE = '12';
// Until a copy has started, its size is a guess from its length (SVT's 1080p runs about 4 Mbit/s).
const BYTES_PER_MINUTE = 30e6;
const pad = (n) => String(n).padStart(2, '0');

// A title as a file or folder name on every system. Colons read better as dashes ("Kriminalarkivet - Flickmorden").
export function safeName(name) {
  return String(name || '').replace(/\s*:\s*/g, ' - ').replace(/[<>"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'SVT Play';
}

// Where a video goes, in the folders and names the library already understands.
export function targetFile({ title, kind, year, season, episode }) {
  const name = safeName(title);
  if (kind === 'series') return path.join('TV', name, `Season ${pad(season)}`, `${name} - S${pad(season)}E${pad(episode)}.mp4`);
  const film = year ? `${name} (${year})` : name;
  return path.join('Movies', film, `${film}.mp4`);
}

// out_time_us= / total_size= / speed= from `ffmpeg -progress`.
export function parseProgress(chunk) {
  const out = {};
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = /^(\w+)=\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  const us = Number(out.out_time_us ?? out.out_time_ms);
  return {
    seconds: Number.isFinite(us) && us > 0 ? us / 1e6 : null,
    bytes: Number(out.total_size) > 0 ? Number(out.total_size) : null,
    end: out.progress === 'end',
  };
}

// What to show as a copy's size. Once under way, what it has written so far says more than SVT's peak bitrate.
export function expectedSize({ bytes, progress, minutes, size }) {
  if (bytes > 0 && progress > 0.02) return Math.round(bytes / progress);
  return minutes ? minutes * BYTES_PER_MINUTE : size || 30 * BYTES_PER_MINUTE;
}

// deps: { mediaDir, dataDir, ffmpeg, freeBytes?(), onSaved(job, fullPath), onChange?(), log? }
export function createSvtQueue(deps) {
  const stateFile = path.join(deps.dataDir, '.marquee-svt.json');
  const jobs = new Map(); // hash -> job
  const running = new Map(); // hash -> ffmpeg process
  const log = deps.log || (() => {});
  let saveTimer = null;

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const rows = [...jobs.values()].map(({ speed, ...job }) => job);
      fs.promises.writeFile(stateFile, JSON.stringify(rows)).catch(() => {});
    }, 500);
    saveTimer.unref?.();
  };
  const changed = () => { save(); deps.onChange?.(); };

  const fullPath = (job) => {
    const full = path.resolve(deps.mediaDir, job.target);
    if (!full.startsWith(path.resolve(deps.mediaDir) + path.sep)) throw new Error('Bad destination.');
    return full;
  };
  // Every part file of this video. A file some other process still holds stays until next time.
  async function removeParts(job) {
    const full = fullPath(job);
    const prefix = `${path.basename(full)}.`;
    const names = await fs.promises.readdir(path.dirname(full)).catch(() => []);
    await Promise.all(names.filter((n) => n.startsWith(prefix) && n.endsWith('.part'))
      .map((n) => fs.promises.rm(path.join(path.dirname(full), n), { force: true }).catch(() => {})));
  }

  function fail(job, message) {
    job.state = 'error';
    job.error = message;
    job.speed = 0;
    log(`[svt] ${job.name}: ${message}`);
  }

  async function run(job) {
    const full = fullPath(job);
    const part = `${full}.${crypto.randomBytes(4).toString('hex')}.part`;
    job.state = 'metaDL';
    job.error = null;
    job.progress = 0;
    changed();
    const video = await svtVideo(job.videoId);
    if (video.refused) throw new Error(video.refused);
    const streams = await svtStreams(video);
    const estimate = streams.bandwidth && video.duration ? Math.round(streams.bandwidth / 8 * video.duration) : null;
    job.size = estimate;
    const free = await deps.freeBytes?.();
    if (estimate && Number.isFinite(free) && free < estimate * 1.1) throw new Error('There isn’t enough free space on the media disk.');
    if (job.state !== 'metaDL') return; // paused or removed meanwhile
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await removeParts(job);

    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-progress', 'pipe:1',
      '-protocol_whitelist', 'https,tls,tcp,crypto,http,httpproxy',
      '-readrate', READ_RATE, '-i', streams.videoUrl];
    if (streams.audioUrl) args.push('-protocol_whitelist', 'https,tls,tcp,crypto,http,httpproxy', '-readrate', READ_RATE, '-i', streams.audioUrl);
    args.push('-map', '0:v:0', '-map', streams.audioUrl ? '1:a:0' : '0:a:0', '-c', 'copy');
    if (video.format === 'hls') args.push('-bsf:a', 'aac_adtstoasc');
    args.push('-movflags', '+faststart', '-f', 'mp4', part);

    job.state = 'downloading';
    changed();
    let tail = '', lastSeconds = 0;
    let last = { at: Date.now(), bytes: 0 };
    const proc = spawn(deps.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    running.set(job.hash, proc);
    proc.stdout.on('data', (chunk) => {
      const p = parseProgress(chunk);
      if (p.seconds) lastSeconds = p.seconds;
      if (p.seconds && video.duration) job.progress = Math.min(0.99, p.seconds / video.duration);
      if (p.bytes) {
        const now = Date.now();
        if (now - last.at >= 1000) {
          job.speed = Math.max(0, (p.bytes - last.bytes) / ((now - last.at) / 1000));
          last = { at: now, bytes: p.bytes };
        }
        job.bytes = p.bytes;
      }
    });
    proc.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-400); });
    const code = await new Promise((resolve) => { proc.on('close', resolve); proc.on('error', (e) => { tail = e.message; resolve(-1); }); });
    running.delete(job.hash);
    if (job.state !== 'downloading') { await removeParts(job); return; } // paused or removed: ffmpeg was stopped
    if (code !== 0) {
      await removeParts(job);
      log(`[svt] ffmpeg stopped for ${job.name}: ${tail.trim().split('\n').at(-1) || code}`);
      throw new Error(/403|Forbidden/.test(tail) ? 'SVT Play only works from Sweden.' : 'The copy from SVT Play stopped. Try again.');
    }
    // Copied streams report how far they got; much shorter than SVT's length means it was cut off.
    if (video.duration && lastSeconds && lastSeconds < video.duration * 0.97) {
      await removeParts(job);
      throw new Error('The copy from SVT Play stopped early. Try again.');
    }
    await fs.promises.rename(part, full);
    await removeParts(job);
    if (video.subtitleUrl) {
      try {
        const srt = await svtSubtitles(video.subtitleUrl);
        if (srt) await fs.promises.writeFile(full.replace(/\.mp4$/, '.sv.srt'), srt);
      } catch (e) { log(`[svt] subtitles for ${job.name}: ${e.message}`); }
    }
    log(`[svt] saved ${job.name} (${streams.height}p)`);
    jobs.delete(job.hash);
    // A title's overall progress counts what's finished, so it doesn't fall back when an episode leaves the queue.
    for (const other of jobs.values()) if (sameTitle(other, job)) other.batchDone = (other.batchDone || 0) + 1;
    await deps.onSaved(job, full);
    changed();
  }

  const sameTitle = (a, b) => a.path === b.path;

  function pump() {
    const busy = [...jobs.values()].filter((j) => j.state === 'metaDL' || j.state === 'downloading').length;
    let free = MAX_RUNNING - busy;
    for (const job of jobs.values()) {
      if (free <= 0) break;
      if (job.state !== 'queuedDL') continue;
      free--;
      run(job).catch(async (e) => {
        if (job.state === 'pausedDL' || !jobs.has(job.hash)) return;
        await removeParts(job);
        fail(job, e.message || String(e));
      }).finally(() => { changed(); pump(); });
    }
  }

  // Stops ffmpeg if this video is being copied. `run` cleans up when it sees the new state.
  const stop = (hash) => { running.get(hash)?.kill('SIGKILL'); };

  const queue = {
    // spec: { videoId, path, title, kind, year, season, episode, episodeName, tmdbId, showId, showKey, poster, backdrop, requester }
    add(spec) {
      const hash = svtHash(spec.videoId);
      const existing = jobs.get(hash);
      if (existing) {
        if (spec.requester != null && !existing.requesters.includes(spec.requester)) existing.requesters.push(spec.requester);
        if (existing.state === 'error') { existing.state = 'queuedDL'; existing.error = null; pump(); }
        changed();
        return existing;
      }
      const { requester, ...info } = spec;
      const label = spec.kind === 'series' ? `${spec.title} S${pad(spec.season)}E${pad(spec.episode)}` : spec.title;
      const job = {
        ...info, hash, name: label, target: targetFile(spec), requesters: requester != null ? [requester] : [],
        state: 'queuedDL', progress: 0, bytes: 0, size: null, speed: 0, error: null, added: Date.now(),
        batchDone: Math.max(0, ...[...jobs.values()].filter((j) => sameTitle(j, spec)).map((j) => j.batchDone || 0)),
      };
      jobs.set(hash, job);
      changed();
      pump();
      return job;
    },
    list: () => [...jobs.values()],
    get: (hash) => jobs.get(String(hash).toLowerCase()) || null,
    pause(hash) {
      const job = queue.get(hash);
      if (!job) return;
      job.state = 'pausedDL'; job.speed = 0; job.progress = 0;
      stop(job.hash);
      changed();
      pump();
    },
    resume(hash) {
      const job = queue.get(hash);
      if (!job || !['pausedDL', 'error'].includes(job.state)) return;
      job.state = 'queuedDL'; job.error = null;
      changed();
      pump();
    },
    async remove(hash) {
      const job = queue.get(hash);
      if (!job) return;
      job.state = 'removed';
      jobs.delete(job.hash);
      stop(job.hash);
      await removeParts(job);
      changed();
      pump();
    },
    // ffmpeg stops with the server, so no half-written copy carries on after a restart.
    stopAll() { for (const proc of running.values()) proc.kill('SIGKILL'); },
    start() {
      let rows = [];
      try { rows = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row?.hash || !row.videoId || !row.target) continue;
        const resume = ['queuedDL', 'metaDL', 'downloading'].includes(row.state);
        jobs.set(row.hash, { ...row, state: resume ? 'queuedDL' : row.state, speed: 0, progress: resume ? 0 : row.progress });
      }
      pump();
    },
  };
  return queue;
}
