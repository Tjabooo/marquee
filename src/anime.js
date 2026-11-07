// Anime: fansub release names, absolute episode numbers and seasons that don't line up with TMDB's.
//
// Anime releases rarely look like "Show.S01E05". They look like "[SubsPlease] Sousou no Frieren S2 - 03
// (1080p) [7556A22B].mkv", "[SubsPlease] Black Clover - 176 (1080p)" (counted from the very first
// episode), "[Erai-raws] Black Clover 2nd Season - 06" or batches such as "[SubsPlease] Black Clover
// (01-170) (1080p) [Batch]" and "[Judas] Jujutsu Kaisen (Season 2) [1080p] (Batch)". Their titles are
// usually the romanised Japanese name ("Sousou no Frieren") rather than TMDB's ("Frieren: Beyond
// Journey's End"), and TMDB often lumps several Japanese seasons into one (Frieren's 28 + 10 episodes
// are TMDB's season 1, episodes 1-38).
//
// So for an anime title Marquee builds a context (TMDB + AniList): every known name, TMDB's seasons as
// ranges of one absolute episode count, and AniList's seasons ("entries", following its sequel chain)
// placed on that same count by their episode numbers. Any release name then resolves to TMDB's season
// and episode numbers, whichever convention it uses. Contexts are cached in .marquee-anime.json.
import fs from 'node:fs';
import path from 'node:path';
import { showKey } from './shows.js';

const ANILIST = process.env.ANILIST_URL || 'https://graphql.anilist.co';
const VERSION = 3;
const DAY = 24 * 60 * 60 * 1000;
const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;

// ---------- release names ----------
const RANGE = /^(\d{1,4})\s?[-~～]\s?(\d{1,4})\b/;
const pad = (n) => String(n).padStart(2, '0');
const span = (a, b) => (b > a && b - a <= 2000 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : null);
// "1+2+3", "1-4", "01-05", "S1+S2+S3+SP" -> [1, 2, 3(, 4, 5)]
function seasonList(text) {
  const nums = [];
  const parts = String(text).split(/\s?[+&,]\s?/);
  for (const p of parts) {
    const r = /^(?:S|Seasons?\s?)?(\d{1,2})\s?[-~]\s?(?:S|Season\s?)?(\d{1,2})$/i.exec(p.trim());
    if (r) { (span(Number(r[1]), Number(r[2])) || [Number(r[1])]).forEach((n) => nums.push(n)); continue; }
    const one = /^(?:S|Seasons?\s?)?(\d{1,2})$/i.exec(p.trim());
    if (one) nums.push(Number(one[1]));
  }
  return [...new Set(nums)];
}

