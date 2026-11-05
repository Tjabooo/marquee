// Social parts of the web client: thumbs up/down with "Liked by …", the Popular on Marquee shelf,
// planned watch parties, the room's chat and reactions, and Marquee Wrapped. app.js passes in its
// helpers (h, api, toast, …) so this file has no globals of its own beyond the DOM.

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
  if (rest <= 0) return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown[0];
  return `${shown.join(', ')} and ${rest === 1 ? '1 other' : `${rest} others`}`;
}

export function likedText({ mine, likedBy = [] }) {
  if (!likedBy.length) return mine === 1 ? 'You liked this' : '';
  return `Liked by ${mine === 1 ? 'you, ' : ''}${namesText(likedBy)}`;
}

// "in 3 h 12 min", "in 4:59", "now"
export function countdownText(ms) {
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  if (s < 3600) return `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const hours = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60);
  if (hours < 48) return `in ${hours} h${min ? ` ${min} min` : ''}`;
  return `in ${Math.round(hours / 24)} days`;
}

export function startLabel(ms, now = Date.now()) {
  const d = new Date(ms), today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(12, 0, 0, 0) - new Date(today).setHours(12, 0, 0, 0)) / 86400000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })} at ${time}`;
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
  if (h >= 10) return `${Math.round(h)} hours`;
  if (h >= 1) return `${Math.round(h * 10) / 10} hours`;
  return `${Math.max(1, Math.round(seconds / 60))} minutes`;
};

