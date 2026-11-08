// Save for later and Follow on the page: dates, the Coming up shelf, New badges and status lines.
// The server keeps the list and does the downloading (src/watchlist.js); these are the words.
import { T, langTag } from './i18n.js';

const pad = (n) => String(n).padStart(2, '0');
export const episodeCode = (e) => T('S{0}E{1}', pad(e.season), pad(e.episode));
export const todayIso = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// "Today", "Tomorrow", "Yesterday", "Fri 14 Nov" (plus the year when it isn't this year).
export function dayLabel(iso, today = todayIso()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return '';
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days === 0) return T('Today');
  if (days === 1) return T('Tomorrow');
  if (days === -1) return T('Yesterday');
  const d = new Date(`${iso}T12:00:00Z`);
  const opts = { weekday: Math.abs(days) < 7 ? 'long' : 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (iso.slice(0, 4) !== today.slice(0, 4)) { delete opts.weekday; opts.year = 'numeric'; }
  return d.toLocaleDateString(langTag, opts);
}

// The same, inside a sentence: "today", "tomorrow", "on Fri 14 Nov".
export function whenPhrase(iso, today = todayIso()) {
  const label = dayLabel(iso, today);
  return [T('Today'), T('Tomorrow'), T('Yesterday')].includes(label) ? label.toLowerCase() : label ? T('on {0}', label) : '';
}

const RELEASE_WORDS = { digital: T('Out to stream'), disc: T('Out on disc'), cinema: T('In cinemas') };

// What's next for saved films and followed shows, soonest first. Only dates from today on.
export function comingUp(items, today = todayIso()) {
  const out = [];
  for (const i of items || []) {
    if (i.type === 'tv' && i.follow && i.nextEpisode?.airDate >= today) {
      const e = i.nextEpisode;
      out.push({ item: i, date: e.airDate, when: dayLabel(e.airDate, today), what: [episodeCode(e), e.name].filter(Boolean).join(' · ') });
    } else if (i.type === 'movie' && i.release >= today) {
      out.push({ item: i, date: i.release, when: dayLabel(i.release, today), what: RELEASE_WORDS[i.releaseKind] || T('Release') });
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
      return item.release > today && !inLibrary ? `${RELEASE_WORDS[item.releaseKind] || T('Out')} ${whenPhrase(item.release, today)}.` : '';
    }
    if (item.state === 'got') return T('Downloaded when it came out.');
    if (inLibrary) return '';
    if (item.state === 'looking') return T('Out now. Looking for a good copy{0}', item.note ? `: ${item.note}` : '.');
    if (item.release > today) return T('Downloads automatically once it’s out {0}.', whenPhrase(item.release, today));
    if (!item.release) return T('Downloads automatically once a release date is known and it’s out.');
    return T('Looking for a good copy…');
  }
  const parts = [];
  const n = item.nextEpisode;
  if (item.follow && n?.airDate) parts.push(T('Next: {0} {1} {2}.', episodeCode(n), n.airDate < today ? T('aired') : T('airs'), whenPhrase(n.airDate, today)));
  else if (item.follow) parts.push(T('No new episodes announced yet.'));
  if (item.follow && item.auto && autoDownload) {
    if (item.waiting?.length) parts.push(T('Looking for {0}.', item.waiting.map(episodeCode).join(', ')));
    if (item.missed?.length) parts.push(T('Couldn’t find {0}.', item.missed.map(episodeCode).join(', ')));
  }
  return parts.join(' ');
}
