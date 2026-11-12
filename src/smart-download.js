// One Download command for films, seasons and single episodes. The person chooses what; this
// chooses how, in a background job the title sheet polls for its state:
//
// Film: already in your library, on the server or downloading? Then nothing new is queued. Else the
// best release (recommend.js) under your profile, size limit and free space, from a title + year
// search (then the original title). No suitable release: a plain reason, never a lesser substitute.
//
// Season: the aired episodes (TMDB) minus what's already here (library, server or queued). Several
// missing: a season pack of exactly that season, added with the episodes you already have switched
// off once its file list arrives, so nothing downloads twice. Episodes the pack turns out not to
// contain, or every missing episode when there's no suitable pack, are found one by one. Episodes
// that can't be found are reported; "Retry unavailable" runs the same command for just those.
//
// Recovery is bounded: a failed search is retried once, a release qBittorrent rejected is not
// picked again for six hours, and an episode never falls back to another show or another season.
//
// Anime (spec.anime: an anime.js context): Nyaa batches like "(01-170)" or "(Season 2) (Batch)" count
// as season packs, several when TMDB lumps seasons together (Frieren's season 1 = two batches), and
// names are matched by every known title and placed on TMDB's numbering ("Black Clover - 176" is
// TMDB's season 2 episode 6). Packs' other seasons are switched off like owned episodes.
//
// Dubbed (spec.dub, anime only): every search asks for dual audio and only dual-audio releases come back
// from it, so packs and single episodes alike are the dub or nothing, never a subtitled substitute.
//
// Another source (deps.alternative: SVT Play, see server.js) takes over where no torrent can: it's asked
// first when spec.preferAlternative says the title is likely to be there, else after the search came up empty.
import crypto from 'node:crypto';
import { showKey } from './shows.js';
import { sameShow, episodesIn, episodeQueries } from './season.js';
import { pickBest, pickEpisode, choose, pictureScore, perItemSize, sourceOf, isDualAudio } from './recommend.js';
import { seasonPacks, packQueries, episodeQueriesAnime } from './anime.js';

const jobs = new Map();          // id -> job
const JOB_TTL = 60 * 60 * 1000;
const MAX_EPISODES = 40;         // without TMDB, episodes are probed until two in a row aren't found
const PACK_FROM = 3;             // fewer missing episodes than this: fetch them one by one
const REJECTED_TTL = 6 * 60 * 60 * 1000;
const rejected = new Map();      // magnet / ref -> when qBittorrent refused it
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const episodeList = (eps) => eps.map((e) => `E${pad(e)}`).join(', ');

export function smartJob(id, { userId, owner = false } = {}) {
  const j = jobs.get(id);
  if (!j) return null;
  if (userId != null && !owner && j.requester !== userId) return null;
  const { requester, target, ...view } = j;
  return view;
}

