// Save for later and Follow on the page: dates, the Coming up shelf, New badges and status lines.
// The server keeps the list and does the downloading (src/watchlist.js); these are the words.

const pad = (n) => String(n).padStart(2, '0');
export const episodeCode = (e) => `S${pad(e.season)}E${pad(e.episode)}`;
export const todayIso = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// "Today", "Tomorrow", "Yesterday", "Fri 14 Nov" (plus the year when it isn't this year).
export function dayLabel(iso, today = todayIso()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return '';
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  const d = new Date(`${iso}T12:00:00Z`);
  const opts = { weekday: Math.abs(days) < 7 ? 'long' : 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (iso.slice(0, 4) !== today.slice(0, 4)) { delete opts.weekday; opts.year = 'numeric'; }
  return d.toLocaleDateString('en-GB', opts);
}

// The same, inside a sentence: "today", "tomorrow", "on Fri 14 Nov".
export function whenPhrase(iso, today = todayIso()) {
  const label = dayLabel(iso, today);
  return /^(Today|Tomorrow|Yesterday)$/.test(label) ? label.toLowerCase() : label ? `on ${label}` : '';
}

const RELEASE_WORDS = { digital: 'Out to stream', disc: 'Out on disc', cinema: 'In cinemas' };

// What's next for saved films and followed shows, soonest first. Only dates from today on.
export function comingUp(items, today = todayIso()) {
  const out = [];
  for (const i of items || []) {
    if (i.type === 'tv' && i.follow && i.nextEpisode?.airDate >= today) {
      const e = i.nextEpisode;
      out.push({ item: i, date: e.airDate, when: dayLabel(e.airDate, today), what: [episodeCode(e), e.name].filter(Boolean).join(' · ') });
    } else if (i.type === 'movie' && i.release >= today) {
      out.push({ item: i, date: i.release, when: dayLabel(i.release, today), what: RELEASE_WORDS[i.releaseKind] || 'Release' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.item.title.localeCompare(b.item.title));
}

// New episodes of a followed show that are ready in your library (files: the show's library files).
export function newEpisodes(item, files) {
  if (!item?.newEpisodes?.length) return 0;
  const ready = new Set((files || []).filter((f) => f.done !== false).map((f) => `${f.season}:${f.episode}`));
  return item.newEpisodes.filter((e) => ready.has(`${e.season}:${e.episode}`)).length;
}

// One line under the Save / Follow buttons, or '' when there's nothing to add.
export function watchStatus(item, { today = todayIso(), autoDownload = false, inLibrary = false } = {}) {
  if (!item) return '';
  if (item.type === 'movie') {
    if (!item.auto || !autoDownload) {
      return item.release > today && !inLibrary ? `${RELEASE_WORDS[item.releaseKind] || 'Out'} ${whenPhrase(item.release, today)}.` : '';
    }
    if (item.state === 'got') return 'Downloaded when it came out.';
    if (inLibrary) return '';
    if (item.state === 'looking') return `Out now. Looking for a good copy${item.note ? `: ${item.note}` : '.'}`;
    if (item.release > today) return `Downloads automatically once it’s out ${whenPhrase(item.release, today)}.`;
    if (!item.release) return 'Downloads automatically once a release date is known and it’s out.';
    return 'Looking for a good copy…';
  }
  const parts = [];
  const n = item.nextEpisode;
  if (item.follow && n?.airDate) parts.push(`Next: ${episodeCode(n)} ${n.airDate < today ? 'aired' : 'airs'} ${whenPhrase(n.airDate, today)}.`);
  else if (item.follow) parts.push('No new episodes announced yet.');
  if (item.follow && item.auto && autoDownload) {
    if (item.waiting?.length) parts.push(`Looking for ${item.waiting.map(episodeCode).join(', ')}.`);
    if (item.missed?.length) parts.push(`Couldn’t find ${item.missed.map(episodeCode).join(', ')}.`);
  }
  return parts.join(' ');
}
