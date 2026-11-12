import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntries, unseenFor, statusFor, allFor, initWhatsNew, buildId, MAX_UNSEEN, updatesToPush, pushFor } from '../src/whats-new.js';

const entry = (id, date, items = [{ title: `Feature ${id}`, text: 'Does a thing.' }], title = `Update ${id}`) => ({ id, date, title, items });
const user = (settings = {}, createdAt = Date.parse('2026-01-01'), isOwner = false) => ({ settings, createdAt, isOwner });

test('entries are cleaned, de-duplicated and sorted newest first', () => {
  const list = parseEntries([
    entry('a', '2026-03-01'),
    entry('b', '2026-05-01'),
    entry('a', '2026-06-01'), // duplicate id
    { id: 'bad id!', date: '2026-04-01', items: [{ title: 'x' }] },
    { id: 'nodate', items: [{ title: 'x' }] },
    entry('empty', '2026-04-01', [{ title: '', text: '' }]),
    'nonsense',
  ]);
  assert.deepEqual(list.map((e) => e.id), ['b', 'a']);
  assert.deepEqual(parseEntries({ not: 'a list' }), []);
});

test('someone who has seen an update only gets the newer ones', () => {
  const list = parseEntries([entry('u1', '2026-02-01'), entry('u2', '2026-03-01'), entry('u3', '2026-04-01')]);
  assert.deepEqual(unseenFor(user({ seenUpdate: 'u2' }), list).map((e) => e.id), ['u3']);
  assert.deepEqual(unseenFor(user({ seenUpdate: 'u3' }), list), []);
});

test('a newcomer sees only updates from the day they joined on', () => {
  const list = parseEntries([entry('old', '2026-02-01'), entry('new', '2026-04-10')]);
  assert.deepEqual(unseenFor(user({}, Date.parse('2026-04-10T15:00:00Z')), list).map((e) => e.id), ['new']);
  assert.deepEqual(unseenFor(user({}, Date.parse('2026-05-01')), list), []);
});

test('a seen update that was removed from the file falls back to its date', () => {
  const list = parseEntries([entry('2026-03-01', '2026-03-01'), entry('2026-05-01', '2026-05-01')]);
  assert.deepEqual(unseenFor(user({ seenUpdate: '2026-04-01' }), list).map((e) => e.id), ['2026-05-01']);
  assert.deepEqual(unseenFor(user({ seenUpdate: 'gone-and-undated' }), list), []);
});

test('at most a few updates pop up at once', () => {
  const list = parseEntries(Array.from({ length: 6 }, (_, i) => entry(`u${i}`, `2026-0${i + 1}-01`)));
  const unseen = unseenFor(user({}, Date.parse('2025-12-01')), list);
  assert.equal(unseen.length, MAX_UNSEEN);
  assert.equal(unseen[0].id, 'u5');
});

test('owner-only items are hidden from everyone else', () => {
  const list = parseEntries([
    entry('mixed', '2026-04-01', [{ title: 'For all' }, { title: 'Owner tool', audience: 'owner' }]),
    entry('owner-only', '2026-05-01', [{ title: 'Server thing', audience: 'owner' }]),
  ]);
  const member = unseenFor(user({}, Date.parse('2026-01-01')), list);
  assert.deepEqual(member.map((e) => e.id), ['mixed']);
  assert.deepEqual(member[0].items.map((i) => i.title), ['For all']);
  assert.equal('audience' in member[0].items[0], false);
  const owner = unseenFor(user({}, Date.parse('2026-01-01'), true), list);
  assert.deepEqual(owner.map((e) => e.id), ['owner-only', 'mixed']);
});

