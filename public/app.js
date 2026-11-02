// Marquee web client. Plain ES modules, no build step.
import { WatchSession, offsetCues } from './watch-sync.js';

const $ = (sel, el = document) => el.querySelector(sel);

// DOM builder. Text is always inserted as text, never parsed as HTML.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ICONS = {
  airplay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1"/><path d="M12 14l5 6H7z"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  tv: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M10 4h4M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v6M14 11v6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>',
  volumeHigh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  back10: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M6.5 3v3.9h3.9"/><text x="12.2" y="15.2" text-anchor="middle">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M17.5 3v3.9h-3.9"/><text x="11.8" y="15.2" text-anchor="middle">10</text></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  fullscreenExit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  pip: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><rect class="fill" x="12" y="11.5" width="6.5" height="5" rx="1"/></svg>',
};
const icon = (name) => { const s = h('span'); s.innerHTML = ICONS[name]; return s.firstChild; };

// A random ID for this browser, so each phone sees its own TV remotes.
const CLIENT_ID = (() => {
  const make = () => Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
  try {
    let id = localStorage.getItem('marquee:client');
    if (!id) { id = make(); localStorage.setItem('marquee:client', id); }
    return id;
  } catch { return make(); }
})();

async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { ...opts.headers, 'X-Marquee-Client': CLIENT_ID } });
  } catch (err) {
    if (err.name !== 'AbortError' && await signedOut()) throw new Error('You’ve been signed out. Sign in again to carry on.');
    throw err;
  }
  let data = {};
  try { data = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw Object.assign(new Error(data.error || `The server responded with ${r.status}.`), { status: r.status });
  return data;
}

// When the Cloudflare Access sign-in runs out, API calls get redirected to Cloudflare's login page,
// which fetch can't follow (it's another site), so they fail as network errors. Telling the two apart:
// a redirect seen without following it means signed out. Then a reload goes through the sign-in.
let signedOutShown = false;
async function signedOut() {
  let r;
  try { r = await fetch('/api/me', { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(3000) }); } catch { return false; } // really offline
  if (r.type !== 'opaqueredirect') return false;
  if (!signedOutShown) {
    signedOutShown = true;
    document.body.append(h('div', { class: 'signed-out', role: 'alert' },
      h('p', {}, h('strong', {}, 'You’ve been signed out.'), ' Your sign-in ran out; sign in again to carry on where you were.'),
      h('button', { class: 'play-btn', onclick: () => location.reload() }, 'Sign in again')));
  }
  return true;
}

// ---------- formatting ----------
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
function fmtEta(s) {
  if (s == null) return null;
  if (s < 60) return 'under a minute left';
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  const hrs = Math.floor(s / 3600);
  return `${hrs} h ${Math.round((s % 3600) / 60)} min left`;
}
function fmtTime(s) {
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
}
function fmtAgo(ms) {
  if (!ms) return null;
  const days = (Date.now() - ms) / 86400000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 45) return `${Math.round(days)} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const yrs = Math.round(days / 365);
  return `${yrs} year${yrs > 1 ? 's' : ''} ago`;
}
const pad2 = (n) => String(n).padStart(2, '0');
const episodeLabel = (f) => (f.season != null ? `S${pad2(f.season)} E${pad2(f.episode)}` : null);
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// ---------- state ----------
const state = {
  view: 'discover',
  sessions: [],
  convert: null,
  query: '',
  status: { search: false, library: false, downloads: false, torrents: false, subtitles: false },
  library: [],
  libraryShows: [], // episodes grouped into shows (server side, TMDB posters per season)
  libraryError: null,
  downloads: [],
  downloadsError: null,
  dlScope: 'mine',  // the owner can switch Downloads to everyone's
  server: [],       // videos on the server that aren't in this person's library
  me: null,         // who's signed in, with their settings (accounts.js)
  rules: null,      // the server's auto-delete rules
  progress: {},     // where this person stopped watching, from any device
  libFilter: 'all',
};
const canDownload = () => state.status.downloads && state.me?.canDownload !== false;
const prefs = () => state.me?.settings || {};

// Local files (library + finished downloads) that belong to a TMDB title.
function localFiles() {
  return [
    ...state.library.map((f) => ({ ...f, kind: 'lib', key: f.id, done: true })),
    ...state.downloads.filter((d) => d.mine !== false).map((d) => ({ ...d, kind: 'dl', key: d.hash, file: d.name })),
  ];
}
const sameTitle = (t) => {
  const n = norm(t.title);
  return (f) => {
    if (t.type !== 'tv') {
      if (f.season != null || f.show || f.movieAmbiguous) return false;
      // A different (or unresolved) ID must never fall through to a title/year guess.
      if (t.id != null) return f.tmdbId != null && Number(f.tmdbId) === Number(t.id);
      return norm(f.title) === n && (!f.year || !t.year || f.year === t.year);
    }
    if (f.tmdbId && f.season == null) return false;
    if (f.show?.startsWith('tv-')) return f.show === `tv-${t.id}`;
    return f.season != null && norm(f.title) === n;
  };
};
const byEpisode = (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0);
function matchesFor(t) {
  return localFiles().filter(sameTitle(t)).sort(byEpisode);
}
// The same title on the server but not in this person's library: offered as "Add to my library".
function serverMatchesFor(t) {
  return state.server.filter(sameTitle(t)).map((f) => ({ ...f, kind: 'lib', key: f.id, done: true })).sort(byEpisode);
}

// ---------- themes (Settings → Appearance) ----------
// Each theme sets the colour tokens style.css is built on. A custom theme picks four colours and the
// rest are mixed from them. The result is cached in localStorage so index.html can paint the right
// colours before this script loads (no flash of the default theme).
const THEMES = {
  marquee: { name: 'Marquee', bg: '#1F1019', surface: '#2B1724', raised: '#3A2031', line: '#4B2C3F', text: '#F6EADF', muted: '#BA9DAD', accent: '#F4C152', alert: '#FF9B85' },
  midnight: { name: 'Midnight', bg: '#0E1320', surface: '#161D2E', raised: '#1F2840', line: '#2A3552', text: '#E8EEF8', muted: '#96A3BD', accent: '#5CC8FF', alert: '#FF8A8A' },
  forest: { name: 'Forest', bg: '#0F1A14', surface: '#16241C', raised: '#1E3127', line: '#2A4134', text: '#E9F2EA', muted: '#9DB5A4', accent: '#9BE07A', alert: '#FF9B85' },
  ember: { name: 'Ember', bg: '#161312', surface: '#221D1B', raised: '#2E2724', line: '#3D3430', text: '#F5EDE8', muted: '#B3A49C', accent: '#FF7A3D', alert: '#FF8A8A' },
  lagoon: { name: 'Lagoon', bg: '#0B1A1C', surface: '#112629', raised: '#183337', line: '#22444A', text: '#E3F4F4', muted: '#93B8BA', accent: '#3DDBC4', alert: '#FF9B85' },
  synth: { name: 'Synthwave', bg: '#140F24', surface: '#1D1633', raised: '#281E45', line: '#352858', text: '#F0EAFF', muted: '#A99BC9', accent: '#FF5FA2', alert: '#FFB36B' },
  noir: { name: 'Noir', bg: '#111111', surface: '#1B1B1B', raised: '#262626', line: '#333333', text: '#F2F2F2', muted: '#A0A0A0', accent: '#E8E8E8', alert: '#FF8A8A' },
  paper: { name: 'Paper', bg: '#F7F2EA', surface: '#FFFDF9', raised: '#EFE7DB', line: '#DDD2C2', text: '#241A14', muted: '#6E6157', accent: '#C2410C', alert: '#B42318' },
  daylight: { name: 'Daylight', bg: '#F2F5FA', surface: '#FFFFFF', raised: '#E5EBF4', line: '#D2DAE7', text: '#141B2B', muted: '#5A6478', accent: '#2563EB', alert: '#C0262D' },
};
const THEME_FIELDS = [['bg', 'Background'], ['surface', 'Panels'], ['text', 'Text'], ['accent', 'Accent']];

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => rgbHex(hexRgb(a).map((v, i) => v + (hexRgb(b)[i] - v) * t)); // t of the way from a to b
const luminance = (hex) => {
  const [r, g, b] = hexRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// A saved theme ({ preset } or { preset: 'custom', colors }) -> the full set of colours.
function themeColors(theme) {
  const preset = THEMES[theme?.preset] || THEMES[state.rules?.defaultTheme] || THEMES.marquee;
  if (theme?.preset !== 'custom' || !theme.colors) return preset;
  const { bg, surface, text, accent } = theme.colors;
  const light = luminance(bg) > 0.5;
  return {
    name: 'Custom', bg, surface, text, accent,
    raised: mix(surface, text, 0.08), line: mix(surface, text, 0.16), muted: mix(text, bg, 0.38),
    alert: light ? '#B42318' : '#FF9B85',
  };
}

function applyTheme(theme) {
  const c = themeColors(theme);
  const light = luminance(c.bg) > 0.5;
  const onAccent = luminance(c.accent) > 0.4 ? (luminance(c.bg) < 0.15 ? c.bg : '#141414') : (luminance(c.bg) > 0.8 ? c.bg : '#FFFFFF');
  const vars = {
    '--velvet': c.bg, '--curtain': c.surface, '--seat': c.raised, '--line': c.line,
    '--paper': c.text, '--dust': c.muted, '--bulb': c.accent, '--alert': c.alert,
    '--bulb-dim': `${c.accent}33`, '--on-bulb': onAccent,
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = light ? 'light' : 'dark';
  root.dataset.scheme = light ? 'light' : 'dark';
  pageThemeColor = c.bg;
  if (!current) setTheme(c.bg);
  try { localStorage.setItem('marquee:theme', JSON.stringify({ vars, scheme: light ? 'light' : 'dark' })); } catch { /* blocked */ }
}

// ---------- shared UI bits ----------
function notice(title, text, retry) {
  return h('div', { class: 'notice' },
    h('h3', {}, title),
    h('p', {}, text),
    retry && h('button', { class: 'retry', onclick: retry }, 'Try again'));
}

function skeletonGrid(n = 8) {
  return h('ul', { class: 'grid', 'aria-hidden': 'true' },
    Array.from({ length: n }, () => h('li', { class: 'skeleton' }, h('div', { class: 'poster' }), h('div', { class: 'bar' }))));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function resumeKey(f) { return `resume:${f.kind}:${f.key}`; }
// Where this person stopped, synced through the server so it resumes on their other devices too.
// Library videos go by their media key, which stays the same when the MP4 copy replaces the original.
const progressRef = (f) => (f.mediaKey ? `m:${f.mediaKey}` : `${f.kind === 'dl' ? 'd' : 'l'}:${f.key}`);
function savedProgress(f) {
  const synced = state.progress[progressRef(f)];
  if (synced) return synced;
  try { return JSON.parse(localStorage.getItem(resumeKey(f))); } catch { return null; }
}
async function loadProgress() {
  try { state.progress = (await api('/api/me/progress')).progress || {}; } catch { /* local copy only */ }
}

// ---------- auto-delete countdown ----------
// Videos in your library are deleted a set time after they finish downloading (the owner's setting,
// 7 days unless changed). The countdown shows on each one, with a button to keep it longer.
function timeLeft(ms) {
  const hours = (ms - Date.now()) / 3600000;
  if (hours <= 0) return 'Deleting soon';
  if (hours < 1) return 'Deleted within the hour';
  if (hours < 48) return `${Math.floor(hours)} h left`;
  return `${Math.round(hours / 24)} days left`;
}
const canExtend = (f) => f.expiresAt != null && (!state.rules?.maxExtensions || (f.extensions || 0) < state.rules.maxExtensions);
const extendDays = () => state.rules?.extendDays || 7;

// The "4 days left · Keep 7 more days" part of a row's meta line. Re-renders itself after extending.
function expiryBits(f) {
  if (f.expiresAt == null) return null;
  const soon = f.expiresAt - Date.now() < 86400000;
  const wrap = h('span', { class: 'expiry-wrap' },
    h('span', { class: `expiry${soon ? ' is-soon' : ''}`, title: `Deleted ${new Date(f.expiresAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` }, timeLeft(f.expiresAt)),
    canExtend(f) && h('button', {
      type: 'button', class: 'keep-btn', 'aria-label': `Keep ${f.title}${episodeLabel(f) ? ` ${episodeLabel(f)}` : ''} ${extendDays()} more days`,
      onclick: async (e) => {
        e.stopPropagation();
        const b = e.currentTarget;
        b.disabled = true;
        const [updated] = await extendItems([f]);
        if (updated) wrap.replaceWith(expiryBits({ ...f, ...updated }) || '');
        else b.disabled = false;
      },
    }, `Keep ${extendDays()} more days`));
  return wrap;
}

// Pushes back when these library videos are deleted. Returns the updated items (or [] on failure).
async function extendItems(files) {
  try {
    const { entries } = await api('/api/library/extend', jsonPost({ ids: files.map((f) => f.id || f.key) }));
    const byKey = new Map(entries.map((e) => [e.key, e]));
    for (const f of state.library) {
      const e = byKey.get(f.mediaKey);
      if (e) Object.assign(f, { expiresAt: e.expiresAt, extensions: e.extensions });
    }
    toast(files.length === 1 ? `Kept ${extendDays()} more days` : `Kept ${plural(files.length, 'video')} ${extendDays()} more days`);
    if (state.view === 'library') renderLibrary();
    return files.map((f) => state.library.find((x) => x.mediaKey === f.mediaKey)).filter(Boolean);
  } catch (err) {
    toast(err.message);
    return [];
  }
}

function fileRow(f) {
  const title = episodeLabel(f) || f.file || f.name;
  const saved = savedProgress(f);
  const pct = saved?.duration ? Math.min(100, (saved.time / saved.duration) * 100) : 0;
  const meta = f.done
    ? [f.format?.toUpperCase() || (f.name?.match(/\.(\w{2,4})$/)?.[1] || '').toUpperCase(), fmtBytes(f.size)]
    : [`Downloading ${Math.floor(f.progress * 100)}%`];
  return h('li', { class: 'row' },
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, title),
      h('div', { class: 'row-meta' }, meta.filter(Boolean).map((m) => h('span', {}, m)), f.kind === 'lib' && expiryBits(f)),
      pct > 1 && h('div', { class: 'resume-track', title: 'Watched so far' }, h('i', { style: `width:${pct}%` }))),
    f.done && h('div', { class: 'row-actions' },
      f.kind === 'lib' && h('button', { class: 'cast-btn del-btn', 'aria-label': `Delete ${title}`, title: 'Delete', onclick: (e) => openDelete(f, e.currentTarget) }, icon('trash')),
      h('button', { class: 'cast-btn', 'aria-label': `Play ${title} on a TV`, title: 'Play on TV', onclick: (e) => openPicker(f, e.currentTarget) }, icon('tv')),
      f.converting
        ? h('button', { class: 'play-btn round is-disabled', 'aria-disabled': 'true', title: 'Cannot play while converting', 'aria-label': `${title}: cannot play while converting`, onclick: () => toast('Cannot play while converting') }, icon('play'))
        : h('button', { class: 'play-btn round', 'aria-label': `Play ${title} here`, onclick: () => openPlayer(f) }, icon('play'))));
}

// ---------- Discover ----------
let searchCtrl;
let searchTimer;
const disc = { type: 'all', genre: null, sort: 'popular', list: null, genres: null, cache: new Map() };
const TYPE_LABELS = [['all', 'All'], ['movie', 'Films'], ['tv', 'Shows']];
const SORT_LABELS = [['popular', 'Popular'], ['rating', 'Top rated'], ['newest', 'Newest']];

async function cachedApi(url, signal) {
  if (disc.cache.has(url)) return disc.cache.get(url);
  const data = await api(url, { signal });
  disc.cache.set(url, data);
  if (disc.cache.size > 60) disc.cache.delete(disc.cache.keys().next().value);
  return data;
}

// "In your library", or "On server" when someone else has it here (it can be added, not downloaded).
function ownershipBadge(t) {
  if (matchesFor(t).some((f) => f.done)) return h('span', { class: 'on-server' }, 'In your library');
  if (serverMatchesFor(t).length) return h('span', { class: 'on-server is-other' }, 'On server');
  return null;
}

function titleCard(t) {
  return h('li', {},
    h('button', { class: 'title-card', onclick: (e) => openDetails(t, e.currentTarget) },
      h('div', { class: 'poster' },
        t.poster
          ? h('img', { src: t.poster, alt: '', loading: 'lazy', decoding: 'async' })
          : h('div', { class: 'poster-fallback' }, t.title),
        ownershipBadge(t),
        t.rating && h('span', { class: 'rating', 'aria-label': `Rated ${t.rating} out of 10` }, `★ ${t.rating.toFixed(1)}`)),
      h('div', { class: 'name' }, t.title),
      h('div', { class: 'sub' }, [t.year, t.type === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(', '))));
}
const titleGrid = (items) => h('ul', { class: 'grid' }, items.map(titleCard));

const genreNames = (t) => (disc.genres || [])
  .filter((g) => t.genres?.includes(t.type === 'tv' ? g.tv : g.movie))
  .map((g) => g.name).slice(0, 2);
const genreFits = (g) => (disc.type === 'movie' ? g.movie : disc.type === 'tv' ? g.tv : g.movie || g.tv);

function segmented(options, value, onPick, label) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label },
    options.map(([key, text]) => h('button', {
      type: 'button', 'aria-pressed': String(key === value), onclick: () => onPick(key),
    }, text)));
}

function discoverFilters() {
  const pick = (changes) => {
    Object.assign(disc, changes, { list: null });
    if (disc.genre && !genreFits(disc.genre)) disc.genre = null;
    window.scrollTo({ top: 0 });
    renderDiscover();
  };
  const chips = h('div', { class: 'genre-chips', role: 'group', 'aria-label': 'Genre' },
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!disc.genre), onclick: () => pick({ genre: null }) }, 'All genres'),
    (disc.genres || []).filter(genreFits).map((g) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(disc.genre?.name === g.name), onclick: () => pick({ genre: g }),
    }, g.name)));
  requestAnimationFrame(() => chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
  return h('div', { class: 'discover-filters' },
    segmented(TYPE_LABELS, disc.type, (type) => pick({ type }), 'Show'), chips);
}

function heroSlide(t) {
  const meta = [t.year, t.type === 'tv' ? 'Series' : 'Film', t.rating && `★ ${t.rating.toFixed(1)}`, ...genreNames(t)].filter(Boolean);
  return h('li', { class: 'hero-slide' },
    h('button', { class: 'hero-card', onclick: (e) => openDetails(t, e.currentTarget) },
      h('img', { src: t.backdrop, alt: '', decoding: 'async' }),
      h('div', { class: 'hero-text' },
        ownershipBadge(t),
        h('div', { class: 'hero-title' }, t.title),
        h('div', { class: 'hero-meta' }, meta.join(' · ')),
        h('p', { class: 'hero-overview' }, t.overview))));
}

function carousel(title, list, seeAll = null) {
  const move = (direction) => list.scrollBy({ left: direction * Math.max(160, list.clientWidth * 0.85),
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  const prev = h('button', { type: 'button', class: 'carousel-arrow', disabled: true, 'aria-label': `Previous in ${title}`, onclick: () => move(-1) }, icon('back'));
  const next = h('button', { type: 'button', class: 'carousel-arrow next', 'aria-label': `Next in ${title}`, onclick: () => move(1) }, icon('back'));
  const update = () => {
    prev.disabled = list.scrollLeft <= 2;
    next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 2;
  };
  list.addEventListener('scroll', update, { passive: true });
  const section = h('section', { class: 'shelf carousel', 'aria-label': title },
    h('div', { class: 'shelf-head' }, h('h3', {}, title),
      h('div', { class: 'carousel-controls' }, seeAll, prev, next)), list);
  const observer = new ResizeObserver(update);
  observer.observe(list);
  searchCtrl?.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  requestAnimationFrame(update);
  return section;
}

function row(r) {
  return carousel(r.title, h('ul', { class: 'shelf-items', tabindex: '0', 'aria-label': r.title }, r.items.map(titleCard)),
    h('button', { class: 'see-all', onclick: () => { disc.list = { key: r.key, title: r.title }; window.scrollTo({ top: 0 }); renderDiscover(); } }, 'See all'));
}

// Paged grid for a genre or a "See all" list, with a Load more button.
async function pagedGrid(content, urlFor, signal) {
  const seen = new Set();
  const grid = h('ul', { class: 'grid' });
  const more = h('button', { class: 'load-more', hidden: true }, 'Load more');
  let page = 0;
  const load = async () => {
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const data = await cachedApi(urlFor(page + 1), signal);
      if (page === 0) {
        if (!data.results.length) { content.replaceChildren(notice('Nothing here', 'Try another genre or type.')); return; }
        content.replaceChildren(grid, more);
      }
      page = data.page;
      const fresh = data.results.filter((t) => !seen.has(`${t.type}:${t.id}`)); // pages can overlap
      fresh.forEach((t) => seen.add(`${t.type}:${t.id}`));
      grid.append(...fresh.map(titleCard));
      more.hidden = page >= data.totalPages;
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (page === 0) content.replaceChildren(notice('Couldn’t load this', err.message, () => { content.replaceChildren(skeletonGrid()); load(); }));
      else toast(err.message);
    } finally {
      more.disabled = false;
      more.textContent = 'Load more';
    }
  };
  more.addEventListener('click', load);
  content.replaceChildren(skeletonGrid());
  await load();
}

async function renderDiscover() {
  const body = $('#discover-body');
  const heading = $('#discover-heading');
  const q = state.query.trim();
  heading.textContent = q ? `Results for “${q}”` : 'Discover';
  heading.classList.toggle('sr-only', !q);

  if (!state.status.search) {
    body.replaceChildren(notice('Discover isn’t set up yet',
      'Add a free TMDB token as TMDB_TOKEN in the .env file, then restart the server.'));
    return;
  }

  searchCtrl?.abort();
  searchCtrl = new AbortController();
  const { signal } = searchCtrl;

  if (q) {
    body.replaceChildren(skeletonGrid());
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`, { signal });
      body.replaceChildren(data.results.length
        ? titleGrid(data.results)
        : notice(`No matches for “${q}”`, 'Check the spelling, or try the original title.'));
    } catch (err) {
      if (err.name !== 'AbortError') body.replaceChildren(notice('Search didn’t work', err.message, renderDiscover));
    }
    return;
  }

  if (!disc.genres) {
    try { disc.genres = (await cachedApi('/api/discover/genres', signal)).genres; } catch { disc.genres = []; }
    if (signal.aborted) return;
  }
  const content = h('div', { class: 'discover-content' });
  body.replaceChildren(discoverFilters(), content);

  if (disc.list) {
    content.before(h('div', { class: 'discover-head' },
      h('button', { class: 'back-link', onclick: () => { disc.list = null; renderDiscover(); } }, '‹ Discover'),
      h('h3', {}, disc.list.title)));
    return pagedGrid(content, (page) => `/api/discover/list?key=${disc.list.key}&page=${page}`, signal);
  }

  if (disc.genre) {
    const g = disc.genre;
    content.before(h('div', { class: 'discover-head' },
      h('h3', {}, g.name),
      segmented(SORT_LABELS, disc.sort, (sort) => { disc.sort = sort; renderDiscover(); }, 'Sort by')));
    return pagedGrid(content, (page) => `/api/discover/genre?type=${disc.type}&movie=${g.movie || ''}&tv=${g.tv || ''}&sort=${disc.sort}&page=${page}`, signal);
  }

  content.replaceChildren(skeletonGrid());
  try {
    const data = await cachedApi(`/api/discover/home?type=${disc.type}`, signal);
    content.replaceChildren(...[
      data.featured.length && carousel('Trending this week', h('ul', { class: 'hero', tabindex: '0', 'aria-label': 'Trending this week' }, data.featured.map(heroSlide))),
      ...data.rows.map(row),
    ].filter(Boolean));
  } catch (err) {
    if (err.name !== 'AbortError') content.replaceChildren(notice('Couldn’t load Discover', err.message, renderDiscover));
  }
}

// ---------- Library ----------
async function loadLibrary() {
  if (!state.status.library) return;
  try {
    const data = await api('/api/library');
    state.library = data.items;
    state.server = data.server || [];
    state.libraryShows = data.shows || [];
    state.libraryError = null;
  } catch (err) {
    state.libraryError = err.message;
  }
}

async function loadConvert() {
  try { state.convert = await api('/api/convert'); } catch { state.convert = null; }
}

