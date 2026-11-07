// Season and episode identity, shared by smart downloads (smart-download.js), manual torrent search
// and the Library: which show a release is, and which episodes of a season it covers.
import { showKey } from './shows.js';
import { episodesInSeason } from './anime.js';

// "South Park S18", "South Park season 18", "south.park.s18.complete" -> { title, year, season }
export function parseSeasonQuery(q) {
  const m = /^(.*?)[\s.]+(?:s(\d{1,2})|season[\s.]*(\d{1,2}))(?:[\s.]+(?:complete|full))?[\s.]*$/i.exec(String(q || '').trim());
  if (!m) return null;
  let title = m[1].replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  let year = null;
  const y = /^(.*?)\s*\(?((?:19|20)\d{2})\)?$/.exec(title);
  if (y && y[1]) { title = y[1].trim(); year = Number(y[2]); }
  if (!title) return null;
  return { title, year, season: Number(m[2] || m[3]) };
}

// Episodes a release name covers: "S18E01" -> [1], "S18E01E02" / "S18E01-E03" -> [1, 2(, 3)].
// Anime names too ("Show - 05", "Show S2 - 03", "Show (01-12) [Batch]"). With an anime context
// (anime.js) every name is placed on TMDB's numbering: for Frieren (TMDB: one season of 38),
// "Sousou no Frieren S2 - 03" is season 1 episode 31.
export function episodesIn(name, season, ctx = null) {
  if (!Number.isInteger(season) || season < 0 || season > 99) return [];
  if (ctx) return episodesInSeason(name, season, ctx);
  const standard = standardEpisodes(name, season);
  return standard.length || /\bS\d{1,2}\s?E\d/i.test(name) ? standard : episodesInSeason(name, season, null);
}

function standardEpisodes(name, season) {
  const normalized = String(name).replace(/[._]+/g, ' ');
  const x = new RegExp(`\\b0?${season}x(\\d{1,3})(?!\\d)`, 'i').exec(normalized);
  if (x) return [Number(x[1])];
  const long = new RegExp(`\\bSeason\\s*0?${season}\\s+Episode\\s*(\\d{1,3})(?!\\d)`, 'i').exec(normalized);
  if (long) return [Number(long[1])];
  const m = new RegExp(`\\bS0?${season}\\s?E(\\d{1,3})(?![\\dp])`, 'i').exec(normalized);
  if (!m) return [];
  const episodes = [Number(m[1])];
  let tail = normalized.slice(m.index + m[0].length);
  for (;;) {
    const next = /^\s*(-\s*E?|E)\s*(\d{1,3})(?![\dp])/i.exec(tail);
    if (!next) break;
    const ep = Number(next[2]), previous = episodes.at(-1);
    if (next[1].trim().startsWith('-') && ep > previous && ep - previous <= 100) {
      for (let n = previous + 1; n <= ep; n++) episodes.push(n);
    } else episodes.push(ep);
    tail = tail.slice(next[0].length);
  }
  return [...new Set(episodes)];
}

// Some shows have established release aliases (notably House / House M.D.).
// Never compare only the first word: House of the Dragon must not match House.
export function sameShow(a, b) {
  const normalize = (value) => {
    const key = showKey(value);
    return key === 'housemd' ? 'house' : key;
  };
  return Boolean(normalize(a)) && normalize(a) === normalize(b);
}

// Search variants are attempted only after the exact title/episode search fails.
export function episodeQueries(title, season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const titles = [title];
  if (showKey(title) === 'house') titles.push('House MD');
  if (showKey(title) === 'housemd') titles.push('House');
  return [...new Set(titles.flatMap((name) => [
    `${name} S${s}E${e}`, `${name} ${season}x${e}`,
  ]))];
}
