// Scratch drive for unfinished downloads (SCRATCH_DIR). Torrents write their pieces in random order,
// which on a hard disk stalls everything else reading from it (playback above all). Downloads that
// fit are kept on a faster drive until they finish; qBittorrent then moves each one to its save
// path in one sequential copy. Downloads that don't fit stay on the media drive, as before.
import path from 'node:path';

const GiB = 1024 ** 3;
const STOPPED = /^(paused|stopped|error|missingFiles|moving|checking|metaDL|forcedMetaDL|allocating|unknown)/;

const inside = (p, dir) => {
  if (!p || !dir) return false;
  const a = path.resolve(p).toLowerCase(), b = path.resolve(dir).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

// Unfinished data of this torrent lives on the scratch drive (download_path is the setting;
// content_path is where the files are right now).
export const usesScratch = (t, scratchDir) => Boolean(t?.download_path) && inside(t.download_path, scratchDir);

// Folder the torrent's files are in right now: the download path while it's unfinished there,
// otherwise its save path. qBittorrent moves the files when the download completes.
export function liveRoot(t) {
  if (t?.download_path && t.content_path && inside(t.content_path, t.download_path)) return t.download_path;
  return t?.save_path || null;
}

// Which torrents to move onto the scratch drive, and which back to the media drive.
// freeBytes: free space on the scratch drive now; reserveBytes: never planned into (keeps Windows
// and everything else on that drive healthy); otherReserved: space promised to other writers
// (conversions in progress); maxCopyBytes: a torrent that has already written more than this
// stays where it is, since moving it means copying that data.
export function scratchPlan({ torrents = [], scratchDir, freeBytes, reserveBytes = 40 * GiB, otherReserved = 0, maxCopyBytes = 2 * GiB }) {
  const toScratch = [], toMedia = [];
  if (!scratchDir || !Number.isFinite(freeBytes)) return { toScratch, toMedia, room: 0 };
  const on = [], candidates = [];
  for (const t of torrents) {
    if (!t?.hash || t.auto_tmm) continue; // automatic management decides its own paths
    const unfinished = Number(t.progress) < 1 && Number(t.amount_left) > 0;
    if (usesScratch(t, scratchDir)) { if (unfinished) on.push(t); continue; }
    if (!unfinished || t.download_path || !(Number(t.size) > 0) || STOPPED.test(t.state || '')) continue;
    if ((Number(t.completed) || 0) > maxCopyBytes) continue;
    candidates.push(t);
  }
  const pending = on.reduce((n, t) => n + (Number(t.amount_left) || 0), 0);
  // Running low anyway (something else filled the drive): send the largest one back, one per round.
  if (on.length && freeBytes - otherReserved - pending < reserveBytes / 2) {
    const biggest = [...on].sort((a, b) => (Number(b.amount_left) || 0) - (Number(a.amount_left) || 0))[0];
    toMedia.push(biggest.hash);
    return { toScratch, toMedia, room: 0 };
  }
  let room = freeBytes - pending - reserveBytes - otherReserved;
  candidates.sort((a, b) => (Number(a.added_on) || 0) - (Number(b.added_on) || 0));
  for (const t of candidates) {
    const need = Number(t.size) || 0; // the data already written moves along with it
    if (need > room) continue;
    toScratch.push(t.hash);
    room -= need;
  }
  return { toScratch, toMedia, room };
}
