// While someone watches, qBittorrent runs on its alternative limits; Lilin only undoes what it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPlaybackGuard } from '../src/playback-guard.js';

function fakeQbit(alt = false) {
  const calls = [];
  const qbit = async (endpoint, init = {}) => {
    calls.push(`${init.method || 'GET'} ${endpoint}`);
    if (endpoint.endsWith('/toggleSpeedLimitsMode')) alt = !alt;
    return { text: async () => (alt ? '1' : '0') };
  };
  return { qbit, calls, alt: () => alt };
}

test('turns the alternative limits on while watching and off once idle', async () => {
  process.env.PLAYBACK_IDLE_SECONDS = '0';
  const q = fakeQbit(false);
  let watching = true;
  const g = startPlaybackGuard({ watching: () => watching, qbit: q.qbit, log: () => {} });
  await g.round();
  assert.equal(q.alt(), true);
  assert.equal(g.state().limited, true);
  await g.round();
  assert.equal(q.calls.filter((c) => c.startsWith('POST')).length, 1, 'no second toggle while still watching');
  watching = false;
  await new Promise((r) => setTimeout(r, 5));
  await g.round();
  assert.equal(q.alt(), false);
  g.stop();
});

test('leaves limits alone that were already on', async () => {
  process.env.PLAYBACK_IDLE_SECONDS = '0';
  const q = fakeQbit(true);
  let watching = true;
  const g = startPlaybackGuard({ watching: () => watching, qbit: q.qbit, log: () => {} });
  await g.round();
  watching = false;
  await new Promise((r) => setTimeout(r, 5));
  await g.round();
  assert.equal(q.alt(), true);
  assert.ok(!q.calls.some((c) => c.startsWith('POST')));
  g.stop();
});

test('restores full speed after a restart that happened mid-film', async () => {
  process.env.PLAYBACK_IDLE_SECONDS = '0';
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ qbitAlt: true }));
  const q = fakeQbit(true);
  const g = startPlaybackGuard({ watching: () => false, qbit: q.qbit, stateFile, log: () => {} });
  await g.round();
  assert.equal(q.alt(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { qbitAlt: false });
  g.stop();
});

test('QBIT_PLAYBACK_LIMITS=off does nothing', async () => {
  process.env.QBIT_PLAYBACK_LIMITS = 'off';
  const q = fakeQbit(false);
  const g = startPlaybackGuard({ watching: () => true, qbit: q.qbit, log: () => {} });
  await g.round();
  assert.equal(q.calls.length, 0);
  g.stop();
  delete process.env.QBIT_PLAYBACK_LIMITS;
});
