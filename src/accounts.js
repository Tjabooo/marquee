// Accounts: everyone who signs in through Cloudflare Access gets their own Marquee (their library,
// watch progress, colours and preferences) with no extra login. The email Cloudflare adds to each
// request (Cf-Access-Authenticated-User-Email) is the account. Visits through the server's local
// address carry no email and share one "Home network" account.
//
// Stored in SQLite (.marquee.db, Node's built-in node:sqlite, so still no dependencies):
//   users     one row per person, with their settings as JSON
//   library   what's in each person's library: a video (by media key), when it was added and when
//             it gets deleted (expires_at; null = kept)
//   torrents  who started each download, so its files land in their library when it finishes
//   media     videos Marquee tracks; one that nobody has in their library any more is deleted
//   progress  where each person stopped watching, so it resumes on any of their devices
//   meta      server-wide settings (the owner's part of the Settings tab) and migration flags
//
// A video is one file on disk however many people have it: "Add to my library" adds a row, never a
// copy. Its media key is its path inside MEDIA_DIR without the extension, lower case, so the MP4
// copy the converter makes and the original count as the same video.
import path from 'node:path';
import { createRequire } from 'node:module';

// node:sqlite still prints an "experimental" warning on load; that one line is noise in the log.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/.test(String(w?.message || w)) ? undefined : emitWarning.call(process, w, ...rest));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
process.emitWarning = emitWarning;

const DAY = 86400000;
const HOME = 'home';

// Server-wide rules, changed by the owner in Settings.
const SERVER_DEFAULTS = {
  retentionDays: 7,        // downloads are deleted this many days after they finish (0 = never)
  extendDays: 7,           // "Keep longer" adds this many days
  maxExtensions: 0,        // times one video can be extended (0 = no limit)
  membersCanDownload: true, // new people may start downloads
  defaultTheme: 'marquee',
};
const RETENTION_CHOICES = [0, 1, 3, 7, 14, 30];
const EXTEND_CHOICES = [1, 3, 7, 14, 30];

// Per-person preferences (Settings tab).
const USER_DEFAULTS = { theme: null, subLang: '', quality: 'all', downloadProfile: '', maxSize: 0, audioLang: '', startView: 'discover', librarySort: 'newest', seenUpdate: '', skipIntro: 'button',
  pushDownload: true, pushEpisode: true, pushWatch: true }; // which notifications they get (push.js)
// Settings → Downloads. quality is the resolution chosen before profiles existed: it maps to a profile until one is chosen.
const DOWNLOAD_PROFILES = ['save', 'balanced', 'best'];
const MAX_SIZES = [0, 1, 2, 4, 8, 15, 30, 60]; // GB per film or episode; 0 = no limit
const QUALITIES = ['all', '2160p', '1440p', '1080p', '720p'];
const START_VIEWS = ['discover', 'library', 'downloads'];
const LIBRARY_SORTS = ['newest', 'expiring', 'title'];
const SKIP_INTRO = ['button', 'auto']; // Skip intro: offer a button, or skip on its own
const HEX = /^#[0-9a-f]{6}$/i;
const THEME_KEYS = ['bg', 'surface', 'text', 'accent'];

let db = null;
let admins = [];
let mediaDir = null;
const lastTouch = new Map(); // user id -> last time last_seen was written

const httpError = (status, message) => Object.assign(new Error(message), { status });

