// Torrent search across The Pirate Bay (apibay JSON API) and 1337x (HTML).
// Sources are queried in parallel; results from a working source are returned even if the other fails.

const TPB_API = (process.env.TPB_API || 'https://apibay.org').replace(/\/+$/, '');
// 1337x mirrors, tried in order.
const X1337_MIRRORS = (process.env.X1337_URL || 'https://1337x.to,https://1337x.st,https://x1337x.ws,https://x1337x.eu,https://x1337x.se')
  .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter((u) => /^https?:\/\//i.test(u));
const FLARESOLVERR_URL = (process.env.FLARESOLVERR_URL || '').replace(/\/+$/, '');
const ENABLED = (process.env.TORRENTS || 'on').toLowerCase() !== 'off';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const CACHE_MS = 5 * 60 * 1000;

// apibay returns only the info hash; these are the trackers TPB adds to its magnets.
const TPB_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969',
  'udp://open.demonii.com:1337/announce',
];
// apibay categories: 201 Movies, 202 DVDR, 207 HD Movies, 209 3D, 211 UHD Movies / 205 TV, 208 HD TV, 212 UHD TV
const TPB_CATS = {
  movie: new Set(['201', '202', '207', '209', '211']),
  tv: new Set(['205', '208', '212']),
};

const searchCache = new Map(); // key -> { at, data }
const magnetCache = new Map(); // 1337x path -> magnet

export const torrentsEnabled = () => ENABLED;

class TorrentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function get(url, what, extraHeaders = {}) {
  let r;
  try {
    r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.8', ...extraHeaders },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? `${what} took too long to answer.` : `Couldn’t reach ${what}. It may be down or blocked by your internet provider.`);
  }
  const text = await r.text();
  if ((r.status === 403 || r.status === 503 || r.status === 429) && /cloudflare|just a moment|cf-chl|challenge-platform/i.test(text)) {
    throw Object.assign(new Error(`${what} is showing a Cloudflare check.`), { cloudflare: true });
  }
  if (!r.ok) throw new Error(`${what} responded with ${r.status}.`);
  return text;
}

// ---------- helpers ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
}).trim();

