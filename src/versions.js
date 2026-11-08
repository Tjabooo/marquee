// Versions: two files of the same film, or of the same episode, are one title with a quality choice,
// not two titles. A 4K and a 1080p Dune show as one card; the person picks which one plays, and the
// watch position is shared between them. Two copies at the same resolution are refused when they're
// downloaded (server.js), so versions differ in quality, or in audio when someone asks for an anime's dub.
//
// Pure helpers: the grouping key, quality and source from a file name, a short label, and the order
// versions are offered in (best first: resolution, then source, then size).
import { sourceOf, isDualAudio } from './recommend.js';
import { showKey } from './shows.js';

const QUALITY_RANK = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, SD: 1 };
const SOURCE_RANK = { remux: 6, bluray: 5, web: 4, webrip: 3, tv: 2, dvd: 1, upscale: 0 };
const SOURCE_NAME = { remux: 'Remux', bluray: 'BluRay', web: 'WEB-DL', webrip: 'WEBRip', tv: 'TV', dvd: 'DVD', upscale: 'Upscale' };

// Resolution from a release or file name (the same reading torrent search uses).
export function qualityOf(name) {
  const n = String(name || '').replace(/[._]+/g, ' ');
  return /\b(2160p|4k|uhd)\b/i.test(n) ? '2160p'
    : /\b(1440p|qhd|2560\s*[x×]\s*1440)\b/i.test(n) ? '1440p'
    : /\b1080p\b|\b1920\s*[x×]\s*10[78]\d\b/i.test(n) ? '1080p'
    : /\b720p\b|\b1280\s*[x×]\s*720\b/i.test(n) ? '720p'
    : /\b(480p|576p|dvdrip|xvid)\b/i.test(n) ? 'SD' : null;
}

// What makes two files versions of one title. Episodes: show, season, episode. Films: the TMDB film
// (or, unidentified, the parsed title and year). null: not something versions apply to.
export function versionKey(item) {
  if (item.season != null && item.episode != null) return `ep:${item.show || showKey(item.title)}:${item.season}:${item.episode}`;
  if (item.season != null) return null;
  if (item.tmdbId && !item.movieAmbiguous) return `film:${item.tmdbId}`;
  const key = showKey(item.filmTitle || item.title || '');
  return key ? `film:${key}:${item.year || ''}` : null;
}

// Several files of one season: the season's key, for a choice that applies to every episode.
export const seasonKey = (item) => (item.season != null && item.episode != null ? `season:${item.show || showKey(item.title)}:${item.season}` : null);

const qualityName = (q) => (q === '2160p' ? '4K' : q === 'SD' ? 'SD' : q || '');
const sizeText = (bytes) => (bytes > 0 ? (bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3 * 10) / 10} GB` : `${Math.round(bytes / 1024 ** 2)} MB`) : '');

// { quality, source, label, signature }. The label reads "4K · BluRay · 18.2 GB"; a dual-audio copy (its
// file or batch folder says so) is a version of its own beside a subtitled one in the same quality. The signature
// ("2160p|bluray") is the same for every episode of one season pack, so a season-wide choice can find
// the matching version of each episode.
export function versionInfo(item) {
  const name = item.file || '';
  const quality = qualityOf(name);
  const source = sourceOf(name);
  const dubbed = isDualAudio(item.full || name);
  return {
    versionQuality: quality,
    versionSource: source,
    versionLabel: [qualityName(quality), SOURCE_NAME[source], dubbed && 'Dual audio', sizeText(item.size)].filter(Boolean).join(' · ') || 'Version',
    versionSignature: `${quality || '?'}|${source || '?'}${dubbed ? '|dual' : ''}`,
    ...(dubbed ? { versionDubbed: true } : {}),
  };
}

// Best first: resolution, then source, then size. Stable for equal versions (by id).
export function rankVersions(list) {
  return [...list].sort((a, b) => (QUALITY_RANK[b.versionQuality] || 0) - (QUALITY_RANK[a.versionQuality] || 0)
    || (SOURCE_RANK[b.versionSource] ?? -1) - (SOURCE_RANK[a.versionSource] ?? -1)
    || (b.size || 0) - (a.size || 0) || String(a.id).localeCompare(String(b.id)));
}

// items -> one item per title: the best version, with `versions` (best first, every one of them,
// itself included) when there is more than one. Items versions don't apply to pass through.
export function collapseVersions(items) {
  const groups = new Map();
  const out = [];
  for (const item of items) {
    const key = item.versionKey;
    if (!key) { out.push(item); continue; }
    if (!groups.has(key)) { groups.set(key, []); out.push(key); }
    groups.get(key).push(item);
  }
  return out.map((x) => {
    if (typeof x !== 'string') return x;
    const list = rankVersions(groups.get(x));
    return list.length === 1 ? list[0] : { ...list[0], versions: list };
  });
}

// Same resolution counts as the same version (a second 1080p of a film is a duplicate, a 4K isn't).
// Unknown resolutions only match each other.
export const sameQuality = (a, b) => (a || null) === (b || null);
