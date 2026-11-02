// Marquee: self-hosted media server for phones, browsers and TVs.
// No dependencies. Requires Node.js 20+.
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
import * as subsync from './subsync.js';
import * as activity from './activity.js';
import * as house from './house.js';
import * as clips from './clips.js';
import * as invites from './invites.js';
import * as shows from './shows.js';
import * as season from './season.js';
import * as accounts from './accounts.js';
import { isHomeRequest, describeRequest } from './network.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 8080;
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
      if (/^169\.254\./.test(a.address) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue;
      return a.address;
    }
  }
  return '127.0.0.1';
}
const LAN_IP = lanAddress();
activity.initActivity({ dataDir: ROOT });
accounts.initAccounts({ dataDir: ROOT, adminEmails: activity.adminEmails(), mediaDir: MEDIA_DIR });
house.initHouse({
  dataDir: ROOT,
  mediaDir: MEDIA_DIR,
  clipsDir: process.env.CLIPS_DIR ? path.resolve(process.env.CLIPS_DIR) : null,
  qbitCheck: QBIT_URL ? async () => (await qbitRequest('/api/v2/app/version')).ok : null,
});
shows.initShows({ dataDir: ROOT });
clips.initClips({ dataDir: ROOT, getEncoder: () => converter.converterStatus().encoder });
invites.initInvites({ dataDir: ROOT, onEvent: activity.record });
cast.initCasting({ lanIp: LAN_IP });
subsync.initSubsync({ dataDir: ROOT, audioShift: (video) => converter.syncState(video).shift });
subtitles.initSubtitles({
  dataDir: ROOT,
  // Downloaded subtitles get their timing checked in the background, unless they were made for this exact file.
  onDownload: (video, srt, { exact }) => {
    if (exact) subsync.markExact(srt);
    else if (subsync.autoSyncEnabled()) subsync.queueSync(srt, video);
  },
});

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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


