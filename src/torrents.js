// Compatibility-only release metadata parsers used by existing tests and import logic.
// This module never contacts public torrent indexes or resolves their links.
import { X1337_ADULT_SUBS, tpbAdultCategory } from './content-filter.js';

const TPB_TRACKERS = [];
const TPB_CATS = {
  movie: new Set(['201', '202', '207', '209', '211']),
  tv: new Set(['205', '208', '212']),
};
const X_PATH = /^\\/torrent\\/\\d+\\/[^/?#"<>\\s]+\\/?$/;
export const torrentsEnabled = () => false;
export const torrentQueryAllowed = (q) => String(q || '').length >= 2 || /^\\d$/.test(String(q || ''));
class TorrentError extends Error { constructor(status, message) { super(message); this.status = status; } }

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
    : /\b(1440p|qhd|2560\s*[x×]\s*1440)\b/i.test(name) ? '1440p'
    : /\b1080p\b|\b1920\s*[x×]\s*10[78]\d\b/i.test(name) ? '1080p'
    : /\b720p\b|\b1280\s*[x×]\s*720\b/i.test(name) ? '720p'
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
    .filter((t) => !tpbAdultCategory(t.category))
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
export function parse1337x(html) {
  const out = [];
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const link = /<a href="(\/torrent\/\d+\/[^"]+)"[^>]*>([^<]+)<\/a>/i.exec(row);
    if (!link || !X_PATH.test(link[1])) continue;
    const cell = (cls) => new RegExp(`class="${cls}[^"]*"[^>]*>(?:<a[^>]*>)?([^<]*)`, 'i').exec(row)?.[1] ?? '';
    const name = decode(link[2]);
    const sub = /href="\/sub\/(\d+)\//i.exec(row)?.[1] || null;
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
      adult: Boolean(sub && X1337_ADULT_SUBS.has(sub)),
      ...describe(name),
    });
  }
  return out;
}
export function parseMagnet(html) {
  const m = /href="(magnet:\?xt=urn:btih:[^"]+)"/i.exec(html);
  return m ? decode(m[1]) : null;
}
export async function magnetFor1337x() {
  throw new TorrentError(503, 'Third-party torrent index lookup is unavailable.');
}
export function parseNyaa(html) {
  const out = [];
  for (const row of String(html).split(/<tr\b/i).slice(1)) {
    const cls = /^[^>]*class="([^"]*)"/i.exec(row)?.[1] || '';
    const category = /href="\/\?c=(\d_\d)"/i.exec(row)?.[1] || '';
    const link = /<a href="\/view\/(\d+)"[^>]*title="([^"]+)"/i.exec(row);
    const magnet = /href="(magnet:\?xt=urn:btih:[^"]+)"/i.exec(row)?.[1];
    if (!link || !magnet) continue;
    const cells = [...row.matchAll(/<td class="text-center"[^>]*>([^<]*)<\/td>/gi)].map((m) => m[1].trim());
    const stamp = Number(/data-timestamp="(\d+)"/i.exec(row)?.[1]) || null;
    const name = decode(link[2]);
    // cells: size, date, seeders, leechers, downloads (the link cell has no plain text)
    const size = cells.find((c) => /\d\s*(?:[KMGT]i?B|Bytes)$/i.test(c));
    const nums = cells.filter((c) => /^\d+$/.test(c)).map(Number);
    out.push({
      source: 'nyaa',
      id: `nyaa:${link[1]}`,
      name,
      seeders: nums[0] || 0,
      leechers: nums[1] || 0,
      size: parseSize(size),
      added: stamp ? stamp * 1000 : null,
      addedText: null,
      uploader: null,
      trusted: /\bsuccess\b/.test(cls),
      remake: /\bdanger\b/.test(cls),
      category,
      magnet: decode(magnet),
      ...describe(name),
    });
  }
  return out;
}
export function parseKnaben(json) {
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  return hits
    .filter((t) => t && /^[a-f0-9]{40}$/i.test(t.hash || '') && t.title)
    .filter((t) => /^(movies|tv|anime)\b/i.test(t.category || ''))
    .map((t) => {
      const name = String(t.title);
      const hash = t.hash.toLowerCase();
      const added = Date.parse(t.date);
      const magnet = /^magnet:\?xt=urn:btih:/i.test(t.magnetUrl || '') ? t.magnetUrl : magnetFor(hash, name);
      const seeders = Math.max(Number(t.liveSeeders) || 0, Number(t.seeders) || 0);
      const leechers = Math.max(Number(t.livePeers) || 0, Number(t.peers) || 0);
      return {
        source: 'knaben',
        id: `knaben:${hash}`,
        name,
        seeders,
        leechers,
        size: Number(t.bytes) || null,
        added: Number.isFinite(added) ? added : null,
        addedText: null,
        uploader: null,
        trusted: false,
        magnet,
        ...describe(name),
      };
    });
}

export const plainQuery = (q) => String(q).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
export async function searchTorrents() {
  throw new TorrentError(503, 'Built-in torrent discovery is not available. Import media you own or use an authorized torrent link.');
}
