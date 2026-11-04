// Shared note links (/c/n/<token>), let past Cloudflare Access like clips so Discord can embed them.
// Only link-preview bots get the note's preview page. Everyone else is sent to the note inside the
// normal app, which is still behind Cloudflare Access, so the link alone doesn't open the note.
import fs from 'node:fs';
import { page, baseUrl, esc } from './clips.js';

// Crawlers that fetch a link to build its preview card. Discord's is "Discordbot".
export const PREVIEW_BOT = /Discordbot|Twitterbot|facebookexternalhit|Slackbot|TelegramBot|WhatsApp|LinkedInBot|Embedly|redditbot|SkypeUriPreview|Iframely|Mastodon|vkShare|Bluesky|Applebot/i;
// Image types Discord shows in an embed.
const EMBED_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const clip = (s, n) => s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
export function previewOf(note) {
  const text = note.text.replace(/\r/g, '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const files = note.attachments.length;
  const extra = files ? `${files} attachment${files === 1 ? '' : 's'}` : '';
  return {
    title: clip(lines[0] || (files ? `Note with ${extra}` : 'Note'), 90),
    desc: clip(lines.slice(1).join('\n') || (lines[0] && lines[0].length > 90 ? text : '') || extra || 'A note shared from Marquee.', 400),
    image: note.attachments.find((a) => a.fileId && EMBED_IMAGES.has(a.mime)) || null,
  };
}

export async function handlePublic(req, res, url, { notes, nameFor }) {
  const m = url.pathname.match(/^\/c\/n\/([A-Za-z0-9_-]{16})(?:\/(image))?\/?$/);
  if (!m) return false;
  const send = (status, type, data, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', Vary: 'User-Agent', ...extra });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  };
  const note = notes.shared(m[1]);
  const bot = PREVIEW_BOT.test(req.headers['user-agent'] || '');
  if (!note) {
    return send(404, 'text/html; charset=utf-8', page({ title: 'Note not found', desc: 'This link doesn’t work any more.', url: '',
      body: '<div class="card"><h1>This note isn’t shared any more</h1><p>Ask whoever sent it for a new link.</p><p><a class="brand" href="/">Open Marquee</a></p></div>' }));
  }
  const preview = previewOf(note);
  if (m[2] === 'image') {
    const file = preview.image && notes.file(preview.image.fileId);
    if (!file) return send(404, 'text/plain; charset=utf-8', 'Not found.');
    try { return send(200, file.mime, await fs.promises.readFile(file.full), { 'X-Content-Type-Options': 'nosniff' }); }
    catch { return send(404, 'text/plain; charset=utf-8', 'Not found.'); }
  }
  const open = `/?note=${note.id}`;
  if (!bot) return send(302, 'text/plain; charset=utf-8', 'Opening Marquee…', { Location: open });
  const link = `${baseUrl(req)}/c/n/${m[1]}`;
  const by = nameFor(note.author);
  return send(200, 'text/html; charset=utf-8', page({
    title: preview.title, url: link,
    desc: `${preview.desc}${by ? `\n— ${by}` : ''}`,
    image: preview.image ? `${link}/image` : null,
    body: `<h1>Marquee</h1><p>Opening…</p><script>location.replace(${JSON.stringify(open)})</script><noscript><a class="brand" href="${esc(open)}">Open the note in Marquee</a></noscript>`,
  }));
}
