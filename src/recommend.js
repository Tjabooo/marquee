// "Best download" for a film, a show's season pack or one episode: one torrent picked from the search
// results, so a title downloads with one tap and nobody has to read release names.
//
// What counts as a match: the release name parses to the same title (and, for films, a year within
// one of the film's), no cinema recordings, at least two seeders. For a season, a pack of exactly
// that season (not single episodes, not multi-season sets, not "complete series" bundles).
//
// Quality follows the person's profile (Settings → Download quality):
// - Balanced (default): 1080p, 1440p or 4K whenever one exists (1080p first, or the preferred
//   resolution); 720p, unlabelled and SD only when nothing 1080p or better is out there.
// - Best Quality: 4K, then 1440p, then 1080p.
// - Save Space: a compact 1080p or 720p under a size target; larger ones only if nothing fits.
// Torrents with 5+ seeders are tried before thin ones within each step, so a dead 1080p doesn't beat
// a lively one. Among those: more seeders, trusted uploaders, sane sizes; remuxes (huge), burned-in
// subtitles, Dolby Vision without an HDR10 fallback (odd colours on most screens) and dubbed-only
// releases in a language you didn't ask for count against.
// Hard limits, never relaxed: an exact resolution chosen in Advanced, the largest size per film or
// episode from Settings, and the free space on the media disk.
import { showKey } from './shows.js';
import { sameShow } from './season.js';

const HEALTHY = 5;
const ALIVE = 2;
const GB = 1024 ** 3;
export const PROFILES = ['save', 'balanced', 'best'];
// Save Space size targets (bytes): per film, per episode.
const SAVE_TARGET = { movie: 2.5 * GB, episode: 0.75 * GB };

const qualityOrder = (prefer, profile = 'balanced') => {
  const order = profile === 'best' ? ['2160p', '1440p', '1080p'] : ['1080p', '1440p', '2160p'];
  return order.includes(prefer) ? [prefer, ...order.filter((q) => q !== prefer)] : order;
};

// "Severance S02 1080p", "Severance Season 2 Complete" -> "Severance" (null when it's no season pack).
export function packTitle(name, season) {
  const n = name.replace(/[._]+/g, ' ');
  if (/\bS\d{1,2}\s?E\d{1,3}\b|\b\d{1,2}x\d{2,3}\b/i.test(n)) return null;          // single episodes
  if (/\bS\d{1,2}\s?-\s?S?\d{1,2}\b|\bseasons?\s?\d{1,2}\s?-\s?\d{1,2}\b|complete series/i.test(n)) return null; // ranges
  const m = new RegExp(`^(.*?)\\b(?:S0?${season}|season\\s?0?${season})\\b(?!\\s?E\\d)`, 'i').exec(n);
  return m ? m[1] : null;
}

// Audio language: dubbed-only releases are labelled in the name ("FRENCH", "iTA", "Hindi"), multi-
// language ones as MULTI or DUAL. Codes are the same two-letter codes as subtitle languages.
const LANGUAGE_TAGS = {
  en: /\b(eng|english)\b/i, sv: /\b(swe|swedish|nordic)\b/i, da: /\b(danish|dan)\b/i, no: /\b(norwegian|nor)\b/i,
  fi: /\b(finnish|fin)\b/i, de: /\b(german|ger|deutsch)\b/i, fr: /\b(french|truefrench|vff|vfq|vf2)\b/i,
  es: /\b(spanish|spa|castellano|latino)\b/i, it: /\b(ita|italian)\b/i, pt: /\b(portuguese|dublado|pt-br)\b/i,
  nl: /\b(dutch)\b/i, pl: /\b(polish|pldub|lektor)\b/i, ru: /\b(rus|russian)\b/i, tr: /\b(turkish|tur)\b/i,
  hi: /\b(hindi)\b/i, ta: /\b(tamil)\b/i, te: /\b(telugu)\b/i, ja: /\b(japanese|jpn)\b/i, ko: /\b(korean|kor)\b/i,
  zh: /\b(chinese|mandarin|cantonese)\b/i, ar: /\b(arabic)\b/i, hu: /\b(hungarian|hun)\b/i, cs: /\b(czech|cz)\b/i,
};
const MULTI = /\b(multi|dual[ ._-]?audio|dual)\b/i;
// 2: has the wanted language (or several). 1: unlabelled (usually the original). 0: dubbed in another one.
export function languageFit(name, audioLang = '') {
  const tail = String(name).replace(/[._]+/g, ' ').replace(/^.*?\b((?:19|20)\d{2}|S\d{1,2}|season\s?\d{1,2})\b/i, '');
  const wanted = LANGUAGE_TAGS[audioLang];
  if (wanted?.test(tail)) return 2;
  if (MULTI.test(tail)) return audioLang && audioLang !== 'en' ? 1.5 : 1;
  const other = Object.entries(LANGUAGE_TAGS).some(([code, re]) => code !== 'en' && code !== audioLang && re.test(tail));
  return other ? 0 : 1;
}

