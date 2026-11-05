// Invites: the owner makes a one-time link, sends it to someone, they open it and enter the email
// they'll sign in with. Marquee adds that email to a Zero Trust email list (Reusable components →
// Lists) that Marquee's Access policy allows ("Emails in list"), then sends them to Marquee, where
// Cloudflare's login page lets them pick any login method you've enabled (one-time email code,
// Google, ...). From then on they just sign in.
//
// Needs, in .env: CF_API_TOKEN (permission "Zero Trust: Edit"), CF_ACCOUNT_ID and CF_ACCESS_LIST_ID.
// Invite pages live under /c/i/, so the same Cloudflare Access bypass as shared clips covers them.
// Links are single use and expire.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { esc, page, baseUrl } from './clips.js';

const CF_API = (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
const CF_TOKEN = process.env.CF_API_TOKEN || '';
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const CF_LIST = process.env.CF_ACCESS_LIST_ID || '';
const INVITE_DAYS = Math.max(1, Number(process.env.INVITE_DAYS) || 7);
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

let file = null;
let invites = {};        // token -> { id, note, created, expires, usedAt, email }
let record = () => {};   // activity logger, from server.js
const attempts = [];     // timestamps of invite form posts, for a simple global rate limit

export function initInvites({ dataDir, onEvent }) {
  file = path.join(dataDir, '.marquee-invites.json');
  try { invites = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { invites = {}; }
  record = onEvent || record;
}
export const invitesConfigured = () => Boolean(CF_TOKEN && CF_ACCOUNT && CF_LIST);
const save = () => { try { fs.writeFileSync(file, JSON.stringify(invites, null, 1)); } catch { /* memory only */ } };
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Cloudflare Zero Trust email list ----------
async function cf(method, suffix = '', body) {
  const r = await fetch(`${CF_API}/accounts/${CF_ACCOUNT}/gateway/lists/${CF_LIST}${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let data = {};
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || data.success === false) {
    const why = data.errors?.map((e) => e.message).join('; ') || `HTTP ${r.status}`;
    throw httpError(502, `Cloudflare refused: ${why}`);
  }
  return data.result;
}

export async function members() {
  const items = (await cf('GET', '/items?per_page=1000')) || [];
  return items.map((i) => String(i.value || '').toLowerCase()).filter(Boolean);
}
// Single-item append / remove: nothing else in the list is touched.
async function addMember(email) {
  if ((await members()).includes(email)) return;
  await cf('PATCH', '', { append: [{ value: email, description: 'Marquee invite' }] });
}
export async function removeMember(email, admins = []) {
  email = String(email || '').toLowerCase();
  if (admins.includes(email)) throw httpError(400, 'Owners (ADMIN_EMAILS) can’t be removed here.');
  const actual = ((await cf('GET', '/items?per_page=1000')) || []).map((i) => i.value).find((v) => String(v).toLowerCase() === email);
  if (actual) await cf('PATCH', '', { remove: [actual] });
  return members();
}

// ---------- invites (owner side) ----------
const state = (inv) => (inv.usedAt ? 'used' : inv.expires < Date.now() ? 'expired' : 'open');
export function listInvites() {
  return Object.entries(invites)
    .map(([token, inv]) => ({ ...inv, token, state: state(inv) }))
    .sort((a, b) => b.created - a.created)
    .slice(0, 50);
}
export function createInvite(req, note = '') {
  const token = crypto.randomBytes(12).toString('base64url');
  const inv = { id: crypto.randomBytes(4).toString('hex'), note: String(note).slice(0, 60), created: Date.now(), expires: Date.now() + INVITE_DAYS * 86400000, usedAt: null, email: null };
  invites[token] = inv;
  // forget used/expired invites after 30 days
  for (const [t, i] of Object.entries(invites)) if (Date.now() - i.created > 30 * 86400000 && state(i) !== 'open') delete invites[t];
  save();
  return { ...inv, token, state: 'open', url: `${baseUrl(req)}/c/i/${token}` };
}
export function revokeInvite(id) {
  const t = Object.keys(invites).find((k) => invites[k].id === id);
  if (!t) throw httpError(404, 'No such invite.');
  delete invites[t];
  save();
}

// ---------- the public invite page (/c/i/<token>) ----------
async function readForm(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 4000) throw httpError(413, 'Too much data.'); }
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) { try { return JSON.parse(raw); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Returns true when it handled the request.
export async function handlePublic(req, res, url) {
  const m = url.pathname.match(/^\/c\/i\/([A-Za-z0-9_-]{16})\/?$/);
  if (!m) return false;
  const send = (status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'same-origin', ...extra }); // same-origin, not no-referrer: no-referrer turns the form's Origin into `null`
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
  const base = baseUrl(req);
  const view = (title, inner, extra) => send(200, page({
    title, desc: 'You’ve been invited to Marquee: films and shows from the home server.',
    url: `${base}${url.pathname}`, image: `${base}/c/marquee.png`, body: `<div class="card">${inner}</div>`,
  }), extra);

  const inv = Object.hasOwn(invites, m[1]) ? invites[m[1]] : null;
  if (!inv || state(inv) !== 'open') {
    return view('Invite not valid', `<h1>This invite doesn’t work any more</h1><p>${inv?.usedAt ? 'It has already been used.' : inv ? 'It has expired.' : 'It may have been cancelled.'} Ask for a new link.</p><p><a class="brand" href="/">Already have access? Open Marquee</a></p>`);
  }
  if (!invitesConfigured()) return view('Invites aren’t set up', '<h1>Invites aren’t set up yet</h1><p>The server owner still needs to connect Marquee to Cloudflare.</p>');

  const form = (email = '', error = '') => `
    <h1>You’re invited to Marquee</h1>
    <p>Films and shows from the home server, on your phone, in a browser or on the TV.</p>
    <form method="post">
      <label for="email">The email you’ll sign in with</label>
      <input id="email" name="email" type="email" required autocomplete="email" autofocus value="${esc(email)}" placeholder="you@example.com">
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <button type="submit">Get access</button>
    </form>
    <p class="foot">Next you choose how to sign in: a one-time code sent to this email, or an account like Google if it uses the same address.</p>`;

  if (req.method !== 'POST') return view('You’re invited to Marquee', form());

  // ---- accept ----
  const now = Date.now();
  while (attempts.length && now - attempts[0] > 60000) attempts.shift();
  if (attempts.length >= 20) return send(429, page({ title: 'Slow down', desc: '', url: '', body: '<div class="card"><h1>Too many tries</h1><p>Wait a minute and try again.</p></div>' }));
  attempts.push(now);

  const email = String((await readForm(req)).email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return view('You’re invited to Marquee', form(email, 'That doesn’t look like an email address.'));
  try {
    await addMember(email);
  } catch (e) {
    console.error('[invites]', e.message);
    return view('You’re invited to Marquee', form(email, 'Couldn’t add you right now. Try again in a minute, or tell whoever sent the link.'));
  }
  inv.usedAt = now;
  inv.email = email;
  save();
  record(req, 'joined', inv.note || 'with an invite', { user: email });
  return view('Welcome to Marquee', `
    <h1>You’re in</h1>
    <p class="ok">${esc(email)} can now sign in to Marquee.</p>
    <p>Taking you there… pick how you want to sign in (with a code sent to this email, or an account that uses it). Next time just open Marquee and sign in the same way.</p>
    <form method="get" action="/"><button type="submit">Open Marquee</button></form>
    <script>setTimeout(() => location.replace('/'), 2500)</script>`);
}
