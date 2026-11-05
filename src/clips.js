// Clips: the game clips the Arch desktop moves to this server (ember-clip sync: Kept/<game>/ and
// Trimmed Clips/ under CLIPS_DIR). The Clips tab is for the server's owner only (ADMIN_EMAILS);
// a clip leaves that circle only when it's shared.
//
// Sharing gives a clip an unguessable link, /c/<token>. That page, its video and its thumbnail
// are the only public things on the server: they work without Cloudflare Access once /c/ is
// bypassed there (see README). The page is Marquee's player with only that clip in it, so anyone
// with the link can watch it (and nothing else); in Discord the link shows the clip's thumbnail.
// The clips are AV1 with separate game / friends / mic tracks, which not every browser can play,
// so sharing makes a full-resolution, near-lossless H.264 copy with the tracks mixed into one.
// Unsharing kills the link and deletes that copy.
import fs from 'node:fs';
import { trackChild } from './load.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const CLIPS_DIR = process.env.CLIPS_DIR ? path.resolve(process.env.CLIPS_DIR) : null;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const SCAN_MS = 30 * 1000;
const TRASH_DAYS = 30;       // deleted clips wait in CLIPS_DIR/.deleted this long before they're gone for good

let cacheDir = null;
let sharesFile = null;
let shares = {};          // token -> { rel, at }
let titlesFile = null;
let titles = {};          // stable clip id -> display name; files and public links stay put
let scanned = { at: 0, list: [] };
const jobs = new Map();   // clip id -> Promise (share copy being made)
const failed = new Map(); // clip id -> error message