// Higher is better; only compares torrents of the same quality.
function score(r, want, kind) {
  let s = Math.log10(r.seeders + 1);
  if (r.trusted) s += 0.3;
  if (r.tags?.includes('Remux')) s -= want.profile === 'best' ? 0.75 : 2;
  if (/\b(hc|hardsub|korsub|hcsubs?)\b/i.test(r.name)) s -= 2;
  if (/\b(dv|dovi|dolby ?vision)\b/i.test(r.name) && !/\bhdr(10)?\b/i.test(r.name)) s -= 1;
  if (want.audioLang) s += (languageFit(r.name, want.audioLang) - 1) * 0.8;
  const size = perItemSize(r, want, kind);
  if (size) {
    const unit = kind === 'movie' ? 1 : 0.15; // an episode is roughly a seventh of a film
    const cap = (r.quality === '2160p' ? 30 : 16) * GB * unit;
    if (size > cap) s -= 1;
    if (size < 0.5 * GB * unit && ['1080p', '1440p', '2160p'].includes(r.quality)) s -= 1.5; // too small to be real
    if (want.profile === 'save') s -= size / (SAVE_TARGET[kind === 'movie' ? 'movie' : 'episode']) * 0.5;
  }
  return s;
}

// The size that counts against limits: a film's whole size, a pack's size per episode.
const perItemSize = (r, want, kind) => (kind === 'pack' && want.episodes > 0 && r.size ? r.size / want.episodes : r.size || 0);
// The space a download really takes: a pack with owned episodes deselected only downloads the rest.
const diskSize = (r, want) => (want.type === 'tv' && want.episodes > 0 && want.missing > 0 && r.size
  ? r.size * Math.min(1, want.missing / want.episodes) : r.size || 0);

// results: torrents.searchTorrents() results. want: { type: 'movie' | 'tv' | 'episode', title, year?,
// season?, episode?, quality? (exact), prefer?, profile?, maxBytes?, freeBytes?, audioLang?,
// episodes? (aired in the season), missing? (of those) }. parseName: the server's release-name parser.
// Returns { pick, why } (pick null when nothing fits; why says why in plain words).
export function pickBest(results, want, parseName) {
  const key = showKey(want.title);
  const live = results.filter((r) => !r.cam && r.seeders >= ALIVE);
  if (want.type === 'tv') {
    const keyOf = (r) => { const t = packTitle(r.name, want.season); return t == null ? null : showKey(parseName(t, { file: false }).title); };
    // "The Office US" for TMDB's "The Office": only when no pack uses the plain name.
    const exact = live.filter((r) => { const t = packTitle(r.name, want.season);
      return t != null && sameShow(parseName(t, { file: false }).title, want.title); });
    const packs = exact.length ? exact : live.filter((r) => keyOf(r)?.startsWith(key) && COUNTRIES.has(keyOf(r).slice(key.length)));
    return choose(packs, want, 'pack');
  }
  return choose(live.filter((r) => {
    const p = parseName(r.name, { file: false });
    return p.season == null && showKey(p.title) === key && (!want.year || !p.year || Math.abs(p.year - want.year) <= 1);
  }), want, 'movie');
}

// Releases already filtered to the right show, season and episode (season.js): the best one, by the
// same profile, limits and language rules as films and packs. One seeder is enough for an episode.
export function pickEpisode(fits, want) {
  return choose(fits.filter((r) => !r.cam && r.seeders > 0), { ...want, type: 'episode' }, 'episode', 1);
}

