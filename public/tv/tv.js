// Marquee's TV app, loaded by the shell in tv/tizen (Samsung) or tv/android (Android TV, which gives it the same
// AVPlay, tizen.* and key codes). Library, Discover, Search and smart downloads.
// Remote-control navigation, the TV's own player (AVPlay: MKV, HEVC, surround),
// and Skip intro / Up next on the screen itself.
// Written for the TV's browser engine (Samsung 2020 = Chrome 69): no optional chaining, nullish coalescing, or newer built-ins.
(function () {
  'use strict';
  var L = window.MarqueeTvLogic;
  var T = L.T; // Swedish when the shell loaded public/tv/sv.js (Samsung always; Android on a Swedish TV), else English
  var SERVER = String(window.MARQUEE_SERVER || '').replace(/\/+$/, '');
  var TOKEN_KEY = 'marquee:tv-session';    // a session token, or "home" for the shared Home network account
  var WATCHED_KEY = 'marquee:tv-watched';  // episodes finished on this TV, to pick where a show continues
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, BACKSPACE: 8, ESC: 27,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412 };
  var app = document.getElementById('app');
  var state = { me: null, library: [], shows: [], progress: {}, genres: [], pending: [], focusPending: false };
  var screen = null;
  var history = [];
  var autoChain = 0;

  // ---------- small helpers ----------
  function h(tag, props) {
    var el = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  function img(src, cls) {
    var i = h('img', { class: cls || '', alt: '', decoding: 'async' });
    if (src) i.src = src; else i.className += ' is-empty';
    i.onerror = function () { i.removeAttribute('src'); i.className += ' is-empty'; };
    return i;
  }
  function bigger(src) { return src ? String(src).replace('/t/p/w300/', '/t/p/w780/') : src; }
  var toastTimer = null;
  function toast(text) {
    var t = document.getElementById('toast') || document.body.appendChild(h('div', { id: 'toast', role: 'status' }));
    t.textContent = text; t.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 3500);
  }
  function load(key, fallback) { try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function token() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }

  // "Medverkande: …" under a description; stays empty when TMDB has no cast or the title isn't on TMDB.
  // The title as TMDB's logo art when there is one (like the web app's title pages); the text stays until it has loaded.
  function titleLogo(heading, type, id, name) {
    if (!id || (type !== 'movie' && type !== 'tv')) return heading;
    api('/api/title/' + type + '/' + id + '/page').then(function (d) {
      var logo = d.page && d.page.logo;
      if (!logo || !logo.url) return;
      var pic = new Image();
      pic.className = 'title-logo';
      pic.alt = name || '';
      pic.onload = function () { heading.textContent = ''; heading.appendChild(pic); };
      pic.src = logo.url;
    }).catch(function () {});
    return heading;
  }

  function castLine(type, id, cls) {
    var line = h('p', { class: cls });
    if (id) api('/api/title/' + type + '/' + id + '/cast').then(function (d) {
      if (d.cast && d.cast.length) line.textContent = T('Cast:') + ' ' + d.cast.join(', ');
    }).catch(function () {});
    return line;
  }

  function api(path, body) {
    var headers = { 'X-Marquee-TV': '1', 'X-Marquee-Lang': window.MarqueeTvStrings ? 'sv' : 'en' };
    var t = token();
    if (t && t !== 'home') headers['X-Marquee-Session'] = t;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(SERVER + path, { method: body !== undefined ? 'POST' : 'GET', headers: headers, credentials: 'omit',
      body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.ok) return d;
          var e = new Error(d.error || T('Marquee answered {0}.', r.status));
          e.status = r.status;
          throw e;
        });
      });
  }

  // ---------- screens ----------
  // A screen is { el, key(code) → handled?, focus(), leave() }. Back pops to the previous screen.
  function show(next, remember) {
    if (screen && remember) history.push(screen);
    else if (screen && screen.leave) screen.leave();
    screen = next;
    app.innerHTML = '';
    app.appendChild(next.el);
    if (next.focus) next.focus();
  }
  function back() {
    var prev = history.pop();
    if (!prev) { exitApp(); return; }
    if (screen && screen.leave) screen.leave();
    screen = prev;
    app.innerHTML = '';
    app.appendChild(prev.el);
    if (prev.refresh) prev.refresh();
    if (prev.focus) prev.focus();
  }
  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* in a desktop browser */ }
  }

  document.addEventListener('keydown', function (e) {
    autoChain = 0; // someone is there: Up next may chain again
    var code = e.keyCode;
    if (code === KEY.BACKSPACE || code === KEY.ESC) code = KEY.BACK;
    if (screen && screen.key && screen.key(code, e)) { e.preventDefault(); return; }
    if (code === KEY.BACK) { e.preventDefault(); back(); }
  });

  // ---------- signing in ----------
  function start() {
    try {
      ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind'].forEach(function (k) {
        try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* not on this model */ }
      });
    } catch (e) { /* not on a TV */ }
    app.innerHTML = '';
    app.appendChild(h('div', { class: 'boot' }, h('div', { class: 'wordmark', text: 'Marquee' })));
    api('/api/status').then(function (status) {
      var me = status.me;
      var t = token();
      if (!t) return pairScreen(me && me.id != null);
      if (t !== 'home' && (!me || me.via !== 'session')) {
        // The TV's session ended (signed out elsewhere, password changed, or a year passed).
        localStorage.removeItem(TOKEN_KEY);
        return pairScreen(me && me.id != null, T('This TV was signed out. Sign it in again.'));
      }
      state.me = me;
      return Promise.all([loadLibrary(), loadGenres()]).then(homeScreen);
    }).catch(function (err) {
      if (err.status === 401) { localStorage.removeItem(TOKEN_KEY); return pairScreen(false); }
      app.innerHTML = '';
      app.appendChild(h('div', { class: 'boot' }, h('div', { class: 'wordmark', text: 'Marquee' }),
        h('p', { class: 'boot-note', text: T('Can’t reach Marquee right now ({0}). Trying again…', err.message) })));
      setTimeout(start, 5000);
    });
  }

  function pairScreen(homeAvailable, note) {
    var codeEl = h('div', { class: 'pair-code', 'aria-live': 'polite' });
    var noteEl = h('p', { class: 'pair-note', text: note || '' });
    var homeBtn = homeAvailable ? h('div', { class: 'pair-alt' }, h('span', { class: 'pair-alt-hint', text: T('No account? Press Down for') }),
      h('button', { class: 'pair-home', text: T('Use the shared Home network account') })) : null;
    var el = h('div', { class: 'screen pair' },
      h('div', { class: 'wordmark', text: 'Marquee' }),
      h('h1', { text: T('Sign in this TV') }),
      h('ol', { class: 'pair-steps' },
        h('li', {}, T('On your phone, open Marquee and go to '), h('b', { text: T('Settings') }), '.'),
        h('li', {}, T('Under '), h('b', { text: T('Sign in a TV') }), T(', enter this code:'))),
      codeEl, noteEl, homeBtn);
    var poll = null, timer = null, alive = true;
    function newCode() {
      if (!alive) return;
      api('/api/tv/pair/start', {}).then(function (r) {
        poll = r.poll;
        codeEl.innerHTML = '';
        r.code.split('').forEach(function (c, i) { codeEl.appendChild(h('span', { class: i === 3 ? 'gap' : '', text: c })); });
        noteEl.textContent = note || T('The code changes every {0} minutes.', Math.round(r.expiresIn / 60));
        check();
      }).catch(function (err) { noteEl.textContent = err.message + ' ' + T('Trying again…'); timer = setTimeout(newCode, 5000); });
    }
    function check() {
      if (!alive) return;
      timer = setTimeout(function () {
        api('/api/tv/pair/poll?id=' + encodeURIComponent(poll)).then(function (r) {
          if (r.state === 'approved') { signedIn(r.grant); return; }
          if (r.state === 'expired') { newCode(); return; }
          check();
        }).catch(function () { check(); });
      }, 2000);
    }
    function signedIn(grant) {
      alive = false;
      localStorage.setItem(TOKEN_KEY, grant.token || 'home');
      toast(T('Signed in as {0}', grant.name || T('you')));
      history = [];
      screen = null;
      start();
    }
    // Nothing is focused at first, so a stray OK can't sign the TV in as the shared account.
    var homeFocused = false;
    show({ el: el,
      key: function (code) {
        if (!homeBtn) return false;
        if (code === KEY.DOWN || code === KEY.UP) { homeFocused = code === KEY.DOWN; homeBtn.lastChild.classList.toggle('focus', homeFocused); return true; }
        if (code === KEY.ENTER && homeFocused) { signedIn({ token: null, name: 'Home network' }); return true; }
        return false;
      },
      leave: function () { alive = false; clearTimeout(timer); } });
    newCode();
  }

  function loadLibrary() {
    return Promise.all([api('/api/library'), api('/api/me/progress').catch(function () { return { progress: {} }; }), loadPending()]).then(function (r) {
      state.library = r[0].items || [];
      state.shows = r[0].shows || [];
      state.progress = r[1].progress || {};
    });
  }
  // Downloads on their way show in the library straight away. Never fails: the library works without them.
  function loadPending() {
    return api('/api/downloads').then(function (d) { state.pending = L.pendingTitles(d.items); })
      .catch(function () { state.pending = []; });
  }
  function pendingFor(t) {
    var key = t.type === 'tv' ? 'tv:tv-' + t.id : 'movie:' + t.id;
    return state.pending.filter(function (p) { return p.key === key; })[0] || null;
  }
  // Back to the library from anywhere, onto the row of what's on its way.
  function goToLibrary() {
    if (!history.length) return;
    state.focusPending = true;
    if (screen && screen.leave) screen.leave();
    while (history.length > 1) { var s = history.pop(); if (s.leave) s.leave(); }
    screen = history.pop();
    app.innerHTML = '';
    app.appendChild(screen.el);
    if (screen.refresh) screen.refresh();
    if (screen.focus) screen.focus();
  }

  // ---------- genres ----------
  // One merged list from the server: { name, movie: TMDB film genre ID, tv: TMDB show genre ID }.
  function loadGenres() {
    return api('/api/discover/genres').then(function (d) { state.genres = d.genres || []; })
      .catch(function () { state.genres = []; });
  }
  function genreNames(type, ids) {
    var out = [];
    (ids || []).forEach(function (id) {
      state.genres.forEach(function (g) { if ((type === 'tv' ? g.tv : g.movie) === id && out.indexOf(g.name) < 0) out.push(g.name); });
    });
    return out;
  }
  function genreUrl(g, type, sort, page) {
    return '/api/discover/genre?type=' + type + (g.movie && type !== 'tv' ? '&movie=' + g.movie : '') +
      (g.tv && type !== 'movie' ? '&tv=' + g.tv : '') + '&sort=' + sort + '&page=' + page;
  }

  // ---------- cards ----------
  // Posters load only when their card comes near the screen, so long rows and grids stay cheap on the TV.
  function lazy(src) {
    var i = h('img', { alt: '', decoding: 'async' });
    var woke = false;
    return { el: i, wake: function () {
      if (woke) return;
      woke = true;
      if (!src) { i.className = 'is-empty'; return; }
      i.onerror = function () { i.removeAttribute('src'); i.className = 'is-empty'; };
      i.src = src;
    } };
  }
  function badge() { return h('span', { class: 'tv-badge', text: T('In library') }); }
  function titleSub(t) { return [t.year, t.type === 'tv' ? T('Series') : T('Film')].filter(Boolean).join(' · '); }

  function onWayBar(p) { return p ? barFor(p.progress).el : null; }
  // A film or show from TMDB (Discover, search). OK opens its page.
  function titleCard(t) {
    var pic = lazy(t.poster);
    return { key: t.type + ':' + t.id, t: t, wake: pic.wake,
      el: h('div', { class: 'card tile' }, h('div', { class: 'art' }, pic.el, libraryEntry(t) ? badge() : null, onWayBar(pendingFor(t))),
        h('div', { class: 'name', text: t.title }), h('div', { class: 'sub', text: titleSub(t) })),
      open: function () { discoverTitle(t); } };
  }
  // Library cards: 'poster' on the home screen, 'tile' (with the In library badge) in search.
  function showCard(s, cls) {
    var pic = lazy(s.poster);
    return { key: s.tmdbId ? 'tv:' + s.tmdbId : s.id, wake: pic.wake,
      el: h('div', { class: 'card ' + (cls || 'poster') }, h('div', { class: 'art' }, pic.el, cls === 'tile' ? badge() : null),
        h('div', { class: 'name', text: s.title }), cls === 'tile' ? h('div', { class: 'sub', text: titleSub({ year: s.year, type: 'tv' }) }) : null),
      open: function () { showPage(s); } };
  }
  function filmCard(f, cls) {
    var pic = lazy(f.poster || f.backdrop);
    return { key: f.tmdbId ? 'movie:' + f.tmdbId : f.id, wake: pic.wake,
      el: h('div', { class: 'card ' + (cls || 'poster') }, h('div', { class: 'art' }, pic.el, cls === 'tile' ? badge() : null),
        h('div', { class: 'name', text: f.filmTitle || f.title }), h('div', { class: 'sub', text: f.year ? String(f.year) : '' })),
      open: function () { playAsked(f); } };
  }
  // A title that's still on its way: the progress updates in place, without redrawing the row.
  function pendingPercent(p) { return p.progress != null && p.progress < 1 ? Math.floor(p.progress * 100) + ' %' : ''; }
  function pendingText(p) { return [pendingPercent(p), p.word].filter(Boolean).join(' · '); }
  // The bar's fill: how far along, or a moving stripe while nobody knows yet (a torrent without its file list).
  function setBar(bar, fill, progress) {
    var unknown = progress == null;
    bar.classList.toggle('is-unknown', unknown);
    fill.style.width = unknown ? '' : (progress * 100).toFixed(1) + '%';
  }
  function barFor(progress) {
    var fill = h('i'), bar = h('div', { class: 'bar' }, fill);
    setBar(bar, fill, progress);
    return { el: bar, set: function (next) { setBar(bar, fill, next); } };
  }
  // A long bar with its words above, for a title's page. set(null) hides it.
  function progressStrip() {
    var text = h('div', { class: 'strip-text' }), fill = h('i'), bar = h('div', { class: 'strip-bar' }, fill);
    var el = h('div', { class: 'progress-strip', style: 'display:none' }, text, bar);
    return { el: el, set: function (p) {
      el.style.display = p ? '' : 'none';
      if (!p) return;
      text.textContent = pendingText(p);
      setBar(bar, fill, p.progress);
    } };
  }
  // Keeps asking how downloads are doing while a screen is open. each() runs after every answer.
  function followPending(isOpen, each) {
    function tick() {
      if (!isOpen()) return;
      loadPending().then(function () { if (isOpen()) { each(); setTimeout(tick, 5000); } });
    }
    setTimeout(tick, 5000);
  }
  function pendingForPath(path) {
    return state.pending.filter(function (p) { return p.items.some(function (d) { return d.svtPath === path; }); })[0] || null;
  }
  function pendingNamed(name) {
    var key = L.searchKey(name);
    return state.pending.filter(function (p) { return L.searchKey(p.title) === key; })[0] || null;
  }
  function pendingCard(p) {
    var pic = lazy(p.poster || p.backdrop);
    var bar = barFor(p.progress);
    var sub = h('div', { class: 'sub', text: p.word });
    var pct = h('span', { class: 'pct', text: pendingPercent(p) });
    return { key: p.key, wake: pic.wake, update: function (next) {
        bar.set(next.progress);
        sub.textContent = next.word;
        pct.textContent = pendingPercent(next);
        p = next;
      },
      el: h('div', { class: 'card poster' }, h('div', { class: 'art' }, pic.el, pct, bar.el),
        h('div', { class: 'name', text: p.title }), sub),
      open: function () {
        var show = p.type === 'tv' && state.shows.filter(function (s) { return s.id === p.showId; })[0];
        if (show) return showPage(show);
        var path = p.items[0] && p.items[0].svtPath;
        if (path) return svtScreen({ type: 'svt', path: path, title: p.title, backdrop: p.backdrop, kind: p.type === 'tv' ? 'series' : 'film' });
        if (p.tmdbId != null) return discoverTitle({ type: p.type, id: p.tmdbId, title: p.title, poster: p.poster, backdrop: p.backdrop, year: p.year });
        toast(p.word);
      } };
  }
  function continueCard(f) {
    var p = state.progress[L.progressRef(f)];
    var showInfo = showOf(f);
    var pct = Math.min(100, p.time / p.duration * 100);
    var pic = lazy(f.season != null ? bigger(f.still) || (showInfo && showInfo.backdrop) : f.backdrop || f.poster);
    return { key: f.id, wake: pic.wake,
      el: h('div', { class: 'card wide' },
        h('div', { class: 'art' }, pic.el, h('div', { class: 'bar' }, h('i', { style: 'width:' + pct.toFixed(1) + '%' }))),
        h('div', { class: 'name', text: showInfo ? showInfo.title : f.filmTitle || f.title }),
        h('div', { class: 'sub', text: [L.episodeLabel(f), f.episodeName, L.minutesLeft(p)].filter(Boolean).join(' · ') })),
      open: function () { play(f, p.time); } };
  }

  // ---------- rows of cards (home and Discover) ----------
  // A row can grow while you move along it (fetch(page) -> { cards, last }) up to ROW_MAX cards, end in a
  // "See all" card, or load its first page only when it comes near the screen (lazy). A key press touches
  // only the focused card and the focused row.
  var ROW_MAX = 60, CARD_GAP = 32, ROW_WIDTH = 1920 - 2 * 96;
  function makeRow(o) {
    var row = { kind: o.kind || 'poster', items: [], index: 0, first: 0, page: 1, busy: false, seen: {},
      fetch: o.fetch || null, done: !o.fetch, pending: Boolean(o.lazy), skip: false, seeAll: o.seeAll || null, end: null };
    row.track = h('div', { class: 'track' });
    row.note = row.pending ? h('div', { class: 'row-note', text: T('Loading…') }) : null;
    row.el = h('section', { class: 'row row-' + row.kind + (row.pending ? ' is-pending' : '') }, h('h2', { text: o.title }),
      h('div', { class: 'viewport' }, row.note, row.track));
    if (!row.pending) addEnd(row);
    if (o.items) addCards(row, o.items);
    return row;
  }
  function addEnd(row) {
    if (!row.seeAll || row.end) return;
    row.end = { el: h('div', { class: 'card see-all ' + (row.kind === 'tile' || row.kind === 'svt' ? row.kind : 'poster') }, h('div', { class: 'art' }, h('span', { text: T('See all') }))),
      open: row.seeAll };
    row.track.appendChild(row.end.el);
    row.items.push(row.end);
  }
  function addCards(row, cards) {
    var count = row.items.length - (row.end ? 1 : 0);
    cards.forEach(function (c) {
      if (count >= ROW_MAX || (c.key && row.seen[c.key])) return;
      if (c.key) row.seen[c.key] = true;
      if (row.end) { row.track.insertBefore(c.el, row.end.el); row.items.splice(row.items.length - 1, 0, c); }
      else { row.track.appendChild(c.el); row.items.push(c); }
      count++;
    });
    if (count >= ROW_MAX) row.done = true;
  }
  function pageOf(d, page) {
    return { cards: (d.results || []).map(titleCard), last: (d.page || page) >= (d.totalPages || 1) };
  }

  // Up/Down between rows, Left/Right along one. `top`: where the focused row sits in the rows box.
  function rowsNav(rowsEl, top, onFocus) {
    var nav = { rows: [], r: 0, lit: null, on: true };
    nav.find = function (from, dir) {
      for (var i = from; i >= 0 && i < nav.rows.length; i += dir) if (!nav.rows[i].skip) return i;
      return -1;
    };
    nav.set = function (rows) {
      nav.rows = rows; nav.lit = null;
      rowsEl.innerHTML = '';
      rows.forEach(function (row) { rowsEl.appendChild(row.el); });
      nav.r = Math.max(0, nav.find(0, 1));
    };
    nav.current = function () { var row = nav.rows[nav.r]; return row && !row.skip && row.items[row.index] || null; };
    nav.move = function (dir) {
      var i = nav.find(nav.r + dir, dir);
      if (i < 0) return false;
      nav.r = i; nav.paint(true);
      return true;
    };
    nav.side = function (dir) {
      var row = nav.rows[nav.r];
      if (!row || !row.items.length) return;
      row.index = Math.max(0, Math.min(row.items.length - 1, row.index + dir));
      nav.paint(true);
    };
    function slide(row) {
      if (!row.items.length) return;
      if (!row.step) { var w = row.items[0].el.offsetWidth; if (!w) return; row.step = w + CARD_GAP; }
      var visible = Math.max(1, Math.floor(ROW_WIDTH / row.step));
      var first = Math.max(0, Math.min(row.index - 1, row.items.length - visible));
      if (first !== row.first || !row.slid) {
        row.first = first; row.slid = true;
        row.track.style.transform = 'translateX(' + (-first * row.step) + 'px)';
      }
    }
    function wakeRow(row) {
      var n = Math.ceil(ROW_WIDTH / (row.step || 200)) + 2;
      for (var j = row.first; j < Math.min(row.items.length, row.first + n); j++) if (row.items[j].wake) row.items[j].wake();
    }
    function settle() {
      if (nav.rows[nav.r] && nav.rows[nav.r].skip) {
        var i = nav.find(nav.r, 1);
        if (i < 0) i = nav.find(nav.r, -1);
        if (i >= 0) nav.r = i;
      }
      nav.paint(nav.on);
    }
    function loadRow(row) {
      row.pending = false; row.busy = true;
      row.fetch(1).then(function (res) {
        row.busy = false;
        if (row.note && row.note.parentNode) row.note.parentNode.removeChild(row.note);
        row.el.classList.remove('is-pending');
        addEnd(row);
        addCards(row, res.cards);
        if (res.last) row.done = true;
        if (row.items.length <= (row.end ? 1 : 0)) { row.skip = true; row.el.style.display = 'none'; }
        settle();
      }).catch(function () { row.busy = false; row.skip = true; row.el.style.display = 'none'; settle(); });
    }
    function more(row) {
      var count = row.items.length - (row.end ? 1 : 0);
      if (row.done || row.busy || !row.fetch || row.index < count - 8) return;
      row.busy = true;
      row.fetch(row.page + 1).then(function (res) {
        row.busy = false; row.page++;
        var before = row.items.length;
        addCards(row, res.cards);
        if (res.last || row.items.length === before) row.done = true;
        if (row === nav.rows[nav.r]) nav.paint(nav.on); else wakeRow(row);
      }).catch(function () { row.busy = false; row.done = true; });
    }
    nav.paint = function (on) {
      nav.on = on !== false;
      var row = nav.rows[nav.r];
      var card = nav.on && row && !row.skip ? row.items[row.index] : null;
      var el = card ? card.el : null;
      if (nav.lit !== el) {
        if (nav.lit) nav.lit.classList.remove('focus');
        nav.lit = el;
        if (el) el.classList.add('focus');
      }
      if (row) slide(row);
      rowsEl.style.transform = 'translateY(' + (row && nav.on ? -Math.max(0, row.el.offsetTop - top) : 0) + 'px)';
      for (var i = Math.max(0, nav.r - 1); i < Math.min(nav.rows.length, nav.r + 3); i++) {
        var near = nav.rows[i];
        if (near.pending) loadRow(near);
        if (!near.skip) wakeRow(near);
      }
      if (row && !row.skip) more(row);
      if (card && onFocus) onFocus(card);
    };
    return nav;
  }

  // ---------- grids (See all, genres, search results) ----------
  var GRID_STEP = 196 + 20, GRID_MAX = 300;
  function gridView(cols, onNeedMore, step) {
    var g = { cols: cols, cards: [], i: 0, lit: null, seen: {}, el: h('div', { class: 'grid', style: 'width:' + cols * (step || GRID_STEP) + 'px' }) };
    g.clear = function () { g.cards = []; g.seen = {}; g.i = 0; g.lit = null; g.el.innerHTML = ''; g.el.style.transform = ''; };
    g.add = function (cards) {
      cards.forEach(function (c) {
        if (c.key && g.seen[c.key]) return;
        if (c.key) g.seen[c.key] = true;
        g.cards.push(c); g.el.appendChild(c.el);
      });
    };
    g.current = function () { return g.cards[g.i] || null; };
    // false at an edge, so the screen can move focus elsewhere
    g.move = function (code) {
      var n = g.cards.length, i = g.i, col = i % cols;
      if (code === KEY.LEFT) { if (col === 0) return false; i--; }
      else if (code === KEY.RIGHT) { if (col === cols - 1 || i + 1 >= n) return false; i++; }
      else if (code === KEY.UP) { if (i < cols) return false; i -= cols; }
      else if (code === KEY.DOWN) { if (Math.floor(i / cols) >= Math.floor((n - 1) / cols)) return false; i = Math.min(n - 1, i + cols); }
      else return false;
      g.i = i;
      return true;
    };
    g.paint = function (on) {
      var c = on !== false ? g.cards[g.i] : null, el = c ? c.el : null;
      if (g.lit !== el) {
        if (g.lit) g.lit.classList.remove('focus');
        g.lit = el;
        if (el) el.classList.add('focus');
      }
      var row = Math.floor(g.i / cols), lastRow = Math.floor((g.cards.length - 1) / cols);
      var anchor = g.cards[Math.max(0, row - 1) * cols];
      var y = anchor && row > 0 ? anchor.el.offsetTop - g.cards[0].el.offsetTop : 0;
      g.el.style.transform = 'translateY(' + (-y) + 'px)';
      for (var k = Math.max(0, (row - 1) * cols); k < Math.min(g.cards.length, (row + 4) * cols); k++) if (g.cards[k].wake) g.cards[k].wake();
      if (onNeedMore && g.cards.length && row >= lastRow - 2) onNeedMore();
    };
    return g;
  }

  var SVT_STEP = 400 + 20;
  var TYPES = [['all', T('All')], ['movie', T('Films')], ['tv', T('Shows')]];
  var SORTS = [['popular', T('Popular')], ['rating', T('Top rated')], ['newest', T('Newest')]];
  // o: { title, fetch(page, type, sort) -> Promise<{ cards, last }>, type, types: bool, sorts: bool }
  function gridScreen(o) {
    var type = o.type || 'all', sort = 'popular', seq = 0, page = 0, last = false, busy = false;
    var chips = [];
    if (o.types) TYPES.forEach(function (t) { chips.push({ kind: 'type', value: t[0], el: h('button', { class: 'tab', text: t[1] }) }); });
    if (o.sorts) SORTS.forEach(function (s, i) { chips.push({ kind: 'sort', value: s[0], el: h('button', { class: 'tab' + (i === 0 && chips.length ? ' gap' : ''), text: s[1] }) }); });
    var note = h('div', { class: 'grid-note' });
    var grid = o.wide ? gridView(4, more, SVT_STEP) : gridView(8, more);
    var el = h('div', { class: 'screen grid-screen' },
      h('header', { class: 'grid-head' }, h('h1', { text: o.title }),
        chips.length ? h('div', { class: 'chips' }, chips.map(function (c) { return c.el; })) : null),
      h('div', { class: 'grid-viewport' + (chips.length ? '' : ' no-chips') }, note, grid.el));
    var atTop = false, ci = 0;
    function paint() {
      chips.forEach(function (c, i) {
        c.el.classList.toggle('active', c.kind === 'type' ? c.value === type : c.value === sort);
        c.el.classList.toggle('focus', atTop && i === ci);
      });
      grid.paint(!atTop);
    }
    function reload() { seq++; page = 0; last = false; busy = false; grid.clear(); note.textContent = T('Loading…'); more(); }
    function more() {
      if (busy || last) return;
      busy = true;
      var my = seq;
      o.fetch(page + 1, type, sort).then(function (res) {
        if (my !== seq) return;
        busy = false; page++;
        var before = grid.cards.length;
        grid.add(res.cards);
        if (res.last || grid.cards.length === before || grid.cards.length >= GRID_MAX) last = true;
        note.textContent = grid.cards.length ? '' : T('Nothing here yet.');
        if (!grid.cards.length && chips.length) atTop = true;
        paint();
      }).catch(function (err) { if (my !== seq) return; busy = false; last = true; note.textContent = err.message; });
    }
    show({ el: el, focus: paint, key: function (code) {
      if (atTop) {
        if (code === KEY.LEFT) { ci = Math.max(0, ci - 1); paint(); return true; }
        if (code === KEY.RIGHT) { ci = Math.min(chips.length - 1, ci + 1); paint(); return true; }
        if (code === KEY.DOWN) { if (grid.cards.length) atTop = false; paint(); return true; }
        if (code === KEY.ENTER) {
          var c = chips[ci];
          if (c.kind === 'type') type = c.value; else sort = c.value;
          reload(); paint();
          return true;
        }
        return code === KEY.UP;
      }
      if (code === KEY.ENTER) { var card = grid.current(); if (card) card.open(); return true; }
      if (code === KEY.UP || code === KEY.DOWN || code === KEY.LEFT || code === KEY.RIGHT) {
        if (!grid.move(code) && code === KEY.UP && chips.length) atTop = true;
        paint();
        return true;
      }
      return false;
    } }, true);
    reload();
  }
  function genreGrid(g, type) {
    var both = Boolean(g.movie && g.tv);
    gridScreen({ title: g.name, type: both ? type : g.movie ? 'movie' : 'tv', types: both, sorts: true,
      fetch: function (page, t, sort) { return api(genreUrl(g, t, sort, page)).then(function (d) { return pageOf(d, page); }); } });
  }
  function listFetch(key) {
    return function (page) {
      return api('/api/discover/list?key=' + encodeURIComponent(key) + '&page=' + page).then(function (d) { return pageOf(d, page); });
    };
  }

  // ---------- home: Continue watching, Shows, Films, then the library by genre ----------
  // A library the owner shares between people (Settings -> People) shows everyone's titles here.
  function sharedNote() {
    var mates = (state.me && state.me.sharedWith || []).map(function (m) { return m.name; });
    if (!mates.length) return null;
    var names = mates.length < 2 ? mates[0] : T('{0} and {1}', mates.slice(0, -1).join(', '), mates[mates.length - 1]);
    return h('span', { class: 'shared', text: T('Shared with {0}', names) });
  }

  function homeScreen() {
    var el = h('div', { class: 'screen home' });
    var rowsEl = h('div', { class: 'rows' });
    var tops = [h('button', { class: 'top-link', text: T('Search') }), h('button', { class: 'top-link', text: T('Discover') }),
      h('button', { class: 'top-link', text: T('Documentaries') }), h('button', { class: 'switch', text: T('Switch account') })];
    var top = h('header', { class: 'topbar' }, h('div', { class: 'brandline' },
        h('div', { class: 'wordmark', text: 'Marquee' })),
      h('div', { class: 'top-actions' }, tops[0], tops[1], tops[2],
        h('div', { class: 'who' }, h('span', { text: state.me && state.me.name || '' }), sharedNote(), tops[3])));
    el.appendChild(top);
    el.appendChild(rowsEl);
    var nav = rowsNav(rowsEl, 40);
    var atTop = false, ti = 1, empty = false, pendingRow = null, watchTimer = null, me = null, gone = false;

    // Keeps the row of what's on its way current while the library is on screen. Progress changes touch
    // only the cards in that row; a title arriving or finishing redraws the rows.
    function watchPending() {
      clearTimeout(watchTimer);
      if (gone) return;
      watchTimer = setTimeout(function () {
        if (screen !== me) return watchPending();
        var before = state.pending.map(function (p) { return p.key; }).join();
        loadPending().then(function () {
          if (screen !== me) return;
          if (state.pending.map(function (p) { return p.key; }).join() !== before) return me.refresh();
          if (pendingRow) state.pending.forEach(function (p, i) { if (pendingRow.items[i] && pendingRow.items[i].update) pendingRow.items[i].update(p); });
        }).then(watchPending, watchPending);
      }, state.pending.length ? 5000 : 30000);
    }

    function build() {
      // Coming back from the player rebuilds the rows: keep the row and the card you were on.
      var was = {}, wasRow = nav.rows[nav.r] && nav.rows[nav.r].title;
      nav.rows.forEach(function (row) { was[row.title] = row.index; });
      var data = L.homeRows(state.library, state.shows, state.progress);
      var rows = [];
      function add(title, kind, items) { var row = makeRow({ title: title, kind: kind, items: items }); row.title = title; rows.push(row); }
      if (data.cont.length) add(T('Continue watching'), 'wide', data.cont.map(continueCard));
      var onWay = T('On its way');
      if (state.pending.length) add(onWay, 'poster', state.pending.map(pendingCard));
      if (data.shows.length) add(T('Shows'), 'poster', data.shows.map(function (s) { return showCard(s); }));
      if (data.films.length) add(T('Films'), 'poster', data.films.map(function (f) { return filmCard(f); }));
      L.genreRows(state.library, state.shows, state.genres).forEach(function (g) {
        add(g.name, 'poster', g.titles.map(function (x) { return x.show ? showCard(x.show) : filmCard(x.film); }));
      });
      nav.set(rows);
      rows.forEach(function (row, i) {
        if (was[row.title] != null) row.index = Math.min(was[row.title], row.items.length - 1);
        if (row.title === wasRow) nav.r = i;
      });
      if (state.focusPending) {
        state.focusPending = false;
        rows.forEach(function (row, i) { if (row.title === onWay) { nav.r = i; row.index = 0; atTop = false; } });
      }
      pendingRow = rows.filter(function (row) { return row.title === onWay; })[0] || null;
      empty = !rows.length;
      if (empty) {
        rowsEl.appendChild(h('div', { class: 'empty' }, h('h2', { text: T('Your library is empty') }),
          h('p', { text: T('Open Discover or Search above to find something to download.') })));
        atTop = true;
      }
    }
    function paint() {
      tops.forEach(function (b, i) { b.classList.toggle('focus', atTop && i === ti); });
      nav.paint(!atTop);
    }
    build();
    me = { el: el,
      focus: paint,
      leave: function () { gone = true; clearTimeout(watchTimer); },
      refresh: function () {
        return Promise.all([loadLibrary(), state.genres.length ? null : loadGenres()]).then(function () { build(); paint(); }).catch(function () {});
      },
      key: function (code) {
        if (atTop) {
          if (code === KEY.LEFT) { ti = Math.max(0, ti - 1); paint(); return true; }
          if (code === KEY.RIGHT) { ti = Math.min(tops.length - 1, ti + 1); paint(); return true; }
          if (code === KEY.DOWN) { if (!empty) atTop = false; paint(); return true; }
          if (code === KEY.ENTER) {
            if (ti === 0) searchScreen();
            else if (ti === 1) discoverScreen();
            else if (ti === 2) docsScreen();
            else { localStorage.removeItem(TOKEN_KEY); history = []; screen = null; pairScreen(true); }
            return true;
          }
          return code === KEY.UP;
        }
        if (code === KEY.UP) { if (!nav.move(-1)) { atTop = true; paint(); } return true; }
        if (code === KEY.DOWN) { nav.move(1); return true; }
        if (code === KEY.LEFT || code === KEY.RIGHT) { nav.side(code === KEY.LEFT ? -1 : 1); return true; }
        if (code === KEY.ENTER) { var c = nav.current(); if (c) c.open(); return true; }
        return false;
      } };
    show(me);
    watchPending();
  }

  // ---------- Discover ----------
  // Curated rows that keep loading as you move along them, a row of genres, then one row per genre
  // (each loads when it comes near the screen). TMDB, torrent search, release choice and qBittorrent all
  // stay on the server; the 2020 TV only draws cards near the screen.
  // What this person owns, by TMDB ID (rebuilt when the library reloads): badges, Play/Open, search.
  var ownedCache = null, ownedFor = null;
  function owned() {
    if (ownedCache && ownedFor === state.library) return ownedCache;
    var films = {}, shows = {}, showIds = {};
    state.library.forEach(function (f) {
      if (f.season == null) { if (f.tmdbId && !films[f.tmdbId]) films[f.tmdbId] = f; }
      else if (f.show) showIds[f.show] = true;
    });
    state.shows.forEach(function (s) {
      if (!showIds[s.id]) return;
      if (s.tmdbId) shows[s.tmdbId] = s;
      var m = /^tv-(\d+)$/.exec(String(s.id));
      if (m) shows[m[1]] = s;
    });
    ownedFor = state.library;
    ownedCache = { films: films, shows: shows, showIds: showIds };
    return ownedCache;
  }
  function libraryEntry(t) {
    var o = owned();
    if (t.type === 'movie') return o.films[t.id] ? { film: o.films[t.id] } : null;
    return o.shows[t.id] ? { show: o.shows[t.id] } : null;
  }

  function discoverScreen() {
    var type = 'all', seq = 0, atTop = false, ti = 1;
    var heroArt = h('img', { alt: '', decoding: 'async', class: 'is-empty' });
    heroArt.onerror = function () { heroArt.removeAttribute('src'); heroArt.className = 'is-empty'; };
    var heroTitle = h('h1'), heroMeta = h('div', { class: 'hero-meta' }), heroText = h('p', { class: 'hero-overview' });
    var tabs = [h('button', { class: 'top-link search-tab', text: T('Search') })]
      .concat(TYPES.map(function (t) { return h('button', { class: 'tab', text: t[1] }); }))
      .concat([h('button', { class: 'tab', text: T('Documentaries') })]);
    var rowsEl = h('div', { class: 'rows' });
    var el = h('div', { class: 'screen discover-screen' },
      h('div', { class: 'hero' }, h('div', { class: 'hero-art' }, heroArt), h('div', { class: 'hero-copy' }, heroTitle, heroMeta, heroText)),
      h('header', { class: 'topbar' },
        h('div', { class: 'brandline' }, h('div', { class: 'wordmark', text: T('Discover') })),
        h('div', { class: 'top-actions tabs' }, tabs)),
      h('div', { class: 'rows-viewport' }, rowsEl));
    // The big picture and text follow the focused card, a moment after it settles (images are slow here).
    var heroTimer = null, heroKey = null;
    function setHero(t, key) {
      heroKey = key;
      heroTitle.textContent = t.title;
      heroMeta.textContent = [t.year, t.type === 'tv' ? T('Series') : T('Film'), t.rating ? '★ ' + t.rating : null]
        .concat(genreNames(t.type, t.genres).slice(0, 3)).filter(Boolean).join('  ·  ');
      heroText.textContent = t.overview || '';
      if (t.backdrop) { heroArt.className = ''; if (heroArt.getAttribute('src') !== t.backdrop) heroArt.src = t.backdrop; }
      else { heroArt.removeAttribute('src'); heroArt.className = 'is-empty'; }
    }
    var nav = rowsNav(rowsEl, 0, function (card) {
      if (!card.t || card.key === heroKey) return;
      clearTimeout(heroTimer);
      heroTimer = setTimeout(function () { setHero(card.t, card.key); }, 220);
    });

    function genreCard(g, i) {
      return { key: 'genre:' + g.name, el: h('div', { class: 'card genre g' + (i % 6) }, h('div', { class: 'art' }, h('span', { text: g.name }))),
        open: function () { genreGrid(g, type); } };
    }
    function load() {
      var my = ++seq;
      nav.set([]);
      rowsEl.appendChild(h('div', { class: 'empty discover-loading' }, h('h2', { text: T('Loading Discover…') })));
      Promise.all([
        api('/api/discover/home?type=' + type).catch(function (err) { return { rows: [], error: err }; }),
        state.genres.length ? null : loadGenres(),
      ]).then(function (r) {
        if (my !== seq) return;
        var data = r[0];
        var rows = (data.rows || []).map(function (row) {
          return makeRow({ title: row.title, kind: 'tile', items: (row.items || []).map(titleCard), fetch: listFetch(row.key),
            seeAll: function () { gridScreen({ title: row.title, fetch: listFetch(row.key) }); } });
        });
        var gs = state.genres.filter(function (g) { return type === 'all' || (type === 'movie' ? g.movie : g.tv); });
        if (gs.length) {
          rows.push(makeRow({ title: T('Browse by genre'), kind: 'genre', items: gs.map(genreCard) }));
          gs.forEach(function (g) {
            rows.push(makeRow({ title: g.name, kind: 'tile', lazy: true,
              fetch: function (page) { return api(genreUrl(g, type, 'popular', page)).then(function (d) { return pageOf(d, page); }); },
              seeAll: function () { genreGrid(g, type); } }));
          });
        }
        if (!data.rows || !data.rows.length) {
          rowsEl.innerHTML = '';
          rowsEl.appendChild(h('div', { class: 'empty' }, h('h2', { text: data.error ? T('Discover is unavailable') : T('Nothing to discover right now') }),
            h('p', { text: data.error ? data.error.message : T('Check that TMDB is configured on the Marquee server.') })));
          atTop = true; paint();
          return;
        }
        nav.set(rows);
        var first = rows[0].items[0];
        if (first && first.t) setHero(first.t, first.key);
        paint();
      });
    }
    function paint() {
      tabs.forEach(function (b, i) {
        b.classList.toggle('focus', atTop && i === ti);
        if (i > 0 && i <= TYPES.length) b.classList.toggle('active', TYPES[i - 1][0] === type);
      });
      nav.paint(!atTop);
    }
    show({ el: el, focus: paint, refresh: paint,
      leave: function () { clearTimeout(heroTimer); seq++; },
      key: function (code) {
        if (atTop) {
          if (code === KEY.LEFT) { ti = Math.max(0, ti - 1); paint(); return true; }
          if (code === KEY.RIGHT) { ti = Math.min(tabs.length - 1, ti + 1); paint(); return true; }
          if (code === KEY.DOWN) { if (nav.current()) atTop = false; paint(); return true; }
          if (code === KEY.ENTER) {
            if (ti === 0) { searchScreen(); return true; }
            if (ti > TYPES.length) { docsScreen(); return true; }
            if (TYPES[ti - 1][0] !== type) { type = TYPES[ti - 1][0]; load(); }
            return true;
          }
          return code === KEY.UP;
        }
        if (code === KEY.UP) { if (!nav.move(-1)) { atTop = true; ti = 1 + TYPES.map(function (t) { return t[0]; }).indexOf(type); paint(); } return true; }
        if (code === KEY.DOWN) { nav.move(1); return true; }
        if (code === KEY.LEFT || code === KEY.RIGHT) { nav.side(code === KEY.LEFT ? -1 : 1); return true; }
        if (code === KEY.ENTER) { var c = nav.current(); if (c) c.open(); return true; }
        return false;
      } }, true);
    load();
  }

  // ---------- Documentaries ----------
  // The first row, every category as a tile, then one row per category, each loading as it comes near.
  // SVT Play's titles have wide art and open svtScreen; the others are ordinary Discover titles.
  function svtCard(t, cls) {
    var pic = lazy(cls === 'tile' ? t.poster || t.wide : t.wide || t.poster);
    return { key: 'svt:' + t.path, t: t, wake: pic.wake,
      el: h('div', { class: 'card ' + (cls || 'svt') }, h('div', { class: 'art' }, pic.el, h('span', { class: 'svt-mark', text: 'SVT Play' }), svtOwned(t) ? badge() : null, onWayBar(pendingForPath(t.path) || pendingNamed(t.title))),
        h('div', { class: 'name', text: t.title }), h('div', { class: 'sub', text: titleSub({ year: t.year, type: t.kind === 'series' ? 'tv' : 'movie' }) })),
      open: function () { svtScreen(t); } };
  }
  function svtOwned(t) {
    var key = L.searchKey(t.title);
    return state.shows.some(function (s) { return owned().showIds[s.id] && L.searchKey(s.title) === key; })
      || state.library.some(function (f) { return f.season == null && L.searchKey(f.filmTitle || f.title) === key; });
  }
  function docsPage(d, page, wide) {
    return { cards: (d.results || []).map(function (t) { return t.type === 'svt' ? svtCard(t, wide ? null : 'tile') : titleCard(t); }),
      last: (d.page || page) >= (d.totalPages || 1) };
  }
  function docsUrl(id, type, sort, page) {
    return '/api/docs/category?id=' + encodeURIComponent(id) + '&type=' + type + '&sort=' + sort + '&page=' + page;
  }
  function docsGrid(c, title) {
    var svt = c.source === 'svt';
    gridScreen({ title: title || c.name || c.title, types: true, sorts: !svt, wide: svt,
      fetch: function (page, type, sort) { return api(docsUrl(c.id, type, sort, page)).then(function (d) { return docsPage(d, page, svt); }); } });
  }
  function docsScreen() {
    var seq = 0, atTop = false;
    var heroArt = h('img', { alt: '', decoding: 'async', class: 'is-empty' });
    heroArt.onerror = function () { heroArt.removeAttribute('src'); heroArt.className = 'is-empty'; };
    var heroTitle = h('h1'), heroMeta = h('div', { class: 'hero-meta' }), heroText = h('p', { class: 'hero-overview' });
    var searchTab = h('button', { class: 'top-link', text: T('Search') });
    var rowsEl = h('div', { class: 'rows' });
    var el = h('div', { class: 'screen discover-screen docs-screen' },
      h('div', { class: 'hero' }, h('div', { class: 'hero-art' }, heroArt), h('div', { class: 'hero-copy' }, heroTitle, heroMeta, heroText)),
      h('header', { class: 'topbar' },
        h('div', { class: 'brandline' }, h('div', { class: 'wordmark', text: T('Documentaries') })),
        h('div', { class: 'top-actions tabs' }, searchTab)),
      h('div', { class: 'rows-viewport' }, rowsEl));
    var heroTimer = null, heroKey = null;
    function setHero(t, key) {
      heroKey = key;
      heroTitle.textContent = t.title;
      var series = t.type === 'tv' || t.kind === 'series';
      heroMeta.textContent = [t.year, series ? T('Series') : T('Film'), t.type === 'svt' ? T('Free on SVT Play') : null, t.rating ? '★ ' + t.rating : null]
        .filter(Boolean).join('  ·  ');
      heroText.textContent = t.overview || '';
      if (t.backdrop) { heroArt.className = ''; if (heroArt.getAttribute('src') !== t.backdrop) heroArt.src = t.backdrop; }
      else { heroArt.removeAttribute('src'); heroArt.className = 'is-empty'; }
    }
    var nav = rowsNav(rowsEl, 0, function (card) {
      if (!card.t || card.key === heroKey) return;
      clearTimeout(heroTimer);
      heroTimer = setTimeout(function () { setHero(card.t, card.key); }, 220);
    });
    function paint() {
      searchTab.classList.toggle('focus', atTop);
      nav.paint(!atTop);
    }
    function categoryCard(c, i) {
      return { key: 'doc:' + c.id, el: h('div', { class: 'card genre g' + (i % 6) }, h('div', { class: 'art' }, h('span', { text: c.name }))),
        open: function () { docsGrid(c); } };
    }
    function rowFor(c, title, items) {
      var svt = c.source === 'svt';
      return makeRow({ title: title, kind: svt ? 'svt' : 'tile', lazy: !items, items: items && docsPage({ results: items, page: 1, totalPages: 1 }, 1, true).cards,
        fetch: function (page) { return api(docsUrl(c.id, 'all', 'popular', page)).then(function (d) { return docsPage(d, page, true); }); },
        seeAll: function () { docsGrid(c, title); } });
    }
    function load() {
      var my = ++seq;
      nav.set([]);
      rowsEl.appendChild(h('div', { class: 'empty discover-loading' }, h('h2', { text: T('Loading documentaries…') })));
      api('/api/docs/home').then(function (data) {
        if (my !== seq) return;
        var rows = (data.rows || []).map(function (r) { return rowFor(r, r.title, r.items || []); });
        var tiles = (data.categories || []).map(categoryCard);
        if (tiles.length) rows.splice(Math.min(1, rows.length), 0, makeRow({ title: T('Browse documentaries'), kind: 'genre', items: tiles }));
        (data.more || []).forEach(function (c) { rows.push(rowFor(c, c.title, null)); });
        if (!rows.length) {
          rowsEl.innerHTML = '';
          rowsEl.appendChild(h('div', { class: 'empty' }, h('h2', { text: T('Nothing here yet.') })));
          atTop = true; paint();
          return;
        }
        nav.set(rows);
        var first = rows[0].items[0];
        if (first && first.t) setHero(first.t, first.key);
        paint();
      }).catch(function (err) {
        if (my !== seq) return;
        rowsEl.innerHTML = '';
        rowsEl.appendChild(h('div', { class: 'empty' }, h('h2', { text: T('Couldn’t load documentaries') }), h('p', { text: err.message })));
        atTop = true; paint();
      });
    }
    show({ el: el, focus: paint, refresh: paint,
      leave: function () { clearTimeout(heroTimer); seq++; },
      key: function (code) {
        if (atTop) {
          if (code === KEY.DOWN) { if (nav.current()) atTop = false; paint(); return true; }
          if (code === KEY.ENTER) { searchScreen(); return true; }
          return code === KEY.UP || code === KEY.LEFT || code === KEY.RIGHT;
        }
        if (code === KEY.UP) { if (!nav.move(-1)) { atTop = true; paint(); } return true; }
        if (code === KEY.DOWN) { nav.move(1); return true; }
        if (code === KEY.LEFT || code === KEY.RIGHT) { nav.side(code === KEY.LEFT ? -1 : 1); return true; }
        if (code === KEY.ENTER) { var c = nav.current(); if (c) c.open(); return true; }
        return false;
      } }, true);
    load();
  }

  // An SVT Play title: Add the film or a whole season, or pick one episode from the list. OK on an episode
  // plays it when it's here and adds it when it isn't. Saved copies join the library like any download.
  function svtScreen(t) {
    var alive = true, data = null, si = 0, ei = 0, zone = 'actions', timer = null, busy = false;
    var backdrop = h('div', { class: 'discover-backdrop' }, img(t.backdrop));
    var titleEl = h('h1', { text: t.title });
    var meta = h('div', { class: 'discover-meta', text: T('Free on SVT Play') });
    var overview = h('p', { class: 'discover-overview', text: t.overview || '' });
    var chips = h('div', { class: 'svt-seasons' });
    var action = h('button', { class: 'title-action primary', text: T('Loading…') });
    var status = h('div', { class: 'download-status' });
    var strip = progressStrip();
    var list = h('div', { class: 'episodes' });
    var rows = []; // per episode on screen: { label, bar, pct }
    var listBox = h('div', { class: 'svt-list' }, list);
    var el = h('div', { class: 'screen discover-title svt-title' }, backdrop,
      h('div', { class: 'discover-panel' }, h('div', { class: 'discover-copy' }, titleEl, meta, overview, chips,
        h('div', { class: 'title-actions' }, action), strip.el, status), listBox));

    function season() { return data && data.seasons && data.seasons[si] || null; }
    function episodes() { var s = season(); return s ? s.episodes : []; }
    function open(items) { return items.filter(function (e) { return e.status !== 'library' && e.status !== 'queued'; }); }
    function statusWord(s) {
      return s === 'library' ? T('In your library') : s === 'server' ? T('On server') : s === 'queued' ? T('On its way') : s === 'failed' ? T('Couldn’t save this') : '';
    }
    function actionText() {
      if (!data) return T('Loading…');
      if (data.kind === 'film') {
        if (data.status === 'library') return T('Play');
        if (data.status === 'queued') return T('Go to library');
        return T('Add to library');
      }
      var rest = open(episodes()).length;
      if (!rest) return episodes().some(function (e) { return e.status === 'queued'; }) ? T('Go to library') : T('Open');
      return rest === 1 ? T('Add 1 episode') : T('Add {0} episodes', rest);
    }
    function buildChips() {
      chips.innerHTML = '';
      if (!data || !data.seasons || data.seasons.length < 2) return;
      chips.appendChild(h('div', { class: 'season-label', text: T('Season') }));
      var track = h('div', { class: 'svt-season-track' });
      data.seasons.forEach(function (s) { track.appendChild(h('div', { class: 'svt-chip', text: s.dated && s.name ? s.name : String(s.number) })); });
      chips.appendChild(track);
    }
    function labelFor(e) {
      var word = e.status === 'queued' ? L.transferWord({ state: e.state, progress: e.progress }) : statusWord(e.status);
      var pct = e.status === 'queued' && e.state === 'downloading' ? Math.floor((e.progress || 0) * 100) + ' %' : null;
      return [T('Episode {0}', e.number), e.minutes ? T('{0} min', e.minutes) : null, word, pct].filter(Boolean).join(' · ');
    }
    function buildList() {
      list.innerHTML = '';
      rows = episodes().map(function (e) {
        var label = h('div', { class: 'label', text: labelFor(e) }), bar = barFor(e.progress || 0);
        bar.el.style.display = e.status === 'queued' ? '' : 'none';
        list.appendChild(h('div', { class: 'episode' },
          h('div', { class: 'art' }, img(e.still), bar.el),
          h('div', { class: 'text' }, label, h('div', { class: 'name', text: e.name }))));
        return { label: label, bar: bar };
      });
    }
    // The rows stay and only their words and bars change, so the list doesn't flicker and images don't reload.
    function updateRows() {
      episodes().forEach(function (e, i) {
        var row = rows[i];
        if (!row) return;
        row.label.textContent = labelFor(e);
        row.bar.el.style.display = e.status === 'queued' ? '' : 'none';
        row.bar.set(e.progress || 0);
      });
    }
    function overall() {
      var p = pendingForPath(t.path);
      strip.set(p);
      var failed = data && (data.status === 'failed' ? data : (data.seasons || []).reduce(function (found, s) {
        return found || s.episodes.filter(function (e) { return e.status === 'failed'; })[0]; }, null));
      if (failed && failed.error) { status.textContent = failed.error; status.classList.add('error'); }
    }
    function paint() {
      action.textContent = actionText();
      action.classList.toggle('focus', zone === 'actions');
      [].forEach.call(chips.querySelectorAll('.svt-chip'), function (c, i) {
        c.classList.toggle('active', i === si); c.classList.toggle('focus', zone === 'seasons' && i === si);
      });
      var track = chips.querySelector('.svt-season-track');
      if (track && track.children[si]) track.style.transform = 'translateX(' + (-Math.max(0, track.children[si].offsetLeft - 480)) + 'px)';
      var items = list.children;
      [].forEach.call(items, function (it, i) { it.classList.toggle('focus', zone === 'episodes' && i === ei); });
      var item = items[ei];
      list.style.transform = 'translateY(' + (zone === 'episodes' && item ? -Math.max(0, item.offsetTop - 10) : 0) + 'px)';
    }
    function waitingOn(d) {
      return d && (d.status === 'queued' || (d.seasons || []).some(function (s) { return s.episodes.some(function (e) { return e.status === 'queued'; }); }));
    }
    function hereCount(d) {
      return d.status === 'library' ? 1 : (d.seasons || []).reduce(function (n, s) { return n + s.episodes.filter(function (e) { return e.status === 'library'; }).length; }, 0);
    }
    function schedule() {
      clearTimeout(timer);
      if (waitingOn(data)) timer = setTimeout(tick, 4000);
    }
    // While something's on its way: fresh numbers, in place. An episode that just finished can be played.
    function tick() {
      Promise.all([api('/api/svt/title?path=' + encodeURIComponent(t.path)), loadPending()]).then(function (r) {
        if (!alive) return;
        var arrived = hereCount(r[0]) !== hereCount(data);
        data = r[0];
        updateRows(); overall(); paint();
        schedule();
        if (arrived) loadLibrary().catch(function () {});
      }).catch(function () { if (alive) schedule(); });
    }
    function load() {
      Promise.all([api('/api/svt/title?path=' + encodeURIComponent(t.path)), loadPending()]).then(function (r) {
        var d = r[0];
        if (!alive) return;
        var first = !data;
        data = d;
        titleEl.textContent = d.title;
        var series = d.kind === 'series';
        meta.textContent = [d.year, series ? T('Series') : T('Film'), d.minutes ? T('{0} min', d.minutes) : null, T('Free on SVT Play')].filter(Boolean).join(' · ');
        overview.textContent = d.overview || t.overview || T('No description available.');
        si = Math.min(si, Math.max(0, (d.seasons || []).length - 1));
        buildChips(); buildList();
        schedule();
        overall();
        return loadLibrary().catch(function () {}).then(function () {
          if (!alive) return;
          paint();
          if (first && !status.classList.contains('error')) status.textContent = T('Saved to your library in full quality, with Swedish subtitles.');
        });
      }).catch(function (err) {
        if (!alive) return;
        action.textContent = T('Back'); status.textContent = err.message; status.classList.add('error');
      });
    }
    function add(payload) {
      if (busy) return;
      if (state.me && state.me.canDownload === false) { toast(T('Downloads disabled')); return; }
      busy = true; status.classList.remove('error'); status.textContent = T('Starting…');
      payload.path = t.path;
      api('/api/svt/add', payload).then(function (r) {
        busy = false;
        if (!alive) return;
        status.textContent = r.message || T('On its way from SVT Play.');
        load();
      }).catch(function (err) {
        busy = false;
        if (!alive) return;
        status.textContent = err.message; status.classList.add('error');
      });
    }
    function fileFor(id) {
      var found = null;
      state.library.forEach(function (f) { if (f.id === id) found = f; });
      return found;
    }
    function playId(id) {
      var f = fileFor(id);
      if (f) playAsked(f); else toast(T('This one is still being prepared. Try again in a little while.'));
    }
    function pressAction() {
      if (!data) return;
      if (data.kind === 'film') {
        if (data.status === 'library') playId(data.libraryId);
        else if (data.status === 'queued') goToLibrary();
        else add({});
        return;
      }
      if (open(episodes()).length) { add({ seasons: [season().number] }); return; }
      if (episodes().some(function (e) { return e.status === 'queued'; })) { goToLibrary(); return; }
      var here = episodes().filter(function (e) { return e.status === 'library'; })[0];
      if (here) { zone = 'episodes'; ei = episodes().indexOf(here); paint(); }
    }
    function pressEpisode() {
      var e = episodes()[ei];
      if (!e) return;
      if (e.status === 'library') playId(e.libraryId);
      else if (e.status !== 'queued') add({ seasons: [season().number], episodes: [e.number] });
    }
    show({ el: el, focus: paint, refresh: function () { if (data) load(); },
      leave: function () { alive = false; clearTimeout(timer); },
      key: function (code) {
        var many = data && data.seasons && data.seasons.length > 1;
        if (zone === 'seasons') {
          if (code === KEY.LEFT && si > 0) { si--; ei = 0; buildList(); paint(); return true; }
          if (code === KEY.RIGHT && si < data.seasons.length - 1) { si++; ei = 0; buildList(); paint(); return true; }
          if (code === KEY.DOWN || code === KEY.ENTER) { zone = 'actions'; paint(); return true; }
          return code === KEY.UP || code === KEY.LEFT || code === KEY.RIGHT;
        }
        if (zone === 'actions') {
          if (code === KEY.UP) { if (many) { zone = 'seasons'; paint(); } return true; }
          if (code === KEY.DOWN) { if (episodes().length) { zone = 'episodes'; paint(); } return true; }
          if (code === KEY.ENTER) { pressAction(); return true; }
          return code === KEY.LEFT || code === KEY.RIGHT;
        }
        if (code === KEY.UP) { if (ei > 0) ei--; else zone = 'actions'; paint(); return true; }
        if (code === KEY.DOWN) { ei = Math.min(episodes().length - 1, ei + 1); paint(); return true; }
        if (code === KEY.ENTER) { pressEpisode(); return true; }
        return code === KEY.LEFT || code === KEY.RIGHT;
      } }, true);
    paint();
    load();
  }

  // ---------- Search ----------
  // An on-screen keyboard for the remote (a USB/Bluetooth keyboard and the remote's number keys type too).
  // Your library answers at once; TMDB (via the server) once you stop typing.
  var KEY_ROWS = 7;
  // A Swedish TV (sv.js loaded) gets å ä ö; every other TV a plain English keyboard. Both are 7 rows of 6.
  var KEYBOARD = (window.MarqueeTvStrings ? 'abcdefghijklmnopqrstuvwxyzåäö1234567890-:.'
    : 'abcdefghijklmnopqrstuvwxyz1234567890\'&-:.!').split('');
  function libraryMatches(query) {
    var q = L.searchKey(query);
    if (!q) return [];
    var out = [], seen = {};
    state.shows.forEach(function (s) {
      if (owned().showIds[s.id] && L.searchKey(s.title).indexOf(q) >= 0) out.push(showCard(s, 'tile'));
    });
    state.library.forEach(function (f) {
      if (f.season != null) return;
      var k = f.tmdbId || f.id;
      if (seen[k] || L.searchKey(f.filmTitle || f.title).indexOf(q) < 0) return;
      seen[k] = true;
      out.push(filmCard(f, 'tile'));
    });
    return out.slice(0, 20);
  }

  function searchScreen() {
    var q = '', zone = 'keys', kx = 0, ky = 0, seq = 0, timer = null, lit = null;
    var keyEls = KEYBOARD.map(function (c) { return h('div', { class: 'key', text: c }); });
    var bottom = [h('div', { class: 'key wide', text: T('Space') }), h('div', { class: 'key wide', text: '⌫' }), h('div', { class: 'key wide', text: T('Clear') })];
    var field = h('div', { class: 'search-field is-empty' });
    var label = h('div', { class: 'search-label' });
    var note = h('div', { class: 'grid-note' });
    var grid = gridView(5, null);
    var el = h('div', { class: 'screen search' },
      h('header', { class: 'topbar' },
        h('div', { class: 'brandline' }, h('div', { class: 'wordmark', text: T('Search') })),
        h('div', { class: 'discover-hint', text: T('OK: type · Right: results · Back: close') })),
      h('div', { class: 'search-left' }, field, h('div', { class: 'keys' }, keyEls, bottom)),
      h('div', { class: 'search-right' }, label, h('div', { class: 'grid-viewport' }, note, grid.el)));

    function keyAt() { return ky < KEY_ROWS ? keyEls[ky * 6 + kx] : bottom[Math.floor(kx / 2)]; }
    function paint() {
      var want = zone === 'keys' ? keyAt() : null;
      if (lit !== want) { if (lit) lit.classList.remove('focus'); lit = want; if (want) want.classList.add('focus'); }
      grid.paint(zone === 'results');
    }
    function setQuery(v) {
      q = v;
      field.textContent = q;
      field.classList.toggle('is-empty', !q);
      clearTimeout(timer);
      timer = setTimeout(run, 450);
    }
    function type(c) { if (q.length < 60 && !(c === ' ' && (!q || q.charAt(q.length - 1) === ' '))) setQuery(q + c); }
    function press() {
      if (ky < KEY_ROWS) type(KEYBOARD[ky * 6 + kx]);
      else if (kx < 2) type(' ');
      else if (kx < 4) setQuery(q.slice(0, -1));
      else setQuery('');
    }
    function results(cards, text) {
      grid.clear(); grid.add(cards);
      label.textContent = text;
      note.textContent = '';
      if (zone === 'results' && !grid.cards.length) zone = 'keys';
      paint();
    }
    function run() {
      var my = ++seq, query = q.replace(/^\s+|\s+$/g, '');
      if (!query) {
        label.textContent = T('Trending this week');
        api('/api/discover/list?key=trending-all&page=1')
          .then(function (d) { if (my === seq) results((d.results || []).map(titleCard), T('Trending this week')); })
          .catch(function () { if (my === seq) results([], T('Type to search films and shows')); });
        return;
      }
      var local = libraryMatches(query);
      if (query.length < 2) { results(local, local.length ? T('In your library') : T('Keep typing…')); return; }
      results(local, T('Searching for “{0}”…', query));
      api('/api/search?q=' + encodeURIComponent(query)).then(function (d) {
        if (my !== seq) return;
        var all = local.concat((d.svt || []).map(function (t) { return svtCard(t, 'tile'); }), (d.results || []).map(titleCard));
        results(all, all.length ? T('Results for “{0}”', query) : T('Nothing found for “{0}”', query));
      }).catch(function (err) {
        if (my !== seq) return;
        results(local, err.message);
      });
    }
    show({ el: el, focus: paint, refresh: paint,
      leave: function () { clearTimeout(timer); seq++; },
      key: function (code, e) {
        // A real keyboard: letters and digits type, Backspace erases (Back still closes when there's nothing to erase).
        if (e && e.keyCode === 8 && q) { setQuery(q.slice(0, -1)); return true; }
        if (e && e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { type(e.key.toLowerCase()); return true; }
        if (zone === 'keys') {
          if (code === KEY.LEFT) kx = ky === KEY_ROWS ? Math.max(0, (Math.floor(kx / 2) - 1) * 2) : Math.max(0, kx - 1);
          else if (code === KEY.RIGHT) {
            if (ky === KEY_ROWS ? kx >= 4 : kx === 5) { if (grid.cards.length) { zone = 'results'; grid.i = Math.min(grid.i, grid.cards.length - 1); } }
            else kx = ky === KEY_ROWS ? (Math.floor(kx / 2) + 1) * 2 : kx + 1;
          }
          else if (code === KEY.UP) { if (ky > 0) ky--; }
          else if (code === KEY.DOWN) { if (ky < KEY_ROWS) ky++; }
          else if (code === KEY.ENTER) press();
          else return false;
          paint();
          return true;
        }
        if (code === KEY.ENTER) { var c = grid.current(); if (c) c.open(); return true; }
        if (code === KEY.LEFT && grid.i % grid.cols === 0) { zone = 'keys'; paint(); return true; }
        if (code === KEY.UP || code === KEY.DOWN || code === KEY.LEFT || code === KEY.RIGHT) { grid.move(code); paint(); return true; }
        return false;
      } }, true);
    run();
  }

  // ---------- a title's page: play it if it's yours, or download it ----------
  function discoverTitle(t) {
    var quality = null, qualities = [null, '2160p', '1440p', '1080p', '720p'];
    var seasons = [], si = 0, zone = t.type === 'tv' ? 'seasons' : 'actions', ai = 0;
    var alive = true, busy = false, pollTimer = null;
    var lib = libraryEntry(t);
    var backdrop = h('div', { class: 'discover-backdrop' }, img(t.backdrop || t.poster));
    var title = titleLogo(h('h1', { text: t.title }), t.type, t.id, t.title);
    var meta = h('div', { class: 'discover-meta', text: [t.year, t.type === 'tv' ? T('Series') : T('Film'), t.rating ? '★ ' + t.rating : null]
      .concat(genreNames(t.type, t.genres)).filter(Boolean).join(' · ') });
    var overview = h('p', { class: 'discover-overview', text: t.overview || T('No description available.') });
    var cast = castLine(t.type, t.id, 'discover-cast');
    var seasonBox = h('div', { class: 'discover-seasons' });
    var onWay = pendingFor(t);
    var status = h('div', { class: 'download-status', text: onWay ? '' : lib ? T('Already in your library. Smart Download will avoid duplicates.') : '' });
    var strip = progressStrip();
    strip.set(onWay);
    var downloadBtn = h('button', { class: 'title-action' + (lib ? '' : ' primary'), text: state.me && state.me.canDownload === false ? T('Downloads disabled') : T('Download') });
    var qualityBtn = h('button', { class: 'title-action', text: '' });
    var actions = [];
    if (lib) actions.push({ el: h('button', { class: 'title-action primary', text: lib.film ? T('Play') : T('Open') }),
      act: function () { if (lib.film) playAsked(lib.film); else showPage(lib.show); } });
    actions.push({ el: downloadBtn, act: download });
    actions.push({ el: qualityBtn, act: function () { cycleQuality(1); }, quality: true });
    // Once it's on its way, the next thing to do is go and see it in the library.
    function offerLibrary() {
      if (actions.some(function (a) { return a.library; })) return;
      var a = { el: h('button', { class: 'title-action primary', text: T('Go to library') }), act: goToLibrary, library: true };
      downloadBtn.classList.remove('primary');
      actions.unshift(a);
      actionsEl.insertBefore(a.el, actionsEl.firstChild);
      zone = 'actions';
      ai = 0;
    }
    // Seasons pick what Download gets; for a show you already have, Open comes first.
    if (lib) zone = 'actions';
    var actionsEl = h('div', { class: 'title-actions' }, actions.map(function (a) { return a.el; }));
    var panel = h('div', { class: 'discover-panel' }, h('div', { class: 'discover-copy' }, title, meta, overview, cast, seasonBox,
      actionsEl, strip.el, status));
    var el = h('div', { class: 'screen discover-title' }, backdrop, panel);
    followPending(function () { return alive; }, function () {
      var was = onWay;
      onWay = pendingFor(t);
      strip.set(onWay);
      if (onWay && !was && !busy) status.textContent = '';
    });

    function savedQuality() {
      var s = state.me && state.me.settings || {};
      if (s.quality && s.quality !== 'all') return s.quality; // 'all' = no fixed resolution: the profile decides
      var profile = { save: T('Save Space'), balanced: T('Balanced · 1080p'), best: T('Best Quality') }[s.downloadProfile];
      if (profile) return profile;
      return T('your saved settings');
    }
    function qualityText() { return T('Quality: {0}', quality || savedQuality()); }
    function buildSeasons() {
      seasonBox.innerHTML = '';
      if (t.type !== 'tv') { seasonBox.style.display = 'none'; return; }
      if (!seasons.length) {
        seasonBox.appendChild(h('div', { class: 'season-note', text: T('Loading seasons…') })); return;
      }
      seasonBox.appendChild(h('div', { class: 'season-label', text: T('Season') }));
      var track = h('div', { class: 'season-track' });
      seasons.forEach(function (s) {
        track.appendChild(h('div', { class: 'season-chip' + (s.upcoming ? ' upcoming' : ''), text: String(s.number) }));
      });
      seasonBox.appendChild(h('div', { class: 'season-viewport' }, track));
    }
    function paint() {
      qualityBtn.textContent = qualityText();
      actions.forEach(function (a, i) { a.el.classList.toggle('focus', zone === 'actions' && ai === i); });
      if (t.type === 'tv' && seasons.length) {
        var chips = seasonBox.querySelectorAll('.season-chip');
        [].forEach.call(chips, function (chip, i) { chip.classList.toggle('focus', zone === 'seasons' && i === si); chip.classList.toggle('active', i === si); });
        var track = seasonBox.querySelector('.season-track');
        if (track) track.style.transform = 'translateX(' + (-Math.max(0, si - 5) * 82) + 'px)';
      }
    }
    function cycleQuality(dir) {
      var at = qualities.indexOf(quality);
      at = (at + dir + qualities.length) % qualities.length;
      quality = qualities[at]; paint();
    }
    function poll(id) {
      if (!alive) return;
      api('/api/downloads/smart/' + encodeURIComponent(id)).then(function (job) {
        if (!alive) return;
        status.textContent = job.message || job.step || (job.state === 'running' ? T('Finding the best download…') : T('Download request finished.'));
        if (job.state === 'running') pollTimer = setTimeout(function () { poll(id); }, 1400);
        else {
          busy = false;
          downloadBtn.textContent = T('Download');
          if (job.state === 'failed') status.classList.add('error'); else status.classList.remove('error');
          loadLibrary().catch(function () {});
          if (job.state !== 'failed' && job.outcome !== 'none') offerLibrary(); // 'none': nothing to go and see
          paint();
        }
      }).catch(function (err) {
        if (!alive) return;
        busy = false; downloadBtn.textContent = T('Download'); status.textContent = err.message; status.classList.add('error'); paint();
      });
    }
    function download() {
      if (busy || state.me && state.me.canDownload === false) return;
      if (t.type === 'tv' && !seasons.length) { toast(T('The season list is still loading.')); return; }
      var body = { type: t.type, tmdbId: t.id };
      if (t.type === 'tv') body.season = seasons[si].number;
      if (quality) body.quality = quality;
      busy = true; status.classList.remove('error');
      downloadBtn.textContent = T('Starting…'); status.textContent = T('Finding the best download…'); paint();
      api('/api/downloads/smart', body).then(function (r) { if (alive) poll(r.id); })
        .catch(function (err) {
          if (!alive) return;
          busy = false; downloadBtn.textContent = T('Download'); status.textContent = err.message; status.classList.add('error'); paint();
        });
    }

    if (onWay) offerLibrary();
    buildSeasons(); paint();
    show({ el: el, focus: paint, leave: function () { alive = false; clearTimeout(pollTimer); },
      key: function (code) {
        if (zone === 'seasons') {
          if (code === KEY.LEFT && si > 0) { si--; paint(); return true; }
          if (code === KEY.RIGHT && si < seasons.length - 1) { si++; paint(); return true; }
          if (code === KEY.DOWN || code === KEY.ENTER) { zone = 'actions'; ai = lib ? 1 : 0; paint(); return true; }
          return code === KEY.UP || code === KEY.LEFT || code === KEY.RIGHT;
        }
        if (code === KEY.UP && t.type === 'tv' && seasons.length) { zone = 'seasons'; paint(); return true; }
        if (code === KEY.LEFT) { ai = Math.max(0, ai - 1); paint(); return true; }
        if (code === KEY.RIGHT) { ai = Math.min(actions.length - 1, ai + 1); paint(); return true; }
        if (code === KEY.ENTER) { actions[ai].act(); return true; }
        if (code === KEY.DOWN && actions[ai].quality) { cycleQuality(1); return true; }
        return false;
      } }, true);

    if (t.type === 'tv') {
      api('/api/tv/' + encodeURIComponent(t.id) + '/seasons').then(function (d) {
        if (!alive) return;
        seasons = (d.seasons || []).filter(function (s) { return !s.upcoming; });
        if (!seasons.length) seasons = d.seasons || [];
        si = Math.max(0, seasons.length - 1);
        buildSeasons(); paint();
      }).catch(function (err) {
        if (!alive) return;
        seasonBox.innerHTML = '';
        seasonBox.appendChild(h('div', { class: 'season-note error', text: T('Couldn’t load seasons: {0}', err.message) }));
      });
    }
  }

  function showOf(f) {
    for (var i = 0; i < state.shows.length; i++) if (state.shows[i].id === f.show) return state.shows[i];
    return null;
  }

  // ---------- a show: seasons and episodes ----------
  function showPage(s) {
    var seasons = L.showSeasons(state.library, s.id);
    var startAt = L.startEpisode(seasons, state.progress, load(WATCHED_KEY, {}));
    var si = 0, ei = 0, zone = 'episodes';
    seasons.forEach(function (season, i) { season.episodes.forEach(function (f, j) { if (f === startAt) { si = i; ei = j; } }); });
    var tabs = h('div', { class: 'seasons' });
    var list = h('div', { class: 'episodes' });
    var strip = progressStrip(), open = true;
    function onWayHere() { return state.pending.filter(function (p) { return p.showId === s.id; })[0] || null; }
    strip.set(onWayHere());
    var el = h('div', { class: 'screen show' },
      h('div', { class: 'backdrop' }, img(s.backdrop)),
      h('div', { class: 'show-head' }, titleLogo(h('h1', { text: s.title }), 'tv', s.tmdbId, s.title), s.overview ? h('p', { class: 'overview', text: s.overview }) : null, castLine('tv', s.tmdbId, 'show-cast'), strip.el),
      tabs, h('div', { class: 'list-viewport' }, list));
    var waited = onWayHere() ? onWayHere().items.length : 0;
    followPending(function () { return open; }, function () {
      var p = onWayHere(), now = p ? p.items.length : 0;
      strip.set(p);
      // An episode finished while you were here: it joins the list.
      if (now !== waited) {
        waited = now;
        loadLibrary().then(function () {
          if (!open) return;
          seasons = L.showSeasons(state.library, s.id);
          si = Math.min(si, Math.max(0, seasons.length - 1));
          if (seasons.length) { buildTabs(); buildList(); paint(); }
        }).catch(function () {});
      }
    });
    function buildTabs() {
      tabs.innerHTML = '';
      seasons.forEach(function (season) { tabs.appendChild(h('div', { class: 'tab', text: T('Season {0}', season.number) })); });
    }
    function buildList() {
      list.innerHTML = '';
      seasons[si].episodes.forEach(function (f) {
        var p = state.progress[L.progressRef(f)];
        var ok = L.resumable(p);
        list.appendChild(h('div', { class: 'episode' + (f.converting ? ' is-busy' : '') },
          h('div', { class: 'art' }, img(f.still || s.backdrop), ok ? h('div', { class: 'bar' }, h('i', { style: 'width:' + (p.time / p.duration * 100).toFixed(1) + '%' })) : null),
          h('div', { class: 'text' },
            h('div', { class: 'label', text: T('Episode {0}', f.episode) + (ok ? ' · ' + L.minutesLeft(p) : '')
              + (f.converting ? ' · ' + T('getting ready') + (typeof f.convertPercent === 'number' ? ' ' + Math.floor(f.convertPercent) + ' %' : '') : '') }),
            h('div', { class: 'name', text: f.episodeName || L.episodeLabel(f) }))));
      });
    }
    function paint() {
      [].forEach.call(tabs.children, function (t, i) { t.classList.toggle('active', i === si); t.classList.toggle('focus', zone === 'seasons' && i === si); });
      var items = list.children;
      [].forEach.call(items, function (it, i) { it.classList.toggle('focus', zone === 'episodes' && i === ei); });
      var item = items[ei];
      list.style.transform = 'translateY(' + (item ? -Math.max(0, item.offsetTop - 170) : 0) + 'px)';
    }
    buildTabs(); buildList();
    show({ el: el, focus: paint,
      leave: function () { open = false; },
      refresh: function () { loadLibrary().then(function () { seasons = L.showSeasons(state.library, s.id); si = Math.min(si, seasons.length - 1); if (si < 0) { back(); return; } buildList(); paint(); }).catch(function () {}); },
      key: function (code) {
        if (zone === 'seasons') {
          if (code === KEY.LEFT && si > 0) { si--; ei = 0; buildList(); }
          else if (code === KEY.RIGHT && si < seasons.length - 1) { si++; ei = 0; buildList(); }
          else if (code === KEY.DOWN || code === KEY.ENTER) zone = 'episodes';
          else return code === KEY.LEFT || code === KEY.RIGHT || code === KEY.UP;
          paint(); return true;
        }
        if (code === KEY.UP) { if (ei > 0) ei--; else if (seasons.length > 1) zone = 'seasons'; paint(); return true; }
        if (code === KEY.DOWN) { ei = Math.min(seasons[si].episodes.length - 1, ei + 1); paint(); return true; }
        if (code === KEY.LEFT || code === KEY.RIGHT) return true;
        if (code === KEY.ENTER) { var f = seasons[si].episodes[ei]; if (f) playAsked(f); return true; }
        return false;
      } }, true);
  }

  // ---------- resume or start over ----------
  function playAsked(f) {
    if (f.converting) { toast(T('This one is still being prepared. Try again in a little while.')); return; }
    var p = state.progress[L.progressRef(f)];
    if (!L.resumable(p)) { play(f, 0); return; }
    var choice = 0;
    var buttons = [h('button', { class: 'choice', text: T('Resume from {0}', L.fmtTime(p.time)) }), h('button', { class: 'choice', text: T('Start over') })];
    var el = h('div', { class: 'screen dialog' }, h('div', { class: 'dialog-box' },
      h('h2', { text: f.season != null ? [L.episodeLabel(f), f.episodeName].filter(Boolean).join(' · ') : f.filmTitle || f.title }), buttons));
    function paint() { buttons.forEach(function (b, i) { b.classList.toggle('focus', i === choice); }); }
    show({ el: el, focus: paint, key: function (code) {
      if (code === KEY.UP || code === KEY.LEFT) { choice = 0; paint(); return true; }
      if (code === KEY.DOWN || code === KEY.RIGHT) { choice = 1; paint(); return true; }
      if (code === KEY.ENTER) { var at = choice === 0 ? p.time : 0; screen = history.pop(); play(f, at); return true; }
      return false;
    } }, true);
  }

  // ---------- the player ----------
  function play(f, startAt) {
    var av = window.webapis && webapis.avplay;
    if (!av) { toast(T('This TV can’t play videos from here.')); return; }
    var ref = { kind: 'lib', id: f.id };
    var s = { f: f, time: startAt || 0, duration: 0, playing: false, ended: false, intro: null, introDone: false, creditsAt: null,
      dismissed: false, autoLeft: null, cues: null, subLang: '', lastSave: 0, played: 0, playTick: null, closed: false, busy: false };
    var obj = h('object', { id: 'av', type: 'application/avplayer' });
    var subsEl = h('div', { class: 'subs' });
    var osd = h('div', { class: 'osd' },
      h('div', { class: 'osd-title' }, h('b', { text: showOf(f) ? showOf(f).title : f.filmTitle || f.title }),
        h('span', { text: f.season != null ? ' ' + [L.episodeLabel(f), f.episodeName].filter(Boolean).join(' · ') : '' })),
      h('div', { class: 'osd-bar' }, h('i', {})),
      h('div', { class: 'osd-times' }, h('span', { class: 'pos', text: '0:00' }), h('span', { class: 'state', text: '' }), h('span', { class: 'dur', text: '' })),
      h('div', { class: 'osd-hint' }, h('span', { text: T('Left / Right: 10 s') }), h('span', { text: T('OK: pause') }), h('span', { text: T('Down: subtitles and audio') })));
    var skipBtn = h('div', { class: 'skip-intro' }, T('Skip intro'));
    skipBtn.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l8 7-8 7zM14 5l8 7-8 7z"/></svg>');
    var upNext = h('div', { class: 'up-next' },
      h('div', { class: 'up-next-art' }), h('div', { class: 'up-next-text' }, h('div', { class: 'up-next-label', text: T('Up next') }), h('div', { class: 'up-next-title' })),
      h('div', { class: 'up-next-actions' }, h('div', { class: 'btn play-next' }), h('div', { class: 'btn keep', text: T('Keep watching') })));
    var menu = h('div', { class: 'menu' });
    var spinner = h('div', { class: 'loading', text: T('Loading…') });
    var el = h('div', { class: 'screen player' }, osd, subsEl, skipBtn, upNext, menu, spinner);
    var cardFocus = 0, menuItems = [], menuIndex = 0, osdTimer = null, seekTarget = null, seekTimer = null, tick = null, autoTimer = null;

    function now() { try { return av.getCurrentTime() / 1000; } catch (e) { return s.time; } }
    function showOsd(stay) {
      var was = osd.classList.contains('show');
      osd.classList.add('show');
      if (!was) paint();
      clearTimeout(osdTimer);
      if (!stay) osdTimer = setTimeout(function () { if (s.playing) osd.classList.remove('show'); }, 4000);
    }
    // The web page sits on top of the video, and this TV's CPU is slow: touch the page only when something
    // on it changes (the hidden OSD isn't updated, unchanged text isn't rewritten).
    var osdBar = osd.querySelector('.osd-bar i'), osdPos = osd.querySelector('.pos'), osdDur = osd.querySelector('.dur'), osdState = osd.querySelector('.state');
    function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
    function paint() {
      var t = seekTarget != null ? seekTarget : s.time;
      if (osd.classList.contains('show')) {
        if (s.duration) {
          var w = (t / s.duration * 100).toFixed(1) + '%';
          if (osdBar.style.width !== w) osdBar.style.width = w;
          setText(osdDur, L.fmtTime(s.duration));
        }
        setText(osdPos, L.fmtTime(t));
        setText(osdState, s.playing || s.ended ? '' : T('Paused'));
      }
      if (s.cues) { var text = L.cueText(s.cues, s.time); if (subsEl.textContent !== text) subsEl.textContent = text; }
      var intro = !s.ended && L.introShowing(s.time, s.intro);
      if (intro && !s.introDone && s.playing && state.me && state.me.settings && state.me.settings.skipIntro === 'auto') { skipIntro(true); return; }
      if (skipBtn.classList.contains('show') !== intro) skipBtn.classList.toggle('show', intro);
      var skipFocus = intro && !menu.classList.contains('show');
      if (skipBtn.classList.contains('focus') !== skipFocus) skipBtn.classList.toggle('focus', skipFocus);
      paintUpNext();
    }
    function nextUp() { return L.nextEpisode(f.id, state.library, state.shows); }
    function paintUpNext() {
      var next = nextUp();
      var on = Boolean(next && !s.dismissed && L.isNextTime(s.time, s.duration, s.creditsAt, s.ended));
      if (upNext.classList.contains('show') !== on) upNext.classList.toggle('show', on);
      var counting = on && !s.busy && autoChain < L.AUTOPLAY_CHAIN;
      if (counting && s.autoLeft == null) startCountdown();
      else if (!on) stopCountdown();
      if (!on) return;
      var title = [L.episodeLabel(next), next.episodeName].filter(Boolean).join(' · ');
      var t = upNext.querySelector('.up-next-title');
      if (t.textContent !== title) {
        t.textContent = title;
        var art = upNext.querySelector('.up-next-art');
        art.innerHTML = '';
        art.appendChild(img(next.still || (showOf(next) && showOf(next).backdrop)));
      }
      var left = s.autoLeft == null ? null : Math.max(1, Math.ceil(s.autoLeft));
      var label = s.busy ? T('Starting…') : left ? T('Next episode in {0}', left) : T('Next episode');
      var btn = upNext.querySelector('.play-next');
      if (btn.textContent !== label) btn.textContent = label;
      btn.style.setProperty('--progress', left == null ? '0' : String(1 - s.autoLeft / L.AUTOPLAY_SECONDS));
      btn.classList.toggle('counting', left != null);
      btn.classList.toggle('focus', cardFocus === 0);
      upNext.querySelector('.keep').classList.toggle('focus', cardFocus === 1);
      upNext.querySelector('.keep').textContent = s.ended ? T('Back') : T('Keep watching');
    }
    // Real seconds while the credits play or after the end; paused on the TV pauses it too.
    function startCountdown() {
      s.autoLeft = L.AUTOPLAY_SECONDS;
      var last = Date.now();
      autoTimer = setInterval(function () {
        var t = Date.now();
        if (s.playing || s.ended) s.autoLeft -= (t - last) / 1000;
        last = t;
        if (s.autoLeft <= 0) { stopCountdown(); autoChain++; playNext(); return; }
        paintUpNext();
      }, 250);
    }
    function stopCountdown() { clearInterval(autoTimer); autoTimer = null; s.autoLeft = null; }

    function skipIntro(auto) {
      if (!s.intro) return;
      s.introDone = true;
      seekTo(s.intro.end);
      toast(auto ? T('Intro skipped') : T('Skipped the intro'));
    }
    function seekTo(sec) {
      sec = Math.max(0, Math.min(s.duration ? s.duration - 2 : sec, sec));
      s.time = sec;
      try { av.seekTo(Math.floor(sec * 1000), function () {}, function () {}); } catch (e) { /* not ready */ }
      paint();
    }
    // ◀ ▶ add up while pressed in a row, then one seek: AVPlay doesn't like a seek per key press.
    function nudge(delta) {
      if (!s.duration) return;
      seekTarget = Math.max(0, Math.min(s.duration - 2, (seekTarget != null ? seekTarget : s.time) + delta));
      showOsd(true); paint();
      clearTimeout(seekTimer);
      seekTimer = setTimeout(function () { var t = seekTarget; seekTarget = null; seekTo(t); showOsd(); }, 700);
    }
    function togglePause(want) {
      var pause = want != null ? want : s.playing;
      try { if (pause) av.pause(); else av.play(); } catch (e) { return; }
      s.playing = !pause; movedAt = Date.now();
      countPlayed();
      if (pause) save(true);
      showOsd(pause); paint();
    }

    // ---- resume points and watch time ----
    function countPlayed() {
      var t = Date.now();
      if (s.playTick) s.played += (t - s.playTick) / 1000;
      s.playTick = s.playing ? t : null;
    }
    function save(force) {
      if (!s.duration) return;
      var t = Date.now();
      if (!force && t - s.lastSave < 15000) return;
      s.lastSave = t;
      countPlayed();
      var done = s.ended || s.duration - s.time < L.DONE_SECONDS;
      var key = L.progressRef(f);
      if (done) {
        delete state.progress[key];
        var watched = load(WATCHED_KEY, {}); watched[key] = t;
        try { localStorage.setItem(WATCHED_KEY, JSON.stringify(watched)); } catch (e) { /* full */ }
      } else state.progress[key] = { time: s.time, duration: s.duration, at: t };
      var watchedSecs = Math.round(s.played * 10) / 10;
      s.played = 0;
      api('/api/me/progress', { ref: key, time: done ? null : s.time, duration: s.duration, watched: watchedSecs,
        about: { titleKey: L.titleKey(f), title: f.filmTitle || f.canonicalTitle || f.title || '', season: f.season != null ? f.season : null, episode: f.episode != null ? f.episode : null } })
        .catch(function () {});
    }

    // ---- subtitles and audio (▼) ----
    function subLangs() {
      return api('/api/subs/langs?kind=lib&id=' + encodeURIComponent(f.id)).then(function (d) { return d.languages || []; }).catch(function () { return []; });
    }
    function setSubs(lang) {
      s.subLang = lang || '';
      s.cues = null; subsEl.textContent = '';
      if (!lang) return Promise.resolve();
      return api('/api/subs/fetch', { kind: 'lib', id: f.id, lang: lang })
        .then(function (r) { return fetch(SERVER + r.url, { credentials: 'omit' }); })
        .then(function (r) { return r.text(); })
        .then(function (text) { if (s.subLang === lang) s.cues = L.parseVtt(text); })
        .catch(function (err) { toast(T('Couldn’t get those subtitles: {0}', err.message)); });
    }
    function audioTracks() {
      try {
        return av.getTotalTrackInfo().filter(function (t) { return t.type === 'AUDIO'; }).map(function (t) {
          var info = {}; try { info = JSON.parse(t.extra_info); } catch (e) { /* none */ }
          return { index: t.index, name: [info.language ? String(info.language).toUpperCase() : T('Track {0}', t.index + 1), info.channels ? info.channels + ' ch' : '', info.fourCC || ''].filter(Boolean).join(' · ') };
        });
      } catch (e) { return []; }
    }
    function openMenu() {
      showOsd(true);
      subLangs().then(function (langs) {
        menuItems = [{ head: T('Subtitles') }, { label: T('Off'), on: !s.subLang, act: function () { setSubs(''); } }];
        langs.forEach(function (l) { menuItems.push({ label: l.name, on: s.subLang === l.code, act: function () { toast(T('Getting {0} subtitles…', l.name)); setSubs(l.code); } }); });
        var tracks = audioTracks();
        if (tracks.length > 1) {
          var current = -1;
          try { var cur = av.getCurrentStreamInfo().filter(function (t) { return t.type === 'AUDIO'; })[0]; current = cur ? cur.index : -1; } catch (e) { /* unknown */ }
          menuItems.push({ head: T('Audio') });
          tracks.forEach(function (t) { menuItems.push({ label: t.name, on: t.index === current, act: function () { try { av.setSelectTrack('AUDIO', t.index); } catch (e) { toast(T('This audio track can’t be picked here.')); } } }); });
        }
        menuIndex = menuItems.findIndex(function (m) { return m.on; });
        if (menuIndex < 0) menuIndex = 1;
        menu.classList.add('show');
        paintMenu();
      });
    }
    function paintMenu() {
      menu.innerHTML = '';
      menuItems.forEach(function (m, i) {
        menu.appendChild(m.head ? h('div', { class: 'menu-head', text: m.head })
          : h('div', { class: 'menu-item' + (m.on ? ' on' : '') + (i === menuIndex ? ' focus' : ''), text: m.label }));
      });
    }
    function menuMove(d) {
      var i = menuIndex;
      do { i += d; } while (menuItems[i] && menuItems[i].head);
      if (menuItems[i]) { menuIndex = i; paintMenu(); }
    }

    // ---- starting, ending, next episode ----
    function close() {
      if (s.closed) return;
      s.closed = true;
      save(true);
      clearInterval(tick); stopCountdown(); clearTimeout(osdTimer); clearTimeout(seekTimer);
      try { av.stop(); } catch (e) { /* already */ }
      try { av.close(); } catch (e) { /* already */ }
      if (obj.parentNode) obj.parentNode.removeChild(obj);
      document.body.classList.remove('playing');
      document.removeEventListener('visibilitychange', onHidden);
    }
    function leavePlayer() { close(); back(); }
    function playNext() {
      var next = nextUp();
      if (!next || s.busy) return;
      s.busy = true; paintUpNext();
      s.ended = true; // counts as watched
      close();
      var p = state.progress[L.progressRef(next)];
      screen = history.pop(); // the player is replaced, not stacked
      play(next, L.resumable(p) ? p.time : 0);
    }
    function onHidden() { if (document.hidden) leavePlayer(); } // TV home button or another app: stop, keep the resume point

    function fail(message) {
      spinner.textContent = T('This video can’t play on the TV.') + ' ' + (message || '');
      spinner.classList.add('error');
    }
    // AVPlay on older Tizen can sit in "Loading…" forever after a dropped connection. If buffering or the
    // play position stalls for 12 s, the stream is reopened where it stopped (up to 5 times in a row).
    var streamUrl = null, bufferingSince = 0, movedAt = 0, lastPlayMs = -1, retries = 0, reopening = false;
    function openStream(at) {
      av.open(streamUrl);
      movedAt = Date.now(); bufferingSince = 0;
        av.setDisplayRect(0, 0, 1920, 1080);
        try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* older firmware */ }
        av.setListener({
          onbufferingstart: function () { spinner.textContent = T('Loading…'); spinner.classList.add('show'); bufferingSince = Date.now(); },
          onbufferingcomplete: function () { spinner.classList.remove('show'); bufferingSince = 0; },
          oncurrentplaytime: function (ms) {
            if (seekTarget == null) s.time = ms / 1000;
            if (ms !== lastPlayMs) { lastPlayMs = ms; movedAt = Date.now(); if (ms > 1000) retries = 0; }
          },
          onstreamcompleted: function () {
            s.ended = true; s.playing = false; countPlayed(); save(true);
            if (nextUp() && !s.dismissed) { cardFocus = 0; paint(); } else leavePlayer();
          },
          onerror: function (e) { if (!reopen()) fail(String(e)); },
          onevent: function () {},
        });
        av.prepareAsync(function () {
          if (s.closed) return;
          s.duration = av.getDuration() / 1000;
          var go = function () { try { av.play(); s.playing = true; s.playTick = Date.now(); spinner.classList.remove('show'); showOsd(); paint(); } catch (e) { fail(e.message); } };
          if (at > 5) {
            s.time = at;
            av.seekTo(Math.floor(at * 1000), go, function (e) {
              if (!reopen()) fail(T('Couldn’t restore your playback position.') + ' ' + String(e && e.name || e || ''));
            });
          } else go();
        }, function (e) { if (!reopen()) fail(String(e && e.name || e)); });
    }
    function reopen() {
      if (s.closed || reopening || !streamUrl || retries >= 5) return false;
      retries++; reopening = true;
      var at = s.time;
      try {
        var live = av.getCurrentTime() / 1000;
        if (live > 5 || at <= 5) at = live;
      } catch (e) { /* keep the last reported position */ }
      s.time = at;
      save(true);
      spinner.textContent = T('Reconnecting…'); spinner.classList.add('show');
      try { av.stop(); } catch (e) { /* already */ }
      try { av.close(); } catch (e) { /* already */ }
      setTimeout(function () { reopening = false; if (!s.closed) { try { openStream(at); } catch (e) { fail(e.message); } } }, 1000);
      return true;
    }
    function watchStall() {
      if (reopening || s.ended || seekTarget != null) return;
      var t = Date.now();
      if ((bufferingSince && t - bufferingSince > 12000) || (s.playing && t - movedAt > 12000)) reopen();
    }
    function begin() {
      document.body.insertBefore(obj, document.body.firstChild);
      document.body.classList.add('playing');
      document.addEventListener('visibilitychange', onHidden);
      // The MP4 copy when there is one (always TV-safe audio: the TV can't decode DTS), else the original.
      // The Android app asks for H.264 instead on TVs that can't decode HEVC (tv/android, Codecs.java).
      api('/api/play-link?kind=lib&id=' + encodeURIComponent(f.id) + '&variant=' + (window.MARQUEE_TV_PLAY || 'browser-hevc')).then(function (link) {
        if (s.closed) return;
        streamUrl = SERVER + link.url;
        openStream(startAt);
      }).catch(function (err) { fail(err.message); });
      tick = setInterval(function () {
        if (s.closed) return;
        if (s.playing && seekTarget == null) s.time = now();
        paint();
        if (s.playing) save(false);
        watchStall();
      }, 500);
      var base = '/api/media/lib/' + encodeURIComponent(f.id);
      api(base + '/intro').then(function (d) { if (d.intro && d.intro.end - d.intro.start >= 5) s.intro = d.intro; }).catch(function () {});
      api(base + '/credits').then(function (d) { if (d.creditsAt > 0) s.creditsAt = d.creditsAt; }).catch(function () {});
      var pref = state.me && state.me.settings && state.me.settings.subLang;
      if (pref) subLangs().then(function (langs) { if (langs.some(function (l) { return l.code === pref; })) setSubs(pref); });
    }

    show({ el: el, leave: close, key: function (code) {
      if (menu.classList.contains('show')) {
        if (code === KEY.UP) menuMove(-1);
        else if (code === KEY.DOWN) menuMove(1);
        else if (code === KEY.ENTER) { var m = menuItems[menuIndex]; if (m && m.act) m.act(); menu.classList.remove('show'); showOsd(); }
        else if (code === KEY.BACK || code === KEY.LEFT) { menu.classList.remove('show'); showOsd(); }
        return true;
      }
      var cardOn = upNext.classList.contains('show');
      if (cardOn) {
        if (code === KEY.LEFT || code === KEY.RIGHT) { cardFocus = cardFocus ? 0 : 1; stopCountdown(); paint(); return true; }
        if (code === KEY.ENTER) { if (cardFocus === 0) playNext(); else { s.dismissed = true; if (s.ended) leavePlayer(); else paint(); } return true; }
        if (code === KEY.BACK) { s.dismissed = true; if (s.ended) leavePlayer(); else paint(); return true; }
      }
      if (code === KEY.ENTER && skipBtn.classList.contains('show')) { skipIntro(false); return true; }
      if (code === KEY.ENTER || code === KEY.PLAYPAUSE) { togglePause(); return true; }
      if (code === KEY.PLAY) { togglePause(false); return true; }
      if (code === KEY.PAUSE) { togglePause(true); return true; }
      if (code === KEY.LEFT || code === KEY.RW) { nudge(-10); return true; }
      if (code === KEY.RIGHT || code === KEY.FF) { nudge(code === KEY.FF ? 30 : 10); return true; }
      if (code === KEY.DOWN) { openMenu(); return true; }
      if (code === KEY.UP) { showOsd(); return true; }
      if (code === KEY.BACK || code === KEY.STOP) { leavePlayer(); return true; }
      return true;
    } }, true);
    spinner.classList.add('show');
    begin();
  }

  start();
})();
