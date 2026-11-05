// Notifications: Web Push straight from Marquee, still with no dependencies. The browser gives us a
// push subscription (an endpoint at its vendor's push service plus two keys); to notify someone we
// encrypt a small JSON message for that browser (RFC 8291, aes128gcm) and POST it to the endpoint,
// signed with the server's VAPID key (RFC 8292, ES256 JWT). Everything is node:crypto.
//
// Kept in DATA_DIR/.marquee-push.json (mode 600, it holds the private key):
//   vapid  the server's P-256 key pair, made on first start; browsers subscribe to its public half
//   subs   one entry per device that turned notifications on: who it belongs to and its keys
//
// What a person hears about is switchable per kind in their settings (accounts.js): KINDS below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// kind -> the user setting that switches it (all on by default)
export const KINDS = { download: 'pushDownload', episode: 'pushEpisode', watch: 'pushWatch' };
const TTL = { download: 86400, episode: 2 * 86400, watch: 600, test: 600 }; // an invite is stale after a few minutes
const URGENCY = { watch: 'high' };
const MAX_DEVICES = 10; // per person; the oldest goes first
const RECORD_SIZE = 4096;

// Endpoints must belong to a known push service, so a subscription can't make the server POST to
// anything else (a machine on the home network, say).
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, // Chrome, Edge on Android, Samsung, Opera
  /(^|\.)push\.services\.mozilla\.com$/,                        // Firefox
  /(^|\.)push\.apple\.com$/,                                     // Safari, iPhone Home Screen apps
  /(^|\.)notify\.windows\.com$/,                                 // Edge on Windows
];

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });

export function pushHostAllowed(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')
    && PUSH_HOSTS.some((re) => re.test(u.hostname.toLowerCase()));
}

// A new P-256 key pair as raw base64url: publicKey is the 65-byte uncompressed point browsers want
// as applicationServerKey, privateKey the 32-byte scalar.
export function makeVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

function vapidKeyObject({ publicKey, privateKey }) {
  const pub = unb64(publicKey);
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)), d: privateKey } });
}

