import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTrust, parseProxies, matches } from '../src/trust.js';

const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers: { ...headers } });
const ID = 'cf-access-authenticated-user-email';

test('proxy lists accept addresses and CIDR ranges and report bad entries', () => {
  const { rules, invalid } = parseProxies('127.0.0.1, ::1, 172.16.0.0/12, fd00::/8, nonsense, 10.0.0.0/33');
  assert.deepEqual(invalid, ['nonsense', '10.0.0.0/33']);
  assert.ok(matches(rules, '::ffff:127.0.0.1'));
  assert.ok(matches(rules, '::1'));
  assert.ok(matches(rules, '172.20.1.5'));
  assert.ok(!matches(rules, '172.32.0.1'));
  assert.ok(matches(rules, 'fd12:3456::1'));
  assert.ok(!matches(rules, '192.168.1.20'));
  assert.ok(!matches(rules, 'garbage'));
});

test('identity and proxy headers from an untrusted address are removed', async () => {
  const trust = createTrust({ trustedProxies: '127.0.0.1,::1' });
  const spoof = req('192.168.1.20', { [ID]: 'owner@example.com', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'x', 'x-forwarded-proto': 'https', 'user-agent': 'ua' });
  await trust.sanitize(spoof);
  assert.equal(spoof.headers[ID], undefined);
  assert.equal(spoof.headers['cf-connecting-ip'], undefined);
  assert.equal(spoof.headers['cf-ray'], undefined);
  assert.equal(spoof.headers['x-forwarded-proto'], undefined);
  assert.equal(spoof.headers['user-agent'], 'ua');

  const proxied = req('::ffff:127.0.0.1', { [ID]: 'owner@example.com', 'cf-connecting-ip': '203.0.113.9' });
  await trust.sanitize(proxied);
  assert.equal(proxied.headers[ID], 'owner@example.com');
  assert.equal(proxied.headers['cf-connecting-ip'], '203.0.113.9');
});

test('an empty TRUSTED_PROXIES trusts nobody', async () => {
  const trust = createTrust({ trustedProxies: '' });
  const r = req('127.0.0.1', { [ID]: 'owner@example.com' });
  await trust.sanitize(r);
  assert.equal(r.headers[ID], undefined);
});

function accessFixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  let certFetches = 0;
  const fetchImpl = async (url) => {
    certFetches++;
    assert.equal(url, 'https://team.cloudflareaccess.com/cdn-cgi/access/certs');
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload, { kid = 'k1', key = privateKey } = {}) => {
    const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
    const body = enc(payload);
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { aud: ['aud123'], iss: 'https://team.cloudflareaccess.com', email: 'Member@Example.com', exp: now + 600, iat: now };
  const trust = createTrust({ trustedProxies: '127.0.0.1', teamDomain: 'team.cloudflareaccess.com', audience: 'aud123', fetchImpl });
  return { trust, sign, good, fetches: () => certFetches };
}

test('with Access verification, the email comes from a valid token only', async () => {
  const { trust, sign, good, fetches } = accessFixture();
  assert.equal(trust.mode, 'access-jwt');

  const ok = req('172.18.0.5', { 'cf-access-jwt-assertion': sign(good), [ID]: 'someone-else@example.com' });
  await trust.sanitize(ok);
  assert.equal(ok.headers[ID], 'member@example.com');

  const viaCookie = req('172.18.0.5', { cookie: `a=b; CF_Authorization=${sign(good)}` });
  await trust.sanitize(viaCookie);
  assert.equal(viaCookie.headers[ID], 'member@example.com');

  for (const bad of [
    sign({ ...good, aud: ['other'] }),
    sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }),
    sign({ ...good, exp: Math.floor(Date.now() / 1000) - 3600 }),
    sign(good, { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }),
    sign(good).replace(/\.[^.]+\./, `.${Buffer.from(JSON.stringify({ ...good, email: 'owner@example.com' })).toString('base64url')}.`),
    'not.a.jwt',
  ]) {
    const r = req('127.0.0.1', { 'cf-access-jwt-assertion': bad, [ID]: 'owner@example.com' });
    await trust.sanitize(r);
    assert.equal(r.headers[ID], undefined, bad.slice(0, 30));
  }
  // Even a trusted proxy can't vouch for an email without a token once verification is on.
  const bare = req('127.0.0.1', { [ID]: 'owner@example.com' });
  await trust.sanitize(bare);
  assert.equal(bare.headers[ID], undefined);
  assert.ok(fetches() <= 2, 'certs are cached, and unknown keys refetch at most once a minute');
});

test('an unknown key id does not trigger a certs fetch per request', async () => {
  const { trust, sign, good, fetches } = accessFixture();
  for (let i = 0; i < 5; i++) await trust.sanitize(req('127.0.0.1', { 'cf-access-jwt-assertion': sign(good, { kid: 'unknown' }) }));
  assert.ok(fetches() <= 2);
});
