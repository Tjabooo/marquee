// Subtitles via the OpenSubtitles REST API.
// Downloads are saved beside the video as "<name>.<lang>.srt", so each is fetched once
// and is also visible to other players.
import fs from 'node:fs';
import path from 'node:path';

const API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const USER = process.env.OPENSUBTITLES_USER || '';
const PASS = process.env.OPENSUBTITLES_PASS || '';
const UA = 'Marquee v1.0';

export const LANG_NAMES = {
  en: 'English', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', is: 'Icelandic',
  de: 'German', nl: 'Dutch', fr: 'French', es: 'Spanish', 'pt-pt': 'Portuguese', 'pt-br': 'Portuguese (Brazil)',
  it: 'Italian', pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian', el: 'Greek',
  tr: 'Turkish', ru: 'Russian', uk: 'Ukrainian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', sl: 'Slovenian',
  et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian', ar: 'Arabic', he: 'Hebrew', fa: 'Persian', hi: 'Hindi',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', ja: 'Japanese', ko: 'Korean',
  'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)',
};
const LANGS = (process.env.SUB_LANGS || 'en,sv,da,no,fi,de,nl,fr,es,pt-pt,pt-br,it,pl,ar,tr')
  .split(',').map((s) => s.trim().toLowerCase()).filter((l) => LANG_NAMES[l]);
const langList = (codes) => LANGS.filter((c) => codes.has(c)).map((code) => ({ code, name: LANG_NAMES[code] }));

export const subtitlesConfigured = () => Boolean(API_KEY);
export const validLang = (l) => Object.hasOwn(LANG_NAMES, String(l || '').toLowerCase());

const fail = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- API client ----------
let base = 'https://api.opensubtitles.com/api/v1';
let token = null;
let tokenAt = 0;
let lastCall = 0;
let chain = Promise.resolve();

// Requests are serialized and spaced to stay within the API's rate limits.
function osFetch(endpoint, opts = {}) {
  const run = chain.then(async () => {
    const wait = lastCall + 350 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return osFetchNow(endpoint, opts);
  });
  chain = run.catch(() => {});
  return run;
}

