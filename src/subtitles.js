// Subtitles via the OpenSubtitles REST API.
// Downloads are saved beside the video as "<name>.<lang>.srt", so each is fetched once
// and is also visible to other players.
import { currentLanguage, tr } from './i18n.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanSubtitle, wantsReference, referenceFits, titleKeyOf } from './subfix.js';

const API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const USER = process.env.OPENSUBTITLES_USER || '';
const PASS = process.env.OPENSUBTITLES_PASS || '';
const UA = 'Lilin v1.0';

export const LANG_NAMES = {
  en: 'English', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', is: 'Icelandic',
  de: 'German', nl: 'Dutch', fr: 'French', es: 'Spanish', 'pt-pt': 'Portuguese', 'pt-br': 'Portuguese (Brazil)',
  it: 'Italian', pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian', el: 'Greek',
  tr: 'Turkish', ru: 'Russian', uk: 'Ukrainian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', sl: 'Slovenian',
  et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian', ar: 'Arabic', he: 'Hebrew', fa: 'Persian', hi: 'Hindi',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', ja: 'Japanese', ko: 'Korean',
  'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)', ka: 'Georgian', tl: 'Tagalog',
};
const LANGS = (process.env.SUB_LANGS || 'en,sv,da,no,fi,de,nl,fr,es,pt-pt,pt-br,it,pl,ar,tr,ka,tl')
  .split(',').map((s) => s.trim().toLowerCase()).filter((l) => LANG_NAMES[l]);
// A language's name in the viewer's own language where the system knows it.
function langName(code) {
  const viewer = currentLanguage();
  if (viewer === 'en') return LANG_NAMES[code];
  try {
    const [base, region] = code.split('-');
    const tag = code === 'zh-cn' ? 'zh-Hans' : code === 'zh-tw' ? 'zh-Hant' : region && region !== base ? `${base}-${region.toUpperCase()}` : base;
    const name = new Intl.DisplayNames([viewer], { type: 'language' }).of(tag);
    return name && name !== tag ? name[0].toLocaleUpperCase(viewer) + name.slice(1) : LANG_NAMES[code];
  } catch { return LANG_NAMES[code]; }
}
const langList = (codes) => LANGS.filter((c) => codes.has(c)).map((code) => ({ code, name: langName(code) }));
// Every language Lilin looks for (SUB_LANGS), for the default-subtitles setting.
export const subtitleLanguages = () => LANGS.map((code) => ({ code, name: langName(code) }));

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
    const reset = data.reset_time ? tr(' It resets in {0}.', data.reset_time) : '';
    throw Object.assign(fail(429, `Today’s subtitle download limit is used up.${reset}${USER ? '' : tr(' Adding a free OpenSubtitles login to .env raises it.')}`), { quota: true });
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
    query: info.tmdbId && !episode ? null : info.title,
    tmdb_id: !episode ? info.tmdbId : null,
    year: episode || info.tmdbId ? null : info.year,
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
// AI translations are saved as "Movie.sv.ai.srt", so what they are stays with the file when it moves.
const autoSidecarPath = (file, lang) => `${stem(file)}.${lang}.ai.srt`;
export const isAutoSidecar = (file) => /\.ai\.srt$/i.test(String(file || ''));
const isAutoUpload = (sub) => Boolean(sub.attributes?.ai_translated || sub.attributes?.machine_translated);
// Written by a person and covers the whole film (foreign-parts files only have the odd line).
const isProperUpload = (sub) => !isAutoUpload(sub) && !sub.attributes?.foreign_parts_only;

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

export function findSidecar(file, lang) {
  const exact = sidecarPath(file, lang);
  if (fs.existsSync(exact)) return exact;
  const prefix = `${path.basename(file, path.extname(file))}.${lang}.`.toLowerCase();
  try {
    const hits = fs.readdirSync(path.dirname(file)).filter((e) => e.toLowerCase().startsWith(prefix) && e.toLowerCase().endsWith('.srt'));
    const hit = hits.find((e) => !isAutoSidecar(e)) || hits[0];
    return hit ? path.join(path.dirname(file), hit) : null;
  } catch { return null; }
}

// ---------- available languages ----------
const langCache = new Map(); // key -> { at, codes, proper }
const SIX_HOURS = 6 * 3600 * 1000;

