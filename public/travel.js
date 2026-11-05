// Download to phone on the page: the words for each copy's state and the list summary.
// The server makes and keeps the copies (src/travel.js).

const pad = (n) => String(n).padStart(2, '0');

// "Dune (2021)", "Severance S01 E03".
export function travelTitle(f) {
  const name = f.filmTitle || f.title || f.name || 'Video';
  if (f.season != null && f.episode != null) return `${name} S${pad(f.season)} E${pad(f.episode)}`;
  return f.year && f.season == null ? `${name} (${f.year})` : name;
}

// "About 450 MB" from the server's estimate; the real size once the copy exists.
export function sizeWords(item, fmtBytes) {
  if (item.state === 'ready' && item.size) return fmtBytes(item.size);
  return item.estimate ? `About ${fmtBytes(item.estimate)}` : '';
}

export function stateWords(item) {
  switch (item.state) {
    case 'ready': return 'Ready to download';
    case 'making': return item.percent != null ? `Making it… ${item.percent}%` : 'Making it…';
    case 'queued': return 'Waiting its turn';
    case 'failed': return `Couldn’t make it${item.error ? `: ${item.error}` : ''}`;
    default: return 'Not made yet';
  }
}

// "3 for your phone · 1 ready · 1 being made"
export function travelSummary(items) {
  if (!items?.length) return '';
  const ready = items.filter((i) => i.state === 'ready').length;
  const busy = items.filter((i) => i.state === 'making' || i.state === 'queued').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  return [`${items.length} for your phone`, ready && `${ready} ready`, busy && `${busy} being made`, failed && `${failed} failed`]
    .filter(Boolean).join(' · ');
}

// Newest request first, but what can be downloaded now on top.
export function travelOrder(items) {
  const rank = { ready: 0, making: 1, queued: 2, failed: 3, none: 4 };
  return [...items].sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || (b.requestedAt || 0) - (a.requestedAt || 0));
}
