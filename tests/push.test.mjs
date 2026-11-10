import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encrypt, decrypt, vapidAuth, makeVapidKeys, cleanSubscription, pushHostAllowed, PushStore, KINDS } from '../src/push.js';
import { pushSupport, deviceLabel, keyBytes, sameKey } from '../public/notifications.js';

// RFC 8291 appendix A: the worked example every Web Push implementation must reproduce.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}
const subscription = (keys, endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') => ({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-push-'));

test('encryption matches the RFC 8291 example byte for byte', () => {
  const out = encrypt(Buffer.from(RFC.plaintext, 'base64url'), { p256dh: RFC.uaPublic, auth: RFC.auth },
    { salt: Buffer.from(RFC.salt, 'base64url'), senderPrivateKey: RFC.asPrivate });
  assert.equal(out.toString('base64url'), RFC.message);
  assert.equal(decrypt(Buffer.from(RFC.message, 'base64url'), { privateKey: RFC.uaPrivate, auth: RFC.auth }), 'When I grow up, I want to be a watermelon');
});

test('random messages decrypt on the browser side', () => {
  const keys = browserKeys();
  const text = JSON.stringify({ title: 'Dune is ready', body: 'Tap to watch. ✨' });
  assert.equal(decrypt(encrypt(text, keys), keys), text);
  assert.throws(() => encrypt('x'.repeat(5000), keys), /too long/);
});

test('the VAPID header is an ES256 JWT for the push service origin', () => {
  const keys = makeVapidKeys();
  const now = Date.parse('2026-11-05T12:00:00Z');
  const header = vapidAuth('https://updates.push.services.mozilla.com/wpush/v2/xyz', keys, 'mailto:owner@example.com', now);
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://updates.push.services.mozilla.com');
  assert.equal(claims.exp, now / 1000 + 12 * 3600);
  assert.equal(claims.sub, 'mailto:owner@example.com');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const verifyKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('only known push services and complete keys are accepted', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QH', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.ok(pushHostAllowed(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://192.168.1.10/x', 'https://localhost/x', 'https://evil-fcm.googleapis.com.example/x',
    'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'not a url']) assert.ok(!pushHostAllowed(bad), bad);
  const keys = browserKeys();
  assert.doesNotThrow(() => cleanSubscription(subscription(keys)));
  assert.throws(() => cleanSubscription(subscription(keys, 'https://router.local/push')), /isn’t supported/);
  assert.throws(() => cleanSubscription({ ...subscription(keys), keys: { p256dh: keys.p256dh, auth: 'short' } }), /incomplete/);
  assert.throws(() => cleanSubscription({ ...subscription(keys), keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: keys.auth } }), /incomplete/);
});

