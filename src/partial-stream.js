// Play now: watch a video while qBittorrent is still downloading it.
//
// qBittorrent downloads the video in order, with its first and last pieces early (many files keep their
// index at the end). A file being downloaded has holes that read as zeros, so nothing may read it directly:
// ffmpeg reads it over HTTP from a small server on the loopback interface instead, which holds every read
// until qBittorrent reports those pieces as finished and verified. Reads waiting for the download look like
// a slow disk to ffmpeg, so the rest of the pipeline is the ordinary live stream (phone-stream.js).
//
// qBittorrent has no way to prioritise a piece in the middle of a file, so a seek past the downloaded part
// waits until the download gets there. The original file is never changed.
//
// Even in order, the edge of what's readable moves in jumps: one slow peer can hold a piece back for half a
// minute while later pieces arrive. So playback starts with a lead that can ride that out when it comes cheaply.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { probeInput } from './phone-stream.js';

const HAVE = 2;                  // qBittorrent's piece state for "downloaded and verified"
const READ_BYTES = 4 * 1024 * 1024;
const POLL_MS = 1000;
const IDLE_MS = 3 * 60_000;      // nobody watching for this long: the download goes back to normal
const START_SECONDS = 20;        // never start with less than this in order
const START_GOAL_SECONDS = 45;   // start with this much when the download brings it soon
const START_GRACE_MS = 20_000;   // how long to wait for the goal after having the minimum
const EARLIER_LEFT_BYTES = 256 * 1024 * 1024; // extras before the video in a pack: not worth reordering for
const MIN_START_BYTES = 8 * 1024 * 1024;
const PROBE_MS = 10 * 60_000;    // reading the start and end of the file can wait for the download
const MAX_PROBE_FAILURES = 2;
const SHORT_READ_MS = 30_000;    // a verified piece that isn't readable yet (still being written)

export const partialId = (hash, index) => `${String(hash).toLowerCase()}-${index}`;
export function parsePartialId(id) {
  const m = /^([a-f0-9]{40}|[a-f0-9]{64})-(\d{1,5})$/i.exec(String(id || ''));
  return m ? { hash: m[1].toLowerCase(), index: Number(m[2]) } : null;
}

// Where a file sits in the torrent's pieces. qBittorrent hides padding files, so the sum of the earlier
// sizes can fall short of the real start. Its piece_range is exact, so the sum is corrected to fit it.
export function fileLayout(files, index, pieceSize) {
  const list = files.map((f, i) => ({ ...f, index: f.index ?? i })).sort((a, b) => a.index - b.index);
  let offset = 0;
  for (const f of list) {
    if (f.index === index) {
      const [first, last] = Array.isArray(f.piece_range) ? f.piece_range : [Math.floor(offset / pieceSize), Math.floor((offset + Math.max(0, f.size - 1)) / pieceSize)];
      const low = first * pieceSize, high = low + pieceSize - 1;
      return { offset: Math.min(high, Math.max(low, offset)), size: f.size, first, last };
    }
    offset += f.size;
  }
  return null;
}

// How many bytes can be read in a row from `from` in this file.
export function readableBytes(layout, pieceSize, states, from = 0) {
  if (!layout || !states || from >= layout.size) return 0;
  let piece = Math.floor((layout.offset + from) / pieceSize);
  const start = piece;
  while (piece <= layout.last && states[piece] === HAVE) piece++;
  if (piece === start) return 0;
  return Math.max(0, Math.min(layout.size, piece * pieceSize - layout.offset) - from);
}

// Share of the file's pieces that are finished, in any order.
export function fileProgress(layout, states) {
  if (!layout || !states) return 0;
  let have = 0;
  for (let i = layout.first; i <= layout.last; i++) if (states[i] === HAVE) have++;
  return have / Math.max(1, layout.last - layout.first + 1);
}

// Enough in order to start: the first seconds at this video's bitrate, or all of a small file.
export const startBytes = (size, bitrate, seconds = START_SECONDS) => Math.min(size, Math.max(MIN_START_BYTES, Math.ceil(((bitrate || 0) / 8) * seconds)));

// Start with the full lead, or with the minimum once it has had a while to grow. `enoughSince` = when the minimum was there.
export function readyToStart(readable, size, bitrate, enoughSince, now = Date.now()) {
  if (readable >= startBytes(size, bitrate, START_GOAL_SECONDS)) return true;
  return enoughSince != null && now - enoughSince >= START_GRACE_MS;
}

