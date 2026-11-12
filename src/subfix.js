// Cleans up English subtitles as they're served (files on disk are never changed).
// Many releases carry subtitle text made by OCR: whoever ripped the disc read the Blu-ray/DVD
// picture subtitles with a text recogniser. Those often have names and acronyms in lowercase
// ("Dinner with cuddy.", "the nicu"), "I" and "l" mixed up ("wiIl", "l'm", "iike") and lowercase
// sentence starts. Fixes come from two sources:
// - rules that are always safe ("l'm" → "I'm", a lone "i" → "I", capital after a full stop), and
// - a word list learned from every English subtitle in the library. Each file votes once per word
//   for how it writes that word mid-sentence (cuddy / Cuddy / CUDDY), so one broken release can't
//   outvote a season of clean ones. A lowercase word is capitalised only when clean files almost
//   always capitalise it, and an i/l spelling is swapped only when the library never uses it but
//   often uses the swapped one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LEXICON_VERSION = 1;
const REBUILD_MS = 24 * 3600 * 1000;
const MAX_FILES = 3000;
const MAX_BYTES = 2 * 1024 * 1024; // per file

// Acronyms that are never ordinary lowercase words; used even before the library is scanned.
const ACRONYMS = new Set(['icu', 'nicu', 'picu', 'mri', 'ekg', 'ecg', 'eeg', 'cpr', 'dna', 'fbi', 'cia', 'nsa', 'tv', 'dvd', 'ceo', 'ok', 'usa', 'nypd', 'lapd', 'dea', 'atf', 'hiv', 'iv', 'er']);
// "er" (hesitation), "iv"/"ok" have lowercase lives too: only when the library agrees, see acronymOk.
const AMBIGUOUS_ACRONYMS = new Set(['er', 'iv', 'ok']);
// After these, a capitalised-in-the-library word is still left alone ("the house", "my chase").
const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'whose', 'some', 'any', 'every', 'each', 'another']);

// Interjections are often capitalised after "..." ("Listen... Oh,"), which looks like a name to the votes.
const INTERJECTIONS = new Set(['oh', 'ah', 'uh', 'um', 'umm', 'hmm', 'mm', 'eh', 'hey', 'yeah', 'okay', 'wow', 'whoa', 'huh', 'aw', 'ooh', 'oops', 'yes', 'no', 'well']);

const L_FOR_I = { ls: 'is', lt: 'it', lf: 'if', ln: 'in', "lt's": "it's", "lsn't": "isn't", "lt'll": "it'll", "lt'd": "it'd" };

let lexicon = null; // { files, words: { lower: [lowFiles, capFiles, upperFiles, anyFiles] } }
let lexiconFile = null;
let roots = [];
let building = null;
const fixedCache = new Map(); // key -> text

const isEnglishName = (name) => /\.(en|eng)(\.(sdh|cc|hi|forced|ai|\d+))*\.srt$/i.test(name);
// "<name>.srt" with no language tag (or an unknown one): read it and check that it's English.
const LANG_TAG = /\.([a-z]{2,3}(-[a-z]{2})?)(\.(sdh|cc|hi|forced|ai|\d+))*\.srt$/i;
const untagged = (name) => /\.srt$/i.test(name) && !LANG_TAG.test(name);
const COMMON = new Set(['the', 'you', 'to', 'and', 'it', 'is', 'that', 'what', 'of', 'in', 'me', 'this', 'we', 'he', 'for', 'have', 'your', 'do', 'be', 'not', 'are', 'was', 'with', 'my']);
function looksEnglish(srt) {
  const words = srt.slice(0, 40000).toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 200) return false;
  let hits = 0;
  for (const w of words) if (COMMON.has(w)) hits++;
  return hits / words.length > 0.15;
}
const WORD = /[A-Za-z][A-Za-z']*|\d+(?:[.,:]\d+)*%?/g;

function stripMarkup(line) {
  return line.replace(/\{\\[^}]*\}/g, '').replace(/<[^>]*>/g, '');
}

// Cue blocks: [{ head: ['1', '00:00:01,000 --> ...'], lines: ['text', ...] }]
function parseCues(srt) {
  return srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((block) => {
    const rows = block.split('\n');
    const t = rows.findIndex((r) => r.includes('-->'));
    return t < 0 ? { head: rows, lines: [] } : { head: rows.slice(0, t + 1), lines: rows.slice(t + 1) };
  });
}

