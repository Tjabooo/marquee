import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import { createAndroidTv, homeAddress, isAndroidPath } from '../src/android-tv.js';
import { inLanguage } from '../src/i18n.js';

// A response that collects what was written (the APK is streamed, so wait for 'finish').
function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, e, done) { chunks.push(Buffer.from(c)); done(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.body = () => Buffer.concat(chunks).toString();
  res.done = new Promise((r) => res.on('finish', r));
  return res;
}
const fakeReq = (local = '192.168.1.5', method = 'GET') => ({ method, headers: {}, socket: { localAddress: `::ffff:${local}`, localPort: 8080 } });
const get = (tv, p, { home = true, local } = {}) => {
  const res = fakeRes();
  assert.equal(tv.handle(fakeReq(local), res, new URL(p, 'http://x'), { home }), true);
  return res;
};

test('the install page, the APK and its version, from tv/android/dist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-android-'));
  const tv = createAndroidTv({ dir, port: 8080 });
  try {
    // Nothing built yet: the page says so, the file and version aren't there.
    assert.match(get(tv, '/android').body(), /isn’t on this server yet/);
    assert.equal(get(tv, '/android.apk').status, 404);
    assert.equal(get(tv, '/android.json').status, 404);

    await fs.writeFile(path.join(dir, 'Marquee.apk'), 'PK-fake-apk');
    await fs.writeFile(path.join(dir, 'Marquee.json'), JSON.stringify({ versionCode: 3, versionName: '1.2.0', sha256: 'ab' }));
    const page = get(tv, '/android').body();
    assert.match(page, /192\.168\.1\.5:8080\/android\.apk/, 'the address to type in Downloader');
    assert.match(page, /version 1\.2\.0/);
    const info = get(tv, '/android.json');
    assert.deepEqual(JSON.parse(info.body()), { versionCode: 3, versionName: '1.2.0', size: 11, sha256: 'ab', apk: '/android.apk' });
    const apk = get(tv, '/android.apk');
    await apk.done;
    assert.equal(apk.status, 200);
    assert.equal(apk.headers['Content-Type'], 'application/vnd.android.package-archive');
    assert.equal(apk.body(), 'PK-fake-apk');

    // From outside the home network: no file (its build holds the home address), and the page says to open it at home.
    assert.equal(get(tv, '/android.apk', { home: false }).status, 404);
    assert.equal(get(tv, '/android.json', { home: false }).status, 404);
    assert.match(get(tv, '/android', { home: false }).body(), /Open this page at home/);
    assert.equal(tv.handle(fakeReq(), fakeRes(), new URL('/androids', 'http://x'), { home: true }), false);

    // The page speaks Swedish to Swedish browsers.
    await inLanguage('sv', async () => assert.match(get(tv, '/android').body(), /Hämta Downloader/));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the address a TV types is a home-network one', () => {
  assert.equal(homeAddress(fakeReq('10.0.0.4'), 9000), '10.0.0.4:8080', 'the address the page was opened on');
  const nics = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], wg0: [{ family: 'IPv4', address: '10.64.0.2', internal: false }],
    eth0: [{ family: 'IPv4', address: '192.168.50.67', internal: false }] };
  assert.equal(homeAddress(fakeReq('127.0.0.1'), 8080, nics), '192.168.50.67:8080', 'through a tunnel: the server’s LAN address');
  assert.equal(homeAddress(fakeReq('127.0.0.1'), 8080, { lo: nics.lo }), null);
  assert.ok(isAndroidPath('/android') && isAndroidPath('/android.apk') && !isAndroidPath('/android/x'));
});
