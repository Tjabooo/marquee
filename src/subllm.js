// Proofreads English subtitles with a language model, once per file, in the background.
// Subtitles made by OCR (read off the disc's picture subtitles) carry mistakes no rule can foresee:
// "iysteria in the cream cheese" (Listeria), "the Wizard of 02" (Oz), names in lowercase. A model
// that reads the lines in context fixes them. It runs on any OpenAI-compatible server
// (SUBTITLE_LLM_URL, e.g. llama.cpp's llama-server on the same machine); without one this is off.
//
// Safety: the model only proposes. A change is kept only when it looks like an OCR repair: the
// letters stay almost the same (small edit distance, ignoring case and spaces), so a rephrased,
// shortened or "improved" line is thrown away. Files on disk are never changed: the accepted
// fixes are kept in CACHE_DIR/subtitle-proofread and applied as the subtitle is served.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const CHUNK = 40; // cues per request
const VIDEO = /\.(mkv|mp4|m4v|mov|webm|avi)$/i;
const ENGLISH_SRT = /\.(en|eng)(\.(sdh|cc|hi|forced|\d+))*\.srt$/i;

let url = '';
let model = '';
let dir = null;
let roots = [];
let charactersOf = async () => [];
let titleOf = () => '';
let fileFixes = new Map(); // srt path -> { mtimeMs, fixes: Map(cueNumber -> [raw, fixed]) }
const queue = []; // srt paths, front = most wanted
const queued = new Set();
let running = false;
let available = null; // last health check: true/false
let lastCheck = 0;

export const proofreadEnabled = () => Boolean(url) && process.env.SUBTITLE_LLM !== 'off';

// llmUrl: OpenAI-compatible base URL ("http://127.0.0.1:8091/v1"); cacheDir: where fixes are kept;
// mediaRoots: folders whose English subtitles are all proofread over time; characters(video) →
// cast list; title(video) → "House" (both help the model with names).
export function initProofread({ llmUrl = '', llmModel = '', cacheDir, mediaRoots = [], characters, title } = {}) {
  url = String(llmUrl || '').replace(/\/+$/, '');
  model = llmModel || 'subtitles';
  dir = cacheDir;
  roots = mediaRoots.filter(Boolean);
  if (characters) charactersOf = characters;
  if (title) titleOf = title;
  if (!proofreadEnabled() || !dir) return;
  // The whole library, a few minutes after start and then every six hours (new downloads).
  const sweep = () => { for (const r of roots) walk(r, 0); kick(); };
  setTimeout(sweep, 3 * 60 * 1000).unref?.();
  setInterval(sweep, 6 * 3600 * 1000).unref?.();
}

const keyOf = (srt) => crypto.createHash('sha1').update(path.resolve(srt).toLowerCase()).digest('hex').slice(0, 24);
const cacheFile = (srt) => path.join(dir, `${keyOf(srt)}.json`);

function walk(d, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (ENGLISH_SRT.test(e.name) && !/\.ai\.srt$/i.test(e.name)) enqueue(p, false);
  }
}

// The video a sidecar belongs to ("X.en.sdh.srt" → "X.mkv"/"X.mp4").
function videoOf(srt) {
  const stem = path.basename(srt).replace(ENGLISH_SRT, '').toLowerCase();
  try {
    const hit = fs.readdirSync(path.dirname(srt)).find((n) => VIDEO.test(n) && n.slice(0, n.lastIndexOf('.')).toLowerCase() === stem);
    return hit ? path.join(path.dirname(srt), hit) : null;
  } catch { return null; }
}

function done(srt) {
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile(srt), 'utf8'));
    const st = fs.statSync(srt);
    return saved.version === VERSION && saved.mtimeMs === st.mtimeMs && saved.size === st.size;
  } catch { return false; }
}

// front: someone is about to watch it.
export function enqueue(srt, front = true) {
  if (!proofreadEnabled() || !dir) return;
  if (queued.has(srt)) {
    if (front) { queue.splice(queue.indexOf(srt), 1); queue.unshift(srt); }
    return;
  }
  if (done(srt)) return;
  queued.add(srt);
  if (front) queue.unshift(srt); else queue.push(srt);
  if (front) kick();
}

