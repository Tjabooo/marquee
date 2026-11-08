// Shared note links (/c/n/<token>), let past Cloudflare Access like clips so Discord can embed them.
// Only link-preview bots get the note's preview page. Everyone else is sent to the note inside the
// normal app, which is still behind Cloudflare Access, so the link alone doesn't open the note.
// The preview's media is public though: up to four images and the first video, so the embed shows
// them to anyone. Videos get an H.264 MP4 copy and a thumbnail (phones record .mov/HEVC, which
// Discord can't play), and images Discord can't show (HEIC and the like) get a JPEG copy.
import { translateHtml } from './i18n.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { trackChild } from './load.js';
import { background } from './priority.js';
import { page, baseUrl, esc } from './clips.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
// Crawlers that fetch a link to build its preview card. Discord's is "Discordbot".
export const PREVIEW_BOT = /Discordbot|Twitterbot|facebookexternalhit|Slackbot|TelegramBot|WhatsApp|LinkedInBot|Embedly|redditbot|SkypeUriPreview|Iframely|Mastodon|vkShare|Bluesky|Applebot/i;
// Image types Discord shows in an embed as they are.
const EMBED_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGES = 4;
// Close to the original for phone videos, and still quick: a minute of 1080p60 takes seconds.
const VIDEO_X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];

const clip = (s, n) => s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
export function previewOf(note) {
  const text = note.text.replace(/\r/g, '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const files = note.attachments.length;
  const extra = files ? `${files} attachment${files === 1 ? '' : 's'}` : '';
  const local = note.attachments.filter((a) => a.fileId && a.mime);
  return {
    title: clip(lines[0] || (files ? `Note with ${extra}` : 'Note'), 90),
    desc: clip(lines.slice(1).join('\n') || (lines[0] && lines[0].length > 90 ? text : '') || extra || 'A note shared from Marquee.', 400),
    images: local.filter((a) => a.mime.startsWith('image/')).slice(0, MAX_IMAGES),
    video: local.find((a) => a.mime.startsWith('video/')) || null,
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    trackChild(child, cmd, args, 'note-share');
    background(child);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const lines = err.trim().split(/\r?\n/).filter((l) => l && !/^Conversion failed/i.test(l));
      reject(new Error(lines.reverse().find((l) => /error|invalid|cannot|could not|not supported|no such|denied|failed/i.test(l)) || lines[0] || `exit code ${code}`));
    });
  });
}

// Copies made for previews, kept in cache/notes-share/ by attachment ID (the file's hash).
export class SharedMedia {
  constructor(notes, { cacheDir }) {
    this.notes = notes;
    this.dir = cacheDir;
    this.jobs = new Map();   // derived file -> Promise
    this.failed = new Map(); // derived file -> error message
    fs.mkdirSync(this.dir, { recursive: true });
  }
  videoPath(id) { return path.join(this.dir, `${id}.mp4`); }
  thumbPath(id) { return path.join(this.dir, `${id}.thumb.jpg`); }
  imagePath(id) { return path.join(this.dir, `${id}.jpg`); }
  // What the preview needs that doesn't exist yet, as [output, maker].
  needed(note) {
    const { images, video } = previewOf(note);
    const out = [];
    for (const a of images) if (!EMBED_IMAGES.has(a.mime)) out.push([this.imagePath(a.fileId), (src, dest) => this.makeImage(src, dest)]);
    if (video) {
      out.push([this.videoPath(video.fileId), (src, dest) => this.makeVideo(src, dest)]);
      out.push([this.thumbPath(video.fileId), (src, dest) => this.makeThumb(src, dest)]);
    }
    return out.map(([dest, make]) => ({ dest, make, id: path.basename(dest).split('.')[0] }));
  }
  prepare(note) {
    for (const { dest, make, id } of this.needed(note)) {
      if (fs.existsSync(dest) || this.jobs.has(dest)) continue;
      const file = this.notes.file(id);
      if (!file) { this.failed.set(dest, 'The attachment is missing on the server.'); continue; }
      this.failed.delete(dest);
      const tmp = `${dest}.marquee-tmp${path.extname(dest)}`;
      const job = make(file.full, tmp)
        .then(() => fs.promises.rename(tmp, dest))
        .catch((e) => { this.failed.set(dest, e.message); console.error('[note-share]', e.message); })
        .finally(() => { fs.promises.rm(tmp, { force: true }).catch(() => {}); this.jobs.delete(dest); });
      this.jobs.set(dest, job);
    }
  }
  state(note) {
    const items = this.needed(note);
    const error = items.map((i) => this.failed.get(i.dest)).find(Boolean) || null;
    return { ready: items.every((i) => fs.existsSync(i.dest)), working: items.some((i) => this.jobs.has(i.dest)), error };
  }
  async makeVideo(src, dest) {
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...VIDEO_X264, '-c:a', 'aac', '-b:a', '256k', '-ac', '2',
      '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', dest]);
  }
  async makeThumb(src, dest) {
    let at = 1;
    try { at = Math.min(1, (Number(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src])) || 2) / 2); } catch { /* 1 s */ }
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-q:v', '3', '-f', 'image2', dest]);
  }
  async makeImage(src, dest) {
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', src, '-frames:v', '1', '-q:v', '2', '-f', 'image2', dest]);
  }
  async size(file) {
    try {
      const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
      const [width, height] = out.trim().split(',').map(Number);
      if (width && height) return { width, height };
    } catch { /* defaults */ }
    return { width: 1920, height: 1080 };
  }
  // After unsharing: drop copies no other shared note uses.
  cleanup() {
    const keep = new Set();
    for (const note of this.notes.sharedNotes()) for (const { dest } of this.needed(note)) keep.add(dest);
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const full = path.join(this.dir, name);
      if (!keep.has(full) && !name.includes('.marquee-tmp') && ![...this.jobs.keys()].includes(full)) fs.rmSync(full, { force: true });
    }
  }
}

