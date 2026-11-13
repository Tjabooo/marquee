import test from 'node:test';
import assert from 'node:assert/strict';
import { planEpisodeOrder, activeSeasons, holdSeason, TOP, NORMAL } from '../src/episode-order.js';

const file = (index, ep, progress = 0, priority = NORMAL) => ({ index, name: `Show.S01/Show.S01E${String(ep).padStart(2, '0')}.1080p.mkv`, progress, priority });
const single = (hash, ep, extra = {}) => ({ hash, name: `Show.S01E${String(ep).padStart(2, '0')}.1080p.WEB`, state: 'downloading', progress: 0, files: [{ index: 0, name: `Show.S01E${String(ep).padStart(2, '0')}.mkv`, progress: 0, priority: 1 }], ...extra });

test('a season pack gives the next unfinished episode top priority and the rest normal', () => {
  const pack = { hash: 'p', name: 'Show.S01.1080p', state: 'downloading', progress: 0.2,
    files: [file(0, 1, 1), file(1, 2, 0.4), file(2, 3), { index: 3, name: 'Show.S01/sample.mkv', progress: 0, priority: 1 }, file(4, 4, 0, 0)] };
  const plan = planEpisodeOrder({ season: 1, torrents: [pack] });
  assert.deepEqual(plan.priorities, [{ hash: 'p', ids: [1], priority: TOP }], 'E02 first; E03 already normal; skipped E04 and samples untouched');
  assert.deepEqual(plan.stop, []); assert.deepEqual(plan.running, [{ hash: 'p', episode: 2 }]);
  const next = planEpisodeOrder({ season: 1, torrents: [{ ...pack, files: [file(0, 1, 1), file(1, 2, 1, TOP), file(2, 3)] }] });
  assert.deepEqual(next.priorities, [{ hash: 'p', ids: [2], priority: TOP }], 'when E02 completes, E03 takes over');
});

test('separate episode torrents run one at a time, earliest first, and resume in turn', () => {
  const held = new Set(['b', 'c']);
  const plan = planEpisodeOrder({ season: 1, torrents: [single('c', 3), single('a', 1), single('b', 2)] });
  assert.deepEqual(plan.stop.sort(), ['b', 'c']); assert.deepEqual(plan.start, []);
  const after = planEpisodeOrder({ season: 1, torrents: [single('a', 1, { progress: 1, state: 'stoppedUP' }), single('b', 2, { state: 'stoppedDL' }), single('c', 3, { state: 'stoppedDL' })] }, held);
  assert.deepEqual(after.start, ['b']); assert.deepEqual(after.stop, []);
});

test('stalled episodes never hold up the season: three keep trying, the next healthy one runs', () => {
  const stalled = (hash, ep) => single(hash, ep, { state: 'stalledDL' });
  const plan = planEpisodeOrder({ season: 1, torrents: [stalled('a', 1), stalled('b', 2), stalled('c', 3), stalled('x', 4), single('d', 5), single('e', 6)] });
  assert.deepEqual(plan.running.map((r) => r.episode), [1, 2, 3, 5]);
  assert.deepEqual(plan.stop.sort(), ['e', 'x']);
  // x was stopped after stalling: it stays stopped instead of taking d's turn
  const held = new Set(['x', 'e']);
  const next = planEpisodeOrder({ season: 1, torrents: [stalled('a', 1), stalled('b', 2), stalled('c', 3), single('x', 4, { state: 'stoppedDL', wasStalled: true }), single('d', 5), single('e', 6, { state: 'stoppedDL' })] }, held);
  assert.deepEqual(next.running.map((r) => r.episode), [1, 2, 3, 5]); assert.deepEqual(next.start, []);
});

