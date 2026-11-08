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
// - Best Quality: the best picture available, whatever it costs in space. See "Picture quality" below.
// - Save Space: a compact 1080p or 720p under a size target; larger ones only if nothing fits.
// Torrents with 5+ seeders are tried before thin ones within each step, so a dead 1080p doesn't beat
// a lively one. Among those: more seeders, trusted uploaders, sane sizes; remuxes (huge), burned-in
// subtitles, Dolby Vision without an HDR10 fallback (odd colours on most screens) and dubbed-only
// releases in a language you didn't ask for count against.
// Picture quality (pictureScore): where the picture came from, then how much of it survived. An
// untouched remux leads, then disc encodes, web downloads and web re-encodes, each adjusted by its
// size per film or episode against what its resolution needs. A 0.3 GB "1080p" episode is 1080p in
// name only. Balanced avoids starved encodes. Best Quality ranks by this score alone: seeders only
// decide whether a release is usable and settle near-ties, and 4K, 1080p and 720p compete on picture.
// (House S06: a 8 GB per episode remux beats a popular 0.8 GB encode.)
// Never picked while anything else exists, in any profile: 3D, AI upscales and disc images.
// Hard limits, never relaxed: an exact resolution chosen in Advanced, the largest size per film or
// episode from Settings, and the free space on the media disk.
import { showKey } from './shows.js';
import { sameShow } from './season.js';
import { GOOD_GROUPS, animeGroup } from './anime.js';

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

// A dual-audio release of an anime: Japanese plus an English dub. Spelled "Dual Audio", "Dual-Audio",
// "DualAudio" or, in capitals only, "DUAL" ("Dual" alone may be part of a title). Dual audio with
// another language ("Dual Audio Hindi", a German dub) isn't the English dub someone asked for; those
// languages in a subtitle list ("Subs: German, French") don't count against it.
const DUB_ELSEWHERE = /\b(hindi|tamil|telugu|malayalam|kannada|bengali|urdu|latino|castellano|dublado|truefrench|vff|deutsch)\b/i;
const DUB_UNLESS_SUBS = /\b(german|french|spanish|italian|russian|portuguese|arabic)\b/i;
export function isDualAudio(name) {
  const n = String(name || '').replace(/[._/\\]+/g, ' ');
  if (!/\bdual[ -]?audio\b/i.test(n) && !/\bDUAL\b/.test(n)) return false;
  return !DUB_ELSEWHERE.test(n) && !(DUB_UNLESS_SUBS.test(n) && !/\bsubs?\b/i.test(n));
}

// What each resolution needs to look like itself, in GB per film / per episode (x264-equivalent).
const NEEDS = {
  movie: { '2160p': 20, '1440p': 10, '1080p': 8, '720p': 4, SD: 1.5 },
  episode: { '2160p': 4, '1440p': 2.5, '1080p': 2, '720p': 1, SD: 0.4 },
};
const EFFICIENT = /\b(x\.?265|h\.?265|hevc|av1)\b/i; // more picture per byte than x264
// The part of the name after the title: groups and tags, never words of the title ("Joy (2015)").
const tagsOf = (name) => String(name).replace(/[._]+/g, ' ').replace(/^.*?\b((?:19|20)\d{2}|S\d{1,2}|season\s?\d{1,2})\b/i, '');
// Groups whose releases are tiny re-encodes (fine on a phone, soft on a big screen).
const TINY_GROUPS = /\b(joy|yify|yts(?:\s?(?:mx|ag|lt))?|psa|megusta|pahe|shaanig|msd|rmteam|ganool|tgx ?x265)\b/i;

// log2 of size against need: 0 = what the resolution needs, -1 = half, +1 = twice. null = size unknown.
export function fidelity(r, want = {}, kind = 'movie') {
  const size = perItemSize(r, want, kind);
  if (!size) return null;
  const table = kind === 'movie' ? NEEDS.movie : NEEDS.episode;
  const need = table[r.quality] ?? table['720p'];
  return Math.log2(size * (EFFICIENT.test(r.name) ? 1.5 : 1) / (need * GB));
}
// Where the picture came from: a disc or a clean web download beats a TV capture or an upscale.
export function sourceOf(name) {
  const n = tagsOf(name);
  if (/\b(upscaled?|ai ?upscale|regrade)\b/i.test(n)) return 'upscale';
  if (/\b(?:bd ?|uhd ?|hd ?)?remux\b/i.test(n)) return 'remux';
  if (/\b(blu[ -]?ray|bdrip|brrip|bd|bd[ -]?rip|uhd[ -]?bd)\b/i.test(n)) return 'bluray';
  if (/\b(web|web[ -]?dl|amzn|nf|dsnp|hmax|atvp|max|pcok|hulu)\b/i.test(n) && !/\bweb[ -]?rip\b/i.test(n)) return 'web';
  if (/\bweb[ -]?rip\b/i.test(n)) return 'webrip';
  if (/\b(hdtv|pdtv|tvrip|hdtvrip|dsr)\b/i.test(n)) return 'tv';
  if (/\b(dvd[ -]?rip|dvd|xvid)\b/i.test(n)) return 'dvd';
  return null;
}
const SOURCE_BONUS = { remux: 0, bluray: 0.3, web: 0.2, webrip: 0, tv: -0.4, dvd: -0.4, upscale: -1 };
const RES_BONUS = { '2160p': 0.5, '1440p': 0.25, '1080p': 0, '720p': -1, SD: -2 };