// ---------- file-name parsing ----------
// "The.Matrix.1999.1080p.BluRay.x264.mkv" -> { title: "The Matrix", year: 1999 }
// "Severance.S02E03.1080p.mkv"           -> { title: "Severance", season: 2, episode: 3 }
// Also "S01E01E02" (first episode counts), "1x05" and "Season 1 Episode 5". A name that starts with
// the episode ("S01E05.1080p.mkv") gets an empty title; the library takes the folder's name then.
const EPISODE_PATTERNS = [
  /\bS(\d{1,2})\s?E(\d{1,3})(?=\b|E\d)/i,
  /\bSeason\s?(\d{1,2})\s?Episode\s?(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/i,
];
function parseName(raw, { file = true, allowEmpty = false } = {}) {
  let name = (file ? raw.replace(/\.[a-z0-9]{2,4}$/i, '') : raw).replace(/[._]+/g, ' ');
  const ep = EPISODE_PATTERNS.map((re) => name.match(re)).find(Boolean);
  // The last year-like number wins: "Blade Runner 2049 2017" -> 2017.
  const year = [...name.matchAll(/[\s(\[]((?:19|20)\d{2})(?=[\s)\]]|$)/g)].at(-1);
  const cutAt = [ep?.index, year?.index,
    name.search(/\b(2160p|1080p|720p|480p|4k|uhd|bluray|brrip|web[- ]?dl|webrip|hdtv|dvdrip|x26[45]|h ?26[45]|hevc|remux)\b/i)]
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
  return parsed;
}

// ---------- TMDB ----------
async function tmdb(endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('language', TMDB_LANG);
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

// ---------- discover ----------
const tmdbCache = new Map(); // key -> { at, promise }
function cachedTmdb(endpoint, params = {}, ttl = 30 * 60 * 1000) {
  const key = endpoint + JSON.stringify(params);
  const hit = tmdbCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = tmdb(endpoint, params);
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
    rows: rows.map(([key, title], i) => ({ key, title, items: lists[i]?.results || [] })).filter((r) => r.items.length),
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

// ---------- library ----------
let libraryCache = { at: 0, items: [] };

async function scanLibrary() {
  if (!MEDIA_DIR) return null;
  if (Date.now() - libraryCache.at < 30_000) return libraryCache.items;

  const items = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
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

async function qbitLogin() {
  const body = new URLSearchParams({
    username: process.env.QBIT_USER || '',
    password: process.env.QBIT_PASS || '',
  });
  const r = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
    method: 'POST', body, headers: { Referer: QBIT_URL }, signal: AbortSignal.timeout(5000),
  });
  const text = (await r.text()).trim();
  if (r.status === 403) {
    throw new HttpError(502, 'qBittorrent has temporarily blocked sign-ins after too many failed attempts. Restart qBittorrent to clear it.');
  }
  // Older versions reply "Ok.", newer ones 204; "Fails." means bad credentials.
  if (!r.ok || /^fails/i.test(text)) {
    throw new HttpError(502, 'Could not sign in to qBittorrent. Check QBIT_USER and QBIT_PASS in .env.');
  }
  const cookie = (r.headers.getSetCookie?.() || [])[0]?.split(';')[0];
  if (cookie) qbitCookie = cookie; // absent when localhost auth bypass is enabled
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

const qbit = async (endpoint) => (await qbitRequest(endpoint)).json();

// Adds a magnet link, .torrent URL or uploaded .torrent file. `user` is who it's for: the torrent is
// tagged marquee-u<id> (and a magnet's infohash recorded) so it lands in their library when it finishes.
async function addDownload({ link, file, user = null, name = '' }) {
  const form = new FormData();
  if (user) {
    form.append('tags', accounts.tagFor(user.id));
    if (link) accounts.recordTorrent(accounts.magnetHash(link), user.id, name);
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
}

// Episodes of a show's season that are already here: in the library, or in qBittorrent (an episode,
// or a season pack, which counts as every episode). Episodes already on the server go straight into
// `user`'s library instead of being downloaded twice.
async function haveEpisodes(key, seasonNo, user = null) {
  const have = new Set();
  await scanLibrary();
  for (const i of libraryCache.all || []) {
    if (i.season === seasonNo && i.episode != null && shows.showKey(i.title) === key) {
      have.add(i.episode);
      if (user) accounts.addEntry(user.id, accounts.mediaKey(i.full), 'added');
    }
  }
  let list = [];
  try { list = await qbit('/api/v2/torrents/info'); } catch { /* qBittorrent down: library only */ }
  for (const t of list) {
    const n = parseName(t.name);
    if (shows.showKey(n.title) !== key) continue;
    if (n.season === seasonNo && n.episode != null) have.add(n.episode);
    const pack = new RegExp(`\\bS0?${seasonNo}\\b(?!\\s?E\\d)|\\bseason\\s?0?${seasonNo}\\b`, 'i').test(t.name.replace(/[._]+/g, ' '));
    if (n.season == null && pack) for (let e = 1; e <= 99; e++) have.add(e);
  }
  return have;
}

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'That file is too large for a .torrent.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const validHash = (h) => /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(h);

// Who a torrent is for: recorded when it was added through Marquee, or its marquee-u<id> tag.
// Torrents added straight in qBittorrent belong to the owner.
const torrentOwner = (t) => accounts.torrentRow(t.hash)?.user_id ?? accounts.userFromTags(t.tags) ?? accounts.ownerUser()?.id ?? null;

// The user's own downloads; `all` (the owner only) lists everyone's, with whose each one is.
async function listDownloads(user, all = false) {
  const torrents = await qbit('/api/v2/torrents/info?sort=added_on&reverse=true');
  const names = new Map();
  const nameOf = (id) => {
    if (!names.has(id)) names.set(id, id == null ? null : accounts.userById(id)?.name || null);
    return names.get(id);
  };
  const owned = torrents.map((t) => [t, torrentOwner(t)]).filter(([, owner]) => all || owner === user.id);
  return owned.map(([t, owner]) => ({
    hash: t.hash,
    owner: all ? nameOf(owner) : undefined,
    mine: owner === user.id,
    name: t.name,
    ...parseName(t.name),
    progress: t.progress,
    speed: t.dlspeed,
    eta: t.eta >= 8640000 ? null : t.eta,
    size: t.size,
    state: t.state,
    done: t.progress >= 1,
    converting: convertingIn(t),
    subs: subtitles.subtitleWants(t.hash),
  }));
}

// True while the converter is making the MP4 copy of a video from this download.
function convertingIn(t) {
  const file = converter.convertingFile();
  if (!file || !converter.needsConversion(file) || !t.content_path) return false;
  return samePath(file, t.content_path) || isInside(file, t.content_path);
}

async function downloadSource(hash) {
  if (!validHash(hash)) throw new HttpError(400, 'Invalid download.');
  const [info] = await qbit(`/api/v2/torrents/info?hashes=${hash}`);
  if (!info) throw new HttpError(404, 'That download no longer exists.');
  const files = await qbit(`/api/v2/torrents/files?hash=${hash}`);
  const video = files
    .filter((f) => VIDEO_EXT.has(path.extname(f.name).toLowerCase()) && !/\bsample\b/i.test(f.name))
    .sort((a, b) => b.size - a.size)[0];
  if (!video) throw new HttpError(404, 'This download has no playable video file.');
  if (video.progress < 1) throw new HttpError(409, 'This video hasn’t finished downloading yet.');
  return path.join(info.save_path, video.name);
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
// ---------- signed stream links ----------
// AirPlay and Chromecast hand the video URL to the TV, which fetches it itself and can't
// sign in to Cloudflare Access. /play/ links carry an expiring signature instead, so only
// that one file can be fetched, and only for a limited time.
const PLAY_LINK_HOURS = 12;
const streamSecret = (() => {
  if (process.env.STREAM_SECRET) return process.env.STREAM_SECRET;
  const file = path.join(ROOT, '.marquee-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(file, secret); } catch { /* links then only last until restart */ }
  return secret;
})();
const signPlay = (kind, id, variant, exp) => crypto.createHmac('sha256', streamSecret)
  .update(`${kind}|${id}|${variant}|${exp}`).digest('base64url').slice(0, 32);

// variant "browser" = the copy with browser-friendly audio; "tv" = original audio for TVs.
async function streamFile(kind, id, variant) {
  const browser = variant === 'browser';
  if (kind === 'lib') return browser ? converter.preferConverted(librarySource(id), { browser: true }) : libraryPath(id);
  if (kind === 'dl') {
    if (!validHash(id)) throw new HttpError(400, 'Invalid download.');
    return browser ? converter.preferConverted(await downloadSource(id), { browser: true }) : downloadPath(id);
  }
  throw new HttpError(400, 'Unknown media type.');
}

async function playLink(kind, id, variant) {
  if (!['browser', 'tv'].includes(variant)) throw new HttpError(400, 'Unknown variant.');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, 'Invalid file.');
  const file = await streamFile(kind, id, variant);
  if (!fs.existsSync(file)) throw new HttpError(404, 'That file is no longer on the server.');
  const exp = Math.floor(Date.now() / 1000) + PLAY_LINK_HOURS * 3600;
  const name = path.basename(file);
  return {
    url: `/play/${kind}/${id}/${variant}/${exp}/${signPlay(kind, id, variant, exp)}/${encodeURIComponent(name)}`,
    name,
    ext: path.extname(name).slice(1).toLowerCase(),
  };
}

async function handlePlay(req, res, url) {
  const m = url.pathname.match(/^\/play\/(lib|dl)\/([A-Za-z0-9_-]+)\/(browser|tv)\/(\d+)\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/);
  if (!m) throw new HttpError(404, 'Not found.');
  const [, kind, id, variant, exp, sig] = m;
  const expected = signPlay(kind, id, variant, exp);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new HttpError(403, 'Invalid link.');
  }
  if (Number(exp) < Date.now() / 1000) throw new HttpError(410, 'This link has expired. Start playback again.');
  return sendVideo(req, res, await streamFile(kind, id, variant));
}

// Title, year and episode used for subtitle searches.
const infoFor = (file) => parseFile(file);

// ---------- streaming (HTTP range requests) ----------
async function sendVideo(req, res, file, { captionUrl } = {}) {
  let stat;
  try { stat = await fs.promises.stat(file); } catch { throw new HttpError(404, 'That file is no longer on the server.'); }
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
  pipeline(fs.createReadStream(file, { start, end }), res, () => {}); // aborted by seeks; safe to ignore
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
async function resolveMedia(kind, id, subLang = null) {
  const file = converter.preferConverted(await sourceFile(kind, id));
  let stat;
  try { stat = await fs.promises.stat(file); } catch { throw new HttpError(404, 'That file is no longer on the server.'); }
  const name = path.basename(file);
  const ext = path.extname(name).slice(1).toLowerCase();
  const info = parseName(name);
  const episode = info.season != null ? `S${String(info.season).padStart(2, '0')} E${String(info.episode).padStart(2, '0')}` : null;
  let subUrl = null;
  if (subLang) {
    await subtitles.ensureSubtitle(file, infoFor(file), subLang);
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

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new HttpError(413, 'Request too large.');
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

function titleOf(file) {
  const info = parseName(path.basename(file));
  const ep = info.season != null ? ` S${String(info.season).padStart(2, '0')} E${String(info.episode).padStart(2, '0')}` : '';
  return `${info.title}${info.year && !ep ? ` (${info.year})` : ''}${ep}`;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  let m;

  // House reports from the laptop/desktop (token + home network only; see house.js). Handled before
  // activity.seen() so the machines don't show up as people in the Activity tab.
  if (p === '/api/house/report') {
    if (!house.agentAllowed(req)) throw new HttpError(403, 'Not allowed.');
    house.acceptReport(req, await readJson(req));
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/house/summary') {
    if (!house.agentAllowed(req) && !activity.isAdmin(req)) throw new HttpError(403, 'Not allowed.');
    return sendJson(res, 200, await house.houseSummary());
  }
  // `marquee-house boot` (root, on a dual-boot machine): reports its boot menu + network card and
  // gets back whether to restart, and into what (house.js, "power").
  if (p === '/api/house/boot' && req.method === 'POST') {
    if (!house.agentAllowed(req)) throw new HttpError(403, 'Not allowed.');
    return sendJson(res, 200, house.bootPoll(req, await readJson(req)));
  }

  activity.seen(req);
  const user = accounts.userFor(req);

  // ---- the signed-in person: profile, preferences, watch progress ----
  if (p === '/api/me') {
    if (req.method === 'POST') {
      const next = accounts.updateMe(user, await readJson(req));
      return sendJson(res, 200, { me: accounts.publicUser(next) });
    }
    return sendJson(res, 200, { me: accounts.publicUser(user) });
  }
  if (p === '/api/me/progress') {
    if (req.method === 'POST') {
      const { ref, time, duration } = await readJson(req);
      accounts.saveProgress(user.id, ref, time, duration);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, { progress: accounts.progressOf(user.id) });
  }
  // ---- the owner's settings: server rules and people ----
  if (p.startsWith('/api/admin/')) {
    if (!user.isOwner) throw new HttpError(403, 'Only the server’s owner can change this.');
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
    if ((m = p.match(/^\/api\/admin\/users\/(\d+)$/)) && req.method === 'POST') {
      const body = await readJson(req);
      const u = accounts.updateUser(Number(m[1]), body);
      if ('canDownload' in body) activity.record(req, 'permission', `${u.name} ${body.canDownload ? 'can' : 'can’t'} download`);
      if ('keep' in body) activity.record(req, 'permission', `${u.name}’s videos ${body.keep ? 'are never auto-deleted' : 'are auto-deleted again'}`);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Unknown admin route.');
  }

  if (p === '/api/house') {
    if (!activity.isAdmin(req)) throw new HttpError(403, 'Only the server’s owner can see the house.');
    return sendJson(res, 200, await house.houseReport());
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
      return sendJson(res, 200, { configured: true, members, error, owners: activity.adminEmails(), invites: invites.listInvites() });
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
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/keyframes$/))) return sendJson(res, 200, await clips.trimInfo(m[1]));
    if ((m = p.match(/^\/api\/clips\/([\w-]{16})\/trim$/)) && req.method === 'POST') {
      const { start, end, deleteOriginal } = await readJson(req);
      const r = await clips.trim(m[1], start, end, { deleteOriginal: Boolean(deleteOriginal) });
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
      me: accounts.publicUser(user),
      rules: accounts.serverSettings(),
      subLangs: subtitles.subtitleLanguages(),
    });
  }
  if (p === '/api/convert') return sendJson(res, 200, converter.converterStatus());
  if (p === '/api/discover/home') {
    return sendJson(res, 200, await discoverHome(url.searchParams.get('type') || 'all'));
  }
  if (p === '/api/discover/list') {
    const page = Math.max(1, Math.min(500, Number(url.searchParams.get('page')) || 1));
    return sendJson(res, 200, await discoverList(url.searchParams.get('key'), page));
  }
  // A show's seasons (TMDB), for the season chips in the details and show sheets.
  if ((m = p.match(/^\/api\/tv\/(\d+)\/seasons$/))) {
    const d = await cachedTmdb(`/tv/${m[1]}`, {}, 6 * 3600 * 1000);
    const today = new Date().toISOString().slice(0, 10);
    return sendJson(res, 200, {
      seasons: (d.seasons || []).filter((x) => x.season_number > 0).map((x) => ({
        number: x.season_number,
        name: x.name || `Season ${x.season_number}`,
        episodes: x.episode_count || null,
        upcoming: !x.air_date || x.air_date > today,
      })),
    });
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
    if (!q) return sendJson(res, 200, { results: [] });
    const data = await tmdb('/search/multi', { query: q, include_adult: 'false' });
    return sendJson(res, 200, { results: data.results.filter(onlyScreen).map((x) => mapTitle(x)) });
  }
  if (p === '/api/library') {
    const items = await scanLibrary();
    if (!items) throw new HttpError(503, 'No media folder is set up. Add MEDIA_DIR to .env and restart.');
    // A video whose MP4 copy is being made can't be played yet (the player disables Play).
    const converting = converter.convertingFile();
    // Episodes are grouped into shows and seasons (TMDB posters and episode names when it answers in time).
    const tmdbOn = Boolean(TMDB_TOKEN || TMDB_KEY);
    const [{ shows: showList, showOf }, filmOf] = await Promise.all([
      shows.groupShows(items, tmdbOn ? tmdb : null),
      shows.filmInfo(items, tmdbOn ? tmdb : null), // posters for films
    ]);
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
      if (!entry) { server.push(base); continue; }
      own.push({
        ...base,
        converting: Boolean(converting) && converting === full && converter.needsConversion(full),
        source: entry.source,
        addedAt: entry.addedAt,
        expiresAt: autoDelete ? entry.expiresAt : null,
        extensions: entry.extensions,
      });
    }
    const myShows = new Set([...own, ...server].map((i) => i.show).filter(Boolean));
    return sendJson(res, 200, { items: own, server, shows: showList.filter((s) => myShows.has(s.id)) });
  }
  // Add videos already on the server to your library (no copy is made).
  if (p === '/api/library/add' && req.method === 'POST') {
    const ids = [].concat((await readJson(req)).ids || []).map(String).slice(0, 500);
    let added = 0;
    for (const id of ids) {
      const full = librarySource(id);
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
  if ((p === '/api/downloads/add' || p === '/api/downloads/season') && !user.canDownload) {
    throw new HttpError(403, 'The server’s owner hasn’t turned on downloads for you. Ask them, or add things that are already on the server.');
  }
  if (p === '/api/downloads/add' && req.method === 'POST') {
    if (/application\/json/i.test(req.headers['content-type'] || '')) {
      const body = await readJson(req);
      const dn = /[?&]dn=([^&]+)/.exec(String(body.link || ''))?.[1];
      let name = String(body.name || '');
      if (!name && dn) { try { name = decodeURIComponent(dn.replace(/\+/g, ' ')); } catch { name = dn; } }
      await addDownload({ link: body.link, user, name });
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
  // ---- a whole season, episode by episode (see season.js) ----
  if (p === '/api/downloads/season' && req.method === 'POST') {
    if (!QBIT_URL) throw new HttpError(503, 'Downloads aren’t connected. Add QBIT_URL to .env and restart.');
    const body = await readJson(req);
    const want = season.parseSeasonQuery(body.query);
    if (!want) throw new HttpError(400, 'Search for a show and a season, like “South Park S18”.');
    const id = season.startSeasonJob({
      ...want,
      quality: String(body.quality || ''),
      subs: Array.isArray(body.subs) ? body.subs.map(String).slice(0, 3) : [],
    }, {
      parseName, tmdb: TMDB_TOKEN || TMDB_KEY ? tmdb : null, seasonEpisodes: shows.seasonEpisodes,
      searchTorrents: torrents.searchTorrents, magnetFor1337x: torrents.magnetFor1337x,
      addDownload: (opts) => addDownload({ ...opts, user }),
      wantSubtitles: (link, subs, name) => { subtitles.wantSubtitles(link, subs, name); setTimeout(checkSubtitleWants, 30_000); },
      haveEpisodes: (key, seasonNo) => haveEpisodes(key, seasonNo, user), log: (msg) => console.log(msg),
    });
    activity.record(req, 'download', `${want.title} season ${want.season}, episode by episode`);
    return sendJson(res, 200, { id });
  }
  if ((m = p.match(/^\/api\/downloads\/season\/([a-f0-9]{12})$/))) {
    const job = season.seasonJob(m[1]);
    if (!job) throw new HttpError(404, 'That season download is no longer tracked.');
    return sendJson(res, 200, job);
  }
  // ---- torrent search ----
  if (p === '/api/torrents/search') {
    return sendJson(res, 200, await torrents.searchTorrents(url.searchParams.get('q'), url.searchParams.get('type')));
  }
  if (p === '/api/torrents/magnet') {
    return sendJson(res, 200, { magnet: await torrents.magnetFor1337x(url.searchParams.get('ref')) });
  }
  if (p === '/api/downloads') {
    return sendJson(res, 200, { items: await listDownloads(user, user.isOwner && url.searchParams.get('all') === '1') });
  }
  if ((m = p.match(/^\/api\/downloads\/([a-f0-9]{40}|[a-f0-9]{64})\/(pause|resume|delete)$/i)) && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const [t] = await qbit(`/api/v2/torrents/info?hashes=${m[1]}`);
    if (!t) throw new HttpError(404, 'That download no longer exists.');
    if (!user.isOwner && torrentOwner(t) !== user.id) throw new HttpError(403, 'That’s someone else’s download.');
    if (m[2] === 'delete') {
      await deleteDownload(t, body.files !== false);
      activity.record(req, 'delete', `${t.name}${body.files === false ? ' (download only, files kept)' : ''}`);
    } else {
      await setPaused(t.hash, m[2] === 'pause');
      activity.record(req, m[2], t.name);
    }
    return sendJson(res, 200, { ok: true });
  }
  // ---- casting ----
  if (p === '/api/play-link') {
    const q = url.searchParams;
    const link = await playLink(q.get('kind') || '', q.get('id') || '', q.get('variant') || 'browser');
    activity.record(req, 'play', titleOf(link.name), { quietMs: 3 * 3600 * 1000 });
    return sendJson(res, 200, link);
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
      return sendJson(res, 200, await subtitles.languagesForFile(file, infoFor(file)));
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
    await subtitles.ensureSubtitle(file, infoFor(file), lang);
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
    res.writeHead(200, {
      'Content-Type': vtt ? 'text/vtt; charset=utf-8' : 'text/srt; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(req.method === 'HEAD' ? undefined : vtt ? subtitles.srtToVtt(text) : text);
  }

  // ---- browser audio compatibility ----
  if ((m = p.match(/^\/api\/media\/(lib|dl)\/([A-Za-z0-9_-]+)\/audio$/))) {
    const source = await sourceFile(m[1], m[2]);
    const served = converter.preferConverted(source, { browser: true });
    let tracks = null;
    let vid = null;
    try { [tracks, vid] = await Promise.all([converter.probeAudio(served), converter.probeVideo(served)]); } catch { /* unreadable: say nothing */ }
    if (!tracks) return sendJson(res, 200, { known: false });
    // Extra codecs the client reports it can decode (e.g. Edge with Dolby, Chrome with HEVC).
    const plays = new Set((url.searchParams.get('plays') || '').split(',').filter(Boolean));
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
      known: true, codec: main, tracks, browserSafe, aligned,
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
    const others = accounts.holders(key).filter((u) => u !== user.id).length;
    return sendJson(res, 200, { ...(await deleteInfo(id)), others, canDeleteForEveryone: user.isOwner && others > 0 });
  }
  if (p === '/api/library/delete' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const key = accounts.mediaKey(librarySource(id));
    const everyone = Boolean(body.everyone) && user.isOwner;
    if (!everyone && !accounts.libraryOf(user.id).has(key) && !user.isOwner) throw new HttpError(403, 'That isn’t in your library.');
    let what = id;
    try { what = titleOf((await deletePlan(id)).original); } catch { /* named by id */ }
    const heldByOthers = (k) => accounts.holders(k).some((u) => u !== user.id);
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
    for (const file of await deleteMedia(id, scope)) {
      const k = accounts.mediaKey(file);
      if (k) { accounts.removeAll(k); accounts.markGone(k); }
    }
    activity.record(req, 'delete', `${what}${scope === 'torrent' ? ' (whole download)' : ''}${everyone ? ' for everyone' : ''}`);
    return sendJson(res, 200, { ok: true });
  }

  // A /sub-<lang>/ segment means the TV was sent subtitles; advertise them via CaptionInfo.sec.
  const caption = (kind, id, lang) => (lang ? { captionUrl: `http://${LAN_IP}:${PORT}/api/subs/file/${kind}/${id}/${lang}.srt` } : {});
  if ((m = p.match(/^\/api\/stream\/lib\/([A-Za-z0-9_-]+)(?:\/sub-([a-z-]+))?(?:\/[^/]*)?$/))) {
    const file = url.searchParams.has('browser') ? converter.preferConverted(librarySource(m[1]), { browser: true }) : libraryPath(m[1]);
    return sendVideo(req, res, file, caption('lib', m[1], m[2]));
  }
  if ((m = p.match(/^\/api\/stream\/dl\/([A-Fa-f0-9]+)(?:\/sub-([a-z-]+))?(?:\/[^/]*)?$/))) {
    const file = url.searchParams.has('browser') ? converter.preferConverted(await downloadSource(m[1]), { browser: true }) : await downloadPath(m[1]);
    return sendVideo(req, res, file, caption('dl', m[1], m[2]));
  }
  throw new HttpError(404, 'Unknown API route.');
}

// ---------- static files ----------
async function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(400, 'Bad path.');
  let data;
  try { data = await fs.promises.readFile(full); } catch { throw new HttpError(404, 'Not found.'); }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'CDN-Cache-Control': 'no-store', // keeps Cloudflare from serving an old copy after an update
  });
  res.end(data);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const allowed = req.method === 'GET' || req.method === 'HEAD'
      || (req.method === 'POST' && (url.pathname.startsWith('/api/cast/') || url.pathname === '/api/downloads/add' || url.pathname === '/api/downloads/season' || url.pathname === '/api/subs/fetch' || url.pathname === '/api/subs/sync' || url.pathname === '/api/library/delete' || /^\/api\/downloads\/\w+\/(pause|resume|delete)$/.test(url.pathname) || /^\/api\/media\/\w+\/[\w-]+\/sync$/.test(url.pathname)
        || /^\/api\/house\/(report|boot|power)$/.test(url.pathname) || /^\/api\/clips\/[\w-]+\/(share|unshare|delete|trim)$/.test(url.pathname)
        || /^\/api\/access\/(invite|remove|invite\/\w+\/revoke)$/.test(url.pathname) || /^\/c\/i\/[\w-]+\/?$/.test(url.pathname)
        || /^\/api\/(me|me\/progress|library\/add|library\/extend|admin\/settings|admin\/users\/\d+)$/.test(url.pathname)));
    if (!allowed) throw new HttpError(405, 'Method not allowed.');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (url.pathname.startsWith('/play/')) await handlePlay(req, res, url);
    // Public: shared clips and the Marquee invite card (bypassed in Cloudflare Access; see README)
    else if (url.pathname === '/c' || url.pathname.startsWith('/c/')) {
      if (!(await invites.handlePublic(req, res, url)) && !(await clips.handlePublic(req, res, url, { sendVideo }))) throw new HttpError(404, 'Not found.');
    }
    else await serveStatic(res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something broke on the server. Check the console.' : err.message });
    else res.destroy();
  }
});

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
        const files = await qbit(`/api/v2/torrents/files?hash=${t.hash}`);
        const complete = t.progress >= 1 && !BUSY_STATES.test(t.state || '');
        for (const f of files) {
          const full = path.join(t.save_path, f.name);
          if (!complete || f.progress < 1) { if (f.priority !== 0) unfinished.push(full); continue; }
          if (/\bsample\b/i.test(f.name) || !VIDEO_EXT.has(path.extname(f.name).toLowerCase())) continue;
          torrentFiles.push(full);
        }
      }
      qbitReachable = true;
    } catch { /* retried next round */ }
  }
  const isTorrentFile = (file) => torrentFiles.some((t) => samePath(t, file));
  const isUnfinished = (file) => unfinished.some((t) => samePath(t, file));

  const list = torrentFiles.map((file) => ({ file, deleteOriginal: false }));
  if (MEDIA_DIR) {
    libraryCache.at = 0;
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
    const files = await qbit(`/api/v2/torrents/files?hash=${t.hash}`);
    const all = files.map((f, i) => ({ index: f.index ?? i, full: path.join(t.save_path, f.name), size: f.size, priority: f.priority }));
    const me = all.find((f) => samePath(f.full, file));
    if (!me) continue;
    const videos = all.filter((f) => isVideo(f.full) && f.priority !== 0 && fs.existsSync(f.full));
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
      if (l.startsWith(stem) && l.endsWith('.srt')) out.push(path.join(path.dirname(file), e));
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

async function deleteMedia(id, scope) {
  const { original, torrent } = await deletePlan(id);
  if (converter.isBusy(original)) throw new HttpError(409, 'This file is being converted right now. Try again when that finishes.');
  const wholeTorrent = torrent && (scope === 'torrent' || torrent.videos.length <= 1);
  const videos = wholeTorrent ? torrent.videos.map((v) => v.full) : [original];
  if (!videos.some((v) => samePath(v, original))) videos.push(original);

  // Remove Marquee's own files first so the folder can be cleaned up.
  for (const v of videos) {
    for (const x of extrasFor(v)) removeFile(x);
    converter.forget(v);
  }
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
    }
    removeFile(original);
  }
  libraryCache.at = 0;
  // qBittorrent deletes asynchronously; clean up afterwards.
  setTimeout(() => { removeEmptyFolders(path.dirname(original)); libraryCache.at = 0; }, 4000);
  console.log(`[library] deleted ${wholeTorrent ? `torrent "${torrent.name}"` : path.basename(original)}`);
  return videos;
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
async function deleteDownload(t, withFiles) {
  if (withFiles) {
    const files = await qbit(`/api/v2/torrents/files?hash=${t.hash}`);
    const videos = files.filter((f) => isVideo(f.name)).map((f) => path.join(t.save_path, f.name));
    if (videos.some((v) => converter.isBusy(v))) throw new HttpError(409, 'A file from this download is being converted right now. Try again when that finishes.');
    for (const v of videos) {
      for (const x of extrasFor(v)) removeFile(x);
      converter.forget(v);
    }
  }
  await qbitRequest('/api/v2/torrents/delete', {
    method: 'POST', body: new URLSearchParams({ hashes: t.hash, deleteFiles: withFiles ? 'true' : 'false' }),
  });
  libraryCache.at = 0;
  if (withFiles && t.content_path) setTimeout(() => { removeEmptyFolders(path.dirname(t.content_path)); libraryCache.at = 0; }, 4000);
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
// kept, so it never seeds and uses no upload bandwidth. Downloads save into MEDIA_DIR, so the video
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
async function claimFiles() {
  if (!MEDIA_DIR) return;
  const first = !accounts.migrated();
  const torrentContent = []; // where torrents still in qBittorrent keep their files
  if (QBIT_URL) {
    try {
      for (const t of await qbit('/api/v2/torrents/info')) {
        torrentContent.push(t.content_path || path.join(t.save_path, t.name));
        let row = accounts.torrentRow(t.hash);
        if (!row) {
          accounts.recordTorrent(t.hash, accounts.userFromTags(t.tags) ?? accounts.ownerUser()?.id ?? null, t.name);
          row = accounts.torrentRow(t.hash);
        }
        if (row.claimed_at || t.progress < 1 || BUSY_STATES.test(t.state || '')) continue;
        for (const f of await qbit(`/api/v2/torrents/files?hash=${t.hash}`)) {
          const full = path.join(t.save_path, f.name);
          if (f.priority === 0 || !isVideo(full)) continue;
          // On the first run, what's already downloaded counts as being there before accounts.
          accounts.addEntry(row.user_id, accounts.mediaKey(full), first ? 'existing' : 'download');
        }
        accounts.markClaimed(t.hash);
        if (row.user_id && !first) console.log(`[accounts] "${t.name}" is in ${accounts.userById(row.user_id)?.name}’s library`);
      }
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
  if (orphaned.length) libraryCache.at = 0;
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
  dataDir: ROOT,
  onSidecar: (srt) => subsync.markTrusted(srt), // extracted from the video: already in sync
  listCandidates: conversionCandidates,
  onConverted: () => { libraryCache.at = 0; },
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Marquee is running: http://localhost:${PORT}`);
  console.log(`  Search:    ${TMDB_TOKEN || TMDB_KEY ? 'ready' : 'off (add TMDB_TOKEN to .env)'}`);
  console.log(`  Library:   ${MEDIA_DIR || 'off (add MEDIA_DIR to .env)'}`);
  console.log(`  Downloads: ${QBIT_URL ? `${QBIT_URL}${REMOVE_FINISHED ? ', finished downloads removed (no seeding)' : ''}` : 'off (add QBIT_URL to .env)'}`);
  console.log(`  Torrents:  ${torrents.torrentsEnabled() ? 'search on (1337x + The Pirate Bay)' : 'off (TORRENTS=off)'}`);
  console.log(`  Subtitles: ${subtitles.subtitlesConfigured() ? 'OpenSubtitles on' : 'off (add OPENSUBTITLES_API_KEY to .env)'}${subsync.autoSyncEnabled() ? ', timing auto-fix on' : ''}`);
  console.log(`  TVs will stream from: http://${LAN_IP}:${PORT} (set SERVER_IP in .env if this is wrong)`);
});
