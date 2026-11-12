// The preview switch: a second copy of the web app (PREVIEW_DIR, another public/ folder) that a browser
// can opt into on the live server, to try a redesign with real data before it goes live.
//   GET /preview      sets the lilin_preview cookie and goes to /
//   GET /preview/off  clears it
// With the cookie, static files come from PREVIEW_DIR first and fall back to public/. Nothing else
// changes: the same API, sign-in and permissions. Pages the server draws itself (sign-in, share pages)
// get PREVIEW_DIR/pages.css added, so their new look can be previewed too.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PREVIEW_COOKIE = 'lilin_preview';
const COOKIE_DAYS = 30;

// PREVIEW_DIR as a usable folder, or '' (unset, not absolute, or missing).
export function previewDir(value = process.env.PREVIEW_DIR) {
  const dir = String(value || '').trim();
  if (!dir || !path.isAbsolute(dir)) return '';
  try { return fs.statSync(dir).isDirectory() ? path.resolve(dir) : ''; } catch { return ''; }
}

// A problem with PREVIEW_DIR worth printing at startup, or ''.
export function previewProblem(value = process.env.PREVIEW_DIR) {
  const dir = String(value || '').trim();
  if (!dir) return '';
  if (!path.isAbsolute(dir)) return `PREVIEW_DIR must be an absolute path (got "${dir}"), so the preview is off.`;
  return previewDir(dir) ? '' : `PREVIEW_DIR "${dir}" isn't a folder, so the preview is off.`;
}

export const previewCookieSet = (req) => /(?:^|;\s*)lilin_preview=1(?:;|$)/.test(String(req.headers?.cookie || ''));
export const inPreview = (req, dir) => Boolean(dir) && previewCookieSet(req);

// /preview and /preview/off. True when the request was one of them.
export function previewRoute(req, res, pathname, dir) {
  if (pathname !== '/preview' && pathname !== '/preview/off') return false;
  if (!dir) return false; // no preview on this server: the usual 404
  const on = pathname === '/preview';
  const secure = req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '') || Boolean(req.socket?.encrypted);
  const cookie = `${PREVIEW_COOKIE}=${on ? '1' : ''}; Path=/; Max-Age=${on ? COOKIE_DAYS * 86400 : 0}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
  res.writeHead(303, { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

// The file a static path points at inside `root`, refusing anything that climbs out of it.
export function staticFile(root, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const full = path.resolve(root, '.' + rel);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

// Folders to look in, in order: the preview's first when this browser has it switched on.
export const staticRoots = (req, publicDir, dir) => (inPreview(req, dir) ? [dir, publicDir] : [publicDir]);

// The web-app build id (whats-new.js buildId) for the preview folder, recomputed when its files change,
// so open preview pages offer a reload after the preview is updated, like the live app does.
let cached = { key: '', id: '' };
export function previewBuild(dir, files = ['index.html', 'app.js', 'style.css']) {
  const stats = files.map((f) => { try { const s = fs.statSync(path.join(dir, f)); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } });
  const key = dir + '|' + stats.join('|');
  if (cached.key === key) return cached.id;
  const hash = crypto.createHash('sha1');
  for (const f of files) { try { hash.update(fs.readFileSync(path.join(dir, f))); } catch { /* missing: still stable */ } }
  cached = { key, id: hash.digest('hex').slice(0, 12) };
  return cached.id;
}

// Server-drawn HTML pages (sign-in, share pages) for a preview browser: adds PREVIEW_DIR/pages.css
// after their own styles. Does nothing without the cookie or without that file.
export function previewPageStyles(req, res, dir) {
  if (!inPreview(req, dir) || !fs.existsSync(path.join(dir, 'pages.css'))) return;
  const end = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null;
    if (text && /^\s*<!doctype html/i.test(text) && text.includes('</head>')) {
      chunk = text.replace('</head>', '<link rel="stylesheet" href="/pages.css"></head>');
    }
    return end(chunk, ...rest);
  };
}
