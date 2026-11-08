// Anime support: fansub names, AniList seasons placed on TMDB's, Nyaa results, batches in smart
// downloads and library numbering. Names below are real Nyaa release names (November 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnimeName, alignEntries, resolve, episodesInSeason, seasonPacks, packQueries, episodeQueriesAnime, isAnimeDetails } from '../src/anime.js';
import { parseName } from '../src/release-name.js';
import { episodesIn } from '../src/season.js';
import { parseNyaa } from '../src/torrents.js';
import { showKey } from '../src/shows.js';
import { startSmartJob, smartJob } from '../src/smart-download.js';
import { isDualAudio } from '../src/recommend.js';
import { versionInfo } from '../src/versions.js';

// A context as anime.buildContext makes it, without the network.
// continuous: TMDB numbers on across seasons (One Piece); years: when each season began.
function ctxOf({ id = 1, title, keys, seasons, entries = [], continuous = false, year = 2020, years = [] }) {
  let start = 1;
  const s = seasons.map((count, i) => { const out = { n: i + 1, count, start, first: continuous ? start : 1, year: years[i] ?? null }; start += count; return out; });
  const e = alignEntries(s, entries.map(([titles, episodes]) => ({ titles, keys: titles.map(showKey), episodes })));
  e.forEach((x, i) => { if (i > 0) x.keys = x.keys.filter((k) => !keys.map(showKey).includes(k)); });
  return { v: 3, type: 'tv', id, title, year, keys: keys.map(showKey), queryTitles: [keys[0]], seasons: s, entries: e };
}
const frieren = ctxOf({ title: 'Frieren: Beyond Journey\'s End', keys: ['Sousou no Frieren', 'Frieren: Beyond Journey\'s End'],
  seasons: [38], entries: [[['Sousou no Frieren'], 28], [['Sousou no Frieren 2nd Season'], 10]] });
const clover = ctxOf({ title: 'Black Clover', keys: ['Black Clover'], seasons: [170, 26], entries: [[['Black Clover'], 170], [['Black Clover 2nd Season'], null]] });
const jjk = ctxOf({ title: 'JUJUTSU KAISEN', keys: ['Jujutsu Kaisen'], seasons: [59],
  entries: [[['Jujutsu Kaisen'], 24], [['Jujutsu Kaisen 2nd Season'], 23], [['Jujutsu Kaisen: Shimetsu Kaiyuu - Zenpen'], 12]] });
const slayer = ctxOf({ title: 'Demon Slayer: Kimetsu no Yaiba', keys: ['Kimetsu no Yaiba', 'Demon Slayer: Kimetsu no Yaiba'], seasons: [26, 7, 11, 11, 8],
  entries: [[['Kimetsu no Yaiba'], 26], [['Kimetsu no Yaiba: Yuukaku-hen'], 11], [['Kimetsu no Yaiba: Katanakaji no Sato-hen'], 11], [['Kimetsu no Yaiba: Hashira Geiko-hen'], 8]] });
const onePiece = ctxOf({ title: 'One Piece', keys: ['One Piece'], seasons: [61, 16, 14, 39], entries: [[['One Piece'], null]] });
const place = (name, ctx) => resolve(parseAnimeName(name, { file: true }), ctx)?.map((x) => `S${x.season}E${x.episode}`).join(',') ?? null;

