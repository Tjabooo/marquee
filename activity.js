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

export function initActivity({ dataDir }) {
  file = path.join(dataDir, '.marquee-activity.jsonl');
  try {
    events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { events = []; }
  for (const e of events) lastSeen.set(e.user, { at: e.at, device: e.device });
}

export const adminsConfigured = () => ADMINS.length > 0;

function userOf(req) {
  const email = String(req.headers['cf-access-authenticated-user-email'] || '').trim().toLowerCase();
  return email || 'Home network';
}

export const isAdmin = (req) => ADMINS.includes(userOf(req));

// "iPhone · Safari", "Windows · Firefox", ...
function deviceOf(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : null;
  return browser ? `${os} · ${browser}` : os;
}

// Called for every API request.
export function seen(req) {
  lastSeen.set(userOf(req), { at: Date.now(), device: deviceOf(req) });
}

// action: download | delete | play | cast | stop | subtitles. Repeats of the same thing by the same
// person within `quietMs` are logged once (a film played twice in a row, a page reloaded).
export function record(req, action, detail, { quietMs = 0 } = {}) {
  const user = userOf(req);
  const key = `${user}|${action}|${detail}`;
  if (quietMs && Date.now() - (recentKeys.get(key) || 0) < quietMs) return;
  recentKeys.set(key, Date.now());
  if (recentKeys.size > 500) recentKeys.delete(recentKeys.keys().next().value);
  const entry = { at: Date.now(), user, device: deviceOf(req), action, detail: String(detail || '').slice(0, 300) };
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
  return {
    people: [...lastSeen.entries()].map(([user, s]) => ({ user, ...s })).sort((a, b) => b.at - a.at),
    events: events.slice(-limit).reverse(),
  };
}
