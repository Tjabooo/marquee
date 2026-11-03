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
import crypto from 'node:crypto';
import { showKey } from './shows.js';
import { sameShow, episodesIn, episodeQueries } from './season.js';
import { pickBest, pickEpisode } from './recommend.js';

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

// spec: { type: 'movie' | 'tv', title, year?, originalTitle?, season?, episodes? (only these),
//   want: { profile, prefer, quality, maxBytes, audioLang }, subs?, requester? }
// deps: { parseName, searchTorrents, magnetFor1337x, addDownload, wantSubtitles?, log?, sleep?,
//   filmHave?(), freeBytes?(type), seasonEpisodes?(title, year, season), haveEpisodes?(key, season),
//   trimPack?(link, season, owned), removePack?(link), inOrder?(added, season) (episodes in order) }
export function startSmartJob(spec, deps) {
  for (const [id, j] of jobs) if (j.state !== 'running' && Date.now() - j.started > JOB_TTL) jobs.delete(id);
  const key = showKey(spec.title);
  const only = Array.isArray(spec.episodes) && spec.episodes.length ? [...new Set(spec.episodes)].sort((a, b) => a - b) : null;
  const target = spec.type === 'tv' ? `tv:${key === 'housemd' ? 'house' : key}:${spec.season}:${only?.join(',') || 'all'}` : `movie:${key}:${spec.year || ''}`;
  const running = [...jobs.values()].find((j) => j.state === 'running' && j.requester === (spec.requester ?? null) && j.target === target);
  if (running) return running.id; // pressing Download twice never queues anything twice
  const job = {
    id: crypto.randomBytes(6).toString('hex'), type: spec.type, title: spec.title, season: spec.season ?? null,
    requester: spec.requester ?? null, target, started: Date.now(), state: 'running', step: 'Finding a download…',
    outcome: null, message: null, total: null, have: [], queued: [], added: [], unavailable: [], upcoming: 0, error: null,
  };
  jobs.set(job.id, job);
  (spec.type === 'tv' ? runSeason(job, { ...spec, only }, deps) : runFilm(job, spec, deps)).catch((e) => {
    job.state = 'failed';
    job.error = e.status === 503 ? 'The download service is unavailable. Try again shortly.' : e.message || String(e);
    job.message = job.error;
    job.step = null;
    deps.log?.(`[smart] ${spec.title}${spec.season != null ? ` S${pad(spec.season)}` : ''}: ${e.message || e}`);
  });
  return job.id;
}

const usable = (r) => !rejected.has(r.magnet || r.ref) || Date.now() - rejected.get(r.magnet || r.ref) > REJECTED_TTL;

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
    if (spec.subs?.length) deps.wantSubtitles?.(link, spec.subs, r.name);
    return { link, ...(result || {}) };
  } catch (e) {
    rejected.set(r.magnet || r.ref, Date.now());
    throw e;
  }
}

const done = (job, outcome, message) => { job.state = 'done'; job.outcome = outcome; job.message = message; job.step = null; };

async function runFilm(job, spec, deps) {
  const have = await deps.filmHave?.();
  if (have === 'library') return done(job, 'have', 'Already in your library.');
  if (have === 'server') return done(job, 'have', 'It was already on the server, so it’s in your library now.');
  if (have === 'downloading') return done(job, 'queued', 'Already downloading.');
  const freeBytes = await deps.freeBytes?.('movie');
  const want = { ...spec.want, type: 'movie', title: spec.title, year: spec.year, freeBytes };
  const queries = [...new Set([[spec.title, spec.year].filter(Boolean).join(' '), spec.originalTitle && [spec.originalTitle, spec.year].filter(Boolean).join(' '), spec.title].filter(Boolean))];
  let results = [], best = { pick: null, why: null }, failures = 0;
  for (const query of queries) {
    try { results = [...results, ...await search(query, 'movie', deps)]; } catch (e) { if (e.status === 503) throw e; failures++; continue; }
    best = pickBest(results.filter(usable), want, deps.parseName);
    if (best.pick) break;
  }
  if (!best.pick) {
    if (failures === queries.length) throw new Error('The torrent sites aren’t answering. Try again shortly.');
    return done(job, 'none', best.why || 'No release clearly matches this title.');
  }
  job.step = 'Starting download…';
  await add(best.pick, 'movie', spec, deps);
  job.added.push({ name: best.pick.name, quality: best.pick.quality, size: best.pick.size || null, seeders: best.pick.seeders });
  done(job, 'started', 'Downloading.');
}