// Every word with whether it starts a sentence. A sentence ends with . ! ? (not "..."). A dialogue
// dash doesn't start one by itself: the next speaker often finishes the previous line.
function* wordsOf(cues) {
  let start = true;
  for (const cue of cues) {
    for (const raw of cue.lines) {
      const line = stripMarkup(raw);
      let last = 0;
      let prevWord = '';
      for (const m of line.matchAll(WORD)) {
        if (endsSentence(line.slice(last, m.index), prevWord)) start = true;
        if (/^[A-Za-z]/.test(m[0])) yield { word: m[0].replace(/'+$/, ''), start };
        start = false;
        prevWord = m[0];
        last = m.index + m[0].length;
      }
      if (endsSentence(line.slice(last), prevWord, true)) start = true;
    }
  }
}

// Does this text between two words end a sentence? "..." doesn't, nor do "p.m." / "e.g." (a
// one-letter word before the full stop).
// "Mr. and Mrs." isn't two sentences, nor is "gmail.com" (no space after the dot).
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'prof', 'sgt', 'lt', 'capt', 'col', 'gen', 'rev', 'mt', 'ft', 'vol']);
function endsSentence(gap, prevWord = '', lineEnd = false) {
  const space = lineEnd ? '\\s*' : '\\s+';
  // Not after a closing quote: 'Ask "Will you pay me?" so I...' goes on.
  if (new RegExp(`[!?][)\\]]*${space}$`).test(gap)) return true;
  if (!new RegExp(`(^|[^.])\\.[)\\]]*${space}$`).test(gap)) return false;
  if (/^\./.test(gap) && ABBREVIATIONS.has(prevWord.toLowerCase())) return false;
  return !(prevWord.length === 1 && /^\./.test(gap) && prevWord !== 'I');
}

