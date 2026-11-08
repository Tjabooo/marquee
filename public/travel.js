// Download to phone on the page: the words for each copy's state and the list summary.
// The server makes and keeps the copies (src/travel.js).
import { T } from './i18n.js';

const pad = (n) => String(n).padStart(2, '0');

// "Dune (2021)", "Severance S01 E03".
export function travelTitle(f) {
  const name = f.filmTitle || f.title || f.name || T('Video');
  if (f.season != null && f.episode != null) return `${name} S${pad(f.season)} E${pad(f.episode)}`;
  return f.year && f.season == null ? `${name} (${f.year})` : name;
}

// "About 450 MB" from the server's estimate; the real size once the copy exists.
export function sizeWords(item, fmtBytes) {
  if (item.state === 'ready' && item.size) return fmtBytes(item.size);
  return item.estimate ? T('About {0}', fmtBytes(item.estimate)) : '';
}

export function stateWords(item) {
  switch (item.state) {
    case 'ready': return T('Ready to download');
    case 'making': return item.percent != null ? T('Making it… {0}%', item.percent) : T('Making it…');
    case 'queued': return T('Waiting its turn');
    case 'failed': return T('Couldn’t make it{0}', item.error ? `: ${item.error}` : '');
    default: return T('Not made yet');
  }
}

// "3 for your phone · 1 ready · 1 being made"
export function travelSummary(items) {
  if (!items?.length) return '';
  const ready = items.filter((i) => i.state === 'ready').length;
  const busy = items.filter((i) => i.state === 'making' || i.state === 'queued').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  return [T('{0} for your phone', items.length), ready && T('{0} ready', ready), busy && T('{0} being made', busy), failed && T('{0} failed', failed)]
    .filter(Boolean).join(' · ');
}

// Newest request first, but what can be downloaded now on top.
export function travelOrder(items) {
  const rank = { ready: 0, making: 1, queued: 2, failed: 3, none: 4 };
  return [...items].sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || (b.requestedAt || 0) - (a.requestedAt || 0));
}
