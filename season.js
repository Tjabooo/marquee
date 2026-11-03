// Whole season, episode by episode: for when no complete season torrent has enough seeders.
// One request starts a background job that, for every aired episode of the season (TMDB), skips
// what's already in the library or downloading, searches the torrent sites for that episode,
// picks the best match and sends it to qBittorrent. The torrent sheet polls the job for progress.
//
// "Best match" for an episode: the release name parses to the same show (loose name, as in the
// Library) and exactly that season and episode; no cinema recordings; at least one seeder. Among
// those with 5+ seeders (or all, if none has), the quality you filtered on (else 1080p, then 720p,
// 4K, SD), then the most seeders.
import crypto from 'node:crypto';
import { showKey } from './shows.js';

const jobs = new Map();       // id -> job
const JOB_TTL = 60 * 60 * 1000;
const MAX_EPISODES = 40;      // without TMDB, episodes are probed until two in a row aren't found
const QUALITY_RANK = { '1080p': 4, '720p': 3, '2160p': 2, SD: 1 };

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
function episodesIn(name, season) {
  const m = new RegExp(`\\bS0?${season}\\s?E(\\d{1,3})(?:\\s?-?\\s?E?(\\d{1,3}))?(?![\\dp])`, 'i').exec(name.replace(/[._]+/g, ' '));
  if (!m) return [];
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (b < a || b - a > 5) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

export function seasonJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const { cancelled, ...view } = j;
  return view;
}

// deps: { parseName, searchTorrents, magnetFor1337x, addDownload, wantSubtitles, haveEpisodes, tmdb, seasonEpisodes, log }
export function startSeasonJob({ title, year, season, quality, exactQuality = false, subs }, deps) {
  for (const [id, j] of jobs) if (Date.now() - j.started > JOB_TTL) jobs.delete(id);
  const key = showKey(title);
  const running = [...jobs.values()].find((j) => j.state === 'running' && j.key === key && j.season === season);
  if (running) return running.id; // pressing the button twice doesn't download everything twice
  const job = {
    id: crypto.randomBytes(6).toString('hex'), key, title, season, started: Date.now(),
    state: 'running', step: 'Checking which episodes there are…', total: null, checked: 0,
    added: [], have: [], missing: [], upcoming: 0, error: null,
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
  const plan = await deps.seasonEpisodes(job.title, year, job.season, deps.tmdb).catch(() => null);
  if (plan?.title) job.title = plan.title;
  let episodes = null;
  if (plan?.episodes?.length) {
    episodes = plan.episodes.filter((e) => e.aired).map((e) => e.episode);
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
    let results = [];
    try {
      results = (await deps.searchTorrents(`${job.title} ${label}`, 'tv')).results;
    } catch (e) {
      if (e.status === 503) throw e; // torrent search turned off
      try { results = (await deps.searchTorrents(`${job.title} ${label}`, 'all')).results; } catch { results = []; }
    }
    const fits = results.filter((r) => !r.cam && r.seeders > 0 && (!exactQuality || r.quality === quality)
      && showKey(deps.parseName(r.name).title) === job.key
      && episodesIn(r.name, job.season).includes(ep));
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
    const magnet = best.magnet || await deps.magnetFor1337x(best.ref);
    await deps.addDownload({ link: magnet });
    if (subs?.length) deps.wantSubtitles(magnet, subs, best.name);
    const eps = episodesIn(best.name, job.season);
    eps.forEach((e) => covered.add(e));
    job.added.push({ episode: ep, episodes: eps, name: best.name, seeders: best.seeders, quality: best.quality });
  }
  if (!episodes) job.total = job.checked - job.missing.length;
  job.state = 'done';
  job.step = null;
  deps.log?.(`[season] ${job.title} S${job.season}: added ${job.added.length}, already had ${job.have.length}, not found ${job.missing.join(', ') || 'none'}`);
}
