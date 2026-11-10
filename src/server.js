// Marquee: self-hosted media server for phones, browsers and TVs.
// No dependencies. Requires Node.js 22.13+ (node:sqlite without a flag).
import './env.js'; // must be the first import so .env is loaded before other modules read it
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';
import * as cast from './cast.js';
import * as converter from './convert.js';
import * as torrents from './torrents.js';
import * as subtitles from './subtitles.js';
import { initSubfix } from './subfix.js';
import * as subsync from './subsync.js';
import * as activity from './activity.js';
import * as house from './house.js';
import { createTvPairing } from './tv.js';
import { createJellyfin } from './jellyfin.js';
import * as load from './load.js';
import * as screenTime from './screentime.js';
import * as clips from './clips.js';
import * as invites from './invites.js';
import * as shows from './shows.js';
import * as season from './season.js';
import { matchesRelease, exactFirst } from './release-match.js';
import { parseCatalogueSearch, needsExactCatalogueFallback, mergeCatalogueResults } from './title-search.js';
import { parseName } from './release-name.js';
import * as anime from './anime.js';
import { downloadDestination, downloadFilePath } from './download-paths.js';
import { fetchTorrentFile, TorrentFetchError } from './torrent-fetch.js';
import { filterMode, filterApplies, firstAdult, torrentFileNames, BLOCKED_MESSAGE } from './content-filter.js';
import * as smart from './smart-download.js';
import * as svt from './svtplay.js';
import { createSvtQueue, expectedSize } from './svt-queue.js';
import { createDocumentaries } from './documentaries.js';
import * as versions from './versions.js';
import { planEpisodeOrder } from './episode-order.js';
import { PROFILES, isDualAudio } from './recommend.js';
import * as accounts from './accounts.js';
import * as live from './live.js';
import { NotesStore } from './notes.js';
import { NotesUploads, mediaType } from './notes-media.js';
import { NotesOcr } from './notes-ocr.js';
import * as noteShare from './note-share.js';
import { WatchRooms } from './watch.js';
import * as social from './social.js';
import { handleWatchPage } from './watch-page.js';
import { creditsFor, introFor, initCredits } from './credits.js';
import * as whatsNew from './whats-new.js';
import { languageOf, inLanguage, currentLanguage, translate } from './i18n.js';
import { WatchlistStore, runRound as watchlistRound, baselineFrom } from './watchlist.js';
import { PushStore, KINDS as PUSH_KINDS } from './push.js';
import { Previews } from './previews.js';
import { TravelStore, QUALITIES as TRAVEL_QUALITIES, travelName, estimateBytes, validQuality } from './travel.js';
import { isHomeRequest, describeRequest } from './network.js';
import { createTrust } from './trust.js';
import { createAuth, signInPage, safeNext, clientAddress } from './auth.js';
import { checkConfig } from './config-check.js';
import { raiseServer } from './priority.js';
import { startPlaybackGuard } from './playback-guard.js';
import { PhoneStreams, segmentIndex, isHeavy, probe as probePhone } from './phone-stream.js';
import { PartialStreams, parsePartialId } from './partial-stream.js';

import { APP_DIR, DATA_DIR, CACHE_DIR, PUBLIC_DIR, dataDirProblem, ensureDataDir } from './paths.js';
import * as preview from './preview.js';

{
  const problem = dataDirProblem();
  if (problem) { console.error(problem); process.exit(1); }
  ensureDataDir();
}

// PORT=0 asks the system for any free port (the tests use it); PORT is the real one once listening.
let PORT = process.env.PORT?.trim() === '0' ? 0 : Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const trust = createTrust();
const MEDIA_DIR = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : null;
const TMDB_TOKEN = process.env.TMDB_TOKEN || '';
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const TMDB_LANG = process.env.TMDB_LANG || 'en-US';
const QBIT_URL = (process.env.QBIT_URL || '').replace(/\/+$/, '');
// TVs live on the home network, so they're only offered to visitors who are at home.
const CAST_WHEN_AWAY = (process.env.CAST_WHEN_AWAY || 'off').toLowerCase() === 'on';
const castAllowed = async (req) => CAST_WHEN_AWAY || (await isHomeRequest(req)) !== false;

// LAN address TVs use to reach this server. Override with SERVER_IP.
function lanAddress() {
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|Tailscale|ZeroTier|Loopback/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // VPN tunnels (WireGuard, TUN adapters) have no hardware address and a /32: TVs can't reach those.
      if (a.mac === '00:00:00:00:00:00' || a.netmask === '255.255.255.255') continue;
      if (/^169\.254\./.test(a.address) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue;
      return a.address;
    }
  }
  return '127.0.0.1';
}
const LAN_IP = lanAddress();
const watchRooms = new WatchRooms({ avatarOf: (id) => accounts.userById(id)?.avatar || null });
// Artwork for a room's link preview, from the TMDB cache only (Discord's crawler doesn't wait long).
function watchArtwork(media) {
  const art = media.season == null ? shows.knownFilm(media.mediaKey, media.title, media.year) : shows.knownShow(media.title, media.year);
  // An episode shows its own still (full size: link previews are large), then the show's backdrop.
  // (A film has no still: `false?.replace` would throw, so films check the type first.)
  const still = media.season != null ? shows.knownEpisode(media.title, media.year, media.season, media.episode)?.still : null;
  const image = (typeof still === 'string' ? still.replace('/t/p/w300/', '/t/p/original/') : null) || art?.backdrop || art?.poster;
  return image ? { image } : null;
}
setInterval(() => watchRooms.cleanup(), 3000).unref();
activity.initActivity({ dataDir: DATA_DIR, nameForUser: accounts.displayNameFor, avatarForUser: accounts.avatarForEmail });
accounts.initAccounts({ dataDir: DATA_DIR, adminEmails: activity.adminEmails(), mediaDir: MEDIA_DIR });
// Notifications (push.js): a download is ready, a new episode arrived, a Watch Together invite.
const push = new PushStore(DATA_DIR);
// Sends `kind` to each person who has it switched on, in the background.
function notify(userIds, kind, message) {
  const ids = [...new Set(userIds)].filter((id) => id != null && push.hasDevice(id)
    && (kind === 'test' || accounts.userById(id)?.settings?.[PUSH_KINDS[kind]] !== false));
  if (!ids.length) return Promise.resolve(0);
  // Each person gets it in their own language (Settings → Language).
  const byLanguage = new Map();
  for (const id of ids) {
    const lang = accounts.userById(id)?.settings?.language || 'en';
    byLanguage.set(lang, [...(byLanguage.get(lang) || []), id]);
  }
  return Promise.all([...byLanguage].map(([lang, people]) => push.send(people, kind,
    { ...message, title: translate(message.title, lang), body: translate(message.body, lang) })
    .catch((err) => { console.warn(`[push] ${err.message}`); return 0; })))
    .then((sent) => sent.reduce((total, n) => total + (Number(n) || 0), 0));
}
const auth = createAuth({ dataDir: DATA_DIR });
const tvPairing = createTvPairing();
// The Jellyfin plugin (jellyfin.js, jellyfin/): someone's own Jellyfin server showing their Marquee library.
const jellyfin = createJellyfin({
  dataDir: DATA_DIR,
  version: VERSION,
  libraryFor: jellyfinLibrary,
  resolveItem: jellyfinItem,
  sendVideo, sendJson, readJson, clientAddress,
  userById: accounts.userById,
  saveProgress: (...args) => saveProgressAllVersions(...args),
  progressOf: accounts.progressOf,
  readSubtitle: subtitles.readSubtitle,
  displayName: (user) => user.name || accounts.displayNameFor(user.email) || 'Home network',
});
watchRooms.attachStore(social.partyStore); // planned watch parties survive restarts
const personName = (id) => accounts.userById(id)?.name || 'Someone';
const avatarOf = (id) => accounts.userById(id)?.avatar || null;
const notes = new NotesStore(DATA_DIR, { fileDir: process.env.NOTES_FILES_DIR });
const watchlist = new WatchlistStore(DATA_DIR);
// Text in Notes images becomes search keywords. Uploads are read right away; older images catch up after startup.
const notesOcr = new NotesOcr(notes);
// Previews of shared notes: video/image copies Discord can show. Shared notes get theirs at startup too.
const sharedMedia = new noteShare.SharedMedia(notes, { cacheDir: path.join(CACHE_DIR, 'notes-share') });
setTimeout(() => { for (const note of notes.sharedNotes()) sharedMedia.prepare(note); }, 5000).unref();
// Timeline previews: keyframe storyboards the player shows while you hover the seek bar.
const previews = new Previews(path.join(CACHE_DIR, 'previews'));
// Download to phone: small copies to take along (travel.js). The person who asked hears when one is ready.
const travel = new TravelStore({
  dataDir: DATA_DIR,
  dir: process.env.TRAVEL_DIR ? path.resolve(process.env.TRAVEL_DIR) : path.join(CACHE_DIR, 'travel'),
  keepDays: Math.max(1, Number(process.env.TRAVEL_KEEP_DAYS) || 7),
  maxBytes: Math.max(1, Number(process.env.TRAVEL_MAX_GB) || 50) * 1024 ** 3,
  resolve: travelSource,
  onChange: (userIds) => { for (const userId of userIds) live.publish('travel', { audience: 'user', userId }); },
  onReady: (userIds, row) => notify(userIds, 'download', { title: 'Ready for your phone',
    body: `${row.title} (${TRAVEL_QUALITIES[row.quality]?.label || row.quality}) can be downloaded now.`, url: '/?travel=1#library', tag: `travel-${row.copy_key}` }),
});
setTimeout(() => travel.resume(), 20_000).unref();
setInterval(() => travel.sweep(), 6 * 3600 * 1000).unref();
const notesUploads = new NotesUploads(notes, { onFile: () => notesOcr.kick() });
setTimeout(() => notesOcr.kick(), 30000).unref();
setInterval(() => { try { notesUploads.prune(); } catch { /* retried on the next upload */ } }, 3600000).unref();
house.initHouse({
  dataDir: DATA_DIR,
  mediaDir: MEDIA_DIR,
  clipsDir: process.env.CLIPS_DIR ? path.resolve(process.env.CLIPS_DIR) : null,
  qbitCheck: QBIT_URL ? async () => (await qbitRequest('/api/v2/app/version')).ok : null,
});
load.initLoad({
  dataDir: DATA_DIR,
  mediaDir: MEDIA_DIR,
  clipsDir: process.env.CLIPS_DIR,
  ipName: house.hostForIp,
  conversionStatus: () => converter.converterStatus().current,
  torrentsUp: QBIT_URL ? async () => {
    const r = await qbitRequest('/api/v2/transfer/info');
    const t = await r.json();
    return { up: t.up_info_speed || 0, down: t.dl_info_speed || 0, upLimit: t.up_rate_limit || null };
  } : null,
});
// Playback first: this process a step above normal, background jobs below it (priority.js), and
// downloads on qBittorrent's alternative speed limits while anyone is watching (playback-guard.js).
raiseServer();
startPlaybackGuard({
  watching: load.watching,
  qbit: QBIT_URL ? (endpoint, init) => qbitRequest(endpoint, init) : null,
  stateFile: path.join(DATA_DIR, '.marquee-playback.json'),
});
shows.initShows({ dataDir: DATA_DIR });
anime.initAnime({ dataDir: DATA_DIR });
initCredits({ dataDir: DATA_DIR });
// What's new (whats-new.js): update notes everyone sees once, and an id for the web app being served.
whatsNew.initWhatsNew(path.join(APP_DIR, 'whats-new.json'));
const WEB_BUILD = whatsNew.buildId(['index.html', 'app.js', 'style.css'].map((f) => path.join(PUBLIC_DIR, f)));
// The preview switch (preview.js): a second web app this browser can opt into at /preview.
const PREVIEW_DIR = preview.previewDir();
const webBuildFor = (req) => (preview.inPreview(req, PREVIEW_DIR) ? preview.previewBuild(PREVIEW_DIR) : WEB_BUILD);
screenTime.initScreenTime({ dataDir: DATA_DIR });
clips.initClips({ dataDir: DATA_DIR, cacheDir: CACHE_DIR, getEncoder: () => converter.converterStatus().encoder });
invites.initInvites({ dataDir: DATA_DIR, onEvent: activity.record });
cast.initCasting({ lanIp: LAN_IP });
subsync.initSubsync({ dataDir: DATA_DIR, cacheDir: CACHE_DIR, audioShift: (video) => converter.syncState(video).shift });
// English subtitles get OCR mistakes fixed as they're served, using words learned from the library.
initSubfix({ roots: [MEDIA_DIR], cacheFile: path.join(CACHE_DIR, 'subtitle-words.json') });
subtitles.initSubtitles({
  dataDir: DATA_DIR,
  // Downloaded subtitles get their timing checked in the background. Even a file-hash match is checked:
  // uploads are often tagged with the wrong release, and an in-sync file costs only a quick check.
  onDownload: (video, srt) => {
    if (subsync.autoSyncEnabled()) subsync.queueSync(srt, video);
  },
});

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}


// Manual release search for an anime title (?tv= / ?movie= TMDB id): its context, or null.
async function animeContextForSearch(params) {
  const type = params.get('tv') ? 'tv' : params.get('movie') ? 'movie' : null;
  const id = Number(params.get(type || ''));
  if (!type || !Number.isSafeInteger(id) || id <= 0 || !(TMDB_TOKEN || TMDB_KEY)) return null;
  const have = anime.contextFor(type, id);
  if (have) return have;
  try {
    const details = await tmdb(`/${type}/${id}`);
    if (!anime.isAnimeDetails(details)) return null;
    // At most a few seconds: the context keeps building for the next search.
    const built = anime.buildContext(type, id, tmdb, { details });
    built.catch(() => {});
    return await Promise.race([built, new Promise((ok) => setTimeout(() => ok(null), 4000))]);
  } catch { return null; }
}
// "Frieren: Beyond Journey's End S01E31" -> "Sousou no Frieren 31"; a season or title search -> the name.
function animeQuery(query, ctx) {
  const main = ctx.queryTitles[0];
  if (!main || shows.showKey(main) === shows.showKey(query)) return null;
  const ep = /\bS(\d{1,2})\s?E(\d{1,4})\b/i.exec(query);
  const s = ep && ctx.seasons.find((x) => x.n === Number(ep[1]));
  return ep ? `${main} ${String(s ? s.start + Number(ep[2]) - 1 : Number(ep[2])).padStart(2, '0')}` : main;
}
// A release of this anime (any of its names), and of the season/episode the query names.
function animeMatches(query, name, ctx) {
  const list = anime.resolve(anime.parseAnimeName(name), ctx);
  const parsed = anime.parseAnimeName(name);
  const ours = list || (parsed && ctx.keys.includes(shows.showKey(parsed.title))) || ctx.keys.includes(shows.showKey(parseName(name, { file: false }).title));
  if (!ours) return false;
  const ep = /\bS(\d{1,2})\s?E(\d{1,4})\b/i.exec(query);
  const sn = !ep && /\b(?:S|season\s*)(\d{1,2})\s*$/i.exec(query);
  if (ep) return Boolean(list?.some((x) => x.season === Number(ep[1]) && x.episode === Number(ep[2])));
  if (sn) return Boolean(list?.some((x) => x.season === Number(sn[1])));
  return true;
}

// ---------- file-name parsing (release-name.js) ----------
// Anime shows in the library get an anime context (anime.js) in the background, once; the next scan
// then places their files on TMDB's seasons ("Black Clover - 176" -> S02E06) under TMDB's name.
const animeLearning = new Set();
function learnAnime(showList) {
  for (const sh of showList) {
    if (!sh.anime || !sh.tmdbId || anime.contextFor('tv', sh.tmdbId) || animeLearning.has(sh.tmdbId)) continue;
    animeLearning.add(sh.tmdbId);
    anime.buildContext('tv', sh.tmdbId, tmdb)
      .then(() => invalidateLibrary())
      .catch((e) => console.warn(`[anime] ${sh.title}: ${e.message}`))
      .finally(() => setTimeout(() => animeLearning.delete(sh.tmdbId), 60 * 60 * 1000));
  }
}
// A file's name info; "The Bear/Season 2/S02E05.mkv" takes the show's name from the nearest folder
// that has one (inside MEDIA_DIR or a download folder: never higher than three levels up).
function parseFile(full) {
  const parsed = parseName(path.basename(full), { allowEmpty: true });
  if (!parsed.title && parsed.season != null) {
    let d = path.dirname(full);
    for (let i = 0; i < 3 && (!MEDIA_DIR || d.length > MEDIA_DIR.length); i++, d = path.dirname(d)) {
      const t = parseName(path.basename(d), { file: false });
      if (t.title && !/^(season|series|s)\s*\d+$/i.test(t.title)) { parsed.title = t.title; parsed.year ??= t.year; break; }
    }
  }
  if (!parsed.title) parsed.title = path.basename(full).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').trim();
  // Anime: "Black Clover - 176" / "Sousou no Frieren S2 - 03" on TMDB's seasons (Black Clover S02E06,
  // Frieren S01E31), under TMDB's name, once the show's anime context is cached (anime.js).
  if (parsed.anime || (parsed.season != null && parsed.episode != null)) {
    const placed = anime.placeFile(parsed, path.basename(full));
    if (placed) Object.assign(parsed, placed);
  }
  return parsed;
}

// ---------- TMDB ----------
async function tmdb(endpoint, params = {}, language = TMDB_LANG) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('language', language);
  const headers = { accept: 'application/json' };
  if (TMDB_TOKEN) headers.authorization = `Bearer ${TMDB_TOKEN}`;
  else if (TMDB_KEY) url.searchParams.set('api_key', TMDB_KEY);
  else throw new HttpError(503, 'Search needs a TMDB key. Add TMDB_TOKEN to .env and restart the server.');

  let r;
  try {
    r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new HttpError(504, 'Could not reach TMDB. Check the server’s internet connection.');
  }
  if (r.status === 401) throw new HttpError(502, 'TMDB rejected the key. Check TMDB_TOKEN in .env.');
  if (!r.ok) throw new HttpError(502, `TMDB responded with ${r.status}.`);
  return r.json();
}

function mapTitle(x, knownType) {
  const type = knownType || x.media_type || (x.first_air_date !== undefined ? 'tv' : 'movie');
  const date = x.release_date || x.first_air_date || '';
  return {
    id: x.id,
    type,
    title: x.title || x.name,
    year: date ? Number(date.slice(0, 4)) : null,
    overview: x.overview || '',
    rating: x.vote_average ? Math.round(x.vote_average * 10) / 10 : null,
    poster: x.poster_path ? `https://image.tmdb.org/t/p/w342${x.poster_path}` : null,
    backdrop: x.backdrop_path ? `https://image.tmdb.org/t/p/w780${x.backdrop_path}` : null,
    genres: x.genre_ids || [],
    popularity: x.popularity || 0,
    votes: x.vote_count || 0,
    date,
  };
}

const onlyScreen = (x) => x.media_type === 'movie' || x.media_type === 'tv';

function exactCatalogueHit(search, item) {
  const expected = shows.showKey(search.title);
  const names = [item.title, item.original_title, item.name, item.original_name].filter(Boolean);
  const date = item.release_date || item.first_air_date || '';
  return names.some((name) => shows.showKey(name) === expected)
    && (!search.year || date.startsWith(String(search.year)));
}

function catalogueParams(search, type, page = 1) {
  return {
    query: search.title,
    include_adult: 'false',
    page: String(page),
    ...(search.year && type === 'movie' ? { primary_release_year: String(search.year) } : {}),
    ...(search.year && type === 'tv' ? { first_air_date_year: String(search.year) } : {}),
  };
}

// TMDB text search is relevance-ranked, so a one-character exact title can be several pages deep.
// Search a few pages in small parallel batches, but only for short/year-qualified queries.
async function exactCataloguePages(search, type, first) {
  const pages = [first];
  if ((first.results || []).some((item) => exactCatalogueHit(search, item))) return pages;
  const lastPage = Math.min(Math.max(1, Number(first.total_pages) || 1), 8);
  for (let start = 2; start <= lastPage; start += 3) {
    const numbers = Array.from({ length: Math.min(3, lastPage - start + 1) }, (_, i) => start + i);
    const batch = await Promise.all(numbers.map((page) => tmdbForViewer(`/search/${type}`, catalogueParams(search, type, page))));
    pages.push(...batch);
    if (batch.some((data) => (data.results || []).some((item) => exactCatalogueHit(search, item)))) break;
  }
  return pages;
}

// ---------- discover ----------
const tmdbCache = new Map(); // key -> { at, promise }
// The same TMDB answer with descriptions and genre names in the viewer's language. Titles stay as they are:
// the library, Search and finding a release all go by them. What TMDB hasn't translated stays in TMDB_LANG.
const TMDB_LANGUAGES = { sv: 'sv-SE' };
const placeholderEpisode = /^(avsnitt|episode) \d+$/i;
function overlayTmdb(base, local) {
  if (!base || !local) return base;
  const out = { ...base };
  for (const field of ['overview', 'tagline']) if (local[field]) out[field] = local[field];
  if (base.episode_number != null && local.name && !placeholderEpisode.test(local.name)) out.name = local.name;
  if (base.season_number != null && base.episode_number == null && local.name) out.name = local.name;
  if (base.id != null && base.name != null && base.title == null && base.first_air_date == null && base.season_number == null && local.name) out.name = local.name; // genres
  for (const list of ['results', 'episodes', 'seasons', 'genres']) {
    if (!Array.isArray(base[list]) || !Array.isArray(local[list])) continue;
    const byId = new Map(local[list].map((x) => [x.id, x]));
    out[list] = base[list].map((x) => overlayTmdb(x, byId.get(x.id)));
  }
  return out;
}
async function tmdbForViewer(endpoint, params = {}) {
  const language = TMDB_LANGUAGES[currentLanguage()];
  if (!language || language === TMDB_LANG) return tmdb(endpoint, params);
  const [base, local] = await Promise.all([tmdb(endpoint, params), tmdb(endpoint, params, language).catch(() => null)]);
  return overlayTmdb(base, local);
}

function cachedTmdb(endpoint, params = {}, ttl = 30 * 60 * 1000) {
  const key = currentLanguage() + endpoint + JSON.stringify(params);
  const hit = tmdbCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = tmdbForViewer(endpoint, params);
  tmdbCache.set(key, { at: Date.now(), promise });
  promise.catch(() => tmdbCache.delete(key));
  if (tmdbCache.size > 300) tmdbCache.delete(tmdbCache.keys().next().value);
  return promise;
}

// Curated lists: [TMDB endpoint, media type]. Also the whitelist for "See all".
const LISTS = {
  'trending-all': ['/trending/all/week', null],
  'trending-movie': ['/trending/movie/week', 'movie'],
  'trending-tv': ['/trending/tv/week', 'tv'],
  'popular-movie': ['/movie/popular', 'movie'],
  'popular-tv': ['/tv/popular', 'tv'],
  'top-movie': ['/movie/top_rated', 'movie'],
  'top-tv': ['/tv/top_rated', 'tv'],
  'cinemas': ['/movie/now_playing', 'movie'],
  'upcoming': ['/movie/upcoming', 'movie'],
  'on-air': ['/tv/on_the_air', 'tv'],
  'airing-today': ['/tv/airing_today', 'tv'],
};
const HOME_ROWS = {
  all: [['trending-all', 'Trending this week'], ['popular-movie', 'Popular films'], ['popular-tv', 'Popular shows'],
    ['cinemas', 'In cinemas now'], ['on-air', 'New episodes this week'], ['top-movie', 'Top rated films'], ['top-tv', 'Top rated shows']],
  movie: [['trending-movie', 'Trending films'], ['popular-movie', 'Popular'], ['cinemas', 'In cinemas now'],
    ['upcoming', 'Coming soon'], ['top-movie', 'Top rated']],
  tv: [['trending-tv', 'Trending shows'], ['popular-tv', 'Popular'], ['airing-today', 'Airing today'],
    ['on-air', 'New episodes this week'], ['top-tv', 'Top rated']],
};

// Trailers first, then teasers; official ones in your language, then English; the biggest and newest wins.
function pickTrailer(videos, lang) {
  const kinds = ['Trailer', 'Teaser'];
  const score = (v) => (kinds.length - kinds.indexOf(v.type)) * 1000
    + (v.official ? 200 : 0)
    + (v.iso_639_1 === lang ? 100 : v.iso_639_1 === 'en' ? 50 : 0)
    + Math.min(Number(v.size) || 0, 2160) / 100;
  const best = videos
    .filter((v) => v.site === 'YouTube' && kinds.includes(v.type) && /^[\w-]{6,20}$/.test(v.key || ''))
    .sort((a, b) => score(b) - score(a) || String(b.published_at || '').localeCompare(String(a.published_at || '')))[0];
  return best ? { key: best.key, name: best.name || best.type, type: best.type } : null;
}

// What /api/title/:type/:id/page sends: the parts of a TMDB details answer the title page uses.
const TMDB_IMG = 'https://image.tmdb.org/t/p/';
function pickLogo(logos, original) {
  const score = (l) => (l.iso_639_1 === 'en' ? 300 : l.iso_639_1 === original ? 200 : l.iso_639_1 == null ? 100 : 0)
    + (/\.png$/i.test(l.file_path) ? 20 : 0) + (Number(l.vote_average) || 0) * 2 + Math.min(Number(l.width) || 0, 2000) / 1000;
  const best = (logos || []).filter((l) => l?.file_path && /\.(png|svg)$/i.test(l.file_path)).sort((a, b) => score(b) - score(a))[0];
  if (!best) return null;
  return { url: `${TMDB_IMG}${/\.svg$/i.test(best.file_path) ? 'original' : 'w500'}${best.file_path}`, aspect: Number(best.aspect_ratio) || null };
}
function certification(type, d) {
  const order = ['SE', 'US', 'GB'];
  if (type === 'tv') {
    const list = d.content_ratings?.results || [];
    for (const c of order) { const r = list.find((x) => x.iso_3166_1 === c && x.rating); if (r) return r.rating; }
    return null;
  }
  const list = d.release_dates?.results || [];
  for (const c of order) {
    const r = list.find((x) => x.iso_3166_1 === c)?.release_dates?.find((x) => x.certification);
    if (r) return r.certification;
  }
  return null;
}
export function titlePage(type, d) {
  const credits = type === 'tv' ? d.aggregate_credits : d.credits;
  return {
    logo: pickLogo(d.images?.logos, d.original_language),
    tagline: d.tagline || '',
    runtime: type === 'tv' ? (d.episode_run_time?.[0] || d.last_episode_to_air?.runtime || null) : (d.runtime || null),
    genres: (d.genres || []).map((g) => g.name).filter(Boolean),
    certification: certification(type, d),
    seasons: type === 'tv' ? d.number_of_seasons || null : null,
    episodes: type === 'tv' ? d.number_of_episodes || null : null,
    status: d.status || null,
    cast: (credits?.cast || []).filter((c) => c.name && c.id).slice(0, 16).map((c) => ({
      id: c.id, name: c.name,
      character: c.character || c.roles?.[0]?.character || '',
      photo: c.profile_path ? `${TMDB_IMG}w185${c.profile_path}` : null,
    })),
    similar: (d.recommendations?.results || []).filter((x) => x.poster_path && (x.media_type ? ['movie', 'tv'].includes(x.media_type) : true))
      .slice(0, 20).map((x) => mapTitle(x, x.media_type || type)),
  };
}
export const seasonEpisodes = (d) => (d.episodes || []).map((e) => ({
  number: e.episode_number, name: e.name || null, overview: e.overview || '', runtime: e.runtime || null,
  airDate: e.air_date || null, still: e.still_path ? `${TMDB_IMG}w300${e.still_path}` : null,
}));

async function discoverList(key, page = 1) {
  const [endpoint, type] = LISTS[key] || [];
  if (!endpoint) throw new HttpError(400, 'Unknown list.');
  const data = await cachedTmdb(endpoint, { page: String(page) });
  const results = (data.results || []).filter((x) => type || onlyScreen(x)).map((x) => mapTitle(x, type));
  return { results, page: data.page || page, totalPages: Math.min(data.total_pages || 1, 500) };
}

async function discoverHome(type) {
  const rows = HOME_ROWS[type] || HOME_ROWS.all;
  const lists = await Promise.all(rows.map(([key]) => discoverList(key).catch(() => null)));
  const featured = (lists[0]?.results || []).filter((t) => t.backdrop && t.overview).slice(0, 6);
  return {
    featured,
    rows: rows.map(([key, title], i) => ({ key, title: translate(title), items: lists[i]?.results || [] })).filter((r) => r.items.length),
  };
}

