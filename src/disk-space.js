// Keeps cache folders from filling their drive. Every cached copy can be made again, so when a new one
// needs room, or the folder is over its cap, the copies watched longest ago are deleted first.
import fs from 'node:fs';

export const GB = 1024 ** 3;

// Free bytes on the drive holding `dir`, or null when the system can't tell.
export async function freeBytes(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

// True when a and b are on the same drive (volume), so deleting in one frees space for the other.
export function sameDrive(a, b) {
  try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch { return false; }
}

// Which cached copies to delete so a new file of `need` bytes fits.
//   entries:   [{ name, size, used, evictable? }] (used = ms timestamp; evictable=false still counts toward the cap)
//   maxBytes:  the folder's cap (0 = none); `need` counts against it only when inFolder
//   free:      free bytes on the output's drive (null = unknown); minFree must stay free after `need`
//   sameDrive: the folder is on the output's drive, so deleting here frees space there
//   keepSince: copies used at or after this time are never deleted
// Returns { names: least recently used first, fits: whether the new file fits after deleting them }.
export function pickEvictions(entries, { need = 0, inFolder = true, maxBytes = 0, free = null, minFree = 0, sameDrive: same = true, keepSince = Infinity } = {}) {
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  let left = free;
  const capOk = () => !(maxBytes > 0) || total + (inFolder ? need : 0) <= maxBytes;
  const freeOk = () => left == null || left - need >= minFree;
  const names = [];
  for (const e of [...entries].sort((a, b) => a.used - b.used)) {
    if (capOk() && (freeOk() || !same)) break;
    if (e.used >= keepSince) break; // sorted: everything after this was used recently too
    if (e.evictable === false) continue; // still occupies space; it just cannot be removed for this job
    names.push(e.name);
    total -= e.size;
    if (same && left != null) left += e.size;
  }
  return { names, fits: capOk() && freeOk() };
}
