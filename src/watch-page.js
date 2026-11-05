// The public face of a Watch Together link (/c/w/<token>): Discord and other chat apps can't get
// past Cloudflare Access, so this page (under the /c/ bypass, like shared clips and invites) carries
// the embed (the title, its artwork and who's hosting) and sends people on to /?watch=<token>,
// where they sign in as usual. It reveals no more than the link's holder would see after joining.
import { esc, page, baseUrl } from './clips.js';

const pad2 = (n) => String(n).padStart(2, '0');

// rooms: the WatchRooms instance. artwork(media) -> { image } or null.
export function handleWatchPage(req, res, url, { rooms, artwork }) {
  const m = url.pathname.match(/^\/c\/w\/([A-Za-z0-9_-]{24})\/?$/);
  if (!m) return false;
  const token = m[1];
  const base = baseUrl(req);
  const link = `${base}/c/w/${token}`;
  const join = `/?watch=${token}`;
  let preview = null;
  try { preview = rooms.preview(token); } catch { /* ended */ }

  const send = (status, html) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  };
  if (!preview) {
    return send(404, page({
      title: 'This watch room has ended', desc: 'Ask whoever sent the link to start a new one.', url: link, image: `${base}/c/marquee.png`,
      body: '<div class="card"><h1>This watch room has ended</h1><p>Ask whoever sent the link to start a new one.</p><p><a class="brand" href="/">Open Marquee</a></p></div>',
    }));
  }

  const { media, host, viewers } = preview;
  const episode = media.season != null && media.episode != null ? `S${pad2(media.season)} E${pad2(media.episode)}` : null;
  const what = [media.title, episode].filter(Boolean).join(' · ');
  const art = artwork(media) || {};
  const desc = `${host} is hosting a Watch Together room on Marquee${viewers > 1 ? ` · ${viewers} watching` : ''}. Open the link and sign in to join; playback stays in sync for everyone.`;
  return send(200, page({
    title: `Watch ${what} together`, desc, url: link, image: art.image || `${base}/c/marquee.png`,
    body: `<div class="card"><h1>Watch ${esc(what)} together</h1><p>${esc(host)} invited you. Taking you to the room…</p>
      <form method="get" action="/"><input type="hidden" name="watch" value="${esc(token)}"><button type="submit">Join the room</button></form>
      <p class="foot">You'll sign in to Marquee as usual first.</p></div>
      <script>location.replace(${JSON.stringify(join)})</script>`,
  }));
}
