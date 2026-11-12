// Checks settings for mistakes that would otherwise only show up as a feature quietly not working.
// Used by server startup (printed as warnings; nothing here stops Lilin) and by `setup.js doctor`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const on = (v, dflt = 'on') => String(v ?? dflt).toLowerCase() !== 'off';

function dirState(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return 'not a folder';
  } catch (e) { return e.code === 'ENOENT' ? 'does not exist' : `not accessible (${e.code})`; }
  try { fs.accessSync(dir, fs.constants.R_OK); } catch { return 'not readable'; }
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { return 'read-only'; }
  return null;
}

const validUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

function toolWorks(cmd) {
  const r = spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 5000 });
  return !r.error && r.status === 0;
}

// Returns [{ level: 'error'|'warn'|'info', key, message, fix }].
export function checkConfig(env = process.env, { tools = true } = {}) {
  const out = [];
  const add = (level, key, message, fix) => out.push({ level, key, message, fix });

  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) add('error', 'PORT', `PORT=${env.PORT} is not a valid port`, 'Use a number between 1024 and 65535, e.g. 8080.');

  if (!env.MEDIA_DIR) add('warn', 'MEDIA_DIR', 'MEDIA_DIR is not set, so the library is off', 'Set MEDIA_DIR to the folder that holds your films and shows.');
  else {
    const s = dirState(path.resolve(env.MEDIA_DIR));
    if (s === 'read-only') add('warn', 'MEDIA_DIR', `MEDIA_DIR (${env.MEDIA_DIR}) is read-only`, 'Playback works; conversion, subtitles, downloads and deleting need write access.');
    else if (s) add('error', 'MEDIA_DIR', `MEDIA_DIR (${env.MEDIA_DIR}) ${s}`, 'Create the folder, mount the drive, or fix its permissions for the account Lilin runs as.');
  }
  for (const key of ['NOTES_FILES_DIR', 'CLIPS_DIR', 'CACHE_DIR', 'AUDIO_FIX_DIR']) {
    if (!env[key]) continue;
    const s = dirState(path.resolve(env[key]));
    if (s && !(key === 'CLIPS_DIR' && s === 'read-only')) add('warn', key, `${key} (${env[key]}) ${s}`, `Create it or clear ${key} to use the default.`);
  }

  for (const key of ['QBIT_URL', 'FLARESOLVERR_URL', 'ADGUARD_URL', 'PUBLIC_URL', 'TPB_API']) {
    if (env[key] && !validUrl(env[key])) add('error', key, `${key}=${env[key]} is not an http(s) URL`, 'Include the scheme, e.g. http://localhost:8081.');
  }
  if (env.QBIT_URL && !env.QBIT_PASS) add('info', 'QBIT_PASS', 'QBIT_PASS is empty', 'Fine if qBittorrent skips authentication for localhost; otherwise set it.');

  if (tools) {
    const ffmpeg = env.FFMPEG || 'ffmpeg';
    const needsFfmpeg = on(env.CONVERT) || on(env.SUBSYNC);
    if (needsFfmpeg && !toolWorks(ffmpeg)) {
      add('warn', 'FFMPEG', `ffmpeg not found (${ffmpeg}): conversion, subtitle timing, previews and clip sharing are off`,
        'Install ffmpeg (node setup.js can do it) or set FFMPEG and FFPROBE to their full paths.');
    } else if (needsFfmpeg && !toolWorks(env.FFPROBE || 'ffprobe')) {
      add('warn', 'FFPROBE', 'ffprobe not found next to ffmpeg', 'Install the full ffmpeg package or set FFPROBE.');
    }
  }

  if (env.HOME_NETWORK_ACCESS && !['shared', 'signin'].includes(String(env.HOME_NETWORK_ACCESS).toLowerCase())) add('error', 'HOME_NETWORK_ACCESS', `HOME_NETWORK_ACCESS="${env.HOME_NETWORK_ACCESS}" isn't shared or signin, so shared is used`, 'Set it to shared or signin.');
  if (env.SESSION_DAYS && !(Number(env.SESSION_DAYS) >= 1 && Number(env.SESSION_DAYS) <= 365)) add('warn', 'SESSION_DAYS', 'SESSION_DAYS should be a number of days from 1 to 365', 'Fix it in .env (default 30).');
  if (env.CF_ACCESS_TEAM_DOMAIN && !env.CF_ACCESS_AUD) add('error', 'CF_ACCESS_AUD', 'CF_ACCESS_TEAM_DOMAIN is set without CF_ACCESS_AUD, so Access tokens are not verified', 'Copy the Application Audience (AUD) tag from the Access application.');
  if (env.CF_ACCESS_AUD && !env.CF_ACCESS_TEAM_DOMAIN) add('error', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD is set without CF_ACCESS_TEAM_DOMAIN', 'Set it to <team>.cloudflareaccess.com.');
  const oidc = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URIS'].filter((k) => String(env[k] || '').trim());
  if (oidc.length && oidc.length < 3) add('error', 'OIDC_CLIENT_ID', 'Lilin sign-in for Access needs OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URIS together, so it is off', 'Run node setup.js (Cloudflare Tunnel + Access, sign in with Lilin passwords) or see docs/remote-access.md.');
  else if (oidc.length === 3 && String(env.OIDC_CLIENT_SECRET).trim().length < 16) add('error', 'OIDC_CLIENT_SECRET', 'OIDC_CLIENT_SECRET is shorter than 16 characters, so Lilin sign-in for Access is off', 'Use a long random string (node setup.js makes one) and enter the same one in Cloudflare.');
  else if (oidc.length === 3 && !/^https?:\/\//.test(String(env.PUBLIC_URL || ''))) add('error', 'PUBLIC_URL', 'Lilin sign-in for Access needs PUBLIC_URL (its sign-in addresses live there), so it is off', 'Set PUBLIC_URL to the address people open, e.g. https://lilin.example.com.');
  if (env.CONTENT_FILTER && !['on', 'members', 'off'].includes(String(env.CONTENT_FILTER).trim().toLowerCase())) add('warn', 'CONTENT_FILTER', `CONTENT_FILTER="${env.CONTENT_FILTER}" isn't on, members or off, so on is used`, 'Set it to on, members or off.');
  if (env.CF_API_TOKEN && !(env.CF_ACCOUNT_ID && env.CF_ACCESS_LIST_ID)) add('warn', 'CF_ACCESS_LIST_ID', 'Invites need CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_LIST_ID together', 'See docs/remote-access.md#invites.');
  for (const key of ['HOUSE_TOKEN', 'SCREENTIME_TOKEN']) {
    if (env[key] && env[key].length < 24) add('warn', key, `${key} is shorter than 24 characters`, 'Generate a new one: node setup.js --yes regenerates missing tokens; or openssl rand -hex 24.');
  }
  if (!env.ADMIN_EMAILS) add('info', 'ADMIN_EMAILS', 'No owner set (ADMIN_EMAILS): Activity, House, Clips and server settings are hidden', 'Only accounts signed in through Cloudflare Access can be owners; see docs/remote-access.md.');
  return out;
}
