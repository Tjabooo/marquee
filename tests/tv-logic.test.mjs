import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// public/tv/logic.js is a plain script for the TV's old browser engine; run it the way the TV does.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(new URL('../public/tv/logic.js', import.meta.url), 'utf8'), sandbox);
const L = sandbox.module.exports;
const plain = (x) => JSON.parse(JSON.stringify(x)); // arrays from the sandbox belong to another realm

const ep = (id, season, episode, extra = {}) => ({ id, show: 'tv-1', title: 'Show', season, episode, file: `${id}.mp4`, mediaKey: `k-${id}`, ...extra });

test('TV: next episode follows the phone rule and never skips one', () => {
  const lib = [ep('a', 1, 1), ep('b', 1, 2), ep('d', 1, 4), ep('s2', 2, 1)];
  assert.equal(L.nextEpisode('a', lib, []).id, 'b');
  assert.equal(L.nextEpisode('b', lib, []), null, 'episode 3 is missing');
  assert.equal(L.nextEpisode('d', lib, [{ id: 'tv-1', seasons: [{ number: 1, total: 4 }] }]).id, 's2');
  assert.equal(L.nextEpisode('d', lib, [{ id: 'tv-1', seasons: [{ number: 1, total: 5 }] }]), null);
  assert.equal(L.nextEpisode('a', [ep('a', 1, 1), ep('b', 1, 2, { converting: true })], []), null);
});

test('TV: Up next waits for the credits or the end, Skip intro only inside the intro', () => {
  assert.equal(L.isNextTime(1239, 1300, 1240, false), false);
  assert.equal(L.isNextTime(1240, 1300, 1240, false), true);
  assert.equal(L.isNextTime(1290, 1300, null, false), false, 'no guessed window');
  assert.equal(L.isNextTime(0, 1300, null, true), true);
  assert.equal(L.isNextTime(100, 1300, 200, false), false, 'a credits start in the first half is ignored');
  assert.equal(L.introShowing(60, { start: 60, end: 150 }), true);
  assert.equal(L.introShowing(149.5, { start: 60, end: 150 }), false);
  assert.equal(L.introShowing(60, null), false);
});

test('TV: home rows, show seasons and where a show starts', () => {
  const lib = [ep('a', 1, 2, { addedAt: 5 }), ep('b', 1, 1, { addedAt: 4 }), ep('c', 2, 1), { id: 'f', title: 'Film', season: null, mediaKey: 'k-f', addedAt: 9 }];
  const progress = { 'm:k-a': { time: 600, duration: 1300, at: 2 }, 'm:k-f': { time: 10, duration: 5000, at: 3 } };
  const rows = L.homeRows(lib, [{ id: 'tv-1', title: 'Show' }, { id: 'tv-9', title: 'Other' }], progress);
  assert.deepEqual(plain(rows.cont.map((f) => f.id)), ['a'], 'barely started (10 s) is not Continue watching');
  assert.deepEqual(plain(rows.shows.map((s) => s.id)), ['tv-1']);
  assert.deepEqual(plain(rows.films.map((f) => f.id)), ['f']);
  const seasons = L.showSeasons(lib, 'tv-1');
  assert.deepEqual(plain(seasons.map((s) => [s.number, s.episodes.map((f) => f.id)])), [[1, ['b', 'a']], [2, ['c']]]);
  assert.equal(L.startEpisode(seasons, progress, {}).id, 'a');
  assert.equal(L.startEpisode(seasons, {}, { 'm:k-a': 1 }).id, 'c', 'after the last one finished on this TV');
  assert.equal(L.startEpisode(seasons, {}, {}).id, 'b');
});

test('TV: subtitles parse from WebVTT and show at the right time', () => {
  const cues = L.parseVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\n<i>Hello</i> &amp; welcome\n\n00:01:02.250 --> 00:01:04.000 align:center\nSecond\nline\n\n1:00:00.000 --> 1:00:01.000\nLate');
  assert.equal(cues.length, 3);
  assert.equal(L.cueText(cues, 2), 'Hello & welcome');
  assert.equal(L.cueText(cues, 3.6), '');
  assert.equal(L.cueText(cues, 63), 'Second\nline');
  assert.equal(L.cueText(cues, 3600.5), 'Late');
  assert.equal(L.fmtTime(3725), '1:02:05');
  assert.equal(L.fmtTime(65), '1:05');
  assert.equal(L.titleKey({ show: 'tv-42', season: 1 }), 'tv:42');
  assert.equal(L.titleKey({ tmdbId: '7', season: null }), 'movie:7');
});

