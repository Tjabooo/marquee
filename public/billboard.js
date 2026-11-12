// The billboard at the top of Discover: the week's trending titles, edge to edge, one at a time.
// Phones swipe between them (a scroll-snap row, so it's native and cheap). Wide screens advance every
// 9 s, paused while you point at it, focus it or the page is hidden. On a desktop on an unmetered
// connection the slide you're looking at plays its trailer muted after a few seconds (never on phones,
// with Save-Data or with reduced motion). The slides are listed as a row of lilin bulbs.
import { T } from './i18n.js';

const ADVANCE_MS = 9000;
const TRAILER_AFTER_MS = 4500;

export function createBillboard({ h, icon, cachedFor, pageInfo, openDetails, quickAction, ownershipBadge, metaFor, bigArt }) {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wide = () => matchMedia('(min-width: 900px)').matches;
  // Trailers only where they can't cost anyone: a big screen with a mouse, no data saving, not on cellular.
  const trailersOk = () => {
    const c = navigator.connection;
    return wide() && matchMedia('(pointer: fine)').matches && !reduced()
      && !(c && (c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType || '') || c.type === 'cellular'));
  };

  return function billboard(items, { signal, label }) {
    const slides = items.slice(0, 6);
    const track = h('ul', { class: 'bb-track', 'aria-label': label });
    const bulbs = h('div', { class: 'bb-bulbs', role: 'group', 'aria-label': T('Choose a title') });
    const sound = h('button', { type: 'button', class: 'bb-sound', hidden: true, 'aria-pressed': 'false', 'aria-label': T('Sound on') }, icon('muted'));
    const root = h('section', { class: 'billboard', 'aria-roledescription': T('carousel'), 'aria-label': label }, track, h('div', { class: 'bb-foot' }, bulbs, sound));
    let index = 0, timer = null, trailerTimer = null, frame = null, paused = false;

    const slideEls = slides.map((t, i) => {
      const quick = quickAction(t);
      const primary = quick && h('button', { type: 'button', class: 'btn-primary', onclick: (e) => quick.run(e.currentTarget) }, icon(quick.icon), h('span', {}, quick.label));
      const more = h('button', { type: 'button', class: 'btn-glass', onclick: (e) => { stopTrailer(); openDetails(t, e.currentTarget); } },
        icon('info'), h('span', {}, T('More info')));
      const title = h('h3', { class: 'bb-title' }, t.title);
      const art = bigArt(t.backdrop);
      const img = h('img', { class: 'bb-img', src: art, alt: '', decoding: 'async', ...(i === 0 ? { fetchpriority: 'high' } : { loading: 'lazy' }) });
      img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
      if (img.complete) img.classList.add('is-loaded');
      const slide = h('li', { class: 'bb-slide', 'aria-roledescription': T('slide'), 'aria-label': T('{0} of {1}: {2}', i + 1, slides.length, t.title) },
        h('div', { class: 'bb-art' }, img),
        h('div', { class: 'bb-copy' },
          h('p', { class: 'kicker bb-rank' }, h('span', { class: 'bb-rank-bulb', 'aria-hidden': 'true' }), T('Trending · #{0}', i + 1)),
          title,
          h('p', { class: 'bb-meta' }, ownershipBadge(t), h('span', {}, metaFor(t))),
          t.overview && h('p', { class: 'bb-overview' }, t.overview),
          h('div', { class: 'bb-actions' }, primary, more)));
      slide._title = t;
      slide._quick = quick;
      slide._primary = primary;
      // Logo art in place of the title text, when TMDB has one (the heading keeps the name as alt text).
      if (t.id && ['movie', 'tv'].includes(t.type)) pageInfo(t.type, t.id).then((page) => {
        if (!page?.logo || !slide.isConnected) return;
        const logo = h('img', { class: `bb-logo${page.logo.aspect > 3.2 ? ' is-wide' : ''}`, src: page.logo.url, alt: t.title, decoding: 'async' });
        logo.addEventListener('load', () => title.replaceChildren(logo), { once: true });
      }).catch(() => {});
      return slide;
    });
    track.append(...slideEls);
    const bulbBtns = slides.map((t, i) => h('button', { type: 'button', class: 'bb-bulb', 'aria-label': T('Show {0}', t.title), onclick: () => { go(i); restart(); } }));
    bulbs.append(...bulbBtns);
    if (slides.length < 2) bulbs.hidden = true;

    function mark(i) {
      index = i;
      bulbBtns.forEach((b, n) => b.setAttribute('aria-current', String(n === i)));
      slideEls.forEach((s, n) => { s.classList.toggle('is-active', n === i); s.inert = n !== i && wide(); });
    }
    function go(i, smooth = true) {
      const n = (i + slides.length) % slides.length;
      stopTrailer();
      track.scrollTo({ left: n * track.clientWidth * (document.dir === 'rtl' ? -1 : 1), behavior: smooth && !reduced() ? 'smooth' : 'instant' });
      mark(n);
      scheduleTrailer();
    }
    // Swiping (phones) or the trackpad: the slide that's mostly in view is the current one.
    let scrollFrame = 0;
    track.addEventListener('scroll', () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        const i = Math.round(Math.abs(track.scrollLeft) / Math.max(1, track.clientWidth));
        if (i !== index && i < slides.length) { stopTrailer(); mark(i); scheduleTrailer(); }
      });
    }, { passive: true });

    const advancing = () => wide() && !reduced() && slides.length > 1 && !paused && !document.hidden && !frame?.classList.contains('is-playing');
    function restart() {
      clearInterval(timer);
      timer = setInterval(() => { if (!root.isConnected) return stop(); if (advancing()) go(index + 1); }, ADVANCE_MS);
    }
    root.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') paused = true; });
    root.addEventListener('pointerleave', () => { paused = false; });
    root.addEventListener('focusin', () => { paused = true; });
    root.addEventListener('focusout', () => { if (!root.contains(document.activeElement)) paused = false; });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && e.target.closest('.bb-bulbs')) { go(index + 1); bulbBtns[index].focus(); }
      if (e.key === 'ArrowLeft' && e.target.closest('.bb-bulbs')) { go(index - 1); bulbBtns[index].focus(); }
    });

    // ---- the muted trailer ----
    function onMessage(e) {
      if (!frame || e.source !== frame.contentWindow) return;
      let data; try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      const stateNow = data?.event === 'onStateChange' ? data.info : data?.info?.playerState;
      if (stateNow === 1) { frame.classList.add('is-playing'); sound.hidden = false; }
      if (stateNow === 0) { stopTrailer(); if (advancing()) go(index + 1); }
    }
    function scheduleTrailer() {
      clearTimeout(trailerTimer);
      if (!trailersOk()) return;
      const t = slides[index];
      if (!t?.id || !['movie', 'tv'].includes(t.type)) return;
      trailerTimer = setTimeout(async () => {
        let trailer = null;
        try { trailer = (await cachedFor(`/api/title/${t.type}/${t.id}/trailer`, 60 * 60 * 1000)).trailer; } catch { return; }
        if (!trailer || !root.isConnected || slides[index] !== t || document.hidden || signal?.aborted) return;
        const key = encodeURIComponent(trailer.key);
        frame = h('iframe', {
          class: 'bb-trailer', title: `${t.title}: ${trailer.name}`, tabindex: '-1', 'aria-hidden': 'true',
          allow: 'autoplay; encrypted-media', referrerpolicy: 'strict-origin-when-cross-origin',
          src: `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`,
        });
        frame.addEventListener('load', () => {
          // Ask the player to report its state, so the video only shows once it's really playing.
          frame?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
        });
        slideEls[index].querySelector('.bb-art').append(frame);
      }, TRAILER_AFTER_MS);
    }
    function stopTrailer() {
      clearTimeout(trailerTimer);
      frame?.remove(); frame = null;
      sound.hidden = true; sound.setAttribute('aria-pressed', 'false'); sound.replaceChildren(icon('muted')); sound.setAttribute('aria-label', T('Sound on'));
    }
    sound.addEventListener('click', () => {
      if (!frame) return;
      const on = sound.getAttribute('aria-pressed') !== 'true';
      frame.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: on ? 'unMute' : 'mute', args: [] }), '*');
      sound.setAttribute('aria-pressed', String(on));
      sound.setAttribute('aria-label', on ? T('Sound off') : T('Sound on'));
      sound.replaceChildren(icon(on ? 'volumeHigh' : 'muted'));
    });
    const onVisibility = () => { if (document.hidden) stopTrailer(); else scheduleTrailer(); };
    function stop() {
      clearInterval(timer); stopTrailer();
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisibility);
    }
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisibility);
    signal?.addEventListener('abort', stop, { once: true });
    root._stop = stop;
    root._refresh = () => { // ownership changed (added, finished): redraw the buttons
      for (const s of slideEls) {
        const q = quickAction(s._title);
        const actions = s.querySelector('.bb-actions');
        const btn = q && h('button', { type: 'button', class: 'btn-primary', onclick: (e) => q.run(e.currentTarget) }, icon(q.icon), h('span', {}, q.label));
        if (s._primary) s._primary.replaceWith(btn || ''); else if (btn) actions.prepend(btn);
        s._primary = btn;
      }
    };
    mark(0);
    restart();
    scheduleTrailer();
    return root;
  };
}