// What an anime-style release name says. null when it doesn't look like one (no group tag, no
// " - 05" episode, no batch range, no season marker). Fields:
// { group, title, alt, seasons: [n] | null, episodes: [n] | null, batch, special, movie, year }
// episodes count within `seasons[0]` when a season is named, else from the first episode overall
// (or within the named entry, see resolve()).
export function parseAnimeName(raw, { file = false } = {}) {
  let name = String(raw || '').trim();
  if (file) name = name.replace(/\.(mkv|mp4|m4v|avi|mov|webm|ts|wmv)$/i, '');
  name = name.replace(/_/g, ' ');
  // Only with a leading zero or an E/EP prefix: a film can be called "2012" or "300".
  const bare = /^(?:(?:E|EP|Episode\s?)(\d{1,4})|(0\d{1,3}))(?:v\d)?$/i.exec(name);
  if (file && bare) { // "05.mkv" in the show's folder
    return { group: null, title: '', alt: null, seasons: null, episodes: [Number(bare[1] || bare[2])], batch: false, special: false, movie: false, year: null };
  }
  const group = /^\s*[[【]([^\]】]{1,40})[\]】]\s*/.exec(name);
  if (group) name = name.slice(group[0].length);
  // Bracketed parts: ranges, seasons, years, "Batch", quality tags. Taken out of the title.
  const brackets = [];
  name = name.replace(/\s*[[(（【]([^\])）】]*)[\])）】]/g, (m, inner) => { brackets.push(inner.trim()); return ' '; });
  if (!/\s/.test(name.trim())) name = name.replace(/\./g, ' '); // Scene style: dots for spaces
  let alt = null;
  const bar = name.indexOf(' | ');
  if (bar >= 0) { alt = name.slice(bar + 3).trim() || null; name = name.slice(0, bar); }
  let core = ` ${name.replace(/\s+/g, ' ').trim()} `;

  let seasons = null, episodes = null, special = false, cut = core.length;
  const at = (re) => { const m = re.exec(core); return m && m.index < cut ? m : null; };
  let m;
  // S01E05, S01E13-E25
  if ((m = at(/\s(?:-\s)?S(\d{1,2})\s?E(\d{1,4})(?:\s?-\s?E?(\d{1,4}))?(?:v\d)?(?=\s)/i))) {
    seasons = [Number(m[1])];
    episodes = (m[3] && span(Number(m[2]), Number(m[3]))) || [Number(m[2])];
    cut = m.index;
  }
  // Season markers: "S2", "S01-05", "S1+S2+S3", "Season 3", "Seasons 1-4", "2nd Season"
  if (!seasons && (m = at(/\s(?:-\s)?((?:S|Seasons?\s?)\d{1,2}(?:\s?[+&]\s?(?:S|Season\s?)?\d{1,2}|[-~](?:S|Season\s?)?\d{1,2}|\s[-~]\sS\d{1,2})*)(?:\s?v\d)?(?=\s)/i))) {
    seasons = seasonList(m[1]);
    cut = m.index;
  }
  if (!seasons && (m = at(/\s(\d{1,2})(?:st|nd|rd|th)\sSeason(?=\s)/i))) { seasons = [Number(m[1])]; cut = m.index; }
  if (!episodes) {
    // After a season marker ("S2 - 05"), else anywhere: the earliest one ends the title.
    const base = seasons ? cut : 0;
    const hay = core.slice(base);
    const r = /\s(?:-\s)?(\d{1,4})\s?[-~～]\s?(\d{1,4})(?=\s)/.exec(hay);           // " - 001 ~ 170", " 01 - 60"
    const ep = /\s-\s(?:#|EP?\s?)?(\d{1,4})(\.\d)?(?:v\d)?(?:\sEND)?(?=\s)/i.exec(hay) // " - 05", " - 05v2"
      || /\s(?:EP|Episode)\s?(\d{1,4})(\.\d)?(?:v\d)?(?=\s)/i.exec(hay);           // " EP1158"
    const range = r && span(Number(r[1]), Number(r[2]));
    if (range && (!ep || r.index <= ep.index)) {
      episodes = range;
      if (!seasons) cut = base + r.index;
    } else if (ep) {
      if (ep[2]) special = true; // "05.5": a recap between episodes
      else episodes = [Number(ep[1])];
      if (!seasons) cut = base + ep.index;
    }
  }
  // Brackets: "(01-170)", "(0001-1071+Movies)", "(Season 2)", "(Seasons 1-4 + Extras)", "(2017-2021)"
  let year = null;
  for (const b of brackets) {
    const y = /^((?:19|20)\d{2})(?:\s?-\s?(?:19|20)\d{2})?$/.exec(b);
    if (y) { year ??= Number(y[1]); continue; }
    const r = RANGE.exec(b);
    if (r && !episodes) { episodes = span(Number(r[1]), Number(r[2])); continue; }
    const s = /^(?:Seasons?\s?\d{1,2}|S\d{1,2})(?:\s?[-+&~,]\s?(?:S|Season\s?)?\d{1,2})*/i.exec(b);
    if (s && !seasons) seasons = seasonList(s[0]);
  }
  let title = core.slice(0, cut).replace(/\s+/g, ' ').trim();
  for (let prev = null; prev !== title;) {
    prev = title;
    title = title.replace(/[\s\-–:]+$/, '').replace(/\s(?:TV|BD|Batch|Complete|Full Series|The Complete Series)$/i, '').trim();
  }
  const movie = /\b(?:movie|gekijouban|the movie)\b/i.test(title) && !episodes;
  const batch = /\bbatch\b|\bcomplete\b|full series/i.test(raw) || Boolean(episodes && episodes.length > 1) || Boolean(seasons && !episodes);
  // Only a name that really looks like an anime release counts.
  const crc = /\[[0-9A-F]{8}\]/i.test(raw);
  if (!seasons && !episodes && !special && !(group && (batch || crc || movie))) return null;
  if (!title && !episodes && !seasons) return null;
  return { group: group ? group[1].trim() : null, title, alt, seasons, episodes, batch, special, movie, year };
}

