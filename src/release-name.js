// Release and file names -> title, year, season, episode.
// "The.Matrix.1999.1080p.BluRay.x264.mkv" -> { title: "The Matrix", year: 1999 }
// "Severance.S02E03.1080p.mkv"           -> { title: "Severance", season: 2, episode: 3 }
// Also "S01E01E02" (first episode counts), "1x05" and "Season 1 Episode 5". A name that starts with
// the episode ("S01E05.1080p.mkv") gets an empty title; the library takes the folder's name then.
// Anime names ("[SubsPlease] Sousou no Frieren S2 - 03 (1080p) [7556A22B].mkv") go through anime.js:
// season 2 episode 3 here, `absolute` when no season is named ("Black Clover - 176": numbered from
// the first episode). The library places those on TMDB's seasons once it knows the show (anime.js).
import { parseAnimeName } from './anime.js';

const EPISODE_PATTERNS = [
  /\bS(\d{1,2})\s?E(\d{1,3})(?=\b|E\d)/i,
  /\bSeason\s?(\d{1,2})\s?Episode\s?(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/i,
];
const GROUP_TAG = /^\s*[[【][^\]】]{1,40}[\]】]\s*/;

export function parseName(raw, { file = true, allowEmpty = false } = {}) {
  let name = (file ? raw.replace(/\.[a-z0-9]{2,4}$/i, '') : raw).replace(GROUP_TAG, '').replace(/[._]+/g, ' ');
  const ep = EPISODE_PATTERNS.map((re) => name.match(re)).find(Boolean);
  if (!ep) {
    const anime = parseAnimeName(raw, { file });
    const one = anime?.episodes?.length === 1 && !anime.movie && (!anime.seasons || anime.seasons.length === 1);
    // A lone " - 7" without a group tag is too weak a sign ("Rocky - 4"); "- 07" or a group isn't.
    if (one && (anime.group || !anime.title || anime.episodes[0] >= 10 || /\s-\s0\d/.test(raw) || anime.seasons) && (anime.title || allowEmpty)) {
      return {
        title: anime.title,
        year: anime.year,
        season: anime.seasons ? anime.seasons[0] : 1,
        episode: anime.episodes[0],
        absolute: !anime.seasons,
        anime: true,
      };
    }
  }
  // The last year-like number wins: "Blade Runner 2049 2017" -> 2017.
  const year = [...name.matchAll(/[\s(\[]((?:19|20)\d{2})(?=[\s)\]]|$)/g)].at(-1);
  const cutAt = [ep?.index, year?.index,
    name.search(/\b(2160p|1440p|qhd|2560\s*[x×]\s*1440|1080p|720p|480p|4k|uhd|bluray|brrip|web[- ]?dl|webrip|hdtv|dvdrip|x26[45]|h ?26[45]|hevc|remux)\b/i)]
    .filter((i) => i !== undefined && i > 0);
  const bare = ep?.index === 0;
  let title = bare ? '' : cutAt.length ? name.slice(0, Math.min(...cutAt)) : name;
  title = title.replace(/[\s\-([]+$/g, '').replace(/\s+/g, ' ').trim() || (bare && allowEmpty ? '' : name.trim());
  return {
    title,
    year: year ? Number(year[1]) : null,
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
  };
}