test('TV: downloads on their way join up per title and leave once they are ready', () => {
  const films = L.pendingTitles([
    { hash: 'a', mediaType: 'movie', tmdbId: 7, canonicalTitle: 'Dune', progress: 0.25, size: 100, state: 'downloading', done: false, added: 5, poster: '/p.jpg' },
    { hash: 'b', mediaType: 'movie', tmdbId: 8, canonicalTitle: 'Other person', progress: 0.5, size: 100, state: 'downloading', done: false, mine: false },
    { hash: 'c', mediaType: 'movie', tmdbId: 9, canonicalTitle: 'Finished', progress: 1, size: 100, state: 'uploading', done: true, ready: true, libraryIds: ['x'] },
    { hash: 'd', mediaType: 'tv', showId: 'tv-3', tmdbId: 3, canonicalTitle: 'House', progress: 0.5, size: 100, state: 'stalledDL', done: false, added: 9 },
    { hash: 'e', mediaType: 'tv', showId: 'tv-3', tmdbId: 3, canonicalTitle: 'House', progress: 1, size: 300, state: 'downloading', done: false, added: 2 },
    { hash: 'f', mediaType: 'movie', tmdbId: 10, canonicalTitle: 'Stuck', progress: 1, size: 100, state: 'uploading', done: true, ready: true, converting: true, libraryIds: ['y'], added: 1 },
  ]);
  assert.deepEqual(plain(films.map((p) => p.key)), ['tv:tv-3', 'movie:7', 'movie:10']);
  assert.equal(films[0].progress, 0.875);
  assert.equal(films[1].progress, 0.25);
  assert.equal(films[1].word, 'On its way');
  assert.equal(films[2].word, 'Preparing playback');
  assert.equal(L.pendingTitles(undefined).length, 0);
});

test('TV: a transfer that is stuck or paused says so', () => {
  const word = (state) => L.pendingTitles([{ hash: 'a', tmdbId: 1, mediaType: 'movie', state, progress: 0.1, size: 1, done: false }])[0].word;
  assert.equal(word('stalledDL'), 'Waiting for a source');
  assert.equal(word('pausedDL'), 'Paused');
  assert.equal(word('metaDL'), 'Starting');
  assert.equal(word('queuedDL'), 'In line');
  assert.equal(word('error'), 'Needs attention');
});

test('TV: queued episodes count in a title\'s progress, and finished ones keep it from falling back', () => {
  const ep = (hash, progress, state, extra = {}) => ({ hash, mediaType: 'tv', showId: 'name-x', canonicalTitle: 'X', season: 1, episode: 1, progress, size: 100, state, done: false, ...extra });
  const start = L.pendingTitles([ep('a', 0.5, 'downloading'), ep('b', 0, 'queuedDL'), ep('c', 0, 'queuedDL')])[0];
  assert.equal(start.progress, 0.5 / 3);
  assert.equal(start.word, '3 episodes on their way');
  const later = L.pendingTitles([ep('b', 0.5, 'downloading', { batchDone: 1 }), ep('c', 0, 'queuedDL', { batchDone: 1 })])[0];
  assert.equal(later.progress, 1.5 / 3, 'one done of three, the next half way');
  assert.equal(later.word, '1 of 3 ready');
  assert.deepEqual([later.finished, later.total], [1, 3]);
  const last = L.pendingTitles([ep('c', 0, 'queuedDL', { batchDone: 2 })])[0];
  assert.equal(last.word, '2 of 3 ready');
  assert.equal(L.pendingTitles([ep('a', 0.5, 'error'), ep('b', 0, 'queuedDL')])[0].word, 'Needs attention');
});

test('TV: a video being prepared shows how far that has come', () => {
  const p = L.pendingTitles([{ hash: 'a', mediaType: 'movie', tmdbId: 1, progress: 1, size: 100, state: 'uploading', done: false, converting: true, convertPercent: 40 }])[0];
  assert.equal(p.progress, 0.4);
  assert.equal(p.word, 'Preparing playback');
  assert.equal(L.pendingTitles([{ hash: 'a', tmdbId: 1, mediaType: 'movie', state: 'metaDL', size: 0, progress: 0, done: false }])[0].progress, null, 'nothing known yet');
});