// ---------- contexts ----------
let cacheFile = null;
let contexts = {};                 // "tv:123" -> context
let byKey = new Map();             // title key -> context
const building = new Map();

export function initAnime({ dataDir } = {}) {
  cacheFile = dataDir ? path.join(dataDir, '.marquee-anime.json') : null;
  try { contexts = cacheFile ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}; } catch { contexts = {}; }
  for (const [k, c] of Object.entries(contexts)) if (c?.v !== VERSION) delete contexts[k];
  reindex();
}
let saveTimer = null;
function save() {
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.promises.writeFile(cacheFile, JSON.stringify(contexts)).catch(() => {});
  }, 500);
}
function reindex() {
  byKey = new Map();
  for (const c of Object.values(contexts)) {
    if (c.type !== 'tv') continue;
    for (const k of [...c.keys, ...c.entries.flatMap((e) => e.keys)]) if (!byKey.has(k)) byKey.set(k, c);
  }
}

// TMDB details of an anime: animation from Japan (or Japanese-language animation).
export function isAnimeDetails(d) {
  if (!d) return false;
  const genres = Array.isArray(d.genres) ? d.genres.map((g) => g?.id) : d.genre_ids || [];
  if (!genres.includes(16)) return false;
  const countries = [...(d.origin_country || []), ...(d.production_countries || []).map((c) => c?.iso_3166_1)];
  return d.original_language === 'ja' || countries.includes('JP');
}

export const contextFor = (type, id) => contexts[`${type}:${id}`] || null;
// The anime context a show name belongs to (library files, torrents), from the cache only.
export function contextForTitle(title) {
  const key = showKey(title);
  return key ? byKey.get(key) || null : null;
}

// "SPY×FAMILY" and "SPY x FAMILY" are the same name.
const keysOf = (titles) => [...new Set(titles.filter((t) => t && LATIN.test(t))
  .flatMap((t) => [showKey(t), showKey(t.replace(/\s*×\s*/g, ' x '))]).filter((k) => k.length >= 3))];

// AniList allows about 30 requests a minute: one at a time, spaced, waiting out a 429 once.
let anilistQueue = Promise.resolve();
const GAP_MS = 2100;
function anilist(query, variables) {
  const run = anilistQueue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(ANILIST, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 429 && attempt === 0) {
        const wait = Math.min(65, Number(r.headers.get('retry-after')) || 30);
        await new Promise((ok) => setTimeout(ok, wait * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`AniList answered ${r.status}`);
      const data = await r.json();
      if (data.errors?.length && !data.data) throw new Error(data.errors[0].message || 'AniList error');
      return data.data;
    }
  });
  anilistQueue = run.catch(() => {}).then(() => new Promise((ok) => setTimeout(ok, GAP_MS)));
  return run;
}
const FIELDS = 'id format episodes status startDate{year} title{romaji english} synonyms';
const SEARCH = `query($s:String,$f:[MediaFormat]){Page(perPage:10){media(search:$s,type:ANIME,format_in:$f,sort:SEARCH_MATCH){${FIELDS}}}}`;
// Two sequel levels per request: half the requests for long chains.
const SEQUELS = `query($id:Int){Media(id:$id){relations{edges{relationType node{${FIELDS} type relations{edges{relationType node{${FIELDS} type}}}}}}}}`;
const TV_FORMATS = ['TV', 'TV_SHORT', 'ONA'];
const titlesOf = (m) => [m.title?.romaji, m.title?.english, ...(m.synonyms || [])].filter(Boolean);