// Conversion progress banner shown at the top of the library.
function renderConvertBanner() {
  const el = $('#convert-banner');
  if (!el) return;
  const c = state.convert;
  const parts = [];
  if (c?.current) {
    const cur = c.current;
    const bits = [h('strong', {}, `${cur.percent || 0}%`),
      cur.mode === 'Re-encoding' ? 're-encoding' : 'quick repackage',
      cur.speed && `${cur.speed} speed`,
      cur.eta != null && fmtEta(cur.eta),
      c.queued > 0 && `${c.queued} more waiting`];
    parts.push(
      h('div', { class: 'row-title' }, `Converting ${cur.name}`),
      h('div', { class: 'dl-state' }, 'Making an MP4 copy that plays on iPhone and Apple TV'),
      h('div', { class: 'bulbs', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-valuenow': String(Math.floor(cur.percent || 0)), 'aria-label': 'Conversion progress',
        style: `--p:${cur.percent || 0}%` }, h('i')),
      h('div', { class: 'dl-stats' }, bits.filter(Boolean).map((b) => (b instanceof Node ? b : h('span', {}, b)))));
  } else if (c && !c.enabled && c.reason && !/turned off/i.test(c.reason)) {
    parts.push(h('div', { class: 'dl-state' }, `Automatic MP4 conversion is off. ${c.reason}`));
  }
  if (c?.recentFailures?.length) {
    parts.push(h('details', { class: 'convert-failures' },
      h('summary', {}, `${c.recentFailures.length} file${c.recentFailures.length > 1 ? 's' : ''} couldn’t be converted`),
      h('ul', {}, c.recentFailures.map((f) => h('li', {}, h('strong', {}, f.name), ` ${f.error}`)))));
  }
  el.hidden = !parts.length;
  el.replaceChildren(...parts);
}

function renderLibrary() {
  const body = $('#library-body');
  if (!state.status.library) {
    body.replaceChildren(notice('No media folder yet', 'Set MEDIA_DIR in the .env file to the folder with your videos, then restart the server.'));
    return;
  }
  if (state.libraryError) {
    body.replaceChildren(notice('Couldn’t read the library', state.libraryError, async () => { await loadLibrary(); renderLibrary(); }));
    return;
  }
  // Open details follow extensions and deletions, including removal of the last library item.
  if (showView.id) renderShow();
  if (filmView.id) renderFilm();
  const q = norm(state.query);
  const showsById = new Map(state.libraryShows.map((x) => [x.id, x]));
  const isShow = (f) => Boolean(f.show && showsById.get(f.show)) || f.season != null;
  const items = state.library.filter((f) => (!q || norm(f.title).includes(q) || norm(f.filmTitle).includes(q) || norm(f.file).includes(q)
    || norm(showsById.get(f.show)?.title).includes(q) || norm(f.episodeName).includes(q))
    && (state.libFilter === 'all' || (state.libFilter === 'tv') === isShow(f)));
  const filters = segmented(LIB_FILTERS, state.libFilter, (v) => { state.libFilter = v; renderLibrary(); }, 'Show');
  if (!state.library.length) {
    body.replaceChildren(notice('Your library is empty',
      state.server.length
        ? `Search for something in Discover. ${plural(state.server.length, 'video is', 'videos are')} already on the server: add those to your library and watch straight away, or download something new.`
        : 'Find something in Discover and download it. It shows up here when it’s ready.'));
    return;
  }
  if (!items.length) {
    body.replaceChildren(filters, notice(q ? `Nothing matches “${state.query.trim()}”` : `No ${state.libFilter === 'tv' ? 'shows' : 'films'} in your library`, q ? 'Try part of the title instead.' : 'Try the other filter.'));
    return;
  }
  // Your own downloads first, then what you added from the server, then (the owner's) collection that
  // was there before accounts. In each: one entry per show (its seasons and episodes are behind it),
  // films as poster cards, in the order picked in Settings.
  const sort = prefs().librarySort || 'newest';
  const soonest = (files) => Math.min(...files.map((f) => f.expiresAt ?? Infinity));
  const newest = (files) => Math.max(...files.map((f) => f.addedAt || f.added || 0));
  const order = (a, b) => (sort === 'expiring' ? soonest(a.files) - soonest(b.files) || newest(b.files) - newest(a.files)
    : sort === 'title' ? a.name.localeCompare(b.name) : newest(b.files) - newest(a.files));
  const sections = LIB_SECTIONS.map(([source, title, hint]) => {
    const entries = [];
    const byShow = new Map();
    for (const f of items.filter((x) => (x.source || 'existing') === source)) {
      const show = f.show && showsById.get(f.show);
      if (!show) { entries.push({ name: f.filmTitle || f.title, files: [f] }); continue; }
      if (!byShow.has(show.id)) { const e = { show, name: show.title, files: [] }; byShow.set(show.id, e); entries.push(e); }
      byShow.get(show.id).files.push(f);
    }
    if (!entries.length) return null;
    entries.sort(order);
    return h('section', { class: 'lib-section', 'aria-label': title },
      h('div', { class: 'lib-section-head' },
        h('h3', {}, title, h('span', { class: 'lib-count' }, String(entries.length))),
        h('p', { class: 'muted' }, typeof hint === 'function' ? hint() : hint)),
      libraryGroups(entries));
  });
  const watching = items.map((f) => ({ f, progress: savedProgress(libraryFile(f)) }))
    .filter((x) => partlyWatched(x.progress)).sort((a, b) => (b.progress.at || 0) - (a.progress.at || 0)).slice(0, 12);
  const leaving = libraryEntries(items.filter((f) => f.expiresAt != null && f.expiresAt - Date.now() < 48 * 3600000))
    .sort((a, b) => nextExpiry(a.files) - nextExpiry(b.files));
  const shelves = [
    watching.length > 0 && libraryShelf('Continue watching', watching.map(({ f, progress }) => {
      const show = showsById.get(f.show);
      const poster = show?.seasons.find((s) => s.number === f.season)?.poster || show?.poster || f.poster;
      const remaining = Math.max(1, Math.ceil((progress.duration - progress.time) / 60));
      return libraryCard({ name: show?.title || f.title, files: [f], poster,
        subtitle: [episodeLabel(f), `${remaining} min left`].filter(Boolean).join(' · '), resume: true });
    })),
    leaving.length > 0 && libraryShelf('Leaving soon', leaving.map((e) => libraryCard(e, true))),
  ].filter(Boolean);
  body.replaceChildren(h('div', { class: 'dl convert-banner', id: 'convert-banner', hidden: true }), filters, ...shelves, ...sections.filter(Boolean));
  renderConvertBanner();
}
const LIB_FILTERS = [['all', 'All'], ['movie', 'Films'], ['tv', 'Shows']];
const autoDeleteHint = () => (state.rules?.retentionDays
  ? `Ready to watch. Keep them longer before the countdown runs out.`
  : 'Kept until you delete them.');
const LIB_SECTIONS = [
  ['download', 'Your downloads', autoDeleteHint],
  ['added', 'Added from the server', 'Ready to watch, without another download.'],
  ['existing', 'Your collection', 'Kept until you choose to delete them.'],
];

// ---------- Library: shows ----------
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const episodeCount = (files) => new Set(files.map((f) => `${f.season}:${f.episode}`)).size;
const seasonName = (n) => (n === 0 ? 'Specials' : `Season ${n}`);

// Library cards share the same identity as playback, including old browser resume points.
const libraryFile = (f) => ({ ...f, kind: 'lib', key: f.id, done: true });
const nextExpiry = (files) => Math.min(...files.map((f) => f.expiresAt ?? Infinity));
const partlyWatched = (p) => p?.duration > 0 && p.time / p.duration > 0.01 && p.time / p.duration < 0.95;

function libraryEntries(items) {
  const shows = new Map(state.libraryShows.map((s) => [s.id, s]));
  const grouped = new Map();
  const entries = [];
  for (const f of items) {
    const show = shows.get(f.show);
    if (!show) { entries.push({ name: f.filmTitle || f.title, files: [f] }); continue; }
    if (!grouped.has(show.id)) {
      const entry = { show, name: show.title, files: [] };
      grouped.set(show.id, entry);
      entries.push(entry);
    }
    grouped.get(show.id).files.push(f);
  }
  return entries;
}

function libraryGroups(entries) {
  const films = entries.filter((e) => !e.show && e.files[0].season == null);
  const series = entries.filter((e) => e.show || e.files[0].season != null);
  const groups = films.length && series.length ? [['Films', films], ['Shows', series]] : [[null, entries]];
  return groups.map(([label, list]) => h('div', { class: 'lib-group' },
    label && h('h4', { class: 'lib-subhead' }, label),
    h('ul', { class: 'grid library-grid' }, list.map((e) => libraryCard(e)))));
}

function libraryShelf(title, cards) {
  return h('section', { class: 'shelf library-shelf', 'aria-label': title },
    h('div', { class: 'shelf-head' }, h('h3', {}, title)), h('ul', { class: 'shelf-items' }, cards));
}

function libraryCard(entry, keep = false) {
  const { show, files, name } = entry;
  const f = files[0];
  const seasons = [...new Set(files.map((f) => f.season))];
  const subtitle = entry.subtitle || (f.movieAmbiguous ? 'Film needs identifying' : show
    ? `${seasons.length === 1 ? seasonName(seasons[0]) : plural(seasons.length, 'season')} · ${plural(episodeCount(files), 'episode')}`
    : [f.year, f.season != null ? episodeLabel(f) : 'Film'].filter(Boolean).join(' · '));
  const poster = entry.poster || show?.poster || f.poster;
  const progress = savedProgress(libraryFile(f));
  const next = nextExpiry(files);
  const hours = (next - Date.now()) / 3600000;
  const expiry = hours <= 0 ? 'Leaving soon' : hours < 1 ? '<1h left' : hours < 48 ? `${Math.ceil(hours)}h left` : `${Math.ceil(hours / 24)}d left`;
  const eligible = files.filter(canExtend);
  return h('li', { class: 'library-card' },
    h('button', { type: 'button', class: 'title-card', onclick: (e) => entry.resume
      ? openPlayer(libraryFile(f)) : show ? openShow(show.id, e.currentTarget) : openFilm(f, e.currentTarget) },
      h('div', { class: 'poster' },
        poster ? h('img', { src: poster, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.currentTarget.replaceWith(h('div', { class: 'poster-fallback' }, name)) })
          : h('div', { class: 'poster-fallback' }, name),
        Number.isFinite(next) && h('span', { class: `poster-expiry${hours < 24 ? ' is-soon' : ''}`, title: timeLeft(next) }, expiry),
        partlyWatched(progress) && h('span', { class: 'poster-progress', 'aria-label': `${Math.round(progress.time / progress.duration * 100)}% watched` },
          h('i', { style: `width:${progress.time / progress.duration * 100}%` }))),
      h('div', { class: 'name' }, name), h('div', { class: 'sub' }, subtitle)),
    keep && eligible.length > 0 && h('button', { type: 'button', class: 'chip library-keep', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      await extendItems(eligible);
      if (btn.isConnected) btn.disabled = false;
    } }, `Keep ${extendDays()} more days`));
}

// These controls appear above the seasons, so extending a show doesn't require finding an episode.
function keepBar(files, onDone) {
  const timed = files.filter((f) => f.expiresAt != null).sort((a, b) => a.expiresAt - b.expiresAt);
  if (!timed.length) return h('div', { class: 'library-keep-bar is-kept' }, h('p', {}, 'Kept in your library'),
    h('p', { class: 'muted' }, 'No automatic deletion scheduled.'));
  const next = timed[0];
  const eligible = timed.filter(canExtend);
  const text = files.length > 1 ? `Next to go: ${episodeLabel(next) || next.title} · ${timeLeft(next.expiresAt)}` : timeLeft(next.expiresAt);
  return h('div', { class: 'library-keep-bar' },
    h('div', {}, h('p', { class: 'keep-countdown' }, text),
      h('p', { class: 'muted' }, eligible.length ? 'Keep it longer if you’re not finished watching.' : 'The extension limit has been reached.')),
    eligible.length > 0 && h('button', { type: 'button', class: 'play-btn', onclick: async (e) => {
      e.currentTarget.disabled = true;
      await extendItems(eligible);
      onDone();
    } }, eligible.length > 1 ? `Keep all ${eligible.length} · ${extendDays()} more days` : `Keep ${extendDays()} more days`));
}

const filmView = { id: null };
function openFilm(f, opener) {
  filmView.id = f.id;
  renderFilm();
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => {
    filmView.id = null;
    opener?.focus({ preventScroll: true });
  }));
}
function renderFilm() {
  const f = state.library.find((f) => f.id === filmView.id);
  if (!f) {
    $('#sheet-body').replaceChildren(h('div', { class: 'sheet-content' }, h('h2', { id: 'sheet-title' }, 'Removed from your library')));
    return;
  }
  const file = libraryFile(f);
  const progress = savedProgress(file);
  $('#sheet-body').replaceChildren(
    h('div', { class: `sheet-hero${f.backdrop ? '' : ' no-image'}`, style: f.backdrop ? `background-image:url("${f.backdrop}")` : null }),
    h('div', { class: 'sheet-content' },
      h('h2', { id: 'sheet-title' }, f.filmTitle || f.title),
      h('ul', { class: 'facts' }, [f.year, f.season != null ? episodeLabel(f) : 'Film', f.rating && `★ ${f.rating}`, f.format?.toUpperCase(), fmtBytes(f.size)]
        .filter(Boolean).map((text) => h('li', {}, text))),
      keepBar([f], renderFilm),
      f.movieAmbiguous && h('p', { class: 'identity-note' }, state.me?.isOwner
        ? 'Several films match this filename. Choose “Identify film” to select the right one.'
        : 'Several films match this filename. The server’s owner can identify this file.'),
      h('div', { class: 'library-film-actions' },
        h('button', { class: 'play-btn', disabled: f.converting, onclick: () => openPlayer(file) }, icon('play'),
          f.converting ? 'Converting…' : partlyWatched(progress) ? `Resume at ${fmtTime(progress.time)}` : 'Play'),
        h('button', { class: 'chip', onclick: (e) => openPicker(file, e.currentTarget) }, icon('tv'), 'Play on TV'),
        h('button', { class: 'chip', onclick: (e) => openDelete(file, e.currentTarget) }, icon('trash'), 'Delete'),
        state.me?.isOwner && h('button', { class: 'chip', onclick: (e) => openFilmIdentity(f, e.currentTarget) }, 'Identify film')),
      f.overview && h('p', { class: 'overview' }, f.overview)));
}

function openFilmIdentity(f, opener) {
  let closed = false;
  let request = 0;
  const list = h('ul', { class: 'rows identity-results' });
  const status = h('p', { class: 'muted', role: 'status' });
  const input = h('input', { type: 'search', 'aria-label': 'Film title', value: f.title });
  const form = h('form', { class: 'identity-search', onsubmit: (e) => { e.preventDefault(); search(); } }, input,
    h('button', { class: 'chip', type: 'submit' }, 'Search'));
  const draw = (results) => {
    list.replaceChildren(...results.map((t) => h('li', {}, h('button', { class: 'row identity-result', type: 'button', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api('/api/library/identify', jsonPost({ id: f.id, tmdbId: t.id }));
        if (!closed) closeTopOverlay();
        await loadLibrary();
        if (state.view === 'library') renderLibrary();
        toast('Film identified');
      } catch (err) { status.textContent = err.message; btn.disabled = false; }
    } },
    t.poster && h('img', { src: t.poster, alt: '', loading: 'lazy' }),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, t.title),
      h('span', { class: 'row-meta' }, t.releaseDate || t.year || 'Release date unknown'),
      h('span', { class: 'identity-overview' }, t.overview || 'No description available.'))))));
    status.textContent = results.length ? 'Choose the poster and description that match your film.' : 'No films found. Try a different title.';
  };
  async function search() {
    const currentRequest = ++request;
    status.textContent = 'Searching…';
    try {
      const data = await api(`/api/library/identify?id=${encodeURIComponent(f.id)}&q=${encodeURIComponent(input.value.trim())}`);
      if (!closed && currentRequest === request) draw(data.results);
    } catch (err) { if (!closed && currentRequest === request) status.textContent = err.message; }
  }
  $('#picker-body').replaceChildren(h('h2', { id: 'picker-title' }, 'Identify film'),
    h('p', { class: 'muted' }, `File: ${f.file}`), form, status, list);
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { closed = true; opener?.focus({ preventScroll: true }); }));
  if (f.filmCandidates?.length) draw(f.filmCandidates); else search();
}

// The show sheet: seasons as poster cards (TMDB's poster for each season), then a season's episodes.
// A show with one season on the server opens straight on its episodes.
const showView = { id: null, season: null };
function openShow(id, opener) {
  showView.id = id;
  showView.season = null;
  renderShow();
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => {
    showView.id = null;
    opener?.focus({ preventScroll: true });
  }));
}

function renderShow() {
  const show = state.libraryShows.find((x) => x.id === showView.id);
  const files = state.library.filter((f) => f.show === showView.id);
  if (!show || !files.length) { // its last episode was just deleted
    $('#sheet-body').replaceChildren(h('div', { class: 'sheet-content' }, h('h2', { id: 'sheet-title' }, show?.title || 'Show'),
      h('p', { class: 'muted' }, 'No episodes of this show are left on the server.')));
    return;
  }
  const seasons = show.seasons.filter((se) => files.some((f) => f.season === se.number));
  const single = seasons.length === 1;
  let open = single ? seasons[0] : seasons.find((se) => se.number === showView.season);
  const pick = (n) => { showView.season = n; renderShow(); $('#sheet').scrollTo({ top: 0, behavior: 'smooth' }); };

  let content;
  if (!open) {
    content = [
      h('h3', {}, 'Seasons'),
      h('ul', { class: 'grid season-grid' }, seasons.map((se) => {
        const n = episodeCount(files.filter((f) => f.season === se.number));
        return h('li', {},
          h('button', { class: 'title-card', onclick: () => pick(se.number) },
            h('div', { class: 'poster' },
              se.poster ? h('img', { src: se.poster, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'poster-fallback' }, se.name)),
            h('div', { class: 'name' }, se.name),
            h('div', { class: 'sub' }, se.total ? `${n} of ${se.total} episodes` : plural(n, 'episode'))));
      })),
    ];
  } else {
    const eps = files.filter((f) => f.season === open.number)
      .sort((a, b) => a.episode - b.episode || a.file.localeCompare(b.file));
    const n = episodeCount(eps);
    content = [
      !single && h('button', { class: 'chip season-back', onclick: () => pick(null) }, icon('back'), 'All seasons'),
      h('div', { class: 'season-head' },
        h('div', { class: 'poster season-poster' },
          open.poster ? h('img', { src: open.poster, alt: '' }) : h('div', { class: 'poster-fallback' }, open.name)),
        h('div', {},
          h('h3', {}, open.name),
          h('p', { class: 'muted' }, open.total ? `${n} of ${open.total} episodes in your library` : `${plural(n, 'episode')} in your library`))),
      h('ul', { class: 'rows' }, eps.map((f) => {
        const row = fileRow({ ...f, kind: 'lib', key: f.id, done: true });
        row.querySelector('.row-title').textContent = `${f.episode}. ${f.episodeName || `Episode ${f.episode}`}`;
        row.querySelector('.row-title').title = f.file;
        row.querySelector('.row-meta').prepend(h('span', {}, episodeLabel(f)));
        return row;
      })),
    ];
  }

  $('#sheet-body').replaceChildren(
    h('div', { class: `sheet-hero${show.backdrop ? '' : ' no-image'}`, style: show.backdrop ? `background-image:url("${show.backdrop}")` : null }),
    h('div', { class: 'sheet-content' },
      h('h2', { id: 'sheet-title' }, show.title),
      h('ul', { class: 'facts' },
        show.year && h('li', {}, show.year),
        h('li', {}, 'Series'),
        show.rating && h('li', {}, `★ ${show.rating}`),
        h('li', {}, `${plural(episodeCount(files), 'episode')} here`)),
      keepBar(files, renderShow),
      show.overview && h('p', { class: 'overview' }, show.overview),
      !open || single ? state.status.torrents && canDownload() && seasonStrip({ id: show.tmdbId, title: show.title }, files) : null,
      ...content));
}

// ---------- Downloads ----------
// Cards are updated in place so progress animates and focus is preserved.
const STATE_LABELS = {
  downloading: 'Downloading', forcedDL: 'Downloading',
  metaDL: 'Getting file info', forcedMetaDL: 'Getting file info',
  stalledDL: 'Waiting for peers',
  queuedDL: 'Queued', queuedUP: 'Queued',
  pausedDL: 'Paused', stoppedDL: 'Paused',
  checkingDL: 'Checking files', checkingUP: 'Checking files', checkingResumeData: 'Checking files',
  moving: 'Moving files',
  error: 'Error', missingFiles: 'Files missing',
};
const dlCards = new Map();

async function loadDownloads() {
  if (!state.status.downloads) return;
  try {
    state.downloads = (await api(`/api/downloads${state.dlScope === 'all' ? '?all=1' : ''}`)).items;
    state.downloadsError = null;
  } catch (err) {
    state.downloadsError = err.message;
  }
  const active = state.downloads.filter((d) => !d.done && d.mine !== false).length;
  const badge = $('#dl-badge');
  badge.hidden = !active;
  badge.textContent = active;
}

