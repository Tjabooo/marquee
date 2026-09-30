// Loads .env into process.env. Imported first by server.js because ES module imports
// are evaluated before the importing module's body; other modules read settings at load time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
let text = '';
try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { /* no .env: defaults */ }
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m || line.trim().startsWith('#')) continue;
  let value = m[2];
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, ''); // inline comment
  if (process.env[m[1]] === undefined) process.env[m[1]] = value;
}
