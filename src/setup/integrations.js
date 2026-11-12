// Optional, read-only checks of configured integrations. Each check makes at most two requests,
// only to the service the credential belongs to, and never retries a failed login (qBittorrent
// bans an address after repeated failures). The one write, setting qBittorrent's save path, is a
// separate function that setup.js only calls after asking.
const TIMEOUT = 8000;
const result = (name, ok, detail, extra = {}) => ({ name, ok, detail, ...extra });
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

async function get(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
}
const reason = (e) => e?.cause?.code || e?.name === 'TimeoutError' && 'timed out' || e?.message || String(e);

export async function checkTmdb(env, fetchImpl = fetch) {
  if (!env.TMDB_TOKEN && !env.TMDB_API_KEY) return null;
  const url = new URL('https://api.themoviedb.org/3/configuration');
  const headers = { Accept: 'application/json' };
  if (env.TMDB_TOKEN) headers.Authorization = `Bearer ${env.TMDB_TOKEN}`;
  else url.searchParams.set('api_key', env.TMDB_API_KEY);
  try {
    const r = await get(fetchImpl, url, { headers });
    if (r.status === 401) return result('TMDB', false, 'the token was rejected: copy the "API Read Access Token" from themoviedb.org → Settings → API');
    return result('TMDB', r.ok, r.ok ? 'token accepted' : `HTTP ${r.status}`);
  } catch (e) { return result('TMDB', false, `api.themoviedb.org unreachable (${reason(e)})`); }
}

// Signs in once and returns the session cookie, or a result explaining why not.
async function qbitLogin(env, fetchImpl) {
  const base = trimUrl(env.QBIT_URL);
  const body = new URLSearchParams({ username: env.QBIT_USER || '', password: env.QBIT_PASS || '' });
  let r;
  try { r = await get(fetchImpl, `${base}/api/v2/auth/login`, { method: 'POST', body, headers: { Referer: base } }); }
  catch (e) { return { error: result('qBittorrent', false, `no answer at ${base} (${reason(e)}). Is qBittorrent running with Web UI enabled?`) }; }
  const text = (await r.text()).trim();
  if (r.status === 403) return { error: result('qBittorrent', false, 'qBittorrent is blocking sign-ins after failed attempts; restart it, then check QBIT_USER/QBIT_PASS') };
  if (!r.ok || /^fails/i.test(text)) return { error: result('qBittorrent', false, 'sign-in refused: check QBIT_USER and QBIT_PASS (Web UI → Authentication)') };
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { base, cookie };
}

export async function checkQbit(env, fetchImpl = fetch) {
  if (!env.QBIT_URL) return null;
  const login = await qbitLogin(env, fetchImpl);
  if (login.error) return login.error;
  try {
    const headers = login.cookie ? { Cookie: login.cookie } : {};
    const [ver, prefs] = await Promise.all([
      get(fetchImpl, `${login.base}/api/v2/app/version`, { headers }).then((r) => r.text()),
      get(fetchImpl, `${login.base}/api/v2/app/preferences`, { headers }).then((r) => r.json()),
    ]);
    return result('qBittorrent', true, `${ver.trim()}, saves to ${prefs.save_path}`, { savePath: prefs.save_path });
  } catch (e) { return result('qBittorrent', false, `signed in but couldn't read its settings (${reason(e)})`); }
}

// Changes qBittorrent's default save path. Only called after the user agreed.
export async function setQbitSavePath(env, savePath, fetchImpl = fetch) {
  const login = await qbitLogin(env, fetchImpl);
  if (login.error) return login.error;
  const body = new URLSearchParams({ json: JSON.stringify({ save_path: savePath }) });
  const r = await get(fetchImpl, `${login.base}/api/v2/app/setPreferences`, { method: 'POST', body, headers: login.cookie ? { Cookie: login.cookie } : {} });
  return result('qBittorrent save path', r.ok, r.ok ? `set to ${savePath}` : `HTTP ${r.status}`);
}

