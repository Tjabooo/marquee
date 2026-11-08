// What's new: short, plain-language notes about each update, shown to everyone once after it goes live
// so nobody has to be told about new features. The notes are written by hand in whats-new.json at the
// app root (newest first), separate from CHANGELOG.md, which is for the people running the server:
//
//   [{ "id": "2026-11-05", "date": "2026-11-05", "title": "…",
//      "items": [{ "title": "…", "text": "…", "audience": "owner" (optional: only the owner sees it) }] }]
//
// "announce": false keeps an entry in the history (the What's new button) without ever popping it up,
// for notes written after the fact about older updates.
//
// Each person's settings remember the newest update they've seen (seenUpdate). People who have never
// seen one see the updates published since they joined, so a newcomer isn't shown the whole history.
import { currentLanguage } from './i18n.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ID = /^[A-Za-z0-9._-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_UNSEEN = 3; // a popup never shows more than the three newest updates

let file = null;
let cache = { mtimeMs: -1, entries: [] };

export function initWhatsNew(path) {
  file = path;
  cache = { mtimeMs: -1, entries: [] };
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Entries that are well-formed, newest first. A broken file shows nothing rather than failing requests.
export function parseEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (!e || !ID.test(String(e.id)) || !DATE.test(String(e.date)) || seen.has(e.id)) continue;
    const items = (Array.isArray(e.items) ? e.items : [])
      .map((i) => ({ title: text(i?.title, 120), text: text(i?.text, 600), audience: i?.audience === 'owner' ? 'owner' : 'all' }))
      .filter((i) => i.title || i.text);
    if (!items.length) continue;
    seen.add(e.id);
    out.push({ id: e.id, date: e.date, title: text(e.title, 120), items, announce: e.announce !== false });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function entries() {
  if (!file) return [];
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  if (stat.mtimeMs !== cache.mtimeMs) {
    let raw = [];
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.warn(`whats-new.json: ${err.message}`); }
    cache = { mtimeMs: stat.mtimeMs, entries: parseEntries(raw) };
  }
  return cache.entries;
}

// What this person may read: owner-only items are left out for everyone else.
// Swedish notes live beside the English ones in whats-new.sv.json, under the same id. The English item titles are
// the keys, so an owner-only item can be hidden without the two lists drifting apart. No Swedish yet: English.
let swedish = null;
function swedishNotes() {
  if (swedish) return swedish;
  try { swedish = JSON.parse(fs.readFileSync(new URL('../whats-new.sv.json', import.meta.url), 'utf8')); } catch { swedish = {}; }
  return swedish;
}
function inViewersLanguage(entry) {
  if (currentLanguage() !== 'sv') return entry;
  const sv = swedishNotes()[entry.id];
  if (!sv) return entry;
  return { ...entry, title: sv.title || entry.title, items: entry.items.map((item) => ({ ...item, ...sv.items?.[item.title] })) };
}

function visible(list, user) {
  return list
    .map(({ announce, ...e }) => ({ ...e, items: e.items.filter((i) => i.audience === 'all' || user?.isOwner).map(({ title, text }) => ({ title, text })) }))
    .filter((e) => e.items.length)
    .map(inViewersLanguage);
}

export const allFor = (user) => visible(entries(), user);
const announced = (list) => list.filter((e) => e.announce);
export const isUpdateId = (id) => ID.test(String(id));

// The updates this person hasn't seen yet, newest first.
export function unseenFor(user, list = entries()) {
  const mine = visible(announced(list), user);
  const seenId = user?.settings?.seenUpdate || '';
  const seenAt = mine.findIndex((e) => e.id === seenId);
  let unseen;
  if (seenAt >= 0) unseen = mine.slice(0, seenAt);
  else if (seenId) {
    // The one they saw has since been removed from the file: compare by date instead.
    const seenDate = list.find((e) => e.id === seenId)?.date || seenId.slice(0, 10);
    unseen = DATE.test(seenDate) ? mine.filter((e) => e.date > seenDate) : [];
  } else {
    const joined = new Date(user?.createdAt || 0).toISOString().slice(0, 10);
    unseen = mine.filter((e) => e.date >= joined);
  }
  return unseen.slice(0, MAX_UNSEEN);
}

// The status reply's part: newest update id, the unseen ones, and a build id that changes when the
// web app does, so an open page can offer a reload after an update.
export function statusFor(user, build) {
  const list = visible(announced(entries()), user);
  return { latest: list[0]?.id || null, unseen: unseenFor(user), build };
}

// Identifies the web app the server is handing out (its files' contents), computed once at start.
export function buildId(files) {
  const hash = crypto.createHash('sha1');
  for (const f of files) {
    try { hash.update(fs.readFileSync(f)); } catch { /* missing file: still a stable id */ }
  }
  return hash.digest('hex').slice(0, 12);
}
