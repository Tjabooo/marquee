// Marquee's Android TV app (tv/android): the install steps (/android), the app itself (/android.apk) and its
// version (/android.json, which installed apps check to offer their own update). The app is built with
// tv/android/build.sh into tv/android/dist (or ANDROID_APP_DIR). Like the Samsung app it runs on the home
// network, and its build holds the server's home address, so the file is only handed out there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr, currentLanguage } from './i18n.js';

const DEFAULT_DIR = fileURLToPath(new URL('../tv/android/dist/', import.meta.url));
const PATHS = new Set(['/android', '/android/', '/android.apk', '/android.json']);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const isAndroidPath = (p) => PATHS.has(p);

const privateV4 = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

// The address a TV at home types: the one this request came in on when that's a home one,
// else the server's own home-network address (the page was opened through a proxy or tunnel).
export function homeAddress(req, port, interfaces = os.networkInterfaces()) {
  const local = String(req.socket?.localAddress || '').replace(/^::ffff:/, '');
  if (privateV4(local)) return `${local}:${req.socket.localPort || port}`;
  const found = Object.values(interfaces).flat().filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal && privateV4(a.address))
    .map((a) => a.address)
    .sort((a, b) => rank(a) - rank(b));
  return found.length ? `${found[0]}:${port}` : null;
}
const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);

// port: the server's port, or a function giving it (it's known once the server listens).
export function createAndroidTv({ dir = process.env.ANDROID_APP_DIR || DEFAULT_DIR, port = 8080 } = {}) {
  const portNow = () => (typeof port === 'function' ? port() : port);
  function app() {
    const file = path.join(dir, 'Marquee.apk');
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) return null;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'Marquee.json'), 'utf8')); } catch { /* built without it: version 1 */ }
    return { file, size: stat.size, versionCode: Number(meta.versionCode) || 1, versionName: String(meta.versionName || '1.0.0'), sha256: meta.sha256 || null };
  }

  // Returns true when it answered. `home` is false for requests from outside the home network.
  function handle(req, res, url, { home }) {
    const p = url.pathname;
    if (!PATHS.has(p)) return false;
    const head = req.method === 'HEAD';
    const found = app();
    if (p === '/android.json') {
      const body = home && found ? JSON.stringify({ versionCode: found.versionCode, versionName: found.versionName, size: found.size, sha256: found.sha256, apk: '/android.apk' }) : '{}';
      res.writeHead(home && found ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(head ? undefined : body);
      return true;
    }
    if (p === '/android.apk') {
      if (!home || !found) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(head ? undefined : tr(home ? 'The Android TV app isn’t on this server yet.' : 'Open this page at home.'));
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': found.size,
        'Content-Disposition': 'attachment; filename="Marquee.apk"',
        'Cache-Control': 'no-cache',
      });
      if (head) { res.end(); return true; }
      fs.createReadStream(found.file).on('error', () => res.destroy()).pipe(res);
      return true;
    }
    const html = page({ home, found, address: homeAddress(req, portNow()) });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(head ? undefined : html);
    return true;
  }

  return { handle, app };
}