export async function checkOpenSubtitles(env, fetchImpl = fetch) {
  if (!env.OPENSUBTITLES_API_KEY) return null;
  try {
    const r = await get(fetchImpl, 'https://api.opensubtitles.com/api/v1/infos/formats', {
      headers: { 'Api-Key': env.OPENSUBTITLES_API_KEY, 'User-Agent': 'Lilin v1.1', Accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) return result('OpenSubtitles', false, 'API key rejected (opensubtitles.com → Profile → API consumers)');
    return result('OpenSubtitles', r.ok, r.ok ? 'API key accepted' : `HTTP ${r.status}`);
  } catch (e) { return result('OpenSubtitles', false, `api.opensubtitles.com unreachable (${reason(e)})`); }
}

export async function checkFlareSolverr(env, fetchImpl = fetch) {
  if (!env.FLARESOLVERR_URL) return null;
  const base = trimUrl(env.FLARESOLVERR_URL);
  try {
    const r = await get(fetchImpl, `${base}/`);
    const body = await r.json().catch(() => ({}));
    const ok = r.ok && /ready/i.test(body.msg || '');
    return result('FlareSolverr', ok, ok ? `ready (${body.version || 'version unknown'})` : `unexpected answer from ${base} (HTTP ${r.status})`);
  } catch (e) { return result('FlareSolverr', false, `no answer at ${base} (${reason(e)})`); }
}

export async function checkAdGuard(env, fetchImpl = fetch) {
  if (!env.ADGUARD_URL || !env.ADGUARD_USER) return null;
  const base = trimUrl(env.ADGUARD_URL);
  try {
    const r = await get(fetchImpl, `${base}/control/status`, {
      headers: { Authorization: `Basic ${Buffer.from(`${env.ADGUARD_USER}:${env.ADGUARD_PASS || ''}`).toString('base64')}` },
    });
    if (r.status === 401 || r.status === 403) return result('AdGuard Home', false, 'login refused: check ADGUARD_USER and ADGUARD_PASS');
    const body = await r.json().catch(() => ({}));
    return result('AdGuard Home', r.ok, r.ok ? `protection ${body.protection_enabled ? 'on' : 'off'}` : `HTTP ${r.status}`);
  } catch (e) { return result('AdGuard Home', false, `no answer at ${base} (${reason(e)})`); }
}

// Invites need a token that can read the Zero Trust list Lilin manages. Reading the list proves
// token, account and list ID together without changing anything.
export async function checkCloudflare(env, fetchImpl = fetch) {
  if (!env.CF_API_TOKEN) return null;
  if (!env.CF_ACCOUNT_ID || !env.CF_ACCESS_LIST_ID) return result('Cloudflare invites', false, 'CF_API_TOKEN is set but CF_ACCOUNT_ID or CF_ACCESS_LIST_ID is missing');
  const api = trimUrl(env.CF_API_BASE || 'https://api.cloudflare.com/client/v4');
  try {
    const r = await get(fetchImpl, `${api}/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/gateway/lists/${encodeURIComponent(env.CF_ACCESS_LIST_ID)}`, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.success) return result('Cloudflare invites', true, `list "${body.result?.name || env.CF_ACCESS_LIST_ID}" readable`);
    const msg = body.errors?.[0]?.message || `HTTP ${r.status}`;
    return result('Cloudflare invites', false, `${msg} (the token needs "Zero Trust: Edit" on this account)`);
  } catch (e) { return result('Cloudflare invites', false, `api.cloudflare.com unreachable (${reason(e)})`); }
}

// Cloudflare Access signing keys: confirms the team domain used to verify Access tokens.
export async function checkAccessTeam(env, fetchImpl = fetch) {
  if (!env.CF_ACCESS_TEAM_DOMAIN) return null;
  if (!env.CF_ACCESS_AUD) return result('Cloudflare Access', false, 'CF_ACCESS_TEAM_DOMAIN is set but CF_ACCESS_AUD is missing, so tokens are not verified');
  const team = String(env.CF_ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  try {
    const r = await get(fetchImpl, `https://${team}/cdn-cgi/access/certs`);
    const body = await r.json().catch(() => ({}));
    const n = body.keys?.length || 0;
    return result('Cloudflare Access', r.ok && n > 0, n ? `${n} signing key(s) at ${team}` : `no signing keys at ${team}`);
  } catch (e) { return result('Cloudflare Access', false, `${team} unreachable (${reason(e)})`); }
}

export function checkLocalSecrets(env) {
  const out = [];
  if (env.HOUSE_TOKEN && env.HOUSE_TOKEN.length < 24) out.push(result('House agents', false, 'HOUSE_TOKEN is short; use at least 24 random characters'));
  if (env.SCREENTIME_TOKEN && env.SCREENTIME_TOKEN.length < 24) out.push(result('Screen Time', false, 'SCREENTIME_TOKEN is short; use at least 24 random characters'));
  return out;
}

export async function checkIntegrations(env, fetchImpl = fetch) {
  const checks = await Promise.all([checkTmdb, checkQbit, checkOpenSubtitles, checkFlareSolverr, checkAdGuard, checkCloudflare, checkAccessTeam]
    .map((fn) => fn(env, fetchImpl).catch((e) => result(fn.name.replace(/^check/, ''), false, reason(e)))));
  return [...checks.filter(Boolean), ...checkLocalSecrets(env)];
}