export async function handlePublic(req, res, url, { notes, media, nameFor, sendVideo }) {
  const m = url.pathname.match(/^\/c\/n\/([A-Za-z0-9_-]{16})(?:\/(image(?:\/[0-3])?|video\.mp4|thumb\.jpg))?\/?$/);
  if (!m) return false;
  const send = (status, type, data, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', Vary: 'User-Agent', ...extra });
    res.end(req.method === 'HEAD' ? undefined : (String(type).startsWith('text/html') ? translateHtml(data) : data));
    return true;
  };
  const notFound = () => send(404, 'text/plain; charset=utf-8', 'Not found.');
  const note = notes.shared(m[1]);
  if (!note) {
    return send(404, 'text/html; charset=utf-8', page({ title: 'Note not found', desc: 'This link doesn’t work any more.', url: '',
      body: '<div class="card"><h1>This note isn’t shared any more</h1><p>Ask whoever sent it for a new link.</p><p><a class="brand" href="/">Open Marquee</a></p></div>' }));
  }
  const preview = previewOf(note);
  // ---- the preview's media: public, like a shared clip ----
  const file = async (full, type) => {
    try { return send(200, type, await fs.promises.readFile(full), { 'X-Content-Type-Options': 'nosniff' }); } catch { return notFound(); }
  };
  if (m[2]?.startsWith('image')) {
    const a = preview.images[Number(m[2].split('/')[1] || 0)];
    if (!a) return notFound();
    if (!EMBED_IMAGES.has(a.mime)) return file(media.imagePath(a.fileId), 'image/jpeg');
    const original = notes.file(a.fileId);
    return original ? file(original.full, a.mime) : notFound();
  }
  if (m[2] === 'thumb.jpg') return preview.video ? file(media.thumbPath(preview.video.fileId), 'image/jpeg') : notFound();
  if (m[2] === 'video.mp4') {
    const copy = preview.video && media.videoPath(preview.video.fileId);
    if (!copy || !fs.existsSync(copy)) return notFound();
    await sendVideo(req, res, copy, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    return true;
  }

  const open = `/?note=${note.id}`;
  if (!PREVIEW_BOT.test(req.headers['user-agent'] || '')) return send(302, 'text/plain; charset=utf-8', 'Opening Marquee…', { Location: open });
  media.prepare(note); // in case a copy went missing; normally made when the note was shared
  const link = `${baseUrl(req)}/c/n/${m[1]}`;
  const images = preview.images.map((a, i) => (EMBED_IMAGES.has(a.mime) || fs.existsSync(media.imagePath(a.fileId))) && `${link}/image/${i}`).filter(Boolean);
  let video = null;
  if (preview.video && fs.existsSync(media.videoPath(preview.video.fileId))) {
    video = { url: `${link}/video.mp4`, ...(await media.size(media.videoPath(preview.video.fileId))) };
    if (fs.existsSync(media.thumbPath(preview.video.fileId))) images.unshift(`${link}/thumb.jpg`);
  }
  const by = nameFor(note.author);
  return send(200, 'text/html; charset=utf-8', page({
    title: preview.title, url: link,
    desc: `${preview.desc}${by ? `\n— ${by}` : ''}`,
    image: images[0] || null, images: images.slice(1), video,
    body: `<h1>Marquee</h1><p>Opening…</p><script>location.replace(${JSON.stringify(open)})</script><noscript><a class="brand" href="${esc(open)}">Open the note in Marquee</a></noscript>`,
  }));
}
