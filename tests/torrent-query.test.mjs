import test from 'node:test';
import assert from 'node:assert/strict';
import { torrentQueryAllowed } from '../src/torrents.js';

test('torrent search allows one-digit titles but still rejects useless one-letter queries', () => {
  assert.equal(torrentQueryAllowed('9'), true);
  assert.equal(torrentQueryAllowed('0'), true);
  assert.equal(torrentQueryAllowed('a'), false);
  assert.equal(torrentQueryAllowed(''), false);
  assert.equal(torrentQueryAllowed('9 2009'), true);
});