// AniList's first season of the show (title + start year), then its sequels in order. Films and
// specials are passed through but not counted; unreleased seasons are left out.
async function anilistChain(names, year, keys, type) {
  const formats = type === 'movie' ? ['MOVIE'] : TV_FORMATS;
  let first = null;
  for (const s of names.slice(0, 3)) {
    const list = (await anilist(SEARCH, { s, f: formats }))?.Page?.media || [];
    const named = list.filter((m) => keysOf(titlesOf(m)).some((k) => keys.includes(k)));
    const near = (m) => !year || !m.startDate?.year || Math.abs(m.startDate.year - year) <= 1;
    first = named.find(near) || (list[0] && near(list[0]) && list[0].startDate?.year === year ? list[0] : null);
    if (first) break;
  }
  if (!first || type === 'movie') return first ? [first] : [];
  const chain = [first];
  const seen = new Set([first.id]);
  const sequel = (edges) => (edges || []).filter((e) => e.relationType === 'SEQUEL' && e.node?.type === 'ANIME' && !seen.has(e.node.id))
    .map((e) => e.node).sort((a, b) => (a.startDate?.year || 9999) - (b.startDate?.year || 9999))[0] || null;
  const take = (m) => {
    seen.add(m.id);
    if (TV_FORMATS.includes(m.format) && !['NOT_YET_RELEASED', 'CANCELLED'].includes(m.status)) chain.push(m);
  };
  let at = first;
  for (let hop = 0; hop < 8 && at; hop++) {
    const next = sequel((await anilist(SEQUELS, { id: at.id }))?.Media?.relations?.edges);
    if (!next) break;
    take(next);
    const after = sequel(next.relations?.edges);
    if (!after) break;
    take(after);
    at = after;
  }
  return chain.map(({ relations, ...m }) => m);
}

// TMDB's seasons as ranges of one absolute count: [{ n, count, start, first, year }] (specials left
// out). first: TMDB's number for the season's first episode, 1 unless TMDB counts on across seasons
// (One Piece: season 21 is episodes 892-1088); year: when the season began.
function tmdbSeasons(d) {
  let start = 1;
  return (d.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0)
    .sort((a, b) => a.season_number - b.season_number)
    .map((s) => {
      const out = { n: s.season_number, count: s.episode_count, start, first: 1, year: Number(String(s.air_date || '').slice(0, 4)) || null };
      start += s.episode_count;
      return out;
    });
}
// TMDB's episode number <-> the absolute count, within season s.
const tmdbEpisode = (s, abs) => abs - s.start + (s.first || 1);
const absoluteOf = (s, episode) => s.start + episode - (s.first || 1);

// Places AniList's seasons on TMDB's absolute count. A season that fits in what's left of a TMDB
// season goes there; one that spans several whole TMDB seasons (One Piece) starts at the first; a
// TMDB season no AniList season fits (Demon Slayer's Mugen Train arc) is skipped.
export function alignEntries(seasons, entries) {
  let i = 0, used = 0;
  const total = seasons.reduce((n, s) => n + s.count, 0);
  for (const e of entries) {
    for (;;) {
      if (i >= seasons.length) { e.from = total + 1; break; }
      const left = seasons[i].count - used;
      if (e.episodes == null) { e.from = seasons[i].start + used; i = seasons.length; break; }
      if (e.episodes <= left) {
        e.from = seasons[i].start + used;
        used += e.episodes;
        if (used >= seasons[i].count) { i++; used = 0; }
        break;
      }
      if (used === 0) {
        let sum = 0, k = i;
        while (k < seasons.length && sum < e.episodes) sum += seasons[k++].count;
        if (sum === e.episodes || k === seasons.length) { e.from = seasons[i].start; i = k; used = 0; if (sum > e.episodes) { i = k - 1; used = seasons[i].count - (sum - e.episodes); } break; }
        i++; // a TMDB season this chain doesn't have
        continue;
      }
      e.from = seasons[i].start + used; // out of step: carry on counting
      let rest = e.episodes - left;
      i++; used = 0;
      while (i < seasons.length && rest >= seasons[i].count) { rest -= seasons[i].count; i++; }
      used = rest;
      break;
    }
  }
  return entries;
}

