// Cleans up English subtitles as they're served (files on disk are never changed).
// Many releases carry subtitle text made by OCR: whoever ripped the disc read the Blu-ray/DVD
// picture subtitles with a text recogniser. Those often have names and acronyms in lowercase
// ("Dinner with cuddy.", "the nicu"), "I" and "l" mixed up ("wiIl", "l'm", "iike") and lowercase
// sentence starts. Fixes come from three sources:
// - rules that are always safe ("l'm" → "I'm", a lone "i" → "I", capital after a full stop, "w rong"
//   → "wrong", "he' s" → "he's", "$12,0001967" → "$12,000 1967", "vitamin c" → "vitamin C"),
// - the film's or show's cast list from TMDB: main characters' names that are never ordinary words
//   elsewhere in the library ("kutner"), names this title's own subtitles capitalise ("house" in
//   House) and full names ("Jimmy quidd"), even when every release of the show gets them wrong, and
// - a word list learned from every English subtitle in the library. Each file votes once per word
//   for how it writes that word mid-sentence (cuddy / Cuddy / CUDDY), so one broken release can't
//   outvote a season of clean ones. A lowercase word is capitalised only when clean files almost
//   always capitalise it, and an i/l spelling is swapped only when the library never uses it but
//   often uses the swapped one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LEXICON_VERSION = 2; // 2: which titles write each word lowercase / capitalised
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

// words: lower → [lowFiles, capFiles, upperFiles, anyFiles, { title: lowFiles }, { title: capFiles }]. Words never
// capitalised keep just four of their lowercase titles (enough to call them ordinary words).
let lexicon = null; // { files, words }
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

// Which film or show a subtitle belongs to, from its folder ("House.S04.1080p…" → "house") or,
// for a file loose in a library folder, its own name. Files of one title agree on how its names are
// written; other titles show whether a name is also an ordinary word ("house", "chase").
const GENERIC_DIR = /^(tv|tv shows|shows|series|movies|films|media|anime|documentaries|seasons?[ ._-]*\d*|s\d{1,2}|subs?|subtitles|specials|extras|featurettes|[a-z]:)$/i;
const keyOfName = (n) => n.replace(/\.[a-z0-9]{2,4}$/i, '')
  .split(/[ ._()[\]-]+(?=(?:s\d{1,2}(?:e\d+)?|season|complete|(?:19|20)\d\d|\d{3,4}p|bluray|web(?:-?dl|rip)?|hdtv)\b)/i)[0]
  .toLowerCase().replace(/[^a-z0-9]+/g, '');
export function titleKeyOf(file) {
  const parts = String(file || '').split(/[\\/]+/);
  const name = parts.pop() || '';
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 3); i--) {
    if (!parts[i] || GENERIC_DIR.test(parts[i])) continue;
    const k = keyOfName(parts[i]);
    if (k) return k;
  }
  return keyOfName(name);
}

function stripMarkup(line) {
  return line.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '');
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

function addFile(words, srt, repeated = null, title = '') {
  const { mid, seen } = fileVotes(srt, repeated);
  for (const lower of seen) {
    let e = words[lower];
    if (!e) e = words[lower] = [0, 0, 0, 0];
    e[3]++;
    const v = mid.get(lower);
    if (v) {
      const best = v.indexOf(Math.max(...v));
      e[best]++;
      if (!title) continue;
      e[4] ||= {};
      if (best > 0) e[5] ||= {};
      const votes = best === 0 ? e[4] : e[5];
      votes[title] = (votes[title] || 0) + 1;
    }
  }
}