export function initAccounts({ dataDir, adminEmails, mediaDir: dir }) {
  admins = adminEmails.map((e) => e.toLowerCase());
  mediaDir = dir;
  db = new DatabaseSync(path.join(dataDir, '.marquee.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      can_download INTEGER NOT NULL DEFAULT 1,
      keep INTEGER NOT NULL DEFAULT 0,
      settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS library (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_key TEXT NOT NULL,
      source TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      expires_at INTEGER,
      extensions INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, media_key)
    );
    CREATE INDEX IF NOT EXISTS library_key ON library(media_key);
    CREATE INDEX IF NOT EXISTS library_expiry ON library(expires_at);
    CREATE TABLE IF NOT EXISTS torrents (
      hash TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT,
      added_at INTEGER NOT NULL,
      claimed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS torrent_requests (
      hash TEXT NOT NULL REFERENCES torrents(hash) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      claimed_at INTEGER,
      PRIMARY KEY (hash, user_id)
    );
    CREATE TABLE IF NOT EXISTS media (
      key TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'tracked',
      first_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      position REAL NOT NULL,
      duration REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, ref)
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

// ---------- meta ----------
const metaGet = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const metaSet = (key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
export const migrated = () => metaGet('migrated') === '1';
export const setMigrated = () => metaSet('migrated', '1');

export function serverSettings() {
  let saved = {};
  try { saved = JSON.parse(metaGet('settings') || '{}'); } catch { /* defaults */ }
  return { ...SERVER_DEFAULTS, ...saved };
}

export function updateServerSettings(patch) {
  const before = serverSettings();
  const next = { ...before };
  if ('retentionDays' in patch) {
    const v = Number(patch.retentionDays);
    if (!RETENTION_CHOICES.includes(v)) throw httpError(400, 'Pick one of the listed periods.');
    next.retentionDays = v;
  }
  if ('extendDays' in patch) {
    const v = Number(patch.extendDays);
    if (!EXTEND_CHOICES.includes(v)) throw httpError(400, 'Pick one of the listed periods.');
    next.extendDays = v;
  }
  if ('maxExtensions' in patch) {
    const v = Number(patch.maxExtensions);
    if (!Number.isInteger(v) || v < 0 || v > 20) throw httpError(400, 'Extensions must be between 0 (no limit) and 20.');
    next.maxExtensions = v;
  }
  if ('membersCanDownload' in patch) next.membersCanDownload = Boolean(patch.membersCanDownload);
  if ('defaultTheme' in patch) {
    if (typeof patch.defaultTheme !== 'string' || !/^[a-z-]{1,20}$/.test(patch.defaultTheme)) throw httpError(400, 'Unknown theme.');
    next.defaultTheme = patch.defaultTheme;
  }
  metaSet('settings', JSON.stringify(next));
  // Turning auto-delete back on: nothing is deleted straight away because of dates set long ago.
  if (!before.retentionDays && next.retentionDays) {
    db.prepare('UPDATE library SET expires_at = ? WHERE expires_at IS NOT NULL AND expires_at < ?')
      .run(Date.now() + next.retentionDays * DAY, Date.now() + DAY);
  }
  return next;
}
export const choices = () => ({ retention: RETENTION_CHOICES, extend: EXTEND_CHOICES });

// ---------- users ----------
const emailOf = (req) => String(req.headers['cf-access-authenticated-user-email'] || '').trim().toLowerCase() || HOME;
const fallbackName = (identity) => identity === HOME || identity === 'Home network' ? 'Home network' : String(identity).split('@')[0];

// One source for person labels. Looking up an old log entry must never create an account.
export function displayNameFor(identity) {
  const raw = String(identity || '').trim();
  const key = raw === 'Home network' ? HOME : raw.toLowerCase();
  return db?.prepare('SELECT name FROM users WHERE email = ?').get(key)?.name || fallbackName(raw);
}

function rowToUser(r) {
  let settings = {};
  try { settings = JSON.parse(r.settings || '{}'); } catch { /* defaults */ }
  const isOwner = admins.includes(r.email);
  return {
    id: r.id,
    email: r.email,
    name: r.name || fallbackName(r.email),
    isOwner,
    // the owner can always download; others as the owner allows
    canDownload: isOwner || Boolean(r.can_download),
    keep: Boolean(r.keep),
    settings: { ...USER_DEFAULTS, ...settings },
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  };
}

function ensureUser(email, lastSeen = Date.now()) {
  let row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) {
    const canDownload = admins.includes(email) || serverSettings().membersCanDownload;
    db.prepare('INSERT OR IGNORE INTO users (email, can_download, created_at, last_seen) VALUES (?, ?, ?, ?)')
      .run(email, canDownload ? 1 : 0, Date.now(), lastSeen);
    row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }
  return rowToUser(row);
}

// The person making this request (created on their first visit).
export function userFor(req) {
  const user = ensureUser(emailOf(req));
  if (Date.now() - (lastTouch.get(user.id) || 0) > 60000) {
    lastTouch.set(user.id, Date.now());
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), user.id);
  }
  return user;
}

// The server's owner (first of ADMIN_EMAILS): files added outside Marquee go in their library.
export const ownerUser = () => (admins[0] ? ensureUser(admins[0]) : null);

export function userById(id) {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return r ? rowToUser(r) : null;
}

// The access list may include people who have not visited yet. Reserve their account without
// marking a visit; their email, permissions and settings remain the account identity.
export function renameUser(email, name, previousName) {
  if (typeof email !== 'string' || !email.includes('@')) throw httpError(400, 'Choose a person from the access list.');
  email = email.trim().toLowerCase();
  if (typeof name !== 'string' || /[\u0000-\u001f\u007f]/.test(name)) throw httpError(400, 'Enter a name on one line.');
  name = name.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) throw httpError(400, 'Enter a name between 1 and 40 characters.');
  if (typeof previousName !== 'string') throw httpError(400, 'The previous name is required.');
  if (displayNameFor(email) !== previousName) throw httpError(409, 'This name changed elsewhere. Reload the page before renaming it.');
  const user = ensureUser(email, null);
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  return userById(user.id);
}