// The context of a TMDB title, built once and cached. tmdb: the server's TMDB client. Never throws:
// without AniList it still knows TMDB's names and seasons.
export async function buildContext(type, id, tmdb, { details = null } = {}) {
  const ck = `${type}:${id}`;
  const have = contexts[ck];
  if (have && Date.now() - have.at < have.ttl) return have;
  if (building.has(ck)) return building.get(ck);
  const p = (async () => {
    const d = details?.seasons || type === 'movie' ? details : null;
    const full = d || await tmdb(`/${type}/${id}`);
    let alts = [], romaji = [];
    try {
      const raw = await tmdb(`/${type}/${id}/alternative_titles`);
      const list = raw.results || raw.titles || []; // shows: results, films: titles
      alts = list.map((x) => x.title).filter(Boolean);
      // Romanised Japanese: what fansub releases (and AniList) call it.
      romaji = list.filter((x) => x.title && LATIN.test(x.title) && (/roma/i.test(x.type || '') || x.iso_3166_1 === 'JP')).map((x) => x.title);
    } catch { /* optional */ }
    const name = type === 'tv' ? full.name : full.title;
    const original = type === 'tv' ? full.original_name : full.original_title;
    const date = type === 'tv' ? full.first_air_date : full.release_date;
    const year = date ? Number(date.slice(0, 4)) : null;
    const baseTitles = [name, original, ...alts].filter((t) => t && LATIN.test(t));
    let chain = [], anilistOk = true;
    try { chain = await anilistChain([...new Set([...romaji, name, original].filter((t) => t && LATIN.test(t)))], year, keysOf(baseTitles), type); }
    catch { anilistOk = false; }
    const seasons = type === 'tv' ? tmdbSeasons(full) : [];
    // Does TMDB number on across seasons? Its last season's first episode tells (one request).
    const last = seasons.at(-1);
    if (last && last.start > 1) {
      try {
        const sd = await tmdb(`/tv/${id}/season/${last.n}`);
        const firstNo = Math.min(...(sd.episodes || []).map((e) => e.episode_number).filter((x) => Number.isInteger(x) && x > 0));
        if (firstNo === last.start) seasons.forEach((x) => { x.first = x.start; });
      } catch { /* optional: numbered per season */ }
    }
    const firstTitles = chain[0] ? titlesOf(chain[0]) : [];
    let keys = keysOf([...baseTitles, ...firstTitles]);
    const entries = type === 'tv' ? alignEntries(seasons, chain.map((m) => ({
      id: m.id, titles: titlesOf(m).filter((t) => LATIN.test(t)), keys: keysOf(titlesOf(m)), episodes: m.status === 'RELEASING' ? null : m.episodes ?? null,
    }))) : [];
    // A later season's own name ("Kimetsu no Yaiba: Hashira Geiko-hen") is that season's, even when
    // TMDB lists it among the show's names; names shared with the first season are the show's.
    const first = new Set(keysOf(firstTitles));
    entries.forEach((e, i) => { if (i > 0) e.keys = e.keys.filter((k) => !first.has(k) && !keysOf([name]).includes(k)); });
    const later = new Set(entries.slice(1).flatMap((e) => e.keys));
    keys = keys.filter((k) => !later.has(k));
    // Query names: the romanised name first (what anime releases use), then TMDB's.
    const queryTitles = [...new Map((chain[0] ? [chain[0].title?.romaji, chain[0].title?.english, name] : [romaji[0], name, original])
      .filter((t) => t && LATIN.test(t)).map((t) => [showKey(t), t])).values()].slice(0, 3);
    const airing = full.status === 'Returning Series' || full.in_production || chain.some((m) => m.status === 'RELEASING');
    const ctx = {
      v: VERSION, type, id, at: Date.now(), ttl: !anilistOk ? DAY / 4 : airing ? 2 * DAY : 30 * DAY,
      title: name, year, keys, queryTitles, seasons, entries,
    };
    contexts[ck] = ctx;
    reindex();
    save();
    return ctx;
  })().finally(() => building.delete(ck));
  building.set(ck, p);
  return p;
}

// ---------- resolving names to TMDB numbering ----------
// Which part of the show a release title names: { entry } (an AniList season after the first), {}
// (the show itself), or null (another show). A missing title (file "05.mkv" in the show's folder)
// counts as the show.
function whichPart(parsed, ctx) {
  const keys = [parsed.title, parsed.alt].filter((t) => t != null).flatMap((t) => [showKey(t), showKey(t.replace(/\s*×\s*/g, ' x '))]);
  if (!keys.length || !keys[0]) return {};
  for (const k of keys) {
    if (!k) continue;
    if (ctx.keys.includes(k)) return {};
    const entry = ctx.entries.findIndex((e, i) => i > 0 && e.keys.includes(k));
    if (entry > 0) return { entry };
  }
  return null;
}