function makeDlCard(d) {
  const refs = {};
  const el = h('li', { class: 'dl' },
    h('div', { class: 'dl-head' },
      h('div', { class: 'row-text' },
        refs.title = h('div', { class: 'row-title' }),
        refs.state = h('div', { class: 'dl-state' })),
      refs.actions = h('div', { class: 'row-actions' },
        refs.cast = h('button', { class: 'cast-btn', title: 'Play on TV', onclick: () => openPicker({ ...refs.data, kind: 'dl', key: refs.data.hash }, refs.cast) }, icon('tv')),
        refs.play = h('button', { class: 'play-btn', onclick: () => {
          if (refs.data.converting) { toast('Cannot play while converting'); return; }
          openPlayer({ ...refs.data, kind: 'dl', key: refs.data.hash });
        } }, icon('play'), 'Play'))),
    refs.bar = h('div', { class: 'bulbs', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')),
    h('div', { class: 'dl-foot' },
      refs.stats = h('div', { class: 'dl-stats' }),
      h('div', { class: 'dl-controls' },
        refs.pause = h('button', { type: 'button', class: 'chip dl-ctl', onclick: () => togglePause(refs.data, refs.pause) }),
        refs.del = h('button', { type: 'button', class: 'chip dl-ctl', onclick: (e) => openDeleteDownload(refs.data, e.currentTarget) }, 'Delete'))));
  el._refs = refs;
  return el;
}

const isPaused = (d) => /^(paused|stopped)/.test(d.state || '');

async function togglePause(d, btn) {
  const resume = isPaused(d);
  btn.disabled = true;
  try {
    await api(`/api/downloads/${d.hash}/${resume ? 'resume' : 'pause'}`, jsonPost({}));
    d.state = resume ? 'downloading' : 'pausedDL'; // shown right away; the next refresh has qBittorrent's own state
    updateDlCard(dlCards.get(d.hash), d);
    toast(resume ? 'Download resumed' : 'Download paused');
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
}

function openDeleteDownload(d, opener) {
  const body = $('#picker-body');
  const status = h('p', { class: 'device-status', role: 'status' });
  const label = [d.title, episodeLabel(d), d.year && !d.season ? `(${d.year})` : null].filter(Boolean).join(' ');
  const run = async (files, btn) => {
    body.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = 'Deleting…';
    try {
      await api(`/api/downloads/${d.hash}/delete`, jsonPost({ files }));
      closeTopOverlay();
      toast(files ? 'Download and files deleted' : 'Removed from downloads; files kept');
      state.downloads = state.downloads.filter((x) => x.hash !== d.hash);
      if (state.view === 'downloads') renderDownloads();
      setTimeout(async () => { await Promise.all([loadLibrary(), loadDownloads()]); renderView(); }, 4000);
    } catch (err) {
      body.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      btn.textContent = btn.dataset.label;
      status.className = 'device-status is-error';
      status.textContent = err.message;
    }
  };
  const button = (text, cls, files) => {
    const b = h('button', { class: cls, 'data-label': text }, text);
    b.addEventListener('click', () => run(files, b));
    return b;
  };
  const cancel = h('button', { class: 'del-cancel', onclick: () => closeTopOverlay() }, 'Keep it');
  body.replaceChildren(
    h('h2', { id: 'picker-title' }, d.done ? 'Delete this download?' : 'Cancel this download?'),
    h('p', { class: 'del-name' }, label),
    h('p', { class: 'muted' }, d.done
      ? `Removes it from qBittorrent, so it stops seeding, and deletes its files (${fmtBytes(d.size)}). This can’t be undone.`
      : `Stops the download and deletes what has been downloaded so far (${Math.floor(d.progress * 100)}% of ${fmtBytes(d.size)}).`),
    h('div', { class: 'del-actions' },
      button(d.done ? 'Delete download and files' : 'Cancel and delete', 'del-confirm', true),
      button('Remove from list, keep files', 'del-confirm del-secondary', false),
      cancel),
    status);
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));
  cancel.focus();
}

function updateDlCard(el, d) {
  const r = el._refs;
  r.data = d;
  const pct = Math.floor(d.progress * 1000) / 10;
  const label = d.done ? 'Ready to watch' : (STATE_LABELS[d.state] || 'Downloading');
  r.title.textContent = [d.title, episodeLabel(d), d.year && !d.season ? `(${d.year})` : null].filter(Boolean).join(' ');
  r.title.title = d.name;
  r.state.textContent = d.owner && !d.mine ? `${label} · for ${d.owner}` : label;
  r.state.classList.toggle('is-error', d.state === 'error' || d.state === 'missingFiles');
  r.actions.hidden = !d.done;
  r.play.setAttribute('aria-label', `Play ${d.title} here`);
  r.cast.setAttribute('aria-label', `Play ${d.title} on a TV`);
  r.bar.hidden = d.done;
  r.bar.style.setProperty('--p', `${pct}%`);
  r.bar.setAttribute('aria-valuenow', String(Math.floor(pct)));
  r.bar.setAttribute('aria-label', `${d.title} download progress`);
  const SUB_STATE = { waiting: 'subtitles when done', ready: 'subtitles ready', missing: 'subtitles not found', error: 'subtitles failed' };
  const subs = (d.subs || []).map((x) => h('span', { class: `sub-state sub-${x.state}` }, `${x.name} ${SUB_STATE[x.state] || ''}`));
  const stats = d.done
    ? [fmtBytes(d.size), ...subs]
    : [h('strong', {}, `${pct}%`), `of ${fmtBytes(d.size)}`, !isPaused(d) && d.speed > 0 && `${fmtBytes(d.speed)}/s`, !isPaused(d) && fmtEta(d.eta), ...subs];
  r.stats.replaceChildren(...stats.filter(Boolean).map((s) => (s instanceof Node ? s : h('span', {}, s))));
  r.pause.hidden = d.done;
  r.del.hidden = d.done; // finished downloads are deleted from the Library
  r.play.classList.toggle('is-disabled', Boolean(d.converting));
  r.play.setAttribute('aria-disabled', String(Boolean(d.converting)));
  r.play.title = d.converting ? 'Cannot play while converting' : '';
  r.pause.textContent = isPaused(d) ? 'Resume' : 'Pause';
  r.pause.setAttribute('aria-label', `${isPaused(d) ? 'Resume' : 'Pause'} ${d.title}`);
}

function renderDownloads() {
  const body = $('#downloads-body');
  // The owner can see everyone's downloads; everybody else only ever gets their own from the server.
  const scope = $('#dl-scope');
  if (state.me?.isOwner && scope && !scope.firstChild) {
    scope.append(segmented([['mine', 'Mine'], ['all', 'Everyone']], state.dlScope, async (v) => {
      state.dlScope = v;
      scope.replaceChildren();
      dlCards.clear();
      $('#downloads-body').replaceChildren();
      renderDownloads();
      await loadDownloads();
      renderDownloads();
    }, 'Whose downloads'));
  }
  if (!state.status.downloads) {
    dlCards.clear();
    body.replaceChildren(notice('Downloads aren’t connected',
      'Turn on qBittorrent’s Web UI, add QBIT_URL, QBIT_USER and QBIT_PASS to the .env file, then restart the server.'));
    return;
  }
  if (state.downloadsError) {
    dlCards.clear();
    body.replaceChildren(notice('Couldn’t get downloads', state.downloadsError));
    return;
  }
  const q = norm(state.query);
  const items = state.downloads.filter((d) => !q || norm(d.name).includes(q));
  if (!items.length) {
    dlCards.clear();
    body.replaceChildren(notice(q ? `Nothing matches “${state.query.trim()}”` : 'No downloads',
      q ? 'Try part of the title instead.' : state.status.torrents ? 'Use “Find torrents” above, or add something in qBittorrent. Progress shows up here.' : 'Anything added in qBittorrent shows up here with its progress.'));
    return;
  }

  let list = body.querySelector('ul.rows');
  if (!list) { list = h('ul', { class: 'rows' }); body.replaceChildren(list); }

  const seen = new Set();
  items.forEach((d, i) => {
    seen.add(d.hash);
    let el = dlCards.get(d.hash);
    if (!el) { el = makeDlCard(d); dlCards.set(d.hash, el); }
    updateDlCard(el, d);
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  for (const [hash, el] of dlCards) if (!seen.has(hash)) { el.remove(); dlCards.delete(hash); }
}

// Polls quickly while Downloads is open, slowly otherwise.
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const clipsBusy = state.view === 'clips' && state.clips?.clips?.some((c) => c.share && !c.share.ready && !c.share.error);
  const powerBusy = state.view === 'house' && state.house?.power?.some((pw) => pw.pending);
  const delay = state.view === 'downloads' ? 2000 : state.view === 'library' || clipsBusy || powerBusy ? 3000 : ['activity', 'house'].includes(state.view) ? 10000 : 15000;
  pollTimer = setTimeout(async () => {
    if (!document.hidden) {
      const before = state.convert?.current?.name;
      await Promise.all([loadDownloads(), loadSessions(), state.view === 'library' ? loadConvert() : null]);
      if (state.view === 'downloads') renderDownloads();
      if (state.view === 'activity') { await loadActivity(); if (state.view === 'activity') renderActivity(); }
      if (state.view === 'house') { await loadHouse(); if (state.view === 'house') renderHouse(); }
      if (state.view === 'clips' && clipsBusy) { await loadClips(); if (state.view === 'clips') renderClips(); }
      if (state.view === 'library') {
        // A conversion finished: refresh so the new MP4 appears.
        // A conversion started or finished: refresh so Play is disabled / the new MP4 appears.
        if (before !== state.convert?.current?.name) { await loadLibrary(); renderLibrary(); } else renderConvertBanner();
      }
    }
    schedulePoll();
  }, delay);
}
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && state.view === 'downloads') { await loadDownloads(); renderDownloads(); }
});

// ---------- overlays ----------
// Each overlay pushes a history entry so the browser/phone back gesture closes it.
const overlayStack = [];
function pushOverlay(close) {
  overlayStack.push(close);
  history.pushState({ overlay: overlayStack.length }, '');
}
function closeTopOverlay() { if (overlayStack.length) history.back(); }
// Browser-back is asynchronous. Transitions must wait before pushing a replacement player.
function dismissTopOverlay() {
  if (!overlayStack.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { window.removeEventListener('popstate', done); reject(new Error('Couldn’t close the previous screen. Please try joining again.')); }, 3000);
    window.addEventListener('popstate', done, { once: true });
    closeTopOverlay();
  });
}
// Replaces the top overlay without adding a history entry.
function swapTopOverlay(close) {
  overlayStack.pop()?.();
  overlayStack.push(close);
  history.replaceState({ overlay: overlayStack.length }, '');
}
window.addEventListener('popstate', () => { overlayStack.pop()?.(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!ccMenu.hidden) { closeCcMenu(); ccBtn.focus(); return; }
  if (!syncMenu.hidden) { closeSyncMenu(); syncBtn.focus(); return; }
  if (!helpEl.hidden) { helpEl.hidden = true; return; }
  if (watchPanelOpen) { setWatchPanel(false); $('#watch-btn').focus(); return; }
  if (fsElement()) { toggleFullscreen(); return; }
  if (Date.now() - fsExitedAt < 500) return; // that Escape just took the player out of fullscreen
  closeTopOverlay();
});

// ---------- sheets ----------
const sheetHideTimers = new Map();
function showSheet(sheet, backdrop, onClosed) {
  clearTimeout(sheetHideTimers.get(sheet));
  sheet.hidden = backdrop.hidden = false;
  sheet.scrollTop = 0;
  requestAnimationFrame(() => { sheet.classList.add('open'); backdrop.classList.add('open'); });
  sheet.querySelector('.sheet-close').focus({ preventScroll: true });
  return () => {
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    sheetHideTimers.set(sheet, setTimeout(() => { sheet.hidden = backdrop.hidden = true; }, 300));
    onClosed?.();
  };
}

for (const [sheetSel, backdropSel] of [['#sheet', '#sheet-backdrop'], ['#picker', '#picker-backdrop']]) {
  const sheet = $(sheetSel);
  sheet.querySelector('.sheet-close').addEventListener('click', closeTopOverlay);
  $(backdropSel).addEventListener('click', closeTopOverlay);
  // Swipe down to close
  let startY = null;
  sheet.addEventListener('touchstart', (e) => { startY = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (startY != null && e.changedTouches[0].clientY - startY > 90) closeTopOverlay();
    startY = null;
  });
}

function openDetails(t, opener) {
  renderDetails(t);
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => opener?.focus({ preventScroll: true })));
}

function renderDetails(t) {
  const files = matchesFor(t);
  const onServer = serverMatchesFor(t);
  const isTv = t.type === 'tv';
  const findBtn = state.status.torrents && canDownload() && h('button', {
    class: `find-btn${onServer.length ? ' is-quiet' : ''}`,
    onclick: (e) => openTorrents({
      query: isTv ? t.title : [t.title, t.year].filter(Boolean).join(' '),
      type: isTv ? 'tv' : 'movie',
      movieId: !isTv ? t.id : null,
      label: t.title,
      opener: e.currentTarget,
    }),
  }, icon('download'), files.some((f) => f.done) || onServer.length ? 'Find another version' : 'Find a download');
  const getIt = findBtn && h('div', { class: 'dl-actions' }, bestDownload(t, files, onServer), findBtn);
  $('#sheet-body').replaceChildren(
    h('div', { class: `sheet-hero${t.backdrop ? '' : ' no-image'}`, style: t.backdrop ? `background-image:url("${t.backdrop}")` : null }),
    h('div', { class: 'sheet-content' },
      h('h2', { id: 'sheet-title' }, t.title),
      h('ul', { class: 'facts' },
        t.year && h('li', {}, t.year),
        h('li', {}, t.type === 'tv' ? 'Series' : 'Film'),
        t.rating && h('li', {}, `★ ${t.rating}`)),
      t.overview && h('p', { class: 'overview' }, t.overview),
      // Already on the server (someone else downloaded it): add it instead of downloading it again.
      onServer.length > 0 && serverOffer(t, onServer),
      // Shows: downloading comes first (a season chip per season), then what's here folded by season,
      // so a show with many episodes on the server doesn't push the buttons far down.
      ...(isTv ? [getIt, state.status.torrents && canDownload() && seasonStrip(t, [...files, ...onServer])] : []),
      h('h3', {}, 'In your library'),
      !files.length ? h('p', { class: 'muted' }, onServer.length ? 'Not in your library yet.' : 'Not on this server yet.')
        : isTv ? seasonGroups(files)
          : h('ul', { class: 'rows' }, files.map(fileRow)),
      !isTv && getIt));
}

// "Already on the server": a row per version of a film, or per season of a show, each with an Add
// button (and Add & play for films). Adding makes no copy; the video just joins your library.
function serverOffer(t, list) {
  const status = h('p', { class: 'device-status', role: 'status' });
  const isTv = t.type === 'tv';
  const add = async (files, btn, play = false) => {
    btn.disabled = true;
    status.textContent = '';
    try {
      await api('/api/library/add', jsonPost({ ids: files.map((f) => f.id) }));
      await loadLibrary();
      toast(files.length === 1 ? 'Added to your library' : `Added ${plural(files.length, 'episode')} to your library`);
      if (state.view === 'library') renderLibrary();
      renderDetails(t);
      if (play) {
        const mine = state.library.find((x) => x.mediaKey === files[0].mediaKey);
        if (mine) openPlayer({ ...mine, kind: 'lib', key: mine.id, done: true });
      }
    } catch (err) {
      btn.disabled = false;
      status.className = 'device-status is-error';
      status.textContent = err.message;
    }
  };
  const button = (text, cls, files, play) => {
    const b = h('button', { type: 'button', class: cls }, text);
    b.addEventListener('click', () => add(files, b, play));
    return b;
  };
  let rows;
  if (!isTv) {
    rows = list.map((f) => h('li', { class: 'row' },
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, f.title + (f.year ? ` (${f.year})` : '')),
        h('div', { class: 'row-meta' }, h('span', {}, f.format?.toUpperCase()), h('span', {}, fmtBytes(f.size)))),
      h('div', { class: 'row-actions' },
        button('Add', 'chip', [f]),
        button('Add & play', 'play-btn', [f], true))));
  } else {
    const bySeason = new Map();
    for (const f of list) {
      const n = f.season ?? -1;
      if (!bySeason.has(n)) bySeason.set(n, []);
      bySeason.get(n).push(f);
    }
    rows = [...bySeason].sort((a, b) => a[0] - b[0]).map(([n, eps]) => {
      const nums = [...new Set(eps.map((f) => f.episode).filter((x) => x != null))].sort((a, b) => a - b);
      const span = nums.length > 1 ? `E${pad2(nums[0])}–E${pad2(nums.at(-1))}` : nums.length ? `E${pad2(nums[0])}` : null;
      return h('li', { class: 'row' },
        h('div', { class: 'row-text' },
          h('div', { class: 'row-title' }, n < 0 ? 'Other videos' : seasonName(n)),
          h('div', { class: 'row-meta' }, h('span', {}, plural(episodeCount(eps), 'episode')), span && h('span', {}, span))),
        h('div', { class: 'row-actions' }, button(n < 0 ? 'Add' : 'Add season', 'chip', eps)));
    });
  }
  return h('div', { class: 'server-offer' },
    h('div', { class: 'server-offer-head' },
      h('h3', {}, 'Already on the server'),
      isTv && rows.length > 1 && button(`Add all ${plural(episodeCount(list), 'episode')}`, 'play-btn', list)),
    h('p', { class: 'muted' }, isTv
      ? 'Someone already has these here. Add them to your library to watch now, without downloading them again.'
      : 'Someone already has this here. Add it to your library to watch now, without downloading it again.'),
    h('ul', { class: 'rows' }, rows),
    status);
}

// Episodes on the server, one collapsible line per season (loose files and season packs first).
function seasonGroups(files) {
  const loose = files.filter((f) => f.season == null);
  const bySeason = new Map();
  for (const f of files.filter((x) => x.season != null).sort((a, b) => a.season - b.season || a.episode - b.episode)) {
    if (!bySeason.has(f.season)) bySeason.set(f.season, []);
    bySeason.get(f.season).push(f);
  }
  return h('div', { class: 'season-groups' },
    loose.length > 0 && h('ul', { class: 'rows' }, loose.map(fileRow)),
    [...bySeason].map(([n, eps]) => {
      const busy = eps.filter((f) => !f.done).length;
      return h('details', { class: 'season-group' },
        h('summary', {},
          h('span', { class: 'row-title' }, seasonName(n)),
          h('span', { class: 'row-meta' }, h('span', {}, plural(episodeCount(eps), 'episode')), busy > 0 && h('span', {}, `${busy} downloading`))),
        h('ul', { class: 'rows' }, eps.map(fileRow)));
    }));
}

// "Get a season": a chip per TMDB season (✓ complete here, 3/10 partly here, soon = not aired yet);
// a tap searches torrents for that season, where "Get all episodes" can fetch it episode by episode.
function seasonStrip(t, files) {
  const box = h('div', { class: 'season-strip' });
  if (!t.id) return box;
  tvSeasons(t.id).then((seasons) => {
    if (!seasons.length) return;
    const chips = seasons.map((se) => {
      const have = episodeCount(files.filter((f) => f.season === se.number && f.episode != null));
      const full = se.episodes && have >= se.episodes;
      const label = full ? `S${pad2(se.number)} ✓` : have ? `S${pad2(se.number)} · ${have}/${se.episodes || '?'}` : `S${pad2(se.number)}`;
      return h('button', {
        type: 'button',
        class: `chip season-chip${full ? ' is-full' : have ? ' is-partial' : ''}`,
        title: `${se.name}${se.episodes ? `, ${plural(se.episodes, 'episode')}` : ''}${have ? `, ${have} on the server` : ''}`,
        disabled: se.upcoming && !have ? true : null,
        onclick: (e) => openTorrents({ query: `${t.title} S${pad2(se.number)}`, type: 'tv', label: `${t.title}, ${se.name}`, opener: e.currentTarget }),
      }, se.upcoming && !have ? `${label} · soon` : label);
    });
    box.replaceChildren(h('h3', {}, 'Get a season'), h('div', { class: 'season-chips' }, chips));
  }).catch(() => {});
  return box;
}

// Requests worth repeating within a few minutes (re-rendering a sheet shouldn't search again).
const shortCache = new Map(); // url -> { at, promise }
function cachedFor(url, ms = 5 * 60 * 1000) {
  const hit = shortCache.get(url);
  if (hit && Date.now() - hit.at < ms) return hit.promise;
  const promise = api(url);
  promise.catch(() => shortCache.delete(url));
  shortCache.set(url, { at: Date.now(), promise });
  return promise;
}
const tvSeasons = (id) => cachedFor(`/api/tv/${id}/seasons`, 30 * 60 * 1000).then((d) => d.seasons);

// "Best download": one tap gets the torrent the server picks (recommend.js: 1080p or 4K whenever
// either exists). Films that aren't here yet; for shows, the first aired season that isn't complete
// here. A season that's partly here, or has no healthy pack, is fetched episode by episode instead.
function bestDownload(t, files, onServer) {
  const box = h('div', { class: 'best-dl', hidden: true });
  const isTv = t.type === 'tv';
  if (!isTv && (files.length || onServer.length)) return box;
  const status = h('p', { class: 'best-meta', role: 'status' });
  const subs = () => (state.status.subtitles && prefs().subLang ? [prefs().subLang] : []);
  const qualityName = (q) => (q === '2160p' ? '4K' : q || 'Unknown quality');
  let se = null; // the season on offer (shows)

  (async () => {
    let have = 0;
    if (isTv) {
      if (!t.id) return;
      const here = [...files, ...onServer].filter((f) => f.episode != null);
      const count = (n) => episodeCount(here.filter((f) => f.season === n));
      se = (await tvSeasons(t.id)).find((s) => !s.upcoming && !(s.episodes && count(s.number) >= s.episodes));
      if (!se) return;
      have = count(se.number);
    }
    box.hidden = false;
    box.replaceChildren(h('button', { type: 'button', class: 'play-btn best-btn', disabled: true }, 'Finding the best download…'));
    // Part of the season is already here: a pack would download those episodes again.
    const rec = have ? { pick: null } : await cachedFor(`/api/torrents/recommend?${new URLSearchParams({
      type: isTv ? 'tv' : 'movie', title: t.title, ...(t.year ? { year: t.year } : {}), ...(se ? { season: se.number } : {}) })}`);
    if (rec.pick) return showPick(rec);
    if (!isTv) {
      box.replaceChildren(h('p', { class: 'best-meta' }, 'No download stood out, so pick one yourself.'));
      return;
    }
    const btn = h('button', { type: 'button', class: 'play-btn best-btn' }, icon('download'), `Get ${se.name} episode by episode`);
    btn.addEventListener('click', () => getSeason(`${t.title} S${pad2(se.number)}`, {
      subs: subs(), btn, status, label: `Get ${se.name} episode by episode`, isOpen: () => btn.isConnected,
    }));
    status.textContent = have
      ? `${have} of ${se.episodes || '?'} episodes are already here. Marquee finds the rest, in 1080p where it can.`
      : `No complete ${se.name.toLowerCase()} with enough seeders, so Marquee finds each episode separately, in 1080p where it can.`;
    box.replaceChildren(btn, status);
  })().catch(() => { box.hidden = true; });

  function showPick({ pick, why }) {
    const label = isTv ? `Get ${se.name}` : 'Get the best download';
    const btn = h('button', { type: 'button', class: 'play-btn best-btn', 'aria-label': `${label}, ${qualityName(pick.quality)}` },
      icon('download'), label, h('span', { class: 'best-q' }, qualityName(pick.quality)));
    status.replaceChildren(...[
      [pick.size && fmtBytes(pick.size), `${pick.seeders.toLocaleString()} seeding`, ...pick.tags, SOURCE_NAMES[pick.source]].filter(Boolean).join(' · '),
      why && h('span', { class: 'best-why' }, why),
    ].filter(Boolean));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.replaceChildren('Adding…');
      try {
        await sendToQbit(await magnetOf(pick), { name: pick.name, subs: subs(), ...(!isTv && t.id ? { movieId: t.id } : {}) });
        btn.classList.add('is-added');
        btn.replaceChildren(icon('check'), 'Added');
        toast(subs().length ? 'Added. Subtitles come when it finishes.' : 'Added to Downloads');
      } catch (err) {
        btn.disabled = false;
        btn.replaceChildren(icon('download'), label, h('span', { class: 'best-q' }, qualityName(pick.quality)));
        status.textContent = err.message;
      }
    });
    box.replaceChildren(btn, status, h('p', { class: 'best-name', title: pick.name }, pick.name));
  }
  return box;
}

// A whole season episode by episode (season.js), with progress in `status` while isOpen() holds.
async function getSeason(query, { quality = '', subs = [], btn, status, label, isOpen }) {
  btn.disabled = true;
  btn.replaceChildren('Starting…');
  let job;
  try {
    job = await api('/api/downloads/season', jsonPost({ query, quality, subs }));
  } catch (err) {
    btn.disabled = false;
    btn.replaceChildren(icon('download'), label);
    status.textContent = err.message;
    return;
  }
  btn.replaceChildren('Working…');
  while (isOpen()) {
    let j;
    try { j = await api(`/api/downloads/season/${job.id}`); } catch (err) { status.textContent = err.message; break; }
    const eps = (list) => list.map((e) => `E${pad2(e)}`).join(', ');
    if (j.state === 'running') {
      status.textContent = [j.step, j.added.length && `${j.added.length} added so far`].filter(Boolean).join(' · ');
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (j.state === 'failed') {
      status.textContent = `Stopped: ${j.error}`;
      btn.disabled = false;
      btn.replaceChildren(icon('download'), 'Try again');
      break;
    }
    const n = j.added.reduce((sum, a) => sum + a.episodes.length, 0);
    status.textContent = [
      n ? `Added ${plural(n, 'episode')}` : j.step || 'Nothing new to add',
      j.have.length && `${j.have.length} already here`,
      j.missing.length && `not found: ${eps(j.missing)}`,
      j.upcoming && `${j.upcoming} not aired yet`,
    ].filter(Boolean).join(' · ');
    btn.classList.add('is-added');
    btn.replaceChildren(icon('check'), n ? 'Added' : 'Done');
    if (n) {
      toast(`${j.title} season ${j.season}: ${plural(n, 'episode')} added to Downloads`);
      loadDownloads().then(() => { if (state.view === 'downloads') renderDownloads(); });
    }
    break;
  }
}

// ---------- casting: device picker ----------
const jsonPost = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function openPicker(file, opener) {
  const name = [file.title, episodeLabel(file)].filter(Boolean).join(' ');
  const list = h('ul', { class: 'rows device-list' });
  const notes = h('div', { class: 'picker-notes' });
  const again = h('button', { class: 'retry', onclick: () => load(true) }, 'Search again');
  // The phone's own AirPlay / Chromecast list: works on whatever network the phone is on.
  const nearby = canCastFromBrowser && h('button', {
    class: 'device device-nearby',
    onclick: () => openPlayer(file, { replace: true, castHint: true }),
  },
  h('span', { class: 'device-icon' }, icon('airplay')),
  h('span', { class: 'row-text' },
    h('span', { class: 'row-title' }, hasAirPlay ? 'AirPlay to a TV near you' : 'Cast to a TV near you'),
    h('span', { class: 'row-meta' }, h('span', {}, 'Pick a TV from this phone’s own list. The TV streams straight from the server.'))));
  const nearbyWrap = h('div', { class: 'nearby', hidden: true }, h('p', { class: 'muted nearby-label' }, 'Or from this phone'), nearby);
  $('#picker-body').replaceChildren(
    h('h2', { id: 'picker-title' }, 'Play on TV'),
    h('p', { class: 'muted picker-sub' }, name),
    ...[list, notes, again, nearby && nearbyWrap].filter(Boolean));
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));

  async function load(refresh) {
    again.disabled = true;
    notes.replaceChildren();
    if (refresh) list.replaceChildren(h('li', { class: 'searching', role: 'status' }, 'Looking for TVs on your network…'));
    try {
      const data = await api(`/api/cast/devices${refresh ? '?refresh=1' : ''}`);
      if (data.away) {
        again.hidden = true;
        if (nearby) {
          nearbyWrap.hidden = true;
          list.replaceChildren(h('li', {}, nearby));
          notes.replaceChildren(h('p', { class: 'muted' }, 'You’re away from home, so the TVs there aren’t listed.'));
        } else {
          list.replaceChildren(h('li', {}, notice('You’re away from home',
            'The TVs at home aren’t available from here, and this browser can’t cast to TVs near you. Open Marquee in Safari (AirPlay) or Chrome (Chromecast) to use one, or press Play to watch here.')));
        }
        return;
      }
      if (nearby) nearbyWrap.hidden = false;
      if (!refresh && !data.devices.length) return load(true); // empty cache: scan now
      list.replaceChildren(...data.devices.map(deviceRow));
      if (!data.devices.length) {
        list.replaceChildren(h('li', {}, notice('No TVs found',
          'Check the TV is switched on and on the same network as the server. On Samsung and LG TVs, screen sharing / DLNA may need turning on in the settings.')));
      }
      notes.replaceChildren(...data.notes.map((n) => h('p', { class: 'muted' }, n)));
    } catch (err) {
      list.replaceChildren(h('li', {}, notice('Couldn’t search for TVs', err.message)));
    } finally {
      again.disabled = false;
    }
  }

  function deviceRow(d) {
    const status = h('span', { class: 'device-status' });
    // A TV that's already playing also gets a button for its remote (yours, or to stop someone else's).
    const remote = d.session && h('button', { type: 'button', class: 'chip device-remote', onclick: () => openRemote(d.session, { replace: true }) },
      d.session.mine ? 'Open remote' : 'Open its remote');
    const btn = h('button', { class: 'device', onclick: () => start(d, btn, status) },
      h('span', { class: 'device-icon' }, icon('tv')),
      h('span', { class: 'row-text' },
        h('span', { class: 'row-title' }, d.name),
        h('span', { class: 'row-meta' }, h('span', {}, d.kind === 'airplay' ? 'Apple TV' : (d.model || 'Smart TV')),
          d.session ? h('span', {}, d.session.mine ? `Playing ${d.session.title}` : 'Someone else is watching')
            : d.playing && h('span', {}, 'Playing something now')),
        status));
    return h('li', {}, btn, remote);
  }

  async function start(d, btn, status) {
    // Someone else's TV: ask for a second tap before taking it over.
    if (d.session && !d.session.mine && !btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      status.className = 'device-status is-error';
      status.textContent = `Someone is watching ${d.session.title} on this TV. Tap again to play here instead.`;
      return;
    }
    btn.disabled = true;
    status.className = 'device-status';
    status.textContent = 'Starting on the TV…';
    try {
      const { session } = await api('/api/cast/play', jsonPost({ deviceId: d.id, kind: file.kind, id: file.key }));
      state.sessions = [session, ...state.sessions.filter((s) => s.deviceId !== session.deviceId)];
      renderNowbar();
      openRemote(session, { replace: true });
    } catch (err) {
      btn.disabled = false;
      status.className = 'device-status is-error';
      status.textContent = err.message;
    }
  }

  load(false);
}

