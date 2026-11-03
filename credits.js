// Read only explicit ending chapter labels. Unknown/generic chapters never imply credits.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

const FFPROBE = process.env.FFPROBE || 'ffprobe';
const cache = new Map();
const pending = new Map();
const LIMIT = 128;

export function creditsStart(info) {
  const duration = Number(info?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(info?.chapters)) return null;
  const matches = info.chapters.filter((chapter) => {
    const title = String(chapter.tags?.title || '').trim().replace(/[_–—-]+/g, ' ').replace(/\s+/g, ' ');
    // Anchored labels avoid opening credits, post-credits scenes and titles mentioning credits.
    return /^(?:(?:end|ending|closing)\s+credits?|credits?(?:\s+(?:end|ending|closing))?|outro|ending|ed)(?:\s*\(\d+\))?$/i.test(title);
  }).map((chapter) => Number(chapter.start_time))
    // A label in the first half is likely an opening or malformed metadata.
    .filter((at) => Number.isFinite(at) && at > duration / 2 && at < duration);
  return matches.length ? Math.min(...matches) : null;
}

function probe(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-show_chapters', '-show_entries',
      'format=duration:chapter=start_time:chapter_tags=title', '-of', 'json', file],
    { timeout: 6000, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(creditsStart(JSON.parse(stdout))); } catch { resolve(null); }
    });
  });
}

export async function creditsFor(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key && Date.now() - hit.at < 3600000) return hit.value;
  if (pending.has(key)) return pending.get(key);
  // Cap probes as well as cached entries; timing is optional and must not delay playback.
  if (pending.size >= 4) return null;
  const task = probe(file).then((value) => {
    cache.delete(file);
    cache.set(file, { key, value, at: Date.now() });
    if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