// TMDB splits genres by media type and TV merges some ("Action & Adventure"). One list, matched by ID.
const TV_EQUIVALENT = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
const SKIP_GENRES = new Set([10770, 10763, 10766, 10767]); // TV Movie, News, Soap, Talk
async function genres() {
  const [movie, tv] = await Promise.all([
    cachedTmdb('/genre/movie/list', {}, 24 * 3600 * 1000),
    cachedTmdb('/genre/tv/list', {}, 24 * 3600 * 1000),
  ]);
  const tvIds = new Set((tv.genres || []).map((g) => g.id));
  const merged = (movie.genres || []).filter((g) => !SKIP_GENRES.has(g.id)).map((g) => ({
    name: g.name,
    movie: g.id,
    tv: TV_EQUIVALENT[g.id] || (tvIds.has(g.id) ? g.id : null),
  }));
  const covered = new Set(merged.map((g) => g.tv));
  for (const g of tv.genres || []) {
    if (!covered.has(g.id) && !SKIP_GENRES.has(g.id) && !Object.values(TV_EQUIVALENT).includes(g.id)) {
      merged.push({ name: g.name, movie: null, tv: g.id });
    }
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

const SORTS = {
  popular: { movie: { sort_by: 'popularity.desc' }, tv: { sort_by: 'popularity.desc' }, by: (t) => t.popularity },
  rating: {
    movie: { sort_by: 'vote_average.desc', 'vote_count.gte': '500' },
    tv: { sort_by: 'vote_average.desc', 'vote_count.gte': '200' },
    by: (t) => t.rating || 0,
  },
  newest: {
    movie: { sort_by: 'primary_release_date.desc', 'vote_count.gte': '20' },
    tv: { sort_by: 'first_air_date.desc', 'vote_count.gte': '20' },
    by: (t) => t.date,
  },
};

// Genre browsing. With type 'all', films and shows are fetched side by side and merged.
async function discoverGenre({ type, movieGenre, tvGenre, sort, page }) {
  const order = SORTS[sort] || SORTS.popular;
  const today = new Date().toISOString().slice(0, 10);
  const fetchType = async (t, genre) => {
    if (!genre) return { results: [], totalPages: 0 };
    const params = { ...order[t], with_genres: String(genre), page: String(page), include_adult: 'false' };
    if (t === 'movie') params['primary_release_date.lte'] = today;
    else params['first_air_date.lte'] = today;
    const data = await cachedTmdb(`/discover/${t}`, params);
    return { results: (data.results || []).map((x) => mapTitle(x, t)), totalPages: Math.min(data.total_pages || 1, 500) };
  };
  const parts = await Promise.all([
    type !== 'tv' ? fetchType('movie', movieGenre) : null,
    type !== 'movie' ? fetchType('tv', tvGenre) : null,
  ]);
  const results = parts.flatMap((x) => x?.results || []);
  if (type === 'all') results.sort((a, b) => (order.by(b) > order.by(a) ? 1 : order.by(b) < order.by(a) ? -1 : 0));
  return { results, page, totalPages: Math.max(...parts.map((x) => x?.totalPages || 0)) };
}

// ---------- documentaries ----------
const docs = createDocumentaries({
  tmdb: (endpoint, params) => cachedTmdb(endpoint, params), mapTitle, svtCategory: svt.svtCategory, svtOn: svt.svtEnabled, translate,
});

// ---------- SVT Play ----------
// Saved into the media folder like any download, under requester's library (src/svt-queue.js).
const svtQueue = MEDIA_DIR ? createSvtQueue({
  mediaDir: MEDIA_DIR, dataDir: DATA_DIR, ffmpeg: process.env.FFMPEG || 'ffmpeg',
  freeBytes: () => freeBytesFor('tv'),
  onChange: () => live.publish('library'),
  onSaved: svtSaved,
  log: (line) => console.log(line),
}) : null;
if (svtQueue) process.on('exit', () => svtQueue.stopAll());

async function svtSaved(job, full) {
  const key = accounts.mediaKey(full);
  const arrived = new Map();
  for (const userId of job.requesters) if (accounts.addEntry(userId, key, 'download')) arrived.set(userId, [full]);
  if (job.kind === 'film' && job.tmdbId) {
    const details = await tmdb(`/movie/${job.tmdbId}`).catch(() => null);
    if (details) shows.identifyFilm(key, details);
  }
  invalidateLibrary();
  if (arrived.size) announceArrivals(job.hash, arrived, job.requesters);
  if (job.kind === 'series') prepSeasonOf(full);
}

// The TMDB title with exactly this name (and year, for films), or null: SVT titles TMDB doesn't know
// keep SVT's own artwork instead of the closest guess.
async function svtIdentity(title) {
  if (!tmdbOn()) return null;
  const key = shows.showKey(title.title);
  const series = title.kind === 'series';
  try {
    const { results = [] } = await cachedTmdb(series ? '/search/tv' : '/search/movie', { query: title.title, include_adult: 'false' }, 6 * 3600 * 1000);
    const exact = results.filter((r) => [r.name, r.original_name, r.title, r.original_title].some((n) => n && shows.showKey(n) === key));
    const yearOf = (r) => Number(String(r.first_air_date || r.release_date || '').slice(0, 4)) || null;
    const fits = series ? exact : exact.filter((r) => !title.year || !yearOf(r) || Math.abs(yearOf(r) - title.year) <= 1);
    return fits.length === 1 || (series && fits.length) ? fits[0].id : null;
  } catch { return null; }
}

// What of a title is already here for this person, per episode (or the film).
async function svtHave(user, title) {
  const key = shows.showKey(title.title);
  const items = (await libraryVisibleItems(await scanLibrary(), user)) || [];
  const mine = accounts.libraryOf(user.id);
  const same = items.filter((i) => shows.showKey(i.title) === key);
  const statusOf = (item, videoId) => {
    if (item) return { status: mine.has(accounts.mediaKey(item.full)) ? 'library' : 'server', libraryId: item.id };
    const job = videoId && svtQueue?.get(svt.svtHashOf(videoId));
    if (!job) return { status: null, libraryId: null };
    return { status: job.state === 'error' ? 'failed' : 'queued', libraryId: null, state: job.state, progress: job.progress || 0, error: job.error || null };
  };
  return { same, statusOf };
}

async function svtTitleView(user, path) {
  const title = await svt.svtTitle(path);
  if (!title) throw new HttpError(404, 'SVT Play doesn’t have this right now.');
  const { same, statusOf } = await svtHave(user, title);
  if (title.kind === 'film') return { ...title, ...statusOf(same.find((i) => i.season == null), title.videoId) };
  return { ...title, seasons: title.seasons.map((s) => ({ ...s, episodes: s.episodes.map((e) => ({
    ...e, ...statusOf(same.find((i) => i.season === s.number && i.episode === e.number), e.videoId),
  })) })) };
}

// Queues a whole film, a season, or chosen episodes. What's already on the server just joins this person's
// library. `name` (a TMDB title) replaces SVT's so the files land under the show the person picked.
async function svtAdd(user, title, { seasons = null, episodes = null, name = null, tmdbId = null } = {}) {
  if (!svtQueue) throw new HttpError(503, 'No media folder is set up. Add MEDIA_DIR to .env and restart.');
  const shown = name || title.title;
  const identity = tmdbId ?? await svtIdentity(title);
  const poster = title.poster || title.wide;
  const common = { path: title.path, title: shown, kind: title.kind, year: title.year, tmdbId: identity,
    poster, backdrop: title.backdrop, requester: user.id };
  const { same, statusOf } = await svtHave(user, { title: shown });
  const result = { queued: 0, added: 0, have: 0, episodes: [] };
  const take = (item, spec) => {
    const state = statusOf(item, spec.videoId);
    if (state.status === 'library') { result.have++; return; }
    if (state.status === 'server') {
      if (accounts.addEntry(user.id, accounts.mediaKey(item.full), 'added')) result.added++;
      return;
    }
    svtQueue.add({ ...common, ...spec });
    result.queued++;
  };
  if (title.kind === 'film') {
    if (!identity) shows.pinFilmArt(shown, { title: shown, overview: title.overview, poster, backdrop: title.backdrop, genres: title.genres });
    take(same.find((i) => i.season == null), { videoId: title.videoId, season: null, episode: null, episodeName: null, minutes: title.minutes });
  } else {
    const picked = title.seasons.filter((s) => !seasons || seasons.includes(s.number));
    const art = { title: shown, overview: title.overview, year: title.year, poster, backdrop: title.backdrop, genres: title.genres,
      seasonNames: {}, episodes: {} };
    for (const s of title.seasons) {
      if (s.dated && s.name) art.seasonNames[s.number] = s.name;
      art.episodes[s.number] = Object.fromEntries(s.episodes.map((e) => [e.number, { name: e.name, still: e.still }]));
    }
    shows.pinShow(shown, identity, art);
    const showId = identity ? `tv-${identity}` : `name-${shows.showKey(shown)}`;
    for (const s of picked) {
      for (const e of s.episodes) {
        if (episodes && !episodes.includes(e.number)) continue;
        take(same.find((i) => i.season === s.number && i.episode === e.number), {
          videoId: e.videoId, season: s.number, episode: e.number, episodeName: e.name, minutes: e.minutes, showId, showKey: shows.showKey(shown),
        });
        result.episodes.push(e.number);
      }
    }
  }
  if (result.added) invalidateLibrary();
  return result;
}

// Smart Download's other source: exactly this title on SVT Play, or nothing. A show's seasons have to be
// numbered the way TMDB numbers them, which SVT's dated seasons ("Sommar 2026") aren't.
function svtAlternative(user, { type, title, originalTitle, year, tmdbId }) {
  if (!svt.svtEnabled() || !svtQueue) return null;
  const keys = new Set([title, originalTitle].filter(Boolean).map(shows.showKey));
  return async ({ season, episodes }) => {
    let hit = null;
    for (const name of [title, originalTitle].filter(Boolean)) {
      hit = (await svt.svtSearch(name)).find((t) => keys.has(shows.showKey(t.title)) && (type === 'tv' ? t.kind === 'series' : true));
      if (hit) break;
    }
    if (!hit) return null;
    const found = await svt.svtTitle(hit.path);
    if (!found) return null;
    if (year && found.year && Math.abs(year - found.year) > 1) return null;
    const message = 'Free on SVT Play, so it’s coming from there. On its way.';
    if (type === 'movie') {
      if (found.kind !== 'film') return null;
      await svtAdd(user, found, { name: title, tmdbId });
      return { name: `${title} (SVT Play)`, quality: '1080p', source: 'svt', message };
    }
    if (found.kind !== 'series') return null;
    const inSeason = found.seasons.find((s) => s.number === season && !s.dated);
    if (!inSeason) return null;
    const wanted = inSeason.episodes.map((e) => e.number).filter((e) => !episodes || episodes.includes(e));
    if (!wanted.length) return null;
    await svtAdd(user, found, { seasons: [season], episodes: wanted, name: title, tmdbId });
    return { name: `${title} (SVT Play)`, quality: '1080p', source: 'svt', episodes: wanted, message };
  };
}

// ---------- library ----------
let libraryCache = { at: 0, items: [] };
let libraryScan = null;
let libraryRevision = 0;
function invalidateLibrary() { libraryCache.at = 0; libraryRevision++; live.publish('library'); }
let libraryIds = null; // what the last scan found, so files added or removed outside Marquee show up live

async function scanLibrary() {
  if (!MEDIA_DIR) return null;
  if (Date.now() - libraryCache.at < 30_000) return libraryCache.items;
  if (libraryScan) return libraryScan;
  const task = (async () => {
    // A completion/delete during a scan must not turn its earlier view into a fresh cache.
    let revision;
    do { revision = libraryRevision; await scanLibraryNow(); } while (revision !== libraryRevision);
    return libraryCache.items;
  })();
  const done = task.finally(() => { if (libraryScan === done) libraryScan = null; });
  libraryScan = done;
  return done;
}

async function scanLibraryNow() {
  const items = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch {
      if (depth === 0) throw new HttpError(503, 'The media folder could not be read. Check that its drive is connected and try again.');
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!VIDEO_EXT.has(ext) || /\bsample\b/i.test(e.name) || converter.isTempFile(e.name)) continue;
      const stat = await fs.promises.stat(full).catch(() => null);
      if (!stat) continue;
      const rel = path.relative(MEDIA_DIR, full);
      const parsed = parseFile(full);
      items.push({
        id: Buffer.from(rel).toString('base64url'),
        file: e.name,
        size: stat.size,
        added: stat.mtimeMs,
        format: ext.slice(1),
        full,
        ...parsed,
      });
    }
  }
  await walk(MEDIA_DIR, 0);
  // Once converted, only the MP4 copy is listed.
  const fulls = new Set(items.map((i) => i.full));
  const visible = items.filter((i) => !(converter.needsConversion(i.full) && fulls.has(converter.twinPath(i.full))));
  visible.sort((a, b) => b.added - a.added);
  libraryCache = { at: Date.now(), items: visible, all: items };
  const ids = visible.map((i) => i.id).sort().join('|');
  if (libraryIds != null && ids !== libraryIds) live.publish('library');
  libraryIds = ids;
  return visible;
}

// librarySource: the file on disk. libraryPath: what gets streamed (the MP4 copy, if one exists).
function librarySource(id) {
  if (!MEDIA_DIR) throw new HttpError(404, 'No media folder is set up.');
  const rel = Buffer.from(id, 'base64url').toString();
  const full = path.resolve(MEDIA_DIR, rel);
  // Reject paths outside MEDIA_DIR.
  if (!full.startsWith(MEDIA_DIR + path.sep)) throw new HttpError(400, 'Invalid file.');
  return full;
}
const libraryPath = (id) => converter.preferConverted(librarySource(id));

// ---------- qBittorrent ----------
let qbitCookie = '';
let qbitSigningIn = null;

function qbitLogin() {
  if (qbitSigningIn) return qbitSigningIn;
  const task = signInQbit();
  const done = task.finally(() => { if (qbitSigningIn === done) qbitSigningIn = null; });
  qbitSigningIn = done;
  return done;
}

async function signInQbit() {
  const body = new URLSearchParams({
    username: process.env.QBIT_USER || '',
    password: process.env.QBIT_PASS || '',
  });
  let r;
  try {
    r = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
      method: 'POST', body, headers: { Referer: QBIT_URL }, signal: AbortSignal.timeout(5000),
    });
  } catch { throw new HttpError(503, 'qBittorrent could not be reached while signing in. Try again when it is running.'); }
  const text = (await r.text()).trim();
  if (r.status === 403) {
    throw new HttpError(502, 'qBittorrent has temporarily blocked sign-ins after too many failed attempts. Restart qBittorrent to clear it.');
  }
  // Older versions reply "Ok.", newer ones 204; "Fails." means bad credentials.
  if (!r.ok || /^fails/i.test(text)) {
    throw new HttpError(502, 'Could not sign in to qBittorrent. Check QBIT_USER and QBIT_PASS in .env.');
  }
  const cookie = (r.headers.getSetCookie?.() || [])[0]?.split(';')[0];
  qbitCookie = cookie || ''; // absent when localhost auth bypass is enabled
}

