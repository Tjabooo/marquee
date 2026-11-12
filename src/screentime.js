// Screen Time: daily summaries pushed by the `screentime` daemon on each machine
// (github.com/Tjabooo/screentime), shown to the owner in House → Screen Time.
//
// POST /api/screentime  with "Authorization: Bearer $SCREENTIME_TOKEN" and
//   { device, date: 'YYYY-MM-DD', final, summary: <screentime today --json> }
// The daemon re-sends today's running summary every few minutes and queues days it couldn't send
// (asleep, away from home), so a later push of the same day simply replaces the earlier one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = process.env.SCREENTIME_TOKEN || '';
const KEEP_DAYS = 400;
let file = null;
let data = { devices: {} };

export function initScreenTime({ dataDir }) {
  file = path.join(dataDir, '.lilin-screentime.json');
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = { devices: {} }; }
  if (!data.devices || typeof data.devices !== 'object') data = { devices: {} };
}

export const screenTimeConfigured = () => Boolean(TOKEN);

export function tokenAllowed(req) {
  if (!TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  const given = Buffer.from(m ? m[1].trim() : '');
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function save() {
  if (!file) return;
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* kept in memory */ }
}

// ---------- validation: keep only what the page shows, bounded ----------
const DAY = 86400;
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const secs = (v, max = DAY + 3600) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(max, Math.round(Number(v)))) : 0);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const hhmm = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

function cleanSummary(s) {
  if (!s || typeof s !== 'object') throw Object.assign(new Error('summary must be an object'), { status: 400 });
  const cats = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 12)
    .map(([k, v]) => [String(k).slice(0, 40), secs(v, 3700)]).filter(([, v]) => v > 0));
  const hourly = Array.from({ length: 24 }, (_, h) => {
    const x = Array.isArray(s.hourly) ? s.hourly[h] : null;
    return { seconds: secs(x?.seconds, 3700), categories: cats(x?.categories) };
  });
  const ls = s.longest_session;
  return {
    total: secs(s.total),
    apps: list(s.apps, 60).map((a) => ({ app: str(a?.app, 120) || 'desktop', name: str(a?.name, 80) || str(a?.app, 80) || 'Desktop', category: str(a?.category, 40) || 'Other', seconds: secs(a?.seconds) }))
      .filter((a) => a.seconds > 0),
    categories: list(s.categories, 20).map((c) => ({ name: str(c?.name, 40) || 'Other', seconds: secs(c?.seconds) })).filter((c) => c.seconds > 0),
    hourly,
    pickups: secs(s.pickups, 10000),
    pickupsHourly: Array.from({ length: 24 }, (_, h) => secs(Array.isArray(s.pickups_hourly) ? s.pickups_hourly[h] : 0, 10000)),
    firstPickup: hhmm(s.first_pickup),
    afterPickup: list(s.after_pickup, 10).map((a) => ({ app: str(a?.app, 120) || 'desktop', name: str(a?.name, 80) || 'Desktop', count: secs(a?.count, 10000) })).filter((a) => a.count > 0),
    longest: ls && typeof ls === 'object' && secs(ls.seconds) > 0
      ? { seconds: secs(ls.seconds), start: hhmm(ls.start), end: hhmm(ls.end), app: str(ls.app, 120), name: str(ls.name, 80) } : null,
    sittings: secs(s.sittings, 10000),
    complete: Boolean(s.complete),
    generated: secs(s.generated, 4102444800),
  };
}

