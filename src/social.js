// Social: thumbs up/down on titles, the watch-time log behind "Popular on Marquee" and Marquee
// Wrapped, and the planned watch parties that have to outlive a restart. Tables live in the accounts
// database (created in initAccounts); this module only reads and writes them.
//
// Watch time is logged per person, local day and video (watch_log), from the seconds the player
// actually played between two progress saves. Progress rows are deleted when a video is finished,
// so they can't answer "how much did I watch this year"; this log can. Time watched in a Watch
// Together room is also credited to each pair of people in it (watch_company).
import { tr } from './i18n.js';
import { database } from './accounts.js';

const TITLE_KEY = /^(movie|tv):\d{1,9}$/;
const REF = /^[a-z]:[^\u0000-\u001f]{1,400}$/i;
const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
export const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const db = () => database();
const fail = (status, message) => Object.assign(new Error(message), { status });
export const validTitleKey = (key) => TITLE_KEY.test(String(key || ''));
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v) => (Number.isSafeInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);

// ---------- thumbs ----------
// value: 1 (thumbs up), -1 (thumbs down) or 0 (clear). Thumbs down stay private: other people only
// ever see who liked a title, and the Popular shelf uses dislikes to rank it lower.
export function rate(userId, key, value, title = '') {
  if (!validTitleKey(key)) throw fail(400, 'Which film or show?');
  value = Number(value);
  if (![1, -1, 0].includes(value)) throw fail(400, 'Rate with thumbs up or down.');
  if (!value) { db().prepare('DELETE FROM ratings WHERE user_id = ? AND title_key = ?').run(userId, key); return; }
  db().prepare(`INSERT INTO ratings (user_id, title_key, value, title, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, title_key) DO UPDATE SET value = excluded.value, title = COALESCE(excluded.title, title), updated_at = excluded.updated_at`)
    .run(userId, key, value, cleanText(title, 200) || null, Date.now());
}

// What one person sees on a title: their own thumb and who else liked it (likedBy: names; people:
// { name, avatar } for the faces beside them, when avatarOf is given).
export function ratingFor(userId, key, nameOf, avatarOf = () => null) {
  if (!validTitleKey(key)) throw fail(400, 'Which film or show?');
  const rows = db().prepare('SELECT user_id, value FROM ratings WHERE title_key = ? ORDER BY updated_at DESC').all(key);
  const mine = rows.find((r) => r.user_id === userId)?.value || 0;
  const others = rows.filter((r) => r.value === 1 && r.user_id !== userId);
  const likedBy = others.map((r) => nameOf(r.user_id));
  const people = others.slice(0, 5).map((r, i) => ({ name: likedBy[i], avatar: avatarOf(r.user_id) }));
  return { key, mine, likedBy, people, likes: rows.filter((r) => r.value === 1).length };
}

// Thumbs for many titles at once (Popular shelf cards, library cards): { key: { mine, likes } }.
export function ratingsFor(userId, keys) {
  const out = {};
  const wanted = [...new Set(keys)].filter(validTitleKey).slice(0, 500);
  if (!wanted.length) return out;
  const rows = db().prepare(`SELECT title_key, user_id, value FROM ratings WHERE title_key IN (${wanted.map(() => '?').join(',')})`).all(...wanted);
  for (const r of rows) {
    const o = out[r.title_key] ||= { mine: 0, likes: 0 };
    if (r.user_id === userId) o.mine = r.value;
    if (r.value === 1) o.likes++;
  }
  return out;
}

// ---------- watch log ----------
const lastLog = new Map(); // `${userId}|${ref}` -> ms of the previous logged save

// Credits `watched` seconds of playback to today's row for this video. The player sends how long it
// really played since its last save; that can't be more than about twice the time that passed (2x
// playback speed), which keeps a stuck or replayed request from inflating anyone's year.
// about: { titleKey?, title, season?, episode? }. companions: other people's user ids in the same
// Watch Together room. Returns the seconds logged.
export function logWatch(userId, { ref, about = {}, watched, finished = false, companions = [], now = Date.now() }) {
  ref = String(ref || '');
  if (!REF.test(ref)) return 0;
  const seconds = Number(watched);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    if (!finished) return 0;
  }
  const k = `${userId}|${ref}`;
  const prev = lastLog.get(k);
  const allowed = prev ? Math.min(180, Math.max(0, (now - prev) / 1000) * 2.1 + 3) : 30;
  const credit = Math.max(0, Math.min(Number.isFinite(seconds) ? seconds : 0, allowed));
  lastLog.set(k, now);
  if (lastLog.size > 5000) lastLog.delete(lastLog.keys().next().value);
  const title = cleanText(about.title, 200);
  if (!title || (credit <= 0 && !finished)) return 0;
  const titleKey = validTitleKey(about.titleKey) ? about.titleKey : null;
  const season = int(about.season), episode = int(about.episode);
  const day = localDay(now);
  const others = [...new Set(companions.map(Number))].filter((id) => Number.isSafeInteger(id) && id !== userId).slice(0, 12);
  const together = others.length ? credit : 0;
  db().prepare(`INSERT INTO watch_log (user_id, day, ref, title_key, title, season, episode, seconds, together, finished, first_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day, ref) DO UPDATE SET seconds = seconds + excluded.seconds, together = together + excluded.together,
      finished = MAX(finished, excluded.finished), title = excluded.title, title_key = COALESCE(excluded.title_key, title_key),
      last_at = excluded.last_at`)
    .run(userId, day, ref, titleKey, title, season, episode, credit, together, finished ? 1 : 0, now, now);
  const company = db().prepare(`INSERT INTO watch_company (user_id, other_id, day, seconds) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, other_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`);
  if (credit > 0) for (const other of others) {
    try { company.run(userId, other, day, credit); } catch { /* that account was removed */ }
  }
  return credit;
}