const shapeOf = (w) => (w === w.toLowerCase() ? 0 : w === w.toUpperCase() ? (w.length > 1 ? 2 : 1) : /^[A-Z][a-z']*$/.test(w) ? 1 : -1);

// Per-file votes: lower word -> [low, cap, upper] counts of mid-sentence uses, plus every spelling seen.
// A line's identity across files: lowercase letters only. Lines that repeat in several files are
// theme songs, credits and ads ("♪ Humble folks without temptation ♪"), not evidence of anything.
const lineKey = (line) => stripMarkup(line).toLowerCase().replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ').trim();
const lineKeys = (srt) => new Set(parseCues(srt).flatMap((c) => c.lines.map(lineKey)).filter((k) => k.includes(' ')));

function fileVotes(srt, repeated) {
  const mid = new Map();
  const seen = new Set();
  const cues = parseCues(srt);
  if (repeated) for (const c of cues) c.lines = c.lines.filter((l) => !repeated.has(lineKey(l)));
  for (const { word, start } of wordsOf(cues)) {
    const lower = word.toLowerCase();
    seen.add(lower);
    if (start || word.length < 2 && lower !== 'i') continue;
    const s = shapeOf(word);
    if (s < 0) continue;
    if (!mid.has(lower)) mid.set(lower, [0, 0, 0]);
    mid.get(lower)[s]++;
  }
  return { mid, seen };
}

function addFile(words, srt, repeated = null) {
  const { mid, seen } = fileVotes(srt, repeated);
  for (const lower of seen) {
    let e = words[lower];
    if (!e) e = words[lower] = [0, 0, 0, 0];
    e[3]++;
    const v = mid.get(lower);
    if (v) {
      const best = v.indexOf(Math.max(...v));
      e[best]++;
    }
  }
}

function listSubtitles(dir, out, depth = 0) {
  if (out.length >= MAX_FILES || depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listSubtitles(p, out, depth + 1);
    else if ((isEnglishName(e.name) || untagged(e.name)) && !e.name.includes('lilin-tmp')) out.push(p);
    if (out.length >= MAX_FILES) return;
  }
}

async function build() {
  const files = [];
  for (const r of roots) listSubtitles(r, files);
  const words = Object.create(null);
  const seen = new Set();
  const texts = [];
  const lineFiles = new Map(); // line key -> number of files that have it
  for (const f of files) {
    try {
      const st = await fs.promises.stat(f);
      if (st.size > MAX_BYTES) continue;
      const text = decode(await fs.promises.readFile(f));
      if (!isEnglishName(path.basename(f)) && !looksEnglish(text)) continue;
      // The same subtitle saved twice (".srt" + ".en.srt") votes once.
      const digest = crypto.createHash('sha1').update(text).digest('hex');
      if (seen.has(digest)) continue;
      seen.add(digest);
      texts.push(text);
      for (const k of lineKeys(text)) lineFiles.set(k, (lineFiles.get(k) || 0) + 1);
    } catch { /* locked or gone */ }
    if (texts.length % 25 === 0) await new Promise((r) => setImmediate(r));
  }
  const repeated = new Set([...lineFiles].filter(([, n]) => n >= 3).map(([k]) => k));
  lineFiles.clear();
  let used = 0;
  for (const text of texts) {
    addFile(words, text, repeated);
    if (++used % 25 === 0) await new Promise((r) => setImmediate(r));
  }
  lexicon = { version: LEXICON_VERSION, at: Date.now(), files: used, words };
  fixedCache.clear();
  if (lexiconFile) {
    try {
      await fs.promises.mkdir(path.dirname(lexiconFile), { recursive: true });
      await fs.promises.writeFile(lexiconFile, JSON.stringify(lexicon));
    } catch (e) { console.warn(`[subfix] couldn't save the word list: ${e.message}`); }
  }
  console.log(`[subfix] learned ${Object.keys(words).length} words from ${used} English subtitle files`);
}

function rebuild() {
  if (!building) building = build().catch((e) => console.warn(`[subfix] ${e.message}`)).finally(() => { building = null; });
  return building;
}

// roots: folders to learn from (the library); cacheFile: where the word list is kept between restarts.
export function initSubfix({ roots: dirs = [], cacheFile = null } = {}) {
  roots = dirs.filter(Boolean);
  lexiconFile = cacheFile;
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (saved.version === LEXICON_VERSION) lexicon = saved;
  } catch { /* none yet */ }
  if (!roots.length) return;
  const due = () => !lexicon || Date.now() - lexicon.at > REBUILD_MS;
  setTimeout(() => { if (due()) rebuild(); }, 60 * 1000).unref?.();
  setInterval(() => { if (due()) rebuild(); }, 3600 * 1000).unref?.();
}

export const rebuildLexicon = rebuild;
export function setLexiconForTest(srts) {
  const words = Object.create(null);
  for (const s of srts) addFile(words, s);
  lexicon = { version: LEXICON_VERSION, at: Date.now(), files: srts.length, words };
  fixedCache.clear();
}

function decode(buf) {
  let s = buf.toString('utf8');
  if (s.includes('�')) s = new TextDecoder('windows-1252').decode(buf);
  return s;
}

// ---------- fixing ----------
const entry = (w) => (lexicon && lexicon.words[w.toLowerCase()]) || null;
const fileCount = (w) => entry(w)?.[3] || 0;

// How clean files write this word mid-sentence: 'cap', 'upper' or null (lowercase / unsure).
// learned = false: only the built-in acronyms.
function preferredShape(lower, learned = true) {
  const e = learned && !INTERJECTIONS.has(lower) ? entry(lower) : null;
  const votes = e ? e[0] + e[1] + e[2] : 0;
  if (e && e[2] >= 3 && e[2] >= 0.8 * votes && lower.length >= 2) return 'upper';
  if (e && e[1] >= 3 && e[1] >= 0.8 * votes) return 'cap';
  const known = entry(lower);
  if (ACRONYMS.has(lower) && (!AMBIGUOUS_ACRONYMS.has(lower) || (known && known[2] >= 3 && known[2] > known[0]))) return 'upper';
  return null;
}

const swaps = { i: 'l', l: 'i', I: 'l' };
// The i/l-swapped spelling the library uses instead of a spelling it never uses, or null.
function ilFix(word) {
  if (!lexicon || lexicon.files < 20 || !/[ilI]/.test(word) || word.length < 2) return null;
  if (fileCount(word) > 2) return null;
  const spots = [...word].map((c, i) => (swaps[c] ? i : -1)).filter((i) => i >= 0);
  if (spots.length > 6) return null;
  let best = null;
  let bestCount = 0;
  // Every combination of swaps (at most 64).
  for (let mask = 1; mask < 1 << spots.length; mask++) {
    const chars = [...word];
    for (let b = 0; b < spots.length; b++) if (mask & (1 << b)) chars[spots[b]] = swaps[chars[spots[b]]];
    const v = chars.join('');
    const n = fileCount(v);
    if (n > bestCount) { best = v; bestCount = n; }
  }
  if (!best || bestCount < 10 || bestCount < 20 * (fileCount(word) + 1)) return null;
  // Swapped letters come out lowercase ("Iike" → "like"); sentence starts get their capital later.
  return best;
}

const capFirst = (w) => w[0].toUpperCase() + w.slice(1);

function fixWord(word, { start, prev, broken, next = '' }) {
  let w = word;
  // l'm, l'll, l've, l'd, lone l → I (not the stutter in "i-it's")
  if (/^[li]('(m|ll|ve|d))?$/.test(w) && !(w.length === 1 && next === '-')) return 'I' + w.slice(1);
  // A capital I read as l: "ls there", "lt's", "lf only". None of these are English words.
  const iWord = L_FOR_I[w.toLowerCase()];
  if (iWord && w[0] === 'l') w = iWord;
  // wiIl, aII, stiII: a capital I between lowercase letters is an l.
  if (/^[a-z]+(I+[a-z]*)+$/.test(w)) w = w.replace(/I/g, 'l');
  else if (/^[A-Z][a-z]*I+[a-z]/.test(w) && !/^Mc|^Mac/.test(w)) w = w[0] + w.slice(1).replace(/I/g, 'l');
  const il = ilFix(w);
  if (il) w = il;
  if (w === w.toLowerCase()) {
    const shape = preferredShape(w.replace(/'s$/, ''), broken);
    if (shape === 'upper') {
      const base = w.replace(/'s$/, '');
      return base.toUpperCase() + w.slice(base.length);
    }
    if (shape === 'cap' && (start || !DETERMINERS.has(prev))) return capFirst(w);
    if (start) return capFirst(w);
  }
  return w;
}

// A file whose casing is broken: at least two different words that the library clearly writes as
// names or acronyms (8+ files, 85 %+ of them) appear in lowercase mid-sentence. Clean files keep their own style ("ambassador").
function strongShape(lower) {
  if (ACRONYMS.has(lower) && !AMBIGUOUS_ACRONYMS.has(lower)) return true;
  const e = INTERJECTIONS.has(lower) ? null : entry(lower);
  if (!e) return false;
  const votes = e[0] + e[1] + e[2];
  return Math.max(e[1], e[2]) >= 8 && Math.max(e[1], e[2]) >= 0.85 * votes;
}
function casingBroken(cues) {
  const odd = new Set();
  for (const { word, start } of wordsOf(cues)) {
    if (start || word !== word.toLowerCase() || word.length < 2) continue;
    if (strongShape(word.replace(/'s$/, ''))) odd.add(word);
    if (odd.size >= 2) return true;
  }
  return false;
}

export function fixEnglishSrt(srt) {
  const cues = parseCues(srt);
  const broken = casingBroken(cues);
  // Walk the words in order, tracking sentence starts across cues, and rewrite each line.
  let start = true;
  let prev = '';
  let prevRaw = '';
  let depth = 0;
  for (const cue of cues) {
    depth = 0;
    cue.lines = cue.lines.map((raw) => {
      let out = '';
      let last = 0;
      // Words outside markup only.
      const re = /(\{\\[^}]*\}|<[^>]*>)|([A-Za-z][A-Za-z']*|\d+(?:[.,:]\d+)*%?)/g;
      let m;
      while ((m = re.exec(raw))) {
        if (m[1]) continue;
        const gap = stripMarkup(raw.slice(last, m.index));
        for (const c of gap) if (c === '[' || c === '(') depth++; else if ((c === ']' || c === ')') && depth) depth--;
        if (endsSentence(gap.replace(/[[(]+\s*$/, ' '), prevRaw)) start = true;
        // "...into weeks": a leading ellipsis continues the last line.
        if (/(\.\.\.|…)\s*$/.test(gap)) start = false;
        const trail = m[2].match(/'+$/)?.[0] || '';
        const word = m[2].slice(0, m[2].length - trail.length);
        // Inside [sound tags] / (asides): no sentence capitals, and the sentence still starts after it.
        // The second half of "uh-oh" / "two-week" keeps its case.
        const joined = /-$/.test(gap);
        const next = raw[m.index + m[2].length] || '';
        const fixed = /^[A-Za-z]/.test(word) && !joined ? fixWord(word, { start: start && !depth, prev, broken, next }) : word;
        out += raw.slice(last, m.index) + fixed + trail;
        last = m.index + m[2].length;
        prev = word.toLowerCase();
        prevRaw = word;
        if (!depth) start = false;
      }
      out += raw.slice(last);
      const tail = stripMarkup(raw.slice(last));
      for (const c of tail) if (c === '[' || c === '(') depth++; else if ((c === ']' || c === ')') && depth) depth--;
      if (endsSentence(tail, prevRaw, true)) start = true;
      return out;
    });
  }
  return cues.map((c) => [...c.head, ...c.lines].join('\n')).join('\n\n');
}

// Cached by file path + modification time + word list age.
export function cleanSubtitle(text, { lang, file = '', mtimeMs = 0 } = {}) {
  if (lang !== 'en' || process.env.SUBTITLE_FIX === 'off') return text;
  const key = `${file}|${mtimeMs}|${lexicon?.at || 0}`;
  if (file && fixedCache.has(key)) return fixedCache.get(key);
  let out = text;
  try { out = fixEnglishSrt(text); } catch (e) { console.warn(`[subfix] ${path.basename(file)}: ${e.message}`); }
  if (file) {
    if (fixedCache.size > 200) fixedCache.delete(fixedCache.keys().next().value);
    fixedCache.set(key, out);
  }
  return out;
}
