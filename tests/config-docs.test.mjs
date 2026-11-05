// Keeps .env.example, the code and docs/configuration.md describing the same settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const example = new Set([...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
const docs = read('docs/configuration.md');
const code = new Set();
for (const f of fs.readdirSync(new URL('../src', import.meta.url))) {
  if (!f.endsWith('.js')) continue;
  for (const m of read(`src/${f}`).matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) code.add(m[1]);
}
// Read by the code but deliberately not in .env.example.
const INTERNAL = new Set(['CF_API_BASE', 'MARQUEE_ENV_FILE', 'NO_COLOR', 'XDG_SESSION_TYPE', 'PATH', 'PATHEXT', 'Path', 'ProgramData', 'SystemRoot']);

test('every setting the server reads is in .env.example', () => {
  const missing = [...code].filter((k) => !example.has(k) && !INTERNAL.has(k));
  assert.deepEqual(missing, []);
});

test('every setting in .env.example is read by the server and documented', () => {
  assert.deepEqual([...example].filter((k) => !code.has(k)), []);
  assert.deepEqual([...example].filter((k) => !docs.includes(`\`${k}\``)), []);
});

test('.env.example holds no real values for secrets', () => {
  for (const line of read('.env.example').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && /(_TOKEN|_PASS|_KEY|_SECRET|_AUD)$/.test(m[1])) assert.equal(m[2], '', `${m[1]} must be blank`);
  }
});
