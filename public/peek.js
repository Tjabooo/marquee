// Peek: a closer look at a title without leaving the row. With a mouse, resting on a poster for a
// moment grows it into a floating card (backdrop, logo, meta, a line of story, Play/Add and More info).
// On a touch screen a long press opens the same card as a sheet; the tap that ends the press doesn't
// also open the title. Cards opt in by carrying their title as `button._title` (app.js titleCard).
import { T } from './i18n.js';

const HOVER_MS = 550;
const PRESS_MS = 480;

export function createPeek({ h, icon, pageInfo, openDetails, quickAction, ownershipBadge, metaFor, bigArt }) {
  const panel = h('div', { class: 'peek', role: 'dialog', 'aria-modal': 'false', hidden: true });
  const shade = h('div', { class: 'peek-shade', hidden: true });
  document.body.append(shade, panel);
  let card = null, hoverTimer = null, pressTimer = null, pressStart = null, swallowUntil = 0, mode = null;

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hoverable = () => matchMedia('(hover: hover) and (pointer: fine) and (min-width: 900px)').matches;

  function fill(t) {
    const quick = quickAction(t);
    const title = h('h3', { class: 'peek-title', id: 'peek-title' }, t.title);
    const art = t.backdrop || t.wide || t.poster;
    const body = [
      h('div', { class: 'peek-art' }, art ? h('img', { src: bigArt(art, 780), alt: '', decoding: 'async' }) : null, ownershipBadge(t)),
      h('div', { class: 'peek-body' },
        title,
        h('p', { class: 'peek-meta' }, metaFor(t)),
        t.overview && h('p', { class: 'peek-overview' }, t.overview),
        h('div', { class: 'peek-actions' },
          quick && h('button', { type: 'button', class: 'play-btn', onclick: (e) => { const b = e.currentTarget; hide(); quick.run(b); } }, icon(quick.icon), h('span', {}, quick.label)),
          h('button', { type: 'button', class: 'chip', onclick: () => { const opener = card; hide(); openDetails(t, opener); } }, icon('info'), T('More info')))),
    ];
    panel.replaceChildren(...body);
    panel.setAttribute('aria-labelledby', 'peek-title');
    if (t.id && ['movie', 'tv'].includes(t.type)) pageInfo(t.type, t.id).then((page) => {
      if (!page?.logo || panel.hidden || panel._t !== t) return;
      const logo = h('img', { class: 'peek-logo', src: page.logo.url, alt: t.title, decoding: 'async' });
      logo.addEventListener('load', () => title.replaceChildren(logo), { once: true });
    }).catch(() => {});
    panel._t = t;
  }

  // Floating over the card it grew from, kept inside the window.
  function place(from) {
    const r = from.getBoundingClientRect();
    const width = Math.min(Math.max(r.width * 1.9, 340), 440, innerWidth - 32);
    let left = r.left + r.width / 2 - width / 2;
    left = Math.max(16, Math.min(left, innerWidth - width - 16));
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    const height = panel.offsetHeight || 380;
    let top = r.top + r.height / 2 - height / 2;
    top = Math.max(16 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head-h')) || 0), Math.min(top, innerHeight - height - 16));
    panel.style.top = `${top}px`;
    panel.style.transformOrigin = `${r.left + r.width / 2 - left}px ${r.top + r.height / 2 - top}px`;
  }

  function show(from, how) {
    const t = from._title;
    if (!t) return;
    card = from; mode = how;
    fill(t);
    panel.classList.toggle('is-sheet', how === 'press');
    panel.hidden = false;
    shade.hidden = how !== 'press';
    if (how === 'hover') place(from);
    else { panel.style.cssText = ''; }
    requestAnimationFrame(() => { panel.classList.add('open'); shade.classList.add('open'); });
    if (how === 'press') { panel.setAttribute('aria-modal', 'true'); panel.querySelector('button')?.focus({ preventScroll: true }); }
    else panel.setAttribute('aria-modal', 'false');
  }
  function hide() {
    clearTimeout(hoverTimer);
    if (panel.hidden) return;
    panel.classList.remove('open'); shade.classList.remove('open');
    const was = panel;
    setTimeout(() => { if (!was.classList.contains('open')) { was.hidden = true; shade.hidden = true; } }, reduced() ? 0 : 200);
    if (mode === 'press' && card?.isConnected) card.focus({ preventScroll: true });
    card = null; mode = null;
  }

  // ---- mouse: rest on a card ----
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' || !hoverable()) return;
    const c = e.target.closest?.('.title-card');
    if (!c?._title || c === card) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (c.matches(':hover')) { if (card) hide(); show(c, 'hover'); } }, HOVER_MS);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const to = e.relatedTarget;
    const c = e.target.closest?.('.title-card');
    if (c && !c.contains(to) && !panel.contains(to)) clearTimeout(hoverTimer);
    if (mode === 'hover' && !panel.contains(to) && !card?.contains(to)) hide();
  });
  panel.addEventListener('pointerleave', (e) => { if (mode === 'hover' && !card?.contains(e.relatedTarget)) hide(); });
  window.addEventListener('scroll', () => { if (mode === 'hover') hide(); clearTimeout(hoverTimer); }, { passive: true, capture: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode) { e.stopPropagation(); hide(); } }, true);

  // ---- touch: long press ----
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const c = e.target.closest?.('.title-card');
    if (!c?._title) return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressStart = null;
      swallowUntil = Date.now() + 800;
      navigator.vibrate?.(8);
      show(c, 'press');
    }, PRESS_MS);
  }, { passive: true });
  const cancelPress = () => { clearTimeout(pressTimer); pressStart = null; };
  document.addEventListener('pointermove', (e) => {
    if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  }, { passive: true });
  document.addEventListener('pointerup', cancelPress, { passive: true });
  document.addEventListener('pointercancel', cancelPress, { passive: true });
  // Android's long-press menu and iOS's callout would otherwise appear over the peek.
  document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.title-card')?._title && matchMedia('(pointer: coarse)').matches) e.preventDefault(); });
  shade.addEventListener('click', hide);

  return {
    // A card's click right after its long press opened the peek: don't also open the title.
    swallow(e) { if (Date.now() < swallowUntil) { e.preventDefault(); swallowUntil = 0; return true; } return false; },
    hide,
  };
}