test('a season batch runs past stalled leftovers and goes before a separate torrent of the same episode', () => {
  // Black Clover: three stalled single episodes from an earlier try, a 170-episode batch, old held singles
  const stalled = (hash, ep) => single(hash, ep, { state: 'stalledDL' });
  const pack = { hash: 'p', name: 'Show.S01.1080p', state: 'stoppedDL', progress: 0, files: [file(0, 5), file(1, 6), file(2, 7)] };
  const plan = planEpisodeOrder({ season: 1, torrents: [stalled('a', 1), stalled('b', 3), stalled('c', 4), single('s5', 5, { state: 'stoppedDL' }), pack] }, new Set(['p', 's5']));
  assert.deepEqual(plan.running.map((r) => r.hash), ['a', 'b', 'c', 'p']);
  assert.deepEqual(plan.start, ['p']); assert.deepEqual(plan.priorities, [{ hash: 'p', ids: [0], priority: TOP }]);
});

test('torrents paused by the person or failed are left alone', () => {
  const plan = planEpisodeOrder({ season: 1, torrents: [single('a', 1, { state: 'stoppedDL' }), single('b', 2, { state: 'error' }), single('c', 3), single('d', 4)] });
  assert.deepEqual(plan.running.map((r) => r.episode), [3]);
  assert.deepEqual(plan.stop, ['d']); assert.deepEqual(plan.start, []);
});

test('a pack waits while an earlier separate episode downloads, then takes over', () => {
  const pack = { hash: 'p', name: 'Show.S01.1080p', state: 'downloading', progress: 0, files: [file(0, 2), file(1, 3)] };
  const plan = planEpisodeOrder({ season: 1, torrents: [single('e1', 1), pack] });
  assert.deepEqual(plan.stop, ['p']); assert.deepEqual(plan.running, [{ hash: 'e1', episode: 1 }]);
  const later = planEpisodeOrder({ season: 1, torrents: [single('e1', 1, { progress: 1, state: 'uploading' }), { ...pack, state: 'stoppedDL' }] }, new Set(['p']));
  assert.deepEqual(later.start, ['p']); assert.deepEqual(later.priorities, [{ hash: 'p', ids: [0], priority: TOP }]);
});

const plan = (running, healthy = true) => ({ running: running.map((hash) => ({ hash, episode: 1 })), healthy, stop: [], start: [], priorities: [] });

test('seasons of one show download one at a time, lowest first', () => {
  const seasons = [8, 5, 7, 6].map((n) => ({ season: n, wanters: ['oliver'], plan: plan([`s${n}`]) }));
  assert.deepEqual([...activeSeasons(seasons)], [5]);
  assert.deepEqual([...activeSeasons(seasons.filter((s) => s.season !== 5))], [6], 'season 5 done: 6 takes over');
});

test('two people downloading different seasons each get their earliest one running', () => {
  const seasons = [{ season: 5, wanters: ['oliver'], plan: plan(['a']) }, { season: 6, wanters: ['oliver'], plan: plan(['b']) },
    { season: 2, wanters: ['anita'], plan: plan(['c']) }, { season: 3, wanters: ['anita'], plan: plan(['d']) }];
  assert.deepEqual([...activeSeasons(seasons)].sort(), [2, 5]);
  // both want season 5: it's the only one running
  assert.deepEqual([...activeSeasons([{ season: 5, wanters: ['oliver', 'anita'], plan: plan(['a']) }, { season: 6, wanters: ['anita'], plan: plan(['b']) }])], [5]);
});

test('a stalled or unrunnable season lets the next season run', () => {
  const seasons = [{ season: 1, wanters: [], plan: plan([]) }, { season: 2, wanters: [], plan: plan(['a'], false) },
    { season: 3, wanters: [], plan: plan(['b']) }, { season: 4, wanters: [], plan: plan(['c']) }];
  assert.deepEqual([...activeSeasons(seasons)], [2, 3]);
});

test('a waiting season stops what would run and starts nothing', () => {
  const p = { running: [{ hash: 'a', episode: 1 }, { hash: 'b', episode: 2 }], start: ['b'], stop: ['c'], priorities: [{ hash: 'a', ids: [0], priority: TOP }], healthy: true };
  assert.deepEqual(holdSeason(p), { priorities: [], stop: ['c', 'a'], start: [], running: [], healthy: false });
  const real = planEpisodeOrder({ season: 1, torrents: [single('x', 1), single('y', 2)] });
  assert.equal(real.healthy, true);
  assert.deepEqual(holdSeason(real).stop.sort(), ['x', 'y']);
});