// ---------- library deletion ----------
async function openDelete(f, opener) {
  const id = f.id || f.key;
  const body = $('#picker-body');
  body.replaceChildren(h('h2', { id: 'picker-title' }, 'Delete'), h('p', { class: 'muted' }, 'Checking…'));
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));

  let info;
  try {
    info = await api(`/api/library/delete-info?id=${encodeURIComponent(id)}`);
  } catch (err) {
    body.replaceChildren(h('h2', { id: 'picker-title' }, 'Can’t delete this'), h('p', { class: 'muted' }, err.message));
    return;
  }
  const label = [info.title || info.name, episodeLabel(info) || (info.year && `(${info.year})`)].filter(Boolean).join(' ');
  const status = h('p', { class: 'device-status', role: 'status' });
  const t = info.torrent;
  const pack = t && t.videos > 1;

  const run = async (scope, btn, everyone = false) => {
    body.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = everyone || !info.others ? 'Deleting…' : 'Removing…';
    status.className = 'device-status';
    status.textContent = '';
    try {
      const r = await api('/api/library/delete', jsonPost({ id, scope, everyone }));
      closeTopOverlay();
      toast(r.kept ? 'Removed from your library' : scope === 'torrent' && pack ? `Deleted all ${t.videos} videos` : 'Deleted');
      state.library = state.library.filter((x) => x.id !== id);
      // Refresh after the server finishes cleaning up.
      setTimeout(async () => { await Promise.all([loadLibrary(), loadDownloads()]); if (state.view === 'library') renderLibrary(); if (state.view === 'downloads') renderDownloads(); }, 5000);
      if (state.view === 'library') renderLibrary();
    } catch (err) {
      body.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      btn.textContent = btn.dataset.label;
      status.className = 'device-status is-error';
      status.textContent = err.message;
    }
  };
  const button = (text, cls, scope, everyone) => {
    const b = h('button', { class: cls, 'data-label': text }, text);
    b.addEventListener('click', () => run(scope, b, everyone));
    return b;
  };
  const cancel = h('button', { class: 'del-cancel', onclick: () => closeTopOverlay() }, 'Keep it');
  // Someone else has it too: it only leaves your library (the owner can still delete the file).
  if (info.others) {
    body.replaceChildren(h('h2', { id: 'picker-title' }, 'Remove from your library?'),
      h('p', { class: 'del-name' }, label),
      h('p', { class: 'muted' }, `${plural(info.others, 'other person has', 'other people have')} this in their library, so the file stays on the server. You can add it back from Discover.`),
      h('div', { class: 'del-actions' },
        button('Remove from my library', 'del-confirm', 'file'),
        info.canDeleteForEveryone && button(`Delete the file for everyone (${fmtBytes(info.size)})`, 'del-confirm del-secondary', 'file', true),
        cancel),
      status);
    cancel.focus();
    return;
  }

  const lines = [
    h('p', { class: 'del-name' }, label),
    h('p', { class: 'muted' }, pack
      ? `This is one of ${t.videos} videos in the torrent “${t.name}”. Deleting all of them also removes the torrent from qBittorrent.`
      : t ? `This also removes the torrent from qBittorrent, so it stops seeding. ${fmtBytes(t.size)} will be freed.`
        : `${fmtBytes(info.size)} will be freed. This can’t be undone.`),
  ];
  const actions = pack
    ? [button('Delete this video only', 'del-confirm', 'file'), button(`Delete all ${t.videos} videos (${fmtBytes(t.size)})`, 'del-confirm del-secondary', 'torrent')]
    : [button('Delete', 'del-confirm', t ? 'torrent' : 'file')];
  body.replaceChildren(h('h2', { id: 'picker-title' }, 'Delete this?'), ...lines, h('div', { class: 'del-actions' }, ...actions, cancel), status);
  cancel.focus();
}

// ---------- torrent search ----------
const SOURCE_NAMES = { tpb: 'The Pirate Bay', '1337x': '1337x' };
const QUALITY_FILTERS = [['all', 'All'], ['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p']];

// navigator.clipboard requires HTTPS; fall back to execCommand on plain HTTP.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  ta.remove();
  return ok;
}

// "South Park S18", "South Park season 18" -> { title, season } (same rule as the server's season.js).
function parseSeasonQuery(q) {
  const m = /^(.*?)[\s.]+(?:s(\d{1,2})|season[\s.]*(\d{1,2}))(?:[\s.]+(?:complete|full))?[\s.]*$/i.exec(String(q || '').trim());
  if (!m || !m[1].trim()) return null;
  return { title: m[1].replace(/[._]+/g, ' ').replace(/\(?(19|20)\d{2}\)?\s*$/, '').trim(), season: Number(m[2] || m[3]) };
}

async function magnetOf(t) {
  if (t.magnet) return t.magnet;
  t.magnet = (await api(`/api/torrents/magnet?ref=${encodeURIComponent(t.ref)}`)).magnet;
  return t.magnet;
}

async function sendToQbit(link, extra = {}) {
  await api('/api/downloads/add', jsonPost({ link, ...extra }));
  loadDownloads().then(() => { if (state.view === 'downloads') renderDownloads(); });
}

function openTorrents({ query = '', type = 'all', label = null, movieId = null, opener } = {}) {
  let results = [];
  let filter = prefs().quality || 'all'; // Settings → preferred quality
  let ctrl;
  const added = new Set();

  const input = h('input', { type: 'search', enterkeyhint: 'search', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
    'aria-label': 'Torrent search', placeholder: 'Title, or paste a magnet link' });
  input.value = query;
  const form = h('form', { class: 'search tor-search', role: 'search' },
    h('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon('search')), input,
    h('button', { type: 'submit', class: 'tor-go' }, 'Search'));
  const chips = h('div', { class: 'tor-filters', role: 'group', 'aria-label': 'Quality' },
    QUALITY_FILTERS.map(([key, text]) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(key === filter),
      onclick: (e) => {
        filter = key;
        chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === e.currentTarget)));
        renderList();
      },
    }, text)));
  const info = h('p', { class: 'muted tor-info', role: 'status' });
  const seasonBox = h('div', { class: 'season-dl-wrap' });
  const list = h('ul', { class: 'rows tor-list' });
  let closed = false;
  // Subtitle language fetched automatically when the download completes.
  const subSelect = h('select', { class: 'sub-select', id: 'tor-sub' });
  const subRow = h('div', { class: 'tor-subs', hidden: true },
    h('label', { for: 'tor-sub' }, 'Subtitles'), subSelect,
    h('span', { class: 'muted tor-subs-note' }));
  subSelect.addEventListener('change', () => { try { localStorage.setItem('subs:dlLang', subSelect.value); } catch { /* blocked */ } });

  async function loadSubLangs(q) {
    if (!state.status.subtitles) return;
    const note = subRow.querySelector('.tor-subs-note');
    subRow.hidden = false;
    subSelect.replaceChildren(h('option', { value: '' }, 'None'));
    subSelect.disabled = true;
    note.textContent = 'Checking OpenSubtitles…';
    try {
      const data = await api(`/api/subs/langs?q=${encodeURIComponent(q)}&type=${type}`);
      subSelect.append(...data.languages.map((l) => h('option', { value: l.code }, l.name)));
      let pref = '';
      try { pref = localStorage.getItem('subs:dlLang') || ''; } catch { /* blocked */ }
      pref ||= prefs().subLang || ''; // Settings → subtitles
      if (data.languages.some((l) => l.code === pref)) subSelect.value = pref;
      note.textContent = data.languages.length ? '' : 'None found for this title';
    } catch (err) {
      note.textContent = err.message;
    } finally {
      subSelect.disabled = false;
    }
  }

  $('#picker-body').replaceChildren(...[
    h('h2', { id: 'picker-title' }, 'Find a download'),
    label && h('p', { class: 'muted picker-sub' }, label),
    form, subRow, chips, info, seasonBox, list].filter(Boolean));
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { closed = true; ctrl?.abort(); opener?.focus({ preventScroll: true }); }));

  form.addEventListener('submit', (e) => { e.preventDefault(); input.blur(); run(); });

  async function run() {
    const q = input.value.trim();
    ctrl?.abort();
    if (/^magnet:\?/i.test(q)) return addPastedMagnet(q);
    seasonBox.replaceChildren();
    if (q.length < 2) { results = []; list.replaceChildren(); info.textContent = 'Type a title to search 1337x and The Pirate Bay.'; return; }
    ctrl = new AbortController();
    const { signal } = ctrl;
    info.textContent = 'Searching 1337x and The Pirate Bay…';
    list.replaceChildren(...Array.from({ length: 5 }, () => h('li', { class: 'row tor skeleton-row', 'aria-hidden': 'true' })));
    try {
      const data = await api(`/api/torrents/search?q=${encodeURIComponent(q)}&type=${type}`, { signal });
      results = data.results;
      renderList(data.problems);
      renderSeasonBox(q);
      loadSubLangs(q);
    } catch (err) {
      if (err.name === 'AbortError') return;
      results = [];
      info.textContent = '';
      list.replaceChildren(h('li', {}, notice('Search didn’t work', err.message, run)));
    }
  }

  async function addPastedMagnet(link) {
    list.replaceChildren();
    if (!state.status.downloads) { info.textContent = 'Downloads aren’t connected, so there’s nowhere to send it. Set up qBittorrent in .env.'; return; }
    info.textContent = 'Sending to qBittorrent…';
    try {
      await sendToQbit(link);
      info.textContent = 'Added. It’s in the Downloads tab.';
      input.value = '';
    } catch (err) {
      info.textContent = err.message;
    }
  }

  function renderList(problems = []) {
    const shown = results.filter((t) => filter === 'all' || t.quality === filter);
    const bits = [];
    if (results.length) {
      bits.push(shown.length === results.length
        ? `${results.length} result${results.length === 1 ? '' : 's'}, most seeded first.`
        : `${shown.length} of ${results.length} results.`);
    }
    if (problems.length) bits.push(`Skipped ${problems.join(' ')}`);
    info.textContent = bits.join(' ');
    if (!shown.length) {
      list.replaceChildren(h('li', {}, results.length
        ? notice('Nothing in that quality', 'Try another filter.')
        : notice('No torrents found', 'Try fewer words, or the original title. For series, add the season, like “S02”.')));
      return;
    }
    list.replaceChildren(...shown.map(torrentRow));
  }

  // A season search ("South Park S18"): offer to get the whole season one episode at a time. It's
  // the main suggestion when no complete-season torrent has enough seeders, a quiet extra otherwise.
  function renderSeasonBox(q) {
    seasonBox.replaceChildren();
    const want = parseSeasonQuery(q);
    if (!want || type === 'movie' || !canDownload()) return;
    const packRe = new RegExp(`\\bS0?${want.season}\\b(?!\\s?E\\d)|\\bseason\\s?0?${want.season}\\b`, 'i');
    const goodPack = results.some((r) => !r.cam && r.seeders >= 10 && norm(r.name).includes(norm(want.title))
      && packRe.test(r.name.replace(/[._]+/g, ' ')) && !/\bS\d{1,2}\s?E\d{1,3}\b/i.test(r.name.replace(/[._]+/g, ' ')));
    const status = h('div', { class: 'row-meta season-dl-status', role: 'status' });
    const btn = h('button', { class: goodPack ? 'chip season-dl-btn' : 'play-btn season-dl-btn', onclick: go },
      icon('download'), 'Get all episodes');
    seasonBox.append(h('div', { class: `row season-dl${goodPack ? '' : ' is-main'}` },
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, goodPack ? `Or get season ${want.season} episode by episode` : `No complete season ${want.season} with enough seeders`),
        h('div', { class: 'row-meta' }, h('span', {}, 'Marquee finds the best torrent for each episode and downloads them all.')),
        status),
      h('div', { class: 'row-actions' }, btn)));

    function go() {
      const sub = subRow.hidden ? '' : subSelect.value;
      return getSeason(q, {
        quality: ['2160p', '1080p', '720p'].includes(filter) ? filter : '',
        subs: sub ? [sub] : [], btn, status, label: 'Get all episodes', isOpen: () => !closed,
      });
    }
  }

  function torrentRow(t) {
    const health = t.seeders >= 50 ? 'good' : t.seeders >= 5 ? 'ok' : 'poor';
    const status = h('span', { class: 'device-status' });
    const meta = [
      h('span', { class: `seeds seeds-${health}` }, `${t.seeders.toLocaleString()} seeding`),
      t.size && fmtBytes(t.size),
      t.quality && t.quality !== 'SD' && (t.quality === '2160p' ? '4K' : t.quality),
      ...t.tags,
      t.cam && h('span', { class: 'tor-warn' }, 'Cinema recording'),
      SOURCE_NAMES[t.source],
      fmtAgo(t.added) || t.addedText,
    ].filter(Boolean).map((m) => (m instanceof Node ? m : h('span', {}, m)));

    const copyBtn = h('button', { class: 'cast-btn', title: 'Copy magnet link', 'aria-label': `Copy magnet link for ${t.name}`, onclick: copy }, icon('copy'));
    const getBtn = canDownload() && h('button', { class: 'play-btn', 'aria-label': `Download ${t.name}`, onclick: get }, icon('download'), 'Get');
    if (getBtn && added.has(t.id)) markAdded();

    async function copy() {
      copyBtn.disabled = true;
      try {
        const ok = await copyText(await magnetOf(t));
        toast(ok ? 'Magnet link copied' : 'Couldn’t copy on this device');
      } catch (err) {
        toast(err.message);
      } finally {
        copyBtn.disabled = false;
      }
    }
    async function get() {
      getBtn.disabled = true;
      getBtn.replaceChildren('Adding…');
      status.className = 'device-status';
      status.textContent = '';
      try {
        const sub = subRow.hidden ? '' : subSelect.value;
        // Only carry the selected film while searching its original title; free searches can be anything.
        await sendToQbit(await magnetOf(t), { name: t.name, ...(sub ? { subs: [sub] } : {}),
          ...(movieId && input.value.trim() === query.trim() ? { movieId } : {}) });
        added.add(t.id);
        markAdded();
        const subName = sub && subSelect.selectedOptions[0]?.textContent;
        toast(subName ? `Added. ${subName} subtitles come when it finishes.` : 'Added to Downloads');
      } catch (err) {
        getBtn.disabled = false;
        getBtn.replaceChildren(icon('download'), 'Get');
        status.className = 'device-status is-error';
        status.textContent = err.message;
      }
    }
    function markAdded() {
      getBtn.disabled = true;
      getBtn.classList.add('is-added');
      getBtn.replaceChildren(icon('check'), 'Added');
    }

    return h('li', { class: 'row tor' },
      h('div', { class: 'row-text' },
        h('div', { class: 'tor-name', title: t.name }, t.name),
        h('div', { class: 'row-meta' }, meta),
        status),
      h('div', { class: 'row-actions' }, copyBtn, getBtn));
  }

  if (query) run(); else { info.textContent = 'Type a title to search 1337x and The Pirate Bay.'; input.focus(); }
}

// ---------- casting: remote control ----------
async function loadSessions() {
  try { state.sessions = (await api('/api/cast/sessions')).sessions.filter((s) => s.mine !== false); } catch { /* keep last known */ }
  renderNowbar();
}

function renderNowbar() {
  const bar = $('#nowbar');
  const s = state.sessions[0];
  bar.hidden = !s || !$('#remote').hidden;
  document.body.classList.toggle('has-nowbar', !bar.hidden);
  if (!s) return;
  const more = state.sessions.length > 1 ? ` (+${state.sessions.length - 1} more)` : '';
  bar.replaceChildren(
    h('span', { class: 'nowbar-icon' }, icon('tv')),
    h('span', { class: 'nowbar-text' }, h('strong', {}, s.title), h('span', {}, `on ${s.deviceName}${more}`)),
    h('span', { class: 'nowbar-open' }, 'Remote'));
  bar.onclick = () => openRemote(s);
}

const STATE_TEXT = { playing: 'Playing', paused: 'Paused', loading: 'Loading on the TV…', stopped: 'Stopped', unknown: '' };

function openRemote(session, { replace = false } = {}) {
  const id = session.deviceId;
  const r = {};
  let st = { state: 'loading', position: null, duration: null, volume: null };
  let dragging = false;
  let lastAction = 0;

  $('#remote-body').replaceChildren(
    h('div', { class: 'remote-top' },
      h('button', { class: 'icon-btn', id: 'remote-close', 'aria-label': 'Close remote', onclick: closeTopOverlay }, icon('back')),
      h('p', { class: 'remote-where' }, icon('tv'), h('span', {}, session.deviceName))),
    h('div', { class: 'remote-main' },
      h('h2', { id: 'remote-title' }, session.title),
      session.subtitle && h('p', { class: 'remote-sub' }, session.subtitle),
      r.state = h('p', { class: 'remote-state', role: 'status' }, 'Connecting…'),
      h('div', { class: 'scrub' },
        r.seek = h('input', { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Position', disabled: true }),
        h('div', { class: 'scrub-times' }, r.pos = h('span', {}, '0:00'), r.dur = h('span', {}, '–:––'))),
      h('div', { class: 'transport' },
        h('button', { class: 'skip-btn', 'aria-label': 'Back 10 seconds', onclick: () => jump(-10) }, '−10s'),
        r.toggle = h('button', { class: 'toggle-btn', onclick: toggle }),
        h('button', { class: 'skip-btn', 'aria-label': 'Forward 30 seconds', onclick: () => jump(30) }, '+30s')),
      r.volWrap = h('label', { class: 'volume', hidden: true }, icon('volume'),
        r.vol = h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'TV volume' })),
      r.subs = h('div', { class: 'remote-subs', hidden: true }),
      h('button', { class: 'stop-btn', onclick: stop }, 'Stop playing on the TV')));

  r.sync = h('div', { class: 'remote-sync' });
  r.seek.addEventListener('pointerdown', () => { dragging = true; });
  r.seek.addEventListener('input', () => { dragging = true; r.pos.textContent = fmtTime(Number(r.seek.value)); });
  r.seek.addEventListener('change', () => {
    dragging = false;
    st.position = Number(r.seek.value);
    send('seek', st.position);
  });
  r.vol.addEventListener('change', () => send('volume', Number(r.vol.value)));

  function render() {
    r.state.textContent = STATE_TEXT[st.state] ?? '';
    const playing = st.state === 'playing' || st.state === 'loading';
    r.toggle.replaceChildren(icon(playing ? 'pause' : 'play'));
    r.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (st.duration) {
      r.seek.disabled = false;
      r.seek.max = String(Math.floor(st.duration));
      r.dur.textContent = fmtTime(st.duration);
    }
    if (!dragging && st.position != null) {
      r.seek.value = String(Math.floor(st.position));
      r.pos.textContent = fmtTime(st.position);
    }
    r.volWrap.hidden = st.volume == null;
    if (st.volume != null && document.activeElement !== r.vol) r.vol.value = String(st.volume);
  }

  async function poll() {
    if (document.hidden || Date.now() - lastAction < 1200) return; // give the TV time to apply a command
    try {
      const s = await api(`/api/cast/${id}/status`);
      st = { ...st, ...s };
      render();
    } catch (err) {
      r.state.textContent = err.message;
    }
  }

  async function send(action, value) {
    lastAction = Date.now();
    render();
    try {
      await api(`/api/cast/${id}/control`, jsonPost({ action, value }));
    } catch (err) {
      toast(err.message);
    }
  }

  function toggle() {
    const pause = st.state === 'playing' || st.state === 'loading';
    st.state = pause ? 'paused' : 'playing';
    send(pause ? 'pause' : 'play');
  }

  function jump(delta) {
    if (st.position == null) return;
    st.position = Math.max(0, Math.min(st.duration || Infinity, st.position + delta));
    send('seek', st.position);
  }

  async function stop() {
    await send('stop');
    state.sessions = state.sessions.filter((s) => s.deviceId !== id);
    closeTopOverlay();
  }

  // Changing subtitles restarts playback on the TV at the current position.
  async function loadSubs() {
    const ref = session.media;
    if (!ref) return;
    if (session.kind === 'airplay') {
      if (!state.status.subtitles) return;
      r.subs.hidden = false;
      r.subs.replaceChildren(h('h3', {}, 'Subtitles'),
        h('p', { class: 'muted' }, 'Apple TV can’t show separate subtitle files over AirPlay. Play it on the phone for subtitles, or use a smart TV.'));
      return;
    }
    let data;
    try { data = await api(`/api/subs/langs?kind=${ref.kind}&id=${encodeURIComponent(ref.id)}`); } catch { return; }
    if (!data.languages.length && !data.configured) return;
    r.subs.hidden = false;
    const note = h('p', { class: 'muted remote-subs-note', role: 'status' }, data.languages.length ? '' : data.problem || 'No subtitles found for this.');
    const options = [{ code: null, name: 'Off' }, ...data.languages];
    const chips = h('div', { class: 'tor-filters' }, options.map((l) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String((session.sub || null) === l.code),
      onclick: () => pickSub(l, chips, note, options),
    }, l.name)));
    r.subs.replaceChildren(...[h('h3', {}, 'Subtitles'), data.languages.length ? chips : null, note, r.sync].filter(Boolean));
    subUi = { chips, note, options };
    renderOffset();
  }

  async function pickSub(l, chips, note, options, { reload = false } = {}) {
    if (!reload && (session.sub || null) === l.code) return;
    chips.querySelectorAll('.chip').forEach((c) => { c.disabled = true; });
    note.textContent = reload ? 'Sending the new subtitle timing to the TV…'
      : l.code ? `Getting ${l.name} subtitles and restarting on the TV…` : 'Restarting on the TV without subtitles…';
    lastAction = Date.now() + 8000; // pause status polling while the TV reloads
    try {
      const { session: next } = await api(`/api/cast/${id}/subtitles`, jsonPost({ lang: l.code }));
      session.sub = next.sub;
      state.sessions = [next, ...state.sessions.filter((s) => s.deviceId !== next.deviceId)];
      chips.querySelectorAll('.chip').forEach((c, i) => c.setAttribute('aria-pressed', String((options[i].code || null) === (session.sub || null))));
      note.textContent = reload ? 'The TV has the new subtitle timing.'
        : l.code ? `${l.name} subtitles on. If they don’t appear, this TV may not support subtitle files over the network.` : '';
    } catch (err) {
      note.textContent = err.message;
    } finally {
      chips.querySelectorAll('.chip').forEach((c) => { c.disabled = false; });
      if (!reload) renderOffset();
    }
  }

  // Subtitle offset. The TV keeps the subtitle file it was given, so after the last tap the new
  // timing is sent over by restarting at the same spot (the same way switching language works).
  let subUi = null;
  let offsetChain = Promise.resolve();
  let applyTimer = null;
  async function renderOffset() {
    const lang = session.sub;
    if (!lang || session.kind === 'airplay') { r.sync.replaceChildren(); return; }
    let s;
    try { s = await api(`/api/subs/sync?kind=${session.media.kind}&id=${encodeURIComponent(session.media.id)}&lang=${lang}`); } catch { r.sync.replaceChildren(); return; }
    if (session.sub !== lang) return;
    drawOffset(s, lang);
  }
  function drawOffset(s, lang, pending = false) {
    r.sync.replaceChildren(...[
      subSyncBusy(s) ? h('p', { class: 'muted remote-subs-note' }, 'Checking the timing…')
        : nudgeRow(s.manual || 0, (n) => nudgeOnTv(lang, n)),
      pending && h('p', { class: 'muted remote-subs-note' }, 'Updating the TV in a moment…'),
    ].filter(Boolean));
  }
  function nudgeOnTv(lang, seconds) {
    clearTimeout(applyTimer);
    offsetChain = offsetChain.then(async () => {
      try {
        const s = await api('/api/subs/sync', jsonPost({ kind: session.media.kind, id: session.media.id, lang, action: 'shift', seconds }));
        if (session.sub !== lang) return;
        drawOffset(s, lang, true);
        clearTimeout(applyTimer);
        applyTimer = setTimeout(() => {
          const l = subUi?.options.find((o) => o.code === lang);
          if (l && session.sub === lang) pickSub(l, subUi.chips, subUi.note, subUi.options, { reload: true }).then(() => drawOffset(s, lang));
        }, 1500);
      } catch (err) { toast(err.message); }
    });
  }
  render();
  loadSubs();
  $('#remote').hidden = false;
  document.body.style.overflow = 'hidden';
  renderNowbar();
  $('#remote-close').focus({ preventScroll: true });
  poll();
  const timer = setInterval(poll, 1500);

  const close = () => {
    clearInterval(timer);
    $('#remote').hidden = true;
    document.body.style.overflow = '';
    renderNowbar();
    loadSessions();
  };
  if (replace) swapTopOverlay(close); else pushOverlay(close);
}

