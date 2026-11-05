import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { NotesStore } from '../src/notes.js';
import { NotesOcr, windowsOcr } from '../src/notes-ocr.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'marquee-notes-ocr-'));
const quiet = { warn() {} };
async function addFile(store, id, mime, body = 'x') {
  await fs.mkdir(store.fileDir, { recursive: true });
  await fs.writeFile(path.join(store.fileDir, `${id}.bin`), body);
  store.registerFile(id, { name: `${id.slice(0, 4)}.bin`, mime, size: body.length });
}

test('text read from images becomes searchable keywords without counting as an edit', async () => {
  const root = await temp(), store = new NotesStore(root);
  try {
    const png = 'a'.repeat(64), jpg = 'b'.repeat(64), pdf = 'c'.repeat(64), gone = 'd'.repeat(64);
    await addFile(store, png, 'image/png'); await addFile(store, jpg, 'image/jpeg'); await addFile(store, pdf, 'application/pdf');
    store.registerFile(gone, { name: 'gone.png', mime: 'image/png', size: 1 });
    const note = store.create({ text: 'Receipt', attachments: [{ fileId: png }] }, 'owner@test');
    const seen = [];
    const ocr = new NotesOcr(store, { enabled: true, log: quiet, run: async (files) => {
      seen.push(...files.map((f) => path.basename(f)));
      return files.map((f) => f.includes('aaaa') ? { text: 'Kvitto ICA Maxi\nTotal 249,00' } : { error: 'unreadable' });
    } });
    await ocr.kick();
    assert.deepEqual(seen.sort(), [`${png}.bin`, `${jpg}.bin`], 'only images that exist are read');
    assert.equal(store.list({ q: 'kvitto' }).notes[0]?.id, note.id);
    assert.equal(store.list({ q: 'receipt maxi' }).total, 1, 'words from the text and the image combine');
    assert.equal(store.list({ q: '249,00' }).total, 1);
    assert.equal(store.get(note.id).version, note.version);
    assert.equal(store.get(note.id).updatedAt, note.updatedAt);
    // Already-read images are reused by later notes and never read twice.
    const later = store.create({ text: '', attachments: [{ fileId: png }, { fileId: jpg }] }, 'owner@test');
    assert.ok(store.list({ q: 'ica' }).notes.some((n) => n.id === later.id));
    seen.length = 0; await ocr.kick(); assert.deepEqual(seen, []);
    // Editing the text keeps the image keywords searchable; deleting from FTS stays consistent.
    store.update(note.id, { text: 'Changed', version: note.version });
    assert.equal(store.list({ q: 'kvitto' }).total, 2);
    assert.equal(store.list({ q: 'receipt' }).total, 0);
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a failed OCR run leaves images pending and retries later', async () => {
  const root = await temp(), store = new NotesStore(root);
  try {
    await addFile(store, 'e'.repeat(64), 'image/webp');
    const ocr = new NotesOcr(store, { enabled: true, log: quiet, run: async () => { throw Error('powershell missing'); } });
    await ocr.kick(); clearTimeout(ocr.retryTimer);
    assert.equal(store.pendingOcr().length, 1);
    const off = new NotesOcr(store, { enabled: false, run: async () => assert.fail('disabled OCR must not run') });
    await off.kick();
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('older databases gain keyword search without losing notes', async () => {
  const root = await temp(), db = new DatabaseSync(path.join(root, '.marquee.db'));
  db.exec(`CREATE TABLE note_files(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', author TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, pinned INTEGER NOT NULL DEFAULT 0,
      reminder_at INTEGER, done_at INTEGER, deleted_at INTEGER, source_id TEXT UNIQUE, source_channel TEXT, original_edited_at INTEGER);
    CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, body) VALUES(new.id, new.body); END;
    INSERT INTO notes(body, author, created_at, updated_at) VALUES('Old wifi password note', 'owner@test', 1, 1);`);
  db.close();
  const store = new NotesStore(root);
  try {
    assert.equal(store.list({ q: 'wifi' }).total, 1);
    const id = 'f'.repeat(64); await addFile(store, id, 'image/png');
    const note = store.create({ text: 'Photo', attachments: [{ fileId: id }] }, 'owner@test');
    store.setFileText(id, 'Router WPA2 key');
    assert.equal(store.list({ q: 'router' }).notes[0].id, note.id);
    store.close(); const again = new NotesStore(root);
    assert.equal(again.list({ q: 'wpa2' }).total, 1, 'reopening does not rebuild or lose keywords'); again.close();
  } finally { try { store.close(); } catch { /* already closed */ } await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows OCR reads text from a real image', { skip: process.platform !== 'win32' && 'needs Windows' , timeout: 60000 }, async () => {
  const dir = await temp(), file = path.join(dir, 'sign.png'), bad = path.join(dir, 'bad.png');
  try {
    const draw = `Add-Type -AssemblyName System.Drawing; $b = New-Object Drawing.Bitmap 900,200; $g = [Drawing.Graphics]::FromImage($b);
      $g.Clear([Drawing.Color]::White); $g.DrawString('MARQUEE GATE 4711', (New-Object Drawing.Font 'Arial',48), [Drawing.Brushes]::Black, 20, 50);
      $b.Save('${file.replace(/'/g, "''")}', [Drawing.Imaging.ImageFormat]::Png)`;
    assert.equal(spawnSync('powershell.exe', ['-NoProfile', '-Command', draw]).status, 0);
    await fs.writeFile(bad, 'not an image');
    const [good, broken] = await windowsOcr([file, bad]);
    assert.match(good.text, /MARQUEE GATE 4711/i);
    assert.ok(broken.error);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