function parseSize(text) {
  const m = /([\d.,]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i.exec(text || '');
  if (!m) return null;
  const pow = { b: 0, kb: 1, mb: 2, gb: 3, tb: 4 }[m[2].toLowerCase().replace('i', '')];
  return Math.round(Number(m[1].replace(/,/g, '')) * 1024 ** pow);
}

// Quality and tags parsed from the release name.
function describe(name) {
  const quality = /\b(2160p|4k|uhd)\b/i.test(name) ? '2160p'
    : /\b1080p\b/i.test(name) ? '1080p'
    : /\b720p\b/i.test(name) ? '720p'
    : /\b(480p|dvdrip|xvid|sd)\b/i.test(name) ? 'SD' : null;
  const tags = [];
  if (/\b(x265|h\.?265|hevc)\b/i.test(name)) tags.push('HEVC');
  if (/\bhdr(10)?\b|\bdolby ?vision\b|\bdv\b/i.test(name)) tags.push('HDR');
  if (/\bremux\b/i.test(name)) tags.push('Remux');
  // Cinema recordings are flagged and sorted last.
  const cam = /\b(cam|camrip|hdcam|ts|telesync|hdts|tc|telecine)\b/i.test(name);
  return { quality, tags, cam };
}

const magnetFor = (hash, name) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${TPB_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;

// ---------- The Pirate Bay ----------
export function parseTpb(json, type) {
  const list = Array.isArray(json) ? json : [];
  return list
    .filter((t) => t && /^[a-f0-9]{40}$/i.test(t.info_hash) && !/^0+$/.test(t.info_hash)) // skip "no results" row
    .filter((t) => String(t.category || '').startsWith('2'))                               // video only
    .filter((t) => !TPB_CATS[type] || TPB_CATS[type].has(String(t.category)))
    .map((t) => ({
      source: 'tpb',
      id: `tpb:${t.info_hash.toLowerCase()}`,
      name: t.name,
      seeders: Number(t.seeders) || 0,
      leechers: Number(t.leechers) || 0,
      size: Number(t.size) || null,
      added: Number(t.added) ? Number(t.added) * 1000 : null,
      addedText: null,
      uploader: t.username || null,
      trusted: t.status === 'vip' || t.status === 'trusted',
      magnet: magnetFor(t.info_hash, t.name),
      ...describe(t.name),
    }));
}

async function searchTpb(q, type) {
  const text = await get(`${TPB_API}/q.php?q=${encodeURIComponent(q)}`, 'The Pirate Bay');
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('The Pirate Bay sent back something unexpected.'); }
  return parseTpb(json, type);
}

// ---------- 1337x ----------
const X_PATH = /^\/torrent\/\d+\/[^/?#"<>\s]+\/?$/;

// Cloudflare handling: try each mirror, then FlareSolverr if configured.
let goodMirror = null;   // last mirror that answered, tried first
let clearance = null;    // { host, cookie, ua } from FlareSolverr, reused until rejected

async function viaFlareSolverr(url) {
  let r;
  try {
    r = await fetch(`${FLARESOLVERR_URL}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 50000 }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error(`FlareSolverr isn’t answering at ${FLARESOLVERR_URL}. Is it running?`);
  }
  const data = await r.json().catch(() => ({}));
  if (data.status !== 'ok' || !data.solution) throw new Error(`FlareSolverr couldn’t get past the check (${data.message || r.status}).`);
  const sol = data.solution;
  if (sol.status >= 400 && !/<table/i.test(sol.response || '')) throw new Error(`1337x responded with ${sol.status} even through FlareSolverr.`);
  // Reuse the clearance cookie and user agent for direct requests.
  const cookie = (sol.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
  if (cookie) clearance = { host: new URL(url).host, cookie, ua: sol.userAgent || UA };
  return sol.response || '';
}

async function get1337x(pathAndQuery) {
  const order = goodMirror ? [goodMirror, ...X1337_MIRRORS.filter((m) => m !== goodMirror)] : X1337_MIRRORS;
  let sawCloudflare = null;
  const problems = [];
  for (const base of order) {
    const url = base + pathAndQuery;
    const host = new URL(base).host;
    const pass = clearance?.host === host ? { cookie: clearance.cookie, 'user-agent': clearance.ua } : {};
    try {
      const html = await get(url, '1337x', pass);
      goodMirror = base;
      return html;
    } catch (e) {
      if (e.cloudflare) {
        if (clearance?.host === host) clearance = null; // pass expired
        sawCloudflare ??= url;
      } else {
        problems.push(`${host}: ${e.message}`);
      }
    }
  }
  if (sawCloudflare && FLARESOLVERR_URL) {
    const html = await viaFlareSolverr(sawCloudflare);
    goodMirror = new URL(sawCloudflare).origin;
    return html;
  }
  if (sawCloudflare) {
    throw new Error('Every 1337x mirror is showing a Cloudflare check right now. Install FlareSolverr and set FLARESOLVERR_URL in .env to get past it.');
  }
  throw new Error(`No 1337x mirror answered (${problems[0] || 'unknown error'}).`);
}

export function parse1337x(html) {
  const out = [];
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const link = /<a href="(\/torrent\/\d+\/[^"]+)"[^>]*>([^<]+)<\/a>/i.exec(row);
    if (!link || !X_PATH.test(link[1])) continue;
    const cell = (cls) => new RegExp(`class="${cls}[^"]*"[^>]*>(?:<a[^>]*>)?([^<]*)`, 'i').exec(row)?.[1] ?? '';
    const name = decode(link[2]);
    const sizeText = cell('coll-4');
    out.push({
      source: '1337x',
      id: `1337x:${link[1]}`,
      name,
      seeders: Number(cell('coll-2').replace(/\D/g, '')) || 0,
      leechers: Number(cell('coll-3').replace(/\D/g, '')) || 0,
      size: parseSize(sizeText),
      added: null,
      addedText: decode(cell('coll-date')) || null,
      uploader: decode(cell('coll-5')) || null,
      trusted: /class="coll-5 vip/i.test(row),
      ref: link[1],            // detail page; the magnet is fetched on demand
      ...describe(name),
    });
  }
  return out;
}

async function search1337x(q, type) {
  const query = encodeURIComponent(q.replace(/[/\\?#]/g, ' ').trim());
  const route = type === 'movie' ? `/sort-category-search/${query}/Movies/seeders/desc/1/`
    : type === 'tv' ? `/sort-category-search/${query}/TV/seeders/desc/1/`
    : `/sort-search/${query}/seeders/desc/1/`;
  const html = await get1337x(route);
  if (!/<table/i.test(html) && !/No results were returned/i.test(html)) {
    throw new Error('1337x sent back a page it doesn’t normally show. Try again in a bit.');
  }
  return parse1337x(html);
}

export function parseMagnet(html) {
  const m = /href="(magnet:\?xt=urn:btih:[^"]+)"/i.exec(html);
  return m ? decode(m[1]) : null;
}

export async function magnetFor1337x(ref) {
  if (!X_PATH.test(String(ref || ''))) throw new TorrentError(400, 'Invalid torrent link.');
  if (magnetCache.has(ref)) return magnetCache.get(ref);
  let html;
  try { html = await get1337x(ref); } catch (e) { throw new TorrentError(502, e.message); }
  const magnet = parseMagnet(html);
  if (!magnet) throw new TorrentError(502, 'That 1337x page didn’t have a magnet link.');
  magnetCache.set(ref, magnet);
  return magnet;
}

// ---------- combined search ----------
export async function searchTorrents(rawQuery, rawType) {
  if (!ENABLED) throw new TorrentError(503, 'Torrent search is turned off (TORRENTS=off in .env).');
  const q = String(rawQuery || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const type = ['movie', 'tv'].includes(rawType) ? rawType : 'all';
  if (q.length < 2) return { results: [], problems: [] };

  const key = `${type}|${q.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const sources = [['The Pirate Bay', searchTpb(q, type)], ['1337x', search1337x(q, type)]];
  const settled = await Promise.allSettled(sources.map((s) => s[1]));
  const results = [];
  const problems = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') results.push(...s.value);
    else problems.push(`${sources[i][0]}: ${s.reason?.message || 'failed'}`);
  });
  if (!results.length && problems.length === sources.length) {
    throw new TorrentError(502, `Neither site answered. ${problems.join(' ')}`);
  }

  // Deduplicate by name, keeping the entry with more seeders.
  const byName = new Map();
  for (const r of results) {
    const k = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const prev = byName.get(k);
    if (!prev || r.seeders > prev.seeders) byName.set(k, r);
  }
  const merged = [...byName.values()].sort((a, b) => (a.cam - b.cam) || b.seeders - a.seeders).slice(0, 80);

  const data = { results: merged, problems };
  if (!problems.length) searchCache.set(key, { at: Date.now(), data }); // cache complete results only
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return data;
}
