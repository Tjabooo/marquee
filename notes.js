// Shared admin-only notes. Stored in the normal Marquee SQLite database and its backups.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { importTimestamp } from './public/notes-import.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const MAX_TEXT = 30000;
const bool = (v) => v ? 1 : 0;
function objectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a note object.');
  return body;
}

function attachmentsOf(value = [], fileExists = () => false) {
  if (!Array.isArray(value) || value.length > 50) fail(400, 'A note can have up to 50 attachment links.');
  return value.map((a) => {
    const file = /^[a-f0-9]{64}$/.test(a?.fileId || '') && fileExists(a.fileId);
    if (file && !a.url) return { fileId:a.fileId, name:file.name, mime:file.mime, size:file.size };
    if (!a || typeof a.url !== 'string' || a.url.length > 4096) fail(400, 'Invalid attachment link.');
    let url; try { url = new URL(a.url); } catch { fail(400, 'Invalid attachment link.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail(400, 'Attachment links must use HTTP or HTTPS.');
    const fileId = /^[a-f0-9]{64}$/.test(a.fileId || '') && fileExists(a.fileId) ? a.fileId : null;
    return { url: url.href, name: String(a.name || 'Attachment').slice(0, 255), ...(fileId ? { fileId } : {}) };
  });
}
function textOf(text, attachments = []) {
  if (typeof text !== 'string' || text.length > MAX_TEXT || (!text.trim() && !attachments.length)) fail(400, `Write a message of up to ${MAX_TEXT.toLocaleString()} characters.`);
  return text;
}
function reminderOf(value) {
  if (value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 8640000000000000) fail(400, 'Choose a valid reminder date.');
  return n;
}

export class NotesStore {
  constructor(dataDir, { fileDir } = {}) {
    this.fileDir = fileDir ? path.resolve(fileDir) : path.join(dataDir, '.marquee-notes-files');
    this.db = new DatabaseSync(path.join(dataDir, '.marquee.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS note_files(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY, body TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]',
        author TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, pinned INTEGER NOT NULL DEFAULT 0,
        reminder_at INTEGER, done_at INTEGER, deleted_at INTEGER,
        source_id TEXT UNIQUE, source_channel TEXT, original_edited_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS notes_timeline ON notes(deleted_at, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS notes_reminders ON notes(reminder_at) WHERE deleted_at IS NULL AND done_at IS NULL;
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(body, content='notes', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, body) VALUES(new.id, new.body); END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.id, old.body); END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF body ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.id, old.body);
        INSERT INTO notes_fts(rowid, body) VALUES(new.id, new.body);
      END;`);
  }
  close() { this.db.close(); }
  file(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) return null;
    const row = this.db.prepare('SELECT * FROM note_files WHERE id=?').get(id);
    const full = path.join(this.fileDir, `${id}.bin`);
    return row && fs.existsSync(full) ? { ...row, full } : null;
  }
  registerFile(id, { name, mime, size }) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail(400, 'Invalid attachment ID.');
    this.db.prepare('INSERT INTO note_files(id,name,mime,size) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mime=excluded.mime,size=excluded.size')
      .run(id, name, mime || 'application/octet-stream', size);
  }
  public(row) {
    if (!row) return null;
    const attachments = JSON.parse(row.attachments).map((a) => {
      const file = a.fileId && this.file(a.fileId);
      return file ? { ...a, mime:file.mime, size:file.size } : a;
    });
    return { id: row.id, text: row.body, attachments, author: row.author,
      createdAt: row.created_at, updatedAt: row.updated_at, version: row.version, pinned: Boolean(row.pinned),
      reminderAt: row.reminder_at, doneAt: row.done_at, deletedAt: row.deleted_at,
      sourceId: row.source_id, sourceChannel: row.source_channel, originalEditedAt: row.original_edited_at };
  }
  get(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) fail(404, 'Note not found.');
    const note = this.public(this.db.prepare('SELECT * FROM notes WHERE id=?').get(Number(id)));
    if (!note) fail(404, 'Note not found.');
    return note;
  }
  list({ q = '', filter = 'all', before = '', limit = 100 } = {}) {
    q = String(q).trim(); if (q.length > 500) fail(400, 'Search is too long.');
    if (!['all', 'pinned', 'due', 'trash'].includes(filter)) fail(400, 'Unknown notes filter.');
    const clauses = [filter === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
    const params = [];
    if (filter === 'pinned') clauses.push('pinned=1');
    if (filter === 'due') { clauses.push('reminder_at<=? AND done_at IS NULL'); params.push(Date.now()); }
    if (q) {
      const words = q.match(/[\p{L}\p{N}_]+/gu) || [];
      if (words.length) {
        clauses.push('id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)');
        params.push(words.map((w) => `"${w}"*`).join(' AND '));
      } else { clauses.push('instr(body, ?) > 0'); params.push(q); }
    }
    const total = this.db.prepare(`SELECT count(*) AS n FROM notes WHERE ${clauses.join(' AND ')}`).get(...params).n;
    if (before) {
      if (!/^\d+:\d+$/.test(before)) fail(400, 'Invalid notes cursor.');
      const [at, id] = before.split(':').map(Number);
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(id)) fail(400, 'Invalid notes cursor.');
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); params.push(at, at, id);
    }
    limit = Math.floor(Math.min(100, Math.max(1, Number(limit) || 100)));
    const rows = this.db.prepare(`SELECT * FROM notes WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    const last = rows.at(-1);
    const due = this.db.prepare('SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL AND done_at IS NULL AND reminder_at<=?').get(Date.now()).n;
    return { notes: rows.reverse().map((r) => this.public(r)), total, due, nextBefore: more ? `${last.created_at}:${last.id}` : null };
  }
  create(body, actor) {
    objectBody(body);
    const attachments = attachmentsOf(body.attachments, (id) => this.file(id));
    const text = textOf(body.text ?? '', attachments), now = Date.now();
    const r = this.db.prepare('INSERT INTO notes(body,attachments,author,created_at,updated_at,reminder_at) VALUES(?,?,?,?,?,?)')
      .run(text, JSON.stringify(attachments), actor, now, now, body.reminderAt == null ? null : reminderOf(body.reminderAt));
    return this.get(Number(r.lastInsertRowid));
  }
  update(id, body, action = 'edit') {
    objectBody(body);
    for (const key of ['pinned', 'done']) if (Object.hasOwn(body, key) && typeof body[key] !== 'boolean') fail(400, `Invalid ${key} value.`);
    const note = this.get(id);
    if (body.version !== note.version) fail(409, 'This note changed on another device. Refresh before saving your changes.');
    if (action === 'restore' && !note.deletedAt || action === 'trash' && note.deletedAt) return note;
    if (note.deletedAt && action !== 'restore') fail(409, 'Restore this note before editing it.');
    const text = Object.hasOwn(body, 'text') ? textOf(body.text, note.attachments) : note.text;
    const reminder = Object.hasOwn(body, 'reminderAt') ? reminderOf(body.reminderAt) : note.reminderAt;
    const now = Date.now();
    const result = this.db.prepare(`UPDATE notes SET body=?, updated_at=?, version=version+1, pinned=?, reminder_at=?, done_at=?, deleted_at=? WHERE id=? AND version=?`)
      .run(text, now, Object.hasOwn(body, 'pinned') ? bool(body.pinned) : bool(note.pinned), reminder,
        Object.hasOwn(body, 'done') ? (body.done ? now : null) : note.doneAt,
        action === 'trash' ? now : action === 'restore' ? null : note.deletedAt, Number(id), body.version);
    if (!result.changes) fail(409, 'This note changed on another device. Refresh and try again.');
    return this.get(id);
  }
  import(body, actor) {
    objectBody(body);
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100000) fail(400, 'Choose an export containing 1–100,000 messages.');
    const channel = String(body.channelId || '');
    if (channel && !/^\d{16,22}$/.test(channel)) fail(400, 'Invalid Discord channel ID.');
    const messages = body.messages.map((r, i) => {
      if (!r || !/^\d{16,22}$/.test(String(r.id || '')) || typeof r.id === 'number' && !Number.isSafeInteger(r.id)) fail(400, `Message ${i + 1} has an invalid original ID.`);
      const attachments = attachmentsOf(r.attachments, (id) => this.file(id));
      let at, edited;
      try { at = importTimestamp(r.createdAt, r.id); edited = r.editedAt == null ? null : importTimestamp(r.editedAt, r.id); }
      catch (e) { fail(400, e.message); }
      return { id: String(r.id), text: textOf(r.text, attachments), attachments, at, edited };
    });
    const insert = this.db.prepare('INSERT INTO notes(body,attachments,author,created_at,updated_at,source_id,source_channel,original_edited_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO NOTHING');
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of messages) added += Number(insert.run(m.text, JSON.stringify(m.attachments), actor, m.at, m.edited || m.at, m.id, channel || null, m.edited).changes);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    const first = messages.reduce((n, m) => Math.min(n, m.at), Infinity);
    const last = messages.reduce((n, m) => Math.max(n, m.at), 0);
    return { added, skipped: messages.length - added, first, last };
  }
}