function pruneTitles(words) {
  for (const e of Object.values(words)) {
    if (e[4] && !e[5]) e[4] = Object.fromEntries(Object.entries(e[4]).slice(0, 4));
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
      texts.push({ text, title: titleKeyOf(f) });
      for (const k of lineKeys(text)) lineFiles.set(k, (lineFiles.get(k) || 0) + 1);
    } catch { /* locked or gone */ }
    if (texts.length % 25 === 0) await new Promise((r) => setImmediate(r));
  }
  const repeated = new Set([...lineFiles].filter(([, n]) => n >= 3).map(([k]) => k));
  lineFiles.clear();
  let used = 0;
  for (const { text, title } of texts) {
    addFile(words, text, repeated, title);
    if (++used % 25 === 0) await new Promise((r) => setImmediate(r));
  }
  pruneTitles(words);
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
  // A plain string, or { text, title } to say which film or show it belongs to.
  for (const s of srts) addFile(words, s.text ?? s, null, s.title || '');
  pruneTitles(words);
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

// ---------- character names (TMDB) ----------
// Words in cast lists that are roles, not names ("Nurse", "Patient's Mother", "Man #2").
const ROLE_WORDS = new Set(['self', 'himself', 'herself', 'themselves', 'voice', 'narrator', 'uncredited', 'archive', 'footage',
  'doctor', 'nurse', 'patient', 'man', 'woman', 'boy', 'girl', 'guy', 'kid', 'baby', 'mother', 'father', 'mom', 'dad', 'wife', 'husband',
  'son', 'daughter', 'brother', 'sister', 'uncle', 'aunt', 'grandma', 'grandpa', 'friend', 'cop', 'officer', 'guard', 'detective',
  'agent', 'reporter', 'waiter', 'waitress', 'receptionist', 'lawyer', 'judge', 'young', 'old', 'older', 'younger', 'little', 'big',
  'various', 'additional', 'voices', 'the', 'and', 'of', 'his', 'her', 'their', 'with', 'from', 'student', 'teacher', 'driver',
  'paramedic', 'surgeon', 'resident', 'intern', 'fellow', 'manager', 'owner', 'clerk', 'soldier', 'priest', 'host', 'customer',
  'neighbor', 'neighbour', 'king', 'queen', 'prince', 'princess', 'lord', 'lady', 'sir', 'mister', 'miss', 'mrs', 'ms', 'mr', 'dr',
  // Said to someone like a name, but not one ("Thanks, honey.").
  'honey', 'sweetie', 'sweetheart', 'darling', 'dear', 'babe', 'buddy', 'pal', 'dude', 'love', 'doc', 'boss', 'chief', 'champ', 'sport',
  // Name particles ("Juan del Rio", "van Helsing") are lowercase in names too.
  'deputy', 'warden', 'prisoner', 'inmate', 'orderly', 'investigator', 'private', 'female', 'male', 'marshal', 'sheriff', 'head',
  'senior', 'junior', 'staff', 'crew', 'member', 'worker', 'assistant', 'secretary', 'technician', 'tech', 'pilot', 'captain', 'major',
  'del', 'della', 'van', 'von', 'der', 'den', 'bin', 'ibn', 'les', 'los', 'las']);
// Before a name these make it one even when it's also an ordinary word ("Dr. house", "Agent chase").
// After the first four any word the library doesn't know as an ordinary one is a name ("Dr sheehan").
const NAME_ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms']);
const NAME_TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'nurse', 'detective', 'agent', 'officer', 'sergeant', 'sgt', 'captain',
  'capt', 'professor', 'prof', 'lieutenant', 'lt', 'judge', 'senator', 'governor', 'father', 'sister', 'uncle', 'aunt']);