const COUNTRIES = new Set(['us', 'uk', 'au', 'nz', 'ca']);
const qualityName = (q) => (q === '2160p' ? '4K' : q);
const fmtGB = (bytes) => `${Math.round(bytes / GB * 10) / 10} GB`;

function limits(fits, want, kind) {
  let why = null;
  if (want.maxBytes > 0) {
    const within = fits.filter((r) => !r.size || perItemSize(r, want, kind) <= want.maxBytes);
    if (fits.length && !within.length) why = `Every suitable release is larger than your ${fmtGB(want.maxBytes)} limit.`;
    fits = within;
  }
  if (Number.isFinite(want.freeBytes)) {
    const fitsDisk = fits.filter((r) => !r.size || diskSize(r, want) <= want.freeBytes);
    if (fits.length && !fitsDisk.length) why = `Not enough free space for a suitable download (${fmtGB(Math.max(0, want.freeBytes))} free).`;
    fits = fitsDisk;
  }
  // A dubbed-only release in another language only when nothing else exists.
  const spoken = fits.filter((r) => languageFit(r.name, want.audioLang) > 0);
  if (spoken.length) fits = spoken;
  return { fits, why };
}

function choose(found, want, kind, minAlive = ALIVE) {
  const none = kind === 'pack' ? 'No complete season pack clearly matches.' : 'No release clearly matches this title.';
  const limited = limits(found, want, kind);
  let fits = limited.fits;
  if (want.quality && want.quality !== 'all') {
    const any = fits.length;
    fits = fits.filter((r) => r.quality === want.quality);
    if (!fits.length) return { pick: null, why: limited.why || (found.length || any ? `No matching ${qualityName(want.quality)} release has enough seeders.` : none) };
    const healthy = fits.filter((r) => r.seeders >= HEALTHY);
    const pool = healthy.length ? healthy : fits;
    return { pick: pool.sort((a, b) => score(b, want, kind) - score(a, want, kind))[0], why: null };
  }
  if (!fits.length) return { pick: null, why: limited.why || none };
  const profile = PROFILES.includes(want.profile) ? want.profile : 'balanced';
  const top = qualityOrder(want.prefer, profile);
  const target = SAVE_TARGET[kind === 'movie' ? 'movie' : 'episode'];
  const small = (r) => !r.size || perItemSize(r, want, kind) <= target;
  // Episodes: 4K comes after 720p in Balanced and Save Space (a 4K episode is rarely worth it).
  const lower = kind === 'movie' || profile === 'best' ? [] : ['2160p'];
  const high = top.filter((q) => !lower.includes(q));
  const steps = profile === 'save' ? [
    [['1080p', '720p'], HEALTHY, small], [['1080p', '720p', null], minAlive, small],
    [['720p'], HEALTHY], [['1080p'], HEALTHY], [[null], HEALTHY], [['SD'], HEALTHY],
    [['720p', '1080p', null, 'SD', '1440p', '2160p'], minAlive],
  ] : [
    ...high.map((q) => [[q], HEALTHY]), [high, minAlive],         // 1080p or better, however thin
    [['720p'], HEALTHY], ...lower.map((q) => [[q], HEALTHY]), [[null], HEALTHY], [['SD'], HEALTHY], // then lower
    [['720p', ...lower, null, 'SD'], minAlive],
  ];
  for (const [qualities, min, extra] of steps) {
    const pool = fits.filter((r) => qualities.includes(r.quality ?? null) && r.seeders >= min && (!extra || extra(r)));
    if (!pool.length) continue;
    // Within a mixed step, keep the preferred quality first; then the best score.
    pool.sort((a, b) => (qualities.indexOf(a.quality ?? null) - qualities.indexOf(b.quality ?? null))
      || score(b, want, kind) - score(a, want, kind));
    const pick = pool[0];
    const low = profile !== 'save' && !['1080p', '1440p', '2160p'].includes(pick.quality);
    return { pick, why: low ? 'Nothing in 1080p, 1440p or 4K is available, so this is the best there is.' : null };
  }
  return { pick: null, why: limited.why || none };
}
