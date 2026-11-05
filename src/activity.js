// Activity log: who did what, and who's been around lately.
// People are identified by the email Cloudflare Access adds to each request
// (Cf-Access-Authenticated-User-Email). Requests that skip Cloudflare, like opening the server's
// local address at home, show up as "Home network".
import fs from 'node:fs';
import path from 'node:path';

const ADMINS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const KEEP = 2000;                   // entries kept in memory and in the file
const MAX_FILE = 2 * 1024 * 1024;    // the file is trimmed back to KEEP entries past this size

let file = null;
let events = [];
const lastSeen = new Map();          // user -> { at, device }
const recentKeys = new Map();        // dedup key -> time
let resolveName = null;
let resolveAvatar = null;

export function initActivity({ dataDir, nameForUser = null, avatarForUser = null }) {
  resolveName = nameForUser;
  resolveAvatar = avatarForUser;
  file = path.join(dataDir, '.marquee-activity.jsonl');
  try {
    events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { events = []; }
  for (const e of events) lastSeen.set(e.user, { at: e.at, device: e.device, location: e.location || null });
}

export const adminsConfigured = () => ADMINS.length > 0;

function userOf(req) {
  const email = String(req.headers['cf-access-authenticated-user-email'] || '').trim().toLowerCase();
  return email || 'Home network';
}

export const isAdmin = (req) => ADMINS.includes(userOf(req));
export const adminEmails = () => [...ADMINS];

// "iPhone · Safari", "Windows · Firefox", ...
function deviceOf(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : null;
  return browser ? `${os} · ${browser}` : os;
}

// Approximate IP location supplied by Cloudflare. Never send visitor IPs to a lookup service.
export function locationOf(req) {
  if (!req.headers['cf-connecting-ip'] || !req.headers['cf-ray']) return null;
  const raw = String(req.headers['cf-ipcity'] || '');
  let city = Buffer.from(raw, 'latin1').toString('utf8');
  if (city.includes('\uFFFD')) city = raw;
  try { city = decodeURIComponent(city); } catch { /* already decoded */ }
  city = city.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  const country = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  const validCountry = /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null;
  return city || validCountry ? { city: city || null, country: validCountry } : null;
}

// Called for every API request.
export function seen(req) {
  lastSeen.set(userOf(req), { at: Date.now(), device: deviceOf(req), location: locationOf(req) });
}

// action: download | delete | play | cast | stop | subtitles. Repeats of the same thing by the same
// person within `quietMs` are logged once (a film played twice in a row, a page reloaded).
// `user` overrides who it's logged as (an invite is accepted before its new user has signed in).
export function record(req, action, detail, { quietMs = 0, user: who = null } = {}) {
  const user = who || userOf(req);
  const key = `${user}|${action}|${detail}`;
  if (quietMs && Date.now() - (recentKeys.get(key) || 0) < quietMs) return;
  recentKeys.set(key, Date.now());
  if (recentKeys.size > 500) recentKeys.delete(recentKeys.keys().next().value);
  const entry = { at: Date.now(), user, device: deviceOf(req), location: locationOf(req), action, detail: String(detail || '').slice(0, 300) };
  events.push(entry);
  if (events.length > KEEP) events = events.slice(-KEEP);
  console.log(`[activity] ${user} (${entry.device}): ${action} ${entry.detail}`);
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    if (fs.statSync(file).size > MAX_FILE) fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch { /* best effort */ }
}

export function report(limit = 300) {
  // Resolve at read time so a renamed profile also updates historical events, without rewriting
  // the stable email identity stored in the log or grouping different people with the same name.
  const names = new Map();
  const nameOf = (user) => {
    if (!names.has(user)) names.set(user, resolveName?.(user) || String(user).split('@')[0]);
    return names.get(user);
  };
  const avatars = new Map();
  const avatarOf = (user) => {
    if (!avatars.has(user)) avatars.set(user, resolveAvatar?.(user) || null);
    return avatars.get(user);
  };
  return {
    people: [...lastSeen.entries()].map(([user, s]) => ({ user, name: nameOf(user), avatar: avatarOf(user), ...s })).sort((a, b) => b.at - a.at),
    events: events.slice(-limit).reverse().map((e) => ({ ...e, name: nameOf(e.user), avatar: avatarOf(e.user),
      ...(e.action === 'revoke' ? { subjectName: nameOf(e.detail) } : {}) })),
  };
}
