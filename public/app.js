// Marquee web client. Plain ES modules, no build step.
import { T, lang, langTag, locale, LANGUAGES, saveLanguage, translatePage } from './i18n.js';
import { WatchSession, offsetCues } from './watch-sync.js';
import { createNotesView } from './notes-view.js';
import { nextLibraryEpisode, isNextEpisodeTime, AUTOPLAY_SECONDS, AUTOPLAY_CHAIN, tvIntroShowing, tvNextShowing, tvFinished } from './player-next.js';
import { audioChoices, nativeAudioMapping } from './player-audio.js';
import { createSeekPreview } from './seek-preview.js';
import * as pushDevice from './notifications.js';
import { createStreamStats } from './player-stats.js';
import { SUB_SIZES, SUB_BACKGROUNDS, SUB_POSITIONS, subLook, subRaise, secondChoices, createNightAudio,
  SLEEP_MINUTES, sleepTimer, sleepSecondsLeft, sleepFade, sleepLabel } from './player-comfort.js';
import { comingUp, newEpisodes, watchStatus, todayIso } from './watchlist.js';
import { travelTitle, sizeWords, stateWords, travelSummary, travelOrder } from './travel.js';
import { libraryUnion, libraryAvailability, filterLibrary, transferState, transferAttention, transferPaused } from './library-downloads.js';
import { createSocial, titleKeyOf, REACTIONS, countdownText, startLabel, namesText } from './social.js';
import { createPeople } from './people.js';

translatePage();
saveLanguage(lang);
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
  skip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l8 7-8 7zM14 5l8 7-8 7z"/></svg>',
  tv: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M10 4h4M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v6M14 11v6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M12 2V1"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  upgrade: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V9M7 14l5-5 5 5M5 4h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.2"/><path d="M12 6.5v7M9.2 10.8l2.8 2.8 2.8-2.8M10.5 18h3"/></svg>',
  volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>',
  volumeHigh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  back10: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M6.5 3v3.9h3.9"/><text x="12.2" y="15.2" text-anchor="middle">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M17.5 3v3.9h-3.9"/><text x="11.8" y="15.2" text-anchor="middle">10</text></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  fullscreenExit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  party: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9.5" r="2.3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M14.5 15.2A4.3 4.3 0 0 1 21 18.5"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.2"/></svg>',
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.5 3 8l5 4 4-6 4 6 5-4-1 9.5z"/></svg>',
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

// This page only: live updates (see connectLive) skip changes this page already shows itself.
const TAB_ID = Math.random().toString(36).slice(2, 12);
async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { ...opts.headers, 'X-Marquee-Client': CLIENT_ID, 'X-Marquee-Tab': TAB_ID, 'X-Marquee-Lang': lang } });
  } catch (err) {
    if (err.name !== 'AbortError' && await signedOut()) throw new Error(T('You’ve been signed out. Sign in again to carry on.'));
    throw err;
  }
  let data = {};
  try { data = await r.json(); } catch { /* non-JSON */ }
  if (r.status === 401 && data.signin) { toSignIn(); throw Object.assign(new Error(T('Sign in to carry on.')), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(data.error || T('The server responded with {0}.', r.status)), { status: r.status });
  return data;
}

// Marquee's own sign-in (auth.js): a 401 with `signin` means this browser needs to sign in.
function toSignIn() {
  location.assign(`/signin?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
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
      h('p', {}, h('strong', {}, T('You’ve been signed out.')), T(' Your sign-in ran out; sign in again to carry on where you were.')),
      h('button', { class: 'play-btn', onclick: () => location.reload() }, T('Sign in again'))));
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
  if (s < 60) return T('under a minute left');
  if (s < 3600) return T('{0} min left', Math.round(s / 60));
  const hrs = Math.floor(s / 3600);
  return T('{0} h {1} min left', hrs, Math.round((s % 3600) / 60));
}
function fmtTime(s) {
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
}
function fmtAgo(ms) {
  if (!ms) return null;
  const days = (Date.now() - ms) / 86400000;
  if (days < 1) return T('today');
  if (days < 2) return T('yesterday');
  if (days < 45) return T('{0} days ago', Math.round(days));
  if (days < 365) return T('{0} months ago', Math.round(days / 30));
  const yrs = Math.round(days / 365);
  return (yrs > 1 ? T('{0} years ago', yrs) : T('{0} year ago', yrs));
}
const pad2 = (n) => String(n).padStart(2, '0');
const episodeLabel = (f) => (f.season != null ? f.episode != null ? T('S{0} E{1}', pad2(f.season), pad2(f.episode)) : T('Season {0}', f.season) : null);
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
  libAvailability: 'all',
};
const canDownload = () => state.status.downloads && state.me?.canDownload !== false;
const prefs = () => state.me?.settings || {};

// Local files (library + finished downloads) that belong to a TMDB title.
// ---------- versions (src/versions.js) ----------
// Two files of one film or episode (a 4K and a 1080p) arrive from the server as one item with
// `versions`, best first. Which one plays here: the one you picked for the title, else the one you
// picked for its season (matched by quality and source, so one choice covers a season pack), else
// the best one, or on a phone the lightest 720p/1080p one. Picks are kept per device.
const VERSION_PICKS = 'marquee:versions';
let versionPicks = {};
try { versionPicks = JSON.parse(localStorage.getItem(VERSION_PICKS)) || {}; } catch { /* blocked */ }
const versionSeasonKey = (f) => (/^ep:/.test(f?.versionKey || '') ? f.versionKey.replace(/^ep:/, 'season:').replace(/:\d+$/, '') : null);
function chooseVersion(list) {
  const picked = list.find((v) => v.mediaKey === versionPicks[list[0].versionKey]);
  if (picked) return picked;
  const season = versionSeasonKey(list[0]);
  const bySeason = season && list.find((v) => v.versionSignature === versionPicks[season]);
  if (bySeason) return bySeason;
  if (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600) {
    return [...list].reverse().find((v) => ['720p', '1080p'].includes(v.versionQuality)) || list.at(-1);
  }
  return list[0];
}
// Deleted files leave at once: a title keeps its other versions.
function dropFromLibrary(ids) {
  const gone = new Set(ids);
  const items = (state.libraryItems || state.library).flatMap((x) => {
    if (!(x.versions?.length > 1)) return gone.has(x.id) ? [] : [x];
    const left = x.versions.filter((v) => !gone.has(v.id));
    return !left.length ? [] : left.length === 1 ? [left[0]] : [{ ...left[0], versions: left }];
  });
  state.libraryItems = items;
  state.library = items.map(applyVersion);
}
const applyVersion = (item) => (item.versions?.length > 1 ? { ...chooseVersion(item.versions), versions: item.versions } : item);
// Every file behind these items (all versions), for deleting or keeping a whole title or season.
const allVersions = (files) => files.flatMap((f) => (f.versions?.length > 1 ? f.versions : [f]));
// season: the choice applies to the whole season (and replaces per-episode choices in it).
function setVersionPick(f, v, { season = false } = {}) {
  const sk = versionSeasonKey(f);
  if (season && sk) {
    versionPicks[sk] = v.versionSignature;
    const prefix = sk.replace(/^season:/, 'ep:') + ':';
    for (const k of Object.keys(versionPicks)) if (k.startsWith(prefix)) delete versionPicks[k];
  } else if (f.versionKey) versionPicks[f.versionKey] = v.mediaKey;
  const keys = Object.keys(versionPicks);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete versionPicks[k];
  try { localStorage.setItem(VERSION_PICKS, JSON.stringify(versionPicks)); } catch { /* blocked */ }
  state.library = (state.libraryItems || state.library).map(applyVersion);
  updateUpNext();
}
// A season where episodes have versions: one choice for all of them, by quality and source
// ("4K · WEB-DL" / "1080p · BluRay"); episodes without that version keep theirs.
function seasonVersionPick(ready, onPicked) {
  const versioned = ready.filter((f) => f.versions?.length > 1);
  if (!versioned.length) return null;
  const options = new Map();
  for (const v of versioned.flatMap((f) => f.versions)) {
    if (!options.has(v.versionSignature)) options.set(v.versionSignature, v.versionLabel.replace(/ · [\d.]+ [GM]B$/, ''));
  }
  if (options.size < 2) return null;
  const counts = new Map();
  for (const f of versioned) counts.set(f.versionSignature, (counts.get(f.versionSignature) || 0) + 1);
  const current = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const n = versioned.length;
  return h('div', { class: 'season-versions' }, versionSelect({
    id: `ver-${versionSeasonKey(versioned[0])}`, label: T('Quality for this season'),
    options: [...options].map(([value, label]) => ({ value, label })), value: current,
    onPick: (sig) => { setVersionPick(versioned[0], { versionSignature: sig }, { season: true }); patchUnifiedLibrary(); onPicked(); },
  }), h('p', { class: 'muted version-hint' }, T('{0} more than one version. Your choice is remembered on this device.', plural(n, T('episode has'), T('episodes have')))));
}
// A film with versions: which one Play starts.
function filmVersionPick(t, onPicked) {
  const f = matchesFor(t).find((x) => x.kind === 'lib' && x.versions?.length > 1);
  if (!f) return null;
  return versionSelect({
    id: `ver-${f.versionKey}`, options: f.versions.map((v) => ({ value: v.mediaKey, label: v.versionLabel })), value: f.mediaKey,
    onPick: (key) => { setVersionPick(f, f.versions.find((v) => v.mediaKey === key)); patchUnifiedLibrary(); onPicked(); },
  });
}
// A small "Quality" select for a title or a season with versions. options: [{ value, label }].
function versionSelect({ id, label = T('Quality'), options, value, onPick }) {
  const sel = h('select', { class: 'sub-select version-select', id },
    options.map((o) => h('option', { value: o.value }, o.label)));
  sel.value = value;
  sel.addEventListener('change', () => onPick(sel.value));
  return h('div', { class: 'version-pick' }, h('label', { for: id }, label), sel);
}

function localFiles() {
  return [
    ...state.library.map((f) => ({ ...f, kind: 'lib', key: f.id, done: true })),
    ...state.downloads.filter((d) => d.mine !== false).map((d) => ({ ...d, title: d.canonicalTitle || d.title, show: d.showId || d.show, kind: 'dl', key: d.hash, file: d.name })),
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
    if (f.mediaType === 'tv' && f.tmdbId != null) return Number(f.tmdbId) === Number(t.id);
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
  midnight: { name: T('Midnight'), bg: '#0E1320', surface: '#161D2E', raised: '#1F2840', line: '#2A3552', text: '#E8EEF8', muted: '#96A3BD', accent: '#5CC8FF', alert: '#FF8A8A' },
  forest: { name: T('Forest'), bg: '#0F1A14', surface: '#16241C', raised: '#1E3127', line: '#2A4134', text: '#E9F2EA', muted: '#9DB5A4', accent: '#9BE07A', alert: '#FF9B85' },
  ember: { name: T('Ember'), bg: '#161312', surface: '#221D1B', raised: '#2E2724', line: '#3D3430', text: '#F5EDE8', muted: '#B3A49C', accent: '#FF7A3D', alert: '#FF8A8A' },
  lagoon: { name: T('Lagoon'), bg: '#0B1A1C', surface: '#112629', raised: '#183337', line: '#22444A', text: '#E3F4F4', muted: '#93B8BA', accent: '#3DDBC4', alert: '#FF9B85' },
  synth: { name: T('Synthwave'), bg: '#140F24', surface: '#1D1633', raised: '#281E45', line: '#352858', text: '#F0EAFF', muted: '#A99BC9', accent: '#FF5FA2', alert: '#FFB36B' },
  noir: { name: T('Noir'), bg: '#111111', surface: '#1B1B1B', raised: '#262626', line: '#333333', text: '#F2F2F2', muted: '#A0A0A0', accent: '#E8E8E8', alert: '#FF8A8A' },
  paper: { name: T('Paper'), bg: '#F7F2EA', surface: '#FFFDF9', raised: '#EFE7DB', line: '#DDD2C2', text: '#241A14', muted: '#6E6157', accent: '#C2410C', alert: '#B42318' },
  daylight: { name: T('Daylight'), bg: '#F2F5FA', surface: '#FFFFFF', raised: '#E5EBF4', line: '#D2DAE7', text: '#141B2B', muted: '#5A6478', accent: '#2563EB', alert: '#C0262D' },
};
const THEME_FIELDS = [['bg', T('Background')], ['surface', T('Panels')], ['text', T('Text')], ['accent', T('Accent')]];

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
    name: T('Custom'), bg, surface, text, accent,
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
    retry && h('button', { class: 'retry', onclick: retry }, T('Try again')));
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
  // Versions share one watch position (the server saves it on all of them): the newest one counts.
  const synced = (f.versions?.length > 1 ? f.versions.map((v) => state.progress[progressRef(v)]).filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0))[0] : null) || state.progress[progressRef(f)];
  if (synced) return synced;
  try { return JSON.parse(localStorage.getItem(resumeKey(f))); } catch { return null; }
}
async function loadProgress() {
  try { state.progress = (await api('/api/me/progress')).progress || {}; } catch { /* local copy only */ }
}

// ---------- Save for later and Follow (watchlist.js; the server downloads, src/watchlist.js) ----------
const watch = { items: [], autoDownload: false, revision: 0 };
const watchItem = (type, id) => watch.items.find((i) => i.type === type && i.id === Number(id)) || null;
async function loadWatchlist() {
  if (!state.status.search) return;
  try { Object.assign(watch, await api('/api/watchlist')); watch.revision++; } catch { return; }
  refreshWatchViews();
}
// Every place that shows the list: Save / Follow boxes in open sheets, the shelves, New badges.
function refreshWatchViews() {
  document.querySelectorAll('.watch-box').forEach((box) => box._update?.());
  if (state.view === 'library') renderLibrary();
  if (state.view === 'discover' && !state.query.trim() && !disc.list && !disc.genre) refreshSavedShelf();
}
async function setWatch(t, flags) {
  const { item } = await api('/api/watchlist', jsonPost({ type: t.type, tmdbId: t.id, ...flags }));
  watch.items = watch.items.filter((i) => !(i.type === t.type && i.id === Number(t.id)));
  if (item) watch.items.unshift(item);
  watch.revision++;
  refreshWatchViews();
  return item;
}
// Save (any title), Follow (shows) and the automatic-download switch, with one status line.
function watchBox(t) {
  const isTv = t.type === 'tv';
  const box = h('div', { class: 'watch-box' });
  let busy = false;
  const act = async (flags, what) => {
    if (busy) return;
    busy = true; box.classList.add('is-busy');
    try {
      const item = await setWatch(t, flags);
      if (what) toast(what(item));
    } catch (err) { toast(err.message); } finally { busy = false; box.classList.remove('is-busy'); box._update(); }
  };
  box._update = () => {
    if (!box.isConnected && box._drawn) return;
    box._drawn = true;
    const item = watchItem(t.type, t.id);
    const saved = Boolean(item?.saved), follow = Boolean(item?.follow);
    const auto = Boolean(item?.auto) && watch.autoDownload;
    const inLibrary = !isTv && matchesFor(t).some((f) => f.done);
    const save = h('button', { type: 'button', class: `chip watch-toggle${saved ? ' is-on' : ''}`, 'aria-pressed': String(saved),
      onclick: () => act({ saved: !saved }, (i) => (i?.saved ? T('Saved for later') : T('Removed from Saved'))) }, icon('bookmark'), saved ? T('Saved') : T('Save'));
    const followBtn = isTv && h('button', { type: 'button', class: `chip watch-toggle${follow ? ' is-on' : ''}`, 'aria-pressed': String(follow),
      onclick: () => act({ follow: !follow }, (i) => (i?.follow ? (i.auto ? T('Following. New episodes arrive as they air.') : T('Following')) : T('Stopped following'))) },
      icon('bell'), follow ? T('Following') : T('Follow'));
    // Films: wait for the release. Shows: new episodes as they air (only while following).
    const offerAuto = watch.autoDownload && (isTv ? follow : saved && !inLibrary && item?.state !== 'got');
    const autoSwitch = offerAuto && h('label', { class: 'watch-auto' },
      h('input', { type: 'checkbox', checked: auto, onchange: (e) => act({ auto: e.currentTarget.checked }) }),
      h('span', {}, isTv ? T('Add new episodes as they air') : T('Add it when a good copy is out')));
    const line = watchStatus(item, { today: todayIso(), autoDownload: watch.autoDownload, inLibrary });
    box.replaceChildren(...[h('div', { class: 'watch-buttons' }, save, followBtn), autoSwitch, line && h('p', { class: 'watch-status', role: 'status' }, line)].filter(Boolean));
  };
  box._update();
  return box;
}

// Discover: your saved titles first, as their own row.
function savedShelf() {
  const items = watch.items.filter((i) => i.saved && (disc.type === 'all' || disc.type === i.type));
  if (!items.length) return h('div', { class: 'saved-shelf', hidden: true });
  const list = h('ul', { class: 'shelf-items', tabindex: '0', 'aria-label': T('Saved for later') }, items.map(titleCard));
  const node = carousel(T('Saved for later'), list);
  node.classList.add('saved-shelf');
  return node;
}
function refreshSavedShelf() {
  const old = $('#discover-body .saved-shelf');
  if (old) old.replaceWith(savedShelf());
}

// Library: the next episode of each followed show and the release of each saved film, soonest first.
function comingUpShelf() {
  const list = comingUp(watch.items, todayIso())
    .filter((c) => state.libFilter === 'all' || state.libFilter === c.item.type)
    .filter((c) => !state.query.trim() || norm(c.item.title).includes(norm(state.query))).slice(0, 20);
  if (!list.length) return null;
  return libraryShelf(T('Coming up'), list.map((c) => h('li', { class: 'library-card continue-card coming-card' },
    h('button', { type: 'button', class: 'title-card', onclick: (e) => openDetails(c.item, e.currentTarget) },
      (() => { const art = wideArt([c.item.backdrop, { src: c.item.poster, contain: true }], '', CONTINUE_SIZES); art.append(h('span', { class: 'coming-date' }, c.when)); return art; })(),
      h('div', { class: 'name' }, c.item.title),
      h('div', { class: 'sub' }, c.what)))), 'continue-shelf coming-shelf');
}
// "3 new" on a followed show's card, for episodes that downloaded by themselves since you last opened it.
function newBadgeCount(entry) {
  const id = entry.show?.tmdbId;
  return id ? newEpisodes(watchItem('tv', id), entry.files) : 0;
}
function markShowSeen(tmdbId) {
  const item = watchItem('tv', tmdbId);
  if (!item?.newEpisodes?.length) return;
  item.newEpisodes = [];
  watch.revision++;
  api('/api/watchlist/seen', jsonPost({ tmdbId })).catch(() => {});
  if (state.view === 'library') renderLibrary();
}

// ---------- auto-delete countdown ----------
// Videos in your library are deleted a set time after they finish downloading (the owner's setting,
// 7 days unless changed). The countdown shows on each one, with a button to keep it longer.
function timeLeft(ms) {
  const hours = (ms - Date.now()) / 3600000;
  if (hours <= 0) return T('Deleting soon');
  if (hours < 1) return T('Deleted within the hour');
  if (hours < 48) return T('{0} h left', Math.floor(hours));
  return T('{0} days left', Math.round(hours / 24));
}
const canExtend = (f) => f.expiresAt != null && (!state.rules?.maxExtensions || (f.extensions || 0) < state.rules.maxExtensions);
const extendDays = () => state.rules?.extendDays || 7;

// The "4 days left · Keep 7 more days" part of a row's meta line. Re-renders itself after extending.
function expiryBits(f) {
  if (f.expiresAt == null) return null;
  const soon = f.expiresAt - Date.now() < 86400000;
  const wrap = h('span', { class: 'expiry-wrap' },
    h('span', { class: `expiry${soon ? ' is-soon' : ''}`, title: T('Deletes {0}', new Date(f.expiresAt).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) }, timeLeft(f.expiresAt)),
    canExtend(f) && h('button', {
      type: 'button', class: 'keep-btn', 'aria-label': T('Keep {0}{1} {2} more days', f.title, episodeLabel(f) ? ` ${episodeLabel(f)}` : '', extendDays()),
      onclick: async (e) => {
        e.stopPropagation();
        const b = e.currentTarget;
        b.disabled = true;
        const [updated] = await extendItems([f]);
        if (updated) wrap.replaceWith(expiryBits({ ...f, ...updated }) || '');
        else b.disabled = false;
      },
    }, T('Keep {0} more days', extendDays())));
  return wrap;
}

// Pushes back when these library videos are deleted. Returns the updated items (or [] on failure).
async function extendItems(files) {
  try {
    const { entries } = await api('/api/library/extend', jsonPost({ ids: [...new Set(allVersions(files).map((f) => f.id || f.key))] }));
    const byKey = new Map(entries.map((e) => [e.key, e]));
    for (const f of state.library) {
      const e = byKey.get(f.mediaKey);
      if (e) Object.assign(f, { expiresAt: e.expiresAt, extensions: e.extensions });
      for (const v of f.versions || []) { const ve = byKey.get(v.mediaKey); if (ve) Object.assign(v, { expiresAt: ve.expiresAt, extensions: ve.extensions }); }
    }
    toast(files.length === 1 ? T('Kept {0} more days', extendDays()) : T('Kept {0} {1} more days', plural(files.length, 'video'), extendDays()));
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
    ? (f.versionKey && (f.versions?.length > 1 || f.versionOf) ? [f.versionLabel]
      : [f.format?.toUpperCase() || (f.name?.match(/\.(\w{2,4})$/)?.[1] || '').toUpperCase(), fmtBytes(f.size)])
    : [T('Downloading {0}%', Math.floor(f.progress * 100))];
  return h('li', { class: 'row' },
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, title),
      h('div', { class: 'row-meta' }, meta.filter(Boolean).map((m) => h('span', {}, m)), f.kind === 'lib' && expiryBits(f)),
      pct > 1 && h('div', { class: 'resume-track', title: T('Watched so far') }, h('i', { style: `width:${pct}%` }))),
    f.done && h('div', { class: 'row-actions' },
      f.kind === 'lib' && h('button', { class: 'cast-btn del-btn', 'aria-label': T('Delete {0}', title), title: T('Delete'), onclick: (e) => openDelete(f, e.currentTarget) }, icon('trash')),
      f.kind === 'lib' && h('button', { class: 'cast-btn', 'aria-label': T('Download {0} to a phone', title), title: T('Download to phone'), onclick: (e) => openTravel(f, e.currentTarget) }, icon('phone')),
      h('button', { class: 'cast-btn', 'aria-label': T('Play {0} on a TV', title), title: T('Play on TV'), onclick: (e) => openPicker(f, e.currentTarget) }, icon('tv')),
      f.kind === 'lib' && h('button', { class: 'cast-btn', 'aria-label': T('Plan a watch party for {0}', title), title: T('Plan a watch party'), onclick: (e) => openPlanParty(f, e.currentTarget) }, icon('party')),
      f.converting
        ? h('button', { class: 'play-btn round is-disabled', 'aria-disabled': 'true', title: T('Getting ready to play'), 'aria-label': T('{0}: getting ready to play', title), onclick: () => toast(T('Almost ready. It can be played in a moment.')) }, icon('play'))
        : h('button', { class: 'play-btn round', 'aria-label': T('Play {0} here', title), onclick: () => openPlayer(f) }, icon('play'))));
}

// ---------- Download to phone (travel.js; the server makes the copies, src/travel.js) ----------
// Small MP4s to watch offline: Small (480p) or Standard (720p), or the file at full quality.
// The picker sheet shows one video's choices, a season's, or your list ("For your phone").
const travelView = { items: [], loaded: false, open: null }; // open: () => redraw the picker while it shows travel
async function loadTravel() {
  try { travelView.items = (await api('/api/travel')).items; travelView.loaded = true; } catch { return; }
  travelView.open?.();
  if (state.view === 'library') renderLibrary();
}
function travelOverlay(opener, draw) {
  travelView.open = draw;
  draw();
  if ($('#picker').hidden || !$('#picker').classList.contains('open')) {
    pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { travelView.open = null; opener?.focus({ preventScroll: true }); }));
  }
}
const travelLink = (url, label = T('Download')) => h('a', { class: 'chip travel-get', href: url, download: '' }, icon('download'), label);
async function askTravel(items, quality, btn) {
  if (btn) btn.disabled = true;
  try {
    travelView.items = (await api('/api/travel', jsonPost({ items, quality }))).items;
    travelView.loaded = true;
    return true;
  } catch (err) { toast(err.message); return false; } finally { if (btn) btn.disabled = false; }
}
function travelProgress(item) {
  return item.state === 'making' && h('div', { class: 'resume-track travel-track', role: 'progressbar', 'aria-valuenow': item.percent ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('i', { style: `width:${item.percent ?? 0}%` }));
}

function openTravel(file, opener) {
  const f = { ...file, kind: file.kind || 'lib' };
  const id = mediaId(f), title = travelTitle(f);
  let data = null, error = null;
  const base = `/api/media/${f.kind}/${encodeURIComponent(id)}/travel`;
  const fetchOptions = async () => {
    try { data = await api(base); error = null; } catch (err) { error = err.message; }
    if (travelView.open === draw) draw();
  };
  function draw() {
    const rows = !data ? [h('li', { class: 'searching', role: 'status' }, error || T('Working out the sizes…'))]
      : [...data.qualities.map((q) => {
        const mine = travelView.items.find((i) => i.kind === f.kind && i.id === id && i.quality === q.quality);
        const item = { ...q, ...(mine || {}) };
        const action = item.state === 'ready' && mine?.url ? travelLink(mine.url)
          : item.state === 'making' || item.state === 'queued' ? null
            : h('button', { type: 'button', class: 'chip', onclick: async (e) => {
              if (await askTravel([{ kind: f.kind, id, title }], q.quality, e.currentTarget)) fetchOptions();
            } }, item.state === 'ready' ? T('Get it') : item.state === 'failed' ? T('Try again') : T('Make it'));
        return h('li', { class: 'row travel-row' },
          h('div', { class: 'row-text' },
            h('div', { class: 'row-title' }, `${q.label} · ${q.height}p`),
            h('div', { class: 'row-meta' }, [sizeWords(item, fmtBytes), q.note, mine || item.state === 'ready' ? stateWords(item) : null].filter(Boolean).map((t) => h('span', {}, t))),
            travelProgress(item)),
          action && h('div', { class: 'row-actions' }, action));
      }),
      h('li', { class: 'row travel-row' },
        h('div', { class: 'row-text' },
          h('div', { class: 'row-title' }, T('Full quality')),
          h('div', { class: 'row-meta' }, [data.original.size && fmtBytes(data.original.size), T('The file as it is, ready now')].filter(Boolean).map((t) => h('span', {}, t)))),
        h('div', { class: 'row-actions' }, travelLink(data.original.url)))];
    $('#picker-body').replaceChildren(
      h('h2', { id: 'picker-title' }, T('Download to phone')),
      h('p', { class: 'muted picker-sub' }, title),
      h('ul', { class: 'rows travel-list' }, rows),
      h('p', { class: 'muted travel-note' }, T('Small and Standard are made on the server first, so you can close this and come back (with notifications on, you’ll hear when one is ready). They play in your phone’s own video player, subtitles included, and stay here for a week after your last download.')),
      travelView.items.length > 0 && h('button', { type: 'button', class: 'retry', onclick: () => openTravelList() }, T('All phone copies')));
  }
  travelOverlay(opener, draw);
  if (!travelView.loaded) loadTravel();
  fetchOptions();
}

// A whole season in one go: pick a size, then the list shows each episode as it's made.
function openTravelSeason(files, label, opener) {
  const items = files.map((f) => ({ kind: 'lib', id: f.id, title: travelTitle(f) }));
  function draw() {
    $('#picker-body').replaceChildren(
      h('h2', { id: 'picker-title' }, T('Season to phone')),
      h('p', { class: 'muted picker-sub' }, (items.length === 1 ? T('{0} · {1} episode', label, items.length) : T('{0} · {1} episodes', label, items.length))),
      h('ul', { class: 'rows travel-list' }, ['small', 'standard'].map((quality) => {
        const q = quality === 'small' ? { label: T('Small · 480p'), note: T('About 230 MB per half hour') } : { label: T('Standard · 720p'), note: T('About 520 MB per half hour') };
        return h('li', { class: 'row travel-row' },
          h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, q.label), h('div', { class: 'row-meta' }, h('span', {}, q.note))),
          h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'chip', onclick: async (e) => {
            if (await askTravel(items, quality, e.currentTarget)) openTravelList();
          } }, T('Make them'))));
      })),
      h('p', { class: 'muted travel-note' }, T('Episodes are made one at a time. Each gets its own Download button in the list when it’s ready.')));
  }
  travelOverlay(opener, draw);
}

// Everything you asked for, with Download buttons as copies finish.
function openTravelList(opener) {
  function draw() {
    const items = travelOrder(travelView.items);
    $('#picker-body').replaceChildren(
      h('h2', { id: 'picker-title' }, T('For your phone')),
      h('p', { class: 'muted picker-sub' }, travelSummary(items).replace(' for your phone', items.length === 1 ? ' copy' : ' copies') || T('Nothing yet. Open a film or episode and choose Download to phone.')),
      h('ul', { class: 'rows travel-list' }, items.map((item) => h('li', { class: 'row travel-row' },
        h('div', { class: 'row-text' },
          h('div', { class: 'row-title' }, item.title),
          h('div', { class: `row-meta${item.state === 'failed' ? ' is-error' : ''}` }, [item.label, sizeWords(item, fmtBytes), stateWords(item),
            item.downloadedAt && T('Downloaded')].filter(Boolean).map((t) => h('span', {}, t))),
          travelProgress(item)),
        h('div', { class: 'row-actions' },
          item.state === 'failed' && h('button', { type: 'button', class: 'chip', onclick: (e) => askTravel([{ kind: item.kind, id: item.id, title: item.title }], item.quality, e.currentTarget).then(draw) }, T('Try again')),
          item.url && travelLink(item.url),
          h('button', { type: 'button', class: 'cast-btn del-btn', title: T('Remove'), 'aria-label': T('Remove {0} ({1}) from your phone list', item.title, item.label), onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { travelView.items = (await api('/api/travel/remove', jsonPost({ kind: item.kind, id: item.id, quality: item.quality }))).items; } catch (err) { toast(err.message); }
            draw();
            if (state.view === 'library') renderLibrary();
          } }, icon('trash')))))),
      items.length > 0 && h('p', { class: 'muted travel-note' }, T('Removing one here doesn’t touch the copy already on your phone. Copies leave the server a week after you last download them.')));
  }
  travelOverlay(opener, draw);
  loadTravel();
}

// ---------- Discover ----------
let searchCtrl;
let searchTimer;
const disc = { type: 'all', genre: null, sort: 'popular', list: null, genres: null, cache: new Map() };
const TYPE_LABELS = [['all', T('All')], ['movie', T('Films')], ['tv', T('Shows')]];
const SORT_LABELS = [['popular', T('Popular')], ['rating', T('Top rated')], ['newest', T('Newest')]];

async function cachedApi(url, signal) {
  if (disc.cache.has(url)) return disc.cache.get(url);
  const data = await api(url, { signal });
  disc.cache.set(url, data);
  if (disc.cache.size > 60) disc.cache.delete(disc.cache.keys().next().value);
  return data;
}

// "In your library", or "On server" when someone else has it here (it can be added, not downloaded).
function ownershipBadge(t) {
  if (matchesFor(t).some((f) => f.done)) return h('span', { class: 'on-server' }, T('In your library'));
  if (serverMatchesFor(t).length) return h('span', { class: 'on-server is-other' }, T('On server'));
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
        t.rating && h('span', { class: 'rating', 'aria-label': T('Rated {0} out of 10', t.rating) }, `★ ${t.rating.toFixed(1)}`)),
      h('div', { class: 'name' }, t.title),
      h('div', { class: 'sub' }, [t.year, t.type === 'tv' ? T('Series') : T('Film')].filter(Boolean).join(', '))));
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
  const chips = h('div', { class: 'genre-chips', role: 'group', 'aria-label': T('Genre') },
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!disc.genre), onclick: () => pick({ genre: null }) }, T('All genres')),
    (disc.genres || []).filter(genreFits).map((g) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(disc.genre?.name === g.name), onclick: () => pick({ genre: g }),
    }, g.name)));
  requestAnimationFrame(() => chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
  return h('div', { class: 'discover-filters' },
    segmented(TYPE_LABELS, disc.type, (type) => pick({ type }), T('Show')), chips);
}

function heroSlide(t) {
  const meta = [t.year, t.type === 'tv' ? T('Series') : T('Film'), t.rating && `★ ${t.rating.toFixed(1)}`, ...genreNames(t)].filter(Boolean);
  return h('li', { class: 'hero-slide' },
    h('button', { class: 'hero-card', onclick: (e) => openDetails(t, e.currentTarget) },
      h('img', { src: t.backdrop, alt: '', decoding: 'async' }),
      h('div', { class: 'hero-text' },
        ownershipBadge(t),
        h('div', { class: 'hero-title' }, t.title),
        h('div', { class: 'hero-meta' }, meta.join(' · ')),
        h('p', { class: 'hero-overview' }, t.overview))));
}

function carousel(title, list, seeAll = null, cls = '') {
  const move = (direction) => list.scrollBy({ left: direction * Math.max(160, list.clientWidth * 0.85),
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  const prev = h('button', { type: 'button', class: 'carousel-arrow', disabled: true, 'aria-label': T('Previous in {0}', title), onclick: () => move(-1) }, icon('back'));
  const next = h('button', { type: 'button', class: 'carousel-arrow next', 'aria-label': T('Next in {0}', title), onclick: () => move(1) }, icon('back'));
  let section, observer, shown = false;
  const update = () => {
    // Library shelves are rebuilt in place; a removed one stops watching its size.
    if (list.isConnected === false && shown) return observer?.disconnect();
    if (list.isConnected) shown = true;
    prev.disabled = list.scrollLeft <= 2;
    next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 2;
    prev.hidden = next.hidden = prev.disabled && next.disabled; // everything fits: no arrows
  };
  list.addEventListener('scroll', update, { passive: true });
  section = h('section', { class: `shelf carousel ${cls}`.trim(), 'aria-label': title },
    h('div', { class: 'shelf-head' }, h('h3', {}, title),
      h('div', { class: 'carousel-controls' }, seeAll, prev, next)), list);
  observer = new ResizeObserver(update);
  observer.observe(list);
  if (!cls) searchCtrl?.signal.addEventListener('abort', () => observer.disconnect(), { once: true }); // Discover rows
  requestAnimationFrame(update);
  return section;
}

function row(r) {
  return carousel(r.title, h('ul', { class: 'shelf-items', tabindex: '0', 'aria-label': r.title }, r.items.map(titleCard)),
    h('button', { class: 'see-all', onclick: () => { disc.list = { key: r.key, title: r.title }; window.scrollTo({ top: 0 }); renderDiscover(); } }, T('See all')));
}

// Paged grid for a genre or a "See all" list, with a Load more button.
async function pagedGrid(content, urlFor, signal) {
  const seen = new Set();
  const grid = h('ul', { class: 'grid' });
  const more = h('button', { class: 'load-more', hidden: true }, T('Load more'));
  let page = 0;
  const load = async () => {
    more.disabled = true;
    more.textContent = T('Loading…');
    try {
      const data = await cachedApi(urlFor(page + 1), signal);
      if (page === 0) {
        if (!data.results.length) { content.replaceChildren(notice(T('Nothing here'), T('Try another genre or type.'))); return; }
        content.replaceChildren(grid, more);
      }
      page = data.page;
      const fresh = data.results.filter((t) => !seen.has(`${t.type}:${t.id}`)); // pages can overlap
      fresh.forEach((t) => seen.add(`${t.type}:${t.id}`));
      grid.append(...fresh.map(titleCard));
      more.hidden = page >= data.totalPages;
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (page === 0) content.replaceChildren(notice(T('Couldn’t load this'), err.message, () => { content.replaceChildren(skeletonGrid()); load(); }));
      else toast(err.message);
    } finally {
      more.disabled = false;
      more.textContent = T('Load more');
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
  heading.textContent = q ? T('Results for “{0}”', q) : T('Discover');
  heading.classList.toggle('sr-only', !q);

  if (!state.status.search) {
    body.replaceChildren(notice(T('Discover isn’t set up yet'),
      T('Add a free TMDB token as TMDB_TOKEN in the .env file, then restart the server.')));
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
        : notice(T('No matches for “{0}”', q), T('Check the spelling, or try the original title.')));
    } catch (err) {
      if (err.name !== 'AbortError') body.replaceChildren(notice(T('Search didn’t work'), err.message, renderDiscover));
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
      h('button', { class: 'back-link', onclick: () => { disc.list = null; renderDiscover(); } }, T('‹ Discover')),
      h('h3', {}, disc.list.title)));
    return pagedGrid(content, (page) => `/api/discover/list?key=${disc.list.key}&page=${page}`, signal);
  }

  if (disc.genre) {
    const g = disc.genre;
    content.before(h('div', { class: 'discover-head' },
      h('h3', {}, g.name),
      segmented(SORT_LABELS, disc.sort, (sort) => { disc.sort = sort; renderDiscover(); }, T('Sort by'))));
    return pagedGrid(content, (page) => `/api/discover/genre?type=${disc.type}&movie=${g.movie || ''}&tv=${g.tv || ''}&sort=${disc.sort}&page=${page}`, signal);
  }

  content.replaceChildren(skeletonGrid());
  try {
    const data = await cachedApi(`/api/discover/home?type=${disc.type}`, signal);
    // Popular on Marquee arrives separately (it's quick, but shouldn't hold up TMDB's rows).
    const popularSlot = h('div', { class: 'popular-slot' });
    content.replaceChildren(...[
      data.featured.length && carousel(T('Trending this week'), h('ul', { class: 'hero', tabindex: '0', 'aria-label': T('Trending this week') }, data.featured.map(heroSlide))),
      savedShelf(),
      popularSlot,
      ...data.rows.map(row),
    ].filter(Boolean));
    social.popularShelf(disc.type, { carousel, titleCard, signal }).then((shelf) => { if (shelf && !signal.aborted) popularSlot.replaceWith(shelf); });
  } catch (err) {
    if (err.name !== 'AbortError') content.replaceChildren(notice(T('Couldn’t load Discover'), err.message, renderDiscover));
  }
}

// ---------- Library ----------
let libraryRequest = null;
let libraryLastChecked = 0;
let libraryProgressRevision = 0;
function invalidateLibraryProgress() { libraryProgressRevision++; }
let librarySignature = null;
let libraryRenderPending = false;
let libraryRefreshNeeded = false;
const libraryContentSignature = (data) => JSON.stringify([
  [...data.items].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  [...(data.server || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  [...(data.shows || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
]);
function loadLibrary() {
  if (!state.status.library) return Promise.resolve(false);
  if (libraryRequest) return libraryRequest;
  libraryLastChecked = Date.now();
  libraryRequest = (async () => {
    try {
      const data = await api('/api/library', { signal: AbortSignal.timeout(15000) });
      const signature = libraryContentSignature(data);
      const changed = signature !== librarySignature || state.libraryError !== null;
      if (signature !== librarySignature) {
        state.libraryItems = data.items;
        state.library = data.items.map(applyVersion);
        state.server = data.server || [];
        state.libraryShows = data.shows || [];
        librarySignature = signature;
      }
      state.libraryError = null;
      libraryRenderPending ||= changed;
      updateUpNext();
      return changed;
    } catch (err) {
      const changed = state.libraryError !== err.message;
      state.libraryError = err.message;
      libraryRenderPending ||= changed;
      return changed;
    } finally { libraryRequest = null; }
  })();
  return libraryRequest;
}

// Background refreshes leave open sheets and the player intact. Restore the focused card and
// scroll position when the library itself changes; unchanged responses never rebuild its DOM.
function renderUpdatedLibrary() {
  if (!libraryRenderPending || state.view !== 'library' || overlayStack.length) return;
  const body = $('#library-body');
  const focused = document.activeElement;
  const key = focused?.getAttribute?.('data-library-focus');
  if (body.contains(focused) && !key) return; // an unkeyed control is currently being used
  const matches = key ? [...body.querySelectorAll('[data-library-focus]')].filter((el) => el.getAttribute('data-library-focus') === key) : [];
  const index = matches.indexOf(focused);
  const x = window.scrollX, y = window.scrollY;
  renderLibrary();
  if (key) [...body.querySelectorAll('[data-library-focus]')].filter((el) => el.getAttribute('data-library-focus') === key)[Math.max(0, index)]?.focus({ preventScroll: true });
  window.scrollTo(x, y);
}

async function loadConvert() {
  try { const next = await api(`/api/convert?plays=${extraPlayable()}`); if (state.convert?.current?.name && state.convert.current.name !== next.current?.name) libraryRefreshNeeded = true; state.convert = next; } catch { state.convert = null; }
}

// What each conversion job is for (src/convert.js sets `purpose`): one file can get two jobs,
// an MP4 for Apple devices and later an H.264 copy for browsers that can't play HEVC.
const CONVERT_PURPOSE = {
  apple: T('Making an MP4 copy that plays on iPhone and Apple TV'),
  'browser-h264': T('Making a one-time H.264 copy for browsers that can’t play HEVC. You can already watch it.'),
  'browser-audio': T('Making a browser copy with audio every browser can play. You can already watch it.'),
  subtitles: T('Saving the original’s subtitles before it’s removed'),
};

// Conversion progress banner shown at the top of the library.
function renderConvertBanner() {
  const el = $('#convert-banner');
  if (!el) return;
  const c = state.convert;
  const parts = [];
  const running = c?.active || (c?.current ? [c.current] : []);
  if (running.length) {
    running.forEach((cur, i) => {
      const bits = [h('strong', {}, `${cur.percent || 0}%`),
        cur.mode === 'Re-encoding' ? T('re-encoding') : cur.mode === 'Saving subtitles' ? T('saving subtitles') : T('quick repackage'),
        cur.speed && T('{0} speed', cur.speed),
        cur.eta != null && fmtEta(cur.eta),
        i === running.length - 1 && c.queued > 0 && T('{0} more waiting', c.queued)];
      parts.push(h('div', { class: 'convert-job' },
        h('div', { class: 'row-title' }, T('Preparing playback: {0}', cur.name)),
        h('div', { class: 'dl-state' }, CONVERT_PURPOSE[cur.purpose] || CONVERT_PURPOSE.apple),
        h('div', { class: 'bulbs', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
          'aria-valuenow': String(Math.floor(cur.percent || 0)), 'aria-label': T('Conversion progress'),
          style: `--p:${cur.percent || 0}%` }, h('i')),
        h('div', { class: 'dl-stats' }, bits.filter(Boolean).map((b) => (b instanceof Node ? b : h('span', {}, b))))));
    });
  } else if (c && !c.enabled && c.reason && !/turned off/i.test(c.reason)) {
    parts.push(h('div', { class: 'dl-state' }, T('Automatic MP4 conversion is off. {0}', c.reason)));
  }
  if (c?.recentFailures?.length) {
    parts.push(h('details', { class: 'convert-failures' },
      h('summary', {}, (c.recentFailures.length > 1 ? T('{0} files couldn’t be converted', c.recentFailures.length) : T('{0} file couldn’t be converted', c.recentFailures.length))),
      h('ul', {}, c.recentFailures.map((f) => h('li', {}, h('strong', {}, f.name), ` ${f.error}`)))));
  }
  el.hidden = !parts.length;
  el.replaceChildren(...parts);
}

const libraryCards = new Map();
let libraryUI = null;
const unifiedLibrary = () => libraryUnion(state.library, state.libraryShows, state.downloads);
// "Pappa", "Pappa and Anita", "Pappa, Anita and Home network"
const nameList = (names) => names.length < 2 ? names.join('') : T('{0} and {1}', names.slice(0, -1).join(', '), names[names.length - 1]);
// The people this person shares one library with (the owner sets it in Settings → People).
const libraryMates = () => (state.me?.sharedWith || []).map((m) => m.name);

function renderLibrary() {
  libraryRenderPending = false;
  const body = $('#library-body');
  if (!libraryUI || !body.contains(libraryUI.root)) {
    const filters = segmented(LIB_FILTERS, state.libFilter, v => { state.libFilter = v; renderLibrary(); }, T('Show'));
    const availability = select([['all', T('All titles')], ['ready', T('Ready to watch')], ['downloading', T('On the way')], ['attention', T('Needs attention')]], state.libAvailability, v => { state.libAvailability = v; renderLibrary(); }, T('Availability'));
    const groups = new Map(['movie', 'tv', 'unknown'].map(type => {
      const list = h('ul', { class: 'grid library-grid' });
      return [type, { list, section: h('section', { class: 'lib-group' }, h('h3', { class: 'lib-subhead' }, { movie: T('Films'), tv: T('Shows'), unknown: T('Unidentified') }[type]), list) }];
    }));
    const root = h('div', { class: 'unified-library' });
    libraryUI = { root, groups, filters, availability, shared: h('p', { class: 'library-shared muted', hidden: true }), notices: h('div'), travel: h('button', { type: 'button', class: 'library-summary travel-summary', hidden: true, onclick: (e) => openTravelList(e.currentTarget) }), parties: h('div', { class: 'parties-slot' }), shelves: h('div'), summary: h('button', { class: 'library-summary', onclick: () => { state.libAvailability = 'downloading'; renderLibrary(); } }), empty: h('div') };
    root.append(h('div', { class: 'dl convert-banner', id: 'convert-banner', hidden: true }),
      h('div', { class: 'library-toolbar' }, filters, h('label', { class: 'library-availability' }, T('Availability'), availability)), libraryUI.shared, libraryUI.summary, libraryUI.travel, libraryUI.notices, libraryUI.parties, libraryUI.shelves, ...[...groups.values()].map(g => g.section), libraryUI.empty);
    body.replaceChildren(root);
    loadParties();
    libraryCards.clear();
  }
  const ui = libraryUI;
  ui.availability.value = state.libAvailability;
  ui.filters.querySelectorAll('button').forEach((button, i) => { button.setAttribute('data-library-focus', `filter-${LIB_FILTERS[i][0]}`); button.setAttribute('aria-pressed', String(state.libFilter === LIB_FILTERS[i][0])); button.classList.toggle('active', state.libFilter === LIB_FILTERS[i][0]); });
  const all = unifiedLibrary();
  const entries = filterLibrary(all, { type: state.libFilter, availability: state.libAvailability, query: state.query, sort: prefs().librarySort });
  const active = all.flatMap(e => e.active).length, attention = all.filter(e => e.attention).length;
  ui.summary.hidden = !active;
  const mates = libraryMates();
  ui.shared.hidden = !mates.length;
  const sharedText = mates.length ? T('Shared library with {0}: you all see and manage the same titles.', nameList(mates)) : '';
  if (ui.shared.textContent !== sharedText) ui.shared.textContent = sharedText;
  ui.summary.textContent = T('{0} downloading{1}', active, attention ? T(' · {0} needs attention', attention) : '');
  const phone = travelSummary(travelView.items);
  ui.travel.hidden = !phone;
  if (ui.travel.textContent !== phone) ui.travel.replaceChildren(icon('phone'), h('span', {}, phone));
  const errors = [state.libraryError && T('Library scan unavailable: {0}', state.libraryError), state.downloadsError && T('Downloads unavailable: {0}', state.downloadsError), !state.status.library && T('No media folder is configured. Downloads will still appear here.')].filter(Boolean);
  const noticeText = errors.join(' ');
  if (ui.notices.textContent !== noticeText) ui.notices.replaceChildren(...errors.map(message => h('p', { class: 'library-source-notice', role: 'status' }, message)));
  const seen = new Set(), positions = new Map(), aliases = new Map(), latestByKey = new Map(all.map(entry => [entry.key, entry])), latestByAlias = new Map(), focusedAnchors = new Map();
  for (const entry of all) for (const alias of entry.aliases) latestByAlias.set(alias, entry);
  const visibleKeys = new Set(entries.map(entry => entry.key));
  for (const [type, group] of ui.groups) {
    const index = [...group.list.children].findIndex(card => card.contains(document.activeElement) && !visibleKeys.has(card._entry?.key));
    if (index >= 0) focusedAnchors.set(type, index);
  }
  for (const card of libraryCards.values()) for (const alias of card._entry?.aliases || []) aliases.set(alias, card);
  for (const entry of entries) {
    let card = libraryCards.get(entry.key);
    if (!card) {
      const prior = entry.aliases.map(key => aliases.get(key)).find(Boolean);
      card = prior || makeUnifiedCard(entry);
      if (prior) libraryCards.delete(prior._entry.key);
      libraryCards.set(entry.key, card);
    }
    updateUnifiedCard(card, entry);
    seen.add(entry.key);
    const list = ui.groups.get(entry.type).list;
    const position = positions.get(entry.type) || 0; positions.set(entry.type, position + 1);
    const anchor = focusedAnchors.get(entry.type);
    const index = position + (anchor != null && position >= anchor ? 1 : 0);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  }
  for (const [key, card] of libraryCards) if (!seen.has(key)) {
    if (card.contains(document.activeElement)) {
      const latest = latestByKey.get(key) || card._entry?.aliases.map(alias => latestByAlias.get(alias)).find(Boolean);
      if (latest) updateUnifiedCard(card, latest);
      card.addEventListener('focusout', () => queueMicrotask(() => { if (!card.contains(document.activeElement)) renderLibrary(); }), { once: true });
      continue;
    }
    card.remove(); libraryCards.delete(key);
  }
  for (const group of ui.groups.values()) group.section.hidden = !group.list.children.length;
  const emptyText = entries.length || [...libraryCards.values()].some(c => c.contains(document.activeElement)) ? '' : all.length ? T('No titles match these filters.') : T('Nothing here yet. Find something in Discover and press Add to start watching.');
  if (ui.empty.textContent !== emptyText) ui.empty.replaceChildren(emptyText ? notice(all.length ? T('No matching titles') : T('Your library is empty'), emptyText) : '');
  // Shelves use ready files only; transfers never create fake playback progress.
  const shelfKey = JSON.stringify([librarySignature, state.libFilter, state.query, libraryProgressRevision, watch.revision, todayIso()]);
  // Also rebuilt when this page changed the list itself (a delete), before the server's copy catches up.
  if (ui.shelfKey !== shelfKey || ui.shelfLibrary !== state.library || ui.shelfProgress !== state.progress) {
    ui.shelfKey = shelfKey; ui.shelfLibrary = state.library; ui.shelfProgress = state.progress;
    const q = norm(state.query), ready = state.library.filter(f => (!q || norm(`${f.title} ${f.filmTitle || ''} ${f.file}`).includes(q)) && (state.libFilter === 'all' || (state.libFilter === 'tv') === (f.season != null)));
    const watching = ready.map(f => ({ f, progress: savedProgress(libraryFile(f)) })).filter(x => partlyWatched(x.progress)).sort((a,b) => (b.progress.at || 0) - (a.progress.at || 0)).slice(0,12);
    const leaving = libraryEntries(ready.filter(f => f.expiresAt != null && f.expiresAt - Date.now() < 48 * 3600000));
    ui.shelves.replaceChildren(...[watching.length && continueShelf(watching.map(({f, progress}) => continueCard(f, progress))), comingUpShelf(), leaving.length && libraryShelf(T('Leaving soon'), leaving.map(e => libraryCard(e, true)))].filter(Boolean));
  }
  ui.shelves.hidden = state.libAvailability !== 'all' && state.libAvailability !== 'ready';
  if (showView.id) updateOpenShow();
  if (filmView.id) updateOpenFilm();
  renderConvertBanner();
}
function makeUnifiedCard(entry) {
  const card = h('li', { class: 'library-card unified-card' });
  const button = h('button', { class: 'title-card', type: 'button', onclick: e => openUnifiedTitle(card._entry, e.currentTarget) },
    h('div', { class: 'poster' }), h('div', { class: 'name' }), h('div', { class: 'sub' }));
  const panel = h('div', { class: 'library-transfer' }, h('div', { class: 'transfer-line' }, h('span', { class: 'transfer-state' }), h('span', { class: 'transfer-percent' })),
    h('div', { class: 'transfer-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')));
  card.append(button, panel, h('button', { class: 'library-more', type: 'button', 'aria-label': T('Download details for {0}', entry.name), onclick: e => openTransferDetails(card._entry, e.currentTarget) }, '•••'));
  return card;
}
function updateUnifiedCard(card, entry) {
  const old = card._entry;
  card._entry = entry;
  const fresh = newBadgeCount(entry);
  const paint = JSON.stringify([fresh, entry.key, entry.type, entry.transfers.map(d => [d.hash, d.done]), entry.name, entry.poster, entry.ready, entry.state, entry.progress, entry.attention, entry.files.map(f => [f.id, f.expiresAt, savedProgress(libraryFile(f))]), libraryAvailability(entry)]);
  if (card._paint === paint) return; card._paint = paint;
  const button = $('.title-card', card), poster = $('.poster', card), panel = $('.library-transfer', card);
  button.setAttribute('data-library-focus', entry.key);
  if (!old || old.poster !== entry.poster || old.name !== entry.name) poster.replaceChildren(entry.poster ? h('img', { src: entry.poster, alt: '', loading: 'lazy', decoding: 'async', onerror: e => e.currentTarget.replaceWith(h('div', { class: 'poster-fallback' }, entry.name)) }) : h('div', { class: 'poster-fallback' }, entry.name));
  $('.name', card).textContent = entry.name;
  $('.sub', card).textContent = libraryAvailability(entry);
  const next = nextExpiry(entry.files), hours = (next-Date.now())/3600000;
  let expiry = $('.poster-expiry', card);
  if (Number.isFinite(next)) { if (!expiry) { expiry = h('span', { class: 'poster-expiry' }); poster.append(expiry); } expiry.textContent = hours < 1 ? T('Leaving soon') : hours < 48 ? T('{0}h left', Math.ceil(hours)) : T('{0}d left', Math.ceil(hours/24)); expiry.classList.toggle('is-soon', hours < 24); } else expiry?.remove();
  let watched = $('.poster-progress', card);
  const progress = entry.files[0] && savedProgress(libraryFile(entry.files[0]));
  if (partlyWatched(progress)) { if (!watched) { watched = h('span', { class: 'poster-progress' }, h('i')); poster.append(watched); } watched.setAttribute('aria-label', T('{0}% watched', Math.round(progress.time/progress.duration*100))); watched.firstChild.style.width = `${progress.time/progress.duration*100}%`; } else watched?.remove();
  panel.hidden = !entry.active.length && !entry.preparing;
  $('.library-more', card).hidden = !entry.transfers.length;
  $('.library-more', card).setAttribute('aria-label', T('Download details for {0}', entry.name));
  $('.transfer-state', card).textContent = entry.state;
  $('.transfer-percent', card).textContent = entry.progress == null ? '' : `${Math.floor(entry.progress * 100)}%`;
  panel.classList.toggle('is-paused', entry.state === T('Paused')); panel.classList.toggle('is-error', entry.attention);
  const track = $('.transfer-track', card);
  track.setAttribute('aria-label', T('{0} download progress', entry.name));
  track.setAttribute('aria-valuetext', `${entry.state}${entry.progress == null ? '' : `, ${Math.floor(entry.progress*100)} percent`}`);
  if (entry.progress == null) track.removeAttribute('aria-valuenow'); else track.setAttribute('aria-valuenow', String(Math.floor(entry.progress*100)));
  track.firstChild.style.width = entry.progress == null ? '0%' : `${entry.progress*100}%`;
  let pill = $('.transfer-pill', poster);
  const pillText = entry.attention ? T('Needs attention') : entry.state === T('Paused') ? T('Paused') : [T('Preparing playback'), T('Checking files')].includes(entry.state) ? T('Preparing') : '';
  if (pillText) { if (!pill) { pill = h('span', { class: 'transfer-pill' }); poster.append(pill); } pill.textContent = pillText; } else pill?.remove();
  let badge = $('.new-badge', poster);
  if (fresh) { if (!badge) { badge = h('span', { class: 'new-badge' }); poster.append(badge); } badge.textContent = fresh === 1 ? T('New') : T('{0} new', fresh); badge.setAttribute('aria-label', (fresh === 1 ? T('{0} new episode', fresh) : T('{0} new episodes', fresh))); } else badge?.remove();
  if (old && (old.ready !== entry.ready || old.attention !== entry.attention)) $('#library-live').textContent = `${entry.name}: ${entry.attention ? T('needs attention') : entry.ready ? T('ready to watch') : entry.state}`;
}
function openUnifiedTitle(entry, opener) {
  if (entry.show) { showView.hashes = entry.transfers.map(d => d.hash); return openShow(entry.show.id, opener); }
  if (entry.files.length) return openFilm(entry.files[0], opener);
  filmView.hashes = entry.transfers.map(d => d.hash);
  filmView.id = `entry:${entry.key}`;
  renderFilm();
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => { filmView.id = null; opener?.focus({ preventScroll: true }); }));
}
const LIB_FILTERS = [['all', T('All')], ['movie', T('Films')], ['tv', T('Shows')]];
// ---------- Library: shows ----------
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? T(one) : T(many)}`;
const episodeCount = (files) => new Set(files.map((f) => `${f.season}:${f.episode}`)).size;
// TMDB's season names are cached in English; the plain ones have a translation of their own.
const localSeasonName = (name, n) => (/^(Season \d+|Specials)$/.test(String(name || '')) || !name ? seasonName(n) : name);
const seasonName = (n) => (n === 0 ? T('Specials') : T('Season {0}', n));

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
  const groups = films.length && series.length ? [[T('Films'), films], [T('Shows'), series]] : [[null, entries]];
  return groups.map(([label, list]) => h('div', { class: 'lib-group' },
    label && h('h4', { class: 'lib-subhead' }, label),
    h('ul', { class: 'grid library-grid' }, list.map((e) => libraryCard(e)))));
}

function libraryShelf(title, cards, cls = '') {
  return h('section', { class: `shelf library-shelf ${cls}`.trim(), 'aria-label': title },
    h('div', { class: 'shelf-head' }, h('h3', {}, title)), h('ul', { class: 'shelf-items' }, cards));
}
// Continue watching scrolls like the Discover rows: arrows beside the title, hidden while every card fits.
function continueShelf(cards) {
  return carousel(T('Continue watching'),
    h('ul', { class: 'shelf-items', tabindex: '0', 'aria-label': T('Continue watching') }, cards), null, 'library-shelf continue-shelf');
}

// 16:9 artwork (episode stills, backdrops). Each source is tried in turn, then a themed placeholder.
// A source is a URL, or { src, contain: true } for a portrait poster shown whole. With `sizes`, TMDB's
// small stills also offer the 780px version, for large cards on high-density screens.
function wideArt(sources, cls = '', sizes = null) {
  const list = sources.map((s) => (typeof s === 'string' ? { src: s } : s)).filter((s) => s?.src);
  const next = () => {
    const s = list.shift();
    const srcset = sizes && /\/t\/p\/w300\//.test(s?.src) ? `${s.src} 300w, ${s.src.replace('/t/p/w300/', '/t/p/w780/')} 780w` : null;
    return s ? h('img', { src: s.src, srcset, sizes: srcset && sizes, alt: '', loading: 'lazy', decoding: 'async', class: s.contain ? 'is-contained' : null, onerror: (e) => e.currentTarget.replaceWith(next()) })
      : h('div', { class: 'wide-art-fallback', 'aria-hidden': 'true' }, icon('tv'));
  };
  return h('div', { class: `wide-art ${cls}`.trim() }, next());
}
// TMDB art for an episode: its own still, then the show's backdrop.
const episodeArt = (still, show, cls, sizes) => wideArt([still, show?.backdrop], cls, sizes);

const CONTINUE_SIZES = '(max-width: 420px) 200px, 240px'; // matches .continue-shelf column widths
// Continue watching: landscape cards that resume playback. Episodes show their still, films a backdrop.
function continueCard(f, progress) {
  const show = state.libraryShows.find((s) => s.id === f.show);
  const name = show?.title || f.filmTitle || f.title;
  const left = T('{0} min left', Math.max(1, Math.ceil((progress.duration - progress.time) / 60)));
  const pct = progress.time / progress.duration * 100;
  const next = nextExpiry([f]), hours = (next - Date.now()) / 3600000;
  const art = f.season != null ? episodeArt(f.still, show, '', CONTINUE_SIZES) : wideArt([f.backdrop, { src: f.poster, contain: true }]);
  art.append(...[
    Number.isFinite(next) && h('span', { class: `poster-expiry${hours < 24 ? ' is-soon' : ''}`, title: timeLeft(next) },
      hours <= 0 ? T('Leaving soon') : hours < 1 ? T('<1h left') : hours < 48 ? T('{0}h left', Math.ceil(hours)) : T('{0}d left', Math.ceil(hours / 24))),
    h('span', { class: 'poster-progress', 'aria-label': T('{0}% watched', Math.round(pct)) }, h('i', { style: `width:${pct}%` }))].filter(Boolean));
  return h('li', { class: 'library-card continue-card' },
    h('button', { type: 'button', class: 'title-card', 'data-library-focus': `play-${f.id}`, onclick: () => openPlayer(libraryFile(f)) },
      art, h('div', { class: 'name' }, name),
      f.season != null && f.episodeName && h('div', { class: 'sub continue-episode' }, f.episodeName),
      h('div', { class: 'sub' }, [episodeLabel(f), left].filter(Boolean).join(' · '))));
}

function libraryCard(entry, keep = false) {
  const { show, files, name } = entry;
  const f = files[0];
  const seasons = [...new Set(files.map((f) => f.season))];
  const subtitle = entry.subtitle || (f.movieAmbiguous ? T('Film needs identifying') : show
    ? `${seasons.length === 1 ? seasonName(seasons[0]) : plural(seasons.length, 'season')} · ${plural(episodeCount(files), 'episode')}`
    : [f.year, f.season != null ? episodeLabel(f) : T('Film')].filter(Boolean).join(' · '));
  const poster = entry.poster || show?.poster || f.poster;
  const progress = savedProgress(libraryFile(f));
  const next = nextExpiry(files);
  const hours = (next - Date.now()) / 3600000;
  const expiry = hours <= 0 ? T('Leaving soon') : hours < 1 ? T('<1h left') : hours < 48 ? T('{0}h left', Math.ceil(hours)) : T('{0}d left', Math.ceil(hours / 24));
  const eligible = files.filter(canExtend);
  return h('li', { class: 'library-card' },
    h('button', { type: 'button', class: 'title-card', 'data-library-focus': `play-${f.id}`, onclick: (e) => entry.resume
      ? openPlayer(libraryFile(f)) : show ? openShow(show.id, e.currentTarget) : openFilm(f, e.currentTarget) },
      h('div', { class: 'poster' },
        poster ? h('img', { src: poster, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.currentTarget.replaceWith(h('div', { class: 'poster-fallback' }, name)) })
          : h('div', { class: 'poster-fallback' }, name),
        Number.isFinite(next) && h('span', { class: `poster-expiry${hours < 24 ? ' is-soon' : ''}`, title: timeLeft(next) }, expiry),
        partlyWatched(progress) && h('span', { class: 'poster-progress', 'aria-label': T('{0}% watched', Math.round(progress.time / progress.duration * 100)) },
          h('i', { style: `width:${progress.time / progress.duration * 100}%` }))),
      h('div', { class: 'name' }, name), h('div', { class: 'sub' }, subtitle)),
    keep && eligible.length > 0 && h('button', { type: 'button', class: 'chip library-keep', 'data-library-focus': `keep-${f.id}`, onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      await extendItems(eligible);
      if (btn.isConnected) btn.disabled = false;
    } }, T('Keep {0} more days', extendDays())));
}

// These controls appear above the seasons, so extending a show doesn't require finding an episode.
function keepBar(files, onDone) {
  const timed = files.filter((f) => f.expiresAt != null).sort((a, b) => a.expiresAt - b.expiresAt);
  if (!timed.length) return h('div', { class: 'library-keep-bar is-kept' }, h('p', {}, T('Kept in your library')),
    h('p', { class: 'muted' }, T('No automatic deletion scheduled.')));
  const next = timed[0];
  const eligible = timed.filter(canExtend);
  const text = files.length > 1 ? T('Next to go: {0} · {1}', episodeLabel(next) || next.title, timeLeft(next.expiresAt)) : timeLeft(next.expiresAt);
  return h('div', { class: 'library-keep-bar' },
    h('div', {}, h('p', { class: 'keep-countdown' }, text),
      h('p', { class: 'muted' }, eligible.length ? T('Keep it longer if you’re not finished watching.') : T('The extension limit has been reached.'))),
    eligible.length > 0 && h('button', { type: 'button', class: 'play-btn', onclick: async (e) => {
      e.currentTarget.disabled = true;
      await extendItems(eligible);
      onDone();
    } }, eligible.length > 1 ? T('Keep all {0} · {1} more days', eligible.length, extendDays()) : T('Keep {0} more days', extendDays())));
}

const filmView = { id: null };
let filmStructure = '';
function updateOpenFilm() {
  const entry = unifiedLibrary().find(e => filmView.id === `entry:${e.key}` || e.files.some(f => f.id === filmView.id) || filmView.hashes?.some(hash => e.transfers.some(d => d.hash === hash)));
  const signature = JSON.stringify([filmView.id, entry?.files, entry?.transfers.map(d => d.hash)]);
  if (filmStructure !== signature && !$('#sheet-body').contains(document.activeElement)) { const top = $('#sheet').scrollTop; renderFilm(); $('#sheet').scrollTop = top; }
}
function openFilm(f, opener) {
  filmView.hashes = null;
  filmView.id = f.id;
  renderFilm();
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => {
    filmView.id = null;
    opener?.focus({ preventScroll: true });
  }));
}
function renderFilm() {
  const entry = unifiedLibrary().find(e => filmView.id === `entry:${e.key}` || e.files.some(f => f.id === filmView.id) || filmView.hashes?.some(hash => e.transfers.some(d => d.hash === hash)));
  filmStructure = JSON.stringify([filmView.id, entry?.files, entry?.transfers.map(d => d.hash)]);
  const f = entry?.files[0] || state.library.find((f) => f.id === filmView.id);
  if (!f && entry) {
    const d = entry.transfers[0];
    $('#sheet-body').replaceChildren(h('div', { class: `sheet-hero${d?.backdrop ? '' : ' no-image'}`, style: d?.backdrop ? `background-image:url("${d.backdrop}")` : null }), h('div', { class: 'sheet-content' }, h('h2', { id: 'sheet-title' }, entry.name), h('ul', { class: 'facts' }, h('li', {}, libraryAvailability(entry))), h('div', { class: 'sheet-transfer' }, transferPanel(entry)))); return;
  }
  if (!f) {
    $('#sheet-body').replaceChildren(h('div', { class: 'sheet-content' }, h('h2', { id: 'sheet-title' }, T('Removed from your library'))));
    return;
  }
  const file = libraryFile(f);
  const progress = savedProgress(file);
  $('#sheet-body').replaceChildren(
    h('div', { class: `sheet-hero${f.backdrop ? '' : ' no-image'}`, style: f.backdrop ? `background-image:url("${f.backdrop}")` : null }),
    h('div', { class: 'sheet-content' },
      h('h2', { id: 'sheet-title' }, f.filmTitle || f.title),
      h('ul', { class: 'facts' }, [f.year, f.season != null ? episodeLabel(f) : T('Film'), f.rating && `★ ${f.rating}`, f.format?.toUpperCase(), fmtBytes(f.size)]
        .filter(Boolean).map((text) => h('li', {}, text))),
      social.rateRow(f.season == null && f.tmdbId ? `movie:${f.tmdbId}` : titleKeyOf(f), f.filmTitle || f.title),
      transferPanel(unifiedLibrary().find(e => e.files.some(file => file.id === f.id))),
      keepBar([f], renderFilm),
      f.movieAmbiguous && h('p', { class: 'identity-note' }, state.me?.isOwner
        ? T('Several films match this filename. Choose “Identify film” to select the right one.')
        : T('Several films match this filename. The server’s owner can identify this file.')),
      h('div', { class: 'library-film-actions' },
        h('button', { class: 'play-btn', disabled: f.converting, onclick: () => openPlayer(file) }, icon('play'),
          f.converting ? T('Preparing playback…') : partlyWatched(progress) ? T('Resume at {0}', fmtTime(progress.time)) : T('Play')),
        h('button', { class: 'chip', onclick: (e) => openPicker(file, e.currentTarget) }, icon('tv'), T('Play on TV')),
        !f.converting && h('button', { class: 'chip', onclick: (e) => openPlanParty(file, e.currentTarget) }, icon('party'), T('Watch party')),
        h('button', { class: 'chip', onclick: (e) => openTravel(file, e.currentTarget) }, icon('phone'), T('To phone')),
        h('button', { class: 'chip', onclick: (e) => openDelete(file, e.currentTarget) }, icon('trash'), T('Delete')),
        state.me?.isOwner && h('button', { class: 'chip', onclick: (e) => openFilmIdentity(f, e.currentTarget) }, T('Identify film'))),
      f.overview && h('p', { class: 'overview' }, f.overview)));
}

function openFilmIdentity(f, opener) {
  let closed = false;
  let request = 0;
  const list = h('ul', { class: 'rows identity-results' });
  const status = h('p', { class: 'muted', role: 'status' });
  const input = h('input', { type: 'search', 'aria-label': T('Film title'), value: f.title });
  const form = h('form', { class: 'identity-search', onsubmit: (e) => { e.preventDefault(); search(); } }, input,
    h('button', { class: 'chip', type: 'submit' }, T('Search')));
  const draw = (results) => {
    list.replaceChildren(...results.map((t) => h('li', {}, h('button', { class: 'row identity-result', type: 'button', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api('/api/library/identify', jsonPost({ id: f.id, tmdbId: t.id }));
        if (!closed) closeTopOverlay();
        await loadLibrary();
        if (state.view === 'library') renderLibrary();
        toast(T('Film identified'));
      } catch (err) { status.textContent = err.message; btn.disabled = false; }
    } },
    t.poster && h('img', { src: t.poster, alt: '', loading: 'lazy' }),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, t.title),
      h('span', { class: 'row-meta' }, t.releaseDate || t.year || T('Release date unknown')),
      h('span', { class: 'identity-overview' }, t.overview || T('No description available.')))))));
    status.textContent = results.length ? T('Choose the poster and description that match your film.') : T('No films found. Try a different title.');
  };
  async function search() {
    const currentRequest = ++request;
    status.textContent = T('Searching…');
    try {
      const data = await api(`/api/library/identify?id=${encodeURIComponent(f.id)}&q=${encodeURIComponent(input.value.trim())}`);
      if (!closed && currentRequest === request) draw(data.results);
    } catch (err) { if (!closed && currentRequest === request) status.textContent = err.message; }
  }
  $('#picker-body').replaceChildren(h('h2', { id: 'picker-title' }, T('Identify film')),
    h('p', { class: 'muted' }, T('File: {0}', f.file)), form, status, list);
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { closed = true; opener?.focus({ preventScroll: true }); }));
  if (f.filmCandidates?.length) draw(f.filmCandidates); else search();
}

// The show sheet: seasons as poster cards (TMDB's poster for each season), then a season's episodes.
// A show with one season on the server opens straight on its episodes.
const showView = { id: null, season: null };
function openShow(id, opener) {
  const tmdbId = unifiedLibrary().find((e) => e.show?.id === id)?.show?.tmdbId;
  if (tmdbId) markShowSeen(tmdbId);
  showView.id = id;
  showView.season = null;
  renderShow();
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => {
    showView.id = null;
    opener?.focus({ preventScroll: true });
  }));
}

let showStructure = '';
function showEntry() { return unifiedLibrary().find(e => e.show && (e.show.id === showView.id || showView.hashes?.some(hash => e.transfers.some(d => d.hash === hash)))); }
function updateOpenShow() {
  const entry = showEntry();
  const signature = JSON.stringify([showView.id, showView.season, entry?.files, entry?.transfers.map(d => [d.hash, d.season, (d.episodes || []).map(ep => [ep.season, ep.episode, ep.available, ep.libraryId])])]);
  if (signature !== showStructure && !$('#sheet-body').contains(document.activeElement)) { const top = $('#sheet').scrollTop; renderShow(); $('#sheet').scrollTop = top; }
}
// A title's downloads in its sheet: state, percentage, Pause/Resume and Details (speed, files, peers).
function transferPanel(entry) {
  if (!entry?.active.length) return entry?.preparing ? h('p', { class: 'pack-transfer' }, T('Preparing playback. It plays here as soon as the MP4 copy is ready.')) : null;
  const { key, aliases } = entry;
  return transferSummary(() => unifiedLibrary().find((e) => e.key === key || e.aliases.some((a) => aliases.includes(a)))?.transfers || [], entry.name);
}
function renderShow() {
  const entry = showEntry(), show = entry?.show;
  const files = entry?.files || [];
  if (!show) { $('#sheet-body').replaceChildren(h('div', { class: 'sheet-content' }, h('h2', { id: 'sheet-title' }, T('Series')), h('p', {}, T('This show is no longer in your library.')))); return; }
  const numbers = new Set(files.map(f => f.season));
  for (const d of entry.transfers) { if (d.season != null) numbers.add(d.season); for (const ep of d.episodes || []) if (ep.season != null) numbers.add(ep.season); }
  const seasons = [...numbers].sort((a,b) => a-b).map(number => ({ ...(show.seasons || []).find(se => se.number === number), number, name: localSeasonName(show.seasons || []).find(se => se.number === number)?.name || seasonName(number, number) }));
  const single = seasons.length === 1;
  const open = single ? seasons[0] : seasons.find(se => se.number === showView.season);
  const pick = n => { showView.season = n; renderShow(); $('#sheet').scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
  const pendingFor = n => entry.transfers.filter(d => d.season === n || (d.episodes || []).some(ep => ep.season === n));
  // One click (plus a confirmation) for a whole season or the whole show.
  const seasonFiles = open ? files.filter(f => f.season === open.number) : [];
  const deleteShow = files.length > 0 && h('button', { type: 'button', class: 'chip delete-many', onclick: e => openDeleteMany({ files, what: T('this show'), label: show.title, onDone: closeTopOverlay }, e.currentTarget) }, icon('trash'), T('Delete show'));
  const deleteSeason = !single && seasonFiles.length > 0 && h('button', { type: 'button', class: 'chip delete-many', onclick: e => openDeleteMany({ files: seasonFiles, what: T('this season'), label: `${show.title} · ${open.name}`, onDone: () => { showView.season = null; renderShow(); } }, e.currentTarget) }, icon('trash'), T('Delete season'));
  let content;
  if (!open) content = [h('h3', {}, T('Seasons')), h('ul', { class: 'grid season-grid' }, seasons.map(se => {
    const ready = episodeCount(files.filter(f => f.season === se.number)), transfers = pendingFor(se.number).filter(d => !d.done);
    const pending = new Set(transfers.flatMap(d => (d.episodes || []).filter(ep => ep.season === se.number && !ep.available).map(ep => ep.episode))).size;
    return h('li', {}, h('button', { class: 'title-card', onclick: () => pick(se.number) }, h('div', { class: 'poster' }, se.poster ? h('img', { src: se.poster, alt: '', loading: 'lazy' }) : h('div', { class: 'poster-fallback' }, se.name)), h('div', { class: 'name' }, se.name), h('div', { class: 'sub' }, T('{0} ready{1}', se.total ? T('{0} of {1}', ready, se.total) : ready, pending ? T(' · {0} downloading', pending) : transfers.length ? T(' · Season pack downloading') : ''))));
  }))];
  else {
    const versions = files.filter(f => f.season === open.number).sort((a,b) => a.episode-b.episode || String(a.id).localeCompare(String(b.id)));
    const ready = [...new Map(versions.map(f => [f.episode, f])).values()];
    const byEpisode = new Map();
    for (const d of pendingFor(open.number)) for (const ep of d.episodes || []) if (ep.season === open.number && !ready.some(f => f.episode === ep.episode) && !byEpisode.has(ep.episode)) byEpisode.set(ep.episode, { d, ep });
    const tmdbEp = n => open.episodes?.[n] || {};
    const epTitle = (n, name) => `${n}. ${name || tmdbEp(n).name || T('Episode {0}', n)}`;
    const thumb = (n, still) => episodeArt(still || tmdbEp(n).still, show, 'episode-thumb');
    const rows = ready.map(f => ({ number: f.episode, node: (() => { const row = fileRow(libraryFile(f)); row.classList.add('episode-row'); row.prepend(thumb(f.episode, f.still)); $('.row-title', row).textContent = epTitle(f.episode, f.episodeName); $('.row-title', row).title = f.file; return row; })() }));
    const tvId = { id: show.tmdbId ?? null, title: show.title, type: 'tv' }; // episodeDownload decides Add / Download / nothing
    for (const {d,ep} of byEpisode.values()) rows.push({ number: ep.episode, node: h('li', { class: 'row episode-row pending-episode', 'data-transfer-hash': d.hash, 'data-episode-number': ep.episode, 'data-episode-season': ep.season }, thumb(ep.episode), h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, epTitle(ep.episode)), h('div', { class: 'row-meta episode-transfer-state' }, ep.available ? T('Ready · watch it from Details') : `${transferState(d)}${Number.isFinite(ep.progress) ? ` · ${Math.floor(ep.progress*100)}%` : ''}`)), h('button', { class: 'chip', onclick: e => openTransferDetails({ ...entry, transfers: [d] }, e.currentTarget) }, T('Details'))) });
    if (Number.isInteger(open.total) && open.total > 0 && open.total <= 1000) for (let number = open.first || 1; number < (open.first || 1) + open.total; number++) if (!rows.some(row => row.number === number)) rows.push({ number, node: h('li', { class: 'row episode-row missing-episode' }, thumb(number), h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, epTitle(number)), h('div', { class: 'row-meta' }, T('Not added yet'))), tvId && episodeDownload(tvId, open.number, number)) });
    content = [!single && h('button', { class: 'chip season-back', onclick: () => pick(null) }, icon('back'), T('All seasons')), h('h3', {}, open.name),
      seasonVersionPick(ready, () => renderShow()),
      h('div', { class: 'season-summary' }, h('p', { class: 'muted' }, T('{0} episodes ready', open.total ? T('{0} of {1}', episodeCount(ready), open.total) : episodeCount(ready))),
        ready.length > 0 && h('button', { type: 'button', class: 'chip delete-many travel-season', onclick: e => openTravelSeason(ready, `${show.title} · ${open.name}`, e.currentTarget) }, icon('phone'), T('Season to phone')), deleteSeason),
      ...pendingFor(open.number).filter(d => !(d.episodes || []).some(ep => ep.season === open.number)).map(d => h('div', { class: 'pack-transfer' }, h('strong', {}, T('{0} pack', open.name)), h('p', {}, T('Episode availability is shown when individual files are verified.')), h('button', { class: 'chip', onclick: e => openTransferDetails({ ...entry, transfers: [d] }, e.currentTarget) }, T('Season pack details')))),
      h('ul', { class: 'rows' }, rows.sort((a,b) => a.number-b.number).map(r => r.node))];
  }
  // The same Download panel as in Discover, opened on the season you're looking at.
  const tv = canGet() && show.tmdbId ? showDownload({ id: show.tmdbId, title: show.title, type: 'tv' }, { season: open?.number ?? null }) : null;
  $('#sheet-body').replaceChildren(h('div', { class: `sheet-hero${show.backdrop ? '' : ' no-image'}`, style: show.backdrop ? `background-image:url("${show.backdrop}")` : null }),
    h('div', { class: 'sheet-content' }, h('h2', { id: 'sheet-title' }, show.title), h('ul', { class: 'facts' }, [show.year, T('Series'), libraryAvailability(entry)].filter(Boolean).map(text => h('li', {}, text))),
      show.tmdbId && social.rateRow(`tv:${show.tmdbId}`, show.title),
      h('div', { class: 'title-actions' }, (tv || deleteShow) && h('div', { class: 'action-row' }, tv?.toggle, deleteShow), tv?.panel, transferPanel(entry)),
      state.status.search && show.tmdbId && watchBox({ id: show.tmdbId, type: 'tv', title: show.title }),
      files.length > 0 && keepBar(files, renderShow), show.overview && h('p', { class: 'overview' }, show.overview), ...content));
  showStructure = JSON.stringify([showView.id, showView.season, entry.files, entry.transfers.map(d => [d.hash, d.season, (d.episodes || []).map(ep => [ep.season, ep.episode, ep.available, ep.libraryId])])]);
}

// ---------- Downloads ----------
// Cards are updated in place so progress animates and focus is preserved.
const dlCards = new Map();
const transferNodes = new Set();

let downloadsRequest = null;
let downloadsGeneration = 0;
// Mutations make every older in-flight snapshot stale, even within the same scope.
function invalidateDownloadsRead() { downloadsGeneration++; downloadsRequest = null; }
function downloadsChangedLibrary(before, after) {
  const own = (items) => items.filter((d) => d.mine !== false);
  const previous = new Map(own(before).map((d) => [d.hash, d]));
  const latest = new Map(own(after).map((d) => [d.hash, d]));
  const availability = d => JSON.stringify([(d?.libraryIds || []).slice().sort(), (d?.episodes || []).map(ep => [ep.season, ep.episode, ep.available, ep.libraryId])]);
  return [...latest.values()].some((d) => d.done && !previous.get(d.hash)?.done || availability(d) !== availability(previous.get(d.hash)))
    || [...previous.keys()].some((hash) => !latest.has(hash));
}
function loadDownloads() {
  if (!state.status.downloads) return Promise.resolve();
  const scope = state.dlScope;
  if (downloadsRequest?.scope === scope) return downloadsRequest.promise;
  const generation = ++downloadsGeneration;
  const promise = (async () => {
    try {
      const data = await api(`/api/downloads${scope === 'all' ? '?all=1' : ''}`, { signal: AbortSignal.timeout(15000) });
      if (generation !== downloadsGeneration || state.dlScope !== scope) return;
      libraryRefreshNeeded ||= downloadsChangedLibrary(state.downloads, data.items);
      state.downloads = data.items;
      state.downloadsError = null;
    } catch (err) { if (generation === downloadsGeneration) state.downloadsError = err.message; }
    finally { if (generation === downloadsGeneration) downloadsRequest = null; }
    const active = state.downloads.filter((d) => !d.done && d.mine !== false).length;
    const badge = $('#dl-badge');
    badge.hidden = !active;
    badge.textContent = active;
    badge.setAttribute('aria-label', T('{0} unfinished downloads', active));
  })();
  downloadsRequest = { scope, promise };
  return promise;
}

function makeDlCard(d) {
  const refs = {};
  const el = h('li', { class: 'dl' },
    h('div', { class: 'dl-head' },
      h('div', { class: 'row-text' },
        refs.title = h('div', { class: 'row-title' }),
        refs.state = h('div', { class: 'dl-state' })),
      refs.actions = h('div', { class: 'row-actions' },
        refs.cast = h('button', { class: 'cast-btn', title: T('Play on TV'), onclick: () => openPicker({ ...refs.data, kind: 'dl', key: refs.data.hash }, refs.cast) }, icon('tv')),
        refs.play = h('button', { class: 'play-btn', onclick: () => {
          if (refs.data.converting) { toast(T('Almost ready. It can be played in a moment.')); return; }
          openPlayer({ ...refs.data, kind: 'dl', key: refs.data.hash });
        } }, icon('play'), T('Play')))),
    refs.release = h('p', { class: 'transfer-release' }),
    refs.files = h('details', { class: 'transfer-files' }, h('summary', {}, T('Files')), h('ul')),
    refs.error = h('p', { class: 'transfer-action-error', role: 'status' }),
    refs.bar = h('div', { class: 'bulbs', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')),
    h('div', { class: 'dl-foot' },
      refs.stats = h('div', { class: 'dl-stats' }),
      h('div', { class: 'dl-controls' },
        refs.pause = h('button', { type: 'button', class: 'chip dl-ctl', onclick: () => togglePause(refs.data, refs.pause) }),
        refs.del = h('button', { type: 'button', class: 'chip dl-ctl', onclick: (e) => openDeleteDownload(refs.data, e.currentTarget) }, T('Delete')),
        refs.retry = h('button', { type: 'button', class: 'chip dl-ctl', onclick: () => { if (transferOperations.get(refs.data.hash)?.label) return; transferOperations.delete(refs.data.hash); runTransferAction(refs.data, 'retry'); } }, T('Retry')))));
  el._refs = refs;
  return el;
}

const isPaused = (d) => /^(paused|stopped)/.test(d.state || '');

const transferOperations = new Map();
async function runTransferAction(d, action) {
  if (d.canManage === false || transferOperations.has(d.hash)) return;
  const opener = document.activeElement, actionCard = opener?.closest?.('.dl');
  const operation = { label: action === 'pause' ? T('Pausing…') : action === 'resume' ? T('Resuming…') : T('Checking files…') };
  transferOperations.set(d.hash, operation); patchTransferNodes();
  try {
    await api(`/api/downloads/${encodeURIComponent(d.hash)}/${action}`, jsonPost({}));
    invalidateDownloadsRead();
    const latest = state.downloads.find(item => item.hash === d.hash);
    if (latest) latest.state = action === 'pause' ? 'pausedDL' : action === 'resume' ? 'downloading' : 'checkingDL';
    operation.error = null;
  } catch (err) { operation.error = err.message; }
  finally {
    if (operation.error) { operation.label = ''; } else transferOperations.delete(d.hash); patchUnifiedLibrary();
    if (document.activeElement === document.body) {
      const target = opener?.isConnected && !opener.hidden && !opener.disabled ? opener : [...(actionCard?.querySelectorAll('button') || [])].find(button => !button.hidden && !button.disabled && button.getClientRects().length > 0);
      target?.focus({ preventScroll: true });
    }
  }
}
async function togglePause(d) { const prior = transferOperations.get(d.hash); if (prior?.error) transferOperations.delete(d.hash); await runTransferAction(d, isPaused(d) ? 'resume' : 'pause'); }

function openDeleteDownload(d, opener) {
  if (transferOperations.get(d.hash)?.label || d.canManage === false) return;
  const restoreManager = pickerManagerSubview(opener);
  const body = $('#picker-body');
  const status = h('p', { class: 'device-status', role: 'status' });
  const label = [d.title, episodeLabel(d), d.year && !d.season ? `(${d.year})` : null].filter(Boolean).join(' ');
  const run = async (files, btn) => {
    body.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = T('Deleting…');
    try {
      await api(`/api/downloads/${d.hash}/delete`, jsonPost({ files }));
      invalidateDownloadsRead();
      if (!restoreManager) closeTopOverlay();
      toast(files ? T('Download and files deleted') : T('Removed from downloads; files kept'));
      state.downloads = state.downloads.filter((x) => x.hash !== d.hash);
      restoreManager?.();
      if (state.view === 'library') renderLibrary();
      if (state.view === 'downloads') renderDownloads();
      setTimeout(async () => { await Promise.all([loadLibrary(), loadDownloads()]); renderView(); }, 4000);
    } catch (err) {
      body.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      btn.textContent = btn.dataset.label;
      status.className = 'device-status is-error';
      status.textContent = err.message;
      if (document.activeElement === document.body) btn.focus({ preventScroll: true });
    }
  };
  const button = (text, cls, files) => {
    const b = h('button', { class: cls, 'data-label': text }, text);
    b.addEventListener('click', () => run(files, b));
    return b;
  };
  const cancel = h('button', { class: 'del-cancel', onclick: () => restoreManager ? restoreManager() : closeTopOverlay() }, T('Keep it'));
  body.replaceChildren(...[
    h('h2', { id: 'picker-title' }, d.done ? T('Delete this download?') : T('Cancel this download?')),
    h('p', { class: 'del-name' }, label),
    h('p', { class: 'muted' }, d.name),
    d.season != null && d.episode == null && h('p', { class: 'muted' }, T('This action affects every file in this season pack.')),
    d.libraryIds?.length && h('p', { class: 'muted' }, T('Files still used by another person’s library are protected. The server will refuse file deletion while they are shared.')),
    h('p', { class: 'muted' }, d.done
      ? T('Removes it from qBittorrent, so it stops seeding, and deletes its files ({0}). This can’t be undone.', fmtBytes(d.size))
      : T('Stops the download and deletes what has been downloaded so far ({0}% of {1}).', Math.floor(d.progress * 100), fmtBytes(d.size))),
    h('div', { class: 'del-actions' },
      button(d.done ? T('Remove transfer and delete files') : T('Cancel and delete downloaded files'), 'del-confirm', true),
      button(T('Remove from list, keep files'), 'del-confirm del-secondary', false),
      cancel),
    status].filter(Boolean));
  if (!restoreManager) pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));
  cancel.focus();
}

// "12 of 340 seeders": connected now, of the whole swarm. The bulb is lit when plenty feed it, dim with a few, out with none.
function seedersChip(d) {
  if (!Number.isFinite(d.seeds)) return null;
  const swarm = Number.isFinite(d.swarmSeeds) && d.swarmSeeds > d.seeds ? d.swarmSeeds : null;
  const health = d.seeds >= 10 ? 'good' : d.seeds >= 1 ? 'ok' : 'poor';
  const text = swarm != null ? T('{0} of {1} seeders', d.seeds.toLocaleString(locale), swarm.toLocaleString(locale)) : `${d.seeds.toLocaleString(locale)} ${d.seeds === 1 ? 'seeder' : 'seeders'}`;
  return h('span', { class: `seeds seeds-${health}`, title: swarm != null ? T('Connected to {0} of the {1} seeders the trackers report', d.seeds.toLocaleString(locale), swarm.toLocaleString(locale)) : T('Seeders connected right now') }, text);
}

function updateDlCard(el, d) {
  if (!el) return;
  const r = el._refs;
  r.data = d;
  const pct = Math.floor(Math.max(0, Math.min(1, Number(d.progress) || 0)) * 100);
  const operation = transferOperations.get(d.hash);
  const label = operation?.label || (d.ready ? (d.converting ? T('Preparing playback') : T('Ready to watch')) : transferState(d));
  r.release.textContent = d.name;
  r.error.textContent = operation?.error || (d.ready && d.mediaType === 'tv' && d.episode == null && !(d.libraryIds || []).length ? T('Verified files are outside the media library. Add the download folder to the media library to play individual episodes.') : '') || (d.canManage === false ? T('Shared download. Only the person who started it can change the transfer.') : '');
  const fileKey = JSON.stringify(d.files || []);
  if (r.fileKey !== fileKey) { r.fileKey = fileKey; r.files.hidden = !(d.files || []).length; r.files.querySelector('ul').replaceChildren(...(d.files || []).map(f => h('li', {}, `${f.name} · ${fmtBytes(f.size)} · ${f.available ? T('File ready') : `${Math.floor((f.progress || 0)*100)}%`}`))); }
  r.title.textContent = [d.canonicalTitle || d.title, d.season != null && d.episode == null ? T('{0} pack', seasonName(d.season)) : episodeLabel(d), d.year && !d.season ? `(${d.year})` : null].filter(Boolean).join(' ');
  r.title.title = d.name;
  r.state.textContent = state.dlScope === 'all' && d.owner ? T('{0} · for {1}', label, d.owner) : label;
  r.state.classList.toggle('is-error', d.state === 'error' || d.state === 'missingFiles');
  r.actions.hidden = !d.ready || d.mediaType === 'tv' && d.episode == null;
  r.play.setAttribute('aria-label', T('Play {0} here', d.title));
  r.cast.setAttribute('aria-label', T('Play {0} on a TV', d.title));
  r.bar.hidden = d.done;
  r.bar.style.setProperty('--p', `${pct}%`);
  if (Number.isFinite(d.progress) && d.size > 0) r.bar.setAttribute('aria-valuenow', String(Math.floor(pct))); else r.bar.removeAttribute('aria-valuenow');
  r.bar.setAttribute('aria-valuetext', `${label}${Number.isFinite(d.progress) && d.size > 0 ? `, ${pct} percent` : ''}`);
  r.bar.setAttribute('aria-label', T('{0} download progress', d.title));
  const SUB_STATE = { waiting: T('subtitles when done'), ready: T('subtitles ready'), missing: T('subtitles not found'), error: T('subtitles failed') };
  const subs = (d.subs || []).map((x) => h('span', { class: `sub-state sub-${x.state}` }, `${x.name} ${SUB_STATE[x.state] || ''}`));
  const stats = d.done
    ? [fmtBytes(d.size), ...subs]
    : [h('strong', {}, Number.isFinite(d.progress) && d.size > 0 ? `${pct}%` : label), d.size > 0 && `${fmtBytes(Math.round(d.size * (Number(d.progress) || 0)))} / ${fmtBytes(d.size)}`, !isPaused(d) && !transferAttention(d) && !/checking/.test(d.state || '') && d.speed > 0 && `${fmtBytes(d.speed)}/s`, !isPaused(d) && !transferAttention(d) && !/checking/.test(d.state || '') && Number.isFinite(d.eta) && d.eta >= 0 && d.eta < 8640000 && fmtEta(d.eta), !isPaused(d) && !/checking/.test(d.state || '') && seedersChip(d), ...subs];
  r.stats.replaceChildren(...stats.filter(Boolean).map((s) => (s instanceof Node ? s : h('span', {}, s))));
  r.pause.hidden = d.done;
  r.del.hidden = d.canManage === false;
  r.del.textContent = d.done ? T('Remove transfer') : d.season != null && d.episode == null ? T('Cancel season pack') : T('Cancel download');
  r.pause.disabled = d.canManage === false; r.del.disabled = false;
  r.pause.setAttribute('aria-disabled', String(d.canManage === false || Boolean(operation?.label))); r.del.setAttribute('aria-disabled', String(Boolean(operation?.label)));
  r.retry.hidden = !transferAttention(d) && !operation?.error; r.retry.disabled = d.canManage === false; r.retry.setAttribute('aria-disabled', String(d.canManage === false || Boolean(operation?.label)));
  r.play.classList.toggle('is-disabled', Boolean(d.converting));
  r.play.setAttribute('aria-disabled', String(Boolean(d.converting)));
  r.play.title = d.converting ? T('Getting ready to play') : '';
  r.pause.textContent = operation?.label || (isPaused(d) ? T('Resume') : T('Pause'));
  r.pause.setAttribute('aria-label', `${isPaused(d) ? T('Resume') : T('Pause')} ${d.title}`);
}

let managerView = null;
function pickerManagerSubview(opener) {
  if (!managerView || !$('#picker-body').contains(opener)) return null;
  const manager = managerView, content = [...$('#picker-body').childNodes];
  manager.suspended = true;
  return () => {
    if (managerView !== manager) return;
    $('#picker-body').replaceChildren(...content); manager.suspended = false; drawTransferDetails();
    (opener?.isConnected ? opener : $('#picker-body').querySelector('button') || $('#picker').querySelector('.sheet-close'))?.focus({ preventScroll: true });
  };
}
function renderDownloads() { if (state.view === 'downloads') { state.libAvailability = 'downloading'; setView('library'); } patchTransferNodes(); }
function openTransferDetails(entry, opener) {
  const list = h('ul', { class: 'rows transfer-detail-list' });
  const scope = h('div');
  $('#picker-body').replaceChildren(h('h2', { id: 'picker-title' }, entry ? T('{0} downloads', entry.name) : T('Manage server downloads')), scope, list);
  managerView = { list, entryKey: entry?.key || null, hashes: entry?.transfers.map(d => d.hash) || null, scope };
  if (!entry && state.me?.isOwner) scope.append(segmented([['mine', T('Mine')], ['all', T('Everyone')]], state.dlScope, async v => { state.dlScope = v; scope.querySelectorAll('button').forEach((b,i) => b.setAttribute('aria-pressed', String((i ? 'all' : 'mine') === v))); await loadDownloads(); drawTransferDetails(); }, T('Whose downloads')));
  drawTransferDetails();
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { managerView = null; if (state.dlScope !== 'mine') { state.dlScope = 'mine'; loadDownloads().then(patchUnifiedLibrary); } opener?.focus({ preventScroll: true }); }));
}
function drawTransferDetails() {
  if (!managerView || managerView.suspended) return;
  const { list, hashes } = managerView;
  const items = state.downloads.filter(d => hashes ? hashes.includes(d.hash) : true);
  if (items.length) for (const child of [...list.children]) if (!child._refs) child.remove();
  const seen = new Set();
  for (const [index,d] of items.entries()) {
    let card = dlCards.get(d.hash); if (!card || !list.contains(card)) { card = makeDlCard(d); dlCards.set(d.hash, card); transferNodes.add(card); }
    transferNodes.add(card); updateDlCard(card,d); seen.add(d.hash); if (list.children[index] !== card) list.insertBefore(card,list.children[index] || null);
  }
  for (const child of [...list.children]) if (child._refs && !seen.has(child._refs.data.hash)) child.remove();
  if (!items.length && !list.children.length) list.append(h('li', { class: 'muted' }, state.downloadsError || T('No downloads in this view.')));
}
function patchTransferNodes() {
  for (const node of transferNodes) {
    if (!node.isConnected) { transferNodes.delete(node); continue; }
    const d = state.downloads.find(d => d.hash === node._refs.data.hash); if (d) updateDlCard(node, d);
  }
  for (const row of document.querySelectorAll('.pending-episode')) {
    const d = state.downloads.find(d => d.hash === row.dataset.transferHash), ep = d?.episodes?.find(ep => String(ep.season) === row.dataset.episodeSeason && String(ep.episode) === row.dataset.episodeNumber);
    if (ep) $('.episode-transfer-state', row).textContent = ep.available ? T('Ready · watch it from Details') : `${transferState(d)}${Number.isFinite(ep.progress) ? ` · ${Math.floor(ep.progress*100)}%` : ''}`;
  }
  drawTransferDetails();
  refreshCommandViews();
}
function patchUnifiedLibrary() { if (state.view === 'library') renderLibrary(); patchTransferNodes(); }

// Downloads claims completed files before replying, so read it before refreshing the library.
let mediaRefreshRequest = null;
function refreshMediaLibrary() {
  if (mediaRefreshRequest) return mediaRefreshRequest;
  mediaRefreshRequest = (async () => {
    await loadDownloads();
    if (state.view === 'downloads') renderDownloads();
    if (libraryRefreshNeeded || (state.view === 'library' || current) && Date.now() - libraryLastChecked >= 30000) {
      libraryRefreshNeeded = false;
      await loadLibrary();
      libraryRefreshNeeded ||= Boolean(state.libraryError);
      renderUpdatedLibrary();
    }
    if (typeof patchUnifiedLibrary === 'function') patchUnifiedLibrary();
  })().finally(() => { mediaRefreshRequest = null; });
  return mediaRefreshRequest;
}
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const clipsBusy = state.view === 'clips' && state.clips?.clips?.some((c) => c.share && !c.share.ready && !c.share.error);
  const powerBusy = state.view === 'house' && state.house?.power?.some((pw) => pw.pending);
  const downloading = state.downloads.some((d) => d.mine !== false && !d.done);
  const delay = state.view === 'downloads' ? 2000 : state.view === 'notes' ? 5000 : state.view === 'library' || downloading || current || clipsBusy || powerBusy ? 3000 : ['activity', 'house'].includes(state.view) ? 10000 : 15000;
  pollTimer = setTimeout(async () => {
    try {
      if (!document.hidden) {
        await Promise.all([refreshMediaLibrary(), loadSessions(), state.view === 'library' ? loadConvert() : null]);
        if (state.view === 'activity' && !$('#activity-body .person-name .clip-rename-form')) { await loadActivity(); if (state.view === 'activity') renderActivity(); }
        if (state.view === 'house') { await loadHouse(); if (state.view === 'house') renderHouse(); }
        if (state.view === 'notes') await notesView.poll();
        if (state.view === 'clips' && clipsBusy && !$('#clips-body .clip-rename-form')) { await loadClips(); if (state.view === 'clips') renderClips(); }
        if (state.view === 'library') renderConvertBanner();
      }
    } finally { schedulePoll(); }
  }, delay);
}
function refreshOnReturn() {
  if (document.hidden) return;
  refreshMediaLibrary().catch(() => {}).finally(schedulePoll);
  updateUpNext();
}
document.addEventListener('visibilitychange', refreshOnReturn);
window.addEventListener('pageshow', refreshOnReturn);
document.addEventListener('focusout', () => { if (libraryRenderPending) setTimeout(renderUpdatedLibrary, 0); });

// ---------- live updates ----------
// The server announces what changed (live.js on the server: a delete, a finished download, progress
// saved on another device, a new note...), and this page refetches just that part right away instead
// of waiting for the next poll or a reload. Polling above stays as the fallback.
const live = { source: null, topics: new Set(), timer: null, resync: false, retry: null };
function connectLive(resync = false) {
  if (live.source || document.hidden || typeof EventSource !== 'function') return;
  clearTimeout(live.retry);
  live.resync ||= resync;
  const source = live.source = new EventSource(`/api/events?tab=${TAB_ID}`);
  source.onopen = () => { if (live.resync) { live.resync = false; queueLive('all'); } };
  source.onmessage = (e) => { try { queueLive(JSON.parse(e.data).topic); } catch { /* not ours */ } };
  source.onerror = () => {
    live.resync = true; // events may have been missed while the stream was down
    if (source.readyState !== EventSource.CLOSED) return; // the browser reconnects by itself
    if (live.source === source) live.source = null; // e.g. the sign-in ran out; try again later
    live.retry = setTimeout(() => connectLive(true), 30000);
  };
}
function disconnectLive() { clearTimeout(live.retry); live.source?.close(); live.source = null; }
// Hidden pages drop the stream (phones, and the browser's limit on open connections) and catch up on return.
document.addEventListener('visibilitychange', () => { if (document.hidden) disconnectLive(); else connectLive(true); });
function queueLive(topic) {
  live.topics.add(topic);
  clearTimeout(live.timer);
  live.timer = setTimeout(applyLive, 150);
}
// A refresh that is already running may have started before the change, so run one more after it.
async function refreshLibraryNow() {
  libraryRefreshNeeded = true;
  if (mediaRefreshRequest) await mediaRefreshRequest.catch(() => {});
  if (libraryRefreshNeeded) await refreshMediaLibrary();
}
const editingIn = (sel) => { const el = document.activeElement; return Boolean(el && $(sel)?.contains(el) && el.matches('input, textarea, select, [contenteditable="true"]')); };
async function applyLive() {
  const topics = live.topics;
  live.topics = new Set();
  const has = (t) => topics.has('all') || topics.has(t);
  const view = state.view;
  const jobs = [];
  if (has('library') || has('people')) {
    jobs.push(refreshLibraryNow().then(() => (view === 'library' ? loadConvert().then(renderConvertBanner) : null)));
  }
  if (has('progress')) {
    jobs.push(loadProgress().then(() => { invalidateLibraryProgress(); if (state.view === 'library') renderLibrary(); updateUpNext(); }));
  }
  if (has('sessions')) jobs.push(loadSessions());
  if (has('watchlist')) jobs.push(loadWatchlist());
  if (has('travel')) jobs.push(loadTravel());
  if (has('push')) { pushView.loaded = false; if (view === 'settings' && !editingIn('#settings-body')) jobs.push(loadPush().then(renderSettings)); }
  if (has('social') || has('avatars')) social.refreshRates();
  if (has('avatars') && view === 'library') jobs.push(loadParties());
  if (has('parties') && view === 'library') jobs.push(loadParties());
  if (has('me') || has('people') || has('avatars')) {
    jobs.push((async () => {
      try {
        state.status = await api('/api/status');
        state.me = state.status.me; state.rules = state.status.rules;
        applyTheme(prefs().theme);
      } catch { return; }
      maybeShowWhatsNew(); // e.g. the server came back from an update
      if (state.view === 'settings' && state.me?.isOwner) await loadPeople();
      if (state.view === 'settings' && !editingIn('#settings-body')) renderSettings();
    })());
  }
  if (has('notes') && view === 'notes') jobs.push(notesView.poll());
  if (has('clips') && view === 'clips' && !$('#clips-body .clip-rename-form')) jobs.push(loadClips().then(() => { if (state.view === 'clips') renderClips(); }));
  if (has('house') && view === 'house') jobs.push(loadHouse().then(() => { if (state.view === 'house') renderHouse(); }));
  // Every change shows up in the Activity log.
  if (topics.size && view === 'activity' && !$('#activity-body .person-name .clip-rename-form')) jobs.push(loadActivity().then(() => { if (state.view === 'activity') renderActivity(); }));
  await Promise.allSettled(jobs);
}

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
    const timer = setTimeout(() => { window.removeEventListener('popstate', done); reject(new Error(T('Couldn’t close the previous screen. Please try joining again.'))); }, 3000);
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
window.addEventListener('popstate', () => { overlayStack.pop()?.(); renderUpdatedLibrary(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!ccMenu.hidden) { closeCcMenu(); ccBtn.focus(); return; }
  if (!audioMenu.hidden) { closeAudioMenu(); audioBtn.focus(); return; }
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
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => {
    $('#sheet-body .trailer-frame')?.remove(); // closing the sheet stops the trailer
    opener?.focus({ preventScroll: true });
  }));
}

// The backdrop at the top of a title sheet. When TMDB has a trailer, a Trailer button sits on it and
// the trailer plays right there, in the backdrop's place (YouTube's no-cookie player, loaded on click).
function detailsHero(t) {
  const hero = h('div', { class: `sheet-hero${t.backdrop ? '' : ' no-image'}`, style: t.backdrop ? `background-image:url("${t.backdrop}")` : null });
  if (!t.id || !['movie', 'tv'].includes(t.type)) return hero;
  cachedFor(`/api/title/${t.type}/${t.id}/trailer`, 60 * 60 * 1000).then(({ trailer }) => {
    if (!trailer || !hero.isConnected) return;
    const label = trailer.type === 'Teaser' ? T('Teaser') : T('Trailer');
    const play = h('button', { type: 'button', class: 'trailer-btn', 'aria-label': T('Play {0}: {1}', label.toLowerCase(), t.title) },
      icon('play'), h('span', {}, label));
    play.addEventListener('click', () => {
      const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}?autoplay=1&rel=0&playsinline=1`;
      hero.classList.add('is-playing');
      hero.replaceChildren(h('iframe', {
        class: 'trailer-frame', src, title: `${t.title}: ${trailer.name}`,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true,
        referrerpolicy: 'strict-origin-when-cross-origin',
      }));
    });
    hero.append(play);
  }).catch(() => {});
  return hero;
}

function renderDetails(t) {
  const files = matchesFor(t);
  const onServer = serverMatchesFor(t);
  const isTv = t.type === 'tv';
  // Shows: one Download button opens the season panel; films: Play and/or Download right here.
  const tv = isTv && canGet() && t.id ? showDownload(t) : null;
  const actions = isTv
    ? h('div', { class: 'title-actions' }, tv && h('div', { class: 'action-row' }, tv.toggle), tv?.panel,
      transferSummary(() => titleState(t).transfers, t.title))
    : filmActions(t);
  const versionFiles = isTv ? [] : allVersions(files.filter((f) => f.kind === 'lib'));
  const versions = versionFiles.length > 1;
  $('#sheet-body').replaceChildren(
    detailsHero(t),
    h('div', { class: 'sheet-content' },
      h('h2', { id: 'sheet-title' }, t.title),
      h('ul', { class: 'facts' },
        t.year && h('li', {}, t.year),
        h('li', {}, t.type === 'tv' ? T('Series') : T('Film')),
        t.rating && h('li', {}, `★ ${t.rating}`)),
      social.rateRow(titleKeyOf(t), t.title),
      actions,
      !isTv && filmVersionPick(t, () => renderDetails(t)),
      state.status.search && t.id && watchBox(t),
      t.overview && h('p', { class: 'overview' }, t.overview),
      // Without download rights, episodes someone else has here can still be added (no copy is made).
      isTv && !canGet() && onServer.length > 0 && serverOffer(t, onServer),
      isTv && files.length > 0 && h('h3', {}, T('In your library')),
      isTv && files.length > 0 && seasonGroups(files),
      versions && h('h3', {}, T('Your versions')),
      versions && h('ul', { class: 'rows' }, versionFiles.map((v) => fileRow(libraryFile({ ...v, versionOf: true }))))));
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
      toast(files.length === 1 ? T('Added to your library') : T('Added {0} to your library', plural(files.length, 'episode')));
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
        button(T('Add'), 'chip', [f]),
        button(T('Add & play'), 'play-btn', [f], true))));
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
          h('div', { class: 'row-title' }, n < 0 ? T('Other videos') : seasonName(n)),
          h('div', { class: 'row-meta' }, h('span', {}, plural(episodeCount(eps), 'episode')), span && h('span', {}, span))),
        h('div', { class: 'row-actions' }, button(n < 0 ? T('Add') : T('Add season'), 'chip', eps)));
    });
  }
  return h('div', { class: 'server-offer' },
    h('div', { class: 'server-offer-head' },
      h('h3', {}, T('Ready to watch now')),
      isTv && rows.length > 1 && button(T('Add all {0}', plural(episodeCount(list), 'episode')), 'play-btn', list)),
    h('p', { class: 'muted' }, isTv
      ? T('These are already here. Add them to your library and watch right away.')
      : T('This is already here. Add it to your library and watch right away.')),
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
          h('span', { class: 'row-meta' }, h('span', {}, plural(episodeCount(eps), 'episode')), busy > 0 && h('span', {}, T('{0} downloading', busy)))),
        h('ul', { class: 'rows' }, eps.map(fileRow)));
    }));
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

// ---------- Download: you choose what, the server chooses how (smart-download.js) ----------
// One command for films, seasons and single episodes. Films: Download picks a release straight away.
// Shows: Download opens a small panel (season, quality, Download Season). Manual releases and an
// exact resolution live under Advanced options. Progress shows where the title is, never as a list.
const PROFILE_OPTIONS = [['save', T('Save Space')], ['balanced', T('Balanced · 1080p')], ['best', T('Best Quality')]];
const EXACT_OPTIONS = [['', T('Use the quality setting')], ['2160p', T('4K only')], ['1440p', T('1440p only')], ['1080p', T('1080p only')], ['720p', T('720p only')]];
const savedProfile = () => {
  const p = prefs();
  return ['save', 'balanced', 'best'].includes(p.downloadProfile) ? p.downloadProfile
    : ['2160p', '1440p'].includes(p.quality) ? 'best' : p.quality === '720p' ? 'save' : 'balanced';
};
const canGet = () => Boolean(state.status.torrents && canDownload());

// Commands by target, so a sheet that re-renders (or is reopened) shows the same state.
const downloadCommands = new Map(); // key -> { body, busy, job, error }
const commandKey = (b) => [b.type, b.tmdbId, b.season ?? '', (b.episodes || []).join(','), b.upgrade ? 'upgrade' : ''].join(':');
const commandViews = new Set();     // nodes with _update(), refreshed on command and transfer changes
function refreshCommandViews() {
  for (const node of commandViews) { if (!node.isConnected) commandViews.delete(node); else node._update(); }
}
const commandStep = (cmd) => (/^(Starting|Startar)/.test(cmd?.job?.step || '') ? T('Adding…') : T('Finding the best copy…'));

async function runDownloadCommand(body) {
  const key = commandKey(body);
  if (downloadCommands.get(key)?.busy) return downloadCommands.get(key);
  const cmd = { body, busy: true, job: null, error: null };
  downloadCommands.set(key, cmd);
  refreshCommandViews();
  try {
    const { id } = await api('/api/downloads/smart', jsonPost(body));
    for (let i = 0; i < 500; i++) { // a few minutes at most; the job keeps going on the server regardless
      cmd.job = await api(`/api/downloads/smart/${id}`);
      refreshCommandViews();
      if (cmd.job.state !== 'running') break;
      await new Promise((r) => setTimeout(r, i < 8 ? 800 : 1500));
    }
  } catch (err) { cmd.error = err.message; }
  cmd.busy = false;
  if (cmd.job?.outcome === 'have') await loadLibrary();
  await loadDownloads();
  patchUnifiedLibrary();
  refreshCommandViews();
  if (['started', 'partial'].includes(cmd.job?.outcome)) toast(body.upgrade ? T('{0}: upgrading season {1}', cmd.job.title, cmd.job.season) : cmd.job.type === 'tv' ? `${cmd.job.title}: ${cmd.job.message}` : T('{0} is on its way. It’ll be ready to watch soon.', cmd.job.title));
  return cmd;
}
// A command's result in plain words, or null while there's nothing to say.
function commandResult(cmd) {
  if (!cmd || cmd.busy) return null;
  if (cmd.error) return { text: cmd.error, retry: true };
  const j = cmd.job;
  if (!j) return null;
  if (j.state === 'failed') return { text: j.message || j.error, retry: true };
  if (j.outcome === 'none') return { text: j.message, retry: true, episodes: j.unavailable?.map((u) => u.episode) };
  if (j.outcome === 'partial') return { text: j.message, retry: true, episodes: j.unavailable.map((u) => u.episode), partial: true };
  if (j.outcome === 'have' || j.outcome === 'queued') return { text: j.message };
  return null;
}

// Adds videos someone else already has here to your library (no copy is made) and refreshes the views.
async function addFromServer(files) {
  await api('/api/library/add', jsonPost({ ids: files.map((f) => f.id) }));
  await loadLibrary();
  const eps = episodeCount(files.filter((f) => f.episode != null));
  toast(eps > 1 ? T('Added {0} to your library', plural(eps, 'episode')) : T('Added to your library'));
  patchUnifiedLibrary();
  refreshCommandViews();
}
// Someone else's copies of episodes you don't have yet (one per episode).
function serverOnlyEpisodes(s, season = null) {
  const mine = new Set(s.ready.map((f) => `${f.season}:${f.episode}`));
  const out = new Map();
  for (const f of s.onServer) {
    const k = `${f.season}:${f.episode}`;
    if (f.episode == null || (season != null && f.season !== season) || mine.has(k) || out.has(k)) continue;
    out.set(k, f);
  }
  return [...out.values()];
}

// A title's files and transfers, from the same state the Library uses.
function titleState(t) {
  const match = sameTitle(t);
  const files = matchesFor(t), onServer = serverMatchesFor(t);
  const transfers = state.downloads.filter((d) => d.mine !== false && match({ ...d, title: d.canonicalTitle || d.title, show: d.showId || d.show }));
  const active = transfers.filter((d) => !d.done || d.converting || transferAttention(d));
  return { files, onServer, ready: files.filter((f) => f.kind === 'lib' || f.ready), transfers, active };
}

// State, percentage and a slim bar for one title's downloads, with Pause/Resume, Retry and Details.
function transferSummary(getTransfers, name) {
  const stateEl = h('span', { class: 'transfer-state' }), pct = h('span', { class: 'transfer-percent' });
  const track = h('div', { class: 'transfer-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': T('{0} download progress', name) }, h('i'));
  const pause = h('button', { type: 'button', class: 'chip transfer-ctl' });
  const retry = h('button', { type: 'button', class: 'chip transfer-ctl' }, T('Retry'));
  const details = h('button', { type: 'button', class: 'link-btn transfer-details' }, T('Details'));
  const el = h('div', { class: 'transfer-summary' }, h('div', { class: 'transfer-line' }, stateEl, pct), track, h('div', { class: 'transfer-controls' }, pause, retry, details));
  const list = () => getTransfers().filter((d) => !d.done || d.converting || transferAttention(d));
  pause.addEventListener('click', () => {
    const mine = list().filter((d) => d.canManage !== false && !transferAttention(d));
    const resume = mine.length && mine.every((d) => isPaused(d));
    for (const d of mine.filter((x) => resume ? isPaused(x) : !isPaused(x))) runTransferAction(d, resume ? 'resume' : 'pause');
  });
  retry.addEventListener('click', () => { for (const d of list().filter(transferAttention)) runTransferAction(d, 'retry'); });
  details.addEventListener('click', (e) => openTransferDetails({ key: `title:${name}`, name, transfers: getTransfers() }, e.currentTarget));
  el._update = () => {
    const active = list();
    el.hidden = !active.length;
    if (!active.length) return;
    const attention = active.some(transferAttention);
    const known = active.every((d) => Number.isFinite(d.size) && d.size > 0 && Number.isFinite(d.progress));
    const progress = known ? active.reduce((n, d) => n + d.size * Math.max(0, Math.min(1, d.progress)), 0) / active.reduce((n, d) => n + d.size, 0) : null;
    const label = attention ? T('Needs attention') : active.length === 1 ? transferState(active[0])
      : active.every((d) => isPaused(d)) ? T('Paused') : T('Downloading · {0}', plural(active.length, 'download'));
    stateEl.textContent = label;
    pct.textContent = progress == null ? '' : `${Math.floor(progress * 100)}%`;
    track.firstChild.style.width = progress == null ? '0%' : `${progress * 100}%`;
    if (progress == null) track.removeAttribute('aria-valuenow'); else track.setAttribute('aria-valuenow', String(Math.floor(progress * 100)));
    track.setAttribute('aria-valuetext', `${label}${progress == null ? '' : `, ${Math.floor(progress * 100)} percent`}`);
    el.classList.toggle('is-error', attention);
    const mine = active.filter((d) => d.canManage !== false && !transferAttention(d));
    const resume = mine.length > 0 && mine.every((d) => isPaused(d));
    pause.hidden = !mine.length;
    pause.textContent = resume ? T('Resume') : T('Pause');
    pause.setAttribute('aria-label', `${resume ? T('Resume') : T('Pause')} ${name}`);
    retry.hidden = !attention;
  };
  commandViews.add(el);
  el._update();
  return el;
}

// "Advanced options": an exact resolution for this command, and the release list for choosing one.
const advancedOpen = new Map(); // title key -> open
function advancedOptions(key, { exact, onExact, browse }) {
  const exactSel = h('select', { class: 'sub-select', id: `adv-exact-${key}` }, EXACT_OPTIONS.map(([v, text]) => h('option', { value: v }, text)));
  exactSel.value = exact;
  exactSel.addEventListener('change', () => onExact(exactSel.value));
  const browser = h('div', { class: 'adv-browser' });
  const browseBtn = h('button', { type: 'button', class: 'chip stroke-icon' }, icon('search'), T('Choose a release yourself'));
  browseBtn.addEventListener('click', () => {
    browseBtn.hidden = true;
    const b = torrentBrowser(browse());
    browser.replaceChildren(b.el);
    b.start();
  });
  const box = h('details', { class: 'advanced' },
    h('summary', {}, T('Advanced options')),
    h('div', { class: 'adv-body' },
      h('div', { class: 'adv-field' }, h('label', { for: `adv-exact-${key}` }, T('Exact quality')), exactSel,
        h('p', { class: 'adv-hint' }, T('Only this resolution is looked for. If there’s none, nothing else is picked instead.'))),
      browseBtn, browser));
  box.open = Boolean(advancedOpen.get(key));
  box.addEventListener('toggle', () => advancedOpen.set(key, box.open));
  return box;
}

// Films: Play when it's here (or on the server), else one Download press. Then state and progress.
const filmExact = new Map(); // tmdb id -> exact resolution for this session
function filmActions(t) {
  const body = () => ({ type: 'movie', tmdbId: t.id, ...(filmExact.get(t.id) ? { quality: filmExact.get(t.id) } : {}) });
  const play = h('button', { type: 'button', class: 'play-btn action-btn' });
  const get = h('button', { type: 'button', class: 'play-btn action-btn stroke-icon' }, icon('plus'), h('span', {}, T('Add to library')));
  const row = h('div', { class: 'action-row' }, play, get);
  const status = h('p', { class: 'action-status', role: 'status' });
  const retry = h('button', { type: 'button', class: 'chip action-retry' }, T('Try again'));
  const progress = transferSummary(() => titleState(t).transfers, t.title);
  const root = h('div', { class: 'title-actions' }, row, progress, h('div', { class: 'action-result' }, status, retry));
  if (canGet() && t.id) root.append(advancedOptions(`movie-${t.id}`, {
    exact: filmExact.get(t.id) || '', onExact: (v) => filmExact.set(t.id, v),
    browse: () => ({ query: [t.title, t.year].filter(Boolean).join(' '), type: 'movie', movieId: t.id, canonicalTitle: t.title, strict: true }),
  }));
  let playing = false;
  play.addEventListener('click', async () => {
    if (play.getAttribute('aria-disabled') === 'true') return;
    const s = titleState(t), mine = s.ready.find((f) => !f.converting);
    if (mine) return openPlayer(mine);
    if (!s.onServer.length || playing) return;
    playing = true; play.setAttribute('aria-disabled', 'true');
    try {
      await api('/api/library/add', jsonPost({ ids: [s.onServer[0].id] }));
      await loadLibrary();
      const added = state.library.find((x) => x.mediaKey === s.onServer[0].mediaKey);
      if (added) openPlayer(libraryFile(added));
      patchUnifiedLibrary();
    } catch (err) { status.textContent = err.message; } finally { playing = false; root._update(); }
  });
  let adding = false;
  const start = () => { if (get.getAttribute('aria-disabled') !== 'true') runDownloadCommand(body()); };
  get.addEventListener('click', async () => {
    if (get.getAttribute('aria-disabled') === 'true') return;
    const s = titleState(t);
    if (s.ready.length || !s.onServer.length) return start();
    // Someone else already has it here: add their copy instead of downloading another.
    adding = true; status.textContent = ''; root._update();
    try { await addFromServer([s.onServer[0]]); } catch (err) { status.textContent = err.message; } finally { adding = false; root._update(); }
  });
  retry.addEventListener('click', start);
  root._update = () => {
    const s = titleState(t), cmd = downloadCommands.get(commandKey(body()));
    const file = s.ready.find((f) => !f.converting) || s.ready[0];
    const playable = Boolean(file || s.onServer.length);
    play.hidden = !playable;
    if (playable) {
      const saved = file && savedProgress(file);
      const converting = file && !s.ready.some((f) => !f.converting);
      play.replaceChildren(icon('play'), h('span', {}, converting ? T('Preparing playback…') : partlyWatched(saved) ? T('Resume at {0}', fmtTime(saved.time)) : T('Play')));
      play.setAttribute('aria-disabled', String(Boolean(converting || playing)));
    }
    // "Add to library" either way: someone else's copy here is added at once, otherwise Marquee fetches one.
    // Shown only when there's nothing to play and nothing on its way; while it runs it says what it's doing.
    const addable = !file && s.onServer.length > 0;
    get.hidden = addable ? false : playable || !canGet() || !t.id || (s.active.length > 0 && !cmd?.busy);
        get.lastChild.textContent = adding ? T('Adding…') : cmd?.busy ? commandStep(cmd) : T('Add to library');
    get.setAttribute('aria-disabled', String(Boolean(cmd?.busy || adding)));
    root.setAttribute('aria-busy', String(Boolean(cmd?.busy)));
    const result = !playable && commandResult(cmd);
    if (!addable && status.textContent !== (result?.text || '')) status.textContent = result?.text || '';
    status.classList.toggle('is-error', Boolean(result?.retry));
    retry.hidden = !result?.retry || s.active.length > 0;
    row.hidden = play.hidden && get.hidden;
    progress._update();
  };
  commandViews.add(root);
  root._update();
  return root;
}

// Shows: one Add button opens the panel; the season and quality chosen stay while it's open.
// Long seasons (Black Clover's 170, One Piece's 197) can download a range of episodes instead.
const showPanels = new Map(); // tmdb id -> { open, season, profile, exact, last: { [season]: command key }, ranges: { [season]: { on, from, to } } }
const RANGE_FROM = 40; // episodes in a season before the panel offers a range
function showDownload(t, { season = null } = {}) {
  let ps = showPanels.get(t.id);
  if (!ps) { ps = { open: false, season, profile: savedProfile(), exact: '', last: {}, ranges: {} }; showPanels.set(t.id, ps); }
  else if (season != null && !ps.touched) ps.season = season;
  const panelId = `dl-panel-${t.id}`;
  const toggle = h('button', { type: 'button', class: 'play-btn action-btn stroke-icon', 'aria-expanded': String(ps.open), 'aria-controls': panelId }, icon('plus'), h('span', {}, T('Add to library')));
  const seasonSel = h('select', { class: 'sub-select', id: `${panelId}-season`, disabled: true }, h('option', {}, T('Loading seasons…')));
  const profileSel = h('select', { class: 'sub-select', id: `${panelId}-quality` }, PROFILE_OPTIONS.map(([v, text]) => h('option', { value: v }, text)));
  profileSel.value = ps.profile;
  const avail = h('p', { class: 'dl-avail' });
  const note = h('p', { class: 'dl-note' });
  // Episodes: the whole season, or a range of it ("150 to 200") when the season is long.
  const scopeSel = h('select', { class: 'sub-select', id: `${panelId}-scope` },
    h('option', { value: 'all' }, T('Whole season')), h('option', { value: 'range' }, T('Choose a range')));
  const numInput = (id, label) => h('input', { type: 'number', class: 'dl-num', id, inputmode: 'numeric', step: '1', 'aria-label': label });
  const fromIn = numInput(`${panelId}-from`, T('First episode')), toIn = numInput(`${panelId}-to`, T('Last episode'));
  const rangeRow = h('div', { class: 'dl-field dl-range' }, h('label', { for: fromIn.id }, T('From – to')),
    h('div', { class: 'dl-range-boxes' }, fromIn, h('span', { class: 'dl-range-dash', 'aria-hidden': 'true' }, '–'), toIn));
  const scopeField = h('div', { class: 'dl-field dl-scope' }, h('label', { for: scopeSel.id }, T('Episodes')), scopeSel);
  const submit = h('button', { type: 'button', class: 'play-btn dl-submit' }, h('span', {}, T('Add Season')));
  const quiet = h('p', { class: 'dl-quiet' });
  // Upgrade quality: the season is here but looks soft. A clearly better pack replaces it episode by episode.
  const upBtn = h('button', { type: 'button', class: 'chip dl-upgrade stroke-icon' }, icon('upgrade'), h('span', {}, T('Upgrade quality')));
  const upNote = h('p', { class: 'dl-note dl-upgrade-note' });
  const upStatus = h('p', { class: 'dl-status dl-upgrade-status', role: 'status' });
  const upgradeBox = h('div', { class: 'dl-upgrade-box' }, upBtn, upNote, upStatus);
  const status = h('p', { class: 'dl-status', role: 'status' });
  const retry = h('button', { type: 'button', class: 'chip dl-retry' });
  const panel = h('div', { class: 'dl-panel', id: panelId, hidden: !ps.open },
    h('div', { class: 'dl-fields' },
      h('div', { class: 'dl-field' }, h('label', { for: seasonSel.id }, T('Season')), seasonSel),
      h('div', { class: 'dl-field' }, h('label', { for: profileSel.id }, T('Quality')), profileSel), scopeField, rangeRow),
    note, avail, submit, quiet, h('div', { class: 'dl-result' }, status, retry), upgradeBox,
    advancedOptions(`tv-${t.id}`, {
      exact: ps.exact, onExact: (v) => { ps.exact = v; },
      browse: () => ({ query: `${t.title} S${pad2(ps.season || 1)}`, type: 'tv', tvId: t.id, canonicalTitle: t.title, strict: true }),
    }));
  let seasons = null;
  const load = () => {
    if (seasons || !t.id) return;
    seasons = [];
    tvSeasons(t.id).then((list) => {
      seasons = list;
      const s = titleState(t), have = (n) => episodeCount([...s.ready, ...s.onServer].filter((f) => f.season === n && f.episode != null));
      seasonSel.replaceChildren(...list.map((se) => h('option', { value: String(se.number), disabled: se.upcoming && !have(se.number) ? true : null },
        `${se.name}${se.upcoming && !have(se.number) ? T(' · Not released') : ''}`)));
      const extra = new Set(serverOnlyEpisodes(s).map((f) => f.season)); // seasons someone else has here
      const pick = list.find((se) => se.number === ps.season) || list.find((se) => extra.has(se.number))
        || list.find((se) => !se.upcoming && !(se.episodes && have(se.number) >= se.episodes)) || list.find((se) => !se.upcoming) || list[0];
      if (pick) { ps.season = pick.number; seasonSel.value = String(pick.number); }
      seasonSel.disabled = false;
      panel._update();
    }).catch((err) => { seasons = null; seasonSel.replaceChildren(h('option', {}, T('Seasons unavailable'))); status.textContent = err.message; });
  };
  toggle.addEventListener('click', (e) => {
    ps.open = !ps.open;
    toggle.setAttribute('aria-expanded', String(ps.open));
    panel.hidden = !ps.open;
    if (ps.open) { load(); if (e.detail === 0) seasonSel.focus(); } // keyboard: straight to Season
  });
  seasonSel.addEventListener('change', () => { ps.season = Number(seasonSel.value); ps.touched = true; addError = ''; panel._update(); });
  profileSel.addEventListener('change', () => { ps.profile = profileSel.value; });
  // The season's range state, its TMDB numbering (first..last) and the episodes it asks for.
  const seasonInfo = () => seasons?.find((x) => x.number === ps.season) || null;
  const longSeason = () => (seasonInfo()?.episodes || 0) >= RANGE_FROM;
  const bounds = () => { const se = seasonInfo(), first = se?.first || 1; return { first, last: first + (se?.episodes || 1) - 1 }; };
  const rangeOf = () => {
    const { first, last } = bounds();
    return (ps.ranges[ps.season] ||= { on: false, from: first, to: Math.min(last, first + 49) });
  };
  const rangeList = () => {
    const r = rangeOf(), { first, last } = bounds();
    const from = Math.max(first, Math.min(r.from, r.to)), to = Math.min(last, Math.max(r.from, r.to));
    return Number.isInteger(from) && Number.isInteger(to) && from <= to ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : [];
  };
  const ranged = () => longSeason() && rangeOf().on;
  scopeSel.addEventListener('change', () => { rangeOf().on = scopeSel.value === 'range'; panel._update(); if (rangeOf().on) fromIn.focus(); });
  for (const [input, k] of [[fromIn, 'from'], [toIn, 'to']]) {
    input.addEventListener('input', () => { const v = Number(input.value); if (Number.isInteger(v)) { rangeOf()[k] = v; panel._update(); } });
    input.addEventListener('change', () => { input.value = String(rangeOf()[k]); }); // an empty box goes back to the last number
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });
  }
  const body = (episodes = null, range = false) => ({ type: 'tv', tmdbId: t.id, season: ps.season, profile: ps.profile,
    ...(ps.exact ? { quality: ps.exact } : {}), ...(episodes?.length ? { episodes } : {}), ...(range ? { range: true } : {}) });
  const run = (episodes, range = false) => {
    if (submit.getAttribute('aria-disabled') === 'true' || !ps.season) return;
    const b = body(episodes, range);
    ps.last[ps.season] = commandKey(b);
    runDownloadCommand(b);
  };
  let adding = false, addError = '';
  submit.addEventListener('click', async () => {
    addError = '';
    if (!submit._add) return ranged() ? (rangeList().length ? run(rangeList(), true) : null) : run(null);
    if (submit.getAttribute('aria-disabled') === 'true') return;
    adding = true; panel._update();
    try { await addFromServer(submit._add); } catch (err) { addError = err.message; } finally { adding = false; panel._update(); }
  });
  retry.addEventListener('click', () => run(retry._episodes));
  ps.up ||= {};
  upBtn.addEventListener('click', () => {
    if (upBtn.getAttribute('aria-disabled') === 'true' || !ps.season) return;
    const b = { type: 'tv', tmdbId: t.id, season: ps.season, upgrade: true };
    ps.up[ps.season] = commandKey(b);
    runDownloadCommand(b);
  });
  panel._update = () => {
    const n = ps.season, se = seasons?.find((x) => x.number === n);
    const cmd = downloadCommands.get(ps.last[n]);
    // Episode range: offered for long seasons; the boxes keep to the season's numbers.
    const canRange = longSeason() && !submit._add;
    scopeField.hidden = !canRange;
    const useRange = canRange && rangeOf().on;
    rangeRow.hidden = !useRange;
    const picked = useRange ? rangeList() : null;
    if (canRange) {
      const r = rangeOf(), { first, last } = bounds();
      scopeSel.value = r.on ? 'range' : 'all';
      for (const [input, v] of [[fromIn, r.from], [toIn, r.to]]) {
        input.min = String(first); input.max = String(last);
        if (document.activeElement !== input) input.value = String(v);
      }
    }
    const s = titleState(t);
    const ready = new Set(s.ready.filter((f) => f.season === n && f.episode != null).map((f) => f.episode));
    const server = new Set(s.onServer.filter((f) => f.season === n && f.episode != null && !ready.has(f.episode)).map((f) => f.episode));
    const downloading = new Set(s.active.flatMap((d) => (d.episodes || []).filter((ep) => ep.season === n && !ep.available).map((ep) => ep.episode)).filter((e) => !ready.has(e)));
    const packBusy = s.active.some((d) => d.season === n && !(d.episodes || []).length);
    const total = se?.episodes || null;
    const parts = [ready.size && (total ? T('{0} of {1} episodes ready', ready.size, total) : T('{0} ready', plural(ready.size, 'episode'))),
      downloading.size ? T('{0} on the way', downloading.size) : packBusy && T('Season on its way'),
      server.size && T('{0} ready to add', server.size)].filter(Boolean);
    avail.textContent = parts.join(' · ');
    avail.hidden = !parts.length;
    const complete = total && ready.size >= total;
    // Everything still missing is on the server under someone else (or already downloading): just add it.
    const addOnly = !complete && server.size > 0 && (total ? ready.size + server.size + downloading.size >= total : !canGet());
    const covered = total && ready.size + server.size + downloading.size >= total && !complete && downloading.size > 0 && !addOnly;
    const locked = Boolean(cmd?.busy);
    submit._add = addOnly && !locked ? serverOnlyEpisodes(s, n).filter((f) => server.has(f.episode)) : null;
    submit.hidden = Boolean(complete || covered) && !locked;
    quiet.textContent = complete ? T('This season is ready to watch') : covered ? T('The rest are on their way') : '';
    quiet.hidden = !submit.hidden;
    const rangeText = picked?.length ? (picked.length === 1 ? T('Add Episode {0}', picked[0]) : T('Add Episodes {0}–{1}', picked[0], picked.at(-1))) : T('Choose episodes');
    submit.firstChild.textContent = locked ? commandStep(cmd) : submit._add ? (adding ? T('Adding…') : T('Add Season {0} to library', n))
      : useRange ? rangeText : (n == null ? T('Add season') : T('Add Season {0}', n));
    submit.setAttribute('aria-disabled', String(locked || adding || !n || Boolean(useRange && !picked.length)));
    note.textContent = submit._add ? T('Someone already has this season here. Adding it makes no copy, so it’s ready to watch right away.')
      : useRange ? T('{0} of {1}–{2}. A season batch still serves a range: episodes outside it are skipped.', plural(picked.length, 'episode'), bounds().first, bounds().last)
      : T('Marquee picks a good copy of the season and skips episodes you already have.');
    // The show's button: "Add to library" until some of it is yours, then "More episodes" for the rest.
    const toggleText = s.ready.length && !serverOnlyEpisodes(s).length ? T('More episodes') : T('Add to library');
    if (toggle._mode !== toggleText) {
      toggle._mode = toggleText;
      toggle.replaceChildren(icon('plus'), h('span', {}, toggleText));
    }
    seasonSel.disabled = locked || !seasons?.length;
    profileSel.disabled = locked;
    scopeSel.disabled = fromIn.disabled = toIn.disabled = locked;
    panel.setAttribute('aria-busy', String(locked));
    const result = commandResult(cmd);
    const text = addError || result?.text || '';
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('is-error', Boolean(addError || (result?.retry && !result.partial)));
    retry._episodes = result?.episodes?.length ? result.episodes : null;
    retry.hidden = !result?.retry;
    retry.textContent = retry._episodes ? T('Retry unavailable') : T('Try again');
    // Upgrade quality: offered once some of the season is here and nothing of it is downloading.
    const up = downloadCommands.get(ps.up[n]);
    const upJob = up && !up.busy ? up.job : null;
    upgradeBox.hidden = !(canGet() && ready.size > 0 && !submit._add && ((!downloading.size && !packBusy) || up));
    upBtn.setAttribute('aria-disabled', String(Boolean(locked || up?.busy || downloading.size || packBusy)));
    upBtn.lastChild.textContent = up?.busy ? T('Looking for better quality…') : T('Upgrade quality');
    upBtn.hidden = Boolean(upJob && ['started', 'queued'].includes(upJob.outcome));
    upNote.textContent = T('Looks soft? Finds a clearly better release of this season and swaps each episode as the new one finishes. Watch progress carries over.');
    upNote.hidden = Boolean(up);
    const upText = up?.error || upJob?.message || '';
    if (upStatus.textContent !== upText) upStatus.textContent = upText;
    upStatus.classList.toggle('is-error', Boolean(up?.error || upJob?.state === 'failed'));
  };
  commandViews.add(panel);
  panel._update();
  if (ps.open) load();
  return { toggle, panel };
}

// One missing episode in the show sheet: a quiet Download that runs the same command for it alone.
function episodeDownload(t, seasonNo, episode) {
  const b = { type: 'tv', tmdbId: t.id, season: seasonNo, episodes: [episode], profile: savedProfile() };
  const onServer = () => serverMatchesFor(t).find((f) => f.season === seasonNo && f.episode === episode);
  if (!onServer() && !(canGet() && t.id)) return null;
  const btn = h('button', { type: 'button', class: 'chip episode-get stroke-icon' }, icon('download'), h('span', {}, T('Download')));
  let adding = false, error = '';
  btn.addEventListener('click', async () => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const f = onServer();
    if (!f) return runDownloadCommand(b);
    adding = true; error = ''; btn._update();
    try { await addFromServer([f]); } catch (err) { error = err.message; } finally { adding = false; btn._update(); }
  });
  btn._update = () => {
    const cmd = downloadCommands.get(commandKey(b)), result = commandResult(cmd), add = Boolean(onServer());
    if (btn._mode !== add) { btn._mode = add; btn.firstChild.replaceWith(icon(add ? 'plus' : 'download')); }
    btn.setAttribute('aria-label', T('Add episode {0} to your library', episode));
    btn.setAttribute('aria-disabled', String(Boolean(cmd?.busy || adding)));
    btn.lastChild.textContent = add ? (adding ? T('Adding…') : error ? T('Try again') : T('Add to library'))
      : cmd?.busy ? T('Finding…') : result?.retry ? T('Try again') : T('Add');
    btn.title = add ? error : result?.text || '';
  };
  commandViews.add(btn);
  btn._update();
  return btn;
}

// ---------- casting: device picker ----------
const jsonPost = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const people = createPeople({ h, api, toast, me: () => state.me }); // faces and profile pictures (people.js)
const social = createSocial({ h, api, jsonPost, toast, icon, people }); // likes, Popular, watch parties, Wrapped (social.js)

// The subtitles the phone player would turn on by itself (see its subtitle setup), so a TV starts with
// them too: the last used language when it's already saved for this video, else the one from Settings.
// A saved empty choice means the viewer switched subtitles off.
async function castSubFor(file) {
  let pref = null;
  try { pref = localStorage.getItem('subs:lang'); } catch { /* blocked */ }
  const want = prefs().subLang;
  if (pref === '') return null;
  let data;
  try { data = await api(`/api/subs/langs?kind=${file.kind}&id=${encodeURIComponent(file.key)}`); } catch { return null; }
  const langs = data.languages || [];
  if (!pref && !want) return (data.anime && langs.find((l) => l.code === 'en' && l.saved)) || null; // anime: its English subtitles
  return langs.find((l) => l.code === pref && l.saved) || (want && langs.find((l) => l.code === want)) || null;
}

function openPicker(file, opener) {
  const restoreManager = pickerManagerSubview(opener);
  const name = [file.title, episodeLabel(file)].filter(Boolean).join(' ');
  const list = h('ul', { class: 'rows device-list' });
  const notes = h('div', { class: 'picker-notes' });
  const again = h('button', { class: 'retry', onclick: () => load(true) }, T('Search again'));
  // The phone's own AirPlay / Chromecast list: works on whatever network the phone is on.
  const nearby = canCastFromBrowser && h('button', {
    class: 'device device-nearby',
    onclick: () => openPlayer(file, { replace: true, castHint: true }),
  },
  h('span', { class: 'device-icon' }, icon('airplay')),
  h('span', { class: 'row-text' },
    h('span', { class: 'row-title' }, hasAirPlay ? T('AirPlay to a TV near you') : T('Cast to a TV near you')),
    h('span', { class: 'row-meta' }, h('span', {}, T('Pick a TV from this phone’s own list. The TV streams straight from the server.')))));
  const nearbyWrap = h('div', { class: 'nearby', hidden: true }, h('p', { class: 'muted nearby-label' }, T('Or from this phone')), nearby);
  $('#picker-body').replaceChildren(
    h('h2', { id: 'picker-title' }, T('Play on TV')),
    h('p', { class: 'muted picker-sub' }, name),
    ...[list, notes, again, nearby && nearbyWrap].filter(Boolean));
  if (restoreManager) $('#picker-body').prepend(h('button', { class: 'chip', onclick: restoreManager }, icon('back'), T('Back to downloads')));
  else pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));

  async function load(refresh) {
    again.disabled = true;
    notes.replaceChildren();
    if (refresh) list.replaceChildren(h('li', { class: 'searching', role: 'status' }, T('Looking for TVs on your network…')));
    try {
      const data = await api(`/api/cast/devices${refresh ? '?refresh=1' : ''}`);
      if (data.away) {
        again.hidden = true;
        if (nearby) {
          nearbyWrap.hidden = true;
          list.replaceChildren(h('li', {}, nearby));
          notes.replaceChildren(h('p', { class: 'muted' }, T('You’re away from home, so the TVs there aren’t listed.')));
        } else {
          list.replaceChildren(h('li', {}, notice(T('You’re away from home'),
            T('The TVs at home aren’t available from here, and this browser can’t cast to TVs near you. Open Marquee in Safari (AirPlay) or Chrome (Chromecast) to use one, or press Play to watch here.'))));
        }
        return;
      }
      if (nearby) nearbyWrap.hidden = false;
      if (!refresh && !data.devices.length) return load(true); // empty cache: scan now
      list.replaceChildren(...data.devices.map(deviceRow));
      if (!data.devices.length) {
        list.replaceChildren(h('li', {}, notice(T('No TVs found'),
          T('Check the TV is switched on and on the same network as the server. On Samsung and LG TVs, screen sharing / DLNA may need turning on in the settings.'))));
      }
      notes.replaceChildren(...data.notes.map((n) => h('p', { class: 'muted' }, n)));
    } catch (err) {
      list.replaceChildren(h('li', {}, notice(T('Couldn’t search for TVs'), err.message)));
    } finally {
      again.disabled = false;
    }
  }

  function deviceRow(d) {
    const status = h('span', { class: 'device-status' });
    // A TV that's already playing also gets a button for its remote (yours, or to stop someone else's).
    const remote = d.session && h('button', { type: 'button', class: 'chip device-remote', onclick: () => openRemote(d.session, { replace: true }) },
      d.session.mine ? T('Open remote') : T('Open its remote'));
    const btn = h('button', { class: 'device', onclick: () => start(d, btn, status) },
      h('span', { class: 'device-icon' }, icon('tv')),
      h('span', { class: 'row-text' },
        h('span', { class: 'row-title' }, d.name),
        h('span', { class: 'row-meta' }, h('span', {}, d.kind === 'airplay' ? T('Apple TV') : (d.model || T('Smart TV'))),
          d.session ? h('span', {}, d.session.mine ? T('Playing {0}', d.session.title) : T('Someone else is watching'))
            : d.playing && h('span', {}, T('Playing something now'))),
        status));
    return h('li', {}, btn, remote);
  }

  async function start(d, btn, status) {
    // Someone else's TV: ask for a second tap before taking it over.
    if (d.session && !d.session.mine && !btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      status.className = 'device-status is-error';
      status.textContent = T('Someone is watching {0} on this TV. Tap again to play here instead.', d.session.title);
      return;
    }
    btn.disabled = true;
    status.className = 'device-status';
    status.textContent = T('Starting on the TV…');
    try {
      // Apple TV can't show subtitle files over AirPlay; smart TVs start with the player's default subtitles.
      const sub = d.kind === 'airplay' ? null : await castSubFor(file);
      if (sub) status.textContent = T('Starting on the TV with {0} subtitles…', sub.name);
      const play = (code) => api('/api/cast/play', jsonPost({ deviceId: d.id, kind: file.kind, id: file.key, ...(code ? { sub: code } : {}) }));
      let result;
      // Subtitles that can't be fetched shouldn't stop the video: start without them.
      try { result = await play(sub?.code); } catch (err) { if (!sub) throw err; result = await play(null); }
      const { session } = result;
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
  body.replaceChildren(h('h2', { id: 'picker-title' }, T('Delete')), h('p', { class: 'muted' }, T('Checking…')));
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));

  let info;
  try {
    info = await api(`/api/library/delete-info?id=${encodeURIComponent(id)}`);
  } catch (err) {
    body.replaceChildren(h('h2', { id: 'picker-title' }, T('Can’t delete this')), h('p', { class: 'muted' }, err.message));
    return;
  }
  const label = [info.title || info.name, episodeLabel(info) || (info.year && `(${info.year})`)].filter(Boolean).join(' ');
  const status = h('p', { class: 'device-status', role: 'status' });
  const t = info.torrent;
  const pack = t && t.videos > 1;

  const run = async (scope, btn, everyone = false) => {
    body.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = everyone || !info.others ? T('Deleting…') : T('Removing…');
    status.className = 'device-status';
    status.textContent = '';
    try {
      const r = await api('/api/library/delete', jsonPost({ id, scope, everyone }));
      closeTopOverlay();
      toast(r.kept ? T('Removed from your library') : scope === 'torrent' && pack ? T('Deleted all {0} videos', t.videos) : T('Deleted'));
      dropFromLibrary([id]);
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
  const cancel = h('button', { class: 'del-cancel', onclick: () => closeTopOverlay() }, T('Keep it'));
  // Someone else has it too: it only leaves your library (the owner can still delete the file).
  if (info.others) {
    body.replaceChildren(h('h2', { id: 'picker-title' }, T('Remove from your library?')),
      h('p', { class: 'del-name' }, label),
      h('p', { class: 'muted' }, T('{0} this in their library, so the file stays on the server. You can add it back from Discover.', plural(info.others, T('other person has'), T('other people have')))),
      info.sharedWith > 0 && h('p', { class: 'muted' }, T('It also leaves the library you share with {0}.', nameList(libraryMates()))),
      h('div', { class: 'del-actions' },
        button(T('Remove from my library'), 'del-confirm', 'file'),
        info.canDeleteForEveryone && button(T('Delete the file for everyone ({0})', fmtBytes(info.size)), 'del-confirm del-secondary', 'file', true),
        cancel),
      status);
    cancel.focus();
    return;
  }

  const lines = [
    h('p', { class: 'del-name' }, label),
    h('p', { class: 'muted' }, pack
      ? T('This is one of {0} videos in the torrent “{1}”. Deleting all of them also removes the torrent from qBittorrent.', t.videos, t.name)
      : t ? T('This also removes the torrent from qBittorrent, so it stops seeding. {0} will be freed.', fmtBytes(t.size))
        : T('{0} will be freed. This can’t be undone.', fmtBytes(info.size))),
    info.sharedWith > 0 && h('p', { class: 'muted' }, T('You share this library with {0}, so it goes for them too.', nameList(libraryMates()))),
  ];
  const actions = pack
    ? [button(T('Delete this video only'), 'del-confirm', 'file'), button(T('Delete all {0} videos ({1})', t.videos, fmtBytes(t.size)), 'del-confirm del-secondary', 'torrent')]
    : [button(T('Delete'), 'del-confirm', t ? 'torrent' : 'file')];
  // A title with versions: this deletes the one shown; the others stay (or all of them go at once).
  const otherVersions = (f.versions || []).filter((v) => v.id !== id);
  if (otherVersions.length) {
    lines.splice(1, 0, h('p', { class: 'muted' }, T('This is the {0} version. {1}', f.versionLabel || T('chosen'), otherVersions.length === 1
      ? T('The other one ({0}) stays.', otherVersions[0].versionLabel) : T('The other {0} versions stay.', otherVersions.length))));
    actions.push(h('button', { class: 'del-confirm del-secondary', onclick: () => { closeTopOverlay(); openDeleteMany({ files: f.versions, what: T('every version'), label }, opener); } },
      T('Delete all {0} versions', f.versions.length)));
  }
  body.replaceChildren(h('h2', { id: 'picker-title' }, T('Delete this?')), ...lines, h('div', { class: 'del-actions' }, ...actions, cancel), status);
  cancel.focus();
}

// A whole season or show: every version of every episode in it, in one go (see deleteMany on the server).
async function openDeleteMany({ files, what, label, onDone }, opener) {
  const ids = [...new Set(allVersions(files).map((f) => f.id).filter(Boolean))];
  const body = $('#picker-body');
  body.replaceChildren(h('h2', { id: 'picker-title' }, T('Delete {0}', what)), h('p', { class: 'muted' }, T('Checking…')));
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));

  let info;
  try {
    info = await api('/api/library/delete-many-info', jsonPost({ ids }));
  } catch (err) {
    body.replaceChildren(h('h2', { id: 'picker-title' }, T('Can’t delete {0}', what)), h('p', { class: 'muted' }, err.message));
    return;
  }
  const episodes = plural(episodeCount(files), 'episode');
  const status = h('p', { class: 'device-status', role: 'status' });
  const allShared = info.shared === info.videos;

  const run = async (btn, everyone = false) => {
    body.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = !everyone && allShared ? T('Removing…') : T('Deleting…');
    status.className = 'device-status';
    status.textContent = '';
    try {
      const r = await api('/api/library/delete-many', jsonPost({ ids, everyone }));
      const gone = new Set(ids);
      dropFromLibrary(gone);
      await dismissTopOverlay().catch(() => {});
      toast(r.failed ? T('{0} deleted, {1} kept: {2}', r.deleted + r.removed, r.failed, r.error)
        : r.deleted ? T('Deleted {0}', label) : T('Removed {0} from your library', label));
      onDone?.();
      // Refresh after the server finishes cleaning up.
      setTimeout(async () => { await Promise.all([loadLibrary(), loadDownloads()]); if (state.view === 'library') renderLibrary(); if (state.view === 'downloads') renderDownloads(); }, 5000);
      if (state.view === 'library') renderLibrary();
    } catch (err) {
      body.querySelectorAll('button').forEach((b) => { b.disabled = false; b.textContent = b.dataset.label; });
      status.className = 'device-status is-error';
      status.textContent = err.message;
    }
  };
  const button = (text, cls, everyone) => {
    const b = h('button', { class: cls, 'data-label': text }, text);
    b.addEventListener('click', () => run(b, everyone));
    return b;
  };
  const cancel = h('button', { class: 'del-cancel', 'data-label': T('Keep it'), onclick: () => closeTopOverlay() }, T('Keep it'));
  const forEveryone = info.canDeleteForEveryone && button(T('Delete the files for everyone ({0})', fmtBytes(info.sizeForEveryone)), 'del-confirm del-secondary', true);

  if (allShared) {
    body.replaceChildren(h('h2', { id: 'picker-title' }, T('Remove {0} from your library?', what)),
      h('p', { class: 'del-name' }, label), h('p', { class: 'muted' }, T('{0}. Other people have {1} in their library too, so the files stay on the server. You can add them back from Discover.', episodes, info.videos === 1 ? T('it') : T('these'))),
      h('div', { class: 'del-actions' }, button(T('Remove {0} from my library', what), 'del-confirm'), forEveryone, cancel), status);
  } else {
    const lines = [T('{0} · {1} will be freed.', episodes, fmtBytes(info.size)),
      info.downloads && T('This also removes {0} from qBittorrent, so {1} seeding.', info.downloads === 1 ? T('its download') : T('{0} downloads', info.downloads), info.downloads === 1 ? T('it stops') : T('they stop')),
      info.shared && T('{0} that other people also have only {1} your library.', plural(info.shared, 'video'), info.shared === 1 ? T('leaves') : T('leave')),
      T('This can’t be undone.')].filter(Boolean);
    body.replaceChildren(h('h2', { id: 'picker-title' }, T('Delete {0}?', what)),
      h('p', { class: 'del-name' }, label), h('p', { class: 'muted' }, lines.join(' ')),
      h('div', { class: 'del-actions' }, button(T('Delete {0}', what), 'del-confirm'), forEveryone, cancel), status);
  }
  cancel.focus();
}

// ---------- torrent search ----------
const SOURCE_NAMES = { tpb: 'The Pirate Bay', '1337x': '1337x', nyaa: 'Nyaa' };
const QUALITY_FILTERS = [['all', T('All')], ['2160p', '4K'], ['1440p', '1440p'], ['1080p', '1080p'], ['720p', '720p']];

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

async function magnetOf(t) {
  if (t.magnet) return t.magnet;
  t.magnet = (await api(`/api/torrents/magnet?ref=${encodeURIComponent(t.ref)}`)).magnet;
  return t.magnet;
}

async function sendToQbit(link, extra = {}) {
  await api('/api/downloads/add', jsonPost({ link, ...extra }));
  loadDownloads().then(patchUnifiedLibrary);
  toast(T('Added to Library'));
}

// The release list: search 1337x, The Pirate Bay and Nyaa and pick one yourself. It sits inside a title's
// Advanced options, and in the Find torrents sheet for anything that isn't a known film or show.
function torrentBrowser({ query = '', type = 'all', movieId = null, tvId = null, canonicalTitle = null, strict = false } = {}) {
  let results = [];
  let filter = 'all';
  let ctrl;
  const added = new Set();

  const input = h('input', { type: 'search', enterkeyhint: 'search', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
    'aria-label': T('Torrent search'), placeholder: T('Title, or paste a magnet link') });
  input.value = query;
  const form = h('form', { class: 'search tor-search', role: 'search' },
    h('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon('search')), input,
    h('button', { type: 'submit', class: 'tor-go' }, T('Search')));
  const chips = h('div', { class: 'tor-filters quality-rail', role: 'group', 'aria-label': T('Quality') },
    QUALITY_FILTERS.map(([key, text]) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(key === filter),
      onclick: (e) => {
        filter = key;
        chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === e.currentTarget)));
        renderList();
      },
    }, text)));
  const info = h('p', { class: 'muted tor-info', role: 'status' });
  const list = h('ul', { class: 'rows tor-list' });
  // Subtitle language fetched automatically when the download completes.
  const subId = `tor-sub-${Math.random().toString(36).slice(2, 8)}`;
  const subSelect = h('select', { class: 'sub-select', id: subId });
  const subRow = h('div', { class: 'tor-subs', hidden: true },
    h('label', { for: subId }, T('Subtitles')), subSelect,
    h('span', { class: 'muted tor-subs-note' }));
  subSelect.addEventListener('change', () => { try { localStorage.setItem('subs:dlLang', subSelect.value); } catch { /* blocked */ } });
  const el = h('div', { class: 'tor-browser' }, form, subRow, chips, info, list);

  async function loadSubLangs(q) {
    if (!state.status.subtitles) return;
    const note = subRow.querySelector('.tor-subs-note');
    subRow.hidden = false;
    subSelect.replaceChildren(h('option', { value: '' }, T('None')));
    subSelect.disabled = true;
    note.textContent = T('Checking OpenSubtitles…');
    try {
      const data = await api(`/api/subs/langs?q=${encodeURIComponent(q)}&type=${type}`);
      subSelect.append(...data.languages.map((l) => h('option', { value: l.code }, l.name)));
      let pref = '';
      try { pref = localStorage.getItem('subs:dlLang') || ''; } catch { /* blocked */ }
      pref ||= prefs().subLang || ''; // Settings → subtitles
      if (data.languages.some((l) => l.code === pref)) subSelect.value = pref;
      note.textContent = data.languages.length ? '' : T('None found for this title');
    } catch (err) {
      note.textContent = err.message;
    } finally {
      subSelect.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); input.blur(); run(); });

  async function run() {
    const q = input.value.trim();
    ctrl?.abort();
    if (/^magnet:\?/i.test(q)) return addPastedMagnet(q);
    if (q.length < 2) { results = []; list.replaceChildren(); info.textContent = T('Type a title to search 1337x, The Pirate Bay and Nyaa (anime).'); return; }
    ctrl = new AbortController();
    const { signal } = ctrl;
    info.textContent = T('Searching 1337x, The Pirate Bay and Nyaa…');
    list.replaceChildren(...Array.from({ length: 5 }, () => h('li', { class: 'row tor skeleton-row', 'aria-hidden': 'true' })));
    try {
      // The title's TMDB id lets the server search anime by its romanised name too (Nyaa).
      const title = tvId ? `&tv=${tvId}` : movieId ? `&movie=${movieId}` : '';
      const data = await api(`/api/torrents/search?q=${encodeURIComponent(q)}&type=${type}${strict && q === query ? '&strict=1' : ''}${title}`, { signal });
      results = data.results;
      renderList(data.problems);
      loadSubLangs(q);
    } catch (err) {
      if (err.name === 'AbortError') return;
      results = [];
      info.textContent = '';
      list.replaceChildren(h('li', {}, notice(T('Search didn’t work'), err.message, run)));
    }
  }

  async function addPastedMagnet(link) {
    list.replaceChildren();
    if (!state.status.downloads) { info.textContent = T('Downloads aren’t connected, so there’s nowhere to send it. Set up qBittorrent in .env.'); return; }
    info.textContent = T('Sending to qBittorrent…');
    try {
      await sendToQbit(link);
      info.textContent = T('Added. It appears in your Library.');
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
        ? (results.length === 1 ? T('{0} result, most seeded first.', results.length) : T('{0} results, most seeded first.', results.length))
        : T('{0} of {1} results.', shown.length, results.length));
    }
    if (problems.length) bits.push(T('Skipped {0}', problems.join(' ')));
    info.textContent = bits.join(' ');
    if (!shown.length) {
      list.replaceChildren(h('li', {}, results.length
        ? notice(T('Nothing in that quality'), T('Try another filter.'))
        : notice(T('No torrents found'), T('Try fewer words, or the original title. For series, add the season, like “S02”.'))));
      return;
    }
    list.replaceChildren(...shown.map(torrentRow));
  }

  // A film you already have: releases in a resolution you have are marked (the server refuses them).
  const ownedQualities = () => new Set(movieId ? allVersions(state.library.filter((f) => Number(f.tmdbId) === Number(movieId)))
    .map((f) => f.versionQuality).filter(Boolean) : []);
  function torrentRow(t) {
    const health = t.seeders >= 50 ? 'good' : t.seeders >= 5 ? 'ok' : 'poor';
    const owned = t.quality && ownedQualities().has(t.quality);
    const status = h('span', { class: 'device-status' });
    const meta = [
      h('span', { class: `seeds seeds-${health}` }, T('{0} seeding', t.seeders.toLocaleString(locale))),
      t.size && fmtBytes(t.size),
      t.quality && t.quality !== 'SD' && (t.quality === '2160p' ? '4K' : t.quality),
      ...t.tags,
      t.cam && h('span', { class: 'tor-warn' }, T('Cinema recording')),
      owned && h('span', { class: 'tor-have' }, T('You have this quality')),
      SOURCE_NAMES[t.source],
      fmtAgo(t.added) || t.addedText,
    ].filter(Boolean).map((m) => (m instanceof Node ? m : h('span', {}, m)));

    const copyBtn = h('button', { class: 'cast-btn', title: T('Copy magnet link'), 'aria-label': T('Copy magnet link for {0}', t.name), onclick: copy }, icon('copy'));
    const getBtn = canDownload() && h('button', { class: 'play-btn', 'aria-label': T('Download {0}', t.name), onclick: get }, icon('download'), T('Get'));
    if (getBtn && added.has(t.id)) markAdded();

    async function copy() {
      copyBtn.disabled = true;
      try {
        const ok = await copyText(await magnetOf(t));
        toast(ok ? T('Magnet link copied') : T('Couldn’t copy on this device'));
      } catch (err) {
        toast(err.message);
      } finally {
        copyBtn.disabled = false;
      }
    }
    async function get() {
      getBtn.disabled = true;
      getBtn.replaceChildren(T('Adding…'));
      status.className = 'device-status';
      status.textContent = '';
      try {
        const sub = subRow.hidden ? '' : subSelect.value;
        // Only carry the title's identity while searching its own name; free searches can be anything.
        const own = input.value.trim() === query.trim();
        await sendToQbit(await magnetOf(t), { name: t.name, ...(sub ? { subs: [sub] } : {}),
          ...(own && type !== 'all' ? { mediaType: type } : {}),
          ...(movieId && own ? { movieId } : {}),
          ...(tvId && own ? { tvId, canonicalTitle } : {}) });
        added.add(t.id);
        markAdded();
        const subName = sub && subSelect.selectedOptions[0]?.textContent;
        toast(subName ? T('Added. {0} subtitles come when it finishes.', subName) : T('Added to Library'));
      } catch (err) {
        getBtn.disabled = false;
        getBtn.replaceChildren(icon('download'), T('Get'));
        status.className = 'device-status is-error';
        status.textContent = err.message;
      }
    }
    function markAdded() {
      getBtn.disabled = true;
      getBtn.classList.add('is-added');
      getBtn.replaceChildren(icon('check'), T('Added'));
    }

    return h('li', { class: 'row tor' },
      h('div', { class: 'row-text' },
        h('div', { class: 'tor-name', title: t.name }, t.name),
        h('div', { class: 'row-meta' }, meta),
        status),
      h('div', { class: 'row-actions' }, copyBtn, getBtn));
  }

  return {
    el,
    abort: () => ctrl?.abort(),
    start: () => { if (query) run(); else { info.textContent = T('Type a title to search 1337x, The Pirate Bay and Nyaa (anime).'); input.focus(); } },
  };
}

// Find torrents (Discover search): the release list on its own, for anything you search by name.
function openTorrents({ query = '', opener } = {}) {
  const browser = torrentBrowser({ query });
  $('#picker-body').replaceChildren(h('h2', { id: 'picker-title' }, T('Find torrents')), browser.el);
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { browser.abort(); opener?.focus({ preventScroll: true }); }));
  browser.start();
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
  const more = state.sessions.length > 1 ? T(' (+{0} more)', state.sessions.length - 1) : '';
  bar.replaceChildren(
    h('span', { class: 'nowbar-icon' }, icon('tv')),
    h('span', { class: 'nowbar-text' }, h('strong', {}, s.title), h('span', {}, T('on {0}{1}', s.deviceName, more))),
    h('span', { class: 'nowbar-open' }, T('Remote')));
  bar.onclick = () => openRemote(s);
}

const STATE_TEXT = { playing: T('Playing'), paused: T('Paused'), loading: T('Loading on the TV…'), stopped: T('Stopped'), unknown: '' };
let activeRemote = null; // the open remote; a replaced one must not hide its successor when it closes

function openRemote(session, { replace = false } = {}) {
  const id = session.deviceId;
  const r = {};
  const token = activeRemote = {};
  let st = { state: 'loading', position: null, duration: null, volume: null };
  let dragging = false;
  let lastAction = 0;
  // Skip intro / Up next on the phone, from the TV's reported position (the TV can't show Marquee's buttons).
  const cue = { intro: null, creditsAt: null, duration: null, lastPosition: null, introDone: false,
    dismissed: false, busy: false, error: '', autoLeft: null, autoTimer: null, announced: null };

  $('#remote-body').replaceChildren(
    h('div', { class: 'remote-top' },
      h('button', { class: 'icon-btn', id: 'remote-close', 'aria-label': T('Close remote'), onclick: closeTopOverlay }, icon('back')),
      h('p', { class: 'remote-where' }, icon('tv'), h('span', {}, session.deviceName))),
    h('div', { class: 'remote-main' },
      h('h2', { id: 'remote-title' }, session.title),
      session.subtitle && h('p', { class: 'remote-sub' }, session.subtitle),
      r.state = h('p', { class: 'remote-state', role: 'status' }, T('Connecting…')),
      h('div', { class: 'scrub' },
        r.seek = h('input', { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': T('Position'), disabled: true }),
        h('div', { class: 'scrub-times' }, r.pos = h('span', {}, '0:00'), r.dur = h('span', {}, '–:––'))),
      h('div', { class: 'transport' },
        h('button', { class: 'skip-btn', 'aria-label': T('Back 10 seconds'), onclick: () => jump(-10) }, '−10s'),
        r.toggle = h('button', { class: 'toggle-btn', onclick: toggle }),
        h('button', { class: 'skip-btn', 'aria-label': T('Forward 30 seconds'), onclick: () => jump(30) }, '+30s')),
      r.skipIntro = h('button', { class: 'remote-skip-intro', type: 'button', hidden: true, onclick: () => skipIntroOnTv() },
        T('Skip intro'), icon('skip')),
      r.upNext = h('section', { class: 'remote-up-next', hidden: true, 'aria-label': T('Up next') },
        h('div', { class: 'up-next-copy' },
          r.upNextArt = h('div', { class: 'up-next-art', 'aria-hidden': 'true' }),
          h('div', {}, h('p', { class: 'up-next-label' }, T('Up next')), r.upNextTitle = h('h3', {}))),
        h('div', { class: 'up-next-actions' },
          r.upNextPlay = h('button', { class: 'up-next-play', type: 'button', onclick: () => playNextOnTv() }, T('Next episode')),
          r.upNextDismiss = h('button', { class: 'up-next-dismiss', type: 'button', onclick: () => { cue.dismissed = true; renderCues(); } }, T('Keep watching'))),
        r.upNextError = h('p', { class: 'up-next-error', hidden: true })),
      r.cueStatus = h('p', { class: 'sr-only', role: 'status' }),
      r.volWrap = h('label', { class: 'volume', hidden: true }, icon('volume'),
        r.vol = h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': T('TV volume') })),
      r.subs = h('div', { class: 'remote-subs', hidden: true }),
      h('button', { class: 'stop-btn', onclick: stop }, T('Stop playing on the TV'))));

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
    r.toggle.setAttribute('aria-label', playing ? T('Pause') : T('Play'));
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
    renderCues();
  }

  // ---- Skip intro and Up next for the TV ----
  async function loadCues() {
    const ref = session.media;
    if (!ref?.kind || !ref.id) return;
    const base = `/api/media/${ref.kind}/${encodeURIComponent(ref.id)}`;
    api(`${base}/intro`).then((data) => {
      const start = Number(data.intro?.start), end = Number(data.intro?.end);
      cue.intro = Number.isFinite(start) && Number.isFinite(end) && end - start >= 5 ? { start, end } : null;
      if (activeRemote === token) renderCues();
    }).catch(() => { /* no known intro: no button */ });
    // The first lookup of a long episode can take half a minute; Up next waits for the end until then.
    api(`${base}/credits`).then((data) => {
      cue.creditsAt = Number.isFinite(data.creditsAt) && data.creditsAt > 0 ? data.creditsAt : null;
      if (activeRemote === token) renderCues();
    }).catch(() => {});
  }
  const nextUp = () => nextLibraryEpisode({ kind: session.media?.kind, id: session.media?.id }, state.library, state.libraryShows);

  function renderCues() {
    if (activeRemote !== token) return;
    if (Number.isFinite(st.duration) && st.duration > 0) cue.duration = st.duration;
    if (st.state === 'playing' && Number.isFinite(st.position)) cue.lastPosition = st.position;
    const reading = { state: st.state, position: st.position, duration: cue.duration, creditsAt: cue.creditsAt, lastPosition: cue.lastPosition };

    const introOn = !dragging && tvIntroShowing({ ...reading, intro: cue.intro });
    if (introOn && prefs().skipIntro === 'auto' && !cue.introDone && st.state === 'playing') { skipIntroOnTv(true); return; }
    r.skipIntro.hidden = !introOn;

    const next = nextUp();
    const show = Boolean(next && !cue.dismissed && !dragging && tvNextShowing(reading));
    r.upNext.hidden = !show;
    // Counts only when the episode really plays out: at the credits, or after the TV finished it
    // (not after someone stopped it with the TV's own remote halfway through the credits).
    const ended = tvFinished(reading);
    const counting = show && !cue.busy && !cue.error && autoChain < AUTOPLAY_CHAIN && (st.state === 'playing' || ended);
    if (counting && cue.autoLeft == null && !cue.autoTimer) startTvAutoplay();
    else if (!counting && !(show && st.state === 'paused')) stopTvAutoplay();
    if (!show) return;
    const title = [episodeLabel(next), next.episodeName || next.title].filter(Boolean).join(' · ');
    if (r.upNextTitle.textContent !== title) r.upNextTitle.textContent = title;
    if (r.upNextArt.dataset.for !== next.id) {
      r.upNextArt.dataset.for = next.id;
      r.upNextArt.replaceChildren(episodeArt(next.still, state.libraryShows.find((s) => s.id === next.show)));
    }
    const left = cue.autoLeft == null ? null : Math.max(1, Math.ceil(cue.autoLeft));
    r.upNextPlay.disabled = cue.busy;
    r.upNextPlay.textContent = cue.busy ? T('Starting on the TV…') : left ? T('Next episode in {0}', left) : T('Next episode');
    r.upNextPlay.classList.toggle('counting', left != null);
    r.upNextPlay.style.setProperty('--auto-progress', left == null ? '0' : String(1 - cue.autoLeft / AUTOPLAY_SECONDS));
    r.upNextDismiss.textContent = ended ? T('Dismiss') : T('Keep watching');
    r.upNextError.textContent = cue.error;
    r.upNextError.hidden = !cue.error;
    if (cue.announced !== next.id) {
      cue.announced = next.id;
      r.cueStatus.textContent = T('Up next: {0}.', title);
    }
  }

  function skipIntroOnTv(auto = false) {
    if (!cue.intro || (auto && cue.introDone)) return;
    cue.introDone = true; // once per cast: seeking back to watch it is left alone
    st.position = cue.intro.end;
    send('seek', cue.intro.end);
    toast(auto ? T('Intro skipped') : T('Skipped the intro'));
  }

  // Real seconds while the credits play on the TV (or after it finished); paused on the TV = paused here.
  // A locked phone runs no timers, so the TV only moves on while someone has the remote open.
  function startTvAutoplay() {
    cue.autoLeft = AUTOPLAY_SECONDS;
    let last = Date.now();
    const tick = () => {
      if (activeRemote !== token || cue.autoLeft == null) { cue.autoTimer = null; return; }
      const now = Date.now();
      if (!document.hidden && st.state !== 'paused') cue.autoLeft -= (now - last) / 1000;
      last = now;
      if (cue.autoLeft <= 0) {
        cue.autoLeft = null; cue.autoTimer = null;
        autoChain++;
        playNextOnTv();
        return;
      }
      cue.autoTimer = setTimeout(tick, 250);
      renderCues();
    };
    cue.autoTimer = setTimeout(tick, 250);
  }
  function stopTvAutoplay() {
    if (cue.autoTimer) clearTimeout(cue.autoTimer);
    cue.autoTimer = null; cue.autoLeft = null;
  }

  async function playNextOnTv() {
    const next = nextUp();
    if (!next || cue.busy) return;
    cue.busy = true; cue.error = '';
    stopTvAutoplay();
    renderCues();
    const start = (sub) => api('/api/cast/play', jsonPost({ deviceId: id, kind: 'lib', id: next.id, ...(sub ? { sub } : {}) }));
    try {
      let result;
      // Keep the subtitles on; if the next episode has none in that language, play it without.
      try { result = await start(session.sub); } catch (err) { if (!session.sub) throw err; result = await start(null); }
      const s = result.session;
      state.sessions = [s, ...state.sessions.filter((x) => x.deviceId !== s.deviceId)];
      if (activeRemote === token) openRemote(s, { replace: true });
    } catch (err) {
      cue.busy = false;
      cue.error = T('{0} Try Next episode again.', err.message);
      r.cueStatus.textContent = cue.error;
      renderCues();
    }
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
      r.subs.replaceChildren(h('h3', {}, T('Subtitles')),
        h('p', { class: 'muted' }, T('Apple TV can’t show separate subtitle files over AirPlay. Play it on the phone for subtitles, or use a smart TV.')));
      return;
    }
    let data;
    try { data = await api(`/api/subs/langs?kind=${ref.kind}&id=${encodeURIComponent(ref.id)}`); } catch { return; }
    if (!data.languages.length && !data.configured) return;
    r.subs.hidden = false;
    const note = h('p', { class: 'muted remote-subs-note', role: 'status' }, data.languages.length ? '' : data.problem || T('No subtitles found for this.'));
    const options = [{ code: null, name: T('Off') }, ...data.languages];
    const chips = h('div', { class: 'tor-filters' }, options.map((l) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String((session.sub || null) === l.code),
      onclick: () => pickSub(l, chips, note, options),
    }, l.name)));
    r.subs.replaceChildren(...[h('h3', {}, T('Subtitles')), data.languages.length ? chips : null, note, r.sync].filter(Boolean));
    subUi = { chips, note, options };
    renderOffset();
  }

  async function pickSub(l, chips, note, options, { reload = false } = {}) {
    if (!reload && (session.sub || null) === l.code) return;
    chips.querySelectorAll('.chip').forEach((c) => { c.disabled = true; });
    note.textContent = reload ? T('Sending the new subtitle timing to the TV…')
      : l.code ? T('Getting {0} subtitles and restarting on the TV…', l.name) : T('Restarting on the TV without subtitles…');
    lastAction = Date.now() + 8000; // pause status polling while the TV reloads
    try {
      const { session: next } = await api(`/api/cast/${id}/subtitles`, jsonPost({ lang: l.code }));
      session.sub = next.sub;
      state.sessions = [next, ...state.sessions.filter((s) => s.deviceId !== next.deviceId)];
      chips.querySelectorAll('.chip').forEach((c, i) => c.setAttribute('aria-pressed', String((options[i].code || null) === (session.sub || null))));
      note.textContent = reload ? T('The TV has the new subtitle timing.')
        : l.code ? T('{0} subtitles on. If they don’t appear, this TV may not support subtitle files over the network.', l.name) : '';
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
      subSyncBusy(s) ? h('p', { class: 'muted remote-subs-note' }, T('Checking the timing…'))
        : nudgeRow(s.manual || 0, (n) => nudgeOnTv(lang, n)),
      pending && h('p', { class: 'muted remote-subs-note' }, T('Updating the TV in a moment…')),
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
  loadCues();
  $('#remote').hidden = false;
  document.body.style.overflow = 'hidden';
  renderNowbar();
  $('#remote-close').focus({ preventScroll: true });
  poll();
  const timer = setInterval(poll, 1500);

  const close = () => {
    clearInterval(timer);
    stopTvAutoplay();
    if (activeRemote !== token) return; // replaced by the next episode's remote
    activeRemote = null;
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
let partyUnread = 0; // chat messages since the Room panel was last open
const watchClient = globalThis.crypto?.randomUUID?.() || `${CLIENT_ID}-${Math.random().toString(36).slice(2, 10)}`;

// Wide screens dock the room on the right and the picture moves over; phones get a sheet.
const roomDocks = matchMedia('(min-width: 1100px)');
const roomDocked = () => Boolean(party && watchPanelOpen && roomDocks.matches);
roomDocks.addEventListener?.('change', () => { if (party) renderParty(); });

// One line about the room, with a tone for its colour: live, count, wait or alert.
function roomStatus(room, host) {
  const counting = party.startsIn != null && party.startsIn > 0;
  if (!party.connected || !party.online) return ['alert', T('Reconnecting… playback is paused')];
  if (counting) return ['count', T('Starts {0}{1}', startLabel(room.startsAt), party.blocked ? T(' · tap Ready so it can start for you') : '')];
  if (party.blocked) return ['alert', T('Press Play to join playback')];
  if (room.waitingFor.length) return ['wait', T('Waiting for {0}', namesText(room.waitingFor))];
  if (room.playing) return ['live', T('Playing for {0}', room.members.length === 1 ? T('you') : T('all {0}', room.members.length))];
  return ['wait', party.isHost ? T('Paused · press Play when everyone’s ready') : T('Paused · {0} has the remote', host)];
}
// Where one viewer is: ready, getting ready, needs a tap, or still connecting.
function memberState(m) {
  if (!m.connected) return ['away', T('Connecting…')];
  if (m.blocked) return ['wait', T('Needs to press Play')];
  if (m.buffering) return ['wait', T('Loading…')];
  if (!m.ready) return ['wait', T('Getting ready')];
  return ['ready', T('Ready')];
}
let roomDrawn = '';
function renderRoster(room) {
  const list = $('#watch-members');
  const rows = room.members.map((m) => {
    const [tone, text] = memberState(m);
    return { m, tone, text, me: m.id === watchClient, host: m.id === room.host };
  });
  const key = JSON.stringify(rows.map((r) => [r.m.id, r.m.name, r.m.avatar, r.tone, r.host]));
  if (key === roomDrawn) return;
  roomDrawn = key;
  list.replaceChildren(...rows.map(({ m, tone, text, me, host }) => h('li', { class: `room-member is-${tone}${host ? ' is-host' : ''}${me ? ' is-me' : ''}` },
    h('span', { class: 'room-member-face' }, people.face(m, { size: 46 }),
      host && h('span', { class: 'room-crown', title: T('Host'), 'aria-hidden': 'true' }, icon('crown'))),
    h('span', { class: 'room-member-name' }, me ? T('You') : personName(m)),
    h('span', { class: 'room-member-state' }, host ? (tone === 'ready' ? T('Host') : T('Host · {0}', text.toLowerCase())) : text))));
  $('#watch-count').textContent = room.members.length > 1 ? `· ${room.members.length}` : '';
}
// The Room button in the control row: faces of who's in, plus unread messages.
let roomButtonDrawn = '';
function renderRoomButton(room) {
  const btn = $('#watch-btn');
  const seen = new Set();
  const faces = (room?.members || []).filter((m) => { const k = `${m.name}|${m.avatar}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const key = JSON.stringify([Boolean(party), faces.map((m) => [m.name, m.avatar])]);
  if (key !== roomButtonDrawn) {
    roomButtonDrawn = key;
    $('#watch-btn-faces').replaceChildren(...(party ? [people.faces(faces, { size: 22, max: 3 })] : [icon('party')]).filter(Boolean));
  }
  $('#watch-btn-label').textContent = party ? T('Room') : T('Watch together');
  const badge = $('#watch-btn-badge');
  badge.hidden = !(party && partyUnread && !watchPanelOpen);
  badge.textContent = partyUnread > 9 ? '9+' : String(partyUnread);
  btn.setAttribute('aria-label', party ? T('Watch Together room{0}', partyUnread && !watchPanelOpen ? T(', {0} new {1}', partyUnread, partyUnread === 1 ? T('message') : T('messages')) : '') : T('Start Watch Together'));
}

function renderParty() {
  const bar = $('#watch-bar');
  bar.hidden = !party || !watchPanelOpen;
  const roomButton = $('#watch-btn');
  roomButton.hidden = !party && (current?.kind !== 'lib' || !state.library.some((f) => f.id === mediaId(current)));
  roomButton.setAttribute('aria-expanded', String(Boolean(party && watchPanelOpen)));
  roomButton.classList.toggle('is-on', Boolean(party));
  renderRoomButton(party?.state);
  playerEl.classList.toggle('in-party', Boolean(party));
  if (playerEl.classList.contains('room-docked') !== roomDocked()) {
    playerEl.classList.toggle('room-docked', roomDocked());
    requestAnimationFrame(layoutSubs);
  }
  updateUpNext();
  if (party) cancelAudioIntent(current);
  renderAudioControls();
  updatePartyCountdown();
  if (!party) { roomDrawn = ''; return; }
  updatePlayState();
  const room = party.state;
  const counting = party.startsIn != null && party.startsIn > 0;
  $('#watch-host-tools').hidden = !party.isHost;
  $('#watch-later').hidden = !party.isHost || counting;
  $('#watch-start-now').hidden = $('#watch-clear-start').hidden = !party.isHost || !counting;
  const hostMember = room.members.find((m) => m.id === room.host);
  const host = hostMember ? personName(hostMember) : T('The host');
  const [tone, status] = roomStatus(room, host);
  const statusEl = $('#watch-status');
  if (statusEl.textContent !== status) statusEl.textContent = status;
  statusEl.dataset.tone = tone;
  const title = current ? [current.filmTitle || current.title, episodeLabel(current)].filter(Boolean).join(' · ') : '';
  if ($('#watch-title').textContent !== title) $('#watch-title').textContent = title;
  renderRoster(room);
  $('#watch-hint').textContent = party.isHost ? T('You have the remote: everyone follows your play, pause and seeking.')
    : T('{0} has the remote: play, pause and seeking follow them.', host);
  $('#watch-ready').hidden = !party.blocked;
  playerEl.classList.toggle('party-guest', !party.isHost);
  airplayBtn.hidden = true;
  audioBtn.hidden = true;
  seekEl.setAttribute('aria-disabled', String(!party.isHost));
  seekEl.tabIndex = party.isHost ? 0 : -1;
  for (const b of playBtns) {
    b.disabled = !party.isHost && !party.blocked;
    b.title = party.blocked ? T('Join playback') : party.isHost ? '' : T('The host controls playback');
  }
  for (const b of playerEl.querySelectorAll('.pc-skip')) { b.disabled = !party.isHost; b.title = party.isHost ? '' : T('The host controls seeking'); }
}

function leaveWatchRoom(notify = true) {
  const old = party;
  if (!old) return;
  party = null;
  watchPanelOpen = false;
  partyUnread = 0;
  $('#chat-log').replaceChildren();
  $('#chat-layer').replaceChildren();
  closeInviteList();
  old.close({ notify });
  for (const t of video.querySelectorAll('track')) offsetCues(t.track, 0);
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
    onEnd: (message) => { leaveWatchRoom(false); video.pause(); toast(message); }, onError: toast,
    onChat: partyChat, onReaction: (r) => { if (r.from !== watchClient) social.burst($('#reaction-layer'), r.emoji, r.name, r.avatar); } });
  partyUnread = 0;
  renderChatLog();
  if (alreadyPlaying) party.blocked = false;
  watchPanelOpen = false;
  renderParty();
  return party;
}

async function hostWatchRoom() {
  if (!current || current.kind !== 'lib' || party) return;
  if (onTvVersion || video.remote?.state === 'connected') { toast(T('Watch Together uses the browser player. Stop casting first.')); return; }
  const btn = $('#watch-btn'); btn.disabled = true;
  const media = current;
  try {
    const room = await api('/api/watch', jsonPost({ id: mediaId(current), clientId: watchClient, position: video.currentTime || 0 }));
    if (current !== media) { api(`/api/watch/${room.token}/leave`, jsonPost({ clientId: watchClient })).catch(() => {}); return; }
    const session = attachWatchRoom(room);
    await session.start();
    showPlayerUi();
    setWatchPanel(true); // straight to inviting people
    toast(T('Room ready. Invite people from here.'));
  } catch (err) { leaveWatchRoom(); toast(err.message); }
  finally { btn.disabled = false; }
}

async function offerWatchRoom(token) {
  if (party?.state.token === token) { toast(T('You’re already in this room')); return; }
  if (!/^[A-Za-z0-9_-]{24}$/.test(token)) { toast(T('Invalid watch-room link')); return; }
  try {
    const preview = await api(`/api/watch/${token}/preview`, { signal: AbortSignal.timeout(10000) });
    let closed = false;
    const status = h('p', { class: 'muted', role: 'status' });
    const join = h('button', { class: 'play-btn room-join', onclick: async () => {
      if (join.disabled) return;
      join.disabled = true;
      join.textContent = T('Joining…');
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
        status.textContent = err.name === 'TimeoutError' ? T('Joining took too long. Please try again.') : err.message;
        if (joined && party?.state.token !== token) api(`/api/watch/${token}/leave`, jsonPost({ clientId: watchClient })).catch(() => {});
      } finally { join.disabled = false; join.textContent = T('Join and watch'); join.removeAttribute('aria-busy'); }
    } }, T('Join and watch'));
    const here = (preview.faces || []).filter((f) => f.name !== preview.host);
    const ticket = h('div', { class: 'room-ticket' },
      h('div', { class: 'room-sign', 'aria-hidden': 'true' }, h('span', { class: 'room-bulbs' }), h('span', { class: 'room-kicker' }, T('You’re invited')), h('span', { class: 'room-bulbs' })),
      h('div', { class: 'room-ticket-host' },
        h('span', { class: 'room-member-face' }, people.face({ name: preview.host, avatar: preview.hostAvatar }, { size: 64 }),
          h('span', { class: 'room-crown', 'aria-hidden': 'true' }, icon('crown'))),
        h('div', {},
          h('p', { class: 'room-ticket-title' }, [preview.media.title, episodeLabel(preview.media)].filter(Boolean).join(' · ')),
          h('p', { class: 'room-ticket-by' }, T('{0} is hosting', preview.host)))),
      preview.startsAt && h('p', { class: 'room-ticket-when' }, T('Starts {0}', startLabel(preview.startsAt)), h('small', {}, countdownText(preview.startsAt - Date.now()))),
      here.length > 0 && h('p', { class: 'room-ticket-here' }, people.faces(here, { size: 26, max: 5 }),
        h('span', {}, T('{0} {1} already here', namesText(here.map((f) => f.name)), here.length === 1 ? T('is') : T('are')))));
    $('#picker-body').replaceChildren(h('h2', { id: 'picker-title', class: 'sr-only' }, T('Watch together')), ticket,
      h('p', { class: 'muted room-ticket-note' }, preview.startsAt
        ? T('Join any time before it starts. There’s a countdown, and playback starts by itself for everyone in the room.')
        : T('Playback stays in step with everyone. Subtitles and volume are just for you.')), join, status);
    pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { closed = true; }));
  } catch (err) { toast(err.message); }
}

function setWatchPanel(open) {
  watchPanelOpen = Boolean(open && party);
  if (!watchPanelOpen) closeInviteList();
  if (watchPanelOpen) { partyUnread = 0; requestAnimationFrame(() => { const log = $('#chat-log'); log.scrollTop = log.scrollHeight; }); }
  renderParty(); showPlayerUi();
}

// ---- Watch Together: chat, reactions and the countdown to a planned start ----
function renderChatLog() {
  const log = $('#chat-log');
  const chat = party?.chat || [];
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.replaceChildren(...chat.map((m, i) => social.chatLine(m, m.from === watchClient, chat[i - 1])));
  log.hidden = !log.childElementCount;
  $('#chat-empty').hidden = Boolean(log.childElementCount);
  if (nearBottom || chat.at(-1)?.from === watchClient) log.scrollTop = log.scrollHeight;
}
function partyChat(message) {
  renderChatLog();
  if (!message || message.from === watchClient) return;
  if (!watchPanelOpen) {
    social.floatMessage($('#chat-layer'), message);
    partyUnread++; renderParty();
  }
}
$('#reaction-bar').append(...REACTIONS.map((emoji) => h('button', { type: 'button', class: 'reaction-btn', 'aria-label': T('React {0}', emoji),
  onclick: (e) => {
    if (!party) return;
    const b = e.currentTarget; b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    social.burst($('#reaction-layer'), emoji, ''); party.react(emoji);
  } }, emoji)));
$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !party) return;
  input.value = '';
  try { await party.say(text); } catch (err) { input.value = text; toast(err.message); }
});
let countdownTimer = null;
function updatePartyCountdown() {
  const el = $('#party-countdown');
  const left = party?.startsIn;
  playerEl.classList.toggle('party-waiting', left != null && left > 0);
  if (left == null || left <= 0) {
    el.hidden = true; clearInterval(countdownTimer); countdownTimer = null;
    return;
  }
  const text = countdownText(left).replace(/^in /, '');
  const here = party.state.members.filter((m) => m.id !== watchClient);
  const hereKey = here.map((m) => `${m.name}|${m.avatar}`).join(',');
  if (el.dataset.blocked !== String(party.blocked) || el.dataset.here !== hereKey || !el.firstChild) {
    const seen = new Set();
    const faces = here.filter((m) => !seen.has(m.name) && seen.add(m.name));
    el.replaceChildren(
      h('div', { class: 'room-sign', 'aria-hidden': 'true' }, h('span', { class: 'room-bulbs' }), h('span', { class: 'room-kicker' }, T('Watch party starts in')), h('span', { class: 'room-bulbs' })),
      h('strong', { class: 'party-countdown-time' }, text),
      h('span', { class: 'party-countdown-title' }, [current?.filmTitle || current?.title, current && episodeLabel(current)].filter(Boolean).join(' · ')),
      faces.length ? h('span', { class: 'party-countdown-here' }, people.faces(faces, { size: 28, max: 5 }),
        h('span', {}, T('{0} {1} here', namesText(faces.map((m) => personName(m))), faces.length === 1 ? T('is') : T('are'))))
        : h('span', { class: 'party-countdown-here muted' }, T('Nobody else is here yet')),
      party.blocked ? h('button', { type: 'button', class: 'play-btn', onclick: () => party?.unlock() }, T('I’m ready'))
        : h('span', { class: 'muted' }, party.isHost ? T('Playback starts by itself. You can start early from the room.') : T('You’re ready. Playback starts by itself.')));
    el.dataset.blocked = String(party.blocked); el.dataset.here = hereKey;
  }
  const time = el.querySelector('.party-countdown-time');
  if (time && time.textContent !== text) time.textContent = text;
  el.hidden = false;
  countdownTimer ||= setInterval(() => { if (!party?.startsIn || party.startsIn <= 0) { party?.pulse(); } updatePartyCountdown(); }, 1000);
}
$('#watch-later').addEventListener('click', async (e) => {
  const minutes = Number(e.target.closest?.('[data-min]')?.dataset.min);
  if (!party || !minutes) return;
  try { await party.schedule(party.serverNow + minutes * 60000); } catch (err) { toast(err.message); }
});
$('#watch-start-now').addEventListener('click', () => party?.control('play'));
$('#watch-clear-start').addEventListener('click', async () => { try { await party?.schedule(null); } catch (err) { toast(err.message); } });

// ---- Marquee Wrapped: a story of slides over everything; tap or arrow keys to move ----
async function openWrapped(year, opener) {
  let data;
  try { data = await api(`/api/me/wrapped?year=${year}`); } catch (err) { toast(err.message); return; }
  const slides = social.wrappedSlides(data, { name: state.me?.name });
  let at = 0;
  const bars = h('div', { class: 'wr-bars', 'aria-hidden': 'true' }, slides.map(() => h('i')));
  const stage = h('div', { class: 'wr-stage', 'aria-live': 'polite' });
  const years = data.years?.filter((y) => y !== year) || [];
  const close = h('button', { type: 'button', class: 'icon-btn wr-close', 'aria-label': T('Close Wrapped'), onclick: closeTopOverlay }, icon('back'));
  const prev = h('button', { type: 'button', class: 'wr-tap wr-prev', 'aria-label': T('Previous') });
  const next = h('button', { type: 'button', class: 'wr-tap wr-next', 'aria-label': T('Next') });
  const el = h('div', { class: 'wrapped', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('Marquee Wrapped {0}', year), tabindex: '-1' },
    bars, close, stage, prev, next,
    years.length > 0 && h('div', { class: 'wr-years' }, years.map((y) => h('button', { type: 'button', class: 'chip', onclick: async () => {
      await dismissTopOverlay(); openWrapped(y, opener);
    } }, String(y)))));
  const show = (i) => {
    at = Math.max(0, Math.min(slides.length - 1, i));
    stage.replaceChildren(slides[at]);
    [...bars.children].forEach((b, n) => b.classList.toggle('done', n <= at));
    el.dataset.slide = slides[at].className.split(' ').find((c) => /^wr-[a-g]$/.test(c)) || '';
  };
  prev.onclick = () => show(at - 1);
  next.onclick = () => (at === slides.length - 1 ? closeTopOverlay() : show(at + 1));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next.onclick(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
  });
  let startX = null;
  el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX; startX = null;
    if (Math.abs(dx) > 50) { if (dx < 0) next.onclick(); else show(at - 1); }
  });
  document.body.append(el);
  document.documentElement.classList.add('wrapped-on');
  show(0);
  requestAnimationFrame(() => { el.classList.add('open'); el.focus(); });
  pushOverlay(() => {
    el.classList.remove('open'); document.documentElement.classList.remove('wrapped-on');
    setTimeout(() => el.remove(), 250); opener?.focus({ preventScroll: true });
  });
}

// ---- planned watch parties ----
const partyLink = (token) => `${location.origin}/c/w/${token}`;
const partyTitle = (m) => [m.filmTitle || m.title, episodeLabel(m)].filter(Boolean).join(' · ');
function openPlanParty(f, opener) {
  const title = partyTitle(f);
  const copy = (link) => copyWithToast(link, T('Invite copied. Everyone uses their usual Marquee sign-in.'));
  $('#picker-body').replaceChildren(...social.planPartyBody({ file: f, title, onPlanned: (room) => {
    $('#picker-body').replaceChildren(...social.plannedBody({ room, title, link: partyLink(room.token), copy }));
    loadParties();
  } }));
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => opener?.focus({ preventScroll: true })));
}
let partiesRequest = null;
async function loadParties() {
  if (!libraryUI?.parties) return;
  partiesRequest ||= api('/api/watch/parties').finally(() => { partiesRequest = null; });
  let parties = [];
  try { parties = (await partiesRequest).parties; } catch { return; }
  const shelf = social.partiesShelf(parties, {
    label: partyTitle,
    join: (p) => offerWatchRoom(p.token),
    copy: (p) => copyWithToast(partyLink(p.token), T('Invite copied. Everyone uses their usual Marquee sign-in.')),
    cancel: async (p, btn) => {
      if (!confirm(T('Cancel the watch party for {0}? The invite stops working.', partyTitle(p.media)))) return;
      btn.disabled = true;
      try { await api(`/api/watch/${p.token}/cancel`, jsonPost({})); toast(T('Watch party cancelled')); loadParties(); }
      catch (err) { btn.disabled = false; toast(err.message); }
    },
  });
  libraryUI.parties.replaceChildren(...(shelf ? [shelf] : []));
}
$('#watch-btn').addEventListener('click', () => { if (party) setWatchPanel(!watchPanelOpen); else hostWatchRoom(); });
$('#watch-hide').addEventListener('click', () => { setWatchPanel(false); $('#watch-btn').focus(); });
// The phone sheet covers the picture, so a tap outside closes it; the docked panel stays put.
document.addEventListener('click', (event) => {
  if (!watchPanelOpen || roomDocked() || !event.target.isConnected) return;
  if (!event.target.closest?.('#watch-bar, #watch-btn')) setWatchPanel(false);
});
$('#watch-ready').addEventListener('click', () => party?.unlock());
$('#watch-copy').addEventListener('click', () => {
  // /c/w/ shows a preview in Discord and other chats, then forwards to /?watch=
  if (party) copyWithToast(`${location.origin}/c/w/${party.state.token}`, T('Room link copied. Everyone uses their usual Marquee sign-in.'));
});
$('#watch-leave').addEventListener('click', () => { leaveWatchRoom(); video.pause(); toast(T('You left the room')); });
// Invite: people with Watch Together invites on get a notification that opens the room.
const inviteList = $('#watch-invite-list');
function closeInviteList() { inviteList.hidden = true; $('#watch-invite').setAttribute('aria-expanded', 'false'); }
$('#watch-invite').addEventListener('click', async () => {
  if (!inviteList.hidden) { closeInviteList(); return; }
  if (!party) return;
  const token = party.state.token;
  inviteList.hidden = false; $('#watch-invite').setAttribute('aria-expanded', 'true');
  inviteList.replaceChildren(h('p', { class: 'room-hint' }, T('Finding people…')));
  try {
    const { people: invitees } = await api(`/api/watch/${token}/invitees?clientId=${encodeURIComponent(watchClient)}`);
    if (party?.state.token !== token) return;
    if (!invitees.length) {
      inviteList.replaceChildren(h('p', { class: 'room-hint' }, T('Nobody else has notifications on yet. Copy the link and send it instead.')));
      return;
    }
    inviteList.replaceChildren(h('p', { class: 'room-hint' }, T('Tap someone to send them a notification.')),
      h('ul', { class: 'room-invitee-grid' }, invitees.map((u) => {
        const state = h('span', { class: 'room-invitee-state' }, T('Invite'));
        const tile = h('button', { class: 'room-invitee', type: 'button', 'aria-label': T('Invite {0}', u.name) },
          people.face(u, { size: 44 }), h('span', { class: 'room-invitee-name' }, u.name), state);
        tile.addEventListener('click', async () => {
          if (tile.dataset.state === 'sent' || tile.disabled) return;
          tile.disabled = true; tile.dataset.state = 'sending'; state.textContent = T('Sending…');
          try {
            const r = await api(`/api/watch/${token}/invite`, jsonPost({ clientId: watchClient, userIds: [u.id] }));
            tile.dataset.state = r.sent ? 'sent' : 'failed';
            state.replaceChildren(...(r.sent ? [icon('check'), T('Invited')] : [T('Not reached')]));
            tile.setAttribute('aria-label', r.sent ? T('{0} invited', u.name) : T('{0} wasn’t reached', u.name));
            if (!r.sent) { tile.disabled = false; toast(T('{0}’s devices didn’t accept the notification. Copy the link instead.', u.name)); }
          } catch (err) { tile.disabled = false; tile.dataset.state = ''; state.textContent = T('Invite'); toast(err.message); }
        });
        return h('li', {}, tile);
      })));
  } catch (err) { inviteList.replaceChildren(h('p', { class: 'room-hint' }, err.message)); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && party) { party.clock().then(() => party?.pulse()).catch(() => {}); } });

function saveProgress(force = false) {
  countPlayed();
  if (plainMedia(current)) return; // clips and note videos have no resume point
  if (!current?.ready || video.currentSrc !== current.sourceUrl || !video.duration || !isFinite(video.duration)) return;
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
  invalidateLibraryProgress();
  const watched = Math.round(playedSince * 10) / 10;
  playedSince = 0;
  api('/api/me/progress', { ...jsonPost({ ref, time: done ? null : video.currentTime, duration: video.duration,
    watched, about: watchAbout(current), room: party?.state.token || undefined }), keepalive: true }).catch(() => {});
}
let lastPush = 0;

// Watch time for Wrapped and Popular on Marquee: seconds the video really played (not seeking,
// not paused, not a tab asleep in the background), sent with each progress save.
let playedSince = 0, playTick = null;
function countPlayed() {
  const now = Date.now();
  if (playTick != null && !video.paused && !video.seeking) {
    const dt = (now - playTick) / 1000;
    if (dt > 0 && dt < 3) playedSince += dt;
  }
  playTick = video.paused ? null : now;
}
const watchAbout = (f) => ({ titleKey: titleKeyOf(f.season == null && f.tmdbId ? { tmdbId: f.tmdbId } : f) || undefined,
  title: f.filmTitle || f.canonicalTitle || f.title || f.name || '', season: f.season ?? null, episode: f.episode ?? null });

const mediaId = (f) => (f.kind === 'lib' ? f.id || f.key : f.hash || f.key);
// Clips and note videos play in the player's plain mode: no subtitles, audio choices, casting,
// Watch Together, Up next or resume points.
function plainMedia(f) { return f?.kind === 'clip' || f?.kind === 'note'; }

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
let castWatch = null;
let castGeneration = 0;

airplayBtn.setAttribute('aria-label', hasAirPlay ? 'AirPlay' : T('Cast to a TV'));
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
  if (!hasRemotePlayback || !current) return; // Safari reports availability through its own event
  const session = current;
  const token = castWatch = {};
  video.remote.watchAvailability((available) => {
    if (current === session && castWatch === token) airplayBtn.hidden = Boolean(party) || !available;
  }).then((id) => {
    if (current !== session || castWatch !== token) video.remote.cancelWatchAvailability(id).catch(() => {});
    else remoteWatchId = id;
  }).catch(() => { if (current === session && castWatch === token) airplayBtn.hidden = true; });
}

function resetCasting() {
  castGeneration++;
  castWatch = null;
  airplayBtn.hidden = true;
  airplayBtn.classList.remove('is-hint');
  if (hasRemotePlayback && remoteWatchId != null) video.remote.cancelWatchAvailability(remoteWatchId).catch(() => {});
  remoteWatchId = null;
  onTvVersion = false;
}

// Only the current source may restore its position. Replacing a source removes the previous
// metadata continuation, including AirPlay and audio-fix swaps still waiting for metadata.
let sourceMetadataHandler = null;
function setPlayerSource(url, session, onMetadata) {
  if (current !== session) return;
  if (sourceMetadataHandler) video.removeEventListener('loadedmetadata', sourceMetadataHandler);
  session.ready = false;
  const expected = session.sourceUrl = new URL(url, location.href).href;
  const handler = () => {
    if (sourceMetadataHandler !== handler || current !== session || video.currentSrc !== expected || video.readyState < 1) return;
    video.removeEventListener('loadedmetadata', handler);
    sourceMetadataHandler = null;
    session.ready = true;
    onMetadata?.();
    updateUpNext();
  };
  sourceMetadataHandler = handler;
  video.addEventListener('loadedmetadata', handler);
  video.src = url;
}

function capturePlayback(session = current) {
  if (!session?.ready && session?.sourceSnapshot) return { ...session.sourceSnapshot };
  return { url: video.currentSrc || video.src, time: video.currentTime || 0, playing: !video.paused && !video.ended,
    muted: video.muted, volume: video.volume, rate: video.playbackRate };
}
function restorePlayback(snapshot) {
  if (Number.isFinite(snapshot.time)) video.currentTime = Math.max(0, Math.min(snapshot.time, Number.isFinite(video.duration) ? Math.max(0, video.duration - .05) : snapshot.time));
  video.muted = snapshot.muted;
  if (canSetVolume) video.volume = snapshot.volume;
  video.playbackRate = snapshot.rate;
  applySubModes();
  if (party) { party.pulse(); party.sync(); }
  else if (snapshot.playing) video.play().catch(() => {});
  else video.pause();
}
function swapSource(url, onReady) {
  const session = current;
  if (!session) return;
  const snapshot = session.sourceSnapshot = capturePlayback(session);
  setPlayerSource(url, session, () => {
    session.sourceSnapshot = null;
    restorePlayback(snapshot);
    onReady?.();
  });
}

async function onWireless(on) {
  const generation = ++castGeneration;
  if (on && party) { leaveWatchRoom(); toast(T('Left Watch Together: casting is not synchronized.')); }
  const session = current;
  if (!session) return;
  if (on) cancelAudioIntent(session);
  renderAudioControls();
  renderQualityMenu();
  const note = $('#player-note');
  if (on) {
    note.textContent = T('Playing on your TV. The controls here work as a remote.');
    note.hidden = false;
  } else if (note.textContent.startsWith(T('Playing on your TV'))) {
    note.hidden = true;
  }
  // With AirPlay, switch to the TV version so the TV gets the original surround audio.
  // (Chromecast keeps the current version: changing the source would end the cast.)
  if (!hasAirPlay || on === onTvVersion) return;
  try {
    const link = await api(`/api/play-link?kind=${session.kind}&id=${encodeURIComponent(mediaId(session))}&variant=${on ? 'tv' : browserVariant()}`);
    if (current !== session || generation !== castGeneration) return;
    const tvCanPlay = ['mp4', 'm4v', 'mov'].includes(link.ext);
    if (on && (!tvCanPlay || link.name === session.browserName)) return; // nothing better to send
    swapSource(link.url, () => refreshAudioMetadata(session, true));
    onTvVersion = on;
    renderAudioControls();
  } catch { /* keep playing the current version */ }
}

const ccBtn = $('#cc-btn');
const ccMenu = $('#cc-menu');
let ccLangs = [];
let ccActive = null;
let ccSecond = null; // a second language shown with the first, smaller and above it
let subtitleGeneration = 0;
let secondGeneration = 0;

// Subtitles are drawn by the page (#player-subs) rather than the browser, so they stay inside the
// picture and move up out of the way while the controls are showing. The track runs in 'hidden'
// mode for that: its cues load and change, but the browser draws nothing. Where the page can't
// draw (iOS's own fullscreen player, picture-in-picture) the browser draws them instead.
const subsEl = $('#player-subs');
let nativeSubs = false;
let subTrack = null;
let secondTrack = null;

// The browser's own drawing (iOS fullscreen, picture-in-picture) shows one language: the first.
function applySubModes() {
  subTrack = secondTrack = null;
  for (const t of video.textTracks) {
    if (t.kind !== 'subtitles') continue;
    const first = Boolean(ccActive) && t.language === ccActive;
    const second = !first && Boolean(ccSecond) && t.language === ccSecond;
    if (party && (first || second)) offsetCues(t, party.offsets[t.language] || 0);
    t.mode = first ? (nativeSubs ? 'showing' : 'hidden') : second && !nativeSubs ? 'hidden' : 'disabled';
    if (first && !nativeSubs) subTrack = t;
    if (second && !nativeSubs) secondTrack = t;
  }
  if (subTrack) subTrack.oncuechange = renderCues;
  if (secondTrack) secondTrack.oncuechange = renderCues;
  renderCues();
}

// Cues placed at the top of the picture ({\an8} in the SRT, `line:0` in the VTT) stay at the top.
const cueAtTop = (c) => typeof c.line === 'number' && (c.snapToLines ? c.line >= 0 : c.line < 50);

// A cue broken into three or more short lines stacks up tall and narrow. Its line breaks become
// spaces (a dialogue line starting with "-" keeps its own line) and the text wraps across the width.
function widenCue(node) {
  const texts = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode);
  const all = texts.map((t) => t.data).join('');
  if (all.trim().split('\n').length < 3) return;
  let at = 0;
  for (const t of texts) {
    const start = at;
    at += t.data.length;
    t.data = t.data.replace(/\n/g, (m, i) => (/^\s*[-\u2010-\u2014]/.test(all.slice(start + i + 1)) ? m : ' '));
  }
}

function renderCues() {
  const [top, bottom] = subsEl.children;
  const active = (t) => (t?.activeCues ? [...t.activeCues] : []);
  const cues = active(subTrack), seconds = active(secondTrack);
  const draw = (list, second = false) => list.map((c) => {
    const text = h('span');
    if (typeof c.getCueAsHTML === 'function') text.append(c.getCueAsHTML()); // <i>, <b> and friends; never parsed as page HTML
    else text.textContent = c.text;
    widenCue(text);
    return h('div', { class: second ? 'sub-cue sub-second' : 'sub-cue' }, text);
  });
  // The second language sits just above the first, so the eye moves between them line by line.
  top.replaceChildren(...draw(cues.filter(cueAtTop)), ...draw(seconds.filter(cueAtTop), true));
  bottom.replaceChildren(...draw(seconds.filter((c) => !cueAtTop(c)), true), ...draw(cues.filter((c) => !cueAtTop(c))));
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
  if (ccActive && ccActive === ccSecond) ccSecond = null;
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
  subtitleGeneration++;
  secondGeneration++;
  video.querySelectorAll('track').forEach((t) => t.remove());
  ccActive = ccSecond = null;
  ccSync = null;
  clearTimeout(ccSyncTimer);
  applySubModes();
}
const subTrackEl = (code) => (code ? [...video.querySelectorAll('track')].find((t) => t.getAttribute('srclang') === code) : null);
// Drops the first language only; a second language stays on.
function dropFirstSub() {
  subtitleGeneration++;
  subTrackEl(ccActive)?.remove();
  ccActive = null;
  ccSync = null;
  clearTimeout(ccSyncTimer);
  applySubModes();
}
function dropSecondSub() {
  secondGeneration++;
  subTrackEl(ccSecond)?.remove();
  ccSecond = null;
  applySubModes();
}
function closeCcMenu() { ccMenu.hidden = true; ccBtn.setAttribute('aria-expanded', 'false'); }
ccBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = ccMenu.hidden;
  closeAudioMenu();
  ccMenu.hidden = !open;
  ccBtn.setAttribute('aria-expanded', String(open));
  if (open) (ccMenu.querySelector('[aria-checked="true"]') || ccMenu.querySelector('button'))?.focus();
});
document.addEventListener('click', (e) => { if (!ccMenu.hidden && !ccMenu.contains(e.target)) closeCcMenu(); });

function renderCcMenu(f, session, message) {
  const items = [{ code: null, name: T('Off') }, ...ccLangs];
  ccMenu.replaceChildren(
    ...items.map((l) => h('button', {
      role: 'menuitemradio', class: 'cc-item', 'aria-checked': String(ccActive === l.code),
      onclick: () => pickPlayerSub(f, session, l),
    }, l.name)),
    ...(message ? [h('p', { class: 'cc-message' }, message)] : []),
    ...(ccActive ? [h('div', { class: 'cc-divider', role: 'separator' }), ...[secondSubRow(f, session)].filter(Boolean), ...subLookRows()] : []),
    ...subSyncItems(f, session));
  ccBtn.classList.toggle('is-on', Boolean(ccActive));
}

// ---- subtitle timing ----
// The server lines downloaded subtitles up with the film in the background. While that runs the
// menu says so, and when the file changes the track is reloaded in place.
let ccSync = null;
let ccSyncTimer = null;
const SUB_SYNC_TEXT = {
  queued: T('Checking the timing…'),
  syncing: T('Checking the timing…'),
  ok: T('Timing checked: already in sync.'),
  unsure: T('Couldn’t check the timing automatically.'),
  exact: T('Made for this exact file.'),
  undone: T('Using the original timing.'),
};
const subSyncBusy = (s) => s?.state === 'queued' || s?.state === 'syncing';
const fmtSubShift = (s) => `${Math.round(Math.abs(s) * 100) / 100} s ${s < 0 ? 'earlier' : 'later'}`;

function subSyncText(s) {
  if (s.state === 'failed') return T('Timing check failed: {0}', s.error || T('unknown error'));
  if (s.state !== 'synced') return SUB_SYNC_TEXT[s.state];
  return s.offset != null
    ? T('Timing fixed: lines moved {0}{1}{2}.', fmtSubShift(s.offset), s.ratio && s.ratio !== 1 ? T(', adjusted for frame rate') : '', s.parts > 1 ? T(', in {0} parts (the subtitles were made for a differently cut version)', s.parts) : '')
    : null;
}

// Manual offset: − shows lines earlier (they come after the speech), + later (they come too soon).
const NUDGES = [-1, -0.25, 0.25, 1];
function nudgeRow(manual, onNudge) {
  return h('div', { class: 'cc-nudge' },
    h('span', { class: 'cc-nudge-label' }, T('Subtitle offset'),
      h('b', {}, manual ? ` ${manual > 0 ? '+' : '−'}${Math.round(Math.abs(manual) * 100) / 100} s` : ' 0 s')),
    h('div', { class: 'cc-nudge-buttons' }, NUDGES.map((n) => h('button', {
      type: 'button', 'aria-label': T('Show subtitles {0} seconds {1}', Math.abs(n), n < 0 ? T('earlier') : T('later')), onclick: () => onNudge(n),
    }, `${n < 0 ? '−' : '+'}${Math.abs(n) === 0.25 ? '¼' : Math.abs(n)} s`))),
    h('span', { class: 'cc-nudge-hint' }, T('− earlier · + later')),
    manual ? h('button', { type: 'button', class: 'cc-nudge-reset', onclick: () => onNudge(-manual) }, T('Reset offset')) : null);
}

function subSyncItems(f, session) {
  if (party && ccActive) return [
    h('div', { class: 'cc-divider', role: 'separator' }),
    h('p', { class: 'cc-message' }, T('Only your subtitles change. Other viewers keep their own settings.')),
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
    s.canUndo && s.offset != null && action(T('Undo timing fix'), 'undo'),
    s.canSync && action(['synced', 'ok', 'unsure'].includes(s.state) ? T('Check timing again') : T('Fix timing'), 'sync'),
  ].filter(Boolean);
}

// Taps are applied one after another, so quick repeated taps all count.
let nudgeChain = Promise.resolve();
function subSyncNudge(f, session, l, seconds) {
  const generation = subtitleGeneration;
  nudgeChain = nudgeChain.then(async () => {
    if (current !== session || generation !== subtitleGeneration || ccActive !== l.code) return;
    try {
      const result = await api('/api/subs/sync', jsonPost({ kind: f.kind, id: mediaId(f), lang: l.code, action: 'shift', seconds }));
      if (current !== session || generation !== subtitleGeneration || ccActive !== l.code) return;
      ccSync = result;
      reloadSubTrack(l);
      renderCcMenu(f, session);
    } catch (err) { if (current === session && generation === subtitleGeneration && ccActive === l.code) toast(err.message); }
  });
}

async function subSyncAction(f, session, l, act) {
  const generation = subtitleGeneration;
  try {
    const result = await api('/api/subs/sync', jsonPost({ kind: f.kind, id: mediaId(f), lang: l.code, action: act }));
    if (current !== session || generation !== subtitleGeneration || ccActive !== l.code) return;
    ccSync = result;
    if (act === 'undo') { reloadSubTrack(l); toast(T('Back to the original subtitle timing')); }
    renderCcMenu(f, session);
    if (subSyncBusy(ccSync)) watchSubSync(f, session, l, true);
  } catch (err) { if (current === session && generation === subtitleGeneration && ccActive === l.code) toast(err.message); }
}

async function watchSubSync(f, session, l, wasBusy = false) {
  const generation = subtitleGeneration;
  clearTimeout(ccSyncTimer);
  let s;
  try { s = await api(`/api/subs/sync?kind=${f.kind}&id=${encodeURIComponent(mediaId(f))}&lang=${l.code}`); } catch { return; }
  if (current !== session || generation !== subtitleGeneration || ccActive !== l.code) return;
  ccSync = s;
  if (subSyncBusy(s)) {
    ccSyncTimer = setTimeout(() => watchSubSync(f, session, l, true), 3000);
  } else if (wasBusy && ['synced', 'ok'].includes(s.state)) {
    reloadSubTrack(l);
    toast(s.state === 'ok' ? T('Subtitle timing checked') : T('Subtitle timing fixed ({0})', fmtSubShift(s.offset)));
  } else if (wasBusy && s.state === 'failed') {
    toast(T('Couldn’t check the subtitle timing'));
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
  renderCcMenu(f, session, ccLangs.length ? null : (data.problem || T('No subtitles found for this.')));
  // Re-enable the last used language if it's already saved locally (no download quota used).
  // Or the language picked in Settings, which is fetched when it isn't saved yet.
  let pref = null;
  try { pref = localStorage.getItem('subs:lang'); } catch { /* blocked */ }
  const want = prefs().subLang;
  const saved = ccLangs.find((l) => l.code === pref && l.saved) || (want && pref !== '' && ccLangs.find((l) => l.code === want))
    // Anime (Japanese audio) for someone who never picked subtitles: the English ones it came with.
    || (data.anime && pref == null && !want && ccLangs.find((l) => l.code === 'en' && l.saved));
  if (!saved) return;
  await pickPlayerSub(f, session, saved, { quiet: true });
  // The second language comes back too, but only when it's already saved here (no download quota).
  let second = null;
  try { second = localStorage.getItem('subs:second'); } catch { /* blocked */ }
  const again = second && current === session && ccActive && secondChoices(ccLangs, ccActive).find((l) => l.code === second && l.saved);
  if (again) pickSecondSub(f, session, again, { quiet: true });
}

async function pickPlayerSub(f, session, l, { quiet = false } = {}) {
  if (current !== session) return;
  if (!quiet) closeCcMenu();
  try { localStorage.setItem('subs:lang', l.code || ''); } catch { /* blocked */ }
  // Picking the language that was second makes it the first; there's no point showing it twice.
  if (l.code && l.code === ccSecond) { dropSecondSub(); try { localStorage.setItem('subs:second', ''); } catch { /* blocked */ } }
  dropFirstSub();
  const generation = subtitleGeneration;
  if (!l.code) { dropSecondSub(); renderCcMenu(f, session); return; } // Off means no text at all
  if (!quiet) toast(T('Getting {0} subtitles…', l.name));
  try {
    const { url } = await api('/api/subs/fetch', jsonPost({ kind: f.kind, id: mediaId(f), lang: l.code }));
    if (current !== session || generation !== subtitleGeneration) return;
    const track = h('track', { kind: 'subtitles', srclang: l.code, label: l.name, src: url, default: true });
    video.append(track);
    ccActive = l.code;
    applySubModes();
    track.addEventListener('load', applySubModes);
    l.saved = true;
    renderCcMenu(f, session);
    if (!quiet) toast(T('{0} subtitles on', l.name));
    watchSubSync(f, session, l);
  } catch (err) {
    if (current !== session || generation !== subtitleGeneration) return;
    renderCcMenu(f, session, err.message);
    if (!quiet) toast(err.message);
  }
}

// ---- second language ----
// Two languages at once, for learning one or watching with someone who reads another. The second
// one is drawn smaller, in a warm tint, just above the first. Its timing follows the first's fixes
// only where the files already agree; it has no timing controls of its own.
async function pickSecondSub(f, session, l, { quiet = false } = {}) {
  if (current !== session) return;
  if (!quiet) { try { localStorage.setItem('subs:second', l.code || ''); } catch { /* blocked */ } }
  dropSecondSub();
  const generation = secondGeneration;
  if (!l.code || l.code === ccActive) { renderCcMenu(f, session); return; }
  if (!quiet) toast(T('Getting {0} subtitles…', l.name));
  try {
    const { url } = await api('/api/subs/fetch', jsonPost({ kind: f.kind, id: mediaId(f), lang: l.code }));
    if (current !== session || generation !== secondGeneration || l.code === ccActive) return;
    const track = h('track', { kind: 'subtitles', srclang: l.code, label: l.name, src: url });
    video.append(track);
    ccSecond = l.code;
    applySubModes();
    track.addEventListener('load', applySubModes);
    l.saved = true;
    renderCcMenu(f, session);
    if (!quiet) toast(T('{0} added as a second language', l.name));
  } catch (err) {
    if (current !== session || generation !== secondGeneration) return;
    renderCcMenu(f, session, err.message);
    if (!quiet) toast(err.message);
  }
}
function secondSubRow(f, session) {
  const choices = secondChoices(ccLangs, ccActive);
  if (!choices.length) return null;
  const pick = h('select', { class: 'cc-select', 'aria-label': T('Second subtitle language'),
    onchange: () => pickSecondSub(f, session, choices.find((l) => l.code === pick.value) || { code: null, name: T('Off') }) },
  h('option', { value: '' }, T('Off')), ...choices.map((l) => h('option', { value: l.code }, l.name)));
  pick.value = ccSecond || '';
  return h('label', { class: 'cc-row' }, h('span', { class: 'cc-nudge-label' }, T('Second')), pick);
}

// ---- audio compatibility ----
const CODEC_NAMES = { ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', mlp: 'Dolby TrueHD' };
const CODEC_MIME = { ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'flac', vorbis: 'vorbis', alac: 'alac' };
const browserPlays = (codec) => Boolean(CODEC_MIME[codec] && video.canPlayType(`audio/mp4; codecs="${CODEC_MIME[codec]}"`));

// Extra codecs this browser can decode, reported to the server.
const playsHevc = () => Boolean(video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'));
// Browsers that play HEVC get the original HEVC video; the rest get the H.264 browser copy when there is one.
const baseVariant = () => (playsHevc() ? 'browser-hevc' : 'browser');
// While the phone-quality stream plays, follow-up links (audio choice, back from AirPlay) stay on it.
const phoneQuality = (session = current) => (session?.quality === '1080' || session?.quality === '720' ? session.quality : null);
function browserVariant() { const q = phoneQuality(); return q ? `phone${q}` : baseVariant(); }
const extraPlayable = () => [...Object.keys(CODEC_MIME).filter(browserPlays), playsHevc() && 'hevc', phoneQuality() && 'phone'].filter(Boolean).join(',');

// ---- audio selection ----
const audioBtn = $('#sync-btn');
const audioMenu = $('#sync-menu');
const audioStatus = $('#audio-status');
let audioWatch = null;
let audioMenuSignature = '';
let audioRows = new Map();
let audioMessage = null;
let audioRetry = null;
const audioCasting = () => Boolean(onTvVersion || video.webkitCurrentPlaybackTargetIsWireless || video.remote?.state === 'connected');
const audioSuppressed = () => Boolean(party || audioCasting());
function closeAudioMenu() { audioMenu.hidden = true; audioBtn.setAttribute('aria-expanded', 'false'); }
function announceAudio(message) { if (audioStatus.textContent !== message) audioStatus.textContent = message; }
function audioLabel(a, index) { return audioChoices(a.tracks).find(t => t.index === index)?.label || T('Audio'); }
function renderAudioControls() {
  const a = current?.audio;
  audioBtn.hidden = !a || a.tracks.length < 2 || audioSuppressed() || nativeSubs;
  if (audioBtn.hidden) closeAudioMenu();
  audioBtn.setAttribute('aria-label', a?.activeLabel ? T('Audio: {0}', a.activeLabel) : T('Audio'));
  if (!a) return;
  const choices = audioChoices(a.tracks);
  const signature = JSON.stringify([a.source, choices]);
  if (signature !== audioMenuSignature) {
    const focused = audioMenu.contains(document.activeElement) ? document.activeElement?.dataset?.audioIndex : null;
    audioMenuSignature = signature;
    audioRows = new Map();
    const rows = choices.map(track => {
      const status = h('span', { class: 'audio-row-status' });
      const button = h('button', { type: 'button', role: 'menuitemradio', class: 'cc-item', tabindex: '-1',
        'data-audio-index': track.index, onclick: () => selectAudioTrack(track.index) }, h('span', {}, track.label), status);
      audioRows.set(track.index, { button, status });
      return button;
    });
    audioMessage = h('p', { class: 'cc-message audio-message', hidden: true });
    audioRetry = h('button', { type: 'button', role: 'menuitem', class: 'cc-item audio-retry', tabindex: '-1', hidden: true,
      onclick: () => { if (current?.audio?.failed != null) selectAudioTrack(current.audio.failed); } }, T('Retry'));
    audioMenu.replaceChildren(h('p', { class: 'audio-title' }, T('Audio')), ...rows, audioMessage, audioRetry);
    if (focused != null && !audioMenu.hidden) audioRows.get(Number(focused))?.button.focus({ preventScroll: true });
  }
  for (const [index, row] of audioRows) {
    row.button.setAttribute('aria-checked', String(index === a.actual));
    const text = index === a.pending ? a.swap ? T('Switching…') : T('Preparing…') : '';
    if (row.status.textContent !== text) row.status.textContent = text;
  }
  const message = a.error || (a.pending != null ? a.swap ? T('Switching to {0} audio…', audioLabel(a, a.pending)) : T('Preparing {0} audio. Playback continues.', audioLabel(a, a.pending)) : '');
  if (audioMessage.textContent !== message) audioMessage.textContent = message;
  audioMessage.hidden = !message;
  audioRetry.hidden = !a.error || a.failed == null;
}
audioBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = audioMenu.hidden;
  closeCcMenu();
  renderAudioControls();
  if (audioBtn.hidden) return;
  audioMenu.hidden = !open;
  audioBtn.setAttribute('aria-expanded', String(open));
  if (open) (audioMenu.querySelector('[aria-checked="true"]') || audioMenu.querySelector('button'))?.focus();
});
audioMenu.addEventListener('keydown', e => {
  const items = [...audioMenu.querySelectorAll('button')].filter(b => !b.hidden && !b.disabled);
  const index = items.indexOf(document.activeElement);
  const target = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (index + 1) % items.length : e.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null;
  if (target != null && items.length) { e.preventDefault(); items[target].focus(); }
});
audioMenu.addEventListener('focusout', () => setTimeout(() => { if (!audioMenu.contains(document.activeElement)) closeAudioMenu(); }, 0));
document.addEventListener('click', e => { if (!audioMenu.hidden && !audioMenu.contains(e.target)) closeAudioMenu(); });

function cancelAudioIntent(session, restore = true) {
  const a = session?.audio;
  if (!a) return;
  a.generation++;
  a.abort?.abort();
  a.abort = null;
  a.pending = null;
  if (a.intentUserChoice != null) a.userChoice = a.intentUserChoice;
  a.intentUserChoice = null;
  const swap = a.swap;
  a.swap = null;
  swap?.cancel(restore);
}
function recoverAudioOwnership(session, a) {
  if (a.intentUserChoice != null) a.userChoice = a.intentUserChoice;
  a.intentUserChoice = null;
  if (current === session && !a.userChoice && !audioSuppressed()) watchAudio(session, session);
}
function resetAudioSelection(session) {
  cancelAudioIntent(session, false);
  audioMenuSignature = '';
  audioRows.clear();
  closeAudioMenu();
  audioBtn.hidden = true;
  announceAudio('');
}
function installAudioMetadata(session, data, reset = false) {
  if (current !== session || !data.audioSource || !Array.isArray(data.tracks)) return;
  const tracks = data.tracks.filter(t => Number.isSafeInteger(t.index) && Number.isSafeInteger(t.audioIndex));
  let a = session.audio;
  if (!a) a = session.audio = { generation: 0, source: data.audioSource, actual: data.defaultAudio,
    tracks, default: data.defaultAudio, pending: null, failed: null, error: '', usingFallback: false, sourceMatches: true, userChoice: false };
  else if (a.source !== data.audioSource || reset) {
    const changedChoice = a.userChoice && !reset;
    cancelAudioIntent(session);
    a.source = data.audioSource;
    a.actual = changedChoice ? null : data.defaultAudio;
    a.usingFallback = changedChoice && a.usingFallback;
    a.sourceMatches = !changedChoice;
    a.error = changedChoice ? T('Audio tracks changed. Choose a track again.') : '';
    a.failed = null;
    if (!changedChoice) { a.userChoice = false; a.activeLabel = null; }
  }
  a.tracks = tracks;
  a.default = data.defaultAudio;
  if (a.actual != null) a.activeLabel = audioLabel(a, a.actual);
  renderAudioControls();
  reflectNativeAudio();
}
async function refreshAudioMetadata(session, reset = false) {
  const audio = session.audio;
  const generation = audio?.generation;
  try {
    const data = await api(`/api/media/${session.kind}/${encodeURIComponent(mediaId(session))}/audio?plays=${extraPlayable()}`, { signal: session.abort.signal });
    if (current === session && session.audio === audio && audio?.generation === generation) { installAudioMetadata(session, data, reset); return true; }
  } catch { /* playback remains available */ }
  return false;
}
function reflectNativeAudio() {
  const a = current?.audio;
  if (!a || a.usingFallback || !a.sourceMatches || a.pending != null || audioSuppressed()) return;
  const mapping = nativeAudioMapping(a.tracks, video.audioTracks);
  if (!mapping) return;
  const enabled = [...mapping].filter(([, track]) => track.enabled);
  if (enabled.length === 1) {
    a.actual = enabled[0][0];
    a.activeLabel = audioLabel(a, a.actual);
    a.userChoice = a.actual !== a.default;
    renderAudioControls();
  }
}
video.audioTracks?.addEventListener?.('change', reflectNativeAudio);
video.addEventListener('loadedmetadata', reflectNativeAudio);
for (const event of ['webkitbeginfullscreen', 'webkitendfullscreen', 'enterpictureinpicture', 'leavepictureinpicture']) video.addEventListener(event, () => { reflectNativeAudio(); renderAudioControls(); });
if (hasRemotePlayback) for (const event of ['connect', 'disconnect']) video.remote.addEventListener(event, () => {
  if (audioSuppressed()) cancelAudioIntent(current);
  renderAudioControls();
});
function audioPrepareDelay(signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 1000);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
function switchAudioSource(session, a, generation, link, valid) {
  return new Promise(resolve => {
    const snapshot = capturePlayback(session);
    const previous = { actual: a.actual, activeLabel: a.activeLabel, usingFallback: a.usingFallback };
    session.sourceSnapshot = snapshot;
    let timer, metadataReady = false;
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('error', failed); video.removeEventListener('canplay', commit); };
    const restore = () => {
      Object.assign(a, previous);
      session.sourceSnapshot = snapshot;
      setPlayerSource(snapshot.url, session, () => { session.sourceSnapshot = null; restorePlayback(snapshot); $('#player-error').hidden = true; });
    };
    const failed = () => {
      if (!valid() || a.swap !== swap) return;
      cleanup(); a.swap = null;
      a.error = T('This audio couldn’t play. Restoring your previous audio.');
      a.failed = link.track; a.pending = null;
      $('#player-error').hidden = true;
      restore(); renderAudioControls(); announceAudio(a.error); resolve(false);
      recoverAudioOwnership(session, a);
    };
    const commit = () => {
      if (!metadataReady || !valid() || a.swap !== swap) return;
      cleanup(); a.swap = null; session.sourceSnapshot = null;
      a.actual = link.track; a.pending = null; a.failed = null; a.error = ''; a.usingFallback = true;
      a.intentUserChoice = null;
      a.activeLabel = audioLabel(a, a.actual);
      renderAudioControls(); announceAudio(T('{0} audio selected.', a.activeLabel)); resolve(true);
    };
    const swap = { cancel: restoreSource => { cleanup(); if (restoreSource && current === session) restore(); resolve(false); } };
    a.swap = swap;
    video.addEventListener('error', failed);
    video.addEventListener('canplay', commit);
    timer = setTimeout(failed, 15000);
    setPlayerSource(link.url, session, () => {
      if (!valid() || a.swap !== swap) return;
      metadataReady = true;
      restorePlayback(snapshot);
      if (video.readyState >= 3) commit();
    });
    renderAudioControls();
  });
}

async function selectAudioTrack(index) {
  const session = current, a = session?.audio;
  if (!a || audioSuppressed() || !a.tracks.some(t => t.index === index)) return;
  cancelAudioIntent(session);
  a.error = ''; a.failed = null;
  if (index === a.actual) {
    a.userChoice = a.usingFallback || a.actual !== a.default;
    renderAudioControls(); announceAudio(T('Audio preparation cancelled.'));
    if (!a.userChoice) watchAudio(session, session);
    return;
  }
  a.intentUserChoice = a.userChoice;
  a.userChoice = true;
  const mapping = !a.usingFallback && a.sourceMatches ? nativeAudioMapping(a.tracks, video.audioTracks) : null;
  if (mapping?.has(index)) {
    const before = [...mapping].map(([, track]) => [track, track.enabled]);
    try {
      for (const [id, track] of mapping) track.enabled = id === index;
      if (mapping.get(index).enabled && [...mapping].every(([id, track]) => track.enabled === (id === index))) {
        a.actual = index; a.activeLabel = audioLabel(a, index);
        a.intentUserChoice = null;
        renderAudioControls(); announceAudio(T('{0} audio selected.', a.activeLabel)); return;
      }
    } catch { /* use the server-prepared rendition */ }
    for (const [track, enabled] of before) try { track.enabled = enabled; } catch { /* read-only implementation */ }
  }
  const generation = a.generation;
  const controller = a.abort = new AbortController();
  const valid = () => current === session && session.audio === a && a.generation === generation && !controller.signal.aborted && !audioSuppressed();
  a.pending = index;
  renderAudioControls(); announceAudio(T('Preparing {0} audio. Playback continues.', audioLabel(a, index)));
  let retry = true;
  try {
    while (valid()) {
      const link = await api(`/api/play-link?kind=${session.kind}&id=${encodeURIComponent(mediaId(session))}&variant=${browserVariant()}&audio=${index}&audioSource=${encodeURIComponent(a.source)}${retry ? '&audioRetry=1' : ''}`, { signal: controller.signal });
      if (!valid()) return;
      retry = false;
      if (!link.ready) { await audioPrepareDelay(controller.signal); continue; }
      if (link.track !== index || link.audioSource !== a.source) throw new Error(T('Audio tracks changed. Choose a track again.'));
      await switchAudioSource(session, a, generation, link, valid);
      return;
    }
  } catch (error) {
    if (!valid()) return;
    if (error.status === 409) {
      const refreshed = await refreshAudioMetadata(session);
      if (current !== session || session.audio !== a || (!refreshed && !valid())) return;
      a.error = T('Audio tracks changed. Choose a track again.'); a.failed = null;
    } else { a.error = error.message || T('Couldn’t prepare this audio.'); a.failed = index; }
    a.pending = null;
    renderAudioControls(); announceAudio(a.error);
    recoverAudioOwnership(session, a);
  }
}

// Polls the server while a corrected copy is made, then switches to it at the current position.
// Covers unplayable audio and automatic timing fixes. Explicit audio choices own the source.
async function watchAudio(f, session) {
  const token = audioWatch = {};
  let videoFixing = false;
  const note = $('#player-note');
  note.hidden = true;
  let changed = Boolean(session.compatibilityPending);
  while (current === session && audioWatch === token && !session.audio?.userChoice) {
    let a;
    try { a = await api(`/api/media/${f.kind}/${encodeURIComponent(mediaId(f))}/audio?plays=${extraPlayable()}`); } catch { return; }
    if (current !== session || audioWatch !== token || session.audio?.userChoice || !a.known) return;
    installAudioMetadata(session, a);
    const videoOk = a.videoSafe !== false;
    if (a.browserSafe && a.aligned && videoOk) {
      if (changed) switchToFixedAudio(session, videoFixing ? T('Ready to play') : T('Audio fixed'));
      else note.hidden = true;
      return;
    }
    const progress = a.job === 'converting' ? ` ${Math.floor(a.percent ?? 0)}%.` : '';
    if (!videoOk) {
      // Video this browser can't decode (e.g. HEVC labelled hev1 in Safari): a compatible copy is being made.
      videoFixing = true;
      $('#player-error').hidden = true;
      note.textContent = a.fixable
        ? T('This video is {0}, which this browser can’t play. Making a version that plays here…{1} It starts by itself when ready.', a.videoCodec, progress)
        : T('This video is {0}, which this browser can’t play. {1}', a.videoCodec, a.error ? T('Marquee couldn’t convert it: {0}', a.error) : T('It should still play on a TV.'));
      note.hidden = false;
      if (!a.fixable) return;
      changed = session.compatibilityPending = true;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!a.browserSafe && !a.fixable) {
      const name = CODEC_NAMES[a.codec] || String(a.codec).toUpperCase();
      note.textContent = T('No sound? This file’s audio is {0}, which this browser can’t play. ', name)
        + (a.error ? T('Marquee couldn’t fix it: {0}', a.error) : T('It should play with sound on a TV.'));
      note.hidden = false;
      return;
    }
    if (!a.fixable) return; // nothing Marquee can do
    if (!a.browserSafe) note.textContent = T('No sound? This file’s audio is {0}, which this browser can’t play. Adding normal stereo sound…{1} It switches over by itself.', CODEC_NAMES[a.codec] || a.codec, progress);
    else note.textContent = T('Correcting this file’s audio timing…{0} It switches over by itself.', progress);
    note.hidden = false;
    changed = session.compatibilityPending = true;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function switchToFixedAudio(session, message) {
  if (current !== session || session.audio?.userChoice || audioSuppressed()) return;
  const base = video.src.replace(/[?&]v=\d+$/, '');
  swapSource(`${base}${base.includes('?') ? '&' : '?'}v=${Date.now()}`, () => {
    if (!session.audio?.userChoice) { session.compatibilityPending = false; refreshAudioMetadata(session, true); }
  });
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
  toast(T('Tip: open Marquee from your Home Screen for fullscreen without Safari’s bar'));
});

// ---- night mode and sleep timer ----
// One "Bedtime" menu: night mode evens out the sound (player-comfort.js), and the sleep timer
// pauses after a while or at the end of what's playing, fading the sound out first.
const nightBtn = $('#night-btn');
const nightMenu = $('#night-menu');
const night = createNightAudio(video);
let nightWanted = false;
try { nightWanted = localStorage.getItem('player:night') === '1'; } catch { /* blocked */ }
let sleep = null; // { kind: 'minutes', minutes, ends } or { kind: 'episode' }
let sleepTick = null;
let sleepVolume = null; // the volume before the fade, put back once paused

// The TV plays the sound itself while casting, so night mode has nothing to work on there.
const nightAvailable = () => night.supported && !audioCasting();
const sleepAvailable = () => !party; // pausing one viewer of a Watch Together room would pause the room
const sleepEndLabel = () => (current?.episode ? T('the end of this episode') : plainMedia(current) ? T('the end of this video') : T('the end of this film'));
const sleepChoiceLabel = (m) => (m < 60 ? T('{0} minutes', m) : m % 60 ? T('{0} h {1} min', Math.floor(m / 60), m % 60) : m === 60 ? T('1 hour') : T('{0} hours', m / 60));
function closeNightMenu() { nightMenu.hidden = true; nightBtn.setAttribute('aria-expanded', 'false'); }

function renderNightMenu() {
  const chosen = !sleep ? 'off' : sleep.kind === 'episode' ? 'episode' : String(sleep.minutes);
  const choices = [['off', T('Off')], ...SLEEP_MINUTES.map((m) => [String(m), sleepChoiceLabel(m)]),
    ['episode', current?.episode ? T('End of episode') : T('When this ends')]];
  const focused = nightMenu.contains(document.activeElement) ? document.activeElement?.dataset?.choice : null;
  nightMenu.replaceChildren(...[
    h('p', { class: 'audio-title' }, T('Bedtime')),
    nightAvailable() && h('button', { type: 'button', role: 'menuitemcheckbox', class: 'cc-item night-item', tabindex: '-1',
      'data-choice': 'night', 'aria-checked': String(night.on), onclick: () => setNight(!night.on) },
    h('span', {}, T('Night mode'), h('small', {}, T('Softer loud scenes, clearer voices')))),
    sleepAvailable() && nightAvailable() && h('div', { class: 'cc-divider', role: 'separator' }),
    sleepAvailable() && h('p', { class: 'cc-nudge-label night-label' }, T('Sleep timer')),
    ...(sleepAvailable() ? choices.map(([v, label]) => h('button', { type: 'button', role: 'menuitemradio', class: 'cc-item', tabindex: '-1',
      'data-choice': v, 'aria-checked': String(chosen === v), onclick: () => setSleep(v) }, label)) : []),
    sleep && h('p', { class: 'cc-message sleep-left', role: 'status' }, sleepLabel(sleep, Date.now(), sleepEndLabel())),
  ].filter(Boolean));
  if (focused && !nightMenu.hidden) nightMenu.querySelector(`[data-choice="${focused}"]`)?.focus({ preventScroll: true });
  nightBtn.hidden = !nightAvailable() && !sleepAvailable();
  if (nightBtn.hidden) closeNightMenu();
  nightBtn.classList.toggle('is-on', night.on || Boolean(sleep));
  nightBtn.setAttribute('aria-label', [night.on && T('Night mode on'), sleep && sleepLabel(sleep, Date.now(), sleepEndLabel())].filter(Boolean).join(', ') || T('Bedtime: night mode and sleep timer (N)'));
}

// Must run from a click or key press the first time (browsers start Web Audio only from one).
function setNight(on, feedback = false) {
  if (on && !nightAvailable()) { if (feedback) osd(T('Night mode isn’t available here')); return; }
  const now = night.set(on);
  if (on && !now) toast(T('Night mode isn’t available in this browser.'));
  nightWanted = now;
  try { localStorage.setItem('player:night', now ? '1' : ''); } catch { /* blocked */ }
  if (feedback) osd(now ? T('Night mode on') : T('Night mode off'));
  renderNightMenu();
}
video.addEventListener('play', () => night.resume()); // iOS suspends the audio when the phone locks

function restoreSleepVolume() {
  if (sleepVolume != null) { video.volume = sleepVolume; sleepVolume = null; }
}
function clearSleep() {
  restoreSleepVolume();
  sleep = null;
  clearInterval(sleepTick);
  sleepTick = null;
}
function setSleep(choice) {
  clearSleep();
  if (choice !== 'off' && sleepAvailable()) sleep = sleepTimer(choice);
  if (sleep?.kind === 'minutes') sleepTick = setInterval(sleepStep, 500);
  osd(sleep ? sleepLabel(sleep, Date.now(), sleepEndLabel()) : T('Sleep timer off'));
  renderNightMenu();
  updateUpNext();
}
function sleepStep() {
  if (!sleep || sleep.kind !== 'minutes') return;
  if (!sleepAvailable()) { clearSleep(); renderNightMenu(); return; }
  const now = Date.now();
  const fade = sleepFade(sleep, now);
  if (fade < 1 && canSetVolume && !video.paused) {
    if (sleepVolume == null) sleepVolume = video.volume;
    video.volume = Math.round(sleepVolume * fade * 100) / 100;
  }
  if (sleepSecondsLeft(sleep, now) <= 0) { sleepPause(); return; }
  const left = nightMenu.querySelector('.sleep-left');
  if (left && !nightMenu.hidden) left.textContent = sleepLabel(sleep, now, sleepEndLabel());
}
function sleepPause() {
  clearSleep();
  video.pause();
  autoChain = AUTOPLAY_CHAIN; // no Next episode countdown while they sleep; a key press or tap brings it back
  osd(T('Paused by the sleep timer'));
  toast(T('Paused by the sleep timer. Press play to keep watching.'));
  renderNightMenu();
}

nightBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = nightMenu.hidden;
  closeCcMenu();
  closeAudioMenu();
  closeQualityMenu();
  renderNightMenu();
  if (nightBtn.hidden) return;
  nightMenu.hidden = !open;
  nightBtn.setAttribute('aria-expanded', String(open));
  if (open) (nightMenu.querySelector('[aria-checked="true"]') || nightMenu.querySelector('button'))?.focus();
});
nightMenu.addEventListener('keydown', (e) => {
  const items = [...nightMenu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  const target = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (index + 1) % items.length : e.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null;
  if (target != null && items.length) { e.preventDefault(); items[target].focus(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNightMenu(); nightBtn.focus(); }
});
document.addEventListener('click', (e) => { if (!nightMenu.hidden && !nightMenu.contains(e.target)) closeNightMenu(); });

// ---- quality (phones) ----
// Big files (4K, very high bitrates) stutter on phones and eat mobile data. The server can stream a
// lighter 1080p or 720p version made live from the file (HLS, phone-stream.js); the file itself stays as
// it is. Auto picks it on phones for files too heavy for one. Needs a browser that plays HLS itself
// (Safari, Chrome on Android); elsewhere the menu isn't shown and the file plays as before.
const qualityBtn = $('#quality-btn');
const qualityMenu = $('#quality-menu');
const QUALITY_PREFS = ['auto', 'original', '1080', '720'];
let qualityPref = 'auto';
try { const saved = localStorage.getItem('player:quality'); if (QUALITY_PREFS.includes(saved)) qualityPref = saved; } catch { /* blocked */ }
const playsHls = () => Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
const touchScreen = () => matchMedia('(pointer: coarse)').matches;
const phoneScreen = () => touchScreen() && Math.min(screen.width, screen.height) <= 600;
// What to ask the server for when playback starts: "auto" only means something on a phone.
function wantedQuality() {
  if (!playsHls()) return 'original';
  if (qualityPref === 'auto') return phoneScreen() ? 'auto' : 'original';
  return qualityPref;
}
const qualityAvailable = (session = current) => Boolean(session && !plainMedia(session) && playsHls() && touchScreen() && !audioCasting());
const heightName = (h) => (!h ? '' : h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : 'SD');
function closeQualityMenu() { qualityMenu.hidden = true; qualityBtn.setAttribute('aria-expanded', 'false'); }

function renderQualityMenu() {
  const session = current;
  // Versions of this film or episode (src/versions.js): shown on every screen, above the phone streams.
  const vers = session && !plainMedia(session) && session.versions?.length > 1 ? session.versions : null;
  const stream = qualityAvailable(session);
  qualityBtn.hidden = !stream && !vers;
  if (qualityBtn.hidden) { closeQualityMenu(); return; }
  const phone = stream ? phoneQuality(session) : null;
  const source = heightName(session.sourceHeight);
  const playing = phone ? T('{0}p, made live from the {1} file', phone, source || 'original') : T('Original{0}', source ? ` (${source})` : '');
  const choices = [
    ['auto', T('Auto'), phoneScreen() ? T('Lighter stream when a file is too big for a phone') : T('The original file on this screen')],
    ['original', T('Original'), T('Full quality, the file as it is')],
    ['1080', '1080p', T('Smooth on phones and mobile data')],
    ['720', '720p', T('Data saver')],
  ];
  const focused = qualityMenu.contains(document.activeElement) ? document.activeElement?.dataset?.choice : null;
  const versionItems = vers ? [
    h('p', { class: 'audio-title' }, T('Version')),
    ...vers.map((v) => {
      const [main, ...rest] = v.versionLabel.split(' · ');
      const size = /\d (GB|MB)$/.test(rest.at(-1) || '') ? rest.pop() : '';
      return h('button', { type: 'button', role: 'menuitemradio', class: 'cc-item night-item', tabindex: '-1',
        'data-choice': `v:${v.mediaKey}`, 'aria-checked': String(v.mediaKey === session.mediaKey), onclick: () => switchVersion(v) },
      h('span', {}, [main, ...rest].join(' · '), size && h('small', {}, size)));
    }),
  ] : [];
  qualityMenu.replaceChildren(
    ...versionItems,
    ...(stream ? [
      h('p', { class: 'audio-title' }, vers ? T('Stream') : T('Quality')),
      ...choices.map(([v, label, note]) => h('button', { type: 'button', role: 'menuitemradio', class: 'cc-item night-item', tabindex: '-1',
        'data-choice': v, 'aria-checked': String(qualityPref === v), onclick: () => setQuality(v) },
      h('span', {}, label, h('small', {}, note)))),
    ] : []),
    h('p', { class: 'cc-message', role: 'status' }, session.qualityBusy ? T('Switching…') : vers && !stream ? T('Playing: {0}', session.versionLabel) : T('Playing: {0}', playing)),
  );
  if (focused && !qualityMenu.hidden) qualityMenu.querySelector(`[data-choice="${focused}"]`)?.focus({ preventScroll: true });
  const badge = $('#quality-badge');
  const height = session.sourceHeight || ({ '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, SD: 480 }[session.versionQuality] || 0);
  badge.textContent = phone || (height >= 2000 ? '4K' : height && height < 700 ? T('SD') : T('HD'));
  badge.style.fontSize = badge.textContent.length > 3 ? '6px' : '';
  qualityBtn.classList.toggle('is-on', Boolean(phone));
  qualityBtn.setAttribute('aria-label', T('Quality: {0}', vers && !stream ? session.versionLabel : playing));
}

// Another version of what's playing: remembered for this title, and playback carries on at the same spot.
async function switchVersion(v) {
  const session = current;
  closeQualityMenu();
  if (!session || v.mediaKey === session.mediaKey) return;
  if (party) { toast(T('Pick the version before starting Watch Together.')); return; }
  if (audioCasting()) { toast(T('Stop casting to switch versions.')); return; }
  if (v.converting) { toast(T('That version is being converted. Try again when it finishes.')); return; }
  const at = video.currentTime || 0;
  setVersionPick(session, v);
  saveProgress(true);
  await loadPlayerMedia(libraryFile({ ...v, versions: session.versions }), { startAt: at });
  osd(v.versionLabel.replace(/ · [\d.]+ [GM]B$/, ''));
}

// Saves the choice for next time and switches the playing video over at the same spot.
async function setQuality(pref) {
  if (!QUALITY_PREFS.includes(pref)) return;
  qualityPref = pref;
  try { localStorage.setItem('player:quality', pref); } catch { /* blocked */ }
  const session = current;
  if (!session || !qualityAvailable(session)) { renderQualityMenu(); return; }
  session.qualityBusy = true;
  renderQualityMenu();
  try {
    const link = await api(party ? `${party.base}/play-link?clientId=${encodeURIComponent(watchClient)}&variant=${baseVariant()}&quality=${wantedQuality()}`
      : `/api/play-link?kind=${session.kind}&id=${encodeURIComponent(mediaId(session))}&variant=${baseVariant()}&quality=${wantedQuality()}`, { signal: session.abort.signal });
    if (current !== session) return;
    session.sourceHeight = link.sourceHeight || session.sourceHeight;
    if ((link.quality || 'original') === (session.quality || 'original')) return;
    // The audio choices belong to the file being streamed: start over with its default track.
    resetAudioSelection(session);
    session.audio = null;
    session.quality = link.quality || 'original';
    session.browserName = link.name;
    swapSource(link.url, () => watchAudio(session, session));
    osd(phoneQuality(session) ? `${session.quality}p` : T('Original quality'));
  } catch (error) {
    if (current === session && error.name !== 'AbortError') toast(error.message || T('Couldn’t change the quality.'));
  } finally {
    if (current === session) { session.qualityBusy = false; renderQualityMenu(); }
  }
}

qualityBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = qualityMenu.hidden;
  closeCcMenu();
  closeAudioMenu();
  closeNightMenu();
  renderQualityMenu();
  if (qualityBtn.hidden) return;
  qualityMenu.hidden = !open;
  qualityBtn.setAttribute('aria-expanded', String(open));
  if (open) (qualityMenu.querySelector('[aria-checked="true"]') || qualityMenu.querySelector('button'))?.focus();
});
qualityMenu.addEventListener('keydown', (e) => {
  const items = [...qualityMenu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  const target = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (index + 1) % items.length : e.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null;
  if (target != null && items.length) { e.preventDefault(); items[target].focus(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQualityMenu(); qualityBtn.focus(); }
});
document.addEventListener('click', (e) => { if (!qualityMenu.hidden && !qualityMenu.contains(e.target)) closeQualityMenu(); });

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
// The frame at the hovered time sits in the tip (seek-preview.js); a sheet arriving late re-places it.
let seekTipX = null;
const seekPreview = createSeekPreview(seekTip, () => { if (!seekTip.hidden && seekTipX != null) showSeekTip(seekTipX); });
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

const menuOpen = () => !ccMenu.hidden || !audioMenu.hidden || !nightMenu.hidden || !qualityMenu.hidden || !helpEl.hidden || (watchPanelOpen && !roomDocked());
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
playerEl.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && !(roomDocked() && e.target.closest?.('#watch-bar'))) showPlayerUi(); });
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
  osdEl.classList.toggle('is-icon', typeof content !== 'string');
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
    b.setAttribute('aria-label', party?.blocked ? T('Join playback (Space)') : playing ? T('Pause (Space)') : T('Play (Space)'));
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
  updateUpNext();
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
  durEl.title = showRemaining ? T('Show duration') : T('Show time remaining');
  updateTime();
});

const seekTimeAt = (x) => {
  const r = seekEl.getBoundingClientRect();
  return Math.min(Math.max((x - r.left) / r.width, 0), 1) * (video.duration || 0);
};
function showSeekTip(x) {
  seekTipX = x;
  const r = seekEl.getBoundingClientRect();
  const t = seekTimeAt(x);
  seekPreview.show(t, fmtTime(t));
  seekTip.hidden = false;
  seekPreview.place(x - r.left, r.width);
}
seekEl.addEventListener('pointerdown', (e) => {
  if (party && !party.isHost) { toast(T('The host controls seeking')); return; }
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
  muteBtn.setAttribute('aria-label', video.muted ? T('Unmute (M)') : T('Mute (M)'));
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
  osd(video.muted ? T('Muted') : T('Volume {0}%', Math.round(video.volume * 100)));
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
  fsBtn.setAttribute('aria-label', on ? T('Exit fullscreen (F)') : T('Fullscreen (F)'));
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
// Size, background and position are kept on this device (player-comfort.js): a phone and a TV
// usually want different ones.
let look = subLook();
try { look = subLook({ size: localStorage.getItem('subs:size'), background: localStorage.getItem('subs:look'), position: localStorage.getItem('subs:position') }); } catch { /* blocked */ }
function applySubLook() {
  for (const [v] of SUB_BACKGROUNDS) subsEl.classList.toggle(`look-${v}`, look.background === v);
}
applySubLook();

function layoutSubs() {
  if (playerEl.hidden) return;
  const box = stage.getBoundingClientRect();
  const seekTop = seekRow.getBoundingClientRect().top;
  if (!upNextEl.hidden || !skipIntroEl.hidden) {
    playerEl.style.setProperty('--up-next-bottom', `${Math.max(16, playerEl.getBoundingClientRect().bottom - seekTop + 12)}px`);
  }
  const overlay = !upNextEl.hidden ? upNextEl : !skipIntroEl.hidden ? skipIntroEl : null;
  const subtitleBottom = overlay ? Math.min(seekTop - 10, overlay.getBoundingClientRect().top - 10) : seekTop - 10;
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
  const below = subtitleBottom - (top + height);
  const sizeOver = Math.min(Math.max(height * 0.05, 15), 52) * look.size; // ~1/20 of the picture's height
  const sizeUnder = Math.min(Math.max(width * 0.045, 15), 26) * look.size;
  const outside = below >= sizeUnder * 1.45 * 3 + sizeUnder; // three lines and a gap
  subsEl.classList.toggle('subs-below', outside);
  Object.assign(subsEl.style, {
    left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${width}px`, height: `${height}px`,
    fontSize: `${outside ? sizeUnder : sizeOver}px`,
  });
  // Under the picture there's nothing to clear, so the position choice applies over it only.
  const raise = outside ? 0 : height * subRaise(look.position);
  subsEl.style.setProperty('--raise', `${raise}px`);
  let lift = 0;
  let drop = 0;
  if (playerEl.classList.contains('ui-visible') || !upNextEl.hidden) {
    const gap = height * 0.05;
    lift = Math.max(0, top + height - gap - raise - subtitleBottom);
    if (playerEl.classList.contains('ui-visible')) drop = Math.max(0, $('#player-close').getBoundingClientRect().bottom + 10 - (top + gap));
  }
  subsEl.style.setProperty('--lift', `${lift}px`);
  subsEl.style.setProperty('--drop', `${drop}px`);
}
const playerResize = new ResizeObserver(layoutSubs);
playerResize.observe(stage);
playerResize.observe(controlsEl);
video.addEventListener('loadedmetadata', layoutSubs);

const LOOK_KEYS = { size: 'subs:size', background: 'subs:look', position: 'subs:position' };
function setSubLook(key, v) {
  look = subLook({ ...look, [key]: v });
  try { localStorage.setItem(LOOK_KEYS[key], String(v)); } catch { /* blocked */ }
  ccMenu.querySelectorAll(`[data-look="${key}"] button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(look[key]))));
  applySubLook();
  layoutSubs();
}
// One line each: a label, then the choices side by side.
function subLookRows() {
  const row = (key, label, options) => h('div', { class: 'cc-row', role: 'group', 'aria-label': T('Subtitle {0}', label.toLowerCase()), 'data-look': key },
    h('span', { class: 'cc-nudge-label' }, label),
    h('div', { class: 'cc-choices' }, options.map(([text, v, name]) => h('button', {
      type: 'button', 'data-value': String(v), 'aria-label': name || text, 'aria-pressed': String(String(look[key]) === String(v)),
      onclick: () => setSubLook(key, v),
    }, text))));
  return [
    row('size', T('Size'), SUB_SIZES.map(([text, v, name]) => [text, v, T('{0} subtitles', name)])),
    row('background', T('Style'), SUB_BACKGROUNDS.map(([v, text]) => [text, v, T('{0} behind subtitles', text)])),
    row('position', T('Height'), SUB_POSITIONS.map(([v, text]) => [text, v, T('Subtitles {0} on the picture', text.toLowerCase())])),
  ];
}

// C turns subtitles off, or back on in the language used last (with its second language).
let lastSubLang = null;
let lastSecondLang = null;
async function toggleSubs() {
  if (!current || ccBtn.hidden) return;
  if (ccActive) {
    lastSubLang = ccActive;
    lastSecondLang = ccSecond;
    pickPlayerSub(current, current, { code: null, name: T('Off') }, { quiet: true });
    osd(T('Subtitles off'));
    return;
  }
  let pref = lastSubLang;
  try { pref ||= localStorage.getItem('subs:lang'); } catch { /* blocked */ }
  const l = ccLangs.find((x) => x.code === pref) || ccLangs.find((x) => x.saved) || ccLangs[0];
  if (!l) return;
  const session = current;
  await pickPlayerSub(session, session, l);
  const second = lastSecondLang && ccActive && secondChoices(ccLangs, ccActive).find((x) => x.code === lastSecondLang);
  if (second && current === session) pickSecondSub(session, session, second, { quiet: true });
}

// ---- keyboard ----
const SHORTCUTS = [
  [T('Space or K'), T('Play or pause')],
  ['← →', T('Back or forward 5 s')],
  ['J L', T('Back or forward 10 s')],
  ['↑ ↓', T('Volume')],
  ['M', T('Mute')],
  ['F', T('Fullscreen')],
  ['C', T('Subtitles on or off')],
  ['N', T('Night mode')],
  ['S', T('Skip intro (while it shows)')],
  ['P', T('Picture in picture')],
  [T('I or right-click'), T('Stats for nerds')],
  ['0 – 9', T('Jump to 0% – 90%')],
  ['?', T('These shortcuts')],
];
function toggleHelp() {
  if (helpEl.hidden) {
    helpEl.replaceChildren(
      h('p', { class: 'help-title' }, T('Keyboard shortcuts')),
      h('dl', {}, SHORTCUTS.filter(([keys]) => keys !== 'C' || !plainMedia(current)).map(([keys, what]) => h('div', {}, h('dt', {}, keys), h('dd', {}, what)))));
  }
  helpEl.hidden = !helpEl.hidden;
}
document.addEventListener('click', (e) => { if (!helpEl.hidden && !helpEl.contains(e.target)) helpEl.hidden = true; });

// Stats for nerds (I, or right-click / long-press on the picture): see player-stats.js.
const signed = (n) => `${n > 0 ? '+' : ''}${Number(n.toFixed(3))} s`;
const streamStats = createStreamStats({
  video, host: playerEl, api,
  context: () => {
    const session = current;
    const lang = ccLangs.find((l) => l.code === ccActive);
    const timing = ccSync && [ccSync.state, ccSync.offset ? T('fixed {0}', signed(ccSync.offset)) : '', ccSync.manual ? T('nudged {0}', signed(ccSync.manual)) : '',
      party?.offsets?.[ccActive] ? T('room {0}', signed(party.offsets[ccActive])) : ''].filter(Boolean).join(', ');
    return {
      title: $('#player-title').textContent,
      delivery: session?.kind === 'clip' ? T('Clip · direct play') : session?.kind === 'note' ? T('Note video · direct play') : '',
      audio: session?.audio?.activeLabel || '',
      subtitles: lang ? `${lang.name || lang.code}${lang.saved ? T(' · saved on the server') : ''}${nativeSubs ? T(' · drawn by the browser') : ''}${timing ? T(' · timing {0}', timing) : ''}` : '',
      party: party ? [party.isHost ? 'host' : 'guest', party.connected ? 'connected' : 'reconnecting', T('clock {0} ms off', Math.round(party.clockOffset)),
        T('rtt {0} ms', Math.round(party.rtt)), $('#watch-members').textContent].filter(Boolean).join(' · ') : '',
      casting: onTvVersion ? T('AirPlay · TV version') : video.webkitCurrentPlaybackTargetIsWireless ? 'AirPlay'
        : video.remote?.state === 'connected' ? T('Remote playback') : document.pictureInPictureElement === video ? T('Picture in picture') : '',
    };
  },
});
stage.addEventListener('contextmenu', (e) => { e.preventDefault(); streamStats.toggle(); });

const seekToFraction = (f) => {
  if (!isFinite(video.duration)) return;
  if (party) party.control('seek', video.duration * f);
  else { video.currentTime = video.duration * f; updateTime(); }
};
const nudgeVolume = (d) => {
  if (!canSetVolume) return;
  setVolume((video.muted ? 0 : video.volume) + d);
  osd(T('Volume {0}%', Math.round(video.volume * 100)));
};
const PLAYER_KEYS = {
  ' ': () => togglePlay(true), k: () => togglePlay(true),
  ArrowLeft: () => skip(-5), ArrowRight: () => skip(5), j: () => skip(-10), l: () => skip(10),
  ArrowUp: () => nudgeVolume(0.05), ArrowDown: () => nudgeVolume(-0.05),
  m: toggleMute, f: toggleFullscreen, c: toggleSubs, p: togglePip, '?': toggleHelp, i: () => streamStats.toggle(),
  n: () => setNight(!night.on, true), s: () => { if (!skipIntroEl.hidden) skipIntro(); },
  Home: () => seekToFraction(0), End: () => seekToFraction(0.999),
};
// Keys typed into a menu or a text field are left alone.
const playerKeyTarget = (e) => !playerEl.hidden && !e.ctrlKey && !e.metaKey && !e.altKey
  && !e.target.closest?.('.cc-menu, #up-next, #watch-bar') && !e.target.matches?.('input:not([type="range"]), textarea, select');
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

// Save and pause the old file before installing a new identity. This runs for both ordinary
// closes and Next episode, which keeps the same overlay, fullscreen element and history entry.
function resetPlayerMedia() {
  saveProgress(true);
  playedSince = 0; playTick = null;
  seekPreview.load(null);
  const old = current;
  resetAudioSelection(old);
  current = null;
  old?.abort?.abort();
  old?.nextAbort?.abort();
  leaveWatchRoom();
  video.pause();
  if (sourceMetadataHandler) video.removeEventListener('loadedmetadata', sourceMetadataHandler);
  sourceMetadataHandler = null;
  resetCasting();
  clearSubTracks();
  ccLangs = [];
  closeCcMenu();
  ccBtn.hidden = true;
  closeAudioMenu();
  audioBtn.hidden = true;
  closeNightMenu();
  closeQualityMenu();
  qualityBtn.hidden = true;
  helpEl.hidden = true;
  endSeek(false);
  audioWatch = null;
  lastSave = lastPush = 0;
  lastTap = { at: 0, side: 0, uiWas: false, skipped: false };
  skipTotal = skipAt = 0;
  clearTimeout(osdTimer);
  osdEl.classList.remove('show');
  $('#player-note').hidden = true;
  $('#player-error').hidden = true;
  setSpinner(false);
  video.removeAttribute('src');
  video.load();
  updateUpNext();
}

async function preparePlayerSource(f, watchSession, signal) {
  const ask = `variant=${baseVariant()}&quality=${wantedQuality()}`;
  const link = await api(watchSession ? `${watchSession.base}/play-link?clientId=${encodeURIComponent(watchClient)}&${ask}`
    : `/api/play-link?kind=${f.kind}&id=${encodeURIComponent(mediaId(f))}&${ask}`, { signal });
  const response = await fetch(link.url, { headers: { Range: 'bytes=0-0' }, signal });
  if (!response.ok) {
    let message = T('The server responded with {0}.', response.status);
    try { message = (await response.json()).error || message; } catch { /* keep default */ }
    throw new Error(message);
  }
  response.body?.cancel()?.catch(() => {});
  return link;
}

// Player heading: the TMDB show name, then the episode spelled out with its TMDB title,
// e.g. "House · Season 3, Episode 2: Cane & Able". Films and clips keep their own title.
function playerEpisodeText(f) {
  if (f.season == null) return '';
  if (f.episode == null) return T('Season {0}', f.season);
  const eps = f.episodeEnd != null && f.episodeEnd > f.episode ? T('Episodes {0}–{1}', f.episode, f.episodeEnd) : T('Episode {0}', f.episode);
  return T('Season {0}, {1}{2}', f.season, eps, f.episodeName ? `: ${f.episodeName}` : '');
}
function setPlayerTitle(f) {
  const show = f.show != null ? state.libraryShows.find((s) => s.id === f.show) : null;
  const name = show?.title || f.filmTitle || f.title || '';
  const episode = playerEpisodeText(f);
  $('#player-title').replaceChildren(name, ...(episode ? [h('span', { class: 'player-episode' }, `${name ? ' \u00b7 ' : ''}${episode}`)] : []));
  $('#player-title').title = $('#player-title').textContent;
}

async function loadPlayerMedia(f, opts = {}) {
  resetPlayerMedia();
  const session = current = { ...f, ready: false, abort: new AbortController(), creditsAt: null, intro: null, introDone: false,
    upNextDismissed: false, upNextBusy: false, upNextError: '', upNextAnnounced: null, autoLeft: null, autoTimer: null };
  const err = $('#player-error');
  setPlayerTitle(f);
  playerEl.classList.toggle('is-clip', plainMedia(f));
  updatePlayState();
  updateTime();
  showPlayerUi();
  setSpinner(true);
  renderNightMenu();
  // Clips use the same player without what only library media has: subtitles, audio choices,
  // casting, Watch Together, Up next and resume points. They play straight from the clips folder.
  if (f.kind === 'clip') {
    renderParty();
    const clipBase = `/api/clips/${encodeURIComponent(f.id)}/preview`;
    seekPreview.load({ indexUrl: clipBase, sheetUrl: (n, key) => `${clipBase}/${n}.jpg?k=${key}` });
    setPlayerSource(`/api/clips/${encodeURIComponent(f.id)}/video`, session);
    video.play().catch(() => { /* autoplay blocked: the controls are there */ });
    return;
  }
  // A video attached to a note: streamed from the notes store (byte ranges), no timeline previews.
  if (f.kind === 'note') {
    renderParty();
    seekPreview.load(null);
    setPlayerSource(`/api/admin/notes/files/${encodeURIComponent(f.id)}?view=1`, session);
    video.play().catch(() => { /* autoplay blocked: the controls are there */ });
    return;
  }
  const watchSession = opts.watchRoom ? attachWatchRoom(opts.watchRoom) : null;
  renderParty();
  // Intro and credits lookups are optional and never delay playback. The intro is needed first, and
  // both share the server's one-at-a-time audio decoding, so the credits are asked for after it.
  loadPlayerIntro(session).finally(() => loadPlayerCredits(session));
  // Asking for the timeline previews early lets the server make them while the video plays.
  const previewBase = `/api/media/${session.kind}/${encodeURIComponent(mediaId(session))}/preview`;
  seekPreview.load({ indexUrl: previewBase, sheetUrl: (n, key) => `${previewBase}/${n}.jpg?k=${key}` });
  let link;
  try { link = opts.prepared || await preparePlayerSource(f, watchSession, session.abort.signal); }
  catch (error) {
    if (current !== session) return;
    if (party === watchSession && watchSession) leaveWatchRoom();
    setSpinner(false);
    err.textContent = error.message;
    err.hidden = false;
    return;
  }
  if (current !== session) return;
  session.browserName = link.name;
  session.quality = link.quality || 'original';
  session.sourceHeight = link.sourceHeight || null;
  renderQualityMenu();
  setPlayerSource(link.url, session, () => {
    if (party) { party.sync(); return; }
    if (opts.startAt > 0) { video.currentTime = Math.min(opts.startAt, Math.max(0, video.duration - 1)); return; } // a version switch
    const saved = savedProgress(session);
    if (saved && saved.time > 30 && saved.time < video.duration - 90) {
      video.currentTime = saved.time;
      toast(T('Resuming at {0}', fmtTime(saved.time)));
    }
  });
  if (!party) watchCastTargets();
  if (opts.castHint && canCastFromBrowser) {
    const note = $('#player-note');
    note.textContent = hasAirPlay
      ? T('Tap the AirPlay button in the controls below to pick a TV. No button means there’s no AirPlay TV on this network.')
      : T('Tap the cast button in the controls below to pick a TV. No button means there’s no Chromecast on this network.');
    note.hidden = false;
    airplayBtn.classList.add('is-hint');
  }
  setupPlayerSubs(f, session);
  watchAudio(f, session);
  if (watchSession) {
    try { await watchSession.start(); }
    catch (error) { if (current === session && party === watchSession) { leaveWatchRoom(); video.pause(); err.textContent = error.message; err.hidden = false; } }
  } else video.play().catch(() => { /* autoplay blocked: the controls are there */ });
}

async function openPlayer(f, opts = {}) {
  const opener = document.activeElement;
  (opts.replace ? swapTopOverlay : pushOverlay)(() => {
    resetPlayerMedia();
    clearSleep();
    setTheme(pageThemeColor);
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    playerEl.hidden = true;
    streamStats.close();
    document.body.style.overflow = '';
    document.body.classList.remove('in-player');
    opener?.focus?.({ preventScroll: true });
    if (state.view === 'library') { libraryRenderPending = true; renderUpdatedLibrary(); }
  });
  playerEl.hidden = false;
  document.body.style.overflow = 'hidden';
  document.body.classList.add('in-player');
  setTheme('#000000');
  $('#player-close').focus({ preventScroll: true });
  if (nightWanted && !night.on && nightAvailable()) night.set(true); // opening the player is a click
  return loadPlayerMedia(f, opts);
}

// ---- Up next ----
const upNextEl = $('#up-next');
const upNextTitle = $('#up-next-title');
const upNextArt = $('#up-next-art');
const upNextPlay = $('#up-next-play');
const upNextDismiss = $('#up-next-dismiss');
const upNextError = $('#up-next-error');
const upNextStatus = $('#up-next-status');
let upNextLayoutSignature = '';
let autoChain = 0; // episodes started by the countdown since the last key press, click or tap

// ---- skip intro ----
// The opening titles come from the server (credits.js): a chapter, or the theme song shared with the
// season's other episodes. The button shows while they play; Settings → Intros can skip them on its own,
// once per playback, so seeking back to watch the intro is left alone. In Watch Together only the
// host can seek, so only the host gets the button, and nothing skips on its own.
const skipIntroEl = $('#skip-intro');
async function loadPlayerIntro(session) {
  try {
    const data = await api(`/api/media/${session.kind}/${encodeURIComponent(mediaId(session))}/intro`, { signal: session.abort.signal });
    if (current !== session) return;
    const start = Number(data.intro?.start), end = Number(data.intro?.end);
    session.intro = Number.isFinite(start) && Number.isFinite(end) && end - start >= 5 ? { start, end } : null;
    updateSkipIntro();
  } catch { /* No known intro: no button. */ }
}
function introShowing(session = current) {
  const intro = session?.intro;
  if (!intro || !session.ready || (party && !party.isHost) || seeking != null || video.ended) return false;
  const t = video.currentTime;
  return t >= intro.start - 0.25 && t < intro.end - 1;
}
function updateSkipIntro() {
  const session = current;
  const show = introShowing(session);
  if (show && prefs().skipIntro === 'auto' && !party && !session.introDone && !video.paused && !video.seeking) {
    skipIntro(true);
    return;
  }
  if (skipIntroEl.hidden === !show) return;
  skipIntroEl.hidden = !show;
  playerEl.classList.toggle('has-skip-intro', show);
  layoutSubs();
}
function skipIntro(auto = false) {
  const session = current;
  if (!introShowing(session)) return;
  session.introDone = true;
  if (party) party.control('seek', session.intro.end);
  else { video.currentTime = session.intro.end; updateTime(); }
  osd(auto ? T('Intro skipped') : T('Skipped the intro'));
  updateSkipIntro();
}
skipIntroEl.addEventListener('click', (e) => { e.stopPropagation(); skipIntro(); });
for (const event of ['timeupdate', 'seeking', 'seeked', 'play', 'ended', 'emptied']) video.addEventListener(event, updateSkipIntro);

async function loadPlayerCredits(session) {
  try {
    const data = await api(`/api/media/${session.kind}/${encodeURIComponent(mediaId(session))}/credits`, { signal: session.abort.signal });
    if (current !== session) return;
    session.creditsAt = Number.isFinite(data.creditsAt) && data.creditsAt > 0 ? data.creditsAt : null;
    updateUpNext();
  } catch { /* Unknown credits start: Up next waits for the end of the file. */ }
}

function updateUpNext() {
  const session = current;
  // "End of episode" on the sleep timer: pause where Up next would start (the credits, or the end).
  if (sleep?.kind === 'episode' && session?.ready && !party && seeking == null && !video.seeking
    && isNextEpisodeTime({ ended: video.ended, time: video.currentTime, duration: video.duration, creditsAt: session.creditsAt })) sleepPause();
  const next = session && nextLibraryEpisode(session, state.library, state.libraryShows);
  const externalPlayer = nativeSubs || video.webkitDisplayingFullscreen || document.pictureInPictureElement === video
    || video.webkitCurrentPlaybackTargetIsWireless || video.remote?.state === 'connected' || onTvVersion;
  const show = Boolean(session?.ready && next && !party && !session.upNextDismissed && !externalPlayer && seeking == null && !video.seeking
    && isNextEpisodeTime({ ended: video.ended, time: video.currentTime, duration: video.duration, creditsAt: session.creditsAt }));
  upNextEl.hidden = !show;
  playerEl.classList.toggle('has-up-next', show);
  // The countdown starts the moment the card does: at the credits, or at the end of the file.
  const counting = show && !session.upNextBusy && !session.upNextError && autoChain < AUTOPLAY_CHAIN;
  if (counting && session.autoLeft == null) startAutoplay(session);
  else if (!counting && session) stopAutoplay(session);
  if (show) {
    const title = [episodeLabel(next), next.episodeName || next.title].filter(Boolean).join(' · ');
    if (upNextTitle.textContent !== title) upNextTitle.textContent = title;
    if (upNextArt.dataset.for !== next.id) {
      upNextArt.dataset.for = next.id;
      upNextArt.replaceChildren(episodeArt(next.still, state.libraryShows.find((s) => s.id === next.show)));
    }
    upNextPlay.disabled = session.upNextBusy;
    const left = session.autoLeft == null ? null : Math.max(1, Math.ceil(session.autoLeft));
    const label = session.upNextBusy ? T('Starting…') : left ? T('Next episode in {0}', left) : T('Next episode');
    if (upNextPlay.textContent !== label) upNextPlay.textContent = label;
    upNextPlay.classList.toggle('counting', left != null);
    upNextPlay.style.setProperty('--auto-progress', left == null ? '0' : String(1 - session.autoLeft / AUTOPLAY_SECONDS));
    upNextPlay.setAttribute('aria-busy', String(session.upNextBusy));
    upNextDismiss.textContent = video.ended ? T('Dismiss') : T('Keep watching');
    upNextError.textContent = session.upNextError;
    upNextError.hidden = !session.upNextError;
    if (session.upNextAnnounced !== next.id) {
      session.upNextAnnounced = next.id;
      upNextStatus.textContent = session.autoLeft == null ? T('Up next: {0}. Next episode is available.', title)
        : T('Up next: {0}. Plays in {1} seconds unless you choose Keep watching.', title, AUTOPLAY_SECONDS);
    }
  } else if (!session) upNextStatus.textContent = '';
  const signature = show ? `${next.id}|${video.ended}|${session.upNextBusy}|${session.upNextError}` : '';
  if (signature !== upNextLayoutSignature) { upNextLayoutSignature = signature; layoutSubs(); }
}

// Counts real seconds while the credits play (or after the end); a pause during the credits pauses it.
function startAutoplay(session) {
  session.autoLeft = AUTOPLAY_SECONDS;
  let last = Date.now();
  const tick = () => {
    if (current !== session || session.autoLeft == null) return;
    const now = Date.now();
    if (!video.paused || video.ended) session.autoLeft -= (now - last) / 1000;
    last = now;
    if (session.autoLeft <= 0) {
      session.autoLeft = null; session.autoTimer = null;
      autoChain++;
      playNextEpisode();
      return;
    }
    session.autoTimer = setTimeout(tick, 250);
    updateUpNext();
  };
  session.autoTimer = setTimeout(tick, 250);
}
function stopAutoplay(session) {
  if (session.autoTimer) clearTimeout(session.autoTimer);
  session.autoTimer = null; session.autoLeft = null;
}

async function playNextEpisode() {
  const session = current;
  if (!session || session.upNextBusy || party || session.upNextDismissed) return;
  const next = nextLibraryEpisode(session, state.library, state.libraryShows);
  if (!next) { updateUpNext(); return; }
  session.upNextBusy = true; // synchronous, including a second click before the first await
  session.upNextError = '';
  updateUpNext();
  video.pause();
  saveProgress(true);
  session.nextAbort = new AbortController();
  const timeout = setTimeout(() => session.nextAbort?.abort(), 15000);
  try {
    // Keep the paused current file available if signing or checking the next stream fails.
    const file = libraryFile(next);
    const prepared = await preparePlayerSource(file, null, session.nextAbort.signal);
    if (current !== session || party || session.upNextDismissed) return;
    const stillNext = nextLibraryEpisode(session, state.library, state.libraryShows);
    if (stillNext?.id !== next.id) throw new Error(T('This episode is no longer available. Try again after the library updates.'));
    await loadPlayerMedia(file, { prepared });
  } catch (error) {
    if (current !== session || session.upNextDismissed) return;
    session.upNextError = error.name === 'AbortError' ? T('Starting took too long. Try Next episode again.') : T('{0} Try Next episode again.', error.message);
    upNextStatus.textContent = session.upNextError;
  } finally {
    clearTimeout(timeout);
    if (current === session) { session.upNextBusy = false; session.nextAbort = null; updateUpNext(); }
  }
}
upNextPlay.addEventListener('click', playNextEpisode);
upNextDismiss.addEventListener('click', () => {
  if (!current) return;
  current.upNextDismissed = true;
  current.nextAbort?.abort();
  updateUpNext();
});
for (const event of ['timeupdate', 'ended', 'seeking', 'seeked', 'durationchange', 'loadedmetadata',
  'webkitbeginfullscreen', 'webkitendfullscreen', 'enterpictureinpicture', 'leavepictureinpicture',
  'webkitcurrentplaybacktargetiswirelesschanged']) video.addEventListener(event, updateUpNext);
if (hasRemotePlayback) for (const event of ['connect', 'disconnect']) video.remote.addEventListener(event, updateUpNext);

video.addEventListener('timeupdate', () => saveProgress());
for (const event of ['seeking', 'waiting']) video.addEventListener(event, () => { countPlayed(); playTick = null; });
// Someone is still there: the countdown may chain another AUTOPLAY_CHAIN episodes.
for (const event of ['keydown', 'pointerdown']) document.addEventListener(event, () => { autoChain = 0; }, true);
video.addEventListener('pause', () => saveProgress(true));
video.addEventListener('error', () => {
  if (!current?.sourceUrl || video.currentSrc !== current.sourceUrl) return;
  const err = $('#player-error');
  err.textContent = current.kind === 'note'
    ? T('This video can’t play in this browser. Its format isn’t supported here; open the file link under the video to download it, or try another browser.')
    : current.kind === 'clip'
    ? T('This clip can’t play in this browser. Its video format (often AV1) isn’t supported here; try another browser, or share it to get a copy that plays everywhere.')
    : T('This video can’t play in this browser yet. Marquee makes a version that plays here automatically; you can follow its progress in the Library tab.');
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
const PLACEHOLDERS = { discover: T('Search films and shows'), library: T('Filter your library'), downloads: T('Filter downloads'), activity: T('Filter by person or title'), house: T('Filter machines'), clips: T('Filter by game or name'), settings: T('Search films and shows'), notes: T('Search notes by keyword') };
const notesView = createNotesView({ h, icon, api, jsonPost, toast, copyText, query: () => state.query,
  playVideo: (a) => openPlayer({ kind: 'note', id: a.fileId, key: `note:${a.fileId}`, title: a.name }),
  overlay: { push: pushOverlay, close: closeTopOverlay },
  clearQuery: () => { input.value = state.query = ''; $('#q-clear').hidden = true; } });

function renderView() {
  if (state.view === 'discover') renderDiscover();
  if (state.view === 'library') renderLibrary();
  if (state.view === 'downloads') renderDownloads();
  if (state.view === 'activity') renderActivity();
  if (state.view === 'house') renderHouse();
  if (state.view === 'clips') renderClips();
  if (state.view === 'settings') renderSettings();
  if (state.view === 'notes') notesView.render();
}

// ---------- settings ----------
// Everyone: name, colours (a preset or their own four), and how Marquee behaves for them. The owner
// also gets the server's rules (auto-delete) and the people who use it. Changes save straight away.
let saveMeTimer = null;
// Profile pictures: yours (person = state.me) or, for the owner, anyone's in People (person.id).
function editPicture({ person, opener }) {
  const mine = person.id === state.me?.id;
  people.choosePhoto(async (file) => {
    let body;
    try {
      body = await people.editor({ file, title: mine ? T('Your picture') : T('{0}’s picture', person.name),
        upload: async (blob) => {
          if (mine) state.me = (await people.saveMine(blob)).me;
          else await people.saveFor(person.id, blob);
        },
        done: () => closeTopOverlay(),
      });
    } catch (err) { toast(err.message); return; }
    $('#picker-body').replaceChildren(...body);
    pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), async () => {
      if (!mine && state.me?.isOwner) await loadPeople();
      if (state.view === 'settings') renderSettings();
      opener?.isConnected && opener.focus({ preventScroll: true });
    }));
  });
}
async function removePicture({ person }) {
  const mine = person.id === state.me?.id;
  try {
    if (mine) state.me = (await people.saveMine(null)).me;
    else { await people.saveFor(person.id, null); await loadPeople(); }
    toast(T('Picture removed'));
    if (state.view === 'settings') renderSettings();
  } catch (err) { toast(err.message); }
}

async function saveMe(patch, msg = T('Saved')) {
  try {
    state.me = (await api('/api/me', jsonPost(patch))).me;
    if (msg) toast(msg);
  } catch (err) { toast(err.message); }
}
async function saveRules(patch) {
  try {
    state.rules = (await api('/api/admin/settings', jsonPost(patch))).settings;
    toast(T('Saved for everyone'));
    await loadLibrary(); // countdowns follow the new rules
  } catch (err) { toast(err.message); }
  renderSettings();
}
async function loadPeople() {
  try { state.people = (await api('/api/admin/users')).users; state.peopleError = null; } catch (err) { state.peopleError = err.message; }
}

// ---------- what's new ----------
// After an update, everyone sees its notes once (whats-new.json on the server, via /api/status). The
// popup waits while a video plays or another sheet is open, and closing it marks the update as seen.
// A page left open across an update offers a reload, since it still runs the old app.
const whatsNewView = { open: false, retry: null, build: null, staleNoted: false, opener: null };
const updateDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: new Date().getFullYear() === Number(d.slice(0, 4)) ? undefined : 'numeric' });
// The header's What's new button opens the whole history at any time, and lights up while an update
// hasn't been seen yet.
function renderWhatsNewButton() {
  const btn = $('#whats-new-btn');
  const wn = state.status?.whatsNew;
  btn.hidden = !wn;
  const unseen = wn?.unseen?.length || 0;
  btn.classList.toggle('has-new', unseen > 0);
  btn.querySelector('.news-count').hidden = !unseen;
  btn.querySelector('.news-count').textContent = unseen;
  btn.setAttribute('aria-label', unseen ? T('What’s new: {0} new {1}', unseen, unseen === 1 ? T('update') : T('updates')) : T('What’s new: every update to Marquee'));
}
$('#whats-new-btn').addEventListener('click', () => {
  // unseen updates first, as the popup would show them; otherwise the full history
  const wn = state.status?.whatsNew;
  if (wn?.unseen?.length && !whatsNewView.open) { clearTimeout(whatsNewView.retry); openWhatsNew(wn.unseen, { latest: wn.latest }); }
  else showUpdateHistory();
});
function maybeShowWhatsNew() {
  const wn = state.status?.whatsNew;
  renderWhatsNewButton();
  if (!wn) return;
  whatsNewView.build ??= wn.build;
  const stale = Boolean(wn.build && whatsNewView.build !== wn.build);
  if (!wn.unseen?.length) {
    if (stale && !whatsNewView.staleNoted) { whatsNewView.staleNoted = true; toast(T('Marquee was updated. Reload the page to get the new version.')); }
    return;
  }
  if (whatsNewView.open) return;
  clearTimeout(whatsNewView.retry);
  if (overlayStack.length || !$('#player').hidden || document.hidden) {
    whatsNewView.retry = setTimeout(maybeShowWhatsNew, 15000);
    return;
  }
  openWhatsNew(wn.unseen, { latest: wn.latest, stale });
}
function markUpdatesSeen(latest) {
  if (!latest || state.me?.settings?.seenUpdate === latest) return;
  if (state.status?.whatsNew) state.status.whatsNew.unseen = [];
  renderWhatsNewButton();
  saveMe({ seenUpdate: latest }, null);
}
function updateEntry(e, heading = true) {
  return h('section', { class: 'update' },
    heading && h('div', { class: 'update-head' },
      h('h3', {}, e.title || T('Update')),
      h('time', { datetime: e.date }, updateDate(e.date))),
    h('ul', { class: 'update-items' }, e.items.map((i) => h('li', {},
      h('span', { class: 'update-bulb', 'aria-hidden': 'true' }),
      h('div', {}, i.title && h('strong', {}, i.title), i.text && h('p', {}, i.text))))));
}
// updates: newest first. latest: the id to mark seen when the sheet closes (none for the history view).
// replace: the sheet is already open (popup → All updates), so swap its content in place.
function openWhatsNew(updates, { latest = null, stale = false, history = false, replace = false } = {}) {
  const opener = replace ? whatsNewView.opener : document.activeElement;
  whatsNewView.opener = opener;
  whatsNewView.open = true;
  const single = updates.length === 1 && !history;
  const done = h('button', { class: 'play-btn whats-new-done', type: 'button' }, stale ? T('Reload to update') : history ? T('Close') : T('Got it'));
  done.addEventListener('click', () => {
    if (stale) { markUpdatesSeen(latest); setTimeout(() => location.reload(), 150); return; }
    closeTopOverlay();
  });
  // From the popup, the full history is one tap away (closing it marks these updates seen first).
  const allBtn = h('button', { class: 'chip whats-new-all', type: 'button' }, T('All updates'));
  allBtn.addEventListener('click', () => { markUpdatesSeen(latest); showUpdateHistory({ replace: true }); });
  $('#picker-body').replaceChildren(h('div', { class: 'whats-new' },
    h('p', { class: 'whats-new-eyebrow' }, history ? T('Updates') : T('New in Marquee')),
    h('h2', { id: 'picker-title' }, history ? T('What’s new') : single ? updates[0].title || T('What’s new') : T('What’s new')),
    single && h('p', { class: 'picker-sub muted' }, updateDate(updates[0].date)),
    updates.length ? updates.map((e) => updateEntry(e, !single)) : h('p', { class: 'muted' }, T('No updates yet.')),
    stale && h('p', { class: 'set-hint whats-new-stale' }, T('This page is from before the update. Reload it to use what’s new.')),
    h('div', { class: 'whats-new-actions' }, !history && allBtn, done)));
  const close = showSheet($('#picker'), $('#picker-backdrop'), () => {
    whatsNewView.open = false;
    markUpdatesSeen(latest);
    opener?.focus?.({ preventScroll: true });
  });
  if (replace && overlayStack.length) overlayStack[overlayStack.length - 1] = close;
  else pushOverlay(close);
  if (!history) done.focus({ preventScroll: true });
}
async function showUpdateHistory({ replace = false } = {}) {
  try {
    const { updates } = await api('/api/whats-new');
    if (replace && !whatsNewView.open) return; // closed while loading
    openWhatsNew(updates, { history: true, latest: state.status?.whatsNew?.latest || null, replace });
  } catch (err) { toast(err.message); }
}

// Settings → Language: the whole page is drawn in one language, so changing it reloads the page.
async function pickLanguage(code) {
  if (code === lang) return;
  saveLanguage(code);
  try { await api('/api/me', jsonPost({ language: code })); } catch { /* it still applies on this device */ }
  location.reload();
}
// The account's language wins on a new device; an account without one takes this device's.
function syncLanguage() {
  if (state.me?.via === 'home') return; // the shared home account: each device keeps its own language
  const wanted = prefs().language;
  if (!wanted) { api('/api/me', jsonPost({ language: lang })).catch(() => {}); return; }
  if (wanted === lang) return;
  try {
    if (sessionStorage.getItem('marquee:lang-synced') === wanted) return;
    sessionStorage.setItem('marquee:lang-synced', wanted);
  } catch { return; }
  saveLanguage(wanted);
  location.reload();
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
const days = (n) => (n ? plural(n, 'day') : T('Never'));

function themeSwatch(key, t, selected, onPick) {
  return h('button', {
    type: 'button', class: 'swatch', 'aria-pressed': String(selected), 'aria-label': T('{0} colours', t.name),
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
  const grid = h('div', { class: 'swatches', role: 'group', 'aria-label': T('Colour themes') },
    Object.entries(THEMES).map(([key, t]) => themeSwatch(key, t, active === key, pick)),
    themeSwatch('custom', { ...themeColors(theme?.preset === 'custom' ? theme : { preset: 'custom', colors: customColors() }), name: T('Your own') }, active === 'custom', pick));

  let editor = null;
  if (active === 'custom') {
    const colors = customColors();
    const contrast = h('p', { class: 'set-hint custom-warn', role: 'status' });
    const check = () => {
      const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const low = ratio(colors.text, colors.bg) < 4.5 || ratio(colors.text, colors.surface) < 4.5;
      contrast.textContent = low ? T('The text may be hard to read on these backgrounds. Try a lighter or darker text colour.') : '';
    };
    const commit = () => {
      clearTimeout(saveMeTimer);
      saveMeTimer = setTimeout(() => saveMe({ theme: { preset: 'custom', colors: { ...colors } } }, T('Colours saved')), 700);
    };
    editor = h('div', { class: 'custom-colors' },
      THEME_FIELDS.map(([k, label]) => {
        const id = `color-${k}`;
        const picker = h('input', { type: 'color', id, value: colors[k] });
        const hex = h('input', { type: 'text', class: 'hex-input', value: colors[k], maxlength: '7', spellcheck: 'false', 'aria-label': T('{0} colour code', label) });
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
          if (/^#[0-9a-f]{6}$/i.test(v)) set(v); else { hex.value = colors[k]; toast(T('Use a colour code like #1f1019')); }
        });
        return h('div', { class: 'color-field' }, h('label', { for: id }, label), h('div', { class: 'color-inputs' }, picker, hex));
      }),
      contrast);
    check();
  }
  return [
    h('h3', { class: 'set-head' }, T('Language')),
    settingsRow(T('Show Marquee in'), T('Used on every device you sign in on. TMDB descriptions follow it too; titles stay as they are.'),
      segmented(LANGUAGES.map((l) => [l.code, l.name]), lang, pickLanguage, T('Language'))),
    h('h3', { class: 'set-head' }, T('Appearance')),
    h('p', { class: 'set-hint' }, T('Only changes how Marquee looks for you, on every device you use.')),
    grid,
    editor,
  ];
}

const PROFILE_HINTS = {
  save: T('Compact 1080p or 720p copies that leave room on the server.'),
  balanced: T('Good-looking 1080p at sensible sizes. Recommended.'),
  best: T('4K when there is one, within your size limit.'),
};
const MAX_SIZE_OPTIONS = [[0, T('No limit')], [1, T('1 GB')], [2, T('2 GB')], [4, T('4 GB')], [8, T('8 GB')], [15, T('15 GB')], [30, T('30 GB')], [60, T('60 GB')]];
const AUDIO_LANGUAGES = [['', T('Original language')], ['en', T('English')], ['sv', T('Swedish')], ['da', T('Danish')], ['no', T('Norwegian')], ['fi', T('Finnish')],
  ['de', T('German')], ['fr', T('French')], ['es', T('Spanish')], ['it', T('Italian')], ['pt', T('Portuguese')], ['nl', T('Dutch')], ['pl', T('Polish')],
  ['ru', T('Russian')], ['tr', T('Turkish')], ['hi', T('Hindi')], ['ja', T('Japanese')], ['ko', T('Korean')], ['zh', T('Chinese')]];
function renderSettings() {
  const body = $('#settings-body');
  const me = state.me;
  if (!me) { body.replaceChildren(notice(T('Couldn’t load your settings'), T('Reload the page to try again.'))); return; }
  const p = prefs();
  const out = [];

  // ---- you ----
  const nameInput = h('input', { type: 'text', class: 'invite-note set-name', maxlength: '40', value: me.name, 'aria-label': T('Your name'), autocomplete: 'nickname' });
  nameInput.addEventListener('change', () => saveMe({ name: nameInput.value }, T('Name saved')));
  const pictureBtn = h('button', { type: 'button', class: 'profile-face', 'aria-label': me.avatar ? T('Change your picture') : T('Add a picture'),
    title: me.avatar ? T('Change your picture') : T('Add a picture'), onclick: (e) => editPicture({ person: me, opener: e.currentTarget }) },
    people.face(me, { size: 64 }), h('span', { class: 'profile-face-edit', 'aria-hidden': 'true' }, icon('camera')));
  out.push(h('div', { class: 'profile' },
    h('div', { class: 'profile-face-col' }, pictureBtn,
      me.avatar && h('button', { type: 'button', class: 'profile-face-remove', onclick: () => removePicture({ person: me }) }, T('Remove'))),
    h('div', { class: 'profile-text' },
      nameInput,
      h('div', { class: 'set-hint' }, !me.email ? T('Home network: everyone at home who opens the server’s local address shares this')
        : me.via === 'session' ? T('Signed in as {0}', me.email) : T('Signed in as {0} through Cloudflare', me.email)),
      h('div', { class: 'profile-tags' }, me.isOwner && h('span', { class: 'tag' }, T('Owner')), !me.canDownload && h('span', { class: 'tag' }, T('Can’t download'))))));

  {
    const unseen = state.status?.whatsNew?.unseen?.length || 0;
    const open = h('button', { class: `chip whats-new-open${unseen ? ' has-new' : ''}`, type: 'button' }, unseen ? (unseen === 1 ? T('1 new') : T('{0} new', unseen)) : T('See updates'));
    open.addEventListener('click', showUpdateHistory);
    out.push(settingsRow(T('What’s new'), T('Everything that changed in Marquee lately.'), open));
  }
  {
    const year = new Date().getFullYear();
    const open = h('button', { class: 'wrapped-open', type: 'button', onclick: (e) => openWrapped(year, e.currentTarget) },
      h('span', { class: 'wrapped-open-kicker' }, T('Marquee Wrapped {0}', year)), h('span', {}, T('Your year in watching so far')));
    out.push(open);
  }

  if (me.via === 'session') out.push(accountSection());

  out.push(...appearanceSection());

  // ---- watching ----
  out.push(h('h3', { class: 'set-head' }, T('Watching')));
  out.push(settingsRow(T('Subtitles'), T('Turned on automatically when a video has them in this language.'),
    select([['', T('Off')], ...(state.status.subLangs || []).map((l) => [l.code, l.name])], p.subLang || '', (v) => saveMe({ subLang: v }), T('Default subtitles'))));
  out.push(settingsRow(T('Intros'), p.skipIntro === 'auto' ? T('Opening titles are skipped as they start (not in Watch Together).') : T('A Skip intro button shows during opening titles.'),
    segmented([['button', T('Show a button')], ['auto', T('Skip automatically')]], p.skipIntro || 'button', (v) => saveMe({ skipIntro: v }).then(renderSettings), T('Intros'))));
  out.push(settingsRow(T('Open Marquee on'), null,
    segmented([['discover', T('Discover')], ['library', T('Library')]], p.startView === 'downloads' ? 'library' : p.startView || 'discover', (v) => saveMe({ startView: v }).then(renderSettings), T('Open Marquee on'))));
  out.push(tvSignInRow());
  out.push(jellyfinRow());
  out.push(settingsRow(T('Library order'), null,
    segmented([['newest', T('Newest')], ['expiring', T('Leaving soonest')], ['title', 'A–Z']], p.librarySort || 'newest', (v) => saveMe({ librarySort: v }).then(renderSettings), T('Library order'))));
  out.push(...notificationSettings());
  // ---- downloads: set once, used by every Download ----
  if (canDownload()) {
    const profile = savedProfile();
    out.push(h('h3', { class: 'set-head' }, T('Downloads')));
    out.push(settingsRow(T('Quality'), PROFILE_HINTS[profile],
      select(PROFILE_OPTIONS, profile, (v) => saveMe({ downloadProfile: v }).then(renderSettings), T('Download quality'))));
    out.push(settingsRow(T('Largest download'), T('Per film or episode. Bigger releases are skipped.'),
      select(MAX_SIZE_OPTIONS, p.maxSize || 0, (v) => saveMe({ maxSize: Number(v) }), T('Largest download'))));
    out.push(settingsRow(T('Audio language'), T('Releases in this language come first. Releases dubbed into another language are skipped when there’s a choice.'),
      select(AUDIO_LANGUAGES, p.audioLang || '', (v) => saveMe({ audioLang: v }), T('Audio language'))));
  }

  // ---- your library ----
  const r = state.rules || {};
  const mine = state.library;
  const next = mine.filter((f) => f.expiresAt != null).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  out.push(h('h3', { class: 'set-head' }, T('Your library')));
  out.push(h('div', { class: 'set-card' },
    h('p', {}, `${plural(mine.length, 'video')}, ${fmtBytes(mine.reduce((n, f) => n + (f.size || 0), 0))}.`,
      next ? T(' Next to go: {0}{1}, {2} left.', next.title, episodeLabel(next) ? ` ${episodeLabel(next)}` : '', timeLeft(next.expiresAt).replace(' left', '')) : ''),
    libraryMates().length > 0 && h('p', {}, T('Shared with {0}: you all see the same library and can add, keep or remove titles in it. Watch progress stays your own.', nameList(libraryMates()))),
    h('p', { class: 'set-hint' }, me.keep ? T('The owner has set your videos to stay until you delete them.')
      : r.retentionDays
        ? T('Downloads are deleted {0} after they finish, to keep space free on the server. Use “Keep {1} more days” in the Library to hold on to something{2}.', plural(r.retentionDays, 'day'), r.extendDays, r.maxExtensions ? T(' (up to {0} per video)', plural(r.maxExtensions, 'time')) : '')
        : T('Nothing is deleted automatically.'))));

  if (me.isOwner) out.push(...ownerSettings());
  body.replaceChildren(...out.filter(Boolean));
}

// The Marquee app on a TV (tv/tizen) shows a code; entering it here signs that TV in as you.
function tvSignInRow() {
  const input = h('input', { type: 'text', class: 'invite-note tv-code', maxlength: '7', placeholder: T('Code on the TV'), 'aria-label': T('Code shown on the TV'),
    autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'done' });
  const go = h('button', { type: 'submit', class: 'chip' }, T('Sign in'));
  const note = h('p', { class: 'set-hint tv-code-note', role: 'status' });
  const form = h('form', { class: 'tv-code-form', onsubmit: async (e) => {
    e.preventDefault();
    const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) { note.textContent = T('The code on the TV has 6 letters and numbers.'); input.focus(); return; }
    go.disabled = true; note.textContent = T('Signing in the TV…');
    try {
      await api('/api/tv/pair/approve', jsonPost({ code }));
      input.value = ''; note.textContent = T('Done. The TV is signed in as you.');
    } catch (err) { note.textContent = err.message; } finally { go.disabled = false; }
  } }, input, go);
  return settingsRow(T('Sign in a TV'), T('Open the Marquee app on the TV and enter the code it shows. The TV then sees your library.'),
    h('div', { class: 'tv-code-wrap' }, form, note));
}

// Your library in your own Jellyfin (the Marquee plugin; jellyfin.js on the server). The plugin's
// settings page shows a code; entering it here connects that Jellyfin server to your library.
const jellyfinView = { links: null, loading: null };
function loadJellyfin() {
  jellyfinView.loading ??= api('/api/jellyfin')
    .then((d) => { jellyfinView.links = d.links; })
    .catch(() => { jellyfinView.links = jellyfinView.links || []; })
    .finally(() => { jellyfinView.loading = null; if (state.view === 'settings') renderSettings(); });
  return jellyfinView.loading;
}
function jellyfinRow() {
  if (!jellyfinView.links && !jellyfinView.loading) loadJellyfin();
  const input = h('input', { type: 'text', class: 'invite-note tv-code', maxlength: '7', placeholder: T('Code'), 'aria-label': T('Code shown in Jellyfin'),
    autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'done' });
  const go = h('button', { type: 'submit', class: 'chip' }, T('Connect'));
  const note = h('p', { class: 'set-hint tv-code-note', role: 'status' });
  const form = h('form', { class: 'tv-code-form', onsubmit: async (e) => {
    e.preventDefault();
    const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) { note.textContent = T('The code in Jellyfin has 6 letters and numbers.'); input.focus(); return; }
    go.disabled = true; note.textContent = T('Connecting…');
    try {
      const r = await api('/api/jellyfin/approve', jsonPost({ code }));
      jellyfinView.links = r.links;
      toast(T('Jellyfin is connected. Your library shows up there after its first sync.'));
      renderSettings();
    } catch (err) { note.textContent = err.message; go.disabled = false; }
  } }, input, go);
  const list = (jellyfinView.links || []).map((l) => h('li', { class: 'jf-link' },
    h('span', { class: 'jf-link-name' }, l.name),
    h('span', { class: 'set-hint jf-link-seen' }, T('Last synced {0}', fmtAgo(l.lastSeen) || T('just now'))),
    h('button', { type: 'button', class: 'chip', 'aria-label': T('Disconnect {0}', l.name), onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { jellyfinView.links = (await api(`/api/jellyfin/${l.id}/remove`, jsonPost({}))).links; toast(T('{0} is disconnected', l.name)); }
      catch (err) { toast(err.message); }
      renderSettings();
    } }, T('Disconnect'))));
  return settingsRow(T('Jellyfin'), T('Watch your library in your own Jellyfin: install the Marquee plugin there, open its settings and enter the code it shows.'),
    h('div', { class: 'tv-code-wrap' }, form, note, list.length > 0 && h('ul', { class: 'jf-links' }, ...list)));
}

// ---------- notifications (notifications.js, sw.js; push.js on the server) ----------
const pushView = { loaded: false, loading: null, publicKey: null, devices: [], deviceId: null, busy: false };
async function loadPush() {
  pushView.loading ??= (async () => {
    try {
      const data = await api('/api/push');
      pushView.publicKey = data.publicKey; pushView.devices = data.devices;
      // A device that already has a subscription re-registers it, so it's in the list (and the
      // server gets it back if its copy was lost). Unchanged ones aren't rewritten.
      const sub = globalThis.Notification?.permission === 'granted' ? await pushDevice.currentSubscription() : null;
      if (sub && pushDevice.sameKey(sub, data.publicKey)) {
        const r = await api('/api/push/subscribe', jsonPost({ subscription: sub.toJSON() }));
        pushView.deviceId = r.id; pushView.devices = r.devices;
      } else pushView.deviceId = null;
    } catch { /* offline: try again next time Settings opens */ }
    pushView.loaded = true; pushView.loading = null;
  })();
  return pushView.loading;
}
function notificationSettings() {
  const support = pushDevice.pushSupport();
  const p = prefs();
  const out = [h('h3', { class: 'set-head' }, T('Notifications'))];
  if (!pushView.loaded) {
    if (support === 'ok') { loadPush().then(() => { if (state.view === 'settings') renderSettings(); }); out.push(h('p', { class: 'muted' }, T('Loading…'))); return out; }
    pushView.loaded = true;
  }
  const on = Boolean(pushView.deviceId);
  const why = {
    insecure: T('Notifications need Marquee opened through its https address, not the local one.'),
    'ios-install': T('On iPhone and iPad, notifications work once Marquee is on your Home Screen: tap Share, then Add to Home Screen, and open Marquee from there.'),
    unsupported: T('This browser can’t show notifications from websites.'),
    denied: T('Notifications are blocked for Marquee in this browser. Allow them in the site settings (the icon next to the address), then reload.'),
  }[support];
  if (why) out.push(settingsRow(T('This device'), why, null));
  else {
    const sw = toggle(on, async (want, input) => {
      if (pushView.busy) { input.checked = on; return; }
      pushView.busy = true; input.disabled = true;
      try {
        if (want) {
          const sub = await pushDevice.subscribe(pushView.publicKey);
          const r = await api('/api/push/subscribe', jsonPost({ subscription: sub.toJSON(), label: pushDevice.deviceLabel(navigator.userAgent) }));
          pushView.deviceId = r.id; pushView.devices = r.devices;
          toast(T('Notifications are on for this device'));
        } else {
          const sub = await pushDevice.currentSubscription();
          const r = await api('/api/push/unsubscribe', jsonPost({ endpoint: sub?.endpoint || '', id: pushView.deviceId || '' }));
          await sub?.unsubscribe().catch(() => {});
          pushView.deviceId = null; pushView.devices = r.devices;
          toast(T('Notifications are off for this device'));
        }
      } catch (err) { toast(err.message); }
      pushView.busy = false;
      renderSettings();
    }, T('Notifications on this device'));
    out.push(settingsRow(T('This device'), on ? T('Marquee can tell you about these even when it’s closed.') : T('Get a notification when something’s ready, even with Marquee closed.'), sw));
  }
  if (pushView.devices.length) {
    out.push(settingsRow(T('Downloads ready'), T('When something you downloaded can be watched.'),
      toggle(p.pushDownload !== false, (v) => saveMe({ pushDownload: v }), T('Notify when downloads are ready'))));
    out.push(settingsRow(T('New episodes'), T('When a new episode of a show in your library arrives on Marquee.'),
      toggle(p.pushEpisode !== false, (v) => saveMe({ pushEpisode: v }), T('Notify about new episodes'))));
    out.push(settingsRow(T('Watch Together invites'), T('When someone asks you to join their room. Off: nobody can invite you this way.'),
      toggle(p.pushWatch !== false, (v) => saveMe({ pushWatch: v }), T('Notify about Watch Together invites'))));
    if (state.me?.isOwner) out.push(settingsRow(T('Agents'), T('When a script or AI agent on your home machines asks for your attention.'),
      toggle(p.pushAgent !== false, (v) => saveMe({ pushAgent: v }), T('Notify when an agent needs you'))));
    const test = h('button', { class: 'chip', type: 'button' }, T('Send a test'));
    test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        const r = await api('/api/push/test', jsonPost({}));
        pushView.devices = r.devices;
        toast(r.sent ? T('Sent to {0}', plural(r.sent, 'device')) : T('No device accepted it. Turn notifications off and on again on that device.'));
      } catch (err) { toast(err.message); }
      setTimeout(() => { test.disabled = false; }, 10000);
    });
    out.push(h('ul', { class: 'rows push-devices', 'aria-label': T('Devices with notifications') }, pushView.devices.map((d) => {
      const remove = h('button', { class: 'chip', type: 'button', 'aria-label': T('Stop notifications on {0}', d.label) }, T('Remove'));
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          if (d.id === pushView.deviceId) { const sub = await pushDevice.currentSubscription(); await sub?.unsubscribe().catch(() => {}); pushView.deviceId = null; }
          pushView.devices = (await api('/api/push/unsubscribe', jsonPost({ id: d.id }))).devices;
        } catch (err) { toast(err.message); }
        renderSettings();
      });
      return h('li', { class: 'row' },
        h('div', { class: 'row-text' },
          h('div', { class: 'row-title' }, d.label, d.id === pushView.deviceId && h('span', { class: 'tag' }, T('This device'))),
          h('div', { class: 'row-meta' }, h('span', {}, T('Added {0}', fmtAgo(d.createdAt))))),
        remove);
    })), h('div', { class: 'set-row push-test' }, test));
  }
  return out;
}

// Marquee's own sign-in: change the password, sign out of this browser.
function accountSection() {
  const current = h('input', { type: 'password', class: 'invite-note', autocomplete: 'current-password', placeholder: T('Current password'), 'aria-label': T('Current password') });
  const next = h('input', { type: 'password', class: 'invite-note', autocomplete: 'new-password', minlength: '10', placeholder: T('New password (10+ characters)'), 'aria-label': T('New password') });
  const save = h('button', { class: 'chip', type: 'submit' }, T('Change password'));
  const msg = h('div', { class: 'set-hint', role: 'status' });
  const form = h('form', { class: 'set-card account-password' }, current, next, save, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await api('/api/auth/password', jsonPost({ current: current.value, next: next.value }));
      current.value = next.value = '';
      msg.textContent = T('Password changed. Other devices were signed out.');
    } catch (err) { msg.textContent = err.message; } finally { save.disabled = false; }
  });
  const out = h('button', { class: 'chip', type: 'button' }, T('Sign out'));
  out.addEventListener('click', async () => {
    out.disabled = true;
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* signed out either way */ }
    location.assign('/signin');
  });
  return h('div', {}, settingsRow(T('Sign out'), T('Signs this browser out of Marquee.'), out),
    h('details', { class: 'set-details' }, h('summary', {}, T('Change password')), form));
}

function ownerSettings() {
  const r = state.rules || {};
  const out = [h('h3', { class: 'set-head' }, T('Server'), h('span', { class: 'tag' }, T('Owner')))];
  out.push(settingsRow(T('Delete downloads after'), T('Counted from when each download finishes, per person. A video someone else still has stays.'),
    select([0, 1, 3, 7, 14, 30].map((n) => [n, days(n)]), r.retentionDays ?? 7, (v) => saveRules({ retentionDays: Number(v) }), T('Delete downloads after'))));
  out.push(settingsRow(T('“Keep longer” adds'), null,
    select([1, 3, 7, 14, 30].map((n) => [n, plural(n, 'day')]), r.extendDays ?? 7, (v) => saveRules({ extendDays: Number(v) }), T('Keep longer adds'))));
  out.push(settingsRow(T('Times a video can be kept longer'), null,
    select([[0, T('No limit')], [1, T('Once')], [2, T('Twice')], [3, T('3 times')], [5, T('5 times')], [10, T('10 times')]], r.maxExtensions ?? 0, (v) => saveRules({ maxExtensions: Number(v) }), T('Times a video can be kept longer'))));
  out.push(settingsRow(T('New people can download'), T('Otherwise they can only add what’s already on the server, until you allow them below.'),
    toggle(r.membersCanDownload !== false, (on) => saveRules({ membersCanDownload: on }), T('New people can download'))));
  out.push(settingsRow(T('Colours for new people'), T('Until they pick their own.'),
    select(Object.entries(THEMES).map(([k, t]) => [k, t.name]), r.defaultTheme || 'marquee', (v) => saveRules({ defaultTheme: v }), T('Colours for new people'))));
  out.push(h('details', { class: 'set-card set-signin' },
    h('summary', {}, T('Staying signed in')),
    h('p', {}, T('Marquee has no login of its own: it uses the Cloudflare Access sign-in, so how long people stay signed in is set in Cloudflare. To make it last a month:')),
    h('ol', {},
      h('li', {}, T('Cloudflare dashboard → Zero Trust → Access → Applications → Marquee → Edit.')),
      h('li', {}, T('Set Session Duration to 1 month (it’s 24 hours now) and save.')),
      h('li', {}, T('If you’ve set a Global session timeout (Settings → Authentication), raise that too: it caps every app.'))),
    h('p', { class: 'set-hint' }, T('If someone’s sign-in does run out while Marquee is open, it now tells them and signs them back in with one tap.'))));

  out.push(h('h3', { class: 'set-head' }, T('People')));
  if (state.peopleError) out.push(h('p', { class: 'muted' }, state.peopleError));
  else if (!state.people) out.push(h('p', { class: 'muted' }, T('Loading…')));
  else {
    out.push(h('ul', { class: 'rows people' }, state.people.map((u) => h('li', { class: 'row person' },
      h('button', { type: 'button', class: 'profile-face small', 'aria-label': T('{0} {1}’s picture', u.avatar ? T('Change') : T('Add'), u.name),
        title: u.avatar ? T('Change picture (right-click to remove)') : T('Add a picture'),
        onclick: (e) => editPicture({ person: u, opener: e.currentTarget }),
        oncontextmenu: (e) => { if (!u.avatar) return; e.preventDefault(); if (confirm(T('Remove {0}’s picture?', u.name))) removePicture({ person: u }); } },
        people.face(u, { size: 40 }), h('span', { class: 'profile-face-edit', 'aria-hidden': 'true' }, icon('camera'))),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, u.name, u.isOwner && h('span', { class: 'tag' }, T('Owner'))),
        h('div', { class: 'row-meta' },
          u.email && h('span', {}, u.email),
          h('span', {}, `${plural(u.items, 'video')}, ${fmtBytes(u.size)}`),
          u.lastSeen && h('span', {}, lastSeenText(u.lastSeen)))),
      h('div', { class: 'person-controls' },
        h('label', { class: 'person-toggle' }, T('Can download'),
          toggle(u.canDownload, async (on, input) => {
            if (u.isOwner) { input.checked = true; toast(T('The owner can always download')); return; }
            await personUpdate(u, { canDownload: on });
          }, T('{0} can download', u.name))),
        h('label', { class: 'person-toggle' }, T('Never auto-delete'),
          toggle(u.keep, (on) => personUpdate(u, { keep: on }), T('Never auto-delete {0}’s videos', u.name))),
        h('label', { class: 'person-toggle person-library' }, T('Library'), libraryShareSelect(u)))))));
  }
  return out;
}
// Own library, or one shared with someone else (joining them joins everyone they already share with).
function libraryShareSelect(u) {
  const mates = u.sharedWith || [];
  const options = [['', T('Own library')]];
  if (mates.length) options.push([String(mates[0].id), T('Shared with {0}', nameList(mates.map((m) => m.name)))]);
  for (const p of state.people) {
    if (p.id === u.id || mates.some((m) => m.id === p.id)) continue;
    const theirs = (p.sharedWith || []).filter((m) => m.id !== u.id).map((m) => m.name);
    options.push([String(p.id), theirs.length ? T('Join {0} (with {1})', p.name, nameList(theirs)) : T('Share with {0}', p.name)]);
  }
  return select(options, mates.length ? String(mates[0].id) : '', (v) => personUpdate(u, { libraryWith: v ? Number(v) : null }), T('{0}’s library', u.name));
}
async function personUpdate(u, patch) {
  try {
    await api(`/api/admin/users/${u.id}`, jsonPost(patch));
    toast(T('Saved'));
  } catch (err) { toast(err.message); }
  await loadPeople();
  if (u.id === state.me.id) { state.me = (await api('/api/me')).me; await loadLibrary(); }
  if (state.view === 'settings') renderSettings();
}

// ---------- activity (server owner only) ----------
// Who has been using Marquee and what they did, from the server's activity log.
const ACTIVITY_TEXT = {
  // The log keeps these lines whole, in English.
  watch: (d) => {
    const room = String(d).match(/^started a room for (.*)$/);
    if (room) return T('started a room for {0}', room[1]);
    const party = String(d).match(/^planned a watch party for (.*)$/);
    if (party) return T('planned a watch party for {0}', party[1]);
    const invited = String(d).match(/^invited (.*) to (.*)$/);
    return invited ? T('invited {0} to {1}', invited[1], invited[2]) : d;
  },
  download: (d) => T('started downloading {0}', d),
  delete: (d) => T('deleted {0}', d),
  travel: (d) => T('saved {0}', d),
  pause: (d) => T('paused the download of {0}', d),
  resume: (d) => T('resumed the download of {0}', d),
  play: (d) => T('watched {0}', d),
  cast: (d) => { const [what, tv] = d.split(' → '); return tv ? T('put {0} on {1}', what, tv) : T('put {0} on a TV', d); },
  stop: (d) => T('stopped {0}', d),
  subtitles: (d) => T('got {0}', d),
  share: (d) => T('shared the clip {0}', d),
  trim: (d) => T('trimmed the clip {0}', d),
  invite: (d) => T('made an invite link ({0})', d),
  joined: (d) => T('joined Marquee ({0})', d),
  revoke: (d) => T('removed {0}’s access', d),
  unshare: (d) => T('stopped sharing {0}', d),
  wake: (d) => T('woke {0}', d),
  restart: (d) => T('restarted {0}', d),
  add: (d) => T('added {0} to their library', d),
  remove: (d) => T('removed {0} from their library', d),
  extend: (d) => T('kept {0} longer', d),
  expire: (d) => T('auto-deleted {0}', d),
  upgrade: (d) => T('upgraded the quality of {0}', d),
  blocked: (d) => T('tried to download {0}, which was blocked', d),
  settings: (d) => T('changed the server rules ({0})', d),
  permission: (d) => T('changed a permission: {0}', d),
};
const personName = (person) => typeof person === 'string' ? person.split('@')[0]
  : person.name || String(person.user || T('Viewer')).split('@')[0];
const clock = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return T('Today');
  if (d.toDateString() === yesterday.toDateString()) return T('Yesterday');
  return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
}
function lastSeenText(ms) {
  const min = (Date.now() - ms) / 60000;
  if (min < 3) return T('Active now');
  if (min < 60) return T('Seen {0} min ago', Math.round(min));
  if (min < 24 * 60) return T('Seen {0} h ago', Math.round(min / 60));
  return T('Seen {0}', fmtAgo(ms));
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
    state.inviteNote = '';
    await copyWithToast(inv.url, T('Invite link copied: send it to them'));
  } catch (err) { toast(err.message); }
  await loadActivity();
  renderActivity();
}
// copyText() (above) has the iOS fallback; this adds the toast, or shows the link if copying failed
async function copyWithToast(text, msg) {
  if (await copyText(text)) toast(msg); else prompt(T('Copy this link'), text);
}
async function accessAction(path, body, msg) {
  try {
    await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    toast(msg);
  } catch (err) { toast(err.message); }
  await loadActivity();
  renderActivity();
}

function accessName(email, name) {
  return inlineName({
    getName: () => name, label: T('Person'), maxLength: 40,
    errorId: `person-rename-error-${encodeURIComponent(email)}`, className: 'person-name',
    successMessage: T('Name saved'),
    save: async (next, previousName) => {
      const { user } = await api('/api/access/rename', jsonPost({ email, name: next, previousName }));
      name = user.name;
      if (state.access) { state.access.names ||= {}; state.access.names[email] = name; }
      if (state.me?.id === user.id) state.me = user;
      const person = state.people?.find((u) => u.id === user.id); if (person) person.name = name;
      for (const entry of [...(state.activity?.people || []), ...(state.activity?.events || [])]) {
        if (entry.user === email) entry.name = name;
        if (entry.detail === email && entry.subjectName) entry.subjectName = name;
      }
    },
  });
}

// One People list: everyone on the access list with their last visit (everyone seen, if the list can't be read).
function peopleSection(q) {
  const a = state.access || {};
  const out = [];
  if (state.access && !a.configured) {
    out.push(h('p', { class: 'muted' }, T('Set CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_LIST_ID in .env to invite people from here (see docs/remote-access.md in the Marquee folder).')));
  } else if (state.access) {
    const noteInput = h('input', { id: 'invite-note', class: 'invite-note', type: 'text', maxlength: '60', placeholder: T('Who’s it for?'), value: state.inviteNote || '',
      oninput: (e) => { state.inviteNote = e.currentTarget.value; } });
    out.push(h('div', { class: 'invite-new' }, noteInput,
      h('button', { class: 'retry', onclick: (e) => makeInvite(e.currentTarget) }, T('Invite someone'))));
    out.push(h('p', { class: 'muted invite-hint' }, T('Makes a one-time link (valid 7 days). They enter their email and can sign in from then on.')));
    const open = (a.invites || []).filter((i) => i.state === 'open');
    if (open.length) {
      out.push(h('ul', { class: 'rows' }, open.map((i) => {
        const url = `${location.origin}/c/i/${i.token}`;
        return h('li', { class: 'row' },
          h('span', { class: 'row-text' },
            h('span', { class: 'row-title' }, i.note || T('Invite')),
            h('span', { class: 'row-meta' }, h('span', {}, T('open · expires {0}', new Date(i.expires).toLocaleDateString(locale, { day: 'numeric', month: 'short' }))))),
          h('span', { class: 'row-actions' },
            h('button', { class: 'retry', onclick: () => copyWithToast(url, T('Invite link copied')) }, T('Copy link')),
            h('button', { class: 'retry', onclick: () => accessAction(`/api/access/invite/${i.id}/revoke`, null, T('Invite cancelled')) }, T('Cancel'))));
      })));
    }
    if (a.error) out.push(h('p', { class: 'muted' }, T('Couldn’t read the access list: {0}', a.error)));
  }
  out.push(h('p', { class: 'muted activity-location-note' }, T('Locations are approximate. City names require Cloudflare’s “Add visitor location headers” Managed Transform.')));

  const members = a.members || null;
  const key = (u) => String(u).toLowerCase();
  const seen = new Map((state.activity?.people || []).map((p) => [key(p.user), p]));
  const rows = [];
  for (const email of members || []) {
    const p = seen.get(key(email));
    seen.delete(key(email));
    rows.push({ email, member: true, owner: (a.owners || []).includes(email), name: a.names?.[email] || p?.name || personName(email), p });
  }
  // Once the access list is known, only people on it are listed: removing someone there drops them here too.
  if (!members) for (const p of seen.values()) rows.push({ email: p.user, member: false, owner: false, name: personName(p), p });
  rows.sort((x, y) => (y.p?.at || 0) - (x.p?.at || 0));
  const list = rows.filter((r) => !q || norm(`${r.email} ${r.name} ${r.p ? activityDevice(r.p) : ''}`).includes(q));

  out.push(list.length ? h('ul', { class: 'rows' }, list.map((r) => {
    const { email, name, p, owner, member } = r;
    const isEmail = String(email).includes('@');
    return h('li', { class: 'row' },
      h('span', { class: 'activity-face' }, people.face({ name, avatar: p?.avatar }, { size: 34 }),
        h('span', { class: `activity-dot${p && Date.now() - p.at < 3 * 60000 ? ' is-on' : ''}`, 'aria-hidden': 'true' })),
      h('div', { class: 'row-text' },
        member ? accessName(email, name) : h('span', { class: 'row-title', title: email }, name),
        h('span', { class: 'row-meta' },
          isEmail && h('span', {}, email),
          owner && h('span', {}, T('owner')),
          h('span', {}, p ? lastSeenText(p.at) : T('Hasn’t signed in yet')),
          p && h('span', {}, activityDevice(p)))),
      member && !owner && h('span', { class: 'row-actions' }, h('button', {
        class: 'retry',
        onclick: (e) => {
          const b = e.currentTarget;
          if (b.dataset.sure) return accessAction('/api/access/remove', { email }, T('{0} can’t sign in any more', name));
          b.dataset.sure = '1';
          b.textContent = T('Sure?');
          setTimeout(() => { b.textContent = T('Remove'); delete b.dataset.sure; }, 4000);
        },
      }, T('Remove'))));
  })) : h('p', { class: 'muted' }, q ? T('Nobody matches.') : T('Nobody yet.')));
  return foldGroup('people', 'h3', 'activity-head', T('People'), rows.length, out, Boolean(q));
}

// Activity sections and days fold open/closed; the folded ones are remembered per browser.
const ACTIVITY_FOLD_KEY = 'marquee:activityFolded';
let activityFolded = null;
function activityFoldSet() {
  if (!activityFolded) {
    try { activityFolded = new Set(JSON.parse(localStorage.getItem(ACTIVITY_FOLD_KEY)) || []); } catch { activityFolded = new Set(); }
  }
  return activityFolded;
}

function foldGroup(key, tag, cls, title, count, kids, forceOpen = false) {
  const folded = !forceOpen && activityFoldSet().has(key);
  const content = h('div', { class: 'fold-body', hidden: folded }, kids);
  const btn = h('button', {
    type: 'button',
    class: 'fold-btn',
    'aria-expanded': String(!folded),
    title: folded ? T('Show') : T('Hide'),
    onclick: () => {
      const open = content.hidden;
      content.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.title = open ? T('Hide') : T('Show');
      const set = activityFoldSet();
      set.delete(key);
      if (!open) set.add(key);
      while (set.size > 60) set.delete(set.values().next().value);
      try { localStorage.setItem(ACTIVITY_FOLD_KEY, JSON.stringify([...set])); } catch { /* blocked */ }
    },
  }, h('span', { class: 'fold-chev', 'aria-hidden': 'true' }), h('span', {}, title), count != null && h('span', { class: 'fold-count' }, String(count)));
  return [h(tag, { class: `${cls} fold-head` }, btn), content];
}

function renderActivity() {
  // Rebuilding mid-typing would throw away the box being typed in (invite note, rename).
  if ($('#activity-body .person-name .clip-rename-form') || editingIn('#activity-body')) return;
  const body = $('#activity-body');
  if (state.activityError) { body.replaceChildren(notice(T('Couldn’t get activity'), state.activityError)); return; }
  if (!state.activity) return;
  const q = norm(state.query);
  const events = state.activity.events.filter((e) => !q || norm(`${e.user} ${personName(e)} ${e.subjectName || ''} ${e.detail} ${e.action} ${activityDevice(e)}`).includes(q));
  const out = [...peopleSection(q)];
  const eventKids = [];
  if (!events.length) eventKids.push(h('p', { class: 'muted' }, q ? T('Nothing matches.') : T('Nothing has happened yet.')));
  const days = [];
  for (const e of events) {
    const label = dayLabel(e.at);
    if (days.at(-1)?.label !== label) days.push({ label, key: `day:${new Date(e.at).toDateString()}`, list: h('ul', { class: 'rows activity-list' }), n: 0 });
    const d = days.at(-1);
    d.n++;
    d.list.append(h('li', { class: 'row activity-row' },
      h('span', { class: 'activity-time' }, clock(e.at)),
      people.face(e, { size: 32, cls: 'activity-row-face' }),
      h('span', { class: 'row-text' },
        h('span', { class: 'activity-text' }, h('strong', { title: e.user }, personName(e)), ' ', (ACTIVITY_TEXT[e.action] || ((d) => `${e.action} ${d}`))(e.subjectName || e.detail)),
        h('span', { class: 'row-meta' }, h('span', {}, activityDevice(e))))));
  }
  for (const d of days) eventKids.push(...foldGroup(d.key, 'p', 'activity-day', d.label, d.n, [d.list], Boolean(q)));
  out.push(...foldGroup('events', 'h3', 'activity-head', T('What happened'), events.length, eventKids, Boolean(q)));
  body.replaceChildren(...out);
}

function activityDevice(entry) {
  const loc = entry.location;
  let country = loc?.country || '';
  if (country) { try { country = new Intl.DisplayNames([lang], { type: 'region' }).of(country); } catch { /* use country code */ } }
  return [T(entry.device), [loc?.city, country].filter(Boolean).join(', ') || T('Location unavailable')].filter(Boolean).join(' · ');
}

// ---------- house (server owner only) ----------
// The home server's own health plus the machines that report in (laptop, desktop): house.js.
async function loadHouse() {
  if (state.houseTab === 'screentime') { await loadScreenTime(); return; }
  const [r, l] = await Promise.allSettled([api('/api/house'), api(`/api/house/load?hours=${state.houseHours || 1}`)]);
  if (r.status === 'fulfilled') { state.house = r.value; state.houseError = null; } else state.houseError = r.reason.message;
  state.houseLoad = l.status === 'fulfilled' ? l.value : null;
}

// ---------- house → sharing: what streams and encodes cost the server (load.js) ----------
const mbps = (bytesPerSec) => (bytesPerSec * 8) / 1e6;
function fmtMbit(bytesPerSec, unit = true) {
  const v = mbps(bytesPerSec || 0);
  const t = v >= 1000 ? `${(v / 1000).toFixed(1)} G` : v >= 10 ? `${Math.round(v)}` : v >= 0.05 ? v.toFixed(1) : '0';
  return unit ? `${t}${t.endsWith('G') ? 'bit/s' : T(' Mbit/s')}` : t;
}
const fmtFor = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return T('{0} min', Math.floor(s / 60));
  return T('{0} h {1} min', Math.floor(s / 3600), Math.floor((s % 3600) / 60));
};
// A meter row: name · bar · reading. `parts` are [value, class] segments of `max`.
function loadRow(name, parts, max, reading, title) {
  const total = parts.reduce((a, [v]) => a + (v || 0), 0);
  const full = max && total / max >= 0.85;
  return h('div', { class: 'house-disk load-row', title },
    h('span', { class: 'house-disk-name' }, name),
    h('span', { class: `meter${full ? ' is-full' : ''}`, role: 'img', 'aria-label': `${name}: ${reading}` },
      parts.map(([v, cls]) => h('i', { class: cls || null, style: `width:${max ? Math.min(100, (100 * (v || 0)) / max) : 0}%` }))),
    h('span', { class: 'house-disk-free' }, reading));
}
const WHERE = { internet: 'internet', lan: T('home network'), tv: T('TV') };

// A small history chart (one series), with a readout that follows the pointer.
function loadChart(title, points, { value, peak, max, fmt, empty }) {
  const W = 300, H = 64;
  const head = h('div', { class: 'load-chart-head' }, h('span', {}, title), h('span', { class: 'load-chart-read' }));
  const read = head.lastChild;
  const wrap = h('div', { class: 'load-chart' }, head);
  if (points.length < 2) { wrap.append(h('p', { class: 'muted load-chart-empty' }, empty)); return wrap; }
  const top = Math.max(max ?? 0, ...points.map((p) => peak(p) ?? value(p) ?? 0)) || 1;
  const x = (i) => (i / (points.length - 1)) * W;
  const y = (v) => H - 2 - ((v || 0) / top) * (H - 6);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(value(p)).toFixed(1)}`).join('');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'load-spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', T('{0}: latest {1}, highest {2}', title, fmt(value(points[points.length - 1])), fmt(top)));
  svg.innerHTML = `<path class="load-area" d="${line}L${W},${H}L0,${H}Z"/><path class="load-line" d="${line}"/>`
    + `<line class="load-cursor" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>`;
  const cursor = svg.lastChild;
  const stamp = (p) => `${clock(p.t)} · ${fmt(value(p))}${peak(p) != null && peak(p) > (value(p) || 0) ? T(' (peak {0})', fmt(peak(p))) : ''}`;
  const latest = () => { read.textContent = T('now {0} · top {1}', fmt(value(points[points.length - 1])), fmt(top)); cursor.setAttribute('visibility', 'hidden'); };
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (points.length - 1))));
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible');
    read.textContent = stamp(points[i]);
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', latest);
  latest();
  wrap.append(svg, h('div', { class: 'load-chart-axis muted' },
    h('span', {}, clock(points[0].t)), h('span', {}, clock(points[points.length - 1].t))));
  return wrap;
}

function sharingSection(L) {
  const out = [h('div', { class: 'load-head' }, h('h3', { class: 'activity-head' }, T('Sharing')),
    segmented([[1, T('Last hour')], [24, T('Last day')]], state.houseHours || 1, async (hours) => {
      state.houseHours = hours; await loadHouse(); if (state.view === 'house') renderHouse();
    }, T('History')))];
  if (!L) { out.push(h('p', { class: 'muted' }, T('Couldn’t read the server’s load.'))); return out; }
  const lim = L.limits || {};

  const rows = [];
  const inet = L.internet || {};
  const upNow = (inet.streams || 0) + (inet.torrents || 0);
  const upMax = lim.uploadMbps ? (lim.uploadMbps * 1e6) / 8 : null;
  rows.push(loadRow(T('Internet upload'), [[inet.streams, null], [inet.torrents, 'is-alt']], upMax,
    T('{0}{1} Mbit/s', fmtMbit(upNow, false), upMax ? T(' of {0}', lim.uploadMbps) : ''),
    T('Marquee streams going out through Cloudflare, plus qBittorrent seeding. Set UPLOAD_MBPS in .env to the connection’s upload speed.')));
  rows.push(h('div', { class: 'load-legend muted' },
    h('span', {}, h('i', { class: 'load-key' }), T('streams {0}', fmtMbit(inet.streams))),
    inet.torrents != null && h('span', {}, h('i', { class: 'load-key is-alt' }), T('torrents {0}{1}', fmtMbit(inet.torrents), inet.torrentLimit ? T(' (capped at {0})', fmtMbit(inet.torrentLimit)) : '')),
    h('span', {}, T('home network {0}', fmtMbit(L.lan?.streams)))));
  if (L.net) {
    const link = lim.linkMbps ? (lim.linkMbps * 1e6) / 8 : null;
    rows.push(loadRow(T('Network card'), [[L.net.up, null]], link,
      T('↑ {0} · ↓ {1}{2} Mbit/s', fmtMbit(L.net.up, false), fmtMbit(L.net.down, false), link ? T(' of {0}', Math.round(lim.linkMbps)) : ''),
      T('Everything the server sends and receives, from every program.')));
  }
  if (L.cpu != null) rows.push(loadRow(T('CPU'), [[L.cpu, null]], 100, T('{0} %{1}', L.cpu, L.marqueeCpu != null ? T(' · Marquee {0} %', L.marqueeCpu) : '')));
  const g = L.gpu;
  if (g) {
    rows.push(loadRow(T('GPU encoder'), [[g.enc, null]], 100,
      T('{0} % · {1} of {2} encodes{3}', g.enc ?? 0, g.sessions ?? 0, lim.nvencSessions, g.temp != null ? ` · ${g.temp} °C` : ''),
      T('{0}: NVENC is the hardware encoder conversions use. GPU {1} % busy, decoder {2} %.', g.name, g.busy ?? 0, g.dec ?? 0)));
  }
  for (const d of (L.disks || []).filter((x) => x.label).sort((a, b) => (a.label === 'Media' ? -1 : b.label === 'Media' ? 1 : 0))) {
    rows.push(loadRow(T('{0} drive {1}:', T(d.label), d.drive), [[d.busy, null]], 100, T('{0} % busy · reads {1}/s', d.busy, fmtBytes(d.read)),
      T('Writes {0}/s. A drive near 100 % busy makes streams from it stutter.', fmtBytes(d.write))));
  }
  if (!L.sampled) rows.push(h('p', { class: 'muted load-note' }, T('Machine readings are starting (or only work on the Windows server); streams and jobs are still counted.')));

  const hist = L.history || [];
  const span = (state.houseHours || 1) === 24 ? T('last day') : T('last hour');
  out.push(h('div', { class: 'house-card' },
    (L.warnings || []).length > 0 && h('ul', { class: 'load-warnings' }, L.warnings.map((w) => h('li', {}, w))),
    rows,
    h('div', { class: 'load-charts' },
      loadChart(T('Internet upload'), hist, {
        value: (p) => (p.inet || 0) + (p.tor || 0), peak: (p) => (p.inetMax != null ? p.inetMax + (p.tor || 0) : null),
        fmt: (v) => fmtMbit(v), empty: T('History builds up a minute at a time ({0}).', span),
      }),
      loadChart('CPU', hist, { value: (p) => p.cpu, peak: (p) => p.cpuMax, max: 100, fmt: (v) => `${Math.round(v || 0)} %`, empty: T('History builds up a minute at a time ({0}).', span) }))));

  const streams = L.streams || [];
  out.push(h('div', { class: 'house-card' },
    h('div', { class: 'house-card-head' }, h('span', { class: 'row-title' }, streams.length ? T('Streaming now · {0}', streams.length) : T('Streaming now')),
      h('span', { class: 'muted house-seen' }, T('checked {0}', clock(L.at)))),
    !streams.length ? h('p', { class: 'muted' }, T('Nothing is being watched.'))
      : h('ul', { class: 'load-list' }, streams.map((s) => {
        const slow = s.behind;
        return h('li', {},
          h('span', { class: `activity-dot${slow ? ' is-bad' : ' is-on'}`, 'aria-hidden': 'true' }),
          h('div', { class: 'load-item' },
            h('span', { class: 'row-title' }, s.label),
            h('span', { class: 'row-meta' },
              h('span', {}, [s.who, s.device].filter(Boolean).join(' · ')),
              h('span', {}, s.where === 'internet' && s.fromHome ? T('internet (from home, via Cloudflare)') : WHERE[s.where] || s.where),
              h('span', {}, s.waiting ? T('buffered ahead') : T('{0} now', fmtMbit(s.rate))),
              s.speed > 0 && h('span', { title: T('How fast it arrives while being sent: the line’s speed for this viewer') }, T('arrives at {0}', fmtMbit(s.speed))),
              h('span', {}, T('avg {0}', fmtMbit(s.avg))),
              s.needs && h('span', { class: slow ? 'load-bad' : null }, T('file needs {0}', fmtMbit(s.needs))),
              h('span', {}, T('{0} sent · {1}', fmtBytes(s.sent), fmtFor(Date.now() - s.since))))));
      }))));

  const jobs = L.jobs || [];
  out.push(h('div', { class: 'house-card' },
    h('div', { class: 'house-card-head' }, h('span', { class: 'row-title' }, jobs.length ? T('Encoding now · {0}', jobs.length) : T('Encoding now'))),
    !jobs.length ? h('p', { class: 'muted' }, T('No clip copies, conversions or previews are being made.'))
      : h('ul', { class: 'load-list' }, jobs.map((j) => h('li', {},
        h('span', { class: 'activity-dot is-on', 'aria-hidden': 'true' }),
        h('div', { class: 'load-item' },
          h('span', { class: 'row-title' }, `${j.kind} · ${j.label}`),
          h('span', { class: 'row-meta' },
            j.encoder && h('span', {}, j.encoder),
            h('span', {}, j.cpu != null ? T('CPU {0} %', j.cpu) : T('CPU …')),
            j.mem && h('span', {}, T('RAM {0}', fmtBytes(j.mem))),
            j.percent != null && h('span', {}, `${j.percent} %${j.speed ? ` · ${j.speed}` : ''}`),
            h('span', {}, T('running {0}', fmtFor(Date.now() - j.since))))))))));

  const top = L.top || [];
  if (top.length) {
    out.push(h('div', { class: 'house-card' },
      h('div', { class: 'house-card-head' }, h('span', { class: 'row-title' }, T('Busiest programs'))),
      h('ul', { class: 'load-top' }, top.map((p) => h('li', {},
        h('span', { class: 'house-svc-name' }, p.name), h('span', { class: 'muted' }, T('{0} % CPU{1}{2}', p.cpu, p.mem ? ` · ${fmtBytes(p.mem)}` : '', p.job ? T(' · Marquee job') : '')))))));
  }

  const recent = L.recent || [];
  if (recent.length) {
    out.push(h('details', { class: 'house-card load-recent', open: state.houseRecentOpen || null, ontoggle: (e) => { state.houseRecentOpen = e.currentTarget.open; } },
      h('summary', { class: 'row-title' }, T('Recently finished · {0}', recent.length)),
      h('ul', { class: 'load-list' }, recent.map((r) => h('li', {},
        h('span', { class: `activity-dot${r.type === 'job' && r.ok === false ? ' is-bad' : ''}`, 'aria-hidden': 'true' }),
        h('div', { class: 'load-item' },
          h('span', { class: 'row-title' }, r.type === 'job' ? `${r.kind} · ${r.label}` : r.label),
          h('span', { class: 'row-meta' },
            h('span', {}, `${clock(r.start)}–${clock(r.end)} (${fmtFor(r.end - r.start)})`),
            r.type === 'stream' && h('span', {}, `${r.who} · ${WHERE[r.where] || r.where}`),
            r.type === 'stream' && h('span', {}, T('avg {0} · peak {1}{2}', fmtMbit(r.avg), fmtMbit(r.peak), r.needs ? T(' · needs {0}', fmtMbit(r.needs)) : '')),
            r.type === 'stream' && h('span', {}, T('{0} sent', fmtBytes(r.sent))),
            r.type === 'job' && r.encoder && h('span', {}, r.encoder),
            r.type === 'job' && r.cpu != null && h('span', {}, T('CPU avg {0} %{1}', r.cpu, r.peak ? T(', peak {0} %', r.peak) : '')),
            r.type === 'job' && r.ok === false && h('span', { class: 'load-bad' }, T('failed')))))))));
  }
  return out;
}

function meter(used, size) {
  const pct = size ? Math.round((100 * used) / size) : 0;
  return h('span', { class: `meter${pct >= 90 ? ' is-full' : ''}`, title: T('{0} % used', pct) }, h('i', { style: `width:${pct}%` }));
}
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return T('just now');
  if (s < 5400) return T('{0} min ago', Math.round(s / 60));
  if (s < 129600) return T('{0} h ago', Math.round(s / 3600));
  return T('{0} days ago', Math.round(s / 86400));
};
const upFor = (secs) => (secs >= 86400 ? T('up {0} d {1} h', Math.floor(secs / 86400), Math.floor((secs % 86400) / 3600)) : T('up {0} h {1} min', Math.floor(secs / 3600), Math.floor((secs % 3600) / 60)));
function diskRows(disks, label = (d) => (d.label ? T(d.label) : d.mount)) {
  return disks.map((d) => h('div', { class: 'house-disk' },
    h('span', { class: 'house-disk-name' }, label(d)),
    meter(d.used, d.size),
    h('span', { class: 'house-disk-free' }, T('{0} free', fmtBytes(d.size - d.used)))));
}

function renderHouse() {
  const body = $('#house-body');
  if (state.houseTab === 'screentime') { body.replaceChildren(houseTabs(), ...screenTimeView()); return; }
  if (state.houseError) { body.replaceChildren(houseTabs(), notice(T('Couldn’t check the house'), state.houseError, () => loadHouse().then(renderHouse))); return; }
  const r = state.house;
  if (!r) return;
  const q = norm(state.query);
  const out = [houseTabs()];
  out.push(r.issues.length
    ? h('div', { class: 'house-status has-issues' },
      h('strong', {}, r.issues.length === 1 ? T('1 thing needs a look') : T('{0} things need a look', r.issues.length)),
      h('ul', {}, r.issues.map((i) => h('li', {}, i))))
    : h('div', { class: 'house-status' }, h('strong', {}, T('Everything’s fine')), h('span', { class: 'muted' }, T(' · checked {0}', clock(r.checkedAt)))));

  const sv = r.server;
  if (!q || norm(`server ${sv.name}`).includes(q)) {
    out.push(h('h3', { class: 'activity-head' }, T('Server')));
    out.push(h('div', { class: 'house-card' },
      h('div', { class: 'house-card-head' },
        h('span', { class: 'row-title' }, sv.name),
        h('span', { class: 'row-meta' }, h('span', {}, upFor(sv.uptime)), sv.cpu != null && h('span', {}, T('CPU {0} %', sv.cpu)),
          h('span', {}, T('RAM {0} / {1}', fmtBytes(sv.mem.total - sv.mem.avail), fmtBytes(sv.mem.total))))),
      diskRows(sv.disks),
      h('ul', { class: 'house-services' }, sv.services.map((x) => h('li', {},
        h('span', { class: `activity-dot${x.ok ? ' is-on' : ' is-bad'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'house-svc-name' }, x.name), h('span', { class: 'muted' }, x.detail))))));
  }

  if (!q || norm(`vpn mullvad tunnel torrent ${r.machines.map((m) => m.host).join(' ')}`).includes(q)) {
    const card = vpnCard(r);
    if (card) out.push(h('h3', { class: 'activity-head' }, T('VPN')), card);
  }

  if (!q || norm('sharing streams streaming encoding upload cpu gpu').includes(q)) out.push(...sharingSection(state.houseLoad));

  const powered = (r.power || []).filter((pw) => !q || norm(`power ${pw.host} ${pw.entries.map((e) => e.label).join(' ')}`).includes(q));
  if (powered.length) {
    out.push(h('h3', { class: 'activity-head' }, T('Power')));
    for (const pw of powered) out.push(powerCard(pw));
  }

  out.push(h('h3', { class: 'activity-head' }, T('Machines')));
  const machines = r.machines.filter((m) => !q || norm(`${m.host} ${m.kind} ${m.os}`).includes(q));
  if (!r.agents) out.push(h('p', { class: 'muted' }, T('Set HOUSE_TOKEN in .env and run agents/marquee-house on each machine to see them here.')));
  else if (!machines.length) out.push(h('p', { class: 'muted' }, q ? T('Nothing matches.') : T('No machine has reported yet.')));
  for (const m of machines) {
    const meta = [m.kind, m.os, m.kernel, m.uptime != null && upFor(m.uptime),
      m.battery && T('battery {0} %{1}', m.battery.pct, m.battery.status && m.battery.status !== 'Unknown' ? ` (${m.battery.status.toLowerCase()})` : ''),
      m.updates ? T('{0} updates', m.updates) : m.updates === 0 && T('up to date'),
      m.secureBoot != null && T('Secure Boot {0}', m.secureBoot ? 'on' : 'OFF'),
      m.lastBackup ? T('backup {0}', ago(m.lastBackup * 1000)) : T('no backups')].filter(Boolean);
    out.push(h('div', { class: `house-card${m.away ? ' is-away' : ''}` },
      h('div', { class: 'house-card-head' },
        h('span', { class: `activity-dot${m.away ? '' : m.issues.length ? ' is-bad' : ' is-on'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'row-title' }, m.host),
        h('span', { class: 'muted house-seen' }, m.away ? T('away · last seen {0}', ago(m.at)) : T('reported {0}', ago(m.at)))),
      h('div', { class: 'row-meta' }, meta.map((t) => h('span', {}, t))),
      diskRows(m.disks, (d) => d.mount),
      m.failed.length > 0 && h('p', { class: 'house-failed' }, T('Failed: {0}', m.failed.join(', ')))));
  }
  body.replaceChildren(...out);
}

// VPN: the server's torrent tunnel (only qBittorrent uses it) and the Mullvad app on each machine.
// One row each: up/down dot, where it exits, then leaks, drops and watchdog problems underneath.
function vpnCard(r) {
  const when = (ms) => (Date.now() - ms < 86400000 ? clock(ms) : new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' }));
  const where = (v) => [v.city, v.relay, v.exitIp].filter(Boolean).join(' · ');
  const rows = [];
  const sv = r.server.vpn;
  if (sv) {
    rows.push({
      name: `${r.server.name} · torrents`, ok: sv.ok, on: sv.tunnel === 'up',
      text: sv.tunnel === 'up' ? T('Tunnel up · {0}', where(sv) || T('checking exit')) : T('Tunnel DOWN · torrents fenced in by the kill switch'),
      notes: [
        sv.torrentIp && T('qBittorrent public address {0}', sv.torrentIp),
        sv.mullvadExit === false && T('exit isn’t a Mullvad address'),
        sv.lastDropAt && T('last drop {0}', when(sv.lastDropAt)),
        sv.lastLeakAt && T('last leak alarm {0}', when(sv.lastLeakAt)),
      ].filter(Boolean),
      problems: sv.problems,
    });
  }
  for (const m of r.machines) {
    const v = m.vpn;
    if (!v) continue;
    const on = v.state === 'connected';
    rows.push({
      name: m.host, ok: v.state !== 'error' && v.mullvadExit !== false, on: on && !m.away, away: m.away,
      text: on ? T('Connected · {0}', where(v)) : v.state === 'error' ? T('Blocked (error state)') : v.state === 'connecting' ? T('Connecting…') : T('Disconnected'),
      notes: [
        v.lockdown != null && T('lockdown {0}', v.lockdown ? 'on' : 'off'),
        v.lastDrop && T('last drop {0}', when(v.lastDrop * 1000)),
        m.away && T('away · last seen {0}', ago(m.at)),
      ].filter(Boolean),
      problems: [v.error, v.mullvadExit === false && on && T('exit isn’t a Mullvad address')].filter(Boolean),
    });
  }
  if (!rows.length) return null;
  return h('div', { class: 'house-card vpn-card' },
    h('ul', { class: 'house-services' }, rows.map((x) => h('li', { class: 'vpn-row' },
      h('span', { class: `activity-dot${x.away ? '' : !x.ok ? ' is-bad' : x.on ? ' is-on' : ''}`, 'aria-hidden': 'true' }),
      h('div', { class: 'vpn-main' },
        h('div', {}, h('span', { class: 'house-svc-name' }, x.name), ' ', h('span', { class: 'muted' }, x.text)),
        x.notes.length > 0 && h('div', { class: 'row-meta' }, x.notes.map((t) => h('span', {}, t))),
        x.problems.map((p) => h('p', { class: 'house-failed' }, p)))))));
}

// Wake a dual-boot machine into the system you pick, or restart it into another one (house.js,
// "power"). Waking into Windows boots Linux first, which hands over to Windows within a few seconds.
function powerCard(pw) {
  const p = pw.pending;
  const status = p
    ? (p.action === 'wake' ? T('Waking up{0}…', p.label ? T(' into {0}', p.label) : '') : T('Restarting{0}…', p.label ? T(' into {0}', p.label) : ''))
    : pw.on ? T('On · {0}', pw.os || 'Linux') : T('Off, or in Windows');
  const sub = !pw.on && !p && (pw.last?.entry && pw.last.at > pw.seen - 120000
    ? T('Last started into {0} from Marquee {1}', pw.last.label, ago(pw.last.at))
    : T('Linux last answered {0}', ago(pw.seen)));
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
        b.textContent = T('Tap again to restart');
        setTimeout(() => { if (b.isConnected && !b.disabled) { delete b.dataset.sure; b.classList.remove('is-sure'); b.textContent = label; } }, 4000);
      },
    }, label);
    buttons = [...linuxFirst.filter((e) => !e.current).map((e) => sure(T('Restart into {0}', e.label), e.title)), sure(T('Restart'), null)];
  } else {
    buttons = linuxFirst.map((e) => h('button', {
      type: 'button', class: `retry${e.os === 'linux' ? ' is-primary' : ''}`, disabled: !pw.canWake || p?.action === 'wake',
      onclick: (ev) => doPower(pw.host, 'wake', e.title, ev.currentTarget),
    }, T('Start {0}', e.label)));
    if (!buttons.length) buttons = [h('button', { type: 'button', class: 'retry is-primary', disabled: !pw.canWake, onclick: (ev) => doPower(pw.host, 'wake', null, ev.currentTarget) }, T('Turn on'))];
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

// ---------- house → screen time (screentime.js) ----------
// iPhone-style Screen Time from the `screentime` daemon on each machine: a day with hourly bars,
// or a week with the daily average, plus most used apps, pickups and the longest session.
const ST_COLORS = ['social', 'games', 'entertainment', 'web', 'development', 'productivity', 'creativity', 'education', 'utilities'];
const stColor = (category) => {
  const key = String(category || '').toLowerCase().split(/[^a-z]/)[0];
  return ST_COLORS.includes(key) ? `st-c-${key}` : 'st-c-other';
};
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shiftDate = (date, n) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + n); return localDate(d); };
const stDate = (date, opts) => new Date(`${date}T12:00:00`).toLocaleDateString(langTag, opts);
function fmtDur(s) {
  s = Math.round(s || 0);
  if (!s) return '0m';
  if (s < 60) return '<1m';
  const hrs = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60);
  return hrs ? `${hrs}h ${pad2(min)}m` : `${min}m`;
}

const HOUR_AXIS = Array.from({ length: 24 }, (_, i) => (i % 6 ? null : pad2(i)));
// Gridline labels like iOS: 30m, 60m, 1h 30m, 4h
const stAxisLabel = (s) => (s <= 3600 ? `${Math.round(s / 60)}m` : s % 3600 ? fmtDur(s) : `${s / 3600}h`);

async function loadScreenTime() {
  const st = (state.st ||= { view: 'day', list: 'apps' });
  const q = new URLSearchParams({ today: localDate() });
  if (st.device) q.set('device', st.device);
  if (st.date) q.set('date', st.date);
  try { st.data = await api(`/api/house/screentime?${q}`); st.error = null; } catch (err) { st.error = err.message; }
}

async function stPick(changes) {
  Object.assign(state.st, changes);
  await loadScreenTime();
  if (state.view === 'house') renderHouse();
}

function houseTabs() {
  return h('div', { class: 'house-tabs' }, segmented([['overview', T('Overview')], ['screentime', T('Screen Time')]], state.houseTab || 'overview', async (tab) => {
    state.houseTab = tab;
    await loadHouse();
    if (state.view === 'house') renderHouse();
  }, T('House page')));
}

// Top three categories get their colour; everything else is "Other", like iOS.
function stLeaders(categories) {
  return (categories || []).filter((c) => c.name !== 'Other').slice(0, 3).map((c) => c.name);
}

// Stacked bars as plain elements (themeable with CSS). cols: [{ label, title, parts: {cat: s}, total, onclick? }]
function stChart(cols, { top, gridLabel, midLabel, avg, axis, label, leaders }) {
  const chart = h('div', { class: `st-chart${cols.length > 7 ? ' is-hourly' : ''}`, role: 'img', 'aria-label': label });
  const plot = h('div', { class: 'st-plot' },
    h('i', { class: 'st-gridline is-top' }, h('span', {}, gridLabel)),
    h('i', { class: 'st-gridline is-mid' }, midLabel && h('span', {}, midLabel)),
    avg != null && avg > 0 && h('i', { class: 'st-avg', style: `bottom:${Math.min(100, (100 * avg) / top)}%` }, h('span', {}, T('avg'))));
  for (const c of cols) {
    const segs = [];
    let other = c.total || 0;
    for (const name of leaders) {
      const v = c.parts[name] || 0;
      if (v > 0) { segs.push(h('i', { class: stColor(name), style: `height:${(100 * v) / (c.total || 1)}%` })); other -= v; }
    }
    if (other > 1) segs.push(h('i', { class: 'st-c-other', style: `height:${(100 * other) / (c.total || 1)}%` }));
    const height = c.total ? Math.max(2, Math.min(100, (100 * c.total) / top)) : 0;
    const bar = h(c.onclick ? 'button' : 'span', {
      class: `st-col${c.current ? ' is-current' : ''}`, title: c.title, type: c.onclick ? 'button' : null, onclick: c.onclick,
      'aria-label': c.onclick ? c.title : null,
    }, h('span', { class: 'st-stack', style: `height:${height}%` }, segs.reverse()));
    plot.append(bar);
  }
  chart.append(plot, h('div', { class: 'st-axis muted' }, axis.map((t) => h('span', {}, t || ''))));
  return chart;
}

function stLegend(categories, leaders) {
  const rows = leaders.map((name) => [name, categories.find((c) => c.name === name)?.seconds || 0]);
  return h('div', { class: 'st-legend' }, rows.map(([name, s]) =>
    h('span', {}, h('i', { class: `st-dot ${stColor(name)}` }), h('b', {}, name), ` ${fmtDur(s)}`)));
}

function stMostUsed(apps, categories) {
  const st = state.st;
  const showApps = st.list !== 'categories';
  const items = showApps ? apps : categories.map((c) => ({ name: c.name, category: c.name, seconds: c.seconds }));
  const best = items[0]?.seconds || 1;
  const shown = st.more ? items : items.slice(0, 8);
  return h('section', { class: 'st-card' },
    h('div', { class: 'st-card-head' }, h('h4', {}, T('Most used')),
      segmented([['apps', T('Apps')], ['categories', T('Categories')]], showApps ? 'apps' : 'categories', (list) => { st.list = list; st.more = false; renderHouse(); }, T('Most used by'))),
    items.length ? h('ol', { class: 'st-apps' }, shown.map((a) => h('li', {},
      h('span', { class: `st-icon ${stColor(a.category)}`, 'aria-hidden': 'true' }, (a.name || '?').trim().charAt(0).toUpperCase()),
      h('span', { class: 'st-app-main' },
        h('span', { class: 'st-app-line' }, h('span', { class: 'st-app-name' }, a.name), h('span', { class: 'st-app-time' }, fmtDur(a.seconds))),
        h('span', { class: 'st-app-bar' }, h('i', { class: stColor(a.category), style: `width:${Math.max(1.5, (100 * a.seconds) / best)}%` })),
        showApps && h('span', { class: 'st-app-cat muted' }, a.category)))))
      : h('p', { class: 'muted' }, T('Nothing used yet.')),
    items.length > 8 && h('button', { type: 'button', class: 'st-more', onclick: () => { st.more = !st.more; renderHouse(); } }, st.more ? T('Show less') : T('Show {0} more', items.length - 8)));
}

function stDayView(D) {
  const s = D.day;
  const out = [];
  if (!s) {
    out.push(h('section', { class: 'st-card st-hero' }, h('p', { class: 'st-eyebrow' }, T('Screen time')), h('p', { class: 'st-big' }, '0m'),
      h('p', { class: 'muted' }, D.date === localDate() ? T('Nothing yet today on this device.') : T('Nothing recorded this day.'))));
    return out;
  }
  const leaders = stLeaders(s.categories);
  const peak = Math.max(0, ...s.hourly.map((x) => x.seconds));
  const top = Math.max(3600, Math.ceil(peak / 1800) * 1800);
  const avg = D.week?.average;
  const diff = avg ? Math.round((100 * (s.total - avg)) / avg) : null;
  out.push(h('section', { class: 'st-card st-hero' },
    h('p', { class: 'st-eyebrow' }, T('Screen time')),
    h('div', { class: 'st-big-row' }, h('p', { class: 'st-big' }, fmtDur(s.total)),
      diff != null && D.week.days.filter((d) => d.total != null).length > 1 && h('span', { class: 'st-pill' },
        T('{0} {1}% {2} this week’s average', diff > 0 ? '↑' : diff < 0 ? '↓' : '=', Math.abs(diff), diff >= 0 ? T('above') : T('below')))),
    stChart(s.hourly.map((x, i) => ({ total: x.seconds, parts: x.categories, title: `${pad2(i)}:00 · ${fmtDur(x.seconds)}` })), {
      top, gridLabel: stAxisLabel(top), midLabel: stAxisLabel(top / 2), axis: HOUR_AXIS, leaders,
      label: T('Screen time by hour: {0} in total, busiest hour {1}', fmtDur(s.total), fmtDur(peak)),
    }),
    stLegend(s.categories, leaders),
    h('p', { class: 'st-updated muted' }, `${s.complete ? T('Complete day') : T('Updated')} · ${clock(s.generated * 1000)}${state.st.device === 'all' ? T(' · {0} devices', D.devices.length) : ''}`)));

  const grid = h('div', { class: 'st-grid' }, stMostUsed(s.apps, s.categories));
  const ptop = Math.max(1, ...s.pickupsHourly);
  grid.append(h('section', { class: 'st-card' },
    h('div', { class: 'st-card-head' }, h('h4', {}, T('Pickups'))),
    h('div', { class: 'st-stat-row' },
      h('div', {}, h('p', { class: 'st-num' }, String(s.pickups)), h('p', { class: 'muted' }, T('wakes and unlocks'))),
      h('div', {}, h('p', { class: 'st-num' }, s.firstPickup || '—'), h('p', { class: 'muted' }, T('first pickup')))),
    h('div', { class: 'st-ticks', role: 'img', 'aria-label': T('Pickups by hour, at most {0} in an hour', ptop) },
      s.pickupsHourly.map((n, i) => h('i', { title: (n === 1 ? T('{0}:00 · {1} pickup', pad2(i), n) : T('{0}:00 · {1} pickups', pad2(i), n)), style: `height:${n ? Math.max(12, (100 * n) / ptop) : 0}%` }))),
    h('div', { class: 'st-axis muted' }, HOUR_AXIS.map((t) => h('span', {}, t || ''))),
    s.afterPickup.length > 0 && h('div', { class: 'st-after' }, h('p', { class: 'st-sub' }, T('First used after pickup')),
      h('ul', {}, s.afterPickup.slice(0, 4).map((a) => h('li', {}, h('span', {}, a.name), h('span', { class: 'muted' }, String(a.count)))))),
    s.longest && h('div', { class: 'st-after' }, h('p', { class: 'st-sub' }, T('Longest session')),
      h('p', { class: 'st-longest' }, h('b', {}, fmtDur(s.longest.seconds)),
        h('span', { class: 'muted' }, ` ${s.longest.start}–${s.longest.end}${s.longest.name ? T(' · mostly {0}', s.longest.name) : ''}`)))));
  out.push(grid);
  return out;
}

function stWeekView(D) {
  const w = D.week;
  const leaders = stLeaders(w.categories);
  const peak = Math.max(0, ...w.days.map((d) => d.total || 0), w.average || 0);
  const top = Math.max(3600, Math.ceil(peak / 3600) * 3600);
  const today = localDate();
  const out = [h('section', { class: 'st-card st-hero' },
    h('p', { class: 'st-eyebrow' }, T('Daily average')),
    h('div', { class: 'st-big-row' }, h('p', { class: 'st-big' }, fmtDur(w.average)),
      w.change != null && h('span', { class: 'st-pill' }, T('{0} {1}% from last week', w.change > 0 ? '↑' : w.change < 0 ? '↓' : '=', Math.abs(w.change)))),
    stChart(w.days.map((d) => ({
      total: d.total || 0, parts: d.categories, current: d.date === today,
      title: `${stDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' })} · ${d.total == null ? T('no data') : fmtDur(d.total)}`,
      onclick: d.total == null ? null : () => stPick({ view: 'day', date: d.date }),
    })), {
      top, gridLabel: stAxisLabel(top), midLabel: stAxisLabel(top / 2), avg: w.average, leaders,
      axis: w.days.map((d) => stDate(d.date, { weekday: 'short' }).slice(0, 1)),
      label: T('Screen time per day: daily average {0}', fmtDur(w.average)),
    }),
    stLegend(w.categories, leaders),
    h('div', { class: 'st-week-stats' },
      h('span', {}, h('b', {}, fmtDur(w.total)), h('span', { class: 'muted' }, T(' total'))),
      h('span', {}, h('b', {}, String(w.pickups)), h('span', { class: 'muted' }, T(' pickups · {0} a day', w.pickupsAverage))),
      w.longest && h('span', {}, h('b', {}, fmtDur(w.longest.seconds)), h('span', { class: 'muted' }, T(' longest session')))))];
  out.push(h('div', { class: 'st-grid' }, stMostUsed(w.apps, w.categories)));
  return out;
}

function screenTimeView() {
  const st = (state.st ||= { view: 'day', list: 'apps' });
  const D = st.data;
  if (st.error) return [notice(T('Couldn’t load Screen Time'), st.error, () => stPick({}))];
  if (!D) return [h('p', { class: 'muted' }, T('Loading…'))];
  if (!D.devices.length) {
    return [h('section', { class: 'st-card st-setup' },
      h('h4', {}, T('No Screen Time yet')),
      h('p', { class: 'muted' }, D.configured
        ? T('Install screentime on a machine and point its push at this server: set [push] url to /api/screentime here and the token to SCREENTIME_TOKEN.')
        : T('Set SCREENTIME_TOKEN in .env, restart Marquee, then point each machine’s screentime push at /api/screentime with that token.')),
      h('a', { href: 'https://github.com/Tjabooo/screentime', target: '_blank', rel: 'noopener' }, T('github.com/Tjabooo/screentime')))];
  }
  const today = localDate();
  const devices = D.devices.length > 1 ? [['all', T('All devices')], ...D.devices.map((d) => [d.name, d.name])] : D.devices.map((d) => [d.name, d.name]);
  const week = st.view === 'week';
  const date = D.date;
  let title;
  if (week) {
    const thisWeek = D.week.start <= today && today <= D.week.end;
    const lastWeek = shiftDate(D.week.start, 7) <= today && today <= shiftDate(D.week.end, 7);
    title = thisWeek ? T('This week') : lastWeek ? T('Last week')
      : `${stDate(D.week.start, { day: 'numeric', month: 'short' })} – ${stDate(D.week.end, { day: 'numeric', month: 'short' })}`;
  } else {
    title = date === today ? T('Today') : date === shiftDate(today, -1) ? T('Yesterday') : stDate(date, { weekday: 'long', day: 'numeric', month: 'long' });
  }
  const step = week ? 7 : 1;
  const first = D.dates[0] || date;
  const canBack = week ? D.week.start > first : date > first;
  const canForward = week ? D.week.end < today : date < today;
  const seen = D.devices.find((d) => d.name === D.device);
  const out = [
    h('div', { class: 'st-controls' },
      segmented(devices, D.device, (device) => stPick({ device }), T('Device')),
      segmented([['day', T('Day')], ['week', T('Week')]], week ? 'week' : 'day', (view) => stPick({ view }), T('Period'))),
    h('div', { class: 'st-datebar' },
      h('button', { type: 'button', class: 'st-step', disabled: !canBack, 'aria-label': week ? T('Previous week') : T('Previous day'), onclick: () => stPick({ date: shiftDate(date, -step) }) }, '‹'),
      h('div', { class: 'st-date' }, h('strong', {}, title),
        h('span', { class: 'muted' }, week ? `${stDate(D.week.start, { day: 'numeric', month: 'short' })} – ${stDate(D.week.end, { day: 'numeric', month: 'short' })}`
          : seen?.lastSeen ? T('{0} last reported {1}', seen.name, ago(seen.lastSeen)) : stDate(date, { weekday: 'short', day: 'numeric', month: 'short' }))),
      h('button', { type: 'button', class: 'st-step', disabled: !canForward, 'aria-label': week ? T('Next week') : T('Next day'), onclick: () => stPick({ date: shiftDate(date, step) > today ? today : shiftDate(date, step) }) }, '›')),
  ];
  return out.concat(week ? stWeekView(D) : stDayView(D));
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
    else toast(T('Preparing a Discord-friendly copy… the link is ready in a minute.'));
  } catch (err) { toast(err.message); }
  await loadClips();
  renderClips();
}
const copyLink = (url) => copyWithToast(url, T('Link copied: paste it in Discord'));
// ---------- clip editor (lossless: never a lossy re-encode) ----------
// The clip is a row of parts on a timeline. Split at the playhead, then remove the parts you don't
// want; trimming the start or end is the same thing at the edges. What's kept is joined into a new
// file. AV1 clips (`exact` from the server) cut on the exact frame: the frames between a cut and the
// next keyframe are rebuilt losslessly, the rest is copied. Other clips can only start a kept stretch
// on a keyframe, so it may begin a little early: the timeline shows that lead-in, and a cut too
// short to clear the next keyframe is flagged before saving.
const fmtT = (t) => { const d = Math.round(t * 10); return `${Math.floor(d / 600)}:${((d % 600) / 10).toFixed(1).padStart(4, '0')}`; };
const EDIT_ICONS = {
  split: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.5 20 18M8.6 16.5 20 6"/></svg>',
  start: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v16M19 12H9M13 8l-4 4 4 4"/></svg>',
  end: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4v16M5 12h10M11 8l4 4-4 4"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
};
async function openTrim(c, opener) {
  const video = h('video', { class: 'edit-video', src: `/api/clips/${c.id}/video`, playsinline: true, preload: 'auto' });
  try { video.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('player:volume') ?? 1))); video.muted = localStorage.getItem('player:muted') === '1'; } catch { /* blocked */ }
  let duration = 0;
  let keys = [0];
  let exact = false;      // the server can cut this clip on any frame
  let frameDur = 1 / 30;  // one frame, for , and .
  let pieces = [];        // [{ start, end, keep }] covering the whole clip, in order
  let tracks = [];        // the clip's audio tracks (from the server); the mix isn't offered
  const removed = new Set();
  const undo = [];
  let busy = false;
  const MIN_PIECE = 0.2;  // seconds; no slivers from double-clicking Split
  const snap = (t) => (exact ? t : keys.filter((k) => k <= t + 0.001).pop() ?? 0);
  // an exact cut that doesn't land on a keyframe's own frame gets a losslessly rebuilt lead-in
  const offKey = (t) => t > 0.0005 && !keys.some((k) => t >= k - 0.0005 && t < k + frameDur - 0.0005);
  // Kept stretches: neighbouring kept parts merge; `from` is where the copy really starts.
  const runs = () => {
    const out = [];
    for (const p of pieces) {
      if (!p.keep) continue;
      const last = out.at(-1);
      if (last && Math.abs(last.end - p.start) < 0.001) last.end = p.end;
      else out.push({ start: p.start, end: p.end });
    }
    for (const r of out) r.from = snap(r.start);
    return out;
  };
  const problem = (list) => {
    if (!list.length) return T('Everything is removed. Restore a part to keep it.');
    for (let i = 1; i < list.length; i++) {
      if (list[i].from < list[i - 1].end - 0.001) return T('The cut at {0} is too short to remove without re-encoding: the next part has to start on the keyframe at {1}. Make the cut longer, or restore it.', fmtT(list[i - 1].end), fmtT(list[i].from));
    }
    if (list.some((r) => r.end - r.start < 0.3)) return T('A kept part is shorter than 0.3 s. Remove it or make it longer.');
    if (list.reduce((n, r) => n + r.end - r.from, 0) < 1) return T('The edit has to be at least 1 second long.');
    return '';
  };
  const pieceAt = (t) => pieces.find((p) => t >= p.start && t < p.end) || pieces.at(-1);
  const remember = () => { undo.push(pieces.map((p) => ({ ...p }))); if (undo.length > 100) undo.shift(); };
  const split = (t) => {
    const p = pieceAt(t);
    if (!p || t - p.start < MIN_PIECE || p.end - t < MIN_PIECE) return false;
    pieces.splice(pieces.indexOf(p), 1, { start: p.start, end: t, keep: p.keep }, { start: t, end: p.end, keep: p.keep });
    return true;
  };
  const act = (what) => {
    if (!duration || busy) return;
    const t = video.currentTime;
    remember();
    const before = JSON.stringify(pieces);
    if (what === 'split' && !split(t)) toast(T('Too close to a split already'));
    if (what === 'toggle') { const p = pieceAt(t); p.keep = !p.keep; }
    if (what === 'start') { split(t); for (const p of pieces) if (p.end <= t + 0.001) p.keep = false; }
    if (what === 'end') { split(t); for (const p of pieces) if (p.start >= t - 0.001) p.keep = false; }
    if (JSON.stringify(pieces) === before) undo.pop();
    render();
  };
  const undoLast = () => { if (undo.length && !busy) { pieces = undo.pop(); render(); } };

  // ---- timeline ----
  const track = h('div', { class: 'edit-track' });
  const head = h('div', { class: 'edit-head' });
  const hover = h('div', { class: 'edit-hover', hidden: true });
  const timeline = h('div', { class: 'edit-timeline', role: 'slider', tabindex: 0, 'aria-label': T('Position in the clip'), 'aria-valuemin': 0 }, track, head, hover);
  const pos = (t) => `${duration ? (t / duration) * 100 : 0}%`;
  const timeAt = (x) => { const r = timeline.getBoundingClientRect(); return Math.min(Math.max((x - r.left) / r.width, 0), 1) * duration; };
  let scrubbing = false;
  timeline.addEventListener('pointerdown', (e) => {
    if (!duration) return;
    timeline.setPointerCapture(e.pointerId); scrubbing = true;
    video.currentTime = timeAt(e.clientX); updateHead();
  });
  timeline.addEventListener('pointermove', (e) => {
    if (!duration) return;
    if (scrubbing) { video.currentTime = timeAt(e.clientX); updateHead(); }
    if (e.pointerType === 'mouse' || scrubbing) {
      const t = timeAt(e.clientX);
      hover.hidden = false; hover.textContent = fmtT(t); hover.style.left = pos(t);
    }
  });
  const stopScrub = () => { scrubbing = false; };
  timeline.addEventListener('pointerup', stopScrub);
  timeline.addEventListener('pointercancel', stopScrub);
  timeline.addEventListener('pointerleave', () => { if (!scrubbing) hover.hidden = true; });

  // ---- controls ----
  const playBtn = h('button', { type: 'button', class: 'edit-play', 'aria-label': T('Play (Space)') });
  const now = h('span', { class: 'edit-now' }, '0:00.0');
  const total = h('span', { class: 'edit-total' }, '');
  const tool = (key, label, what, hint) => {
    const b = h('button', { type: 'button', class: 'edit-tool', title: hint, onclick: () => act(what) }, h('span', { class: 'edit-tool-label' }, label));
    b.insertAdjacentHTML('afterbegin', EDIT_ICONS[key]);
    return b;
  };
  const startBtn = tool('start', T('Start here'), 'start', T('Remove everything before the playhead ([)'));
  const splitBtn = tool('split', T('Split'), 'split', T('Split the clip at the playhead (S)'));
  const endBtn = tool('end', T('End here'), 'end', T('Remove everything after the playhead (])'));
  const toggleBtn = tool('remove', T('Remove part'), 'toggle', T('Remove or restore the part under the playhead (X)'));
  const undoBtn = h('button', { type: 'button', class: 'edit-tool edit-undo', title: T('Undo (Ctrl+Z)'), 'aria-label': T('Undo'), onclick: undoLast });
  undoBtn.innerHTML = EDIT_ICONS.undo;
  const info = h('p', { class: 'edit-info', role: 'status' }, T('Loading the clip…'));
  // Audio: keep or leave out each separate track. Track 1 (the mix every player plays) is rebuilt.
  const trackRow = h('div', { class: 'edit-tracks', hidden: true });
  function renderTracks() {
    const own = tracks.filter((t) => !t.mix);
    trackRow.hidden = own.length < 2 && !tracks.some((t) => t.mix);
    if (trackRow.hidden) return;
    trackRow.replaceChildren(h('span', { class: 'edit-tracks-label' }, T('Audio')), ...own.map((t) => {
      const kept = !removed.has(t.index);
      const label = t.mic ? T('{0} (mic)', t.label) : t.label;
      return h('button', { type: 'button', class: `edit-chip${kept ? '' : ' is-off'}`, 'aria-pressed': String(kept),
        title: kept ? T('Leave {0} out of the copy', label) : T('Keep {0}', label),
        onclick: () => { if (busy) return; if (kept) removed.add(t.index); else removed.delete(t.index); renderTracks(); render(); } }, label);
    }));
  }
  const delOrig = h('input', { type: 'checkbox', id: 'trim-del' });
  const previewBtn = h('button', { type: 'button', class: 'retry', onclick: () => { const r = runs(); if (!r.length) return; video.currentTime = r[0].from; video.play().catch(() => {}); } }, T('Preview'));
  const save = h('button', { type: 'button', class: 'play-btn edit-save', disabled: true }, T('Save edited copy'));

  function updateHead() {
    const t = video.currentTime;
    head.style.left = pos(t);
    now.textContent = fmtT(t);
    timeline.setAttribute('aria-valuemax', String(Math.round(duration * 10) / 10));
    timeline.setAttribute('aria-valuenow', String(Math.round(t * 10) / 10));
    timeline.setAttribute('aria-valuetext', `${fmtT(t)} of ${fmtT(duration)}`);
    const p = duration && pieceAt(t);
    const removing = !p || p.keep;
    toggleBtn.querySelector('svg')?.remove();
    toggleBtn.insertAdjacentHTML('afterbegin', EDIT_ICONS[removing ? 'remove' : 'restore']);
    toggleBtn.querySelector('.edit-tool-label').textContent = removing ? T('Remove part') : T('Restore part');
    toggleBtn.classList.toggle('is-restore', !removing);
  }
  function render() {
    if (!duration) return;
    const list = runs();
    const issue = problem(list);
    const out = [];
    for (const p of pieces) {
      out.push(h('div', { class: `edit-piece ${p.keep ? 'is-kept' : 'is-cut'}`, style: `left:${pos(p.start)};width:${pos(p.end - p.start)}` }));
    }
    list.forEach((r, i) => {
      if (r.from < r.start - 0.01) {
        const clash = i > 0 && r.from < list[i - 1].end - 0.001;
        out.push(h('div', { class: `edit-lead${clash ? ' is-clash' : ''}`, title: T('Starts on the keyframe at {0}', fmtT(r.from)), style: `left:${pos(r.from)};width:${pos(r.start - r.from)}` }));
      }
    });
    for (const p of pieces.slice(1)) out.push(h('div', { class: 'edit-split', style: `left:${pos(p.start)}` }));
    track.replaceChildren(...out);
    const length = list.reduce((n, r) => n + r.end - r.from, 0);
    const early = list.some((r) => r.from < r.start - 0.05);
    total.textContent = T('of {0}', fmtT(duration));
    info.classList.toggle('is-error', Boolean(issue));
    const gone = tracks.filter((t) => removed.has(t.index)).map((t) => t.mic ? T('{0} (mic)', t.label) : t.label);
    const remix = gone.length && tracks.some((t) => t.mix) && tracks.filter((t) => !t.mix && !removed.has(t.index)).length > 1;
    info.textContent = issue || T('{0} · {1} long{2}{3} · {4}', list.length === 1 ? T('Keeping 1 part') : T('Keeping {0} parts', list.length), fmtT(length), early ? T(' · striped bits are kept so each part starts on a keyframe') : '', gone.length ? T(' · without {0}', gone.join(' and ')) : '', exact && list.some((r) => offKey(r.start)) ? T('exact cuts, every frame identical to the original{0}', remix ? T(', the mix re-encoded') : '') : remix ? T('video untouched, only the mix is re-encoded') : T('no re-encoding, same quality'));
    save.disabled = busy || Boolean(issue);
    save.textContent = busy ? T('Saving…') : list.length > 1 || gone.length ? T('Save edited copy') : T('Save trimmed copy');
    previewBtn.disabled = !list.length;
    undoBtn.disabled = !undo.length || busy;
    updateHead();
  }

  // ---- playback: removed parts are skipped when playing runs into them ----
  let lastKept = true;
  const keptAt = (t, list) => list.some((r) => t >= r.from - 0.001 && t < r.end);
  function watchFrame() {
    if (!duration) return;
    const list = runs();
    const t = video.currentTime;
    const inKept = keptAt(t, list);
    if (!video.paused && lastKept && !inKept && !video.seeking) {
      const next = list.find((r) => r.from >= t - 0.05);
      if (next) video.currentTime = next.from;
      else { video.pause(); video.currentTime = list.at(-1)?.end ?? t; }
      lastKept = true;
    } else lastKept = inKept;
    updateHead();
  }
  const loop = () => {
    if (!video.isConnected || video.paused) return;
    watchFrame();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
  };
  video.addEventListener('play', () => { lastKept = keptAt(video.currentTime, runs()); loop(); });
  video.addEventListener('seeked', () => { lastKept = keptAt(video.currentTime, runs()); updateHead(); });
  video.addEventListener('timeupdate', updateHead);
  const syncPlay = () => {
    const playing = !video.paused && !video.ended;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', playing ? T('Pause (Space)') : T('Play (Space)'));
  };
  for (const ev of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(ev, syncPlay);
  syncPlay();
  const togglePlayback = () => { if (video.paused || video.ended) video.play().catch(() => {}); else video.pause(); };
  playBtn.addEventListener('click', togglePlayback);
  video.addEventListener('click', togglePlayback);

  save.addEventListener('click', async () => {
    const list = runs();
    if (problem(list)) return;
    busy = true; render();
    try {
      const r = await api(`/api/clips/${c.id}/trim`, jsonPost({ segments: list.map(({ start, end }) => ({ start, end })), removeTracks: [...removed], deleteOriginal: delOrig.checked }));
      toast(T('Saved “{0}” in Trimmed Clips', r.title));
      closeTopOverlay();
      await loadClips();
      renderClips();
    } catch (err) {
      toast(err.message);
      busy = false; render();
    }
  });

  const content = h('div', { class: 'sheet-content edit' },
    h('h2', { id: 'sheet-title' }, T('Edit · {0}', c.title)),
    h('div', { class: 'edit-stage' }, video),
    h('div', { class: 'edit-transport' }, playBtn, h('span', { class: 'edit-clock' }, now, ' ', total)),
    timeline,
    h('div', { class: 'edit-tools' }, startBtn, splitBtn, endBtn, toggleBtn, undoBtn),
    trackRow,
    info,
    h('div', { class: 'edit-actions' }, previewBtn, save),
    h('label', { class: 'trim-del', for: 'trim-del' }, delOrig, T(' Move the original to Deleted afterwards (kept 30 days)')),
    h('p', { class: 'edit-keys muted' }, T('Space play · S split · X remove or restore · [ ] start or end here · ← → 1 s · , . one frame · Ctrl+Z undo')));
  // Keys while the editor is open. Text fields and the checkbox keep their own keys.
  const onKey = (e) => {
    if (!content.isConnected || !sheet.classList.contains('open') || e.target.matches?.('input:not([type="checkbox"]), textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = (d) => { video.pause(); video.currentTime = Math.min(Math.max(video.currentTime + d, 0), duration); updateHead(); };
    const run = { ' ': togglePlayback, k: togglePlayback, s: () => act('split'), x: () => act('toggle'), Delete: () => act('toggle'), Backspace: () => act('toggle'),
      '[': () => act('start'), ']': () => act('end'), ArrowLeft: () => step(-1), ArrowRight: () => step(1), ',': () => step(-frameDur), '.': () => step(frameDur) }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!run || (e.key === ' ' && e.target.matches?.('button:not(.edit-play)'))) return;
    e.preventDefault();
    run();
  };
  const sheet = $('#sheet');
  document.addEventListener('keydown', onKey);
  sheet.classList.add('is-editor');
  $('#sheet-body').replaceChildren(content);
  pushOverlay(showSheet(sheet, $('#sheet-backdrop'), () => {
    sheet.classList.remove('is-editor');
    document.removeEventListener('keydown', onKey);
    video.pause(); video.removeAttribute('src'); video.load();
    opener?.focus({ preventScroll: true });
  }));
  const ready = (d) => {
    if (duration || !(d > 0)) return;
    duration = d;
    pieces = [{ start: 0, end: d, keep: true }];
    render();
  };
  video.addEventListener('loadedmetadata', () => ready(video.duration), { once: true });
  playBtn.focus({ preventScroll: true });
  try {
    const k = await api(`/api/clips/${c.id}/keyframes`);
    keys = k.keyframes.length ? k.keyframes : [0];
    exact = Boolean(k.exact);
    if (k.frame > 0 && k.frame < 1) frameDur = k.frame;
    tracks = k.tracks || [];
    renderTracks();
    ready(k.duration);
    render();
  } catch (err) { info.textContent = T('Couldn’t read the clip: {0}', err.message); info.classList.add('is-error'); }
}

async function deleteClip(c) {
  try {
    await api(`/api/clips/${c.id}/delete`, { method: 'POST' });
    toast(T('Deleted {0}', c.title));
  } catch (err) { toast(err.message); }
  await loadClips();
  renderClips();
}
async function unshareClip(c) {
  try { await api(`/api/clips/${c.id}/unshare`, { method: 'POST' }); toast(T('Link removed')); } catch (err) { toast(err.message); }
  await loadClips();
  renderClips();
}

const UNLINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 7.8 16.2a3 3 0 0 1-4.2-4.2l2.6-2.6a3 3 0 0 1 4.2 0M14.5 9.5l1.7-1.7a3 3 0 0 1 4.2 4.2l-2.6 2.6a3 3 0 0 1-4.2 0M4 4l16 16"/></svg>';
function inlineName({ getName, save, label, maxLength, errorId, className = '', successMessage }) {
  const wrap = h('div', { class: `clip-title-wrap ${className}` });
  function display(focus = false) {
    const button = h('button', { type: 'button', class: 'clip-title row-title', 'aria-label': T('Rename {0}: {1}', label.toLowerCase(), getName()), title: T('Rename {0}', label.toLowerCase()) },
      h('span', {}, getName()));
    button.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z"/></svg>');
    button.addEventListener('click', edit);
    wrap.replaceChildren(button); if (focus) button.focus({ preventScroll: true });
  }
  function edit() {
    const previousTitle = getName();
    const height = wrap.getBoundingClientRect().height;
    wrap.style.minHeight = `${height}px`;
    let committing = false, settled = false, outsidePointer = false, afterPointer = null;
    const preserveClick = (e) => {
      if (wrap.contains(e.target) || outsidePointer) return;
      outsidePointer = true;
      const release = () => {
        document.removeEventListener('pointerup', release);
        document.removeEventListener('pointercancel', release);
        setTimeout(() => {
          outsidePointer = false;
          const complete = afterPointer; afterPointer = null; complete?.();
        }, 0);
      };
      document.addEventListener('pointerup', release);
      document.addEventListener('pointercancel', release);
    };
    document.addEventListener('pointerdown', preserveClick, true);
    const finish = (focus) => {
      settled = true;
      document.removeEventListener('pointerdown', preserveClick, true);
      const complete = () => { wrap.style.minHeight = ''; display(focus); };
      if (outsidePointer) afterPointer = complete;
      else complete();
    };
    const input = h('input', { type: 'text', maxlength: maxLength, value: getName(), 'aria-label': T('{0} name', label), autocomplete: 'off' });
    const error = h('p', { id: errorId, class: 'clip-rename-error', role: 'alert', hidden: true });
    const fail = (message) => {
      error.textContent = message; error.hidden = false;
      input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id);
    };
    const commit = async (fromEnter = false) => {
      if (committing || settled) return;
      const title = input.value.trim();
      if (title === previousTitle) { finish(fromEnter && document.activeElement === input); return; }
      if (!title) { fail(T('Enter a {0} name.', label.toLowerCase())); return; }
      committing = true; input.readOnly = true; form.setAttribute('aria-busy', 'true'); error.hidden = true;
      input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
      try {
        await save(title, previousTitle, wrap);
        finish(fromEnter && document.activeElement === input); toast(successMessage);
      } catch (err) {
        fail(err.message);
        committing = false; input.readOnly = false; form.removeAttribute('aria-busy');
      }
    };
    const form = h('form', { class: 'clip-rename-form', onsubmit: (e) => { e.preventDefault(); commit(true); } }, input, error);
    input.style.minHeight = `${height}px`;
    input.addEventListener('blur', () => commit());
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape' && !committing) { e.preventDefault(); finish(true); }
    });
    wrap.replaceChildren(form); input.focus(); input.select();
  }
  display(); return wrap;
}
function clipTitle(c) {
  return inlineName({
    getName: () => c.title, label: T('Clip'), maxLength: 120,
    errorId: `clip-rename-error-${c.id}`, successMessage: T('Clip renamed'),
    save: async (next, previousTitle, wrap) => {
      const renamed = await api(`/api/clips/${c.id}/rename`, jsonPost({ title: next, previousTitle }));
      c.title = renamed.title;
      const current = state.clips?.clips.find((item) => item.id === c.id); if (current) current.title = renamed.title;
      const card = wrap.closest('.clip');
      card?.querySelector('.clip-thumb')?.setAttribute('aria-label', T('Play {0}', c.title));
      card?.querySelector('.clip-delete')?.setAttribute('aria-label', T('Delete {0}', c.title));
      card?.querySelector('.clip-trim')?.setAttribute('aria-label', T('Edit {0}', c.title));
    },
  });
}
function clipCard(c) {
  const when = new Date(c.mtime).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const thumb = h('button', { class: 'clip-thumb', 'aria-label': T('Play {0}', c.title) },
    h('img', { src: `/api/clips/${c.id}/thumb.jpg`, alt: '', loading: 'lazy' }));
  thumb.insertAdjacentHTML('beforeend', `<span class="clip-play">${ICONS.play}</span>`);
  thumb.addEventListener('click', () => openPlayer({ kind: 'clip', id: c.id, key: c.id, title: c.title }));
  const s = c.share;
  const link = s && `${location.origin}/c/${s.token}`;
  let actions;
  if (!s) actions = [h('button', { class: 'retry', onclick: (e) => shareClip(c, e.currentTarget) }, T('Share'))];
  else if (s.error) actions = [h('span', { class: 'muted clip-error' }, T('Couldn’t prepare it: {0}', s.error)), h('button', { class: 'retry', onclick: (e) => shareClip(c, e.currentTarget) }, T('Try again'))];
  else if (!s.ready) actions = [h('span', { class: 'muted clip-working' }, T('Preparing for Discord…'))];
  // the label hides on narrow cards (style.css), leaving the copy icon; aria-label keeps the name
  else actions = [h('button', { class: 'retry clip-copy', 'aria-label': T('Copy link'), title: T('Copy link'), onclick: () => copyLink(link) }, icon('copy'), h('span', { class: 'clip-btn-label' }, T('Copy link')))];
  if (s) actions.push(h('button', { class: 'icon-btn clip-unshare', 'aria-label': T('Stop sharing'), title: T('Stop sharing (the link stops working)'), onclick: () => unshareClip(c) }));
  // two taps: the first turns the bin into "Delete?", the second deletes (it waits 30 days in .deleted)
  const del = h('button', {
    class: 'icon-btn clip-delete', 'aria-label': T('Delete {0}', c.title), title: T('Delete clip'),
    onclick: (e) => {
      const b = e.currentTarget;
      if (b.dataset.sure) { b.disabled = true; deleteClip(c); return; }
      b.dataset.sure = '1';
      b.classList.add('is-sure');
      b.textContent = T('Delete?');
      setTimeout(() => { if (b.isConnected && !b.disabled) { delete b.dataset.sure; b.classList.remove('is-sure'); b.innerHTML = ICONS.trash; } }, 4000);
    },
  });
  actions.push(h('button', { class: 'icon-btn clip-trim', 'aria-label': T('Edit {0}', c.title), title: T('Edit: trim or cut out parts (no quality loss)'), onclick: (e) => openTrim(c, e.currentTarget) }));
  actions.push(del);
  const card = h('li', { class: 'clip' }, thumb,
    h('div', { class: 'clip-text' },
      clipTitle(c),
      h('div', { class: 'row-meta' }, h('span', {}, c.game), h('span', {}, when), h('span', {}, fmtBytes(c.size)), s?.ready && h('span', { class: 'clip-shared' }, T('shared')))),
    h('div', { class: 'clip-actions' }, actions));
  const un = $('.clip-unshare', card);
  if (un) un.innerHTML = UNLINK_ICON;
  $('.clip-delete', card).innerHTML = ICONS.trash;
  $('.clip-trim', card).innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.5 20 18M8.6 16.5 20 6"/></svg>';
  return card;
}

function renderClips() {
  const body = $('#clips-body');
  if (state.clipsError) { body.replaceChildren(notice(T('Couldn’t load clips'), state.clipsError, () => loadClips().then(renderClips))); return; }
  if (!state.clips) return;
  if (!state.clips.configured) { body.replaceChildren(notice(T('No clips folder'), T('Set CLIPS_DIR in .env to the folder your desktop syncs clips to.'))); return; }
  const q = norm(state.query);
  const list = state.clips.clips.filter((c) => !q || norm(`${c.title} ${c.game}`).includes(q));
  if (!list.length) { body.replaceChildren(h('p', { class: 'muted' }, q ? T('Nothing matches.') : T('No clips yet.'))); return; }
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
const enableHouseTab = () => addAdminTab('house', T('House'), '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/></svg>');
const enableClipsTab = () => addAdminTab('clips', T('Clips'), '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/></svg>');

const enableNotesTab = () => {
  addAdminTab('notes', T('Notes'), '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/></svg>');
  $('.tabs').insertBefore($('.tab[data-view="notes"]'), $('.tab[data-view="library"]'));
};

// Adds the Activity tab for the server's owner (ADMIN_EMAILS in .env).
function enableActivityTab() {
  if ($('#view-activity')) return;
  $('#main').append(h('section', { id: 'view-activity', class: 'view', 'aria-labelledby': 'activity-heading', hidden: true },
    h('h2', { class: 'view-heading', id: 'activity-heading' }, T('Activity')),
    h('div', { id: 'activity-body' })));
  const tab = h('button', { class: 'tab', 'data-view': 'activity' });
  tab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 13.8c1.8.7 3 2.6 3 5.2"/></svg><span>' + T('Activity') + '</span>';
  tab.addEventListener('click', () => setView('activity'));
  $('.tabs').insertBefore(tab, $('.tab[data-view="settings"]'));
}

input.addEventListener('input', () => {
  if (state.view === 'settings') { const q = input.value; setView('discover').then(() => { input.value = state.query = q; renderDiscover(); }); return; }
  state.query = input.value;
  $('#q-clear').hidden = !input.value;
  if (state.view === 'notes') {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => notesView.load(), 250);
    return;
  }
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
  if (state.view === 'notes') notesView.load();
  input.blur(); // hides the phone keyboard
});
$('#q-clear').addEventListener('click', () => {
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.focus();
});

// The open tab lives in the address (#library), so reloading the page comes back to it.
function rememberView(view) {
  if (!view || location.hash === `#${view}`) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}#${view}`);
}
// Closing a sheet restores the address it opened on; keep the tab shown now in it.
window.addEventListener('popstate', () => rememberView(state.view));
function linkedView() {
  const view = decodeURIComponent(location.hash.slice(1));
  return view && [...document.querySelectorAll('.tab')].some((t) => t.dataset.view === view) ? view : null;
}
async function setView(view) {
  if (view === 'library' || view === 'downloads') invalidateLibraryProgress();
  if (view === 'downloads') { state.libAvailability = 'downloading'; view = 'library'; }
  if (view === state.view) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  state.view = view;
  rememberView(view);
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.view === view) {
      t.setAttribute('aria-current', 'page');
    }
    else t.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  input.value = state.query = '';
  $('#q-clear').hidden = true;
  input.placeholder = PLACEHOLDERS[view];
  window.scrollTo(0, 0);

  renderView(); // render cached data, then refresh
  revealSectionTab();
  if (view === 'library') { await loadDownloads(); await Promise.all([loadLibrary(), loadConvert()]); }
  if (view === 'downloads') await loadDownloads();
  if (view === 'activity') await loadActivity();
  if (view === 'house') await loadHouse();
  if (view === 'clips') await loadClips();
  if (view === 'notes') await notesView.load();
  if (view === 'settings') await Promise.all([loadLibrary(), state.me?.isOwner ? loadPeople() : null]);
  if (state.view === view) { renderView(); revealSectionTab(); }
  schedulePoll();
}
const sectionTabs = $('.tabs');
function updateTabOverflow() {
  sectionTabs.classList.toggle('can-scroll-left', sectionTabs.scrollLeft > 1);
  sectionTabs.classList.toggle('can-scroll-right', sectionTabs.scrollLeft + sectionTabs.clientWidth < sectionTabs.scrollWidth - 1);
}
function revealSectionTab() {
  const tab = sectionTabs.querySelector('[aria-current="page"]');
  if (tab) {
    const start = tab.offsetLeft, end = start + tab.offsetWidth;
    if (start < sectionTabs.scrollLeft) sectionTabs.scrollLeft = start;
    else if (end > sectionTabs.scrollLeft + sectionTabs.clientWidth) sectionTabs.scrollLeft = end - sectionTabs.clientWidth;
  }
  updateTabOverflow();
}
sectionTabs.addEventListener('scroll', updateTabOverflow, { passive: true });
window.addEventListener('resize', revealSectionTab);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$('#home-link').addEventListener('click', async (e) => {
  e.preventDefault();
  disc.list = null; disc.genre = null;
  state.query = ''; input.value = ''; $('#q-clear').hidden = true;
  if (state.view === 'discover') { await renderDiscover(); window.scrollTo({ top: 0 }); }
  else await setView('discover');
});
$('#manage-downloads').addEventListener('click', e => openTransferDetails(null, e.currentTarget));
$('#find-torrents').addEventListener('click', (e) => openTorrents({ query: state.query.trim(), opener: e.currentTarget }));

// ---------- start ----------
// A tapped notification while Marquee is open (sw.js): open what it points at without a reload.
navigator.serviceWorker?.addEventListener('message', async (event) => {
  if (event.data?.type !== 'marquee:open') return;
  let url;
  try { url = new URL(event.data.url, location.origin); } catch { return; }
  if (url.origin !== location.origin) return;
  const token = url.searchParams.get('watch');
  if (token) { await offerWatchRoom(token); return; }
  if (url.searchParams.has('travel')) { await setView('library'); openTravelList(); return; }
  const view = url.hash.slice(1);
  if (view && view !== state.view && $(`#view-${view}`)) await setView(view);
});

(async function init() {
  try {
    state.status = await api('/api/status');
  } catch {
    $('#discover-body').replaceChildren(notice(T('Can’t reach the server'), T('Make sure server.js is running, then reload this page.'), () => location.reload()));
    return;
  }
  state.me = state.status.me;
  syncLanguage();
  state.rules = state.status.rules;
  applyTheme(prefs().theme);
  $('#find-torrents').hidden = !state.status.torrents || !canDownload();
  $('#manage-downloads').hidden = !state.me?.isOwner;
  if (state.status.admin) { enableActivityTab(); enableHouseTab(); enableNotesTab(); }
  if (state.status.clips) enableClipsTab();
  updateTabOverflow();
  await Promise.all([loadLibrary(), loadDownloads(), loadSessions(), loadProgress(), loadWatchlist(), loadTravel()]);
  // A reload stays on the tab it was on (#library); a fresh visit opens the chosen start tab.
  const start = linkedView() || prefs().startView;
  if (start && start !== 'discover') { state.view = null; await setView(start); } else { rememberView('discover'); renderDiscover(); }
  const watchToken = new URL(location.href).searchParams.get('watch');
  if (watchToken) await offerWatchRoom(watchToken);
  // A shared note link (/c/n/<token>) lands here as ?note=<id>.
  const noteId = new URL(location.href).searchParams.get('note');
  if (noteId) {
    const url = new URL(location.href); url.searchParams.delete('note'); history.replaceState(null, '', url.pathname + url.search + url.hash);
    if (state.status.admin && /^\d+$/.test(noteId)) { await setView('notes'); await notesView.focus(Number(noteId)); }
  }
  // A "Ready for your phone" notification opens Marquee as ?travel=1.
  if (new URL(location.href).searchParams.has('travel')) {
    const url = new URL(location.href); url.searchParams.delete('travel'); history.replaceState(null, '', url.pathname + url.search + url.hash);
    await setView('library'); openTravelList();
  }
  schedulePoll();
  connectLive();
  pushDevice.registerWorker();
  setTimeout(maybeShowWhatsNew, 1200); // let the first screen settle before showing update notes
})();
