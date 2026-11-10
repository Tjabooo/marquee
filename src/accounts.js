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
//   ratings, watch_log, watch_company, watch_parties  thumbs, watch time and planned watch parties
//             (see social.js; watch_log keeps watch time after progress rows are deleted)
//
// Shared libraries (library_shares): people the owner puts in one group see and manage one library
// together. Rows stay per person (who added it, their countdown); every read merges the group's rows,
// and removing or keeping longer acts on the whole group. Watch progress stays personal.
//
// A video is one file on disk however many people have it: "Add to my library" adds a row, never a
// copy. Its media key is its path inside MEDIA_DIR without the extension, lower case, so the MP4
// copy the converter makes and the original count as the same video.
import fs from 'node:fs';
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
const USER_DEFAULTS = { theme: null, language: '', subLang: '', quality: 'all', downloadProfile: '', maxSize: 0, audioLang: '', dubbed: [], startView: 'discover', librarySort: 'newest', seenUpdate: '', skipIntro: 'button',
  pushDownload: true, pushEpisode: true, pushWatch: true, pushAgent: true, pushUpdate: true }; // which notifications they get (push.js)
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
  avatarDir = path.join(dataDir, '.marquee-avatars');
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
    CREATE TABLE IF NOT EXISTS ratings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title_key TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value IN (-1, 1)),
      title TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, title_key)
    );
    CREATE INDEX IF NOT EXISTS ratings_title ON ratings(title_key);
    CREATE TABLE IF NOT EXISTS watch_log (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      ref TEXT NOT NULL,
      title_key TEXT,
      title TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      seconds REAL NOT NULL DEFAULT 0,
      together REAL NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, day, ref)
    );
    CREATE INDEX IF NOT EXISTS watch_log_title ON watch_log(title_key, day);
    CREATE TABLE IF NOT EXISTS watch_company (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      other_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      seconds REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, other_id, day)
    );
    CREATE TABLE IF NOT EXISTS watch_parties (
      token TEXT PRIMARY KEY,
      creator INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      people TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_shares (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS library_shares_group ON library_shares(group_id);
  `);
}
// The open database, for modules that keep their own tables here (social.js).
export const database = () => db;

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

// ---------- profile pictures ----------
// One small square image per person (the browser crops and shrinks it to 256 px before upload), kept
// as .marquee-avatars/<id>.<ext>. settings.avatar holds the upload time, which versions the URL, so
// browsers can cache a picture forever and still see a new one at once.
let avatarDir = null;
const AVATAR_MAX = 600 * 1024;
const AVATAR_TYPES = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };
const avatarUrl = (id, version) => (Number.isSafeInteger(version) && version > 0 ? `/api/avatar/${id}?v=${version.toString(36)}` : null);
export function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  return null;
}
export function avatarFile(id) {
  if (!avatarDir || !Number.isSafeInteger(Number(id))) return null;
  for (const [ext, type] of Object.entries(AVATAR_TYPES)) {
    const file = path.join(avatarDir, `${Number(id)}.${ext}`);
    if (fs.existsSync(file)) return { file, type };
  }
  return null;
}
// image: a Buffer to set, null to remove. Returns the updated person.
export function setAvatar(id, image) {
  const user = userById(id);
  if (!user) throw httpError(404, 'No such person.');
  const kind = image == null ? null : imageKind(image);
  if (image != null && !kind) throw httpError(415, 'Use a JPEG, PNG or WebP picture.');
  if (image != null && image.length > AVATAR_MAX) throw httpError(413, 'That picture is too large.');
  fs.mkdirSync(avatarDir, { recursive: true });
  for (const ext of Object.keys(AVATAR_TYPES)) fs.rmSync(path.join(avatarDir, `${user.id}.${ext}`), { force: true });
  const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(user.id);
  let settings = {};
  try { settings = JSON.parse(row?.settings || '{}'); } catch { /* start over */ }
  if (kind) {
    const file = path.join(avatarDir, `${user.id}.${kind}`);
    fs.writeFileSync(`${file}.tmp`, image);
    fs.renameSync(`${file}.tmp`, file);
    settings.avatar = Math.max(Date.now(), (settings.avatar || 0) + 1);
  } else delete settings.avatar;
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), user.id);
  return userById(user.id);
}
// The picture for the email an old log entry carries (Activity), without creating an account.
export function avatarForEmail(identity) {
  const raw = String(identity || '').trim();
  const key = raw === 'Home network' ? HOME : raw.toLowerCase();
  const r = db?.prepare('SELECT id, settings FROM users WHERE email = ?').get(key);
  if (!r) return null;
  try { return avatarUrl(r.id, JSON.parse(r.settings || '{}').avatar); } catch { return null; }
}

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
    avatar: avatarUrl(r.id, settings.avatar),
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
  if ('language' in patch) s.language = ['en', 'sv'].includes(patch.language) ? patch.language : '';
  if ('subLang' in patch) s.subLang = /^[a-z]{2,3}(-[a-z]{2})?$/.test(String(patch.subLang)) ? String(patch.subLang) : '';
  if ('quality' in patch && QUALITIES.includes(patch.quality)) s.quality = patch.quality;
  if ('downloadProfile' in patch && DOWNLOAD_PROFILES.includes(patch.downloadProfile)) {
    s.downloadProfile = patch.downloadProfile;
    if (!('quality' in patch)) s.quality = 'all'; // the chosen profile replaces an older fixed resolution
  }
  if ('maxSize' in patch && MAX_SIZES.includes(Number(patch.maxSize))) s.maxSize = Number(patch.maxSize);
  if ('audioLang' in patch) s.audioLang = /^[a-z]{2,3}$/.test(String(patch.audioLang)) ? String(patch.audioLang) : '';
  // Anime this person asked to hear dubbed ("tv:123"): the player starts on the English track.
  if (Array.isArray(patch.dubbed)) s.dubbed = [...new Set(patch.dubbed.map(String).filter((k) => /^(tv|movie):\d+$/.test(k)))].slice(-500);
  if ('startView' in patch && START_VIEWS.includes(patch.startView)) s.startView = patch.startView;
  if ('librarySort' in patch && LIBRARY_SORTS.includes(patch.librarySort)) s.librarySort = patch.librarySort;
  if ('skipIntro' in patch && SKIP_INTRO.includes(patch.skipIntro)) s.skipIntro = patch.skipIntro;
  // the newest What's new update this person has seen (whats-new.js)
  if ('seenUpdate' in patch && /^[A-Za-z0-9._-]{1,40}$/.test(String(patch.seenUpdate))) s.seenUpdate = String(patch.seenUpdate);
  for (const k of ['pushDownload', 'pushEpisode', 'pushWatch', 'pushAgent', 'pushUpdate']) if (k in patch) s[k] = Boolean(patch[k]);
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
  return { id: u.id, email: u.email === HOME ? null : u.email, name: u.name, avatar: u.avatar, isOwner: u.isOwner, canDownload: u.canDownload, keep: u.keep, settings: u.settings,
    sharedWith: libraryMates(u.id).filter((id) => id !== u.id).map((id) => userById(id)).filter(Boolean).map((m) => ({ id: m.id, name: m.name, avatar: m.avatar })) };
}

// The owner's list of people: everyone who has opened Marquee, with what's in their library.
export function listUsers() {
  const rows = db.prepare('SELECT * FROM users ORDER BY (last_seen IS NULL), last_seen DESC').all();
  const counts = db.prepare('SELECT user_id, media_key, source FROM library').all();
  return rows.map((r) => {
    const u = rowToUser(r);
    const mates = libraryMates(u.id);
    const mine = counts.filter((c) => mates.includes(c.user_id));
    return { ...publicUser(u), email: r.email === HOME ? null : r.email, lastSeen: u.lastSeen, createdAt: u.createdAt, keys: [...new Set(mine.map((c) => c.media_key))], downloads: mine.filter((c) => c.source === 'download').length };
  });
}

export function updateUser(id, patch) {
  const u = userById(id);
  if (!u) throw httpError(404, 'No such person.');
  if ('canDownload' in patch) {
    if (u.isOwner && !patch.canDownload) throw httpError(400, 'The owner can always download.');
    db.prepare('UPDATE users SET can_download = ? WHERE id = ?').run(patch.canDownload ? 1 : 0, id);
  }
  if ('libraryWith' in patch) shareLibrary(id, patch.libraryWith == null || patch.libraryWith === '' ? null : Number(patch.libraryWith));
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

// ---------- shared libraries ----------
// Everyone whose library this person sees (themselves included).
export function libraryMates(userId) {
  const g = db.prepare('SELECT group_id FROM library_shares WHERE user_id = ?').get(userId);
  if (!g) return [userId];
  return db.prepare('SELECT user_id FROM library_shares WHERE group_id = ? ORDER BY user_id').all(g.group_id).map((r) => r.user_id);
}
export const sameLibrary = (a, b) => a === b || (a != null && b != null && libraryMates(a).includes(b));
const matesSql = (ids) => ids.map(() => '?').join(',');

// Puts `userId` in `withId`'s library (null = back to a library of their own). Each keeps the rows they
// added, so leaving takes back what they brought and leaves the rest with the group.
export function shareLibrary(userId, withId) {
  if (!userById(userId)) throw httpError(404, 'No such person.');
  const leave = () => {
    const g = db.prepare('SELECT group_id FROM library_shares WHERE user_id = ?').get(userId);
    db.prepare('DELETE FROM library_shares WHERE user_id = ?').run(userId);
    if (g) {
      const left = db.prepare('SELECT user_id FROM library_shares WHERE group_id = ?').all(g.group_id);
      if (left.length < 2) db.prepare('DELETE FROM library_shares WHERE group_id = ?').run(g.group_id);
    }
  };
  if (withId == null) { leave(); return libraryMates(userId); }
  withId = Number(withId);
  if (withId === userId) throw httpError(400, 'Pick someone else to share with.');
  if (!userById(withId)) throw httpError(404, 'No such person.');
  if (sameLibrary(userId, withId)) return libraryMates(userId);
  leave();
  const target = db.prepare('SELECT group_id FROM library_shares WHERE user_id = ?').get(withId);
  const group = target?.group_id ?? withId;
  if (!target) db.prepare('INSERT INTO library_shares (user_id, group_id) VALUES (?, ?)').run(withId, group);
  db.prepare('INSERT INTO library_shares (user_id, group_id) VALUES (?, ?)').run(userId, group);
  return libraryMates(userId);
}

// One video seen by a whole group: kept forever if anyone keeps it, else the latest countdown.
function mergeEntries(rows) {
  const out = new Map();
  for (const r of rows) {
    const e = rowToEntry(r);
    const had = out.get(e.key);
    if (!had) { out.set(e.key, e); continue; }
    const later = had.expiresAt != null && (e.expiresAt == null || e.expiresAt > had.expiresAt);
    out.set(e.key, {
      ...(later ? e : had),
      addedAt: Math.min(had.addedAt, e.addedAt),
      extensions: Math.max(had.extensions, e.extensions),
    });
  }
  return out;
}

export function libraryOf(userId) {
  const ids = libraryMates(userId);
  return mergeEntries(db.prepare(`SELECT * FROM library WHERE user_id IN (${matesSql(ids)})`).all(...ids));
}
export function hasEntry(userId, key) {
  const ids = libraryMates(userId);
  return Boolean(db.prepare(`SELECT 1 FROM library WHERE media_key = ? AND user_id IN (${matesSql(ids)}) LIMIT 1`).get(key, ...ids));
}
// Everyone's library as (user, video) pairs: who has which shows, for new-episode notifications.
// People sharing a library each get the group's videos.
export function libraryRows() {
  const rows = db.prepare('SELECT user_id, media_key FROM library').all();
  const groups = db.prepare('SELECT user_id, group_id FROM library_shares').all();
  if (!groups.length) return rows;
  const groupOf = new Map(groups.map((g) => [g.user_id, g.group_id]));
  const members = new Map();
  for (const g of groups) members.set(g.group_id, [...(members.get(g.group_id) || []), g.user_id]);
  const out = new Map();
  for (const r of rows) {
    for (const id of groupOf.has(r.user_id) ? members.get(groupOf.get(r.user_id)) : [r.user_id]) {
      out.set(`${id}\n${r.media_key}`, { user_id: id, media_key: r.media_key });
    }
  }
  return [...out.values()];
}
// Who has the video in their library: the people with a row, plus everyone sharing a library with them.
export function holders(key) {
  const direct = db.prepare('SELECT user_id FROM library WHERE media_key = ?').all(key).map((r) => r.user_id);
  return [...new Set(direct.flatMap((id) => libraryMates(id)))];
}
// Someone outside this person's (shared) library has the video, so removing it must keep the file.
export const heldOutside = (key, userId) => holders(key).some((id) => !sameLibrary(id, userId));

// source: 'download' (they downloaded it), 'added' (added from the server), 'existing' (on the server
// before accounts, or copied in by hand: kept, no countdown). Adding what's already there does nothing.
export function addEntry(userId, key, source) {
  if (!userId || !key) return false;
  track(key);
  if (hasEntry(userId, key)) return false; // already in their (shared) library
  const expires = source === 'existing' ? null : expiryFor(userId);
  return db.prepare('INSERT OR IGNORE INTO library (user_id, media_key, source, added_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, key, source, Date.now(), expires).changes > 0;
}

// Returns true when nobody has the video any more (the caller deletes the file).
// In a shared library it leaves everyone's view, so it goes for the whole group.
export function removeEntry(userId, key) {
  const ids = libraryMates(userId);
  db.prepare(`DELETE FROM library WHERE media_key = ? AND user_id IN (${matesSql(ids)})`).run(key, ...ids);
  return !holders(key).length;
}
export function removeAll(key) {
  db.prepare('DELETE FROM library WHERE media_key = ?').run(key);
}
// A video replaced by a better copy (Upgrade quality): everyone who had the old one has the new one,
// with the same countdown and the same place in it. Returns the number of libraries moved.
export function moveMedia(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return 0;
  track(newKey);
  const moved = db.prepare('UPDATE OR IGNORE library SET media_key = ? WHERE media_key = ?').run(newKey, oldKey).changes;
  db.prepare('DELETE FROM library WHERE media_key = ?').run(oldKey); // rows the new key already had
  db.prepare('UPDATE OR IGNORE progress SET ref = ? WHERE ref = ?').run(`m:${newKey}`, `m:${oldKey}`);
  db.prepare('DELETE FROM progress WHERE ref = ?').run(`m:${oldKey}`);
  return moved;
}

export function extend(userId, key) {
  const ids = libraryMates(userId);
  const r = libraryOf(userId).get(key);
  if (!r) throw httpError(404, 'That isn’t in your library.');
  if (r.expiresAt == null) return r;
  const { extendDays, maxExtensions } = serverSettings();
  if (maxExtensions && r.extensions >= maxExtensions) {
    throw httpError(409, `This has already been kept longer ${maxExtensions === 1 ? 'once' : `${maxExtensions} times`}, the most the server allows.`);
  }
  const expires = Math.max(r.expiresAt, Date.now()) + extendDays * DAY;
  // Every countdown in the group moves, so the merged entry shows the same date for everyone.
  db.prepare(`UPDATE library SET expires_at = ?, extensions = ? WHERE media_key = ? AND expires_at IS NOT NULL AND user_id IN (${matesSql(ids)})`)
    .run(expires, r.extensions + 1, key, ...ids);
  return { ...r, expiresAt: expires, extensions: r.extensions + 1 };
}

// Removes library entries whose time is up. Returns the keys nobody has any more, marked for deletion.
export function expireDue() {
  if (!serverSettings().retentionDays) return [];
  const due = db.prepare('SELECT user_id, media_key FROM library WHERE expires_at IS NOT NULL AND expires_at <= ?').all(Date.now());
  const orphaned = new Set();
  for (const r of due) {
    // only this row: someone in a shared library may still have their own, later countdown
    db.prepare('DELETE FROM library WHERE user_id = ? AND media_key = ?').run(r.user_id, r.media_key);
    if (!holders(r.media_key).length) orphaned.add(r.media_key);
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
// Everyone who wants this download: whoever started it and whoever asked for it since.
export function torrentWanters(hash) {
  const row = torrentRow(hash);
  return [...new Set([row?.user_id, ...torrentRequesters(hash)].filter((id) => id != null))];
}
// Someone takes themselves off a download, so it stops landing in their library. The next person who
// asked for it takes it over. Returns who still wants it.
export function leaveTorrent(hash, userId) {
  hash = String(hash).toLowerCase();
  db.prepare('DELETE FROM torrent_requests WHERE hash = ? AND user_id = ?').run(hash, userId);
  const row = torrentRow(hash);
  const others = torrentWanters(hash).filter((id) => id !== userId);
  if (row?.user_id === userId) {
    if (others.length) db.prepare('UPDATE torrents SET user_id = ? WHERE hash = ?').run(others[0], hash);
    else db.prepare('UPDATE torrents SET claimed_at = ? WHERE hash = ?').run(Date.now(), hash); // nobody left to hand its files to
  }
  return others;
}
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
