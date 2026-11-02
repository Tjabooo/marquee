// Clips: the game clips the Arch desktop moves to this server (ember-clip sync: Kept/<game>/ and
// Trimmed Clips/ under CLIPS_DIR). The Clips tab is for the server's owner only (ADMIN_EMAILS);
// a clip leaves that circle only when it's shared.
//
// Sharing gives a clip an unguessable link, /c/<token>. That page, its video and its thumbnail
// are the only public things on the server: they work without Cloudflare Access once /c/ is
// bypassed there (see README), and they carry OpenGraph tags so the link embeds and plays in
// Discord. The clips are AV1 with separate game / friends / mic tracks, which Discord can't play,
// so sharing makes an H.264 copy with all tracks mixed into one (like `ember-clip share`).
// Unsharing kills the link and deletes that copy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const CLIPS_DIR = process.env.CLIPS_DIR ? path.resolve(process.env.CLIPS_DIR) : null;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const SCAN_MS = 30 * 1000;

let cacheDir = null;
let sharesFile = null;
let shares = {};          // token -> { rel, at }
let encoder = () => null; // 'nvenc' | 'x264' | null, from the converter
let scanned = { at: 0, list: [] };
const jobs = new Map();   // clip id -> Promise (share copy being made)
const failed = new Map(); // clip id -> error message

export function initClips({ dataDir, getEncoder }) {
  cacheDir = path.join(dataDir, 'cache', 'clips');
  sharesFile = path.join(dataDir, '.marquee-shares.json');
  try { shares = JSON.parse(fs.readFileSync(sharesFile, 'utf8')); } catch { shares = {}; }
  encoder = getEncoder;
  for (const d of ['thumbs', 'share']) fs.mkdirSync(path.join(cacheDir, d), { recursive: true });
}

export const clipsConfigured = () => Boolean(CLIPS_DIR);
const saveShares = () => { try { fs.writeFileSync(sharesFile, JSON.stringify(shares)); } catch { /* memory only */ } };
const idOf = (rel) => crypto.createHash('sha1').update(rel.toLowerCase()).digest('base64url').slice(0, 16);
const tokenFor = (rel) => Object.keys(shares).find((t) => shares[t].rel === rel) || null;

// ---------- library ----------
async function walk(dir, rel = '', depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(path.join(dir, e.name), r, depth + 1, out);
    else if (EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        const st = await fs.promises.stat(path.join(dir, e.name));
        out.push({ rel: r, size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return out;
}

// "Kept/Counter-Strike 2/clip.mp4" → game "Counter-Strike 2"; "Trimmed Clips/x.mp4" → "Trimmed".
function gameOf(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'Kept' && parts.length > 2) return parts[1];
  if (parts[0] === 'Trimmed Clips') return 'Trimmed';
  return parts.length > 1 ? parts[parts.length - 2] : 'Clips';
}
// Desktop clip names look like "Replay_2026-11-01_21-14-03.mp4" or "<game> 2026-11-01 21-14.mp4".
const titleOf = (rel) => path.basename(rel, path.extname(rel)).replace(/[_]+/g, ' ').trim();

export async function scan(force = false) {
  if (!CLIPS_DIR) return [];
  if (!force && Date.now() - scanned.at < SCAN_MS) return scanned.list;
  const files = await walk(CLIPS_DIR);
  scanned = {
    at: Date.now(),
    list: files.sort((a, b) => b.mtime - a.mtime).map((f) => ({
      id: idOf(f.rel), rel: f.rel, title: titleOf(f.rel), game: gameOf(f.rel), size: f.size, mtime: f.mtime,
    })),
  };
  return scanned.list;
}

async function byId(id) {
  const c = (await scan()).find((x) => x.id === id) || (await scan(true)).find((x) => x.id === id);
  if (!c) throw Object.assign(new Error('That clip is no longer on the server.'), { status: 404 });
  return c;
}
// Resolved inside CLIPS_DIR only (rel comes from our own scan or the shares file).
function fullPath(rel) {
  const full = path.resolve(CLIPS_DIR, rel);
  if (!full.startsWith(CLIPS_DIR + path.sep)) throw Object.assign(new Error('Bad clip path.'), { status: 400 });
  return full;
}

// ---------- ffmpeg helpers ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(errorLine(err) || `exit code ${code}`))));
  });
}
// The meaningful line of ffmpeg's stderr (its last line is usually just "Conversion failed!").
function errorLine(s) {
  const lines = s.trim().split(/\r?\n/).filter((l) => l && !/^Conversion failed/i.test(l));
  return lines.reverse().find((l) => /error|invalid|cannot|could not|not supported|no such|denied|failed/i.test(l)) || lines[0] || '';
}

async function probe(file) {
  const info = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).filter((s) => s.codec_type === 'audio');
  return { v, audio, duration: Number(info.format?.duration) || null };
}