// ---------- player ----------
const video = $('#video');
let current = null;
let lastSave = 0;
let party = null;
let watchPanelOpen = false;
const watchClient = globalThis.crypto?.randomUUID?.() || `${CLIENT_ID}-${Math.random().toString(36).slice(2, 10)}`;

function renderParty() {
  const bar = $('#watch-bar');
  bar.hidden = !party || !watchPanelOpen;
  const roomButton = $('#watch-btn');
  roomButton.hidden = !party && (current?.kind !== 'lib' || !state.library.some((f) => f.id === mediaId(current)));
  roomButton.textContent = party ? 'Room' : 'Watch together';
  roomButton.setAttribute('aria-expanded', String(Boolean(party && watchPanelOpen)));
  roomButton.setAttribute('aria-label', party ? 'Watch Together room controls' : 'Start Watch Together');
  playerEl.classList.toggle('in-party', Boolean(party));
  if (!party) return;
  updatePlayState();
  const room = party.state;
  const hostMember = room.members.find((m) => m.id === room.host);
  const host = hostMember ? personName(hostMember) : 'Host';
  const status = !party.connected || !party.online ? 'Reconnecting — playback paused'
    : party.blocked ? 'Press Play to join playback'
      : room.waitingFor.length ? `Waiting for ${room.waitingFor.join(', ')}`
        : room.playing ? `Watching together · ${room.members.length} viewers` : party.isHost ? 'You’re hosting — press Play when everyone is ready' : `Paused · ${host} controls playback`;
  if ($('#watch-status').textContent !== status) $('#watch-status').textContent = status;
  const members = room.members.map((m) => `${personName(m)}${m.id === room.host ? ' (host)' : ''}${!m.ready || m.buffering || m.blocked ? ' · getting ready' : ''}`).join(' / ');
  if ($('#watch-members').textContent !== members) $('#watch-members').textContent = members;
  $('#watch-members').title = members;
  $('#watch-ready').hidden = !party.blocked;
  playerEl.classList.toggle('party-guest', !party.isHost);
  airplayBtn.hidden = true;
  syncBtn.hidden = true;
  seekEl.setAttribute('aria-disabled', String(!party.isHost));
  seekEl.tabIndex = party.isHost ? 0 : -1;
  for (const b of playBtns) {
    b.disabled = !party.isHost && !party.blocked;
    b.title = party.blocked ? 'Join playback' : party.isHost ? '' : 'The host controls playback';
  }
  for (const b of playerEl.querySelectorAll('.pc-skip')) { b.disabled = !party.isHost; b.title = party.isHost ? '' : 'The host controls seeking'; }
}

function leaveWatchRoom(notify = true) {
  const old = party;
  if (!old) return;
  party = null;
  watchPanelOpen = false;
  old.close({ notify });
  offsetCues(video.querySelector('track')?.track, 0);
  video.disableRemotePlayback = false;
  video.preload = 'metadata';
  playerEl.classList.remove('party-guest');
  seekEl.removeAttribute('aria-disabled');
  seekEl.tabIndex = 0;
  for (const b of [...playBtns, ...playerEl.querySelectorAll('.pc-skip')]) { b.disabled = false; b.title = ''; }
  const url = new URL(location.href); url.searchParams.delete('watch'); history.replaceState(null, '', url.pathname + url.search + url.hash);
  renderParty();
  if (current) { watchCastTargets(); renderCcMenu(current, current); }
}

function attachWatchRoom(room) {
  if (party) leaveWatchRoom();
  const alreadyPlaying = !video.paused && video.readyState >= 3;
  video.pause();
  video.preload = 'auto';
  video.disableRemotePlayback = true;
  resetCasting();
  party = new WatchSession({ video, room, clientId: watchClient, request: api, onState: renderParty,
    onEnd: (message) => { leaveWatchRoom(false); video.pause(); toast(message); }, onError: toast });
  if (alreadyPlaying) party.blocked = false;
  watchPanelOpen = false;
  renderParty();
  return party;
}

async function hostWatchRoom() {
  if (!current || current.kind !== 'lib' || party) return;
  if (onTvVersion || video.remote?.state === 'connected') { toast('Watch Together uses the browser player. Stop casting first.'); return; }
  const btn = $('#watch-btn'); btn.disabled = true;
  const media = current;
  try {
    const room = await api('/api/watch', jsonPost({ id: mediaId(current), clientId: watchClient, position: video.currentTime || 0 }));
    if (current !== media) { api(`/api/watch/${room.token}/leave`, jsonPost({ clientId: watchClient })).catch(() => {}); return; }
    const session = attachWatchRoom(room);
    await session.start();
    showPlayerUi();
    toast('Room ready. Copy the invite to your family.');
  } catch (err) { leaveWatchRoom(); toast(err.message); }
  finally { btn.disabled = false; }
}

async function offerWatchRoom(token) {
  if (party?.state.token === token) { toast('You’re already in this room'); return; }
  if (!/^[A-Za-z0-9_-]{24}$/.test(token)) { toast('Invalid watch-room link'); return; }
  try {
    const preview = await api(`/api/watch/${token}/preview`, { signal: AbortSignal.timeout(10000) });
    let closed = false;
    const status = h('p', { class: 'muted', role: 'status' });
    const join = h('button', { class: 'play-btn', onclick: async () => {
      if (join.disabled) return;
      join.disabled = true;
      join.textContent = 'Joining…';
      join.setAttribute('aria-busy', 'true');
      let joined = false;
      try {
        const room = await api(`/api/watch/${token}/join`, { ...jsonPost({ clientId: watchClient }), signal: AbortSignal.timeout(10000) });
        joined = true;
        if (closed) { api(`/api/watch/${token}/leave`, jsonPost({ clientId: watchClient })).catch(() => {}); return; }
        if (current) {
          await dismissTopOverlay(); // Invite first, then the existing player.
          if (current) await dismissTopOverlay();
          await openPlayer({ ...room.media, key: room.media.id, done: true }, { watchRoom: room });
        } else {
          // Replace the invite in-place: no pending history.back() can close the new player.
          await openPlayer({ ...room.media, key: room.media.id, done: true }, { watchRoom: room, replace: true });
        }
      } catch (err) {
        status.textContent = err.name === 'TimeoutError' ? 'Joining took too long. Please try again.' : err.message;
        if (joined && party?.state.token !== token) api(`/api/watch/${token}/leave`, jsonPost({ clientId: watchClient })).catch(() => {});
      } finally { join.disabled = false; join.textContent = 'Join and watch'; join.removeAttribute('aria-busy'); }
    } }, 'Join and watch');
    $('#picker-body').replaceChildren(h('h2', { id: 'picker-title' }, 'Watch together'),
      h('p', { class: 'del-name' }, [preview.media.title, episodeLabel(preview.media)].filter(Boolean).join(' · ')),
      h('p', { class: 'muted' }, `${preview.host} is hosting. Playback stays together; you choose your own subtitles and volume.`), join, status);
    pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { closed = true; }));
  } catch (err) { toast(err.message); }
}

function setWatchPanel(open) { watchPanelOpen = Boolean(open && party); renderParty(); showPlayerUi(); }
$('#watch-btn').addEventListener('click', () => { if (party) setWatchPanel(!watchPanelOpen); else hostWatchRoom(); });
$('#watch-hide').addEventListener('click', () => { setWatchPanel(false); $('#watch-btn').focus(); });
document.addEventListener('click', (event) => { if (watchPanelOpen && !event.target.closest?.('#watch-bar, #watch-btn')) setWatchPanel(false); });
$('#watch-ready').addEventListener('click', () => party?.unlock());
$('#watch-copy').addEventListener('click', () => {
  // /c/w/ shows a preview in Discord and other chats, then forwards to /?watch=
  if (party) copyWithToast(`${location.origin}/c/w/${party.state.token}`, 'Watch-room invite copied. Everyone uses their usual Marquee sign-in.');
});
$('#watch-leave').addEventListener('click', () => { leaveWatchRoom(); video.pause(); toast('Left the watch room'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && party) { party.clock().then(() => party?.pulse()).catch(() => {}); } });

function saveProgress(force = false) {
  if (!current || !video.duration || !isFinite(video.duration)) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  const done = video.duration - video.currentTime < 90; // treat as finished
  try {
    if (done) localStorage.removeItem(resumeKey(current));
    else localStorage.setItem(resumeKey(current), JSON.stringify({ time: video.currentTime, duration: video.duration }));
  } catch { /* storage full or blocked */ }
  // The server copy (other devices) is updated less often, and always on pause and close.
  if (!force && now - lastPush < 15000) return;
  lastPush = now;
  const ref = progressRef(current);
  if (done) delete state.progress[ref];
  else state.progress[ref] = { time: video.currentTime, duration: video.duration, at: now };
  api('/api/me/progress', { ...jsonPost({ ref, time: done ? null : video.currentTime, duration: video.duration }), keepalive: true }).catch(() => {});
}
let lastPush = 0;

const mediaId = (f) => (f.kind === 'lib' ? f.id || f.key : f.hash || f.key);

// ---- subtitles ----
// ---------- AirPlay / Chromecast from the browser ----------
// Safari hands the video URL to the Apple TV, which then streams straight from the server
// (full quality; the phone just acts as a remote). Signed /play/ links make that possible
// through Cloudflare Access. Chrome on Android does the same with Chromecast.
const airplayBtn = $('#airplay-btn');
const hasAirPlay = 'WebKitPlaybackTargetAvailabilityEvent' in window;
const hasRemotePlayback = !hasAirPlay && 'remote' in HTMLMediaElement.prototype;
const canCastFromBrowser = hasAirPlay || hasRemotePlayback;
let remoteWatchId = null;
let onTvVersion = false;   // AirPlay is playing the TV version (original audio)
let swappingSource = false;

airplayBtn.setAttribute('aria-label', hasAirPlay ? 'AirPlay' : 'Cast to a TV');
airplayBtn.addEventListener('click', () => {
  airplayBtn.classList.remove('is-hint');
  if (hasAirPlay) video.webkitShowPlaybackTargetPicker();
  else if (hasRemotePlayback) video.remote.prompt().catch(() => { /* dismissed */ });
});
if (hasAirPlay) {
  video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
    airplayBtn.hidden = Boolean(party) || e.availability !== 'available';
  });
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => onWireless(video.webkitCurrentPlaybackTargetIsWireless));
}
if (hasRemotePlayback) {
  video.remote.addEventListener('connect', () => onWireless(true));
  video.remote.addEventListener('disconnect', () => onWireless(false));
}

function watchCastTargets() {
  if (!hasRemotePlayback) return; // Safari reports availability through the event above
  video.remote.watchAvailability((available) => { airplayBtn.hidden = Boolean(party) || !available; })
    .then((id) => { remoteWatchId = id; })
    .catch(() => { airplayBtn.hidden = true; });
}

function resetCasting() {
  airplayBtn.hidden = true;
  airplayBtn.classList.remove('is-hint');
  if (hasRemotePlayback && remoteWatchId != null) video.remote.cancelWatchAvailability(remoteWatchId).catch(() => {});
  remoteWatchId = null;
  onTvVersion = false;
}

// Keeps the position and play state while changing the video's source.
function swapSource(url) {
  const at = video.currentTime;
  const wasPlaying = !video.paused;
  swappingSource = true;
  video.addEventListener('loadedmetadata', () => {
    swappingSource = false;
    if (!party && at > 1) video.currentTime = at;
    if (wasPlaying) video.play().catch(() => {});
  }, { once: true });
  video.src = url;
}

async function onWireless(on) {
  if (on && party) { leaveWatchRoom(); toast('Left Watch Together: casting is not synchronized.'); }
  const session = current;
  if (!session) return;
  const note = $('#player-note');
  if (on) {
    note.textContent = 'Playing on your TV. The controls here work as a remote.';
    note.hidden = false;
  } else if (note.textContent.startsWith('Playing on your TV')) {
    note.hidden = true;
  }
  // With AirPlay, switch to the TV version so the TV gets the original surround audio.
  // (Chromecast keeps the current version: changing the source would end the cast.)
  if (!hasAirPlay || on === onTvVersion) return;
  try {
    const link = await api(`/api/play-link?kind=${session.kind}&id=${encodeURIComponent(mediaId(session))}&variant=${on ? 'tv' : 'browser'}`);
    if (current !== session) return;
    const tvCanPlay = ['mp4', 'm4v', 'mov'].includes(link.ext);
    if (on && (!tvCanPlay || link.name === session.browserName)) return; // nothing better to send
    swapSource(link.url);
    onTvVersion = on;
  } catch { /* keep playing the current version */ }
}

const ccBtn = $('#cc-btn');
const ccMenu = $('#cc-menu');
let ccLangs = [];
let ccActive = null;

// Subtitles are drawn by the page (#player-subs) rather than the browser, so they stay inside the
// picture and move up out of the way while the controls are showing. The track runs in 'hidden'
// mode for that: its cues load and change, but the browser draws nothing. Where the page can't
// draw (iOS's own fullscreen player, picture-in-picture) the browser draws them instead.
const subsEl = $('#player-subs');
let nativeSubs = false;
let subTrack = null;

function applySubModes() {
  subTrack = null;
  for (const t of video.textTracks) {
    if (t.kind !== 'subtitles') continue;
    const on = Boolean(ccActive) && t.language === ccActive;
    if (party && on) offsetCues(t, party.offsets[t.language] || 0);
    t.mode = on ? (nativeSubs ? 'showing' : 'hidden') : 'disabled';
    if (on && !nativeSubs) subTrack = t;
  }
  if (subTrack) subTrack.oncuechange = renderCues;
  renderCues();
}

// Cues placed at the top of the picture ({\an8} in the SRT, `line:0` in the VTT) stay at the top.
const cueAtTop = (c) => typeof c.line === 'number' && (c.snapToLines ? c.line >= 0 : c.line < 50);

function renderCues() {
  const [top, bottom] = subsEl.children;
  const cues = subTrack?.activeCues ? [...subTrack.activeCues] : [];
  const draw = (list) => list.map((c) => {
    const text = h('span');
    if (typeof c.getCueAsHTML === 'function') text.append(c.getCueAsHTML()); // <i>, <b> and friends; never parsed as page HTML
    else text.textContent = c.text;
    return h('div', { class: 'sub-cue' }, text);
  });
  top.replaceChildren(...draw(cues.filter(cueAtTop)));
  bottom.replaceChildren(...draw(cues.filter((c) => !cueAtTop(c))));
}

// iOS's own fullscreen player picks captions itself and often lands on "Auto", which hides
// subtitles in your own language. Re-select ours when it opens, and mirror any change the
// viewer makes there back to the CC button when it closes.
video.addEventListener('webkitbeginfullscreen', () => {
  nativeSubs = true;
  applySubModes();
  setTimeout(applySubModes, 500); // again, after the native player has applied its own choice
});
video.addEventListener('webkitendfullscreen', () => {
  const showing = [...video.textTracks].find((t) => t.kind === 'subtitles' && t.mode === 'showing');
  ccActive = showing ? showing.language : null;
  nativeSubs = false;
  applySubModes();
  ccBtn.classList.toggle('is-on', Boolean(ccActive));
  ccMenu.querySelectorAll('.cc-item[role="menuitemradio"]').forEach((b, i) => {
    b.setAttribute('aria-checked', String(i === 0 ? !ccActive : ccLangs[i - 1]?.code === ccActive));
  });
});
video.addEventListener('enterpictureinpicture', () => { nativeSubs = true; applySubModes(); });
video.addEventListener('leavepictureinpicture', () => { nativeSubs = false; applySubModes(); });

function clearSubTracks() {
  video.querySelectorAll('track').forEach((t) => t.remove());
  ccActive = null;
  ccSync = null;
  clearTimeout(ccSyncTimer);
  applySubModes();
}
function closeCcMenu() { ccMenu.hidden = true; ccBtn.setAttribute('aria-expanded', 'false'); }
ccBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = ccMenu.hidden;
  closeSyncMenu();
  ccMenu.hidden = !open;
  ccBtn.setAttribute('aria-expanded', String(open));
  if (open) (ccMenu.querySelector('[aria-checked="true"]') || ccMenu.querySelector('button'))?.focus();
});
document.addEventListener('click', (e) => { if (!ccMenu.hidden && !ccMenu.contains(e.target)) closeCcMenu(); });

function renderCcMenu(f, session, message) {
  const items = [{ code: null, name: 'Off' }, ...ccLangs];
  ccMenu.replaceChildren(
    ...items.map((l) => h('button', {
      role: 'menuitemradio', class: 'cc-item', 'aria-checked': String(ccActive === l.code),
      onclick: () => pickPlayerSub(f, session, l),
    }, l.name)),
    ...(message ? [h('p', { class: 'cc-message' }, message)] : []),
    ...(ccActive ? [h('div', { class: 'cc-divider', role: 'separator' }), subSizeRow()] : []),
    ...subSyncItems(f, session));
  ccBtn.classList.toggle('is-on', Boolean(ccActive));
}

// ---- subtitle timing ----
// The server lines downloaded subtitles up with the film in the background. While that runs the
// menu says so, and when the file changes the track is reloaded in place.
let ccSync = null;
let ccSyncTimer = null;
const SUB_SYNC_TEXT = {
  queued: 'Checking the timing…',
  syncing: 'Checking the timing…',
  ok: 'Timing checked: already in sync.',
  unsure: 'Couldn’t check the timing automatically.',
  exact: 'Made for this exact file.',
  undone: 'Using the original timing.',
};
const subSyncBusy = (s) => s?.state === 'queued' || s?.state === 'syncing';
const fmtSubShift = (s) => `${Math.round(Math.abs(s) * 100) / 100} s ${s < 0 ? 'earlier' : 'later'}`;

function subSyncText(s) {
  if (s.state === 'failed') return `Timing check failed: ${s.error || 'unknown error'}`;
  if (s.state !== 'synced') return SUB_SYNC_TEXT[s.state];
  return s.offset != null
    ? `Timing fixed: lines moved ${fmtSubShift(s.offset)}${s.ratio && s.ratio !== 1 ? ', adjusted for frame rate' : ''}.`
    : null;
}

// Manual offset: − shows lines earlier (they come after the speech), + later (they come too soon).
const NUDGES = [-1, -0.25, 0.25, 1];
function nudgeRow(manual, onNudge) {
  return h('div', { class: 'cc-nudge' },
    h('span', { class: 'cc-nudge-label' }, 'Subtitle offset',
      h('b', {}, manual ? ` ${manual > 0 ? '+' : '−'}${Math.round(Math.abs(manual) * 100) / 100} s` : ' 0 s')),
    h('div', { class: 'cc-nudge-buttons' }, NUDGES.map((n) => h('button', {
      type: 'button', 'aria-label': `Show subtitles ${Math.abs(n)} seconds ${n < 0 ? 'earlier' : 'later'}`, onclick: () => onNudge(n),
    }, `${n < 0 ? '−' : '+'}${Math.abs(n) === 0.25 ? '¼' : Math.abs(n)} s`))),
    h('span', { class: 'cc-nudge-hint' }, '− earlier · + later'),
    manual ? h('button', { type: 'button', class: 'cc-nudge-reset', onclick: () => onNudge(-manual) }, 'Reset offset') : null);
}

function subSyncItems(f, session) {
  if (party && ccActive) return [
    h('div', { class: 'cc-divider', role: 'separator' }),
    h('p', { class: 'cc-message' }, 'Only your subtitles change. Other viewers keep their own settings.'),
    nudgeRow(party.offsets[ccActive] || 0, (seconds) => {
      party.offsets[ccActive] = Math.round(((party.offsets[ccActive] || 0) + seconds) * 1000) / 1000;
      applySubModes(); renderCcMenu(f, session);
    }),
  ];
  const s = ccSync;
  if (!ccActive || !s) return [];
  const text = s.state === 'trusted' ? null : subSyncText(s);
  const lang = ccLangs.find((l) => l.code === ccActive);
  const action = (label, act) => h('button', { class: 'cc-item cc-action', onclick: () => subSyncAction(f, session, lang, act) }, label);
  return [
    h('div', { class: 'cc-divider', role: 'separator' }),
    text && h('p', { class: 'cc-message' }, text),
    !subSyncBusy(s) && nudgeRow(s.manual || 0, (n) => subSyncNudge(f, session, lang, n)),
    s.canUndo && s.offset != null && action('Undo timing fix', 'undo'),
    s.canSync && action(['synced', 'ok', 'unsure'].includes(s.state) ? 'Check timing again' : 'Fix timing', 'sync'),
  ].filter(Boolean);
}

// Taps are applied one after another, so quick repeated taps all count.
let nudgeChain = Promise.resolve();
function subSyncNudge(f, session, l, seconds) {
  nudgeChain = nudgeChain.then(async () => {
    try {
      ccSync = await api('/api/subs/sync', jsonPost({ kind: f.kind, id: mediaId(f), lang: l.code, action: 'shift', seconds }));
      if (current !== session) return;
      reloadSubTrack(l);
      renderCcMenu(f, session);
    } catch (err) { toast(err.message); }
  });
}

async function subSyncAction(f, session, l, act) {
  try {
    ccSync = await api('/api/subs/sync', jsonPost({ kind: f.kind, id: mediaId(f), lang: l.code, action: act }));
    if (current !== session) return;
    if (act === 'undo') { reloadSubTrack(l); toast('Back to the original subtitle timing'); }
    renderCcMenu(f, session);
    if (subSyncBusy(ccSync)) watchSubSync(f, session, l, true);
  } catch (err) { toast(err.message); }
}

async function watchSubSync(f, session, l, wasBusy = false) {
  clearTimeout(ccSyncTimer);
  let s;
  try { s = await api(`/api/subs/sync?kind=${f.kind}&id=${encodeURIComponent(mediaId(f))}&lang=${l.code}`); } catch { return; }
  if (current !== session || ccActive !== l.code) return;
  ccSync = s;
  if (subSyncBusy(s)) {
    ccSyncTimer = setTimeout(() => watchSubSync(f, session, l, true), 3000);
  } else if (wasBusy && ['synced', 'ok'].includes(s.state)) {
    reloadSubTrack(l);
    toast(s.state === 'ok' ? 'Subtitle timing checked' : `Subtitle timing fixed (${fmtSubShift(s.offset)})`);
  } else if (wasBusy && s.state === 'failed') {
    toast('Couldn’t check the subtitle timing');
  }
  renderCcMenu(f, session);
}

// Swaps the track for a fresh copy of the same file.
function reloadSubTrack(l) {
  const old = video.querySelector(`track[srclang="${l.code}"]`);
  if (!old) return;
  const src = `${old.getAttribute('src').split('?')[0]}?v=${Date.now()}`;
  const track = h('track', { kind: 'subtitles', srclang: l.code, label: l.name, src, default: true });
  old.remove();
  video.append(track);
  applySubModes();
  track.addEventListener('load', applySubModes);
}