// Searches don't count toward the download quota. Common languages fill the first pages, so a rare one
// can sit many pages in: each round asks only for what's still missing, until a round finds nothing new.
async function collectLanguages(info, found, extra, accept) {
  for (let round = 0; round < LANGS.length; round++) {
    const missing = LANGS.filter((l) => !found.has(l));
    if (!missing.length) break;
    const before = found.size;
    const data = await osFetch(query(searchParams(info, { languages: missing.sort().join(','), ...extra })));
    for (const s of data.data || []) {
      const l = String(s.attributes?.language || '').toLowerCase();
      if (LANG_NAMES[l] && accept(s)) found.add(l);
    }
    if (found.size === before) break;
  }
}

// { codes: every language online, proper: the ones with subtitles written by people }
async function remoteLanguages(info) {
  if (!API_KEY || !info.title) return { codes: new Set(), proper: new Set() };
  const key = JSON.stringify(info);
  const hit = langCache.get(key);
  if (hit && Date.now() - hit.at < SIX_HOURS) return hit;
  const proper = new Set();
  await collectLanguages(info, proper, { ai_translated: 'exclude' }, isProperUpload);
  const codes = new Set(proper);
  await collectLanguages(info, codes, {}, () => true);
  const entry = { at: Date.now(), codes, proper };
  langCache.set(key, entry);
  if (langCache.size > 300) langCache.delete(langCache.keys().next().value);
  return entry;
}

const autoLabelled = (l) => ({ ...l, name: `${l.name} (${tr('auto-translated')})`, auto: true });

// Languages for a local file: saved subtitles plus those available online.
export async function languagesForFile(file, info) {
  const local = localLanguages(file);
  let problem = null;
  let remote = { codes: new Set(), proper: new Set() };
  try { remote = await remoteLanguages(info); } catch (e) { problem = e.message; }
  const all = new Set([...local, ...remote.codes]);
  return {
    languages: langList(all).map((l) => {
      const saved = local.has(l.code);
      const savedAuto = saved && isAutoSidecar(findSidecar(file, l.code));
      const better = remote.proper.has(l.code);
      // "Not saved" when people's subtitles have turned up: choosing the language then fetches them.
      const entry = { ...l, saved: saved && !(savedAuto && better) };
      return (saved ? savedAuto : true) && !better ? autoLabelled(entry) : entry;
    }),
    ...(problem && { problem }),
    configured: Boolean(API_KEY),
  };
}

// Languages available online for a title that hasn't been downloaded yet.
export async function languagesForTitle(info) {
  const { codes, proper } = await remoteLanguages(info);
  return { languages: langList(codes).map((l) => (proper.has(l.code) ? l : autoLabelled(l))), configured: Boolean(API_KEY) };
}

// ---------- download ----------
const tokens = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));

const releaseSource = (s) => /blu[ ._-]?ray|b[dr]rip/i.test(s) ? 'bluray'
  : /web[ ._-]?(?:dl|rip)|webrip/i.test(s) ? 'web' : /hdtv|pdtv|dsr/i.test(s) ? 'tv' : /dvd/i.test(s) ? 'dvd' : null;

function score(sub, fileTokens, videoName, subtitleName) {
  const a = sub.attributes || {};
  let n = Math.log10((a.download_count || 0) + 1) * 10;
  if (a.moviehash_match === true) n += 1000;                  // exact release match
  // People's subtitles always win, even from another release: the timing check can fix timing, but
  // nothing fixes a machine reading the name "Sinon" as the French word for "otherwise".
  if (isAutoUpload(sub)) n -= 5000;
  if (a.hearing_impaired) n -= 5;                             // prefer regular subtitles
  if (a.foreign_parts_only) n -= 10000;                       // only the odd line: last resort
  for (const t of tokens(`${a.release || ''} ${subtitleName || ''}`)) if (fileTokens.has(t)) n += 15;
  const videoSource = releaseSource(videoName);
  const subSource = releaseSource(`${a.release || ''} ${subtitleName || ''}`);
  if (videoSource && subSource) n += videoSource === subSource ? 80 : -120;
  return n;
}