test('fansub names: groups, absolute numbers, season markers, batches and ranges', () => {
  const p = (n) => { const x = parseAnimeName(n); return x && [x.title, x.seasons?.join('+') ?? null, x.episodes ? (x.episodes.length > 2 ? `${x.episodes[0]}..${x.episodes.at(-1)}` : x.episodes.join(',')) : null]; };
  assert.deepEqual(p('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv'), ['Black Clover', null, '176']);
  assert.deepEqual(p('[SubsPlease] Sousou no Frieren S2 - 03 (1080p) [7556A22B].mkv'), ['Sousou no Frieren', '2', '3']);
  assert.deepEqual(p('[Erai-raws] Black Clover 2nd Season - 06 [1080p CR WEB-DL AVC AAC][MultiSub][D4FA28BC]'), ['Black Clover', '2', '6']);
  assert.deepEqual(p('[SubsPlease] Black Clover (01-170) (1080p) [Batch]'), ['Black Clover', null, '1..170']);
  assert.deepEqual(p('[Erai-raws] Black Clover (TV) - 001 ~ 170 [1080p][BATCH][Multiple Subtitle] [ENG]'), ['Black Clover', null, '1..170']);
  assert.deepEqual(p('[HorribleSubs] Black Clover 01 - 60 [720p] [Batch]'), ['Black Clover', null, '1..60']);
  assert.deepEqual(p('[Judas] Jujutsu Kaisen (Season 2) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs] (Batch)'), ['Jujutsu Kaisen', '2', null]);
  assert.deepEqual(p('[Judas] Black Clover (Seasons 1-4 + Extras) [BD 1080p][HEVC x265 10bit] (Batch)'), ['Black Clover', '1+2+3+4', null]);
  assert.deepEqual(p('[Trix] Kimetsu no Yaiba S01-05 [Dual Audio] (BD 1080p AV1) - Demon Slayer VOSTFR (Batch)'), ['Kimetsu no Yaiba', '1+2+3+4+5', null]);
  assert.deepEqual(p('[Anime Time] One Piece (0001-1071+Movies+Specials) [BD+CR] [Dual Audio] [Batch]'), ['One Piece', null, '1..1071']);
  assert.deepEqual(p('[ToonsHub] One Piece EP1158 1080p CR WEB-DL DUAL AAC2.0 H.264 (Dual-Audio, Multi-Subs)'), ['One Piece', null, '1158']);
  assert.deepEqual(p('SPY.x.FAMILY.S02.1080p.BluRay.Dual-Audio.Opus.5.1.x265-YURASUKA (SPYxFAMILY 2nd Season)'), ['SPY x FAMILY', '2', null]);
  assert.deepEqual(p('[ASW] 86 - Eighty Six - 05 [1080p HEVC]'), ['86 - Eighty Six', null, '5']);
  assert.deepEqual(p('Mob Psycho 100 III - 05 (1080p)'), ['Mob Psycho 100 III', null, '5']);
  assert.equal(parseAnimeName('[SubsPlease] Frieren - 05.5 (1080p) [ABCDEF12].mkv').special, true, 'recaps are not episodes');
  assert.equal(parseAnimeName('[Erai-raws] Mugyutto! Black Clover - 01 ~ 08 [1080p][BATCH]').title, 'Mugyutto! Black Clover');
  assert.equal(parseAnimeName('Dune.2021.1080p.BluRay.x264'), null, 'films stay films');
});

test('parseName: anime episodes without SxxEyy, group tags never part of a title', () => {
  assert.deepEqual(parseName('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv'), { title: 'Black Clover', year: null, season: 1, episode: 176, absolute: true, anime: true });
  assert.deepEqual(parseName('[SubsPlease] Sousou no Frieren S2 - 03 (1080p) [7556A22B].mkv'), { title: 'Sousou no Frieren', year: null, season: 2, episode: 3, absolute: false, anime: true });
  assert.equal(parseName('[Judas] Black Clover - S02E06 [1080p][HEVC x265 10bit].mkv').title, 'Black Clover');
  assert.equal(parseName('[SubsPlease] Kimetsu no Yaiba Movie 1 - Mugenjou-hen - Akaza Sairai (1080p) [E0B0972D].mkv').season, null);
  assert.equal(parseName('Rocky - 4 (1986).mkv').season, null, 'a lone low number is no episode');
  assert.deepEqual(parseName('Severance.S02E03.1080p.mkv'), { title: 'Severance', year: null, season: 2, episode: 3 });
});

test('AniList seasons are placed on TMDB’s count, skipping TMDB seasons AniList doesn’t have', () => {
  assert.deepEqual(frieren.entries.map((e) => e.from), [1, 29]);
  assert.deepEqual(clover.entries.map((e) => e.from), [1, 171]);
  assert.deepEqual(jjk.entries.map((e) => e.from), [1, 25, 48]);
  // TMDB: 26, Mugen Train arc (7), 11, 11, 8. AniList skips the Mugen Train TV arc.
  assert.deepEqual(slayer.entries.map((e) => e.from), [1, 34, 45, 56]);
  assert.deepEqual(onePiece.entries.map((e) => e.from), [1]);
});

