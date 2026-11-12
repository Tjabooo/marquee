import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { torrentsEnabled, searchTorrents, magnetFor1337x } from '../src/torrents.js';

test('built-in public index lookup remains off regardless of configuration', async () => {
  assert.equal(torrentsEnabled(), false);
  await assert.rejects(() => searchTorrents('Example Movie', 'movie'), /not available|turned off/i);
  await assert.rejects(() => magnetFor1337x('/torrent/1234/example'), /unavailable/i);
});

test('app retains manual authorized import and does not expose public torrent search UI', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Add authorized download/);
  assert.match(app, /\/api\/downloads\/add/);
  assert.match(app, /Only add media you have permission/);
});
