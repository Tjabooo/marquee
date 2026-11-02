// Marquee web client. Plain ES modules, no build step.

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
  const r = await fetch(path, { ...opts, headers: { ...opts.headers, 'X-Marquee-Client': CLIENT_ID } });
  let data = {};
  try { data = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error(data.error || `The server responded with ${r.status}.`);
  return data;
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
  libraryError: null,
  downloads: [],
  downloadsError: null,
};

// Local files (library + finished downloads) that belong to a TMDB title.
function localFiles() {
  return [
    ...state.library.map((f) => ({ ...f, kind: 'lib', key: f.id, done: true })),
    ...state.downloads.map((d) => ({ ...d, kind: 'dl', key: d.hash, file: d.name })),
  ];
}
function matchesFor(t) {
  const n = norm(t.title);
  return localFiles()
    .filter((f) => norm(f.title) === n &&
      (t.type === 'tv' || !f.year || !t.year || Math.abs(f.year - t.year) <= 1))
    .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
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
function savedProgress(f) {
  try { return JSON.parse(localStorage.getItem(resumeKey(f))); } catch { return null; }
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
      h('div', { class: 'row-meta' }, meta.filter(Boolean).map((m) => h('span', {}, m))),
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

function titleCard(t) {
  const onServer = matchesFor(t).some((f) => f.done);
  return h('li', {},
    h('button', { class: 'title-card', onclick: (e) => openDetails(t, e.currentTarget) },
      h('div', { class: 'poster' },
        t.poster
          ? h('img', { src: t.poster, alt: '', loading: 'lazy', decoding: 'async' })
          : h('div', { class: 'poster-fallback' }, t.title),
        onServer && h('span', { class: 'on-server' }, 'On server'),
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
  const onServer = matchesFor(t).some((f) => f.done);
  return h('li', { class: 'hero-slide' },
    h('button', { class: 'hero-card', onclick: (e) => openDetails(t, e.currentTarget) },
      h('img', { src: t.backdrop, alt: '', decoding: 'async' }),
      h('div', { class: 'hero-text' },
        onServer && h('span', { class: 'on-server' }, 'On server'),
        h('div', { class: 'hero-title' }, t.title),
        h('div', { class: 'hero-meta' }, meta.join(' · ')),
        h('p', { class: 'hero-overview' }, t.overview))));
}

function row(r) {
  return h('section', { class: 'shelf', 'aria-label': r.title },
    h('div', { class: 'shelf-head' },
      h('h3', {}, r.title),
      h('button', { class: 'see-all', onclick: () => { disc.list = { key: r.key, title: r.title }; window.scrollTo({ top: 0 }); renderDiscover(); } }, 'See all')),
    h('ul', { class: 'shelf-items' }, r.items.map(titleCard)));
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
      data.featured.length && h('ul', { class: 'hero', 'aria-label': 'Featured' }, data.featured.map(heroSlide)),
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
    state.library = (await api('/api/library')).items;
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
  const q = norm(state.query);
  const items = state.library.filter((f) => !q || norm(f.title).includes(q) || norm(f.file).includes(q));
  if (!state.library.length) {
    body.replaceChildren(notice('Nothing here yet', 'Video files you add to the media folder show up here within 30 seconds.'));
    return;
  }
  if (!items.length) {
    body.replaceChildren(notice(`Nothing matches “${state.query.trim()}”`, 'Try part of the title instead.'));
    return;
  }
  body.replaceChildren(h('div', { class: 'dl convert-banner', id: 'convert-banner', hidden: true }), h('ul', { class: 'rows' }, items.map((f) => {
    const row = fileRow({ ...f, kind: 'lib', key: f.id, done: true });
    // Title on the first line, episode on the meta line.
    row.querySelector('.row-title').textContent = f.title + (f.year ? ` (${f.year})` : '');
    const ep = episodeLabel(f);
    if (ep) row.querySelector('.row-meta').prepend(h('span', {}, ep));
    return row;
  })));
  renderConvertBanner();
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
    state.downloads = (await api('/api/downloads')).items;
    state.downloadsError = null;
  } catch (err) {
    state.downloadsError = err.message;
  }
  const active = state.downloads.filter((d) => !d.done).length;
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
  r.state.textContent = label;
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
  const files = matchesFor(t);
  $('#sheet-body').replaceChildren(
    h('div', { class: `sheet-hero${t.backdrop ? '' : ' no-image'}`, style: t.backdrop ? `background-image:url("${t.backdrop}")` : null }),
    h('div', { class: 'sheet-content' },
      h('h2', { id: 'sheet-title' }, t.title),
      h('ul', { class: 'facts' },
        t.year && h('li', {}, t.year),
        h('li', {}, t.type === 'tv' ? 'Series' : 'Film'),
        t.rating && h('li', {}, `★ ${t.rating}`)),
      t.overview && h('p', { class: 'overview' }, t.overview),
      h('h3', {}, 'On this server'),
      files.length
        ? h('ul', { class: 'rows' }, files.map(fileRow))
        : h('p', { class: 'muted' }, 'Not on this server yet.'),
      state.status.torrents && h('button', {
        class: 'find-btn',
        onclick: (e) => openTorrents({
          query: t.type === 'tv' ? t.title : [t.title, t.year].filter(Boolean).join(' '),
          type: t.type === 'tv' ? 'tv' : 'movie',
          label: t.title,
          opener: e.currentTarget,
        }),
      }, icon('download'), files.some((f) => f.done) ? 'Find another version' : 'Find a download')));
  pushOverlay(showSheet($('#sheet'), $('#sheet-backdrop'), () => opener?.focus({ preventScroll: true })));
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

  const run = async (scope, btn) => {
    body.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = 'Deleting…';
    status.className = 'device-status';
    status.textContent = '';
    try {
      await api('/api/library/delete', jsonPost({ id, scope }));
      closeTopOverlay();
      toast(scope === 'torrent' && pack ? `Deleted all ${t.videos} videos` : 'Deleted');
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
  const button = (text, cls, scope) => {
    const b = h('button', { class: cls, 'data-label': text }, text);
    b.addEventListener('click', () => run(scope, b));
    return b;
  };

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
  const cancel = h('button', { class: 'del-cancel', onclick: () => closeTopOverlay() }, 'Keep it');
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

async function magnetOf(t) {
  if (t.magnet) return t.magnet;
  t.magnet = (await api(`/api/torrents/magnet?ref=${encodeURIComponent(t.ref)}`)).magnet;
  return t.magnet;
}

async function sendToQbit(link, extra = {}) {
  await api('/api/downloads/add', jsonPost({ link, ...extra }));
  loadDownloads().then(() => { if (state.view === 'downloads') renderDownloads(); });
}

function openTorrents({ query = '', type = 'all', label = null, opener } = {}) {
  let results = [];
  let filter = 'all';
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
  const list = h('ul', { class: 'rows tor-list' });
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
    form, subRow, chips, info, list].filter(Boolean));
  pushOverlay(showSheet($('#picker'), $('#picker-backdrop'), () => { ctrl?.abort(); opener?.focus({ preventScroll: true }); }));

  form.addEventListener('submit', (e) => { e.preventDefault(); input.blur(); run(); });

  async function run() {
    const q = input.value.trim();
    ctrl?.abort();
    if (/^magnet:\?/i.test(q)) return addPastedMagnet(q);
    if (q.length < 2) { results = []; list.replaceChildren(); info.textContent = 'Type a title to search 1337x and The Pirate Bay.'; return; }
    ctrl = new AbortController();
    const { signal } = ctrl;
    info.textContent = 'Searching 1337x and The Pirate Bay…';
    list.replaceChildren(...Array.from({ length: 5 }, () => h('li', { class: 'row tor skeleton-row', 'aria-hidden': 'true' })));
    try {
      const data = await api(`/api/torrents/search?q=${encodeURIComponent(q)}&type=${type}`, { signal });
      results = data.results;
      renderList(data.problems);
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
    const getBtn = state.status.downloads && h('button', { class: 'play-btn', 'aria-label': `Download ${t.name}`, onclick: get }, icon('download'), 'Get');
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
        await sendToQbit(await magnetOf(t), sub ? { subs: [sub], name: t.name } : {});
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

function saveProgress(force = false) {
  if (!current || !video.duration || !isFinite(video.duration)) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  try {
    if (video.duration - video.currentTime < 90) localStorage.removeItem(resumeKey(current)); // treat as finished
    else localStorage.setItem(resumeKey(current), JSON.stringify({ time: video.currentTime, duration: video.duration }));
  } catch { /* storage full or blocked */ }
}

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
    airplayBtn.hidden = e.availability !== 'available';
  });
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => onWireless(video.webkitCurrentPlaybackTargetIsWireless));
}
if (hasRemotePlayback) {
  video.remote.addEventListener('connect', () => onWireless(true));
  video.remote.addEventListener('disconnect', () => onWireless(false));
}

function watchCastTargets() {
  if (!hasRemotePlayback) return; // Safari reports availability through the event above
  video.remote.watchAvailability((available) => { airplayBtn.hidden = !available; })
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
    if (at > 1) video.currentTime = at;
    if (wasPlaying) video.play().catch(() => {});
  }, { once: true });
  video.src = url;
}

async function onWireless(on) {
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
    s.canSync && [null, 'exact', 'undone', 'failed'].includes(s.state) && action('Fix timing', 'sync'),
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
  } else if (wasBusy && s.state === 'synced') {
    reloadSubTrack(l);
    toast(`Subtitle timing fixed (${fmtSubShift(s.offset)})`);
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
  let pref = null;
  try { pref = localStorage.getItem('subs:lang'); } catch { /* blocked */ }
  const saved = ccLangs.find((l) => l.code === pref && l.saved);
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
      syncBtn.hidden = false;
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
    if (at > 1) video.currentTime = at;
    if (wasPlaying) video.play().catch(() => {});
  }, { once: true });
  video.src = `${base}${base.includes('?') ? '&' : '?'}v=${Date.now()}`; // cache-busting URL
  $('#player-note').hidden = true;
  $('#player-error').hidden = true;
  toast(message);
}

