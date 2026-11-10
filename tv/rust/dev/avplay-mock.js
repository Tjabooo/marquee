// A pretend AVPlay for the dev harness (?mock=av): plays nothing, but reports time like the TV's player,
// at SPEED× real time, so the player's overlay, Skip intro, Up next and menus can be tried in a browser.
(function () {
  var SPEED = Number((/[?&]speed=(\d+)/.exec(location.search) || [])[1] || 20);
  var DURATION = 2652000;
  var t = 0, playing = false, listener = {}, timer = null;
  function tick() {
    if (!playing) return;
    t += 250 * SPEED;
    if (t >= DURATION) { t = DURATION; playing = false; listener.onstreamcompleted && listener.onstreamcompleted(); return; }
    listener.oncurrentplaytime && listener.oncurrentplaytime(t);
  }
  window.webapis = window.webapis || {};
  window.webapis.avplay = {
    open: function (url) { console.log('avplay open ' + url); t = 0; },
    setDisplayRect: function () {}, setDisplayMethod: function () {},
    setListener: function (l) { listener = l; },
    prepareAsync: function (ok) { setTimeout(function () { listener.onbufferingstart && listener.onbufferingstart(); setTimeout(function () { listener.onbufferingcomplete && listener.onbufferingcomplete(); ok(); }, 400); }, 300); },
    getDuration: function () { return DURATION; },
    play: function () { playing = true; clearInterval(timer); timer = setInterval(tick, 250); },
    pause: function () { playing = false; },
    seekTo: function (ms, ok) { t = ms; setTimeout(function () { ok && ok(); }, 200); },
    getCurrentTime: function () { return t; },
    stop: function () { playing = false; clearInterval(timer); },
    close: function () { playing = false; clearInterval(timer); },
    getTotalTrackInfo: function () { return [{ type: 'VIDEO', index: 0, extra_info: '{}' },
      { type: 'AUDIO', index: 1, extra_info: '{"language":"eng","channels":6,"fourCC":"EAC3"}' },
      { type: 'AUDIO', index: 2, extra_info: '{"language":"swe","channels":2,"fourCC":"AAC"}' }]; },
    getCurrentStreamInfo: function () { return [{ type: 'AUDIO', index: 1 }]; },
    setSelectTrack: function () {},
  };
})();
