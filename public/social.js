// Social parts of the web client: thumbs up/down with "Liked by …", the Popular on Marquee shelf,
// planned watch parties, the room's chat and reactions, and Marquee Wrapped. app.js passes in its
// helpers (h, api, toast, …) so this file has no globals of its own beyond the DOM.
import { T, locale } from './i18n.js';

export const REACTIONS = ['😂', '😮', '😍', '😢', '😱', '👏', '🔥', '👍'];

// "movie:603" / "tv:1399" for anything with a TMDB id: a Discover title, a library film or a show.
export function titleKeyOf(t) {
  if (!t) return null;
  if (t.type && t.id != null && /^\d+$/.test(String(t.id))) return `${t.type === 'tv' ? 'tv' : 'movie'}:${t.id}`;
  const show = /^tv-(\d+)$/.exec(String(t.show || t.showId || ''));
  if (show) return `tv:${show[1]}`;
  if (t.tmdbId && t.season == null) return `movie:${t.tmdbId}`;
  if (t.tmdbId && t.isShow) return `tv:${t.tmdbId}`;
  return null;
}

// "Anna", "Anna and Ben", "Anna, Ben and 2 others"
export function namesText(names, total = names.length) {
  const shown = names.slice(0, 2);
  const rest = total - shown.length;
  if (!shown.length) return '';
  if (rest <= 0) return shown.length === 2 ? T('{0} and {1}', shown[0], shown[1]) : shown[0];
  return T('{0} and {1}', shown.join(', '), rest === 1 ? T('1 other') : T('{0} others', rest));
}

export function likedText({ mine, likedBy = [] }) {
  if (!likedBy.length) return mine === 1 ? T('You liked this') : '';
  return T('Liked by {0}{1}', mine === 1 ? T('you, ') : '', namesText(likedBy));
}

// "in 3 h 12 min", "in 4:59", "now"
export function countdownText(ms) {
  if (ms <= 0) return T('now');
  const s = Math.ceil(ms / 1000);
  if (s < 3600) return T('in {0}:{1}', Math.floor(s / 60), String(s % 60).padStart(2, '0'));
  const hours = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60);
  if (hours < 48) return T('in {0} h{1}', hours, min ? T(' {0} min', min) : '');
  return T('in {0} days', Math.round(hours / 24));
}

export function startLabel(ms, now = Date.now()) {
  const d = new Date(ms), today = new Date(now);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(12, 0, 0, 0) - new Date(today).setHours(12, 0, 0, 0)) / 86400000);
  if (days === 0) return T('today at {0}', time);
  if (days === 1) return T('tomorrow at {0}', time);
  return T('{0} at {1}', d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' }), time);
}

