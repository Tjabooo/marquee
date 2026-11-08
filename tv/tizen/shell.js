// Loads Marquee's TV app (public/tv on the server) into this page, so a Marquee update reaches the TV
// without reinstalling anything. If the server can't be reached, it says so and keeps trying.
(function () {
  'use strict';
  var server = String(window.MARQUEE_SERVER || '').replace(/\/+$/, '');
  var added = [];
  var waiting = false;

  function note(text) { var n = document.getElementById('shell-note'); if (n) n.textContent = text; }
  function add(el) { added.push(el); document.head.appendChild(el); }
  function script(src, done) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { done(null); };
    s.onerror = function () { done(new Error('failed')); };
    add(s);
  }
  function retry() {
    added.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    added = [];
    waiting = true;
    note('Kan inte nå Marquee på ' + server + '. Är servern på? Försöker igen…');
    setTimeout(function () { waiting = false; load(); }, 5000);
  }
  function load() {
    var v = Date.now();
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = server + '/tv/tv.css?v=' + v;
    add(css);
    script(server + '/tv/sv.js?v=' + v, function (err0) {
      if (err0) return retry();
      script(server + '/tv/logic.js?v=' + v, function (err) {
        if (err) return retry();
        script(server + '/tv/tv.js?v=' + v, function (err2) { if (err2) retry(); });
      });
    });
  }
  document.addEventListener('keydown', function (e) {
    if (waiting && (e.keyCode === 10009 || e.keyCode === 8)) {
      try { tizen.application.getCurrentApplication().exit(); } catch (x) { /* not on a TV */ }
    }
  });
  if (!server) { note('Den här appen byggdes utan Marquee-adress. Bygg om den med MARQUEE_URL.'); return; }
  load();
})();