test('every naming convention lands on TMDB’s season and episode', () => {
  assert.equal(place('[SubsPlease] Sousou no Frieren S2 - 03 (1080p) [7556A22B].mkv', frieren), 'S1E31');
  assert.equal(place('[Erai-raws] Sousou no Frieren 2nd Season - 10 [1080p][5A357DEE].mkv', frieren), 'S1E38');
  assert.equal(place('[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCDEF12].mkv', frieren), 'S1E5');
  assert.equal(place('Frieren - Beyond Journey\'s End - 07 [1080p].mkv', frieren), 'S1E7');
  assert.equal(place('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv', clover), 'S2E6');
  assert.equal(place('[Erai-raws] Black Clover 2nd Season - 06 [1080p][D4FA28BC].mkv', clover), 'S2E6');
  assert.equal(place('[Judas] Black Clover - S02E06 [1080p].mkv', clover), 'S2E6');
  assert.equal(place('[SubsPlease] Black Clover - 012 (1080p) [ABCDEF12].mkv', clover), 'S1E12');
  assert.equal(place('[ToonsHub] Jujutsu Kaisen S03E10 1080p NF WEB-DL AAC2.0 H.264 (Multi-Subs).mkv', jjk), 'S1E57');
  assert.equal(place('[SubsPlease] Jujutsu Kaisen - 56 (1080p) [0F106B43].mkv', jjk), 'S1E56');
  assert.equal(place('[X] Kimetsu no Yaiba - Yuukaku-hen - 05 [1080p].mkv', slayer), 'S3E5');
  assert.equal(place('[Judas] Kimetsu no Yaiba - S05E02 [1080p].mkv', slayer), 'S5E2');
  assert.equal(place('[SubsPlease] One Piece - 1179 (1080p) [A02F35FE].mkv', onePiece), null, 'beyond TMDB’s known episodes by far');
  assert.equal(place('[SubsPlease] One Piece - 80 (1080p) [A02F35FE].mkv', onePiece), 'S3E3');
  assert.equal(place('[Erai-raws] Mugyutto! Black Clover - 03 [1080p].mkv', clover), null, 'another show');
  assert.equal(place('05.mkv', frieren), 'S1E5', 'a bare number in the show’s folder');
  assert.deepEqual(episodesIn('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv', 2, clover), [6]);
  assert.deepEqual(episodesIn('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv', 1, clover), []);
  assert.deepEqual(episodesInSeason('[Judas] Jujutsu Kaisen (Season 2) [1080p] (Batch)', 1, jjk), Array.from({ length: 23 }, (_, i) => 25 + i));
});

test('without a context: what the name says, season 1 when it names none', () => {
  assert.deepEqual(episodesIn('[SubsPlease] Dandadan - 05 (1080p) [ABCDEF12].mkv', 1), [5]);
  assert.deepEqual(episodesIn('[SubsPlease] Dandadan S2 - 05 (1080p) [ABCDEF12].mkv', 2), [5]);
  assert.deepEqual(episodesIn('Severance.S02E03.1080p.mkv', 2), [3]);
});

test('batches per TMDB season: coverage, size per episode, untrustworthy multi-season sets left out', () => {
  const r = (name, size = 100) => ({ name, seeders: 50, size, quality: '1080p' });
  const packs = seasonPacks([
    r('[SubsPlease] Black Clover (01-170) (1080p) [Batch]'),
    r('[Judas] Black Clover (Seasons 1-4 + Extras) [BD 1080p] (Batch)'),     // BD seasons ≠ TMDB’s
    r('[HorribleSubs] Black Clover 01 - 60 [720p] [Batch]'),
    r('[Erai-raws] Mugyutto! Black Clover - 01 ~ 08 [1080p][BATCH]'),
    r('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv'),
  ], clover, 1);
  assert.deepEqual(packs.map((p) => [p.name.slice(0, 26), p.covers, p.packEpisodes]), [
    ['[SubsPlease] Black Clover ', 170, 170], ['[HorribleSubs] Black Clove', 60, 60]]);
  const s2 = seasonPacks([r('[SubsPlease] Sousou no Frieren S2 (01-10) (1080p) [Batch]'), r('[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]')], frieren, 1);
  assert.deepEqual(s2.map((p) => p.coveredEpisodes.at(-1)), [38, 28]);
  assert.deepEqual(seasonPacks([r('[Trix] Kimetsu no Yaiba S01-05 [Dual Audio] (BD 1080p AV1) (Batch)')], slayer, 5)[0].covers, 8);
  // "Season 1" of Frieren is the Japanese season 1 (28), not all of TMDB's season 1 (38).
  assert.equal(seasonPacks([r('[Judas] Sousou no Frieren (Season 01) [BD 1080p][HEVC x265 10bit] (Batch)')], frieren, 1)[0].covers, 28);
});