export function updateMe(user, patch) {
  const s = { ...user.settings };
  let name = null;
  if ('name' in patch) {
    name = String(patch.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  if ('theme' in patch) s.theme = cleanTheme(patch.theme);
  if ('subLang' in patch) s.subLang = /^[a-z]{2,3}(-[a-z]{2})?$/.test(String(patch.subLang)) ? String(patch.subLang) : '';
  if ('quality' in patch && QUALITIES.includes(patch.quality)) s.quality = patch.quality;
  if ('downloadProfile' in patch && DOWNLOAD_PROFILES.includes(patch.downloadProfile)) {
    s.downloadProfile = patch.downloadProfile;
    if (!('quality' in patch)) s.quality = 'all'; // the chosen profile replaces an older fixed resolution
  }
  if ('maxSize' in patch && MAX_SIZES.includes(Number(patch.maxSize))) s.maxSize = Number(patch.maxSize);
  if ('audioLang' in patch) s.audioLang = /^[a-z]{2,3}$/.test(String(patch.audioLang)) ? String(patch.audioLang) : '';
  if ('startView' in patch && START_VIEWS.includes(patch.startView)) s.startView = patch.startView;
  if ('librarySort' in patch && LIBRARY_SORTS.includes(patch.librarySort)) s.librarySort = patch.librarySort;
  if ('skipIntro' in patch && SKIP_INTRO.includes(patch.skipIntro)) s.skipIntro = patch.skipIntro;
  // the newest What's new update this person has seen (whats-new.js)
  if ('seenUpdate' in patch && /^[A-Za-z0-9._-]{1,40}$/.test(String(patch.seenUpdate))) s.seenUpdate = String(patch.seenUpdate);
  for (const k of ['pushDownload', 'pushEpisode', 'pushWatch']) if (k in patch) s[k] = Boolean(patch[k]);
  const stored = Object.fromEntries(Object.entries(s).filter(([k, v]) => v !== USER_DEFAULTS[k]));
  if (name !== null) db.prepare('UPDATE users SET name = ?, settings = ? WHERE id = ?').run(name || null, JSON.stringify(stored), user.id);
  else db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(stored), user.id);
  return userById(user.id);
}

// { preset: 'forest' } or { preset: 'custom', colors: { bg, surface, text, accent } }; null = server default.
function cleanTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const preset = String(t.preset || '');
  if (!/^[a-z-]{1,20}$/.test(preset)) return null;
  if (preset !== 'custom') return { preset };
  const colors = {};
  for (const k of THEME_KEYS) {
    if (!HEX.test(String(t.colors?.[k] || ''))) throw httpError(400, 'Colours must look like #a1b2c3.');
    colors[k] = t.colors[k].toLowerCase();
  }
  return { preset, colors };
}

// What the browser gets about the person signed in.
export function publicUser(u) {
  return { id: u.id, email: u.email === HOME ? null : u.email, name: u.name, isOwner: u.isOwner, canDownload: u.canDownload, keep: u.keep, settings: u.settings };
}

// The owner's list of people: everyone who has opened Marquee, with what's in their library.
export function listUsers() {
  const rows = db.prepare('SELECT * FROM users ORDER BY (last_seen IS NULL), last_seen DESC').all();
  const counts = db.prepare('SELECT user_id, media_key, source FROM library').all();
  return rows.map((r) => {
    const u = rowToUser(r);
    const mine = counts.filter((c) => c.user_id === u.id);
    return { ...publicUser(u), email: r.email === HOME ? null : r.email, lastSeen: u.lastSeen, createdAt: u.createdAt, keys: mine.map((c) => c.media_key), downloads: mine.filter((c) => c.source === 'download').length };
  });
}

