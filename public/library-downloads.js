// Canonical Library union. Ready files are evidence; transfer percentages never grant playback.
export const transferPaused = d => /^(paused|stopped)/.test(d.state || '');
export const transferAttention = d => /^(error|missingFiles)$/.test(d.state || '');
export function transferState(d) {
  if (d.converting) return 'Preparing playback';
  if (transferAttention(d)) return d.state === 'missingFiles' ? 'Files missing' : 'Needs attention';
  if (d.done && (d.ready || d.hasVideo === false)) return 'Complete';
  if (transferPaused(d)) return 'Paused';
  if (/checking/.test(d.state || '')) return 'Checking files';
  if (d.done) return 'Almost ready';
  if (Number(d.progress) >= 1) return 'Almost ready';
  return ({ stalledDL: 'Waiting for a source', metaDL: 'Starting', forcedMetaDL: 'Starting', queuedDL: 'In line', moving: 'Almost ready' })[d.state] || 'On its way';
}
const mediaType = x => x.mediaType === 'tv' || x.showId || x.show || x.season != null ? 'tv' : x.mediaType === 'movie' || x.tmdbId ? 'movie' : 'unknown';
function identity(x, ready = false) {
  const type = mediaType(x);
  if (type === 'tv' && (x.showId || x.show)) return `tv:${x.showId || x.show}`;
  if (x.tmdbId != null) return `${type === 'tv' ? 'tv' : 'movie'}:${type === 'tv' ? `tv-${x.tmdbId}` : x.tmdbId}`;
  return `${ready ? 'file' : 'hash'}:${ready ? x.mediaKey || x.id : x.hash}`;
}
export function libraryUnion(files = [], shows = [], downloads = []) {
  const grouped = new Map(), byFile = new Map(), byShow = new Map(shows.map(s => [s.id, s]));
  const get = (key, x, ready) => {
    if (!grouped.has(key)) {
      const show = byShow.get(x.showId || x.show) || (mediaType(x) === 'tv' ? { id: x.showId || x.show || (x.tmdbId != null ? `tv-${x.tmdbId}` : `pending-${x.hash || x.id}`), title: x.canonicalTitle || x.title, tmdbId: x.tmdbId, poster: x.poster, backdrop: x.backdrop, seasons: [] } : null);
      grouped.set(key, { key, aliases: [], type: ready && mediaType(x) === 'unknown' ? 'movie' : mediaType(x), show, name: show?.title || x.canonicalTitle || x.filmTitle || x.title || x.name || 'Unidentified download', poster: show?.poster || x.poster, files: [], transfers: [] });
    }
    const entry = grouped.get(key);
    (ready ? entry.files : entry.transfers).push(x);
    if (x.hash) entry.aliases.push(`hash:${x.hash}`);
    return entry;
  };
  for (const f of files) { const entry = get(identity(f, true), f, true); byFile.set(f.id, entry); }
  for (const d of downloads.filter(d => d.mine !== false)) {
    const match = (d.libraryIds || []).map(id => byFile.get(id)).find(Boolean);
    const entry = match || get(identity(d), d, false);
    if (match) { entry.transfers.push(d); entry.aliases.push(`hash:${d.hash}`); }
  }
  return [...grouped.values()].map(e => {
    e.active = e.transfers.filter(d => !d.done || d.converting || transferAttention(d) || d.hasVideo !== false && !d.ready && !(d.libraryIds || []).length);
    e.preparing = e.files.some(f => f.converting);
    e.ready = e.files.some(f => !f.converting) || e.transfers.some(d => d.ready === true && !d.converting);
    e.attention = e.active.some(transferAttention);
    const known = e.active.length > 0 && e.active.every(d => Number.isFinite(d.size) && d.size > 0 && Number.isFinite(d.progress));
    e.progress = known ? e.active.reduce((n, d) => n + d.size * Math.max(0, Math.min(1, d.progress)), 0) / e.active.reduce((n, d) => n + d.size, 0) : null;
    e.speed = e.active.filter(d => !transferPaused(d) && !transferAttention(d) && !/checking/.test(d.state || '')).reduce((n, d) => n + (Number(d.speed) || 0), 0);
    e.state = e.attention ? 'Needs attention' : e.active.length === 1 ? transferState(e.active[0]) : e.active.length ? e.active.every(transferPaused) ? 'Paused' : `${e.active.length} downloads` : e.preparing ? 'Preparing playback' : e.transfers.length && !e.ready && e.transfers.every(d => d.done && d.hasVideo === false) ? 'Complete' : 'Ready to watch';
    e.added = Math.max(0, ...e.files.map(f => f.addedAt || f.added || 0), ...e.transfers.map(d => d.added || 0));
    return e;
  });
}
export function libraryAvailability(e) {
  if (!e.files.length && e.transfers.length && e.transfers.every(d => d.done && d.hasVideo === false)) return 'No playable video';
  if (e.type === 'unknown') return 'Unidentified download';
  if (e.type !== 'tv') return e.ready ? 'Ready to watch' : e.type === 'movie' ? 'Film' : 'Unidentified download';
  const readyEpisodes = new Set(e.files.map(f => `${f.season}:${f.episode}`));
  const ready = readyEpisodes.size;
  const pending = new Set(e.active.flatMap(d => (d.episodes || []).filter(ep => !ep.available && !readyEpisodes.has(`${ep.season}:${ep.episode}`)).map(ep => `${ep.season}:${ep.episode}`))).size;
  return [ready ? `${ready} ready` : null, pending ? `${pending} downloading` : e.active.length ? 'Season on its way' : null].filter(Boolean).join(' · ') || 'Series';
}
export function filterLibrary(entries, { type = 'all', availability = 'all', query = '', sort = 'newest' } = {}) {
  const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const q = normalize(query);
  const expiry = e => Math.min(Infinity, ...e.files.map(f => f.expiresAt ?? Infinity));
  return entries.filter(e => (type === 'all' || e.type === type) && (availability === 'all' || availability === 'ready' && e.ready || availability === 'downloading' && (e.active.length || e.preparing) || availability === 'attention' && e.attention)
    && (!q || normalize([e.name, ...e.files.map(f => `${f.file} ${f.episodeName || ''}`), ...e.transfers.map(d => d.name)].join(' ')).includes(q)))
    .sort((a, b) => (sort === 'title' ? a.name.localeCompare(b.name) : sort === 'expiring' ? expiry(a) - expiry(b) || b.added - a.added : b.added - a.added) || a.key.localeCompare(b.key));
}