test('search queries use the romanised name, absolute and per-season numbers', () => {
  assert.deepEqual(packQueries(frieren, 1).slice(0, 2), ['Sousou no Frieren batch', 'Sousou no Frieren']);
  const q = episodeQueriesAnime(frieren, 1, 31);
  assert.ok(q.includes('Sousou no Frieren 31') && q.includes('Sousou no Frieren 03') && q.includes('Sousou no Frieren S2 03'), q.join(' | '));
});

test('TMDB details: Japanese animation counts as anime, other animation doesn’t', () => {
  assert.equal(isAnimeDetails({ genres: [{ id: 16 }], original_language: 'ja', origin_country: ['JP'] }), true);
  assert.equal(isAnimeDetails({ genres: [{ id: 16 }], original_language: 'en', origin_country: ['US'] }), false);
  assert.equal(isAnimeDetails({ genres: [{ id: 18 }], original_language: 'ja' }), false);
});

test('Nyaa search page: seeders, size, trusted and remakes', () => {
  const row = (cls, id, name, size, s, l) => `<tr class="${cls}"><td><a href="/?c=1_2" title="Anime - English-translated"></a></td>
    <td colspan="2"><a href="/view/${id}" title="${name}">${name}</a></td>
    <td class="text-center"><a href="/download/${id}.torrent"></a><a href="magnet:?xt=urn:btih:${String(id).padStart(40, 'a')}&amp;dn=x&amp;tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce"></a></td>
    <td class="text-center">${size}</td><td class="text-center" data-timestamp="1794063708">2026-11-07 15:01</td>
    <td class="text-center">${s}</td><td class="text-center">${l}</td><td class="text-center">999</td></tr>`;
  const html = `<table class="torrent-list"><tbody>${row('success', 1, '[SubsPlease] Black Clover (01-170) (1080p) [Batch]', '233.2 GiB', 412, 30)}${row('danger', 2, 'Black Clover - 01 &amp; more', '1.4 GiB', 3, 1)}</tbody></table>`;
  const [a, b] = parseNyaa(html);
  assert.equal(a.name, '[SubsPlease] Black Clover (01-170) (1080p) [Batch]');
  assert.equal(a.seeders, 412); assert.equal(a.leechers, 30); assert.equal(a.trusted, true); assert.equal(a.quality, '1080p');
  assert.equal(Math.round(a.size / 1024 ** 3), 233);
  assert.match(a.magnet, /^magnet:\?xt=urn:btih:a+1&dn=x&tr=/);
  assert.equal(b.name, 'Black Clover - 01 & more'); assert.equal(b.remake, true); assert.equal(b.trusted, false);
});

// ---------- the Download command ----------
const GB = 1024 ** 3;
const wait = async (id) => {
  for (let i = 0; i < 400 && smartJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  return smartJob(id);
};
let hashN = 0;
const nyaa = (name, seeders, size) => ({ source: 'nyaa', name, seeders, size, quality: /1080p/.test(name) ? '1080p' : /720p/.test(name) ? '720p' : null,
  tags: [], cam: false, magnet: `magnet:?xt=urn:btih:${(++hashN).toString(16).padStart(40, '0')}` });
function deps(catalogue, extra = {}) {
  const added = [], queries = [];
  return {
    added, queries,
    deps: {
      parseName,
      searchTorrents: async (q) => { queries.push(q); return { results: catalogue.filter((r) => q.toLowerCase().split(' ').filter((w) => w !== 'batch').every((w) => r.name.toLowerCase().includes(w))) }; },
      addDownload: async ({ name }) => { added.push(name); return { hash: String(added.length), existing: false }; },
      seasonEpisodes: async () => ({ title: extra.title, episodes: Array.from({ length: extra.aired }, (_, i) => ({ episode: (extra.first || 1) + i, aired: true })) }),
      haveEpisodes: async () => Object.assign(new Set(extra.have || []), { queued: new Set() }),
      ...extra.deps,
    },
  };
}

test('Black Clover season 1: one 170-episode batch instead of 170 torrents', async () => {
  const cat = [
    nyaa('[SubsPlease] Black Clover (01-170) (1080p) [Batch]', 412, 233 * GB),
    nyaa('[Erai-raws] Black Clover (TV) - 001 ~ 170 [720p][BATCH][Multiple Subtitle]', 90, 120 * GB),
    nyaa('[Judas] Black Clover (Seasons 1-4 + Extras) [BD 1080p][HEVC x265 10bit] (Batch)', 1207, 58 * GB),
    nyaa('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv', 2784, 1.4 * GB),
  ];
  const { deps: d, added } = deps(cat, { title: 'Black Clover', aired: 170 });
  const job = await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, anime: clover, want: { profile: 'balanced' }, requester: 'bc1' }, d));
  assert.deepEqual(added, ['[SubsPlease] Black Clover (01-170) (1080p) [Batch]']);
  assert.equal(job.outcome, 'started');
  assert.equal(job.added[0].episodes.length, 170);
});

