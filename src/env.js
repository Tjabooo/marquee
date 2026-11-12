// Loads .env into process.env. Imported first by server.js because ES module imports are evaluated
// before the importing module's body, and other modules read settings at load time.
// Variables already set in the environment win over .env (Docker, systemd and CI set them directly).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = process.env.LILIN_ENV_FILE ? path.resolve(process.env.LILIN_ENV_FILE) : path.join(APP_DIR, '.env');

// Parses KEY=value lines; quotes are stripped and unquoted values may end in a # comment.
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

let text = '';
try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* no .env: defaults and the real environment */ }
for (const [key, value] of Object.entries(parseEnv(text))) {
  if (process.env[key] === undefined) process.env[key] = value;
}