export function createSocial({ h, api, jsonPost, toast, icon }) {
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
    const up = h('button', { type: 'button', class: 'thumb', 'aria-pressed': 'false', 'aria-label': 'I like this' }, thumbSvg(false));
    const down = h('button', { type: 'button', class: 'thumb', 'aria-pressed': 'false', 'aria-label': 'Not for me' }, thumbSvg(true));
    const who = h('span', { class: 'liked-by', 'aria-live': 'polite' });
    const el = h('div', { class: 'rate-row', role: 'group', 'aria-label': 'Rate this title' }, up, down, who);
    let current = { key, mine: 0, likedBy: [] };
    const paint = (r) => {
      current = r; cache.set(key, r);
      up.setAttribute('aria-pressed', String(r.mine === 1));
      down.setAttribute('aria-pressed', String(r.mine === -1));
      who.textContent = likedText(r);
      down.title = r.mine === -1 ? 'Only you see this' : 'Not for me (only you see this)';
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
        : t.viewers > 1 ? `${t.viewers} people watched` : t.youLiked ? '♥ You liked this' : t.viewers ? 'Watched here' : '';
      if (note) li.querySelector('.sub')?.replaceChildren(h('span', { class: 'popular-why' }, note));
      return li;
    });
    return carousel('Popular on Marquee', h('ul', { class: 'shelf-items', tabindex: '0', 'aria-label': 'Popular on Marquee' }, cards));
  }

  // ---------- watch parties ----------
  // The planning sheet: pick a time, get the invite. onPlanned(room) after it's created.
  function planPartyBody({ file, title, onPlanned }) {
    const input = h('input', { type: 'datetime-local', class: 'party-when', value: localInputValue(suggestedStart()),
      min: localInputValue(Date.now() + 60000), max: localInputValue(Date.now() + 14 * 86400000), 'aria-label': 'Start time' });
    const status = h('p', { class: 'muted', role: 'status' });
    const quick = [['In 15 min', 15], ['In 1 hour', 60], ['Tonight 20:00', null]].map(([label, min]) =>
      h('button', { type: 'button', class: 'chip', onclick: () => {
        input.value = localInputValue(min == null ? suggestedStart() : Date.now() + min * 60000);
      } }, label));
    const create = h('button', { type: 'button', class: 'play-btn', onclick: async () => {
      const startsAt = new Date(input.value).getTime();
      if (!Number.isFinite(startsAt)) { status.textContent = 'Pick a day and time.'; return; }
      create.disabled = true; status.textContent = '';
      try {
        const room = await api('/api/watch/plan', jsonPost({ id: file.id, startsAt }));
        onPlanned?.(room);
      } catch (err) { status.textContent = err.message; }
      finally { create.disabled = false; }
    } }, 'Plan the party');
    return [h('h2', { id: 'picker-title' }, 'Plan a watch party'),
      h('p', { class: 'del-name' }, title),
      h('p', { class: 'muted' }, 'Everyone with the link sees a countdown, and playback starts by itself at this time for whoever has joined.'),
      h('div', { class: 'party-quick' }, ...quick), input, create, status];
  }

  function plannedBody({ room, link, copy, title }) {
    return [h('h2', { id: 'picker-title' }, 'Party planned'),
      h('p', { class: 'del-name' }, title),
      h('p', {}, `Starts ${startLabel(room.startsAt)}. Send the invite to whoever's watching; the party also waits for you in Library.`),
      h('button', { type: 'button', class: 'play-btn', onclick: () => copy(link) }, icon('copy'), 'Copy invite')];
  }

  // Library shelf: planned parties you made or joined, with a live countdown.
  function partiesShelf(parties, { join, copy, cancel, label }) {
    if (!parties.length) return null;
    const items = parties.map((p) => {
      const when = h('span', { class: 'party-when-text' });
      const tick = () => { when.textContent = p.started ? 'Started' : `${countdownText(p.startsAt - Date.now())} · ${startLabel(p.startsAt)}`; };
      tick();
      when.tick = tick;
      return h('li', { class: 'party-card' },
        h('div', { class: 'party-text' }, h('strong', {}, label(p.media)), when,
          h('span', { class: 'muted' }, p.mine ? 'You planned this' : `Planned by ${p.host}`)),
        h('div', { class: 'party-actions' },
          h('button', { type: 'button', class: 'chip primary', onclick: () => join(p) }, p.started ? 'Join' : 'Wait in room'),
          h('button', { type: 'button', class: 'chip', onclick: () => copy(p) }, 'Invite'),
          p.mine && h('button', { type: 'button', class: 'chip', onclick: (e) => cancel(p, e.currentTarget) }, 'Cancel')));
    });
    const section = h('section', { class: 'shelf parties-shelf', 'aria-label': 'Watch parties' },
      h('div', { class: 'shelf-head' }, h('h3', {}, 'Watch parties')), h('ul', { class: 'party-list' }, items));
    const timer = setInterval(() => {
      if (!section.isConnected) { clearInterval(timer); return; }
      for (const li of items) li.querySelector('.party-when-text').tick();
    }, 1000);
    return section;
  }

  // ---------- in-room chat and reactions ----------
  // Floating emoji over the video; several at once drift apart.
  function burst(layer, emoji, name) {
    if (!layer || layer.childElementCount > 40) return;
    const el = h('span', { class: 'reaction-float', 'aria-hidden': 'true' }, emoji, name && h('small', {}, name));
    el.style.setProperty('--x', `${Math.round(Math.random() * 60 - 30)}px`);
    el.style.setProperty('--r', `${Math.round(Math.random() * 30 - 15)}deg`);
    layer.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  // A message shown over the video for a few seconds, even with the controls hidden.
  function floatMessage(layer, msg) {
    if (!layer) return;
    const el = h('div', { class: 'chat-float' }, h('strong', {}, msg.name), ' ', msg.text);
    layer.append(el);
    while (layer.childElementCount > 3) layer.firstElementChild.remove();
    setTimeout(() => el.classList.add('gone'), 6500);
    setTimeout(() => el.remove(), 7200);
  }

  function chatLine(msg, mine) {
    const time = new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return h('li', { class: `chat-line${mine ? ' mine' : ''}` }, h('strong', {}, mine ? 'You' : msg.name), h('time', {}, time), h('p', {}, msg.text));
  }

  // ---------- Marquee Wrapped ----------
  // A short story of slides: tap or arrow keys to move on. data from /api/me/wrapped.
  function wrappedSlides(w, { name }) {
    const big = (text) => h('p', { class: 'wr-big' }, text);
    const small = (text) => text && h('p', { class: 'wr-small' }, text);
    const slides = [];
    const slide = (cls, ...kids) => slides.push(h('section', { class: `wr-slide ${cls}` }, ...kids.filter(Boolean)));
    if (w.empty) {
      slide('wr-a', h('p', { class: 'wr-kicker' }, `Marquee Wrapped ${w.year}`), big('Nothing here yet'),
        small('Watch something and your year starts filling in. Wrapped counts the time you actually spend watching.'));
      return slides;
    }
    slide('wr-a', h('p', { class: 'wr-kicker' }, `Marquee Wrapped ${w.year}`), big(`${name ? `${name}, ` : ''}here's your year`),
      small('Tap to continue'));
    slide('wr-b', h('p', { class: 'wr-kicker' }, 'You watched'), big(fmtHours(w.seconds)),
      small(`${w.titles} ${w.titles === 1 ? 'title' : 'titles'}: ${w.films} ${w.films === 1 ? 'film' : 'films'} and ${w.episodes} ${w.episodes === 1 ? 'episode' : 'episodes'}, on ${w.activeDays} ${w.activeDays === 1 ? 'day' : 'days'}.`),
      w.people > 1 && small(w.rank === 1 ? `More than anyone else on Marquee (${w.people} people watched).` : `Number ${w.rank} of the ${w.people} people who watched here.`));
    if (w.top?.length) slide('wr-c', h('p', { class: 'wr-kicker' }, 'Your top titles'),
      h('ol', { class: 'wr-list' }, w.top.map((t) => h('li', {}, h('span', {}, t.title),
        h('small', {}, t.tv && t.episodes ? `${t.episodes} ${t.episodes === 1 ? 'episode' : 'episodes'} · ${fmtHours(t.seconds)}` : fmtHours(t.seconds))))));
    if (w.topShow) slide('wr-d', h('p', { class: 'wr-kicker' }, 'Your show of the year'), big(w.topShow.title),
      small(`${w.topShow.episodes} ${w.topShow.episodes === 1 ? 'episode' : 'episodes'}, ${fmtHours(w.topShow.seconds)}.`));
    const busy = new Date(`${w.busiestDay.day}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    const max = Math.max(...w.months, 1);
    slide('wr-e', h('p', { class: 'wr-kicker' }, 'When you watched'), big(w.busiestMonth),
      h('div', { class: 'wr-months', 'aria-hidden': 'true' }, w.months.map((s) => h('i', { style: `--v:${(s / max).toFixed(3)}` }))),
      small(`${w.busiestWeekday}s were your night. Your biggest day was ${busy} (${fmtHours(w.busiestDay.seconds)}).`),
      w.streak.days > 1 && small(`Longest run: ${w.streak.days} days in a row.`));
    if (w.company?.length) slide('wr-f', h('p', { class: 'wr-kicker' }, 'Watched together'), big(namesText(w.company.map((c) => c.name))),
      small(`${fmtHours(w.together)} in Watch Together rooms${w.company[0] ? `, most of it with ${w.company[0].name}` : ''}.`));
    slide('wr-g', h('p', { class: 'wr-kicker' }, 'It all started with'), big(w.first.title),
      small(w.first.season != null ? `Season ${w.first.season}, episode ${w.first.episode}` : ''),
      w.likes > 0 && small(`You gave ${w.likes} thumbs up${w.liked?.length ? `, including ${w.liked.slice(0, 3).join(', ')}` : ''}.`),
      small('See you next year.'));
    return slides;
  }

  return { rateRow, refreshRates, popularShelf, planPartyBody, plannedBody, partiesShelf, burst, floatMessage, chatLine, wrappedSlides };
}
