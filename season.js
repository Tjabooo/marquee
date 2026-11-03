// Whole season, episode by episode: for when no complete season torrent has enough seeders.
// One request starts a background job that, for every aired episode of the season (TMDB), skips
// what's already in the library or downloading, searches the torrent sites for that episode,
// picks the best match and sends it to qBittorrent. The torrent sheet polls the job for progress.
//
// "Best match" for an episode: the release name parses to the same show (loose name, as in the
// Library) and exactly that season and episode; no cinema recordings; at least one seeder. Among
// those with 5+ seeders (or all, if none has), the quality you filtered on (else 1080p, then 1440p,
// 720p, 4K, SD), then the most seeders. An exact quality never falls back to another resolution.
import crypto from 'node:crypto';
import { showKey } from './shows.js';

const jobs = new Map();       // id -> job
const JOB_TTL = 60 * 60 * 1000;
const MAX_EPISODES = 40;      // without TMDB, episodes are probed until two in a row aren't found
const QUALITY_RANK = { '1080p': 5, '1440p': 4, '720p': 3, '2160p': 2, SD: 1 };

// "South Park S18", "South Park season 18", "south.park.s18.complete" -> { title, year, season }
export function parseSeasonQuery(q) {
  const m = /^(.*?)[\s.]+(?:s(\d{1,2})|season[\s.]*(\d{1,2}))(?:[\s.]+(?:complete|full))?[\s.]*$/i.exec(String(q || '').trim());
  if (!m) return null;
  let title = m[1].replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  let year = null;
  const y = /^(.*?)\s*\(?((?:19|20)\d{2})\)?$/.exec(title);
  if (y && y[1]) { title = y[1].trim(); year = Number(y[2]); }
  if (!title) return null;
  return { title, year, season: Number(m[2] || m[3]) };
}

// Episodes a release name covers: "S18E01" -> [1], "S18E01E02" / "S18E01-E03" -> [1, 2(, 3)].
export function episodesIn(name, season) {
  if (!Number.isInteger(season) || season < 0 || season > 99) return [];
  const normalized = String(name).replace(/[._]+/g, ' ');
  const x = new RegExp(`\\b0?${season}x(\\d{1,3})(?!\\d)`, 'i').exec(normalized);
  if (x) return [Number(x[1])];
  const long = new RegExp(`\\bSeason\\s*0?${season}\\s+Episode\\s*(\\d{1,3})(?!\\d)`, 'i').exec(normalized);
  if (long) return [Number(long[1])];
  const m = new RegExp(`\\bS0?${season}\\s?E(\\d{1,3})(?![\\dp])`, 'i').exec(normalized);
  if (!m) return [];
  const episodes = [Number(m[1])];
  let tail = normalized.slice(m.index + m[0].length);
  for (;;) {
    const next = /^\s*(-\s*E?|E)\s*(\d{1,3})(?![\dp])/i.exec(tail);
    if (!next) break;
    const ep = Number(next[2]), previous = episodes.at(-1);
    if (next[1].trim().startsWith('-') && ep > previous && ep - previous <= 100) {
      for (let n = previous + 1; n <= ep; n++) episodes.push(n);
    } else episodes.push(ep);
    tail = tail.slice(next[0].length);
  }
  return [...new Set(episodes)];
}

// Some shows have established release aliases (notably House / House M.D.).
// Never compare only the first word: House of the Dragon must not match House.
export function sameShow(a, b) {
  const normalize = (value) => {
    const key = showKey(value);
    return key === 'housemd' ? 'house' : key;
  };
  return Boolean(normalize(a)) && normalize(a) === normalize(b);
}

// Search variants are attempted only after the exact title/episode search fails.
function episodeQueries(title, season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const titles = [title];
  if (showKey(title) === 'house') titles.push('House MD');
  if (showKey(title) === 'housemd') titles.push('House');
  return [...new Set(titles.flatMap((name) => [
    `${name} S${s}E${e}`, `${name} ${season}x${e}`,
  ]))];
}

export function seasonJob(id, { userId, owner = false } = {}) {
  const j = jobs.get(id);
  if (!j) return null;
  if (userId != null && !owner && j.requester !== userId) return null;
  const { cancelled, requester, ...view } = j;
  return view;
}

