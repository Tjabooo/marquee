// "Best download" for a film or a show's season: one torrent picked from the search results, so a
// title can be downloaded with one tap from its details sheet.
//
// What counts as a match: the release name parses to the same title (and, for films, a year within
// one of the film's), no cinema recordings, at least two seeders. For a season, a pack of exactly
// that season (not single episodes, not multi-season sets).
//
// Quality: 1080p, 1440p or 4K whenever one exists (1080p first, or the preferred resolution); 720p,
// unlabelled and SD only when nothing 1080p or better is out there. Torrents with 5+ seeders are
// tried before thin ones within each step, so a dead 1080p doesn't beat a lively one.
// Among those: more seeders, trusted uploaders, sane sizes; remuxes (huge), burned-in subtitles
// and Dolby Vision without an HDR10 fallback (odd colours on most screens) count against.
import { showKey } from './shows.js';
import { sameShow } from './season.js';

const HEALTHY = 5;
const ALIVE = 2;
const GB = 1024 ** 3;

const qualityOrder = (prefer) => {
  const order = ['1080p', '1440p', '2160p'];
  return order.includes(prefer) ? [prefer, ...order.filter((q) => q !== prefer)] : order;
};

// "Severance S02 1080p", "Severance Season 2 Complete" -> "Severance" (null when it's no season pack).
function packTitle(name, season) {
  const n = name.replace(/[._]+/g, ' ');
  if (/\bS\d{1,2}\s?E\d{1,3}\b|\b\d{1,2}x\d{2,3}\b/i.test(n)) return null;          // single episodes
  if (/\bS\d{1,2}\s?-\s?S?\d{1,2}\b|\bseasons?\s?\d{1,2}\s?-\s?\d{1,2}\b|complete series/i.test(n)) return null; // ranges
  const m = new RegExp(`^(.*?)\\b(?:S0?${season}|season\\s?0?${season})\\b(?!\\s?E\\d)`, 'i').exec(n);
  return m ? m[1] : null;
}

// Higher is better; only compares torrents of the same quality.
function score(r, type) {
  let s = Math.log10(r.seeders + 1);
  if (r.trusted) s += 0.3;
  if (r.tags.includes('Remux')) s -= 2;
  if (/\b(hc|hardsub|korsub|hcsubs?)\b/i.test(r.name)) s -= 2;
  if (/\b(dv|dovi|dolby ?vision)\b/i.test(r.name) && !/\bhdr(10)?\b/i.test(r.name)) s -= 1;
  if (r.size && type === 'movie') {
    const cap = r.quality === '2160p' ? 30 * GB : 16 * GB;
    if (r.size > cap) s -= 1;
    if (r.size < 0.5 * GB && ['1080p', '1440p', '2160p'].includes(r.quality)) s -= 1.5; // too small to be real
  }
  return s;
}

// results: torrents.searchTorrents() results. want: { type: 'movie' | 'tv', title, year?, season?, prefer? }
// parseName: the server's release-name parser. Returns { pick, why } (pick null when nothing fits).
export function pickBest(results, want, parseName) {
  const key = showKey(want.title);
  const live = results.filter((r) => !r.cam && r.seeders >= ALIVE);
  if (want.type === 'tv') {
    const keyOf = (r) => { const t = packTitle(r.name, want.season); return t == null ? null : showKey(parseName(t, { file: false }).title); };
    // "The Office US" for TMDB's "The Office": only when no pack uses the plain name.
    const exact = live.filter((r) => { const t = packTitle(r.name, want.season);
      return t != null && sameShow(parseName(t, { file: false }).title, want.title); });
    return choose(exact.length ? exact : live.filter((r) => keyOf(r)?.startsWith(key) && COUNTRIES.has(keyOf(r).slice(key.length))), want);
  }
  return choose(live.filter((r) => {
    const p = parseName(r.name, { file: false });
    return p.season == null && showKey(p.title) === key && (!want.year || !p.year || Math.abs(p.year - want.year) <= 1);
  }), want);
}

const COUNTRIES = new Set(['us', 'uk', 'au', 'nz', 'ca']);

function choose(fits, want) {
  if (want.quality && want.quality !== 'all') {
    fits = fits.filter((r) => r.quality === want.quality);
    if (!fits.length) return { pick: null, why: `No matching ${want.quality === '2160p' ? '4K' : want.quality} release has enough seeders.` };
    const healthy = fits.filter((r) => r.seeders >= HEALTHY);
    const pool = healthy.length ? healthy : fits;
    return { pick: pool.sort((a, b) => score(b, want.type) - score(a, want.type))[0], why: null };
  }
  if (!fits.length) return { pick: null, why: 'No release that clearly matches.' };
  const top = qualityOrder(want.prefer);
  const steps = [
    ...top.map((q) => [[q], HEALTHY]), [top, ALIVE],             // 1080p or better, however thin
    [['720p'], HEALTHY], [[null], HEALTHY], [['SD'], HEALTHY],   // then lower, only if that found nothing
    [['720p', null, 'SD'], ALIVE],
  ];
  for (const [qualities, min] of steps) {
    const pool = fits.filter((r) => qualities.includes(r.quality ?? null) && r.seeders >= min);
    if (!pool.length) continue;
    // Within a mixed step, keep the preferred quality first; then the best score.
    pool.sort((a, b) => (qualities.indexOf(a.quality ?? null) - qualities.indexOf(b.quality ?? null))
      || score(b, want.type) - score(a, want.type));
    const pick = pool[0];
    const low = !['1080p', '1440p', '2160p'].includes(pick.quality);
    return { pick, why: low ? 'Nothing in 1080p, 1440p or 4K is available, so this is the best there is.' : null };
  }
  return { pick: null, why: 'No release that clearly matches.' };
}