async function setupPlayerSubs(f, session) {
  clearSubTracks();
  closeCcMenu();
  ccBtn.hidden = true;
  let data;
  try { data = await api(`/api/subs/langs?kind=${f.kind}&id=${encodeURIComponent(mediaId(f))}`); } catch { return; }
  if (current !== session) return;
  ccLangs = data.languages;
  if (!ccLangs.length && !data.configured) return; // nothing local and no API key
  ccBtn.hidden = false;
  renderCcMenu(f, session, ccLangs.length ? null : (data.problem || 'No subtitles found for this.'));
  // Re-enable the last used language if it's already saved locally (no download quota used).
  // Or the language picked in Settings, which is fetched when it isn't saved yet.
  let pref = null;
  try { pref = localStorage.getItem('subs:lang'); } catch { /* blocked */ }
  const want = prefs().subLang;
  const saved = ccLangs.find((l) => l.code === pref && l.saved) || (want && pref !== '' && ccLangs.find((l) => l.code === want));
  if (saved) pickPlayerSub(f, session, saved, { quiet: true });
}

async function pickPlayerSub(f, session, l, { quiet = false } = {}) {
  if (!quiet) closeCcMenu();
  try { localStorage.setItem('subs:lang', l.code || ''); } catch { /* blocked */ }
  clearSubTracks();
  if (!l.code) { renderCcMenu(f, session); return; }
  if (!quiet) toast(`Getting ${l.name} subtitles…`);
  try {
    const { url } = await api('/api/subs/fetch', jsonPost({ kind: f.kind, id: mediaId(f), lang: l.code }));
    if (current !== session) return;
    const track = h('track', { kind: 'subtitles', srclang: l.code, label: l.name, src: url, default: true });
    video.append(track);
    ccActive = l.code;
    applySubModes();
    track.addEventListener('load', applySubModes);
    l.saved = true;
    renderCcMenu(f, session);
    if (!quiet) toast(`${l.name} subtitles on`);
    watchSubSync(f, session, l);
  } catch (err) {
    renderCcMenu(f, session, err.message);
    if (!quiet) toast(err.message);
  }
}

// ---- audio compatibility ----
const CODEC_NAMES = { ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', mlp: 'Dolby TrueHD' };
const CODEC_MIME = { ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'flac', vorbis: 'vorbis', alac: 'alac' };
const browserPlays = (codec) => Boolean(CODEC_MIME[codec] && video.canPlayType(`audio/mp4; codecs="${CODEC_MIME[codec]}"`));

// Extra codecs this browser can decode, reported to the server.
const playsHevc = () => Boolean(video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'));
const extraPlayable = () => [...Object.keys(CODEC_MIME).filter(browserPlays), playsHevc() && 'hevc'].filter(Boolean).join(',');

// ---- audio sync ----
const syncBtn = $('#sync-btn');
const syncMenu = $('#sync-menu');
const SYNC_STEPS = [0.1, 0.25, 0.5, 1, 2];
let syncShift = 0;
let audioWatch = null; // token for the running watchAudio loop

function closeSyncMenu() { syncMenu.hidden = true; syncBtn.setAttribute('aria-expanded', 'false'); }
syncBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = syncMenu.hidden;
  closeCcMenu();
  syncMenu.hidden = !open;
  syncBtn.setAttribute('aria-expanded', String(open));
  if (open) syncMenu.querySelector('button')?.focus();
});
document.addEventListener('click', (e) => { if (!syncMenu.hidden && !syncMenu.contains(e.target)) closeSyncMenu(); });

const fmtShift = (s) => (s === 0 ? 'No correction'
  : `Sound moved ${Math.abs(s)} s ${s < 0 ? 'earlier' : 'later'}`);

function renderSyncMenu(f, session) {
  const row = (label, sign) => h('div', { class: 'sync-row' },
    h('span', { class: 'sync-label' }, label),
    h('div', { class: 'sync-steps' }, SYNC_STEPS.map((step) => h('button', {
      class: 'chip', 'aria-label': `${label} by ${step} seconds`,
      onclick: () => applySync(f, session, Math.round((syncShift + sign * step) * 1000) / 1000),
    }, `${step}s`))));
  syncMenu.replaceChildren(...[
    h('p', { class: 'sync-title' }, 'Audio out of sync?'),
    h('p', { class: 'cc-message' }, fmtShift(syncShift)),
    row('Sound is late', -1),
    row('Sound is early', +1),
    syncShift !== 0 && h('button', { class: 'cc-item', onclick: () => applySync(f, session, 0) }, 'Remove correction'),
    h('p', { class: 'cc-message' }, 'Saves a corrected copy. The video switches over by itself when it’s ready.'),
  ].filter(Boolean));
}

async function applySync(f, session, shift) {
  closeSyncMenu();
  try {
    await api(`/api/media/${f.kind}/${encodeURIComponent(mediaId(f))}/sync`, jsonPost({ shift }));
  } catch (err) {
    toast(err.message);
    return;
  }
  syncShift = shift;
  renderSyncMenu(f, session);
  watchAudio(f, session, shift);
}

// Polls the server while a corrected copy is made, then switches to it at the current position.
// Covers unplayable audio, automatic timing fixes and manual sync corrections (target).
async function watchAudio(f, session, target = null) {
  const token = audioWatch = {};
  let videoFixing = false;
  const note = $('#player-note');
  note.hidden = true;
  let changed = false;
  while (current === session && audioWatch === token) {
    let a;
    try { a = await api(`/api/media/${f.kind}/${encodeURIComponent(mediaId(f))}/audio?plays=${extraPlayable()}`); } catch { return; }
    if (current !== session || audioWatch !== token || !a.known) return;
    if (target === null) {
      syncShift = a.sync?.shift || 0;
      renderSyncMenu(f, session);
      syncBtn.hidden = Boolean(party);
    }
    const pendingSync = target !== null && (a.sync?.applied !== target || a.job);
    const videoOk = a.videoSafe !== false;
    if (a.browserSafe && a.aligned && videoOk && !pendingSync) {
      if (changed) switchToFixedAudio(session, target !== null ? 'Audio sync corrected' : videoFixing ? 'Ready to play' : 'Audio fixed');
      else note.hidden = true;
      return;
    }
    const progress = a.job === 'converting' ? ` ${Math.floor(a.percent ?? 0)}%.` : '';
    if (!videoOk) {
      // Video this browser can't decode (e.g. HEVC labelled hev1 in Safari): a compatible copy is being made.
      videoFixing = true;
      $('#player-error').hidden = true;
      note.textContent = a.fixable
        ? `This video is ${a.videoCodec}, which this browser can’t play. Making a version that plays here…${progress} It starts by itself when ready.`
        : `This video is ${a.videoCodec}, which this browser can’t play. ${a.error ? `Marquee couldn’t convert it: ${a.error}` : 'It should still play on a TV.'}`;
      note.hidden = false;
      if (!a.fixable) return;
      changed = true;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!a.browserSafe && !a.fixable) {
      const name = CODEC_NAMES[a.codec] || String(a.codec).toUpperCase();
      note.textContent = `No sound? This file’s audio is ${name}, which this browser can’t play. `
        + (a.error ? `Marquee couldn’t fix it: ${a.error}` : 'It should play with sound on a TV.');
      note.hidden = false;
      return;
    }
    if (!a.fixable && !pendingSync) return; // nothing Marquee can do
    if (pendingSync) note.textContent = `Applying your audio sync correction…${progress} It switches over by itself.`;
    else if (!a.browserSafe) note.textContent = `No sound? This file’s audio is ${CODEC_NAMES[a.codec] || a.codec}, which this browser can’t play. Adding normal stereo sound…${progress} It switches over by itself.`;
    else note.textContent = `Correcting this file’s audio timing…${progress} It switches over by itself.`;
    note.hidden = false;
    changed = true;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function switchToFixedAudio(session, message) {
  const at = video.currentTime;
  const wasPlaying = !video.paused;
  const base = video.src.replace(/[?&]v=\d+$/, '');
  video.addEventListener('loadedmetadata', () => {
    if (current !== session) return;
    if (!party && at > 1) video.currentTime = at;
    if (party) { party.pulse(); party.sync(); }
    else if (wasPlaying) video.play().catch(() => {});
  }, { once: true });
  video.src = `${base}${base.includes('?') ? '&' : '?'}v=${Date.now()}`; // cache-busting URL
  $('#player-note').hidden = true;
  $('#player-error').hidden = true;
  toast(message);
}

// Safari tints its toolbars with theme-color; black while the player is open so it blends in.
const themeMeta = document.querySelector('meta[name="theme-color"]');
let pageThemeColor = themeMeta?.content; // the theme's background (applyTheme)
const setTheme = (color) => { if (themeMeta) themeMeta.content = color; };

// Safari's toolbars can't be hidden by a web page; the Home Screen version has none.
// Mention that once, the first time the phone is turned sideways in Safari.
const isStandalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const landscapeQuery = matchMedia('(orientation: landscape) and (max-height: 600px) and (pointer: coarse)');
landscapeQuery.addEventListener('change', (e) => {
  if (!e.matches || isStandalone || !current || !/iPhone|iPad/.test(navigator.userAgent)) return;
  try {
    if (localStorage.getItem('tip:homescreen')) return;
    localStorage.setItem('tip:homescreen', '1');
  } catch { return; }
  toast('Tip: open Marquee from your Home Screen for fullscreen without Safari’s bar');
});

// ---- controls ----
// Marquee's own controls instead of the browser's, so they look the same everywhere, work from
// the keyboard, and the subtitles know where they are. They show on mouse movement or a tap and
// fade out 3 s into playback; they stay up while paused, while a menu is open or under the mouse.
const playerEl = $('#player');
const stage = $('#player-stage');
const controlsEl = $('#player-controls');
const seekRow = $('.seek-row');
const seekEl = $('#seek');
const seekTip = $('#seek-tip');
const playBtns = [$('#pc-play'), $('.pc-big-play')];
const muteBtn = $('#pc-mute');
const volInput = $('#pc-vol');
const fsBtn = $('#pc-fs');
const pipBtn = $('#pc-pip');
const timeEl = $('#pc-time');
const durEl = $('#pc-duration');
const osdEl = $('#player-osd');
const spinner = $('#player-spinner');
const helpEl = $('#player-help');

const menuOpen = () => !ccMenu.hidden || !syncMenu.hidden || !helpEl.hidden || watchPanelOpen;
let lastPointer = 'mouse';
let overControls = false;
let uiTimer = null;

function setUi(on) {
  if (playerEl.classList.contains('ui-visible') === on) return;
  playerEl.classList.toggle('ui-visible', on);
  layoutSubs();
}
function showPlayerUi() {
  setUi(true);
  clearTimeout(uiTimer);
  if (!video.paused) uiTimer = setTimeout(hidePlayerUi, 3000);
}
function hidePlayerUi() {
  if (video.paused) return;
  if (menuOpen() || overControls || seeking != null) { showPlayerUi(); return; }
  setUi(false);
}
playerEl.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, true);
playerEl.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showPlayerUi(); });
controlsEl.addEventListener('pointerenter', (e) => { overControls = e.pointerType === 'mouse'; });
controlsEl.addEventListener('pointerleave', () => { overControls = false; });
video.addEventListener('play', showPlayerUi);
video.addEventListener('pause', showPlayerUi);

// Mouse: click to play or pause, double-click for fullscreen. Touch: a tap shows or hides the
// controls, and a double tap on the left or right third skips 10 s (more taps keep skipping).
let lastTap = { at: 0, side: 0, uiWas: false, skipped: false };
stage.addEventListener('click', (e) => {
  if (menuOpen()) return; // this click only closes the menu
  if (lastPointer === 'mouse') { togglePlay(true); showPlayerUi(); return; }
  const r = stage.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const side = x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0;
  const now = Date.now();
  if (side && side === lastTap.side && now - lastTap.at < 350) {
    if (!lastTap.skipped) setUi(lastTap.uiWas); // undo what the first tap did to the controls
    lastTap = { ...lastTap, at: now, skipped: true };
    skip(10 * side);
    return;
  }
  lastTap = { at: now, side, uiWas: playerEl.classList.contains('ui-visible'), skipped: false };
  if (lastTap.uiWas) { clearTimeout(uiTimer); setUi(false); } else showPlayerUi();
});
stage.addEventListener('dblclick', () => { if (lastPointer === 'mouse') toggleFullscreen(); });

// Feedback in the middle of the picture: "+10 s", "Volume 40%", a play or pause symbol.
let osdTimer = null;
function osd(content) {
  osdEl.replaceChildren(h('span', {}, content));
  osdEl.classList.remove('show');
  void osdEl.offsetWidth; // restart the animation
  osdEl.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osdEl.classList.remove('show'), 700);
}

function togglePlay(feedback = false) {
  if (party?.blocked) { party.unlock(); return; }
  if (party) { party.control(party.state.intentPlaying ? 'pause' : 'play'); return; }
  const play = video.paused || video.ended;
  if (play) video.play().catch(() => {}); else video.pause();
  if (feedback) osd(icon(play ? 'play' : 'pause'));
}
function updatePlayState() {
  const playing = party ? !party.blocked && party.state.intentPlaying : !video.paused && !video.ended;
  for (const b of playBtns) {
    b.replaceChildren(icon(playing ? 'pause' : 'play'));
    b.setAttribute('aria-label', party?.blocked ? 'Join playback (Space)' : playing ? 'Pause (Space)' : 'Play (Space)');
  }
  playerEl.classList.toggle('is-paused', !playing);
}
for (const ev of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(ev, updatePlayState);
for (const b of playBtns) b.addEventListener('click', () => togglePlay());

// Repeated skips in the same direction add up in the feedback: "+30 s".
let skipTotal = 0;
let skipAt = 0;
function skip(seconds) {
  if (!isFinite(video.duration) || !video.duration) return;
  if (party) { party.control('seek', Math.min(Math.max(video.currentTime + seconds, 0), video.duration - 0.5)); return; }
  const now = Date.now();
  skipTotal = now - skipAt < 1000 && Math.sign(skipTotal) === Math.sign(seconds) ? skipTotal + seconds : seconds;
  skipAt = now;
  video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), video.duration - 0.5);
  osd(`${skipTotal < 0 ? '−' : '+'}${Math.abs(skipTotal)} s`);
  updateTime();
}
playerEl.querySelectorAll('.pc-skip').forEach((b) => b.replaceChildren(icon(Number(b.dataset.skip) < 0 ? 'back10' : 'fwd10')));
playerEl.querySelectorAll('.pc-skip').forEach((b) => b.addEventListener('click', () => { skip(Number(b.dataset.skip)); showPlayerUi(); }));

// ---- time and seek bar ----
let seeking = null; // where the seek bar is being dragged to, in seconds
let showRemaining = false;
try { showRemaining = localStorage.getItem('player:remaining') === '1'; } catch { /* blocked */ }

function updateTime() {
  const d = isFinite(video.duration) ? video.duration : 0;
  const t = seeking ?? video.currentTime;
  seekEl.style.setProperty('--pos', `${d ? (t / d) * 100 : 0}%`);
  timeEl.textContent = fmtTime(t);
  durEl.textContent = !d ? '–:––' : showRemaining ? `−${fmtTime(d - t)}` : fmtTime(d);
  seekEl.setAttribute('aria-valuemax', String(Math.floor(d)));
  seekEl.setAttribute('aria-valuenow', String(Math.floor(t)));
  seekEl.setAttribute('aria-valuetext', d ? `${fmtTime(t)} of ${fmtTime(d)}` : fmtTime(t));
}
function updateBuffer() {
  const d = video.duration;
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 1) end = Math.max(end, video.buffered.end(i));
  }
  seekEl.style.setProperty('--buf', d && isFinite(d) ? `${(end / d) * 100}%` : '0%');
}
for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'emptied', 'seeking']) video.addEventListener(ev, updateTime);
for (const ev of ['progress', 'timeupdate', 'emptied']) video.addEventListener(ev, updateBuffer);
durEl.addEventListener('click', () => {
  showRemaining = !showRemaining;
  try { localStorage.setItem('player:remaining', showRemaining ? '1' : ''); } catch { /* blocked */ }
  durEl.title = showRemaining ? 'Show duration' : 'Show time remaining';
  updateTime();
});

const seekTimeAt = (x) => {
  const r = seekEl.getBoundingClientRect();
  return Math.min(Math.max((x - r.left) / r.width, 0), 1) * (video.duration || 0);
};
function showSeekTip(x) {
  const r = seekEl.getBoundingClientRect();
  seekTip.textContent = fmtTime(seekTimeAt(x));
  seekTip.hidden = false;
  const half = seekTip.offsetWidth / 2;
  seekTip.style.left = `${Math.min(Math.max(x - r.left, half), r.width - half)}px`;
}
seekEl.addEventListener('pointerdown', (e) => {
  if (party && !party.isHost) { toast('The host controls seeking'); return; }
  if (!isFinite(video.duration) || !video.duration) return;
  seekEl.setPointerCapture(e.pointerId);
  seeking = seekTimeAt(e.clientX);
  seekEl.classList.add('is-dragging');
  showSeekTip(e.clientX);
  updateTime();
});
seekEl.addEventListener('pointermove', (e) => {
  if (seeking != null) { seeking = seekTimeAt(e.clientX); updateTime(); }
  if (seeking != null || e.pointerType === 'mouse') showSeekTip(e.clientX);
});
function endSeek(apply) {
  if (seeking == null) return;
  if (apply) {
    if (party) party.control('seek', seeking);
    else video.currentTime = seeking;
  }
  seeking = null;
  seekEl.classList.remove('is-dragging');
  seekTip.hidden = true;
  updateTime();
  showPlayerUi();
}
seekEl.addEventListener('pointerup', () => endSeek(true));
seekEl.addEventListener('pointercancel', () => endSeek(false));
seekEl.addEventListener('pointerleave', () => { if (seeking == null) seekTip.hidden = true; });

// ---- volume ----
// iOS ignores volume set by a page (the side buttons are the volume), so it only gets mute.
const canSetVolume = (() => { const v = document.createElement('video'); v.volume = 0.5; return v.volume === 0.5; })();
volInput.hidden = !canSetVolume;
try {
  const v = Number(localStorage.getItem('player:volume'));
  if (canSetVolume && localStorage.getItem('player:volume') !== null && v >= 0 && v <= 1) video.volume = v;
  video.muted = localStorage.getItem('player:muted') === '1';
} catch { /* blocked */ }

function updateVolume() {
  const level = video.muted ? 0 : video.volume;
  muteBtn.replaceChildren(icon(level === 0 ? 'muted' : level < 0.5 ? 'volume' : 'volumeHigh'));
  muteBtn.setAttribute('aria-label', video.muted ? 'Unmute (M)' : 'Mute (M)');
  if (document.activeElement !== volInput) volInput.value = String(level);
  volInput.style.setProperty('--val', `${level * 100}%`);
  try {
    localStorage.setItem('player:volume', String(video.volume));
    localStorage.setItem('player:muted', video.muted ? '1' : '');
  } catch { /* blocked */ }
}
video.addEventListener('volumechange', updateVolume);
updateVolume();
function setVolume(v) {
  video.volume = Math.round(Math.min(Math.max(v, 0), 1) * 100) / 100;
  video.muted = video.volume === 0;
}
function toggleMute() {
  if (video.muted && video.volume === 0) video.volume = 0.5; // unmuting at zero would stay silent
  video.muted = !video.muted;
  osd(video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
}
muteBtn.addEventListener('click', toggleMute);
volInput.addEventListener('input', () => setVolume(Number(volInput.value)));

// ---- fullscreen and picture-in-picture ----
// The whole player goes fullscreen, so the controls and subtitles come along. iPhones can only
// make the video itself fullscreen, which opens iOS's own player.
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
let fsExitedAt = 0;
fsBtn.hidden = !playerEl.requestFullscreen && !playerEl.webkitRequestFullscreen && !video.webkitEnterFullscreen;
function toggleFullscreen() {
  if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  if (playerEl.requestFullscreen) {
    playerEl.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      // Phones: turn to landscape for widescreen films (works where the browser allows it).
      if (lastPointer !== 'mouse' && video.videoWidth > video.videoHeight) screen.orientation?.lock?.('landscape').catch(() => {});
    }, () => {});
  } else if (playerEl.webkitRequestFullscreen) playerEl.webkitRequestFullscreen();
  else try { video.webkitEnterFullscreen(); } catch { /* not ready yet */ }
}
function updateFullscreen() {
  const on = Boolean(fsElement());
  if (!on) fsExitedAt = Date.now();
  fsBtn.replaceChildren(icon(on ? 'fullscreenExit' : 'fullscreen'));
  fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen (F)' : 'Fullscreen (F)');
  layoutSubs();
}
document.addEventListener('fullscreenchange', updateFullscreen);
document.addEventListener('webkitfullscreenchange', updateFullscreen);
updateFullscreen();
fsBtn.addEventListener('click', toggleFullscreen);

pipBtn.hidden = !document.pictureInPictureEnabled;
pipBtn.replaceChildren(icon('pip'));
function togglePip() {
  if (!document.pictureInPictureEnabled || !video.currentSrc) return;
  (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => {});
}
pipBtn.addEventListener('click', togglePip);

// Buffering: a spinner, after a short wait so quick seeks don't flash it.
let spinTimer = null;
function setSpinner(on) {
  clearTimeout(spinTimer);
  if (on) spinTimer = setTimeout(() => { spinner.hidden = false; }, 300);
  else spinner.hidden = true;
}
video.addEventListener('waiting', () => setSpinner(true));
for (const ev of ['playing', 'canplay', 'pause', 'emptied', 'error']) video.addEventListener(ev, () => setSpinner(false));

// ---- subtitle layout ----
// The subtitle layer covers the picture itself, not the black bars around it, and its text is
// sized to the picture. While the controls or the title bar are showing, the lines move just far
// enough to clear them, and slide back when they fade.
const SUB_SIZES = [['S', 0.8, 'Small'], ['M', 1, 'Medium'], ['L', 1.25, 'Large'], ['XL', 1.55, 'Extra large']];
let subSize = 1;
try { subSize = Number(localStorage.getItem('subs:size')) || 1; } catch { /* blocked */ }