function kick() {
  if (running || !queue.length) return;
  running = true;
  (async () => {
    while (queue.length) {
      if (!(await healthy())) { await new Promise((r) => setTimeout(r, 10 * 60 * 1000)); continue; }
      const srt = queue.shift();
      queued.delete(srt);
      if (done(srt)) continue;
      try { await proofreadFile(srt); } catch (e) { console.warn(`[proofread] ${path.basename(srt)}: ${e.message}`); }
    }
  })().finally(() => { running = false; idleLater(); });
}

// SUBTITLE_LLM_PAUSE: a command that exits 0 while the model's machine is busy with something that
// matters more (a game on the desktop whose graphics card runs the model), checked before every
// chunk. Proofreading waits until it says otherwise.
function busyNow() {
  const cmd = process.env.SUBTITLE_LLM_PAUSE;
  if (!cmd) return Promise.resolve(false);
  const [exe, ...rest] = args(cmd);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(exe, rest, { stdio: 'ignore', windowsHide: true });
      const t = setTimeout(() => { p.kill(); finish(false); }, 20000);
      p.on('exit', (code) => { clearTimeout(t); finish(code === 0); });
      p.on('error', () => { clearTimeout(t); finish(false); });
    } catch { finish(false); }
  });
}
let pausedSince = 0;
async function waitWhileBusy() {
  while (await busyNow()) {
    if (!pausedSince) { pausedSince = Date.now(); console.log('[proofread] paused: the model\'s machine is busy'); }
    await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
  }
  if (pausedSince) { pausedSince = 0; console.log('[proofread] carrying on'); }
}