test('Frieren (TMDB: one season of 38): the season 1 batch, then the season 2 batch', async () => {
  const cat = [
    nyaa('[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]', 800, 40 * GB),
    nyaa('[SubsPlease] Sousou no Frieren S2 (01-10) (1080p) [Batch]', 300, 14 * GB),
    nyaa('[SubsPlease] Sousou no Frieren S2 - 03 (1080p) [7556A22B].mkv', 900, 1.4 * GB),
  ];
  const { deps: d, added } = deps(cat, { title: 'Frieren: Beyond Journey\'s End', aired: 38 });
  const job = await wait(startSmartJob({ type: 'tv', title: 'Frieren: Beyond Journey\'s End', season: 1, anime: frieren, want: { profile: 'balanced' }, requester: 'fr1' }, d));
  assert.deepEqual(added, ['[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]', '[SubsPlease] Sousou no Frieren S2 (01-10) (1080p) [Batch]']);
  assert.equal(job.outcome, 'started');
});

test('single anime episodes are found by absolute or per-season number, never a batch or another show', async () => {
  const cat = [
    nyaa('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv', 2784, 1.4 * GB),
    nyaa('[Erai-raws] Black Clover 2nd Season - 05 [1080p CR WEB-DL AVC AAC][MultiSub][C8D18DEA]', 400, 1.3 * GB),
    nyaa('[Erai-raws] Mugyutto! Black Clover - 06 [1080p]', 900, 0.2 * GB),
  ];
  const { deps: d, added } = deps(cat, { title: 'Black Clover', aired: 6, have: [1, 2, 3, 4] });
  const job = await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 2, anime: clover, want: { profile: 'balanced' }, requester: 'bc2' }, d));
  assert.deepEqual(added, ['[Erai-raws] Black Clover 2nd Season - 05 [1080p CR WEB-DL AVC AAC][MultiSub][C8D18DEA]', '[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv']);
  assert.equal(job.outcome, 'started');
});

// One Piece as TMDB really has it: 23 seasons numbered on from one to the next (season 21 = 892-1088),
// and a live-action series of the same name from 2023.
const OP_SEASONS = [61, 16, 14, 39, 13, 52, 33, 35, 73, 45, 26, 14, 101, 58, 62, 50, 56, 55, 74, 14, 197, 67, 25];
const onePieceReal = ctxOf({ title: 'One Piece', keys: ['One Piece'], seasons: OP_SEASONS, entries: [[['One Piece'], null]], continuous: true,
  year: 1999, years: [1999, 2001, 2001, 2001, 2002, 2002, 2003, 2004, 2004, 2006, 2007, 2007, 2008, 2009, 2010, 2011, 2013, 2014, 2016, 2016, 2019, 2023, 2025] });

test('One Piece: TMDB’s continuous numbering, absolute fansub numbers and season-style names agree', () => {
  assert.equal(place('[SubsPlease] One Piece - 1085 (1080p) [A02F35FE].mkv', onePieceReal), 'S21E1085');
  assert.equal(place('[SubsPlease] One Piece - 892 (1080p) [A02F35FE].mkv', onePieceReal), 'S21E892');
  assert.equal(place('[SubsPlease] One Piece - 61 (1080p) [A02F35FE].mkv', onePieceReal), 'S1E61');
  assert.equal(place('[SubsPlease] One Piece - 62 (1080p) [A02F35FE].mkv', onePieceReal), 'S2E62');
  assert.equal(place('One.Piece.S21E1085.1080p.WEB.x264.mkv', onePieceReal), 'S21E1085', 'TMDB’s own number');
  assert.equal(place('One.Piece.S21E05.1080p.WEB.x264.mkv', onePieceReal), 'S21E896', 'counted within the season');
  assert.deepEqual(episodesInSeason('[Erai-raws] One Piece - 1001 ~ 1010 [1080p][Multiple Subtitle]', 21, onePieceReal, { file: false }),
    [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]);
  assert.ok(episodeQueriesAnime(onePieceReal, 21, 1085).includes('One Piece 1085'));
});