function layoutSubs() {
  if (playerEl.hidden) return;
  const box = stage.getBoundingClientRect();
  const vr = video.getBoundingClientRect();
  let { left, top, width, height } = vr;
  if (video.videoWidth && video.videoHeight) {
    const scale = Math.min(vr.width / video.videoWidth, vr.height / video.videoHeight);
    width = video.videoWidth * scale;
    height = video.videoHeight * scale;
    left += (vr.width - width) / 2;
    top += (vr.height - height) / 2;
  }
  // A phone held upright shows a short strip of picture with empty black above and below: when
  // three lines fit between the picture and the controls, the dialogue goes there instead of over
  // the picture. (The controls take up their space even while faded, so this doesn't jump around.)
  const below = seekRow.getBoundingClientRect().top - 10 - (top + height);
  const sizeOver = Math.min(Math.max(height * 0.05, 15), 52) * subSize; // ~1/20 of the picture's height
  const sizeUnder = Math.min(Math.max(width * 0.045, 15), 26) * subSize;
  const outside = below >= sizeUnder * 1.25 * 3 + sizeUnder; // three lines and a gap
  subsEl.classList.toggle('subs-below', outside);
  Object.assign(subsEl.style, {
    left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${width}px`, height: `${height}px`,
    fontSize: `${outside ? sizeUnder : sizeOver}px`,
  });
  let lift = 0;
  let drop = 0;
  if (playerEl.classList.contains('ui-visible')) {
    // Measured from the controls themselves, not the fade behind them.
    const gap = height * 0.05; // where lines sit without the controls: 5% in from the edge
    lift = Math.max(0, top + height - gap - (seekRow.getBoundingClientRect().top - 10));
    drop = Math.max(0, $('#player-close').getBoundingClientRect().bottom + 10 - (top + gap));
  }
  subsEl.style.setProperty('--lift', `${lift}px`);
  subsEl.style.setProperty('--drop', `${drop}px`);
}
new ResizeObserver(layoutSubs).observe(stage);
video.addEventListener('loadedmetadata', layoutSubs);

function setSubSize(v) {
  subSize = v;
  try { localStorage.setItem('subs:size', String(v)); } catch { /* blocked */ }
  ccMenu.querySelectorAll('.cc-size button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.size) === v)));
  layoutSubs();
}
function subSizeRow() {
  return h('div', { class: 'cc-nudge cc-size' },
    h('span', { class: 'cc-nudge-label' }, 'Size'),
    h('div', { class: 'cc-nudge-buttons' }, SUB_SIZES.map(([label, v, name]) => h('button', {
      type: 'button', 'data-size': v, 'aria-label': `${name} subtitles`, 'aria-pressed': String(subSize === v), onclick: () => setSubSize(v),
    }, label))));
}

// C turns subtitles off, or back on in the language used last.
let lastSubLang = null;
function toggleSubs() {
  if (!current || ccBtn.hidden) return;
  if (ccActive) {
    lastSubLang = ccActive;
    pickPlayerSub(current, current, { code: null, name: 'Off' }, { quiet: true });
    osd('Subtitles off');
    return;
  }
  let pref = lastSubLang;
  try { pref ||= localStorage.getItem('subs:lang'); } catch { /* blocked */ }
  const l = ccLangs.find((x) => x.code === pref) || ccLangs.find((x) => x.saved) || ccLangs[0];
  if (l) pickPlayerSub(current, current, l);
}

// ---- keyboard ----
const SHORTCUTS = [
  ['Space or K', 'Play or pause'],
  ['← →', 'Back or forward 5 s'],
  ['J L', 'Back or forward 10 s'],
  ['↑ ↓', 'Volume'],
  ['M', 'Mute'],
  ['F', 'Fullscreen'],
  ['C', 'Subtitles on or off'],
  ['P', 'Picture in picture'],
  ['0 – 9', 'Jump to 0% – 90%'],
  ['?', 'These shortcuts'],
];
function toggleHelp() {
  if (helpEl.hidden) {
    helpEl.replaceChildren(
      h('p', { class: 'help-title' }, 'Keyboard shortcuts'),
      h('dl', {}, SHORTCUTS.map(([keys, what]) => h('div', {}, h('dt', {}, keys), h('dd', {}, what)))));
  }
  helpEl.hidden = !helpEl.hidden;
}
document.addEventListener('click', (e) => { if (!helpEl.hidden && !helpEl.contains(e.target)) helpEl.hidden = true; });

const seekToFraction = (f) => {
  if (!isFinite(video.duration)) return;
  if (party) party.control('seek', video.duration * f);
  else { video.currentTime = video.duration * f; updateTime(); }
};
const nudgeVolume = (d) => {
  if (!canSetVolume) return;
  setVolume((video.muted ? 0 : video.volume) + d);
  osd(`Volume ${Math.round(video.volume * 100)}%`);
};
const PLAYER_KEYS = {
  ' ': () => togglePlay(true), k: () => togglePlay(true),
  ArrowLeft: () => skip(-5), ArrowRight: () => skip(5), j: () => skip(-10), l: () => skip(10),
  ArrowUp: () => nudgeVolume(0.05), ArrowDown: () => nudgeVolume(-0.05),
  m: toggleMute, f: toggleFullscreen, c: toggleSubs, p: togglePip, '?': toggleHelp,
  Home: () => seekToFraction(0), End: () => seekToFraction(0.999),
};
// Keys typed into a menu or a text field are left alone.
const playerKeyTarget = (e) => !playerEl.hidden && !e.ctrlKey && !e.metaKey && !e.altKey
  && !e.target.closest?.('.cc-menu') && !e.target.matches?.('input:not([type="range"]), textarea, select');
document.addEventListener('keydown', (e) => {
  if (!playerKeyTarget(e)) return;
  if (e.key === 'Tab') { showPlayerUi(); return; } // hidden controls can't take focus
  const key = e.key === '/' && e.shiftKey ? '?' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const run = PLAYER_KEYS[key] ?? (/^[0-9]$/.test(key) ? () => seekToFraction(Number(key) / 10) : null);
  if (!run) return;
  e.preventDefault(); // also keeps Space from pressing whichever button has focus
  run();
  if (key !== '?') showPlayerUi();
});
document.addEventListener('keyup', (e) => { if (e.key === ' ' && playerKeyTarget(e)) e.preventDefault(); });

async function openPlayer(f, opts = {}) {
  if (party) leaveWatchRoom();
  let src = null; // signed link to the browser version (audio-fixed copy when one exists)
  const opener = document.activeElement;
  const err = $('#player-error');
  const session = current = { ...f };

  $('#player-title').textContent = [f.title, episodeLabel(f)].filter(Boolean).join(' ');
  err.hidden = true;
  $('#player').hidden = false;
  document.body.style.overflow = 'hidden';
  document.body.classList.add('in-player');
  $('#player-close').focus({ preventScroll: true });

  setTheme('#000000');
  updatePlayState();
  updateTime();
  showPlayerUi();
  setSpinner(true);
  (opts.replace ? swapTopOverlay : pushOverlay)(() => {
    leaveWatchRoom();
    setTheme(pageThemeColor);
    saveProgress(true);
    video.pause();
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    resetCasting();
    clearSubTracks();
    closeCcMenu();
    ccBtn.hidden = true;
    closeSyncMenu();
    syncBtn.hidden = true;
    helpEl.hidden = true;
    endSeek(false);
    audioWatch = null;
    $('#player-note').hidden = true;
    video.removeAttribute('src');
    video.load(); // stops the network stream
    $('#player').hidden = true;
    document.body.style.overflow = '';
    document.body.classList.remove('in-player');
    current = null;
    opener?.focus?.({ preventScroll: true });
    if (state.view === 'library') renderLibrary(); // refresh watched bars
  });
  const watchSession = opts.watchRoom ? attachWatchRoom(opts.watchRoom) : null;
  renderParty();

  // Get a signed link, then request one byte so server errors can be shown as text.
  try {
    const link = await api(watchSession ? `${watchSession.base}/play-link?clientId=${encodeURIComponent(watchClient)}`
      : `/api/play-link?kind=${f.kind}&id=${encodeURIComponent(mediaId(f))}&variant=browser`);
    src = link.url;
    session.browserName = link.name;
    const r = await fetch(src, { headers: { Range: 'bytes=0-0' } });
    if (!r.ok) {
      let msg = `The server responded with ${r.status}.`;
      try { msg = (await r.json()).error || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    r.body?.cancel();
  } catch (e) {
    if (current !== session) return;
    if (party === watchSession && watchSession) leaveWatchRoom();
    setSpinner(false);
    err.textContent = e.message;
    err.hidden = false;
    return;
  }

  if (current !== session) return; // closed while we were checking
  video.src = src;
  if (!party) watchCastTargets();
  if (opts.castHint && canCastFromBrowser) {
    const note = $('#player-note');
    note.textContent = hasAirPlay
      ? 'Tap the AirPlay button in the controls below to pick a TV. No button means there’s no AirPlay TV on this network.'
      : 'Tap the cast button in the controls below to pick a TV. No button means there’s no Chromecast on this network.';
    note.hidden = false;
    airplayBtn.classList.add('is-hint');
  }
  setupPlayerSubs(f, session);
  syncBtn.hidden = true;
  watchAudio(f, session);
  if (watchSession) {
    try { await watchSession.start(); }
    catch (error) { if (party === watchSession) { leaveWatchRoom(); video.pause(); err.textContent = error.message; err.hidden = false; } }
  } else video.play().catch(() => { /* autoplay blocked: the controls are there */ });
}

video.addEventListener('loadedmetadata', () => {
  if (party) { party.sync(); return; }
  if (swappingSource) return; // swapSource restores the position itself
  const saved = current && savedProgress(current);
  if (saved && saved.time > 30 && saved.time < video.duration - 90) {
    video.currentTime = saved.time;
    toast(`Resuming at ${fmtTime(saved.time)}`);
  }
});
video.addEventListener('timeupdate', () => saveProgress());
video.addEventListener('pause', () => saveProgress(true));
video.addEventListener('error', () => {
  if (!current) return;
  const err = $('#player-error');
  err.textContent = 'This video can’t play in this browser yet. Marquee makes a version that plays here automatically; you can follow its progress in the Library tab.';
  // When the note below the video says a version is being made, that note is the explanation.
  err.hidden = !$('#player-note').hidden;
});
$('#player-close').addEventListener('click', closeTopOverlay);
window.addEventListener('pagehide', () => { saveProgress(true); party?.close(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted && party?.closed) { const token = party.state.token; leaveWatchRoom(false); video.pause(); offerWatchRoom(token); }
});

// ---------- search box + tabs ----------
const input = $('#q');
const PLACEHOLDERS = { discover: 'Search films and shows', library: 'Filter your library', downloads: 'Filter downloads', activity: 'Filter by person or title', house: 'Filter machines', clips: 'Filter by game or name', settings: 'Search films and shows' };

function renderView() {
  if (state.view === 'discover') renderDiscover();
  if (state.view === 'library') renderLibrary();
  if (state.view === 'downloads') renderDownloads();
  if (state.view === 'activity') renderActivity();
  if (state.view === 'house') renderHouse();
  if (state.view === 'clips') renderClips();
  if (state.view === 'settings') renderSettings();
}

// ---------- settings ----------
// Everyone: name, colours (a preset or their own four), and how Marquee behaves for them. The owner
// also gets the server's rules (auto-delete) and the people who use it. Changes save straight away.
let saveMeTimer = null;
async function saveMe(patch, msg = 'Saved') {
  try {
    state.me = (await api('/api/me', jsonPost(patch))).me;
    if (msg) toast(msg);
  } catch (err) { toast(err.message); }
}
async function saveRules(patch) {
  try {
    state.rules = (await api('/api/admin/settings', jsonPost(patch))).settings;
    toast('Saved for everyone');
    await loadLibrary(); // countdowns follow the new rules
  } catch (err) { toast(err.message); }
  renderSettings();
}
async function loadPeople() {
  try { state.people = (await api('/api/admin/users')).users; state.peopleError = null; } catch (err) { state.peopleError = err.message; }
}

const settingsRow = (label, hint, control) => h('div', { class: 'set-row' },
  h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, label), hint && h('div', { class: 'set-hint' }, hint)),
  h('div', { class: 'set-control' }, control));
function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', { 'aria-hidden': 'true' }));
}
function select(options, value, onChange, label) {
  const el = h('select', { class: 'sub-select', 'aria-label': label },
    options.map(([v, text]) => h('option', { value: String(v) }, text)));
  el.value = String(value);
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
const days = (n) => (n ? plural(n, 'day') : 'Never');

function themeSwatch(key, t, selected, onPick) {
  return h('button', {
    type: 'button', class: 'swatch', 'aria-pressed': String(selected), 'aria-label': `${t.name} colours`,
    style: `--sw-bg:${t.bg};--sw-surface:${t.surface};--sw-text:${t.text};--sw-accent:${t.accent};--sw-muted:${t.muted}`,
    onclick: () => onPick(key),
  },
  h('span', { class: 'swatch-preview', 'aria-hidden': 'true' },
    h('i', { class: 'sw-title' }), h('i', { class: 'sw-line' }), h('i', { class: 'sw-card' }), h('i', { class: 'sw-dot' })),
  h('span', { class: 'swatch-name' }, t.name));
}

function appearanceSection() {
  const theme = prefs().theme;
  const active = theme?.preset || state.rules?.defaultTheme || 'marquee';
  const pick = (key) => {
    const next = key === 'custom' ? { preset: 'custom', colors: customColors() } : { preset: key };
    applyTheme(next);
    saveMe({ theme: next }, null).then(renderSettings);
  };
  // The custom editor starts from whatever is showing now.
  const customColors = () => {
    if (theme?.preset === 'custom') return { ...theme.colors };
    const c = themeColors(theme);
    return { bg: c.bg.toLowerCase(), surface: c.surface.toLowerCase(), text: c.text.toLowerCase(), accent: c.accent.toLowerCase() };
  };
  const grid = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour themes' },
    Object.entries(THEMES).map(([key, t]) => themeSwatch(key, t, active === key, pick)),
    themeSwatch('custom', { ...themeColors(theme?.preset === 'custom' ? theme : { preset: 'custom', colors: customColors() }), name: 'Your own' }, active === 'custom', pick));

  let editor = null;
  if (active === 'custom') {
    const colors = customColors();
    const contrast = h('p', { class: 'set-hint custom-warn', role: 'status' });
    const check = () => {
      const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const low = ratio(colors.text, colors.bg) < 4.5 || ratio(colors.text, colors.surface) < 4.5;
      contrast.textContent = low ? 'The text may be hard to read on these backgrounds. Try a lighter or darker text colour.' : '';
    };
    const commit = () => {
      clearTimeout(saveMeTimer);
      saveMeTimer = setTimeout(() => saveMe({ theme: { preset: 'custom', colors: { ...colors } } }, 'Colours saved'), 700);
    };
    editor = h('div', { class: 'custom-colors' },
      THEME_FIELDS.map(([k, label]) => {
        const id = `color-${k}`;
        const picker = h('input', { type: 'color', id, value: colors[k] });
        const hex = h('input', { type: 'text', class: 'hex-input', value: colors[k], maxlength: '7', spellcheck: 'false', 'aria-label': `${label} colour code` });
        const set = (v) => {
          colors[k] = v.toLowerCase();
          picker.value = hex.value = colors[k];
          applyTheme({ preset: 'custom', colors });
          check();
          commit();
        };
        picker.addEventListener('input', () => set(picker.value));
        hex.addEventListener('change', () => {
          const v = hex.value.trim().replace(/^#?/, '#');
          if (/^#[0-9a-f]{6}$/i.test(v)) set(v); else { hex.value = colors[k]; toast('Use a colour code like #1f1019'); }
        });
        return h('div', { class: 'color-field' }, h('label', { for: id }, label), h('div', { class: 'color-inputs' }, picker, hex));
      }),
      contrast);
    check();
  }
  return [
    h('h3', { class: 'set-head' }, 'Appearance'),
    h('p', { class: 'set-hint' }, 'Only changes how Marquee looks for you, on every device you use.'),
    grid,
    editor,
  ];
}

function renderSettings() {
  const body = $('#settings-body');
  const me = state.me;
  if (!me) { body.replaceChildren(notice('Couldn’t load your settings', 'Reload the page to try again.')); return; }
  const p = prefs();
  const out = [];

  // ---- you ----
  const nameInput = h('input', { type: 'text', class: 'invite-note set-name', maxlength: '40', value: me.name, 'aria-label': 'Your name', autocomplete: 'nickname' });
  nameInput.addEventListener('change', () => saveMe({ name: nameInput.value }, 'Name saved'));
  out.push(h('div', { class: 'profile' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, (me.name || '?').slice(0, 1).toUpperCase()),
    h('div', { class: 'profile-text' },
      nameInput,
      h('div', { class: 'set-hint' }, me.email ? `Signed in as ${me.email} through Cloudflare` : 'Home network: everyone at home who opens the server’s local address shares this'),
      h('div', { class: 'profile-tags' }, me.isOwner && h('span', { class: 'tag' }, 'Owner'), !me.canDownload && h('span', { class: 'tag' }, 'Can’t download')))));

  out.push(...appearanceSection());

  // ---- watching ----
  out.push(h('h3', { class: 'set-head' }, 'Watching'));
  out.push(settingsRow('Subtitles', 'Turned on automatically when a video has them in this language.',
    select([['', 'Off'], ...(state.status.subLangs || []).map((l) => [l.code, l.name])], p.subLang || '', (v) => saveMe({ subLang: v }), 'Default subtitles')));
  out.push(settingsRow('Open Marquee on', null,
    segmented([['discover', 'Discover'], ['library', 'Library'], ['downloads', 'Downloads']], p.startView || 'discover', (v) => saveMe({ startView: v }).then(renderSettings), 'Open Marquee on')));
  out.push(settingsRow('Library order', null,
    segmented([['newest', 'Newest'], ['expiring', 'Leaving soonest'], ['title', 'A–Z']], p.librarySort || 'newest', (v) => saveMe({ librarySort: v }).then(renderSettings), 'Library order')));
  if (canDownload()) {
    out.push(settingsRow('Preferred quality', 'The filter torrent search starts on.',
      segmented([['all', 'Any'], ['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p']], p.quality || 'all', (v) => saveMe({ quality: v }).then(renderSettings), 'Preferred quality')));
  }

  // ---- your library ----
  const r = state.rules || {};
  const mine = state.library;
  const next = mine.filter((f) => f.expiresAt != null).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  out.push(h('h3', { class: 'set-head' }, 'Your library'));
  out.push(h('div', { class: 'set-card' },
    h('p', {}, `${plural(mine.length, 'video')}, ${fmtBytes(mine.reduce((n, f) => n + (f.size || 0), 0))}.`,
      next ? ` Next to go: ${next.title}${episodeLabel(next) ? ` ${episodeLabel(next)}` : ''}, ${timeLeft(next.expiresAt).replace(' left', '')} left.` : ''),
    h('p', { class: 'set-hint' }, me.keep ? 'The owner has set your videos to stay until you delete them.'
      : r.retentionDays
        ? `Downloads are deleted ${plural(r.retentionDays, 'day')} after they finish, to keep space free on the server. Use “Keep ${r.extendDays} more days” in the Library to hold on to something${r.maxExtensions ? ` (up to ${plural(r.maxExtensions, 'time')} per video)` : ''}.`
        : 'Nothing is deleted automatically.')));

  if (me.isOwner) out.push(...ownerSettings());
  body.replaceChildren(...out.filter(Boolean));
}

function ownerSettings() {
  const r = state.rules || {};
  const out = [h('h3', { class: 'set-head' }, 'Server', h('span', { class: 'tag' }, 'Owner'))];
  out.push(settingsRow('Delete downloads after', 'Counted from when each download finishes, per person. A video someone else still has stays.',
    select([0, 1, 3, 7, 14, 30].map((n) => [n, days(n)]), r.retentionDays ?? 7, (v) => saveRules({ retentionDays: Number(v) }), 'Delete downloads after')));
  out.push(settingsRow('“Keep longer” adds', null,
    select([1, 3, 7, 14, 30].map((n) => [n, plural(n, 'day')]), r.extendDays ?? 7, (v) => saveRules({ extendDays: Number(v) }), 'Keep longer adds')));
  out.push(settingsRow('Times a video can be kept longer', null,
    select([[0, 'No limit'], [1, 'Once'], [2, 'Twice'], [3, '3 times'], [5, '5 times'], [10, '10 times']], r.maxExtensions ?? 0, (v) => saveRules({ maxExtensions: Number(v) }), 'Times a video can be kept longer')));
  out.push(settingsRow('New people can download', 'Otherwise they can only add what’s already on the server, until you allow them below.',
    toggle(r.membersCanDownload !== false, (on) => saveRules({ membersCanDownload: on }), 'New people can download')));
  out.push(settingsRow('Colours for new people', 'Until they pick their own.',
    select(Object.entries(THEMES).map(([k, t]) => [k, t.name]), r.defaultTheme || 'marquee', (v) => saveRules({ defaultTheme: v }), 'Colours for new people')));
  out.push(h('details', { class: 'set-card set-signin' },
    h('summary', {}, 'Staying signed in'),
    h('p', {}, 'Marquee has no login of its own: it uses the Cloudflare Access sign-in, so how long people stay signed in is set in Cloudflare. To make it last a month:'),
    h('ol', {},
      h('li', {}, 'Cloudflare dashboard → Zero Trust → Access → Applications → Marquee → Edit.'),
      h('li', {}, 'Set Session Duration to 1 month (it’s 24 hours now) and save.'),
      h('li', {}, 'If you’ve set a Global session timeout (Settings → Authentication), raise that too: it caps every app.')),
    h('p', { class: 'set-hint' }, 'If someone’s sign-in does run out while Marquee is open, it now tells them and signs them back in with one tap.')));

  out.push(h('h3', { class: 'set-head' }, 'People'));
  if (state.peopleError) out.push(h('p', { class: 'muted' }, state.peopleError));
  else if (!state.people) out.push(h('p', { class: 'muted' }, 'Loading…'));
  else {
    out.push(h('ul', { class: 'rows people' }, state.people.map((u) => h('li', { class: 'row person' },
      h('span', { class: 'avatar small', 'aria-hidden': 'true' }, (u.name || '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, u.name, u.isOwner && h('span', { class: 'tag' }, 'Owner')),
        h('div', { class: 'row-meta' },
          u.email && h('span', {}, u.email),
          h('span', {}, `${plural(u.items, 'video')}, ${fmtBytes(u.size)}`),
          u.lastSeen && h('span', {}, lastSeenText(u.lastSeen)))),
      h('div', { class: 'person-controls' },
        h('label', { class: 'person-toggle' }, 'Can download',
          toggle(u.canDownload, async (on, input) => {
            if (u.isOwner) { input.checked = true; toast('The owner can always download'); return; }
            await personUpdate(u, { canDownload: on });
          }, `${u.name} can download`)),
        h('label', { class: 'person-toggle' }, 'Never auto-delete',
          toggle(u.keep, (on) => personUpdate(u, { keep: on }), `Never auto-delete ${u.name}’s videos`)))))));
  }
  return out;
}
async function personUpdate(u, patch) {
  try {
    await api(`/api/admin/users/${u.id}`, jsonPost(patch));
    toast('Saved');
  } catch (err) { toast(err.message); }
  await loadPeople();
  if (u.id === state.me.id) { state.me = (await api('/api/me')).me; await loadLibrary(); }
  if (state.view === 'settings') renderSettings();
}

// ---------- activity (server owner only) ----------
// Who has been using Marquee and what they did, from the server's activity log.
const ACTIVITY_TEXT = {
  watch: (d) => d,
  download: (d) => `started downloading ${d}`,
  delete: (d) => `deleted ${d}`,
  pause: (d) => `paused the download of ${d}`,
  resume: (d) => `resumed the download of ${d}`,
  play: (d) => `watched ${d}`,
  cast: (d) => { const [what, tv] = d.split(' → '); return tv ? `put ${what} on ${tv}` : `put ${d} on a TV`; },
  stop: (d) => `stopped ${d}`,
  subtitles: (d) => `got ${d}`,
  share: (d) => `shared the clip ${d}`,
  trim: (d) => `trimmed the clip ${d}`,
  invite: (d) => `made an invite link (${d})`,
  joined: (d) => `joined Marquee (${d})`,
  revoke: (d) => `removed ${d}’s access`,
  unshare: (d) => `stopped sharing ${d}`,
  wake: (d) => `woke ${d}`,
  restart: (d) => `restarted ${d}`,
  add: (d) => `added ${d} to their library`,
  remove: (d) => `removed ${d} from their library`,
  extend: (d) => `kept ${d} longer`,
  expire: (d) => `auto-deleted ${d}`,
  settings: (d) => `changed the server rules (${d})`,
  permission: (d) => `changed a permission: ${d}`,
};
const personName = (person) => typeof person === 'string' ? person.split('@')[0]
  : person.name || String(person.user || 'Viewer').split('@')[0];
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
function lastSeenText(ms) {
  const min = (Date.now() - ms) / 60000;
  if (min < 3) return 'Active now';
  if (min < 60) return `Seen ${Math.round(min)} min ago`;
  if (min < 24 * 60) return `Seen ${Math.round(min / 60)} h ago`;
  return `Seen ${fmtAgo(ms)}`;
}

async function loadActivity() {
  try { state.activity = await api('/api/activity'); state.activityError = null; } catch (err) { state.activityError = err.message; }
  try { state.access = await api('/api/access'); } catch (err) { state.access = { configured: true, error: err.message, invites: [] }; }
}

// ---------- access: who may sign in (Zero Trust email list) + invite links ----------
async function makeInvite(btn) {
  const note = $('#invite-note')?.value.trim() || '';
  btn.disabled = true;
  try {
    const inv = await api('/api/access/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
    state.newInvite = inv.url;
    await copyWithToast(inv.url, 'Invite link copied: send it to them');
  } catch (err) { toast(err.message); }
  await loadActivity();
  renderActivity();
}
// copyText() (above) has the iOS fallback; this adds the toast, or shows the link if copying failed
async function copyWithToast(text, msg) {
  if (await copyText(text)) toast(msg); else prompt('Copy this link', text);
}
async function accessAction(path, body, msg) {
  try {
    await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    toast(msg);
  } catch (err) { toast(err.message); }
  await loadActivity();
  renderActivity();
}

function accessSection() {
  const a = state.access;
  if (!a) return [];
  const out = [h('h3', { class: 'activity-head' }, 'Access')];
  if (!a.configured) {
    out.push(h('p', { class: 'muted' }, 'Set CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_LIST_ID in .env to invite people from here (see the README).'));
    return out;
  }
  const noteInput = h('input', { id: 'invite-note', class: 'invite-note', type: 'text', maxlength: '60', placeholder: 'Who’s it for?' });
  out.push(h('div', { class: 'invite-new' }, noteInput,
    h('button', { class: 'retry', onclick: (e) => makeInvite(e.currentTarget) }, 'Invite someone')));
  out.push(h('p', { class: 'muted invite-hint' }, 'Makes a one-time link (valid 7 days). They enter their email and can sign in from then on.'));
  const open = (a.invites || []).filter((i) => i.state === 'open');
  if (open.length) {
    out.push(h('ul', { class: 'rows' }, open.map((i) => {
      const url = `${location.origin}/c/i/${i.token}`;
      return h('li', { class: 'row' },
        h('span', { class: 'row-text' },
          h('span', { class: 'row-title' }, i.note || 'Invite'),
          h('span', { class: 'row-meta' }, h('span', {}, `open · expires ${new Date(i.expires).toLocaleDateString([], { day: 'numeric', month: 'short' })}`))),
        h('span', { class: 'row-actions' },
          h('button', { class: 'retry', onclick: () => copyWithToast(url, 'Invite link copied') }, 'Copy link'),
          h('button', { class: 'retry', onclick: () => accessAction(`/api/access/invite/${i.id}/revoke`, null, 'Invite cancelled') }, 'Cancel')));
    })));
  }
  if (a.error) out.push(h('p', { class: 'muted' }, `Couldn’t read the access list: ${a.error}`));
  else if (a.members) {
    const q = norm(state.query);
    const list = a.members.filter((e) => !q || norm(`${e} ${a.names?.[e] || ''}`).includes(q));
    out.push(h('p', { class: 'activity-day' }, `${a.members.length} ${a.members.length === 1 ? 'person' : 'people'} can sign in`));
    out.push(h('ul', { class: 'rows' }, list.map((email) => {
      const owner = (a.owners || []).includes(email);
      const name = a.names?.[email] || personName(email);
      return h('li', { class: 'row' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, name),
          h('span', { class: 'row-meta' }, h('span', {}, email), owner && h('span', {}, 'owner'))),
        !owner && h('span', { class: 'row-actions' }, h('button', {
          class: 'retry',
          onclick: (e) => {
            const b = e.currentTarget;
            if (b.dataset.sure) return accessAction('/api/access/remove', { email }, `${name} can’t sign in any more`);
            b.dataset.sure = '1';
            b.textContent = 'Sure?';
            setTimeout(() => { b.textContent = 'Remove'; delete b.dataset.sure; }, 4000);
          },
        }, 'Remove')));
    })));
  }
  return out;
}

function renderActivity() {
  const body = $('#activity-body');
  if (state.activityError) { body.replaceChildren(notice('Couldn’t get activity', state.activityError)); return; }
  if (!state.activity) return;
  const q = norm(state.query);
  const people = state.activity.people.filter((p) => !q || norm(`${p.user} ${personName(p)} ${activityDevice(p)}`).includes(q));
  const events = state.activity.events.filter((e) => !q || norm(`${e.user} ${personName(e)} ${e.subjectName || ''} ${e.detail} ${e.action} ${activityDevice(e)}`).includes(q));
  const out = [...accessSection(), h('h3', { class: 'activity-head' }, 'People'),
    h('p', { class: 'muted activity-location-note' }, 'Locations are approximate. City names require Cloudflare’s “Add visitor location headers” Managed Transform.')];
  out.push(people.length ? h('ul', { class: 'rows' }, people.map((p) => h('li', { class: 'row' },
    h('span', { class: `activity-dot${Date.now() - p.at < 3 * 60000 ? ' is-on' : ''}`, 'aria-hidden': 'true' }),
    h('span', { class: 'row-text' },
      h('span', { class: 'row-title', title: p.user }, personName(p)),
      h('span', { class: 'row-meta' }, p.user.includes('@') && h('span', {}, p.user), h('span', {}, lastSeenText(p.at)), h('span', {}, activityDevice(p)))))))
    : h('p', { class: 'muted' }, 'Nobody yet.'));
  out.push(h('h3', { class: 'activity-head' }, 'What happened'));
  if (!events.length) out.push(h('p', { class: 'muted' }, q ? 'Nothing matches.' : 'Nothing has happened yet.'));
  let day = null;
  let list = null;
  for (const e of events) {
    const label = dayLabel(e.at);
    if (label !== day) {
      day = label;
      list = h('ul', { class: 'rows activity-list' });
      out.push(h('p', { class: 'activity-day' }, label), list);
    }
    list.append(h('li', { class: 'row activity-row' },
      h('span', { class: 'activity-time' }, clock(e.at)),
      h('span', { class: 'row-text' },
        h('span', { class: 'activity-text' }, h('strong', { title: e.user }, personName(e)), ' ', (ACTIVITY_TEXT[e.action] || ((d) => `${e.action} ${d}`))(e.subjectName || e.detail)),
        h('span', { class: 'row-meta' }, h('span', {}, activityDevice(e))))));
  }
  body.replaceChildren(...out);
}

function activityDevice(entry) {
  const loc = entry.location;
  let country = loc?.country || '';
  if (country) { try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(country); } catch { /* use country code */ } }
  return [entry.device, [loc?.city, country].filter(Boolean).join(', ') || 'Location unavailable'].filter(Boolean).join(' · ');
}

// ---------- house (server owner only) ----------
// The home server's own health plus the machines that report in (laptop, desktop): house.js.
async function loadHouse() {
  try { state.house = await api('/api/house'); state.houseError = null; } catch (err) { state.houseError = err.message; }
}

function meter(used, size) {
  const pct = size ? Math.round((100 * used) / size) : 0;
  return h('span', { class: `meter${pct >= 90 ? ' is-full' : ''}`, title: `${pct} % used` }, h('i', { style: `width:${pct}%` }));
}
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const upFor = (secs) => (secs >= 86400 ? `up ${Math.floor(secs / 86400)} d ${Math.floor((secs % 86400) / 3600)} h` : `up ${Math.floor(secs / 3600)} h ${Math.floor((secs % 3600) / 60)} min`);
function diskRows(disks, label = (d) => d.label || d.mount) {
  return disks.map((d) => h('div', { class: 'house-disk' },
    h('span', { class: 'house-disk-name' }, label(d)),
    meter(d.used, d.size),
    h('span', { class: 'house-disk-free' }, `${fmtBytes(d.size - d.used)} free`)));
}

function renderHouse() {
  const body = $('#house-body');
  if (state.houseError) { body.replaceChildren(notice('Couldn’t check the house', state.houseError, () => loadHouse().then(renderHouse))); return; }
  const r = state.house;
  if (!r) return;
  const q = norm(state.query);
  const out = [];
  out.push(r.issues.length
    ? h('div', { class: 'house-status has-issues' },
      h('strong', {}, r.issues.length === 1 ? '1 thing needs a look' : `${r.issues.length} things need a look`),
      h('ul', {}, r.issues.map((i) => h('li', {}, i))))
    : h('div', { class: 'house-status' }, h('strong', {}, 'Everything’s fine'), h('span', { class: 'muted' }, ` · checked ${clock(r.checkedAt)}`)));

  const sv = r.server;
  if (!q || norm(`server ${sv.name}`).includes(q)) {
    out.push(h('h3', { class: 'activity-head' }, 'Server'));
    out.push(h('div', { class: 'house-card' },
      h('div', { class: 'house-card-head' },
        h('span', { class: 'row-title' }, sv.name),
        h('span', { class: 'row-meta' }, h('span', {}, upFor(sv.uptime)), sv.cpu != null && h('span', {}, `CPU ${sv.cpu} %`),
          h('span', {}, `RAM ${fmtBytes(sv.mem.total - sv.mem.avail)} / ${fmtBytes(sv.mem.total)}`))),
      diskRows(sv.disks),
      h('ul', { class: 'house-services' }, sv.services.map((x) => h('li', {},
        h('span', { class: `activity-dot${x.ok ? ' is-on' : ' is-bad'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'house-svc-name' }, x.name), h('span', { class: 'muted' }, x.detail))))));
  }

  const powered = (r.power || []).filter((pw) => !q || norm(`power ${pw.host} ${pw.entries.map((e) => e.label).join(' ')}`).includes(q));
  if (powered.length) {
    out.push(h('h3', { class: 'activity-head' }, 'Power'));
    for (const pw of powered) out.push(powerCard(pw));
  }

  out.push(h('h3', { class: 'activity-head' }, 'Machines'));
  const machines = r.machines.filter((m) => !q || norm(`${m.host} ${m.kind} ${m.os}`).includes(q));
  if (!r.agents) out.push(h('p', { class: 'muted' }, 'Set HOUSE_TOKEN in .env and run agents/marquee-house on each machine to see them here.'));
  else if (!machines.length) out.push(h('p', { class: 'muted' }, q ? 'Nothing matches.' : 'No machine has reported yet.'));
  for (const m of machines) {
    const meta = [m.kind, m.os, m.kernel, m.uptime != null && upFor(m.uptime),
      m.battery && `battery ${m.battery.pct} %${m.battery.status && m.battery.status !== 'Unknown' ? ` (${m.battery.status.toLowerCase()})` : ''}`,
      m.updates ? `${m.updates} updates` : m.updates === 0 && 'up to date',
      m.secureBoot != null && `Secure Boot ${m.secureBoot ? 'on' : 'OFF'}`,
      m.lastBackup ? `backup ${ago(m.lastBackup * 1000)}` : 'no backups'].filter(Boolean);
    out.push(h('div', { class: `house-card${m.away ? ' is-away' : ''}` },
      h('div', { class: 'house-card-head' },
        h('span', { class: `activity-dot${m.away ? '' : m.issues.length ? ' is-bad' : ' is-on'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'row-title' }, m.host),
        h('span', { class: 'muted house-seen' }, m.away ? `away · last seen ${ago(m.at)}` : `reported ${ago(m.at)}`)),
      h('div', { class: 'row-meta' }, meta.map((t) => h('span', {}, t))),
      diskRows(m.disks, (d) => d.mount),
      m.failed.length > 0 && h('p', { class: 'house-failed' }, `Failed: ${m.failed.join(', ')}`)));
  }
  body.replaceChildren(...out);
}

// Wake a dual-boot machine into the system you pick, or restart it into another one (house.js,
// "power"). Waking into Windows boots Linux first, which hands over to Windows within a few seconds.
function powerCard(pw) {
  const p = pw.pending;
  const status = p
    ? (p.action === 'wake' ? `Waking up${p.label ? ` into ${p.label}` : ''}…` : `Restarting${p.label ? ` into ${p.label}` : ''}…`)
    : pw.on ? `On · ${pw.os || 'Linux'}` : 'Off, or in Windows';
  const sub = !pw.on && !p && (pw.last?.entry && pw.last.at > pw.seen - 120000
    ? `Last started into ${pw.last.label} from Marquee ${ago(pw.last.at)}`
    : `Linux last answered ${ago(pw.seen)}`);
  const linuxFirst = [...pw.entries].sort((a, b) => (a.os === 'linux' ? 0 : 1) - (b.os === 'linux' ? 0 : 1));
  let buttons;
  if (pw.on) {
    // restarting is disruptive (a game might be running): two taps, like deleting a clip
    const sure = (label, entry) => h('button', {
      type: 'button', class: 'retry', disabled: Boolean(p),
      onclick: (e) => {
        const b = e.currentTarget;
        if (b.dataset.sure) { doPower(pw.host, 'restart', entry, b); return; }
        b.dataset.sure = '1';
        b.classList.add('is-sure');
        b.textContent = 'Tap again to restart';
        setTimeout(() => { if (b.isConnected && !b.disabled) { delete b.dataset.sure; b.classList.remove('is-sure'); b.textContent = label; } }, 4000);
      },
    }, label);
    buttons = [...linuxFirst.filter((e) => !e.current).map((e) => sure(`Restart into ${e.label}`, e.title)), sure('Restart', null)];
  } else {
    buttons = linuxFirst.map((e) => h('button', {
      type: 'button', class: `retry${e.os === 'linux' ? ' is-primary' : ''}`, disabled: !pw.canWake || p?.action === 'wake',
      onclick: (ev) => doPower(pw.host, 'wake', e.title, ev.currentTarget),
    }, `Start ${e.label}`));
    if (!buttons.length) buttons = [h('button', { type: 'button', class: 'retry is-primary', disabled: !pw.canWake, onclick: (ev) => doPower(pw.host, 'wake', null, ev.currentTarget) }, 'Turn on')];
  }
  return h('div', { class: 'house-card power-card' },
    h('div', { class: 'house-card-head' },
      h('span', { class: `activity-dot${pw.on ? ' is-on' : ''}`, 'aria-hidden': 'true' }),
      h('span', { class: 'row-title' }, pw.host),
      h('span', { class: 'muted house-seen' }, status)),
    sub && h('p', { class: 'muted power-sub' }, sub),
    h('div', { class: 'power-actions' }, buttons),
    pw.notes.map((n) => h('p', { class: 'house-failed' }, n)));
}

async function doPower(host, action, entry, btn) {
  btn.disabled = true;
  try {
    const r = await api('/api/house/power', jsonPost({ host, action, entry }));
    toast(r.message);
  } catch (err) { toast(err.message); }
  await loadHouse();
  if (state.view === 'house') renderHouse();
}

// ---------- clips (server owner only) ----------
// Game clips from the desktop (clips.js). Sharing makes a public /c/ link that embeds in Discord.
async function loadClips() {
  try { state.clips = await api('/api/clips'); state.clipsError = null; } catch (err) { state.clipsError = err.message; }
}

async function shareClip(c, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/clips/${c.id}/share`, { method: 'POST' });
    c.share = r;
    c.shareUrl = r.url;
    if (r.ready) await copyLink(r.url);
    else toast('Preparing a Discord-friendly copy… the link is ready in a minute.');
  } catch (err) { toast(err.message); }
  await loadClips();
  renderClips();
}
const copyLink = (url) => copyWithToast(url, 'Link copied: paste it in Discord');
// ---------- clip trimmer (lossless: the server copies, never re-encodes) ----------
const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
async function openTrim(c, opener) {
  const video = h('video', { class: 'trim-video', src: `/api/clips/${c.id}/video`, controls: true, playsinline: true, preload: 'auto' });
  const info = h('p', { class: 'muted trim-info' }, 'Loading keyframes…');
  const startOut = h('strong', {}, '0:00.0');
  const endOut = h('strong', {}, '…');
  const delOrig = h('input', { type: 'checkbox', id: 'trim-del' });
  const save = h('button', { class: 'play-btn trim-save', disabled: true }, 'Save trimmed copy');
  let keys = [0];
  let start = 0;
  let end = null;
  // what the server will actually do: start at the keyframe at or before the chosen point
  const snap = (t) => keys.filter((k) => k <= t + 0.001).pop() ?? 0;
  const show = () => {
    const from = snap(start);
    startOut.textContent = fmtT(from);
    endOut.textContent = end == null ? '…' : fmtT(end);
    const ok = end != null && end - from >= 1;
    save.disabled = !ok;
    info.textContent = !ok ? 'Scrub the video, then set the start and the end (at least 1 s apart).'
      : `${fmtT(end - from)} long${from < start - 0.05 ? ` · starts ${(start - from).toFixed(1)} s early, on the nearest keyframe` : ''} · no re-encoding, same quality`;
  };
  const preview = async () => {
    const from = snap(start);
    video.currentTime = from;
    await video.play().catch(() => {});
    const stop = () => { if (end != null && video.currentTime >= end) { video.pause(); video.removeEventListener('timeupdate', stop); } };
    video.addEventListener('timeupdate', stop);
  };
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const r = await api(`/api/clips/${c.id}/trim`, jsonPost({ start, end, deleteOriginal: delOrig.checked }));
      toast(`Saved “${r.title}”`);
      closeTopOverlay();
      await loadClips();
      renderClips();
    } catch (err) {
      toast(err.message);
      save.textContent = 'Save trimmed copy';
      show();
    }
  });
  $('#sheet-body').replaceChildren(h('div', { class: 'sheet-content trim' },
    h('h2', { id: 'sheet-title' }, `Trim · ${c.title}`),
    video,
    h('div', { class: 'trim-marks' },
      h('button', { class: 'retry', onclick: () => { start = video.currentTime; if (end != null && end <= start) end = null; show(); } }, 'Start here'),
      h('span', { class: 'trim-range' }, startOut, ' → ', endOut),
      h('button', { class: 'retry', onclick: () => { end = video.currentTime; show(); } }, 'End here')),
    info,
    h('div', { class: 'trim-actions' },
      h('button', { class: 'retry', onclick: preview }, 'Preview'),
      save),
    h('label', { class: 'trim-del', for: 'trim-del' }, delOrig, ' Move the original to Deleted afterwards (kept 30 days)')));
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => { video.pause(); video.removeAttribute('src'); video.load(); opener?.focus({ preventScroll: true }); }));
  video.addEventListener('loadedmetadata', () => { if (end == null) { end = video.duration; show(); } }, { once: true });
  try {
    const k = await api(`/api/clips/${c.id}/keyframes`);
    keys = k.keyframes.length ? k.keyframes : [0];
    if (end == null && k.duration) end = k.duration;
    show();
  } catch (err) { info.textContent = `Couldn’t read the clip: ${err.message}`; }
}