// Best Quality's ladder: what each source starts from before its size is counted.
const SOURCE_RANK = { remux: 3, bluray: 1.5, web: 1.2, webrip: 1, tv: -0.4, dvd: -1, upscale: -2 };
const UNKNOWN_SOURCE = 1;
// VC-1 and MPEG-2 remuxes are as good on disc, but browsers need them re-encoded on the fly. A solid
// encode that plays directly ranks above them; anything starved still ranks below.
const OLD_CODEC_REMUX = 1.9;
const OLD_CODEC = /\b(vc ?-?1|mpeg ?-?2)\b/i;
const INTERPOLATED = /\b(50|60|120) ?fps\b|\binterpolated\b|\bsvp\b/i;
// "WEB-DL" on an x265 file means someone re-encoded the download.
const REENCODED = /\b(x\.?265|h\.?265|hevc|av1)\b/i;

// Picture only (no seeders): how good a release will look. Used to rank Best Quality and to decide
// whether a release is an upgrade over what's already here.
export function pictureScore(r, want = {}, kind = 'movie') {
  const f = fidelity(r, want, kind);
  const source = sourceOf(r.name);
  const tags = tagsOf(r.name);
  let s;
  if (source === 'remux' && (f == null || f >= 0)) {
    // Untouched: a bigger file isn't a better one, so size stops counting. (Too small to be real: below.)
    s = OLD_CODEC.test(tags) ? OLD_CODEC_REMUX : SOURCE_RANK.remux;
  } else {
    const start = source === 'remux' ? SOURCE_RANK.bluray
      : source === 'web' && REENCODED.test(tags) ? SOURCE_RANK.webrip
      : SOURCE_RANK[source] ?? UNKNOWN_SOURCE;
    s = start + (f == null ? 0 : Math.max(-3, Math.min(1, f)));
  }
  s += RES_BONUS[r.quality] ?? 0;
  if (TINY_GROUPS.test(tags)) s -= 1;
  if (INTERPOLATED.test(tags)) s -= 1;
  return s;
}

// Higher is better; only compares torrents of the same quality (Best Quality: of 1080p and up).
function score(r, want, kind) {
  const profile = want.profile;
  // Best Quality: seeders only settle near-ties (at most about 0.25 of a picture score).
  let s = profile === 'best' ? Math.log10(Math.min(r.seeders, 50) + 1) * 0.15 : Math.log10(r.seeders + 1);
  if (r.trusted) s += profile === 'best' ? 0.1 : 0.3;
  if (profile !== 'best' && r.tags?.includes('Remux')) s -= 2;
  if (/\b(hc|hardsub|korsub|hcsubs?)\b/i.test(r.name)) s -= 2;
  if (/\b(dv|dovi|dolby ?vision)\b/i.test(r.name) && !/\bhdr(10)?\b/i.test(r.name)) s -= 1;
  if (want.audioLang) {
    const fit = languageFit(r.name, want.audioLang) - 1;
    // Best Quality, English wanted: most English originals aren't labelled at all, so "ENG" in a name
    // says nothing about the picture. A dub in another language still counts against.
    if (!(profile === 'best' && want.audioLang === 'en' && fit > 0)) s += fit * 0.8;
  }
  if (r.remake) s -= 0.5;                                     // Nyaa: a re-upload of someone else's release
  // 10-bit H.264 ("Hi10P", common in older anime) plays on almost no TV or phone without re-encoding.
  if (/\b(hi10p?|10.?bits?)\b/i.test(r.name) && /\b(x264|h\.?264|avc)\b/i.test(r.name) && !/\b(x265|hevc|av1)\b/i.test(r.name)) s -= 0.7;
  if (want.anime && GOOD_GROUPS.has(animeGroup(r.name))) s += 0.3;
  const size = perItemSize(r, want, kind);
  if (size && profile !== 'best') {
    const unit = kind === 'movie' ? 1 : 0.15; // an episode is roughly a seventh of a film
    const cap = (r.quality === '2160p' ? 30 : 16) * GB * unit;
    if (size > cap) s -= 1;
    if (size < 0.5 * GB * unit && ['1080p', '1440p', '2160p'].includes(r.quality)) s -= 1.5; // too small to be real
    if (profile === 'save') s -= size / (SAVE_TARGET[kind === 'movie' ? 'movie' : 'episode']) * 0.5;
  }
  if (profile === 'best') {
    s += pictureScore(r, want, kind) + (want.prefer && r.quality === want.prefer ? 1 : 0);
  } else if (profile !== 'save') {
    // Balanced: no reward for size, but a starved encode (under half of what it needs) counts against.
    const f = fidelity(r, want, kind);
    if (f != null && f < -1) s += Math.max(-2, f + 1);
    if (TINY_GROUPS.test(tagsOf(r.name))) s -= 0.5;
    s += (SOURCE_BONUS[sourceOf(r.name)] ?? 0) * 0.5;
  }
  return s;
}

