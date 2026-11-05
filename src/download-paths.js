// Destination for new torrents. Explicit catalogue identity takes precedence;
// recognizable TV releases can also be routed when added from a manual search.
// Unknown torrents use qBittorrent's default save path (Downloads).
import path from 'node:path';

// qBittorrent file names are relative to save_path. Reject an unexpected absolute path or
// traversal before it can reach streaming, conversion or deletion code.
export function downloadFilePath(savePath, name) {
  if (!savePath || typeof name !== 'string' || !name || name.includes('\0')) return null;
  const relative = name.replace(/[\\/]/g, path.sep);
  if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) return null;
  const root = path.resolve(savePath), full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? full : null;
}

export function downloadDestination(mediaDir, { mediaType, film, name = '' } = {}) {
  if (!mediaDir) return null;
  if (film || mediaType === 'movie') return path.join(mediaDir, 'Movies');
  if (mediaType === 'tv' || /\bS\d{1,2}\s?E\d{1,3}\b|\bS\d{1,2}(?!\s?E\d)\b|\bSeason[ ._-]*\d{1,2}\b|\b\d{1,2}x\d{2,3}\b/i.test(name)) {
    return path.join(mediaDir, 'TV');
  }
  return null;
}
