// Live updates: open Marquee pages keep one event stream (/api/events) and are told which part of
// the app changed ("library", "progress", "notes", ...), so they refetch it right away instead of
// waiting for the next poll or a reload. Events carry topic names only, never data.

const clients = new Set(); // { res, userId, admin, tab }
const pending = new Map(); // coalesces bursts: one event per topic and audience every 250 ms

// Which topic a successful POST changed, and who needs to hear about it.
// audience 'user' = only the person who made the change (their other devices and tabs).
const RULES = [
  [/^\/api\/me\/progress$/, 'progress', 'user'],
  [/^\/api\/me$/, 'me', 'user'],
  [/^\/api\/watchlist(?:\/seen)?$/, 'watchlist', 'user'],
  [/^\/api\/travel(?:\/remove)?$/, 'travel', 'user'],
  [/^\/api\/push\/(subscribe|unsubscribe)$/, 'push', 'user'], // the devices list in Settings
  [/^\/api\/social\/rate$/, 'social', 'all'],
  [/^\/api\/watch\/(plan|[A-Za-z0-9_-]{24}\/(cancel|schedule|join))$/, 'parties', 'all'],
  [/^\/api\/(library|downloads)\/(?!.*-info$)/, 'library', 'all'], // not the read-only delete-info checks
  [/^\/api\/media\/\w+\/[\w-]+\/sync$/, 'library', 'all'],
  [/^\/api\/admin\/notes(?:\/import|\/\d+(?:\/\w+)?|\/uploads\/[a-f0-9]{32}\/finish)?$/, 'notes', 'admin'],
  [/^\/api\/(admin\/settings|admin\/users\/\d+|access\/)/, 'people', 'all'],
  [/^\/api\/clips\//, 'clips', 'admin'],
  [/^\/api\/house\/power$/, 'house', 'admin'],
  [/^\/api\/cast\/(play|[\w-]+\/(control|subtitles))$/, 'sessions', 'all'],
];

export function topicFor(pathname) {
  for (const [re, topic, audience] of RULES) if (re.test(pathname)) return { topic, audience };
  return null;
}

// Opens the stream for one page. `tab` identifies the page so it isn't told about its own changes
// where it already updated itself (progress, settings).
export function subscribe(req, res, { userId, admin, tab }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
    'CDN-Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  req.socket.setNoDelay(true);
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const client = { res, userId, admin, tab: String(tab || '') };
  clients.add(client);
  const ping = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 20000);
  res.on('close', () => { clearInterval(ping); clients.delete(client); });
}

// Tells pages that `topic` changed. Repeats within 250 ms are sent once.
export function publish(topic, { audience = 'all', userId = null, exceptTab = '' } = {}) {
  const key = `${topic}|${audience}|${userId ?? ''}|${exceptTab}`;
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    const line = `data: ${JSON.stringify({ topic })}\n\n`;
    for (const c of clients) {
      if (audience === 'user' && c.userId !== userId) continue;
      if (audience === 'admin' && !c.admin) continue;
      if (exceptTab && c.tab === exceptTab) continue;
      if (c.res.destroyed || c.res.writableEnded) { clients.delete(c); continue; }
      c.res.write(line);
      if (c.res.writableLength > 256 * 1024) c.res.destroy(); // a stalled page reconnects and refetches
    }
  }, 250));
}

// Called when a POST to the API finished: announces what it changed.
export function afterRequest(pathname, status, { userId, tab }) {
  if (status >= 400) return;
  const hit = topicFor(pathname);
  if (!hit) return;
  // Your own page already shows its progress and settings; your other pages still hear about them.
  const exceptTab = hit.topic === 'progress' || hit.topic === 'me' ? String(tab || '') : '';
  publish(hit.topic, { audience: hit.audience, userId, exceptTab });
}

export const connectedCount = () => clients.size;
