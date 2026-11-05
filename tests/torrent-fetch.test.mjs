import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTorrentFile, isPublicAddress, looksLikeTorrent } from '../src/torrent-fetch.js';

const torrent = Buffer.from('d8:announce3:foo4:infod4:name1:aee');
const publicLookup = async () => [{ address: '93.184.216.34' }];
const reply = (status, body = '', headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  body: (async function* () { if (body.length) yield Buffer.from(body); })(),
});

test('public and private addresses are told apart', () => {
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.67', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'nope'])
    assert.equal(isPublicAddress(ip), false, ip);
});

test('a .torrent file is downloaded and checked', async () => {
  const out = await fetchTorrentFile('https://example.com/a.torrent', { lookup: publicLookup, fetchImpl: async () => reply(200, torrent) });
  assert.deepEqual(out.file, torrent);
  assert.equal(looksLikeTorrent(Buffer.from('<html>')), false);
  await assert.rejects(fetchTorrentFile('https://example.com/a.torrent', { lookup: publicLookup, fetchImpl: async () => reply(200, '<html>hi</html>') }), /isn’t a .torrent/);
});

test('links into the local network are refused, also through redirects', async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return reply(200, torrent); };
  await assert.rejects(fetchTorrentFile('http://192.168.1.1/x.torrent', { fetchImpl }), /private network/);
  await assert.rejects(fetchTorrentFile('http://router.lan/x.torrent', { lookup: async () => [{ address: '192.168.1.1' }], fetchImpl }), /private network/);
  await assert.rejects(fetchTorrentFile('http://[::1]:8081/', { fetchImpl }), /private network/);
  await assert.rejects(fetchTorrentFile('http://[::ffff:127.0.0.1]:8081/', { fetchImpl }), /private network/);
  await assert.rejects(fetchTorrentFile('http://2130706433:8081/', { fetchImpl }), /private network/);
  assert.equal(fetched, 0);
  const redirect = async () => reply(302, '', { location: 'http://127.0.0.1:8081/api' });
  await assert.rejects(fetchTorrentFile('https://example.com/a.torrent', { lookup: async (h) => [{ address: h === 'example.com' ? '93.184.216.34' : '127.0.0.1' }], fetchImpl: redirect }), /private network/);
  await assert.rejects(fetchTorrentFile('file:///C:/x.torrent', { fetchImpl }), /Only http/);
});

test('a redirect to a magnet link is handed back', async () => {
  const out = await fetchTorrentFile('https://example.com/get', { lookup: publicLookup, fetchImpl: async () => reply(302, '', { location: 'magnet:?xt=urn:btih:abc' }) });
  assert.equal(out.magnet, 'magnet:?xt=urn:btih:abc');
});

test('oversized downloads are cut off', async () => {
  const big = async () => reply(200, Buffer.alloc(64, 0x64));
  await assert.rejects(fetchTorrentFile('https://example.com/a.torrent', { lookup: publicLookup, fetchImpl: big, maxBytes: 32 }), /too big/);
});