// The value for <input type="datetime-local">, in local time.
export function localInputValue(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A sensible default for a new party: tonight at 20:00, or the next full hour once that's passed.
export function suggestedStart(now = Date.now()) {
  const tonight = new Date(now); tonight.setHours(20, 0, 0, 0);
  if (tonight.getTime() - now > 15 * 60000) return tonight.getTime();
  const next = new Date(now); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  if (next.getTime() - now < 15 * 60000) next.setHours(next.getHours() + 1);
  return next.getTime();
}

export const fmtHours = (seconds) => {
  const h = seconds / 3600;
  if (h >= 10) return T('{0} hours', Math.round(h));
  if (h >= 1) return T('{0} hours', Math.round(h * 10) / 10);
  return T('{0} minutes', Math.max(1, Math.round(seconds / 60)));
};

export function createSocial({ h, api, jsonPost, toast, icon, people }) {
  const faces = (list, opts) => people?.faces(list, opts) || null;
  const face = (p, opts) => people?.face(p, opts) || null;
  const thumbSvg = (down) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<path d="M7 11v9H4v-9zM7 11l4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.5 20H7"/>';
    if (down) s.style.transform = 'scaleY(-1)';
    return s;
  };

  // Thumbs up/down plus who else liked it. Rendered empty, then filled in when the server answers.
  const openRows = new Set();
  const cache = new Map(); // key -> last answer, so a re-rendered sheet doesn't flicker
  function rateRow(key, title) {
    if (!key) return null;
    const up = h('button', { type: 'button', class: 'thumb', 'aria-pressed': 'false', 'aria-label': T('I like this') }, thumbSvg(false));
    const down = h('button', { type: 'button', class: 'thumb', 'aria-pressed': 'false', 'aria-label': T('Not for me') }, thumbSvg(true));
    const whoFaces = h('span', { class: 'liked-faces' });
    const whoText = h('span', { class: 'liked-text', 'aria-live': 'polite' });
    const who = h('span', { class: 'liked-by' }, whoFaces, whoText);
    const el = h('div', { class: 'rate-row', role: 'group', 'aria-label': T('Rate this title') }, up, down, who);
    let current = { key, mine: 0, likedBy: [] };
    const paint = (r) => {
      current = r; cache.set(key, r);
      up.setAttribute('aria-pressed', String(r.mine === 1));
      down.setAttribute('aria-pressed', String(r.mine === -1));
      whoText.textContent = likedText(r);
      const list = [...(r.mine === 1 && people?.me?.() ? [people.me()] : []), ...(r.people || r.likedBy.map((name) => ({ name })))];
      whoFaces.replaceChildren(...[faces(list, { size: 26, max: 4 })].filter(Boolean));
      down.title = r.mine === -1 ? T('Only you see this') : T('Not for me (only you see this)');
    };
    const send = async (value) => {
      const before = current;
      paint({ ...current, mine: value });
      try { paint(await api('/api/social/rate', jsonPost({ key, value, title }))); }
      catch (err) { paint(before); toast(err.message); }
    };
    up.onclick = () => send(current.mine === 1 ? 0 : 1);
    down.onclick = () => send(current.mine === -1 ? 0 : -1);
    if (cache.has(key)) paint(cache.get(key));
    el.refresh = () => api(`/api/social/title?key=${encodeURIComponent(key)}`).then(paint).catch(() => {});
    el.refresh();
    openRows.add(el);
    return el;
  }
  // Live update: someone else rated something; refresh the rows still on screen.
  function refreshRates() {
    for (const el of openRows) { if (!el.isConnected) openRows.delete(el); else el.refresh(); }
  }

  // Popular on Marquee: what the household liked and watched lately. null when there's nothing yet.
  async function popularShelf(type, { carousel, titleCard, signal }) {
    let items = [];
    try { items = (await api(`/api/social/popular?type=${type}`, { signal })).items || []; } catch { return null; }
    if (!items.length) return null;
    const cards = items.map((t) => {
      const li = titleCard(t);
      const note = t.likedBy?.length ? `♥ ${namesText(t.likedBy, t.likes - (t.youLiked ? 1 : 0))}`
        : t.viewers > 1 ? T('{0} people watched', t.viewers) : t.youLiked ? T('♥ You liked this') : t.viewers ? T('Watched here') : '';
      if (note) li.querySelector('.sub')?.replaceChildren(h('span', { class: 'popular-why' }, faces(t.people, { size: 18, max: 3 }), h('span', {}, note)));
      return li;
    });
    return carousel(T('Popular on Marquee'), h('ul', { class: 'shelf-items', tabindex: '0', 'aria-label': T('Popular on Marquee') }, cards));
  }

  // ---------- watch parties ----------
  // The planning sheet: pick a time, get the invite. onPlanned(room) after it's created.
  function planPartyBody({ file, title, onPlanned }) {
    const input = h('input', { type: 'datetime-local', class: 'party-when', value: localInputValue(suggestedStart()),
      min: localInputValue(Date.now() + 60000), max: localInputValue(Date.now() + 14 * 86400000), 'aria-label': T('Start time') });
    const status = h('p', { class: 'muted', role: 'status' });
    const quick = [[T('In 15 min'), 15], [T('In 1 hour'), 60], [T('Tonight 20:00'), null]].map(([label, min]) =>
      h('button', { type: 'button', class: 'chip', onclick: () => {
        input.value = localInputValue(min == null ? suggestedStart() : Date.now() + min * 60000);
      } }, label));
    const create = h('button', { type: 'button', class: 'play-btn', onclick: async () => {
      const startsAt = new Date(input.value).getTime();
      if (!Number.isFinite(startsAt)) { status.textContent = T('Pick a day and time.'); return; }
      create.disabled = true; status.textContent = '';
      try {
        const room = await api('/api/watch/plan', jsonPost({ id: file.id, startsAt }));
        onPlanned?.(room);
      } catch (err) { status.textContent = err.message; }
      finally { create.disabled = false; }
    } }, T('Plan the party'));
    return [h('h2', { id: 'picker-title' }, T('Plan a watch party')),
      h('p', { class: 'del-name' }, title),
      h('p', { class: 'muted' }, T('Everyone with the link sees a countdown, and playback starts by itself at this time for whoever has joined.')),
      h('div', { class: 'party-quick' }, ...quick), input, create, status];
  }

  function plannedBody({ room, link, copy, title }) {
    return [h('h2', { id: 'picker-title' }, T('Party planned')),
      h('p', { class: 'del-name' }, title),
      h('p', {}, T('Starts {0}. Send the invite to whoever\'s watching; the party also waits for you in Library.', startLabel(room.startsAt))),
      h('button', { type: 'button', class: 'play-btn', onclick: () => copy(link) }, icon('copy'), T('Copy invite'))];
  }

  // Library shelf: planned parties you made or joined, with a live countdown.
  function partiesShelf(parties, { join, copy, cancel, label }) {
    if (!parties.length) return null;
    const items = parties.map((p) => {
      const when = h('span', { class: 'party-when-text' });
      const tick = () => { when.textContent = p.started ? T('Started') : `${countdownText(p.startsAt - Date.now())} · ${startLabel(p.startsAt)}`; };
      tick();
      when.tick = tick;
      const here = p.faces?.length ? T('{0} {1} in the room', namesText(p.faces.map((f) => f.name)), p.faces.length === 1 ? T('is') : T('are')) : '';
      return h('li', { class: 'party-card' },
        face({ name: p.host, avatar: p.hostAvatar }, { size: 44, cls: 'party-host' }),
        h('div', { class: 'party-text' }, h('strong', {}, label(p.media)), when,
          h('span', { class: 'muted' }, p.mine ? T('You planned this') : T('Planned by {0}', p.host)),
          here && h('span', { class: 'party-here' }, faces(p.faces, { size: 20, max: 5 }), h('span', {}, here))),
        h('div', { class: 'party-actions' },
          h('button', { type: 'button', class: 'chip primary', onclick: () => join(p) }, p.started ? T('Join') : T('Wait in room')),
          h('button', { type: 'button', class: 'chip', onclick: () => copy(p) }, T('Invite')),
          p.mine && h('button', { type: 'button', class: 'chip', onclick: (e) => cancel(p, e.currentTarget) }, T('Cancel'))));
    });
    const section = h('section', { class: 'shelf parties-shelf', 'aria-label': T('Watch parties') },
      h('div', { class: 'shelf-head' }, h('h3', {}, T('Watch parties'))), h('ul', { class: 'party-list' }, items));
    const timer = setInterval(() => {
      if (!section.isConnected) { clearInterval(timer); return; }
      for (const li of items) li.querySelector('.party-when-text').tick();
    }, 1000);
    return section;
  }

  // ---------- in-room chat and reactions ----------
  // Floating emoji over the video; several at once drift apart.
  function burst(layer, emoji, name, avatar = null) {
    if (!layer || layer.childElementCount > 40) return;
    const el = h('span', { class: 'reaction-float', 'aria-hidden': 'true' }, emoji,
      name && h('small', {}, face({ name, avatar }, { size: 16 }), name));
    el.style.setProperty('--x', `${Math.round(Math.random() * 60 - 30)}px`);
    el.style.setProperty('--r', `${Math.round(Math.random() * 30 - 15)}deg`);
    layer.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  // A message shown over the video for a few seconds, even with the controls hidden.
  function floatMessage(layer, msg) {
    if (!layer) return;
    const el = h('div', { class: 'chat-float' }, face(msg, { size: 26 }),
      h('span', { class: 'chat-float-text' }, h('strong', {}, msg.name), h('span', {}, msg.text)));
    layer.append(el);
    while (layer.childElementCount > 3) layer.firstElementChild.remove();
    setTimeout(() => el.classList.add('gone'), 6500);
    setTimeout(() => el.remove(), 7200);
  }

  // One chat message. prev: the message before it; a run from the same person within a few minutes
  // shows their face and name once.
  function chatLine(msg, mine, prev = null) {
    const time = new Date(msg.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const cont = prev && prev.from === msg.from && msg.at - prev.at < 3 * 60000;
    return h('li', { class: `chat-line${mine ? ' mine' : ''}${cont ? ' cont' : ''}` },
      !mine && (cont ? h('span', { class: 'chat-gap', 'aria-hidden': 'true' }) : face(msg, { size: 30, cls: 'chat-face' })),
      h('div', { class: 'chat-bubble' },
        !cont && h('div', { class: 'chat-meta' }, h('strong', {}, mine ? T('You') : msg.name), h('time', { datetime: new Date(msg.at).toISOString() }, time)),
        h('p', {}, msg.text)));
  }

  // ---------- Marquee Wrapped ----------
  // A short story of slides: tap or arrow keys to move on. data from /api/me/wrapped.
  function wrappedSlides(w, { name }) {
    const big = (text) => h('p', { class: 'wr-big' }, text);
    const small = (text) => text && h('p', { class: 'wr-small' }, text);
    const slides = [];
    const slide = (cls, ...kids) => slides.push(h('section', { class: `wr-slide ${cls}` }, ...kids.filter(Boolean)));
    if (w.empty) {
      slide('wr-a', h('p', { class: 'wr-kicker' }, T('Marquee Wrapped {0}', w.year)), big(T('Nothing here yet')),
        small(T('Watch something and your year starts filling in. Wrapped counts the time you actually spend watching.')));
      return slides;
    }
    slide('wr-a', h('p', { class: 'wr-kicker' }, T('Marquee Wrapped {0}', w.year)), big(T('{0}here\'s your year', name ? `${name}, ` : '')),
      small(T('Tap to continue')));
    slide('wr-b', h('p', { class: 'wr-kicker' }, T('You watched')), big(fmtHours(w.seconds)),
      small(T('{0} {1}: {2} {3} and {4} {5}, on {6} {7}.', w.titles, w.titles === 1 ? T('title') : T('titles'), w.films, w.films === 1 ? T('film') : T('films'), w.episodes, w.episodes === 1 ? T('episode') : T('episodes'), w.activeDays, w.activeDays === 1 ? T('day') : T('days'))),
      w.people > 1 && small(w.rank === 1 ? T('More than anyone else on Marquee ({0} people watched).', w.people) : T('Number {0} of the {1} people who watched here.', w.rank, w.people)));
    if (w.top?.length) slide('wr-c', h('p', { class: 'wr-kicker' }, T('Your top titles')),
      h('ol', { class: 'wr-list' }, w.top.map((t) => h('li', {}, h('span', {}, t.title),
        h('small', {}, t.tv && t.episodes ? `${t.episodes} ${t.episodes === 1 ? T('episode') : T('episodes')} · ${fmtHours(t.seconds)}` : fmtHours(t.seconds))))));
    if (w.topShow) slide('wr-d', h('p', { class: 'wr-kicker' }, T('Your show of the year')), big(w.topShow.title),
      small(`${w.topShow.episodes} ${w.topShow.episodes === 1 ? T('episode') : T('episodes')}, ${fmtHours(w.topShow.seconds)}.`));
    const busy = new Date(`${w.busiestDay.day}T12:00:00`).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
    const max = Math.max(...w.months, 1);
    slide('wr-e', h('p', { class: 'wr-kicker' }, T('When you watched')), big(w.busiestMonth),
      h('div', { class: 'wr-months', 'aria-hidden': 'true' }, w.months.map((s) => h('i', { style: `--v:${(s / max).toFixed(3)}` }))),
      small(T('{0}s were your night. Your biggest day was {1} ({2}).', w.busiestWeekday, busy, fmtHours(w.busiestDay.seconds))),
      w.streak.days > 1 && small(T('Longest run: {0} days in a row.', w.streak.days)));
    if (w.company?.length) slide('wr-f', h('p', { class: 'wr-kicker' }, T('Watched together')),
      h('div', { class: 'wr-faces' }, w.company.slice(0, 5).map((c) => face(c, { size: 72 }))),
      big(namesText(w.company.map((c) => c.name))),
      small(T('{0} in Watch Together rooms{1}.', fmtHours(w.together), w.company[0] ? T(', most of it with {0}', w.company[0].name) : '')));
    slide('wr-g', h('p', { class: 'wr-kicker' }, T('It all started with')), big(w.first.title),
      small(w.first.season != null ? T('Season {0}, episode {1}', w.first.season, w.first.episode) : ''),
      w.likes > 0 && small(T('You gave {0} thumbs up{1}.', w.likes, w.liked?.length ? T(', including {0}', w.liked.slice(0, 3).join(', ')) : '')),
      small(T('See you next year.')));
    return slides;
  }

  return { rateRow, refreshRates, popularShelf, planPartyBody, plannedBody, partiesShelf, burst, floatMessage, chatLine, wrappedSlides };
}