export async function thumbnail(id) {
  const c = await byId(id);
  const out = path.join(cacheDir, 'thumbs', `${id}.jpg`);
  if (!fs.existsSync(out)) {
    const src = fullPath(c.rel);
    // a frame 1 s in (clips start mid-action; frame 0 is sometimes black)
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-ss', '1', '-i', src, '-frames:v', '1',
      '-vf', 'scale=1280:-2', '-q:v', '4', out]).catch(() => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', out]));
  }
  return out;
}

// A copy Discord (and every browser) plays: H.264 8-bit, at most 1080p, one stereo AAC track
// that mixes every audio track of the original.
const sharePath = (id) => path.join(cacheDir, 'share', `${id}.mp4`);
function makeShareCopy(c) {
  if (jobs.has(c.id)) return jobs.get(c.id);
  failed.delete(c.id);
  const job = (async () => {
    const src = fullPath(c.rel);
    const { v, audio } = await probe(src);
    if (!v) throw new Error('No video in this clip.');
    const tmp = `${sharePath(c.id)}.marquee-tmp.mp4`;
    const args = ['-hide_banner', '-nostdin', '-y', '-i', src, '-map', '0:v:0'];
    if (audio.length > 1) {
      args.push('-filter_complex', `${audio.map((_, i) => `[0:a:${i}]`).join('')}amix=inputs=${audio.length}:duration=longest:normalize=0,alimiter=limit=0.95[a]`, '-map', '[a]');
    } else if (audio.length === 1) args.push('-map', '0:a:0');
    if ((v.height || 0) > 1080) args.push('-vf', 'scale=-2:1080');
    const tail = ['-pix_fmt', 'yuv420p', '-profile:v', 'high'];
    if (audio.length) tail.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
    tail.push('-movflags', '+faststart', tmp);
    const NVENC = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', '12M', '-bufsize', '24M'];
    const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '12M', '-bufsize', '24M'];
    try {
      // NVENC on the server's GPU when the converter found it; the CPU when that isn't there or fails
      if (encoder() === 'nvenc') {
        try { await run(FFMPEG, [...args, ...NVENC, ...tail]); } catch { await run(FFMPEG, [...args, ...X264, ...tail]); }
      } else await run(FFMPEG, [...args, ...X264, ...tail]);
      await fs.promises.rename(tmp, sharePath(c.id));
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  })().catch((e) => { failed.set(c.id, e.message); throw e; }).finally(() => jobs.delete(c.id));
  job.catch(() => {}); // failures are reported through clip state
  jobs.set(c.id, job);
  return job;
}

function shareState(c) {
  const token = tokenFor(c.rel);
  if (!token) return null;
  const ready = fs.existsSync(sharePath(c.id));
  return { token, ready, working: jobs.has(c.id), error: failed.get(c.id) || null };
}

// ---------- API (owner only; checked by the caller) ----------
export async function listClips() {
  return { configured: clipsConfigured(), clips: (await scan()).map((c) => ({ ...c, rel: undefined, share: shareState(c) })) };
}
export const clipFile = async (id) => fullPath((await byId(id)).rel);

export async function share(id) {
  const c = await byId(id);
  let token = tokenFor(c.rel);
  if (!token) {
    token = crypto.randomBytes(12).toString('base64url'); // 96 bits: not guessable
    shares[token] = { rel: c.rel, at: Date.now() };
    saveShares();
  }
  if (!fs.existsSync(sharePath(c.id))) makeShareCopy(c);
  return { token, title: c.title, ...shareState(c) };
}

export async function unshare(id) {
  const c = await byId(id);
  for (const t of Object.keys(shares)) if (shares[t].rel === c.rel) delete shares[t];
  saveShares();
  await fs.promises.rm(sharePath(c.id), { force: true });
  return { ok: true, title: c.title };
}

