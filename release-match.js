// Title identity shared by manual torrent results and automatic episode selection.
import { showKey } from './shows.js';

export function matchesRelease(query, releaseName, parseName) {
  const q = String(query || '').trim();
  if (!q) return false;
  const episode = /^(.*?)[\s.]+S(\d{1,2})\s?E(\d{1,3})(?:\b|$)/i.exec(q);
  const season = !episode && /^(.*?)[\s.]+(?:S(\d{1,2})|season[\s.]*(\d{1,2}))(?:[\s.]+(?:complete|full))?\s*$/i.exec(q);
  const bare = episode ? episode[1] : season ? season[1] : q;
  const year = /^(.*?)\s*\(?((?:19|20)\d{2})\)?$/.exec(bare);
  const title = year ? year[1] : bare;
  const expected = showKey(title);
  const parsed = parseName(releaseName, { file: false });
  // Season packs have no episode marker, so the library parser may leave S01/Season 1 in the title.
  const releasedTitle = parsed.title.replace(/(?:[\s.]+(?:S\d{1,2}|season[\s.]*\d{1,2}))(?:[\s.]+(?:complete|full))?\s*$/i, '').trim();
  if (!expected || showKey(releasedTitle) !== expected) return false;
  if (year && parsed.year && parsed.year !== Number(year[2])) return false;
  if (episode) {
    return parsed.season === Number(episode[2]) && parsed.episode === Number(episode[3]);
  }
  if (season) {
    // A season search may show packs and individual episodes, but not other seasons.
    const s = Number(season[2] || season[3]);
    const text = String(releaseName).replace(/[._]+/g, ' ');
    return parsed.season === s || new RegExp(`\\b(?:S0?${s}(?!\\d)|season\\s*0?${s}\\b)`, 'i').test(text);
  }
  return true;
}