// Safari tints its toolbars with theme-color; black while the player is open so it blends in.
const themeMeta = document.querySelector('meta[name="theme-color"]');
const PAGE_THEME = themeMeta?.content;
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

const menuOpen = () => !ccMenu.hidden || !syncMenu.hidden || !helpEl.hidden;
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
  const play = video.paused || video.ended;
  if (play) video.play().catch(() => {}); else video.pause();
  if (feedback) osd(icon(play ? 'play' : 'pause'));
}
function updatePlayState() {
  const playing = !video.paused && !video.ended;
  for (const b of playBtns) {
    b.replaceChildren(icon(playing ? 'pause' : 'play'));
    b.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
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
  if (apply) video.currentTime = seeking;
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

const seekToFraction = (f) => { if (isFinite(video.duration)) { video.currentTime = video.duration * f; updateTime(); } };
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
    setTheme(PAGE_THEME);
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

  // Get a signed link, then request one byte so server errors can be shown as text.
  try {
    const link = await api(`/api/play-link?kind=${f.kind}&id=${encodeURIComponent(mediaId(f))}&variant=browser`);
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
    setSpinner(false);
    err.textContent = e.message;
    err.hidden = false;
    return;
  }

  if (current !== session) return; // closed while we were checking
  video.src = src;
  watchCastTargets();
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
  video.play().catch(() => { /* autoplay blocked: the controls are there */ });
}

video.addEventListener('loadedmetadata', () => {
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
window.addEventListener('pagehide', () => saveProgress(true));

// ---------- search box + tabs ----------
const input = $('#q');
const PLACEHOLDERS = { discover: 'Search films and shows', library: 'Filter your library', downloads: 'Filter downloads', activity: 'Filter by person or title', house: 'Filter machines', clips: 'Filter by game or name' };

function renderView() {
  if (state.view === 'discover') renderDiscover();
  if (state.view === 'library') renderLibrary();
  if (state.view === 'downloads') renderDownloads();
  if (state.view === 'activity') renderActivity();
  if (state.view === 'house') renderHouse();
  if (state.view === 'clips') renderClips();
}

// ---------- activity (server owner only) ----------
// Who has been using Marquee and what they did, from the server's activity log.
const ACTIVITY_TEXT = {
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
};
const personName = (user) => (user.includes('@') ? user.split('@')[0] : user);
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
    const list = a.members.filter((e) => !q || norm(e).includes(q));
    out.push(h('p', { class: 'activity-day' }, `${a.members.length} ${a.members.length === 1 ? 'person' : 'people'} can sign in`));
    out.push(h('ul', { class: 'rows' }, list.map((email) => {
      const owner = (a.owners || []).includes(email);
      return h('li', { class: 'row' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, email), owner && h('span', { class: 'row-meta' }, h('span', {}, 'owner'))),
        !owner && h('span', { class: 'row-actions' }, h('button', {
          class: 'retry',
          onclick: (e) => {
            const b = e.currentTarget;
            if (b.dataset.sure) return accessAction('/api/access/remove', { email }, `${email} can’t sign in any more`);
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
  const people = state.activity.people.filter((p) => !q || norm(`${p.user} ${p.device}`).includes(q));
  const events = state.activity.events.filter((e) => !q || norm(`${e.user} ${e.detail} ${e.action}`).includes(q));
  const out = [...accessSection(), h('h3', { class: 'activity-head' }, 'People')];
  out.push(people.length ? h('ul', { class: 'rows' }, people.map((p) => h('li', { class: 'row' },
    h('span', { class: `activity-dot${Date.now() - p.at < 3 * 60000 ? ' is-on' : ''}`, 'aria-hidden': 'true' }),
    h('span', { class: 'row-text' },
      h('span', { class: 'row-title' }, p.user),
      h('span', { class: 'row-meta' }, h('span', {}, lastSeenText(p.at)), p.device && h('span', {}, p.device))))))
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
        h('span', { class: 'activity-text' }, h('strong', {}, personName(e.user)), ' ', (ACTIVITY_TEXT[e.action] || ((d) => `${e.action} ${d}`))(e.detail)),
        h('span', { class: 'row-meta' }, h('span', {}, e.device)))));
  }
  body.replaceChildren(...out);
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
  $('.tabs').append(tab);
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
  $('.tabs').append(tab);
}

input.addEventListener('input', () => {
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
  if (state.view === view) renderView();
  schedulePoll();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$('#find-torrents').addEventListener('click', (e) => openTorrents({ query: state.query.trim(), opener: e.currentTarget }));

// ---------- start ----------
(async function init() {
  try {
    state.status = await api('/api/status');
  } catch {
    $('#discover-body').replaceChildren(notice('Can’t reach the server', 'Make sure server.js is running, then reload this page.', () => location.reload()));
    return;
  }
  $('#find-torrents').hidden = !state.status.torrents;
  if (state.status.admin) { enableActivityTab(); enableHouseTab(); }
  if (state.status.clips) enableClipsTab();
  await Promise.all([loadLibrary(), loadDownloads(), loadSessions()]);
  renderDiscover();
  schedulePoll();
})();