async function ping() {
  try { return (await fetch(`${url}/models`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
}

async function healthy() {
  if (available && Date.now() - lastCheck < 60 * 1000) return true;
  lastCheck = Date.now();
  available = await ping();
  if (!available && process.env.SUBTITLE_LLM_SERVER) available = await startServer();
  if (!available) console.warn(`[proofread] the language model at ${url} isn't answering; trying again in 10 minutes`);
  return available;
}

// ---------- a model server Lilin starts itself ----------
// SUBTITLE_LLM_SERVER: the command that starts an OpenAI-compatible server at SUBTITLE_LLM_URL
// (llama.cpp's llama-server with a small model). Lilin starts it when there's proofreading to do,
// at low priority, and stops it after 10 idle minutes, so the graphics card's memory is free the
// rest of the time.
let child = null;
let idleTimer = null;
const IDLE_MS = 10 * 60 * 1000;
function args(cmd) {
  return (String(cmd).match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
}
async function startServer() {
  if (!child) {
    const [exe, ...rest] = args(process.env.SUBTITLE_LLM_SERVER);
    try {
      child = spawn(exe, rest, { cwd: path.dirname(exe), stdio: 'ignore', windowsHide: true });
      child.on('exit', () => { child = null; });
      child.on('error', (e) => { console.warn(`[proofread] couldn't start the model server: ${e.message}`); child = null; });
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
      console.log('[proofread] started the model server');
    } catch (e) {
      console.warn(`[proofread] couldn't start the model server: ${e.message}`);
      return false;
    }
  }
  for (let i = 0; i < 60 && child; i++) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
function idleLater() {
  clearTimeout(idleTimer);
  if (!child) return;
  idleTimer = setTimeout(() => {
    if (running || !child) return;
    child.kill();
    child = null;
    available = null;
    console.log('[proofread] stopped the model server (idle)');
  }, IDLE_MS);
  idleTimer.unref?.();
}
process.on('exit', () => { try { child?.kill(); } catch { /* gone */ } });

// ---------- reading and applying ----------
function parse(srt) {
  return srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((block) => {
    const rows = block.split('\n');
    const t = rows.findIndex((r) => r.includes('-->'));
    return t < 0 ? { head: rows, lines: [] } : { head: rows.slice(0, t + 1), lines: rows.slice(t + 1) };
  });
}

function fixesFor(srt) {
  let st;
  try { st = fs.statSync(srt); } catch { return null; }
  const hit = fileFixes.get(srt);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.fixes;
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile(srt), 'utf8'));
    if (saved.version !== VERSION || saved.mtimeMs !== st.mtimeMs) return null;
    const fixes = new Map(saved.fixes.map(([i, raw, fixed]) => [i, [raw, fixed]]));
    if (fileFixes.size > 100) fileFixes.delete(fileFixes.keys().next().value);
    fileFixes.set(srt, { mtimeMs: st.mtimeMs, fixes });
    return fixes;
  } catch { return null; }
}

// The subtitle text with the model's accepted fixes, and how many there are (0: not proofread yet
// or nothing to fix). A cue is only replaced while its text is still what was proofread.
export function applyProofread(srt, text) {
  const fixes = proofreadEnabled() ? fixesFor(srt) : null;
  if (!fixes?.size) return { text, count: 0 };
  const cues = parse(text);
  let count = 0;
  cues.forEach((c, i) => {
    const f = fixes.get(i);
    if (f && c.lines.join('\n') === f[0]) { c.lines = f[1].split('\n'); count++; }
  });
  return { text: cues.map((c) => [...c.head, ...c.lines].join('\n')).join('\n\n'), count };
}

// ---------- proofreading ----------
const strip = (s) => s.replace(/\{[^}]*\}|<[^>]*>/g, '');
function lev(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 12) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// An OCR repair, not a rewrite: the same line count, the same markup, and the letters (ignoring
// case, spaces and look-alike punctuation) within a small edit distance; every word that changed
// must stay close to the word it replaces.
// protect(lower): a real word (in the library or the reference subtitle) whose letters must stay
// ("ebsen" is not "Ebstein"); ordinary(lower): an everyday word that keeps its lowercase
// ("surgery department"). Each row keeps its leading and trailing punctuation ("- ", "...").
export function plausibleFix(raw, fixed, { protect = () => false, ordinary = () => false } = {}) {
  if (fixed === raw || typeof fixed !== 'string' || !fixed.trim()) return false;
  const rowsA = raw.split('\n');
  const rowsB = fixed.split('\n');
  if (rowsA.length !== rowsB.length) return false;
  const ends = (r) => [r.match(/^[^A-Za-z0-9]*/)[0].replace(/\s+/g, ''), r.match(/[^A-Za-z0-9]*$/)[0].replace(/\s+/g, '')];
  for (let i = 0; i < rowsA.length; i++) {
    const [a1, a2] = ends(strip(rowsA[i]));
    const [b1, b2] = ends(strip(rowsB[i]));
    if (a1 !== b1 || a2 !== b2) return false;
  }
  const tags = (s) => (s.match(/\{[^}]*\}|<[^>]*>/g) || []).join('');
  if (tags(raw) !== tags(fixed)) return false;
  const norm = (s) => strip(s).toLowerCase().replace(/[\s'’`´]/g, '').replace(/[“”"]/g, '"');
  const a = norm(raw);
  const b = norm(fixed);
  const d = lev(a, b);
  if (d > Math.max(2, Math.round(a.length * 0.12))) return false;
  // Word by word: a changed word must be close to the old one (or the old ones, joined/split).
  const wa = strip(raw).split(/\s+/).filter(Boolean);
  const wb = strip(fixed).split(/\s+/).filter(Boolean);
  if (Math.abs(wa.length - wb.length) > 2) return false;
  // Same number of words: check each changed one against the word it replaces.
  if (wa.length === wb.length) {
    for (let i = 0; i < wa.length; i++) {
      const x = wa[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      const y = wb[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (x === y) continue;
      const lx = x.toLowerCase();
      if (lx === y.toLowerCase()) {
        if (x === lx && ordinary(lx.replace(/'s$/, ''))) return false; // "surgery" → "Surgery"
        continue;
      }
      if (protect(lx.replace(/'s$/, ''))) return false; // "ebsen" → "Ebstein"
    }
  }
  const bag = new Set(wa.map((w) => w.toLowerCase()));
  for (const w of wb) {
    if (bag.has(w.toLowerCase())) continue;
    const word = w.toLowerCase().replace(/[^a-z0-9']/g, '');
    if (!word) continue;
    const near = wa.some((o, i) => {
      const one = o.toLowerCase().replace(/[^a-z0-9']/g, '');
      const two = (one + (wa[i + 1] || '').toLowerCase().replace(/[^a-z0-9']/g, ''));
      return lev(one, word) <= Math.max(1, Math.ceil(word.length / 3)) || lev(two, word) <= 1;
    }) || wa.some((o) => o.toLowerCase().replace(/[^a-z0-9']/g, '').includes(word));
    if (!near) return false;
  }
  return true;
}

async function ask(system, user) {
  const r = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.SUBTITLE_LLM_KEY && { Authorization: `Bearer ${process.env.SUBTITLE_LLM_KEY}` }) },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      // Qwen-style models: answer straight away (a reasoning pass is slow and changes nothing here).
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!r.ok) throw new Error(`the model answered ${r.status}`);
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { return {}; }
}

function systemPrompt(title, names) {
  return [
    `You proofread English subtitles${title ? ` of "${title}"` : ''} that were made by OCR (text recognition of picture subtitles).`,
    names.length ? `Names in it include: ${names.join(', ')}.` : '',
    'Fix only OCR mistakes: misread letters (l/I/1, rn/m, cl/d, 0/O, ii/u, wv/rw: "papewvork" → "paperwork"), garbled words ("iysteria" → "Listeria"),',
    'digits read instead of letters ("Wizard of 02" → "Wizard of Oz"), words wrongly split or joined,',
    'and missing capitals on names, places, brands and titles ("cuddy" → "Cuddy", "a large coke" → "a large Coke").',
    'Never rephrase, never change wording, grammar, slang, spelling style or punctuation, never translate,',
    'never add or remove words, never fix what the speaker said. If a line is fine, leave it out.',
    'Lines are given as "number: text" with " | " between the rows of one subtitle; keep the " | ".',
    'Answer with a JSON object mapping the number to the corrected text, only for lines you changed. {} if none.',
  ].filter(Boolean).join(' ');
}

// Filled by the server: the word list (subfix.js) and a cached reference subtitle (subtitles.js).
let wordGuards = { protect: () => false, ordinary: () => false };
let referenceOf = () => null;
export function setProofreadGuards({ known, ordinary, reference } = {}) {
  if (known) wordGuards.protect = (w) => known(w) >= 3;
  if (ordinary) wordGuards.ordinary = ordinary;
  if (reference) referenceOf = reference;
}
function guardsFor(srt) {
  const ref = srt ? referenceOf(srt) : null;
  const refWords = ref ? new Set(strip(ref).toLowerCase().match(/[a-z][a-z']+/g) || []) : null;
  return { protect: (w) => wordGuards.protect(w) || Boolean(refWords?.has(w)), ordinary: wordGuards.ordinary };
}

async function proofreadFile(srt) {
  const st = fs.statSync(srt);
  const text = fs.readFileSync(srt, 'utf8');
  const cues = parse(text);
  const video = videoOf(srt);
  const cast = video ? await charactersOf(video).catch(() => []) : [];
  const names = [...new Set(cast.filter((c) => c.main !== false).map((c) => String(c.name || c)).flatMap((n) => n.split(/\s+/))
    .map((t) => t.replace(/^['"(]+|['".,)]+$/g, '')).filter((t) => /^[A-Z][a-z]{2,}/.test(t)))].slice(0, 60);
  const started = Date.now();
  const fixes = await proofreadCues(cues, { title: video ? titleOf(video) : '', names, guards: guardsFor(srt) });
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(cacheFile(srt), JSON.stringify({ version: VERSION, file: srt, mtimeMs: st.mtimeMs, size: st.size, at: Date.now(), fixes }));
  fileFixes.delete(srt);
  console.log(`[proofread] ${path.basename(srt)}: ${fixes.length} lines fixed in ${Math.round((Date.now() - started) / 1000)} s (${queue.length} left)`);
}

// [[cueIndex, raw, fixed]] for one subtitle's cues. Exported for tests and tools.
export async function proofreadCues(cues, { title = '', names = [], onChunk = null, guards = {} } = {}) {
  if (typeof cues === 'string') cues = parse(cues);
  const system = systemPrompt(title, names);
  const fixes = [];
  for (let i = 0; i < cues.length; i += CHUNK) {
    const part = [];
    for (let j = i; j < Math.min(cues.length, i + CHUNK); j++) {
      const raw = cues[j].lines.join('\n');
      if (/[A-Za-z]/.test(strip(raw))) part.push(`${j}: ${raw.replace(/\n/g, ' | ')}`);
    }
    if (!part.length) continue;
    await waitWhileBusy();
    const answer = await ask(system, part.join('\n'));
    for (const [k, v] of Object.entries(answer || {})) {
      const j = Number(k);
      if (!Number.isInteger(j) || !cues[j] || typeof v !== 'string') continue;
      const raw = cues[j].lines.join('\n');
      const fixed = v.replace(/\s*\|\s*/g, '\n').trim();
      const ok = plausibleFix(raw, fixed, guards);
      onChunk?.({ index: j, raw, fixed, ok });
      if (ok) fixes.push([j, raw, fixed]);
    }
  }
  return fixes;
}

// For tests and tools: point at a model without starting the background queue.
export function setModelForTest(llmUrl, llmModel) { url = String(llmUrl).replace(/\/+$/, ''); model = llmModel; }