export function acceptSummary(body) {
  const device = str(body?.device, 40);
  if (!device || !/^[\w .-]+$/.test(device)) throw Object.assign(new Error('device: letters, digits, space, . _ - (max 40)'), { status: 400 });
  if (!isDate(body?.date)) throw Object.assign(new Error('date must be YYYY-MM-DD'), { status: 400 });
  const summary = cleanSummary(body.summary);
  const d = (data.devices[device] ||= { days: {} });
  const old = d.days[body.date];
  // a queued older copy arriving late never overwrites a newer one
  if (old && old.generated > summary.generated) return { ok: true, kept: 'newer' };
  d.days[body.date] = summary;
  d.lastSeen = Date.now();
  const dates = Object.keys(d.days).sort();
  for (const old of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete d.days[old];
  save();
  return { ok: true };
}

// ---------- report for the page ----------
const addDays = (date, n) => {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
const mondayOf = (date) => addDays(date, -((weekday(date) + 6) % 7));

// All devices as one: times and pickups add up, the first pickup is the earliest.
function combine(summaries) {
  const list = summaries.filter(Boolean);
  if (list.length <= 1) return list[0] || null;
  const apps = new Map(), cats = new Map(), after = new Map();
  const add = (map, key, make, n) => { const x = map.get(key) || make(); x.value += n; map.set(key, x); };
  for (const s of list) {
    for (const a of s.apps) add(apps, a.name, () => ({ ...a, value: 0 }), a.seconds);
    for (const c of s.categories) add(cats, c.name, () => ({ name: c.name, value: 0 }), c.seconds);
    for (const a of s.afterPickup) add(after, a.name, () => ({ ...a, value: 0 }), a.count);
  }
  const sorted = (map, field) => [...map.values()].sort((a, b) => b.value - a.value).map(({ value, ...x }) => ({ ...x, [field]: value }));
  return {
    total: list.reduce((n, s) => n + s.total, 0),
    apps: sorted(apps, 'seconds'),
    categories: sorted(cats, 'seconds'),
    hourly: Array.from({ length: 24 }, (_, h) => {
      const categories = {};
      for (const s of list) for (const [k, v] of Object.entries(s.hourly[h].categories)) categories[k] = (categories[k] || 0) + v;
      return { seconds: list.reduce((n, s) => n + s.hourly[h].seconds, 0), categories };
    }),
    pickups: list.reduce((n, s) => n + s.pickups, 0),
    pickupsHourly: Array.from({ length: 24 }, (_, h) => list.reduce((n, s) => n + s.pickupsHourly[h], 0)),
    firstPickup: list.map((s) => s.firstPickup).filter(Boolean).sort()[0] || null,
    afterPickup: sorted(after, 'count').slice(0, 10),
    longest: list.map((s) => s.longest).filter(Boolean).sort((a, b) => b.seconds - a.seconds)[0] || null,
    sittings: list.reduce((n, s) => n + s.sittings, 0),
    complete: list.every((s) => s.complete),
    generated: Math.max(...list.map((s) => s.generated)),
  };
}

function dayOf(devices, date) {
  return combine(devices.map((name) => data.devices[name]?.days[date]));
}

function weekOf(devices, date, latest, first) {
  const start = mondayOf(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const rows = days.map((d) => {
    const s = dayOf(devices, d);
    const categories = Object.fromEntries((s?.categories || []).map((c) => [c.name, c.seconds]));
    return { date: d, total: s ? s.total : d <= latest && d >= first ? 0 : null, pickups: s ? s.pickups : null, categories };
  });
  const average = (dates) => {
    const counted = dates.filter((d) => d <= latest && d >= first);
    if (!counted.length) return null;
    return Math.round(counted.reduce((n, d) => n + (dayOf(devices, d)?.total || 0), 0) / counted.length);
  };
  const avg = average(days);
  const lastAvg = average(days.map((d) => addDays(d, -7)));
  const sums = combine(days.map((d) => dayOf(devices, d)))
    || { total: 0, apps: [], categories: [], pickups: 0, longest: null };
  const counted = days.filter((d) => d <= latest && d >= first).length;
  return {
    start, end: days[6], days: rows,
    total: sums.total, average: avg ?? 0, lastAverage: lastAvg,
    change: lastAvg ? Math.round((100 * ((avg ?? 0) - lastAvg)) / lastAvg) : null,
    apps: sums.apps.slice(0, 30), categories: sums.categories,
    pickups: sums.pickups, pickupsAverage: counted ? Math.round(sums.pickups / counted) : 0,
    longest: sums.longest,
  };
}

export function screenTimeReport({ device, date, today } = {}) {
  const names = Object.keys(data.devices).sort((a, b) => (data.devices[b].lastSeen || 0) - (data.devices[a].lastSeen || 0));
  const devices = names.map((name) => {
    const dates = Object.keys(data.devices[name].days).sort();
    return { name, lastSeen: data.devices[name].lastSeen || null, latest: dates[dates.length - 1] || null, first: dates[0] || null };
  });
  const pick = device === 'all' || names.includes(device) ? device : names.length > 1 ? 'all' : names[0] || null;
  const chosen = pick === 'all' ? names : pick ? [pick] : [];
  const dates = [...new Set(chosen.flatMap((n) => Object.keys(data.devices[n].days)))].sort();
  const latest = dates[dates.length - 1] || null;
  const first = dates[0] || null;
  const day = isDate(date) ? date : (isDate(today) && (!latest || today >= latest) ? today : latest);
  if (!day) return { configured: screenTimeConfigured(), devices, device: pick, date: null, dates, day: null, week: null };
  const until = latest && latest > day ? latest : day;
  return {
    configured: screenTimeConfigured(),
    devices, device: pick, date: day, dates,
    day: dayOf(chosen, day),
    week: weekOf(chosen, day, until, first || day),
  };
}
