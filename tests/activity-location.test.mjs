import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locationOf, initActivity, seen, record, report } from '../activity.js';

test('activity stores city/country alongside device, without an external geolocation lookup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-activity-'));
  initActivity({ dataDir: dir });
  const req = { headers: { 'cf-connecting-ip': '192.0.2.1', 'cf-ray': 'test', 'cf-ipcity': 'M%C3%BCnchen', 'cf-ipcountry': 'DE',
    'cf-access-authenticated-user-email': 'test@example.test', 'user-agent': 'Windows Chrome/100' } };
  assert.deepEqual(locationOf(req), { city: 'München', country: 'DE' });
  seen(req); record(req, 'play', 'Test film');
  assert.deepEqual(report().people[0].location, { city: 'München', country: 'DE' });
  assert.equal(report().events[0].device, 'Windows · Chrome');
  initActivity({ dataDir: dir });
  assert.equal(report().people[0].location.city, 'München', 'Stored locations survive restart');
  assert.equal(locationOf({ headers: {} }), null);
  assert.equal(locationOf({ headers: { 'cf-connecting-ip': '192.0.2.1', 'cf-ray': 'test', 'cf-ipcountry': 'XX' } }), null);
});
