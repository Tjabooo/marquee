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
function parseName(raw) {
  let name = raw.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
  const ep = name.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i);
  // The last year-like number wins: "Blade Runner 2049 2017" -> 2017.
  const year = [...name.matchAll(/[\s(\[]((?:19|20)\d{2})(?=[\s)\]]|$)/g)].at(-1);
  const cutAt = [ep?.index, year?.index,
    name.search(/\b(2160p|1080p|720p|480p|4k|uhd|bluray|brrip|web[- ]?dl|webrip|hdtv|dvdrip|x26[45]|h ?26[45]|hevc|remux)\b/i)]
    .filter((i) => i !== undefined && i > 0);
  let title = cutAt.length ? name.slice(0, Math.min(...cutAt)) : name;
  title = title.replace(/[\s\-([]+$/g, '').replace(/\s+/g, ' ').trim() || name.trim();
  return {
    title,
    year: year ? Number(year[1]) : null,
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
  };
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
      items.push({
        id: Buffer.from(rel).toString('base64url'),
        file: e.name,
        size: stat.size,
        added: stat.mtimeMs,
        format: ext.slice(1),
        full,
        ...parseName(e.name),
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

// Adds a magnet link, .torrent URL or uploaded .torrent file.
async function addDownload({ link, file }) {
  const form = new FormData();
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

async function listDownloads() {
  const torrents = await qbit('/api/v2/torrents/info?sort=added_on&reverse=true');
  return torrents.map((t) => ({
    hash: t.hash,
    name: t.name,
    ...parseName(t.name),
    progress: t.progress,
    speed: t.dlspeed,
    eta: t.eta >= 8640000 ? null : t.eta,
    size: t.size,
    state: t.state,
    done: t.progress >= 1,
    subs: subtitles.subtitleWants(t.hash),
  }));
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
const infoFor = (file) => parseName(path.basename(file));

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
function titleOf(file) {
  const info = parseName(path.basename(file));
  const ep = info.season != null ? ` S${String(info.season).padStart(2, '0')} E${String(info.episode).padStart(2, '0')}` : '';
  return `${info.title}${info.year && !ep ? ` (${info.year})` : ''}${ep}`;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  let m;
  activity.seen(req);

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
    return sendJson(res, 200, { items: items.map(({ full, ...rest }) => rest) });
  }
  if (p === '/api/downloads/add' && req.method === 'POST') {
    if (/application\/json/i.test(req.headers['content-type'] || '')) {
      const body = await readJson(req);
      await addDownload({ link: body.link });
      const dn = /[?&]dn=([^&]+)/.exec(String(body.link || ''))?.[1];
      let name = String(body.name || '');
      if (!name && dn) { try { name = decodeURIComponent(dn.replace(/\+/g, ' ')); } catch { name = dn; } }
      activity.record(req, 'download', name || 'a torrent link');
      // Subtitles chosen in torrent search are fetched when the download completes.
      if (Array.isArray(body.subs) && body.subs.length) {
        subtitles.wantSubtitles(String(body.link || ''), body.subs, String(body.name || ''));
        setTimeout(checkSubtitleWants, 30_000);
      }
    } else {
      const file = await readRaw(req, 10 * 1024 * 1024);
      if (!file.length) throw new HttpError(400, 'The file was empty.');
      await addDownload({ file });
      activity.record(req, 'download', 'a .torrent file');
    }
    return sendJson(res, 200, { ok: true });
  }
  // ---- torrent search ----
  if (p === '/api/torrents/search') {
    return sendJson(res, 200, await torrents.searchTorrents(url.searchParams.get('q'), url.searchParams.get('type')));
  }
  if (p === '/api/torrents/magnet') {
    return sendJson(res, 200, { magnet: await torrents.magnetFor1337x(url.searchParams.get('ref')) });
  }
  if (p === '/api/downloads') {
    return sendJson(res, 200, { items: await listDownloads() });
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
    // Timing check for a saved subtitle: GET for its state, POST { action: 'sync' | 'undo' }.
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
    const videoSafe = converter.videoBrowserSafe(vid);
    const main = tracks[0]?.codec || null;
    // Extra codecs the client reports it can decode (e.g. Edge with Dolby).
    const plays = new Set((url.searchParams.get('plays') || '').split(',').filter(Boolean));
    const browserSafe = !main || converter.BROWSER_AUDIO.has(main) || plays.has(main);
    const aligned = converter.isAligned(tracks);
    // Unplayable video or audio, or out-of-sync audio: move this file to the front of the conversion queue.
    const fix = browserSafe && aligned && videoSafe ? {} : converter.requestBrowserAudio(source);
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
  if (p === '/api/library/delete-info') {
    return sendJson(res, 200, await deleteInfo(String(url.searchParams.get('id') || '')));
  }
  if (p === '/api/library/delete' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    let what = id;
    try { what = titleOf((await deletePlan(id)).original); } catch { /* named by id */ }
    await deleteMedia(id, body.scope === 'torrent' ? 'torrent' : 'file');
    activity.record(req, 'delete', `${what}${body.scope === 'torrent' ? ' (whole download)' : ''}`);
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
      || (req.method === 'POST' && (url.pathname.startsWith('/api/cast/') || url.pathname === '/api/downloads/add' || url.pathname === '/api/subs/fetch' || url.pathname === '/api/subs/sync' || url.pathname === '/api/library/delete' || /^\/api\/media\/\w+\/[\w-]+\/sync$/.test(url.pathname)));
    if (!allowed) throw new HttpError(405, 'Method not allowed.');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (url.pathname.startsWith('/play/')) await handlePlay(req, res, url);
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
async function conversionCandidates() {
  const torrentFiles = [];
  let qbitReachable = !QBIT_URL;
  if (QBIT_URL) {
    try {
      for (const t of await qbit('/api/v2/torrents/info?filter=completed')) {
        const files = await qbit(`/api/v2/torrents/files?hash=${t.hash}`);
        for (const f of files) {
          if (f.progress < 1 || /\bsample\b/i.test(f.name)) continue;
          if (!VIDEO_EXT.has(path.extname(f.name).toLowerCase())) continue;
          torrentFiles.push(path.join(t.save_path, f.name));
        }
      }
      qbitReachable = true;
    } catch { /* retried next round */ }
  }
  const isTorrentFile = (file) => torrentFiles.some((t) => samePath(t, file));

  const list = torrentFiles.map((file) => ({ file, deleteOriginal: false }));
  if (MEDIA_DIR) {
    libraryCache.at = 0;
    await scanLibrary();
    // Without qBittorrent's file list there is no way to tell what it owns, so nothing is deleted.
    const deleteOriginal = qbitReachable && (process.env.CONVERT_DELETE_ORIGINAL || 'off').toLowerCase() === 'on';
    for (const i of libraryCache.all || []) {
      if (!isTorrentFile(i.full)) list.push({ file: i.full, deleteOriginal });
    }
  }
  return list;
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
  console.log(`  Downloads: ${QBIT_URL || 'off (add QBIT_URL to .env)'}`);
  console.log(`  Torrents:  ${torrents.torrentsEnabled() ? 'search on (1337x + The Pirate Bay)' : 'off (TORRENTS=off)'}`);
  console.log(`  Subtitles: ${subtitles.subtitlesConfigured() ? 'OpenSubtitles on' : 'off (add OPENSUBTITLES_API_KEY to .env)'}${subsync.autoSyncEnabled() ? ', timing auto-fix on' : ''}`);
  console.log(`  TVs will stream from: http://${LAN_IP}:${PORT} (set SERVER_IP in .env if this is wrong)`);
});
