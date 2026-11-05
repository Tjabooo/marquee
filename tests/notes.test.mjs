import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NotesStore } from '../src/notes.js';
import { parseDiscordExport, importTimestamp } from '../public/notes-import.js';

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-notes-'));
  const store = new NotesStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
};

test('shared notes persist, search Unicode and prefixes, edit without changing creation dates, and recover from trash', (t) => {
  const store = setup(t);
  const one = store.create({ text: 'Köp äpplen på torsdag', reminderAt: Date.now() - 1000 }, 'owner@example.test');
  const other = store.create({ text: '<img src=x onerror=alert(1)> server backup' }, 'admin@example.test');
  assert.equal(store.list({ q: 'appl tors' }).notes[0].id, one.id);
  assert.equal(store.list({ q: 'backup OR' }).total, 0, 'FTS operators are treated as keywords');
  assert.equal(store.list({ filter: 'due' }).total, 1);
  const edited = store.update(one.id, { version: one.version, text: 'Köp päron', pinned: true });
  assert.equal(edited.createdAt, one.createdAt);
  assert.equal(store.list({ q: 'applen' }).total, 0, 'Search index follows edits');
  assert.equal(store.list({ q: 'par' }).total, 1);
  assert.equal(store.list({ filter: 'pinned' }).notes[0].id, one.id);
  assert.throws(() => store.update(one.id, { version: one.version, text: 'stale overwrite' }), { status: 409 });
  const done = store.update(one.id, { version: edited.version, done: true });
  assert.equal(store.list({ filter: 'due' }).total, 0);
  const trashed = store.update(one.id, { version: done.version }, 'trash');
  assert.equal(store.list().total, 1);
  assert.equal(store.list({ filter: 'trash' }).notes[0].id, one.id);
  assert.throws(() => store.update(one.id, { version: trashed.version, text: 'change while trashed' }), { status: 409 });
  const restored = store.update(one.id, { version: trashed.version }, 'restore');
  assert.equal(restored.createdAt, one.createdAt);
  assert.equal(store.get(other.id).text, '<img src=x onerror=alert(1)> server backup');
  const reopened = new NotesStore(path.dirname(store.db.prepare('PRAGMA database_list').get().file));
  assert.equal(reopened.get(one.id).text, 'Köp päron');
  reopened.close();
});

test('imports preserve original dates and IDs, are idempotent, and validate the entire batch before writing', (t) => {
  const store = setup(t);
  const first = { id: '900000000000000001', text: 'Original note', createdAt: '2020-02-03T04:05:06.123Z' };
  const second = { id: '900000000000000002', text: '', createdAt: '2020-02-03T04:05:06.123Z', attachments: [{ url: 'https://cdn.discordapp.com/attachments/a/b/image.png', name: 'image.png' }] };
  assert.deepEqual(store.import({ messages: [first, second], channelId: '800000000000000001' }, 'owner'), { added: 2, skipped: 0, first: Date.parse(first.createdAt), last: Date.parse(first.createdAt) });
  const items = store.list({ limit: 1 }); assert.equal(items.notes.length, 1); assert.ok(items.nextBefore);
  const previous = store.list({ limit: 1, before: items.nextBefore }); assert.notEqual(previous.notes[0].id, items.notes[0].id, 'Pagination handles identical timestamps');
  assert.equal(store.import({ messages: [first, second] }, 'owner').skipped, 2);
  const note = store.list().notes[0];
  assert.equal(note.createdAt, Date.parse(first.createdAt));
  assert.equal(note.sourceId, first.id);
  const deleted = store.update(note.id, { version: note.version }, 'trash');
  store.import({ messages: [first] }, 'owner'); assert.equal(store.get(deleted.id).deletedAt, deleted.deletedAt, 'Retry does not resurrect discarded messages');
  assert.throws(() => store.import({ messages: [{ ...first, id: '900000000000000003' }, { ...second, attachments: [{ url: 'javascript:alert(1)' }] }] }, 'owner'), { status: 400 });
  assert.equal(store.list({ filter: 'all' }).total, 1, 'An invalid batch wrote nothing');
  assert.throws(() => store.create({ text: ' '.repeat(5) }, 'owner'), { status: 400 });
  assert.throws(() => store.create(null, 'owner'), { status: 400 });
  const huge = 'x'.repeat(200_000);
  const hugeNote = store.create({ text: huge }, 'owner');
  assert.equal(store.get(hugeNote.id).text.length, huge.length, 'large prompts fit in one note');
  assert.throws(() => store.create({ text: 'x'.repeat(1_000_001) }, 'owner'), { status: 400 });
});

test('Discord JSON and quoted multiline CSV preserve IDs, exact UTC dates, text, and author choices', () => {
  const csv = 'ID,Timestamp,Contents,Attachments\r\n900000000000000001,2020-02-03 04:05:06.123000,"one, two\nline ""three""",https://cdn.discordapp.com/attachments/a/b/p.png';
  const result = parseDiscordExport(csv);
  assert.equal(result.messages[0].text, 'one, two\nline "three"');
  assert.equal(result.messages[0].createdAt, Date.parse('2020-02-03T04:05:06.123Z'));
  assert.equal(result.messages[0].attachments.length, 1);
  assert.equal(result.messages[0].id, '900000000000000001');
  const json = parseDiscordExport(JSON.stringify({ channel: { id: '800000000000000001', name: 'MEE6' }, messages: [
    { id: '900000000000000001', content: 'Mine', timestamp: '2020-02-03T04:05:06Z', author: { id: '123', name: 'Me', isBot: false } },
    { id: '900000000000000002', content: 'Bot', timestamp: '2020-02-03T04:05:07Z', author: { id: '456', name: 'MEE6', isBot: true } },
  ] }));
  assert.equal(json.authors.filter((a) => !a.bot).length, 1);
  assert.equal(json.channelName, 'MEE6');
  assert.throws(() => parseDiscordExport('[{"ID":900000000000000001,"Timestamp":"2020-01-01"}]'), /precision/);
  assert.equal(importTimestamp(undefined, '900000000000000001'), Number((900000000000000001n >> 22n) + 1420070400000n));
});