// What a pack's file priorities should be for watching file `index`. In sequential mode libtorrent takes
// top-priority pieces first but in rarest-first order, so priority 7 scatters the very file being watched: leave it
// off whenever the file can simply be next in line. Sequential goes by position and ignores normal priorities,
// so if a lot of earlier files are still missing, it would fetch those first: only then is 7 the better of the two.
// Returns [[file, priority], ...] for the files to change.
export function packPriorities(files, index) {
  const list = files.map((f, i) => ({ ...f, index: f.index ?? i }));
  const target = list.find((f) => f.index === index);
  if (!target) return [];
  const missing = (f) => (f.size || 0) * (1 - (f.progress || 0));
  const earlier = list.filter((f) => f.index < index && f.priority > 0).reduce((sum, f) => sum + missing(f), 0);
  if (earlier > EARLIER_LEFT_BYTES) return target.priority === 7 ? [] : [[index, 7]];
  const changes = list.filter((f) => f.priority === 7 && (f.index === index || (f.progress || 0) < 1)).map((f) => [f.index, 1]);
  return changes;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});
const failure = (status, message) => Object.assign(new Error(message), { status });

export class PartialStreams {
  // qbit(path) = parsed JSON; post(path, fields) = a command; filePath(torrent, file) = where it is on disk;
  // isVideo(name); start(hash) = start a stopped torrent; probe = probeInput (tests replace it).
  constructor({ qbit, post, filePath, isVideo, start, probe = probeInput, log = console }) {
    Object.assign(this, { qbit, post, filePath, isVideo, start, probe, log });
    this.entries = new Map();
    this.torrents = new Map(); // hash -> what Marquee changed, restored when the last viewer leaves
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.port = null;
    this.timer = setInterval(() => this.sweep().catch((e) => this.log.warn?.(`[play now] ${e.message}`)), 30_000);
    this.timer.unref?.();
  }