// Multi-file uploads can contain an entire season; select the matching file, not just the first one.
export function selectSubtitle(results, file, info, lang) {
  const name = path.basename(file);
  const fileTokens = tokens(name);
  const sameEpisode = (season, episode) => (info.season == null || season == null || Number(season) === info.season)
    && (info.episode == null || episode == null || Number(episode) === info.episode);
  const candidates = [];
  for (const sub of results) {
    const a = sub.attributes || {};
    if (String(a.language || '').toLowerCase() !== lang || !sameEpisode(a.feature_details?.season_number, a.feature_details?.episode_number)) continue;
    if (info.tmdbId && a.feature_details?.tmdb_id && Number(a.feature_details.tmdb_id) !== Number(info.tmdbId)) continue;
    for (const entry of a.files || []) {
      const ep = /\bs(\d{1,2})e(\d{1,3})\b/i.exec(entry.file_name || '');
      if (ep && !sameEpisode(ep[1], ep[2])) continue;
      if (entry.file_id) candidates.push({ sub, entry, score: score(sub, fileTokens, name, entry.file_name) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

const inflight = new Map();
const upgradeChecked = new Map(); // key -> when we last looked for people's subtitles to replace an AI translation
// Returns the path of the saved subtitle, downloading the best match if needed. An AI translation
// is only kept until people's own subtitles turn up.
export function ensureSubtitle(file, info, lang) {
  lang = String(lang).toLowerCase();
  if (!validLang(lang)) return Promise.reject(fail(400, 'Unknown language.'));
  const existing = findSidecar(file, lang);
  if (existing && !isAutoSidecar(existing)) return Promise.resolve(existing);
  const key = `${file}|${lang}`;
  if (existing && !inflight.has(key) && Date.now() - (upgradeChecked.get(key) || 0) < SIX_HOURS) return Promise.resolve(existing);
  if (!inflight.has(key)) {
    if (existing) upgradeChecked.set(key, Date.now());
    const job = existing ? download(file, info, lang, { properOnly: true }).catch(() => existing) : download(file, info, lang);
    inflight.set(key, job.finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function download(file, info, lang, { properOnly = false } = {}) {
  const search = async (extra) => (await osFetch(query(searchParams(info, { languages: lang, ...extra })))).data || [];
  // Remuxing/re-encoding changes the hash; the original release is much more likely to be indexed.
  const hash = await movieHash(info.hashFile || file).catch(() => null);
  let results = await search({ moviehash: hash, ...(properOnly && { ai_translated: 'exclude' }) });
  // A hash search can come back with nothing but AI translations while people's subtitles for the same
  // film sit under another release, so look for those before settling.
  if (!results.some(isProperUpload)) results = [...results, ...await search({ ai_translated: 'exclude' })];
  if (!results.length && hash && !properOnly) results = await search({});
  const best = selectSubtitle(properOnly ? results.filter(isProperUpload) : results, file, info, lang);
  const name = LANG_NAMES[lang];
  if (!best) throw fail(404, `OpenSubtitles has no ${name} subtitles for this.`);

  await login().catch((e) => console.warn(`[subtitles] ${e.message} Continuing without login.`));
  const dl = await osFetch('/download', { method: 'POST', body: { file_id: best.entry.file_id } });
  if (!dl.link) throw fail(502, 'OpenSubtitles didn’t return a download link.');
  let r;
  try { r = await fetch(dl.link, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }); } catch {
    throw fail(504, 'The subtitle download didn’t finish.');
  }
  if (!r.ok) throw fail(502, `The subtitle download failed (${r.status}).`);
  const text = decodeText(Buffer.from(await r.arrayBuffer()));
  if (!/-->/.test(text)) throw fail(502, 'The subtitle file OpenSubtitles sent wasn’t readable.');
  const auto = isAutoUpload(best.sub);
  const out = auto ? autoSidecarPath(file, lang) : sidecarPath(file, lang);
  await fs.promises.writeFile(out, text, 'utf8');
  if (!auto) await fs.promises.rm(autoSidecarPath(file, lang), { force: true }).catch(() => {});
  noteDownloadsLeft(dl.remaining);
  console.log(`[subtitles] saved ${path.basename(out)} (${dl.remaining ?? '?'} downloads left today)`);
  // Lets the timing check run (whether or not the file hash matched).
  try { onDownloaded?.(file, out, { exact: best.sub.attributes.moviehash_match === true }); } catch { /* best effort */ }
  return out;
}

// Decodes as UTF-8, falling back to Windows-1252.
function decodeText(buf) {
  let s = buf.toString('utf8');
  if (s.includes('\uFFFD')) s = new TextDecoder('windows-1252').decode(buf);
  return s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// The server's look-up of a video's cast list (character names from TMDB), for subfix.js.
let charactersOf = null;
export function setCharacterSource(fn) { charactersOf = fn; }
async function charactersFor(file) {
  if (!charactersOf) return [];
  let timer;
  try {
    return await Promise.race([charactersOf(file), new Promise((r) => { timer = setTimeout(() => r([]), 2000); })]) || [];
  } catch { return []; } finally { clearTimeout(timer); }
}

export async function readSubtitle(file, lang) {
  lang = String(lang).toLowerCase();
  const p = findSidecar(file, lang);
  if (!p) throw fail(404, 'Those subtitles aren’t on the server.');
  const [buf, st, characters] = await Promise.all([fs.promises.readFile(p), fs.promises.stat(p), lang === 'en' ? charactersFor(file) : []]);
  const text = decodeText(buf);
  // English text that came from OCR gets its names, acronyms and I/l mix-ups fixed (see subfix.js),
  // with a human-made subtitle of the same episode as a guide when one has been fetched.
  const reference = lang === 'en' ? await referenceFor(file, p, text, characters) : null;
  return cleanSubtitle(text, { lang, file: p, mtimeMs: st.mtimeMs, characters, reference });
}

// ---------- reference subtitles ----------
// When an English subtitle's casing looks broken (OCR'd from the disc: "talk to cuddy", "an m. Night
// shyamalan movie", "a large coke"), Lilin fetches one popular human-made English subtitle of the
// same episode or film from OpenSubtitles and keeps it in the cache. subfix.js copies only how it
// capitalises words, never its text or timing. Downloads are limited per day, so references only
// use what's left above SUBTITLE_REFERENCE_RESERVE (10), keeping those for subtitles people ask for.
// SUBTITLE_REFERENCE=off turns it off.
let refDir = null;
let refInfo = null;
let downloadsLeft = null;
let downloadsLeftAt = 0;
const refJobs = new Map();
const refFailed = new Map(); // key -> when a fetch last failed (retried after an hour)
const REF_WAIT_MS = 5000;
const DAY = 24 * 3600 * 1000;
const refReserve = () => Math.max(0, Number(process.env.SUBTITLE_REFERENCE_RESERVE ?? 10) || 0);

function noteDownloadsLeft(n) {
  if (n == null || !Number.isFinite(Number(n))) return;
  downloadsLeft = Number(n);
  downloadsLeftAt = Date.now();
}

// dir: where references are kept; info: video → { title, year, season, episode, tmdbId, parentTmdbId }.
export function setReferenceSource({ dir, info }) {
  refDir = dir;
  refInfo = info;
}

// One reference per video, whichever English sidecar (.en.srt, .en.sdh.srt) is shown.
const refKey = (srtPath) => crypto.createHash('sha1')
  .update(srtPath.replace(/\.(en|eng)(\.[a-z0-9]+)*\.srt$/i, '').toLowerCase()).digest('hex').slice(0, 24);

// ahead: fetching for the next episode in the background (that doesn't fetch the one after it).
async function referenceFor(video, srtPath, text, characters, { ahead = false } = {}) {
  if (!refDir || !refInfo || !API_KEY || process.env.SUBTITLE_REFERENCE === 'off') return null;
  const key = refKey(srtPath);
  const file = path.join(refDir, `${key}.srt`);
  try {
    const ref = decodeText(await fs.promises.readFile(file));
    if (!ahead) prefetchNext(video, characters);
    return ref;
  } catch { /* not fetched yet */ }
  if (!refJobs.has(key)) {
    const none = await fs.promises.stat(path.join(refDir, `${key}.none`)).catch(() => null);
    if (none && Date.now() - none.mtimeMs < 30 * DAY) return null;
    if (Date.now() - (refFailed.get(key) || 0) < 3600 * 1000) return null;
    const title = titleKeyOf(srtPath);
    if (!wantsReference(text, { characters, title })) return null;
    const job = fetchReference(video, key, text, { characters, title })
      .then((ref) => {
        // Watching a season: the next episode gets its reference ahead of time.
        if (ref && !ahead) prefetchNext(video, characters);
        return ref;
      })
      .catch((e) => {
        refFailed.set(key, Date.now());
        console.warn(`[subtitles] no reference for ${path.basename(srtPath)}: ${e.message}`);
        return null;
      })
      .finally(() => refJobs.delete(key));
    refJobs.set(key, job);
  }
  // The first showing waits a little; if the download takes longer, the next one has it.
  let timer;
  const waited = await Promise.race([refJobs.get(key), new Promise((r) => { timer = setTimeout(() => r(null), REF_WAIT_MS); })]);
  clearTimeout(timer);
  return waited;
}

async function fetchReference(video, key, text, { characters, title }) {
  if (downloadsLeft != null && downloadsLeft <= refReserve() && Date.now() - downloadsLeftAt < DAY) return null;
  const info = refInfo(video);
  if (!info?.title) return null;
  const episode = info.season != null;
  const params = info.parentTmdbId
    ? { parent_tmdb_id: info.parentTmdbId, season_number: info.season, episode_number: info.episode, type: 'episode' }
    : searchParams(info);
  const results = (await osFetch(query({ ...params, languages: 'en', ai_translated: 'exclude' }))).data || [];
  // The most downloaded human-made one for this exact episode: popular files are the clean ones.
  const sameEpisode = (a) => !episode || (Number(a.feature_details?.season_number) === info.season
    && (info.episode == null || Number(a.feature_details?.episode_number) === info.episode));
  const best = results
    .filter((r) => isProperUpload(r) && String(r.attributes?.language).toLowerCase() === 'en' && sameEpisode(r.attributes) && r.attributes.files?.[0]?.file_id)
    .sort((a, b) => (a.attributes.hearing_impaired - b.attributes.hearing_impaired) || (b.attributes.download_count || 0) - (a.attributes.download_count || 0))[0];
  await fs.promises.mkdir(refDir, { recursive: true });
  const none = () => fs.promises.writeFile(path.join(refDir, `${key}.none`), '').then(() => null);
  if (!best) return none();
  await login().catch(() => {});
  let dl;
  try { dl = await osFetch('/download', { method: 'POST', body: { file_id: best.attributes.files[0].file_id } }); } catch (e) {
    if (e.quota) noteDownloadsLeft(0);
    throw e;
  }
  noteDownloadsLeft(dl.remaining);
  if (!dl.link) throw fail(502, 'no download link');
  const r = await fetch(dl.link, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw fail(502, `download failed (${r.status})`);
  const ref = decodeText(Buffer.from(await r.arrayBuffer()));
  // The wrong episode, another language or OCR'd itself: not used, and not fetched again for a month.
  if (!/-->/.test(ref) || !referenceFits(text, ref, { characters, title })) {
    console.log(`[subtitles] reference for ${path.basename(video)} didn't fit (${dl.remaining ?? '?'} downloads left today)`);
    return none();
  }
  await fs.promises.writeFile(path.join(refDir, `${key}.srt`), ref, 'utf8');
  console.log(`[subtitles] saved a reference for ${path.basename(video)} (${dl.remaining ?? '?'} downloads left today)`);
  return ref;
}

const VIDEO_FILE = /\.(mkv|mp4|m4v|mov|webm|avi)$/i;
function prefetchNext(video, characters) {
  let names;
  try { names = fs.readdirSync(path.dirname(video)).filter((n) => VIDEO_FILE.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); } catch { return; }
  const next = names[names.indexOf(path.basename(video)) + 1];
  if (!next || !refDir) return;
  const nextVideo = path.join(path.dirname(video), next);
  const p = findSidecar(nextVideo, 'en');
  if (!p) return;
  if (refJobs.has(refKey(p)) || fs.existsSync(path.join(refDir, `${refKey(p)}.srt`))) return;
  fs.promises.readFile(p).then((buf) => referenceFor(nextVideo, p, decodeText(buf), characters, { ahead: true })).catch(() => {});
}

// SRT to WebVTT: header, dotted timestamps, ASS override tags removed. Lines tagged {\an7}–{\an9}
// (signs and captions placed at the top of the picture) keep that position as a `line:0` cue setting.
export function srtToVtt(srt) {
  const body = srt
    .replace(/^\s+/, '')
    .split(/\n\s*\n/)
    .map((cue) => {
      const top = /\{\\an[789]\}/.test(cue);
      return cue
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .replace(/^(.*-->\s*\S+).*$/m, top ? '$1 line:0' : '$1');
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}`;
}

// ---------- deferred downloads ----------
let wantsFile = null;
let onDownloaded = null;
let wants = {}; // infohash -> { name, langs: { en: 'waiting' | 'ready' | 'missing' | 'error' }, at }

export function initSubtitles({ dataDir, onDownload }) {
  onDownloaded = onDownload || null;
  wantsFile = path.join(dataDir, '.lilin-subs.json');
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
