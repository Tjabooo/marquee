// Marquee on a TV (tv/tizen): the parts of the TV app that are plain logic, kept apart so tests can run them.
// Written for the TV's browser engine (Samsung 2020 = Chrome 69): no ?. or ??, no newer built-ins.
(function (root) {
  'use strict';

  // Translates an English line with public/tv/sv.js (loaded first by the shell); {0}, {1}… are filled in.
  function T(text) {
    var strings = root.MarqueeTvStrings || {};
    var args = arguments;
    return String(strings[text] || text).replace(/\{(\d+)\}/g, function (m, i) { return args[+i + 1]; });
  }

  var AUTOPLAY_SECONDS = 10;
  var AUTOPLAY_CHAIN = 3; // episodes in a row the countdown may start before it waits for a person
  var DONE_SECONDS = 90;  // this close to the end counts as watched (same as the phone player)

  function posInt(n) { return typeof n === 'number' && isFinite(n) && n > 0 && Math.floor(n) === n; }
  function usableEpisode(f) {
    return Boolean(f && f.id && f.show && posInt(f.season) && posInt(f.episode) && !f.converting && f.done !== false);
  }

  // Same rule as the phone (public/player-next.js): the next episode of this person's own library,
  // the first of the next season only when TMDB says this was the season's last. Never skips one.
  function nextEpisode(currentId, library, shows) {
    var current = null, i;
    for (i = 0; i < library.length; i++) if (library[i].id === currentId) { current = library[i]; break; }
    if (!usableEpisode(current)) return null;
    var episodes = library.filter(function (f) { return usableEpisode(f) && f.show === current.show; });
    function choose(season, episode) {
      return episodes.filter(function (f) { return f.season === season && f.episode === episode; })
        .sort(function (a, b) { return String(a.file || '').localeCompare(String(b.file || '')) || String(a.id).localeCompare(String(b.id)); })[0] || null;
    }
    var next = choose(current.season, current.episode + 1);
    if (next) return next;
    var show = null;
    for (i = 0; i < shows.length; i++) if (shows[i].id === current.show) show = shows[i];
    var season = show && (show.seasons || []).filter(function (s) { return s.number === current.season; })[0];
    var total = season && season.total;
    return posInt(total) && current.episode === total ? choose(current.season + 1, 1) : null;
  }

  // Up next starts with the credits (an ending chapter or the credits music, from the server), never
  // at a guessed time: with no credits start known it waits for the end of the file.
  function nextPromptAt(duration, creditsAt) {
    if (!(duration > 0)) return null;
    return typeof creditsAt === 'number' && creditsAt > duration / 2 && creditsAt < duration ? creditsAt : null;
  }
  function isNextTime(time, duration, creditsAt, ended) {
    if (ended) return true;
    var at = nextPromptAt(duration, creditsAt);
    return at !== null && time >= at;
  }
  function introShowing(time, intro) {
    return Boolean(intro) && time >= intro.start - 0.25 && time < intro.end - 1;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  function episodeLabel(f) {
    return f && f.season != null && f.episode != null ? T('S{0} E{1}', pad2(f.season), pad2(f.episode)) : '';
  }
  function minutesLeft(p) { return T('{0} min left', Math.max(1, Math.ceil((p.duration - p.time) / 60))); }

  // Resume points are synced by media key, which stays the same when the MP4 copy replaces the original.
  function progressRef(f) { return f.mediaKey ? 'm:' + f.mediaKey : 'l:' + f.id; }
  function resumable(p) { return Boolean(p && p.time > 30 && p.duration > 0 && p.duration - p.time > DONE_SECONDS); }

  // "movie:603" / "tv:1399", for Wrapped and Popular on Marquee (same as public/social.js titleKeyOf).
  function titleKey(f) {
    var show = /^tv-(\d+)$/.exec(String(f.show || ''));
    if (show) return 'tv:' + show[1];
    if (f.tmdbId && f.season == null) return 'movie:' + f.tmdbId;
    return undefined;
  }

  // The home screen: what you were watching (newest first), then shows, then films.
  // What a transfer is doing, in the same words as the website's Library (public/library-downloads.js).
  function transferWord(d) {
    if (d.converting) return T('Preparing playback');
    var st = String(d.state || '');
    if (st === 'missingFiles') return T('Files missing');
    if (st === 'error') return T('Needs attention');
    if (/^(paused|stopped)/.test(st)) return T('Paused');
    if (/^checking/.test(st)) return T('Checking files');
    if (st === 'stalledDL') return T('Waiting for a source');
    if (st === 'metaDL' || st === 'forcedMetaDL') return T('Starting');
    if (st === 'queuedDL') return T('In line');
    if (st === 'moving' || d.progress >= 1) return T('Almost ready');
    return T('On its way');
  }
  // Downloads that aren't ready yet, one entry per film or show (a season pack and single episodes join up),
  // newest first. The same rule as the website's libraryUnion: yours, and still on its way or needing attention.
  function pendingTitles(downloads, library) {
    var order = [], byKey = {};
    (downloads || []).forEach(function (d) {
      if (d.mine === false) return;
      var trouble = d.state === 'error' || d.state === 'missingFiles';
      var linked = d.libraryIds && d.libraryIds.length;
      if (!(!d.done || d.converting || trouble || (d.hasVideo !== false && !d.ready && !linked))) return;
      var isShow = d.mediaType === 'tv' || d.showId;
      var key = isShow ? 'tv:' + (d.showId || d.tmdbId || d.hash) : d.tmdbId != null ? 'movie:' + d.tmdbId : 'hash:' + d.hash;
      var e = byKey[key];
      if (!e) {
        e = byKey[key] = { key: key, type: isShow ? 'tv' : 'movie', tmdbId: d.tmdbId == null ? null : d.tmdbId, showId: d.showId || null,
          title: d.canonicalTitle || d.title || d.name || '', poster: d.poster || null, backdrop: d.backdrop || null, year: d.year || null,
          items: [], added: 0 };
        order.push(e);
      }
      e.items.push(d);
      e.added = Math.max(e.added, d.added || 0);
    });
    return order.map(function (e) {
      var known = e.items.every(function (d) { return d.size > 0 && typeof d.progress === 'number'; });
      var total = known ? e.items.reduce(function (n, d) { return n + d.size; }, 0) : 0;
      e.progress = known && total ? e.items.reduce(function (n, d) { return n + d.size * Math.max(0, Math.min(1, d.progress)); }, 0) / total : null;
      e.word = e.items.length === 1 ? transferWord(e.items[0]) : T('{0} downloads', e.items.length);
      return e;
    }).sort(function (a, b) { return b.added - a.added; });
  }

  function homeRows(library, shows, progress) {
    var cont = library.filter(function (f) { return resumable(progress[progressRef(f)]) && !f.converting; })
      .sort(function (a, b) { return (progress[progressRef(b)].at || 0) - (progress[progressRef(a)].at || 0); })
      .slice(0, 20);
    var showIds = {};
    library.forEach(function (f) { if (f.show && f.season != null) showIds[f.show] = true; });
    var showList = shows.filter(function (s) { return showIds[s.id]; })
      .sort(function (a, b) { return latestAdded(library, b.id) - latestAdded(library, a.id); });
    var films = library.filter(function (f) { return f.season == null; })
      .sort(function (a, b) { return (b.addedAt || b.added || 0) - (a.addedAt || a.added || 0); });
    return { cont: cont, shows: showList, films: films };
  }
  function latestAdded(library, showId) {
    var t = 0;
    library.forEach(function (f) { if (f.show === showId) t = Math.max(t, f.addedAt || f.added || 0); });
    return t;
  }

  // The library by genre: one row per genre that has something in it, the biggest first, newest titles
  // first inside. Films match by their TMDB film genre, shows by the show genre (TMDB merges a few for
  // shows, e.g. "Action & Adventure", so one show can sit in both Action and Adventure).
  function genreRows(library, shows, genres) {
    var showIds = {}, showAdded = {}, films = [], seenFilm = {};
    library.forEach(function (f) {
      if (f.show && f.season != null) { showIds[f.show] = true; showAdded[f.show] = Math.max(showAdded[f.show] || 0, f.addedAt || f.added || 0); }
      if (f.season != null || !f.genres || !f.genres.length) return;
      var k = f.tmdbId ? 'm' + f.tmdbId : f.id;
      if (!seenFilm[k]) { seenFilm[k] = true; films.push(f); }
    });
    function has(list, id) { return Boolean(id && list && list.indexOf(id) >= 0); }
    var rows = [];
    (genres || []).forEach(function (g) {
      var titles = [];
      shows.forEach(function (s) { if (showIds[s.id] && has(s.genres, g.tv)) titles.push({ show: s, added: showAdded[s.id] }); });
      films.forEach(function (f) { if (has(f.genres, g.movie)) titles.push({ film: f, added: f.addedAt || f.added || 0 }); });
      if (titles.length) rows.push({ name: g.name, titles: titles.sort(function (a, b) { return b.added - a.added; }) });
    });
    return rows.sort(function (a, b) { return b.titles.length - a.titles.length || (a.name < b.name ? -1 : 1); });
  }

  // Search matching: case, accents, spaces and punctuation don't count ("spider man" finds "Spider-Man").
  function searchKey(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  }

  // One show's downloaded episodes by season, and the episode to start on: the one in progress, else
  // the one after the last you finished, else the first.
  function showSeasons(library, showId) {
    var bySeason = {};
    library.forEach(function (f) {
      if (f.show !== showId || f.season == null) return;
      (bySeason[f.season] = bySeason[f.season] || []).push(f);
    });
    return Object.keys(bySeason).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
      return { number: n, episodes: bySeason[n].sort(function (a, b) { return (a.episode || 0) - (b.episode || 0) || String(a.file || '').localeCompare(String(b.file || '')); }) };
    });
  }
  function startEpisode(seasons, progress, watched) {
    var all = [];
    seasons.forEach(function (s) { all = all.concat(s.episodes); });
    var i;
    for (i = 0; i < all.length; i++) if (resumable(progress[progressRef(all[i])])) return all[i];
    var last = -1;
    for (i = 0; i < all.length; i++) if (watched && watched[progressRef(all[i])]) last = i;
    return all[Math.min(last + 1, all.length - 1)] || null;
  }

  // WebVTT from /api/subs/file/…vtt: cues with start/end in seconds and plain text (tags dropped).
  function parseVtt(text) {
    var cues = [];
    var blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
    var time = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
    blocks.forEach(function (block) {
      var lines = block.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var m = time.exec(lines[i]);
        if (!m) continue;
        var start = (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
        var end = (+m[5] || 0) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
        var body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
        if (body && end > start) cues.push({ start: start, end: end, text: body });
        break;
      }
    });
    return cues.sort(function (a, b) { return a.start - b.start; });
  }
  // Text showing at `t` (overlapping cues are joined), by binary search on start times.
  function cueText(cues, t) {
    var lo = 0, hi = cues.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (cues[mid].start <= t) lo = mid + 1; else hi = mid; }
    var out = [];
    for (var i = lo - 1; i >= 0 && i >= lo - 8; i--) if (cues[i].end > t) out.unshift(cues[i].text);
    return out.join('\n');
  }

  var api = {
    AUTOPLAY_SECONDS: AUTOPLAY_SECONDS, AUTOPLAY_CHAIN: AUTOPLAY_CHAIN, DONE_SECONDS: DONE_SECONDS,
    nextEpisode: nextEpisode, nextPromptAt: nextPromptAt, isNextTime: isNextTime, introShowing: introShowing,
    T: T, fmtTime: fmtTime, episodeLabel: episodeLabel, minutesLeft: minutesLeft, progressRef: progressRef, resumable: resumable,
    titleKey: titleKey, pendingTitles: pendingTitles, homeRows: homeRows, genreRows: genreRows, searchKey: searchKey, showSeasons: showSeasons, startEpisode: startEpisode, parseVtt: parseVtt, cueText: cueText,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarqueeTvLogic = api;
})(this);
