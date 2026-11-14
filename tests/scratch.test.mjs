import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scratchPlan, liveRoot, usesScratch } from '../src/scratch.js';

const GiB = 1024 ** 3;
const S = path.resolve('/scratch'), M = path.resolve('/media/TV');
const t = (o) => ({ hash: o.hash, save_path: M, download_path: '', content_path: path.join(M, o.hash), progress: 0.01,
  amount_left: o.size ?? 10 * GiB, size: 10 * GiB, completed: 0, state: 'queuedDL', added_on: 1, auto_tmm: false, ...o });

test('downloads that fit go to the scratch drive, oldest first, within the reserve', () => {
  const plan = scratchPlan({ scratchDir: S, freeBytes: 100 * GiB, reserveBytes: 40 * GiB, torrents: [
    t({ hash: 'a', size: 30 * GiB, amount_left: 30 * GiB, added_on: 2 }),
    t({ hash: 'b', size: 25 * GiB, amount_left: 25 * GiB, added_on: 1 }),
    t({ hash: 'c', size: 20 * GiB, amount_left: 20 * GiB, added_on: 3 }),
  ] });
  assert.deepEqual(plan.toScratch, ['b', 'a']); // 25 + 30 fit in 60; c (20) no longer does
  assert.deepEqual(plan.toMedia, []);
});

test('what is already on the scratch drive counts against the room', () => {
  const plan = scratchPlan({ scratchDir: S, freeBytes: 100 * GiB, reserveBytes: 40 * GiB, otherReserved: 5 * GiB, torrents: [
    t({ hash: 'on', download_path: S, content_path: path.join(S, 'on'), amount_left: 40 * GiB, size: 50 * GiB }),
    t({ hash: 'new', size: 16 * GiB }),
    t({ hash: 'small', size: 10 * GiB }),
  ] });
  assert.deepEqual(plan.toScratch, ['small']); // 100 - 40 left - 40 reserve - 5 conversions = 15
});

test('finished, stopped, managed and half-done downloads stay where they are', () => {
  const plan = scratchPlan({ scratchDir: S, freeBytes: 500 * GiB, reserveBytes: 40 * GiB, torrents: [
    t({ hash: 'done', progress: 1, amount_left: 0 }),
    t({ hash: 'stopped', state: 'stoppedDL' }),
    t({ hash: 'meta', state: 'metaDL', size: 0 }),
    t({ hash: 'auto', auto_tmm: true }),
    t({ hash: 'half', completed: 5 * GiB }),
    t({ hash: 'barely-started', completed: 50 * 1024 ** 2 }), // 50 MB in, but a move copies all 10 GB
    t({ hash: 'downloading', state: 'downloading' }), // could start writing before the move: stays
    t({ hash: 'other', download_path: path.resolve('/elsewhere') }),
    t({ hash: 'ok' }),
  ] });
  assert.deepEqual(plan.toScratch, ['ok']);
});

test('a scratch drive running low sends the largest unfinished download back', () => {
  const plan = scratchPlan({ scratchDir: S, freeBytes: 30 * GiB, reserveBytes: 40 * GiB, torrents: [
    t({ hash: 'x', download_path: S, content_path: path.join(S, 'x'), amount_left: 2 * GiB }),
    t({ hash: 'y', download_path: S, content_path: path.join(S, 'y'), amount_left: 9 * GiB }),
    t({ hash: 'new', size: 1 * GiB }),
  ] });
  assert.deepEqual(plan, { toScratch: [], toMedia: ['y'], room: 0 });
});

test('liveRoot follows the files: download path while there, save path after the move', () => {
  const on = t({ hash: 'z', download_path: S, content_path: path.join(S, 'Show.S01') });
  assert.equal(liveRoot(on), S);
  assert.equal(usesScratch(on, S), true);
  assert.equal(liveRoot({ ...on, content_path: path.join(M, 'Show.S01') }), M); // moved, setting still there
  assert.equal(liveRoot(t({ hash: 'w' })), M);
});

test('a torrent whose move is still queued is not planned twice, and its full size is promised', () => {
  const plan = scratchPlan({ scratchDir: S, freeBytes: 100 * GiB, reserveBytes: 40 * GiB, arriving: new Set(['q']), torrents: [
    t({ hash: 'q', size: 50 * GiB, amount_left: 49 * GiB }), // queued: download_path not reported yet
    t({ hash: 'small', size: 9 * GiB }),
    t({ hash: 'big', size: 11 * GiB }),
  ] });
  assert.deepEqual(plan.toScratch, ['small']); // 100 - 50 queued - 40 reserve = 10
});

test('while one download is being sent back, no other one follows it', () => {
  const plan = scratchPlan({ scratchDir: S, freeBytes: 30 * GiB, reserveBytes: 40 * GiB, leaving: new Set(['y']), torrents: [
    t({ hash: 'x', download_path: S, content_path: path.join(S, 'x'), amount_left: 2 * GiB }),
    t({ hash: 'y', download_path: S, content_path: path.join(S, 'y'), amount_left: 9 * GiB }),
  ] });
  assert.deepEqual(plan.toMedia, []);
});

test('space already taken by downloads on the drive does not count twice as running low', () => {
  // 48 GB free after the files took their space; 46 GB still to download into that space.
  const plan = scratchPlan({ scratchDir: S, freeBytes: 48 * GiB, reserveBytes: 10 * GiB, torrents: [
    t({ hash: 'bb', download_path: S, content_path: path.join(S, 'bb'), size: 40 * GiB, amount_left: 38 * GiB }),
    t({ hash: 'om', download_path: S, content_path: path.join(S, 'om'), size: 17 * GiB, amount_left: 8 * GiB }),
  ] });
  assert.deepEqual(plan.toMedia, []);
});
