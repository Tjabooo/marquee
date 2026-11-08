// Canonical Library union. Ready files are evidence; transfer percentages never grant playback.
import { T } from './i18n.js';
// "70–170" or "1–5, 9, 12–20"; null when it would be a long list.
export function episodeSpans(list, max = 4) {
  const eps = [...new Set(list)].sort((a, b) => a - b), spans = [];
  for (const e of eps) {
    const last = spans.at(-1);
    if (last && e === last[1] + 1) last[1] = e; else spans.push([e, e]);
  }
  return spans.length && spans.length <= max ? spans.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ') : null;
}
// What a season pack with episodes switched off is really getting, or null for a whole pack.
export function packScope(d) {
  if (d.season == null || d.episode != null || !(d.skippedFiles > 0)) return null;
  const spans = episodeSpans((d.episodes || []).filter(ep => ep.season === d.season).map(ep => ep.episode));
  return spans ? T('Episodes {0}', spans) : T('{0} of {1} episodes', d.packFiles - d.skippedFiles, d.packFiles);
}
export const transferPaused = d => /^(paused|stopped)/.test(d.state || '');
export const transferAttention = d => /^(error|missingFiles)$/.test(d.state || '');
export function transferState(d) {
  if (d.converting) return T('Preparing playback');
  if (transferAttention(d)) return d.state === 'missingFiles' ? T('Files missing') : T('Needs attention');
  if (d.done && (d.ready || d.hasVideo === false)) return T('Complete');
  if (transferPaused(d)) return T('Paused');
  if (/checking/.test(d.state || '')) return T('Checking files');
  if (d.done) return T('Almost ready');
  if (Number(d.progress) >= 1) return T('Almost ready');
  return ({ stalledDL: T('Waiting for a source'), metaDL: T('Starting'), forcedMetaDL: T('Starting'), queuedDL: T('In line'), moving: T('Almost ready') })[d.state] || T('On its way');
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
      grouped.set(key, { key, aliases: [], type: ready && mediaType(x) === 'unknown' ? 'movie' : mediaType(x), show, name: show?.title || x.canonicalTitle || x.filmTitle || x.title || x.name || T('Unidentified download'), poster: show?.poster || x.poster, files: [], transfers: [] });
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
    // SVT Play copies leave the list as they finish: what's done still counts, so the bar never falls back.
    const finished = Math.max(0, ...e.active.map(d => d.batchDone || 0));
    if (known && finished) e.progress = (finished + e.progress * e.active.length) / (finished + e.active.length);
    e.speed = e.active.filter(d => !transferPaused(d) && !transferAttention(d) && !/checking/.test(d.state || '')).reduce((n, d) => n + (Number(d.speed) || 0), 0);
    e.state = e.attention ? T('Needs attention') : e.active.length === 1 ? transferState(e.active[0]) : e.active.length ? e.active.every(transferPaused) ? T('Paused') : T('{0} downloads', e.active.length) : e.preparing ? T('Preparing playback') : e.transfers.length && !e.ready && e.transfers.every(d => d.done && d.hasVideo === false) ? T('Complete') : T('Ready to watch');
    e.added = Math.max(0, ...e.files.map(f => f.addedAt || f.added || 0), ...e.transfers.map(d => d.added || 0));
    return e;
  });
}
export function libraryAvailability(e) {
  if (!e.files.length && e.transfers.length && e.transfers.every(d => d.done && d.hasVideo === false)) return T('No playable video');
  if (e.type === 'unknown') return T('Unidentified download');
  if (e.type !== 'tv') return e.ready ? T('Ready to watch') : e.type === 'movie' ? T('Film') : T('Unidentified download');
  const readyEpisodes = new Set(e.files.map(f => `${f.season}:${f.episode}`));
  const ready = readyEpisodes.size;
  const pending = new Set(e.active.flatMap(d => (d.episodes || []).filter(ep => !ep.available && !readyEpisodes.has(`${ep.season}:${ep.episode}`)).map(ep => `${ep.season}:${ep.episode}`))).size;
  return [ready ? T('{0} ready', ready) : null, pending ? T('{0} downloading', pending) : e.active.length ? T('Season on its way') : null].filter(Boolean).join(' · ') || T('Series');
}
export function filterLibrary(entries, { type = 'all', availability = 'all', query = '', sort = 'newest' } = {}) {
  const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const q = normalize(query);
  const expiry = e => Math.min(Infinity, ...e.files.map(f => f.expiresAt ?? Infinity));
  return entries.filter(e => (type === 'all' || e.type === type) && (availability === 'all' || availability === 'ready' && e.ready || availability === 'downloading' && (e.active.length || e.preparing) || availability === 'attention' && e.attention)
    && (!q || normalize([e.name, ...e.files.map(f => `${f.file} ${f.episodeName || ''}`), ...e.transfers.map(d => d.name)].join(' ')).includes(q)))
    .sort((a, b) => (sort === 'title' ? a.name.localeCompare(b.name) : sort === 'expiring' ? expiry(a) - expiry(b) || b.added - a.added : b.added - a.added) || a.key.localeCompare(b.key));
}
