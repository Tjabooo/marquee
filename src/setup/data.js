// Backups and DATA_DIR moves. The database is copied with SQLite's VACUUM INTO, which produces a
// consistent copy even while Lilin is running (WAL mode); plain file copies of .lilin.db and its
// -wal file taken at different moments can disagree.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILES, STATE_DIRS } from '../paths.js';

const stamp = (d = new Date()) => d.toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');

async function sqliteCopy(src, dest) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(src, { readOnly: true });
  try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { db.close(); }
}

// Copies the database (consistently), the JSON state files and Notes files into `dest`.
// Returns { dest, files: [...] }. Media, cache/ and logs/ are not included.
export async function backup({ dataDir, dest, notesDir = null, log = () => {} }) {
  const out = dest || path.join(dataDir, 'backups', `lilin-${stamp()}`);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} already exists and isn't empty.`);
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  const db = path.join(dataDir, '.lilin.db');
  if (fs.existsSync(db)) { await sqliteCopy(db, path.join(out, '.lilin.db')); files.push('.lilin.db'); log('database copied with VACUUM INTO'); }
  for (const name of STATE_FILES.filter((f) => !f.startsWith('.lilin.db'))) {
    const src = path.join(dataDir, name);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(out, name)); files.push(name); }
  }
  const dirs = [...STATE_DIRS.map((d) => [d, path.join(dataDir, d)])];
  if (notesDir && path.resolve(notesDir) !== path.join(dataDir, '.lilin-notes-files')) dirs.push(['notes-files', path.resolve(notesDir)]);
  for (const [name, src] of dirs) {
    if (fs.existsSync(src)) { fs.cpSync(src, path.join(out, name), { recursive: true }); files.push(`${name}/`); }
  }
  return { dest: out, files };
}

// Moves state from the application folder to a new DATA_DIR. Lilin must be stopped. Files are
// copied first and verified by size; only then are the originals moved aside into
// <appDir>/.backup-pre-data-dir-<time>/, so nothing is deleted and the move can be undone.
export async function migrateData({ from, to, dryRun = false, log = console.log }) {
  const src = path.resolve(from), dest = path.resolve(to);
  if (src === dest) throw new Error('DATA_DIR is already the application folder; nothing to move.');
  if (fs.existsSync(path.join(dest, '.lilin.db'))) throw new Error(`${dest} already has a database. Move it away first, or point DATA_DIR at an empty folder.`);
  const items = [...STATE_FILES, ...STATE_DIRS, 'cache'].filter((n) => fs.existsSync(path.join(src, n)));
  if (!items.length) throw new Error(`No Lilin state found in ${src}.`);
  log(`Moving ${items.length} item(s) from ${src} to ${dest}:`);
  for (const n of items) log(`  ${n}`);
  if (dryRun) return { moved: [], dryRun: true };

  fs.mkdirSync(dest, { recursive: true });
  // A consistent database copy first; the -wal/-shm files are then unnecessary at the destination.
  if (items.includes('.lilin.db')) await sqliteCopy(path.join(src, '.lilin.db'), path.join(dest, '.lilin.db'));
  for (const n of items.filter((x) => !x.startsWith('.lilin.db'))) {
    fs.cpSync(path.join(src, n), path.join(dest, n), { recursive: true, errorOnExist: true, force: false });
  }
  for (const n of items.filter((x) => !x.startsWith('.lilin.db') && fs.statSync(path.join(src, x)).isFile())) {
    if (fs.statSync(path.join(src, n)).size !== fs.statSync(path.join(dest, n)).size) throw new Error(`Copy of ${n} doesn't match; originals left in place.`);
  }
  const aside = path.join(src, `.backup-pre-data-dir-${stamp()}`);
  fs.mkdirSync(aside);
  for (const n of items) fs.renameSync(path.join(src, n), path.join(aside, n));
  log(`Done. The originals are in ${aside}; delete that folder once Lilin runs fine from ${dest}.`);
  return { moved: items, aside };
}