// spec: { type: 'movie' | 'tv', title, year?, originalTitle?, season?, episodes? (only these), range? (episodes is a
//   chosen range: batches may serve it), anime? (context), upgrade? ({ episodes, bytes, names, quality }: the season
//   as it is now; only a clearly better season pack is downloaded, and deps.upgrading() swaps the old files later),
//   want: { profile, prefer, quality, maxBytes, audioLang }, subs?, requester?, dub? (dual-audio releases only) }
// deps: { parseName, searchTorrents, magnetFor1337x, addDownload, wantSubtitles?, log?, sleep?,
//   filmHave?(), freeBytes?(type), seasonEpisodes?(title, year, season), haveEpisodes?(key, season, ctx),
//   trimPack?(link, season, owned, ctx), removePack?(link), inOrder?(added, season) (episodes in order),
//   upgrading?(added, season) (replace the old episodes as the new ones finish) }
export function startSmartJob(spec, deps) {
  for (const [id, j] of jobs) if (j.state !== 'running' && Date.now() - j.started > JOB_TTL) jobs.delete(id);
  const key = showKey(spec.title);
  const only = Array.isArray(spec.episodes) && spec.episodes.length ? [...new Set(spec.episodes)].sort((a, b) => a - b) : null;
  const target = (spec.type === 'tv' ? `tv:${key === 'housemd' ? 'house' : key}:${spec.season}:${only?.join(',') || 'all'}` : `movie:${key}:${spec.year || ''}`)
    + (spec.upgrade ? ':upgrade' : '') + (spec.dub ? ':dub' : '');
  const running = [...jobs.values()].find((j) => j.state === 'running' && j.requester === (spec.requester ?? null) && j.target === target);
  if (running) return running.id; // pressing Download twice never queues anything twice
  const job = {
    id: crypto.randomBytes(6).toString('hex'), type: spec.type, title: spec.title, season: spec.season ?? null,
    requester: spec.requester ?? null, target, started: Date.now(), state: 'running', step: 'Finding a download…',
    outcome: null, message: null, total: null, have: [], queued: [], added: [], unavailable: [], upcoming: 0, error: null,
    ...(spec.dub ? { dub: true } : {}),
  };
  jobs.set(job.id, job);
  if (spec.dub) deps = dubbedOnly(deps);
  (spec.type === 'tv' ? (spec.upgrade ? runUpgrade : runSeason)(job, { ...spec, only }, deps) : runFilm(job, spec, deps)).catch((e) => {
    job.state = 'failed';
    job.error = e.status === 503 ? 'The download service is unavailable. Try again shortly.' : e.message || String(e);
    job.message = job.error;
    job.step = null;
    deps.log?.(`[smart] ${spec.title}${spec.season != null ? ` S${pad(spec.season)}` : ''}: ${e.message || e}`);
  });
  return job.id;
}

// "dual" finds every spelling on the torrent sites ("Dual-Audio", "Dual Audio", "DUAL"); "DualAudio" as a
// search word finds next to nothing. The names are then checked, because sites match loosely.
function dubbedOnly(deps) {
  return { ...deps, undubbed: deps, searchTorrents: async (query, type) => {
    const found = await deps.searchTorrents(`${query} dual`, type);
    return { ...found, results: (found.results || []).filter((r) => isDualAudio(r.name)) };
  } };
}

const hashOf = (r) => /btih:([a-z0-9]+)/i.exec(r.magnet || '')?.[1]?.toLowerCase() || null;
// A pack whose file list arrived but no file in it could be read (no episode numbers Lilin knows):
// its name already matched the season, so it's kept whole instead of being thrown away.
const unreadable = (trim) => Boolean(trim?.covered && !trim.covered.size && !trim.allOwned);
const usable = (r) => !isFake(r) && (!rejected.has(r.magnet || r.ref) || Date.now() - rejected.get(r.magnet || r.ref) > REJECTED_TTL);

// ---- fake releases (fake-release.js) ----
// A torrent found to hold a program instead of a video is never picked again (by info hash, or by
// its 1337x page when the search result had no magnet). Fakes copy real release names, so a name
// alone never counts. origins: which job added each torrent, so a removed fake can be replaced.
const fakes = new Set();
const origins = new Map();       // info hash -> { spec, deps, ref, at }
const ORIGIN_TTL = 24 * 60 * 60 * 1000;
const hashOfLink = (link) => /btih:([a-z0-9]+)/i.exec(String(link || ''))?.[1]?.toLowerCase() || null;
function isFake(r) {
  const hash = hashOf(r);
  return Boolean((hash && fakes.has(hash)) || (r.ref && fakes.has(`ref:${r.ref}`)));
}
// Remembered fakes from earlier runs (server.js keeps them in a file).
export function loadFakes(list) {
  for (const f of list || []) { if (f.hash) fakes.add(String(f.hash).toLowerCase()); if (f.ref) fakes.add(`ref:${f.ref}`); }
}
// The server removed this torrent as a fake: block it, and run the job that added it again. The new
// job sees every other episode already on its way, so it looks for just what the fake was meant to be.
// Returns { ref, retried } (ref: to remember with the hash), or null when Lilin's search didn't add it.
export function fakeFound(hash) {
  hash = String(hash || '').toLowerCase();
  fakes.add(hash);
  const origin = origins.get(hash);
  origins.delete(hash);
  if (origin?.ref) fakes.add(`ref:${origin.ref}`);
  if (!origin || Date.now() - origin.at > ORIGIN_TTL) return origin ? { ref: origin.ref || null, retried: null } : null;
  const { only, ...spec } = origin.spec;
  return { ref: origin.ref || null, retried: startSmartJob(spec, origin.deps) };
}

