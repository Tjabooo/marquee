import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { downloadDestination, downloadFilePath } from '../download-paths.js';

const root = path.resolve('media-root');

test('categorized downloads go to Movies or TV', () => {
  assert.equal(downloadDestination(root, { film: { id: 123 } }), path.join(root, 'Movies'));
  assert.equal(downloadDestination(root, { mediaType: 'movie' }), path.join(root, 'Movies'));
  assert.equal(downloadDestination(root, { mediaType: 'tv' }), path.join(root, 'TV'));
});

test('TV release names are classified, including season packs', () => {
  for (const name of ['House.M.D.S02E01.1080p', 'House.M.D.S02.COMPLETE', 'House.M.D.Season.2', 'House.M.D.2x03']) {
    assert.equal(downloadDestination(root, { name }), path.join(root, 'TV'), name);
  }
});

test('unrecognized and unspecific torrents retain the qBittorrent default', () => {
  assert.equal(downloadDestination(root, { name: 'Unidentified.Media.Release' }), null);
  assert.equal(downloadDestination(null, { mediaType: 'tv' }), null);
});

test('torrent file paths stay inside their save directory on either slash convention', () => {
  assert.equal(downloadFilePath(root, 'Show/episode.mp4'), path.join(root, 'Show', 'episode.mp4'));
  assert.equal(downloadFilePath(root, 'Show\\episode.mp4'), path.join(root, 'Show', 'episode.mp4'));
  for (const name of ['../outside.mp4', '..\\outside.mp4', '/outside.mp4', 'C:\\outside.mp4', 'C:outside.mp4', '.', 'bad\0.mp4']) {
    assert.equal(downloadFilePath(root, name), null, name);
  }
});