async function qbitRequest(endpoint, init = {}, retry = true) {
  if (!QBIT_URL) throw new HttpError(503, 'Downloads aren’t connected. Add QBIT_URL to .env and restart.');
  let r;
  try {
    const headers = { Referer: QBIT_URL };
    if (qbitCookie) headers.cookie = qbitCookie;
    r = await fetch(QBIT_URL + endpoint, { ...init, headers, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new HttpError(503, `qBittorrent isn’t reachable at ${QBIT_URL}. Is it running with Web UI turned on?`);
  }
  if ((r.status === 401 || r.status === 403) && retry) {
    await qbitLogin();
    return qbitRequest(endpoint, init, false);
  }
  if (r.status === 401 || r.status === 403) {
    throw new HttpError(502, 'qBittorrent accepted the sign-in but still refused access. Tick “Bypass authentication for clients on localhost” in its Web UI settings.');
  }
  if (!r.ok && r.status !== 415) throw new HttpError(502, `qBittorrent responded with ${r.status}.`);
  return r;
}

const torrentInventory = { at: 0, items: null, pending: null };
const knownLibraryAvailability = new Map();
async function qbit(endpoint) {
  let data;
  try { data = await (await qbitRequest(endpoint)).json(); }
  catch (error) {
    if (/^\/api\/v2\/torrents\/info(?:\?|$)/.test(endpoint)) torrentInventory.at = 0;
    throw error;
  }
  if (/^\/api\/v2\/torrents\/info(?:\?|$)/.test(endpoint) && !/[?&](?:hashes|filter)=/.test(endpoint) && Array.isArray(data)) {
    torrentInventory.at = Date.now(); torrentInventory.items = data;
  }
  return data;
}
// One person's library as the Library tab (and the Jellyfin plugin) sees it.
// Descriptions in the library come from the shared cache in TMDB_LANG. A viewer in another language gets theirs
// from a small cache of their own, which fills up a batch at a time, like genres do.
function localizedLibrary(view) {
  const lang = currentLanguage();
  const language = TMDB_LANGUAGES[lang];
  if (!language || language === TMDB_LANG) return view;
  const fetchOverview = async (type, id) => (await tmdb(`/${type}/${id}`, {}, language)).overview || '';
  shows.backfillOverviews(lang, 'tv', view.shows.map((s) => s.tmdbId), fetchOverview).catch(() => {});
  shows.backfillOverviews(lang, 'movie', view.items.filter((f) => f.season == null).map((f) => f.tmdbId), fetchOverview).catch(() => {});
  return {
    ...view,
    shows: view.shows.map((s) => ({ ...s, overview: shows.localOverview(lang, 'tv', s.tmdbId) || s.overview })),
    items: view.items.map((f) => (f.season == null && f.overview ? { ...f, overview: shows.localOverview(lang, 'movie', f.tmdbId) || f.overview } : f)),
  };
}

async function libraryView(user) {
  const items = await libraryVisibleItems(await scanLibrary(), user);
  if (!items) throw new HttpError(503, 'No media folder is set up. Add MEDIA_DIR to .env and restart.');
  // A video whose MP4 copy is being made can't be played yet (the player disables Play).
  const converting = converter.convertingFile();
  // Episodes are grouped into shows and seasons (TMDB posters and episode names when it answers in time).
  const tmdbOn = Boolean(TMDB_TOKEN || TMDB_KEY);
  const [{ shows: showList, showOf }, filmOf] = await Promise.all([
    shows.groupShows(items, tmdbOn ? tmdb : null),
    shows.filmInfo(items.map((i) => ({ ...i, mediaKey: accounts.mediaKey(i.full) })), tmdbOn ? tmdb : null),
  ]);
  if (tmdbOn) learnAnime(showList);
  // `items` is this person's library, with when each video gets deleted. `server` is everything
  // else on the server (no word on whose it is), so search can offer to add it instead of downloading
  // it again.
  const mine = accounts.libraryOf(user.id);
  const autoDelete = accounts.serverSettings().retentionDays > 0;
  const own = [];
  const server = [];
  for (const { full, ...rest } of items) {
    const mediaKey = accounts.mediaKey(full);
    const entry = mediaKey && mine.get(mediaKey);
    const base = { ...rest, mediaKey, ...showOf.get(rest.id), ...filmOf.get(rest.id) };
    Object.assign(base, versions.versionInfo({ ...base, full }));
    if (base.versionDubbed && wantsDub(user, base.filmTitle || base.title)) base.preferDub = true;
    base.versionKey = versions.versionKey(base);
    if (!entry) { server.push(base); continue; }
    own.push({
      ...base,
      converting: Boolean(converting) && converting === full && converter.needsConversion(full),
      convertPercent: Boolean(converting) && converting === full ? convertPercentOf(full) : null,
      source: entry.source,
      addedAt: entry.addedAt,
      expiresAt: autoDelete ? entry.expiresAt : null,
      extensions: entry.extensions,
    });
  }
  const myShows = new Set([...own, ...server].map((i) => i.show).filter(Boolean));
  rememberVersions([...own, ...server]);
  // Versions (versions.js): one item per film or episode, the others under `versions`.
  return { items: versions.collapseVersions(own), server, shows: showList.filter((s) => myShows.has(s.id)) };
}

// Media key -> the media keys of every version of the same title (itself included), so a watch
// position saved on one version is saved on all of them (web, TV app, Jellyfin alike).
const versionSiblings = new Map();
function rememberVersions(items) {
  const groups = new Map();
  for (const i of items) if (i.versionKey && i.mediaKey) groups.set(i.versionKey, [...(groups.get(i.versionKey) || []), i.mediaKey]);
  for (const keys of groups.values()) {
    if (keys.length > 1) for (const k of keys) versionSiblings.set(k, keys);
    else versionSiblings.delete(keys[0]);
  }
  if (versionSiblings.size > 20000) versionSiblings.clear();
}
function saveProgressAllVersions(userId, ref, time, duration) {
  accounts.saveProgress(userId, ref, time, duration);
  const key = /^m:(.+)$/.exec(String(ref || ''))?.[1];
  for (const other of versionSiblings.get(key) || []) {
    if (other !== key) accounts.saveProgress(userId, `m:${other}`, time, duration);
  }
}

// The Jellyfin plugin's view: the Library tab's items plus the subtitles saved beside each video.
async function jellyfinLibrary(user) {
  const { items, shows: showList } = await libraryView(user);
  for (const item of items) {
    try { item.subtitleLangs = [...subtitles.localLanguages(libraryPath(item.id))].sort(); } catch { item.subtitleLangs = []; }
  }
  return { items, shows: showList };
}

// A video a Jellyfin .strm points at, if it's still in this person's library. A file converted since
// the plugin's last sync is found again under its MP4 name (same media key).
async function jellyfinItem(user, id) {
  let full;
  try { full = librarySource(id); } catch { throw new HttpError(404, 'Not found.'); }
  const key = accounts.mediaKey(full);
  if (!key || !accounts.hasEntry(user.id, key)) throw new HttpError(404, 'That video isn’t in your Marquee library any more.');
  if (!fs.existsSync(full)) {
    const twin = (await scanLibrary())?.find((i) => accounts.mediaKey(i.full) === key);
    if (!twin) throw new HttpError(404, 'That file is no longer on the server.');
    full = twin.full;
  }
  return { stream: converter.preferConverted(full), label: streamLabel(full) };
}

async function libraryVisibleItems(items, user) {
  if (!QBIT_URL || !items) return items;
  const mine = accounts.libraryOf(user.id);
  const trusted = (item) => mine.has(accounts.mediaKey(item.full)) && knownLibraryAvailability.get(accounts.mediaKey(item.full)) !== false;
  let torrents = torrentInventory.items;
  if (!torrents || Date.now() - torrentInventory.at > 5000) {
    try {
      if (!torrentInventory.pending) {
        torrentInventory.pending = qbit('/api/v2/torrents/info').finally(() => { torrentInventory.pending = null; });
      }
      torrents = await torrentInventory.pending;
    } catch {
      // A disconnected client must not make existing trusted ownership disappear. Unowned files
      // cannot be offered for adoption until their completion can be established again.
      return items.filter(trusted);
    }
  }
  const availability = new Map(), uncertain = [];
  const relevant = torrents.filter((t) => items.some((i) => isInside(i.full, t.save_path || MEDIA_DIR)));
  await Promise.all(relevant.map(async (t) => {
    try {
      const files = await torrentFileMetadata(t);
      await Promise.all(files.filter((f) => isVideo(f.name)).map(async (f) => {
        const key = accounts.mediaKey(torrentFilePath(t, f));
        if (!key) return;
        const ready = !deletingDownloads.has(t.hash.toLowerCase()) && f.priority !== 0 && await downloadAvailable(t, f);
        availability.set(key, availability.get(key) === false ? false : ready);
      }));
    } catch { uncertain.push(t.content_path || t.save_path); }
  }));
  return items.filter((item) => {
    const key = accounts.mediaKey(item.full);
    if (availability.has(key)) {
      const ready = availability.get(key); knownLibraryAvailability.set(key, ready); return ready;
    }
    if (uncertain.some((dir) => dir && isInside(item.full, dir))) return trusted(item);
    knownLibraryAvailability.set(key, true);
    return true;
  });
}

// Coalesce file metadata between viewers/polls and bound requests for large torrent lists.
// Completion changes bypass the short cache so a newly finished episode is available immediately.
const torrentFilesCache = new Map();
let torrentFileRequests = 0;
const torrentFileWaiters = [];
async function fetchTorrentFiles(hash) {
  if (torrentFileRequests >= 4) await new Promise((resolve) => torrentFileWaiters.push(resolve));
  else torrentFileRequests++;
  try { return await qbit(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`); }
  finally {
    const next = torrentFileWaiters.shift();
    if (next) next(); else torrentFileRequests--;
  }
}
function torrentFileMetadata(t, { fresh = false } = {}) {
  const key = `${t.save_path || ''}|${t.progress >= 1}`;
  const previous = torrentFilesCache.get(t.hash);
  if (!fresh && previous?.key === key && (previous.pending || Date.now() - previous.at < 5000)) return previous.promise;
  // A claim and the metadata view can safely share an in-flight request.
  if (previous?.pending && previous.key === key) return previous.promise;
  const entry = { key, at: Date.now(), pending: true, promise: null };
  entry.promise = fetchTorrentFiles(t.hash).then((files) => {
    if (!Array.isArray(files)) throw new Error('Invalid qBittorrent file list.');
    entry.at = Date.now(); entry.pending = false;
    return files;
  }).catch((error) => { if (torrentFilesCache.get(t.hash) === entry) torrentFilesCache.delete(t.hash); throw error; });
  torrentFilesCache.set(t.hash, entry);
  if (torrentFilesCache.size > 500) torrentFilesCache.delete(torrentFilesCache.keys().next().value);
  return entry.promise;
}
function torrentFilePath(t, f) {
  const full = downloadFilePath(t.save_path, f.name);
  if (!full) throw new HttpError(502, 'qBittorrent returned an unsafe file path.');
  return full;
}
const fileExists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const downloadStatCache = new Map();
let downloadStatRequests = 0;
const downloadStatWaiters = [];
async function statDownloadFile(full) {
  if (downloadStatRequests >= 8) await new Promise((resolve) => downloadStatWaiters.push(resolve));
  else downloadStatRequests++;
  try { return await fs.promises.stat(full).catch(() => null); }
  finally { const next = downloadStatWaiters.shift(); if (next) next(); else downloadStatRequests--; }
}
function downloadAvailable(t, f, { fresh = false } = {}) {
  if (!(f.progress >= 1) || BUSY_STATES.test(t.state || '')) return Promise.resolve(false);
  let full;
  try { full = torrentFilePath(t, f); } catch { return Promise.resolve(false); }
  const key = `${full}|${f.size || 0}`, cached = downloadStatCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < 1500) return cached.promise;
  const entry = { at: Date.now(), promise: statDownloadFile(full).then((stat) => Boolean(stat?.isFile() && (!f.size || stat.size >= f.size))) };
  downloadStatCache.set(key, entry);
  if (downloadStatCache.size > 2000) downloadStatCache.delete(downloadStatCache.keys().next().value);
  return entry.promise;
}

function torrentIdentity(name) {
  const parsed = parseName(name, { file: false });
  if (parsed.season != null) return parsed;
  // Anime batches: "[SubsPlease] Black Clover (01-170) (1080p) [Batch]" is Black Clover (season 1).
  const a = anime.parseAnimeName(name);
  if (a?.title && !a.movie && (a.batch || a.seasons)) return { ...parsed, title: a.title, season: a.seasons?.length === 1 ? a.seasons[0] : a.seasons ? null : 1 };
  const pack = /\b(?:S(\d{1,2})|season[\s._-]*(\d{1,2}))\b/i.exec(name.replace(/[._]+/g, ' '));
  return pack ? { ...parsed, title: parseName(name.slice(0, pack.index), { file: false }).title, season: Number(pack[1] || pack[2]) } : parsed;
}

// Adds a magnet link, .torrent URL or uploaded .torrent file. `user` is who it's for: the torrent is
// tagged marquee-u<id> (and a magnet's infohash recorded) so it lands in their library when it finishes.
const downloadAdds = new Map();
const recentlyAddedDownloads = new Map();
const deletingDownloads = new Set();
function assertDownloadNotDeleting(hash) {
  if (hash && deletingDownloads.has(hash.toLowerCase())) throw new HttpError(409, 'This download is being removed. Wait for it to finish, then try again.');
}
async function addDownload(opts) {
  const hash = accounts.magnetHash(opts.link);
  if (!hash) return addDownloadNow(opts);
  const task = (downloadAdds.get(hash) || Promise.resolve()).catch(() => {}).then(() => addDownloadNow(opts));
  const done = task.finally(() => { if (downloadAdds.get(hash) === done) downloadAdds.delete(hash); });
  downloadAdds.set(hash, done);
  return done;
}
async function addDownloadNow({ link, file, user = null, name = '', film = null, show = null, mediaType = null }) {
  // .torrent links are downloaded here and handed to qBittorrent as a file: its own web requests
  // may be fenced off by the torrent VPN kill switch.
  if (!file && /^https?:\/\//i.test(String(link || '').trim())) {
    let got;
    try { got = await fetchTorrentFile(String(link).trim()); } catch (e) {
      throw new HttpError(400, e instanceof TorrentFetchError ? e.message : 'Couldn’t download the .torrent file.');
    }
    if (got.magnet) return addDownload({ link: got.magnet, user, name, film, show, mediaType });
    file = got.file;
  }
  // Adult content never reaches qBittorrent: the name, the magnet's dn, the .torrent's own file names
  // and the chosen TMDB identity are checked first. Magnets without names are checked again by
  // contentGuardRound() once their file list arrives.
  if (filterApplies(user)) {
    let dn = /[?&]dn=([^&]+)/.exec(String(link || ''))?.[1] || '';
    try { dn = decodeURIComponent(dn.replace(/\+/g, ' ')); } catch { /* keep it encoded */ }
    const found = (film?.adult || show?.adult) ? { name: name || film?.title || show?.name, reason: 'an adult TMDB title' }
      : firstAdult([name, dn, ...(file ? torrentFileNames(file) : [])]);
    if (found) {
      contentBlocked(user, name || found.name, found);
      throw new HttpError(403, BLOCKED_MESSAGE);
    }
  }
  const hash = accounts.magnetHash(link);
  assertDownloadNotDeleting(hash);
  if (hash && user) {
    const [existing] = await qbit(`/api/v2/torrents/info?hashes=${hash}`);
    assertDownloadNotDeleting(hash);
    if (existing) {
      accounts.recordTorrent(hash, torrentOwner(existing), existing.name);
      accounts.requestTorrent(hash, user.id, name);
      if (film && !shows.filmDownload(hash)) shows.rememberFilmDownload(hash, film);
      if (show && !shows.showDownload(hash)) shows.rememberShowDownload(hash, show, torrentIdentity(name));
      if (/^(missingFiles|error|unknown)$/.test(existing.state || '')) await retryDownload(existing);
      await claimCompletedTorrents([existing]);
      return { existing: true, hash };
    }
  }
  const form = new FormData();
  if (user) {
    form.append('tags', accounts.tagFor(user.id));
  }
  const destination = downloadDestination(MEDIA_DIR, { mediaType, film, name });
  if (destination) {
    await fs.promises.mkdir(destination, { recursive: true });
    form.append('savepath', destination);
  }
  if (file) {
    form.append('torrents', new Blob([file], { type: 'application/x-bittorrent' }), 'upload.torrent');
  } else {
    const url = String(link || '').trim();
    if (!/^magnet:\?/i.test(url) && !/^https?:\/\//i.test(url)) {
      throw new HttpError(400, 'Paste a magnet link (magnet:?…) or a link to a .torrent file.');
    }
    form.append('urls', url);
  }
  const r = await qbitRequest('/api/v2/torrents/add', { method: 'POST', body: form });
  const text = (await r.text()).trim();
  // Rejected input: "Fails." on older versions, 415 on newer ones.
  if (r.status === 415 || /^fails/i.test(text)) {
    throw new HttpError(400, file ? 'qBittorrent couldn’t read that .torrent file.' : 'qBittorrent couldn’t use that link.');
  }
  if (hash && user) {
    assertDownloadNotDeleting(hash);
    const recent = recentlyAddedDownloads.get(hash);
    accounts.requestTorrent(hash, user.id, name, { restart: !recent || Date.now() - recent > 60000 });
    recentlyAddedDownloads.set(hash, Date.now());
    if (recentlyAddedDownloads.size > 500) recentlyAddedDownloads.delete(recentlyAddedDownloads.keys().next().value);
    torrentFilesCache.delete(hash);
    torrentInventory.at = 0;
  }
  if (film && hash) shows.rememberFilmDownload(hash, film);
  if (show && hash) shows.rememberShowDownload(hash, show, torrentIdentity(name));
  setTimeout(() => contentGuardRound(), 1000);
  return { existing: false, hash };
}

// Episodes of a show's season that are already here: in the library, or in qBittorrent (an episode,
// or a season pack, which counts as every episode). Episodes already on the server go straight into
// `user`'s library instead of being downloaded twice.
// dub: only dual-audio copies count, so a subtitled copy never stands in for the dub someone asked for.
async function haveEpisodes(key, seasonNo, user = null, ctx = null, { dub = false } = {}) {
  const have = new Set();
  const queued = new Set(); // in `have` because a download has them, not yet playable
  have.queued = queued;
  let list = [];
  try { list = await qbit('/api/v2/torrents/info'); } catch { /* qBittorrent down: library only */ }
  const relevant = list.filter((t) => {
    if (dub && !isDualAudio(t.name)) return false;
    // Anime: a torrent Marquee downloaded for this show, or any name the context places in this season.
    if (ctx && (shows.showDownload(t.hash)?.id === ctx.id || season.episodesIn(t.name, seasonNo, ctx).length)) return true;
    const identity = torrentIdentity(t.name);
    return identity.season === seasonNo && season.sameShow(identity.title, key);
  });
  const managed = new Map();
  for (const t of relevant) {
    try {
      const files = await torrentFileMetadata(t, { fresh: true });
      let covered = false;
      for (const f of files) {
        const full = torrentFilePath(t, f);
        const selected = f.priority !== 0 && isVideo(f.name);
        const ready = selected && f.progress >= 1 && fileExists(full) && !BUSY_STATES.test(t.state || '');
        managed.set(path.resolve(full).toLowerCase(), ready);
        if (!selected) continue;
        const failed = /^(missingFiles|error|unknown)$/.test(t.state || '');
        // Selected queued files count, but a completed/missing download must prove its files exist.
        if (!ready && (failed || t.progress >= 1)) continue;
        for (const ep of season.episodesIn(path.basename(f.name.replace(/\\/g, '/')), seasonNo, ctx)) { have.add(ep); if (!ready) queued.add(ep); covered = true; }
      }
      if (covered && user) {
        accounts.recordTorrent(t.hash, torrentOwner(t), t.name);
        accounts.requestTorrent(t.hash, user.id, t.name);
      }
    } catch { /* Unreadable file metadata does not prove episode coverage. */ }
  }
  const library = await libraryVisibleItems(await scanLibrary(), user || accounts.ownerUser());
  for (const i of library || []) {
    if (dub && !isDualAudio(i.full)) continue;
    if (ctx ? i.episode == null || !(season.sameShow(i.title, key) || ctx.keys.includes(shows.showKey(i.title)))
      : i.season !== seasonNo || i.episode == null || !season.sameShow(i.title, key)) continue;
    const managedState = managed.get(path.resolve(i.full).toLowerCase());
    // A partial file may already be visible in MEDIA_DIR; never adopt it as a playable episode.
    if (managedState === false || (managedState == null && relevant.some((t) => isInside(i.full, t.content_path || path.join(t.save_path || '', t.name))))) continue;
    const eps = ctx ? (i.season === seasonNo && i.title === ctx.title ? [i.episode] : season.episodesIn(i.file, seasonNo, ctx)) : season.episodesIn(i.file, seasonNo);
    if (ctx && !eps.length) continue;
    for (const ep of eps) { have.add(ep); queued.delete(ep); }
    if (user) accounts.addEntry(user.id, accounts.mediaKey(i.full), 'added');
  }
  return have;
}

// This person asked for this anime dubbed (Download panel), by any of its names.
function wantsDub(user, title) {
  const ctx = title ? anime.contextForTitle(title) : null;
  return Boolean(ctx && user?.settings?.dubbed?.includes(`${ctx.type}:${ctx.id}`));
}

function rememberDub(user, type, id, on) {
  const key = `${type}:${id}`;
  const list = (user.settings?.dubbed || []).filter((k) => k !== key);
  if (on || list.length !== (user.settings?.dubbed || []).length) accounts.updateMe(user, { dubbed: on ? [...list, key] : list });
}

// The Download command (smart-download.js) for one person: a film, a season or some episodes.
// Used by the Download button and by Save for later / Follow (watchlist.js) in the background.
async function startSmartFor(user, body) {
  if (!QBIT_URL) throw new HttpError(503, 'Downloads aren’t connected. Add QBIT_URL to .env and restart.');
  const type = body.type === 'tv' ? 'tv' : 'movie';
  const tmdbId = Number(body.tmdbId);
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) throw new HttpError(400, 'Which film or show?');
  if (!TMDB_TOKEN && !TMDB_KEY) throw new HttpError(503, 'Downloading by title needs TMDB. Add TMDB_TOKEN to .env and restart.');
  const details = await tmdb(`/${type}/${tmdbId}`);
  const title = String((type === 'tv' ? details.name : details.title) || '').trim();
  if (!title) throw new HttpError(404, 'That title couldn’t be found.');
  if (details.adult && filterApplies(user)) {
    contentBlocked(user, title, { name: title, reason: 'an adult TMDB title' });
    throw new HttpError(403, BLOCKED_MESSAGE);
  }
  const date = type === 'tv' ? details.first_air_date : details.release_date;
  const year = date ? Number(date.slice(0, 4)) : null;
  const original = String((type === 'tv' ? details.original_name : details.original_title) || '').trim();
  const seasonNo = type === 'tv' ? Number(body.season) : null;
  if (type === 'tv' && (!Number.isInteger(seasonNo) || seasonNo < 1 || seasonNo > 99)) throw new HttpError(400, 'Which season?');
  const episodes = type === 'tv' && Array.isArray(body.episodes)
    ? [...new Set(body.episodes.map(Number).filter((e) => Number.isInteger(e) && e > 0 && e < 5000))].slice(0, 1500) : null;
  const range = Boolean(body.range && episodes?.length > 1); // "Episodes 150–200": batches may serve it
  const film = type === 'movie' ? details : null, show = type === 'tv' ? details : null;
  const subs = subtitles.subtitlesConfigured() && user.settings?.subLang ? [user.settings.subLang] : [];
  // Anime: every known name and how its seasons line up with TMDB's (anime.js). Without AniList it
  // still has TMDB's names; a failure only means the plain search below.
  const animeCtx = anime.isAnimeDetails(details)
    ? anime.buildContext(type, tmdbId, tmdb, { details }).catch((e) => { console.warn(`[anime] ${title}: ${e.message}`); return null; })
    : null; // a promise: the job waits for it, the Download button doesn't
  const upgrade = type === 'tv' && body.upgrade ? await upgradeSource(user, title, seasonNo) : null;
  // Dubbed: dual-audio releases only, anime only. The choice is remembered for the player.
  const dub = Boolean(animeCtx && !upgrade && body.dub === true);
  if (animeCtx && !upgrade && typeof body.dub === 'boolean') rememberDub(user, type, tmdbId, dub);
  const want = downloadWant(user, body);
  const documentary = (details.genres || []).some((g) => g.id === 99);
  const id = smart.startSmartJob({
    type, title, year, season: seasonNo, episodes: upgrade || !episodes?.length ? null : episodes, range: !upgrade && range, requester: user.id, subs, anime: upgrade ? null : animeCtx, dub,
    upgrade: upgrade && { episodes: upgrade.episodes, bytes: upgrade.bytes, names: upgrade.names, quality: upgrade.quality },
    originalTitle: original && original !== title && /^[\p{Script=Latin}\d\s\p{P}]+$/u.test(original) ? original : null,
    want,
    preferAlternative: !upgrade && !animeCtx && details.original_language === 'sv',
  }, {
    parseName, magnetFor1337x: torrents.magnetFor1337x,
    searchTorrents: (q, t) => torrents.searchTorrents(q, t, { documentary }),
    alternative: upgrade || animeCtx ? null : svtAlternative(user, { type, title, originalTitle: original, year, tmdbId }),
    addDownload: (opts) => addDownload({ ...opts, user, film, show }),
    wantSubtitles: (link, list, name) => { subtitles.wantSubtitles(link, list, name); setTimeout(checkSubtitleWants, 30_000); },
    filmHave: () => filmHave(tmdbId, user, want.quality, { dub }), freeBytes: freeBytesFor,
    seasonEpisodes: (t, y, n) => shows.seasonEpisodes(t, y, n, tmdb),
    haveEpisodes: (key, n, ctx) => haveEpisodes(key, n, user, ctx, { dub }),
    trimPack: (link, n, owned, ctx) => trimSeasonPack(link, n, owned, { ctx }), removePack: removeNewPack,
    reopenPack: (link, n, owned, ctx) => reopenPack(link, n, owned, { ctx, key: shows.showKey(title) }),
    torrentsHere: async () => new Set((await qbit('/api/v2/torrents/info')).map((t) => t.hash.toLowerCase())),
    inOrder: ({ hash, existing }, n) => { if (!existing) orderEpisodes(hash, shows.showKey(title), n); },
    upgrading: ({ hash }, n) => registerUpgrade(hash, { title, season: n, by: user.id, old: upgrade?.old || [] }),
    log: (msg) => console.log(msg),
  });
  return { id, title, type, season: seasonNo, episodes: upgrade ? null : episodes, upgrade: Boolean(upgrade) };
}

// ---- Upgrade quality ----
// The season as this person has it (their library): its files, episodes, size and release name.
// Replacing deletes files, so someone else's copy can only be upgraded by the server's owner.
async function upgradeSource(user, title, seasonNo) {
  const key = shows.showKey(title);
  const items = ((await libraryVisibleItems(await scanLibrary(), user)) || [])
    .filter((i) => i.season === seasonNo && i.episode != null && season.sameShow(i.title, key));
  if (!items.length) throw new HttpError(409, 'There’s nothing of this season in your library to upgrade.');
  if (!user.isOwner && items.some((i) => accounts.heldOutside(accounts.mediaKey(i.full), user.id))) {
    throw new HttpError(403, 'Someone else also has these episodes, so only the server’s owner can upgrade them.');
  }
  if ([...upgrades.values()].some((u) => u.old.some((o) => items.some((i) => samePath(i.full, o.full))))) {
    throw new HttpError(409, 'This season is already being upgraded. The old episodes are swapped as the new ones finish.');
  }
  const old = items.map((i) => ({ id: i.id, full: i.full, episodes: season.episodesIn(i.file, seasonNo).length ? season.episodesIn(i.file, seasonNo) : [i.episode] }));
  const folder = path.basename(path.dirname(items[0].full));
  const files = items.map((i) => path.basename(i.file, path.extname(i.file)));
  const names = [...new Set(/\b(s\d{1,2}|season)\b/i.test(folder.replace(/[._]+/g, ' ')) ? [folder, ...files] : files)];
  return {
    old, names, bytes: items.reduce((n, i) => n + (i.size || 0), 0),
    episodes: [...new Set(old.flatMap((o) => o.episodes))].sort((a, b) => a - b),
    quality: parseName(names[0], { file: false }).quality || items[0].quality || null,
  };
}
// New download hash -> { title, season, by, old: [{ id, full, episodes }], at }. Saved across restarts.
const UPGRADE_FILE = path.join(DATA_DIR, '.marquee-upgrades.json');
const upgrades = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(UPGRADE_FILE, 'utf8')); } catch { return {}; } })()));
const saveUpgrades = () => { try { fs.writeFileSync(UPGRADE_FILE, JSON.stringify(Object.fromEntries(upgrades))); } catch (e) { console.warn(`[upgrade] ${e.message}`); } };
function registerUpgrade(hash, entry) {
  if (!hash || !entry.old.length) return;
  upgrades.set(hash.toLowerCase(), { ...entry, at: Date.now() });
  saveUpgrades();
}
// Each old episode goes once its new one has finished: libraries and watch progress move to the new
// file first, so nobody loses their place. Busy files (playing, converting, in a Watch Together room)
// wait for the next round. Episodes the new download doesn't have keep their old file. If the new
// download is removed, the old episodes simply stay.
let upgradeBusy = false;
async function upgradeRound() {
  if (!QBIT_URL || !upgrades.size || upgradeBusy) return;
  upgradeBusy = true;
  let changed = false;
  try {
    const list = await qbit(`/api/v2/torrents/info?hashes=${[...upgrades.keys()].join('|')}`);
    const byHash = new Map(list.map((t) => [t.hash.toLowerCase(), t]));
    for (const [hash, u] of [...upgrades]) {
      const label = `${u.title} S${String(u.season).padStart(2, '0')}`;
      const t = byHash.get(hash);
      if (!t) { upgrades.delete(hash); changed = true; console.log(`[upgrade] ${label}: new download removed, old episodes kept`); continue; }
      let files;
      try { files = await torrentFileMetadata(t, { fresh: true }); } catch { continue; }
      const ready = new Map(); // episode -> finished new file
      for (const f of files) {
        if (f.priority === 0 || !isVideo(f.name) || f.progress < 1) continue;
        const full = torrentFilePath(t, f);
        if (!fileExists(full)) continue;
        for (const ep of season.episodesIn(path.basename(f.name.replace(/\\/g, '/')), u.season)) if (!ready.has(ep)) ready.set(ep, full);
      }
      const finished = t.progress >= 1 && !BUSY_STATES.test(t.state || '');
      const left = [];
      for (const old of u.old) {
        const target = old.episodes.every((e) => ready.has(e)) ? ready.get(old.episodes[0]) : null;
        if (!target) { if (!finished) left.push(old); continue; }
        if (samePath(target, old.full)) continue;
        if (!await replaceWithUpgrade(old, target)) left.push(old);
      }
      if (left.length !== u.old.length) changed = true;
      if (left.length) u.old = left;
      else { upgrades.delete(hash); console.log(`[upgrade] ${label}: done, every old episode replaced`); }
    }
  } catch (e) {
    console.warn(`[upgrade] ${e.message}`);
  } finally {
    if (changed) saveUpgrades();
    upgradeBusy = false;
  }
}
async function replaceWithUpgrade(old, target) {
  if (!fileExists(old.full)) return true;
  const oldKey = accounts.mediaKey(old.full), newKey = accounts.mediaKey(target);
  if (converter.isBusy(old.full) || watchRooms.protects(oldKey)) return false;
  accounts.moveMedia(oldKey, newKey);
  try {
    await deleteMedia(old.id, 'file', { everyone: true });
    if (oldKey) accounts.markGone(oldKey);
    console.log(`[upgrade] replaced ${path.basename(old.full)} with ${path.basename(target)}`);
    prepSeasonOf(target);
    return true;
  } catch (e) {
    console.warn(`[upgrade] ${path.basename(old.full)} kept for now: ${e.message}`);
    return false;
  }
}
setInterval(() => upgradeRound(), 30_000).unref();

// ---- Save for later and Follow (watchlist.js) ----
const tmdbOn = () => Boolean(TMDB_TOKEN || TMDB_KEY);
const mayAutoDownload = (u) => Boolean(u && u.canDownload && QBIT_URL && tmdbOn() && torrents.torrentsEnabled());
function watchMeta(type, d) {
  const date = type === 'tv' ? d.first_air_date : d.release_date;
  return {
    title: String((type === 'tv' ? d.name : d.title) || '').trim() || 'Untitled', year: date ? Number(date.slice(0, 4)) : null,
    poster: d.poster_path ? `https://image.tmdb.org/t/p/w342${d.poster_path}` : null,
    backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w780${d.backdrop_path}` : null,
    overview: d.overview || null, rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
  };
}
async function finishedSmartJob(user, body) {
  const { id } = await startSmartFor(user, body);
  for (const end = Date.now() + 20 * 60 * 1000; Date.now() < end;) {
    const job = smart.smartJob(id);
    if (!job || job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return smart.smartJob(id);
}
let watchlistBusy = false, watchlistAgain = false;
async function checkWatchlist() {
  if (!tmdbOn()) return;
  if (watchlistBusy) { watchlistAgain = true; return; }
  watchlistBusy = true;
  try {
    do {
      watchlistAgain = false;
      await watchlistRound(watchlist, {
        user: (id) => accounts.userById(id), canAuto: mayAutoDownload,
        film: (id) => cachedTmdb(`/movie/${id}`, { append_to_response: 'release_dates' }, 6 * 3600 * 1000),
        show: (id) => cachedTmdb(`/tv/${id}`, {}, 3600 * 1000),
        season: (id, n) => cachedTmdb(`/tv/${id}/season/${n}`, {}, 3600 * 1000),
        download: finishedSmartJob,
        changed: (userId) => live.publish('watchlist', { audience: 'user', userId }),
        log: (msg) => console.log(msg),
      });
    } while (watchlistAgain);
  } catch (e) { console.log(`[watchlist] ${e.message || e}`); } finally { watchlistBusy = false; }
}
setInterval(checkWatchlist, 10 * 60 * 1000).unref();
setTimeout(checkWatchlist, 60 * 1000).unref();

// ---- smart downloads (smart-download.js): what the job needs from the server ----
// Space left for new downloads on the disk a film or show goes to: free space, minus what queued
// downloads still have to write there, minus a reserve so the disk never fills up completely.
const DISK_RESERVE = 5 * 1024 ** 3;
async function freeBytesFor(type) {
  const dir = MEDIA_DIR ? downloadDestination(MEDIA_DIR, { mediaType: type }) || MEDIA_DIR : null;
  if (!dir) return Infinity;
  let free;
  try {
    const target = fs.existsSync(dir) ? dir : MEDIA_DIR;
    const st = await fs.promises.statfs(target);
    free = Number(st.bavail) * Number(st.bsize);
  } catch { return Infinity; } // unknown: the size limit from Settings still applies
  let pending = 0;
  try {
    const root = path.parse(path.resolve(dir)).root.toLowerCase();
    for (const t of await qbit('/api/v2/torrents/info?filter=downloading')) {
      if (path.parse(path.resolve(t.save_path || dir)).root.toLowerCase() === root) pending += Number(t.amount_left) || 0;
    }
  } catch { /* qBittorrent down: free space alone */ }
  return free - pending - DISK_RESERVE;
}

// A film you already have, can have (someone else's copy on the server joins your library), or that
// is already downloading (you're added to its requesters, as when adding the same magnet twice).
// quality: an exact resolution was asked for (Advanced). A copy in another resolution doesn't count:
// the new one becomes a version of the film (versions.js).
async function filmHave(tmdbId, user, quality = null, { dub = false } = {}) {
  const items = await libraryVisibleItems(await scanLibrary(), user);
  if (items?.length) {
    const ids = await shows.filmInfo(items.map((i) => ({ ...i, mediaKey: accounts.mediaKey(i.full) })), null);
    const mine = accounts.libraryOf(user.id);
    const matches = items.filter((i) => Number(ids.get(i.id)?.tmdbId) === Number(tmdbId) && !ids.get(i.id)?.movieAmbiguous
      && (!quality || versions.sameQuality(versions.qualityOf(i.file), quality)) && (!dub || isDualAudio(i.full)));
    if (matches.some((i) => mine.has(accounts.mediaKey(i.full)))) return 'library';
    if (matches.length) {
      for (const i of matches) accounts.addEntry(user.id, accounts.mediaKey(i.full), 'added');
      return 'server';
    }
  }
  let list = [];
  try { list = await qbit('/api/v2/torrents/info'); } catch { return null; }
  const active = list.find((t) => Number(shows.filmDownload(t.hash)?.id) === Number(tmdbId) && (!dub || isDualAudio(t.name)) && !/^(missingFiles|error|unknown)$/.test(t.state || ''));
  if (!active) return null;
  accounts.recordTorrent(active.hash, torrentOwner(active), active.name);
  accounts.requestTorrent(active.hash, user.id, active.name);
  return 'downloading';
}

// A season pack that was just added: wait (bounded) for its file list, switch off the episodes
// already here and report the episodes it really contains. null when the file list never came.
// Anime (ctx): files of other seasons are switched off too (a "(01-170)" batch for one TMDB season).
async function packFilesOf(hash, timeout) {
  let files = [];
  for (const end = Date.now() + timeout; Date.now() < end;) {
    try { files = await qbit(`/api/v2/torrents/files?hash=${hash}`); } catch { files = []; }
    if (files.length) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return files;
}

// The batch is already on the server, perhaps with episodes switched off (someone's range, or ones
// deleted earlier). Switches back on the ones this request wants, so "on the way" is true.
async function reopenPack(link, seasonNo, owned, { timeout = 45000, ctx = null, key = null } = {}) {
  const hash = accounts.magnetHash(link);
  if (!hash) return null;
  const files = await packFilesOf(hash, timeout);
  if (!files.length) return null;
  const [t] = await qbit(`/api/v2/torrents/info?hashes=${hash}`);
  if (!t) return null;
  const covered = new Set(), on = [];
  let deleted = false;
  files.forEach((f, i) => {
    if (!isVideo(f.name)) return;
    const base = path.basename(f.name.replace(/\\/g, '/'));
    const fileSeason = ctx ? null : parseName(base).season;
    if (fileSeason != null && fileSeason !== seasonNo) return;
    const eps = season.episodesIn(base, seasonNo, ctx).filter((e) => !owned.has(e));
    if (!eps.length) return;
    eps.forEach((e) => covered.add(e));
    if (f.priority !== 0) return;
    on.push(f.index ?? i);
    // Fully downloaded once and since deleted: qBittorrent still counts those pieces as done.
    try { if (f.progress >= 0.99 && !fileExists(torrentFilePath(t, f))) deleted = true; } catch { deleted = true; }
  });
  if (!on.length) return { covered, skipped: 0 };
  await qbitRequest('/api/v2/torrents/filePrio', { method: 'POST', body: new URLSearchParams({ hash, id: on.join('|'), priority: '1' }) });
  if (deleted) await qbitRequest('/api/v2/torrents/recheck', { method: 'POST', body: new URLSearchParams({ hashes: hash }) });
  const entry = episodeOrder.get(hash.toLowerCase());
  if (!entry?.held && /^(paused|stopped)/.test(t.state || '')) await setPaused(hash, false);
  if (!entry) orderEpisodes(hash, key, seasonNo);
  torrentFilesCache.delete(hash);
  torrentInventory.at = 0;
  return { covered, skipped: 0, reopened: on.length };
}

async function trimSeasonPack(link, seasonNo, owned, { timeout = 45000, ctx = null } = {}) {
  const hash = accounts.magnetHash(link);
  if (!hash) return null;
  const files = await packFilesOf(hash, timeout);
  if (!files.length) return null;
  const covered = new Set(), skip = [];
  files.forEach((f, i) => {
    if (!isVideo(f.name)) return;
    const name = f.name.replace(/\\/g, '/');
    if (ctx) {
      const eps = season.episodesIn(path.basename(name), seasonNo, ctx);
      if (!eps.length) { if (anime.resolve(anime.parseAnimeName(path.basename(name), { file: true }), ctx)) skip.push(f.index ?? i); return; }
      if (eps.every((e) => owned.has(e))) skip.push(f.index ?? i);
      else eps.forEach((e) => covered.add(e));
      return;
    }
    const fileSeason = parseName(path.basename(name)).season;
    if (fileSeason != null && fileSeason !== seasonNo) return;
    const eps = season.episodesIn(path.basename(name), seasonNo);
    if (!eps.length) return;
    if (eps.every((e) => owned.has(e))) skip.push(f.index ?? i);
    else eps.forEach((e) => covered.add(e));
  });
  if (skip.length && covered.size) {
    await qbitRequest('/api/v2/torrents/filePrio', {
      method: 'POST', body: new URLSearchParams({ hash, id: skip.join('|'), priority: '0' }),
    });
  }
  torrentFilesCache.delete(hash);
  torrentInventory.at = 0;
  return { covered, skipped: covered.size ? skip.length : 0, allOwned: !covered.size && skip.length > 0 };
}

// ---- versions: no second copy in the same resolution (versions.js) ----
// A manual download (release list, Find torrents, a pasted link) of a film or episode that's already
// here in the same resolution is refused with what's here and what to do instead. Another resolution
// is fine: it becomes a version. Season packs aren't refused (they may fill gaps): the episodes already
// here in that resolution are switched off instead. Returns { seasonNo, owned } for that.
async function newVersionCheck(user, { link, name, film, show, mediaType }) {
  // The same torrent again (already in qBittorrent, or its files still here) is shared or resumed, not copied.
  const hash = accounts.magnetHash(link);
  if (hash && (await qbit(`/api/v2/torrents/info?hashes=${hash}`).catch(() => []))[0]) return null;
  const items = await libraryVisibleItems(await scanLibrary(), user);
  if (!items?.length) return null;
  const quality = versions.qualityOf(name);
  const mine = accounts.libraryOf(user.id);
  const label = quality === '2160p' ? '4K' : quality || 'this quality';
  const plainName = (n) => String(n).replace(/\.[a-z0-9]{2,4}$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const release = plainName(name);
  const ownFiles = (i) => plainName(i.file) === release || plainName(path.basename(path.dirname(i.full))) === release;
  const same = (i) => versions.sameQuality(versions.qualityOf(i.file), quality) && !ownFiles(i);
  const refuse = (title, found) => {
    const yours = found.some((i) => mine.has(accounts.mediaKey(i.full)));
    throw new HttpError(409, `${title} is already ${yours ? 'in your library' : 'on the server'} in ${label}. `
      + (yours ? 'Pick a release in another quality (it becomes a version you can switch to), or use Upgrade quality to replace it.'
        : 'Add it to your library instead of downloading it again.'));
  };
  const identity = torrentIdentity(name);
  const isShow = show || mediaType === 'tv' || identity.season != null;
  if (!isShow) {
    const parsed = parseName(name, { file: false });
    const films = items.filter((i) => i.season == null);
    if (!films.length) return null;
    const info = await shows.filmInfo(films.map((i) => ({ ...i, mediaKey: accounts.mediaKey(i.full) })), null);
    const found = films.filter((i) => {
      const f = info.get(i.id);
      if (film) return Number(f?.tmdbId) === Number(film.id) && !f?.movieAmbiguous;
      return shows.showKey(f?.filmTitle || i.title) === shows.showKey(parsed.title)
        && (!parsed.year || !(f?.year || i.year) || Math.abs((f?.year || i.year) - parsed.year) <= 1);
    }).filter(same);
    if (found.length) refuse(film?.title || parsed.title, found);
    return null;
  }
  const seasonNo = identity.season;
  if (seasonNo == null) return null;
  const key = shows.showKey(show?.name || identity.title || '');
  if (!key) return null;
  const here = items.filter((i) => i.season === seasonNo && i.episode != null && season.sameShow(i.title, key) && same(i));
  const eps = season.episodesIn(name, seasonNo);
  if (eps.length) {
    const found = here.filter((i) => eps.includes(i.episode));
    if (eps.every((e) => found.some((i) => i.episode === e))) {
      refuse(`${show?.name || identity.title} S${String(seasonNo).padStart(2, '0')}${eps.length === 1 ? `E${String(eps[0]).padStart(2, '0')}` : ''}`, found);
    }
    return null;
  }
  return { seasonNo, owned: new Set(here.map((i) => i.episode)), here: here.map((i) => ({ full: i.full, episode: i.episode })) };
}
// Once the pack's file list is known: files already on disk at the pack's own paths are the pack
// itself (a re-add or a resume), not other copies, so they never count as owned.
async function trimDuplicatePack(link, { seasonNo, here }) {
  const hash = accounts.magnetHash(link);
  if (!hash) return;
  let files = [], t = null;
  for (const end = Date.now() + 45000; Date.now() < end && !files.length;) {
    try { [t] = await qbit(`/api/v2/torrents/info?hashes=${hash}`); files = t ? await qbit(`/api/v2/torrents/files?hash=${hash}`) : []; } catch { files = []; }
    if (!files.length) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!t || !files.length) return;
  const own = new Set(files.map((f) => path.resolve(torrentFilePath(t, f)).toLowerCase()));
  const owned = new Set(here.filter((i) => !own.has(path.resolve(i.full).toLowerCase())).map((i) => i.episode));
  if (!owned.size) return;
  trimSeasonPack(link, seasonNo, owned).then(async (trim) => {
    if (!trim?.covered) return;
    if (trim.allOwned) {
      await removeNewPack(link);
      console.log(`[versions] removed a season ${seasonNo} pack: every episode was already here in that quality`);
    } else if (trim.skipped) console.log(`[versions] season ${seasonNo} pack: ${trim.skipped} episodes already here in that quality switched off`);
  }).catch((e) => console.warn(`[versions] ${e.message}`));
}

async function removeNewPack(link) {
  const hash = accounts.magnetHash(link);
  if (!hash) return;
  await qbitRequest('/api/v2/torrents/delete', { method: 'POST', body: new URLSearchParams({ hashes: hash, deleteFiles: 'true' }) });
  torrentFilesCache.delete(hash);
  torrentInventory.at = 0;
}

// Download preferences (Settings → Downloads), optionally overridden for one command.
const EXACT_QUALITIES = ['2160p', '1440p', '1080p', '720p'];
function downloadWant(user, body = {}) {
  const s = user.settings || {};
  const saved = PROFILES.includes(s.downloadProfile) ? s.downloadProfile
    : ['2160p', '1440p'].includes(s.quality) ? 'best' : s.quality === '720p' ? 'save' : 'balanced';
  const profile = PROFILES.includes(body.profile) ? body.profile : saved;
  return {
    profile,
    // A resolution chosen before profiles existed still leads, as long as the profile is the saved one.
    prefer: profile === saved && EXACT_QUALITIES.includes(s.quality) ? s.quality : null,
    quality: EXACT_QUALITIES.includes(body.quality) ? body.quality : null,
    maxBytes: Number(s.maxSize) > 0 ? Number(s.maxSize) * 1024 ** 3 : 0,
    audioLang: s.audioLang || '',
  };
}

// ---- episodes in order (episode-order.js) ----
// Torrents a Download Season added: hash -> { key, season, held }. held = stopped by Marquee to
// let an earlier episode download first. Saved, so a restart doesn't leave episodes stopped.
const ORDER_FILE = path.join(DATA_DIR, '.marquee-episode-order.json');
const episodeOrder = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')); } catch { return {}; } })()));
const saveEpisodeOrder = () => { try { fs.writeFileSync(ORDER_FILE, JSON.stringify(Object.fromEntries(episodeOrder))); } catch (e) { console.warn(`[order] ${e.message}`); } };
const finishedEpisodeFiles = new Set();
function orderEpisodes(hash, key, seasonNo) {
  if (!hash || !key || !Number.isInteger(seasonNo)) return;
  episodeOrder.set(hash.toLowerCase(), { key, season: seasonNo, held: false });
  saveEpisodeOrder();
  setTimeout(() => episodeOrderRound().catch(() => {}), 1500);
}
// The person took over this download (paused, resumed or removed it): Marquee stops ordering it.
function releaseEpisodeOrder(hash) {
  if (episodeOrder.delete(String(hash).toLowerCase())) saveEpisodeOrder();
}
let orderBusy = false;
// When each ordered torrent was last seen stalled: one Marquee stopped keeps counting as stalled for a
// while (episode-order.js), then gets another try.
const lastStalled = new Map();
const STALL_MEMORY = 30 * 60e3;
async function episodeOrderRound() {
  if (!QBIT_URL || !episodeOrder.size || orderBusy) return;
  orderBusy = true;
  try {
    const list = await qbit(`/api/v2/torrents/info?hashes=${[...episodeOrder.keys()].join('|')}`);
    const present = new Set(list.map((t) => t.hash.toLowerCase()));
    let changed = false;
    for (const hash of [...episodeOrder.keys()]) if (!present.has(hash)) { episodeOrder.delete(hash); changed = true; }
    const groups = new Map();
    for (const t of list) {
      const entry = episodeOrder.get(t.hash.toLowerCase());
      if (t.progress >= 1) { episodeOrder.delete(t.hash.toLowerCase()); changed = true; continue; }
      const files = await qbit(`/api/v2/torrents/files?hash=${t.hash}`).catch(() => []);
      for (const f of files) {
        const id = `${t.hash}:${f.index ?? files.indexOf(f)}`;
        if (f.progress >= 1 && f.priority !== 0 && isVideo(f.name) && !finishedEpisodeFiles.has(id)) {
          finishedEpisodeFiles.add(id);
          converter.convertSoon(); // a finished episode becomes an MP4 while the next one downloads
          invalidateLibrary();
        }
      }
      const hashKey = t.hash.toLowerCase();
      if (/^(stalledDL|metaDL|forcedMetaDL)$/.test(t.state || '')) lastStalled.set(hashKey, Date.now());
      const wasStalled = Date.now() - (lastStalled.get(hashKey) || 0) < STALL_MEMORY;
      const group = `${entry.key}|${entry.season}`;
      if (!groups.has(group)) groups.set(group, { season: entry.season, ctx: anime.contextForTitle(entry.key), torrents: [] });
      groups.get(group).torrents.push({ hash: hashKey, name: t.name, state: t.state, progress: t.progress, wasStalled,
        files: files.map((f, i) => ({ index: f.index ?? i, name: f.name, progress: f.progress, priority: f.priority })) });
    }
    if (finishedEpisodeFiles.size > 5000) finishedEpisodeFiles.clear();
    for (const hash of lastStalled.keys()) if (!episodeOrder.has(hash)) lastStalled.delete(hash);
    const held = new Set([...episodeOrder].filter(([, e]) => e.held).map(([hash]) => hash));
    for (const group of groups.values()) {
      const plan = planEpisodeOrder(group, held);
      // Someone is watching this one with Play now: it keeps its own order until they stop.
      const watching = partialStreams.activeHashes();
      plan.priorities = plan.priorities.filter(({ hash }) => !watching.has(hash));
      plan.stop = plan.stop.filter((hash) => !watching.has(hash));
      for (const { hash, ids, priority } of plan.priorities) {
        await qbitRequest('/api/v2/torrents/filePrio', { method: 'POST', body: new URLSearchParams({ hash, id: ids.join('|'), priority: String(priority) }) });
        torrentFilesCache.delete(hash);
      }
      for (const hash of plan.stop) { await setPaused(hash, true); episodeOrder.get(hash).held = true; changed = true; }
      for (const hash of plan.start) { await setPaused(hash, false); episodeOrder.get(hash).held = false; changed = true; }
      if (plan.stop.length || plan.start.length) torrentInventory.at = 0;
    }
    if (changed) saveEpisodeOrder();
  } catch (e) {
    console.warn(`[order] ${e.message}`);
  } finally { orderBusy = false; }
}
setInterval(() => episodeOrderRound(), 5000).unref();

// ---- content filter (content-filter.js) ----
// Logged in the activity feed (the owner sees it under What happened) and the server log.
function contentBlocked(user, title, found) {
  console.warn(`[content-filter] blocked ${user?.email || 'a download'}: ${title} (${found.reason}${found.name && found.name !== title ? ` in ${found.name}` : ''})`);
  activity.record(SYSTEM, 'blocked', `${String(title || 'a torrent').slice(0, 200)} (adult content)`, { user: user?.email || 'Marquee' });
}
// Marquee's downloads are checked once their name and file list are known (a magnet's files arrive
// with its metadata, a few seconds after it's added). Adult ones are removed with their files.
// Downloads that finished before this server started are only reported, never deleted.
const contentChecked = new Set();
const contentGuardSince = Math.floor(Date.now() / 1000);
let contentGuardBusy = false;
async function contentGuardRound() {
  if (!QBIT_URL || filterMode() === 'off' || contentGuardBusy) return;
  contentGuardBusy = true;
  try {
    const list = await qbit('/api/v2/torrents/info');
    const present = new Set();
    for (const t of list) {
      const hash = t.hash.toLowerCase();
      present.add(hash);
      if (contentChecked.has(hash) || deletingDownloads.has(hash)) continue;
      const ownerId = accounts.torrentRow(hash)?.user_id ?? accounts.userFromTags(t.tags);
      // Not added through Marquee, or its owner isn't filtered: left alone.
      if (ownerId == null || !filterApplies(accounts.userById(ownerId))) { contentChecked.add(hash); continue; }
      let found = firstAdult([t.name]);
      if (!found) {
        const files = await torrentFileMetadata(t, { fresh: true }).catch(() => null);
        if (!files?.length) continue; // no metadata yet: next round
        found = firstAdult(files.map((f) => f.name));
      }
      contentChecked.add(hash);
      if (!found) continue;
      const who = accounts.userById(ownerId);
      if (Number(t.added_on) < contentGuardSince && t.progress >= 1) {
        console.warn(`[content-filter] ${t.name} looks like adult content (${found.reason}) but finished before this check started: left alone`);
        continue;
      }
      await removeBlockedDownload(t, who, found).catch((e) => {
        contentChecked.delete(hash); // try again next round
        console.warn(`[content-filter] couldn’t remove ${t.name}: ${e.message}`);
      });
    }
    for (const hash of contentChecked) if (!present.has(hash)) contentChecked.delete(hash);
  } catch { /* qBittorrent down: next round */ }
  finally { contentGuardBusy = false; }
}
async function removeBlockedDownload(t, user, found) {
  const hash = t.hash.toLowerCase();
  deletingDownloads.add(hash);
  try {
    releaseEpisodeOrder(t.hash);
    await qbitRequest('/api/v2/torrents/delete', {
      method: 'POST', body: new URLSearchParams({ hashes: t.hash, deleteFiles: 'true' }),
    });
  } finally { deletingDownloads.delete(hash); }
  torrentFilesCache.delete(t.hash);
  recentlyAddedDownloads.delete(hash);
  torrentInventory.at = 0;
  invalidateLibrary();
  if (t.content_path) setTimeout(() => { removeEmptyFolders(path.dirname(t.content_path)); invalidateLibrary(); }, 4000);
  contentBlocked(user, t.name, found);
}
setInterval(() => contentGuardRound(), 3000).unref();

async function readRaw(req, limit, tooLarge = 'That file is too large for a .torrent.') {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, tooLarge);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const validHash = (h) => /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(h);

// Who a torrent is for: recorded when it was added through Marquee, or its marquee-u<id> tag.
// Torrents added straight in qBittorrent belong to the owner.
const torrentOwner = (t) => accounts.torrentRow(t.hash)?.user_id ?? accounts.userFromTags(t.tags) ?? accounts.ownerUser()?.id ?? null;

// The user's own downloads; `all` (the owner only) lists everyone's, with whose each one is.
// An SVT Play copy in the shape of a torrent, so every client's download views just show it.
function svtDownloadView(job, user, all) {
  const mates = accounts.libraryMates(user.id);
  const mine = job.requesters.some((id) => mates.includes(id));
  if (!mine && !all) return null;
  const size = expectedSize(job);
  return {
    source: 'svt', hash: job.hash, svtPath: job.path, batchDone: job.batchDone || 0,
    mediaType: job.kind === 'series' ? 'tv' : 'movie', tmdbId: job.tmdbId || null, canonicalTitle: job.title,
    showKey: job.showKey || null, showId: job.showId || null, poster: job.poster || null, backdrop: job.backdrop || null,
    added: job.added, ready: false, hasVideo: true, files: [],
    episodes: job.kind === 'series' ? [{ season: job.season, episode: job.episode, progress: job.progress, available: false, libraryId: null }] : [],
    libraryIds: [], owner: all ? accounts.userById(job.requesters[0])?.name || null : undefined,
    mine, canManage: user.isOwner || mine, name: job.name, title: job.title, year: job.year || null,
    season: job.season ?? null, episode: job.episode ?? null,
    progress: job.progress, speed: job.speed || 0,
    eta: job.speed > 0 && size ? Math.max(0, Math.round((size - job.bytes) / job.speed)) : null,
    seeds: null, swarmSeeds: null, size,
    state: job.state, transferComplete: false, done: false, converting: false, subs: [], error: job.error || null,
  };
}

async function listDownloads(user, all = false) {
  const copies = (svtQueue?.list() || []).map((job) => svtDownloadView(job, user, all)).filter(Boolean);
  // A server without qBittorrent can still have SVT Play copies under way.
  const torrents = await qbit('/api/v2/torrents/info?sort=added_on&reverse=true').catch((e) => { if (copies.length) return []; throw e; });
  // The browser polls this every few seconds. Claim completed files before returning so the
  // next library refresh doesn't wait for the minute-long maintenance round.
  await claimCompletedTorrents(torrents);
  const names = new Map();
  const nameOf = (id) => {
    if (!names.has(id)) names.set(id, id == null ? null : accounts.userById(id)?.name || null);
    return names.get(id);
  };
  const mates = accounts.libraryMates(user.id); // a shared library shows the group's downloads too
  const owned = torrents.map((t) => [t, torrentOwner(t), accounts.torrentRequesters(t.hash).some((id) => mates.includes(id))])
    .filter(([, owner, requested]) => all || mates.includes(owner) || requested);
  await scanLibrary();
  const library = new Map((libraryCache.items || []).map((i) => [accounts.mediaKey(i.full), i]));
  const mine = accounts.libraryOf(user.id);
  const transfers = await Promise.all(owned.map(async ([t, owner, requested]) => {
    let files = [], filesKnown = false;
    try { files = await torrentFileMetadata(t); filesKnown = true; } catch { /* Keep the download visible while qBittorrent refreshes metadata. */ }
    const videos = files.filter((f) => f.priority !== 0 && isVideo(f.name));
    let parsed = torrentIdentity(t.name);
    if (parsed.season == null && videos.length) {
      const first = parseName(path.basename(videos[0].name), { file: true });
      if (first.season != null) parsed = { ...parsed, ...first };
    }
    const film = shows.filmDownload(t.hash), show = shows.showDownload(t.hash);
    const cachedShow = shows.knownShow(parsed.title, parsed.year), cachedFilm = shows.knownFilm(null, parsed.title, parsed.year);
    const mediaType = film ? 'movie' : show || parsed.season != null || cachedShow ? 'tv' : cachedFilm?.id || parsed.year ? 'movie' : null;
    const art = film ? mapTitle(film, 'movie') : show ? mapTitle(show, 'tv') : mediaType === 'tv' ? cachedShow : cachedFilm;
    const tmdbId = film?.id || show?.id || art?.id || null;
    const canonicalTitle = art?.title || parsed.title;
    const showKey = mediaType === 'tv' ? shows.showKey(canonicalTitle) : null;
    const safeFiles = await Promise.all(videos.map(async (f) => {
      let full = null;
      try { full = torrentFilePath(t, f); } catch { /* Invalid metadata cannot become playable. */ }
      const key = full && accounts.mediaKey(full);
      const item = key && mine.has(key) && library.get(key);
      return { name: path.basename(f.name.replace(/\\/g, '/')), size: f.size || 0, progress: f.progress || 0,
        available: await downloadAvailable(t, f),
        index: f.index ?? files.indexOf(f), mediaKey: key || null,
        libraryId: item?.id || null };
    }));
    const episodes = [];
    const animeCtx = mediaType === 'tv' ? anime.contextForTitle(canonicalTitle) : null;
    for (let i = 0; i < videos.length; i++) {
      // The file's own name first: a batch's folder ("Show - 001 ~ 170") isn't this file's episode.
      const base = safeFiles[i].name;
      const placed = animeCtx && anime.resolve(anime.parseAnimeName(base, { file: true }), animeCtx);
      const fileSeason = parseName(base, { file: true }).season ?? parseName(videos[i].name).season ?? parsed.season;
      const own = season.episodesIn(base, fileSeason);
      const list = placed?.length ? placed : (own.length ? own : season.episodesIn(videos[i].name, fileSeason)).map((episode) => ({ season: fileSeason, episode }));
      for (const { season: s, episode } of list) {
        episodes.push({ season: s, episode, progress: safeFiles[i].progress,
          available: safeFiles[i].available, libraryId: safeFiles[i].libraryId,
          fileIndex: safeFiles[i].index, mediaKey: safeFiles[i].mediaKey });
      }
    }
    const packFiles = files.filter((f) => isVideo(f.name)).length;
    const primary = safeFiles.toSorted((a, b) => b.size - a.size)[0];
    const selected = files.filter((f) => f.priority !== 0);
    const verifiedComplete = t.progress >= 1 && selected.length > 0 && (await Promise.all(selected.map((f) => downloadAvailable(t, f)))).every(Boolean);
    return {
    hash: t.hash,
    mediaType, tmdbId, canonicalTitle, showKey,
    showId: mediaType === 'tv' ? tmdbId ? `tv-${tmdbId}` : `name-${showKey}${parsed.year ? `-${parsed.year}` : ''}` : null,
    poster: art?.poster || null, backdrop: art?.backdrop || null,
    added: t.added_on ? t.added_on * 1000 : accounts.torrentRow(t.hash)?.added_at || null,
    ready: Boolean(primary?.available), hasVideo: filesKnown ? videos.length > 0 : null, files: safeFiles, episodes,
    canPlayNow: PARTIAL_ENABLED && filesKnown && videos.length > 0 && STREAMABLE_TORRENT.test(t.state || ''),
    packFiles, skippedFiles: packFiles - videos.length, dualAudio: isDualAudio(t.name),
    others: accounts.torrentWanters(t.hash).some((id) => id !== user.id),
    libraryIds: [...new Set(safeFiles.map((f) => f.libraryId).filter(Boolean))],
    owner: all ? nameOf(owner) : undefined,
    mine: mates.includes(owner) || requested,
    canManage: user.isOwner || mates.includes(owner),
    name: t.name,
    ...parsed,
    progress: t.progress,
    speed: t.dlspeed,
    eta: t.eta >= 8640000 ? null : t.eta,
    // Seeders this transfer is connected to, and how many the trackers report in the whole swarm (null when unknown).
    seeds: Number.isFinite(t.num_seeds) ? t.num_seeds : null,
    swarmSeeds: Number.isFinite(t.num_complete) && t.num_complete >= 0 ? t.num_complete : null,
    size: t.size,
    // Stopped by Marquee so an earlier episode downloads first: waiting its turn, not paused.
    state: episodeOrder.get(t.hash.toLowerCase())?.held && /^(paused|stopped)/.test(t.state || '') ? 'queuedDL' : t.state,
    transferComplete: t.progress >= 1,
    done: Boolean(verifiedComplete),
    converting: convertingIn(t),
    convertPercent: convertPercentIn(t),
    subs: subtitles.subtitleWants(t.hash),
    };
  }));
  return [...copies, ...transfers];
}

// True while the converter is making the MP4 copy of a video from this download.
function convertingIn(t) {
  const file = converter.convertingFile();
  if (!file || !converter.needsConversion(file) || !t.content_path) return false;
  return samePath(file, t.content_path) || isInside(file, t.content_path);
}

// How far along that MP4 copy is, or null.
function convertPercentOf(file) {
  const job = file && converter.jobFiles().active.find((j) => samePath(j.file, file));
  return job && Number.isFinite(job.slot?.percent) ? job.slot.percent : null;
}
function convertPercentIn(t) {
  if (!convertingIn(t)) return null;
  return convertPercentOf(converter.convertingFile());
}

async function downloadSource(hash) {
  if (!validHash(hash)) throw new HttpError(400, 'Invalid download.');
  const [info] = await qbit(`/api/v2/torrents/info?hashes=${hash}`);
  if (!info) throw new HttpError(404, 'That download no longer exists.');
  const files = await torrentFileMetadata(info, { fresh: true });
  const video = files
    .filter((f) => f.priority !== 0 && isVideo(f.name))
    .sort((a, b) => b.size - a.size)[0];
  if (!video) throw new HttpError(404, 'This download has no playable video file.');
  if (!(video.progress >= 1) || BUSY_STATES.test(info.state || '')) throw new HttpError(409, 'This video hasn’t finished downloading yet.');
  const full = torrentFilePath(info, video);
  if (!fileExists(full)) throw new HttpError(409, 'The downloaded video is missing. Retry the download to check its files.');
  return full;
}
const downloadPath = async (hash) => converter.preferConverted(await downloadSource(hash));

async function sourceFile(kind, id) {
  if (kind === 'lib') return librarySource(String(id));
  if (kind === 'dl') {
    if (!validHash(String(id))) throw new HttpError(400, 'Invalid download.');
    return downloadSource(String(id));
  }
  throw new HttpError(400, 'Unknown media type.');
}
// What a travel copy is made from: the original (all audio tracks), with the subtitles saved beside it
// or beside its MP4 copy.
async function travelSource(kind, id) {
  const source = await sourceFile(kind, id);
  const served = converter.preferConverted(source);
  const langs = [...new Set([...subtitles.localLanguages(source), ...subtitles.localLanguages(served)])];
  const subs = langs.map((lang) => ({ lang, read: () => subtitles.readSubtitle(subtitles.findSidecar(source, lang) ? source : served, lang) }));
  return { source, subs };
}
const travelUrl = (row) => `/api/travel/file/${row.copy_key}/${encodeURIComponent(travelName(row.title, row.quality))}`;
function travelItem(row) {
  const copy = travel.copyState(row.copy_key);
  return { kind: row.kind, id: row.media_id, quality: row.quality, label: TRAVEL_QUALITIES[row.quality]?.label || row.quality,
    title: row.title, requestedAt: row.requested_at, downloadedAt: row.downloaded_at ?? null, duration: row.duration ?? null,
    estimate: estimateBytes(row.duration, row.quality, row.audio), ...copy, url: copy.state === 'ready' ? travelUrl(row) : null };
}
const attachment = (name) => `attachment; filename="${String(name).replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

// ---------- signed stream links ----------
// AirPlay and Chromecast hand the video URL to the TV, which fetches it itself and can't
// sign in to Cloudflare Access. /play/ links carry an expiring signature instead, so only
// that one file can be fetched, and only for a limited time.
const PLAY_LINK_HOURS = 12;
const streamSecret = (() => {
  if (process.env.STREAM_SECRET) return process.env.STREAM_SECRET;
  const file = path.join(DATA_DIR, '.marquee-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(file, secret); } catch { /* links then only last until restart */ }
  return secret;
})();
const signPlay = (kind, id, variant, exp) => crypto.createHmac('sha256', streamSecret)
  .update(`${kind}|${id}|${variant}|${exp}`).digest('base64url').slice(0, 32);

// variant "browser" = the copy with browser-friendly audio (H.264 video if the file is HEVC and an H.264
// copy exists); "browser-hevc" = the same for a browser that plays HEVC, which keeps the HEVC file;
// "tv" = original audio for TVs.
const BROWSER_VARIANTS = ['browser', 'browser-hevc'];
// "phone1080" / "phone720" (+ "-a<stream>" for a chosen audio track): a live, lighter HLS stream made from
// the best file there is (phone-stream.js). The file itself is never changed.
const PHONE_VARIANT = /^phone(1080|720)(?:-a(\d{1,5}))?$/;
const phoneStreams = new PhoneStreams({ dir: path.join(CACHE_DIR, 'phone') });
// Play now: the same live stream, from a video qBittorrent is still downloading (partial-stream.js).
const PARTIAL_ENABLED = !/^(0|off|false|no)$/i.test(process.env.PARTIAL_STREAMS || '') && Boolean(QBIT_URL);
const partialStreams = new PartialStreams({
  qbit,
  post: (endpoint, body) => qbitRequest(endpoint, { method: 'POST', body }).then(() => torrentFilesCache.clear()),
  filePath: (t, f) => torrentFilePath(t, f),
  isVideo: (name) => isVideo(name),
  start: async (hash) => {
    const held = episodeOrder.get(hash);
    if (held?.held) { held.held = false; saveEpisodeOrder(); }
    await setPaused(hash, false);
    torrentInventory.at = 0;
  },
});
const STREAMABLE_TORRENT = /^(?!error$|missingFiles$|checking|moving$|metaDL$|forcedMetaDL$|allocating$)/;
// Play now is for downloads in this person's library: their own, their group's, or ones they asked for too.
async function partialAccess(user, id) {
  if (!PARTIAL_ENABLED) throw new HttpError(404, 'Not found.');
  const parsed = parsePartialId(id);
  if (!parsed) throw new HttpError(400, 'Invalid video.');
  if (partialStreams.finished(id)) return null; // watched to the end of its download; the torrent has gone
  const [t] = await qbit(`/api/v2/torrents/info?hashes=${parsed.hash}`);
  if (!t) throw new HttpError(404, 'That download no longer exists.');
  const mates = accounts.libraryMates(user.id);
  if (!user.isOwner && !mates.includes(torrentOwner(t)) && !accounts.torrentRequesters(t.hash).some((who) => mates.includes(who))) {
    throw new HttpError(403, 'That’s someone else’s download.');
  }
  if (!STREAMABLE_TORRENT.test(t.state || '')) throw new HttpError(409, 'This download can’t be played right now. Try again in a moment.');
  return t;
}
async function streamFile(kind, id, variant) {
  if (kind === 'part') throw new HttpError(409, 'This video hasn’t finished downloading yet.');
  if (PHONE_VARIANT.test(variant)) return streamFile(kind, id, 'browser-hevc');
  const selected = variant.match(/^(browser(?:-hevc)?)-a(\d+)-([a-f0-9]{24})$/);
  if (selected) {
    const base = await streamFile(kind, id, selected[1]);
    const file = converter.selectedAudioPath(base, Number(selected[2]), selected[3]);
    if (!file) throw new HttpError(410, 'This audio selection has expired. Choose the language again.');
    // Keep actively streamed selections out of the cache's stale-file cleanup.
    fs.promises.utimes(file, new Date(), new Date()).catch(() => {});
    return file;
  }
  const browser = BROWSER_VARIANTS.includes(variant);
  const hevc = variant === 'browser-hevc';
  if (kind === 'lib') return browser ? converter.preferConverted(librarySource(id), { browser: true, hevc }) : libraryPath(id);
  if (kind === 'dl') {
    if (!validHash(id)) throw new HttpError(400, 'Invalid download.');
    return browser ? converter.preferConverted(await downloadSource(id), { browser: true, hevc }) : downloadPath(id);
  }
  throw new HttpError(400, 'Unknown media type.');
}

// quality (phones): "auto" = the phone stream when the video is too heavy for a phone (above 1080p or a very
// high bitrate) or its picture won't play in this browser; "1080" / "720" = always; else the file as is.
async function phoneChoice(kind, id, variant, quality) {
  if (!BROWSER_VARIANTS.includes(variant) || !['auto', '1080', '720'].includes(quality)) return variant;
  if (quality !== 'auto') return `phone${quality}`;
  try {
    const info = await probePhone(await streamFile(kind, id, 'browser-hevc'));
    if (isHeavy(info)) return 'phone1080';
    const vid = await converter.probeVideo(await streamFile(kind, id, variant));
    if (vid && !converter.videoBrowserSafe(vid, { hevc: variant === 'browser-hevc' })) return 'phone1080';
  } catch { /* unreadable: the normal link says why */ }
  return variant;
}

async function phoneLink(kind, id, variant, audio, audioSource) {
  const file = await streamFile(kind, id, variant);
  if (!fs.existsSync(file)) throw new HttpError(404, 'That file is no longer on the server.');
  let selection = {};
  if (audio !== null && audio !== undefined) {
    if (!/^\d{1,5}$/.test(String(audio))) throw new HttpError(400, 'Invalid audio selection.');
    if (audioSource !== converter.audioSourceKey(file)) throw new HttpError(409, 'Audio tracks changed. Open Audio and choose the language again.');
    const track = Number(audio);
    if (!(await converter.probeAudio(file))?.some((t) => t.index === track)) throw new HttpError(400, 'That audio track is not available.');
    variant = `${variant.replace(/-a\d+$/, '')}-a${track}`;
    selection = { ready: true, track, audioSource };
  }
  const exp = Math.floor(Date.now() / 1000) + PLAY_LINK_HOURS * 3600;
  return {
    ...selection,
    url: `/play/${kind}/${id}/${variant}/${exp}/${signPlay(kind, id, variant, exp)}/index.m3u8`,
    name: path.basename(file), ext: 'm3u8', quality: PHONE_VARIANT.exec(variant)[1],
  };
}

async function playLink(kind, id, variant, audio = null, audioSource = null, retry = false, quality = null) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, 'Invalid file.');
  if (audio === null && quality) {
    // The player's quality menu names the original's resolution ("made live from the 4K file").
    const link = await playLink(kind, id, await phoneChoice(kind, id, variant, quality), null, null, retry);
    try { link.sourceHeight = (await probePhone(await streamFile(kind, id, 'browser-hevc'))).height || null; } catch { /* unknown */ }
    return link;
  }
  if (PHONE_VARIANT.test(variant)) return phoneLink(kind, id, variant, audio, audioSource);
  if (![...BROWSER_VARIANTS, 'tv'].includes(variant)) throw new HttpError(400, 'Unknown variant.');
  let file = await streamFile(kind, id, variant);
  let selection = {};
  if (audio !== null) {
    if (!BROWSER_VARIANTS.includes(variant) || !/^\d{1,5}$/.test(String(audio))) throw new HttpError(400, 'Invalid audio selection.');
    const track = Number(audio);
    const result = await converter.requestAudioTrack(file, track, audioSource, { retry });
    selection = { ready: result.ready, track, audioSource };
    if (!result.ready) return { ...selection, state: result.state };
    file = result.file;
    variant = `${variant}-a${track}-${audioSource}`;
  }
  if (!fs.existsSync(file)) throw new HttpError(404, 'That file is no longer on the server.');
  const exp = Math.floor(Date.now() / 1000) + PLAY_LINK_HOURS * 3600;
  const name = path.basename(file);
  return {
    ...selection,
    url: `/play/${kind}/${id}/${variant}/${exp}/${signPlay(kind, id, variant, exp)}/${encodeURIComponent(name)}`,
    name,
    ext: path.extname(name).slice(1).toLowerCase(),
    quality: 'original',
  };
}

// Whether this browser can already play a job's video as served right now (so it isn't waiting for the job).
// Same checks as /api/media/.../audio: video codec, default audio codec and audio alignment.
async function browserPlaysNow(job, plays) {
  if (job.kind === 'retire') return true; // the MP4 copy exists; only the original's subtitles are being saved
  const hevc = plays.has('hevc');
  const served = converter.preferConverted(job.file, { browser: true, hevc });
  if (converter.needsConversion(served)) return false; // no MP4 copy yet: Play waits for it
  try {
    const [tracks, vid] = await Promise.all([converter.probeAudio(served), converter.probeVideo(served)]);
    const main = tracks?.[0]?.codec;
    return converter.videoBrowserSafe(vid, { hevc }) && converter.isAligned(tracks)
      && (!main || converter.BROWSER_AUDIO.has(main) || plays.has(main));
  } catch { return false; }
}

// The conversion banner for one person: only videos in their library, and only jobs their browser is
// actually waiting for. A browser that already plays a file never sees its background copies.
const CONVERT_QUEUE_CHECK = 30;
async function convertStatusFor(user, plays) {
  const all = converter.converterStatus();
  const jobs = converter.jobFiles();
  const mine = user ? accounts.libraryOf(user.id) : new Map();
  const inLibrary = (file) => { const key = file && accounts.mediaKey(file); return Boolean(key && mine.has(key)); };
  const waiting = async (job) => inLibrary(job.file) && !(await browserPlaysNow(job, plays));
  const active = [];
  for (const job of jobs.active) if (await waiting(job)) active.push(job.slot);
  let queued = 0;
  for (const job of jobs.queued.slice(0, CONVERT_QUEUE_CHECK)) if (await waiting(job)) queued += 1;
  return {
    enabled: all.enabled, reason: all.reason, encoder: all.encoder, done: all.done, lowSpace: all.lowSpace,
    active, current: active[0] || null, queued,
    recentFailures: jobs.failures.filter((f) => inLibrary(f.file)).map(({ name, error }) => ({ name, error })),
  };
}

// The file a signed /play/ path names, once its signature checks out (expiry is the caller's business).
function verifiedPlayPath(pathname) {
  const m = pathname.match(/^\/play\/(lib|dl|part)\/([A-Za-z0-9_-]+)\/(browser(?:-hevc)?(?:-a\d+-[a-f0-9]{24})?|tv|phone(?:1080|720)(?:-a\d{1,5})?)\/(\d+)\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/);
  if (!m) throw new HttpError(404, 'Not found.');
  const [, kind, id, variant, exp, sig] = m;
  const expected = signPlay(kind, id, variant, exp);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new HttpError(403, 'Invalid link.');
  }
  return { kind, id, variant, exp: Number(exp) };
}

async function handlePlay(req, res, url) {
  const { kind, id, variant, exp } = verifiedPlayPath(url.pathname);
  if (exp < Date.now() / 1000) throw new HttpError(410, 'This link has expired. Start playback again.');
  if (kind === 'part') {
    if (!PHONE_VARIANT.test(variant)) throw new HttpError(404, 'Not found.');
    return sendPartialPiece(req, res, url, { id, variant });
  }
  if (PHONE_VARIANT.test(variant)) return sendPhonePiece(req, res, url, { kind, id, variant });
  // Library files name their stream for House → Sharing (cheap); downloads keep the file's own name.
  return sendVideo(req, res, await streamFile(kind, id, variant), { label: kind === 'lib' ? streamLabel(librarySource(id)) : null });
}

// The phone stream's playlist (index.m3u8) or one of its 4-second pieces (s00012.ts). One session per
// play link: the signature is its key.
async function sendPhonePiece(req, res, url, { kind, id, variant }) {
  const parts = url.pathname.split('/');
  const name = parts.pop();
  const sig = parts.pop();
  const [, quality, audio] = PHONE_VARIANT.exec(variant);
  const file = await streamFile(kind, id, variant);
  const label = `${kind === 'lib' ? streamLabel(librarySource(id)) : streamLabel(file)} · ${quality}p`;
  let session;
  try { session = await phoneStreams.open(sig, { file, quality, audioIndex: audio == null ? null : Number(audio), label }); }
  catch (e) { throw new HttpError(e.status || 500, e.message); }
  converter.noteServed(file); // keep a cached copy being streamed out of the cache cleanup
  const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (name === 'index.m3u8') {
    const body = phoneStreams.playlist(session);
    res.writeHead(200, { ...headers, 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(body) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const n = segmentIndex(name);
  if (n == null) throw new HttpError(404, 'Not found.');
  let piece;
  try { piece = await phoneStreams.segment(session, n); }
  catch (e) { throw new HttpError(e.status || 500, e.message); }
  const size = (await fs.promises.stat(piece)).size;
  res.writeHead(200, { ...headers, 'Content-Type': 'video/mp2t', 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  // One stream per session in House → Sharing (keyed by its folder, which has no bitrate of its own).
  const meter = trackStream(req, session.dir, size, label);
  const read = fs.createReadStream(piece, { highWaterMark: STREAM_READ_BYTES });
  read.on('data', (chunk) => meter.add(chunk.length));
  pipeline(read, res, () => meter.done());
}

// Play now: the same playlist and pieces, from a video still downloading. A piece the download hasn't reached
// yet can take minutes, and proxies give up on a silent response, so after a while the response starts with
// MPEG-TS null packets (which players skip) to show it is still coming.
const NULL_TS_PACKET = (() => { const b = Buffer.alloc(188, 0xff); b[0] = 0x47; b[1] = 0x1f; b[2] = 0xff; b[3] = 0x10; return b; })();
const PIECE_HOLD_MS = 20_000;
const PIECE_BEAT_MS = 15_000;
async function sendPartialPiece(req, res, url, { id, variant }) {
  const name = url.pathname.split('/').pop();
  const [, quality] = PHONE_VARIANT.exec(variant);
  const sig = url.pathname.split('/').at(-2);
  let opened;
  try { opened = await partialStreams.open(id); }
  catch (e) { throw new HttpError(e.status || 500, e.message); }
  const entry = opened.entry;
  if (!entry.info) throw new HttpError(503, 'This video is still starting.');
  const input = await partialStreams.inputUrl(entry);
  const label = `${streamLabel(entry.file)} · ${quality}p`;
  const session = await phoneStreams.open(sig, { file: input, info: entry.info, quality, label });
  const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (name === 'index.m3u8') {
    const body = phoneStreams.playlist(session);
    res.writeHead(200, { ...headers, 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(body) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const n = segmentIndex(name);
  if (n == null) throw new HttpError(404, 'Not found.');
  const stop = new AbortController();
  res.once('close', () => stop.abort());
  const making = phoneStreams.segment(session, n, { patient: true, signal: stop.signal });
  making.catch(() => {});
  let held = false;
  let piece = await Promise.race([making, new Promise((resolve) => { held = setTimeout(() => resolve(null), PIECE_HOLD_MS); })]).catch((e) => { throw new HttpError(e.status || 500, e.message); });
  clearTimeout(held);
  const size = piece ? (await fs.promises.stat(piece)).size : null;
  if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Type': 'video/mp2t' }); return res.end(); }
  if (piece) res.writeHead(200, { ...headers, 'Content-Type': 'video/mp2t', 'Content-Length': size });
  else {
    res.writeHead(200, { ...headers, 'Content-Type': 'video/mp2t' });
    res.write(NULL_TS_PACKET);
    const beat = setInterval(() => res.write(NULL_TS_PACKET), PIECE_BEAT_MS);
    try { piece = await making; }
    catch { return res.destroy(); }
    finally { clearInterval(beat); }
  }
  const meter = trackStream(req, session.dir, size ?? (await fs.promises.stat(piece)).size, label);
  const read = fs.createReadStream(piece, { highWaterMark: STREAM_READ_BYTES });
  read.on('data', (chunk) => meter.add(chunk.length));
  pipeline(read, res, () => meter.done());
}

// Stats for nerds: what ffprobe says about the exact file the player streams (its src path), and
// about the original release when the player gets a browser copy of it.
async function streamInfo(req, src) {
  let file;
  let served = translate('Original file');
  let original = null;
  let expires = null;
  let m;
  if (src.startsWith('/play/')) {
    const link = verifiedPlayPath(src);
    if (link.kind === 'part') return { known: false, reason: 'This video is still downloading.' };
    expires = link.exp * 1000;
    file = await streamFile(link.kind, link.id, link.variant);
    const source = await sourceFile(link.kind, link.id);
    const first = converter.originalFor(source) || source;
    const selected = link.variant.match(/^browser-a(\d+)-/);
    const phone = PHONE_VARIANT.exec(link.variant);
    served = phone ? translate(`Phone quality: ${phone[1]}p H.264, made live from this file`)
      : link.variant === 'tv' ? 'TV version (original audio)'
      : selected ? `Single-audio copy (audio track ${Number(selected[1])})`
        : translate(file === first ? 'Original file' : 'Browser copy');
    if (first !== file && fs.existsSync(first)) original = first;
  } else if ((m = src.match(/^\/api\/clips\/([\w-]{16})\/video$/))) {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can see clips.');
    file = await clips.clipFile(m[1]);
    served = 'Clip file';
  } else return { known: false, reason: 'No file details for this kind of video.' };
  if (!fs.existsSync(file)) throw new HttpError(404, 'That file is no longer on the server.');
  const describe = async (f) => {
    const started = Date.now();
    const info = await converter.probeDetails(f).catch(() => null);
    return info && { name: path.basename(f), modified: fs.statSync(f).mtimeMs, probeMs: Date.now() - started, ...info };
  };
  const [playing, originalInfo] = await Promise.all([describe(file), original ? describe(original).catch(() => null) : null]);
  if (!playing) return { known: false, reason: 'ffprobe couldn’t read this file on the server.' };
  return { known: true, served, expires, file: playing, original: originalInfo };
}

// Title, year and episode used for subtitle searches.
const infoFor = (file) => {
  const parsed = parseFile(file);
  const film = parsed.season == null ? shows.knownFilm(accounts.mediaKey(file), parsed.title, parsed.year) : null;
  return { ...parsed, tmdbId: film?.id || null, hashFile: converter.originalFor(file) || file };
};

// ---------- streaming (HTTP range requests) ----------
// Media is read in large pieces (STREAM_READ_KB, 4 MB by default). With Node's default 64 KB, a stream
// on a hard drive that is also busy with a download or a conversion waits in the drive's queue for
// every 64 KB; measured on a busy HDD, a 4 MB range took 0.6-2.9 s that way and 11-45 ms in one read.
const STREAM_READ_BYTES = Math.min(64 * 1024, Math.max(64, Number(process.env.STREAM_READ_KB) || 4096)) * 1024;
// What House → Sharing calls a stream: "House S02 E06", "Clip · dust2 ace".
const CLIPS_ROOT = process.env.CLIPS_DIR ? path.resolve(process.env.CLIPS_DIR) : null;
function streamLabel(file) {
  if (CLIPS_ROOT && file.startsWith(CLIPS_ROOT + path.sep)) return `Clip · ${path.basename(file).replace(/\.[a-z0-9]{2,4}$/i, '')}`;
  const info = parseFile(file);
  const ep = info.season != null ? ` S${String(info.season).padStart(2, '0')} E${String(info.episode).padStart(2, '0')}` : '';
  return `${info.title}${info.year && !ep ? ` (${info.year})` : ''}${ep}`;
}
// The TV a cast is being served to, from the cast session that holds this file's link.
function tvFor(req) {
  const m = /^\/(?:api\/stream|play)\/(lib|dl)\/([A-Za-z0-9_-]+)(?:\/([\w-]+))?/.exec(req.url || '');
  if (!m || /[?&]browser\b/.test(req.url) || (req.url.startsWith('/play/') && m[3] !== 'tv')) return null;
  const s = cast.listSessions().find((x) => x.media?.ref?.kind === m[1] && x.media?.ref?.id === m[2]);
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  return s?.deviceName || house.hostForIp(ip) || `TV at ${ip}`;
}
function trackStream(req, file, size, label) {
  const email = String(req.headers['cf-access-authenticated-user-email'] || '').trim().toLowerCase();
  return load.trackStream(req, {
    file, size, label: label || streamLabel(file),
    who: email ? accounts.displayNameFor(email) : null,
    tv: req.headers['cf-ray'] ? null : tvFor(req),
    fromHome: req.headers['cf-ray'] ? isHomeRequest(req) : null,
  });
}

async function sendVideo(req, res, file, { captionUrl, headers = {}, label = null } = {}) {
  let stat;
  try { stat = await fs.promises.stat(file); } catch { throw new HttpError(404, 'That file is no longer on the server.'); }
  converter.noteServed(file); // cached browser copies watched recently are kept when room is needed
  const size = stat.size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    // Required by DLNA renderers.
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
    ...headers,
  };
  if (captionUrl) base['CaptionInfo.sec'] = captionUrl; // Samsung subtitle header

  let start = 0;
  let end = size - 1;
  let status = 200;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && m[1] === '' && m[2] !== '') {
      start = Math.max(size - Number(m[2]), 0);
    } else if (m && m[1] !== '') {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (!m || start >= size || start > end) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    base['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }

  res.writeHead(status, { ...base, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  const meter = trackStream(req, file, size, label);
  const read = fs.createReadStream(file, { start, end, highWaterMark: STREAM_READ_BYTES });
  read.on('data', (chunk) => meter.add(chunk.length));
  pipeline(read, res, () => meter.done()); // aborted by seeks; safe to ignore
}

// ---------- casting ----------
// Each browser sends a random ID (X-Marquee-Client), so the remote and "now playing" bar only show the
// TVs that browser started. Pages loaded before this existed send no ID; they're told apart by their
// Cloudflare Access login and address instead. Anyone can still pick any TV from the TV list.
const castOwners = new Map(); // deviceId -> who started what's playing
function clientOf(req) {
  const id = String(req.headers['x-marquee-client'] || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (id) return id;
  const who = req.headers['cf-access-authenticated-user-email'] || '';
  const where = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
  return `anon:${who}|${where}`;
}
const isMine = (req, deviceId) => castOwners.get(deviceId) === clientOf(req);
// The exact file each cast started with. An MP4 or audio-fixed copy can finish mid-playback, and
// switching files under a TV's range requests (different size and layout) breaks playback.
const castFiles = new Map(); // "kind:id" -> file
const castFile = (kind, id) => {
  const file = castFiles.get(`${kind}:${id}`);
  return file && fs.existsSync(file) ? file : null;
};
async function resolveMedia(kind, id, subLang = null) {
  const file = converter.preferConverted(await sourceFile(kind, id));
  let stat;
  try { stat = await fs.promises.stat(file); } catch { throw new HttpError(404, 'That file is no longer on the server.'); }
  castFiles.set(`${kind}:${id}`, file);
  const name = path.basename(file);
  const ext = path.extname(name).slice(1).toLowerCase();
  const info = parseName(name);
  const episode = info.season != null ? `S${String(info.season).padStart(2, '0')} E${String(info.episode).padStart(2, '0')}` : null;
  let subUrl = null;
  if (subLang) {
    const srt = await subtitles.ensureSubtitle(file, infoFor(file), subLang);
    subsync.ensureSync(srt, file);
    subUrl = `http://${LAN_IP}:${PORT}/api/subs/file/${kind}/${id}/${subLang}.srt`;
  }
  return {
    // Some TVs infer the format from the file name at the end of the URL.
    url: `http://${LAN_IP}:${PORT}/api/stream/${kind}/${id}/${subLang ? `sub-${subLang}/` : ''}${encodeURIComponent(name)}`,
    subUrl,
    subLang,
    title: info.title,
    subtitle: episode || (info.year ? String(info.year) : ''),
    mime: MIME[`.${ext}`] || 'video/mp4',
    size: stat.size,
    ext,
    ref: { kind, id: String(id) },
  };
}

const NOTES_JSON_MAX_BYTES = 6 * 1024 * 1024; // 1M-char notes plus UTF-8/JSON overhead; other APIs keep the 100 KB default.
async function readJson(req, maxBytes = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, 'Request too large.');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

// ---------- API routes ----------
// "Dune (2021)", "Severance S02 E03": how a file is named in the activity log.
// Episodes are converted to MP4 keeping their HEVC video (fast, full quality, plays on TVs, iPhones,
// Safari and Chrome). A browser without HEVC (Firefox, Zen) needs an H.264 copy, which takes a minute
// or two per episode. When one episode needs it, the next NEXT_EPISODES of the show get theirs made in
// the background, so the next episode starts right away.
const NEXT_EPISODES = Math.max(0, Number(process.env.PREPARE_NEXT_EPISODES ?? 2) || 0);
async function prepareNextEpisodes(source, plays) {
  if (!NEXT_EPISODES) return;
  const items = await scanLibrary();
  const all = libraryCache.all || items || [];
  const here = all.find((i) => samePath(i.full, source)) || items.find((i) => samePath(converter.preferConverted(i.full), source));
  if (!here || here.season == null) return;
  const key = shows.showKey(here.title);
  const order = (i) => i.season * 10000 + i.episode;
  const seen = new Set();
  const next = items
    .filter((i) => i.season != null && shows.showKey(i.title) === key && order(i) > order(here))
    .sort((a, b) => order(a) - order(b))
    .filter((i) => !seen.has(order(i)) && seen.add(order(i))) // one file per episode
    .slice(0, NEXT_EPISODES);
  for (const i of next) {
    const served = converter.preferConverted(i.full);
    const v = await converter.probeVideo(served).catch(() => null);
    if (v && !converter.videoBrowserSafe(v, { hevc: plays.has('hevc') }) && converter.queueBrowserVideo(i.full)) {
      console.log(`[convert] getting the next episode ready for this browser: ${path.basename(served)}`);
    }
  }
}

// Other episodes of the same show and season, nearest first (the next one before the previous one),
// one file per episode, as originals; plus the next episode's file.
async function creditPeers(file) {
  const items = await scanLibrary();
  const all = libraryCache.all || items || [];
  const here = all.find((i) => samePath(i.full, file));
  if (!here || here.season == null || here.episode == null) return { siblings: [] };
  const key = shows.showKey(here.title);
  const rank = (i) => Math.abs(i.episode - here.episode) * 2 + (i.episode < here.episode ? 1 : 0);
  const seen = new Set([here.episode]);
  const siblings = all
    .filter((i) => i.season === here.season && i.episode != null && shows.showKey(i.title) === key)
    .map((i) => ({ episode: i.episode, full: converter.originalFor(i.full) || i.full }))
    .sort((a, b) => rank(a) - rank(b) || a.full.localeCompare(b.full))
    .filter((i) => !seen.has(i.episode) && seen.add(i.episode));
  return { siblings: siblings.slice(0, 2).map((i) => i.full), next: siblings.find((i) => i.episode === here.episode + 1)?.full };
}

// Skip intro and Up next for a whole season, worked out when its episodes arrive. Otherwise the first
// play has to compare the audio itself, and the button can turn up after the intro has passed. One
// decode at a time, so someone pressing play waits for the one in progress at most, and with longer
// pauses while anyone is watching. Saved, so a restart carries on where it was.
const PREP_FILE = path.join(DATA_DIR, '.marquee-prep-seasons.json');
const seasonsToPrep = new Map((() => { try { return JSON.parse(fs.readFileSync(PREP_FILE, 'utf8')); } catch { return []; } })());
const savePrepSeasons = () => { try { fs.writeFileSync(PREP_FILE, JSON.stringify([...seasonsToPrep])); } catch (e) { console.warn(`[prep] ${e.message}`); } };
let prepRunning = false;
const PREP_DELAY = 30e3; // episodes of a pack land in a burst
function startSeasonPrep() {
  if (prepRunning || !seasonsToPrep.size) return;
  prepRunning = true;
  setTimeout(() => runSeasonPrep().catch((e) => console.warn(`[prep] ${e.message}`)).finally(() => { prepRunning = false; }), PREP_DELAY).unref();
}
function prepSeasonOf(file) {
  const { title, season, episode } = parseFile(file);
  if (season == null || episode == null) return;
  const key = shows.showKey(title);
  seasonsToPrep.set(`${key}|${season}`, { key, season });
  savePrepSeasons();
  startSeasonPrep();
}
async function runSeasonPrep() {
  for (let next; (next = seasonsToPrep.entries().next().value);) {
    const [id, job] = next;
    try { await prepSeason(job); } catch (e) { console.warn(`[prep] ${e.message}`); }
    if (seasonsToPrep.get(id) === job) { seasonsToPrep.delete(id); savePrepSeasons(); } // more arrived meanwhile: goes again
  }
}
async function prepSeason({ key, season }) {
  await scanLibrary();
  const files = new Set((libraryCache.all || [])
    .filter((i) => i.season === season && i.episode != null && shows.showKey(i.title) === key)
    .sort((a, b) => a.episode - b.episode)
    .map((i) => converter.originalFor(i.full) || i.full));
  for (const file of files) {
    const { siblings } = await creditPeers(file);
    await introFor(file, siblings);
    await creditsFor(file, siblings);
    await new Promise((resolve) => { setTimeout(resolve, load.watching() ? 15e3 : 1e3); });
  }
  if (files.size) console.log(`[prep] Skip intro and Up next ready for ${files.size} files of ${key} season ${season}`);
}
setTimeout(startSeasonPrep, 60e3).unref();

function titleOf(file) {
  const info = parseFile(file); // a full path: "Show/Season 1/S01E05.mkv" takes the show's folder name
  const ep = info.season != null ? ` S${String(info.season).padStart(2, '0')} E${String(info.episode).padStart(2, '0')}` : '';
  return `${info.title}${info.year && !ep ? ` (${info.year})` : ''}${ep}`;
}

// Notifications for files that just landed in people's libraries: "ready to watch" for the people who
// downloaded them, and "new episode" for others who have that show in their library.
const watchInvitesSent = new Map(); // room|person -> when they were last invited
const pushTestsSent = new Map();
let agentPushes = []; // times of recent agent notifications (rate limit)
const announcedEpisodes = new Set(); // media keys already announced as new episodes since startup
setInterval(() => { for (const [k, at] of watchInvitesSent) if (Date.now() - at > 120000) watchInvitesSent.delete(k); }, 600000).unref();
const pushTitle = (title) => shows.knownShow(title, null)?.title || title;
function announceArrivals(hash, arrived, claimants) {
  const follows = new Map(); // person -> show keys they follow (Follow, watchlist.js)
  for (const r of watchlist.followers()) {
    if (!follows.has(r.user_id)) follows.set(r.user_id, new Set());
    follows.get(r.user_id).add(shows.showKey(r.title));
  }
  for (const [userId, files] of arrived) {
    const infos = files.map(parseFile);
    const shown = new Set(infos.map((i) => (i.season != null ? shows.showKey(i.title) : `film:${i.title}`)));
    // A followed show's episodes that downloaded by themselves count as new episodes.
    if (shown.size === 1 && infos[0].season != null && follows.get(userId)?.has([...shown][0])) {
      const name = pushTitle(infos[0].title);
      notify([userId], 'episode', { title: files.length === 1 ? `New episode of ${name}` : `${files.length} new episodes of ${name}`,
        body: files.length === 1 ? `${titleOf(files[0])} is in your library. Tap to watch.` : 'They’re in your library. Tap to watch.', url: '/#library', tag: `download-${hash.toLowerCase()}` });
      continue;
    }
    let title;
    if (files.length === 1) title = `${titleOf(files[0])} is ready`;
    else if (shown.size === 1 && infos[0].season != null) title = `${files.length} episodes of ${pushTitle(infos[0].title)} are ready`;
    else title = `${files.length} videos are ready`;
    notify([userId], 'download', { title, body: files.length === 1 ? 'It’s in your library. Tap to watch.' : 'They’re in your library. Tap to watch.',
      url: '/#library', tag: `download-${hash.toLowerCase()}` });
  }
  // New episodes: everyone else with an episode of the show in their library hears once per episode.
  // Following alone isn't enough: a show that isn't in your library stays quiet until it lands there.
  const episodes = [...new Set([...arrived.values()].flat())].map((full) => ({ key: accounts.mediaKey(full), info: parseFile(full) }))
    .filter((e) => e.key && e.info.season != null && !announcedEpisodes.has(e.key));
  if (!episodes.length) return;
  const showsOf = new Map(); // person -> show keys in their library
  for (const r of accounts.libraryRows()) {
    const info = parseFile(path.join(MEDIA_DIR, `${r.media_key}.mkv`));
    if (info.season == null) continue;
    if (!showsOf.has(r.user_id)) showsOf.set(r.user_id, new Set());
    showsOf.get(r.user_id).add(shows.showKey(info.title));
  }
  const skip = new Set(claimants);
  const byShow = new Map();
  if (announcedEpisodes.size > 5000) announcedEpisodes.clear();
  for (const e of episodes) {
    announcedEpisodes.add(e.key);
    const k = shows.showKey(e.info.title);
    byShow.set(k, [...(byShow.get(k) || []), e]);
  }
  const label = (i) => `S${String(i.season).padStart(2, '0')} E${String(i.episode).padStart(2, '0')}`;
  for (const [k, eps] of byShow) {
    const people = [...showsOf].filter(([id, set]) => !skip.has(id) && set.has(k)).map(([id]) => id);
    if (!people.length) continue;
    eps.sort((a, b) => a.info.season - b.info.season || a.info.episode - b.info.episode);
    const name = pushTitle(eps[0].info.title);
    notify(people, 'episode', {
      title: eps.length === 1 ? `New episode of ${name}` : `${eps.length} new episodes of ${name}`,
      body: eps.length === 1 ? `${label(eps[0].info)} just arrived on Marquee. Find it on the show’s page to add it to your library.`
        : `${label(eps[0].info)} to ${label(eps.at(-1).info)} just arrived on Marquee. Find them on the show’s page to add them to your library.`,
      url: '/', tag: `episode-${k}`.slice(0, 64),
    });
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  let m;
  if (p.startsWith('/api/auth/')) return handleAuth(req, res, p);

  // House reports from the laptop/desktop (token + home network only; see house.js). Handled before
  // activity.seen() so the machines don't show up as people in the Activity tab.
  if (p === '/api/house/report') {
    if (!house.agentAllowed(req)) throw new HttpError(403, 'Not allowed.');
    house.acceptReport(req, await readJson(req));
    return sendJson(res, 200, { ok: true });
  }
  // An agent on one of the home machines (a script, Claude, Codex) asking the owner for attention: one push to the
  // owner's devices. Same gate as House reports (HOUSE_TOKEN, straight from the home network); max 1 per 20 s, 30 a day.
  if (p === '/api/agent/notify' && req.method === 'POST') {
    if (!house.agentAllowed(req)) throw new HttpError(403, 'Not allowed.');
    const body = await readJson(req);
    const title = String(body.title || '').trim().slice(0, 60);
    if (!title) throw new HttpError(400, 'A title is needed.');
    const owner = accounts.ownerUser();
    if (!owner || !push.hasDevice(owner.id)) return sendJson(res, 200, { sent: 0, reason: 'The owner has no device with notifications on.' });
    const now = Date.now();
    agentPushes = agentPushes.filter((t) => now - t < 86400000);
    if (agentPushes.length >= 30 || now - (agentPushes.at(-1) || 0) < 20000) throw new HttpError(429, 'Too many agent notifications; try again later.');
    agentPushes.push(now);
    const url = typeof body.url === 'string' && /^\/(?![\/\\])/.test(body.url) ? body.url.slice(0, 200) : '/';
    const sent = await notify([owner.id], 'agent', { title, body: String(body.body || '').trim().slice(0, 200), url });
    return sendJson(res, 200, { sent });
  }
  if (p === '/api/house/summary') {
    if (!house.agentAllowed(req) && !activity.isAdmin(req)) throw new HttpError(403, 'Not allowed.');
    return sendJson(res, 200, await house.houseSummary());
  }
  // What sharing costs the server right now (load.js): House → Sharing, Archfleet, the machines' panels.
  if (p === '/api/house/load') {
    if (!house.agentAllowed(req) && !activity.isAdmin(req)) throw new HttpError(403, 'Not allowed.');
    return sendJson(res, 200, load.loadReport({ hours: url.searchParams.get('hours') === '24' ? 24 : 1 }));
  }
  // Daily summaries from the screentime daemon on each machine (screentime.js). Its own token, so
  // a laptop can catch up on queued days; handled here so machines don't show up in Activity.
  if (p === '/api/screentime' && req.method === 'POST') {
    if (!screenTime.tokenAllowed(req)) throw new HttpError(screenTime.screenTimeConfigured() ? 403 : 404, screenTime.screenTimeConfigured() ? 'Wrong token.' : 'Set SCREENTIME_TOKEN in .env first.');
    try { return sendJson(res, 200, screenTime.acceptSummary(await readJson(req, 400_000))); } catch (err) {
      if (err.status) throw new HttpError(err.status, err.message);
      throw err;
    }
  }
  // `marquee-house boot` (root, on a dual-boot machine): reports its boot menu + network card and
  // gets back whether to restart, and into what (house.js, "power").
  if (p === '/api/house/boot' && req.method === 'POST') {
    if (!house.agentAllowed(req)) throw new HttpError(403, 'Not allowed.');
    return sendJson(res, 200, house.bootPoll(req, await readJson(req)));
  }

  // Signing in the TV app (tv.js): the TV asks for a code and waits; a signed-in phone approves it.
  // Home network only, like casting: the TV and the phone are in the same room.
  if (p === '/api/tv/pair/start' && req.method === 'POST') {
    if (req.auth.remote) throw new HttpError(403, 'Sign in a TV from the home network.');
    return sendJson(res, 200, tvPairing.start());
  }
  if (p === '/api/tv/pair/poll') {
    if (req.auth.remote) throw new HttpError(403, 'Sign in a TV from the home network.');
    return sendJson(res, 200, tvPairing.poll(url.searchParams.get('id')));
  }

  activity.seen(req);
  { // video requests often come without the Access email: remember who this visitor's address is
    const email = String(req.headers['cf-access-authenticated-user-email'] || '').trim().toLowerCase();
    if (email && req.headers['cf-connecting-ip']) load.noteVisitor(req.headers['cf-connecting-ip'], accounts.displayNameFor(email));
  }
  const user = accounts.userFor(req);
  // Live updates (live.js): one stream per open page, and every successful change announces itself.
  if (p === '/api/events' && req.method === 'GET') return live.subscribe(req, res, { userId: user.id, admin: activity.isAdmin(req), tab: url.searchParams.get('tab') });
  if (req.method === 'POST') res.once('finish', () => live.afterRequest(p, res.statusCode, { userId: user.id, tab: req.headers['x-marquee-tab'] }));

  // Watch-room links still require the normal Cloudflare sign-in. A room grants access to this
  // one title, without adding it to every participant's library or changing anyone's subtitles.
  if (p === '/api/watch/clock') return sendJson(res, 200, { serverNow: Date.now() });
  const watchMedia = (id) => {
    const full = librarySource(id);
    const key = accounts.mediaKey(full);
    if (!key || !accounts.hasEntry(user.id, key)) throw new HttpError(403, 'Add this title to your library before hosting a room.');
    if (!isVideo(full) || !fs.existsSync(full)) throw new HttpError(404, 'That video is no longer available.');
    const info = parseFile(full);
    const film = info.season == null ? shows.knownFilm(key, info.title, info.year) : null;
    return { kind: 'lib', id, mediaKey: key, ...info,
      title: film?.title || info.title, size: fs.statSync(full).size, format: path.extname(full).slice(1) };
  };
  if (p === '/api/watch' && req.method === 'POST') {
    const body = await readJson(req);
    const media = watchMedia(String(body.id || ''));
    const room = watchRooms.create(user, media, String(body.clientId || ''), Number(body.position || 0));
    activity.record(req, 'watch', `started a room for ${media.title}`);
    return sendJson(res, 200, room);
  }
  // Invite people to a room with a notification: anyone else who has Watch Together invites on.
  if ((m = p.match(/^\/api\/watch\/([A-Za-z0-9_-]{24})\/(invitees|invite)$/))) {
    const [, token, action] = m;
    const body = req.method === 'POST' ? await readJson(req) : {};
    const room = watchRooms.room(token);
    watchRooms.member(room, user, String(body.clientId || url.searchParams.get('clientId') || ''));
    const inRoom = new Set([...room.members.values()].map((v) => v.userId));
    const invitees = accounts.listUsers().filter((u) => !inRoom.has(u.id) && push.hasDevice(u.id) && u.settings?.pushWatch !== false)
      .map((u) => ({ id: u.id, name: u.name, avatar: u.avatar }));
    if (action === 'invitees') return sendJson(res, 200, { people: invitees });
    if (req.method !== 'POST') throw new HttpError(405, 'Unsupported watch-room action.');
    const allowedIds = new Set(invitees.map((u) => u.id));
    const ids = (Array.isArray(body.userIds) ? body.userIds : []).map(Number).filter((id) => allowedIds.has(id)).slice(0, 20)
      .filter((id) => { // one invite per person per room every two minutes
        const k = `${token}|${id}`, last = watchInvitesSent.get(k) || 0;
        if (Date.now() - last < 120000) return false;
        watchInvitesSent.set(k, Date.now());
        return true;
      });
    if (!ids.length) throw new HttpError(400, 'Choose someone to invite (each person can be invited once every two minutes).');
    const what = [room.media.title, room.media.season != null ? `S${String(room.media.season).padStart(2, '0')} E${String(room.media.episode).padStart(2, '0')}` : ''].filter(Boolean).join(' ');
    const sent = await notify(ids, 'watch', { title: `${user.name || 'Someone'} wants to watch with you`, body: `${what}. Tap to join the room.`, url: `/?watch=${token}`, tag: `watch-${token}` });
    activity.record(req, 'watch', `invited ${ids.length === 1 ? accounts.userById(ids[0])?.name : `${ids.length} people`} to ${room.media.title}`);
    return sendJson(res, 200, { invited: ids.length, sent });
  }
  // A party planned for later: the invite works right away and shows a countdown until it starts.
  if (p === '/api/watch/plan' && req.method === 'POST') {
    const body = await readJson(req);
    const media = watchMedia(String(body.id || ''));
    const room = watchRooms.plan(user, media, Number(body.startsAt));
    activity.record(req, 'watch', `planned a watch party for ${media.title}`);
    return sendJson(res, 200, room);
  }
  if (p === '/api/watch/parties') return sendJson(res, 200, { parties: watchRooms.parties(user) });
  if ((m = p.match(/^\/api\/watch\/([A-Za-z0-9_-]{24})\/(preview|join|events|heartbeat|control|leave|play-link|chat|react|schedule|cancel)$/))) {
    const [, token, action] = m;
    if (action === 'preview') return sendJson(res, 200, watchRooms.preview(token));
    if (req.method === 'POST') {
      const body = await readJson(req);
      const client = String(body.clientId || '');
      if (action === 'cancel') { watchRooms.cancel(token, user); return sendJson(res, 200, { ok: true }); }
      if (action === 'chat') return sendJson(res, 200, watchRooms.chat(token, user, client, body.text));
      if (action === 'react') return sendJson(res, 200, { ok: watchRooms.react(token, user, client, String(body.emoji || '')) });
      if (action === 'schedule') return sendJson(res, 200, watchRooms.schedule(token, user, client, body.startsAt ?? null));
      if (action === 'join') return sendJson(res, 200, watchRooms.join(token, user, client));
      if (action === 'heartbeat') return sendJson(res, 200, watchRooms.heartbeat(token, user, client, body));
      if (action === 'control') return sendJson(res, 200, watchRooms.control(token, user, client, body.action, body.position));
      if (action === 'leave') { watchRooms.leave(token, user, client); return sendJson(res, 200, { ok: true }); }
    }
    const client = String(url.searchParams.get('clientId') || '');
    const room = watchRooms.room(token);
    watchRooms.member(room, user, client);
    if (action === 'play-link') {
      const asked = String(url.searchParams.get('variant') || '');
      const variant = asked === 'browser-hevc' || /^phone(1080|720)$/.test(asked) ? asked : 'browser';
      return sendJson(res, 200, await playLink(room.media.kind, room.media.id, variant, null, null, false, url.searchParams.get('quality')));
    }
    if (action === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
        'CDN-Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      req.socket.setNoDelay(true);
      res.flushHeaders();
      const send = (state) => {
        if (res.destroyed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify(state)}\n\n`);
        if (state.left || state.ended) res.end();
        else if (res.writableLength > 256 * 1024) res.destroy();
      };
      res.write('retry: 1000\n\n');
      const unsubscribe = watchRooms.subscribe(token, user, client, send);
      const ping = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 10000);
      res.on('close', () => { clearInterval(ping); unsubscribe(); });
      return;
    }
    throw new HttpError(405, 'Unsupported watch-room action.');
  }

  // ---- notifications on this person's devices (push.js) ----
  if (p === '/api/push') return sendJson(res, 200, { publicKey: push.publicKey(), devices: push.devices(user.id) });
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readJson(req);
    const id = push.subscribe(user.id, body.subscription, body.label, String(body.replaces || ''));
    return sendJson(res, 200, { id, devices: push.devices(user.id) });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = await readJson(req);
    push.unsubscribe(user.id, { endpoint: String(body.endpoint || ''), id: String(body.id || '') });
    return sendJson(res, 200, { devices: push.devices(user.id) });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    if (!push.hasDevice(user.id)) throw new HttpError(400, 'Turn notifications on for this device first.');
    if (Date.now() - (pushTestsSent.get(user.id) || 0) < 10000) throw new HttpError(429, 'Wait a few seconds before sending another test.');
    pushTestsSent.set(user.id, Date.now());
    const sent = await notify([user.id], 'test', { title: 'Marquee', body: 'Notifications work. You’ll hear when downloads are ready, new episodes arrive and someone invites you to watch.', url: '/#settings', tag: 'test' });
    return sendJson(res, 200, { sent, devices: push.devices(user.id) });
  }

  // ---- the signed-in person: profile, preferences, watch progress ----
  if (p === '/api/me') {
    if (req.method === 'POST') {
      const next = accounts.updateMe(user, await readJson(req));
      watchRooms.renameUser(next);
      return sendJson(res, 200, { me: { ...accounts.publicUser(next), via: req.auth.via } });
    }
    return sendJson(res, 200, { me: { ...accounts.publicUser(user), via: req.auth.via } });
  }
  // Profile pictures: anyone signed in sees everyone's (they show beside names all over Marquee).
  if ((m = p.match(/^\/api\/avatar\/(\d{1,9})$/)) && req.method === 'GET') {
    const found = accounts.avatarFile(Number(m[1]));
    if (!found) throw new HttpError(404, 'No picture.');
    res.writeHead(200, { 'Content-Type': found.type, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache' });
    return res.end(await fs.promises.readFile(found.file));
  }
  // POST an image to set your picture; an empty POST removes it.
  if (p === '/api/me/avatar' && req.method === 'POST') {
    const body = await readRaw(req, 700 * 1024, 'That picture is too large.');
    const image = body.length ? body : null;
    const next = accounts.setAvatar(user.id, image);
    watchRooms.renameUser(next);
    return sendJson(res, 200, { me: { ...accounts.publicUser(next), via: req.auth.via } });
  }
  if (p.startsWith('/api/jellyfin') && await jellyfin.handleApi(req, res, p, user)) return;
  if (p === '/api/tv/pair/approve' && req.method === 'POST') {
    const body = await readJson(req, 4096);
    const email = req.auth.via === 'home' ? null : req.auth.email;
    const result = tvPairing.approve(`u${user.id}`, body.code, () => ({
      // The shared Home network account has no email: its TV simply uses home network access.
      token: email ? auth.createSession(req, email, 'Marquee TV app') : null,
      name: user.name || accounts.displayNameFor(email) || 'Home network',
    }));
    activity.record(req, 'signin', 'Signed in a TV');
    return sendJson(res, 200, result);
  }
  if (p === '/api/me/progress') {
    if (req.method === 'POST') {
      const { ref, time, duration, watched, about, room } = await readJson(req);
      saveProgressAllVersions(user.id, ref, time, duration);
      // Watch time for Wrapped and Popular on Marquee (see social.js), with who was in the same room.
      if (about && typeof about === 'object') {
        const companions = /^[A-Za-z0-9_-]{24}$/.test(String(room || '')) ? watchRooms.companions(room, user.id) : [];
        social.logWatch(user.id, { ref, about, watched, finished: time == null, companions });
      }
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, { progress: accounts.progressOf(user.id) });
  }
  // Marquee Wrapped: one person's year (defaults to this one).
  if (p === '/api/me/wrapped') {
    const year = Number(url.searchParams.get('year')) || new Date().getFullYear();
    return sendJson(res, 200, social.wrapped(user.id, year, personName, avatarOf));
  }
  // ---- social: thumbs up/down, who liked a title, Popular on Marquee ----
  if (p === '/api/social/rate' && req.method === 'POST') {
    const { key, value, title } = await readJson(req);
    social.rate(user.id, String(key || ''), value, title);
    return sendJson(res, 200, social.ratingFor(user.id, String(key), personName, avatarOf));
  }
  if (p === '/api/social/title') return sendJson(res, 200, social.ratingFor(user.id, String(url.searchParams.get('key') || ''), personName, avatarOf));
  if (p === '/api/social/ratings') {
    const keys = String(url.searchParams.get('keys') || '').split(',').slice(0, 500);
    return sendJson(res, 200, { ratings: social.ratingsFor(user.id, keys) });
  }
  if (p === '/api/social/popular') {
    const type = ['movie', 'tv'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all';
    if (!TMDB_TOKEN && !TMDB_KEY) return sendJson(res, 200, { items: [] });
    const ranked = social.popular({ type, limit: 20 });
    const cards = await Promise.allSettled(ranked.map(async (r) => {
      const [kind, id] = r.key.split(':');
      const card = mapTitle(await cachedTmdb(`/${kind}/${id}`, {}, 6 * 3600 * 1000), kind);
      return { ...card, likes: r.likes, viewers: r.viewers,
        likedBy: r.likedBy.filter((u) => u !== user.id).map(personName).slice(0, 4),
        people: r.likedBy.filter((u) => u !== user.id).slice(0, 4).map((u) => ({ name: personName(u), avatar: avatarOf(u) })),
        youLiked: r.likedBy.includes(user.id) };
    }));
    return sendJson(res, 200, { items: cards.filter((c) => c.status === 'fulfilled').map((c) => c.value) });
  }
  // ---- the owner's settings: server rules and people ----
  if (p.startsWith('/api/admin/')) {
    if (!user.isOwner) throw new HttpError(403, 'Only the server’s owner can change this.');
    // All configured admins share this inbox. No note content is put in Activity logs.
    const noteFor = (note) => ({ ...note, authorName: accounts.displayNameFor(note.author),
      shareMedia: note.shareToken && !note.deletedAt ? sharedMedia.state(note) : null });
    if (p === '/api/admin/notes/uploads' && req.method === 'POST') return sendJson(res,201,notesUploads.start(await readJson(req),user.email));
    if ((m = p.match(/^\/api\/admin\/notes\/uploads\/([a-f0-9]{32})(?:\/(finish|cancel))?$/))) {
      if (req.method === 'GET' && !m[2]) return sendJson(res,200,notesUploads.status(m[1],user.email));
      if (req.method === 'POST') {
        const result = m[2] === 'finish' ? notesUploads.finish(m[1],user.email)
          : m[2] === 'cancel' ? notesUploads.cancel(m[1],user.email)
          : await notesUploads.append(m[1],user.email,Number(url.searchParams.get('offset')),req);
        return sendJson(res,200,result);
      }
    }
    if ((m = p.match(/^\/api\/admin\/notes\/files\/([a-f0-9]{64})$/))) {
      const file = notes.file(m[1]);
      if (!file) throw new HttpError(404, 'Attachment not found.');
      const type = url.searchParams.get('view') === '1' && mediaType(file.full,file.mime);
      return sendVideo(req,res,file.full,{headers:{ 'Content-Type':type || 'application/octet-stream',
        'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store' }, label: `Note · ${file.name}`});
    }
    if (p === '/api/admin/notes') {
      if (req.method === 'GET') {
        const result = notes.list(Object.fromEntries(url.searchParams));
        return sendJson(res, 200, { ...result, notes: result.notes.map(noteFor) });
      }
      if (req.method === 'POST') return sendJson(res, 201, { note: noteFor(notes.create(await readJson(req, NOTES_JSON_MAX_BYTES), user.email)) });
    }
    if (p === '/api/admin/notes/import' && req.method === 'POST') {
      const result = notes.import(await readJson(req, 20 * 1024 * 1024), user.email);
      activity.record(req, 'notes-import', `imported ${result.added} notes`);
      return sendJson(res, 200, result);
    }
    if ((m = p.match(/^\/api\/admin\/notes\/(\d+)\/(share|unshare)$/)) && req.method === 'POST') {
      const note = m[2] === 'share' ? notes.share(m[1]) : notes.unshare(m[1]);
      if (note.shareToken) sharedMedia.prepare(note); else sharedMedia.cleanup();
      return sendJson(res, 200, { note: noteFor(note), url: note.shareToken ? `${clips.baseUrl(req)}/c/n/${note.shareToken}` : null });
    }
    if ((m = p.match(/^\/api\/admin\/notes\/(\d+)(?:\/(trash|restore))?$/))) {
      if (req.method === 'GET' && !m[2]) return sendJson(res, 200, { note: noteFor(notes.get(m[1])) });
      if (req.method === 'POST') {
        const note = notes.update(m[1], await readJson(req, NOTES_JSON_MAX_BYTES), m[2] || 'edit');
        if (m[2] === 'trash' && note.shareToken) sharedMedia.cleanup();
        if (m[2] === 'restore' && note.shareToken) sharedMedia.prepare(note);
        return sendJson(res, 200, { note: noteFor(note) });
      }
    }
    if (p === '/api/admin/settings') {
      if (req.method === 'POST') {
        const next = accounts.updateServerSettings(await readJson(req));
        activity.record(req, 'settings', `auto-delete ${next.retentionDays ? `after ${next.retentionDays} days` : 'off'}`, { quietMs: 60000 });
        lastExpiry = 0; // run the auto-delete check on the next round
        return sendJson(res, 200, { settings: next, choices: accounts.choices() });
      }
      return sendJson(res, 200, { settings: accounts.serverSettings(), choices: accounts.choices() });
    }
    if (p === '/api/admin/users') {
      // Sizes come from the files on disk: each video counts once per person who has it.
      const sizes = new Map();
      for (const i of (await scanLibrary()) || []) sizes.set(accounts.mediaKey(i.full), i.size);
      const users = accounts.listUsers().map(({ keys, ...u }) => {
        const held = keys.filter((k) => sizes.has(k));
        return { ...u, items: held.length, size: held.reduce((n, k) => n + sizes.get(k), 0) };
      });
      return sendJson(res, 200, { users });
    }
    // The owner can give someone a picture (handy for family who never open Settings).
    if ((m = p.match(/^\/api\/admin\/users\/(\d+)\/avatar$/)) && req.method === 'POST') {
      const body = await readRaw(req, 700 * 1024, 'That picture is too large.');
      const image = body.length ? body : null;
      const u = accounts.setAvatar(Number(m[1]), image);
      watchRooms.renameUser(u);
      activity.record(req, 'permission', `${image ? 'set' : 'removed'} ${u.name}’s picture`);
      return sendJson(res, 200, { avatar: u.avatar });
    }
    if ((m = p.match(/^\/api\/admin\/users\/(\d+)$/)) && req.method === 'POST') {
      const body = await readJson(req);
      const u = accounts.updateUser(Number(m[1]), body);
      if ('canDownload' in body) activity.record(req, 'permission', `${u.name} ${body.canDownload ? 'can' : 'can’t'} download`);
      if ('keep' in body) activity.record(req, 'permission', `${u.name}’s videos ${body.keep ? 'are never auto-deleted' : 'are auto-deleted again'}`);
      if ('libraryWith' in body) {
        const mates = accounts.libraryMates(u.id).filter((id) => id !== u.id).map((id) => accounts.userById(id)?.name).filter(Boolean);
        activity.record(req, 'permission', mates.length ? `${u.name} shares a library with ${mates.join(', ')}` : `${u.name} has their own library again`);
        live.publish('library');
      }
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Unknown admin route.');
  }

  if (p === '/api/house') {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can see the house.');
    const report = await house.houseReport();
    if (Array.isArray(report?.server?.services)) report.server = { ...report.server, services: report.server.services.map((x) => ({ ...x, detail: translate(x.detail) })) };
    // "Server: FlareSolverr: no answer at …" ends in a service's own detail line.
    const speakIssue = (line) => { const whole = translate(line); return whole !== line ? whole : line.replace(/^(.*: )(.*)$/, (m, head, tail) => head + translate(tail)); };
    if (Array.isArray(report?.issues)) report.issues = report.issues.map(speakIssue);
    return sendJson(res, 200, report);
  }
  if (p === '/api/house/screentime') {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can see Screen Time.');
    const q = url.searchParams;
    return sendJson(res, 200, screenTime.screenTimeReport({ device: q.get('device') || '', date: q.get('date') || '', today: q.get('today') || '' }));
  }
  if (p === '/api/house/power' && req.method === 'POST') {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can turn machines on.');
    const { host, action, entry } = await readJson(req);
    const r = await house.powerAction(String(host || ''), String(action || ''), entry == null ? null : String(entry));
    activity.record(req, action === 'wake' ? 'wake' : 'restart', r.detail);
    return sendJson(res, 200, { ok: true, message: r.message });
  }
  // Who has access (the Zero Trust email list) and invite links: owner only.
  if (p === '/api/access' || p.startsWith('/api/access/')) {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can manage access.');
    if (p === '/api/access') {
      if (!invites.invitesConfigured()) return sendJson(res, 200, { configured: false, members: [], invites: [] });
      let members = null;
      let error = null;
      try { members = await invites.members(); } catch (e) { error = e.message; }
      const names = Object.fromEntries((members || []).map((email) => [email, accounts.displayNameFor(email)]));
      return sendJson(res, 200, { configured: true, members, names, error, owners: activity.adminEmails(), invites: invites.listInvites() });
    }
    if (p === '/api/access/rename' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Enter a person and a name.');
      const { email, name, previousName } = body;
      const identity = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!invites.invitesConfigured()) throw new HttpError(503, 'Access management is not configured.');
      if (!(await invites.members()).includes(identity)) throw new HttpError(404, 'That person is no longer in the access list.');
      const renamed = accounts.renameUser(identity, name, previousName);
      watchRooms.renameUser(renamed);
      return sendJson(res, 200, { user: accounts.publicUser(renamed) });
    }
    if (p === '/api/access/invite' && req.method === 'POST') {
      const { note } = await readJson(req);
      const inv = invites.createInvite(req, note);
      activity.record(req, 'invite', inv.note || 'a new invite');
      return sendJson(res, 200, inv);
    }
    if ((m = p.match(/^\/api\/access\/invite\/([a-f0-9]{8})\/revoke$/)) && req.method === 'POST') {
      invites.revokeInvite(m[1]);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/access/remove' && req.method === 'POST') {
      const { email } = await readJson(req);
      const left = await invites.removeMember(email, activity.adminEmails());
      const gone = accounts.listUsers().find((u) => u.email && u.email === String(email || '').trim().toLowerCase());
      if (gone) { push.forgetUser(gone.id); jellyfin.store.removeUser(gone.id); } // their devices stop getting notifications, their Jellyfin servers lose access
      activity.record(req, 'revoke', String(email || '').toLowerCase());
      return sendJson(res, 200, { members: left });
    }
    throw new HttpError(404, 'Unknown access route.');
  }
  if (p === '/api/clips' || p.startsWith('/api/clips/')) {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can see clips.');
    if (p === '/api/clips') return sendJson(res, 200, await clips.listClips());
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/thumb\.jpg$/))) {
      const data = await fs.promises.readFile(await clips.thumbnail(m[1]));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      return res.end(data);
    }
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/video$/))) return sendVideo(req, res, await clips.clipFile(m[1]));
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/preview(?:\/(\d{1,4})\.jpg)?$/))) return sendPreview(res, await clips.clipFile(m[1]), m[2]);
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/keyframes$/))) return sendJson(res, 200, await clips.trimInfo(m[1]));
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/rename$/)) && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Send a clip name.');
      return sendJson(res, 200, await clips.renameClip(m[1], body.title, body.previousTitle));
    }
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/trim$/)) && req.method === 'POST') {
      const { start, end, segments, deleteOriginal, removeTracks } = await readJson(req);
      // segments: the parts to keep, in order. A single start/end is one part (older pages).
      // removeTracks: audio tracks to leave out (the mix is rebuilt from the rest).
      const r = await clips.trim(m[1], segments ?? [{ start, end }], { deleteOriginal: Boolean(deleteOriginal), removeTracks: removeTracks ?? [] });
      activity.record(req, 'trim', r.original);
      return sendJson(res, 200, r);
    }
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/delete$/)) && req.method === 'POST') {
      const r = await clips.deleteClip(m[1]);
      activity.record(req, 'delete', `the clip ${r.title}`);
      return sendJson(res, 200, r);
    }
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/(share|unshare)$/)) && req.method === 'POST') {
      if (m[2] === 'unshare') {
        const r = await clips.unshare(m[1]);
        activity.record(req, 'unshare', r.title);
        return sendJson(res, 200, r);
      }
      const r = await clips.share(m[1]);
      activity.record(req, 'share', r.title, { quietMs: 60000 });
      return sendJson(res, 200, { ...r, url: `${clips.baseUrl(req)}/c/${r.token}` });
    }
    throw new HttpError(404, 'Unknown clips route.');
  }

  if (p === '/api/activity') {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can see activity.');
    return sendJson(res, 200, activity.report());
  }

  if (p === '/api/status') {
    return sendJson(res, 200, {
      search: Boolean(TMDB_TOKEN || TMDB_KEY), library: Boolean(MEDIA_DIR), downloads: Boolean(QBIT_URL),
      torrents: torrents.torrentsEnabled(),
      subtitles: subtitles.subtitlesConfigured(),
      casting: await castAllowed(req),
      admin: activity.isAdmin(req),
      clips: activity.isAdmin(req) && clips.clipsConfigured(),
      me: { ...accounts.publicUser(user), via: req.auth.via },
      rules: accounts.serverSettings(),
      subLangs: subtitles.subtitleLanguages(),
      whatsNew: whatsNew.statusFor(user, webBuildFor(req)),
      ...(preview.inPreview(req, PREVIEW_DIR) && { preview: true }),
    });
  }
  // Every update's notes, for Settings → What's new.
  if (p === '/api/whats-new') return sendJson(res, 200, { updates: whatsNew.allFor(user), seen: user.settings.seenUpdate || null });
  if (p === '/api/convert') {
    const plays = new Set((url.searchParams.get('plays') || '').split(',').filter(Boolean));
    return sendJson(res, 200, await convertStatusFor(user, plays));
  }
  if (p === '/api/discover/home') {
    return sendJson(res, 200, await discoverHome(url.searchParams.get('type') || 'all'));
  }
  if (p === '/api/discover/list') {
    const page = Math.max(1, Math.min(500, Number(url.searchParams.get('page')) || 1));
    return sendJson(res, 200, await discoverList(url.searchParams.get('key'), page));
  }
  // The best trailer TMDB knows for a film or show (YouTube only: that's what the title sheet can embed).
  if ((m = p.match(/^\/api\/title\/(movie|tv)\/(\d+)\/trailer$/))) {
    if (!tmdbOn()) return sendJson(res, 200, { trailer: null });
    const lang = TMDB_LANG.split('-')[0];
    const d = await cachedTmdb(`/${m[1]}/${m[2]}/videos`, { include_video_language: [...new Set([lang, 'en', 'null'])].join(',') }, 12 * 3600 * 1000);
    return sendJson(res, 200, { trailer: pickTrailer(d.results || [], lang) });
  }
  // The main actors, for the Cast line under a description. A show counts its whole run, not just the latest season.
  if ((m = p.match(/^\/api\/title\/(movie|tv)\/(\d+)\/cast$/))) {
    if (!tmdbOn()) return sendJson(res, 200, { cast: [], people: [] });
    const d = await cachedTmdb(m[1] === 'tv' ? `/tv/${m[2]}/aggregate_credits` : `/movie/${m[2]}/credits`, {}, 24 * 3600 * 1000);
    const people = (d.cast || []).filter((c) => c.name && c.id).slice(0, 5).map((c) => ({ name: c.name, id: c.id }));
    return sendJson(res, 200, { cast: people.map((c) => c.name), people });
  }
  // A title page's extras beyond the card: logo art, runtime, genres, tagline, age rating, the cast with
  // faces and titles like it. One TMDB call (append_to_response), cached 12 h like the trailer.
  if ((m = p.match(/^\/api\/title\/(movie|tv)\/(\d+)\/page$/))) {
    if (!tmdbOn()) return sendJson(res, 200, { page: null });
    const tv = m[1] === 'tv';
    const lang = TMDB_LANG.split('-')[0];
    const d = await cachedTmdb(`/${m[1]}/${m[2]}`, {
      append_to_response: tv ? 'images,aggregate_credits,recommendations,content_ratings' : 'images,credits,recommendations,release_dates',
      include_image_language: [...new Set(['en', lang, 'null'])].join(','),
    }, 12 * 3600 * 1000);
    return sendJson(res, 200, { page: titlePage(m[1], d) });
  }
  // One season's episodes with descriptions, running times and air dates, for a title page's episode list.
  if ((m = p.match(/^\/api\/tv\/(\d+)\/season\/(\d+)$/))) {
    if (!tmdbOn()) return sendJson(res, 200, { episodes: [] });
    const d = await cachedTmdb(`/tv/${m[1]}/season/${m[2]}`, {}, 6 * 3600 * 1000);
    return sendJson(res, 200, { episodes: seasonEpisodes(d) });
  }
  // Anime get an Audio choice in the Download panel; `dubbed`: what this person last chose for it.
  if ((m = p.match(/^\/api\/title\/(movie|tv)\/(\d+)\/dub$/))) {
    if (!tmdbOn()) return sendJson(res, 200, { anime: false, dubbed: false });
    const d = await cachedTmdb(`/${m[1]}/${m[2]}`, {}, 6 * 3600 * 1000);
    // Adding someone's dual-audio copy from the server: the same choice, with no download to carry it.
    if (req.method === 'POST') {
      if (anime.isAnimeDetails(d)) rememberDub(user, m[1], m[2], (await readJson(req)).dubbed === true);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, { anime: anime.isAnimeDetails(d), dubbed: Boolean(user.settings?.dubbed?.includes(`${m[1]}:${m[2]}`)) });
  }
  // A show's seasons (TMDB), for the season chips in the details and show sheets.
  if ((m = p.match(/^\/api\/tv\/(\d+)\/seasons$/))) {
    const d = await cachedTmdb(`/tv/${m[1]}`, {}, 6 * 3600 * 1000);
    const today = new Date().toISOString().slice(0, 10);
    // Anime: where each season's numbering starts (One Piece's season 21 is episodes 892-1088), for
    // the Download panel's episode range. The context is cached; building it waits a few seconds at most.
    const ctx = anime.isAnimeDetails(d) ? await Promise.race([
      anime.buildContext('tv', Number(m[1]), tmdb, { details: d }).catch(() => null),
      new Promise((ok) => setTimeout(ok, 8000, null)),
    ]) : null;
    return sendJson(res, 200, {
      seasons: (d.seasons || []).filter((x) => x.season_number > 0).map((x) => ({
        number: x.season_number,
        name: x.name || `Season ${x.season_number}`,
        episodes: x.episode_count || null,
        first: ctx?.seasons?.find((c) => c.n === x.season_number)?.first || 1,
        upcoming: shows.seasonUpcoming(d, x, today),
      })),
    });
  }
  // ---- Save for later and Follow (watchlist.js) ----
  if (p === '/api/watchlist' && req.method === 'GET') {
    return sendJson(res, 200, { items: watchlist.list(user.id), autoDownload: mayAutoDownload(user) });
  }
  if (p === '/api/watchlist' && req.method === 'POST') {
    const body = await readJson(req);
    const type = body.type === 'tv' ? 'tv' : body.type === 'movie' ? 'movie' : null;
    const tmdbId = Number(body.tmdbId);
    if (!type || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) throw new HttpError(400, 'Which film or show?');
    const flags = {};
    for (const k of ['saved', 'follow', 'auto']) if (body[k] != null) flags[k] = Boolean(body[k]);
    if (flags.auto && !mayAutoDownload(user)) {
      throw user.canDownload ? new HttpError(503, 'Automatic downloads need TMDB, qBittorrent and torrent search set up on the server.')
        : new HttpError(403, 'Automatic downloads need download rights. Ask the server’s owner.');
    }
    const old = watchlist.get(user.id, type, tmdbId);
    const leaving = !(flags.saved ?? old?.saved) && !(type === 'tv' && (flags.follow ?? old?.follow));
    if (leaving) {
      watchlist.remove(user.id, type, tmdbId);
      return sendJson(res, 200, { item: null });
    }
    if (!tmdbOn()) throw new HttpError(503, 'Saving titles needs TMDB. Add TMDB_TOKEN to .env and restart.');
    const details = await cachedTmdb(`/${type}/${tmdbId}`, {}, 3600 * 1000);
    if (type === 'tv' && flags.follow && !old?.follow && flags.auto == null) flags.auto = mayAutoDownload(user);
    // Following starts after the episode that aired last, so nothing older downloads by itself.
    if (type === 'tv' && (flags.auto ?? old?.auto) && (!old?.auto || !old?.follow)) flags.baseline = baselineFrom(details);
    watchlist.set(user.id, type, tmdbId, watchMeta(type, details), flags);
    setImmediate(checkWatchlist);
    return sendJson(res, 200, { item: watchlist.list(user.id).find((i) => i.type === type && i.id === tmdbId) || null });
  }
  if (p === '/api/watchlist/seen' && req.method === 'POST') {
    const tmdbId = Number((await readJson(req)).tmdbId);
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) throw new HttpError(400, 'Which show?');
    return sendJson(res, 200, { cleared: watchlist.markSeen(user.id, tmdbId) });
  }
  if (p === '/api/discover/genres') {
    return sendJson(res, 200, { genres: await genres() });
  }
  if (p === '/api/discover/genre') {
    const type = ['movie', 'tv'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all';
    const id = (k) => (/^\d+$/.test(url.searchParams.get(k) || '') ? Number(url.searchParams.get(k)) : null);
    const page = Math.max(1, Math.min(500, Number(url.searchParams.get('page')) || 1));
    return sendJson(res, 200, await discoverGenre({
      type, movieGenre: id('movie'), tvGenre: id('tv'), sort: url.searchParams.get('sort'), page,
    }));
  }
  if (p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return sendJson(res, 200, { results: [], svt: [] });
    const search = parseCatalogueSearch(q);
    // SVT Play may answer late or not at all: its titles are a bonus, never a reason to wait long.
    const svtHitsPromise = Promise.race([svt.svtSearch(search.title), new Promise((r) => setTimeout(() => r([]), 5000))]);
    const multiPromise = tmdbForViewer('/search/multi', { query: search.title, include_adult: 'false' });
    let answers;
    if (needsExactCatalogueFallback(search)) {
      const [multi, movieFirst, tvFirst] = await Promise.all([
        multiPromise,
        tmdbForViewer('/search/movie', catalogueParams(search, 'movie')),
        tmdbForViewer('/search/tv', catalogueParams(search, 'tv')),
      ]);
      const [moviePages, tvPages] = await Promise.all([
        exactCataloguePages(search, 'movie', movieFirst),
        exactCataloguePages(search, 'tv', tvFirst),
      ]);
      answers = [multi, ...moviePages, ...tvPages];
    } else {
      answers = [await multiPromise];
    }
    const svtHits = await svtHitsPromise;
    const results = mergeCatalogueResults(search, answers.map((data) => data.results || []));
    return sendJson(res, 200, { results: results.filter(onlyScreen).map((x) => mapTitle(x)), svt: svtHits });
  }
  // ---- documentaries ----
  if (p === '/api/docs/home') return sendJson(res, 200, await docs.home());
  if (p === '/api/docs/category') {
    const page = Math.max(1, Math.min(500, Number(url.searchParams.get('page')) || 1));
    const data = await docs.category(url.searchParams.get('id'), {
      type: ['movie', 'tv'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all',
      sort: url.searchParams.get('sort'), page,
    });
    if (!data) throw new HttpError(404, 'There’s no such category.');
    return sendJson(res, 200, data);
  }
  if (p === '/api/svt/title') {
    const svtPath = url.searchParams.get('path') || '';
    if (!svt.validPath(svtPath)) throw new HttpError(400, 'That isn’t an SVT Play title.');
    return sendJson(res, 200, await svtTitleView(user, svtPath));
  }
  if (p === '/api/svt/add' && req.method === 'POST') {
    if (!user.canDownload) throw new HttpError(403, 'The server’s owner hasn’t turned on downloads for you. Ask them, or add things that are already on the server.');
    const body = await readJson(req);
    if (!svt.validPath(body.path)) throw new HttpError(400, 'That isn’t an SVT Play title.');
    const title = await svt.svtTitle(body.path);
    if (!title) throw new HttpError(404, 'SVT Play doesn’t have this right now.');
    const numbers = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 5000).slice(0, 500) : null);
    const result = await svtAdd(user, title, { seasons: numbers(body.seasons), episodes: numbers(body.episodes) });
    activity.record(req, 'download', `${title.title} (SVT Play)`, { quietMs: 60000 });
    return sendJson(res, 200, {
      ...result,
      message: result.queued ? 'On its way from SVT Play.' : result.added ? 'It was already on the server, so it’s in your library now.' : 'Already in your library.',
    });
  }
  if (p === '/api/library') return sendJson(res, 200, localizedLibrary(await libraryView(user)));
  // Add videos already on the server to your library (no copy is made).
  if (p === '/api/library/identify') {
    if (!user.isOwner) throw new HttpError(403, 'Only the server’s owner can change a film’s identity.');
    if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Use GET or POST.');
    const body = req.method === 'POST' ? await readJson(req) : null;
    const id = String(body?.id || url.searchParams.get('id') || '');
    const item = (await scanLibrary() || []).find((i) => i.id === id && i.season == null);
    if (!item) throw new HttpError(404, 'That film is no longer in the library.');
    if (!body) {
      const q = String(url.searchParams.get('q') || item.title).trim().slice(0, 150);
      const result = await tmdb('/search/movie', { query: q, include_adult: 'false' });
      return sendJson(res, 200, { results: (result.results || []).map((r) => ({ ...mapTitle(r, 'movie'), releaseDate: r.release_date || null })) });
    }
    const tmdbId = Number(body.tmdbId);
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) throw new HttpError(400, 'Choose a film from the results.');
    const details = await tmdb(`/movie/${tmdbId}`);
    shows.identifyFilm(accounts.mediaKey(item.full), details);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/library/add' && req.method === 'POST') {
    const ids = [].concat((await readJson(req)).ids || []).map(String).slice(0, 500);
    const available = new Set((await libraryVisibleItems(await scanLibrary(), user) || []).map((i) => i.id));
    let added = 0;
    for (const id of ids) {
      const full = librarySource(id);
      if (!available.has(id)) throw new HttpError(409, 'That video is not ready to add. Wait for its download to finish, then try again.');
      if ((torrentInventory.items || []).some((t) => deletingDownloads.has(t.hash.toLowerCase()) && isInside(full, t.save_path || MEDIA_DIR))) {
        throw new HttpError(409, 'A download in this folder is being removed. Wait for it to finish, then try again.');
      }
      if (!fs.existsSync(full)) continue;
      if (accounts.addEntry(user.id, accounts.mediaKey(full), 'added')) added++;
    }
    if (added) activity.record(req, 'add', ids.length === 1 ? titleOf(librarySource(ids[0])) : `${added} videos`, { quietMs: 60000 });
    return sendJson(res, 200, { added });
  }
  // "Keep longer": push back when videos in your library are deleted.
  if (p === '/api/library/extend' && req.method === 'POST') {
    const ids = [].concat((await readJson(req)).ids || []).map(String).slice(0, 500);
    const entries = ids.map((id) => accounts.extend(user.id, accounts.mediaKey(librarySource(id))));
    const days = accounts.serverSettings().extendDays;
    activity.record(req, 'extend', `${ids.length === 1 ? titleOf(librarySource(ids[0])) : `${ids.length} videos`} by ${days} days`, { quietMs: 60000 });
    return sendJson(res, 200, { entries });
  }
  if ((p === '/api/downloads/add' || p === '/api/downloads/smart') && !user.canDownload) {
    throw new HttpError(403, 'The server’s owner hasn’t turned on downloads for you. Ask them, or add things that are already on the server.');
  }
  if (p === '/api/downloads/add' && req.method === 'POST') {
    if (/application\/json/i.test(req.headers['content-type'] || '')) {
      const body = await readJson(req);
      const dn = /[?&]dn=([^&]+)/.exec(String(body.link || ''))?.[1];
      let name = String(body.name || '');
      if (!name && dn) { try { name = decodeURIComponent(dn.replace(/\+/g, ' ')); } catch { name = dn; } }
      let film = null, show = null;
      if (body.movieId != null && body.tvId != null) throw new HttpError(400, 'Choose a film or a show identity.');
      if (body.movieId != null) {
        const id = Number(body.movieId);
        if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Invalid film identity.');
        film = await tmdb(`/movie/${id}`);
      }
      if (body.tvId != null) {
        const id = Number(body.tvId);
        if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Invalid show identity.');
        show = await tmdb(`/tv/${id}`);
      }
      const check = name ? await newVersionCheck(user, { link: String(body.link || ''), name, film, show, mediaType: body.mediaType }) : null;
      const added = await addDownload({ link: body.link, user, name, film, show,
        mediaType: ['tv', 'movie'].includes(body.mediaType) ? body.mediaType : null });
      // A season pack: episodes already here in the same resolution are switched off once its file list arrives.
      if (check?.owned?.size && added && !added.existing) trimDuplicatePack(String(body.link || ''), check).catch((e) => console.warn(`[versions] ${e.message}`));
      activity.record(req, 'download', name || 'a torrent link');
      // Subtitles chosen in torrent search are fetched when the download completes.
      if (Array.isArray(body.subs) && body.subs.length) {
        subtitles.wantSubtitles(String(body.link || ''), body.subs, String(body.name || ''));
        setTimeout(checkSubtitleWants, 30_000);
      }
    } else {
      const file = await readRaw(req, 10 * 1024 * 1024);
      if (!file.length) throw new HttpError(400, 'The file was empty.');
      await addDownload({ file, user });
      activity.record(req, 'download', 'a .torrent file');
    }
    return sendJson(res, 200, { ok: true });
  }
  // ---- Download: one command for a film, a season or some episodes (see smart-download.js) ----
  if (p === '/api/downloads/smart' && req.method === 'POST') {
    const body = await readJson(req);
    const { id, title, type, season: seasonNo, episodes, upgrade } = await startSmartFor(user, body);
    activity.record(req, upgrade ? 'upgrade' : 'download', type === 'tv'
      ? `${title} season ${seasonNo}${episodes?.length ? `, ${episodes.length === 1 ? `episode ${episodes[0]}` : `${episodes.length} episodes`}` : ''}` : title);
    return sendJson(res, 202, { id });
  }
  if ((m = p.match(/^\/api\/downloads\/smart\/([a-f0-9]{12})$/))) {
    const job = smart.smartJob(m[1], { userId: user.id, owner: user.isOwner });
    if (!job) throw new HttpError(404, 'That download request is no longer tracked.');
    return sendJson(res, 200, job);
  }
  // ---- torrent search ----
  if (p === '/api/torrents/search') {
    const query = url.searchParams.get('q');
    const adult = !filterApplies(user);
    const ctx = await animeContextForSearch(url.searchParams);
    let found = await torrents.searchTorrents(query, url.searchParams.get('type'), { adult });
    // Anime: also under its romanised name ("Sousou no Frieren" for "Frieren: Beyond Journey's End").
    const romaji = ctx && animeQuery(query, ctx);
    if (romaji) {
      const more = await torrents.searchTorrents(romaji, 'all', { adult }).catch(() => null);
      if (more) {
        const seen = new Set(found.results.map((r) => r.magnet || r.ref || r.name));
        found = { ...found, results: [...found.results, ...more.results.filter((r) => !seen.has(r.magnet || r.ref || r.name))].sort((a, b) => b.seeders - a.seeders) };
      }
    }
    return sendJson(res, 200, url.searchParams.get('strict') === '1'
      ? { ...found, results: found.results.filter((r) => matchesRelease(query, r.name, parseName) || (ctx && animeMatches(query, r.name, ctx))) } : { ...found, results: exactFirst(query, found.results, parseName) });
  }
  if (p === '/api/torrents/magnet') {
    return sendJson(res, 200, { magnet: await torrents.magnetFor1337x(url.searchParams.get('ref')) });
  }
  if (p === '/api/downloads') {
    return sendJson(res, 200, { items: await listDownloads(user, user.isOwner && url.searchParams.get('all') === '1') });
  }
  if ((m = p.match(/^\/api\/downloads\/([a-f0-9]{40}|[a-f0-9]{64})\/(pause|resume|retry|delete)$/i)) && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const copy = svtQueue?.get(m[1]);
    if (copy) {
      if (!user.isOwner && !copy.requesters.some((id) => accounts.sameLibrary(id, user.id))) throw new HttpError(403, 'That’s someone else’s download.');
      if (m[2] === 'delete') await svtQueue.remove(copy.hash);
      else if (m[2] === 'pause') svtQueue.pause(copy.hash);
      else svtQueue.resume(copy.hash);
      activity.record(req, m[2], copy.name);
      return sendJson(res, 200, { ok: true });
    }
    const [t] = await qbit(`/api/v2/torrents/info?hashes=${m[1]}`);
    if (!t) throw new HttpError(404, 'That download no longer exists.');
    if (!user.isOwner && !accounts.sameLibrary(torrentOwner(t), user.id)) throw new HttpError(403, 'That’s someone else’s download.');
    if (['resume', 'retry'].includes(m[2]) && !user.canDownload) throw new HttpError(403, 'Downloads have been turned off for you. Ask the server’s owner before resuming this download.');
    releaseEpisodeOrder(t.hash); // pausing, resuming or removing it yourself overrides the episode order
    if (m[2] === 'delete') {
      await deleteDownload(t, body.files !== false, user);
      activity.record(req, 'delete', `${t.name}${body.files === false ? ' (download only, files kept)' : ''}`);
    } else if (m[2] === 'retry') {
      await retryDownload(t);
      activity.record(req, 'resume', `${t.name} (checking files and retrying)`);
    } else {
      await setPaused(t.hash, m[2] === 'pause');
      activity.record(req, m[2], t.name);
    }
    return sendJson(res, 200, { ok: true });
  }
  // "Remove from my library" for a download: others who want it keep it; nobody else, and it's cancelled.
  if ((m = p.match(/^\/api\/downloads\/([a-f0-9]{40}|[a-f0-9]{64})\/leave$/i)) && req.method === 'POST') {
    const [t] = await qbit(`/api/v2/torrents/info?hashes=${m[1]}`);
    if (!t) throw new HttpError(404, 'That download no longer exists.');
    accounts.recordTorrent(t.hash, torrentOwner(t), t.name);
    const wanters = accounts.torrentWanters(t.hash);
    if (!wanters.includes(user.id)) return sendJson(res, 200, { ok: true, kept: true });
    if (wanters.length === 1) {
      releaseEpisodeOrder(t.hash);
      await deleteDownload(t, true, user);
      activity.record(req, 'delete', t.name);
      return sendJson(res, 200, { ok: true, kept: false });
    }
    accounts.leaveTorrent(t.hash, user.id);
    for (const f of await torrentFileMetadata(t).catch(() => [])) {
      let key = null;
      try { key = accounts.mediaKey(torrentFilePath(t, f)); } catch { /* unsafe path: never in a library */ }
      if (key) accounts.removeEntry(user.id, key);
    }
    invalidateLibrary();
    activity.record(req, 'remove', t.name);
    return sendJson(res, 200, { ok: true, kept: true });
  }
  // ---- casting ----
  // Play now: asks for the download to run for playback; polled until the start of the video has arrived.
  if (p === '/api/part/open' || p === '/api/part/status') {
    const id = url.searchParams.get('id') || '';
    await partialAccess(user, id);
    let opened;
    try { opened = await partialStreams.open(id); }
    catch (e) { throw new HttpError(e.status || 500, e.message); }
    const { entry, ready } = opened;
    const status = partialStreams.status(entry);
    if (p === '/api/part/status') {
      // The finished file in this person's library, once there is one to switch to.
      let libraryId = null;
      if (status.done) {
        const key = accounts.mediaKey(entry.file);
        if (key && accounts.libraryOf(user.id).has(key)) libraryId = (libraryCache.items || []).find((i) => accounts.mediaKey(i.full) === key)?.id || null;
      }
      return sendJson(res, 200, { ...status, libraryId });
    }
    if (!ready) return sendJson(res, 202, { ready: false, status });
    if (!entry.announced) { entry.announced = true; activity.record(req, 'play', titleOf(entry.file), { quietMs: 3 * 3600 * 1000 }); }
    const variant = 'phone1080';
    const exp = Math.floor(Date.now() / 1000) + PLAY_LINK_HOURS * 3600;
    return sendJson(res, 200, { ready: true, status, url: `/play/part/${id}/${variant}/${exp}/${signPlay('part', id, variant, exp)}/index.m3u8`,
      sourceHeight: entry.info.height || null });
  }
  if (p === '/api/play-link') {
    const q = url.searchParams;
    const link = await playLink(q.get('kind') || '', q.get('id') || '', q.get('variant') || 'browser', q.get('audio'), q.get('audioSource'), q.get('audioRetry') === '1', q.get('quality'));
    // Named from the library/download file: browsers often stream a cached copy named by a hash.
    if (link.url && q.get('audio') === null) activity.record(req, 'play', titleOf(await sourceFile(q.get('kind'), q.get('id'))), { quietMs: 3 * 3600 * 1000 });
    return sendJson(res, link.ready === false ? 202 : 200, link);
  }
  if (p === '/api/network') {
    return sendJson(res, 200, { ...(await describeRequest(req)), castAllowed: await castAllowed(req), castWhenAwaySetting: CAST_WHEN_AWAY });
  }
  if (p === '/api/cast/devices') {
    if (!(await castAllowed(req))) return sendJson(res, 200, { devices: [], notes: [], away: true });
    const data = url.searchParams.get('refresh') ? await cast.discover() : { devices: cast.knownDevices(), notes: [] };
    // What each TV is playing, and whether it was started from this device.
    const devices = data.devices.map((d) => {
      const s = cast.getSession(d.id);
      return s ? { ...d, session: { ...s, mine: isMine(req, d.id) } } : d;
    });
    return sendJson(res, 200, { ...data, devices });
  }
  if (p === '/api/cast/sessions') {
    // Only this device's own casts, so even a page that doesn't filter (an older cached copy) shows nothing else.
    cast.pruneSessions().catch(() => {}); // not awaited: a switched-off TV takes seconds to time out; the next poll sees it
    return sendJson(res, 200, { sessions: cast.listSessions().filter((s) => isMine(req, s.deviceId)).map((s) => ({ ...s, mine: true })) });
  }
  if (p === '/api/cast/play' && req.method === 'POST') {
    if (!(await castAllowed(req))) {
      throw new HttpError(403, 'You’re away from home, so the TVs there aren’t available. Play it on this device instead.');
    }
    const body = await readJson(req);
    const sub = body.sub && subtitles.validLang(body.sub) ? String(body.sub).toLowerCase() : null;
    const media = await resolveMedia(body.kind, body.id, sub);
    const session = await cast.castTo(String(body.deviceId || ''), media);
    castOwners.set(session.deviceId, clientOf(req));
    console.log(`[cast] ${session.title} on ${session.deviceName}, started by ${clientOf(req).slice(0, 12)}`);
    activity.record(req, 'cast', `${session.title}${session.subtitle ? ` ${session.subtitle}` : ''} → ${session.deviceName}`);
    return sendJson(res, 200, { session: { ...session, mine: true } });
  }
  if ((m = p.match(/^\/api\/cast\/([\w-]+)\/subtitles$/)) && req.method === 'POST') {
    // DLNA can't swap subtitles mid-playback: restart with the new track and seek back.
    const body = await readJson(req);
    const session = cast.getSession(m[1]);
    if (!session) throw new HttpError(404, 'Nothing is playing on that TV.');
    if (session.kind === 'airplay') {
      throw new HttpError(400, 'Apple TV can’t show separate subtitle files over AirPlay. Play it here on the phone instead, or use a smart TV.');
    }
    const sub = body.lang && subtitles.validLang(body.lang) ? String(body.lang).toLowerCase() : null;
    const media = await resolveMedia(session.media.kind, session.media.id, sub);
    let position = null;
    try { position = (await cast.status(m[1])).position; } catch { /* start from the beginning */ }
    const next = await cast.castTo(m[1], media);
    cast.resumeAt(m[1], position).catch(() => {});
    return sendJson(res, 200, { session: next, resumeAt: position });
  }
  if ((m = p.match(/^\/api\/cast\/([\w-]+)\/status$/))) return sendJson(res, 200, await cast.status(m[1]));
  if ((m = p.match(/^\/api\/cast\/([\w-]+)\/control$/)) && req.method === 'POST') {
    const body = await readJson(req);
    const before = cast.getSession(m[1]);
    const result = await cast.control(m[1], String(body.action || ''), Number(body.value));
    if (body.action === 'stop' && before) activity.record(req, 'stop', `${before.title} on ${before.deviceName}`);
    return sendJson(res, 200, result);
  }

  // ---- subtitles ----
  if (p === '/api/subs/langs') {
    const kind = url.searchParams.get('kind');
    if (kind) {
      const file = converter.preferConverted(await sourceFile(kind, url.searchParams.get('id')));
      const info = infoFor(file);
      // anime: Japanese audio, so the player turns on English subtitles for people who never chose any.
      // Not for a dual-audio copy of an anime they asked for dubbed.
      const heardDubbed = isDualAudio(file) && wantsDub(user, info?.title);
      return sendJson(res, 200, { ...await subtitles.languagesForFile(file, info), anime: Boolean(info?.title && anime.contextForTitle(info.title)) && !heardDubbed });
    }
    // Not downloaded yet (torrent search): look up by title.
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return sendJson(res, 200, { languages: [], configured: subtitles.subtitlesConfigured() });
    const info = parseName(q);
    if (url.searchParams.get('type') === 'tv') info.tv = true;
    return sendJson(res, 200, await subtitles.languagesForTitle(info));
  }
  if (p === '/api/subs/fetch' && req.method === 'POST') {
    const body = await readJson(req);
    const lang = String(body.lang || '').toLowerCase();
    const file = converter.preferConverted(await sourceFile(body.kind, body.id));
    const srt = await subtitles.ensureSubtitle(file, infoFor(file), lang);
    subsync.ensureSync(srt, file);
    activity.record(req, 'subtitles', `${subtitles.LANG_NAMES[lang] || lang} subtitles for ${titleOf(file)}`, { quietMs: 24 * 3600 * 1000 });
    return sendJson(res, 200, { url: `/api/subs/file/${body.kind}/${encodeURIComponent(body.id)}/${lang}.vtt` });
  }
  if (p === '/api/subs/sync') {
    // Timing of a saved subtitle: GET for its state, POST { action: 'sync' | 'undo' | 'shift', seconds }.
    const body = req.method === 'POST' ? await readJson(req) : null;
    const kind = body ? body.kind : url.searchParams.get('kind');
    const id = body ? body.id : url.searchParams.get('id');
    const lang = String((body ? body.lang : url.searchParams.get('lang')) || '').toLowerCase();
    if (!subtitles.validLang(lang)) throw new HttpError(400, 'Unknown language.');
    const video = converter.preferConverted(await sourceFile(kind, String(id || '')));
    const srt = subtitles.findSidecar(video, lang);
    if (!srt) throw new HttpError(404, 'Those subtitles aren’t on the server.');
    if (!body) return sendJson(res, 200, subsync.stateOf(srt));
    if (body.action === 'undo') return sendJson(res, 200, subsync.undoSync(srt));
    if (body.action === 'sync') return sendJson(res, 200, subsync.queueSync(srt, video));
    if (body.action === 'shift') {
      const seconds = Number(body.seconds);
      if (!Number.isFinite(seconds) || seconds === 0 || Math.abs(seconds) > 60) throw new HttpError(400, 'Adjustment must be between -60 and 60 seconds.');
      return sendJson(res, 200, subsync.nudge(srt, seconds));
    }
    throw new HttpError(400, 'Unknown action.');
  }
  if ((m = p.match(/^\/api\/subs\/file\/(lib|dl)\/([A-Za-z0-9_-]+)\/([a-z]{2,3}(?:-[a-z]{2})?)\.(vtt|srt)$/))) {
    const file = converter.preferConverted(await sourceFile(m[1], m[2]));
    const text = await subtitles.readSubtitle(file, m[3]);
    const vtt = m[4] === 'vtt';
    // Only TVs ask for .srt (browsers get .vtt): shows whether a TV really picked the subtitles up.
    if (!vtt && req.method === 'GET') console.log(`[cast] TV fetched ${m[3]} subtitles for ${path.basename(file)} (${String(req.headers['user-agent'] || 'no user agent').slice(0, 60)})`);
    res.writeHead(200, {
      'Content-Type': vtt ? 'text/vtt; charset=utf-8' : 'text/srt; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(req.method === 'HEAD' ? undefined : vtt ? subtitles.srtToVtt(text) : text);
  }

  // Chapters belong to the original release, even when its browser copy lost chapter tags.
  // Without a credits chapter, the closing-credits music is found by comparing the ending with
  // other episodes of the season (see credits.js). The next episode gets its own lookup ready meanwhile.
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/credits$/))) {
    const listed = await sourceFile(m[1], m[2]);
    const file = converter.originalFor(listed) || listed;
    const peers = m[1] === 'lib' ? await creditPeers(file) : { siblings: [] };
    const creditsAt = await creditsFor(file, peers.siblings);
    if (peers.next) creditPeers(peers.next).then((n) => creditsFor(peers.next, n.siblings)).catch(() => {});
    return sendJson(res, 200, { creditsAt });
  }
  // The opening titles to offer Skip intro for: an opening chapter, or the theme song this episode
  // shares with its season neighbours (credits.js). The next episode's is found meanwhile.
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/intro$/))) {
    const listed = await sourceFile(m[1], m[2]);
    const file = converter.originalFor(listed) || listed;
    const peers = m[1] === 'lib' ? await creditPeers(file) : { siblings: [] };
    const intro = await introFor(file, peers.siblings);
    if (peers.next) creditPeers(peers.next).then((n) => introFor(peers.next, n.siblings)).catch(() => {});
    return sendJson(res, 200, { intro });
  }

  // Timeline previews of the copy the browser plays (its timeline is the one the seek bar shows).
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/preview(?:\/(\d{1,4})\.jpg)?$/))) {
    return sendPreview(res, await streamFile(m[1], m[2], 'browser'), m[3]);
  }

  if (p === '/api/stream-info') {
    const src = String(url.searchParams.get('src') || '');
    if (src.length > 1000) throw new HttpError(400, 'Invalid stream.');
    return sendJson(res, 200, await streamInfo(req, src));
  }

  // ---- browser audio compatibility ----
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/audio$/))) {
    const source = await sourceFile(m[1], m[2]);
    // Extra codecs the client reports it can decode (e.g. Edge with Dolby, Chrome with HEVC).
    const plays = new Set((url.searchParams.get('plays') || '').split(',').filter(Boolean));
    // "phone": the player streams the phone version, which is made from the HEVC-capable pick and always
    // plays (H.264 + AAC, timed by ffmpeg), so nothing needs converting; track indexes refer to that file.
    const phone = plays.has('phone');
    const served = converter.preferConverted(source, { browser: true, hevc: phone || plays.has('hevc') });
    let tracks = null;
    let vid = null;
    try { [tracks, vid] = await Promise.all([converter.probeAudio(served), converter.probeVideo(served)]); } catch { /* unreadable: say nothing */ }
    if (!tracks) return sendJson(res, 200, { known: false });
    // They asked for this anime dubbed: the player starts on the English track.
    const preferAudio = isDualAudio(source) && wantsDub(user, infoFor(source)?.title) ? 'en' : null;
    if (phone) {
      return sendJson(res, 200, {
        preferAudio, known: true, codec: 'aac', tracks, browserSafe: true, aligned: true, phone: true,
        audioSource: converter.audioSourceKey(served), defaultAudio: tracks[0]?.index ?? null,
        videoSafe: true, videoCodec: 'H.264', fixable: false, job: null, percent: null, error: null,
        sync: { shift: 0, applied: 0 },
      });
    }
    const videoSafe = converter.videoBrowserSafe(vid, { hevc: plays.has('hevc') });
    const main = tracks[0]?.codec || null;
    const browserSafe = !main || converter.BROWSER_AUDIO.has(main) || plays.has(main);
    const aligned = converter.isAligned(tracks);
    // Unplayable video or audio, or out-of-sync audio: move this file to the front of the conversion queue.
    // HEVC in a browser without HEVC (Firefox) needs an H.264 copy; everything else goes through the usual browser copy.
    const fix = browserSafe && aligned && videoSafe ? {}
      : !videoSafe && vid?.codec === 'hevc' && !plays.has('hevc') ? converter.requestBrowserVideo(source)
        : converter.requestBrowserAudio(source);
    // An episode this browser can't play as is: get the next ones ready now (see prepareNextEpisodes).
    if (!videoSafe && m[1] === 'lib') prepareNextEpisodes(source, plays).catch(() => {});
    const sync = converter.syncState(source);
    return sendJson(res, 200, {
      preferAudio, known: true, codec: main, tracks, browserSafe, aligned,
      audioSource: converter.audioSourceKey(served), defaultAudio: tracks[0]?.index ?? null,
      videoSafe, videoCodec: vid ? (vid.codec === 'hevc' ? `HEVC (${vid.tag || 'hev1'})` : `${converter.VIDEO_NAMES[vid.codec] || vid.codec}${vid.tenBit ? ' 10-bit' : ''}`) : null,
      fixable: Boolean(fix.fixable), job: fix.state || sync.state || null,
      percent: fix.percent ?? (sync.state === 'converting' ? converter.converterStatus().current?.percent ?? 0 : null),
      error: fix.error || null,
      sync: { shift: sync.shift, applied: sync.applied },
    });
  }
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/sync$/)) && req.method === 'POST') {
    const shift = Number((await readJson(req)).shift);
    if (!Number.isFinite(shift) || Math.abs(shift) > 10) throw new HttpError(400, 'Correction must be between -10 and 10 seconds.');
    const result = converter.setSync(await sourceFile(m[1], m[2]), shift);
    if (!result.fixable) throw new HttpError(409, result.error || 'This file can’t be corrected.');
    return sendJson(res, 200, result);
  }

  // ---- library deletion ----
  // Deleting takes a video out of your library. The file itself is only deleted when nobody else has
  // it in theirs (the owner can also delete it for everyone).
  if (p === '/api/library/delete-info') {
    const id = String(url.searchParams.get('id') || '');
    const key = accounts.mediaKey(librarySource(id));
    const others = accounts.holders(key).filter((u) => !accounts.sameLibrary(u, user.id)).length;
    const sharedWith = accounts.libraryMates(user.id).length - 1;
    return sendJson(res, 200, { ...(await deleteInfo(id)), others, sharedWith, canDeleteForEveryone: user.isOwner && others > 0 });
  }
  if (p === '/api/library/delete' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const key = accounts.mediaKey(librarySource(id));
    const everyone = Boolean(body.everyone) && user.isOwner;
    if (!everyone && !accounts.hasEntry(user.id, key) && !user.isOwner) throw new HttpError(403, 'That isn’t in your library.');
    let what = id;
    try { what = titleOf((await deletePlan(id)).original); } catch { /* named by id */ }
    const heldByOthers = (k) => accounts.heldOutside(k, user.id);
    if (!everyone && heldByOthers(key)) {
      accounts.removeEntry(user.id, key);
      activity.record(req, 'remove', what);
      return sendJson(res, 200, { ok: true, kept: true });
    }
    let scope = body.scope === 'torrent' ? 'torrent' : 'file';
    // A whole season pack only goes if none of its other episodes are in someone else's library.
    if (scope === 'torrent' && !everyone) {
      const { torrent } = await deletePlan(id);
      if (torrent?.videos.some((v) => heldByOthers(accounts.mediaKey(v.full)))) scope = 'file';
    }
    for (const file of await deleteMedia(id, scope, { user, everyone })) {
      const k = accounts.mediaKey(file);
      if (k) { accounts.removeAll(k); accounts.markGone(k); }
    }
    activity.record(req, 'delete', `${what}${scope === 'torrent' ? ' (whole download)' : ''}${everyone ? ' for everyone' : ''}`);
    return sendJson(res, 200, { ok: true });
  }
  // A whole season or show in one go (see deleteMany).
  if (p === '/api/library/delete-many-info' && req.method === 'POST') {
    return sendJson(res, 200, await deleteManyInfo(deleteIds(await readJson(req)), user));
  }
  if (p === '/api/library/delete-many' && req.method === 'POST') {
    const body = await readJson(req);
    const everyone = Boolean(body.everyone) && user.isOwner;
    const result = await deleteMany(deleteIds(body), user, everyone);
    if (result.deleted || result.removed) {
      activity.record(req, result.deleted ? 'delete' : 'remove', `${result.what} (${result.deleted + result.removed} videos)${everyone ? ' for everyone' : ''}`);
    }
    if (!result.deleted && !result.removed && result.failed) throw new HttpError(409, result.error);
    return sendJson(res, 200, { ok: true, deleted: result.deleted, removed: result.removed, failed: result.failed, error: result.error });
  }

  // ---- Download to phone (travel.js) ----
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/travel$/))) {
    const served = converter.preferConverted(await sourceFile(m[1], m[2]));
    const opts = await travel.options(m[1], m[2]);
    let size = null;
    try { size = (await fs.promises.stat(served)).size; } catch { /* gone */ }
    return sendJson(res, 200, {
      duration: opts.duration,
      qualities: opts.qualities.map(({ key, ...q }) => {
        const row = travel.row(user.id, m[1], m[2], q.quality);
        return { ...q, mine: Boolean(row), url: row && q.state === 'ready' ? travelUrl(row) : null };
      }),
      original: { size, name: path.basename(served), url: `/api/media/${m[1]}/${m[2]}/original/${encodeURIComponent(path.basename(served))}` },
    });
  }
  // The file as it is (the MP4 copy when there is one), for keeping at full quality.
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/original(?:\/[^/]*)?$/))) {
    const served = converter.preferConverted(await sourceFile(m[1], m[2]));
    return sendVideo(req, res, served, { headers: { 'Content-Disposition': attachment(path.basename(served)) }, label: `Download · ${path.basename(served)}` });
  }
  if (p === '/api/travel') {
    if (req.method === 'POST') {
      const body = await readJson(req);
      const quality = String(body.quality || '');
      if (!validQuality(quality)) throw new HttpError(400, 'Choose Small or Standard.');
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200).map((it) => ({
        kind: String(it?.kind || ''), id: String(it?.id || ''), title: String(it?.title || '').slice(0, 160) }));
      if (!items.length) throw new HttpError(400, 'Nothing to copy.');
      for (const it of items) if (!['lib', 'dl'].includes(it.kind) || !/^[A-Za-z0-9_-]{1,1000}$/.test(it.id)) throw new HttpError(400, 'Invalid video.');
      try { await travel.request(user.id, items, quality); } catch (e) { throw e instanceof HttpError ? e : new HttpError(e.status || 500, e.message); }
      activity.record(req, 'travel', `${items.length === 1 ? items[0].title || 'a video' : `${items.length} videos`} for a phone (${TRAVEL_QUALITIES[quality].label})`, { quietMs: 60000 });
    }
    return sendJson(res, 200, { items: travel.rowsFor(user.id).map(travelItem) });
  }
  if (p === '/api/travel/remove' && req.method === 'POST') {
    const body = await readJson(req);
    travel.remove(user.id, String(body.kind || ''), String(body.id || ''), String(body.quality || ''));
    return sendJson(res, 200, { items: travel.rowsFor(user.id).map(travelItem) });
  }
  if ((m = p.match(/^\/api\/travel\/file\/([a-f0-9]{24})(?:\/[^/]*)?$/))) {
    const row = travel.rowByKey(user.id, m[1]);
    if (!row || !travel.ready(m[1])) throw new HttpError(404, 'That phone copy isn’t ready, or has been cleared away. Ask for it again.');
    // Counted once per download, not per range request.
    if (req.method === 'GET' && !/^bytes=(?!0-)/.test(String(req.headers.range || ''))) travel.markDownloaded(user.id, m[1]);
    const name = travelName(row.title, row.quality);
    return sendVideo(req, res, travel.filePath(m[1]), { headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': attachment(name) }, label: `Phone copy · ${row.title}` });
  }

  // A /sub-<lang>/ segment means the TV was sent subtitles; advertise them via CaptionInfo.sec.
  const caption = (kind, id, lang) => (lang ? { captionUrl: `http://${LAN_IP}:${PORT}/api/subs/file/${kind}/${id}/${lang}.srt` } : {});
  if ((m = p.match(/^\/api\/stream\/lib\/([A-Za-z0-9_-]+)(?:\/sub-([a-z-]+))?(?:\/[^/]*)?$/))) {
    const file = url.searchParams.has('browser') ? converter.preferConverted(librarySource(m[1]), { browser: true, hevc: url.searchParams.has('hevc') }) : castFile('lib', m[1]) || libraryPath(m[1]);
    return sendVideo(req, res, file, caption('lib', m[1], m[2]));
  }
  if ((m = p.match(/^\/api\/stream\/dl\/([A-Fa-f0-9]+)(?:\/sub-([a-z-]+))?(?:\/[^/]*)?$/))) {
    const file = url.searchParams.has('browser') ? converter.preferConverted(await downloadSource(m[1]), { browser: true, hevc: url.searchParams.has('hevc') }) : castFile('dl', m[1]) || await downloadPath(m[1]);
    return sendVideo(req, res, file, caption('dl', m[1], m[2]));
  }
  throw new HttpError(404, 'Unknown API route.');
}

// ---------- static files ----------
// With the preview switched on (preview.js), PREVIEW_DIR is tried first and public/ fills the gaps.
async function serveStatic(req, res, pathname) {
  let data, full;
  for (const root of preview.staticRoots(req, PUBLIC_DIR, PREVIEW_DIR)) {
    full = preview.staticFile(root, pathname);
    if (!full) throw new HttpError(400, 'Bad path.');
    try { data = await fs.promises.readFile(full); break; } catch { /* not in this folder */ }
  }
  if (!data) throw new HttpError(404, 'Not found.');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'CDN-Cache-Control': 'no-store', // keeps Cloudflare from serving an old copy after an update
    ...(PREVIEW_DIR && { Vary: 'Cookie' }),
  });
  res.end(data);
}

// Index (no sheet): frame times and sheet layout, made in the background on first ask (previews.js).
// Sheet URLs carry the storyboard key, so a sheet can be cached for good.
async function sendPreview(res, file, sheet) {
  if (sheet == null) return sendJson(res, 200, await previews.index(file));
  const jpg = await previews.sheet(file, Number(sheet));
  if (!jpg) throw new HttpError(404, 'That preview isn’t ready yet.');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=2592000, immutable' });
  res.end(await fs.promises.readFile(jpg));
}

// Messages meant to be read, on their way out in the viewer's language.
const SPOKEN_FIELDS = ['error', 'message', 'note', 'hint', 'reason', 'warning', 'step'];
function spoken(body) {
  if (currentLanguage() === 'en' || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = { ...body };
  for (const f of SPOKEN_FIELDS) if (typeof out[f] === 'string') out[f] = translate(out[f]);
  if (out.job && typeof out.job === 'object') out.job = spoken(out.job);
  return out;
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(spoken(body)));
}

// ---------- sign-in (auth.js) ----------
// Reachable without an identity: the sign-in page and API, health, public share links (/c),
// signed video links (/play), the token-protected House/Screen Time agents, subtitles for TVs at
// home, and the app's static files (code and styles only; the page itself needs an identity).
function publicPath(req, url) {
  const p = url.pathname;
  if (p.startsWith('/api/auth/') || p === '/c' || p.startsWith('/c/') || p.startsWith('/play/')) return true;
  if (/^\/api\/(house\/(report|summary|load|boot)|screentime|agent\/notify)$/.test(p)) return true;
  if (/^\/api\/tv\/pair\/(start|poll)$/.test(p)) return true; // home network only (checked in the route)
  if (p.startsWith('/api/subs/file/') && !req.auth.remote) return true;
  if (p.startsWith('/api/')) return false;
  const ext = path.extname(p).toLowerCase();
  return Boolean(ext) && ext !== '.html';
}

function refuseSignedOut(req, res, url) {
  if (url.pathname.startsWith('/api/') || req.method !== 'GET') return sendJson(res, 401, { error: 'Sign in to use Marquee.', signin: true });
  res.writeHead(303, { Location: `/signin?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' });
  res.end();
}

function sendSignIn(req, res, url) {
  const asked = url.searchParams.get('lang');
  if (['en', 'sv'].includes(asked)) res.setHeader('Set-Cookie', `marquee_lang=${asked}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return inLanguage(['en', 'sv'].includes(asked) ? asked : currentLanguage(), () => drawSignIn(req, res, url));
}
function drawSignIn(req, res, url) {
  const next = safeNext(url.searchParams.get('next'));
  if (req.auth.via) { res.writeHead(303, { Location: next, 'Cache-Control': 'no-store' }); return res.end(); }
  const errors = { wrong: 'That email and password don’t match.', wait: 'Too many tries. Wait a few minutes and try again.', missing: 'Enter your email and password.' };
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : signInPage({ next, error: errors[url.searchParams.get('error')] || '', hasLogins: auth.hasLogins(), remote: req.auth.remote }));
}

// JSON from the app, or a plain form post from /signin.
async function readCredentials(req) {
  if (/^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 4096) throw new HttpError(413, 'Request too large.'); chunks.push(c); }
    return { form: true, ...Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())) };
  }
  return { form: false, ...(await readJson(req, 4096)) };
}

async function handleAuth(req, res, p) {
  if (p === '/api/auth/status') {
    return sendJson(res, 200, { via: req.auth.via, email: req.auth.email, remote: req.auth.remote, homeNetwork: auth.mode, localLogins: auth.hasLogins() });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = await readCredentials(req);
    const next = safeNext(body.next);
    try {
      if (!body.email || !body.password) throw new HttpError(400, 'Enter your email and password.');
      const { email, setCookie } = await auth.signIn(req, body.email, body.password);
      activity.record(req, 'signin', 'Signed in to Marquee', { user: email });
      res.setHeader('Set-Cookie', setCookie);
      if (body.form) { res.writeHead(303, { Location: next, 'Cache-Control': 'no-store' }); return res.end(); }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (!body.form || !err.status) throw err;
      const code = err.status === 429 ? 'wait' : err.status === 400 ? 'missing' : 'wrong';
      res.writeHead(303, { Location: `/signin?error=${code}&next=${encodeURIComponent(next)}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', auth.signOut(req));
    return sendJson(res, 200, { ok: true, signin: auth.mode === 'signin' || req.auth.remote });
  }
  if (p === '/api/auth/password' && req.method === 'POST') {
    const body = await readJson(req, 4096);
    const { setCookie } = await auth.changePassword(req, body.current, body.next);
    res.setHeader('Set-Cookie', setCookie);
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found.');
}

const server = http.createServer((req, res) => inLanguage(languageOf(req), () => handleRequest(req, res)));
async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Liveness for Docker, service managers and setup.js doctor. Says nothing about the library.
    if (url.pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return sendJson(res, 200, { status: 'ok', version: VERSION });
    await trust.sanitize(req);
    auth.guard(req, res);       // DNS rebinding, cross-site requests, security headers (auth.js)
    auth.identify(req);         // proxy identity, Marquee sign-in, or the shared home account
    if (url.pathname === '/signin' || url.pathname.startsWith('/c/')) preview.previewPageStyles(req, res, PREVIEW_DIR);
    if (url.pathname === '/signin' && (req.method === 'GET' || req.method === 'HEAD')) return sendSignIn(req, res, url);
    if (!req.auth.via && !publicPath(req, url)) return refuseSignedOut(req, res, url);
    const allowed = req.method === 'GET' || req.method === 'HEAD'
      || (req.method === 'POST' && (url.pathname.startsWith('/api/cast/') || url.pathname === '/api/downloads/add' || url.pathname === '/api/downloads/smart' || url.pathname === '/api/svt/add' || url.pathname === '/api/subs/fetch' || url.pathname === '/api/subs/sync' || url.pathname === '/api/library/delete' || url.pathname === '/api/library/delete-many' || url.pathname === '/api/library/delete-many-info' || /^\/api\/downloads\/\w+\/(pause|resume|retry|delete|leave)$/.test(url.pathname) || /^\/api\/media\/\w+\/[\w-]+\/sync$/.test(url.pathname)
        || /^\/api\/(house\/(report|boot|power)|screentime|agent\/notify)$/.test(url.pathname) || /^\/api\/clips\/[\w-]+\/(share|unshare|delete|trim|rename)$/.test(url.pathname)
        || /^\/api\/access\/(invite|remove|rename|invite\/\w+\/revoke)$/.test(url.pathname) || /^\/c\/i\/[\w-]+\/?$/.test(url.pathname)
        || /^\/api\/auth\/(login|logout|password)$/.test(url.pathname)
        || /^\/api\/(me|me\/progress|me\/avatar|library\/add|library\/extend|library\/identify|admin\/settings|admin\/users\/\d+|admin\/users\/\d+\/avatar|push\/subscribe|push\/unsubscribe|push\/test)$/.test(url.pathname)
        || /^\/api\/title\/(movie|tv)\/\d+\/dub$/.test(url.pathname) || /^\/api\/watchlist(?:\/seen)?$/.test(url.pathname) || /^\/api\/travel(?:\/remove)?$/.test(url.pathname)
        || /^\/api\/admin\/notes(?:\/import|\/\d+(?:\/(?:trash|restore|share|unshare))?)?$/.test(url.pathname)
        || /^\/api\/admin\/notes\/uploads(?:\/[a-f0-9]{32}(?:\/(?:finish|cancel))?)?$/.test(url.pathname)
        || /^\/api\/watch(?:\/plan|\/[A-Za-z0-9_-]{24}\/(join|heartbeat|control|leave|invite|chat|react|schedule|cancel))?$/.test(url.pathname)
        || url.pathname === '/api/social/rate' || /^\/api\/tv\/pair\/(start|approve)$/.test(url.pathname)
        || /^\/c\/jf\/v1\/(pair\/start|progress|disconnect)$/.test(url.pathname) || /^\/api\/jellyfin\/(approve|[\w-]+\/remove)$/.test(url.pathname)));
    if (!allowed) throw new HttpError(405, 'Method not allowed.');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (url.pathname.startsWith('/play/')) await handlePlay(req, res, url);
    // Public: shared clips, shared note previews and the Marquee invite card (bypassed in Cloudflare Access; see docs/remote-access.md)
    else if (url.pathname === '/c' || url.pathname.startsWith('/c/')) {
      if (url.pathname.startsWith('/c/jf/')) { if (!(await jellyfin.handlePublic(req, res, url))) throw new HttpError(404, 'Not found.'); }
      else if (!handleWatchPage(req, res, url, { rooms: watchRooms, artwork: watchArtwork })
        && !(await invites.handlePublic(req, res, url))
        && !(await noteShare.handlePublic(req, res, url, { notes, media: sharedMedia, sendVideo, nameFor: (email) => accounts.displayNameFor(email) })) && !(await clips.handlePublic(req, res, url, { sendVideo, previews }))) throw new HttpError(404, 'Not found.');
    }
    else if (!(req.method === 'GET' && preview.previewRoute(req, res, url.pathname, PREVIEW_DIR))) await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something broke on the server. Check the console.' : err.message });
    else res.destroy();
  }
}

// Video files for the converter: the library plus finished downloads.
// Files owned by qBittorrent are never deleted after conversion, since they may still be seeding.
// Only finished files are converted: a torrent that's still downloading (or paused, checking or
// being moved) is skipped entirely, including when qBittorrent saves into the library folder.
const BUSY_STATES = /^(checking|moving|metaDL|forcedMetaDL|allocating)/;
async function conversionCandidates() {
  const torrentFiles = [];   // finished video files owned by qBittorrent
  const unfinished = [];     // every file of a torrent that isn't complete yet
  let qbitReachable = !QBIT_URL;
  if (QBIT_URL) {
    try {
      for (const t of await qbit('/api/v2/torrents/info')) {
        const files = await torrentFileMetadata(t, { fresh: true });
        const complete = t.progress >= 1 && !BUSY_STATES.test(t.state || '');
        for (const f of files) {
          const full = torrentFilePath(t, f);
          // A finished episode of a pack that's still downloading converts now, not when the pack ends.
          const fileDone = f.progress >= 1 && f.priority !== 0 && !BUSY_STATES.test(t.state || '')
            && (complete || await downloadAvailable(t, f, { fresh: true }));
          if (!fileDone) { unfinished.push(full); continue; }
          if (/\bsample\b/i.test(f.name) || !VIDEO_EXT.has(path.extname(f.name).toLowerCase())) continue;
          torrentFiles.push(full);
        }
      }
      qbitReachable = true;
    } catch {
      // An incomplete inventory cannot distinguish hand-copied videos from partial torrent files.
      // null means "inventory unavailable", not "there are no candidates": the converter must skip
      // this scan entirely so cache cleanup cannot delete valid browser copies and trigger re-encodes.
      return null;
    }
  }
  const isTorrentFile = (file) => torrentFiles.some((t) => samePath(t, file));
  const isUnfinished = (file) => unfinished.some((t) => samePath(t, file));

  const list = torrentFiles.map((file) => ({ file, deleteOriginal: false }));
  if (MEDIA_DIR) {
    invalidateLibrary();
    await scanLibrary();
    // Without qBittorrent's file list there is no way to tell what it owns, so nothing is deleted.
    const deleteOriginal = qbitReachable && (process.env.CONVERT_DELETE_ORIGINAL || 'off').toLowerCase() === 'on';
    for (const i of libraryCache.all || []) {
      if (isTorrentFile(i.full) || isUnfinished(i.full)) continue;
      // Also skip anything still being written (copied in, or downloaded by another program).
      if (recentlyChanged(i.full)) continue;
      list.push({ file: i.full, deleteOriginal });
    }
  }
  return list;
}
function recentlyChanged(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs < 2 * 60 * 1000; } catch { return true; }
}

// ---------- deletion ----------
// Case-insensitive path comparison (Windows; qBittorrent may use forward slashes).
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (p, dir) => {
  const a = path.resolve(p).toLowerCase();
  const b = path.resolve(dir).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};
const isVideo = (f) => VIDEO_EXT.has(path.extname(f).toLowerCase()) && !/\bsample\b/i.test(f);

// Finds the torrent that owns a file, matched on its exact path.
async function torrentFor(file) {
  if (!QBIT_URL) return null;
  let list;
  try { list = await qbit('/api/v2/torrents/info'); } catch (e) {
    // Refuse rather than delete files qBittorrent may still own.
    throw new HttpError(503, `${e.message} Marquee needs it to check whether this file belongs to a torrent.`);
  }
  for (const t of list) {
    const content = t.content_path || path.join(t.save_path, t.name);
    if (!isInside(file, content) && !isInside(file, t.save_path)) continue;
    const files = await torrentFileMetadata(t, { fresh: true });
    const all = files.map((f, i) => ({ index: f.index ?? i, full: torrentFilePath(t, f), size: f.size, priority: f.priority }));
    const me = all.find((f) => samePath(f.full, file));
    if (!me) continue;
    // Deselected videos may still exist and belong to another viewer; deleting a torrent removes
    // those bytes too, so include them in sharing/conversion/room safety checks.
    const videos = all.filter((f) => isVideo(f.full) && fs.existsSync(f.full));
    return { hash: t.hash, name: t.name, size: t.size, fileIndex: me.index, videos };
  }
  return null;
}

// Files Marquee created alongside a video: MP4 copy and subtitles.
function extrasFor(file) {
  const out = [];
  if (converter.needsConversion(file)) {
    const twin = converter.twinPath(file);
    if (fs.existsSync(twin)) out.push(twin);
  }
  const stem = `${path.basename(file, path.extname(file)).toLowerCase()}.`;
  try {
    for (const e of fs.readdirSync(path.dirname(file))) {
      const l = e.toLowerCase();
      if (l.startsWith(stem) && /\.(srt|mks)$/.test(l)) out.push(path.join(path.dirname(file), e)); // .mks: subtitles kept from a deleted original
    }
  } catch { /* folder gone */ }
  return out;
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
    if (file.toLowerCase().endsWith('.srt')) subsync.forget(file);
  } catch (e) {
    if (/EBUSY|EPERM|EACCES/.test(e.code || '')) {
      throw new HttpError(409, `Windows says ${path.basename(file)} is in use. Stop playing it (here or on a TV) and try again.`);
    }
    throw e;
  }
}

// Removes empty parent folders up to (not including) MEDIA_DIR.
function removeEmptyFolders(dir) {
  while (MEDIA_DIR && isInside(dir, MEDIA_DIR) && !samePath(dir, MEDIA_DIR)) {
    try { fs.rmdirSync(dir); } catch { return; } // not empty
    dir = path.dirname(dir);
  }
}

async function deletePlan(id) {
  const listed = librarySource(id);
  // The library lists the MP4 copy; the original is the file that gets deleted.
  const original = converter.originalFor(listed) || listed;
  const torrent = await torrentFor(original);
  return { listed, original, torrent };
}

async function deleteInfo(id) {
  const { listed, original, torrent } = await deletePlan(id);
  const files = [original, ...extrasFor(original)].filter((f) => fs.existsSync(f));
  const size = files.reduce((n, f) => n + (fs.statSync(f).size || 0), 0);
  return {
    name: path.basename(listed),
    ...parseName(path.basename(listed)),
    size,
    torrent: torrent && {
      name: torrent.name,
      videos: torrent.videos.length,
      size: torrent.size,
    },
  };
}

async function deleteMedia(id, scope, context = {}) {
  const plan = await deletePlan(id), hash = plan.torrent?.hash.toLowerCase();
  assertDownloadNotDeleting(hash);
  if (hash) deletingDownloads.add(hash);
  try { return await deleteMediaPlan(plan, scope, context); }
  finally { if (hash) deletingDownloads.delete(hash); }
}
async function deleteMediaPlan({ original, torrent }, scope, { user = null, everyone = false } = {}) {
  if (converter.isBusy(original)) throw new HttpError(409, 'This file is being converted right now. Try again when that finishes.');
  const wholeTorrent = torrent && (scope === 'torrent' || torrent.videos.length <= 1);
  const videos = wholeTorrent ? torrent.videos.map((v) => v.full) : [original];
  if (!videos.some((v) => samePath(v, original))) videos.push(original);
  if (!everyone && (videos.some((v) => accounts.heldOutside(accounts.mediaKey(v), user?.id))
    || (torrent && accounts.torrentClaimants(torrent.hash).some((id) => !accounts.sameLibrary(id, user?.id))))) {
    throw new HttpError(409, 'Someone else is using a video from this download. Its files have been kept. Try again after their request finishes.');
  }
  if (videos.some((v) => converter.isBusy(v))) throw new HttpError(409, 'A file from this download is being converted right now. Try again when that finishes.');
  if (videos.some((v) => watchRooms.protects(accounts.mediaKey(v)))) throw new HttpError(409, 'A Watch Together room is using this video. End the room before deleting it.');

  const extras = videos.flatMap((v) => extrasFor(v));
  if (wholeTorrent) {
    // qBittorrent removes the torrent and all of its files.
    await qbitRequest('/api/v2/torrents/delete', {
      method: 'POST', body: new URLSearchParams({ hashes: torrent.hash, deleteFiles: 'true' }),
    });
  } else {
    if (torrent) {
      // Single file from a multi-file torrent: set it to "do not download".
      await qbitRequest('/api/v2/torrents/filePrio', {
        method: 'POST', body: new URLSearchParams({ hash: torrent.hash, id: String(torrent.fileIndex), priority: '0' }),
      });
      torrentFilesCache.delete(torrent.hash);
    }
    removeFile(original);
  }
  // Only invalidate derived files after qBittorrent accepted the mutation.
  for (const extra of extras) removeFile(extra);
  for (const v of videos) converter.forget(v);
  if (torrent) {
    torrentFilesCache.delete(torrent.hash);
    if (wholeTorrent) recentlyAddedDownloads.delete(torrent.hash.toLowerCase());
    torrentInventory.at = 0;
  }
  invalidateLibrary();
  // qBittorrent deletes asynchronously; clean up afterwards.
  setTimeout(() => { removeEmptyFolders(path.dirname(original)); invalidateLibrary(); }, 4000);
  console.log(`[library] deleted ${wholeTorrent ? `torrent "${torrent.name}"` : path.basename(original)}`);
  return videos;
}

// ---- deleting a season or a show at once ----
// Each video follows the single-delete rules: one that someone else also has only leaves your library
// (unless the owner deletes for everyone). A download whose videos are all on the list goes as a whole,
// so qBittorrent stops seeding it; from any other download, single files are deselected and deleted.
function deleteIds(body) {
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'Nothing to delete.');
  if (ids.length > 2000) throw new HttpError(400, 'Too many videos at once.');
  return ids;
}

async function deleteManyItems(ids, user) {
  const mine = accounts.libraryOf(user.id);
  const items = [];
  for (const id of ids) {
    const key = accounts.mediaKey(librarySource(id));
    if (!mine.has(key) && !user.isOwner) continue; // not yours to delete
    items.push({ id, key, plan: await deletePlan(id), shared: accounts.heldOutside(key, user.id) });
  }
  return items;
}

// Hashes of the downloads that go as a whole.
function wholeDownloads(items, user, everyone) {
  const whole = new Set();
  for (const { plan: { torrent: t } } of items) {
    if (!t || whole.has(t.hash)) continue;
    const listed = items.filter((i) => i.plan.torrent?.hash === t.hash && (everyone || !i.shared));
    if (!t.videos.every((v) => listed.some((i) => samePath(i.plan.original, v.full)))) continue;
    if (!everyone && t.videos.some((v) => accounts.heldOutside(accounts.mediaKey(v.full), user.id))) continue;
    whole.add(t.hash);
  }
  return whole;
}

function freedBytes(items, whole, everyone) {
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const downloads = new Map();
  let size = 0;
  for (const { plan, shared } of items) {
    if (shared && !everyone) continue;
    const t = plan.torrent;
    if (t && whole.has(t.hash)) downloads.set(t.hash, t.videos.reduce((n, v) => n + sizeOf(v.full) + extrasFor(v.full).reduce((m, f) => m + sizeOf(f), 0), 0));
    else size += sizeOf(plan.original) + extrasFor(plan.original).reduce((n, f) => n + sizeOf(f), 0);
  }
  return size + [...downloads.values()].reduce((n, s) => n + s, 0);
}

async function deleteManyInfo(ids, user) {
  const items = await deleteManyItems(ids, user);
  if (!items.length) throw new HttpError(403, 'None of these are in your library.');
  const shared = items.filter((i) => i.shared).length;
  const whole = wholeDownloads(items, user, false);
  const info = { videos: items.length, shared, size: freedBytes(items, whole, false), downloads: whole.size, canDeleteForEveryone: user.isOwner && shared > 0 };
  if (info.canDeleteForEveryone) info.sizeForEveryone = freedBytes(items, wholeDownloads(items, user, true), true);
  return info;
}

async function deleteMany(ids, user, everyone) {
  const items = await deleteManyItems(ids, user);
  if (!items.length) throw new HttpError(403, 'None of these are in your library.');
  const names = items.map((i) => parseName(path.basename(i.plan.original)));
  const seasons = new Set(names.map((n) => n.season));
  const what = `${names[0].title}${seasons.size === 1 && names[0].season != null ? ` Season ${names[0].season}` : ''}`;
  const whole = wholeDownloads(items, user, everyone);
  const gone = new Set();
  const out = { what, deleted: 0, removed: 0, failed: 0, error: null };
  for (const i of items) {
    if (i.shared && !everyone) { accounts.removeEntry(user.id, i.key); out.removed++; continue; }
    const hash = i.plan.torrent?.hash;
    if (hash && gone.has(hash)) { out.deleted++; continue; }
    try {
      const scope = hash && whole.has(hash) ? 'torrent' : 'file';
      for (const file of await deleteMedia(i.id, scope, { user, everyone })) {
        const k = accounts.mediaKey(file);
        if (k) { accounts.removeAll(k); accounts.markGone(k); }
      }
      if (scope === 'torrent') gone.add(hash);
      out.deleted++;
    } catch (e) {
      out.failed++;
      out.error ||= e.message;
    }
  }
  // Removed everything of yours from a download that's still running: you've left it, or the next
  // finished episode would put it straight back in your library.
  if (out.removed) {
    const mine = accounts.libraryOf(user.id);
    const left = new Map(items.filter((i) => i.shared && !everyone && i.plan.torrent).map((i) => [i.plan.torrent.hash, i.plan.torrent]));
    for (const [hash, t] of left) if (!t.videos.some((v) => mine.has(accounts.mediaKey(v.full)))) accounts.leaveTorrent(hash, user.id);
  }
  console.log(`[library] bulk delete "${what}": ${out.deleted} deleted, ${out.removed} removed, ${out.failed} failed`);
  return out;
}

// Pause or resume a download. qBittorrent 5 calls these stop/start; older versions pause/resume.
async function setPaused(hash, paused) {
  const body = () => new URLSearchParams({ hashes: hash });
  try {
    await qbitRequest(`/api/v2/torrents/${paused ? 'stop' : 'start'}`, { method: 'POST', body: body() });
  } catch (e) {
    if (e.status !== 502) throw e;
    await qbitRequest(`/api/v2/torrents/${paused ? 'pause' : 'resume'}`, { method: 'POST', body: body() });
  }
}

// Removes a download from qBittorrent, with its files (and Marquee's copies and subtitles) unless keepFiles.
async function retryDownload(t) {
  await qbitRequest('/api/v2/torrents/recheck', {
    method: 'POST', body: new URLSearchParams({ hashes: t.hash }),
  });
  await setPaused(t.hash, false);
  const owner = torrentOwner(t);
  accounts.recordTorrent(t.hash, owner, t.name);
  for (const userId of new Set([owner, ...accounts.torrentRequesters(t.hash)])) {
    if (userId) accounts.requestTorrent(t.hash, userId, t.name);
  }
  torrentFilesCache.delete(t.hash);
  torrentInventory.at = 0;
  invalidateLibrary();
}

async function deleteDownload(t, withFiles, user = null) {
  const hash = t.hash.toLowerCase();
  assertDownloadNotDeleting(hash);
  deletingDownloads.add(hash);
  try { return await deleteDownloadNow(t, withFiles, user); }
  finally { deletingDownloads.delete(hash); }
}
async function deleteDownloadNow(t, withFiles, user = null) {
  let videos = [], extras = [];
  if (withFiles) {
    const files = await torrentFileMetadata(t, { fresh: true });
    videos = files.filter((f) => isVideo(f.name)).map((f) => torrentFilePath(t, f));
    if (user && (accounts.torrentClaimants(t.hash).some((id) => !accounts.sameLibrary(id, user.id))
      || videos.some((v) => accounts.heldOutside(accounts.mediaKey(v), user.id)))) {
      throw new HttpError(409, 'Someone else has a video from this download in their library. Remove the download with files kept instead.');
    }
    if (videos.some((v) => watchRooms.protects(accounts.mediaKey(v)))) throw new HttpError(409, 'A Watch Together room is using a video from this download.');
    if (videos.some((v) => converter.isBusy(v))) throw new HttpError(409, 'A file from this download is being converted right now. Try again when that finishes.');
    extras = videos.flatMap((v) => extrasFor(v));
  }
  await qbitRequest('/api/v2/torrents/delete', {
    method: 'POST', body: new URLSearchParams({ hashes: t.hash, deleteFiles: withFiles ? 'true' : 'false' }),
  });
  for (const extra of extras) removeFile(extra);
  for (const v of videos) converter.forget(v);
  torrentFilesCache.delete(t.hash);
  recentlyAddedDownloads.delete(t.hash.toLowerCase());
  torrentInventory.at = 0;
  invalidateLibrary();
  if (withFiles && t.content_path) setTimeout(() => { removeEmptyFolders(path.dirname(t.content_path)); invalidateLibrary(); }, 4000);
  console.log(`[downloads] removed "${t.name}"${withFiles ? ' and its files' : ''}`);
}

// Fetches subtitles requested at download time once each torrent completes.
async function checkSubtitleWants() {
  if (!QBIT_URL) return;
  await subtitles.processWants(async (hash) => {
    const [t] = await qbit(`/api/v2/torrents/info?hashes=${hash}`);
    if (!t || t.progress < 1) return null;
    const file = await downloadSource(hash);
    return { file, info: infoFor(file) };
  }).catch((e) => console.warn(`[subtitles] ${e.message}`));
}
setTimeout(checkSubtitleWants, 20_000);
setInterval(checkSubtitleWants, 2 * 60 * 1000);

// ---------- finished downloads: no seeding ----------
// QBIT_REMOVE_FINISHED=on (default): a finished download is removed from qBittorrent with its files
// kept, so it never seeds and uses no upload bandwidth. New categorized torrents save inside MEDIA_DIR, so the video
// stays in the Library (and gets its MP4 copy as usual). A download still waiting for its automatic
// subtitles is stopped instead and removed once they're fetched (or 2 hours after it finished).
// One saved outside MEDIA_DIR is only stopped, so it stays playable from the Downloads tab.
// To keep seeding a particular torrent, give it the tag "seed" in qBittorrent.
const REMOVE_FINISHED = (process.env.QBIT_REMOVE_FINISHED || 'on').toLowerCase() !== 'off';
const SEEDING = /^(uploading|stalledUP|forcedUP|queuedUP|pausedUP|stoppedUP)$/;
let stoppingSeeds = false;
async function stopSeeding() {
  if (!QBIT_URL || !REMOVE_FINISHED || stoppingSeeds) return;
  stoppingSeeds = true;
  try {
    for (const t of await qbit('/api/v2/torrents/info?filter=completed')) {
      if (t.progress < 1 || !SEEDING.test(t.state || '')) continue;
      if ((t.tags || '').split(',').some((tag) => tag.trim().toLowerCase() === 'seed')) continue;
      const content = t.content_path || path.join(t.save_path || '', t.name);
      const inLibrary = Boolean(MEDIA_DIR) && isInside(content, MEDIA_DIR);
      // Not in anyone's library yet (claimFiles below does that first): keep it until it is.
      if (inLibrary && !accounts.torrentRow(t.hash)?.claimed_at) continue;
      const waitingSubs = (subtitles.subtitleWants(t.hash) || []).some((w) => w.state === 'waiting');
      const finishedFor = t.completion_on > 0 ? Date.now() / 1000 - t.completion_on : 0;
      try {
        if (inLibrary && (!waitingSubs || finishedFor > 2 * 3600)) {
          await deleteDownload(t, false);
        } else if (!/^(pausedUP|stoppedUP)$/.test(t.state)) {
          await setPaused(t.hash, true);
          console.log(`[downloads] stopped seeding "${t.name}"${waitingSubs ? ' (removed once its subtitles are fetched)' : ''}`);
        }
      } catch (e) { console.warn(`[downloads] couldn't stop "${t.name}" seeding: ${e.message}`); }
    }
  } catch { /* qBittorrent unreachable: next round */ } finally {
    stoppingSeeds = false;
  }
}
// ---------- whose library each video is in ----------
// Finished downloads go into the library of whoever started them (the torrent's marquee-u<id> tag, or
// the infohash recorded when it was added). Torrents added straight in qBittorrent belong to the owner.
// Videos that turn up in MEDIA_DIR any other way (copied in by hand, or there before accounts
// existed) go into the owner's library as kept, so nothing that was already there gets auto-deleted.
let completedClaims = null;
function claimCompletedTorrents(torrents) {
  if (!MEDIA_DIR) return Promise.resolve();
  // Polling and maintenance can overlap. Keep ownership/claimed_at writes in one sequence.
  const task = (completedClaims || Promise.resolve()).then(async () => {
    const first = !accounts.migrated();
    for (const t of torrents) {
      let row = accounts.torrentRow(t.hash);
      if (deletingDownloads.has(t.hash.toLowerCase())) continue;
      if (!row) {
        accounts.recordTorrent(t.hash, accounts.userFromTags(t.tags) ?? accounts.ownerUser()?.id ?? null, t.name);
        row = accounts.torrentRow(t.hash);
      }
      if (!accounts.torrentClaimants(t.hash).length || BUSY_STATES.test(t.state || '')) continue;
      try {
        const files = await torrentFileMetadata(t, { fresh: true });
        const videos = files.filter((f) => f.priority !== 0 && isVideo(f.name));
        if (!videos.length) continue;
        const availability = await Promise.all(videos.map((f) => downloadAvailable(t, f, { fresh: true })));
        if (deletingDownloads.has(t.hash.toLowerCase())) continue;
        const ready = videos.filter((f, i) => availability[i]);
        if (!ready.length) continue;
        const claimants = accounts.torrentClaimants(t.hash);
        let changed = false;
        const arrived = new Map(); // person -> files that just landed in their library (notifications)
        for (const f of ready) {
          const full = torrentFilePath(t, f), key = accounts.mediaKey(full);
          for (const userId of claimants) {
            if (accounts.addEntry(userId, key, first ? 'existing' : 'download')) {
              changed = true;
              if (!first) arrived.set(userId, [...(arrived.get(userId) || []), full]);
            }
          }
          const film = shows.filmDownload(t.hash);
          if (film && parseFile(full).season == null && shows.knownFilm(key, '', null)?.id !== film.id) {
            shows.identifyFilm(key, film); changed = true;
          }
        }
        // A season pack can contribute ready episodes while the rest downloads. Keep claimants
        // pending until the whole selected video set is ready; INSERT OR IGNORE preserves dates.
        if (t.progress >= 1 && availability.every(Boolean)) accounts.markClaimed(t.hash);
        if (changed) invalidateLibrary();
        if (arrived.size) announceArrivals(t.hash, arrived, claimants);
        for (const file of new Set([...arrived.values()].flat())) prepSeasonOf(file);
      } catch {
        // A transient qBittorrent/filesystem failure is retried on the next poll.
      }
    }
  });
  const done = task.finally(() => { if (completedClaims === done) completedClaims = null; });
  completedClaims = done;
  return done;
}

async function claimFiles() {
  if (!MEDIA_DIR) return;
  const first = !accounts.migrated();
  let torrentContent = []; // where torrents still in qBittorrent keep their files
  if (QBIT_URL) {
    try {
      const torrents = await qbit('/api/v2/torrents/info');
      torrentContent = torrents.map((t) => t.content_path || path.join(t.save_path, t.name));
      await claimCompletedTorrents(torrents);
    } catch {
      return; // qBittorrent unreachable: can't tell downloads from hand-copied files, so wait
    }
  }
  const owner = accounts.ownerUser();
  if (!owner) return;
  await scanLibrary();
  const tracked = accounts.trackedKeys();
  let adopted = 0;
  for (const i of libraryCache.all || []) {
    const key = accounts.mediaKey(i.full);
    if (!key || tracked.has(key) || torrentContent.some((c) => isInside(i.full, c))) continue;
    if (!first && Date.now() - i.added < 10 * 60 * 1000) continue; // may still be being copied in
    accounts.addEntry(owner.id, key, 'existing');
    tracked.add(key);
    adopted++;
  }
  if (adopted) console.log(`[accounts] ${adopted} video${adopted === 1 ? '' : 's'} added to ${owner.name}’s library (kept)`);
  if (first) accounts.setMigrated();
}

// ---------- auto-delete ----------
// Each video in someone's library has a date it goes (the owner sets how long, 7 days by default;
// "Keep longer" pushes it back). When that passes it leaves their library, and once it's in nobody's
// library the file is deleted. A delete that fails (the file is playing) is tried again next round.
const SYSTEM = { headers: { 'user-agent': 'Marquee' } }; // stands in for a request in the activity log
async function expireLibrary() {
  if (!MEDIA_DIR) return;
  const orphaned = accounts.expireDue();
  const pending = accounts.pendingDeletes();
  if (!pending.length) return;
  if (orphaned.length) invalidateLibrary();
  await scanLibrary();
  const byKey = new Map();
  for (const i of [...(libraryCache.all || []), ...(libraryCache.items || [])]) byKey.set(accounts.mediaKey(i.full), i); // the listed copy wins
  for (const key of pending) {
    const item = byKey.get(key);
    if (!item) { accounts.markGone(key); continue; }
    try {
      await deleteMedia(item.id, 'file');
      accounts.markGone(key);
      activity.record(SYSTEM, 'expire', titleOf(item.full), { user: 'Marquee' });
    } catch (e) {
      console.warn(`[library] couldn’t auto-delete ${item.file}: ${e.message} Trying again later.`);
    }
  }
}

let libraryBusy = false;
let lastExpiry = 0;
async function libraryRound() {
  if (libraryBusy) return;
  libraryBusy = true;
  try {
    await claimFiles().catch((e) => console.warn(`[accounts] ${e.message}`));
    await stopSeeding();
    if (Date.now() - lastExpiry > 10 * 60 * 1000) {
      lastExpiry = Date.now();
      await expireLibrary().catch((e) => console.warn(`[library] auto-delete: ${e.message}`));
    }
  } finally {
    libraryBusy = false;
  }
}
setTimeout(libraryRound, 15_000);
setInterval(libraryRound, 60 * 1000);

converter.startConverter({
  dataDir: DATA_DIR,
  cacheDir: CACHE_DIR,
  onSidecar: (srt) => subsync.markTrusted(srt), // extracted from the video: already in sync
  listCandidates: conversionCandidates,
  onConverted: () => { invalidateLibrary(); },
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other program or set PORT in .env.` : err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  PORT = server.address().port;
  svtQueue?.start();
  console.log(`Marquee is running: http://localhost:${PORT} (version ${VERSION})`);
  console.log(`  Data:      ${DATA_DIR}`);
  console.log(`  Cache:     ${CACHE_DIR}`);
  console.log(`  Accounts:  ${trust.mode === 'access-jwt' ? 'Cloudflare Access tokens verified' : `identity headers trusted from ${process.env.TRUSTED_PROXIES || '127.0.0.1, ::1'}`}; ${auth.store.count()} Marquee sign-in${auth.store.count() === 1 ? '' : 's'}`);
  console.log(`  Sign-in:   ${auth.mode === 'signin' ? 'required for everyone' : 'home network shares one account; visitors from the internet must sign in'}`);
  console.log(`  Search:    ${TMDB_TOKEN || TMDB_KEY ? 'ready' : 'off (add TMDB_TOKEN to .env)'}`);
  console.log(`  Library:   ${MEDIA_DIR || 'off (add MEDIA_DIR to .env)'}`);
  if (PREVIEW_DIR) console.log(`  Preview:   ${PREVIEW_DIR} (open /preview to try it, /preview/off to leave)`);
  else if (preview.previewProblem()) console.log(`  ! ${preview.previewProblem()}`);
  console.log(`  Downloads: ${QBIT_URL ? `${QBIT_URL}${REMOVE_FINISHED ? ', finished downloads removed (no seeding)' : ''}` : 'off (add QBIT_URL to .env)'}`);
  console.log(`  Torrents:  ${torrents.torrentsEnabled() ? 'search on (1337x + The Pirate Bay)' : 'off (TORRENTS=off)'}`);
  console.log(`  Subtitles: ${subtitles.subtitlesConfigured() ? 'OpenSubtitles on' : 'off (add OPENSUBTITLES_API_KEY to .env)'}${subsync.autoSyncEnabled() ? ', timing auto-fix on' : ''}`);
  console.log(`  TVs will stream from: http://${LAN_IP}:${PORT} (set SERVER_IP in .env if this is wrong)`);
  for (const w of checkConfig(process.env).filter((c) => c.level !== 'info')) console.warn(`  ! ${w.message}. ${w.fix}`);
});

// Docker and service managers stop Marquee with SIGTERM. Open live-update streams would keep
// server.close() waiting forever, so connections are closed too. qBittorrent keeps downloading;
// an interrupted conversion starts over on the next run.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`Marquee stopping (${signal})`);
    server.close();
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 300).unref();
  });
}