  async listen() {
    if (this.port) return this.port;
    this.listening ||= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.serve(req, res).catch(() => res.destroy()));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { this.server = server; this.port = server.address().port; server.unref(); resolve(this.port); });
    });
    return this.listening;
  }

  async torrent(hash) {
    const list = await this.qbit(`/api/v2/torrents/info?hashes=${hash}`);
    return Array.isArray(list) ? list[0] || null : null;
  }

  async entry(id) {
    const known = this.entries.get(id);
    if (known) return known;
    const parsed = parsePartialId(id);
    if (!parsed) throw failure(400, 'Invalid video.');
    const t = await this.torrent(parsed.hash);
    if (!t) throw failure(404, 'That download no longer exists.');
    const files = await this.qbit(`/api/v2/torrents/files?hash=${parsed.hash}`);
    const file = Array.isArray(files) ? files.find((f, i) => (f.index ?? i) === parsed.index) : null;
    if (!file || file.priority === 0 || !this.isVideo(file.name)) throw failure(404, 'This download has no playable video file.');
    const props = await this.qbit(`/api/v2/torrents/properties?hash=${parsed.hash}`);
    const pieceSize = Number(props?.piece_size);
    if (!(pieceSize > 0)) throw failure(409, 'This download is still starting. Try again in a moment.');
    const layout = fileLayout(files, parsed.index, pieceSize);
    if (!layout || !(layout.size > 0)) throw failure(404, 'This download has no playable video file.');
    const raced = this.entries.get(id);
    if (raced) return raced;
    const entry = { id, hash: parsed.hash, index: parsed.index, file: this.filePath(t, file), name: file.name, priority: file.priority, multiFile: files.length > 1,
      size: layout.size, layout, pieceSize, states: null, statesAt: 0, torrent: t, last: Date.now(), info: null, probing: null, probeFailures: 0, probeError: null,
      gone: false, boosted: false, started: false, enoughSince: null, holds: 0, heldMs: 0, restorePriorities: [] };
    this.entries.set(id, entry);
    return entry;
  }

  // Asks for fresh piece states at most once a second, however many readers are waiting.
  refresh(e, { force = false } = {}) {
    if (e.refreshing) return e.refreshing;
    if (!force && Date.now() - e.statesAt < POLL_MS) return Promise.resolve();
    e.refreshing = (async () => {
      try {
        const [t, states] = await Promise.all([this.torrent(e.hash), this.qbit(`/api/v2/torrents/pieceStates?hash=${e.hash}`)]);
        if (!t) { e.gone = true; return; }
        e.torrent = t;
        if (Array.isArray(states) && states.length) e.states = states;
      } catch (error) { this.log.warn?.(`[play now] ${error.message}`); } finally { e.statesAt = Date.now(); e.refreshing = null; }
    })();
    return e.refreshing;
  }

  readable(e, from = 0) { return readableBytes(e.layout, e.pieceSize, e.states, from); }

  complete(e) { return fileProgress(e.layout, e.states) >= 1; }

  // A video being watched whose download has finished and left qBittorrent.
  finished(id) { const e = this.entries.get(id); return Boolean(e?.gone && this.complete(e)); }

  // Waits until something can be read at `from`; resolves with how many bytes in a row.
  async waitReadable(e, from, signal) {
    let waitingSince = null;
    for (;;) {
      if (signal?.aborted) throw failure(499, 'Stopped.');
      e.last = Date.now();
      const n = this.readable(e, from);
      if (n > 0) {
        if (waitingSince != null && e.started) { e.holds += 1; e.heldMs += Date.now() - waitingSince; }
        return n;
      }
      waitingSince ??= Date.now();
      await this.refresh(e);
      if (e.gone) throw failure(410, 'That download no longer exists.');
      if (this.readable(e, from) > 0) continue;
      await sleep(POLL_MS, signal);
    }
  }

  // ---- the loopback file server ffmpeg reads from ----
  async inputUrl(e) {
    const port = await this.listen();
    return `http://127.0.0.1:${port}/${this.token}/${e.id}/video${path.extname(e.name).toLowerCase()}`;
  }

  async serve(req, res) {
    const [, token, id] = new URL(req.url, 'http://localhost').pathname.split('/');
    const given = Buffer.from(String(token)), wanted = Buffer.from(this.token);
    const e = given.length === wanted.length && crypto.timingSafeEqual(given, wanted) ? this.entries.get(id) : null;
    if (!e) { res.writeHead(404); res.end(); return; }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), e.size - 1) : e.size - 1;
    if (start >= e.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${e.size}` }); res.end(); return; }
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${e.size}` } : {}) });
    if (req.method === 'HEAD') { res.end(); return; }
    const stop = new AbortController();
    res.once('close', () => stop.abort());
    let handle = null;
    try {
      let at = start;
      while (at <= end) {
        const ready = await this.waitReadable(e, at, stop.signal);
        handle ||= await this.openWhenWritten(e.file, stop.signal);
        const buffer = Buffer.allocUnsafe(Math.min(ready, READ_BYTES, end - at + 1));
        const { bytesRead } = await this.readFully(handle, buffer, at, stop.signal);
        at += bytesRead;
        if (!res.write(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead))) {
          // Wait for room, or for the reader to go. A response that already closed never emits
          // again: waiting on it would park this read for ever and its file handle would only be
          // closed by the garbage collector ("Closing file descriptor ... on garbage collection").
          await new Promise((resolve) => {
            const go = () => { res.off('close', go); res.off('drain', go); stop.signal.removeEventListener('abort', go); resolve(); };
            res.once('drain', go); res.once('close', go); stop.signal.addEventListener('abort', go, { once: true });
            if (res.destroyed || stop.signal.aborted) go();
          });
        }
      }
      res.end();
    } catch { res.destroy(); } finally { await handle?.close().catch(() => {}); }
  }

  async openWhenWritten(file, signal) {
    const until = Date.now() + SHORT_READ_MS;
    for (;;) {
      try { return await fs.promises.open(file, 'r'); } catch (error) {
        if (signal?.aborted || Date.now() > until) throw error;
        await sleep(250, signal);
      }
    }
  }

  // A piece qBittorrent just verified can be a moment away from the file on disk.
  async readFully(handle, buffer, at, signal) {
    const until = Date.now() + SHORT_READ_MS;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, at);
      if (result.bytesRead > 0) return result;
      if (signal?.aborted || Date.now() > until) throw failure(503, 'The downloaded part could not be read.');
      await sleep(250, signal);
    }
  }

  // ---- downloading for playback ----
  // In order, first and last pieces early, this file first, and running even if it was stopped or queued.
  async boost(e) {
    if (e.boosted) return;
    e.boosted = true;
    try {
      const t = await this.torrent(e.hash);
      if (!t) throw failure(404, 'That download no longer exists.');
      let was = this.torrents.get(e.hash);
      if (!was) {
        was = { sequential: Boolean(t.seq_dl), firstLast: Boolean(t.f_l_piece_prio), forced: Boolean(t.force_start) };
        this.torrents.set(e.hash, was);
        const hashes = new URLSearchParams({ hashes: e.hash });
        if (!t.seq_dl) await this.post('/api/v2/torrents/toggleSequentialDownload', hashes);
        if (!t.f_l_piece_prio) await this.post('/api/v2/torrents/toggleFirstLastPiecePrio', hashes);
      }
      if (/^(paused|stopped)/.test(t.state || '')) await this.start(e.hash);
      else if (/^queued/.test(t.state || '') && !t.force_start) await this.post('/api/v2/torrents/setForceStart', new URLSearchParams({ hashes: e.hash, value: 'true' }));
      if (e.multiFile) await this.orderPack(e);
    } catch (error) { e.boosted = false; throw error; }
  }

  // Someone already watching this pack keeps the order set for them.
  async orderPack(e) {
    if ([...this.entries.values()].some((x) => x !== e && x.hash === e.hash && x.boosted)) return;
    const files = await this.qbit(`/api/v2/torrents/files?hash=${e.hash}`);
    if (!Array.isArray(files)) return;
    const before = new Map(files.map((f, i) => [f.index ?? i, f.priority]));
    for (const [file, priority] of packPriorities(files, e.index)) {
      await this.post('/api/v2/torrents/filePrio', new URLSearchParams({ hash: e.hash, id: String(file), priority: String(priority) }));
      e.restorePriorities.push([file, before.get(file)]);
    }
  }

  async open(id) {
    const e = await this.entry(id);
    e.last = Date.now();
    await this.boost(e);
    await this.refresh(e);
    // Finished torrents leave qBittorrent; the file is all there, so someone watching just carries on.
    if (e.gone && !this.complete(e)) { this.entries.delete(id); throw failure(404, 'That download no longer exists.'); }
    if (e.probeFailures >= MAX_PROBE_FAILURES) throw failure(422, e.probeError || 'Couldn’t read this video.');
    if (!e.info && !e.probing) {
      const input = await this.inputUrl(e);
      e.probing = this.probe(input, { size: e.size, timeout: PROBE_MS })
        .then((info) => { e.info = info; })
        .catch((error) => { e.probeFailures += 1; e.probeError = error.message; })
        .finally(() => { e.probing = null; });
    }
    if (e.info && !e.started) {
      const readable = this.readable(e, 0);
      if (readable >= startBytes(e.size, e.info.bitrate)) e.enoughSince ??= Date.now();
      e.started = readyToStart(readable, e.size, e.info.bitrate, e.enoughSince);
    }
    return { ready: Boolean(e.info) && e.started, entry: e };
  }

  // What the player shows about the download.
  status(e) {
    const t = e.torrent || {};
    const progress = fileProgress(e.layout, e.states);
    const speed = Number(t.dlspeed) || 0;
    const left = e.size * (1 - progress);
    const bitrate = e.info?.bitrate || 0;
    return { id: e.id, done: progress >= 1, progress, inOrder: e.size ? this.readable(e, 0) / e.size : 0, speed, eta: speed > 0 ? Math.round(left / speed) : null,
      state: t.state || '', paused: /^(paused|stopped)/.test(t.state || ''), seeds: Number.isFinite(t.num_seeds) ? t.num_seeds : null,
      keepsUp: bitrate > 0 ? speed * 8 >= bitrate * 1.1 : null, duration: e.info?.duration || null };
  }

  activeHashes() { return new Set([...this.entries.values()].map((e) => e.hash)); }

  // Nobody has asked for a while: the download carries on the way it was before.
  async sweep(now = Date.now()) {
    for (const e of [...this.entries.values()]) {
      if (now - e.last < IDLE_MS) continue;
      this.entries.delete(e.id);
      await this.restore(e).catch((error) => this.log.warn?.(`[play now] ${error.message}`));
    }
  }

  async restore(e) {
    if (e.started) {
      const mbit = ((e.info?.bitrate || 0) / 1e6).toFixed(1);
      this.log.info?.(`[play now] ${e.name}: ${mbit} Mbit/s, the stream waited for the download ${e.holds} times, ${Math.round(e.heldMs / 1000)} s in all`);
    }
    for (const [file, priority] of e.restorePriorities) {
      await this.post('/api/v2/torrents/filePrio', new URLSearchParams({ hash: e.hash, id: String(file), priority: String(priority) }));
    }
    if ([...this.entries.values()].some((x) => x.hash === e.hash)) return;
    const was = this.torrents.get(e.hash);
    this.torrents.delete(e.hash);
    if (!was) return;
    const t = await this.torrent(e.hash);
    if (!t) return;
    const hashes = new URLSearchParams({ hashes: e.hash });
    if (Boolean(t.seq_dl) !== was.sequential) await this.post('/api/v2/torrents/toggleSequentialDownload', hashes);
    if (Boolean(t.f_l_piece_prio) !== was.firstLast) await this.post('/api/v2/torrents/toggleFirstLastPiecePrio', hashes);
    if (Boolean(t.force_start) !== was.forced) await this.post('/api/v2/torrents/setForceStart', new URLSearchParams({ hashes: e.hash, value: String(was.forced) }));
  }

  close() {
    clearInterval(this.timer);
    this.server?.close();
    this.server?.closeAllConnections?.();
  }
}