async function osFetchNow(endpoint, { method = 'GET', body } = {}) {
  if (!API_KEY) throw fail(503, 'Subtitles need an OpenSubtitles API key. Add OPENSUBTITLES_API_KEY to .env and restart.');
  const headers = { 'Api-Key': API_KEY, 'User-Agent': UA, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let r;
  try {
    r = await fetch(base + endpoint, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  } catch {
    throw fail(504, 'Couldn’t reach OpenSubtitles. Check the server’s internet connection.');
  }
  let data = {};
  try { data = await r.json(); } catch { /* not JSON */ }
  if (r.status === 401 || r.status === 403) {
    if (endpoint === '/login') throw fail(502, 'OpenSubtitles rejected the login. Check OPENSUBTITLES_USER and OPENSUBTITLES_PASS.');
    throw fail(502, 'OpenSubtitles rejected the API key. Check OPENSUBTITLES_API_KEY in .env.');
  }
  if (r.status === 429) throw fail(429, 'OpenSubtitles is busy. Try again in a few seconds.');
  if (r.status === 406 || (endpoint === '/download' && data.remaining != null && !data.link)) {
    const reset = data.reset_time ? ` It resets in ${data.reset_time}.` : '';
    throw Object.assign(fail(429, `Today’s subtitle download limit is used up.${reset}${USER ? '' : ' Adding a free OpenSubtitles login to .env raises it.'}`), { quota: true });
  }
  if (!r.ok) throw fail(502, data.message || `OpenSubtitles responded with ${r.status}.`);
  return data;
}

async function login() {
  if (!USER || !PASS) return;
  if (token && Date.now() - tokenAt < 23 * 3600 * 1000) return; // tokens are valid for 24 h
  const data = await osFetch('/login', { method: 'POST', body: { username: USER, password: PASS } });
  token = data.token || null;
  tokenAt = Date.now();
  if (data.base_url) base = `https://${data.base_url}/api/v1`; // VIP accounts get a different host
}

// Parameters must be sorted and lower-case, or the API responds with a redirect.
function query(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v).toLowerCase())}`)
    .join('&');
  return `/subtitles?${q}`;
}

function searchParams(info, extra = {}) {
  const episode = info.season != null || Boolean(info.tv);
  return {
    query: info.title,
    year: episode ? null : info.year,
    season_number: episode ? info.season : null,
    episode_number: episode ? info.episode : null,
    type: episode ? 'episode' : 'movie',
    ...extra,
  };
}

// ---------- file hash ----------
// OpenSubtitles hash: file size plus the 64-bit sum of the first and last 64 KB.
export async function movieHash(file) {
  const CHUNK = 65536;
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < CHUNK * 2) return null;
    const buf = Buffer.alloc(CHUNK * 2);
    await fh.read(buf, 0, CHUNK, 0);
    await fh.read(buf, CHUNK, CHUNK, size - CHUNK);
    let sum = BigInt(size);
    for (let i = 0; i < buf.length; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & 0xFFFFFFFFFFFFFFFFn;
    return sum.toString(16).padStart(16, '0');
  } finally {
    await fh.close();
  }
}

// ---------- local subtitle files ----------
const stem = (file) => path.join(path.dirname(file), path.basename(file, path.extname(file)));
export const sidecarPath = (file, lang) => `${stem(file)}.${lang}.srt`;

// Languages already saved beside a video ("Movie.en.srt", "Movie.sv.forced.srt", ...).
export function localLanguages(file) {
  const name = path.basename(file, path.extname(file)).toLowerCase();
  const found = new Set();
  let entries = [];
  try { entries = fs.readdirSync(path.dirname(file)); } catch { return found; }
  for (const e of entries) {
    const lower = e.toLowerCase();
    if (!lower.startsWith(`${name}.`) || !lower.endsWith('.srt')) continue;
    const code = lower.slice(name.length + 1, -4).split('.')[0];
    if (LANG_NAMES[code]) found.add(code);
  }
  return found;
}

function findSidecar(file, lang) {
  const exact = sidecarPath(file, lang);
  if (fs.existsSync(exact)) return exact;
  const prefix = `${path.basename(file, path.extname(file))}.${lang}.`.toLowerCase();
  try {
    const hit = fs.readdirSync(path.dirname(file)).find((e) => e.toLowerCase().startsWith(prefix) && e.toLowerCase().endsWith('.srt'));
    return hit ? path.join(path.dirname(file), hit) : null;
  } catch { return null; }
}

// ---------- available languages ----------
const langCache = new Map(); // key -> { at, codes }

async function remoteLanguages(info) {
  if (!API_KEY || !info.title) return new Set();
  const key = JSON.stringify(info);
  const hit = langCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.codes;
  const codes = new Set();
  // Searches don't count toward the download quota.
  for (let page = 1; page <= 3; page++) {
    const data = await osFetch(query(searchParams(info, { languages: [...LANGS].sort().join(','), page })));
    for (const s of data.data || []) {
      const l = String(s.attributes?.language || '').toLowerCase();
      if (LANG_NAMES[l]) codes.add(l);
    }
    if (page >= (data.total_pages || 1) || codes.size === LANGS.length) break;
  }
  langCache.set(key, { at: Date.now(), codes });
  if (langCache.size > 300) langCache.delete(langCache.keys().next().value);
  return codes;
}

// Languages for a local file: saved subtitles plus those available online.
export async function languagesForFile(file, info) {
  const local = localLanguages(file);
  let problem = null;
  let remote = new Set();
  try { remote = await remoteLanguages(info); } catch (e) { problem = e.message; }
  const all = new Set([...local, ...remote]);
  return {
    languages: langList(all).map((l) => ({ ...l, saved: local.has(l.code) })),
    ...(problem && { problem }),
    configured: Boolean(API_KEY),
  };
}

// Languages available online for a title that hasn't been downloaded yet.
export async function languagesForTitle(info) {
  return { languages: langList(await remoteLanguages(info)), configured: Boolean(API_KEY) };
}

// ---------- download ----------
const tokens = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));

function score(sub, fileTokens) {
  const a = sub.attributes || {};
  let n = Math.log10((a.download_count || 0) + 1) * 10;
  if (a.moviehash_match) n += 1000;                           // exact release match
  if (a.ai_translated || a.machine_translated) n -= 300;
  if (a.hearing_impaired) n -= 5;                             // prefer regular subtitles
  if (a.foreign_parts_only) n -= 500;
  for (const t of tokens(a.release)) if (fileTokens.has(t)) n += 15; // shared release tokens
  return n;
}

const inflight = new Map();
// Returns the path of "<video>.<lang>.srt", downloading the best match if needed.
export function ensureSubtitle(file, info, lang) {
  lang = String(lang).toLowerCase();
  if (!validLang(lang)) return Promise.reject(fail(400, 'Unknown language.'));
  const existing = findSidecar(file, lang);
  if (existing) return Promise.resolve(existing);
  const key = `${file}|${lang}`;
  if (!inflight.has(key)) {
    inflight.set(key, download(file, info, lang).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function download(file, info, lang) {
  const hash = await movieHash(file).catch(() => null);
  let data = await osFetch(query(searchParams(info, { languages: lang, moviehash: hash })));
  if (!data.data?.length && hash) data = await osFetch(query(searchParams(info, { languages: lang })));
  const fileTokens = tokens(path.basename(file));
  const best = (data.data || [])
    .filter((s) => String(s.attributes?.language || '').toLowerCase() === lang && s.attributes?.files?.length)
    .sort((a, b) => score(b, fileTokens) - score(a, fileTokens))[0];
  const name = LANG_NAMES[lang];
  if (!best) throw fail(404, `OpenSubtitles has no ${name} subtitles for this.`);

  await login().catch((e) => console.warn(`[subtitles] ${e.message} Continuing without login.`));
  const dl = await osFetch('/download', { method: 'POST', body: { file_id: best.attributes.files[0].file_id } });
  if (!dl.link) throw fail(502, 'OpenSubtitles didn’t return a download link.');
  let r;
  try { r = await fetch(dl.link, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }); } catch {
    throw fail(504, 'The subtitle download didn’t finish.');
  }
  if (!r.ok) throw fail(502, `The subtitle download failed (${r.status}).`);
  const text = decodeText(Buffer.from(await r.arrayBuffer()));
  if (!/-->/.test(text)) throw fail(502, 'The subtitle file OpenSubtitles sent wasn’t readable.');
  const out = sidecarPath(file, lang);
  await fs.promises.writeFile(out, text, 'utf8');
  console.log(`[subtitles] saved ${path.basename(out)} (${dl.remaining ?? '?'} downloads left today)`);
  return out;
}

// Decodes as UTF-8, falling back to Windows-1252.
function decodeText(buf) {
  let s = buf.toString('utf8');
  if (s.includes('\uFFFD')) s = new TextDecoder('windows-1252').decode(buf);
  return s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export async function readSubtitle(file, lang) {
  const p = findSidecar(file, String(lang).toLowerCase());
  if (!p) throw fail(404, 'Those subtitles aren’t on the server.');
  return decodeText(await fs.promises.readFile(p));
}

// SRT to WebVTT: header, dotted timestamps, ASS override tags removed.
export function srtToVtt(srt) {
  const body = srt
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\s+/, '');
  return `WEBVTT\n\n${body}`;
}

// ---------- deferred downloads ----------
let wantsFile = null;
let wants = {}; // infohash -> { name, langs: { en: 'waiting' | 'ready' | 'missing' | 'error' }, at }

export function initSubtitles({ dataDir }) {
  wantsFile = path.join(dataDir, '.marquee-subs.json');
  try { wants = JSON.parse(fs.readFileSync(wantsFile, 'utf8')); } catch { wants = {}; }
}
const saveWants = () => { try { fs.writeFileSync(wantsFile, JSON.stringify(wants, null, 2)); } catch { /* best effort */ } };

// Info hash from a magnet link, normalized to lower-case hex (magnets may use base32).
export function infoHashOf(magnet) {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet || '');
  if (!m) return null;
  const h = m[1];
  if (/^[a-f0-9]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(h)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of h.toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
    return bits.match(/.{4}/g).map((b) => parseInt(b, 2).toString(16)).join('');
  }
  return null;
}

export function wantSubtitles(magnet, langs, name) {
  const hash = infoHashOf(magnet);
  const list = [...new Set((langs || []).map((l) => String(l).toLowerCase()).filter(validLang))];
  if (!hash || !list.length) return false;
  wants[hash] = { name, langs: Object.fromEntries(list.map((l) => [l, 'waiting'])), at: Date.now() };
  saveWants();
  return true;
}

export const subtitleWants = (hash) => (wants[hash]
  ? Object.entries(wants[hash].langs).map(([code, state]) => ({ code, name: LANG_NAMES[code], state }))
  : null);

// Called periodically. finishedFile(hash) returns { file, info }, or null while downloading.
let processing = false;
export async function processWants(finishedFile) {
  if (processing || !API_KEY) return;
  processing = true;
  try {
    for (const [hash, w] of Object.entries(wants)) {
      if (Date.now() - w.at > 30 * 86400000) { delete wants[hash]; continue; } // expire after 30 days
      const waiting = Object.keys(w.langs).filter((l) => w.langs[l] === 'waiting');
      if (!waiting.length) continue;
      let target;
      try { target = await finishedFile(hash); } catch { continue; }
      if (!target) continue;
      for (const lang of waiting) {
        try {
          await ensureSubtitle(target.file, target.info, lang);
          w.langs[lang] = 'ready';
        } catch (e) {
          if (e.quota) return; // retry after the quota resets
          w.langs[lang] = e.status === 404 ? 'missing' : 'error';
          console.warn(`[subtitles] ${w.name} (${lang}): ${e.message}`);
        }
      }
    }
  } finally {
    saveWants();
    processing = false;
  }
}
