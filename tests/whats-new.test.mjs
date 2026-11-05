import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntries, unseenFor, statusFor, allFor, initWhatsNew, buildId, MAX_UNSEEN } from '../src/whats-new.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-whats-new-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-whats-new-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-build-'));
  try {
    const f = path.join(dir, 'app.js');
    fs.writeFileSync(f, 'one');
    const a = buildId([f]);
    assert.equal(buildId([f]), a);
    fs.writeFileSync(f, 'two');
    assert.notEqual(buildId([f]), a);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
