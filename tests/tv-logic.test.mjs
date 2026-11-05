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
