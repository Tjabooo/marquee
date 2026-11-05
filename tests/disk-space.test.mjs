import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GB, freeBytes, pickEvictions, sameDrive } from '../src/disk-space.js';

const copies = [
  { name: 'new.mp4', size: 10 * GB, used: 300 },
  { name: 'old.mp4', size: 10 * GB, used: 100 },
  { name: 'mid.mp4', size: 10 * GB, used: 200 },
];

test('nothing is deleted when the new copy fits', () => {
  assert.deepEqual(pickEvictions(copies, { need: 5 * GB, maxBytes: 100 * GB, free: 500 * GB, minFree: 20 * GB }), { names: [], fits: true });
});

test('the cap deletes the copies watched longest ago first', () => {
  const r = pickEvictions(copies, { need: 15 * GB, maxBytes: 40 * GB, free: 500 * GB });
  assert.deepEqual(r, { names: ['old.mp4'], fits: true });
});

test('a nearly full drive deletes copies until MIN_FREE_GB is left', () => {
  const r = pickEvictions(copies, { need: 10 * GB, free: 15 * GB, minFree: 20 * GB });
  assert.deepEqual(r, { names: ['old.mp4', 'mid.mp4'], fits: true });
});

test('copies watched recently are kept, and the job waits', () => {
  const r = pickEvictions(copies, { need: 10 * GB, free: 15 * GB, minFree: 20 * GB, keepSince: 150 });
  assert.deepEqual(r, { names: ['old.mp4'], fits: false });
});

test('deleting copies on another drive does not count as freeing space', () => {
  const r = pickEvictions(copies, { need: 10 * GB, free: 15 * GB, minFree: 20 * GB, sameDrive: false });
  assert.deepEqual(r, { names: [], fits: false });
});

test('an output outside the folder does not count against its cap', () => {
  assert.deepEqual(pickEvictions(copies, { need: 50 * GB, inFolder: false, maxBytes: 40 * GB }), { names: [], fits: true });
});

test('trimming with no new copy only enforces the cap', () => {
  assert.deepEqual(pickEvictions(copies, { maxBytes: 25 * GB }), { names: ['old.mp4'], fits: true });
  assert.deepEqual(pickEvictions(copies, { maxBytes: 0 }), { names: [], fits: true });
});

test('freeBytes and sameDrive read the real file system', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-space-'));
  try {
    fs.mkdirSync(path.join(dir, 'a'));
    assert.ok((await freeBytes(dir)) > 0);
    assert.equal(await freeBytes(path.join(dir, 'missing')), null);
    assert.equal(sameDrive(dir, path.join(dir, 'a')), true);
    assert.equal(sameDrive(dir, path.join(dir, 'missing')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