// Name words from a title's cast list ("Dr. Lisa Cuddy", "Remy 'Thirteen' Hadley") for one subtitle:
// lower → { form, kind, firsts }. kind 'name': a main character's name that's not an ordinary word
// anywhere else in the library, fixed wherever it's lowercase; 'title': also an ordinary word, but
// this title's clean subtitles write it as a name ("House" in House); 'weak': an ordinary word or a
// minor role ("Cartel Member", "Manacled Patient"), fixed only after "Dr." or when someone is
// addressed ("Thanks, chase."). firsts: the names written before it ("Jimmy" for "Jimmy quidd").
// characters: [{ name, main }] (or plain strings, all main).
const NAME_TOKEN = /^(?:Mc|Mac|O'|D')?[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/;
function nameTable(characters, title) {
  const out = new Map();
  if (!characters?.length) return out;
  const learned = lexicon && lexicon.files >= 50;
  for (const c of characters) {
    const { name, main = true } = typeof c === 'string' ? { name: c } : c;
    let before = '';
    for (const raw of String(name || '').split(/[\s"“”()/,&;:]+/)) {
      const t = raw.replace(/^['‘’-]+|['‘’.-]+$/g, '').replace(/['’]s$/, '');
      const lower = t.toLowerCase();
      const first = before;
      before = NAME_TOKEN.test(t) && !ROLE_WORDS.has(lower) ? lower : '';
      if (t.length < 3 || !NAME_TOKEN.test(t) || ROLE_WORDS.has(lower) || COMMON.has(lower)) continue;
      const known = out.get(lower);
      if (known) {
        if (first) known.firsts.add(first);
        if (!main || known.main) continue;
      }
      const e = entry(lower);
      const elsewhere = Object.keys(e?.[4] || {}).filter((k) => k !== title).length;
      // This title's subtitles capitalise it often enough that it can't be chance or one odd release.
      const here = e?.[5]?.[title] || 0;
      const kind = !learned ? 'weak' : here >= 5 && here >= 0.25 * (here + (e[4][title] || 0)) ? 'title' : elsewhere === 0 && main ? 'name' : 'weak';
      const firsts = known?.firsts || new Set();
      if (first) firsts.add(first);
      out.set(lower, { form: t, kind, main, firsts });
    }
  }
  return out;
}

// Ordinary words ("good", "out") are never names after "Miss" or in "Oh, good."; words the library
// sometimes writes as a name ("chase", "house") can be.
function nameLike(lower, title) {
  const e = entry(lower);
  if (!e) return true;
  const votes = e[0] + e[1] + e[2];
  return votes === 0 || (e[1] + e[2]) >= 0.1 * votes || !Object.keys(e[4] || {}).some((k) => k !== title);
}

// ---------- a reference subtitle ----------
// A second, human-made English subtitle for the same episode or film (subtitles.js fetches one from
// OpenSubtitles when a file looks broken). Only its capitalisation is used, never its text or
// timing: how it writes each word mid-sentence ("Shyamalan" every time) and in which company
// ("a large Coke, no" but "do some coke"). Words inside [sound tags] and ALL-CAPS speaker labels
// don't count.
const TOKEN = /([A-Za-z][A-Za-z']*|\d+(?:[.,:]\d+)*%?)/g;
function* tokensOf(cues) {
  let start = true;
  let prev = '';
  let prevRaw = '';
  for (const cue of cues) {
    let depth = 0;
    for (const raw of cue.lines) {
      const line = stripMarkup(raw);
      const toks = [...line.matchAll(TOKEN)];
      let last = 0;
      for (let i = 0; i < toks.length; i++) {
        const m = toks[i];
        const gap = line.slice(last, m.index);
        for (const c of gap) if (c === '[' || c === '(') depth++; else if ((c === ']' || c === ')') && depth) depth--;
        if (endsSentence(gap.replace(/[[(]+\s*$/, ' '), prevRaw)) start = true;
        if (/(\.\.\.|…)\s*$/.test(gap)) start = false;
        const word = m[0].replace(/'+$/, '');
        const next = toks[i + 1] ? toks[i + 1][0].replace(/'+$/, '').toLowerCase() : '';
        if (/^[A-Za-z]/.test(word) && !depth) yield { word, start, prev, next };
        prev = word.toLowerCase();
        prevRaw = word;
        last = m.index + m[0].length;
        if (!depth) start = false;
      }
      const tail = line.slice(last);
      for (const c of tail) if (c === '[' || c === '(') depth++; else if ((c === ']' || c === ')') && depth) depth--;
      if (endsSentence(tail, prevRaw, true)) start = true;
    }
  }
}

// { words: lower → Map(form → count), ctx: "prev word next" / "prev word|" / "|word next" → Map(form → count) }
function referenceTable(refSrt) {
  const words = new Map();
  const ctx = new Map();
  const add = (map, key, form) => {
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(form, (map.get(key).get(form) || 0) + 1);
  };
  for (const { word, start, prev, next } of tokensOf(parseCues(refSrt))) {
    if (start || word.length < 2) continue;
    const base = word.replace(/'s$/i, '');
    if (base.length > 1 && base === base.toUpperCase()) continue; // "HOUSE:" labels, shouting
    const lower = base.toLowerCase();
    add(words, lower, base);
    add(ctx, `${prev} ${lower} ${next}`, base);
    add(ctx, `${prev} ${lower}|`, base);
    add(ctx, `|${lower} ${next}`, base);
  }
  return { words, ctx };
}

// The form the reference uses for a lowercase word here, or null. Every mid-sentence use capitalised
// (twice or more, or once in the same company), or the same company capitalised and never lowercase.
function referenceForm(ref, lower, prev, next) {
  const all = ref.words.get(lower);
  if (!all || all.has(lower)) {
    for (const key of [`${prev} ${lower} ${next}`, `${prev} ${lower}|`, `|${lower} ${next}`]) {
      const forms = ref.ctx.get(key);
      if (!forms || forms.has(lower) || forms.size !== 1) continue;
      return [...forms.keys()][0];
    }
    return null;
  }
  if (all.size !== 1) return null;
  const [form, n] = [...all][0];
  if (n >= 2) return form;
  const near = [`${prev} ${lower}|`, `|${lower} ${next}`].some((k) => ref.ctx.get(k)?.has(form));
  return near ? form : null;
}

// A word the library writes in lowercase almost everywhere ("if", "medicine", "room"): the
// reference's own style ("Dean of Medicine", "...If you") doesn't change it.
function ordinaryWord(lower) {
  const e = entry(lower);
  return Boolean(e) && e[0] >= 8 && e[1] + e[2] < 0.1 * (e[0] + e[1] + e[2]);
}

// Is this subtitle worth fetching a reference for (OpenSubtitles downloads are limited)? Only when
// its casing looks broken.
export function wantsReference(srt, { characters = [], title = '' } = {}) {
  const cues = parseCues(srt);
  if (srt.length > 4000 && !looksEnglish(cues.flatMap((c) => c.lines.map(stripMarkup)).join('\n'))) return false;
  return casingBroken(cues, nameTable(characters, title));
}

// Does a downloaded reference fit: English, capitalising names properly, and the same episode
// (most of this subtitle's longer words appear in it)?
export function referenceFits(srt, refSrt, { characters = [], title = '' } = {}) {
  const refCues = parseCues(refSrt);
  if (refSrt.length > 4000 && !looksEnglish(refCues.flatMap((c) => c.lines.map(stripMarkup)).join('\n'))) return false;
  if (casingBroken(refCues, nameTable(characters, title))) return false;
  const bag = (text) => new Set((stripMarkup(text).toLowerCase().match(/[a-z']{5,}/g) || []));
  const mine = bag(srt);
  const theirs = bag(refSrt);
  let shared = 0;
  for (const w of mine) if (theirs.has(w)) shared++;
  return mine.size > 0 && shared >= 0.5 * mine.size;
}

// ---------- OCR repairs on whole lines ----------
const CONTRACTION_ENDS = /^(s|t|d|m|ll|re|ve)$/;
const known = (w, n = 20) => fileCount(w.toLowerCase()) >= n;
function repairText(text) {
  let t = text;
  // "$12,0001967" → "$12,000 1967": a thousands group has three digits, the rest is the next number.
  t = t.replace(/\b(\d{1,3}(?:,\d{3})+)(\d+)\b/g, '$1 $2');
  // "b.S.", "c.B." → "B.S.", "C.B." (not "a.m." / "e.g.", whose letters are both lowercase).
  t = t.replace(/(^|[^A-Za-z.])([a-z])\.(?=[A-Z]\.)/g, (m, a, l) => a + l.toUpperCase() + '.');
  // "he' s", "don' t" → "he's", "don't".
  t = t.replace(/\b([A-Za-z]+)['’] (s|t|d|m|ll|re|ve)\b(?!['’])/g, '$1\'$2');
  if (lexicon && lexicon.files >= 20) {
    // "don t", "it s" → "don't", "it's" when the library knows the contraction.
    t = t.replace(/\b([A-Za-z]+) (s|t|d|m|ll|re|ve)\b(?![A-Za-z'’-])/g, (m, w, end) =>
      (CONTRACTION_ENDS.test(end) && known(`${w}'${end}`) ? `${w}'${end}` : m));
    // "w rong", "s orry" → "wrong", "sorry": a split word the library knows, whose second half it doesn't.
    t = t.replace(/(^|[^A-Za-z'’-])([b-hj-zB-HJ-Z]) ([a-z]{2,})\b(?![A-Za-z'’-])/g, (m, a, l, rest) =>
      (known(l + rest) && fileCount(rest) * 10 < fileCount(l + rest) ? a + l + rest : m));
  }
  return t;
}
// Only the text between markup tags is repaired.
const repairLine = (line) => line.split(/(\{[^}]*\}|<[^>]*>)/).map((part, i) => (i % 2 ? part : repairText(part))).join('');

function fixWord(word, { start, prev, prevRaw = '', nextWord = '', reference = null, lone = false, broken, next = '', next2 = '', before = '', prevChar = '', names = null, title = '', titled = false, vocative = false, possessive = false }) {
  // A letter on its own is a capital ("vitamin c", "row d", "a flying v"). Not "a"/"i"/"l", nor
  // m/n/o/s/y (French "il y a", romaji "kage o", "rock n roll"), nor a letter touching anything but
  // spaces and punctuation (one letter of a styled word "<b>A{\\frz3}f{\\frz4}t…", "x-ray",
  // "o'clock", "wouldn´t"), nor "x"/"h" after a number ("2 x 3", "18 h"), nor a letter alone on a line.
  if (/^[b-hj-kp-rt-xz]$/.test(word) && (/^[\s,?!;:)\]…]?$/.test(next) || (next === '.' && !/[A-Za-z]/.test(next2))) && /^[\s(\["“‘]?$/.test(prevChar)
    && !(/^[xh]$/.test(word) && /^\d/.test(prevRaw)) && !lone) return word.toUpperCase();
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
    const base = w.replace(/'s$/, '');
    // A human-made subtitle of the same episode knows best ("shyamalan", "a large coke").
    const ref = !start && reference && base.length > 1 && !ordinaryWord(base) ? referenceForm(reference, base, prev, nextWord) : null;
    if (ref) return ref + w.slice(base.length);
    const name = names?.get(base);
    const fullName = name?.firsts.has(prev) && /^[A-Z]/.test(prevRaw) && /^\s+$/.test(before);
    if (name && (start || fullName || (broken && (name.kind === 'name' ? !DETERMINERS.has(prev)
      : name.kind === 'title' ? !DETERMINERS.has(prev) && !possessive : vocative && nameLike(base, title)))
      || (titled && (NAME_ABBREVIATIONS.has(prev) || nameLike(base, title))))) {
      return name.form + w.slice(base.length);
    }
    // "Dr sheehan", "Mr. breene": a word the library doesn't use as an ordinary one.
    if (titled && NAME_ABBREVIATIONS.has(prev) && base.length > 1 && !COMMON.has(base) && lexicon?.files >= 50
      && !Object.keys(entry(base)?.[4] || {}).some((k) => k !== title)) return capFirst(w);
    const shape = preferredShape(base, broken);
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
// A cast name that's never an ordinary word, lowercase mid-sentence three times, also counts.
// So does a name this title's own subtitles capitalise ("cuddy" in House), when it isn't after
// "the"/"my"/"Bob's" (where "house" is just a house).
function casingBroken(cues, names) {
  const odd = new Set();
  let nameHits = 0;
  for (const { word, start, prev } of tokensOf(cues)) {
    if (start || word !== word.toLowerCase() || word.length < 2) continue;
    const base = word.replace(/'s$/, '');
    if (strongShape(base)) odd.add(word);
    const kind = names?.get(base)?.kind;
    if (kind === 'name' || (kind === 'title' && !DETERMINERS.has(prev) && !/'s?$/.test(prev))) { odd.add(word); nameHits++; }
    if (odd.size >= 2 || nameHits >= 3) return true;
  }
  return false;
}

// characters: the title's cast list from TMDB ("Dr. Lisa Cuddy"); title: titleKeyOf(subtitle file).
// reference: a human-made English subtitle of the same episode/film (see referenceTable).
export function fixEnglishSrt(srt, { characters = [], title = '', reference = null } = {}) {
  // A track labelled English that isn't (French in an ".en.2.srt") is left as it is.
  const cues = parseCues(srt);
  if (srt.length > 4000 && !looksEnglish(cues.flatMap((c) => c.lines.map(stripMarkup)).join('\n'))) return srt;
  for (const c of cues) c.lines = c.lines.map(repairLine);
  const names = nameTable(characters, title);
  const broken = casingBroken(cues, names);
  const refTable = reference ? referenceTable(reference) : null;
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
      const re = /(\{[^}]*\}|<[^>]*>)|([A-Za-z][A-Za-z']*|\d+(?:[.,:]\d+)*%?)/g;
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
        const rest = stripMarkup(raw.slice(m.index + m[2].length));
        const fixed = /^[A-Za-z]/.test(word) && !joined ? fixWord(word, {
          next2: raw[m.index + m[2].length + 1] || '',
          nextWord: (rest.match(/^[^A-Za-z0-9]*?([A-Za-z][A-Za-z']*|\d+(?:[.,:]\d+)*%?)/)?.[1] || '').replace(/'+$/, '').toLowerCase(),
          reference: refTable,
          start: start && !depth, prev, prevRaw, lone: !/[A-Za-z]{2}|[A-Za-z][^A-Za-z]+[A-Za-z]/.test(stripMarkup(raw)), broken, next, before: gap, prevChar: raw[m.index - 1] || '', names, title,
          titled: NAME_TITLES.has(prev) && /^\.?\s+$/.test(gap),
          vocative: /,\s*$/.test(gap) && /^['’]?s?\s*(?:$|[.?!,…])/.test(rest),
          possessive: /['’]s?$/.test(prevRaw) || /^[A-Za-z]+s['’]$/.test(prevRaw),
        }) : word;
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
// characters: the film's or show's cast list (character names) from TMDB, when known.
export function cleanSubtitle(text, { lang, file = '', mtimeMs = 0, characters = [], reference = null } = {}) {
  if (lang !== 'en' || process.env.SUBTITLE_FIX === 'off') return text;
  const key = `${file}|${mtimeMs}|${lexicon?.at || 0}|${characters.length}|${reference?.length || 0}`;
  if (file && fixedCache.has(key)) return fixedCache.get(key);
  let out = text;
  try { out = fixEnglishSrt(text, { characters, title: titleKeyOf(file), reference }); } catch (e) { console.warn(`[subfix] ${path.basename(file)}: ${e.message}`); }
  if (file) {
    if (fixedCache.size > 200) fixedCache.delete(fixedCache.keys().next().value);
    fixedCache.set(key, out);
  }
  return out;
}