test('a year that is neither the show’s nor the season’s is another show (One Piece live action)', () => {
  assert.equal(place('One Piece (2023) Season 1 S01 (1080p NF WEB-DL x265 HEVC 10bit EAC3 Atmos 5.1 Garshasp) [QxR]', onePieceReal), null);
  assert.equal(place('[Judas] One Piece (1999) - 1085 [1080p].mkv', onePieceReal), 'S21E1085');
  assert.equal(place('[ASW] One Piece (2023) - 1085 [1080p].mkv', onePieceReal), null, 'season 21 began in 2019');
  assert.equal(place('[ASW] One Piece (2023) - 1090 [1080p].mkv', onePieceReal), 'S22E1090', 'season 22 began in 2023');
});

test('undated seasons take their year from the dated seasons around them', () => {
  // As TMDB really lists One Piece: most seasons have no date of their own.
  const undated = ctxOf({ title: 'One Piece', keys: ['One Piece'], continuous: true, seasons: [61, 16, 14, 39], year: 1999,
    years: [1999, null, null, 2016], entries: [[['One Piece'], null]] });
  assert.equal(place('[ASW] One Piece (2001) - 62 [1080p].mkv', undated), 'S2E62', 'between 1999 and 2016');
  assert.equal(place('[ASW] One Piece (2023) - 62 [1080p].mkv', undated), null, 'long after the next dated season');
  assert.equal(place('One Piece (2023) Season 1 S01 (1080p NF WEB-DL x265 HEVC 10bit EAC3 Atmos 5.1 Garshasp) [QxR]', undated), null, 'the live-action series');
});

test('One Piece season 1: the anime’s batch, never the live-action season', async () => {
  const cat = [
    nyaa('One Piece (2023) Season 1 S01 (1080p NF WEB-DL x265 HEVC 10bit EAC3 Atmos 5.1 Garshasp) [QxR]', 900, 12 * GB),
    nyaa('[Erai-raws] One Piece - 001 ~ 061 [1080p][BATCH][Multiple Subtitle]', 40, 30 * GB),
  ];
  const { deps: d, added } = deps(cat, { title: 'One Piece', aired: 61 });
  const job = await wait(startSmartJob({ type: 'tv', title: 'One Piece', season: 1, anime: onePieceReal, want: { profile: 'balanced' }, requester: 'op1' }, d));
  assert.deepEqual(added, ['[Erai-raws] One Piece - 001 ~ 061 [1080p][BATCH][Multiple Subtitle]']);
  assert.equal(job.added[0].episodes.length, 61);
});

test('an episode range (Black Clover 150-170) takes the batch with everything else switched off', async () => {
  const cat = [
    nyaa('[SubsPlease] Black Clover (01-170) (1080p) [Batch]', 412, 233 * GB),
    ...Array.from({ length: 21 }, (_, i) => nyaa(`[SubsPlease] Black Clover - ${150 + i} (1080p) [AB${i}].mkv`, 50, 1.4 * GB)),
  ];
  const trims = [];
  const { deps: d, added } = deps(cat, { title: 'Black Clover', aired: 170, have: [152],
    deps: { trimPack: async (link, season, owned) => { trims.push(owned); return null; } } });
  const range = Array.from({ length: 21 }, (_, i) => 150 + i);
  const job = await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, episodes: range, range: true, anime: clover, want: { profile: 'balanced' }, requester: 'bcr' }, d));
  assert.deepEqual(added, ['[SubsPlease] Black Clover (01-170) (1080p) [Batch]']);
  assert.equal(trims[0].has(1) && trims[0].has(149) && trims[0].has(152), true, 'outside the range and owned: switched off');
  assert.equal(trims[0].has(150), false);
  assert.deepEqual(job.added[0].episodes, range.filter((e) => e !== 152));
  assert.equal(job.outcome, 'started');
});

