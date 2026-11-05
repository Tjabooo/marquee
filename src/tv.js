// Signing in a TV app (tv/tizen): the TV can't type a password comfortably, so it shows a short code
// and someone approves it from their phone (Settings → Sign in a TV). The TV then gets its own Marquee
// session for that person, which it sends in the X-Marquee-Session header (auth.js).
//
// start()   → { code, poll, expiresIn }: the code is shown on the TV, `poll` stays secret on the TV.
// poll(id)  → { state: 'waiting' | 'approved' | 'expired', grant? }: the grant is handed over once.
// approve(code, grant) by the signed-in person; a few wrong codes in a row wait a while.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: read off a TV across the room
export const CODE_LENGTH = 6;
export const PAIR_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const MAX_FAILS = 8;          // wrong codes per person before approving waits
const FAIL_WINDOW_MS = 10 * 60_000;

export const normalCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function createTvPairing({ now = () => Date.now() } = {}) {
  const pending = new Map(); // code -> { code, poll, created, grant, taken }
  const fails = new Map();   // who -> { count, first }

  function sweep() {
    const t = now();
    for (const [code, p] of pending) if (t - p.created > PAIR_TTL_MS || p.taken) pending.delete(code);
    for (const [who, f] of fails) if (t - f.first > FAIL_WINDOW_MS) fails.delete(who);
  }

  function start() {
    sweep();
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    let code;
    do code = randomCode(); while (pending.has(code));
    const entry = { code, poll: crypto.randomBytes(24).toString('base64url'), created: now(), grant: null, taken: false };
    pending.set(code, entry);
    return { code, poll: entry.poll, expiresIn: Math.round(PAIR_TTL_MS / 1000) };
  }

  function poll(id) {
    const entry = [...pending.values()].find((p) => p.poll === String(id || ''));
    if (!entry || now() - entry.created > PAIR_TTL_MS) { sweep(); return { state: 'expired' }; }
    if (!entry.grant) return { state: 'waiting' };
    entry.taken = true; // the session token is handed over once
    sweep();
    return { state: 'approved', grant: entry.grant };
  }

  // grant: () => { token, name } made only once the code is known to be right.
  function approve(who, code, makeGrant) {
    sweep();
    const f = fails.get(who);
    if (f && f.count >= MAX_FAILS) {
      throw Object.assign(new Error('Too many wrong codes. Wait a few minutes and try again.'), { status: 429 });
    }
    const entry = pending.get(normalCode(code));
    if (!entry || entry.grant) {
      fails.set(who, { count: (f?.count || 0) + 1, first: f?.first || now() });
      throw Object.assign(new Error('That code isn’t showing on any TV. Check the code on the TV and try again.'), { status: 404 });
    }
    fails.delete(who);
    entry.grant = makeGrant();
    return { ok: true };
  }

  return { start, poll, approve, pendingCount: () => (sweep(), pending.size) };
}
