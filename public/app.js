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
};
const icon = (name) => { const s = h('span'); s.innerHTML = ICONS[name]; return s.firstChild; };

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
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
      h('button', { class: 'play-btn round', 'aria-label': `Play ${title} here`, onclick: () => openPlayer(f) }, icon('play'))));
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
        refs.play = h('button', { class: 'play-btn', onclick: () => openPlayer({ ...refs.data, kind: 'dl', key: refs.data.hash }) },
          icon('play'), 'Play'))),
    refs.bar = h('div', { class: 'bulbs', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')),
    refs.stats = h('div', { class: 'dl-stats' }));
  el._refs = refs;
  return el;
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
    : [h('strong', {}, `${pct}%`), `of ${fmtBytes(d.size)}`, d.speed > 0 && `${fmtBytes(d.speed)}/s`, fmtEta(d.eta), ...subs];
  r.stats.replaceChildren(...stats.filter(Boolean).map((s) => (s instanceof Node ? s : h('span', {}, s))));
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
  const delay = state.view === 'downloads' ? 2000 : state.view === 'library' ? 3000 : 15000;
  pollTimer = setTimeout(async () => {
    if (!document.hidden) {
      const wasConverting = Boolean(state.convert?.current);
      await Promise.all([loadDownloads(), loadSessions(), state.view === 'library' ? loadConvert() : null]);
      if (state.view === 'downloads') renderDownloads();
      if (state.view === 'library') {
        // A conversion finished: refresh so the new MP4 appears.
        if (wasConverting && !state.convert?.current) { await loadLibrary(); renderLibrary(); } else renderConvertBanner();
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
    const btn = h('button', { class: 'device', onclick: () => start(d, btn, status) },
      h('span', { class: 'device-icon' }, icon('tv')),
      h('span', { class: 'row-text' },
        h('span', { class: 'row-title' }, d.name),
        h('span', { class: 'row-meta' }, h('span', {}, d.kind === 'airplay' ? 'Apple TV' : (d.model || 'Smart TV')),
          d.playing && h('span', {}, 'Playing something now')),
        status));
    return h('li', {}, btn);
  }

  async function start(d, btn, status) {
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
  try { state.sessions = (await api('/api/cast/sessions')).sessions; } catch { /* keep last known */ }
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
    r.subs.replaceChildren(...[h('h3', {}, 'Subtitles'), data.languages.length ? chips : null, note].filter(Boolean));
  }

  async function pickSub(l, chips, note, options) {
    if ((session.sub || null) === l.code) return;
    chips.querySelectorAll('.chip').forEach((c) => { c.disabled = true; });
    note.textContent = l.code ? `Getting ${l.name} subtitles and restarting on the TV…` : 'Restarting on the TV without subtitles…';
    lastAction = Date.now() + 8000; // pause status polling while the TV reloads
    try {
      const { session: next } = await api(`/api/cast/${id}/subtitles`, jsonPost({ lang: l.code }));
      session.sub = next.sub;
      state.sessions = [next, ...state.sessions.filter((s) => s.deviceId !== next.deviceId)];
      chips.querySelectorAll('.chip').forEach((c, i) => c.setAttribute('aria-pressed', String((options[i].code || null) === (session.sub || null))));
      note.textContent = l.code ? `${l.name} subtitles on. If they don’t appear, this TV may not support subtitle files over the network.` : '';
    } catch (err) {
      note.textContent = err.message;
    } finally {
      chips.querySelectorAll('.chip').forEach((c) => { c.disabled = false; });
    }
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

function clearSubTracks() {
  video.querySelectorAll('track').forEach((t) => t.remove());
  ccActive = null;
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
    ...(message ? [h('p', { class: 'cc-message' }, message)] : []));
  ccBtn.classList.toggle('is-on', Boolean(ccActive));
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
    track.track.mode = 'showing';
    track.addEventListener('load', () => { track.track.mode = 'showing'; });
    ccActive = l.code;
    l.saved = true;
    renderCcMenu(f, session);
    if (!quiet) toast(`${l.name} subtitles on`);
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
const extraPlayable = () => Object.keys(CODEC_MIME).filter(browserPlays).join(',');

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
    if (a.browserSafe && a.aligned && !pendingSync) {
      if (changed) switchToFixedAudio(session, target !== null ? 'Audio sync corrected' : 'Audio fixed');
      else note.hidden = true;
      return;
    }
    const progress = a.job === 'converting' ? ` ${Math.floor(a.percent ?? 0)}%.` : '';
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
  toast(message);
}

async function openPlayer(f, opts = {}) {
  let src = null; // signed link to the browser version (audio-fixed copy when one exists)
  const opener = document.activeElement;
  const err = $('#player-error');
  const session = current = { ...f };

  $('#player-title').textContent = [f.title, episodeLabel(f)].filter(Boolean).join(' ');
  err.hidden = true;
  $('#player').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#player-close').focus({ preventScroll: true });

  (opts.replace ? swapTopOverlay : pushOverlay)(() => {
    saveProgress(true);
    video.pause();
    resetCasting();
    clearSubTracks();
    closeCcMenu();
    ccBtn.hidden = true;
    closeSyncMenu();
    syncBtn.hidden = true;
    audioWatch = null;
    $('#player-note').hidden = true;
    video.removeAttribute('src');
    video.load(); // stops the network stream
    $('#player').hidden = true;
    document.body.style.overflow = '';
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
      ? 'Tap the AirPlay button at the top to pick a TV. No button means there’s no AirPlay TV on this network.'
      : 'Tap the cast button at the top to pick a TV. No button means there’s no Chromecast on this network.';
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
  err.textContent = 'This video can’t play in this browser. The server makes an MP4 copy of MKV files automatically; check the Library tab for progress, then try again.';
  err.hidden = false;
});
$('#player-close').addEventListener('click', closeTopOverlay);
window.addEventListener('pagehide', () => saveProgress(true));

// ---------- search box + tabs ----------
const input = $('#q');
const PLACEHOLDERS = { discover: 'Search films and shows', library: 'Filter your library', downloads: 'Filter downloads' };

function renderView() {
  if (state.view === 'discover') renderDiscover();
  if (state.view === 'library') renderLibrary();
  if (state.view === 'downloads') renderDownloads();
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
  await Promise.all([loadLibrary(), loadDownloads(), loadSessions()]);
  renderDiscover();
  schedulePoll();
})();