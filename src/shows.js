// Shows: the library's episodes grouped into one entry per show, split into seasons, with TMDB's
// poster for each season (South Park season 18 gets the season 18 poster) and episode names.
//
// Episodes of one show often come from different releases with different names:
//   "The.Last.of.Us.S01E04.Please.Hold.on.to.My.Hand.1080p.HMAX.WEB-DL...-SMURF"
//   "the.last.of.us.s01e05.1080p.web.h264-cakes"
//   "South Park (1997) - S18E01 - Go Fund Yourself (1080p BluRay x265 RCVR)"
// They're merged in two steps: names are compared loosely (case, punctuation and a leading "The"
// don't count), and each distinct name is looked up on TMDB once, so spellings that TMDB resolves
// to the same show end up together too. Without TMDB (no key, offline) the loose name alone groups.
//
// Lookups are cached in .lilin-shows.json: a found show for 30 days (its seasons and posters are
// refreshed weekly, so new seasons appear), a name TMDB didn't know for a day.
import fs from 'node:fs';
import path from 'node:path';

const IMG = 'https://image.tmdb.org/t/p/';
const DAY = 24 * 3600 * 1000;
const NAME_TTL = 30 * DAY;
const MISS_TTL = DAY;
const DETAILS_TTL = 7 * DAY;

let file = null;
let cache = { names: {}, shows: {}, films: {}, filmFiles: {}, filmDownloads: {}, showDownloads: {}, genres: {} };
const pending = new Map();             // in-flight lookups, so a name is never looked up twice at once
let saveTimer = null;

export function initShows({ dataDir }) {
  file = path.join(dataDir, '.lilin-shows.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { localArt: saved.localArt || {}, overviews: saved.overviews || {}, names: saved.names || {}, shows: saved.shows || {}, films: saved.films || {}, filmFiles: saved.filmFiles || {}, filmDownloads: saved.filmDownloads || {}, showDownloads: saved.showDownloads || {}, genres: saved.genres || {} };
  } catch { /* first run */ }
}

function save() {
  if (!file) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.promises.writeFile(file, JSON.stringify(cache)).catch(() => {});
  }, 1000);
}

const img = (size, p) => (p ? `${IMG}${size}${p}` : null);

// "The Last of Us", "the last of us", "Last of Us, The", "The Last Of Us!" -> "lastofus"
export function showKey(title) {
  let s = String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').trim();
  s = s.replace(/,\s*the$/, '').replace(/^the\s+/, '');
  return s.replace(/[^a-z0-9]+/g, '');
}

// Of the spellings found in file names, the one that reads best: mixed case beats all lower case.
function bestTitle(titles) {
  const score = (t) => (/[A-Z]/.test(t) ? 2 : 0) + (/[a-z]/.test(t) ? 1 : 0);
  return [...titles].sort((a, b) => score(b) - score(a) || b.length - a.length)[0] || '';
}