// The size that counts against limits: a film's whole size, a pack's size per episode.
// Anime packs say how many episodes they hold (packEpisodes, anime.js): "(01-170)" is 170 of them.
export const perItemSize = (r, want, kind) => (kind === 'pack' && r.packEpisodes > 0 && r.size ? r.size / r.packEpisodes
  : kind === 'pack' && want.episodes > 0 && r.size ? r.size / want.episodes : r.size || 0);
// The space a download really takes: a pack with owned episodes deselected only downloads the rest.
// Anime packs: only the episodes of this season it covers (the rest are switched off too).
const diskSize = (r, want) => (r.packEpisodes > 0 && r.size ? r.size / r.packEpisodes * Math.min(r.covers || r.packEpisodes, want.missing || r.covers || r.packEpisodes)
  : want.type === 'tv' && want.episodes > 0 && want.missing > 0 && r.size
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
  // Other names of the film (anime: the romanised title, "Kimi no Na wa." for "Your Name.").
  const keys = new Set([key, ...(want.aliases || [])]);
  return choose(live.filter((r) => {
    const p = parseName(r.name, { file: false });
    return p.season == null && keys.has(showKey(p.title)) && (!want.year || !p.year || Math.abs(p.year - want.year) <= 1);
  }), want, 'movie');
}

// Releases already filtered to the right show, season and episode (season.js): the best one, by the
// same profile, limits and language rules as films and packs. One seeder is enough for an episode.
export function pickEpisode(fits, want) {
  return choose(fits.filter((r) => !r.cam && r.seeders > 0), { ...want, type: 'episode' }, 'episode', 1);
}

const COUNTRIES = new Set(['us', 'uk', 'au', 'nz', 'ca']);
const qualityName = (q) => (q === '2160p' ? '4K' : q);
// 3D (side by side or over/under), AI upscales, and disc images (qBittorrent is told to skip .iso files).
const NOT_A_NORMAL_COPY = /\b(3d|sbs|hsbs|fsbs|h-?ou|half-?ou|anaglyph|upscaled?|ai ?upscale|bdmv|bd-?(?:25|50|66|100)|dvd[59]|dvdr|iso|complete[ -](?:uhd[ -])?blu-?ray)\b/i;
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
  // Not a normal copy of the film or show: only when nothing else exists.
  const normal = fits.filter((r) => !NOT_A_NORMAL_COPY.test(tagsOf(r.name)));
  if (normal.length) fits = normal;
  // A dubbed-only release in another language only when nothing else exists.
  const spoken = fits.filter((r) => languageFit(r.name, want.audioLang) > 0);
  if (spoken.length) fits = spoken;
  return { fits, why };
}

export function choose(found, want, kind, minAlive = ALIVE) {
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
  ] : profile === 'best' ? [
    // 4K down to 720p side by side: the picture score decides, not the label alone.
    [[...high, '720p'], HEALTHY, null, true], [[...high, '720p'], minAlive, null, true],
    [[null], HEALTHY], [['SD'], HEALTHY], [[null, 'SD'], minAlive],
  ] : [
    ...high.map((q) => [[q], HEALTHY]), [high, minAlive],         // 1080p or better, however thin
    [['720p'], HEALTHY], ...lower.map((q) => [[q], HEALTHY]), [[null], HEALTHY], [['SD'], HEALTHY], // then lower
    [['720p', ...lower, null, 'SD'], minAlive],
  ];
  for (const [qualities, min, extra, byScore] of steps) {
    const pool = fits.filter((r) => qualities.includes(r.quality ?? null) && r.seeders >= min && (!extra || extra(r)));
    if (!pool.length) continue;
    // Within a mixed step, keep the preferred quality first; then the best score (Best Quality: score only).
    pool.sort((a, b) => (byScore ? 0 : qualities.indexOf(a.quality ?? null) - qualities.indexOf(b.quality ?? null))
      || score(b, want, kind) - score(a, want, kind));
    const pick = pool[0];
    const isHigh = (q) => ['1080p', '1440p', '2160p'].includes(q);
    // (Best Quality may prefer a solid 720p to a starved 1080p: that isn't "nothing better exists".)
    const low = profile !== 'save' && !isHigh(pick.quality) && !fits.some((r) => isHigh(r.quality) && r.seeders >= minAlive);
    return { pick, why: low ? 'Nothing in 1080p, 1440p or 4K is available, so this is the best there is.' : null };
  }
  return { pick: null, why: limited.why || none };
}