// Absolute episode -> { season, episode } on TMDB. Past the last known episode: the last season.
export function fromAbsolute(ctx, abs) {
  if (!Number.isInteger(abs) || abs < 1) return null;
  const s = ctx.seasons.find((x) => abs >= x.start && abs < x.start + x.count) || null;
  if (s) return { season: s.n, episode: tmdbEpisode(s, abs) };
  const last = ctx.seasons.at(-1);
  if (last && abs >= last.start + last.count && abs < last.start + last.count + 60) return { season: last.n, episode: tmdbEpisode(last, abs) };
  if (!ctx.seasons.length) return { season: 1, episode: abs };
  return null;
}
const seasonRange = (ctx, n) => ctx.seasons.find((s) => s.n === n) || null;
// A season the release names (its own counting): TMDB's season n when TMDB has it, else the n-th
// AniList season (Frieren "S2" = TMDB season 1 from episode 29).
// A whole-season batch ("Season 1") holds the Japanese season: when TMDB's season n starts with an
// AniList season that's shorter (Frieren: 28 of TMDB's 38), that many.
function namedSeason(ctx, n, { whole = false } = {}) {
  const t = seasonRange(ctx, n);
  const own = whole && t && ctx.entries.find((e) => e.from === t.start && e.episodes > 0);
  if (t) return { start: t.start, count: own ? Math.min(t.count, own.episodes) : t.count };
  const e = ctx.entries[n - 1];
  if (e && e.from) return { start: e.from, count: e.episodes ?? 999 };
  return null;
}

// Every TMDB { season, episode } a release name covers, or null when it's another show or can't be
// placed. parsed: parseAnimeName() result. Without a context: the season named (or 1), as written.
export function resolve(parsed, ctx) {
  if (!parsed || parsed.special || parsed.movie) return null;
  if (!ctx) {
    if (!parsed.episodes) return null;
    const season = parsed.seasons?.length === 1 ? parsed.seasons[0] : parsed.seasons ? null : 1;
    return season == null ? null : parsed.episodes.map((episode) => ({ season, episode }));
  }
  const part = whichPart(parsed, ctx);
  if (!part) return null;
  const out = [];
  const add = (abs) => { const x = fromAbsolute(ctx, abs); if (x) out.push(x); };
  if (parsed.episodes) {
    if (parsed.seasons?.length === 1) {
      const n = parsed.seasons[0];
      const t = seasonRange(ctx, n);
      const named = namedSeason(ctx, n);
      for (const e of parsed.episodes) {
        const first = t?.first || 1;
        if (t && e >= first && e < first + t.count) out.push({ season: n, episode: e }); // TMDB's own number
        else if (t && e <= t.count) add(t.start + e - 1); // counted within the season
        else if (!t && named && e <= named.count) add(named.start + e - 1);
        else add(e); // numbered from the first episode after all
      }
    } else if (parsed.seasons) return null;
    else if (part.entry) {
      const e = ctx.entries[part.entry];
      for (const x of parsed.episodes) add(x <= (e.episodes ?? Infinity) ? e.from + x - 1 : x);
    } else parsed.episodes.forEach(add);
  } else if (parsed.seasons) {
    for (const n of parsed.seasons) {
      const named = namedSeason(ctx, n, { whole: true });
      if (!named) continue;
      const count = Math.min(named.count, ctx.seasons.reduce((a, s) => a + s.count, 0) - named.start + 1);
      for (let i = 0; i < count; i++) add(named.start + i);
    }
  } else if (part.entry) {
    const e = ctx.entries[part.entry];
    const next = ctx.entries[part.entry + 1]?.from;
    const count = e.episodes ?? (next ? next - e.from : 0);
    for (let i = 0; i < count; i++) add(e.from + i);
  } else if (parsed.batch && ctx.seasons.length === 1) {
    for (let i = 0; i < ctx.seasons[0].count; i++) add(1 + i);
  }
  if (!out.length) return null;
  // A year in the name must be the show's or the season's: "One Piece (2023) Season 1" is the
  // live-action series, not the 1999 anime.
  if (parsed.year && ctx.year) {
    const years = new Set([ctx.year, ...out.map((x) => seasonRange(ctx, x.season)?.year).filter(Boolean)]);
    if (![...years].some((y) => Math.abs(y - parsed.year) <= 1)) return null;
  }
  return out;
}

