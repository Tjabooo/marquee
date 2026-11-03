// Run on the Marquee host: node tools/import-discord-notes.mjs EXPORT.json [--dry-run] [--author-id ID]
// Imports only into the private notes tables; no account tokens and no Discord API access.
import '../env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NotesStore } from '../notes.js';
import { parseDiscordExport } from '../public/notes-import.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), input = args[0];
if (!input) throw new Error('Usage: node tools/import-discord-notes.mjs EXPORT.json [--dry-run] [--author-id ID]');
if ((await fs.stat(input)).size > 20 * 1024 * 1024) throw new Error('The conversation export exceeds 20 MB.');
const parsed = parseDiscordExport(await fs.readFile(input, 'utf8'));
const humans = parsed.authors.filter((a) => !a.bot);
const authorId = args.includes('--author-id') ? args[args.indexOf('--author-id') + 1] : humans.length === 1 ? humans[0].id : null;
if (parsed.authors.length && !authorId) throw new Error('Select your Discord account with --author-id. Bot replies are not imported.');
const messages = parsed.messages.filter((m) => !parsed.authors.length || m.authorId === authorId);
if (!messages.length) throw new Error('No messages by the selected author.');
const dates = messages.map((m) => m.createdAt).sort((a, b) => a - b);
const summary = { messages: messages.length, first: new Date(dates[0]).toISOString(), last: new Date(dates.at(-1)).toISOString(), attachments: messages.reduce((n, m) => n + m.attachments.length, 0) };
if (args.includes('--dry-run')) { console.log(JSON.stringify(summary)); process.exit(0); }
const actor = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)[0];
if (!actor) throw new Error('Configure ADMIN_EMAILS before importing private notes.');
const store = new NotesStore(root, { fileDir:process.env.NOTES_FILES_DIR });
const failures = [];
let archived = 0, processed = 0;
const jobs = new Map();
const allowed = (url) => url.protocol === 'https:' && (
  ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) && /^\/(?:attachments|ephemeral-attachments|stickers)\//.test(url.pathname)
  || ['media.tenor.com', 'c.tenor.com'].includes(url.hostname) && /\.(?:gif|webp|mp4)$/i.test(url.pathname)
  || /^(?:media\d*|i)\.giphy\.com$/.test(url.hostname) && /\.(?:gif|webp|mp4)$/i.test(url.pathname)
);
for (const m of messages) for (const a of m.attachments) {
  const url = new URL(a.url);
  if (!allowed(url)) continue;
  const id = crypto.createHash('sha256').update(url.pathname).digest('hex');
  if (!jobs.has(id)) jobs.set(id, { id, url, name: a.name, references: [] });
  jobs.get(id).references.push(a);
}
await fs.mkdir(store.fileDir, { recursive: true });
const queue = [...jobs.values()];
async function download(job) {
  const { id, references, name } = job;
  if (store.file(id)) { for (const a of references) a.fileId = id; archived++; return; }
  const target = path.join(store.fileDir, `${id}.bin`), temp = `${target}.part`;
  try {
    let url = new URL(job.url);
    for (const key of ['width', 'height', 'format', 'quality', 'size']) url.searchParams.delete(key);
    let response;
    for (let redirect = 0; redirect < 4; redirect++) {
      if (!allowed(url)) throw new Error('Unsupported attachment host');
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(45000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get('location'), url); }
      else break;
    }
    if (!response.ok || response.status >= 300) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const max = 100 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('Attachment exceeds 100 MB'); }
    const file = await fs.open(temp, 'w'); let size = 0;
    try { for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new Error('Attachment exceeds 100 MB'); await file.writeFile(chunk); } }
    finally { await file.close(); }
    await fs.rename(temp, target);
    store.registerFile(id, { name, mime: response.headers.get('content-type') || 'application/octet-stream', size });
    for (const a of references) a.fileId = id;
    archived++;
  } catch (e) {
    await fs.rm(temp, { force: true }).catch(() => {});
    failures.push({ id, reason: /^(HTTP \d+|Attachment exceeds|Unsupported attachment)/.test(e.message) ? e.message : 'Download unavailable' });
  } finally { processed++; if (processed % 50 === 0) console.log(JSON.stringify({ attachmentsProcessed: processed, attachmentsTotal: queue.length, archived, unavailable: failures.length })); }
}
try {
  let cursor = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (cursor < queue.length) await download(queue[cursor++]); }));
  const result = store.import({ messages, channelId: parsed.channelId }, actor);
  const report = { ...summary, ...result, attachmentsArchived: archived, attachmentsUnavailable: failures.length, failures };
  const reports = path.join(root, '.marquee-notes-imports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, `report-${Date.now()}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...summary, ...result, attachmentsArchived: archived, attachmentsUnavailable: failures.length }));
} finally { store.close(); }