export function initClips({ dataDir }) {
  cacheDir = path.join(dataDir, 'cache', 'clips');
  sharesFile = path.join(dataDir, '.marquee-shares.json');
  try { shares = JSON.parse(fs.readFileSync(sharesFile, 'utf8')); } catch { shares = {}; }
  titlesFile = path.join(dataDir, '.marquee-clip-titles.json');
  try { titles = JSON.parse(fs.readFileSync(titlesFile, 'utf8')); } catch { titles = {}; }
  if (!titles || typeof titles !== 'object' || Array.isArray(titles)) titles = {};
  scanned = { at: 0, list: [] };
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

// "Kept/Counter-Strike 2/clip.mp4" → game "Counter-Strike 2"; trims made in Marquee keep their game
// ("Trimmed Clips/<Game>/x.mp4"); the desktop's flat "Trimmed Clips/x.mp4" → "Trimmed".
function gameOf(rel) {
  const parts = rel.split('/');
  if ((parts[0] === 'Kept' || parts[0] === 'Trimmed Clips') && parts.length > 2) return parts[1];
  if (parts[0] === 'Trimmed Clips') return 'Trimmed';
  return parts.length > 1 ? parts[parts.length - 2] : 'Clips';
}
// Desktop clip names look like "Replay_2026-11-01_21-14-03.mp4" or "<game> 2026-11-01 21-14.mp4".
const titleOf = (rel) => path.basename(rel, path.extname(rel)).replace(/[_]+/g, ' ').trim();
const displayTitle = (rel) => typeof titles[idOf(rel)] === 'string' && titles[idOf(rel)] ? titles[idOf(rel)] : titleOf(rel);

export async function scan(force = false) {
  if (!CLIPS_DIR) return [];
  purgeTrash();
  if (!force && Date.now() - scanned.at < SCAN_MS) return scanned.list;
  const files = await walk(CLIPS_DIR);
  scanned = {
    at: Date.now(),
    list: files.sort((a, b) => b.mtime - a.mtime).map((f) => ({
      id: idOf(f.rel), rel: f.rel, title: displayTitle(f.rel), game: gameOf(f.rel), size: f.size, mtime: f.mtime,
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
    trackChild(child, cmd, args, 'clips');
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

// A copy Discord (and every browser) plays: H.264 8-bit at the clip's own resolution and frame
// rate, one stereo AAC track that mixes every audio track of the original. Clips with 4+ tracks
// (clip-replay and Clipper since 2026-11-02) already start with that mix (ALL, then game / friends /
// mic), so that AAC track is copied untouched.
// Video is visually lossless on purpose: x264 preset slow, CRF 10, no bitrate cap, always on the
// CPU (the GTX 1650's NVENC is a lot worse per bit). Measured 2026-11-04 on a CS2 clip against the
// AV1 original, VMAF mean / worst 5 % of frames: CRF 10 99.5 / 97.0 at ~82 Mbps (CRF 6: 99.6 / 97.2
// at 130 Mbps; the old 1080p veryfast CRF 22 12M copy: 85.4 / 79.8). That takes ~15 fps on the
// i5-14600KF, so a 90 s clip's copy needs ~6 minutes; the upload (~350 Mbit/s) streams it easily.
const SHARE_X264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '10', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
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
    // the one track that's already the mix: copy it when it's stereo-or-less AAC, else re-encode
    const mix = mixTrack(audio);
    if (mix) args.push('-map', '0:a:0');
    else if (audio.length > 1) {
      args.push('-filter_complex', `${audio.map((_, i) => `[0:a:${i}]`).join('')}amix=inputs=${audio.length}:duration=longest:normalize=0,alimiter=limit=0.95[a]`, '-map', '[a]');
    }
    if ((v.width || 0) % 2 || (v.height || 0) % 2) args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'); // 4:2:0 needs even sizes
    const tail = [...SHARE_X264];
    if (mix && mix.codec_name === 'aac' && (Number(mix.channels) || 2) <= 2) tail.push('-c:a', 'copy');
    else if (audio.length) tail.push('-c:a', 'aac', '-b:a', '320k', '-ac', '2');
    tail.push('-movflags', '+faststart', tmp);
    try {
      await run(FFMPEG, [...args, ...tail]);
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

export async function renameClip(id, title, previousTitle) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw Object.assign(new Error('Give the clip a name of 1–120 characters, on one line.'), { status: 400 });
  }
  const c = await byId(id);
  const current = displayTitle(c.rel);
  if (previousTitle !== undefined && previousTitle !== current) {
    throw Object.assign(new Error('This clip was renamed on another device. Refresh before renaming it.'), { status: 409 });
  }
  const next = { ...titles, [c.id]: title.trim() };
  const temp = `${titlesFile}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(next)); fs.renameSync(temp, titlesFile); }
  finally { fs.rmSync(temp, { force: true }); }
  titles = next; scanned.at = 0;
  return { id: c.id, title: next[c.id] };
}

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

// ---------- lossless trimming ----------
// Stream copy: nothing is re-encoded, so quality is identical to the original and no GPU is used.
// The catch: a copy can only start on a keyframe, so the start snaps back to the keyframe at or
// before the chosen point (the UI shows where). The end is cut where asked. All tracks are kept.
async function keyframeTimes(file) {
  // packet flags only: no decoding, so it's fast even for AV1 on a GPU that can't decode it
  const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file]);
  const keys = [];
  for (const line of out.split(/\r?\n/)) {
    const [t, flags] = line.split(',');
    if (flags?.includes('K') && Number.isFinite(Number(t))) keys.push(Number(t));
  }
  return keys.sort((a, b) => a - b);
}
// ---------- audio tracks ----------
// clip-replay (magi) records four tracks: 1 everything mixed (what browsers, Discord and phones
// play), 2 game, 3 friends (Discord), 4 you (mic). Older clips have three tracks and no mix.
// Copies Marquee makes name their tracks, so the mix is still found when there are fewer than four.
const RECORDER_TRACKS = ['Mix', 'Game', 'Friends', 'You'];
// MP4 keeps a track's name as its handler name; ffmpeg's default ones ("SoundHandler") aren't names.
const titleOfTrack = (a) => {
  const t = String(a?.tags?.title || a?.tags?.TITLE || a?.tags?.handler_name || '').trim();
  return /^(sound|audio|video)\s*handler$|^$/i.test(t) || /^core media/i.test(t) ? '' : t;
};
export function trackLayout(audio) {
  const titled = audio.some((a) => titleOfTrack(a));
  return audio.map((a, i) => {
    const title = titled ? titleOfTrack(a) : audio.length === 4 ? RECORDER_TRACKS[i] : '';
    const mix = titled ? /^(mix|all)$/i.test(title) : audio.length === 4 && i === 0;
    return { index: i, mix, label: title || `Track ${i + 1}`, mic: /^(you|mic)/i.test(title) };
  });
}
// The track that already has everything in it, or null when the tracks still need mixing.
export function mixTrack(audio) {
  const layout = trackLayout(audio);
  if (layout[0]?.mix || audio.length === 1) return audio[0];
  return null;
}

export async function trimInfo(id) {
  const c = await byId(id);
  const file = fullPath(c.rel);
  const [{ duration, audio }, keys] = await Promise.all([probe(file), keyframeTimes(file)]);
  const first = keys[0] || 0; // container start offset: everything below is relative to it
  return { duration, keyframes: keys.map((k) => Math.round((k - first) * 1000) / 1000), tracks: trackLayout(audio) };
}
// Lossless editing: one or more parts of the clip are kept, in order, and joined into a new file.
// Each part is cut with a stream copy (so it starts on the keyframe at or before its chosen start)
// and the parts are joined with ffmpeg's concat demuxer, also a copy. A gap between two kept parts
// must reach past the next part's keyframe, or the "removed" bit would be in the copy anyway.
const bad = (message) => Object.assign(new Error(message), { status: 400 });
export function planSegments(segments, { duration, keyframes }) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 50) throw bad('Keep between 1 and 50 parts of the clip.');
  const snap = (t) => keyframes.filter((k) => k <= t + 0.001).pop() ?? 0;
  const parts = segments.map((seg) => {
    const start = Number(seg?.start), end = Number(seg?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 0.05 || end - start < 0.3) {
      throw bad('Each kept part needs a start and an end inside the clip, at least 0.3 s apart.');
    }
    return { start, end: Math.min(end, duration), from: snap(start) };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].from < parts[i - 1].end - 0.001) {
      throw bad(`The cut before ${parts[i].start.toFixed(1)} s is too short to remove without re-encoding: the next part has to start on the keyframe at ${parts[i].from.toFixed(1)} s. Make the cut longer or keep it.`);
    }
  }
  const total = parts.reduce((n, p) => n + p.end - p.from, 0);
  if (total < 1) throw bad('The edited clip has to be at least 1 second long.');
  return parts;
}
// Which audio tracks the copy keeps. `remove` lists separate tracks (never the mix: that's rebuilt
// from the tracks that stay). Returns null when nothing changes, so the copy stays a plain copy.
export function planTracks(layout, remove = []) {
  if (!Array.isArray(remove) || !remove.length) return null;
  const drop = new Set(remove.map(Number));
  for (const i of drop) {
    const t = layout[i];
    if (!t) throw bad('That audio track isn’t in this clip.');
    if (t.mix) throw bad('The mix can’t be removed on its own: remove the tracks you don’t want in it.');
  }
  const keep = layout.filter((t) => !t.mix && !drop.has(t.index));
  const hasMix = layout.some((t) => t.mix);
  // A rebuilt mix comes first (players only play track 1). One track left is its own mix.
  return { keep, mix: hasMix && keep.length > 1, removed: layout.filter((t) => drop.has(t.index)) };
}
export async function trim(id, segments, { deleteOriginal = false, removeTracks = [] } = {}) {
  const c = await byId(id);
  const src = fullPath(c.rel);
  const info = await trimInfo(id);
  const parts = planSegments(segments, info);
  const tracks = planTracks(info.tracks, removeTracks);
  const dir = path.join(CLIPS_DIR, 'Trimmed Clips', c.game === 'Trimmed' ? '' : c.game);
  await fs.promises.mkdir(dir, { recursive: true });
  const stem = c.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[ .]+$/, '').slice(0, 100) || 'Clip';
  const base = `${stem} (${parts.length > 1 || tracks ? 'edit' : 'trim'})`;
  let name = `${base}.mp4`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} ${i}.mp4`;
  const dest = path.join(dir, name);
  const tmp = `${dest}.marquee-tmp.mp4`;
  // a dot-folder next to the result: same drive, and the clip scan skips it
  const work = path.join(dir, `.marquee-edit-${crypto.randomBytes(6).toString('hex')}`);
  const cutTmp = tracks ? path.join(work, 'cut.mp4') : tmp;
  const cut = (p, out, extra = []) => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-ss', String(p.from), '-i', src, '-t', String(p.end - p.from),
    '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...extra, out]);
  try {
    await fs.promises.mkdir(work, { recursive: true });
    if (parts.length === 1) await cut(parts[0], cutTmp, ['-movflags', '+faststart']);
    else {
      const names = parts.map((_, i) => `part${i}.mp4`);
      for (let i = 0; i < parts.length; i++) await cut(parts[i], path.join(work, names[i]));
      await fs.promises.writeFile(path.join(work, 'parts.txt'), names.map((n) => `file '${n}'`).join('\n') + '\n');
      await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'parts.txt'),
        '-map', '0', '-c', 'copy', '-movflags', '+faststart', cutTmp]);
    }
    if (tracks) {
      // Video and the kept tracks are copied; only a rebuilt mix is encoded (AAC 320k, like share copies).
      const args = ['-hide_banner', '-nostdin', '-y', '-i', cutTmp];
      const out = []; // [map, title, encode?]
      if (tracks.mix) {
        args.push('-filter_complex', `${tracks.keep.map((t) => `[0:a:${t.index}]`).join('')}amix=inputs=${tracks.keep.length}:duration=longest:normalize=0,alimiter=limit=0.95[mix]`);
        out.push(['[mix]', 'Mix', true]);
      }
      for (const t of tracks.keep) out.push([`0:a:${t.index}`, t.label, false]);
      args.push('-map', '0:v:0');
      for (const [map] of out) args.push('-map', map);
      args.push('-c:v', 'copy', '-map_metadata', '0');
      out.forEach(([, title, encode], i) => {
        args.push(`-c:a:${i}`, encode ? 'aac' : 'copy', `-metadata:s:a:${i}`, `title=${title}`, `-metadata:s:a:${i}`, `handler_name=${title}`, `-disposition:a:${i}`, i ? '0' : 'default');
        if (encode) args.push(`-b:a:${i}`, '320k');
      });
      args.push('-movflags', '+faststart', tmp);
      await run(FFMPEG, args);
    }
    await fs.promises.rename(tmp, dest);
  } finally {
    await fs.promises.rm(tmp, { force: true });
    await fs.promises.rm(work, { recursive: true, force: true });
  }
  scanned.at = 0;
  if (deleteOriginal) await deleteClip(id);
  return { ok: true, title: path.basename(name, '.mp4'), parts: parts.map((p) => ({ start: p.from, end: p.end })),
    removedTracks: tracks ? tracks.removed.map((t) => t.label) : [],
    start: parts[0].from, end: parts.at(-1).end, original: c.title };
}

// Delete: the share link and its copy go, the thumbnail goes, and the clip itself moves to
// CLIPS_DIR/.deleted/ (skipped by the scan, like every dot-folder) where it's erased after
// TRASH_DAYS. Same drive, so it's a rename: instant, and recoverable until then.
const trashDir = () => path.join(CLIPS_DIR, '.deleted');
export async function deleteClip(id) {
  const c = await byId(id);
  await unshare(id);
  await fs.promises.rm(path.join(cacheDir, 'thumbs', `${id}.jpg`), { force: true });
  await fs.promises.mkdir(trashDir(), { recursive: true });
  const dest = path.join(trashDir(), `${Date.now()}--${c.rel.replace(/[\\/]/g, '__')}`);
  await fs.promises.rename(fullPath(c.rel), dest);
  scanned.at = 0; // next scan starts fresh
  return { ok: true, title: c.title };
}

let purgedAt = 0;
function purgeTrash() {
  if (Date.now() - purgedAt < 3600 * 1000) return;
  purgedAt = Date.now();
  fs.promises.readdir(trashDir()).then((names) => Promise.all(names.map((n) => {
    const at = Number(n.split('--')[0]);
    if (at && Date.now() - at > TRASH_DAYS * 86400000) return fs.promises.rm(path.join(trashDir(), n), { force: true });
    return null;
  }))).catch(() => { /* no trash yet */ });
}

// ---------- public share pages (/c/...) ----------
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// Absolute links for the embed: PUBLIC_URL if set, else the host the visitor used (Cloudflare
// Tunnel passes the public hostname through; it's https whenever CF-Ray is present).
export const baseUrl = (req) => PUBLIC_URL || `${req.headers['cf-ray'] || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;

function sharedClip(token) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(token) || !Object.hasOwn(shares, token)) return null;
  const rel = shares[token].rel;
  return { token, rel, id: idOf(rel), title: displayTitle(rel), game: gameOf(rel) };
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
.wait{margin-top:18px;padding:40px;border:1px dashed #4B2C3F;border-radius:14px;text-align:center}
.card{max-width:460px;margin:0 auto;padding:28px 24px;background:#2B1724;border:1px solid #4B2C3F;border-radius:18px}
.card h1{margin-bottom:8px}.card p+p{margin-top:10px}
form{margin-top:20px;display:grid;gap:10px}
label{font-size:14px;color:#BA9DAD}
input[type=email]{font:inherit;color:#F6EADF;background:#1F1019;border:1px solid #4B2C3F;border-radius:12px;padding:12px 14px}
input[type=email]:focus{outline:2px solid #F4C152;border-color:transparent}
button{font:700 16px/1 system-ui,sans-serif;color:#1F1019;background:#F4C152;border:0;border-radius:999px;padding:14px 18px;cursor:pointer}
.err{color:#FF9B85}.ok{color:#F4C152;font-weight:700}`;

export function page({ title, desc, url, image, images = [], video, body }) {
  const og = [
    ['og:site_name', 'Marquee'], ['og:title', title], ['og:description', desc], ['og:url', url],
    ['og:type', video ? 'video.other' : 'website'], image && ['og:image', image], ...images.map((i) => ['og:image', i]),
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
export async function handlePublic(req, res, url, { sendVideo, previews }) {
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
  // The shared clip player: Marquee's own stylesheet and a player script for one clip.
  if (p === '/c/style.css' || p === '/c/player.js' || p === '/c/seek-preview.js') {
    const file = new URL({ '/c/style.css': '../public/style.css', '/c/player.js': '../public/clip-share.js', '/c/seek-preview.js': '../public/seek-preview.js' }[p], import.meta.url);
    try { return send(200, p.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', await fs.promises.readFile(file), { 'Cache-Control': 'no-cache' }); }
    catch { return send(404, 'text/plain', 'Not found.'); }
  }
  if (p === '/c/marquee.png') {
    const file = new URL('../public/og-marquee.png', import.meta.url);
    try { return send(200, 'image/png', await fs.promises.readFile(file)); } catch { return send(404, 'text/plain', 'Not found.'); }
  }

  const m = p.match(/^\/c\/([A-Za-z0-9_-]{16})(?:\/(video\.mp4|thumb\.jpg|preview\.json|preview\/(\d{1,4})\.jpg))?\/?$/);
  if (!m) return false;
  const clip = sharedClip(m[1]);
  if (!clip) return send(404, 'text/html; charset=utf-8', page({ title: 'Clip not found', desc: 'This link doesn’t work any more.', url: '', body: '<h1>This clip isn’t shared any more</h1><p>Ask whoever sent it for a new link.</p>' }), { 'Cache-Control': 'no-store' });

  if (m[2] === 'thumb.jpg') {
    try { return send(200, 'image/jpeg', await fs.promises.readFile(await thumbnail(clip.id))); } catch { return send(404, 'text/plain', 'Not found.'); }
  }
  const copy = sharePath(clip.id);
  const ready = fs.existsSync(copy);
  // Timeline previews of the share copy, for the seek bar (previews.js).
  if (previews && (m[2] === 'preview.json' || m[3] != null)) {
    if (!ready) return send(404, 'text/plain', 'Not found.', { 'Cache-Control': 'no-store' });
    if (m[3] == null) return send(200, 'application/json; charset=utf-8', JSON.stringify(await previews.index(copy)), { 'Cache-Control': 'no-store' });
    const jpg = await previews.sheet(copy, Number(m[3]));
    if (!jpg) return send(404, 'text/plain', 'Not ready yet.', { 'Cache-Control': 'no-store' });
    return send(200, 'image/jpeg', await fs.promises.readFile(jpg), { 'Cache-Control': 'public, max-age=604800' });
  }
  if (m[2] === 'video.mp4') {
    if (!ready) return send(503, 'text/plain', 'Still being prepared.', { 'Retry-After': '30', 'Cache-Control': 'no-store' });
    await sendVideo(req, res, copy);
    return true;
  }

  const base = baseUrl(req);
  const link = `${base}/c/${clip.token}`;
  if (!ready) {
    if (!jobs.has(clip.id)) makeShareCopy({ id: clip.id, rel: clip.rel }); // e.g. the copy was deleted from the cache
    return send(200, 'text/html; charset=utf-8', page({
      title: clip.title, desc: `${clip.game} · clip from the home server`, url: link, image: `${link}/thumb.jpg`,
      body: `<h1>${esc(clip.title)}</h1><p>${esc(clip.game)}</p><div class="wait"><p>This clip is still being prepared. Reload in a minute.</p></div><script>setTimeout(()=>location.reload(),15000)</script>`,
    }), { 'Cache-Control': 'no-store' });
  }
  return send(200, 'text/html; charset=utf-8', playerPage({ title: clip.title, game: clip.game, link }), { 'Cache-Control': 'no-store' });
}

// Discord shows the thumbnail as a large card; clicking it opens this page. The video is the
// full-quality copy, played in Marquee's player, and the page has no way into the rest of Marquee.
function playerPage({ title, game, link }) {
  const local = new URL(link).pathname; // same host the viewer used
  const og = [['og:site_name', 'Marquee'], ['og:title', title], ['og:description', `${game} · watch the clip`], ['og:url', link],
    ['og:type', 'website'], ['og:image', `${link}/thumb.jpg`], ['twitter:card', 'summary_large_image'], ['twitter:image', `${link}/thumb.jpg`]]
    .map(([k, v]) => `<meta ${k.startsWith('twitter:') ? 'name' : 'property'}="${k}" content="${esc(v)}">`).join('\n  ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <meta name="color-scheme" content="dark">
  <meta name="robots" content="noindex">
  <title>${esc(title)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎞️</text></svg>">
  ${og}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/c/style.css">
</head>
<body class="in-player">
  <div class="player ui-visible is-paused" id="player" role="region" aria-label="${esc(title)}">
    <div class="player-stage" id="player-stage">
      <video id="video" src="${esc(`${local}/video.mp4`)}" poster="${esc(`${local}/thumb.jpg`)}" playsinline preload="auto"></video>
      <div class="player-spinner" id="player-spinner" hidden></div>
      <div class="player-osd" id="player-osd" aria-hidden="true"></div>
    </div>
    <div class="player-bar">
      <p class="player-title" id="player-title">${esc(title)}<span class="player-game"> · ${esc(game)}</span></p>
    </div>
    <div class="player-center">
      <button class="pc-btn pc-skip" data-skip="-10" aria-label="Back 10 seconds (J)"></button>
      <button class="pc-btn pc-big-play" aria-label="Play (Space)"></button>
      <button class="pc-btn pc-skip" data-skip="10" aria-label="Forward 10 seconds (L)"></button>
    </div>
    <div class="player-controls" id="player-controls">
      <div class="seek-row">
        <span class="pc-time" id="pc-time">0:00</span>
        <div class="seek" id="seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
          <div class="seek-track"><div class="seek-buffer" id="seek-buffer"></div><div class="seek-fill" id="seek-fill"></div></div>
          <div class="seek-thumb" id="seek-thumb"></div>
          <div class="seek-tip" id="seek-tip" hidden></div>
        </div>
        <button class="pc-time pc-duration" id="pc-duration" title="Show time remaining">–:––</button>
      </div>
      <div class="pc-row">
        <button class="pc-btn pc-play" id="pc-play" aria-label="Play (Space)"></button>
        <button class="pc-btn pc-skip" data-skip="-10" aria-label="Back 10 seconds (J)"></button>
        <button class="pc-btn pc-skip" data-skip="10" aria-label="Forward 10 seconds (L)"></button>
        <div class="pc-volume" id="pc-volume">
          <button class="pc-btn" id="pc-mute" aria-label="Mute (M)"></button>
          <input type="range" id="pc-vol" min="0" max="1" step="0.05" value="1" aria-label="Volume">
        </div>
        <span class="pc-spacer"></span>
        <button class="pc-btn" id="pc-pip" aria-label="Picture in picture (P)" hidden></button>
        <button class="pc-btn" id="pc-fs" aria-label="Fullscreen (F)"></button>
      </div>
    </div>
    <p class="player-error" id="player-error" role="alert" hidden></p>
  </div>
  <script type="module" src="/c/player.js"></script>
</body>
</html>`;

}