// Episodes of TMDB season `season` a name covers (season.js episodesIn for anime).
export function episodesInSeason(name, season, ctx, { file = true } = {}) {
  const parsed = parseAnimeName(name, { file });
  const list = resolve(parsed, ctx) || [];
  return [...new Set(list.filter((x) => x.season === season).map((x) => x.episode))].sort((a, b) => a - b);
}

// A library file's TMDB season and episode, when its name is anime style and its show is known.
export function placeFile(parsed, name) {
  const ctx = contextForTitle(parsed.title);
  if (!ctx) return null;
  const list = resolve(parseAnimeName(name, { file: true }), ctx);
  if (!list?.length) return null;
  return { title: ctx.title, year: ctx.year, season: list[0].season, episode: list[0].episode };
}

// ---------- searching ----------
// Search queries for a TMDB season (packs) or one episode of it.
export function packQueries(ctx, season) {
  const range = seasonRange(ctx, season);
  const own = range ? ctx.entries.filter((e, i) => i > 0 && e.from >= range.start && e.from < range.start + range.count) : [];
  const titles = [...ctx.queryTitles, ...own.flatMap((e) => e.titles.slice(0, 1))];
  const qs = [];
  for (const t of titles) qs.push(`${t} batch`, t);
  if (range) qs.push(`${ctx.queryTitles[0] || ctx.title} S${pad(season)}`);
  return [...new Set(qs)];
}
export function episodeQueriesAnime(ctx, season, episode) {
  const range = seasonRange(ctx, season);
  const abs = range ? absoluteOf(range, episode) : episode;
  const idx = ctx.entries.reduce((best, e, i) => (e.from && e.from <= abs ? i : best), -1);
  const entry = idx >= 0 ? ctx.entries[idx] : null;
  const rel = entry ? abs - entry.from + 1 : episode;
  const main = ctx.queryTitles[0] || ctx.title;
  const qs = [`${main} ${pad(abs)}`];
  if (rel !== abs) qs.push(`${main} ${pad(rel)}`);
  if (idx > 0) { qs.push(`${main} S${idx + 1} ${pad(rel)}`); if (entry.titles[0]) qs.push(`${entry.titles[0]} ${pad(rel)}`); }
  for (const t of ctx.queryTitles.slice(1)) qs.push(`${t} ${pad(abs)}`);
  qs.push(`${main} S${pad(season)}E${pad(episode)}`);
  return [...new Set(qs)];
}

// Releases that are packs for TMDB season `season`: each one gets `covers` (episodes of the season
// it has), `packEpisodes` (all episodes it has, for size per episode) and `extra` (episodes outside
// the season). Sets of several seasons only when their numbering can be trusted to be TMDB's.
export function seasonPacks(results, ctx, season, aired = null) {
  const range = seasonRange(ctx, season);
  const out = [];
  for (const r of results) {
    const parsed = parseAnimeName(r.name);
    if (!parsed || (!parsed.batch && !(parsed.episodes?.length > 1))) continue;
    if (parsed.seasons?.length > 1 && Math.max(...parsed.seasons) > ctx.seasons.length) continue;
    if (!parsed.episodes && !parsed.seasons && ctx.seasons.length !== 1 && !whichPart(parsed, ctx)?.entry) continue;
    const list = resolve(parsed, ctx);
    if (!list) continue;
    const mine = list.filter((x) => x.season === season && (!aired || aired.includes(x.episode)));
    if (!mine.length) continue;
    out.push({ ...r, covers: mine.length, packEpisodes: list.length, extra: list.length - mine.length, coveredEpisodes: mine.map((x) => x.episode) });
  }
  void range;
  return out;
}

// Release groups whose anime encodes are reliably watchable, a small nudge in ranking.
export const GOOD_GROUPS = new Set(['subsplease', 'erai-raws', 'judas', 'ember', 'asw', 'toonshub', 'varyg', 'kametsu',
  'sokudo', 'yurasuka', 'anime time', 'dkb', 'tenrai-sensei', 'crucible', 'mtbb', 'beatrice-raws', 'vodes']);
export const animeGroup = (name) => (/^\s*\[([^\]]{1,40})\]/.exec(String(name || ''))?.[1] || '').trim().toLowerCase();
