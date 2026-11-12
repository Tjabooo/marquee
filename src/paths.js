// Where Lilin keeps its state. DATA_DIR defaults to the application folder, which is where every
// release before 1.1 kept it, so existing installations keep working without a migration.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './env.js';

export { APP_DIR };
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : APP_DIR;
// Copies Lilin can always make again (browser copies, previews, share copies). CACHE_DIR puts them on
// another drive than the state, e.g. a big media drive instead of a small system SSD.
export const CACHE_DIR = process.env.CACHE_DIR ? path.resolve(process.env.CACHE_DIR) : path.join(DATA_DIR, 'cache');

// State files and folders that belong to an installation. Used by the data-dir guard, backups,
// `setup.js migrate-data` and `setup.js doctor`. cache/ is rebuilt automatically and isn't listed.
export const STATE_FILES = [
  '.lilin.db', '.lilin.db-wal', '.lilin.db-shm', '.lilin-secret',
  '.lilin-activity.jsonl', '.lilin-clip-titles.json', '.lilin-convert.json', '.lilin-credits.json',
  '.lilin-episode-order.json', '.lilin-house.json', '.lilin-invites.json', '.lilin-load.json',
  '.lilin-power.json', '.lilin-screentime.json', '.lilin-shares.json', '.lilin-shows.json',
  '.lilin-subfiles.json', '.lilin-subs.json', '.lilin-subsync.json',
];
export const STATE_DIRS = ['.lilin-notes-files', '.lilin-notes-imports', '.lilin-avatars'];

// Refuses to start with an empty DATA_DIR while the application folder still holds a database:
// that would quietly start a second, empty installation and strand everyone's accounts.
export function dataDirProblem(dataDir = DATA_DIR, appDir = APP_DIR) {
  if (path.resolve(dataDir) === path.resolve(appDir)) return null;
  const here = (dir) => fs.existsSync(path.join(dir, '.lilin.db'));
  if (!here(dataDir) && here(appDir)) {
    return `DATA_DIR is ${dataDir}, but the existing database is still in ${appDir}. `
      + 'Stop Lilin and run `node setup.js migrate-data` to move it, or remove DATA_DIR from .env.';
  }
  return null;
}

export function ensureDataDir(dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
}