test('history written after the fact is listed but never pops up', () => {
  const list = parseEntries([
    { ...entry('past', '2026-02-01'), announce: false },
    { ...entry('past2', '2026-04-15'), announce: false },
    entry('now', '2026-04-10'),
  ]);
  const newcomer = user({}, Date.parse('2026-01-15'));
  assert.deepEqual(unseenFor(newcomer, list).map((e) => e.id), ['now']);
  assert.deepEqual(unseenFor(user({ seenUpdate: 'past' }), list).map((e) => e.id), ['now']);
  assert.deepEqual(unseenFor(user({ seenUpdate: 'now' }), list), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-whats-new-'));
  const file = path.join(dir, 'whats-new.json');
  try {
    initWhatsNew(file);
    fs.writeFileSync(file, JSON.stringify([{ ...entry('past', '2026-02-01'), announce: false }, entry('now', '2026-04-10')]));
    assert.equal(statusFor(user(), 'b1').latest, 'now');
    const all = allFor(user());
    assert.deepEqual(all.map((e) => e.id), ['now', 'past']);
    assert.ok(all.every((e) => !('announce' in e)), 'the flag stays on the server');
  } finally {
    initWhatsNew(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is read from disk and re-read when it changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-whats-new-'));
  const file = path.join(dir, 'whats-new.json');
  try {
    initWhatsNew(file);
    assert.deepEqual(statusFor(user(), 'b1'), { latest: null, unseen: [], build: 'b1' });
    fs.writeFileSync(file, JSON.stringify([entry('first', '2026-03-01')]));
    assert.equal(statusFor(user(), 'b1').latest, 'first');
    fs.writeFileSync(file, JSON.stringify([entry('first', '2026-03-01'), entry('second', '2026-03-02')]));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // make sure the mtime moves on fast filesystems
    const status = statusFor(user({ seenUpdate: 'first' }), 'b1');
    assert.equal(status.latest, 'second');
    assert.deepEqual(status.unseen.map((e) => e.id), ['second']);
    assert.equal(allFor(user()).length, 2);
    fs.writeFileSync(file, '{ broken');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.deepEqual(allFor(user()), []);
  } finally {
    initWhatsNew(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped whats-new.json is valid and nothing in it is dropped', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../whats-new.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(raw) && raw.length > 0);
  assert.equal(parseEntries(raw).length, raw.length);
  for (const e of raw) for (const i of e.items) assert.ok(i.title && i.text, `${e.id}: every item needs a title and a text`);
  // only the newest updates may pop up: everything older is history written after the fact
  const firstAnnounced = raw.findLastIndex((e) => e.announce !== false);
  assert.ok(raw.slice(0, firstAnnounced + 1).every((e) => e.announce !== false), 'a quiet history entry sits between announced ones');
});

test('the build id changes with the files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-build-'));
  try {
    const f = path.join(dir, 'app.js');
    fs.writeFileSync(f, 'one');
    const a = buildId([f]);
    assert.equal(buildId([f]), a);
    fs.writeFileSync(f, 'two');
    assert.notEqual(buildId([f]), a);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- update notifications ----------
const trEn = (text, ...args) => text.replace(/\{(\d+)\}/g, (_, i) => args[+i] ?? '');
const day = (iso) => new Date(`${iso}T12:00:00`).getTime();

test('only new, recent, announced updates are pushed, and each once', () => {
  const list = parseEntries([
    entry('today', '2026-11-10'), entry('yesterday', '2026-11-09'), entry('old', '2026-11-01'),
    { ...entry('quiet', '2026-11-10'), announce: false },
  ]);
  const now = day('2026-11-10');
  assert.deepEqual(updatesToPush([], { now, list }).map((e) => e.id), ['today', 'yesterday']);
  assert.deepEqual(updatesToPush(['today'], { now, list }).map((e) => e.id), ['yesterday']);
  assert.deepEqual(updatesToPush(['today', 'yesterday'], { now, list }), []);
});

test('an update file still being written is not pushed yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-push-'));
  const file = path.join(dir, 'whats-new.json');
  fs.writeFileSync(file, JSON.stringify([entry('fresh', '2026-11-10')]));
  initWhatsNew(file);
  const written = fs.statSync(file).mtimeMs;
  assert.deepEqual(updatesToPush([], { now: written + 10000 }), []);
  // Settled, but dated more than a day before "now": too old to announce.
  assert.deepEqual(updatesToPush([], { now: day('2026-11-20') }), []);
  initWhatsNew(null);
});

test('one update: its title plus a short summary and "Tap to read more"', () => {
  const list = parseEntries([entry('u1', '2026-11-10', [{ title: 'Faster starts', text: 'Videos start in a second. Even on phones.' }], 'Quicker playback')]);
  const msg = pushFor(user(), ['u1'], { tr: trEn, list });
  assert.equal(msg.title, 'Lilin update: Quicker playback');
  assert.equal(msg.body, 'Videos start in a second. Tap to read more.');
  assert.equal(msg.url, '/?update=u1');
  assert.equal(msg.tag, 'lilin-update');
});

test('several items or updates are summed up by their headlines, and long ones are cut', () => {
  const list = parseEntries([
    entry('u2', '2026-11-10', [{ title: 'One', text: 'x.' }, { title: 'Two', text: 'y.' }], 'Two things'),
    entry('u1', '2026-11-09', [{ title: 'A', text: 'z.' }], 'Earlier'),
  ]);
  assert.equal(pushFor(user(), ['u2'], { tr: trEn, list }).body, 'One · Two Tap to read more.');
  const both = pushFor(user(), ['u2', 'u1'], { tr: trEn, list });
  assert.equal(both.title, '2 Lilin updates');
  assert.equal(both.body, 'Two things · Earlier Tap to read more.');
  assert.equal(both.url, '/?update=u2');
  const long = parseEntries([entry('l', '2026-11-10', [{ title: 'L', text: `${'word '.repeat(100)}end.` }])]);
  const body = pushFor(user(), ['l'], { tr: trEn, list: long }).body;
  assert.ok(body.length <= 300 && /… Tap to read more\.$/.test(body), body);
});

test('nobody hears about an update they already saw or can not read', () => {
  const list = parseEntries([
    entry('u2', '2026-11-10', [{ title: 'Owner bit', text: 'x.', audience: 'owner' }]),
    entry('u1', '2026-11-09'),
  ]);
  assert.equal(pushFor(user({ seenUpdate: 'u1' }), ['u2'], { tr: trEn, list }), null); // owner-only for a guest
  assert.ok(pushFor(user({ seenUpdate: 'u1' }, undefined, true), ['u2'], { tr: trEn, list }));
  assert.equal(pushFor(user({ seenUpdate: 'u2' }, undefined, true), ['u2'], { tr: trEn, list }), null);
});
