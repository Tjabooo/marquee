// Lilin in someone's own Jellyfin (jellyfin/ in this repository holds the plugin).
//
// The plugin runs on the other person's Jellyfin server. It signs in like the TV app: it shows a code,
// and the person enters it in Lilin (Settings → Connect Jellyfin). The plugin then holds a key for
// that person and:
//   * reads their library from /c/jf/v1/library (films, shows and episodes with TMDB ids),
//   * writes one .strm file per video for Jellyfin to scan; each holds a stream URL signed for that
//     one video, so a leaked .strm opens one file, never the account,
//   * reports what was watched in Jellyfin to /c/jf/v1/progress, so Continue watching in Lilin
//     picks up where Jellyfin stopped.
//
// Everything lives under /c/, the path Cloudflare Access already lets through (see
// docs/remote-access.md), because a Jellyfin server can't sign in to Cloudflare. Lilin checks the key
// or the signature itself. Disconnecting (either side) deletes the key and every URL made with it.
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createTvPairing } from './tv.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const API = '/c/jf/v1';
const KEY_PREFIX = 'liljf_';
const MAX_LINKS_PER_USER = 10;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

export function openJellyfinStore(dataDir, { now = () => Date.now() } = {}) {
  const db = new DatabaseSync(path.join(dataDir, '.lilin.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jellyfin_links (
      id TEXT PRIMARY KEY,          -- public: appears in stream URLs
      key_hash TEXT NOT NULL UNIQUE,
      secret TEXT NOT NULL,         -- signs stream URLs; dies with the link
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      address TEXT
    );
    CREATE INDEX IF NOT EXISTS jellyfin_links_user ON jellyfin_links(user_id);
  `);
  const row = (r) => r && { id: r.id, userId: r.user_id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen, secret: r.secret };
  return {
    create(userId, name, address) {
      const count = db.prepare('SELECT COUNT(*) AS n FROM jellyfin_links WHERE user_id = ?').get(userId).n;
      if (count >= MAX_LINKS_PER_USER) throw fail(409, `You already have ${MAX_LINKS_PER_USER} Jellyfin servers connected. Disconnect one first.`);
      const id = crypto.randomBytes(9).toString('base64url');
      const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
      const t = now();
      db.prepare('INSERT INTO jellyfin_links (id, key_hash, secret, user_id, name, created_at, last_seen, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, hash(key), crypto.randomBytes(32).toString('base64url'), userId, cleanName(name) || 'Jellyfin', t, t, String(address || '').slice(0, 64));
      return { id, key };
    },
    byKey(key) {
      if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length > 100) return null;
      const r = row(db.prepare('SELECT * FROM jellyfin_links WHERE key_hash = ?').get(hash(key)));
      if (r && now() - r.lastSeen > 600_000) db.prepare('UPDATE jellyfin_links SET last_seen = ? WHERE id = ?').run(now(), r.id);
      return r;
    },
    byId: (id) => row(db.prepare('SELECT * FROM jellyfin_links WHERE id = ?').get(String(id))),
    touch(id) { db.prepare('UPDATE jellyfin_links SET last_seen = ? WHERE id = ? AND last_seen < ?').run(now(), id, now() - 600_000); },
    list: (userId) => db.prepare('SELECT * FROM jellyfin_links WHERE user_id = ? ORDER BY created_at').all(userId)
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen })),
    remove: (userId, id) => db.prepare('DELETE FROM jellyfin_links WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0,
    removeById: (id) => db.prepare('DELETE FROM jellyfin_links WHERE id = ?').run(String(id)).changes > 0,
    removeUser: (userId) => db.prepare('DELETE FROM jellyfin_links WHERE user_id = ?').run(userId).changes,
  };
}

// A video's signature in one link: 128 bits of HMAC, so URLs can't be guessed or moved to another video.
export const signItem = (secret, id) => crypto.createHmac('sha256', secret).update(`v1|${id}`).digest('base64url').slice(0, 22);
function sameSig(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// File name for a URL: the plugin doesn't need it, but ffprobe and logs read better with one.
const urlName = (file) => encodeURIComponent(String(file || 'video').replace(/[\\/?#%]/g, ' ').slice(0, 120));

// A small fixed window per address for the unauthenticated pairing calls.
function createRate({ limit, windowMs, now }) {
  const hits = new Map();
  return (who) => {
    const t = now();
    if (hits.size > 2000) for (const [k, v] of hits) if (t - v.first > windowMs) hits.delete(k);
    let h = hits.get(who);
    if (!h || t - h.first > windowMs) h = { first: t, count: 0 };
    h.count += 1; hits.set(who, h);
    if (h.count > limit) throw Object.assign(fail(429, 'Too many tries. Wait a minute and try again.'), { retryAfter: 60 });
  };
}

// deps (from server.js):
//   libraryFor(user)            → { items, shows } this person's library, as /api/library builds it
//   resolveItem(user, id)       → { id, full, stream, label } the file to stream, or throws 404
//   sendVideo(req, res, file, opts), sendJson(res, status, body), readJson(req, max)
//   userById(id), saveProgress(userId, ref, time, duration), progressOf(userId), mediaKey(full)
//   localLanguages(file), readSubtitle(file, lang), clientAddress(req), displayName(user), version
export function createJellyfin({ dataDir, now = () => Date.now(), ...deps }) {
  const store = openJellyfinStore(dataDir, { now });
  const pairing = createTvPairing({ now });
  const startRate = createRate({ limit: 10, windowMs: 60_000, now });

  function linkFromRequest(req) {
    const header = String(req.headers.authorization || '');
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-lilin-key'] || '');
    const link = store.byKey(key);
    if (!link) throw fail(401, 'This Jellyfin server isn’t connected to Lilin any more. Connect it again from the plugin’s settings.');
    const user = deps.userById(link.userId);
    if (!user) { store.removeById(link.id); throw fail(401, 'The Lilin account behind this connection is gone.'); }
    return { link, user };
  }

  // A signed media path: /c/jf/v1/<kind>/<link>/<sig>/<id>/<name>
  function signedPath(kind, link, id, name) { return `${API}/${kind}/${link.id}/${signItem(link.secret, id)}/${id}/${name}`; }

  function verifySigned(linkId, sig, id) {
    const link = store.byId(linkId);
    if (!link || !/^[A-Za-z0-9_-]{1,700}$/.test(id) || !sameSig(sig, signItem(link.secret, id))) throw fail(404, 'Not found.');
    const user = deps.userById(link.userId);
    if (!user) throw fail(404, 'Not found.');
    store.touch(link.id);
    return { link, user };
  }

  async function feed(link, user) {
    const { items, shows } = await deps.libraryFor(user);
    const progress = deps.progressOf(user.id);
    const showById = new Map(shows.map((s) => [s.id, { id: s.id, title: s.title, year: s.year || null, tmdbId: s.tmdbId || null, overview: s.overview || '', episodes: [] }]));
    const films = [];
    for (const it of items) {
      if (it.converting) continue; // its MP4 copy is being written; the next sync picks it up
      const p = progress[`m:${it.mediaKey}`];
      const entry = {
        id: it.id,
        key: it.mediaKey,
        file: it.file,
        size: it.size,
        added: Math.round(it.addedAt || it.added || 0),
        stream: signedPath('s', link, it.id, urlName(it.file)),
        subtitles: (it.subtitleLangs || []).map((lang) => ({ lang, url: signedPath('t', link, it.id, `${lang}.srt`) })),
        progress: p ? { position: p.time, duration: p.duration, at: p.at } : null,
      };
      const show = it.show && showById.get(it.show);
      if (show && it.season != null && it.episode != null) {
        show.episodes.push({ ...entry, season: it.season, episode: it.episode, episodeEnd: it.episodeEnd ?? null, title: it.episodeName || null });
      } else {
        films.push({ ...entry, title: it.filmTitle || it.title, year: it.year || null, tmdbId: it.tmdbId || null, overview: it.overview || '' });
      }
    }
    return {
      server: { name: 'Lilin', version: deps.version },
      account: { name: deps.displayName(user) },
      link: { id: link.id, name: link.name },
      films,
      shows: [...showById.values()].filter((s) => s.episodes.length),
    };
  }

  // /c/jf/v1/... Returns false for paths that aren't Jellyfin's.
  async function handlePublic(req, res, url) {
    if (!url.pathname.startsWith(`${API}/`)) return false;
    const p = url.pathname.slice(API.length);
    let m;
    if (p === '/pair/start' && req.method === 'POST') {
      startRate(deps.clientAddress(req));
      const body = await deps.readJson(req, 4096).catch(() => ({}));
      const started = pairing.start({ label: cleanName(body?.name) || null });
      return deps.sendJson(res, 200, { ...started, approveAt: '/#settings' }), true;
    }
    if (p === '/pair/poll' && (req.method === 'GET' || req.method === 'HEAD')) {
      const r = pairing.poll(url.searchParams.get('id'));
      return deps.sendJson(res, 200, r.state === 'approved' ? { state: 'approved', key: r.grant.key, name: r.grant.name } : { state: r.state }), true;
    }
    if (p === '/me') {
      const { link, user } = linkFromRequest(req);
      return deps.sendJson(res, 200, { account: { name: deps.displayName(user) }, link: { id: link.id, name: link.name }, server: { name: 'Lilin', version: deps.version } }), true;
    }
    if (p === '/library') {
      const { link, user } = linkFromRequest(req);
      return deps.sendJson(res, 200, await feed(link, user)), true;
    }
    if (p === '/progress' && req.method === 'POST') {
      const { user } = linkFromRequest(req);
      const body = await deps.readJson(req, 4096);
      const key = String(body?.key || '');
      if (!/^[^\u0000-\u001f]{1,400}$/.test(key)) throw fail(400, 'Unknown video.');
      if (body.finished) deps.saveProgress(user.id, `m:${key}`, null, null);
      else deps.saveProgress(user.id, `m:${key}`, Number(body.position), Number(body.duration));
      return deps.sendJson(res, 200, { ok: true }), true;
    }
    if (p === '/disconnect' && req.method === 'POST') {
      const { link } = linkFromRequest(req);
      store.removeById(link.id);
      return deps.sendJson(res, 200, { ok: true }), true;
    }
    if ((m = p.match(/^\/s\/([\w-]{8,20})\/([\w-]{22})\/([\w-]+)(?:\/[^/]*)?$/))) {
      const { user } = verifySigned(m[1], m[2], m[3]);
      const item = await deps.resolveItem(user, m[3]);
      await deps.sendVideo(req, res, item.stream, { label: item.label });
      return true;
    }
    if ((m = p.match(/^\/t\/([\w-]{8,20})\/([\w-]{22})\/([\w-]+)\/([a-z]{2,3})\.srt$/))) {
      const { user } = verifySigned(m[1], m[2], m[3]);
      const item = await deps.resolveItem(user, m[3]);
      const text = await deps.readSubtitle(item.stream, m[4]);
      res.writeHead(200, { 'Content-Type': 'application/x-subrip; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : text);
      return true;
    }
    throw fail(404, 'Not found.');
  }

  // Signed-in Lilin: Settings → Connect Jellyfin.
  async function handleApi(req, res, p, user) {
    let m;
    if (p === '/api/jellyfin' && req.method === 'GET') return deps.sendJson(res, 200, { links: store.list(user.id) }), true;
    if (p === '/api/jellyfin/approve' && req.method === 'POST') {
      const body = await deps.readJson(req, 4096);
      pairing.approve(`u${user.id}`, body?.code, (entry) => {
        const name = cleanName(body?.name) || entry.label || 'Jellyfin';
        const made = store.create(user.id, name, deps.clientAddress(req));
        return { key: made.key, name };
      }, { notFound: 'That code isn’t showing in any Jellyfin. Check the code in the Lilin plugin’s settings and try again.' });
      return deps.sendJson(res, 200, { ok: true, links: store.list(user.id) }), true;
    }
    if ((m = p.match(/^\/api\/jellyfin\/([\w-]{8,20})\/remove$/)) && req.method === 'POST') {
      if (!store.remove(user.id, m[1])) throw fail(404, 'That Jellyfin server isn’t connected.');
      return deps.sendJson(res, 200, { ok: true, links: store.list(user.id) }), true;
    }
    return false;
  }

  return { handlePublic, handleApi, store, pairing };
}