function page({ home, found, address }) {
  const typed = address ? `${address}/android.apk` : '';
  const steps = [
    [tr('Get Downloader'), `<p>${esc(tr('On the TV, open Google Play, search for Downloader and install it. It’s free, made by AFTVnews, with an orange icon.'))}</p>`],
    [tr('Type this address'), `<p>${esc(tr('Open Downloader, select the address box and type:'))}</p>
      <div class="address" aria-label="${esc(typed)}">${esc(typed)}</div><p>${esc(tr('Then press Go.'))}</p>`],
    [tr('Install Marquee'), `<p>${esc(tr('When the download is done, press Install. The first time, the TV asks to let Downloader install apps: choose Settings, turn Downloader on, press Back, then Install.'))}</p>`],
    [tr('Sign in'), `<p>${esc(tr('Press Open. The TV shows a code: on your phone, open Marquee, go to Settings → Sign in a TV and enter it.'))}</p>`],
  ];
  let body;
  if (!home) {
    body = `<section class="card note"><h2>${esc(tr('Open this page at home.'))}</h2><p>${esc(tr('The Android TV app installs and runs on the home network, where Marquee is.'))}</p></section>`;
  } else if (!found) {
    body = `<section class="card note"><h2>${esc(tr('The Android TV app isn’t on this server yet.'))}</h2><p>${esc(tr('Whoever runs Marquee can build it with tv/android/build.sh (see docs/android-tv.md).'))}</p></section>`;
  } else {
    const size = `${(found.size / 1048576).toFixed(1)} MB`;
    body = `<ol class="steps">${steps.map(([title, text], i) => `<li class="card"><span class="n">${i + 1}</span><div><h2>${esc(title)}</h2>${text}</div></li>`).join('')}</ol>
      <p class="after">${esc(tr('Marquee is now among the TV’s apps. It keeps itself up to date: when there’s a new version, the TV offers it as the app starts. Downloader may offer to delete the file it fetched; the app stays.'))}</p>
      <p class="after">${esc(tr('The TV has to be on the same network as Marquee.'))}</p>
      <a class="download" href="/android.apk" download="Marquee.apk">${esc(tr('Download the app ({0} · version {1})', size, found.versionName))}</a>`;
  }
  return `<!doctype html>
<html lang="${currentLanguage()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1F1019">
<meta name="robots" content="noindex">
<title>${esc(tr('Marquee on Android TV'))}</title>
<link rel="icon" href="/c/favicon.svg" type="image/svg+xml">
<style>
  @font-face { font-family: "Bricolage Grotesque"; font-weight: 200 800; font-display: swap; src: url("/c/fonts/bricolage-grotesque-latin.woff2") format("woff2"); }
  :root { --velvet: #1F1019; --curtain: #2B1724; --seat: #3A2031; --paper: #F6EADF; --dust: #BA9DAD; --bulb: #F4C152; --on-bulb: #1F1019; --hair: rgba(246, 234, 223, .1);
    --display: "Bricolage Grotesque", system-ui, sans-serif; color-scheme: dark; }
  * { box-sizing: border-box; }
  html { background: radial-gradient(ellipse 120% 60% at 50% -10%, #3D2234 0%, rgba(61, 34, 52, 0) 100%), linear-gradient(#1F1019, #160B12) fixed; min-height: 100%; }
  body { margin: 0; color: var(--paper); font: 17px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
  main { max-width: 680px; margin: 0 auto; padding: max(40px, env(safe-area-inset-top)) 20px max(48px, env(safe-area-inset-bottom)); }
  .mark { font: 800 26px/1 var(--display); letter-spacing: -.03em; color: var(--bulb); text-shadow: 0 0 18px rgba(244, 193, 82, .45); }
  .mark::before { content: ''; display: block; width: 150px; height: 10px; margin-bottom: 14px;
    background: radial-gradient(circle, #F4C152 3px, rgba(244, 193, 82, .35) 4px, rgba(244, 193, 82, 0) 6px) 0 50% / 15px 10px repeat-x; }
  h1 { margin: 26px 0 8px; font: 800 clamp(34px, 8vw, 50px)/1.02 var(--display); letter-spacing: -.025em; }
  .lead { margin: 0 0 30px; color: var(--dust); }
  .steps { list-style: none; margin: 0; padding: 0; counter-reset: none; }
  .card { display: flex; gap: 18px; padding: 22px 22px 20px; margin-bottom: 14px; border-radius: 22px; background: linear-gradient(var(--seat), var(--curtain)); border: 1px solid var(--hair); }
  .card.note { display: block; }
  .n { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--bulb); color: var(--on-bulb);
    font: 800 20px/1 var(--display); box-shadow: 0 0 22px rgba(244, 193, 82, .35); }
  h2 { margin: 6px 0 6px; font: 700 22px/1.2 var(--display); letter-spacing: -.01em; }
  .card p { margin: 0 0 8px; color: var(--dust); }
  .address { margin: 12px 0 12px; padding: 14px 18px; border-radius: 14px; background: rgba(22, 11, 18, .7); border: 1px solid rgba(244, 193, 82, .35);
    font: 800 clamp(20px, 5.4vw, 28px)/1.2 var(--display); letter-spacing: .01em; color: var(--bulb); overflow-wrap: anywhere; user-select: all; }
  .after { margin: 18px 4px 0; color: var(--dust); font-size: 15px; }
  .download { display: block; margin-top: 28px; padding: 16px 22px; border-radius: 999px; text-align: center; text-decoration: none;
    background: var(--paper); color: var(--on-bulb); font: 700 17px/1.2 system-ui, sans-serif; }
  .download:focus-visible, .download:hover { background: var(--bulb); box-shadow: 0 0 0 4px rgba(244, 193, 82, .35); outline: none; }
</style>
</head>
<body><main>
<div class="mark">Marquee</div>
<h1>${esc(tr('Marquee on Android TV'))}</h1>
<p class="lead">${esc(tr('For TVs with Android TV or Google TV, Chromecast with Google TV, Nvidia Shield and other Android TV boxes.'))}</p>
${body}
</main></body>
</html>`;
}