test('retrying unavailable episodes (no range) still goes episode by episode', async () => {
  const cat = [
    nyaa('[SubsPlease] Black Clover (01-170) (1080p) [Batch]', 412, 233 * GB),
    ...[10, 11, 12].map((e) => nyaa(`[SubsPlease] Black Clover - ${e} (1080p) [CD${e}].mkv`, 50, 1.4 * GB)),
  ];
  const { deps: d, added } = deps(cat, { title: 'Black Clover', aired: 170 });
  await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, episodes: [10, 11, 12], anime: clover, want: { profile: 'balanced' }, requester: 'bcu' }, d));
  assert.equal(added.length, 3);
  assert.ok(added.every((n) => !/Batch/.test(n)));
});

test('One Piece season 21 (episodes 892-1088 on TMDB): a 892-1088 batch covers it', async () => {
  const cat = [nyaa('[Erai-raws] One Piece - 892 ~ 1088 [1080p][BATCH][Multiple Subtitle]', 120, 200 * GB)];
  const { deps: d, added } = deps(cat, { title: 'One Piece', aired: 197, first: 892 });
  const job = await wait(startSmartJob({ type: 'tv', title: 'One Piece', season: 21, anime: onePieceReal, want: { profile: 'balanced' }, requester: 'op21' }, d));
  assert.deepEqual(added, ['[Erai-raws] One Piece - 892 ~ 1088 [1080p][BATCH][Multiple Subtitle]']);
  assert.equal(job.added[0].episodes.length, 197);
  assert.equal(job.added[0].episodes[0], 892);
});

test('more episodes of a batch on the server: same batch, skipped episodes back on, a rival not added', async () => {
  const here = nyaa('[Erai-raws] Black Clover (TV) - 001 ~ 170 [1080p][BATCH]', 107, 233 * GB);
  const rival = nyaa('[SubsPlease] Black Clover (01-170) (1080p) [Batch]', 412, 231 * GB);
  const reopened = [];
  const { deps: d, added } = deps([rival, here], { title: 'Black Clover', aired: 170, have: Array.from({ length: 101 }, (_, i) => 70 + i),
    deps: {
      addDownload: async ({ name }) => { added.push(name); return { existing: name === here.name }; },
      torrentsHere: async () => new Set([/btih:(\w+)/.exec(here.magnet)[1]]),
      trimPack: async () => { throw new Error('a pack on the server is never trimmed'); },
      removePack: async () => { throw new Error('a pack on the server is never removed'); },
      reopenPack: async (link, season, owned) => { reopened.push(owned); return { covered: new Set(Array.from({ length: 69 }, (_, i) => i + 1)), skipped: 0, reopened: 69 }; },
    } });
  const job = await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, anime: clover, want: { profile: 'balanced' }, requester: 'bcm' }, d));
  assert.deepEqual(added, [here.name]);
  assert.equal(reopened[0].has(70), true, 'what you have stays as it is');
  assert.equal(reopened[0].has(1), false);
  assert.equal(job.added[0].episodes.length, 69);
  assert.equal(job.outcome, 'started');
});

test('a batch on the server with nothing new is left alone, and Best Quality still looks further', async () => {
  const here = nyaa('[Erai-raws] Black Clover (TV) - 001 ~ 170 [1080p][BATCH]', 107, 233 * GB);
  const rival = nyaa('[Judas] Black Clover (01-170) (1080p) [BluRay] [Batch]', 412, 300 * GB);
  const hash = /btih:(\w+)/.exec(here.magnet)[1];
  let removed = 0;
  const empty = deps([here], { title: 'Black Clover', aired: 170, have: [],
    deps: { addDownload: async () => ({ existing: true }), torrentsHere: async () => new Set([hash]), reopenPack: async () => ({ covered: new Set(), skipped: 0 }), removePack: async () => { removed++; } } });
  await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, anime: clover, want: { profile: 'balanced' }, requester: 'bcn' }, empty.deps));
  assert.equal(removed, 0);
  const best = deps([rival, here], { title: 'Black Clover', aired: 170, have: [], deps: { torrentsHere: async () => new Set([hash]), trimPack: async () => null } });
  await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, anime: clover, want: { profile: 'best' }, requester: 'bco' }, best.deps));
  assert.equal(best.added.includes(rival.name), true);
});