function once(key, fn) {
  if (pending.has(key)) return pending.get(key);
  const p = fn().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

// TMDB id for a show name (+ year from the file name, when there is one), or null.
function lookupName(key, title, year, tmdb) {
  const ck = `${key}|${year || ''}`;
  const hit = cache.names[ck];
  if (hit && (hit.pinned || Date.now() - hit.at < (hit.id ? NAME_TTL : MISS_TTL))) return Promise.resolve(hit.id);
  return once(`name:${ck}`, async () => {
    let results = [];
    if (year) results = (await tmdb('/search/tv', { query: title, first_air_date_year: String(year) })).results || [];
    if (!results.length) results = (await tmdb('/search/tv', { query: title })).results || [];
    // An exact (loose) name match wins; otherwise TMDB's first, most relevant result.
    const exact = results.filter((r) => showKey(r.name) === key || showKey(r.original_name) === key);
    const pick = (year && exact.find((r) => (r.first_air_date || '').startsWith(String(year)))) || exact[0] || results[0];
    cache.names[ck] = { id: pick?.id ?? null, at: Date.now() };
    save();
    return pick?.id ?? null;
  });
}

// Show details + the seasons on the server with their episode names (one TMDB request per season).
function loadDetails(id, seasons, tmdb) {
  const have = cache.shows[id];
  const fresh = have && Date.now() - have.at < DETAILS_TTL && have.anime !== undefined; // anime: added later
  const missing = seasons.filter((n) => !have?.episodes?.[n]);
  if (fresh && !missing.length) return Promise.resolve(have);
  return once(`tv:${id}:${fresh ? missing.join(',') : 'all'}`, async () => {
    let s = cache.shows[id];
    if (!fresh) {
      const d = await tmdb(`/tv/${id}`);
      rememberGenres('tv', id, d);
      s = {
        at: Date.now(),
        id,
        title: d.name,
        year: d.first_air_date ? Number(d.first_air_date.slice(0, 4)) : null,
        overview: d.overview || '',
        rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
        poster: img('w342', d.poster_path),
        backdrop: img('w780', d.backdrop_path),
        // Japanese animation (same test as anime.js isAnimeDetails): its files get anime numbering.
        anime: (d.genres || []).some((g) => g.id === 16) && (d.original_language === 'ja' || (d.origin_country || []).includes('JP')),
        seasons: Object.fromEntries((d.seasons || []).map((x) => [x.season_number, {
          name: x.name || null, poster: img('w342', x.poster_path), total: x.episode_count || null,
        }])),
        episodes: {},
      };
    }
    for (const n of fresh ? missing : seasons) {
      try {
        const d = await tmdb(`/tv/${id}/season/${n}`);
        s.episodes[n] = Object.fromEntries((d.episodes || []).map((e) => [e.episode_number, {
          name: e.name || null, still: img('w300', e.still_path),
        }]));
      } catch { s.episodes[n] = s.episodes[n] || {}; }
    }
    cache.shows[id] = s;
    save();
    return s;
  });
}

// ---------- genres ----------
// TMDB genre IDs per title ("movie:603" -> [28, 878]), for sorting the library by genre. Taken from any
// TMDB answer that carries them (search results: genre_ids, details: genres); older cache entries are
// filled in the background, a few per library request.
function rememberGenres(type, id, d) {
  const ids = Array.isArray(d?.genre_ids) ? d.genre_ids : Array.isArray(d?.genres) ? d.genres.map((g) => g?.id) : null;
  if (!id || !ids) return;
  cache.genres[`${type}:${id}`] = ids.filter((g) => Number.isInteger(g));
  save();
}
// Descriptions in other languages than the shared cache's, a batch at a time ('' = TMDB has none).
const OVERVIEW_BATCH = 12;
export const localOverview = (lang, type, id) => (id ? cache.overviews?.[lang]?.[`${type}:${id}`] || null : null);
export function backfillOverviews(lang, type, ids, fetchOverview) {
  cache.overviews ||= {};
  const known = (cache.overviews[lang] ||= {});
  const missing = [...new Set(ids.filter((id) => id && known[`${type}:${id}`] === undefined))].slice(0, OVERVIEW_BATCH);
  return Promise.allSettled(missing.map((id) => once(`overview:${lang}:${type}:${id}`, async () => {
    try { known[`${type}:${id}`] = await fetchOverview(type, id); save(); }
    catch (error) { if (/\b404\b/.test(error?.message || '') || error?.status === 404) { known[`${type}:${id}`] = ''; save(); } }
  })));
}

export const genresOf = (type, id) => (id ? cache.genres[`${type}:${id}`] || null : null);
const GENRE_BATCH = 12;
function backfillGenres(type, ids, tmdb) {
  const missing = [...new Set(ids.filter((id) => id && !cache.genres[`${type}:${id}`]))].slice(0, GENRE_BATCH);
  return Promise.allSettled(missing.map((id) => once(`genres:${type}:${id}`, async () => {
    try {
      rememberGenres(type, id, await tmdb(`/${type}/${id}`));
    } catch (error) {
      // A title TMDB no longer has gets no genres instead of being asked for again on every load.
      if (/\b404\b/.test(error?.message || '') || error?.status === 404) rememberGenres(type, id, { genres: [] });
      throw error;
    }
  })));
}

// items: library items with { id, title, year, season, episode, added }.
// Returns { shows, showOf } where showOf maps item id -> { show, episodeName }. Waits at most `wait`
// ms for TMDB: whatever isn't resolved yet is grouped by name now and merged on a later call.
// Titles that came from another source (SVT Play) say what they are themselves. TMDB's search would
// otherwise label an unknown name with its closest guess, so the name is pinned: to the show with exactly
// that name, or to none. `art` (title, overview, poster, backdrop, genres, episodes, seasonNames) fills in what
// TMDB doesn't have, and its episode names win: SVT's numbering of dated seasons isn't TMDB's.
export function pinShow(title, id, art = null) {
  const key = showKey(title);
  if (!key) return;
  cache.names[`${key}|`] = { id: id ?? null, at: Date.now(), pinned: true };
  if (art) (cache.localArt ??= {})[`tv:${key}`] = { ...cache.localArt?.[`tv:${key}`], ...art };
  save();
}
export function pinFilmArt(title, art) {
  const key = showKey(title);
  if (!key) return;
  (cache.localArt ??= {})[`movie:${key}`] = art;
  save();
}
const localArt = (type, title) => cache.localArt?.[`${type}:${showKey(title)}`] || null;

export async function groupShows(items, tmdb, { wait = 2500 } = {}) {
  const episodes = items.filter((i) => i.season != null && i.title);
  const byName = new Map(); // "key|year" -> { key, year, titles:Set, items:[] }
  for (const it of episodes) {
    const key = showKey(it.title);
    if (!key) continue;
    const ck = `${key}|${it.year || ''}`;
    if (!byName.has(ck)) byName.set(ck, { key, year: it.year || null, titles: new Set(), items: [] });
    const g = byName.get(ck);
    g.titles.add(it.title);
    g.items.push(it);
  }

  // A name with a year ("South Park (1997)") and the same name without one are the same show
  // unless TMDB says otherwise: until it answers, the yearless files join the dated group.
  const work = [];
  if (tmdb) {
    for (const g of byName.values()) {
      const seasons = [...new Set(g.items.map((i) => i.season))];
      work.push(lookupName(g.key, bestTitle(g.titles), g.year, tmdb)
        .then((id) => id && loadDetails(id, seasons, tmdb))
        .catch(() => null));
    }
  }
  // Genres for shows looked up before genres were cached.
  if (tmdb) work.push(backfillGenres('tv', [...byName.values()].map((g) => cache.names[`${g.key}|${g.year || ''}`]?.id), tmdb));
  if (work.length) {
    await Promise.race([Promise.allSettled(work), new Promise((r) => setTimeout(r, wait))]);
  }

  const groups = new Map(); // show id -> { id, tmdb, titles:Set, years:Set, items:[] }
  const looseYear = new Map(); // key -> dated group id, for yearless names
  for (const g of byName.values()) {
    const tmdbId = cache.names[`${g.key}|${g.year || ''}`]?.id || null;
    let id = tmdbId ? `tv-${tmdbId}` : `name-${g.key}${g.year ? `-${g.year}` : ''}`;
    if (!tmdbId && !g.year && looseYear.has(g.key)) id = looseYear.get(g.key);
    if (!groups.has(id)) groups.set(id, { id, tmdbId, titles: new Set(), years: new Set(), items: [] });
    const grp = groups.get(id);
    g.titles.forEach((t) => grp.titles.add(t));
    if (g.year) { grp.years.add(g.year); if (!looseYear.has(g.key)) looseYear.set(g.key, id); }
    grp.items.push(...g.items);
  }
  // Second pass: yearless groups that were created before their dated twin was seen.
  for (const [id, grp] of groups) {
    if (grp.tmdbId || grp.years.size) continue;
    const key = showKey(bestTitle(grp.titles));
    const twin = looseYear.get(key);
    if (twin && twin !== id && groups.has(twin)) {
      const t = groups.get(twin);
      grp.titles.forEach((x) => t.titles.add(x));
      t.items.push(...grp.items);
      groups.delete(id);
    }
  }

  const shows = [];
  const showOf = new Map();
  for (const grp of groups.values()) {
    const d = grp.tmdbId ? cache.shows[grp.tmdbId] : null;
    const art = localArt('tv', bestTitle(grp.titles));
    const seasonNums = [...new Set(grp.items.map((i) => i.season))].sort((a, b) => a - b);
    const seasons = seasonNums.map((n) => {
      const sd = d?.seasons?.[n];
      const eps = grp.items.filter((i) => i.season === n);
      return {
        number: n,
        name: art?.seasonNames?.[n] || sd?.name || (n === 0 ? 'Specials' : `Season ${n}`),
        poster: sd?.poster || d?.poster || art?.poster || null,
        total: sd?.total || null,                               // episodes in the season on TMDB
        // TMDB's first episode number: 1, or where numbering carries on from the season before (One Piece)
        first: firstEpisode(d?.episodes?.[n]),
        count: new Set(eps.map((i) => i.episode)).size,          // episodes on the server
        // Every TMDB episode's name and still, so rows for episodes not on the server get them too.
        episodes: { ...d?.episodes?.[n], ...art?.episodes?.[n] },
      };
    });
    for (const it of grp.items) {
      const ep = art?.episodes?.[it.season]?.[it.episode] || d?.episodes?.[it.season]?.[it.episode];
      showOf.set(it.id, { show: grp.id, episodeName: ep?.name || null, still: ep?.still || null });
    }
    shows.push({
      id: grp.id,
      tmdbId: grp.tmdbId,
      title: d?.title || art?.title || bestTitle(grp.titles),
      year: d?.year || art?.year || [...grp.years][0] || null,
      overview: d?.overview || art?.overview || '',
      rating: d?.rating || null,
      genres: genresOf('tv', grp.tmdbId) || art?.genres || null,
      anime: Boolean(d?.anime),
      poster: d?.poster || art?.poster || null,
      backdrop: d?.backdrop || art?.backdrop || null,
      seasons,
      episodes: grp.items.length,
      added: Math.max(...grp.items.map((i) => i.added || 0)),
    });
  }
  return { shows, showOf };
}

// A season's episodes from TMDB for downloading it episode by episode: [{ episode, name, aired }]
// (aired false for episodes with a future or unknown air date). null when TMDB doesn't know the show.
// The lowest episode number TMDB gives a season (1 unless it numbers on across seasons).
function firstEpisode(episodes) {
  const numbers = Object.keys(episodes || {}).map(Number).filter((x) => x > 0);
  return numbers.length ? Math.min(...numbers) : 1;
}

// Whether a season from TMDB's show details hasn't started yet. TMDB often leaves a season's own date
// empty even when all its episodes have dates (One Piece's seasons 2-17, 22 and 23), so an empty date
// only means "not out" past the last aired episode's season and the last season dated in the past.
export function seasonUpcoming(details, season, today = new Date().toISOString().slice(0, 10)) {
  if (season.air_date) return season.air_date > today;
  if (!season.episode_count) return true;
  const reached = Math.max(details?.last_episode_to_air?.season_number || 0,
    ...(details?.seasons || []).filter((x) => x.air_date && x.air_date <= today).map((x) => x.season_number));
  return season.season_number > reached;
}

export async function seasonEpisodes(title, year, season, tmdb) {
  const key = showKey(title);
  if (!key || !tmdb) return null;
  const id = await lookupName(key, title, year, tmdb);
  if (!id) return null;
  let d;
  try { d = await tmdb(`/tv/${id}/season/${season}`); } catch (error) {
    if (error.status === 404) return { id, title, episodes: [] };
    throw error; // A temporary catalogue outage must not masquerade as an empty season.
  }
  const today = new Date().toISOString().slice(0, 10);
  const show = cache.shows[id];
  return {
    id,
    title: show?.title || title,
    episodes: (d.episodes || []).map((e) => ({
      episode: e.episode_number,
      name: e.name || null,
      aired: Boolean(e.air_date) && e.air_date <= today,
    })),
  };
}

// ---------- films ----------
const FILM_IDENTITY_VERSION = 2; // Older title/year matches may have silently picked a different film.
const filmDetails = (pick) => ({
  id: pick.id, title: pick.title, year: pick.release_date ? Number(pick.release_date.slice(0, 4)) : null,
  releaseDate: pick.release_date || null, overview: pick.overview || '',
  rating: pick.vote_average ? Math.round(pick.vote_average * 10) / 10 : null,
  poster: img('w342', pick.poster_path), backdrop: img('w780', pick.backdrop_path),
});

// An explicit choice belongs to the file, not every film with the same title and year.
export function identifyFilm(key, details) {
  if (!key || !details?.id) return;
  rememberGenres('movie', details.id, details);
  cache.filmFiles[key] = { ...filmDetails(details), explicit: true };
  save();
}
export function rememberFilmDownload(hash, details) {
  if (!hash || !details?.id) return;
  cache.filmDownloads[hash.toLowerCase()] = details;
  save();
}
export const filmDownload = (hash) => cache.filmDownloads[String(hash).toLowerCase()] || null;
export function rememberShowDownload(hash, details, release = {}) {
  if (!hash || !details?.id) return;
  cache.showDownloads[String(hash).toLowerCase()] = details;
  const title = release.title || details.name;
  cache.names[`${showKey(title)}|${release.year || ''}`] = { id: details.id, at: Date.now() };
  if (!cache.shows[details.id]) {
    cache.shows[details.id] = {
      at: 0, id: details.id, title: details.name,
      year: details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : null,
      overview: details.overview || '', poster: img('w342', details.poster_path), backdrop: img('w780', details.backdrop_path),
      seasons: {}, episodes: {},
    };
  }
  save();
}
export const showDownload = (hash) => cache.showDownloads[String(hash).toLowerCase()] || null;

// A show's cached details by name, without asking TMDB (link previews must answer fast).
export function knownShow(title, year) {
  const key = showKey(title);
  const id = cache.names[`${key}|${year || ''}`]?.id ?? cache.names[`${key}|`]?.id;
  return id ? cache.shows[id] || null : null;
}
// One episode's TMDB name and still from the cache (link previews), or null.
export function knownEpisode(title, year, season, episode) {
  return knownShow(title, year)?.episodes?.[season]?.[episode] || null;
}
export function knownFilm(key, title, year) {
  const explicit = cache.filmFiles[key];
  if (explicit) return explicit;
  const hit = cache.films[`${showKey(title)}|${year || ''}`];
  return hit?.identityVersion === FILM_IDENTITY_VERSION ? hit : null;
}

// A film's TMDB poster, backdrop and overview, for the library's poster cards and film page. Looked
// up by the name and year in the file name and cached like shows (found: 30 days, unknown: a day).
function lookupFilm(title, year, tmdb) {
  const key = showKey(title);
  const ck = `${key}|${year || ''}`;
  const hit = cache.films[ck];
  if (hit?.identityVersion === FILM_IDENTITY_VERSION && Date.now() - hit.at < (hit.id || hit.ambiguous ? NAME_TTL : MISS_TTL)) return Promise.resolve(hit);
  return once(`film:${ck}`, async () => {
    let results = [];
    if (year) results = (await tmdb('/search/movie', { query: title, year: String(year) })).results || [];
    if (!results.length) results = (await tmdb('/search/movie', { query: title })).results || [];
    // Require a matching name and year; loose guesses can label a different film as available.
    const sameYear = (r) => year && (r.release_date || '').startsWith(String(year));
    const exact = results.filter((r) => showKey(r.title) === key || showKey(r.original_title) === key);
    const dated = exact.filter(sameYear);
    const possible = year ? dated : exact;
    // Popularity isn't identity. Ask for a choice if two films share this title/year.
    const ambiguous = possible.length > 1;
    const pick = !ambiguous && possible[0];
    for (const r of possible) rememberGenres('movie', r.id, r);
    cache.films[ck] = { at: Date.now(), identityVersion: FILM_IDENTITY_VERSION, id: null,
      ...(pick ? filmDetails(pick) : {}), ambiguous,
      candidates: ambiguous ? possible.map(filmDetails) : [],
    };
    save();
    return cache.films[ck];
  });
}

// items: library items (with mediaKey when available). Returns a Map of item id -> artwork/identity for
// the films TMDB knows. Waits at most `wait` ms; films not looked up yet get their poster next time.
export async function filmInfo(items, tmdb, { wait = 2500 } = {}) {
  const films = items.filter((i) => i.season == null && i.title);
  if (tmdb && films.length) {
    const work = films.filter((f) => !cache.filmFiles[f.mediaKey]).map((f) => lookupFilm(f.title, f.year, tmdb).catch(() => null));
    work.push(backfillGenres('movie', films.map((f) => knownFilm(f.mediaKey, f.title, f.year)?.id), tmdb));
    await Promise.race([Promise.allSettled(work), new Promise((r) => setTimeout(r, wait))]);
  }
  const out = new Map();
  for (const f of films) {
    const hit = knownFilm(f.mediaKey, f.title, f.year);
    const art = hit?.id ? null : localArt('movie', f.title);
    if (art) {
      out.set(f.id, { tmdbId: null, filmTitle: art.title, poster: art.poster, backdrop: art.backdrop, overview: art.overview, rating: null,
        genres: art.genres || null, movieAmbiguous: false, filmCandidates: [] });
    } else if (hit?.id || hit?.ambiguous) out.set(f.id, {
      tmdbId: hit.id, filmTitle: hit.title, poster: hit.poster, backdrop: hit.backdrop, overview: hit.overview, rating: hit.rating,
      genres: genresOf('movie', hit.id),
      movieAmbiguous: Boolean(hit.ambiguous), filmCandidates: hit.candidates || [],
    });
  }
  return out;
}
