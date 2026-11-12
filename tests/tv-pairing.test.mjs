import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTvPairing, normalCode, PAIR_TTL_MS } from '../src/tv.js';
import { createAuth, TV_HEADER, SESSION_HEADER } from '../src/auth.js';

const fakeReq = ({ ip = '192.168.1.20', headers = {}, method = 'GET' } = {}) => ({ method, headers: { host: '192.168.1.5:8080', ...headers }, socket: { remoteAddress: ip } });
const fakeRes = () => ({ setHeader() {} });

test('a TV code is approved once, hands its grant over once, and expires', () => {
  let t = 1_000_000;
  const pairing = createTvPairing({ now: () => t });
  const { code, poll } = pairing.start();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.deepEqual(pairing.poll(poll), { state: 'waiting' });
  assert.deepEqual(pairing.poll('wrong'), { state: 'expired' });
  let made = 0;
  pairing.approve('u1', ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `, () => { made++; return { token: 'tok', name: 'Anna' }; });
  assert.equal(made, 1);
  assert.deepEqual(pairing.poll(poll), { state: 'approved', grant: { token: 'tok', name: 'Anna' } });
  assert.deepEqual(pairing.poll(poll), { state: 'expired' }, 'the token is handed over once');
  assert.throws(() => pairing.approve('u1', code, () => ({})), { status: 404 }, 'a used code is gone');

  const late = pairing.start();
  t += PAIR_TTL_MS + 1;
  assert.deepEqual(pairing.poll(late.poll), { state: 'expired' });
  assert.throws(() => pairing.approve('u1', late.code, () => ({})), { status: 404 });
});

test('wrong codes never create a session and too many in a row wait', () => {
  const pairing = createTvPairing();
  const { code } = pairing.start();
  let made = 0;
  for (let i = 0; i < 8; i++) assert.throws(() => pairing.approve('u2', 'ZZZZZZ', () => { made++; }), { status: 404 });
  assert.throws(() => pairing.approve('u2', code, () => { made++; }), { status: 429 });
  assert.equal(made, 0);
  pairing.approve('u3', code, () => { made++; return {}; }); // someone else is unaffected
  assert.equal(made, 1);
  assert.equal(normalCode('ab-c 2d3'), 'ABC2D3');
});

test('a paired TV signs in with its header session and may POST without an Origin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-tv-'));
  const auth = createAuth({ dataDir: dir, homeNetworkAccess: 'signin' });
  try {
    const token = auth.createSession(fakeReq(), 'Anna@Example.com', 'Lilin TV app');
    const req = fakeReq({ headers: { [SESSION_HEADER]: token } });
    auth.identify(req);
    assert.equal(req.auth.via, 'session');
    assert.equal(req.auth.email, 'anna@example.com');
    const bad = fakeReq({ headers: { [SESSION_HEADER]: 'x'.repeat(40) } });
    auth.identify(bad);
    assert.equal(bad.auth.via, null);
    assert.throws(() => auth.createSession(fakeReq(), null, 'tv'), { status: 400 });

    // The TV app's pages have Origin "null"; its marker header is what lets the POST through.
    assert.throws(() => auth.guard(fakeReq({ method: 'POST', headers: { origin: 'null' } }), fakeRes()), { status: 403 });
    assert.doesNotThrow(() => auth.guard(fakeReq({ method: 'POST', headers: { origin: 'null', [TV_HEADER]: '1' } }), fakeRes()));
    // The host check (DNS rebinding) still applies to it.
    assert.throws(() => auth.guard(fakeReq({ method: 'POST', headers: { host: 'evil.example.net', [TV_HEADER]: '1' } }), fakeRes()), { status: 421 });
  } finally {
    auth.store.db.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