test('isDualAudio: every spelling on the sites, not "Dual" in a title or a dub in another language', () => {
  for (const name of [
    '[Judas] Sousou no Frieren (Season 02) [1080p][HEVC x265 10bit][Dual-Audio]',
    '[EMBER] Frieren (2023) (Season 1) [BDRip] [1080p Dual Audio HEVC 10 bits DDP]',
    'Black.Clover.S01.1080p.BluRay.Dual-Audio.Opus.2.0.AV1-Pi13',
    'Black Clover S02E04 Day of Atonement 1080p CR WEB-DL DUAL AAC2.0 H.264-VARYG',
    'Some.Show.S01.1080p.DualAudio.x265',
    'D:\\media\\[DB] Some Show [Dual Audio 10bit 1080p]\\Episode 01.mkv',
    '[Judas] Show [Dual-Audio][Subs: German, French]',
  ]) assert.equal(isDualAudio(name), true, name);
  for (const name of [
    '[SubsPlease] Black Clover (01-170) (1080p) [Batch]',
    '[Group] Dual Parallel Trouble Adventure - 01 (1080p)',
    'Your Name 2016 1080p Dual Audio Hindi English',
    'Show S01 1080p German Dual Audio',
    '',
  ]) assert.equal(isDualAudio(name), false, name);
});

test('Dubbed: searches ask for dual audio and only a dual-audio batch is added', async () => {
  const cat = [
    nyaa('[SubsPlease] Black Clover (01-170) (1080p) [Batch]', 412, 233 * GB),
    nyaa('Black.Clover.S01.1080p.BluRay.Dual-Audio.Opus.2.0.AV1-Pi13', 40, 90 * GB),
    nyaa('[Group] Black Clover (01-170) (1080p) [Dual Audio Hindi] [Batch]', 900, 90 * GB),
  ];
  const { deps: d, added } = deps(cat, { title: 'Black Clover', aired: 170 });
  const queries = [];
  const plain = d.searchTorrents;
  d.searchTorrents = (q, t) => { queries.push(q); return plain(q, t); };
  const job = await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, anime: clover, dub: true, want: { profile: 'balanced' }, requester: 'dub1' }, d));
  assert.deepEqual(added, ['Black.Clover.S01.1080p.BluRay.Dual-Audio.Opus.2.0.AV1-Pi13']);
  assert.equal(job.outcome, 'started');
  assert.ok(queries.length && queries.every((q) => /\bdual$/.test(q)), queries.join(' | '));
});

test('Dubbed: no dual-audio release means nothing is added and it says so, never a subtitled copy', async () => {
  const cat = [nyaa('[SubsPlease] Black Clover (01-170) (1080p) [Batch]', 412, 233 * GB), nyaa('[SubsPlease] Black Clover - 176 (1080p) [DC022518].mkv', 2784, 1.4 * GB)];
  const { deps: d, added } = deps(cat, { title: 'Black Clover', aired: 2 });
  const job = await wait(startSmartJob({ type: 'tv', title: 'Black Clover', season: 1, anime: clover, dub: true, want: { profile: 'balanced' }, requester: 'dub2' }, d));
  assert.deepEqual(added, []);
  assert.equal(job.outcome, 'none');
  assert.match(job.message, /dual-audio/);
});

test('Dubbed and subtitled requests of one season are separate jobs', async () => {
  const { deps: d } = deps([], { title: 'Black Clover', aired: 1 });
  const spec = { type: 'tv', title: 'Black Clover', season: 1, anime: clover, want: {}, requester: 'dub3' };
  const a = startSmartJob(spec, d), b = startSmartJob({ ...spec, dub: true }, d);
  assert.notEqual(a, b);
  await wait(a); await wait(b);
});

test('versions: a dual-audio copy is its own version beside a subtitled one in the same quality', () => {
  const sub = versionInfo({ file: '[SubsPlease] Frieren - 01 (1080p WEB).mkv', full: 'D:\\media\\[SubsPlease] Frieren\\[SubsPlease] Frieren - 01 (1080p WEB).mkv' });
  const dub = versionInfo({ file: 'Frieren - 01 (1080p WEB).mkv', full: 'D:\\media\\[Judas] Frieren [Dual-Audio]\\Frieren - 01 (1080p WEB).mkv' });
  assert.notEqual(sub.versionSignature, dub.versionSignature);
  assert.equal(dub.versionDubbed, true);
  assert.equal(sub.versionDubbed, undefined);
  assert.match(dub.versionLabel, /Dual audio/);
});
