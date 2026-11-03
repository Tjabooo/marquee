import test from 'node:test';
import assert from 'node:assert/strict';
import { planEpisodeOrder, TOP, NORMAL } from '../episode-order.js';

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

test('a stalled episode lets the next one run alongside it, at most three', () => {
  const stalled = (hash, ep) => single(hash, ep, { state: 'stalledDL' });
  const plan = planEpisodeOrder({ season: 1, torrents: [stalled('a', 1), stalled('b', 2), stalled('c', 3), single('d', 4), single('e', 5)] });
  assert.deepEqual(plan.running.map((r) => r.episode), [1, 2, 3]);
  assert.deepEqual(plan.stop.sort(), ['d', 'e']);
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