// ---------- Popular on Marquee ----------
// Titles ranked by the household over the last `days`: likes count most, then how many people
// watched, then (a little) hours watched; dislikes pull a title down. Only titles with a TMDB id
// can be shown as cards. Returns [{ key, likes, viewers, hours, likedBy: [userId], watchedBy: [userId] }].
export function popular({ days = 60, limit = 20, now = Date.now(), type = 'all' } = {}) {
  const since = now - days * DAY;
  const t = new Map();
  const get = (key) => {
    if (!t.has(key)) t.set(key, { key, likes: 0, dislikes: 0, viewers: 0, seconds: 0, likedBy: [], watchedBy: [] });
    return t.get(key);
  };
  for (const r of db().prepare('SELECT title_key, user_id, value FROM ratings WHERE updated_at >= ?').all(since)) {
    const o = get(r.title_key);
    if (r.value === 1) { o.likes++; o.likedBy.push(r.user_id); } else o.dislikes++;
  }
  for (const r of db().prepare(`SELECT title_key, user_id, SUM(seconds) AS s FROM watch_log
      WHERE title_key IS NOT NULL AND day >= ? GROUP BY title_key, user_id`).all(localDay(since))) {
    if (r.s < 300) continue; // a five-minute look isn't a vote
    const o = get(r.title_key);
    o.viewers++; o.seconds += r.s; o.watchedBy.push(r.user_id);
  }
  return [...t.values()]
    .filter((o) => type === 'all' || o.key.startsWith(`${type}:`))
    .map((o) => ({ ...o, hours: Math.round(o.seconds / 360) / 10,
      score: o.likes * 3 - o.dislikes * 2 + o.viewers * 2 + Math.min(o.seconds / 3600, 10) * 0.3 }))
    .filter((o) => o.score > 0 && (o.likes > 0 || o.viewers > 0))
    .sort((a, b) => b.score - a.score || b.seconds - a.seconds || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map(({ key, likes, viewers, hours, likedBy, watchedBy }) => ({ key, likes, viewers, hours, likedBy, watchedBy }));
}

// ---------- Marquee Wrapped ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function wrappedYears(userId) {
  return db().prepare("SELECT DISTINCT substr(day, 1, 4) AS y FROM watch_log WHERE user_id = ? AND seconds > 0 ORDER BY y DESC")
    .all(userId).map((r) => Number(r.y));
}