// deps: { parseName, searchTorrents, magnetFor1337x, addDownload, wantSubtitles, haveEpisodes, tmdb, seasonEpisodes, log }
export function startSeasonJob({ title, year, season, quality, exactQuality = false, subs, requester = null }, deps) {
  for (const [id, j] of jobs) if (j.state !== 'running' && Date.now() - j.started > JOB_TTL) jobs.delete(id);
  const key = showKey(title);
  const running = [...jobs.values()].find((j) => j.state === 'running' && j.requester === requester && sameShow(j.key, key) && j.season === season);
  if (running) return running.id; // pressing the button twice doesn't download everything twice
  const job = {
    id: crypto.randomBytes(6).toString('hex'), key, title, season, requester, started: Date.now(),
    state: 'running', step: 'Checking which episodes there are…', total: null, checked: 0,
    added: [], have: [], missing: [], errors: [], upcoming: 0, error: null,
  };
  jobs.set(job.id, job);
  run(job, { year, quality, exactQuality, subs }, deps).catch((e) => {
    job.state = 'failed';
    job.error = e.message || String(e);
    deps.log?.(`[season] ${title} S${season}: ${job.error}`);
  });
  return job.id;
}

async function run(job, { year, quality, exactQuality, subs }, deps) {
  const plan = await deps.seasonEpisodes(job.title, year, job.season, deps.tmdb);
  if (plan?.title) job.title = plan.title;
  let episodes = null;
  if (Array.isArray(plan?.episodes)) {
    episodes = [...new Set(plan.episodes.filter((e) => e.aired && Number.isInteger(e.episode) && e.episode > 0).map((e) => e.episode))].sort((a, b) => a - b);
    job.upcoming = plan.episodes.length - episodes.length;
  }
  job.total = episodes ? episodes.length : null;
  if (episodes && !episodes.length) {
    job.state = 'done';
    job.step = job.upcoming ? 'None of this season’s episodes have aired yet.' : 'TMDB lists no episodes for this season.';
    return;
  }

  const have = await deps.haveEpisodes(job.key, job.season); // Set of episode numbers (library + downloads)
  const covered = new Set();
  const want = quality && QUALITY_RANK[quality] ? quality : '1080p';
  const list = episodes || Array.from({ length: MAX_EPISODES }, (_, i) => i + 1);
  let missesInARow = 0;
  for (const ep of list) {
    const label = `S${String(job.season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`;
    if (covered.has(ep)) { job.checked++; continue; } // came with a multi-episode release added above
    if (have.has(ep)) {
      job.have.push(ep);
      job.checked++;
      continue;
    }
    job.step = `Looking for episode ${ep}${job.total ? ` of ${job.total}` : ''}…`;
    const fitsFor = (results) => results.filter((r) => !r.cam && r.seeders > 0
      && (!exactQuality || r.quality === quality)
      && sameShow(deps.parseName(r.name).title, job.title)
      && episodesIn(r.name, job.season).includes(ep));
    let fits = [];
    let searchError = null;
    // Prefer the precise SxxExx query. If it finds no matching releases, try
    // an alternate episode numbering style and known title aliases.
    for (const query of episodeQueries(job.title, job.season, ep)) {
      for (const type of ['tv', 'all']) {
        try {
          const found = (await deps.searchTorrents(query, type)).results || [];
          fits = fitsFor(found);
          if (fits.length) break;
        } catch (e) {
          if (e.status === 503) throw e;
          searchError = e;
        }
      }
      if (fits.length) break;
    }
    if (searchError && !fits.length) {
      job.errors.push({ episode: ep, message: searchError.message || String(searchError) });
    }
    // Quality only counts among healthy torrents (5+ seeders): a 1080p with one seeder can stall forever.
    const healthy = fits.filter((r) => r.seeders >= 5);
    const pool = healthy.length ? healthy : fits;
    pool.sort((a, b) => ((b.quality === want) - (a.quality === want))
      || ((QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0))
      || b.seeders - a.seeders);
    job.checked++;
    const best = pool[0];
    if (!best) {
      job.missing.push(ep);
      if (!episodes && ++missesInARow >= 2) { // no TMDB: two misses in a row = past the last episode
        job.missing.splice(-2);
        break;
      }
      continue;
    }
    missesInARow = 0;
    try {
      const magnet = best.magnet || await deps.magnetFor1337x(best.ref);
      if (!magnet) throw new Error('No download link was available.');
      await deps.addDownload({ link: magnet, name: best.name, mediaType: 'tv' });
      if (subs?.length) deps.wantSubtitles(magnet, subs, best.name);
      const eps = episodesIn(best.name, job.season);
      eps.forEach((e) => covered.add(e));
      job.added.push({ episode: ep, episodes: eps, name: best.name, seeders: best.seeders, quality: best.quality });
    } catch (e) {
      job.missing.push(ep);
      job.errors.push({ episode: ep, message: e.message || String(e) });
    }
  }
  if (!episodes) job.total = job.checked - job.missing.length;
  job.state = 'done';
  job.step = null;
  deps.log?.(`[season] ${job.title} S${job.season}: added ${job.added.length}, already had ${job.have.length}, not found ${job.missing.join(', ') || 'none'}`);
}
