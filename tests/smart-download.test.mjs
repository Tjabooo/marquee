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
test('Balanced favours a sensible 1080p, Best the untouched 4K remux, Save Space a compact copy', () => {
  assert.equal(pick(dune, { ...film, profile: 'balanced' }), 'Dune.2021.1080p.BluRay.x264');
  assert.equal(pick(dune, { ...film, profile: 'best' }), 'Dune.2021.2160p.UHD.BluRay.REMUX.HDR.HEVC');
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
  assert.match(job.message, /8 episodes on the way/);
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
  assert.equal(job.outcome, 'started'); assert.match(job.message, /5 episodes on the way/);
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
  assert.match((await wait(startSmartJob({ type: 'tv', title: 'Busy Show', season: 1, want: {} }, deps(owned([1, 2, 3], [3]))))).message, /The rest are on their way/);
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

// ---------- picture quality and Upgrade quality ----------
const house = [
  ['House.S03.1080p.BluRay.REMUX.AVC.DTS.5.1-NOGRP', 20, 174.8 * GB],
  ['House.S03.1080p.BluRay.x264-SHORTBREHD', 20, 77.4 * GB],
  ['House, M.D. Season 3 S03 (1080p Bluray x265 AAC 5.1 Joy)[UTR]', 213, 8.1 * GB],
];
const houseWant = { type: 'tv', title: 'House', season: 3, episodes: 24, missing: 24 };
test('Best Quality ranks by picture, not popularity: remux, then a solid BluRay, then a tiny popular encode', () => {
  assert.equal(pick(house, { ...houseWant, profile: 'best' }), 'House.S03.1080p.BluRay.REMUX.AVC.DTS.5.1-NOGRP');
  assert.equal(pick(house.slice(1), { ...houseWant, profile: 'best' }), 'House.S03.1080p.BluRay.x264-SHORTBREHD');
});

// Real search results, seeders and sizes (2026-11-08). Each of these went wrong, or nearly did.
const best = (title, season, episodes, rows, over = {}) => pick(rows,
  { type: 'tv', title, season, episodes, missing: episodes, profile: 'best', ...over });
test('Best Quality: a remux beats a popular small encode, even with fewer seeders', () => {
  assert.equal(best('House', 6, 22, [
    ['House.S06.1080p.BluRay.REMUX.VC-1.DTS-HD.MA.5.1-NOGRP', 29, 182 * GB],
    ['House.S06.1080p.AMZN.WEBRip.AAC5.1.x265-RxB', 54, 17.1 * GB],
    ['House, M.D. Season 6 S06 (1080p Bluray x265 AAC 5.1 Joy)[UTR]', 204, 7.7 * GB],
  ]), 'House.S06.1080p.BluRay.REMUX.VC-1.DTS-HD.MA.5.1-NOGRP');
});
test('Best Quality: a solid encode that plays directly beats a VC-1 remux; an H.264 remux beats it', () => {
  const s07 = [
    ['House.S07.1080p.BluRay.REMUX.VC-1.DTS-HD.MA.5.1-NOGRP', 23, 181.4 * GB],
    ['House.S07.1080p.BluRay.X264-MIXED', 13, 75.3 * GB],
    ['House.S07.1080p.AMZN.WEBRip.AAC5.1.x265-RxB', 55, 17.7 * GB],
  ];
  assert.equal(best('House', 7, 23, s07), 'House.S07.1080p.BluRay.X264-MIXED');
  assert.equal(best('House', 7, 23, [['House.S07.1080p.BluRay.REMUX.AVC.DTS.5.1-NOGRP', 23, 150 * GB], ...s07]), 'House.S07.1080p.BluRay.REMUX.AVC.DTS.5.1-NOGRP');
});
test('3D, AI upscales and disc images are never picked while a normal copy exists, in any profile', () => {
  const s03 = [
    ['Breaking Bad. S03. 2008  2160P.Ai Upscaled.BluRay.60FPS.H265.SDR.DTS5.1_Marjen', 95, 187.3 * GB],
    ['Breaking.Bad.S03.1080p.3D.FULL-SBS.HEVC.SBS-SUB.ENG-HUN.iFA-AI3D', 300, 102.4 * GB],
    ['Breaking.Bad.S03.COMPLETE.BLURAY.BDMV-GROUP', 300, 180 * GB],
    ['Breaking.Bad.S03.1080p.BluRay.X264-7SinS', 23, 42.6 * GB],
  ];
  for (const profile of ['best', 'balanced', 'save']) assert.equal(best('Breaking Bad', 3, 13, s03, { profile }), 'Breaking.Bad.S03.1080p.BluRay.X264-7SinS', profile);
  assert.equal(best('Breaking Bad', 3, 13, s03.slice(1, 2)), s03[1][0], 'nothing else exists: better than nothing');
});
test('Best Quality: seeders only settle near-ties, and a dead release still loses to a healthy one', () => {
  assert.equal(best('House', 6, 22, [['House.S06.1080p.BluRay.x264-A', 8, 70 * GB], ['House.S06.1080p.BluRay.x264-B', 400, 70 * GB]]), 'House.S06.1080p.BluRay.x264-B');
  assert.equal(best('House', 6, 22, [['House.S06.1080p.BluRay.REMUX.AVC-A', 3, 150 * GB], ['House.S06.1080p.BluRay.x264-B', 40, 70 * GB]]), 'House.S06.1080p.BluRay.x264-B');
});
test('Best Quality: a solid 720p beats a starved 1080p, but not a decent one, and says nothing about "nothing better"', () => {
  const bd720 = ['House.S06.720p.BluRay.x264-GRP', 30, 44 * GB];
  assert.equal(best('House', 6, 22, [bd720, ['House.S06.1080p.WEBRip.x265-Joy', 500, 6 * GB]]), bd720[0]);
  assert.equal(best('House', 6, 22, [bd720, ['House.S06.1080p.BluRay.x264-GRP', 30, 70 * GB]]), 'House.S06.1080p.BluRay.x264-GRP');
  const res = pickBest(results([bd720, ['House.S06.1080p.WEBRip.x265-Joy', 500, 6 * GB]]), { type: 'tv', title: 'House', season: 6, episodes: 22, missing: 22, profile: 'best' }, parseName);
  assert.equal(res.why, null);
});
test('Best Quality: "ENG" in a name earns nothing when English is wanted, but a dub still loses', () => {
  const rows = [['Breaking Bad S03 Complete 1080p ENG-ITA MultiSub x264 BluRay', 18, 34.5 * GB], ['Breaking Bad (2008) S03 (1080p x265 10bit BD DTS-HD MA 5.1) [Prof]', 150, 59.7 * GB]];
  assert.equal(best('Breaking Bad', 3, 13, rows, { audioLang: 'en' }), rows[1][0]);
  assert.equal(best('Breaking Bad', 3, 13, [['Breaking.Bad.S03.1080p.BluRay.x264.FRENCH-X', 200, 70 * GB], ['Breaking.Bad.S03.1080p.BluRay.x264-Y', 20, 60 * GB]], { audioLang: 'en' }), 'Breaking.Bad.S03.1080p.BluRay.x264-Y');
});
test('Best Quality searches for quality releases by name; a plain search can miss them', async () => {
  const added = [], asked = [];
  const quiet = ['House.S07.1080p.BluRay.REMUX.AVC.DTS.5.1-NOGRP', 20, 150 * GB];
  const popular = ['House.S07.1080p.AMZN.WEBRip.AAC5.1.x265-RxB', 55, 17.7 * GB];
  const deps = (over) => ({ parseName, magnetFor1337x: async () => null, sleep: async () => {}, freeBytes: async () => 900 * GB,
    addDownload: async (d) => { added.push(d.name); return { hash: 'abc' }; }, ...over,
    searchTorrents: async (q) => { asked.push(q); return { results: results(/REMUX/.test(q) ? [quiet, popular] : [popular]) }; } });
  await wait(startSmartJob({ type: 'tv', title: 'House', season: 7, want: { profile: 'best' } }, deps()));
  assert.equal(added[0], quiet[0]); assert.ok(asked.includes('House S07 REMUX') && asked.includes('House S07 BluRay'));
  asked.length = 0;
  await wait(startSmartJob({ type: 'tv', title: 'Severance', season: 2, want: { profile: 'balanced' } }, deps()));
  assert.ok(!asked.some((q) => /REMUX|BluRay/.test(q)), 'other profiles search as before');
  added.length = 0; asked.length = 0;
  const filmRemux = ['Dune.2021.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1', 20, 30 * GB];
  await wait(startSmartJob({ type: 'movie', title: 'Dune', year: 2021, want: { profile: 'best' } }, { ...deps(), searchTorrents: async (q) => { asked.push(q);
    return { results: results(/REMUX/.test(q) ? [filmRemux] : [['Dune.2021.1080p.WEBRip.x265', 900, 2 * GB]]) }; } }));
  assert.equal(added[0], filmRemux[0], 'a film goes through every search too'); assert.ok(asked.includes('Dune 2021 REMUX'));
});
test('Hard limits still win over picture: the size limit and free space', () => {
  const rows = [['House.S06.1080p.BluRay.REMUX.AVC-A', 29, 182 * GB], ['House.S06.1080p.AMZN.WEBRip.x265-RxB', 54, 17.1 * GB]];
  assert.equal(best('House', 6, 22, rows, { maxBytes: 4 * GB }), rows[1][0]);
  assert.equal(best('House', 6, 22, rows, { freeBytes: 100 * GB }), rows[1][0]);
});

const upgradeDeps = (over = {}) => ({
  parseName, magnetFor1337x: async () => null, sleep: async () => {},
  searchTorrents: async () => ({ results: results(house) }),
  seasonEpisodes: aired(24), haveEpisodes: async () => owned(Array.from({ length: 24 }, (_, i) => i + 1)),
  addDownload: async () => ({ hash: 'abc' }), ...over,
});
const joyNow = { episodes: Array.from({ length: 24 }, (_, i) => i + 1), bytes: 24 * 0.4 * GB, names: ['House, M.D. Season 3 (1080p x265 Joy)'], quality: '1080p' };
test('Upgrade quality downloads a clearly better pack and hands the swap to the server', async () => {
  const added = [], swaps = [];
  const job = await wait(startSmartJob({ type: 'tv', title: 'House', season: 3, upgrade: joyNow, want: { profile: 'balanced' } }, upgradeDeps({
    addDownload: async (d) => { added.push(d); return { hash: 'abc' }; }, upgrading: (a, n) => swaps.push([a.hash, n]),
  })));
  assert.equal(job.outcome, 'started'); assert.equal(added[0].name, 'House.S03.1080p.BluRay.REMUX.AVC.DTS.5.1-NOGRP');
  assert.deepEqual(swaps, [['abc', 3]]); assert.match(job.message, /was 1080p · 0\.4 GB per episode/);
});
test('Upgrade quality says so when nothing is clearly better, and never re-downloads the same release', async () => {
  const added = [];
  const now = { ...joyNow, bytes: 24 * 3.2 * GB, names: ['House.S03.1080p.BluRay.x264-SHORTBREHD'] };
  const job = await wait(startSmartJob({ type: 'tv', title: 'House', season: 3, upgrade: now, want: {} }, upgradeDeps({
    searchTorrents: async () => ({ results: results(house.slice(1)) }), addDownload: async (d) => { added.push(d); return {}; },
  })));
  assert.equal(job.outcome, 'none'); assert.match(job.message, /Nothing clearly better/); assert.equal(added.length, 0);
});

// ---------- another source (SVT Play) ----------
const altFilm = { type: 'movie', title: 'Palmemördaren', year: 2020, want: {} };
const altDeps = (over = {}) => ({ parseName, searchTorrents: async () => ({ results: [] }), addDownload: async () => { throw new Error('no torrent wanted'); }, ...over });

test('a film no torrent can be found for comes from the other source', async () => {
  const asked = [];
  const job = await wait(startSmartJob({ ...altFilm, requester: 'alt-1' }, altDeps({
    alternative: async (r) => { asked.push(r); return { name: 'Palmemördaren (SVT Play)', quality: '1080p', source: 'svt', message: 'From SVT Play.' }; },
  })));
  assert.deepEqual(asked, [{ type: 'movie' }]);
  assert.equal(job.outcome, 'started');
  assert.equal(job.message, 'From SVT Play.');
  assert.equal(job.added[0].source, 'svt');
});

test('a film with a good torrent never asks the other source, unless told to prefer it', async () => {
  const found = results([['Dune.2021.1080p.WEB.x265', 300, 2 * GB]]);
  let asked = 0, adds = 0;
  const deps = { parseName, searchTorrents: async () => ({ results: found }), addDownload: async () => { adds++; return {}; },
    alternative: async () => { asked++; return { name: 'Dune (SVT Play)', source: 'svt', message: 'From SVT Play.' }; } };
  await wait(startSmartJob({ ...film, want: {}, requester: 'alt-2' }, deps));
  assert.deepEqual([asked, adds], [0, 1]);
  await wait(startSmartJob({ ...film, want: {}, requester: 'alt-3', preferAlternative: true }, deps));
  assert.deepEqual([asked, adds], [1, 1]);
});

test('the other source failing or having nothing is the same as no answer', async () => {
  for (const [i, alternative] of [async () => null, async () => { throw new Error('down'); }].entries()) {
    const job = await wait(startSmartJob({ ...altFilm, requester: `alt-4-${i}` }, altDeps({ alternative })));
    assert.equal(job.outcome, 'none');
  }
});

test('a season: the other source gets what torrents can’t find, and only that', async () => {
  const asked = [];
  const job = await wait(startSmartJob({ type: 'tv', title: 'GW:s mord', season: 1, want: {}, requester: 'alt-5' }, altDeps({
    seasonEpisodes: aired(3), haveEpisodes: async () => owned([2]),
    alternative: async (r) => { asked.push(r); return { name: 'GW:s mord (SVT Play)', source: 'svt', episodes: r.episodes, message: 'x' }; },
  })));
  assert.deepEqual(asked, [{ type: 'tv', season: 1, episodes: [1, 3] }]);
  assert.equal(job.outcome, 'started');
  assert.deepEqual(job.unavailable, []);
  assert.match(job.message, /2 episodes on the way/);
});

test('a Swedish season asks the other source first; torrents fill in what it lacks', async () => {
  const asked = [], searched = [];
  const job = await wait(startSmartJob({ type: 'tv', title: 'Hövdingen', season: 1, want: {}, requester: 'alt-6', preferAlternative: true }, altDeps({
    seasonEpisodes: aired(2), haveEpisodes: async () => owned([]),
    searchTorrents: async (q) => { searched.push(q); return { results: [] }; },
    alternative: async (r) => { asked.push(r); return { name: 'x', source: 'svt', episodes: [1], message: 'x' }; },
  })));
  assert.equal(asked.length, 1);
  assert.ok(searched.some((q) => /S01E02/.test(q)), 'episode 2 is still searched for');
  assert.ok(!searched.some((q) => /S01E01/.test(q)), 'episode 1 is on its way');
  assert.equal(job.outcome, 'partial');
});