async function deleteClip(c) {
  try {
    await api(`/api/clips/${c.id}/delete`, { method: 'POST' });
    toast(`Deleted ${c.title}`);
  } catch (err) { toast(err.message); }
  await loadClips();
  renderClips();
}
async function unshareClip(c) {
  try { await api(`/api/clips/${c.id}/unshare`, { method: 'POST' }); toast('Link removed'); } catch (err) { toast(err.message); }
  await loadClips();
  renderClips();
}

const UNLINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 7.8 16.2a3 3 0 0 1-4.2-4.2l2.6-2.6a3 3 0 0 1 4.2 0M14.5 9.5l1.7-1.7a3 3 0 0 1 4.2 4.2l-2.6 2.6a3 3 0 0 1-4.2 0M4 4l16 16"/></svg>';
function clipCard(c) {
  const when = new Date(c.mtime).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const thumb = h('button', { class: 'clip-thumb', 'aria-label': `Play ${c.title}` },
    h('img', { src: `/api/clips/${c.id}/thumb.jpg`, alt: '', loading: 'lazy' }));
  thumb.insertAdjacentHTML('beforeend', `<span class="clip-play">${ICONS.play}</span>`);
  thumb.addEventListener('click', () => {
    thumb.replaceWith(h('video', { class: 'clip-video', src: `/api/clips/${c.id}/video`, controls: true, autoplay: true, playsinline: true }));
  });
  const s = c.share;
  const link = s && `${location.origin}/c/${s.token}`;
  let actions;
  if (!s) actions = [h('button', { class: 'retry', onclick: (e) => shareClip(c, e.currentTarget) }, 'Share')];
  else if (s.error) actions = [h('span', { class: 'muted clip-error' }, `Couldn’t prepare it: ${s.error}`), h('button', { class: 'retry', onclick: (e) => shareClip(c, e.currentTarget) }, 'Try again')];
  else if (!s.ready) actions = [h('span', { class: 'muted clip-working' }, 'Preparing for Discord…')];
  // the label hides on narrow cards (style.css), leaving the copy icon; aria-label keeps the name
  else actions = [h('button', { class: 'retry clip-copy', 'aria-label': 'Copy link', title: 'Copy link', onclick: () => copyLink(link) }, icon('copy'), h('span', { class: 'clip-btn-label' }, 'Copy link'))];
  if (s) actions.push(h('button', { class: 'icon-btn clip-unshare', 'aria-label': 'Stop sharing', title: 'Stop sharing (the link stops working)', onclick: () => unshareClip(c) }));
  // two taps: the first turns the bin into "Delete?", the second deletes (it waits 30 days in .deleted)
  const del = h('button', {
    class: 'icon-btn clip-delete', 'aria-label': `Delete ${c.title}`, title: 'Delete clip',
    onclick: (e) => {
      const b = e.currentTarget;
      if (b.dataset.sure) { b.disabled = true; deleteClip(c); return; }
      b.dataset.sure = '1';
      b.classList.add('is-sure');
      b.textContent = 'Delete?';
      setTimeout(() => { if (b.isConnected && !b.disabled) { delete b.dataset.sure; b.classList.remove('is-sure'); b.innerHTML = ICONS.trash; } }, 4000);
    },
  });
  actions.push(h('button', { class: 'icon-btn clip-trim', 'aria-label': `Trim ${c.title}`, title: 'Trim (no quality loss)', onclick: (e) => openTrim(c, e.currentTarget) }));
  actions.push(del);
  const card = h('li', { class: 'clip' }, thumb,
    h('div', { class: 'clip-text' },
      h('div', { class: 'row-title' }, c.title),
      h('div', { class: 'row-meta' }, h('span', {}, c.game), h('span', {}, when), h('span', {}, fmtBytes(c.size)), s?.ready && h('span', { class: 'clip-shared' }, 'shared'))),
    h('div', { class: 'clip-actions' }, actions));
  const un = $('.clip-unshare', card);
  if (un) un.innerHTML = UNLINK_ICON;
  $('.clip-delete', card).innerHTML = ICONS.trash;
  $('.clip-trim', card).innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.5 20 18M8.6 16.5 20 6"/></svg>';
  return card;
}

function renderClips() {
  const body = $('#clips-body');
  if (state.clipsError) { body.replaceChildren(notice('Couldn’t load clips', state.clipsError, () => loadClips().then(renderClips))); return; }
  if (!state.clips) return;
  if (!state.clips.configured) { body.replaceChildren(notice('No clips folder', 'Set CLIPS_DIR in .env to the folder your desktop syncs clips to.')); return; }
  const q = norm(state.query);
  const list = state.clips.clips.filter((c) => !q || norm(`${c.title} ${c.game}`).includes(q));
  if (!list.length) { body.replaceChildren(h('p', { class: 'muted' }, q ? 'Nothing matches.' : 'No clips yet.')); return; }
  const out = [];
  let game = null;
  let grid = null;
  for (const c of [...list].sort((a, b) => a.game.localeCompare(b.game) || b.mtime - a.mtime)) {
    if (c.game !== game) {
      game = c.game;
      grid = h('ul', { class: 'clip-grid' });
      out.push(h('h3', { class: 'activity-head' }, game), grid);
    }
    grid.append(clipCard(c));
  }
  body.replaceChildren(...out);
}

function addAdminTab(view, label, iconSvg) {
  if ($(`#view-${view}`)) return;
  $('#main').append(h('section', { id: `view-${view}`, class: 'view', 'aria-labelledby': `${view}-heading`, hidden: true },
    h('h2', { class: 'view-heading', id: `${view}-heading` }, label),
    h('div', { id: `${view}-body` })));
  const tab = h('button', { class: 'tab', 'data-view': view });
  tab.innerHTML = `${iconSvg}<span>${label}</span>`;
  tab.addEventListener('click', () => setView(view));
  $('.tabs').insertBefore(tab, $('.tab[data-view="settings"]')); // Settings stays last
}
const enableHouseTab = () => addAdminTab('house', 'House', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/></svg>');
const enableClipsTab = () => addAdminTab('clips', 'Clips', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/></svg>');

// Adds the Activity tab for the server's owner (ADMIN_EMAILS in .env).
function enableActivityTab() {
  if ($('#view-activity')) return;
  $('#main').append(h('section', { id: 'view-activity', class: 'view', 'aria-labelledby': 'activity-heading', hidden: true },
    h('h2', { class: 'view-heading', id: 'activity-heading' }, 'Activity'),
    h('div', { id: 'activity-body' })));
  const tab = h('button', { class: 'tab', 'data-view': 'activity' });
  tab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 13.8c1.8.7 3 2.6 3 5.2"/></svg><span>Activity</span>';
  tab.addEventListener('click', () => setView('activity'));
  $('.tabs').insertBefore(tab, $('.tab[data-view="settings"]'));
}

input.addEventListener('input', () => {
  if (state.view === 'settings') { const q = input.value; setView('discover').then(() => { input.value = state.query = q; renderDiscover(); }); return; }
  state.query = input.value;
  $('#q-clear').hidden = !input.value;
  if (state.view === 'discover') {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderDiscover, 300);
  } else {
    renderView();
  }
});
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  if (state.view === 'discover') renderDiscover();
  input.blur(); // hides the phone keyboard
});
$('#q-clear').addEventListener('click', () => {
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.focus();
});

async function setView(view) {
  if (view === state.view) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.view === view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  input.value = state.query = '';
  $('#q-clear').hidden = true;
  input.placeholder = PLACEHOLDERS[view];
  window.scrollTo(0, 0);

  renderView(); // render cached data, then refresh
  if (view === 'library') await Promise.all([loadLibrary(), loadConvert()]);
  if (view === 'downloads') await loadDownloads();
  if (view === 'activity') await loadActivity();
  if (view === 'house') await loadHouse();
  if (view === 'clips') await loadClips();
  if (view === 'settings') await Promise.all([loadLibrary(), state.me?.isOwner ? loadPeople() : null]);
  if (state.view === view) renderView();
  schedulePoll();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$('#home-link').addEventListener('click', async (e) => {
  e.preventDefault();
  disc.list = null; disc.genre = null;
  state.query = ''; input.value = ''; $('#q-clear').hidden = true;
  if (state.view === 'discover') { await renderDiscover(); window.scrollTo({ top: 0 }); }
  else await setView('discover');
});
$('#find-torrents').addEventListener('click', (e) => openTorrents({ query: state.query.trim(), opener: e.currentTarget }));

// ---------- start ----------
(async function init() {
  try {
    state.status = await api('/api/status');
  } catch {
    $('#discover-body').replaceChildren(notice('Can’t reach the server', 'Make sure server.js is running, then reload this page.', () => location.reload()));
    return;
  }
  state.me = state.status.me;
  state.rules = state.status.rules;
  applyTheme(prefs().theme);
  $('#find-torrents').hidden = !state.status.torrents || !canDownload();
  if (state.status.admin) { enableActivityTab(); enableHouseTab(); }
  if (state.status.clips) enableClipsTab();
  await Promise.all([loadLibrary(), loadDownloads(), loadSessions(), loadProgress()]);
  const start = prefs().startView;
  if (start && start !== 'discover') { state.view = null; await setView(start); } else renderDiscover();
  const watchToken = new URL(location.href).searchParams.get('watch');
  if (watchToken) await offerWatchRoom(watchToken);
  schedulePoll();
})();