test('the store keeps its key, devices per person, and sends encrypted messages', async () => {
  const dir = tmp();
  const sent = [];
  let reply = 201;
  const fetch = async (url, opts) => { sent.push({ url, opts }); return new Response(null, { status: reply }); };
  const store = new PushStore(dir, { fetch, log: { warn() {} } });
  const key = store.publicKey();
  assert.equal(new PushStore(dir).publicKey(), key, 'the VAPID key survives a restart');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.marquee-push.json')).mode & 0o077, 0, 'the key file is private'); // Windows has no mode bits

  const phone = browserKeys(), laptop = browserKeys();
  const id = store.subscribe(1, subscription(phone, 'https://fcm.googleapis.com/fcm/send/phone'), 'Chrome on Android');
  store.subscribe(1, subscription(laptop, 'https://updates.push.services.mozilla.com/wpush/v2/laptop'), 'Firefox on Linux');
  assert.equal(store.subscribe(1, subscription(phone, 'https://fcm.googleapis.com/fcm/send/phone')), id, 're-registering changes nothing');
  assert.deepEqual(store.devices(1).map((d) => d.label), ['Chrome on Android', 'Firefox on Linux']);
  assert.deepEqual(store.devices(2), []);

  assert.equal(await store.send([1], 'download', { title: 'Dune is ready', body: 'Tap to watch.', url: '/#library', tag: 'download-abc' }), 2);
  const phoneMsg = sent.find((s) => s.url.endsWith('/phone'));
  assert.equal(phoneMsg.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(phoneMsg.opts.headers.TTL, '86400');
  assert.match(phoneMsg.opts.headers.Authorization, /^vapid t=.+, k=/);
  assert.match(phoneMsg.opts.headers.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.deepEqual(JSON.parse(decrypt(phoneMsg.opts.body, phone)), { title: 'Dune is ready', body: 'Tap to watch.', url: '/#library', tag: 'download-abc', kind: 'download' });

  // Links stay on this server; an invite is urgent and short-lived.
  sent.length = 0;
  await store.send([1], 'watch', { title: 'Join', url: 'https://elsewhere.example/' });
  assert.equal(JSON.parse(decrypt(sent[0].opts.body, sent[0].url.endsWith('/phone') ? phone : laptop)).url, '/');
  assert.equal(sent[0].opts.headers.Urgency, 'high');
  assert.equal(sent[0].opts.headers.TTL, '600');

  // A subscription the browser dropped (410) is forgotten.
  reply = 410;
  assert.equal(await store.send([1], 'download', { title: 'x' }), 0);
  assert.deepEqual(store.devices(1), []);
  assert.deepEqual(new PushStore(dir).devices(1), []);
});

test('a device moves to whoever subscribes it, can be removed, and people are capped at ten', () => {
  const store = new PushStore(tmp(), { fetch: async () => new Response(null, { status: 201 }) });
  const keys = browserKeys();
  const id = store.subscribe(1, subscription(keys));
  store.subscribe(2, subscription(keys));
  assert.deepEqual(store.devices(1), []);
  assert.equal(store.devices(2).length, 1);
  assert.equal(store.unsubscribe(1, { id: store.devices(2)[0].id }), 0, 'nobody removes someone else’s device');
  assert.equal(store.unsubscribe(2, { endpoint: subscription(keys).endpoint }), 1);
  assert.ok(id);
  for (let i = 0; i < 12; i++) store.subscribe(3, subscription(browserKeys(), `https://fcm.googleapis.com/fcm/send/d${i}`), `Device ${i}`);
  assert.equal(store.devices(3).length, 10);
  assert.ok(!store.devices(3).some((d) => d.label === 'Device 0'), 'the oldest went first');
  // A renewed subscription (pushsubscriptionchange) replaces the old one and keeps its name.
  const renewed = browserKeys();
  store.subscribe(3, subscription(renewed, 'https://fcm.googleapis.com/fcm/send/new'), '', 'https://fcm.googleapis.com/fcm/send/d11');
  assert.equal(store.devices(3).length, 10);
  assert.ok(store.devices(3).some((d) => d.label === 'Device 11'));
  store.forgetUser(3);
  assert.deepEqual(store.devices(3), []);
  assert.deepEqual(Object.keys(KINDS), ['download', 'episode', 'watch', 'agent', 'update']);
});

test('the page knows when this browser can get notifications', () => {
  const env = (o = {}) => ({ isSecureContext: true, PushManager: function () {}, Notification: { permission: 'default' },
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0', serviceWorker: {} }, matchMedia: () => ({ matches: false }), ...o });
  assert.equal(pushSupport(env()), 'ok');
  assert.equal(pushSupport(env({ isSecureContext: false })), 'insecure');
  assert.equal(pushSupport(env({ Notification: { permission: 'denied' } })), 'denied');
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1', serviceWorker: {} };
  const safari = env({ navigator: iphone }); delete safari.PushManager;
  assert.equal(pushSupport(safari), 'ios-install');
  assert.equal(pushSupport(env({ navigator: { ...iphone, standalone: true } })), 'ok');
  assert.equal(deviceLabel(iphone.userAgent), 'iPhone');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0'), 'Edge on Windows');
  assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox on Linux');
  const key = makeVapidKeys().publicKey;
  assert.deepEqual([...keyBytes(key)], [...Buffer.from(key, 'base64url')]);
  assert.ok(sameKey({ options: { applicationServerKey: keyBytes(key).buffer } }, key));
  assert.ok(!sameKey({ options: { applicationServerKey: keyBytes(makeVapidKeys().publicKey).buffer } }, key));
});