// ---------- public share pages (/c/...) ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// Absolute links for the embed: PUBLIC_URL if set, else the host the visitor used (Cloudflare
// Tunnel passes the public hostname through; it's https whenever CF-Ray is present).
export const baseUrl = (req) => PUBLIC_URL || `${req.headers['cf-ray'] || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;

function sharedClip(token) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(token) || !Object.hasOwn(shares, token)) return null;
  const rel = shares[token].rel;
  return { token, rel, id: idOf(rel), title: titleOf(rel), game: gameOf(rel) };
}

const PAGE_CSS = `
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#1F1019;color:#F6EADF;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:1100px}
h1{font:800 clamp(22px,4vw,34px)/1.15 "Bricolage Grotesque","Avenir Next","Segoe UI",system-ui,sans-serif;margin:0 0 4px}
p{margin:0;color:#BA9DAD}
video{display:block;width:100%;aspect-ratio:16/9;background:#000;border-radius:14px;margin-top:18px;border:1px solid #4B2C3F}
.brand{color:#F4C152;font-weight:800;letter-spacing:.02em;text-decoration:none}
.foot{margin-top:14px;font-size:13px}
.wait{margin-top:18px;padding:40px;border:1px dashed #4B2C3F;border-radius:14px;text-align:center}`;

function page({ title, desc, url, image, video, body }) {
  const og = [
    ['og:site_name', 'Marquee'], ['og:title', title], ['og:description', desc], ['og:url', url],
    ['og:type', video ? 'video.other' : 'website'], image && ['og:image', image],
    ...(video ? [['og:video', video.url], ['og:video:secure_url', video.url], ['og:video:type', 'video/mp4'],
      ['og:video:width', video.width], ['og:video:height', video.height]] : []),
  ].filter(Boolean).map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join('\n  ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="theme-color" content="#F4C152">
  ${og}
  <meta name="twitter:card" content="${video ? 'player' : 'summary_large_image'}">
  ${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}
  ${video ? `<meta name="twitter:player" content="${esc(video.url)}">
  <meta name="twitter:player:width" content="${video.width}">
  <meta name="twitter:player:height" content="${video.height}">
  <meta name="twitter:player:stream" content="${esc(video.url)}">
  <meta name="twitter:player:stream:content_type" content="video/mp4">` : ''}
  <style>${PAGE_CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

// Returns true when it handled the request.
export async function handlePublic(req, res, url, { sendVideo }) {
  const p = url.pathname;
  const send = (status, type, data, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex', ...extra });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  };

  // /c/ on its own: an invite card for Marquee itself, so the site's link embeds in Discord too.
  // Visitors are sent on to the app (which is still behind Cloudflare Access).
  if (p === '/c' || p === '/c/') {
    const base = baseUrl(req);
    return send(200, 'text/html; charset=utf-8', page({
      title: 'Marquee',
      desc: 'Films and shows from the home server: browse, download, and play on your phone, in a browser or on the TV.',
      url: `${base}/c/`, image: `${base}/c/marquee.png`,
      body: `<h1>Marquee</h1><p>Opening…</p><script>location.replace('/')</script>`,
    }));
  }
  if (p === '/c/marquee.png') {
    const file = new URL('./public/og-marquee.png', import.meta.url);
    try { return send(200, 'image/png', await fs.promises.readFile(file)); } catch { return send(404, 'text/plain', 'Not found.'); }
  }

  const m = p.match(/^\/c\/([A-Za-z0-9_-]{16})(?:\/(video\.mp4|thumb\.jpg))?\/?$/);
  if (!m) return false;
  const clip = sharedClip(m[1]);
  if (!clip) return send(404, 'text/html; charset=utf-8', page({ title: 'Clip not found', desc: 'This link doesn’t work any more.', url: '', body: '<h1>This clip isn’t shared any more</h1><p>Ask whoever sent it for a new link.</p>' }), { 'Cache-Control': 'no-store' });

  if (m[2] === 'thumb.jpg') {
    try { return send(200, 'image/jpeg', await fs.promises.readFile(await thumbnail(clip.id))); } catch { return send(404, 'text/plain', 'Not found.'); }
  }
  const copy = sharePath(clip.id);
  const ready = fs.existsSync(copy);
  if (m[2] === 'video.mp4') {
    if (!ready) return send(503, 'text/plain', 'Still being prepared.', { 'Retry-After': '30', 'Cache-Control': 'no-store' });
    await sendVideo(req, res, copy);
    return true;
  }

  const base = baseUrl(req);
  const link = `${base}/c/${clip.token}`;
  let video = null;
  if (ready) {
    let w = 1920, h = 1080;
    try { const { v } = await probe(copy); w = v.width || w; h = v.height || h; } catch { /* defaults */ }
    video = { url: `${link}/video.mp4`, width: w, height: h };
  } else if (!jobs.has(clip.id)) {
    makeShareCopy({ id: clip.id, rel: clip.rel }); // e.g. the copy was deleted from the cache
  }
  const desc = `${clip.game} · clip from the home server`;
  return send(200, 'text/html; charset=utf-8', page({
    title: clip.title, desc, url: link, image: `${link}/thumb.jpg`, video,
    body: `<h1>${esc(clip.title)}</h1><p>${esc(clip.game)}</p>${ready
      ? `<video src="${esc(video.url)}" poster="${esc(`${link}/thumb.jpg`)}" controls playsinline preload="metadata"></video>`
      : '<div class="wait"><p>This clip is still being prepared. Reload in a minute.</p></div><script>setTimeout(()=>location.reload(),15000)</script>'}
      <p class="foot">Shared from <a class="brand" href="/c/">Marquee</a></p>`,
  }), ready ? {} : { 'Cache-Control': 'no-store' });
}