// Search sites sort by popularity and cut the list short, so a quiet remux may never show up in a plain
// search. Best Quality also asks for the good stuff by name (under the main title, to keep it quick).
const QUALITY_WORDS = ['2160p', '1080p', 'BluRay', 'REMUX'];
const seasonQueries = (titles, season, profile) => [
  ...titles.flatMap((t) => [`${t} S${pad(season)}`, `${t} Season ${season}`]),
  ...(profile === 'best' ? QUALITY_WORDS.map((w) => `${titles[0]} S${pad(season)} ${w}`) : []),
];

// A search that throws is retried once after a short pause; a 503 (not configured) is final.
async function search(query, type, deps) {
  try { return (await deps.searchTorrents(query, type)).results || []; } catch (e) {
    if (e.status === 503) throw e;
    await (deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(1500);
    return (await deps.searchTorrents(query, type)).results || [];
  }
}

async function add(r, mediaType, spec, deps) {
  const link = r.magnet || await deps.magnetFor1337x(r.ref);
  if (!link) throw new Error('No download link was available.');
  try {
    const result = await deps.addDownload({ link, name: r.name, mediaType });
    const hash = hashOfLink(link);
    if (hash && !result?.existing) {
      origins.set(hash, { spec, deps: deps.undubbed || deps, ref: r.magnet ? null : r.ref || null, at: Date.now() });
      for (const [h, o] of origins) if (Date.now() - o.at > ORIGIN_TTL) origins.delete(h);
    }
    if (spec.subs?.length) deps.wantSubtitles?.(link, spec.subs, r.name);
    return { link, ...(result || {}) };
  } catch (e) {
    rejected.set(r.magnet || r.ref, Date.now());
    throw e;
  }
}

const done = (job, outcome, message) => {
  job.state = 'done'; job.outcome = outcome; job.step = null;
  // "Nothing matched" means no dub here; a size limit or a season that hasn't aired keeps its own reason.
  job.message = job.dub && outcome === 'none' && /clearly matches|Couldn’t find/.test(message)
    ? 'No dubbed (dual-audio) release of this was found, so nothing was added.' : message;
};

// spec.anime may still be on its way (AniList is slow): a promise, waited for here, never fatal.
async function animeOf(job, spec) {
  if (!spec.anime?.then) return spec.anime || null;
  job.step = 'Looking up the anime…';
  spec.anime = await spec.anime.catch(() => null);
  job.step = 'Finding the best copy…';
  return spec.anime;
}

// True when the other source took the whole request. Never fatal: torrents are still there.
async function tryAlternative(job, deps, request) {
  if (!deps.alternative) return null;
  job.step = 'Checking SVT Play…';
  try { return await deps.alternative(request); } catch (e) {
    deps.log?.(`[smart] ${job.title}: the other source failed: ${e.message || e}`);
    return null;
  } finally { job.step = 'Finding the best copy…'; }
}

async function runFilm(job, spec, deps) {
  await animeOf(job, spec);
  const have = await deps.filmHave?.();
  if (have === 'library') return done(job, 'have', 'Already in your library.');
  if (have === 'server') return done(job, 'have', 'It was already on the server, so it’s in your library now.');
  if (have === 'downloading') return done(job, 'queued', 'Already on its way.');
  const fromAlternative = (alt) => {
    job.added.push({ name: alt.name, quality: alt.quality || null, size: null, source: alt.source });
    done(job, 'started', alt.message);
  };
  if (spec.preferAlternative) {
    const alt = await tryAlternative(job, deps, { type: 'movie' });
    if (alt) return fromAlternative(alt);
  }
  const freeBytes = await deps.freeBytes?.('movie');
  const want = { ...spec.want, type: 'movie', title: spec.title, year: spec.year, freeBytes, anime: Boolean(spec.anime), aliases: spec.anime?.keys || [] };
  const names = [spec.title, spec.originalTitle, ...(spec.anime?.queryTitles || [])].filter(Boolean);
  const queries = [...new Set([...names.map((t) => [t, spec.year].filter(Boolean).join(' ')), spec.title, ...(spec.anime?.queryTitles || []),
    ...(want.profile === 'best' ? QUALITY_WORDS.map((w) => [spec.title, spec.year, w].filter(Boolean).join(' ')) : [])])];
  let results = [], best = { pick: null, why: null }, failures = 0;
  for (const query of queries) {
    try { results = [...results, ...await search(query, 'movie', deps)]; } catch (e) { if (e.status === 503) throw e; failures++; continue; }
    best = pickBest(results.filter(usable), want, deps.parseName);
    if (best.pick && want.profile !== 'best') break; // Best Quality: every search before choosing
  }
  if (!best.pick) {
    const alt = spec.preferAlternative ? null : await tryAlternative(job, deps, { type: 'movie' });
    if (alt) return fromAlternative(alt);
    if (failures === queries.length) throw new Error('The torrent sites aren’t answering. Try again shortly.');
    return done(job, 'none', best.why || 'Couldn’t find a good copy of this yet.');
  }
  job.step = 'Starting download…';
  await add(best.pick, 'movie', spec, deps);
  job.added.push({ name: best.pick.name, quality: best.pick.quality, size: best.pick.size || null, seeders: best.pick.seeders });
  done(job, 'started', 'On its way. It’ll be ready to watch soon.');
}

async function runSeason(job, spec, deps) {
  await animeOf(job, spec);
  const { season, only } = spec;
  const plan = deps.seasonEpisodes ? await deps.seasonEpisodes(spec.title, spec.year, season) : null;
  if (plan?.title) job.title = plan.title;
  let aired = null;
  if (Array.isArray(plan?.episodes)) {
    aired = [...new Set(plan.episodes.filter((e) => e.aired && Number.isInteger(e.episode) && e.episode > 0).map((e) => e.episode))].sort((a, b) => a - b);
    job.upcoming = plan.episodes.length - aired.length;
    if (!aired.length) return done(job, 'none', job.upcoming ? 'None of this season’s episodes have aired yet.' : 'TMDB lists no episodes for this season.');
  }
  const wanted = only ? only.filter((e) => !aired || aired.includes(e)) : aired;
  job.total = aired ? aired.length : null;
  job.step = 'Checking which episodes you have…';
  const ctx = spec.anime || null;
  const have = (await deps.haveEpisodes?.(showKey(job.title), season, ctx)) || new Set();
  const queued = have.queued || new Set();
  job.have = (wanted || [...have]).filter((e) => have.has(e) && !queued.has(e));
  job.queued = (wanted || [...queued]).filter((e) => queued.has(e));
  const missing = wanted ? wanted.filter((e) => !have.has(e)) : null;
  if (missing && !missing.length) {
    return done(job, job.queued.length ? 'queued' : 'have', job.queued.length ? 'The rest are on their way.'
      : only && only.length > 1 ? 'These episodes are ready to watch.' : only ? 'This episode is ready to watch.' : 'This season is ready to watch.');
  }
  // A chosen range (episodes 150-200 of a long anime season): a batch still serves it, with the
  // episodes outside the range switched off like ones you already have.
  const outside = only && aired ? aired.filter((e) => !only.includes(e)) : [];
  const ranged = Boolean(spec.range && only && missing && missing.length >= PACK_FROM && aired);
  const inRange = (e) => !only || only.includes(e);
  let freeBytes = await deps.freeBytes?.('tv');
  const want = { ...spec.want, title: job.title, season, anime: Boolean(ctx) };
  const covered = new Set();
  let packWhy = null;
  // A batch already on the server beats a fresh one for the rest of a season: one release throughout,
  // no second copy. Best Quality still goes for the best out there.
  const hereHashes = want.profile === 'best' ? new Set() : await Promise.resolve(deps.torrentsHere?.()).catch(() => null) || new Set();
  const onServer = (list) => list.filter((r) => hereHashes.has(hashOf(r)));
  const fromAlternative = (alt) => {
    alt.episodes.forEach((e) => covered.add(e));
    job.added.push({ pack: true, name: alt.name, quality: alt.quality || null, episodes: [...alt.episodes].sort((a, b) => a - b), skipped: 0, size: null, source: alt.source });
  };
  if (spec.preferAlternative) {
    const alt = await tryAlternative(job, deps, { type: 'tv', season, episodes: missing });
    if (alt) {
      fromAlternative(alt);
      // Everything's on its way, or (no TMDB list to compare with) this is all that's known.
      if (!missing || missing.every((e) => covered.has(e))) { if (!missing) job.total = job.have.length + job.queued.length + covered.size; return finish(job, deps, null); }
    }
  }

  // ---- anime: batches, as many as it takes to cover the season ----
  if (ctx && (ranged || (!only && (!missing || missing.length >= PACK_FROM)))) {
    job.step = 'Looking for a batch…';
    let results = [];
    for (const query of packQueries(ctx, season).slice(0, 5)) {
      try { results = [...results, ...await search(query, 'all', deps)]; } catch (e) { if (e.status === 503) throw e; }
    }
    for (let round = 0; round < 3; round++) {
      const left = (missing || aired || []).filter((e) => !covered.has(e));
      if (round > 0 && left.length < PACK_FROM) break; // (no TMDB list: one batch is all there is to go on)
      const packs = seasonPacks(results.filter(usable).filter((r) => !r.cam && r.seeders >= 2), ctx, season, left.length ? left : null);
      if (!packs.length) { if (!round) packWhy = 'No batch of this season clearly matches.'; break; }
      const most = Math.max(...packs.map((p) => p.covers));
      if (round > 0 && most < PACK_FROM) break;
      const pool = packs.filter((p) => p.covers >= most * 0.9);
      const tidy = pool.filter((p) => p.extra <= p.covers); // this season's worth, not the whole series
      const packWant = { ...want, type: 'tv', episodes: aired?.length || 0, missing: left.length, freeBytes };
      const hereFirst = onServer(tidy.length ? tidy : pool);
      const reused = hereFirst.length ? choose(hereFirst, packWant, 'pack') : null;
      const best = reused?.pick ? reused : choose(tidy.length ? tidy : pool, packWant, 'pack');
      if (!best.pick) { if (!round) packWhy = best.why; break; }
      job.step = 'Starting download…';
      try {
        const added = await add(best.pick, 'tv', spec, deps);
        deps.inOrder?.(added, season);
        const owned = new Set([...have, ...covered, ...outside]);
        const trim = added.existing ? await deps.reopenPack?.(added.link, season, owned, ctx) : await deps.trimPack?.(added.link, season, owned, ctx);
        if (unreadable(trim)) deps.log?.(`[smart] ${job.title} S${pad(season)}: no episode numbers readable in ${best.pick.name}, kept whole`);
        const packEps = (trim?.covered && !unreadable(trim) ? [...trim.covered] : best.pick.coveredEpisodes).filter((e) => !owned.has(e) && inRange(e));
        if (trim?.covered && !packEps.length) {
          if (added.existing) { results = results.filter((r) => r !== best.pick && r.name !== best.pick.name); continue; } // someone else's: never removed
          await deps.removePack?.(added.link);
          break;
        }
        packEps.forEach((e) => covered.add(e));
        job.added.push({ pack: true, name: best.pick.name, quality: best.pick.quality, episodes: packEps.sort((a, b) => a - b),
          skipped: trim?.skipped || 0, size: best.pick.size || null });
        if (Number.isFinite(freeBytes) && best.pick.size) freeBytes -= best.pick.size / best.pick.packEpisodes * packEps.length;
        results = results.filter((r) => r !== best.pick && r.name !== best.pick.name);
      } catch (e) {
        if (e.status === 503) throw e;
        packWhy = e.message || String(e);
        break;
      }
    }
    if (!missing && covered.size) return finish(job, deps, packWhy);
  }

  // ---- a season pack, with what's already here switched off ----
  if (!ctx && (ranged || (!only && (!missing || missing.length >= PACK_FROM || missing.length === aired.length)))) {
    job.step = 'Looking for a season pack…';
    const titles = [job.title, ...(showKey(job.title) === 'house' ? ['House MD'] : showKey(job.title) === 'housemd' ? ['House'] : [])];
    let results = [], best = { pick: null, why: null };
    for (const query of seasonQueries(titles, season, want.profile)) {
      try { results = [...results, ...await search(query, 'tv', deps)]; } catch (e) { if (e.status === 503) throw e; continue; }
      best = pickBest(results.filter(usable), { ...want, type: 'tv', episodes: aired?.length || 0, missing: missing?.length || 0, freeBytes }, deps.parseName);
      if (best.pick && want.profile !== 'best') break; // Best Quality: every name before choosing
    }
    const hereFirst = onServer(results.filter(usable)).filter((r) => deps.parseName(r.name, { file: false }).episode == null);
    if (hereFirst.length) {
      const reused = pickBest(hereFirst, { ...want, type: 'tv', episodes: aired?.length || 0, missing: missing?.length || 0, freeBytes }, deps.parseName);
      if (reused.pick) best = reused;
    }
    packWhy = best.why;
    if (best.pick) {
      job.step = 'Starting download…';
      try {
        const added = await add(best.pick, 'tv', spec, deps);
        deps.inOrder?.(added, season);
        // The pack's file list: which episodes it really has. Unknown (no metadata yet) counts as all.
        const owned = new Set([...have, ...outside]);
        const trim = added.existing ? await deps.reopenPack?.(added.link, season, owned, null) : await deps.trimPack?.(added.link, season, owned);
        if (unreadable(trim)) deps.log?.(`[smart] ${job.title} S${pad(season)}: no episode numbers readable in ${best.pick.name}, kept whole`);
        const packEps = trim?.covered && !unreadable(trim) ? [...trim.covered].filter((e) => !owned.has(e) && inRange(e)) : (missing || []);
        if (trim?.covered && !unreadable(trim) && !packEps.length) {
          if (!added.existing) await deps.removePack?.(added.link); // nothing new in it: not worth keeping
          packWhy = 'The season pack had no episodes you’re missing.';
        } else {
          packEps.forEach((e) => covered.add(e));
          job.added.push({ pack: true, name: best.pick.name, quality: best.pick.quality, episodes: packEps.sort((a, b) => a - b),
            skipped: trim?.skipped || 0, size: best.pick.size || null });
          if (Number.isFinite(freeBytes) && best.pick.size) freeBytes -= best.pick.size * (aired?.length && missing ? missing.length / aired.length : 1);
        }
      } catch (e) {
        if (e.status === 503) throw e;
        packWhy = e.message || String(e);
      }
    }
    // Without a TMDB episode list, a pack is all there is to go on.
    if (!missing && covered.size) return finish(job, deps, packWhy);
  }

  // ---- episode by episode: what's still missing ----
  const list = missing || Array.from({ length: MAX_EPISODES }, (_, i) => i + 1);
  let missesInARow = 0;
  for (const ep of list) {
    if (covered.has(ep)) continue;
    if (!missing && have.has(ep)) continue;
    job.step = `Looking for episode ${ep}${job.total ? ` of ${job.total}` : ''}…`;
    const found = await findEpisode(job.title, season, ep, { ...want, freeBytes }, deps, ctx);
    if (!found.pick) {
      job.unavailable.push({ episode: ep, reason: found.why });
      if (!missing && ++missesInARow >= 2) { job.unavailable.splice(-2); break; } // two misses in a row: past the last episode
      continue;
    }
    missesInARow = 0;
    try {
      const added = await add(found.pick, 'tv', spec, deps);
      deps.inOrder?.(added, season);
      const eps = episodesIn(found.pick.name, season, ctx);
      eps.forEach((e) => covered.add(e));
      job.added.push({ episode: ep, episodes: eps, name: found.pick.name, quality: found.pick.quality, seeders: found.pick.seeders, size: found.pick.size || null });
      if (Number.isFinite(freeBytes) && found.pick.size) freeBytes -= found.pick.size;
    } catch (e) {
      if (e.status === 503) throw e;
      job.unavailable.push({ episode: ep, reason: e.message || String(e) });
    }
  }
  // Nothing from the torrent sites: what they couldn't find may still be on SVT Play.
  if (!spec.preferAlternative && !ctx && deps.alternative && (job.unavailable.length || (!missing && !covered.size))) {
    const alt = await tryAlternative(job, deps, { type: 'tv', season, episodes: missing ? job.unavailable.map((u) => u.episode) : null });
    if (alt) {
      fromAlternative(alt);
      job.unavailable = job.unavailable.filter((u) => !covered.has(u.episode));
    }
  }
  if (!missing) job.total = job.have.length + job.queued.length + covered.size;
  finish(job, deps, packWhy);
}

// Upgrade quality: the season is here but looks poor. Only a season pack that is clearly better
// (pictureScore, recommend.js) than what's here is downloaded, by Best Quality rules, with nothing
// switched off; the old episodes stay playable until each new one has finished (deps.upgrading).
const UPGRADE_MARGIN = 0.75;
const sameRelease = (a, b) => a.toLowerCase().replace(/[^a-z0-9]+/g, '') === b.toLowerCase().replace(/[^a-z0-9]+/g, '');
const perEpisodeText = (bytes) => `${Math.round(bytes / 1024 ** 3 * 10) / 10} GB per episode`;
const describe = (quality, name, bytes) => [quality === '2160p' ? '4K' : quality, { remux: 'Remux', bluray: 'BluRay', web: 'WEB-DL', webrip: 'WEBRip', tv: 'TV capture', dvd: 'DVD', upscale: 'upscale' }[sourceOf(name)], bytes && perEpisodeText(bytes)].filter(Boolean).join(' · ');

async function runUpgrade(job, spec, deps) {
  const { season } = spec;
  const now = spec.upgrade;
  const plan = deps.seasonEpisodes ? await deps.seasonEpisodes(spec.title, spec.year, season) : null;
  if (plan?.title) job.title = plan.title;
  const aired = Array.isArray(plan?.episodes) ? plan.episodes.filter((e) => e.aired).map((e) => e.episode) : null;
  job.total = aired?.length || now.episodes.length;
  job.step = 'Checking which episodes you have…';
  const have = (await deps.haveEpisodes?.(showKey(job.title), season, null)) || new Set();
  if (have.queued?.size) return done(job, 'queued', 'Some episodes of this season are still downloading. Upgrade once they’ve finished.');
  const count = aired?.length || now.episodes.length;
  const current = { name: now.names[0] || '', size: now.bytes / now.episodes.length * count, quality: now.quality || null };
  const want = { ...spec.want, profile: 'best', quality: spec.want?.quality || null, title: job.title, season, type: 'tv', episodes: count, missing: count };
  const bar = pictureScore(current, want, 'pack') + UPGRADE_MARGIN;
  const nowText = describe(now.quality, current.name, now.bytes / now.episodes.length);
  job.step = 'Looking for a better season pack…';
  const freeBytes = await deps.freeBytes?.('tv');
  const titles = [job.title, ...(showKey(job.title) === 'house' ? ['House MD'] : showKey(job.title) === 'housemd' ? ['House'] : [])];
  let results = [];
  for (const query of seasonQueries(titles, season, 'best')) {
    try { results = [...results, ...await search(query, 'tv', deps)]; } catch (e) { if (e.status === 503) throw e; }
  }
  const better = results.filter((r) => usable(r) && !now.names.some((n) => sameRelease(n, r.name))
    && (!r.size || pictureScore(r, want, 'pack') >= bar)); // size unknown: can't tell, so not an upgrade
  const best = pickBest(better.filter((r) => r.size), { ...want, freeBytes }, deps.parseName);
  if (!best.pick) {
    const why = best.why && !/clearly matches/.test(best.why) ? ` ${best.why}` : '';
    return done(job, 'none', `Nothing clearly better is out there right now. Yours: ${nowText}.${why}`);
  }
  job.step = 'Starting download…';
  const added = await add(best.pick, 'tv', spec, deps);
  deps.inOrder?.(added, season);
  const trim = added.existing ? null : await deps.trimPack?.(added.link, season, new Set());
  const eps = trim?.covered ? [...trim.covered].sort((a, b) => a - b) : now.episodes;
  deps.upgrading?.(added, season);
  const per = perItemSize(best.pick, want, 'pack');
  job.added.push({ pack: true, upgrade: true, name: best.pick.name, quality: best.pick.quality, episodes: eps, size: best.pick.size || null });
  done(job, 'started', `Upgrading to ${describe(best.pick.quality, best.pick.name, per)} (was ${nowText}). Each episode is swapped for the new one as it finishes; watch progress carries over.`);
  deps.log?.(`[upgrade] ${job.title} S${pad(season)}: ${current.name} -> ${best.pick.name}`);
}

function finish(job, deps, packWhy) {
  const n = new Set(job.added.flatMap((a) => a.episodes || [a.episode])).size;
  const gone = job.unavailable.map((u) => u.episode);
  // A shared reason worth repeating (size limit, free space, quality), not just "nothing found".
  const reasons = [...new Set(job.unavailable.map((u) => u.reason).filter((r) => r && r !== NOTHING))];
  const reason = reasons.length === 1 ? ` ${reasons[0]}` : '';
  if (!n && gone.length) {
    done(job, 'none', (gone.length === 1 ? `Couldn’t find a good copy of episode ${gone[0]}.` : `Couldn’t find good copies of ${episodeList(gone)}.`) + reason);
  } else if (!n) {
    done(job, 'none', packWhy || 'Couldn’t find a good copy of this season yet.');
  } else {
    done(job, gone.length ? 'partial' : 'started', [`${plural(n, 'episode')} on the way`, gone.length && `${gone.length} not found yet (${episodeList(gone)})`].filter(Boolean).join(' · '));
  }
  deps.log?.(`[smart] ${job.title} S${pad(job.season)}: ${job.message}`);
}

const NOTHING = 'Nothing found.';
// One episode: the exact SxxExx search, then other numbering styles and known title aliases, in the
// TV category and then everywhere. Only releases of this show, season and episode count.
async function findEpisode(title, season, episode, want, deps, ctx = null) {
  // Anime: the title check is the context's (any known name), and numbering is placed on TMDB's.
  const fitsFor = (results) => results.filter((r) => usable(r) && (ctx
    ? ((eps) => eps.includes(episode) && eps.length <= 3)(episodesIn(r.name, season, ctx)) // not a whole batch
    : sameShow(deps.parseName(r.name).title, title) && episodesIn(r.name, season).includes(episode)));
  let fits = [], error = null;
  const queries = ctx ? episodeQueriesAnime(ctx, season, episode).slice(0, 5) : episodeQueries(title, season, episode);
  for (const query of queries) {
    for (const type of ctx ? ['all'] : ['tv', 'all']) {
      try { fits = fitsFor(await search(query, type, deps)); } catch (e) { if (e.status === 503) throw e; error = e; continue; }
      if (fits.length) break;
    }
    if (fits.length) break;
  }
  const best = pickEpisode(fits, { ...want, episode });
  return { pick: best.pick, why: best.pick ? null : fits.length ? best.why : error ? 'The torrent sites didn’t answer.' : NOTHING };
}
