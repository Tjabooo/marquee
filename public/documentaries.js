// Discover → Documentaries: categories, rows that load as they scroll into view, and the sheet for SVT
// Play titles. app.js passes in its helpers, as it does for social.js. TMDB titles open app.js's usual sheet.
import { T } from './i18n.js';

export function createDocumentaries(ui) {
  const { h, api, jsonPost, toast, icon } = ui;
  const view = { category: null, type: 'all', sort: 'popular' };
  const SORTS = [['popular', T('Popular')], ['rating', T('Top rated')], ['newest', T('Newest')]];
  const TYPES = [['all', T('All')], ['movie', T('Films')], ['tv', T('Shows')]];

  function open(category) {
    Object.assign(view, { category, type: 'all', sort: 'popular' });
    window.scrollTo({ top: 0 });
    ui.rerender();
  }
  const close = () => { view.category = null; ui.rerender(); };
  const wideList = (items, label) => h('ul', { class: 'shelf-items wide-cards', tabindex: '0', 'aria-label': label }, items.map(ui.titleCard));
  const list = (items, label, source) => (source === 'svt' ? wideList(items, label)
    : h('ul', { class: 'shelf-items', tabindex: '0', 'aria-label': label }, items.map(ui.titleCard)));
  const seeAll = (c) => h('button', { class: 'see-all', onclick: () => open(c) }, T('See all'));

  // Each group of categories: its name, and a row of chips that opens one.
  function browse(categories) {
    const groups = new Map();
    for (const c of categories) groups.set(c.group, [...(groups.get(c.group) || []), c]);
    return h('section', { class: 'doc-browse', 'aria-label': T('Browse documentaries') },
      [...groups].map(([name, members]) => h('div', { class: 'doc-group' },
        h('h3', {}, name),
        h('div', { class: 'genre-chips', role: 'group', 'aria-label': name },
          members.map((c) => h('button', { type: 'button', class: `chip${c.source === 'svt' ? ' is-svt' : ''}`, onclick: () => open(c) }, c.name))))));
  }

  // A row that fetches its titles when it comes near the screen, and removes itself if there are none.
  function lazyRow(c, signal) {
    const slot = h('div', { class: 'doc-lazy' }, h('div', { class: 'shelf-head' }, h('h3', {}, c.title)));
    const observer = new IntersectionObserver(async (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      try {
        const data = await ui.cachedApi(`/api/docs/category?id=${encodeURIComponent(c.id)}`, signal);
        if (signal.aborted) return;
        if (!data.results.length) { slot.remove(); return; }
        slot.replaceWith(ui.carousel(c.title, list(data.results, c.title, c.source), seeAll({ ...c, name: c.title })));
      } catch (err) { if (err.name !== 'AbortError') slot.remove(); }
    }, { rootMargin: '500px 0px' });
    observer.observe(slot);
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    return slot;
  }

  async function render(content, signal) {
    if (view.category) {
      const c = view.category;
      const svt = c.source === 'svt';
      content.before(h('div', { class: 'discover-head doc-head' },
        h('button', { class: 'back-link', onclick: close }, T('‹ Documentaries')),
        h('h3', {}, c.name),
        h('div', { class: 'doc-controls' },
          ui.segmented(TYPES, view.type, (type) => { view.type = type; ui.rerender(); }, T('Show')),
          !svt && ui.segmented(SORTS, view.sort, (sort) => { view.sort = sort; ui.rerender(); }, T('Sort by')))));
      return ui.pagedGrid(content, (page) => `/api/docs/category?id=${encodeURIComponent(c.id)}&type=${view.type}&sort=${view.sort}&page=${page}`, signal,
        svt ? 'grid wide-cards' : 'grid');
    }
    content.replaceChildren(ui.skeletonGrid());
    try {
      const data = await ui.cachedApi('/api/docs/home', signal);
      if (signal.aborted) return;
      const cat = (id) => data.categories.find((c) => c.id === id);
      const [first, ...rows] = data.rows.map((r) => ui.carousel(r.title, list(r.items, r.title, r.source), seeAll(cat(r.id))));
      content.replaceChildren(...[
        data.featured.length > 0 && (ui.billboard ? ui.billboard(data.featured, { signal, label: T('Documentaries') })
          : ui.carousel(T('Documentaries'), h('ul', { class: 'hero', tabindex: '0', 'aria-label': T('Documentaries') }, data.featured.map(ui.heroSlide)))),
        first,
        browse(data.categories),
        ...rows,
        ...data.more.map((c) => lazyRow(c, signal)),
      ].filter(Boolean));
    } catch (err) {
      if (err.name !== 'AbortError') content.replaceChildren(ui.notice(T('Couldn’t load documentaries'), err.message, ui.rerender));
    }
  }

  // ---------- an SVT Play title ----------
  let shown = null; // the title in the open sheet: its timer stops when another opens or the sheet closes

  const stillOpen = (token) => shown === token && ui.sheet().classList.contains('open');

  function statusWord(item) {
    if (item.status === 'queued') {
      if (item.state === 'queuedDL') return T('In line');
      if (/^paused/.test(item.state || '')) return T('Paused');
      return item.progress > 0 ? `${T('On its way')} · ${Math.floor(item.progress * 100)} %` : T('On its way');
    }
    return { library: T('In your library'), server: T('On server'), failed: T('Couldn’t save this') }[item.status] || '';
  }

  function playById(id) {
    const f = ui.fileById(id);
    if (f) ui.play(f); else toast(T('It’s nearly ready. Try again in a moment.'));
  }

  // One episode or film: Play when it's here, Add when it isn't, a word in between.
  function actionFor(item, label, add) {
    if (item.status === 'library') return h('button', { class: 'play-btn round', 'aria-label': T('Play {0} here', label), onclick: () => playById(item.libraryId) }, icon('play'));
    if (item.status === 'queued') return h('span', { class: 'doc-status' }, item.state === 'queuedDL' ? T('In line') : `${Math.floor((item.progress || 0) * 100)} %`);
    if (!ui.canAdd()) return null;
    return h('button', { class: 'play-btn round stroke-icon', 'aria-label': T('Add {0} to your library', label), title: T('Add to library'), onclick: add }, icon('plus'));
  }

  function renderTitle(t, data, token, seasonNo) {
    const body = ui.sheetBody();
    const isSeries = data && data.kind === 'series';
    const status = h('p', { class: 'device-status', role: 'status' });
    const refresh = (season) => load(t, token, season);
    const add = async (payload, label) => {
      status.classList.remove('is-error');
      status.textContent = T('Adding…');
      try {
        const r = await api('/api/svt/add', jsonPost({ path: t.path, ...payload }));
        toast(r.message || T('On its way from SVT Play.'));
        ui.refreshLibrary();
        refresh(seasonNo);
      } catch (err) {
        status.classList.add('is-error');
        status.textContent = err.message;
        ui.log?.(`SVT add ${label}: ${err.message}`);
      }
    };
    const facts = [(data?.year || t.year), (isSeries || t.kind === 'series') ? T('Series') : T('Film'), T('Free on SVT Play')].filter(Boolean);
    const content = [
      h('h2', { id: 'sheet-title' }, data?.title || t.title),
      h('ul', { class: 'facts' }, facts.map((f) => h('li', {}, f))),
    ];
    if (!data) {
      content.push(h('p', { class: 'muted' }, T('Loading…')));
    } else if (!isSeries) {
      const here = data.status === 'library';
      const button = here
        ? h('button', { class: 'play-btn action-btn', onclick: () => playById(data.libraryId) }, icon('play'), h('span', {}, T('Play')))
        : data.status === 'queued'
          ? h('button', { class: 'play-btn action-btn', disabled: true }, h('span', {}, statusWord(data)))
          : ui.canAdd() && h('button', { class: 'play-btn action-btn stroke-icon', onclick: () => add({}, data.title) }, icon('plus'), h('span', {}, T('Add to library')));
      content.push(h('div', { class: 'title-actions' }, button, status));
      if (data.minutes) content[1].append(h('li', {}, T('{0} min', data.minutes)));
    } else {
      const season = data.seasons.find((s) => s.number === seasonNo) || data.seasons.at(-1);
      const rest = season.episodes.filter((e) => !['library', 'queued'].includes(e.status));
      const count = season.episodes.length;
      content.push(h('div', { class: 'title-actions' },
        ui.canAdd() && rest.length > 0 && h('button', { class: 'play-btn action-btn stroke-icon', onclick: () => add({ seasons: [season.number] }, data.title) },
          icon('plus'), h('span', {}, rest.length === 1 ? T('Add 1 episode') : T('Add {0} episodes', rest.length))),
        !rest.length && h('p', { class: 'muted' }, season.episodes.some((e) => e.status === 'queued') ? T('On its way. It’ll be ready to watch soon.') : T('This season is in your library.')),
        status));
      content.push(h('p', { class: 'overview' }, data.overview));
      if (data.seasons.length > 1) {
        content.push(h('div', { class: 'genre-chips doc-seasons', role: 'group', 'aria-label': T('Season') },
          data.seasons.map((s) => h('button', {
            type: 'button', class: 'chip', 'aria-pressed': String(s.number === season.number),
            onclick: () => renderTitle(t, data, token, s.number),
          }, s.dated && s.name ? s.name : T('Season {0}', s.number)))));
      }
      content.push(h('h3', {}, count === 1 ? T('1 episode') : T('{0} episodes', count)));
      content.push(h('ul', { class: 'rows doc-episodes' }, season.episodes.map((e) => h('li', { class: 'row' },
        e.still && h('img', { class: 'doc-still', src: e.still, alt: '', loading: 'lazy', decoding: 'async' }),
        h('div', { class: 'row-text' },
          h('div', { class: 'row-title' }, e.name),
          h('div', { class: 'row-meta' }, [e.minutes && T('{0} min', e.minutes), statusWord(e)].filter(Boolean).map((m) => h('span', {}, m))),
          e.status === 'queued' && e.progress > 0 && h('div', { class: 'resume-track' }, h('i', { style: `width:${(e.progress * 100).toFixed(1)}%` })),
          e.overview && h('p', { class: 'doc-episode-text' }, e.overview)),
        h('div', { class: 'row-actions' },
          actionFor(e, e.name, () => add({ seasons: [season.number], episodes: [e.number] }, e.name)))))));
    }
    if (data && !isSeries && data.overview) content.push(h('p', { class: 'overview' }, data.overview));
    if (data) content.push(h('p', { class: 'muted doc-note' }, T('Saved from SVT Play to your library in full quality, with Swedish subtitles. SVT Play only works in Sweden.')));
    const backdrop = data?.backdrop || t.backdrop;
    body.replaceChildren(
      h('div', { class: `sheet-hero${backdrop ? '' : ' no-image'}`, style: backdrop ? `background-image:url("${backdrop}")` : null }),
      h('div', { class: 'sheet-content' }, ...content));
    // While something's on its way, keep the sheet up to date.
    const waiting = data && (data.status === 'queued' || data.seasons?.some((s) => s.episodes.some((e) => e.status === 'queued')));
    if (waiting) setTimeout(() => { if (stillOpen(token)) refresh(seasonNo); }, 6000);
  }

  async function load(t, token, seasonNo) {
    try {
      const data = await api(`/api/svt/title?path=${encodeURIComponent(t.path)}`);
      if (shown !== token) return;
      await ui.refreshLibrary();
      if (shown !== token) return;
      renderTitle(t, data, token, seasonNo ?? data.seasons?.at(0)?.number);
    } catch (err) {
      if (shown === token) ui.sheetBody().replaceChildren(h('div', { class: 'sheet-content' }, ui.notice(T('Couldn’t load this'), err.message)));
    }
  }

  function openTitle(t, opener) {
    const token = shown = {};
    renderTitle(t, null, token);
    ui.openSheet(() => { if (shown === token) shown = null; opener?.focus({ preventScroll: true }); });
    load(t, token);
  }

  return { render, openTitle, reset: () => { view.category = null; }, inCategory: () => Boolean(view.category) };
}