export function updateUser(id, patch) {
  const u = userById(id);
  if (!u) throw httpError(404, 'No such person.');
  if ('canDownload' in patch) {
    if (u.isOwner && !patch.canDownload) throw httpError(400, 'The owner can always download.');
    db.prepare('UPDATE users SET can_download = ? WHERE id = ?').run(patch.canDownload ? 1 : 0, id);
  }
  if ('keep' in patch) {
    db.prepare('UPDATE users SET keep = ? WHERE id = ?').run(patch.keep ? 1 : 0, id);
    // Exempt: everything they have stays. No longer exempt: their videos start a fresh countdown.
    const days = serverSettings().retentionDays;
    if (patch.keep) db.prepare('UPDATE library SET expires_at = NULL WHERE user_id = ?').run(id);
    else if (days) db.prepare("UPDATE library SET expires_at = ? WHERE user_id = ? AND expires_at IS NULL AND source != 'existing'").run(Date.now() + days * DAY, id);
  }
  return userById(id);
}

// ---------- media keys ----------
// "C:\Media\Films\Dune.2021.1080p.mkv" -> "films/dune.2021.1080p"
export function mediaKey(full) {
  if (!mediaDir) return null;
  const rel = path.relative(mediaDir, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.slice(0, rel.length - path.extname(rel).length).split(path.sep).join('/').toLowerCase();
}

// Videos Marquee looks after (in someone's library, or waiting to be deleted).
export const trackedKeys = () => new Set(db.prepare("SELECT key FROM media WHERE state != 'gone'").all().map((r) => r.key));
function track(key) {
  db.prepare("INSERT INTO media (key, state, first_seen) VALUES (?, 'tracked', ?) ON CONFLICT(key) DO UPDATE SET state = 'tracked'").run(key, Date.now());
}

// ---------- library entries ----------
function expiryFor(userId) {
  const days = serverSettings().retentionDays;
  const u = userById(userId);
  return !days || u?.keep ? null : Date.now() + days * DAY;
}

const rowToEntry = (r) => ({ key: r.media_key, source: r.source, addedAt: r.added_at, expiresAt: r.expires_at, extensions: r.extensions });

export function libraryOf(userId) {
  return new Map(db.prepare('SELECT * FROM library WHERE user_id = ?').all(userId).map((r) => [r.media_key, rowToEntry(r)]));
}
// Everyone's library as (user, video) pairs: who has which shows, for new-episode notifications.
export const libraryRows = () => db.prepare('SELECT user_id, media_key FROM library').all();
export const holders = (key) => db.prepare('SELECT user_id FROM library WHERE media_key = ?').all(key).map((r) => r.user_id);

// source: 'download' (they downloaded it), 'added' (added from the server), 'existing' (on the server
// before accounts, or copied in by hand: kept, no countdown). Adding what's already there does nothing.
export function addEntry(userId, key, source) {
  if (!userId || !key) return false;
  track(key);
  const expires = source === 'existing' ? null : expiryFor(userId);
  return db.prepare('INSERT OR IGNORE INTO library (user_id, media_key, source, added_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, key, source, Date.now(), expires).changes > 0;
}

// Returns true when nobody has the video any more (the caller deletes the file).
export function removeEntry(userId, key) {
  db.prepare('DELETE FROM library WHERE user_id = ? AND media_key = ?').run(userId, key);
  return !holders(key).length;
}
export function removeAll(key) {
  db.prepare('DELETE FROM library WHERE media_key = ?').run(key);
}

export function extend(userId, key) {
  const r = db.prepare('SELECT * FROM library WHERE user_id = ? AND media_key = ?').get(userId, key);
  if (!r) throw httpError(404, 'That isn’t in your library.');
  if (r.expires_at == null) return rowToEntry(r);
  const { extendDays, maxExtensions } = serverSettings();
  if (maxExtensions && r.extensions >= maxExtensions) {
    throw httpError(409, `This has already been kept longer ${maxExtensions === 1 ? 'once' : `${maxExtensions} times`}, the most the server allows.`);
  }
  const expires = Math.max(r.expires_at, Date.now()) + extendDays * DAY;
  db.prepare('UPDATE library SET expires_at = ?, extensions = extensions + 1 WHERE user_id = ? AND media_key = ?').run(expires, userId, key);
  return { ...rowToEntry(r), expiresAt: expires, extensions: r.extensions + 1 };
}

// Removes library entries whose time is up. Returns the keys nobody has any more, marked for deletion.
export function expireDue() {
  if (!serverSettings().retentionDays) return [];
  const due = db.prepare('SELECT user_id, media_key FROM library WHERE expires_at IS NOT NULL AND expires_at <= ?').all(Date.now());
  const orphaned = new Set();
  for (const r of due) {
    if (removeEntry(r.user_id, r.media_key)) orphaned.add(r.media_key);
  }
  for (const key of orphaned) markDeleting(key);
  return [...orphaned];
}

// Videos waiting to be deleted (a delete can fail while the file is playing; it's retried).
export const markDeleting = (key) => db.prepare("INSERT INTO media (key, state, first_seen) VALUES (?, 'deleting', ?) ON CONFLICT(key) DO UPDATE SET state = 'deleting'").run(key, Date.now());
export const markGone = (key) => db.prepare("UPDATE media SET state = 'gone' WHERE key = ?").run(key);
export const pendingDeletes = () => db.prepare("SELECT key FROM media WHERE state = 'deleting'").all().map((r) => r.key);

// ---------- downloads ----------
export const tagFor = (userId) => `marquee-u${userId}`;
export function userFromTags(tags) {
  const m = /(?:^|,)\s*marquee-u(\d+)\s*(?:,|$)/.exec(String(tags || ''));
  return m ? Number(m[1]) : null;
}

// Infohash of a magnet link (hex or base32), lower-case hex.
export function magnetHash(link) {
  const m = /[?&]xt=urn:btih:([a-z0-9]+)/i.exec(String(link || ''));
  if (!m) return null;
  const v = m[1];
  if (/^[a-f0-9]{40}$/i.test(v)) return v.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(v)) return null;
  let bits = '';
  for (const c of v.toUpperCase()) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  return bits.match(/.{4}/g).map((b) => parseInt(b, 2).toString(16)).join('');
}

export function recordTorrent(hash, userId, name) {
  if (!hash) return;
  db.prepare('INSERT INTO torrents (hash, user_id, name, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING')
    .run(hash.toLowerCase(), userId, String(name || '').slice(0, 300), Date.now());
}
export function torrentRow(hash) {
  return db.prepare('SELECT * FROM torrents WHERE hash = ?').get(String(hash).toLowerCase()) || null;
}
// A second viewer can request an existing torrent without downloading a second copy. Keep that
// request across restarts until the finished files can be added to their own library.
export function requestTorrent(hash, userId, name, { restart = false } = {}) {
  if (!hash || !userId) return;
  hash = String(hash).toLowerCase();
  recordTorrent(hash, userId, name);
  if (restart) {
    db.prepare('DELETE FROM torrent_requests WHERE hash = ?').run(hash);
    db.prepare('UPDATE torrents SET user_id = ?, name = ?, added_at = ?, claimed_at = NULL WHERE hash = ?')
      .run(userId, String(name || '').slice(0, 300), Date.now(), hash);
  }
  db.prepare('INSERT INTO torrent_requests (hash, user_id) VALUES (?, ?) ON CONFLICT(hash, user_id) DO UPDATE SET claimed_at = NULL')
    .run(hash, userId);
}
export const torrentRequesters = (hash) => db.prepare('SELECT user_id FROM torrent_requests WHERE hash = ?').all(String(hash).toLowerCase()).map((r) => r.user_id);
export function torrentClaimants(hash) {
  const row = torrentRow(hash);
  const pending = db.prepare('SELECT user_id FROM torrent_requests WHERE hash = ? AND claimed_at IS NULL').all(String(hash).toLowerCase()).map((r) => r.user_id);
  return [...new Set([...(!row?.claimed_at && row?.user_id ? [row.user_id] : []), ...pending])];
}
export function markClaimed(hash) {
  hash = String(hash).toLowerCase();
  const now = Date.now();
  db.prepare('UPDATE torrents SET claimed_at = ? WHERE hash = ?').run(now, hash);
  db.prepare('UPDATE torrent_requests SET claimed_at = ? WHERE hash = ? AND claimed_at IS NULL').run(now, hash);
}

// ---------- watch progress ----------
const REF = /^[a-z]:[^\u0000-\u001f]{1,400}$/i; // m:<media key>, d:<torrent hash>, l:<library id>
export function progressOf(userId) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500').all(userId)) {
    out[r.ref] = { time: r.position, duration: r.duration, at: r.updated_at };
  }
  return out;
}
export function saveProgress(userId, ref, time, duration) {
  ref = String(ref || '');
  if (!REF.test(ref)) throw httpError(400, 'Unknown video.');
  if (time == null) { db.prepare('DELETE FROM progress WHERE user_id = ? AND ref = ?').run(userId, ref); return; }
  time = Number(time);
  duration = Number(duration);
  if (!Number.isFinite(time) || !Number.isFinite(duration) || time < 0 || duration <= 0) throw httpError(400, 'Bad position.');
  db.prepare(`INSERT INTO progress (user_id, ref, position, duration, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, ref) DO UPDATE SET position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`)
    .run(userId, ref, time, duration, Date.now());
}