async function runSeason(job, spec, deps) {
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
  const have = (await deps.haveEpisodes?.(showKey(job.title), season)) || new Set();
  const queued = have.queued || new Set();
  job.have = (wanted || [...have]).filter((e) => have.has(e) && !queued.has(e));
  job.queued = (wanted || [...queued]).filter((e) => queued.has(e));
  const missing = wanted ? wanted.filter((e) => !have.has(e)) : null;
  if (missing && !missing.length) {
    return done(job, job.queued.length ? 'queued' : 'have', job.queued.length ? 'Remaining episodes are downloading.' : 'This season is ready to watch.');
  }
  let freeBytes = await deps.freeBytes?.('tv');
  const want = { ...spec.want, title: job.title, season };
  const covered = new Set();
  let packWhy = null;

  // ---- a season pack, with what's already here switched off ----
  if (!only && (!missing || missing.length >= PACK_FROM || missing.length === aired.length)) {
    job.step = 'Looking for a season pack…';
    const titles = [job.title, ...(showKey(job.title) === 'house' ? ['House MD'] : showKey(job.title) === 'housemd' ? ['House'] : [])];
    let results = [], best = { pick: null, why: null };
    for (const query of titles.flatMap((t) => [`${t} S${pad(season)}`, `${t} Season ${season}`])) {
      try { results = [...results, ...await search(query, 'tv', deps)]; } catch (e) { if (e.status === 503) throw e; continue; }
      best = pickBest(results.filter(usable), { ...want, type: 'tv', episodes: aired?.length || 0, missing: missing?.length || 0, freeBytes }, deps.parseName);
      if (best.pick) break;
    }
    packWhy = best.why;
    if (best.pick) {
      job.step = 'Starting download…';
      try {
        const added = await add(best.pick, 'tv', spec, deps);
        deps.inOrder?.(added, season);
        // The pack's file list: which episodes it really has. Unknown (no metadata yet) counts as all.
        const owned = new Set([...have]);
        const trim = added.existing ? null : await deps.trimPack?.(added.link, season, owned);
        const packEps = trim?.covered ? [...trim.covered].filter((e) => !owned.has(e)) : (missing || []);
        if (trim?.covered && !packEps.length) {
          await deps.removePack?.(added.link); // nothing new in it: not worth keeping
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
    const found = await findEpisode(job.title, season, ep, { ...want, freeBytes }, deps);
    if (!found.pick) {
      job.unavailable.push({ episode: ep, reason: found.why });
      if (!missing && ++missesInARow >= 2) { job.unavailable.splice(-2); break; } // two misses in a row: past the last episode
      continue;
    }
    missesInARow = 0;
    try {
      const added = await add(found.pick, 'tv', spec, deps);
      deps.inOrder?.(added, season);
      const eps = episodesIn(found.pick.name, season);
      eps.forEach((e) => covered.add(e));
      job.added.push({ episode: ep, episodes: eps, name: found.pick.name, quality: found.pick.quality, seeders: found.pick.seeders, size: found.pick.size || null });
      if (Number.isFinite(freeBytes) && found.pick.size) freeBytes -= found.pick.size;
    } catch (e) {
      if (e.status === 503) throw e;
      job.unavailable.push({ episode: ep, reason: e.message || String(e) });
    }
  }
  if (!missing) job.total = job.have.length + job.queued.length + covered.size;
  finish(job, deps, packWhy);
}

function finish(job, deps, packWhy) {
  const n = new Set(job.added.flatMap((a) => a.episodes || [a.episode])).size;
  const gone = job.unavailable.map((u) => u.episode);
  // A shared reason worth repeating (size limit, free space, quality), not just "nothing found".
  const reasons = [...new Set(job.unavailable.map((u) => u.reason).filter((r) => r && r !== NOTHING))];
  const reason = reasons.length === 1 ? ` ${reasons[0]}` : '';
  if (!n && gone.length) {
    done(job, 'none', (gone.length === 1 ? `No suitable download for episode ${gone[0]}.` : `No suitable downloads for ${episodeList(gone)}.`) + reason);
  } else if (!n) {
    done(job, 'none', packWhy || 'No suitable download was found.');
  } else {
    done(job, gone.length ? 'partial' : 'started', [`${plural(n, 'episode')} downloading`, gone.length && `${gone.length} unavailable (${episodeList(gone)})`].filter(Boolean).join(' · '));
  }
  deps.log?.(`[smart] ${job.title} S${pad(job.season)}: ${job.message}`);
}

const NOTHING = 'Nothing found.';
// One episode: the exact SxxExx search, then other numbering styles and known title aliases, in the
// TV category and then everywhere. Only releases of this show, season and episode count.
async function findEpisode(title, season, episode, want, deps) {
  const fitsFor = (results) => results.filter((r) => usable(r)
    && sameShow(deps.parseName(r.name).title, title) && episodesIn(r.name, season).includes(episode));
  let fits = [], error = null;
  for (const query of episodeQueries(title, season, episode)) {
    for (const type of ['tv', 'all']) {
      try { fits = fitsFor(await search(query, type, deps)); } catch (e) { if (e.status === 503) throw e; error = e; continue; }
      if (fits.length) break;
    }
    if (fits.length) break;
  }
  const best = pickEpisode(fits, { ...want, episode });
  return { pick: best.pick, why: best.pick ? null : fits.length ? best.why : error ? 'The torrent sites didn’t answer.' : NOTHING };
}
