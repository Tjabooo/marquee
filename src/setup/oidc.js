// Marquee as Cloudflare Access's sign-in (src/oidc.js, docs/remote-access.md): the .env values setup
// writes for it, and the login method the owner adds in Cloudflare Zero Trust (Settings →
// Authentication → Login methods → OpenID Connect). Used by `setup.js`, `setup.js oidc` and the
// Windows wizard (`setup.js wizard oidc`).
import { newSecret } from './envfile.js';

export const OIDC_KEYS = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URIS'];
export const DEFAULT_CLIENT_ID = 'cloudflare';
const MIN_SECRET = 16; // src/oidc.js refuses shorter secrets

// "myteam", "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com/" → the host name.
export function teamHost(team) {
  const t = String(team || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!t) return '';
  return t.includes('.') ? t : `${t}.cloudflareaccess.com`;
}

export const accessCallback = (team) => (teamHost(team) ? `https://${teamHost(team)}/cdn-cgi/access/callback` : '');

export const oidcConfigured = (env) => OIDC_KEYS.some((k) => String(env[k] || '').trim());

// The OIDC_* values for turning it on. Existing values are kept (a new secret would break the login
// method already in Cloudflare); the team's callback is added to any redirect addresses already set.
export function oidcValues(current = {}, team = current.CF_ACCESS_TEAM_DOMAIN) {
  const id = String(current.OIDC_CLIENT_ID || '').trim() || DEFAULT_CLIENT_ID;
  const secret = String(current.OIDC_CLIENT_SECRET || '').trim();
  const uris = String(current.OIDC_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const callback = accessCallback(team);
  if (callback && !uris.includes(callback)) uris.push(callback);
  return {
    OIDC_CLIENT_ID: id,
    OIDC_CLIENT_SECRET: secret.length >= MIN_SECRET ? secret : newSecret(),
    OIDC_REDIRECT_URIS: uris.join(','),
  };
}

// What to enter in Cloudflare, and what's still missing for it to work.
export function loginMethod(env) {
  const base = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const missing = [];
  if (!String(env.OIDC_CLIENT_ID || '').trim()) missing.push('OIDC_CLIENT_ID');
  if (String(env.OIDC_CLIENT_SECRET || '').trim().length < MIN_SECRET) missing.push('OIDC_CLIENT_SECRET');
  if (!String(env.OIDC_REDIRECT_URIS || '').trim()) missing.push('OIDC_REDIRECT_URIS');
  if (!/^https?:\/\//.test(base)) missing.push('PUBLIC_URL');
  const at = (p) => (base ? `${base}/c/oidc/${p}` : '');
  return {
    ready: missing.length === 0,
    missing,
    appId: String(env.OIDC_CLIENT_ID || '').trim(),
    clientSecret: String(env.OIDC_CLIENT_SECRET || '').trim(),
    authUrl: at('authorize'),
    tokenUrl: at('token'),
    certUrl: at('jwks'),
    pkce: true,
    scopes: 'openid email profile',
    redirectUris: String(env.OIDC_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

// The same as plain lines, for the terminal and the wizard's copy box.
export function loginMethodLines(m) {
  return [
    'Cloudflare Zero Trust > Settings > Authentication > Login methods > Add new > OpenID Connect:',
    `  Name:             Marquee`,
    `  App ID:           ${m.appId}`,
    `  Client secret:    ${m.clientSecret}`,
    `  Auth URL:         ${m.authUrl}`,
    `  Token URL:        ${m.tokenUrl}`,
    `  Certificate URL:  ${m.certUrl}`,
    `  Proof Key for Code Exchange (PKCE): on`,
    `  Scopes:           ${m.scopes}`,
    'Then in the Marquee application in Access > Login methods: allow only Marquee and turn on Instant Auth.',
    'Keep the email-list policy: it still decides who gets in.',
  ];
}