// One person's year on Marquee. nameOf(userId) -> display name.
export function wrapped(userId, year, nameOf, avatarOf = () => null) {
  year = Number(year);
  if (!Number.isSafeInteger(year) || year < 2000 || year > 3000) throw fail(400, 'Which year?');
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const rows = db().prepare('SELECT * FROM watch_log WHERE user_id = ? AND day BETWEEN ? AND ? AND seconds > 0 ORDER BY first_at').all(userId, from, to);
  const seconds = rows.reduce((s, r) => s + r.seconds, 0);
  const base = { year, years: wrappedYears(userId), seconds: Math.round(seconds) };
  if (seconds < 60) return { ...base, empty: true };

  // Titles: a show is one title however many episodes; films without a TMDB id group by name.
  const titles = new Map();
  for (const r of rows) {
    const id = r.title_key || `name:${r.title.toLowerCase()}`;
    const t = titles.get(id) || { key: r.title_key, title: r.title, seconds: 0, episodes: new Set(), tv: r.season != null || r.title_key?.startsWith('tv:') };
    t.seconds += r.seconds; t.title = r.title;
    if (r.season != null && r.episode != null) t.episodes.add(`${r.season}x${r.episode}`);
    titles.set(id, t);
  }
  const ranked = [...titles.values()].sort((a, b) => b.seconds - a.seconds);
  const top = ranked.slice(0, 5).map((t) => ({ key: t.key, title: t.title, seconds: Math.round(t.seconds), episodes: t.episodes.size, tv: t.tv }));
  const shows = ranked.filter((t) => t.tv);
  const topShow = shows.toSorted((a, b) => b.episodes.size - a.episodes.size || b.seconds - a.seconds)[0];

  // Days: busiest day, month, weekday and the longest run of days in a row.
  const byDay = new Map();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) || 0) + r.seconds);
  const days = [...byDay.keys()].sort();
  let streak = { days: 0, from: null, to: null }, run = 0, runFrom = null, prev = null;
  for (const d of days) {
    const t = new Date(`${d}T12:00:00`).getTime();
    run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    if (run === 1) runFrom = d;
    if (run > streak.days) streak = { days: run, from: runFrom, to: d };
    prev = t;
  }
  const [busyDay, busySeconds] = [...byDay].sort((a, b) => b[1] - a[1])[0];
  const months = Array(12).fill(0), weekdays = Array(7).fill(0);
  for (const [d, s] of byDay) {
    months[Number(d.slice(5, 7)) - 1] += s;
    weekdays[new Date(`${d}T12:00:00`).getDay()] += s;
  }
  const maxIdx = (a) => a.indexOf(Math.max(...a));

  const company = db().prepare(`SELECT other_id, SUM(seconds) AS s FROM watch_company WHERE user_id = ? AND day BETWEEN ? AND ?
    GROUP BY other_id ORDER BY s DESC LIMIT 5`).all(userId, from, to)
    .filter((r) => r.s >= 60).map((r) => ({ name: nameOf(r.other_id), avatar: avatarOf(r.other_id), seconds: Math.round(r.s) }));
  const together = rows.reduce((s, r) => s + r.together, 0);

  // Where this person ranks among everyone who watched that year (1 = watched the most).
  const totals = db().prepare('SELECT user_id, SUM(seconds) AS s FROM watch_log WHERE day BETWEEN ? AND ? GROUP BY user_id HAVING s >= 60 ORDER BY s DESC')
    .all(from, to);
  const rank = totals.findIndex((r) => r.user_id === userId) + 1;

  const fromMs = new Date(`${year}-01-01T00:00:00`).getTime(), toMs = new Date(`${year + 1}-01-01T00:00:00`).getTime();
  const liked = db().prepare('SELECT title FROM ratings WHERE user_id = ? AND value = 1 AND updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC')
    .all(userId, fromMs, toMs);
  const first = rows[0];
  return {
    ...base,
    titles: titles.size,
    films: ranked.filter((t) => !t.tv).length,
    episodes: rows.filter((r) => r.season != null && r.episode != null).reduce((set, r) => set.add(`${r.title_key || r.title}|${r.season}x${r.episode}`), new Set()).size,
    finished: rows.filter((r) => r.finished).length,
    top,
    topShow: topShow ? { key: topShow.key, title: topShow.title, episodes: topShow.episodes.size, seconds: Math.round(topShow.seconds) } : null,
    first: { title: first.title, season: first.season, episode: first.episode, day: first.day },
    busiestDay: { day: busyDay, seconds: Math.round(busySeconds) },
    busiestMonth: tr(MONTHS[maxIdx(months)]),
    busiestWeekday: tr(WEEKDAYS[maxIdx(weekdays)]),
    months: months.map(Math.round),
    activeDays: days.length,
    streak,
    together: Math.round(together),
    company,
    rank, people: totals.length,
    likes: liked.length,
    liked: liked.slice(0, 5).map((r) => r.title).filter(Boolean),
  };
}

// ---------- planned watch parties ----------
// Only rooms with a start time are stored: a room someone is watching in right now lives in memory,
// but a party planned for tonight has to survive a restart in between.
export const partyStore = {
  save(room) {
    db().prepare(`INSERT INTO watch_parties (token, creator, media, starts_at, people, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET media = excluded.media, starts_at = excluded.starts_at, people = excluded.people`)
      .run(room.token, room.creator, JSON.stringify({ media: room.media, creatorName: room.creatorName, position: room.position }),
        room.startsAt, JSON.stringify([...room.people]), room.created);
  },
  remove(token) { db().prepare('DELETE FROM watch_parties WHERE token = ?').run(token); },
  load() {
    return db().prepare('SELECT * FROM watch_parties').all().map((r) => {
      try {
        const { media, creatorName, position } = JSON.parse(r.media);
        return { token: r.token, creator: r.creator, media, creatorName, position: Number(position) || 0,
          startsAt: r.starts_at, people: JSON.parse(r.people), created: r.created_at };
      }
      catch { return null; }
    }).filter(Boolean);
  },
};
