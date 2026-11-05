// Reads and edits .env without losing anything: comments, blank lines, key order and keys this
// version of Marquee doesn't know about all survive. Only the keys being set change, in place;
// new keys are appended at the end.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from '../env.js';

export { parseEnv };

const LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

// Quotes a value only when it needs it to round-trip through parseEnv.
export function formatValue(value) {
  const v = String(value ?? '');
  if (v === '') return '';
  if (/[\s#'"]/.test(v) || v !== v.trim()) {
    if (!v.includes('"')) return `"${v}"`;
    if (!v.includes("'")) return `'${v}'`;
    throw new Error('A value cannot contain both single and double quotes.');
  }
  return v;
}

// Applies `changes` ({ KEY: value }) to the text of an .env file. Returns the new text.
// A key that appears more than once has every occurrence updated, so the file never disagrees with itself.
export function updateEnvText(text, changes, { header = '# Added by setup.js' } = {}) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const pending = new Map(Object.entries(changes).filter(([, v]) => v !== undefined));
  const seen = new Set();
  const out = lines.map((line) => {
    const m = LINE.exec(line);
    if (!m || line.trim().startsWith('#') || !pending.has(m[2])) return line;
    seen.add(m[2]);
    return `${m[1]}${m[2]}${m[3]}${formatValue(pending.get(m[2]))}`;
  });
  const added = [...pending].filter(([k]) => !seen.has(k));
  if (added.length) {
    if (out.length && out.at(-1).trim() !== '') out.push('');
    if (header) out.push(header);
    for (const [k, v] of added) out.push(`${k}=${formatValue(v)}`);
  }
  return out.join(eol) + eol;
}

export function readEnvFile(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Writes atomically, keeping a copy of the previous file as .env.bak and the file's permissions.
// New files are created readable by the owner only, because .env holds passwords and tokens.
export function writeEnvFile(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; fs.copyFileSync(file, `${file}.bak`); } catch { /* new file */ }
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

export const newSecret = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

// Keys whose values are never printed.
export const SECRET_KEYS = /(_TOKEN|_PASS|_KEY|_SECRET)$|^CF_ACCESS_AUD$/;
export const redact = (key, value) => (SECRET_KEYS.test(key) && value ? '••••••' : value);