// The Authorization header for one endpoint: a JWT for its origin, valid for 12 hours.
export function vapidAuth(endpoint, keys, subject, now = Date.now()) {
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(sig)}, k=${keys.publicKey}`;
}

// RFC 8291: encrypts `plaintext` for one browser. salt and the sender's ephemeral key are random;
// tests pass them in to check against the RFC's worked example.
export function encrypt(plaintext, { p256dh, auth }, { salt = crypto.randomBytes(16), senderPrivateKey = null } = {}) {
  const uaPublic = unb64(p256dh), authSecret = unb64(auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (senderPrivateKey) ecdh.setPrivateKey(unb64(senderPrivateKey)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 2 = last (and only) record
  if (data.length + 16 > RECORD_SIZE) throw fail(413, 'Notification too long.');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

// The browser's side, for tests: decrypts a message made by encrypt().
export function decrypt(message, { privateKey, auth }) {
  const salt = message.subarray(0, 16), idLen = message[20];
  const asPublic = message.subarray(21, 21 + idLen), body = message.subarray(21 + idLen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(unb64(privateKey));
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(asPublic), unb64(auth), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const out = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  return out.subarray(0, out.lastIndexOf(2)).toString();
}

// A browser subscription as sent by the page (PushSubscription.toJSON()), checked.
export function cleanSubscription(sub) {
  const endpoint = String(sub?.endpoint || '');
  if (endpoint.length > 1024 || !pushHostAllowed(endpoint)) throw fail(400, 'This browser’s push service isn’t supported.');
  const p256dh = String(sub?.keys?.p256dh || ''), auth = String(sub?.keys?.auth || '');
  const pub = unb64(p256dh);
  if (pub.length !== 65 || pub[0] !== 4 || unb64(auth).length !== 16) throw fail(400, 'That push subscription is incomplete.');
  try { const probe = crypto.createECDH('prime256v1'); probe.generateKeys(); probe.computeSecret(pub); } catch { throw fail(400, 'That push subscription is incomplete.'); }
  return { endpoint, p256dh, auth };
}

// Message text shown on the notification. url is a path on this server opened when it's tapped.
function cleanMessage({ title, body, url, tag }) {
  const text = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
  return { title: text(title, 120) || 'Marquee', body: text(body, 300), url: /^\/(?!\/)/.test(String(url || '')) ? String(url).slice(0, 300) : '/', tag: text(tag, 64) };
}

export class PushStore {
  constructor(dataDir, { subject = 'https://github.com/Tjabooo/marquee', fetch = globalThis.fetch, now = Date.now, log = console } = {}) {
    this.file = path.join(dataDir, '.marquee-push.json');
    this.subject = subject;
    this.fetch = fetch;
    this.now = now;
    this.log = log;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') log.warn?.(`.marquee-push.json: ${err.message}`); }
    this.vapid = data.vapid?.publicKey && data.vapid?.privateKey ? data.vapid : makeVapidKeys();
    this.subs = Array.isArray(data.subs) ? data.subs.filter((s) => s && s.id && s.userId != null && s.endpoint) : [];
    if (!data.vapid) this.save();
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ vapid: this.vapid, subs: this.subs }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  publicKey() { return this.vapid.publicKey; }

  devices(userId) {
    return this.subs.filter((s) => s.userId === userId)
      .map(({ id, label, createdAt, lastOkAt }) => ({ id, label, createdAt, lastOkAt: lastOkAt || null }));
  }

  hasDevice(userId) { return this.subs.some((s) => s.userId === userId); }

  // Turns notifications on for one device. The same endpoint signed in as someone else moves to them.
  subscribe(userId, sub, label = '', replaces = '') {
    const clean = cleanSubscription(sub);
    const previous = this.subs.find((s) => s.userId === userId && (s.endpoint === clean.endpoint || (replaces && s.endpoint === replaces)));
    label = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    // The page re-registers its subscription whenever Settings opens: nothing to write if it's known.
    if (previous && previous.endpoint === clean.endpoint && previous.p256dh === clean.p256dh && previous.auth === clean.auth
      && (!label || label === previous.label)) return previous.id;
    label ||= previous?.label || 'Browser';
    this.subs = this.subs.filter((s) => s.endpoint !== clean.endpoint && !(replaces && s.endpoint === replaces && s.userId === userId));
    const entry = { id: crypto.randomBytes(9).toString('base64url'), userId, ...clean,
      label, createdAt: previous?.createdAt || this.now(), lastOkAt: null, fails: 0 };
    this.subs.push(entry);
    const mine = this.subs.filter((s) => s.userId === userId);
    if (mine.length > MAX_DEVICES) {
      const drop = new Set(mine.sort((a, b) => a.createdAt - b.createdAt).slice(0, mine.length - MAX_DEVICES));
      this.subs = this.subs.filter((s) => !drop.has(s));
    }
    this.save();
    return entry.id;
  }

  // By endpoint (this device turning itself off) or by id (Settings → remove another device).
  unsubscribe(userId, { endpoint = '', id = '' } = {}) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => !(s.userId === userId && ((endpoint && s.endpoint === endpoint) || (id && s.id === id))));
    if (this.subs.length !== before) this.save();
    return before - this.subs.length;
  }

  forgetUser(userId) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.userId !== userId);
    if (this.subs.length !== before) this.save();
  }

  // Sends one message to one device. Returns the push service's status (0 = network error).
  async sendTo(sub, kind, message) {
    const msg = cleanMessage(message);
    const payload = JSON.stringify({ ...msg, kind });
    const headers = {
      Authorization: vapidAuth(sub.endpoint, this.vapid, this.subject, this.now()),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(TTL[kind] ?? 86400), Urgency: URGENCY[kind] || 'normal',
    };
    // A newer message with the same topic replaces one the device hasn't received yet (offline phone).
    if (msg.tag) headers.Topic = crypto.createHash('sha256').update(msg.tag).digest('base64url').slice(0, 32);
    let status = 0;
    try {
      const res = await this.fetch(sub.endpoint, { method: 'POST', headers, body: encrypt(payload, sub), signal: AbortSignal.timeout(15000) });
      status = res.status;
      await res.arrayBuffer().catch(() => {});
    } catch { status = 0; }
    if (status === 404 || status === 410) { // the browser dropped this subscription
      this.subs = this.subs.filter((s) => s.id !== sub.id);
      this.save();
    } else if (status >= 200 && status < 300) {
      if (sub.fails || this.now() - (sub.lastOkAt || 0) > 3600000) { sub.fails = 0; sub.lastOkAt = this.now(); this.save(); }
    } else {
      sub.fails = (sub.fails || 0) + 1;
      // A device that has failed for weeks on end is gone in all but name.
      if (sub.fails >= 50 && this.now() - (sub.lastOkAt || sub.createdAt) > 30 * 86400000) this.subs = this.subs.filter((s) => s.id !== sub.id);
      this.save();
      // The endpoint is a secret capability URL: log only its host.
      this.log.warn?.(`[push] ${new URL(sub.endpoint).hostname} answered ${status || 'nothing'} for a ${kind} notification`);
    }
    return status;
  }

  // Sends to every device of each person. Returns how many devices accepted it.
  async send(userIds, kind, message) {
    const ids = new Set(userIds);
    const targets = this.subs.filter((s) => ids.has(s.userId));
    const results = await Promise.all(targets.map((s) => this.sendTo(s, kind, message)));
    return results.filter((s) => s >= 200 && s < 300).length;
  }
}
