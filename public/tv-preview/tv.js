// Marquee TV Preview: an isolated second TV client loaded by tv/tizen-preview.
// It keeps the stable /tv client untouched while adding lightweight Discover + smart downloads.
// Remote-control navigation, the TV's own player (AVPlay: MKV, HEVC, surround),
// and Skip intro / Up next on the screen itself.
// Written for the TV's browser engine (Samsung 2020 = Chrome 69): no optional chaining, nullish coalescing, or newer built-ins.
(function () {
  'use strict';
  var L = window.MarqueeTvLogic;
  var SERVER = String(window.MARQUEE_SERVER || '').replace(/\/+$/, '');
  var TOKEN_KEY = 'marquee:tv-preview-session'; // kept separate from the stable TV app
  var WATCHED_KEY = 'marquee:tv-preview-watched';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, BACKSPACE: 8, ESC: 27,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412 };
  var app = document.getElementById('app');
  var state = { me: null, library: [], shows: [], progress: {} };
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

  function api(path, body) {
    var headers = { 'X-Marquee-TV': '1' };
    var t = token();
    if (t && t !== 'home') headers['X-Marquee-Session'] = t;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(SERVER + path, { method: body !== undefined ? 'POST' : 'GET', headers: headers, credentials: 'omit',
      body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.ok) return d;
          var e = new Error(d.error || 'Marquee answered ' + r.status + '.');
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
    if (screen && screen.key && screen.key(code)) { e.preventDefault(); return; }
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
        return pairScreen(me && me.id != null, 'This TV was signed out. Sign it in again.');
      }
      state.me = me;
      return loadLibrary().then(homeScreen);
    }).catch(function (err) {
      if (err.status === 401) { localStorage.removeItem(TOKEN_KEY); return pairScreen(false); }
      app.innerHTML = '';
      app.appendChild(h('div', { class: 'boot' }, h('div', { class: 'wordmark', text: 'Marquee' }),
        h('p', { class: 'boot-note', text: 'Can’t reach Marquee right now (' + err.message + '). Trying again…' })));
      setTimeout(start, 5000);
    });
  }

  function pairScreen(homeAvailable, note) {
    var codeEl = h('div', { class: 'pair-code', 'aria-live': 'polite' });
    var noteEl = h('p', { class: 'pair-note', text: note || '' });
    var homeBtn = homeAvailable ? h('div', { class: 'pair-alt' }, h('span', { class: 'pair-alt-hint', text: 'No account? Press Down for' }),
      h('button', { class: 'pair-home', text: 'Use the shared Home network account' })) : null;
    var el = h('div', { class: 'screen pair' },
      h('div', { class: 'wordmark', text: 'Marquee' }),
      h('h1', { text: 'Sign in this TV' }),
      h('ol', { class: 'pair-steps' },
        h('li', {}, 'On your phone, open Marquee and go to ', h('b', { text: 'Settings' }), '.'),
        h('li', {}, 'Under ', h('b', { text: 'Sign in a TV' }), ', enter this code:')),
      codeEl, noteEl, homeBtn);
    var poll = null, timer = null, alive = true;
    function newCode() {
      if (!alive) return;
      api('/api/tv/pair/start', {}).then(function (r) {
        poll = r.poll;
        codeEl.innerHTML = '';
        r.code.split('').forEach(function (c, i) { codeEl.appendChild(h('span', { class: i === 3 ? 'gap' : '', text: c })); });
        noteEl.textContent = note || 'The code changes every ' + Math.round(r.expiresIn / 60) + ' minutes.';
        check();
      }).catch(function (err) { noteEl.textContent = err.message + ' Trying again…'; timer = setTimeout(newCode, 5000); });
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
      toast('Signed in as ' + (grant.name || 'you'));
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
    return Promise.all([api('/api/library'), api('/api/me/progress').catch(function () { return { progress: {} }; })]).then(function (r) {
      state.library = r[0].items || [];
      state.shows = r[0].shows || [];
      state.progress = r[1].progress || {};
    });
  }

  // ---------- home: Continue watching, Shows, Films ----------
  // A library the owner shares between people (Settings -> People) shows everyone's titles here.
  function sharedNote() {
    var mates = (state.me && state.me.sharedWith || []).map(function (m) { return m.name; });
    if (!mates.length) return null;
    var names = mates.length < 2 ? mates[0] : mates.slice(0, -1).join(', ') + ' and ' + mates[mates.length - 1];
    return h('span', { class: 'shared', text: 'Shared with ' + names });
  }

  function homeScreen() {
    var el = h('div', { class: 'screen home' });
    var rowsEl = h('div', { class: 'rows' });
    var discoverBtn = h('button', { class: 'discover-link focusable', text: 'Discover' });
    var top = h('header', { class: 'topbar' }, h('div', { class: 'brandline' },
        h('div', { class: 'wordmark', text: 'Marquee' }), h('span', { class: 'preview-label', text: 'Preview' })),
      h('div', { class: 'top-actions' }, discoverBtn,
        h('div', { class: 'who' }, h('span', { text: state.me && state.me.name || '' }),
          sharedNote(), h('button', { class: 'switch focusable', text: 'Switch account' }))));
    el.appendChild(top);
    el.appendChild(rowsEl);
    var rows = [];   // { el, track, items: [{ el, open }], index }
    var r = 0, topIndex = 0; // -1 = top controls; 0 Discover, 1 Switch account

    function build() {
      var data = L.homeRows(state.library, state.shows, state.progress);
      rows = [];
      rowsEl.innerHTML = '';
      if (data.cont.length) rows.push(makeRow('Continue watching', 'wide', data.cont.map(continueCard)));
      if (data.shows.length) rows.push(makeRow('Shows', 'poster', data.shows.map(showCard)));
      if (data.films.length) rows.push(makeRow('Films', 'poster', data.films.map(filmCard)));
      if (!rows.length) {
        rowsEl.appendChild(h('div', { class: 'empty' }, h('h2', { text: 'Your library is empty' }),
          h('p', { text: 'Open Discover above to find something to download.' })));
        r = -1;
      }
      rows.forEach(function (row) { rowsEl.appendChild(row.el); });
      r = Math.min(Math.max(r, rows.length ? 0 : -1), rows.length - 1);
    }
    function makeRow(title, kind, items) {
      var track = h('div', { class: 'track' });
      items.forEach(function (it) { track.appendChild(it.el); });
      return { el: h('section', { class: 'row row-' + kind }, h('h2', { text: title }), h('div', { class: 'viewport' }, track)), track: track, items: items, index: 0, kind: kind };
    }
    function continueCard(f) {
      var p = state.progress[L.progressRef(f)];
      var showInfo = showOf(f);
      var pct = Math.min(100, p.time / p.duration * 100);
      return { el: h('div', { class: 'card wide' },
        h('div', { class: 'art' }, img(f.season != null ? bigger(f.still) || (showInfo && showInfo.backdrop) : f.backdrop || f.poster),
          h('div', { class: 'bar' }, h('i', { style: 'width:' + pct.toFixed(1) + '%' }))),
        h('div', { class: 'name', text: showInfo ? showInfo.title : f.filmTitle || f.title }),
        h('div', { class: 'sub', text: [L.episodeLabel(f), f.episodeName, L.minutesLeft(p)].filter(Boolean).join(' · ') })),
      open: function () { play(f, p.time); } };
    }
    function showCard(s) {
      return { el: h('div', { class: 'card poster' }, h('div', { class: 'art' }, img(s.poster)), h('div', { class: 'name', text: s.title })),
        open: function () { showPage(s); } };
    }
    function filmCard(f) {
      return { el: h('div', { class: 'card poster' }, h('div', { class: 'art' }, img(f.poster || f.backdrop)),
        h('div', { class: 'name', text: f.filmTitle || f.title }), h('div', { class: 'sub', text: f.year ? String(f.year) : '' })),
        open: function () { playAsked(f); } };
    }
    function paint() {
      discoverBtn.classList.toggle('focus', r === -1 && topIndex === 0);
      top.querySelector('.switch').classList.toggle('focus', r === -1 && topIndex === 1);
      rows.forEach(function (row, i) {
        row.items.forEach(function (it, j) { it.el.classList.toggle('focus', i === r && j === row.index); });
        // Keep the focused card in view: the row slides so it sits second from the left.
        var card = row.items[0] && row.items[0].el;
        var step = card ? card.offsetWidth + 32 : 0;
        var visible = Math.max(1, Math.floor((1920 - 160) / (step || 1)));
        var first = Math.max(0, Math.min(row.index - 1, row.items.length - visible));
        row.track.style.transform = 'translateX(' + (-first * step) + 'px)';
      });
      var focused = rows[r];
      rowsEl.style.transform = 'translateY(' + (focused ? -Math.max(0, focused.el.offsetTop - 40) : 0) + 'px)';
    }
    build();
    show({ el: el,
      focus: paint,
      refresh: function () { loadLibrary().then(function () { build(); paint(); }).catch(function () {}); },
      key: function (code) {
        var row = rows[r];
        if (code === KEY.UP) { if (r > -1) r--; paint(); return true; }
        if (code === KEY.DOWN) { if (r < rows.length - 1) r++; paint(); return true; }
        if (code === KEY.LEFT && r === -1) { topIndex = 0; paint(); return true; }
        if (code === KEY.RIGHT && r === -1) { topIndex = 1; paint(); return true; }
        if (code === KEY.LEFT && row) { row.index = Math.max(0, row.index - 1); paint(); return true; }
        if (code === KEY.RIGHT && row) { row.index = Math.min(row.items.length - 1, row.index + 1); paint(); return true; }
        if (code === KEY.ENTER) {
          if (r === -1 && topIndex === 0) { discoverScreen(); return true; }
          if (r === -1 && topIndex === 1) { localStorage.removeItem(TOKEN_KEY); history = []; screen = null; pairScreen(true); return true; }
          if (row) row.items[row.index].open();
          return true;
        }
        return false;
      } });
  }
  // ---------- Discover (preview only) ----------
  // The TV only renders a small slice of each server-curated row. TMDB lookup, torrent search,
  // release selection and qBittorrent all stay on the server so the 2020 TV does very little work.
  function titleInLibrary(t) {
    var i, id = Number(t.id);
    if (t.type === 'movie') {
      for (i = 0; i < state.library.length; i++) {
        if (state.library[i].season == null && Number(state.library[i].tmdbId) === id) return true;
      }
      return false;
    }
    for (i = 0; i < state.shows.length; i++) {
      if (Number(state.shows[i].tmdbId) === id || state.shows[i].id === 'tv-' + id) return true;
    }
    return false;
  }

  function discoverScreen() {
    var el = h('div', { class: 'screen home discover-screen' });
    var rowsEl = h('div', { class: 'rows' });
    var top = h('header', { class: 'topbar' },
      h('div', { class: 'brandline' }, h('div', { class: 'wordmark', text: 'Discover' }), h('span', { class: 'preview-label', text: 'Preview' })),
      h('div', { class: 'discover-hint', text: 'Back: Library · OK: Details' }));
    el.appendChild(top); el.appendChild(rowsEl);
    var rows = [], r = 0, alive = true;

    function makeRow(title, items) {
      var track = h('div', { class: 'track' });
      var cards = items.slice(0, 8).map(function (t) {
        var local = titleInLibrary(t);
        var card = h('div', { class: 'card poster discover-card' },
          h('div', { class: 'art' }, img(t.poster), local ? h('span', { class: 'tv-badge', text: 'In library' }) : null),
          h('div', { class: 'name', text: t.title }),
          h('div', { class: 'sub', text: [t.year, t.type === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(' · ') }));
        return { el: card, open: function () { discoverTitle(t); } };
      });
      cards.forEach(function (c) { track.appendChild(c.el); });
      return { el: h('section', { class: 'row row-poster' }, h('h2', { text: title }), h('div', { class: 'viewport' }, track)),
        track: track, items: cards, index: 0 };
    }
    function build(data) {
      rows = (data.rows || []).slice(0, 6).map(function (row) { return makeRow(row.title, row.items || []); })
        .filter(function (row) { return row.items.length; });
      rowsEl.innerHTML = '';
      if (!rows.length) {
        rowsEl.appendChild(h('div', { class: 'empty' }, h('h2', { text: 'Nothing to discover right now' }),
          h('p', { text: 'Check that TMDB is configured on the Marquee server.' })));
        r = -1; return;
      }
      rows.forEach(function (row) { rowsEl.appendChild(row.el); });
      r = Math.max(0, Math.min(r, rows.length - 1));
      paint();
    }
    function paint() {
      rows.forEach(function (row, i) {
        row.items.forEach(function (it, j) { it.el.classList.toggle('focus', i === r && j === row.index); });
        var card = row.items[0] && row.items[0].el;
        var step = card ? card.offsetWidth + 32 : 0;
        var visible = Math.max(1, Math.floor((1920 - 160) / (step || 1)));
        var first = Math.max(0, Math.min(row.index - 1, row.items.length - visible));
        row.track.style.transform = 'translateX(' + (-first * step) + 'px)';
      });
      var focused = rows[r];
      rowsEl.style.transform = 'translateY(' + (focused ? -Math.max(0, focused.el.offsetTop - 40) : 0) + 'px)';
    }
    function loadDiscover() {
      rowsEl.innerHTML = '';
      rowsEl.appendChild(h('div', { class: 'empty discover-loading' }, h('h2', { text: 'Loading Discover…' })));
      api('/api/discover/home?type=all').then(function (data) { if (alive) build(data); })
        .catch(function (err) {
          if (!alive) return;
          rowsEl.innerHTML = '';
          rowsEl.appendChild(h('div', { class: 'empty' }, h('h2', { text: 'Discover is unavailable' }), h('p', { text: err.message })));
          r = -1;
        });
    }
    show({ el: el, focus: paint, refresh: loadDiscover,
      leave: function () { alive = false; },
      key: function (code) {
        var row = rows[r];
        if (code === KEY.UP && r > 0) { r--; paint(); return true; }
        if (code === KEY.DOWN && r < rows.length - 1) { r++; paint(); return true; }
        if (code === KEY.LEFT && row) { row.index = Math.max(0, row.index - 1); paint(); return true; }
        if (code === KEY.RIGHT && row) { row.index = Math.min(row.items.length - 1, row.index + 1); paint(); return true; }
        if (code === KEY.ENTER && row && row.items[row.index]) { row.items[row.index].open(); return true; }
        return false;
      } }, true);
    loadDiscover();
  }

  function discoverTitle(t) {
    var quality = null, qualities = [null, '2160p', '1440p', '1080p', '720p'];
    var seasons = [], si = 0, zone = t.type === 'tv' ? 'seasons' : 'actions', ai = 0;
    var alive = true, busy = false, pollTimer = null;
    var backdrop = h('div', { class: 'discover-backdrop' }, img(t.backdrop || t.poster));
    var title = h('h1', { text: t.title });
    var meta = h('div', { class: 'discover-meta', text: [t.year, t.type === 'tv' ? 'Series' : 'Film', t.rating ? '★ ' + t.rating : null].filter(Boolean).join(' · ') });
    var overview = h('p', { class: 'discover-overview', text: t.overview || 'No description available.' });
    var seasonBox = h('div', { class: 'discover-seasons' });
    var status = h('div', { class: 'download-status', text: titleInLibrary(t) ? 'Already in your library. Smart Download will avoid duplicates.' : '' });
    var downloadBtn = h('button', { class: 'title-action primary', text: state.me && state.me.canDownload === false ? 'Downloads disabled' : 'Download' });
    var qualityBtn = h('button', { class: 'title-action', text: '' });
    var actions = h('div', { class: 'title-actions' }, downloadBtn, qualityBtn);
    var panel = h('div', { class: 'discover-panel' }, h('div', { class: 'discover-copy' }, title, meta, overview, seasonBox, actions, status));
    var el = h('div', { class: 'screen discover-title' }, backdrop, panel);

    function savedQuality() {
      var s = state.me && state.me.settings || {};
      if (s.quality) return s.quality;
      if (s.downloadProfile) return s.downloadProfile;
      return 'your saved settings';
    }
    function qualityText() { return quality ? 'Quality: ' + quality : 'Quality: ' + savedQuality(); }
    function buildSeasons() {
      seasonBox.innerHTML = '';
      if (t.type !== 'tv') { seasonBox.style.display = 'none'; return; }
      if (!seasons.length) {
        seasonBox.appendChild(h('div', { class: 'season-note', text: 'Loading seasons…' })); return;
      }
      seasonBox.appendChild(h('div', { class: 'season-label', text: 'Season' }));
      var track = h('div', { class: 'season-track' });
      seasons.forEach(function (s, i) {
        track.appendChild(h('div', { class: 'season-chip' + (s.upcoming ? ' upcoming' : ''), text: String(s.number) }));
      });
      seasonBox.appendChild(h('div', { class: 'season-viewport' }, track));
    }
    function paint() {
      qualityBtn.textContent = qualityText();
      downloadBtn.classList.toggle('focus', zone === 'actions' && ai === 0);
      qualityBtn.classList.toggle('focus', zone === 'actions' && ai === 1);
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
        status.textContent = job.message || job.step || (job.state === 'running' ? 'Finding the best download…' : 'Download request finished.');
        if (job.state === 'running') pollTimer = setTimeout(function () { poll(id); }, 1400);
        else {
          busy = false;
          downloadBtn.textContent = 'Download';
          if (job.state === 'failed') status.classList.add('error'); else status.classList.remove('error');
          loadLibrary().catch(function () {});
          paint();
        }
      }).catch(function (err) {
        if (!alive) return;
        busy = false; downloadBtn.textContent = 'Download'; status.textContent = err.message; status.classList.add('error'); paint();
      });
    }
    function download() {
      if (busy || state.me && state.me.canDownload === false) return;
      if (t.type === 'tv' && !seasons.length) { toast('The season list is still loading.'); return; }
      var body = { type: t.type, tmdbId: t.id };
      if (t.type === 'tv') body.season = seasons[si].number;
      if (quality) body.quality = quality;
      busy = true; status.classList.remove('error');
      downloadBtn.textContent = 'Starting…'; status.textContent = 'Finding the best download…'; paint();
      api('/api/downloads/smart', body).then(function (r) { if (alive) poll(r.id); })
        .catch(function (err) {
          if (!alive) return;
          busy = false; downloadBtn.textContent = 'Download'; status.textContent = err.message; status.classList.add('error'); paint();
        });
    }

    buildSeasons(); paint();
    show({ el: el, focus: paint, leave: function () { alive = false; clearTimeout(pollTimer); },
      key: function (code) {
        if (zone === 'seasons') {
          if (code === KEY.LEFT && si > 0) { si--; paint(); return true; }
          if (code === KEY.RIGHT && si < seasons.length - 1) { si++; paint(); return true; }
          if (code === KEY.DOWN || code === KEY.ENTER) { zone = 'actions'; ai = 0; paint(); return true; }
          return code === KEY.UP || code === KEY.LEFT || code === KEY.RIGHT;
        }
        if (code === KEY.UP && t.type === 'tv' && seasons.length) { zone = 'seasons'; paint(); return true; }
        if (code === KEY.LEFT) { ai = Math.max(0, ai - 1); paint(); return true; }
        if (code === KEY.RIGHT) { ai = Math.min(1, ai + 1); paint(); return true; }
        if (code === KEY.ENTER) { if (ai === 0) download(); else cycleQuality(1); return true; }
        if (code === KEY.DOWN && ai === 1) { cycleQuality(1); return true; }
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
        seasonBox.appendChild(h('div', { class: 'season-note error', text: 'Couldn’t load seasons: ' + err.message }));
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
    var el = h('div', { class: 'screen show' },
      h('div', { class: 'backdrop' }, img(s.backdrop)),
      h('div', { class: 'show-head' }, h('h1', { text: s.title }), s.overview ? h('p', { class: 'overview', text: s.overview }) : null),
      tabs, h('div', { class: 'list-viewport' }, list));
    function buildTabs() {
      tabs.innerHTML = '';
      seasons.forEach(function (season) { tabs.appendChild(h('div', { class: 'tab', text: 'Season ' + season.number })); });
    }
    function buildList() {
      list.innerHTML = '';
      seasons[si].episodes.forEach(function (f) {
        var p = state.progress[L.progressRef(f)];
        var ok = L.resumable(p);
        list.appendChild(h('div', { class: 'episode' + (f.converting ? ' is-busy' : '') },
          h('div', { class: 'art' }, img(f.still || s.backdrop), ok ? h('div', { class: 'bar' }, h('i', { style: 'width:' + (p.time / p.duration * 100).toFixed(1) + '%' })) : null),
          h('div', { class: 'text' },
            h('div', { class: 'label', text: 'Episode ' + f.episode + (ok ? ' · ' + L.minutesLeft(p) : '') + (f.converting ? ' · getting ready' : '') }),
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
    if (f.converting) { toast('This one is still being prepared. Try again in a little while.'); return; }
    var p = state.progress[L.progressRef(f)];
    if (!L.resumable(p)) { play(f, 0); return; }
    var choice = 0;
    var buttons = [h('button', { class: 'choice', text: 'Resume from ' + L.fmtTime(p.time) }), h('button', { class: 'choice', text: 'Start over' })];
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
    if (!av) { toast('This TV can’t play videos from here.'); return; }
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
      h('div', { class: 'osd-hint' }, h('span', { text: 'Left / Right: 10 s' }), h('span', { text: 'OK: pause' }), h('span', { text: 'Down: subtitles and audio' })));
    var skipBtn = h('div', { class: 'skip-intro' }, 'Skip intro');
    skipBtn.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l8 7-8 7zM14 5l8 7-8 7z"/></svg>');
    var upNext = h('div', { class: 'up-next' },
      h('div', { class: 'up-next-art' }), h('div', { class: 'up-next-text' }, h('div', { class: 'up-next-label', text: 'Up next' }), h('div', { class: 'up-next-title' })),
      h('div', { class: 'up-next-actions' }, h('div', { class: 'btn play-next' }), h('div', { class: 'btn keep', text: 'Keep watching' })));
    var menu = h('div', { class: 'menu' });
    var spinner = h('div', { class: 'loading', text: 'Loading…' });
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
        setText(osdState, s.playing || s.ended ? '' : 'Paused');
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
      var label = s.busy ? 'Starting…' : left ? 'Next episode in ' + left : 'Next episode';
      var btn = upNext.querySelector('.play-next');
      if (btn.textContent !== label) btn.textContent = label;
      btn.style.setProperty('--progress', left == null ? '0' : String(1 - s.autoLeft / L.AUTOPLAY_SECONDS));
      btn.classList.toggle('counting', left != null);
      btn.classList.toggle('focus', cardFocus === 0);
      upNext.querySelector('.keep').classList.toggle('focus', cardFocus === 1);
      upNext.querySelector('.keep').textContent = s.ended ? 'Back' : 'Keep watching';
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
      toast(auto ? 'Intro skipped' : 'Skipped the intro');
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
        .catch(function (err) { toast('Couldn’t get those subtitles: ' + err.message); });
    }
    function audioTracks() {
      try {
        return av.getTotalTrackInfo().filter(function (t) { return t.type === 'AUDIO'; }).map(function (t) {
          var info = {}; try { info = JSON.parse(t.extra_info); } catch (e) { /* none */ }
          return { index: t.index, name: [info.language ? String(info.language).toUpperCase() : 'Track ' + (t.index + 1), info.channels ? info.channels + ' ch' : '', info.fourCC || ''].filter(Boolean).join(' · ') };
        });
      } catch (e) { return []; }
    }
    function openMenu() {
      showOsd(true);
      subLangs().then(function (langs) {
        menuItems = [{ head: 'Subtitles' }, { label: 'Off', on: !s.subLang, act: function () { setSubs(''); } }];
        langs.forEach(function (l) { menuItems.push({ label: l.name, on: s.subLang === l.code, act: function () { toast('Getting ' + l.name + ' subtitles…'); setSubs(l.code); } }); });
        var tracks = audioTracks();
        if (tracks.length > 1) {
          var current = -1;
          try { var cur = av.getCurrentStreamInfo().filter(function (t) { return t.type === 'AUDIO'; })[0]; current = cur ? cur.index : -1; } catch (e) { /* unknown */ }
          menuItems.push({ head: 'Audio' });
          tracks.forEach(function (t) { menuItems.push({ label: t.name, on: t.index === current, act: function () { try { av.setSelectTrack('AUDIO', t.index); } catch (e) { toast('This audio track can’t be picked here.'); } } }); });
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
      spinner.textContent = 'This video can’t play on the TV. ' + (message || '');
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
          onbufferingstart: function () { spinner.textContent = 'Loading…'; spinner.classList.add('show'); bufferingSince = Date.now(); },
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
              if (!reopen()) fail('Couldn’t restore your playback position. ' + String(e && e.name || e || ''));
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
      spinner.textContent = 'Reconnecting…'; spinner.classList.add('show');
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
      api('/api/play-link?kind=lib&id=' + encodeURIComponent(f.id) + '&variant=browser-hevc').then(function (link) {
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
