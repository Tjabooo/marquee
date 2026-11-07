// The unified Download command: profiles, limits, films, season packs with owned episodes switched
// off, missing-only fallback and plain-language outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBest, languageFit } from '../src/recommend.js';
import { parseTpb } from '../src/torrents.js';
import { startSmartJob, smartJob } from '../src/smart-download.js';

import { parseName } from '../src/release-name.js';
const GB = 1024 ** 3;
let n = 0;
const results = (rows) => parseTpb(rows.map(([name, seeders, size = 2 * GB]) => ({
  info_hash: (++n).toString(16).padStart(40, '0'), name, seeders, leechers: 0, size, category: '207', status: 'member',
})), 'all');
const pick = (rows, want) => pickBest(results(rows), want, parseName).pick?.name ?? null;
const film = { type: 'movie', title: 'Dune', year: 2021 };
const wait = async (id) => {
  for (let i = 0; i < 400 && smartJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  return smartJob(id);
};
const aired = (count) => async () => ({ episodes: Array.from({ length: count }, (_, i) => ({ episode: i + 1, aired: true })) });
const owned = (list, queued = []) => { const s = new Set(list); s.queued = new Set(queued); return s; };

// ---------- ranking ----------
const dune = [
  ['Dune.2021.2160p.UHD.BluRay.REMUX.HDR.HEVC', 400, 70 * GB],
  ['Dune.2021.2160p.WEB-DL.HDR.x265', 300, 18 * GB],
  ['Dune.2021.1080p.BluRay.x264', 900, 9 * GB],
  ['Dune.2021.1080p.WEB.x265', 300, 1.9 * GB],
  ['Dune.2021.720p.WEB.x264', 1200, 1.2 * GB],
];
test('Balanced favours a sensible 1080p, Best a 4K that isn’t a remux, Save Space a compact copy', () => {
  assert.equal(pick(dune, { ...film, profile: 'balanced' }), 'Dune.2021.1080p.BluRay.x264');
  assert.equal(pick(dune, { ...film, profile: 'best' }), 'Dune.2021.2160p.WEB-DL.HDR.x265');
  assert.equal(pick(dune, { ...film, profile: 'save' }), 'Dune.2021.1080p.WEB.x265');
  assert.equal(pick(dune.slice(0, 3), { ...film, profile: 'save' }), 'Dune.2021.1080p.BluRay.x264', 'nothing compact: the smallest sensible one');
});

test('size limit and free space are hard limits with a plain reason', () => {
  assert.equal(pick(dune, { ...film, profile: 'best', maxBytes: 10 * GB }), 'Dune.2021.1080p.BluRay.x264');
  const tooBig = pickBest(results(dune.slice(0, 2)), { ...film, maxBytes: 8 * GB }, parseName);
  assert.equal(tooBig.pick, null); assert.match(tooBig.why, /larger than your 8 GB limit/);
  const full = pickBest(results(dune), { ...film, freeBytes: 0.5 * GB }, parseName);
  assert.equal(full.pick, null); assert.match(full.why, /Not enough free space/);
  assert.equal(pick(dune, { ...film, freeBytes: 2 * GB }), 'Dune.2021.1080p.WEB.x265', 'never a release that exceeds the space left');
});

test('dubbed-only releases in another language are passed over; a wanted language is preferred', () => {
  const rows = [['Dune.2021.1080p.FRENCH.BluRay.x264', 5000, 9 * GB], ['Dune.2021.1080p.BluRay.x264', 60, 9 * GB]];
  assert.equal(pick(rows, film), 'Dune.2021.1080p.BluRay.x264');
  assert.equal(pick(rows, { ...film, audioLang: 'fr' }), 'Dune.2021.1080p.FRENCH.BluRay.x264');
  assert.equal(pick(rows.slice(0, 1), film), 'Dune.2021.1080p.FRENCH.BluRay.x264', 'only a dub exists: better than nothing');
  assert.equal(languageFit('The.Good.German.2006.1080p.BluRay'), 1, 'a title word is not a language tag');
  assert.equal(languageFit('Dune.2021.MULTi.1080p', 'sv'), 1.5);
});

test('a season pack is judged per episode against the size limit and by its real disk use', () => {
  const show = { type: 'tv', title: 'Severance', season: 2, episodes: 10, missing: 10 };
  const rows = [['Severance.S02.2160p.WEB', 300, 80 * GB], ['Severance.S02.1080p.WEB', 200, 25 * GB]];
  assert.equal(pick(rows, { ...show, profile: 'best' }), 'Severance.S02.2160p.WEB');
  assert.equal(pick(rows, { ...show, profile: 'best', maxBytes: 4 * GB }), 'Severance.S02.1080p.WEB', '8 GB an episode is over a 4 GB limit');
  assert.equal(pick(rows, { ...show, profile: 'best', missing: 2, freeBytes: 20 * GB }), 'Severance.S02.2160p.WEB', 'owned episodes are switched off, so 2 of 10 count');
});

test('complete-series bundles and other seasons are never taken for a season pack', () => {
  const show = { type: 'tv', title: 'Severance', season: 2 };
  assert.equal(pick([['Severance.Complete.Series.S01-S02.1080p', 900], ['Severance.S01.1080p', 900]], show), null);
});

// ---------- films ----------
const filmDeps = (extra = {}) => ({
  parseName, searchTorrents: async () => ({ results: results(dune) }), addDownload: async () => ({ existing: false }), ...extra,
});
test('Download on a film you have, or one already downloading, queues nothing', async () => {
  for (const [have, outcome] of [['library', 'have'], ['server', 'have'], ['downloading', 'queued']]) {
    let searched = 0;
    const job = await wait(startSmartJob({ ...film, title: `Dune ${have}`, want: {} }, filmDeps({
      filmHave: async () => have, searchTorrents: async () => { searched++; return { results: [] }; },
    })));
    assert.equal(job.outcome, outcome); assert.equal(searched, 0);
  }
});

test('a film downloads the profile’s pick in one step and records what was chosen', async () => {
  const added = [];
  const job = await wait(startSmartJob({ ...film, want: { profile: 'balanced' } }, filmDeps({ addDownload: async (d) => { added.push(d); } })));
  assert.equal(job.outcome, 'started'); assert.equal(added.length, 1);
  assert.equal(added[0].name, 'Dune.2021.1080p.BluRay.x264'); assert.equal(added[0].mediaType, 'movie');
});

test('no suitable film release explains why and never substitutes another title', async () => {
  const added = [];
  const job = await wait(startSmartJob({ type: 'movie', title: 'Arrival', year: 2016, want: {} }, filmDeps({
    searchTorrents: async () => ({ results: results([['Arrival.Of.The.Dead.2016.1080p', 900], ['Arrivals.2016.1080p', 900]]) }),
    addDownload: async (d) => added.push(d),
  })));
  assert.equal(job.outcome, 'none'); assert.match(job.message, /No release clearly matches/); assert.equal(added.length, 0);
});

test('a release qBittorrent rejected is not picked again by the next Download', async () => {
  const tried = [], heat = results([['Heat.1995.1080p.BluRay', 900, 9 * GB], ['Heat.1995.1080p.WEB', 40, 6 * GB]]);
  const deps = filmDeps({
    searchTorrents: async () => ({ results: heat }),
    addDownload: async ({ name }) => { tried.push(name); if (name === 'Heat.1995.1080p.BluRay') throw Error('qBittorrent couldn’t use that link.'); },
  });
  const first = await wait(startSmartJob({ type: 'movie', title: 'Heat', year: 1995, want: {} }, deps));
  assert.equal(first.state, 'failed'); assert.match(first.message, /couldn’t use that link/);
  const second = await wait(startSmartJob({ type: 'movie', title: 'Heat', year: 1995, want: {} }, deps));
  assert.equal(second.outcome, 'started'); assert.deepEqual(tried, ['Heat.1995.1080p.BluRay', 'Heat.1995.1080p.WEB']);
});

test('search sites that never answer fail the command with a retryable message', async () => {
  const job = await wait(startSmartJob({ type: 'movie', title: 'Offline', year: 2000, want: {} }, filmDeps({
    sleep: async () => {}, searchTorrents: async () => { throw Error('ETIMEDOUT'); },
  })));
  assert.equal(job.state, 'failed'); assert.match(job.message, /aren’t answering/);
});

// ---------- seasons ----------
const pack = (name, size = 20 * GB) => results([[name, 300, size]]);
const seasonDeps = (extra = {}) => ({
  parseName, seasonEpisodes: aired(8), haveEpisodes: async () => owned([]),
  searchTorrents: async (q) => ({ results: /E\d/.test(q) ? [] : pack('Severance.S02.1080p.WEB') }),
  addDownload: async () => ({ existing: false }), ...extra,
});

test('nothing owned: one season pack, nothing else', async () => {
  const added = [];
  const job = await wait(startSmartJob({ type: 'tv', title: 'Severance', season: 2, want: {} }, seasonDeps({
    addDownload: async (d) => { added.push(d.name); return { existing: false }; },
  })));
  assert.deepEqual(added, ['Severance.S02.1080p.WEB']); assert.equal(job.outcome, 'started');
  assert.match(job.message, /8 episodes downloading/);
});

test('partly owned: the pack is added with owned episodes switched off, and gaps are filled one by one', async () => {
  const added = [], trims = [];
  const job = await wait(startSmartJob({ type: 'tv', title: 'Severance', season: 2, want: {} }, seasonDeps({
    haveEpisodes: async () => owned([1, 2, 3]),
    searchTorrents: async (q) => ({ results: q === 'Severance S02E08' ? results([['Severance.S02E08.1080p.WEB', 50, 2 * GB]])
      : /E\d/.test(q) ? [] : pack('Severance.S02.1080p.WEB') }),
    addDownload: async (d) => { added.push(d.name); return { existing: false }; },
    trimPack: async (link, season, have) => { trims.push([season, [...have].sort()]); return { covered: new Set([1, 2, 3, 4, 5, 6, 7]), skipped: 3 }; },
  })));
  assert.deepEqual(trims, [[2, [1, 2, 3]]]);
  assert.deepEqual(added, ['Severance.S02.1080p.WEB', 'Severance.S02E08.1080p.WEB'], 'E08 is not in the pack, so it comes on its own');
  assert.deepEqual(job.added[0].episodes, [4, 5, 6, 7]); assert.equal(job.added[0].skipped, 3);
  assert.equal(job.outcome, 'started'); assert.match(job.message, /5 episodes downloading/);
});

test('a pack with nothing new is removed again and the missing episodes come one by one', async () => {
  const removed = [], added = [];
  const job = await wait(startSmartJob({ type: 'tv', title: 'Severance', season: 2, want: {} }, seasonDeps({
    seasonEpisodes: aired(4), haveEpisodes: async () => owned([1]),
    searchTorrents: async (q) => {
      const ep = /S02E0(\d)/.exec(q)?.[1];
      return { results: ep ? results([[`Severance.S02E0${ep}.1080p.WEB`, 40, 2 * GB]]) : /E\d|x\d/.test(q) ? [] : pack('Severance.S02.1080p.WEB') };
    },
    addDownload: async (d) => { added.push(d.name); return { existing: false }; },
    trimPack: async () => ({ covered: new Set([1]), skipped: 0 }), removePack: async (link) => removed.push(link),
  })));
  assert.equal(removed.length, 1);
  assert.deepEqual(added.slice(1), ['Severance.S02E02.1080p.WEB', 'Severance.S02E03.1080p.WEB', 'Severance.S02E04.1080p.WEB']);
  assert.equal(job.outcome, 'started');
});

test('someone else’s existing pack is joined, never trimmed', async () => {
  let trimmed = 0;
  const job = await wait(startSmartJob({ type: 'tv', title: 'Severance', season: 2, want: {} }, seasonDeps({
    haveEpisodes: async () => owned([1]), addDownload: async () => ({ existing: true }), trimPack: async () => { trimmed++; return null; },
  })));
  assert.equal(trimmed, 0); assert.equal(job.outcome, 'started');
});

test('a complete or fully queued season says so and queues nothing', async () => {
  let searches = 0;
  const deps = (have) => seasonDeps({ seasonEpisodes: aired(3), haveEpisodes: async () => have, searchTorrents: async () => { searches++; return { results: [] }; } });
  assert.match((await wait(startSmartJob({ type: 'tv', title: 'Done Show', season: 1, want: {} }, deps(owned([1, 2, 3]))))).message, /ready to watch/);
  assert.match((await wait(startSmartJob({ type: 'tv', title: 'Busy Show', season: 1, want: {} }, deps(owned([1, 2, 3], [3]))))).message, /Remaining episodes are downloading/);
  assert.equal(searches, 0);
});

test('nothing found anywhere names the missing episodes', async () => {
  const job = await wait(startSmartJob({ type: 'tv', title: 'Lost Media', season: 1, want: {} }, seasonDeps({
    seasonEpisodes: aired(3), searchTorrents: async () => ({ results: [] }),
  })));
  assert.equal(job.outcome, 'none'); assert.match(job.message, /E01, E02, E03/);
  assert.deepEqual(job.unavailable.map((u) => u.episode), [1, 2, 3]);
});

test('Retry unavailable (chosen episodes) never searches a pack and skips what arrived meanwhile', async () => {
  const queries = [];
  const job = await wait(startSmartJob({ type: 'tv', title: 'Severance', season: 2, episodes: [6, 7], want: {} }, seasonDeps({
    haveEpisodes: async () => owned([7]),
    searchTorrents: async (q) => { queries.push(q); return { results: results([[`${q.replace(/ /g, '.')}.1080p.WEB`, 40, 2 * GB]]) }; },
  })));
  assert.ok(queries.every((q) => /E06|2x06/.test(q))); assert.equal(job.outcome, 'started');
});
